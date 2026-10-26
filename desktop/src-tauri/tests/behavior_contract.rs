use std::collections::BTreeSet;
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use desktop_lib::cleanup::{CleanupService, TrashPort};
use desktop_lib::domain::{CleanupStatus, DuplicateGroup, ProgressStage, ScanProgress};
use desktop_lib::scanner::{validated_root, CancellationToken, DuplicateScanner};
use desktop_lib::selection::{recommended_selection, update_selection, SelectionError};
use serde::Deserialize;

const CONTRACT_JSON: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/duplicate_contract_v1.json"
);

#[derive(Debug, Deserialize)]
struct ContractManifest {
    schema_version: u32,
    scanner: ScannerConfig,
    files: Vec<FileEntry>,
    links: Vec<LinkEntry>,
    expected_groups: Vec<ExpectedGroup>,
    stage_expectations: StageExpectations,
    selection_case: SelectionCase,
    changed_cleanup_case: ChangedCleanupCase,
}

#[derive(Debug, Deserialize)]
struct ScannerConfig {
    head_bytes: usize,
    chunk_bytes: usize,
}

#[derive(Debug, Deserialize)]
struct FileEntry {
    path: String,
    content_utf8: String,
    mtime_ns: u64,
}

#[derive(Debug, Deserialize)]
struct LinkEntry {
    kind: String,
    path: String,
    target: Option<String>,
    external_path: Option<String>,
    external_content_utf8: Option<String>,
    required: bool,
}

#[derive(Debug, Deserialize)]
struct ExpectedGroup {
    id: String,
    digest: String,
    size: u64,
    members: Vec<String>,
    default_keeper: String,
    reclaimable_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct StageExpectations {
    partial_excludes: Vec<String>,
    full_includes: Vec<String>,
    never_grouped: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SelectionCase {
    group_id: String,
    attempt_cleanup: String,
    expected_error: String,
}

#[derive(Debug, Deserialize)]
struct ChangedCleanupCase {
    group_id: String,
    cleanup_path: String,
    replacement_content_utf8: String,
    restore_mtime: bool,
    expected_status: String,
    expected_trash_calls: usize,
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CanonicalGroup {
    digest: String,
    size: u64,
    members: Vec<String>,
    default_keeper: String,
    reclaimable_bytes: u64,
}

struct ContractDirectory {
    base: PathBuf,
    root: PathBuf,
    external_root: PathBuf,
    hardlink_supported: bool,
    isolation_link: Option<(PathBuf, &'static str)>,
}

impl ContractDirectory {
    fn materialize(manifest: &ContractManifest, name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "guijian-contract-{name}-{}-{unique}",
            std::process::id()
        ));
        // Exercise a noncanonical TEMP alias without changing process-wide environment.
        let root = base.join("fixture-parent").join("..").join("scan-root");
        let external_root = base.join("outside-root");
        fs::create_dir_all(&root).expect("create contract scan root");
        fs::create_dir_all(&external_root).expect("create contract external root");
        let root = validated_root(&root).expect("normalize contract scan root");

        for entry in &manifest.files {
            let path = safe_join(&root, &entry.path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create contract parent");
            }
            fs::write(&path, entry.content_utf8.as_bytes()).expect("write contract file");
            set_modified_ns(&path, entry.mtime_ns);
        }

        let mut hardlink_supported = false;
        let mut isolation_link = None;
        for entry in &manifest.links {
            let link = safe_join(&root, &entry.path);
            if let Some(parent) = link.parent() {
                fs::create_dir_all(parent).expect("create link parent");
            }
            let result = match entry.kind.as_str() {
                "hardlink" => fs::hard_link(
                    safe_join(
                        &root,
                        entry
                            .target
                            .as_deref()
                            .expect("hardlink target is required"),
                    ),
                    &link,
                ),
                "symlink" => {
                    let target = safe_join(
                        &external_root,
                        entry
                            .external_path
                            .as_deref()
                            .expect("symlink external path is required"),
                    );
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).expect("create external parent");
                    }
                    fs::write(
                        &target,
                        entry
                            .external_content_utf8
                            .as_deref()
                            .expect("symlink content is required")
                            .as_bytes(),
                    )
                    .expect("write external symlink target");
                    create_isolation_link(&target, &link).map(|kind| {
                        isolation_link = Some((link.clone(), kind));
                    })
                }
                other => panic!("unknown contract link kind: {other}"),
            };
            match result {
                Ok(()) if entry.kind == "hardlink" => hardlink_supported = true,
                Ok(()) if entry.kind == "symlink" => {}
                Ok(()) => unreachable!(),
                Err(error) if entry.required => {
                    panic!(
                        "required {} fixture could not be created: {error}",
                        entry.kind
                    )
                }
                Err(_) => {}
            }
        }
        Self {
            base,
            root,
            external_root,
            hardlink_supported,
            isolation_link,
        }
    }

