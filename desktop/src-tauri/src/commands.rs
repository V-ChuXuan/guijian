use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::cleanup::{CleanupService, SharedTrash, TrashPort};
use crate::domain::{
    CleanupReport, CleanupStatus, DuplicateGroup, ProgressStage, ScanProgress, ScanResult,
};
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTarget {
    pub group_id: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    pub report: CleanupReport,
    pub session: SessionView,
}

#[derive(Default)]
struct ScanProgressThrottle {
    pending: Option<ScanProgress>,
    last_stage: Option<ProgressStage>,
    last_emitted: Option<Instant>,
}

impl ScanProgressThrottle {
    fn push(&mut self, progress: ScanProgress, now: Instant) -> Option<ScanProgress> {
        let emit = self.last_stage != Some(progress.stage)
            || progress.current_path.is_none()
            || self
                .last_emitted
                .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100));
        self.pending = Some(progress);
        if emit {
            self.last_stage = self.pending.as_ref().map(|progress| progress.stage);
            self.last_emitted = Some(now);
            self.pending.take()
        } else {
            None
        }
    }
}

#[derive(Clone)]
enum ActiveOperation {
    Scan(CancellationToken),
    Cleanup {
        approved: BTreeSet<PathBuf>,
        cancellation: CancellationToken,
    },
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

