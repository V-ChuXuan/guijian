use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::fs::{File, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressStage {
    Enumerating,
    PartialHash,
    FullHash,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct FileIdentity {
    pub volume: u64,
    pub file: u128,
}

impl FileIdentity {
    pub fn is_meaningful(self) -> bool {
        self.volume != 0 || self.file != 0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: PathBuf,
    pub size: u64,
    pub modified_at_ms: u64,
    pub identity: FileIdentity,
    pub hard_link_count: u64,
    pub digest: String,
}

impl FileSnapshot {
    pub(crate) fn capture(path: PathBuf, metadata: &Metadata, digest: String) -> Self {
        let physical =
            physical_file_info(&path, metadata).unwrap_or_else(|_| unknown_physical_file());
        Self {
            path,
            size: metadata.len(),
            modified_at_ms: modified_at_ms(metadata),
            identity: physical.identity,
            hard_link_count: physical.hard_link_count,
            digest,
        }
    }

    pub(crate) fn metadata_matches(&self, metadata: &Metadata) -> io::Result<bool> {
        Ok(self.size == metadata.len()
            && self.modified_at_ms == modified_at_ms(metadata)
            && physical_file_info(&self.path, metadata)?
                == PhysicalFileInfo {
                    identity: self.identity,
                    hard_link_count: self.hard_link_count,
                })
    }

    pub(crate) fn opened_file_matches(&self, file: &File, metadata: &Metadata) -> io::Result<bool> {
        Ok(self.size == metadata.len()
            && self.modified_at_ms == modified_at_ms(metadata)
            && physical_file_info_from_file(file, metadata)?
                == PhysicalFileInfo {
                    identity: self.identity,
                    hard_link_count: self.hard_link_count,
                })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    pub digest: String,
    pub size: u64,
    pub files: Vec<FileSnapshot>,
}

impl DuplicateGroup {
    pub(crate) fn from_files(mut files: Vec<FileSnapshot>) -> Result<Self, String> {
        if files.len() < 2 {
            return Err("重复组至少需要两个文件".to_owned());
        }
        files.sort_by(|left, right| compare_paths(&left.path, &right.path));
        let digest = files[0].digest.clone();
        let size = files[0].size;
        if digest.is_empty()
            || files
                .iter()
                .any(|file| file.digest != digest || file.size != size)
        {
            return Err("重复组文件摘要或大小不一致".to_owned());
        }
        for (index, file) in files.iter().enumerate() {
            if files[..index]
                .iter()
                .any(|previous| previous.path == file.path)
            {
                return Err("重复组不能包含相同路径".to_owned());
            }
        }
        Ok(Self {
            id: digest.clone(),
            digest,
            size,
            files,
        })
    }

    pub fn reclaimable_bytes(&self) -> u64 {
        let keeper = self.recommended_keeper();
        let cleanup_paths = self
            .files
            .iter()
            .filter(|file| file.path != keeper.path)
            .map(|file| file.path.clone())
            .collect();
        self.reclaimable_bytes_for(&cleanup_paths)
    }

    pub fn recommended_keeper(&self) -> &FileSnapshot {
        self.files
            .iter()
            .min_by(|left, right| compare_paths(&left.path, &right.path))
            .expect("duplicate groups always contain files")
    }

    pub fn reclaimable_bytes_for(&self, cleanup_paths: &BTreeSet<PathBuf>) -> u64 {
        let mut physical_files = HashMap::<FileIdentity, (u64, usize, usize)>::new();
        for file in &self.files {
            if !file.identity.is_meaningful() || file.hard_link_count == 0 {
                continue;
            }
            let entry = physical_files
                .entry(file.identity)
                .or_insert((file.hard_link_count, 0, 0));
            entry.0 = entry.0.max(file.hard_link_count);
            entry.1 += 1;
            if cleanup_paths.contains(&file.path) {
                entry.2 += 1;
            }
        }
        physical_files
            .values()
            .filter(|(link_count, visible_paths, selected_paths)| {
                *selected_paths > 0
                    && selected_paths == visible_paths
                    && *selected_paths as u64 == *link_count
            })
            .map(|_| self.size)
            .sum()
    }

    pub fn contains_path(&self, path: &Path) -> bool {
        self.files.iter().any(|file| file.path == path)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub stage: ProgressStage,
    pub path: PathBuf,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub stage: ProgressStage,
    pub scanned_files: usize,
    pub scanned_bytes: u64,
    pub candidate_files: usize,
    pub completed_files: usize,
    pub total_files: usize,
    pub current_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub groups: Vec<DuplicateGroup>,
    pub issues: Vec<ScanIssue>,
    pub scanned_files: usize,
    pub scanned_bytes: u64,
    pub candidate_files: usize,
    pub cancelled: bool,
}

impl ScanResult {
    pub fn cancelled(
        scanned_files: usize,
        scanned_bytes: u64,
        candidate_files: usize,
        issues: Vec<ScanIssue>,
    ) -> Self {
        Self {
            groups: Vec::new(),
            issues,
            scanned_files,
            scanned_bytes,
            candidate_files,
            cancelled: true,
        }
    }

    pub fn reclaimable_bytes(&self) -> u64 {
        self.groups
            .iter()
            .map(DuplicateGroup::reclaimable_bytes)
            .sum()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupStatus {
    MovedToTrash,
    Changed,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItemResult {
    pub path: PathBuf,
    pub size: u64,
    pub status: CleanupStatus,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub items: Vec<CleanupItemResult>,
    pub reclaimable_bytes: u64,
}

impl CleanupReport {
    pub fn succeeded_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.status == CleanupStatus::MovedToTrash)
            .count()
    }

    pub fn failed_count(&self) -> usize {
        self.items.len().saturating_sub(self.succeeded_count())
    }

    pub fn reclaimable_bytes(&self) -> u64 {
        self.reclaimable_bytes
    }
}

pub(crate) fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

pub(crate) fn compare_paths(left: &Path, right: &Path) -> Ordering {
    path_character_count(left)
        .cmp(&path_character_count(right))
        .then_with(|| path_key(left).cmp(&path_key(right)))
        .then_with(|| left.to_string_lossy().cmp(&right.to_string_lossy()))
}

fn path_character_count(path: &Path) -> usize {
    path.to_string_lossy().chars().count()
}

pub(crate) fn is_link_like(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn modified_at_ms(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PhysicalFileInfo {
    identity: FileIdentity,
    hard_link_count: u64,
}

fn unknown_physical_file() -> PhysicalFileInfo {
    PhysicalFileInfo {
        identity: FileIdentity { volume: 0, file: 0 },
        hard_link_count: 0,
    }
}

#[cfg(windows)]
fn physical_file_info(path: &Path, metadata: &Metadata) -> io::Result<PhysicalFileInfo> {
    let file = File::open(path)?;
    physical_file_info_from_file(&file, metadata)
}

#[cfg(windows)]
fn physical_file_info_from_file(file: &File, _metadata: &Metadata) -> io::Result<PhysicalFileInfo> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let result = unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle().cast()), &mut information)
    };
    result.map_err(|error| io::Error::other(error.to_string()))?;
    Ok(PhysicalFileInfo {
        identity: FileIdentity {
            volume: information.dwVolumeSerialNumber as u64,
            file: ((information.nFileIndexHigh as u128) << 32) | information.nFileIndexLow as u128,
        },
        hard_link_count: information.nNumberOfLinks as u64,
    })
}

#[cfg(unix)]
fn physical_file_info(_path: &Path, metadata: &Metadata) -> io::Result<PhysicalFileInfo> {
    use std::os::unix::fs::MetadataExt;

    Ok(PhysicalFileInfo {
        identity: FileIdentity {
            volume: metadata.dev(),
            file: metadata.ino() as u128,
        },
        hard_link_count: metadata.nlink(),
    })
}

#[cfg(unix)]
fn physical_file_info_from_file(_file: &File, metadata: &Metadata) -> io::Result<PhysicalFileInfo> {
    physical_file_info(Path::new(""), metadata)
}

#[cfg(not(any(windows, unix)))]
fn physical_file_info(_path: &Path, _metadata: &Metadata) -> io::Result<PhysicalFileInfo> {
    Ok(unknown_physical_file())
}

#[cfg(not(any(windows, unix)))]
fn physical_file_info_from_file(
    _file: &File,
    _metadata: &Metadata,
) -> io::Result<PhysicalFileInfo> {
    Ok(unknown_physical_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(path: &str) -> FileSnapshot {
        FileSnapshot {
            path: PathBuf::from(path),
            size: 9,
            modified_at_ms: 0,
            identity: FileIdentity { volume: 0, file: 0 },
            hard_link_count: 0,
            digest: "digest".to_owned(),
        }
    }

    #[test]
    fn keeper_order_is_stable_when_casefolded_paths_are_equal() {
        let expected = PathBuf::from(r"C:\Root\A.txt");
        let first = DuplicateGroup::from_files(vec![
            snapshot(r"c:\root\a.TXT"),
            snapshot(r"C:\Root\A.txt"),
        ])
        .unwrap();
        let second = DuplicateGroup::from_files(vec![
            snapshot(r"C:\Root\A.txt"),
            snapshot(r"c:\root\a.TXT"),
        ])
        .unwrap();

        assert_eq!(first.recommended_keeper().path, expected);
        assert_eq!(second.recommended_keeper().path, expected);
        assert_eq!(first.files, second.files);
    }
}
