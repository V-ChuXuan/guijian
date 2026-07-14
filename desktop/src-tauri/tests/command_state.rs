use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use desktop_lib::cleanup::TrashPort;
use desktop_lib::commands::{validate_scan_root, AppState, CommandErrorCode};
use desktop_lib::domain::{CleanupReport, ProgressStage, ScanProgress};
use desktop_lib::scanner::{CancellationToken, DuplicateScanner};

struct NoopTrash;

impl TrashPort for NoopTrash {
    fn move_to_trash(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

fn fixture_directory() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("guijian-command-{unique}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a.bin"), b"same").unwrap();
    fs::write(root.join("b.bin"), b"same").unwrap();
    root
}

fn multiple_group_fixture_directory() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("guijian-command-multiple-{unique}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("a-one.bin"), b"same-one").unwrap();
    fs::write(root.join("z-one-copy.bin"), b"same-one").unwrap();
    fs::write(root.join("a-two.bin"), b"same-two-content").unwrap();
    fs::write(root.join("z-two-copy.bin"), b"same-two-content").unwrap();
    root
}

#[test]
fn command_boundary_rejects_relative_or_non_directory_roots() {
    let relative = validate_scan_root("relative/path").unwrap_err();
    assert_eq!(relative.code, CommandErrorCode::InvalidPath);

    let missing = std::env::temp_dir().join("guijian-does-not-exist");
    let missing = validate_scan_root(missing.to_str().unwrap()).unwrap_err();
    assert_eq!(missing.code, CommandErrorCode::InvalidPath);
}

#[test]
fn state_prevents_concurrent_operations_and_cancels_only_active_scan() {
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();

    let busy = state.begin_scan().unwrap_err();
    assert_eq!(busy.code, CommandErrorCode::Busy);
    let absolute_unknown = std::env::current_dir().unwrap().join("unknown");
    let update_while_busy = state
        .update_selection("unknown", &absolute_unknown, false)
        .unwrap_err();
    assert_eq!(update_while_busy.code, CommandErrorCode::Busy);
    assert!(state.cancel_scan());
    assert!(token.is_cancelled());
    state.abandon_operation();
    assert!(!state.cancel_scan());
}

