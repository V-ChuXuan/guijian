use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use desktop_lib::cleanup::{CleanupService, TrashPort};
use desktop_lib::domain::{CleanupStatus, ProgressStage};
use desktop_lib::scanner::{CancellationToken, DuplicateScanner};
use desktop_lib::selection::{
    recommended_selection, update_selection, validate_selection, SelectionError,
};

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("guijian-{name}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        Self { path }
    }

    fn write(&self, relative: &str, content: &[u8]) -> PathBuf {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&path, content).expect("write fixture");
        path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Default)]
struct RecordingTrash {
    paths: Mutex<Vec<PathBuf>>,
    fail: bool,
}

struct KeeperChangingTrash {
    paths: Mutex<Vec<PathBuf>>,
    keeper: PathBuf,
}

impl TrashPort for KeeperChangingTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        let mut paths = self.paths.lock().expect("trash lock");
        paths.push(path.to_path_buf());
        if paths.len() == 1 {
            fs::write(&self.keeper, b"changed!!").expect("change keeper after first cleanup");
        }
        Ok(())
    }
}

impl TrashPort for RecordingTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        if self.fail {
            return Err("trash unavailable".to_owned());
        }
        self.paths
            .lock()
            .expect("trash lock")
            .push(path.to_path_buf());
        Ok(())
    }
}

#[test]
fn three_stage_scan_finds_only_exact_non_empty_duplicates() {
    let fixtures = TestDirectory::new("scan");
    let original = fixtures.write("inbox/original.bin", &b"same-content".repeat(32));
    let copy = fixtures.write("archive/copy.bin", &b"same-content".repeat(32));
    let different = fixtures.write("archive/different.bin", &b"different!!!".repeat(32));
    fixtures.write("empty-a", b"");
    fixtures.write("empty-b", b"");
    let mut stages = Vec::new();

    let result = DuplicateScanner::with_buffer_sizes(16, 32)
        .scan_with_progress(&fixtures.path, &CancellationToken::new(), |progress| {
            stages.push(progress.stage)
        })
        .expect("scan should complete");

    assert!(!result.cancelled);
    assert_eq!(result.scanned_files, 5);
    assert_eq!(
        result.scanned_bytes,
        original.metadata().unwrap().len()
            + copy.metadata().unwrap().len()
            + different.metadata().unwrap().len()
    );
    assert_eq!(result.groups.len(), 1);
    let paths: Vec<_> = result.groups[0]
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect();
    assert!(paths.contains(&original));
    assert!(paths.contains(&copy));
    assert_eq!(
        result.reclaimable_bytes(),
        original.metadata().unwrap().len()
    );
    assert!(stages.contains(&ProgressStage::Enumerating));
    assert!(stages.contains(&ProgressStage::PartialHash));
    assert!(stages.contains(&ProgressStage::FullHash));
}

#[test]
fn scan_progress_finishes_each_phase_with_actual_completed_counts() {
    let fixtures = TestDirectory::new("progress-counts");
    fixtures.write("a.bin", b"duplicate");
    fixtures.write("b.bin", b"duplicate");
    fixtures.write("different.bin", b"different");
    let mut events = Vec::new();

    let result = DuplicateScanner::with_buffer_sizes(4, 4)
        .scan_with_progress(&fixtures.path, &CancellationToken::new(), |event| {
            events.push(event);
        })
        .unwrap();

    let enumeration = events
        .iter()
        .rfind(|event| event.stage == ProgressStage::Enumerating)
        .unwrap();
    assert_eq!(enumeration.scanned_files, result.scanned_files);
    assert_eq!(enumeration.scanned_bytes, result.scanned_bytes);
    assert_eq!(enumeration.total_files, 0);
    assert!(enumeration.current_path.is_none());
    for (stage, expected_total) in [
        (ProgressStage::PartialHash, 3),
        (ProgressStage::FullHash, 2),
    ] {
        let phase: Vec<_> = events.iter().filter(|event| event.stage == stage).collect();
        assert!(phase
            .iter()
            .all(|event| event.completed_files <= event.total_files));
        assert_eq!(phase.first().unwrap().completed_files, 0);
        assert_eq!(phase.last().unwrap().completed_files, expected_total);
        assert_eq!(phase.last().unwrap().total_files, expected_total);
        assert!(phase.last().unwrap().current_path.is_none());
    }
}