    fn unlink_isolation_fixture(&mut self) {
        if let Some((link, kind)) = self.isolation_link.take() {
            if kind == "directory junction" {
                fs::remove_dir(link).expect("remove only the synthetic junction, not its target");
            } else {
                fs::remove_file(link).expect("remove only the synthetic symlink, not its target");
            }
        }
    }
}

impl Drop for ContractDirectory {
    fn drop(&mut self) {
        self.unlink_isolation_fixture();
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[derive(Default)]
struct RecordingTrash {
    paths: Mutex<Vec<PathBuf>>,
}

impl TrashPort for RecordingTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        self.paths
            .lock()
            .expect("trash lock")
            .push(path.to_path_buf());
        Ok(())
    }
}

fn load_manifest() -> ContractManifest {
    let content = fs::read_to_string(CONTRACT_JSON).expect("read Rust behavior contract JSON");
    let manifest: ContractManifest =
        serde_json::from_str(&content).expect("parse Rust behavior contract JSON");
    assert_eq!(manifest.schema_version, 1, "unsupported contract schema");
    manifest
}

fn scan_contract(
    manifest: &ContractManifest,
    directory: &ContractDirectory,
) -> (desktop_lib::domain::ScanResult, Vec<ScanProgress>) {
    let mut progress = Vec::new();
    let result = DuplicateScanner::with_buffer_sizes(
        manifest.scanner.head_bytes,
        manifest.scanner.chunk_bytes,
    )
    .scan_with_progress(&directory.root, &CancellationToken::new(), |event| {
        progress.push(event)
    })
    .expect("contract scan succeeds");
    (result, progress)
}

fn canonical_groups(groups: &[DuplicateGroup], root: &Path) -> Vec<CanonicalGroup> {
    let mut canonical: Vec<_> = groups
        .iter()
        .map(|group| {
            let selection = recommended_selection(group);
            let mut members: Vec<_> = group
                .files
                .iter()
                .map(|file| relative_path(root, &file.path))
                .collect();
            members.sort();
            CanonicalGroup {
                digest: group.digest.clone(),
                size: group.size,
                members,
                default_keeper: relative_path(root, &selection.keep_paths(group)[0]),
                reclaimable_bytes: group.reclaimable_bytes(),
            }
        })
        .collect();
    canonical.sort();
    canonical
}

fn expected_groups(
    manifest: &ContractManifest,
    link_support: impl Fn(&str) -> bool,
) -> Vec<CanonicalGroup> {
    let unsupported_paths: BTreeSet<_> = manifest
        .links
        .iter()
        .filter(|link| !link_support(&link.kind))
        .map(|link| link.path.clone())
        .collect();
    let mut expected: Vec<_> = manifest
        .expected_groups
        .iter()
        .map(|group| {
            let mut members: Vec<_> = group
                .members
                .iter()
                .filter(|path| !unsupported_paths.contains(*path))
                .cloned()
                .collect();
            members.sort();
            CanonicalGroup {
                digest: group.digest.clone(),
                size: group.size,
                members,
                default_keeper: group.default_keeper.clone(),
                reclaimable_bytes: group.reclaimable_bytes,
            }
        })
        .collect();
    expected.sort();
    expected
}

fn group_by_contract_id<'a>(
    manifest: &ContractManifest,
    groups: &'a [DuplicateGroup],
    root: &Path,
    id: &str,
) -> &'a DuplicateGroup {
    let expected = manifest
        .expected_groups
        .iter()
        .find(|group| group.id == id)
        .expect("contract group id exists");
    let expected_members: BTreeSet<_> = expected.members.iter().cloned().collect();
    groups
        .iter()
        .find(|group| {
            group
                .files
                .iter()
                .map(|file| relative_path(root, &file.path))
                .collect::<BTreeSet<_>>()
                == expected_members
        })
        .expect("scanned contract group exists")
}

