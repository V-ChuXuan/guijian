use std::fs::{self, File, Metadata};
use std::io::{self, Read};

use sha2::{Digest, Sha256};

use crate::domain::{is_link_like, FileSnapshot};
use crate::scanner::CancellationToken;

#[derive(Debug)]
pub(crate) enum FingerprintError {
    Cancelled,
    Changed(String),
    Io(io::Error),
}

impl FingerprintError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Cancelled => "操作已取消".to_owned(),
            Self::Changed(message) => message.clone(),
            Self::Io(error) => error.to_string(),
        }
    }
}

pub(crate) fn hash_snapshot(
    snapshot: &FileSnapshot,
    cancellation: &CancellationToken,
    limit: Option<usize>,
    chunk_bytes: usize,
) -> Result<String, FingerprintError> {
    require_current_path(snapshot, "读取前")?;

    let mut source = File::open(&snapshot.path).map_err(FingerprintError::Io)?;
    let opened = source.metadata().map_err(FingerprintError::Io)?;
    require_opened_file(snapshot, &source, &opened, "打开后")?;
    require_current_path(snapshot, "打开后")?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; chunk_bytes];
    let mut remaining = limit.unwrap_or(usize::MAX);
    while remaining > 0 {
        if cancellation.is_cancelled() {
            return Err(FingerprintError::Cancelled);
        }
        let read_size = buffer.len().min(remaining);
        let read = source
            .read(&mut buffer[..read_size])
            .map_err(FingerprintError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        remaining = remaining.saturating_sub(read);
    }

    let after = source.metadata().map_err(FingerprintError::Io)?;
    require_opened_file(snapshot, &source, &after, "读取后")?;
    require_current_path(snapshot, "读取后")?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn require_current_path(
    snapshot: &FileSnapshot,
    stage: &str,
) -> Result<Metadata, FingerprintError> {
    let metadata = fs::symlink_metadata(&snapshot.path).map_err(FingerprintError::Io)?;
    if is_link_like(&metadata) || !metadata.is_file() {
        return Err(FingerprintError::Changed(format!(
            "{stage}路径已变为符号链接、重解析点或非普通文件"
        )));
    }
    if !snapshot
        .metadata_matches(&metadata)
        .map_err(FingerprintError::Io)?
    {
        return Err(FingerprintError::Changed(format!(
            "{stage}文件已不是扫描时记录的文件"
        )));
    }
    Ok(metadata)
}

fn require_opened_file(
    snapshot: &FileSnapshot,
    file: &File,
    metadata: &Metadata,
    stage: &str,
) -> Result<(), FingerprintError> {
    if !metadata.is_file()
        || !snapshot
            .opened_file_matches(file, metadata)
            .map_err(FingerprintError::Io)?
    {
        return Err(FingerprintError::Changed(format!(
            "{stage}打开的文件已不是扫描时记录的文件"
        )));
    }
    Ok(())
}
