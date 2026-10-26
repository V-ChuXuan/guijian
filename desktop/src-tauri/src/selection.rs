use std::collections::{BTreeSet, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::DuplicateGroup;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSelection {
    pub group_id: String,
    pub cleanup_paths: BTreeSet<PathBuf>,
    pub reclaimable_bytes: u64,
    pub recommendation_reason: String,
}

impl GroupSelection {
    pub fn keep_paths(&self, group: &DuplicateGroup) -> Vec<PathBuf> {
        group
            .files
            .iter()
            .filter(|file| !self.cleanup_paths.contains(&file.path))
            .map(|file| file.path.clone())
            .collect()
    }

    pub fn reclaimable_bytes(&self, group: &DuplicateGroup) -> u64 {
        group.reclaimable_bytes_for(&self.cleanup_paths)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SelectionError {
    UnknownPath,
    WrongGroup,
    LastCopy,
}

impl Display for SelectionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnknownPath => "路径不属于当前重复组",
            Self::WrongGroup => "选择状态与重复组不匹配",
            Self::LastCopy => "每个重复组必须至少保留一份文件",
        })
    }
}

impl Error for SelectionError {}

pub fn recommended_selection(group: &DuplicateGroup) -> GroupSelection {
    let keeper = group.recommended_keeper();
    let cleanup_paths = group
        .files
        .iter()
        .filter(|file| file.path != keeper.path)
        .map(|file| file.path.clone())
        .collect();
    let mut selection = GroupSelection {
        group_id: group.id.clone(),
        cleanup_paths,
        reclaimable_bytes: 0,
        recommendation_reason: "默认保留路径最短的文件，路径长度相同时按名称稳定排序。".to_owned(),
    };
    selection.reclaimable_bytes = selection.reclaimable_bytes(group);
    selection
}

pub fn validate_selection(
    group: &DuplicateGroup,
    selection: &GroupSelection,
) -> Result<(), SelectionError> {
    if selection.group_id != group.id {
        return Err(SelectionError::WrongGroup);
    }
    let paths: HashSet<_> = group.files.iter().map(|file| file.path.as_path()).collect();
    if selection
        .cleanup_paths
        .iter()
        .any(|path| !paths.contains(path.as_path()))
    {
        return Err(SelectionError::UnknownPath);
    }
    if selection.cleanup_paths.len() >= group.files.len() {
        return Err(SelectionError::LastCopy);
    }
    Ok(())
}

pub fn update_selection(
    group: &DuplicateGroup,
    selection: &GroupSelection,
    path: &Path,
    should_cleanup: bool,
) -> Result<GroupSelection, SelectionError> {
    validate_selection(group, selection)?;
    if !group.contains_path(path) {
        return Err(SelectionError::UnknownPath);
    }
    let mut updated = selection.clone();
    if should_cleanup {
        updated.cleanup_paths.insert(path.to_path_buf());
    } else {
        updated.cleanup_paths.remove(path);
    }
    validate_selection(group, &updated)?;
    updated.reclaimable_bytes = updated.reclaimable_bytes(group);
    Ok(updated)
}