fn safe_join(root: &Path, relative: &str) -> PathBuf {
    let path = Path::new(relative);
    assert!(
        !path.is_absolute()
            && path
                .components()
                .all(|component| matches!(component, Component::Normal(_))),
        "unsafe contract path: {relative}"
    );
    root.join(path)
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .expect("path belongs to contract root")
        .to_string_lossy()
        .replace('\\', "/")
}

fn set_modified_ns(path: &Path, value: u64) {
    File::options()
        .write(true)
        .open(path)
        .expect("open contract file")
        .set_modified(UNIX_EPOCH + Duration::from_nanos(value))
        .expect("set contract mtime");
}

#[cfg(windows)]
fn create_isolation_link(target: &Path, link: &Path) -> std::io::Result<&'static str> {
    use std::os::windows::process::CommandExt;

    if std::os::windows::fs::symlink_file(target, link).is_ok() {
        return Ok("file symlink");
    }
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link.components().collect::<PathBuf>())
        .arg(
            target
                .parent()
                .expect("synthetic target has a parent")
                .components()
                .collect::<PathBuf>(),
        )
        .creation_flags(0x0800_0000)
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "neither file symlink nor directory junction could be created: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok("directory junction")
}

#[cfg(unix)]
fn create_isolation_link(target: &Path, link: &Path) -> std::io::Result<&'static str> {
    std::os::unix::fs::symlink(target, link)?;
    Ok("file symlink")
}

#[cfg(not(any(windows, unix)))]
fn create_isolation_link(_target: &Path, _link: &Path) -> std::io::Result<&'static str> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlink fixture is unsupported",
    ))
}

#[test]
fn rust_scan_matches_the_shared_canonical_fixture() {
    let manifest = load_manifest();
    let directory = ContractDirectory::materialize(&manifest, "canonical");
    let (result, progress) = scan_contract(&manifest, &directory);

    assert_eq!(
        canonical_groups(&result.groups, &directory.root),
        expected_groups(&manifest, |kind| match kind {
            "hardlink" => directory.hardlink_supported,
            "symlink" => directory.isolation_link.is_some(),
            _ => false,
        })
    );
    let partial_paths: BTreeSet<_> = progress
        .iter()
        .filter(|event| event.stage == ProgressStage::PartialHash)
        .filter_map(|event| event.current_path.as_ref())
        .map(|path| relative_path(&directory.root, path))
        .collect();
    let full_paths: BTreeSet<_> = progress
        .iter()
        .filter(|event| event.stage == ProgressStage::FullHash)
        .filter_map(|event| event.current_path.as_ref())
        .map(|path| relative_path(&directory.root, path))
        .collect();
    assert!(manifest
        .stage_expectations
        .partial_excludes
        .iter()
        .all(|path| !partial_paths.contains(path)));
    assert!(manifest
        .stage_expectations
        .full_includes
        .iter()
        .all(|path| full_paths.contains(path)));
    let grouped: BTreeSet<_> = result
        .groups
        .iter()
        .flat_map(|group| group.files.iter())
        .map(|file| relative_path(&directory.root, &file.path))
        .collect();
    assert!(manifest
        .stage_expectations
        .never_grouped
        .iter()
        .all(|path| !grouped.contains(path)));
}

#[test]
fn hardlink_alias_is_selected_by_the_same_path_policy() {
    let manifest = load_manifest();
    let directory = ContractDirectory::materialize(&manifest, "hardlink");
    assert!(
        directory.hardlink_supported,
        "hardlink safety fixture is required"
    );
    let (result, _) = scan_contract(&manifest, &directory);
    let alias = safe_join(&directory.root, "hard/10-alias.bin");
    let source = safe_join(&directory.root, "hard/00-source.bin");

    assert!(alias.metadata().expect("alias metadata").is_file());
    assert_eq!(
        canonical_groups(&result.groups, &directory.root),
        expected_groups(&manifest, |kind| kind == "hardlink")
    );
    assert_eq!(fs::read(&alias).unwrap(), fs::read(source).unwrap());
    let group = result
        .groups
        .iter()
        .find(|group| group.files.iter().any(|file| file.path == alias))
        .expect("hardlink alias should be visible in its duplicate group");
    assert_eq!(group.reclaimable_bytes(), 18);
    assert_eq!(
        recommended_selection(group)
            .cleanup_paths
            .iter()
            .map(|path| relative_path(&directory.root, path))
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "hard/00-source.bin".to_owned(),
            "hard/20-real-copy.bin".to_owned(),
        ])
    );
}

