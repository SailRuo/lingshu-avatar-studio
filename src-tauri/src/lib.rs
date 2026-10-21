//! Avatar Studio — Tauri backend.
//!
//! The renderer is the same Vue app the Electron build used; this crate only
//! replaces the Electron main process. Every command mirrors one IPC channel
//! of the old build, so the shapes in `types.rs` are the contract between the
//! two sides.

mod db;
mod files;
mod fish;
mod httpproxy;
mod keyvault;
mod types;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            db::init(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // httpproxy
            httpproxy::http_start,
            httpproxy::http_abort,
            // keyvault
            keyvault::keyvault_set,
            keyvault::keyvault_get,
            keyvault::keyvault_delete,
            keyvault::keyvault_clear,
            keyvault::keyvault_list,
            // files
            files::file_save,
            files::app_info,
            // db
            db::db_characters_list,
            db::db_characters_get,
            db::db_characters_save,
            db::db_characters_delete,
            db::db_settings_get,
            db::db_settings_set,
            db::db_file,
            // fish
            fish::fish_start,
            fish::fish_text,
            fish::fish_flush,
            fish::fish_stop,
            fish::fish_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Avatar Studio");
}