    pub fn operation_in_progress(&self) -> bool {
        self.active.lock().map_or(true, |active| active.is_some())
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

    pub fn cancel_cleanup(&self) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        if let Some(ActiveOperation::Cleanup { cancellation, .. }) = active.as_ref() {
            cancellation.cancel();
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

    pub fn keep_group(&self, group_id: &str) -> Result<GroupSelection, CommandError> {
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
        validate_selection(group, &session.selections[selection_index]).map_err(|error| {
            CommandError::new(CommandErrorCode::InvalidSelection, error.to_string())
        })?;
        let selection = &mut session.selections[selection_index];
        selection.cleanup_paths.clear();
        selection.reclaimable_bytes = 0;
        let updated = selection.clone();
        drop(active);
        Ok(updated)
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

    pub fn begin_cleanup(
        &self,
        target: Option<&CleanupTarget>,
    ) -> Result<(Vec<DuplicateGroup>, Vec<GroupSelection>, CancellationToken), CommandError> {
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
        let (groups, selections) = if let Some(target) = target {
            if !target.path.is_absolute() {
                return Err(CommandError::new(
                    CommandErrorCode::InvalidSelection,
                    "文件路径必须是绝对路径",
                ));
            }
            let group = result
                .groups
                .iter()
                .find(|group| group.id == target.group_id)
                .ok_or_else(|| CommandError::new(CommandErrorCode::UnknownGroup, "重复组不存在"))?;
            let mut selection = GroupSelection {
                group_id: group.id.clone(),
                cleanup_paths: BTreeSet::from([target.path.clone()]),
                reclaimable_bytes: 0,
                recommendation_reason: "仅回收当前选定的文件。".to_owned(),
            };
            validate_selection(group, &selection).map_err(|error| {
                CommandError::new(CommandErrorCode::InvalidSelection, error.to_string())
            })?;
            selection.reclaimable_bytes = selection.reclaimable_bytes(group);
            (vec![group.clone()], vec![selection])
        } else {
            (result.groups.clone(), session.selections.clone())
        };
        let approved = selections
            .iter()
            .flat_map(|selection| selection.cleanup_paths.iter().cloned())
            .collect();
        let cancellation = CancellationToken::new();
        *active = Some(ActiveOperation::Cleanup {
            approved,
            cancellation: cancellation.clone(),
        });
        Ok((groups, selections, cancellation))
    }

    pub fn complete_cleanup(&self, report: CleanupReport) -> Result<CleanupOutcome, CommandError> {
        let mut active = self.lock_active()?;
        let Some(ActiveOperation::Cleanup { approved, .. }) = active.as_ref() else {
            return Err(CommandError::new(
                CommandErrorCode::Internal,
                "清理任务状态不匹配",
            ));
        };
        if report
            .items
            .iter()
            .any(|item| !approved.contains(&item.path))
        {
            return Err(CommandError::new(
                CommandErrorCode::Internal,
                "清理报告包含未批准的文件",
            ));
        }
        let moved: BTreeSet<_> = report
            .items
            .iter()
            .filter(|item| item.status == CleanupStatus::MovedToTrash)
            .map(|item| item.path.clone())
            .collect();
        let mut session = self.lock_session()?;
        let mut updated = session.clone();
        let mut selections: HashMap<_, _> = updated
            .selections
            .into_iter()
            .map(|selection| (selection.group_id.clone(), selection))
            .collect();
        let result = updated
            .result
            .as_mut()
            .ok_or_else(|| CommandError::new(CommandErrorCode::NoScanResult, "当前没有扫描结果"))?;
        result.groups.retain_mut(|group| {
            group.files.retain(|file| !moved.contains(&file.path));
            group.files.len() >= 2
        });
        updated.selections = result
            .groups
            .iter()
            .map(|group| {
                let mut selection = selections.remove(&group.id).ok_or_else(|| {
                    CommandError::new(CommandErrorCode::Internal, "重复组选择状态不存在")
                })?;
                selection.cleanup_paths.retain(|path| !moved.contains(path));
                if selection.cleanup_paths.len() == group.files.len() {
                    selection
                        .cleanup_paths
                        .remove(&group.recommended_keeper().path);
                }
                validate_selection(group, &selection).map_err(|error| {
                    CommandError::new(CommandErrorCode::Internal, error.to_string())
                })?;
                selection.reclaimable_bytes = selection.reclaimable_bytes(group);
                Ok(selection)
            })
            .collect::<Result<_, CommandError>>()?;
        *session = updated.clone();
        *active = None;
        Ok(CleanupOutcome {
            report,
            session: updated,
        })
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
        let mut throttle = ScanProgressThrottle::default();
        let result =
            DuplicateScanner::default().scan_with_progress(&root, &worker_token, |progress| {
                if let Some(progress) = throttle.push(progress, Instant::now()) {
                    let _ = app.emit("scan-progress", progress);
                }
            });
        if let Some(progress) = throttle.pending.take() {
            let _ = app.emit("scan-progress", progress);
        }
        result
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
pub fn cancel_cleanup(state: State<'_, AppState>) -> bool {
    state.cancel_cleanup()
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
pub fn keep_group(
    group_id: String,
    state: State<'_, AppState>,
) -> Result<GroupSelection, CommandError> {
    state.keep_group(&group_id)
}

#[tauri::command]
pub fn restore_recommended_selections(
    state: State<'_, AppState>,
) -> Result<SessionView, CommandError> {
    state.restore_recommended_selections()
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
pub async fn confirm_cleanup(
    target: Option<CleanupTarget>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CleanupOutcome, CommandError> {
    let (groups, selections, cancellation) = state.begin_cleanup(target.as_ref())?;
    let trash = state.trash();
    let result = tauri::async_runtime::spawn_blocking(move || {
        CleanupService::new(trash.as_ref()).cleanup_with_progress(
            &groups,
            &selections,
            &cancellation,
            |progress| {
                let _ = app.emit("cleanup-progress", progress);
            },
        )
    })
    .await;
    match result {
        Ok(Ok(report)) => state.complete_cleanup(report),
        Ok(Err(error)) => {
            state.abandon_operation();
            Err(CommandError::new(
                CommandErrorCode::InvalidSelection,
                error.to_string(),
            ))
        }
        Err(error) => {
            state.abandon_operation();
            Err(CommandError::new(
                CommandErrorCode::Internal,
                format!("清理线程失败: {error}"),
            ))
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(stage: ProgressStage, count: usize) -> ScanProgress {
        ScanProgress {
            stage,
            scanned_files: count,
            scanned_bytes: count as u64,
            candidate_files: 10,
            completed_files: count,
            total_files: 10,
            current_path: Some(PathBuf::from("synthetic")),
        }
    }

    #[test]
    fn scan_progress_is_limited_to_intervals_and_retains_the_latest_pending_event() {
        let mut throttle = ScanProgressThrottle::default();
        let start = Instant::now();
        assert!(throttle
            .push(progress(ProgressStage::Enumerating, 1), start)
            .is_some());
        assert!(throttle
            .push(
                progress(ProgressStage::Enumerating, 2),
                start + Duration::from_millis(99)
            )
            .is_none());
        assert_eq!(throttle.pending.as_ref().unwrap().scanned_files, 2);
        assert!(throttle
            .push(
                progress(ProgressStage::Enumerating, 3),
                start + Duration::from_millis(100)
            )
            .is_some());
        assert!(throttle.pending.is_none());
        assert!(throttle
            .push(
                progress(ProgressStage::Enumerating, 4),
                start + Duration::from_millis(101)
            )
            .is_none());
        assert_eq!(throttle.pending.take().unwrap().scanned_files, 4);
    }

    #[test]
    fn scan_progress_always_emits_phase_changes_and_terminal_counts() {
        let mut throttle = ScanProgressThrottle::default();
        let now = Instant::now();
        for stage in [
            ProgressStage::Enumerating,
            ProgressStage::PartialHash,
            ProgressStage::FullHash,
        ] {
            assert!(throttle.push(progress(stage, 0), now).is_some());
            assert!(throttle.push(progress(stage, 9), now).is_none());
            let mut terminal = progress(stage, 10);
            terminal.current_path = None;
            assert_eq!(throttle.push(terminal.clone(), now), Some(terminal));
            assert!(throttle.pending.is_none());
        }
    }
}
