pub mod cleanup;
pub mod commands;
pub mod domain;
mod fingerprint;
pub mod scanner;
pub mod selection;

use std::sync::Arc;

use cleanup::WindowsTrash;
use commands::{
    cancel_scan, confirm_cleanup, get_session, prepare_single_cleanup,
    restore_recommended_selections, reveal_file, set_file_cleanup, start_scan, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new(Arc::new(WindowsTrash)))
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            get_session,
            set_file_cleanup,
            prepare_single_cleanup,
            restore_recommended_selections,
            reveal_file,
            confirm_cleanup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
