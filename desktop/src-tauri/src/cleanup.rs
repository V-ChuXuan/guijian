use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::sync::Arc;

use crate::domain::{
    CleanupItemResult, CleanupReport, CleanupStatus, DuplicateGroup, FileSnapshot,
};
use crate::fingerprint::{hash_snapshot, FingerprintError};
use crate::scanner::CancellationToken;
use crate::selection::{validate_selection, GroupSelection};

pub trait TrashPort: Send + Sync {
    fn move_to_trash(&self, path: &Path) -> Result<(), String>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupError(pub String);

impl Display for CleanupError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for CleanupError {}

pub struct CleanupService<'a> {
    trash: &'a dyn TrashPort,
    chunk_bytes: usize,
}

impl<'a> CleanupService<'a> {
    pub fn new(trash: &'a dyn TrashPort) -> Self {
        Self {
            trash,
            chunk_bytes: 1024 * 1024,
        }
    }

    pub fn cleanup(
        &self,
        groups: &[DuplicateGroup],
        selections: &[GroupSelection],
    ) -> Result<CleanupReport, CleanupError> {
        let mut jobs = Vec::new();
        for selection in selections {
            let group = groups
                .iter()
                .find(|group| group.id == selection.group_id)
                .ok_or_else(|| CleanupError("选择包含未知重复组".to_owned()))?;
            validate_selection(group, selection)
                .map_err(|error| CleanupError(error.to_string()))?;
            jobs.push((group, selection));
        }

        let mut items = Vec::new();
        for (group, selection) in jobs {
            for snapshot in group
                .files
                .iter()
                .filter(|file| selection.cleanup_paths.contains(&file.path))
            {
                let mut keeper_failure = None;
                let valid_keeper = group
                    .files
                    .iter()
                    .filter(|file| !selection.cleanup_paths.contains(&file.path))
                    .any(|file| match self.verify_snapshot(file, &group.digest) {
                        Ok(()) => true,
                        Err(error) => {
                            keeper_failure.get_or_insert_with(|| {
                                format!("{}: {}", file.path.display(), error.message())
                            });
                            false
                        }
                    });
                let result = if !valid_keeper {
                    CleanupItemResult {
                        path: snapshot.path.clone(),
                        size: snapshot.size,
                        status: CleanupStatus::Blocked,
                        message: format!(
                            "没有通过复核的保留副本，本组未执行清理。{}",
                            keeper_failure.unwrap_or_else(|| "未找到保留路径".to_owned())
                        ),
                    }
                } else {
                    match self.verify_snapshot(snapshot, &group.digest) {
                        Ok(()) => match self.trash.move_to_trash(&snapshot.path) {
                            Ok(()) => CleanupItemResult {
                                path: snapshot.path.clone(),
                                size: snapshot.size,
                                status: CleanupStatus::MovedToTrash,
                                message: "已移入系统回收站。".to_owned(),
                            },
                            Err(error) => CleanupItemResult {
                                path: snapshot.path.clone(),
                                size: snapshot.size,
                                status: CleanupStatus::Failed,
                                message: format!("移入回收站失败: {error}"),
                            },
                        },
                        Err(FingerprintError::Changed(message)) => CleanupItemResult {
                            path: snapshot.path.clone(),
                            size: snapshot.size,
                            status: CleanupStatus::Changed,
                            message: format!("文件自扫描后发生变化，已跳过: {message}"),
                        },
                        Err(FingerprintError::Io(error)) => CleanupItemResult {
                            path: snapshot.path.clone(),
                            size: snapshot.size,
                            status: CleanupStatus::Failed,
                            message: format!("文件复核失败: {error}"),
                        },
                        Err(FingerprintError::Cancelled) => CleanupItemResult {
                            path: snapshot.path.clone(),
                            size: snapshot.size,
                            status: CleanupStatus::Failed,
                            message: "文件复核被取消，已跳过。".to_owned(),
                        },
                    }
                };
                items.push(result);
            }
        }
        let moved_paths: BTreeSet<_> = items
            .iter()
            .filter(|item| item.status == CleanupStatus::MovedToTrash)
            .map(|item| item.path.clone())
            .collect();
        let reclaimable_bytes = groups
            .iter()
            .map(|group| group.reclaimable_bytes_for(&moved_paths))
            .sum();
        Ok(CleanupReport {
            items,
            reclaimable_bytes,
        })
    }

    fn verify_snapshot(
        &self,
        snapshot: &FileSnapshot,
        expected_digest: &str,
    ) -> Result<(), FingerprintError> {
        hash_snapshot(snapshot, &CancellationToken::new(), None, self.chunk_bytes).and_then(
            |digest| {
                if digest == expected_digest {
                    Ok(())
                } else {
                    Err(FingerprintError::Changed(
                        "完整内容摘要与扫描结果不一致".to_owned(),
                    ))
                }
            },
        )
    }
}

#[derive(Default)]
pub struct WindowsTrash;

#[cfg(windows)]
impl TrashPort for WindowsTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{
            FileOperation, IFileOperation, IFileOperationProgressSink, IShellItem,
            SHCreateItemFromParsingName, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
            FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        };

        if !path.is_absolute() {
            return Err("回收站操作只接受绝对路径".to_owned());
        }
        let shell_path = shell_compatible_path(path);
        let mut source: Vec<u16> = shell_path.as_os_str().encode_wide().collect();
        source.push(0);

        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        initialized
            .ok()
            .map_err(|error| format!("初始化 Windows Shell 失败: {error}"))?;
        let _apartment = ComApartment;
        let operation: IFileOperation = unsafe {
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
                .map_err(|error| format!("创建 Windows Shell 文件操作失败: {error}"))?
        };
        let flags = FOFX_RECYCLEONDELETE
            | FOFX_EARLYFAILURE
            | FOF_NOCONFIRMATION
            | FOF_NOERRORUI
            | FOF_SILENT;
        unsafe {
            operation
                .SetOperationFlags(flags)
                .map_err(|error| format!("配置 Windows 回收站操作失败: {error}"))?;
        }
        let item: IShellItem = unsafe {
            SHCreateItemFromParsingName(PCWSTR(source.as_ptr()), None)
                .map_err(|error| format!("无法解析待清理文件: {error}"))?
        };
        unsafe {
            operation
                .DeleteItem(&item, None::<&IFileOperationProgressSink>)
                .map_err(|error| format!("登记回收站操作失败: {error}"))?;
            operation
                .PerformOperations()
                .map_err(|error| format!("执行回收站操作失败: {error}"))?;
        }
        let aborted = unsafe {
            operation
                .GetAnyOperationsAborted()
                .map_err(|error| format!("读取回收站操作状态失败: {error}"))?
        };
        if aborted.as_bool() {
            return Err("Windows Shell 中止了回收站操作".to_owned());
        }
        Ok(())
    }
}

#[cfg(windows)]
struct ComApartment;

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(not(windows))]
impl TrashPort for WindowsTrash {
    fn move_to_trash(&self, _path: &Path) -> Result<(), String> {
        Err("当前回收站适配器仅支持 Windows".to_owned())
    }
}

#[cfg(windows)]
fn shell_compatible_path(path: &Path) -> std::path::PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    path.to_path_buf()
}

pub type SharedTrash = Arc<dyn TrashPort>;