#[test]
fn session_wire_fields_are_camel_case() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let session = state.complete_scan(&token, result).unwrap();

    let wire = serde_json::to_value(session).unwrap();
    let result = wire["result"].as_object().unwrap();
    assert!(result.contains_key("scannedFiles"));
    assert!(result.contains_key("scannedBytes"));
    assert!(result.contains_key("candidateFiles"));
    assert!(!result.contains_key("scanned_files"));
    assert!(!result.contains_key("scanned_bytes"));
    let file = result["groups"][0]["files"][0].as_object().unwrap();
    assert!(file.contains_key("modifiedAtMs"));
    assert!(file.contains_key("hardLinkCount"));
    assert!(!file.contains_key("modified_at_ms"));
    let selection = wire["selections"][0].as_object().unwrap();
    assert!(selection.contains_key("groupId"));
    assert!(selection.contains_key("cleanupPaths"));
    assert!(selection.contains_key("reclaimableBytes"));
    assert!(selection.contains_key("recommendationReason"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn progress_and_cleanup_report_wire_fields_use_current_camel_case_contract() {
    let progress = serde_json::to_value(ScanProgress {
        stage: ProgressStage::Enumerating,
        scanned_files: 1,
        scanned_bytes: 42,
        candidate_files: 0,
        completed_files: 0,
        total_files: 0,
        current_path: None,
    })
    .unwrap();
    assert_eq!(progress["scannedBytes"], 42);
    assert!(progress.get("scanned_bytes").is_none());

    let report = serde_json::to_value(CleanupReport {
        items: Vec::new(),
        reclaimable_bytes: 42,
    })
    .unwrap();
    assert_eq!(report["reclaimableBytes"], 42);
    assert!(report.get("reclaimedBytes").is_none());
}

#[test]
fn state_owns_scan_result_and_validates_group_and_file_selection() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let session = state.complete_scan(&token, result.clone()).unwrap();
    let group = &result.groups[0];

    assert_eq!(session.result.unwrap().groups, result.groups);
    assert_eq!(session.selections.len(), 1);
    let outside = root.join("outside.bin");
    let invalid_path = state
        .update_selection(&group.id, &outside, false)
        .unwrap_err();
    assert_eq!(invalid_path.code, CommandErrorCode::InvalidSelection);
    let invalid_group = state
        .update_selection("unknown-group", &group.files[0].path, false)
        .unwrap_err();
    assert_eq!(invalid_group.code, CommandErrorCode::UnknownGroup);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn state_restores_all_recommended_selections() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let initial = state.complete_scan(&token, result.clone()).unwrap();
    let group = &result.groups[0];
    let cleanup_path = initial.selections[0]
        .cleanup_paths
        .iter()
        .next()
        .unwrap()
        .clone();

    state
        .update_selection(&group.id, &cleanup_path, false)
        .unwrap();
    assert!(state.session().unwrap().selections[0]
        .cleanup_paths
        .is_empty());

    let restored = state.restore_recommended_selections().unwrap();

    assert_eq!(restored.selections, initial.selections);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn state_allows_reveal_only_for_paths_in_the_current_scan_result() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let known_path = result.groups[0].files[0].path.clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();

    assert_eq!(
        state.validated_session_path(&known_path).unwrap(),
        known_path
    );
    let outside = root.join("outside.bin");
    let error = state.validated_session_path(&outside).unwrap_err();
    assert_eq!(error.code, CommandErrorCode::InvalidPath);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepare_single_cleanup_selects_only_the_target_across_all_groups() {
    let root = multiple_group_fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(result.groups.len(), 2);
    let target_group = result
        .groups
        .iter()
        .find(|group| group.files[0].size == b"same-two-content".len() as u64)
        .unwrap();
    let target = target_group.files[1].path.clone();
    let target_group_id = target_group.id.clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();

    let prepared = state
        .prepare_single_cleanup(&target_group_id, &target)
        .unwrap();

    assert_eq!(prepared.selections.len(), 2);
    for selection in &prepared.selections {
        if selection.group_id == target_group_id {
            assert_eq!(selection.cleanup_paths.len(), 1);
            assert!(selection.cleanup_paths.contains(&target));
        } else {
            assert!(selection.cleanup_paths.is_empty());
            assert_eq!(selection.reclaimable_bytes, 0);
        }
    }
    let wire = serde_json::to_value(&prepared).unwrap();
    let target_selection = wire["selections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|selection| selection["groupId"] == target_group_id)
        .unwrap()
        .as_object()
        .unwrap();
    assert!(target_selection.contains_key("cleanupPaths"));
    assert!(target_selection.contains_key("reclaimableBytes"));
    assert!(!target_selection.contains_key("cleanup_paths"));
    assert_eq!(state.session().unwrap(), prepared);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepare_single_cleanup_allows_the_current_keeper() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let group = &result.groups[0];
    let keeper = group.recommended_keeper().path.clone();
    let group_id = group.id.clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();

    let prepared = state.prepare_single_cleanup(&group_id, &keeper).unwrap();

    assert_eq!(prepared.selections[0].cleanup_paths.len(), 1);
    assert!(prepared.selections[0].cleanup_paths.contains(&keeper));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepare_single_cleanup_failures_leave_the_session_unchanged() {
    let root = multiple_group_fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let first_group = &result.groups[0];
    let second_group = &result.groups[1];
    let first_group_id = first_group.id.clone();
    let first_path = first_group.files[0].path.clone();
    let second_path = second_group.files[0].path.clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();
    let initial = state.session().unwrap();

    let relative = state
        .prepare_single_cleanup(&first_group_id, Path::new("relative.bin"))
        .unwrap_err();
    assert_eq!(relative.code, CommandErrorCode::InvalidSelection);
    assert_eq!(state.session().unwrap(), initial);

    let unknown = state
        .prepare_single_cleanup("unknown-group", &first_path)
        .unwrap_err();
    assert_eq!(unknown.code, CommandErrorCode::UnknownGroup);
    assert_eq!(state.session().unwrap(), initial);

    let unknown_path = state
        .prepare_single_cleanup(&first_group_id, &root.join("not-scanned.bin"))
        .unwrap_err();
    assert_eq!(unknown_path.code, CommandErrorCode::InvalidSelection);
    assert_eq!(state.session().unwrap(), initial);

    let cross_group = state
        .prepare_single_cleanup(&first_group_id, &second_path)
        .unwrap_err();
    assert_eq!(cross_group.code, CommandErrorCode::InvalidSelection);
    assert_eq!(state.session().unwrap(), initial);

    let token = state.begin_scan().unwrap();
    let busy = state
        .prepare_single_cleanup(&first_group_id, &first_path)
        .unwrap_err();
    assert_eq!(busy.code, CommandErrorCode::Busy);
    assert_eq!(state.session().unwrap(), initial);
    state.abandon_operation();
    assert!(!token.is_cancelled());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepare_single_cleanup_without_a_scan_result_is_atomic() {
    let state = AppState::new(Arc::new(NoopTrash));
    let before = state.session().unwrap();
    let target = std::env::current_dir().unwrap().join("unknown.bin");

    let error = state
        .prepare_single_cleanup("unknown-group", &target)
        .unwrap_err();

    assert_eq!(error.code, CommandErrorCode::NoScanResult);
    assert_eq!(state.session().unwrap(), before);
}

#[test]
fn prepare_single_cleanup_uses_physical_reclaimable_bytes_for_hard_links() {
    let root = fixture_directory();
    let hard_link = root.join("c-hard-link.bin");
    fs::hard_link(root.join("a.bin"), &hard_link).unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let group = &result.groups[0];
    let independent = group
        .files
        .iter()
        .find(|file| file.hard_link_count == 1)
        .unwrap()
        .path
        .clone();
    let linked = group
        .files
        .iter()
        .find(|file| file.hard_link_count > 1)
        .unwrap()
        .path
        .clone();
    let group_id = group.id.clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();

    let independent_plan = state
        .prepare_single_cleanup(&group_id, &independent)
        .unwrap();
    assert_eq!(independent_plan.selections[0].reclaimable_bytes, 4);

    let linked_plan = state.prepare_single_cleanup(&group_id, &linked).unwrap();
    assert_eq!(linked_plan.selections[0].reclaimable_bytes, 0);

    fs::remove_dir_all(root).unwrap();
}
