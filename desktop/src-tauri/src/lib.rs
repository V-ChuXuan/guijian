pub mod cleanup;
pub mod commands;
pub mod domain;
mod fingerprint;
pub mod scanner;
pub mod selection;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use cleanup::WindowsTrash;
use commands::{
    cancel_cleanup, cancel_scan, confirm_cleanup, get_session, keep_group,
    restore_recommended_selections, reveal_file, set_file_cleanup, start_scan, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new(Arc::new(WindowsTrash)))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<AppState>().operation_in_progress() {
                    api.prevent_close();
                    let _ = window.emit("operation-close-blocked", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            cancel_cleanup,
            get_session,
            set_file_cleanup,
            keep_group,
            restore_recommended_selections,
            reveal_file,
            confirm_cleanup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
