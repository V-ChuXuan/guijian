use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::domain::{
    is_link_like, path_key, DuplicateGroup, FileSnapshot, ProgressStage, ScanIssue, ScanProgress,
    ScanResult,
};
use crate::fingerprint::{hash_snapshot, FingerprintError};

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) fn same_operation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScanError {
    InvalidRoot(String),
    Io(String),
}

impl Display for ScanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRoot(message) | Self::Io(message) => formatter.write_str(message),
        }
    }
}

impl Error for ScanError {}

#[derive(Clone, Debug)]
pub struct DuplicateScanner {
    head_bytes: usize,
    chunk_bytes: usize,
}

impl Default for DuplicateScanner {
    fn default() -> Self {
        Self::with_buffer_sizes(64 * 1024, 1024 * 1024)
    }
}

impl DuplicateScanner {
    pub fn with_buffer_sizes(head_bytes: usize, chunk_bytes: usize) -> Self {
        assert!(
            head_bytes > 0 && chunk_bytes > 0,
            "hash buffers must be non-zero"
        );
        Self {
            head_bytes,
            chunk_bytes,
        }
    }

    pub fn scan(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<ScanResult, ScanError> {
        self.scan_with_progress(root, cancellation, |_| {})
    }

    pub fn scan_with_progress<F>(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<ScanResult, ScanError>
    where
        F: FnMut(ScanProgress),
    {
        let root = validated_root(root)?;
        if cancellation.is_cancelled() {
            return Ok(ScanResult::cancelled(0, 0, 0, Vec::new()));
        }

        let mut issues = Vec::new();
        let mut scanned_files = 0;
        let mut scanned_bytes = 0_u64;
        let mut sizes: BTreeMap<u64, Vec<FileSnapshot>> = BTreeMap::new();
        let mut directories = vec![root.clone()];

        while let Some(directory) = directories.pop() {
            if cancellation.is_cancelled() {
                return Ok(ScanResult::cancelled(
                    scanned_files,
                    scanned_bytes,
                    0,
                    issues,
                ));
            }
            // Revalidate queued paths to reduce directory-swap/reparse escape risk.
            // This narrows the race window but does not claim to make path traversal atomic.
            let directory = match validated_directory(&directory, &root) {
                Ok(directory) => directory,
                Err(message) => {
                    issues.push(ScanIssue {
                        stage: ProgressStage::Enumerating,
                        path: directory,
                        message,
                    });
                    continue;
                }
            };
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) => {
                    issues.push(ScanIssue {
                        stage: ProgressStage::Enumerating,
                        path: directory,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            for entry in entries {
                if cancellation.is_cancelled() {
                    return Ok(ScanResult::cancelled(
                        scanned_files,
                        scanned_bytes,
                        0,
                        issues,
                    ));
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        issues.push(ScanIssue {
                            stage: ProgressStage::Enumerating,
                            path: directory.clone(),
                            message: error.to_string(),
                        });
                        continue;
                    }
                };
                let path = entry.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        issues.push(ScanIssue {
                            stage: ProgressStage::Enumerating,
                            path,
                            message: error.to_string(),
                        });
                        continue;
                    }
                };
                if is_link_like(&metadata) {
                    issues.push(ScanIssue {
                        stage: ProgressStage::Enumerating,
                        path,
                        message: "符号链接或重解析点不会被扫描".to_owned(),
                    });
                    continue;
                }
                if metadata.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                if let Err(message) = validate_file_within_root(&path, &root) {
                    issues.push(ScanIssue {
                        stage: ProgressStage::Enumerating,
                        path,
                        message,
                    });
                    continue;
                }
                scanned_files += 1;
                scanned_bytes = scanned_bytes.saturating_add(metadata.len());
                progress(ScanProgress {
                    stage: ProgressStage::Enumerating,
                    scanned_files,
                    scanned_bytes,
                    candidate_files: 0,
                    completed_files: 0,
                    total_files: 0,
                    current_path: Some(path.clone()),
                });
                if metadata.len() == 0 {
                    continue;
                }
                let snapshot = FileSnapshot::capture(path, &metadata, String::new());
                sizes.entry(snapshot.size).or_default().push(snapshot);
            }
        }

        progress(ScanProgress {
            stage: ProgressStage::Enumerating,
            scanned_files,
            scanned_bytes,
            candidate_files: 0,
            completed_files: 0,
            total_files: 0,
            current_path: None,
        });
        let candidates: Vec<_> = sizes
            .into_values()
            .filter(|files| files.len() > 1)
            .flatten()
            .collect();
        let candidate_files = candidates.len();
        let mut partials: BTreeMap<(u64, String), Vec<FileSnapshot>> = BTreeMap::new();
        for (completed, snapshot) in candidates.into_iter().enumerate() {
            progress(ScanProgress {
                stage: ProgressStage::PartialHash,
                scanned_files,
                scanned_bytes,
                candidate_files,
                completed_files: completed,
                total_files: candidate_files,
                current_path: Some(snapshot.path.clone()),
            });
            match hash_snapshot(
                &snapshot,
                cancellation,
                Some(self.head_bytes),
                self.chunk_bytes,
            ) {
                Ok(digest) => partials
                    .entry((snapshot.size, digest))
                    .or_default()
                    .push(snapshot),
                Err(FingerprintError::Cancelled) => {
                    return Ok(ScanResult::cancelled(
                        scanned_files,
                        scanned_bytes,
                        candidate_files,
                        issues,
                    ));
                }
                Err(error) => issues.push(ScanIssue {
                    stage: ProgressStage::PartialHash,
                    path: snapshot.path,
                    message: error.message(),
                }),
            }
        }

        progress(ScanProgress {
            stage: ProgressStage::PartialHash,
            scanned_files,
            scanned_bytes,
            candidate_files,
            completed_files: candidate_files,
            total_files: candidate_files,
            current_path: None,
        });
        let full_candidates: Vec<_> = partials
            .into_values()
            .filter(|files| files.len() > 1)
            .flatten()
            .collect();
        let full_total = full_candidates.len();
        let mut full: BTreeMap<(u64, String), Vec<FileSnapshot>> = BTreeMap::new();
        for (completed, mut snapshot) in full_candidates.into_iter().enumerate() {
            progress(ScanProgress {
                stage: ProgressStage::FullHash,
                scanned_files,
                scanned_bytes,
                candidate_files,
                completed_files: completed,
                total_files: full_total,
                current_path: Some(snapshot.path.clone()),
            });
            match hash_snapshot(&snapshot, cancellation, None, self.chunk_bytes) {
                Ok(digest) => {
                    snapshot.digest = digest.clone();
                    full.entry((snapshot.size, digest))
                        .or_default()
                        .push(snapshot);
                }
                Err(FingerprintError::Cancelled) => {
                    return Ok(ScanResult::cancelled(
                        scanned_files,
                        scanned_bytes,
                        candidate_files,
                        issues,
                    ));
                }
                Err(error) => issues.push(ScanIssue {
                    stage: ProgressStage::FullHash,
                    path: snapshot.path,
                    message: error.message(),
                }),
            }
        }

        progress(ScanProgress {
            stage: ProgressStage::FullHash,
            scanned_files,
            scanned_bytes,
            candidate_files,
            completed_files: full_total,
            total_files: full_total,
            current_path: None,
        });
        let mut groups = full
            .into_values()
            .filter(|files| files.len() > 1)
            .map(DuplicateGroup::from_files)
            .collect::<Result<Vec<_>, _>>()
            .map_err(ScanError::Io)?;
        groups.sort_by(|left, right| {
            right
                .reclaimable_bytes()
                .cmp(&left.reclaimable_bytes())
                .then_with(|| {
                    path_key(&left.recommended_keeper().path)
                        .cmp(&path_key(&right.recommended_keeper().path))
                })
                .then_with(|| {
                    left.recommended_keeper()
                        .path
                        .to_string_lossy()
                        .cmp(&right.recommended_keeper().path.to_string_lossy())
                })
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(ScanResult {
            groups,
            issues,
            scanned_files,
            scanned_bytes,
            candidate_files,
            cancelled: false,
        })
    }
}

pub fn validated_root(root: &Path) -> Result<PathBuf, ScanError> {
    if !root.is_absolute() {
        return Err(ScanError::InvalidRoot("扫描位置必须是绝对路径".to_owned()));
    }
    let link_metadata = fs::symlink_metadata(root)
        .map_err(|error| ScanError::InvalidRoot(format!("扫描位置不可访问: {error}")))?;
    if is_link_like(&link_metadata) || !link_metadata.is_dir() {
        return Err(ScanError::InvalidRoot(
            "扫描位置必须是现有的真实目录".to_owned(),
        ));
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| ScanError::InvalidRoot(format!("扫描位置不可访问: {error}")))?;
    Ok(normalize_windows_path(canonical))
}

fn validated_directory(directory: &Path, root: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|error| format!("待遍历目录不可访问: {error}"))?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err("待遍历路径已变为重解析点或非目录，已跳过".to_owned());
    }
    canonical_path_within_root(directory, root, "目录")
}

fn validate_file_within_root(path: &Path, root: &Path) -> Result<(), String> {
    canonical_path_within_root(path, root, "文件").map(|_| ())
}

fn canonical_path_within_root(path: &Path, root: &Path, kind: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map(normalize_windows_path)
        .map_err(|error| format!("{kind}规范化失败: {error}"))?;
    if !path_is_within_root(&canonical, root) {
        return Err(format!("{kind}规范化后已超出扫描根目录，已跳过"));
    }
    Ok(canonical)
}

fn path_is_within_root(path: &Path, root: &Path) -> bool {
    let mut path_components = path.components();
    root.components().all(|root_component| {
        path_components
            .next()
            .is_some_and(|path_component| components_equal(path_component, root_component))
    })
}

#[cfg(windows)]
fn components_equal(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left.as_os_str().to_string_lossy().to_lowercase()
        == right.as_os_str().to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn components_equal(left: std::path::Component<'_>, right: std::path::Component<'_>) -> bool {
    left == right
}

#[cfg(windows)]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    path
}