#[test]
fn empty_scan_still_finishes_all_progress_phases() {
    let fixtures = TestDirectory::new("empty-progress");
    let mut events = Vec::new();
    DuplicateScanner::default()
        .scan_with_progress(&fixtures.path, &CancellationToken::new(), |event| {
            events.push(event);
        })
        .unwrap();

    assert_eq!(events.len(), 3);
    assert_eq!(events[0].stage, ProgressStage::Enumerating);
    assert_eq!(events[1].stage, ProgressStage::PartialHash);
    assert_eq!(events[2].stage, ProgressStage::FullHash);
    assert!(events.iter().all(|event| event.completed_files == 0
        && event.total_files == 0
        && event.current_path.is_none()));
}

#[test]
fn same_size_and_prefix_but_different_full_content_are_not_grouped() {
    let fixtures = TestDirectory::new("collision");
    fixtures.write("a.bin", b"common-prefix-A");
    fixtures.write("b.bin", b"common-prefix-B");

    let result = DuplicateScanner::with_buffer_sizes(13, 4)
        .scan(&fixtures.path, &CancellationToken::new())
        .expect("scan should complete");

    assert!(result.groups.is_empty());
}

#[test]
fn equal_capacity_groups_are_sorted_by_representative_path() {
    let fixtures = TestDirectory::new("group-order");
    fixtures.write("z-group/a.bin", b"first-content");
    fixtures.write("z-group/b.bin", b"first-content");
    fixtures.write("a-group/a.bin", b"other-content");
    fixtures.write("a-group/b.bin", b"other-content");

    let result = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();

    assert_eq!(result.groups.len(), 2);
    assert!(result.groups[0]
        .recommended_keeper()
        .path
        .to_string_lossy()
        .contains("a-group"));
}

#[test]
fn hardlink_paths_are_auto_selected_as_content_duplicates() {
    let fixtures = TestDirectory::new("hardlink-paths");
    let source = fixtures.write("工商注册流程ai化.docx", b"same-office-document");
    let alias = fixtures.path.join("工商注册流程ai化(1).docx");
    let second_alias = fixtures.path.join("工商注册流程ai化(1)(1).docx");
    fs::hard_link(&source, &alias)
        .and_then(|()| fs::hard_link(&source, &second_alias))
        .expect("hardlink fixtures are required for the duplicate policy assertion");

    let result = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .expect("scan should complete");

    assert_eq!(result.groups.len(), 1);
    let group = &result.groups[0];
    assert_eq!(group.files.len(), 3);
    assert!(group.files.iter().any(|file| file.path == source));
    assert!(group.files.iter().any(|file| file.path == alias));
    assert!(group.files.iter().any(|file| file.path == second_alias));
    assert_eq!(group.reclaimable_bytes(), 0);
    let selection = recommended_selection(group);
    assert_eq!(selection.keep_paths(group), vec![source.clone()]);
    assert_eq!(
        selection.cleanup_paths,
        std::collections::BTreeSet::from([alias.clone(), second_alias.clone()])
    );
    assert_eq!(selection.reclaimable_bytes, 0);
    assert_eq!(
        update_selection(group, &selection, &source, true).unwrap_err(),
        SelectionError::LastCopy
    );
}

#[test]
fn cleanup_report_counts_only_physical_bytes_actually_released() {
    let fixtures = TestDirectory::new("hardlink-capacity");
    let source = fixtures.write("00-source.bin", b"same-office-document");
    let alias = fixtures.path.join("10-alias.bin");
    fs::hard_link(&source, &alias)
        .expect("hardlink fixture is required for the physical capacity assertion");
    fixtures.write("20-real-copy.bin", b"same-office-document");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.succeeded_count(), 2);
    assert_eq!(
        report.reclaimable_bytes(),
        b"same-office-document".len() as u64
    );
}

#[test]
fn cancellation_discards_partial_duplicate_groups() {
    let fixtures = TestDirectory::new("cancel");
    fixtures.write("a.bin", &b"duplicate".repeat(256));
    fixtures.write("b.bin", &b"duplicate".repeat(256));
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    let result = DuplicateScanner::default()
        .scan(&fixtures.path, &cancellation)
        .expect("cancelled scan is a valid result");

    assert!(result.cancelled);
    assert!(result.groups.is_empty());
}

