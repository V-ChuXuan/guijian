use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::cleanup::{CleanupService, SharedTrash, TrashPort};
use crate::domain::{CleanupReport, DuplicateGroup, ScanResult};
use crate::scanner::{validated_root, CancellationToken, DuplicateScanner};
use crate::selection::{
    recommended_selection, update_selection, validate_selection, GroupSelection,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandErrorCode {
    InvalidPath,
    Busy,
    UnknownGroup,
    InvalidSelection,
    NoScanResult,
    Internal,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub message: String,
}

impl CommandError {
    fn new(code: CommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub result: Option<ScanResult>,
    pub selections: Vec<GroupSelection>,
}

#[derive(Clone)]
enum ActiveOperation {
    Scan(CancellationToken),
    Cleanup,
}

pub struct AppState {
    session: Mutex<SessionView>,
    active: Mutex<Option<ActiveOperation>>,
    trash: SharedTrash,
}

impl AppState {
    pub fn new(trash: Arc<dyn TrashPort>) -> Self {
        Self {
            session: Mutex::new(SessionView::default()),
            active: Mutex::new(None),
            trash,
        }
    }

    pub fn begin_scan(&self) -> Result<CancellationToken, CommandError> {
        let mut active = self.lock_active()?;
        if active.is_some() {
            return Err(CommandError::new(
                CommandErrorCode::Busy,
                "已有操作正在进行",
            ));
        }
        let token = CancellationToken::new();
        *active = Some(ActiveOperation::Scan(token.clone()));
        Ok(token)
    }

    pub fn cancel_scan(&self) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        if let Some(ActiveOperation::Scan(token)) = active.as_ref() {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub fn complete_scan(
        &self,
        token: &CancellationToken,
        result: ScanResult,
    ) -> Result<SessionView, CommandError> {
        let mut active = self.lock_active()?;
        match active.as_ref() {
            Some(ActiveOperation::Scan(current)) if current.same_operation(token) => {}
            _ => {
                return Err(CommandError::new(
                    CommandErrorCode::Internal,
                    "扫描任务状态不匹配",
                ));
            }
        }
        let selections = result.groups.iter().map(recommended_selection).collect();
        let view = SessionView {
            result: Some(result),
            selections,
        };
        *self.lock_session()? = view.clone();
        *active = None;
        Ok(view)
    }

    pub fn abandon_operation(&self) {
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
    }

    pub fn session(&self) -> Result<SessionView, CommandError> {
        Ok(self.lock_session()?.clone())
    }

    pub fn update_selection(
        &self,
        group_id: &str,
        path: &Path,
        should_cleanup: bool,
    ) -> Result<GroupSelection, CommandError> {
        if !path.is_absolute() {
            return Err(CommandError::new(
                CommandErrorCode::InvalidSelection,
                "文件路径必须是绝对路径",
            ));
        }
        let active = self.lock_active()?;
        if active.is_some() {
            return Err(CommandError::new(
                CommandErrorCode::Busy,
                "操作进行期间不能修改清理选择",
            ));
        }
        let mut session = self.lock_session()?;
        let result = session
            .result
            .as_ref()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        let group = result
            .groups
            .iter()
            .find(|group| group.id == group_id)
            .ok_or_else(|| CommandError::new(CommandErrorCode::UnknownGroup, "重复组不存在"))?;
        let selection_index = session
            .selections
            .iter()
            .position(|selection| selection.group_id == group_id)
            .ok_or_else(|| {
                CommandError::new(CommandErrorCode::UnknownGroup, "重复组选择状态不存在")
            })?;
        let updated = update_selection(
            group,
            &session.selections[selection_index],
            path,
            should_cleanup,
        )
        .map_err(|error| {
            CommandError::new(CommandErrorCode::InvalidSelection, error.to_string())
        })?;
        session.selections[selection_index] = updated.clone();
        drop(active);
        Ok(updated)
    }

    pub fn restore_recommended_selections(&self) -> Result<SessionView, CommandError> {
        let active = self.lock_active()?;
        if active.is_some() {
            return Err(CommandError::new(
                CommandErrorCode::Busy,
                "操作进行期间不能恢复建议",
            ));
        }
        let mut session = self.lock_session()?;
        let result = session
            .result
            .as_ref()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        session.selections = result.groups.iter().map(recommended_selection).collect();
        drop(active);
        Ok(session.clone())
    }

    pub fn prepare_single_cleanup(
        &self,
        group_id: &str,
        path: &Path,
    ) -> Result<SessionView, CommandError> {
        if !path.is_absolute() {
            return Err(CommandError::new(
                CommandErrorCode::InvalidSelection,
                "文件路径必须是绝对路径",
            ));
        }
        let active = self.lock_active()?;
        if active.is_some() {
            return Err(CommandError::new(
                CommandErrorCode::Busy,
                "操作进行期间不能准备清理计划",
            ));
        }
        let mut session = self.lock_session()?;
        let result = session
            .result
            .as_ref()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        let target_group = result
            .groups
            .iter()
            .find(|group| group.id == group_id)
            .ok_or_else(|| CommandError::new(CommandErrorCode::UnknownGroup, "重复组不存在"))?;
        if !target_group.contains_path(path) {
            return Err(CommandError::new(
                CommandErrorCode::InvalidSelection,
                "文件不属于指定的重复组",
            ));
        }

        let mut prepared = Vec::with_capacity(result.groups.len());
        for group in &result.groups {
            let cleanup_paths = if group.id == group_id {
                BTreeSet::from([path.to_path_buf()])
            } else {
                BTreeSet::new()
            };
            let mut selection = GroupSelection {
                group_id: group.id.clone(),
                cleanup_paths,
                reclaimable_bytes: 0,
                recommendation_reason: "仅回收当前选定的文件。".to_owned(),
            };
            selection.reclaimable_bytes = selection.reclaimable_bytes(group);
            validate_selection(group, &selection).map_err(|error| {
                CommandError::new(CommandErrorCode::InvalidSelection, error.to_string())
            })?;
            prepared.push(selection);
        }

        session.selections = prepared;
        drop(active);
        Ok(session.clone())
    }

    pub fn validated_session_path(&self, path: &Path) -> Result<PathBuf, CommandError> {
        if !path.is_absolute() {
            return Err(CommandError::new(
                CommandErrorCode::InvalidPath,
                "文件路径必须是绝对路径",
            ));
        }
        let session = self.lock_session()?;
        let result = session
            .result
            .as_ref()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        result
            .groups
            .iter()
            .flat_map(|group| &group.files)
            .find(|file| file.path == path)
            .map(|file| file.path.clone())
            .ok_or_else(|| {
                CommandError::new(CommandErrorCode::InvalidPath, "文件不在当前扫描结果中")
            })
    }

    fn begin_cleanup(&self) -> Result<(Vec<DuplicateGroup>, Vec<GroupSelection>), CommandError> {
        let mut active = self.lock_active()?;
        if active.is_some() {
            return Err(CommandError::new(
                CommandErrorCode::Busy,
                "已有操作正在进行",
            ));
        }
        let session = self.lock_session()?;
        let result = session
            .result
            .as_ref()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        *active = Some(ActiveOperation::Cleanup);
        Ok((result.groups.clone(), session.selections.clone()))
    }

    fn trash(&self) -> SharedTrash {
        Arc::clone(&self.trash)
    }

    fn lock_active(&self) -> Result<MutexGuard<'_, Option<ActiveOperation>>, CommandError> {
        self.active
            .lock()
            .map_err(|_| CommandError::new(CommandErrorCode::Internal, "操作状态锁已损坏"))
    }

    fn lock_session(&self) -> Result<MutexGuard<'_, SessionView>, CommandError> {
        self.session
            .lock()
            .map_err(|_| CommandError::new(CommandErrorCode::Internal, "会话状态锁已损坏"))
    }
}

pub fn validate_scan_root(path: &str) -> Result<PathBuf, CommandError> {
    validated_root(Path::new(path))
        .map_err(|error| CommandError::new(CommandErrorCode::InvalidPath, error.to_string()))
}

#[tauri::command]
pub async fn start_scan(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionView, CommandError> {
    let root = validate_scan_root(&path)?;
    let token = state.begin_scan()?;
    let worker_token = token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        DuplicateScanner::default().scan_with_progress(&root, &worker_token, |progress| {
            let _ = app.emit("scan-progress", progress);
        })
    })
    .await;
    match result {
        Ok(Ok(result)) => state.complete_scan(&token, result),
        Ok(Err(error)) => {
            state.abandon_operation();
            Err(CommandError::new(
                CommandErrorCode::Internal,
                error.to_string(),
            ))
        }
        Err(error) => {
            state.abandon_operation();
            Err(CommandError::new(
                CommandErrorCode::Internal,
                format!("扫描线程失败: {error}"),
            ))
        }
    }
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> bool {
    state.cancel_scan()
}

#[tauri::command]
pub fn get_session(state: State<'_, AppState>) -> Result<SessionView, CommandError> {
    state.session()
}

#[tauri::command]
pub fn set_file_cleanup(
    group_id: String,
    path: String,
    should_cleanup: bool,
    state: State<'_, AppState>,
) -> Result<GroupSelection, CommandError> {
    state.update_selection(&group_id, Path::new(&path), should_cleanup)
}

#[tauri::command]
pub fn restore_recommended_selections(
    state: State<'_, AppState>,
) -> Result<SessionView, CommandError> {
    state.restore_recommended_selections()
}

#[tauri::command]
pub fn prepare_single_cleanup(
    group_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<SessionView, CommandError> {
    state.prepare_single_cleanup(&group_id, Path::new(&path))
}

#[tauri::command]
pub fn reveal_file(path: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    let path = state.validated_session_path(Path::new(&path))?;
    if !path.is_file() {
        return Err(CommandError::new(
            CommandErrorCode::InvalidPath,
            "文件已移动或不可访问",
        ));
    }
    reveal_in_explorer(&path).map_err(|error| {
        CommandError::new(
            CommandErrorCode::Internal,
            format!("无法在资源管理器中显示文件: {error}"),
        )
    })
}

#[tauri::command]
pub async fn confirm_cleanup(state: State<'_, AppState>) -> Result<CleanupReport, CommandError> {
    let (groups, selections) = state.begin_cleanup()?;
    let trash = state.trash();
    let result = tauri::async_runtime::spawn_blocking(move || {
        CleanupService::new(trash.as_ref()).cleanup(&groups, &selections)
    })
    .await;
    state.abandon_operation();
    match result {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(error)) => Err(CommandError::new(
            CommandErrorCode::InvalidSelection,
            error.to_string(),
        )),
        Err(error) => Err(CommandError::new(
            CommandErrorCode::Internal,
            format!("清理线程失败: {error}"),
        )),
    }
}

#[cfg(windows)]
fn reveal_in_explorer(path: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn reveal_in_explorer(_path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "仅支持 Windows 资源管理器",
    ))
}