#[test]
fn reparse_link_outside_root_is_visible_and_never_followed() {
    let manifest = load_manifest();
    let mut directory = ContractDirectory::materialize(&manifest, "symlink");
    let (link, kind) = directory
        .isolation_link
        .as_ref()
        .expect("root isolation fixture is required");
    eprintln!("root isolation assertion executes with a real {kind}");
    let (result, _) = scan_contract(&manifest, &directory);

    let metadata = link.symlink_metadata().unwrap();
    if *kind == "directory junction" {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;

            assert_ne!(metadata.file_attributes() & 0x400, 0);
        }
    } else {
        assert!(metadata.file_type().is_symlink());
    }
    assert!(result.issues.iter().any(|issue| issue.path == *link));
    assert!(!result
        .groups
        .iter()
        .flat_map(|group| group.files.iter())
        .any(|file| file.path.starts_with(link)));
    let outside = directory.external_root.join("outside.bin");
    let external_content = &manifest
        .links
        .iter()
        .find(|entry| entry.kind == "symlink")
        .unwrap()
        .external_content_utf8
        .as_ref()
        .unwrap();
    assert_eq!(fs::read(&outside).unwrap(), external_content.as_bytes());
    directory.unlink_isolation_fixture();
    assert_eq!(
        fs::read(&outside).unwrap(),
        external_content.as_bytes(),
        "unlinking the isolation fixture must not remove its target"
    );
}

#[test]
fn shared_fixture_locks_default_keeper_and_last_copy_protection() {
    let manifest = load_manifest();
    let directory = ContractDirectory::materialize(&manifest, "selection");
    let (result, _) = scan_contract(&manifest, &directory);

    for expected in &manifest.expected_groups {
        let group = group_by_contract_id(&manifest, &result.groups, &directory.root, &expected.id);
        let selection = recommended_selection(group);
        assert_eq!(
            relative_path(&directory.root, &selection.keep_paths(group)[0]),
            expected.default_keeper
        );
    }

    assert_eq!(manifest.selection_case.expected_error, "last_copy");
    let group = group_by_contract_id(
        &manifest,
        &result.groups,
        &directory.root,
        &manifest.selection_case.group_id,
    );
    let selection = recommended_selection(group);
    let error = update_selection(
        group,
        &selection,
        &safe_join(&directory.root, &manifest.selection_case.attempt_cleanup),
        true,
    )
    .expect_err("last copy must be rejected");
    assert_eq!(error, SelectionError::LastCopy);
}

#[test]
fn shared_fixture_change_with_restored_mtime_is_blocked_before_trash() {
    let manifest = load_manifest();
    let directory = ContractDirectory::materialize(&manifest, "changed");
    let (result, _) = scan_contract(&manifest, &directory);
    let cleanup_case = &manifest.changed_cleanup_case;
    let group = group_by_contract_id(
        &manifest,
        &result.groups,
        &directory.root,
        &cleanup_case.group_id,
    );
    let cleanup_path = safe_join(&directory.root, &cleanup_case.cleanup_path);
    let original_modified = cleanup_path.metadata().unwrap().modified().unwrap();
    fs::write(
        &cleanup_path,
        cleanup_case.replacement_content_utf8.as_bytes(),
    )
    .unwrap();
    if cleanup_case.restore_mtime {
        File::options()
            .write(true)
            .open(&cleanup_path)
            .unwrap()
            .set_modified(original_modified)
            .unwrap();
    }
    let selection = recommended_selection(group);
    assert!(selection.cleanup_paths.contains(&cleanup_path));
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(std::slice::from_ref(group), &[selection])
        .unwrap();

    assert_eq!(cleanup_case.expected_status, "changed");
    assert_eq!(report.items[0].status, CleanupStatus::Changed);
    assert_eq!(
        trash.paths.lock().unwrap().len(),
        cleanup_case.expected_trash_calls
    );
    assert!(cleanup_path.exists());
    assert!(safe_join(
        &directory.root,
        &manifest
            .expected_groups
            .iter()
            .find(|expected| expected.id == cleanup_case.group_id)
            .unwrap()
            .default_keeper
    )
    .exists());
}