#[test]
fn cancellation_preserves_scanned_logical_bytes() {
    let fixtures = TestDirectory::new("cancelled-bytes");
    fixtures.write("a.bin", b"first");
    fixtures.write("b.bin", b"second-file");
    let cancellation = CancellationToken::new();
    let callback_token = cancellation.clone();
    let mut observed_bytes = None;

    let result = DuplicateScanner::default()
        .scan_with_progress(&fixtures.path, &cancellation, |progress| {
            if progress.stage == ProgressStage::Enumerating && observed_bytes.is_none() {
                observed_bytes = Some(progress.scanned_bytes);
                callback_token.cancel();
            }
        })
        .unwrap();

    assert!(result.cancelled);
    assert_eq!(result.scanned_files, 1);
    assert_eq!(result.scanned_bytes, observed_bytes.unwrap());
    assert!(result.scanned_bytes > 0);
}

#[test]
fn recommendation_keeps_shortest_path_even_when_it_is_newer() {
    let fixtures = TestDirectory::new("selection");
    let oldest = fixtures.write("a-much-longer-name.bin", b"duplicate");
    let newest = fixtures.write("short.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&oldest)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&newest)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let group = &scan.groups[0];

    let selection = recommended_selection(group);

    assert_eq!(selection.keep_paths(group), vec![newest.clone()]);
    assert!(selection.cleanup_paths.contains(&oldest));
    assert!(selection.recommendation_reason.contains("路径最短"));
    let error = update_selection(group, &selection, &newest, true).unwrap_err();
    assert_eq!(error, SelectionError::LastCopy);
}

#[test]
fn selection_validation_preserves_wrong_group_unknown_path_and_last_copy_errors() {
    let fixtures = TestDirectory::new("selection-validation");
    fixtures.write("a.bin", b"duplicate");
    fixtures.write("b.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let group = &scan.groups[0];
    let mut selection = recommended_selection(group);
    selection.group_id = "unknown".to_owned();
    selection
        .cleanup_paths
        .insert(fixtures.path.join("outside"));
    assert_eq!(
        validate_selection(group, &selection),
        Err(SelectionError::WrongGroup)
    );
    selection.group_id = group.id.clone();
    assert_eq!(
        validate_selection(group, &selection),
        Err(SelectionError::UnknownPath)
    );
    selection.cleanup_paths = group.files.iter().map(|file| file.path.clone()).collect();
    assert_eq!(
        validate_selection(group, &selection),
        Err(SelectionError::LastCopy)
    );
}

#[test]
fn cleanup_plan_validates_all_groups_before_recycling_and_keeps_first_id_match() {
    let fixtures = TestDirectory::new("cleanup-plan-index");
    fixtures.write("a.bin", b"duplicate");
    fixtures.write("b.bin", b"duplicate");
    fixtures.write("c.bin", b"other content");
    fixtures.write("d.bin", b"other content");
    let mut scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let mut unknown = selection.clone();
    unknown.group_id = "unknown".to_owned();
    let trash = RecordingTrash::default();
    let service = CleanupService::new(&trash);

    assert!(service
        .cleanup(&scan.groups, &[selection.clone(), unknown])
        .is_err());
    assert!(trash.paths.lock().unwrap().is_empty());
    scan.groups[1].id = scan.groups[0].id.clone();
    let report = service
        .cleanup(&scan.groups, std::slice::from_ref(&selection))
        .unwrap();
    assert_eq!(report.succeeded_count(), 1);
    assert_eq!(
        trash.paths.lock().unwrap().as_slice(),
        selection.cleanup_paths.iter().cloned().collect::<Vec<_>>()
    );
}

#[test]
fn cleanup_revalidates_hash_and_uses_injected_trash() {
    let fixtures = TestDirectory::new("cleanup");
    let keep = fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&keep)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&remove)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let trash = RecordingTrash::default();
    let service = CleanupService::new(&trash);

    let report = service.cleanup(&scan.groups, &[selection]).unwrap();

    assert_eq!(report.succeeded_count(), 1);
    assert_eq!(report.items[0].status, CleanupStatus::MovedToTrash);
    assert_eq!(trash.paths.lock().unwrap().as_slice(), &[remove]);
}

#[test]
fn failed_trash_items_do_not_contribute_to_reclaimed_capacity() {
    let fixtures = TestDirectory::new("cleanup-failure-capacity");
    fixtures.write("keep.bin", b"duplicate");
    fixtures.write("remove.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let trash = RecordingTrash {
        fail: true,
        ..RecordingTrash::default()
    };

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Failed);
    assert_eq!(report.reclaimable_bytes(), 0);
}

