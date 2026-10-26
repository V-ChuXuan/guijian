use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use desktop_lib::cleanup::{CleanupService, TrashPort};
use desktop_lib::commands::{validate_scan_root, AppState, CleanupTarget, CommandErrorCode};
use desktop_lib::domain::{
    CleanupItemResult, CleanupProgress, CleanupReport, CleanupStatus, ProgressStage, ScanProgress,
};
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
fn operation_remains_in_progress_until_completion_or_abandonment() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    assert!(!state.operation_in_progress());
    let token = state.begin_scan().unwrap();
    assert!(state.operation_in_progress());
    assert!(state.cancel_scan());
    assert!(state.operation_in_progress());
    state.complete_scan(&token, result).unwrap();
    assert!(!state.operation_in_progress());

    let (_, _, cleanup_token) = state.begin_cleanup(None).unwrap();
    assert!(state.operation_in_progress());
    assert!(state.cancel_cleanup());
    assert!(cleanup_token.is_cancelled());
    assert!(state.operation_in_progress());
    state
        .complete_cleanup(CleanupReport {
            items: vec![],
            reclaimable_bytes: 0,
            cancelled: true,
            remaining_files: 1,
        })
        .unwrap();
    assert!(!state.operation_in_progress());

    state.begin_scan().unwrap();
    state.abandon_operation();
    assert!(!state.operation_in_progress());
    state.begin_cleanup(None).unwrap();
    state.abandon_operation();
    assert!(!state.operation_in_progress());
    fs::remove_dir_all(root).unwrap();
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
        cancelled: true,
        remaining_files: 3,
    })
    .unwrap();
    assert_eq!(report["reclaimableBytes"], 42);
    assert_eq!(report["cancelled"], true);
    assert_eq!(report["remainingFiles"], 3);
    assert!(report.get("reclaimedBytes").is_none());
    let cleanup_progress = serde_json::to_value(CleanupProgress {
        completed_files: 2,
        total_files: 5,
        current_path: None,
        moved_count: 1,
        skipped_count: 1,
        failed_count: 0,
    })
    .unwrap();
    assert_eq!(cleanup_progress["completedFiles"], 2);
    assert_eq!(cleanup_progress["totalFiles"], 5);
    assert_eq!(cleanup_progress["movedCount"], 1);
    assert_eq!(cleanup_progress["skippedCount"], 1);
    assert_eq!(cleanup_progress["failedCount"], 0);
    assert!(cleanup_progress["currentPath"].is_null());
    assert!(cleanup_progress.get("completed_files").is_none());
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
fn keep_group_clears_only_that_groups_selection_in_one_update() {
    let root = multiple_group_fixture_directory();
    fs::write(root.join("extra-one.bin"), b"same-one").unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let before = state.complete_scan(&token, result).unwrap();
    let group_id = &before.selections[0].group_id;

    let updated = state.keep_group(group_id).unwrap();

    assert_eq!(&updated.group_id, group_id);
    assert!(updated.cleanup_paths.is_empty());
    assert_eq!(updated.reclaimable_bytes, 0);
    let after = state.session().unwrap();
    assert_eq!(after.result, before.result);
    assert_eq!(after.selections[0], updated);
    assert_eq!(after.selections[1], before.selections[1]);
    assert_eq!(state.keep_group(group_id).unwrap(), updated);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn keep_group_rejects_empty_unknown_and_busy_sessions_without_mutation() {
    let state = AppState::new(Arc::new(NoopTrash));
    assert_eq!(
        state.keep_group("unknown").unwrap_err().code,
        CommandErrorCode::NoScanResult
    );
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let token = state.begin_scan().unwrap();
    let before = state.complete_scan(&token, result).unwrap();
    assert_eq!(
        state.keep_group("unknown").unwrap_err().code,
        CommandErrorCode::UnknownGroup
    );
    let group_id = &before.selections[0].group_id;
    state.begin_scan().unwrap();
    assert_eq!(
        state.keep_group(group_id).unwrap_err().code,
        CommandErrorCode::Busy
    );
    assert_eq!(state.session().unwrap(), before);
    state.abandon_operation();
    state.begin_cleanup(None).unwrap();
    assert_eq!(
        state.keep_group(group_id).unwrap_err().code,
        CommandErrorCode::Busy
    );
    assert_eq!(state.session().unwrap(), before);
    state.abandon_operation();
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
fn single_cleanup_preserves_choices_and_reconciles_without_rescan() {
    let root = multiple_group_fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let untouched = result.groups[0].clone();
    let target_group = result.groups[1].clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();
    for file in &untouched.files {
        state
            .update_selection(&untouched.id, &file.path, false)
            .unwrap();
    }
    let before = state.session().unwrap();
    let target = CleanupTarget {
        group_id: target_group.id.clone(),
        path: target_group.files[1].path.clone(),
    };
    let (groups, selections, _) = state.begin_cleanup(Some(&target)).unwrap();
    assert_eq!(state.session().unwrap(), before);
    assert_eq!(groups.len(), 1);
    assert_eq!(selections[0].cleanup_paths, [target.path.clone()].into());
    assert_eq!(state.begin_scan().unwrap_err().code, CommandErrorCode::Busy);
    assert_eq!(
        state
            .update_selection(&untouched.id, &untouched.files[0].path, true)
            .unwrap_err()
            .code,
        CommandErrorCode::Busy
    );
    let report = CleanupService::new(&NoopTrash)
        .cleanup(&groups, &selections)
        .unwrap();
    let outcome = state.complete_cleanup(report).unwrap();
    assert_eq!(
        outcome.session.result.as_ref().unwrap().groups,
        vec![untouched]
    );
    assert_eq!(
        outcome.session.result.as_ref().unwrap().scanned_files,
        before.result.unwrap().scanned_files
    );
    assert!(outcome.session.selections[0].cleanup_paths.is_empty());
    assert_eq!(state.session().unwrap(), outcome.session);
    assert!(state.begin_scan().is_ok());
    state.abandon_operation();
    let wire = serde_json::to_value(&target).unwrap();
    assert!(wire.get("groupId").is_some());
    assert!(wire.get("group_id").is_none());
    let wire = serde_json::to_value(&outcome).unwrap();
    assert!(wire.get("report").is_some());
    assert!(wire.get("session").is_some());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_single_cleanup_preserves_all_choices() {
    let root = multiple_group_fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let target = CleanupTarget {
        group_id: result.groups[1].id.clone(),
        path: result.groups[1].files[0].path.clone(),
    };
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let untouched = result.groups[0].clone();
    state.complete_scan(&token, result).unwrap();
    for file in &untouched.files {
        state
            .update_selection(&untouched.id, &file.path, false)
            .unwrap();
    }
    let before = state.session().unwrap();
    state.begin_cleanup(Some(&target)).unwrap();
    let outcome = state
        .complete_cleanup(CleanupReport {
            items: vec![CleanupItemResult {
                path: target.path,
                size: 4,
                status: CleanupStatus::Failed,
                message: "synthetic failure".into(),
            }],
            reclaimable_bytes: 0,
            cancelled: false,
            remaining_files: 0,
        })
        .unwrap();
    assert_eq!(outcome.session, before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn removing_original_keeper_retains_a_surviving_copy() {
    let root = fixture_directory();
    fs::write(root.join("c.bin"), b"same").unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let group = result.groups[0].clone();
    let target = CleanupTarget {
        group_id: group.id.clone(),
        path: group.recommended_keeper().path.clone(),
    };
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();
    let (groups, selections, _) = state.begin_cleanup(Some(&target)).unwrap();
    let report = CleanupService::new(&NoopTrash)
        .cleanup(&groups, &selections)
        .unwrap();
    let outcome = state.complete_cleanup(report).unwrap();
    let remaining = &outcome.session.result.as_ref().unwrap().groups[0];
    assert_eq!(remaining.files.len(), 2);
    assert_eq!(outcome.session.selections[0].cleanup_paths.len(), 1);
    assert!(!outcome.session.selections[0]
        .cleanup_paths
        .contains(&remaining.recommended_keeper().path));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn partial_batch_removes_only_successful_paths() {
    let root = fixture_directory();
    fs::write(root.join("c.bin"), b"same").unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let before = state.complete_scan(&token, result).unwrap();
    let selected: Vec<_> = before.selections[0].cleanup_paths.iter().cloned().collect();
    state.begin_cleanup(None).unwrap();
    let report = CleanupReport {
        items: selected
            .iter()
            .enumerate()
            .map(|(index, path)| CleanupItemResult {
                path: path.clone(),
                size: 4,
                status: if index == 0 {
                    CleanupStatus::MovedToTrash
                } else {
                    CleanupStatus::Changed
                },
                message: String::new(),
            })
            .collect(),
        reclaimable_bytes: 4,
        cancelled: false,
        remaining_files: 0,
    };
    let outcome = state.complete_cleanup(report).unwrap();
    assert_eq!(
        outcome.session.result.as_ref().unwrap().groups[0]
            .files
            .len(),
        2
    );
    assert_eq!(
        outcome.session.selections[0].cleanup_paths,
        [selected[1].clone()].into()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_single_targets_leave_session_and_operation_state_unchanged() {
    let root = multiple_group_fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let before = state.complete_scan(&token, result).unwrap();
    let groups = &before.result.as_ref().unwrap().groups;
    for (target, expected) in [
        (
            CleanupTarget {
                group_id: groups[0].id.clone(),
                path: PathBuf::from("relative"),
            },
            CommandErrorCode::InvalidSelection,
        ),
        (
            CleanupTarget {
                group_id: "unknown".into(),
                path: groups[0].files[0].path.clone(),
            },
            CommandErrorCode::UnknownGroup,
        ),
        (
            CleanupTarget {
                group_id: groups[0].id.clone(),
                path: groups[1].files[0].path.clone(),
            },
            CommandErrorCode::InvalidSelection,
        ),
    ] {
        assert_eq!(
            state.begin_cleanup(Some(&target)).unwrap_err().code,
            expected
        );
        assert_eq!(state.session().unwrap(), before);
    }
    let token = state.begin_scan().unwrap();
    assert_eq!(
        state.begin_cleanup(None).unwrap_err().code,
        CommandErrorCode::Busy
    );
    state.abandon_operation();
    assert!(!token.is_cancelled());
    let empty = AppState::new(Arc::new(NoopTrash));
    assert_eq!(
        empty.begin_cleanup(None).unwrap_err().code,
        CommandErrorCode::NoScanResult
    );
    assert!(empty
        .complete_cleanup(CleanupReport {
            items: vec![],
            reclaimable_bytes: 0,
            cancelled: false,
            remaining_files: 0,
        })
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn single_cleanup_plan_preserves_physical_hard_link_accounting() {
    let root = fixture_directory();
    fs::hard_link(root.join("a.bin"), root.join("c.bin")).unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let group = result.groups[0].clone();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    state.complete_scan(&token, result).unwrap();
    for file in &group.files {
        let target = CleanupTarget {
            group_id: group.id.clone(),
            path: file.path.clone(),
        };
        let (_, selections, _) = state.begin_cleanup(Some(&target)).unwrap();
        assert_eq!(
            selections[0].reclaimable_bytes,
            if file.hard_link_count == 1 { 4 } else { 0 }
        );
        state.abandon_operation();
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_report_rejects_unapproved_paths_without_changing_the_session() {
    let root = fixture_directory();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    let token = state.begin_scan().unwrap();
    let before = state.complete_scan(&token, result).unwrap();
    let (groups, selections, _) = state.begin_cleanup(None).unwrap();
    let keeper = groups[0].recommended_keeper();
    let unapproved_report = CleanupReport {
        items: vec![CleanupItemResult {
            path: keeper.path.clone(),
            size: keeper.size,
            status: CleanupStatus::MovedToTrash,
            message: "synthetic unapproved report".into(),
        }],
        reclaimable_bytes: keeper.size,
        cancelled: false,
        remaining_files: 0,
    };

    let error = state.complete_cleanup(unapproved_report).unwrap_err();

    assert_eq!(error.code, CommandErrorCode::Internal);
    assert_eq!(state.session().unwrap(), before);
    assert_eq!(state.begin_scan().unwrap_err().code, CommandErrorCode::Busy);
    let report = CleanupService::new(&NoopTrash)
        .cleanup(&groups, &selections)
        .unwrap();
    assert!(state.complete_cleanup(report).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_cleanup_reconciles_completed_items_and_uses_a_fresh_next_token() {
    let root = fixture_directory();
    fs::write(root.join("c.bin"), b"same").unwrap();
    let result = DuplicateScanner::default()
        .scan(&root, &CancellationToken::new())
        .unwrap();
    let state = AppState::new(Arc::new(NoopTrash));
    assert!(!state.cancel_cleanup());
    let scan_token = state.begin_scan().unwrap();
    assert!(!state.cancel_cleanup());
    state.complete_scan(&scan_token, result).unwrap();
    let (groups, selections, cleanup_token) = state.begin_cleanup(None).unwrap();
    assert!(!state.cancel_scan());
    let selected_before = selections[0].cleanup_paths.clone();
    let report = CleanupService::new(&NoopTrash)
        .cleanup_with_progress(&groups, &selections, &cleanup_token, |progress| {
            if progress.current_path.is_some() {
                assert!(state.cancel_cleanup());
            }
        })
        .unwrap();
    assert!(report.cancelled);
    assert_eq!(report.remaining_files, 1);
    assert_eq!(report.items.len(), 1);
    assert_eq!(state.begin_scan().unwrap_err().code, CommandErrorCode::Busy);
    let processed = report.items[0].path.clone();

    let outcome = state.complete_cleanup(report).unwrap();

    let remaining_group = &outcome.session.result.as_ref().unwrap().groups[0];
    assert_eq!(remaining_group.files.len(), 2);
    assert!(!remaining_group
        .files
        .iter()
        .any(|file| file.path == processed));
    let remaining_selection = &outcome.session.selections[0].cleanup_paths;
    assert_eq!(remaining_selection.len(), 1);
    assert!(remaining_selection.is_subset(&selected_before));
    assert!(!remaining_selection.contains(&processed));
    assert!(!state.cancel_cleanup());
    let (_, _, next_token) = state.begin_cleanup(None).unwrap();
    cleanup_token.cancel();
    assert!(!next_token.is_cancelled());
    assert!(!scan_token.is_cancelled());
    assert!(state.cancel_cleanup());
    assert!(next_token.is_cancelled());
    state.abandon_operation();
    assert!(!state.cancel_cleanup());
    fs::remove_dir_all(root).unwrap();
}