#[test]
fn same_size_change_with_restored_mtime_is_skipped_by_full_hash_check() {
    let fixtures = TestDirectory::new("changed");
    let keep = fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&keep)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&remove)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let original_modified = remove.metadata().unwrap().modified().unwrap();
    fs::write(&remove, b"duplicaXe").unwrap();
    File::options()
        .write(true)
        .open(&remove)
        .unwrap()
        .set_modified(original_modified)
        .unwrap();
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Changed);
    assert!(trash.paths.lock().unwrap().is_empty());
}

#[test]
fn new_hardlink_after_scan_blocks_cleanup_as_changed() {
    let fixtures = TestDirectory::new("link-topology-change");
    let keep = fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&keep)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&remove)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    fs::hard_link(&remove, fixtures.path.join("late-alias.bin"))
        .expect("hardlink fixture is required for the changed-topology assertion");
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Changed);
    assert!(trash.paths.lock().unwrap().is_empty());
}

#[test]
fn missing_keeper_blocks_the_entire_group() {
    let fixtures = TestDirectory::new("keeper");
    let keep = fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&keep)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&remove)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    fs::remove_file(&keep).unwrap();
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Blocked);
    assert!(report.items[0].message.contains("keep.bin"));
    assert!(trash.paths.lock().unwrap().is_empty());
}

#[test]
fn missing_cleanup_target_is_reported_as_failed_io() {
    let fixtures = TestDirectory::new("missing-target");
    fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    fs::remove_file(&remove).unwrap();
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Failed);
    assert!(report.items[0].message.contains("复核失败"));
    assert!(trash.paths.lock().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn inaccessible_cleanup_target_is_reported_as_failed_io() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixtures = TestDirectory::new("inaccessible-target");
    fixtures.write("keep.bin", b"duplicate");
    let remove = fixtures.write("remove.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let _exclusive = File::options()
        .read(true)
        .share_mode(0)
        .open(&remove)
        .unwrap();
    let trash = RecordingTrash::default();

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(report.items[0].status, CleanupStatus::Failed);
    assert!(trash.paths.lock().unwrap().is_empty());
}

#[test]
fn keeper_is_revalidated_before_each_selected_file() {
    let fixtures = TestDirectory::new("keeper-revalidation");
    let keeper = fixtures.write("00-keep.bin", b"duplicate");
    let first = fixtures.write("10-first.bin", b"duplicate");
    let second = fixtures.write("20-second.bin", b"duplicate");
    File::options()
        .write(true)
        .open(&keeper)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(10))
        .unwrap();
    File::options()
        .write(true)
        .open(&first)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(20))
        .unwrap();
    File::options()
        .write(true)
        .open(&second)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(30))
        .unwrap();
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selection = recommended_selection(&scan.groups[0]);
    let trash = KeeperChangingTrash {
        paths: Mutex::new(Vec::new()),
        keeper,
    };

    let report = CleanupService::new(&trash)
        .cleanup(&scan.groups, &[selection])
        .unwrap();

    assert_eq!(trash.paths.lock().unwrap().len(), 1);
    assert_eq!(report.items[0].status, CleanupStatus::MovedToTrash);
    assert_eq!(report.items[1].status, CleanupStatus::Blocked);
}

#[test]
fn cleanup_cancelled_before_first_item_keeps_all_files_and_reports_zero_progress() {
    let fixtures = TestDirectory::new("cleanup-cancel-before");
    fixtures.write("keep.bin", b"duplicate");
    fixtures.write("copy.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selections = vec![recommended_selection(&scan.groups[0])];
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let trash = RecordingTrash::default();
    let mut events = Vec::new();

    let report = CleanupService::new(&trash)
        .cleanup_with_progress(&scan.groups, &selections, &cancellation, |event| {
            events.push(event);
        })
        .unwrap();

    assert!(report.cancelled);
    assert_eq!(report.remaining_files, 1);
    assert!(report.items.is_empty());
    assert!(trash.paths.lock().unwrap().is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].completed_files, 0);
    assert_eq!(events[0].total_files, 1);
    assert!(events[0].current_path.is_none());
}

#[test]
fn cleanup_stop_requested_at_item_start_finishes_that_item_before_stopping() {
    let fixtures = TestDirectory::new("cleanup-stop-boundary");
    fixtures.write("keep.bin", b"duplicate");
    fixtures.write("first-copy.bin", b"duplicate");
    fixtures.write("second-copy.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selections = vec![recommended_selection(&scan.groups[0])];
    let cancellation = CancellationToken::new();
    let callback_token = cancellation.clone();
    let trash = RecordingTrash::default();
    let mut events = Vec::new();

    let report = CleanupService::new(&trash)
        .cleanup_with_progress(&scan.groups, &selections, &cancellation, |event| {
            if event.current_path.is_some() {
                callback_token.cancel();
            }
            events.push(event);
        })
        .unwrap();

    assert!(report.cancelled);
    assert_eq!(report.remaining_files, 1);
    assert_eq!(report.items.len(), 1);
    assert_eq!(report.items[0].status, CleanupStatus::MovedToTrash);
    assert_eq!(trash.paths.lock().unwrap().len(), 1);
    assert_eq!(events.len(), 3);
    let final_event = events.last().unwrap();
    assert_eq!(final_event.completed_files, 1);
    assert_eq!(final_event.total_files, 2);
    assert_eq!(final_event.moved_count, 1);
    assert_eq!(final_event.skipped_count, 0);
    assert_eq!(final_event.failed_count, 0);
    assert!(final_event.current_path.is_none());
}

#[test]
fn cleanup_stop_during_last_item_is_normal_completion_and_counts_failed_items() {
    let fixtures = TestDirectory::new("cleanup-stop-last");
    fixtures.write("keep.bin", b"duplicate");
    fixtures.write("copy.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let selections = vec![recommended_selection(&scan.groups[0])];
    let cancellation = CancellationToken::new();
    let callback_token = cancellation.clone();
    let trash = RecordingTrash {
        fail: true,
        ..RecordingTrash::default()
    };
    let mut events = Vec::new();

    let report = CleanupService::new(&trash)
        .cleanup_with_progress(&scan.groups, &selections, &cancellation, |event| {
            if event.current_path.is_some() {
                callback_token.cancel();
            }
            events.push(event);
        })
        .unwrap();

    assert!(!report.cancelled);
    assert_eq!(report.remaining_files, 0);
    assert_eq!(report.items[0].status, CleanupStatus::Failed);
    assert_eq!(events.last().unwrap().completed_files, 1);
    assert_eq!(events.last().unwrap().moved_count, 0);
    assert_eq!(events.last().unwrap().failed_count, 1);
}

#[test]
fn cleanup_progress_counts_changed_files_and_finishes_an_empty_plan() {
    let fixtures = TestDirectory::new("cleanup-progress-skipped");
    let keeper = fixtures.write("keep.bin", b"duplicate");
    let selected = fixtures.write("selected-copy.bin", b"duplicate");
    let scan = DuplicateScanner::default()
        .scan(&fixtures.path, &CancellationToken::new())
        .unwrap();
    let mut selection = recommended_selection(&scan.groups[0]);
    fs::write(selected, b"changed content").unwrap();
    let trash = RecordingTrash::default();
    let cancellation = CancellationToken::new();
    let mut events = Vec::new();
    let report = CleanupService::new(&trash)
        .cleanup_with_progress(
            &scan.groups,
            std::slice::from_ref(&selection),
            &cancellation,
            |event| {
                events.push(event);
            },
        )
        .unwrap();
    assert!(!report.cancelled);
    assert_eq!(report.remaining_files, 0);
    assert_eq!(report.items[0].status, CleanupStatus::Changed);
    assert_eq!(events.last().unwrap().completed_files, 1);
    assert_eq!(events.last().unwrap().skipped_count, 1);
    assert_eq!(events.last().unwrap().failed_count, 0);
    assert!(trash.paths.lock().unwrap().is_empty());
    assert_eq!(fs::read(keeper).unwrap(), b"duplicate");

    selection.cleanup_paths.clear();
    selection.reclaimable_bytes = 0;
    events.clear();
    let report = CleanupService::new(&trash)
        .cleanup_with_progress(&scan.groups, &[selection], &cancellation, |event| {
            events.push(event);
        })
        .unwrap();
    assert!(report.items.is_empty());
    assert!(!report.cancelled);
    assert_eq!(report.remaining_files, 0);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].total_files, 0);
}
