//! File export dialog and app information.
//!
//! Ports the `file:save` and `app:info` IPC handlers of `electron/main.cjs`:
//! a native "save as" dialog followed by writing the bytes, and the version /
//! platform pair the settings screen shows.

use crate::types::{AppInfo, FileFilter, SaveResult};
use std::fs;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Shows the native save dialog and writes the bytes to the chosen path.
///
/// A cancelled dialog is not an error: it returns `saved: false`.
#[tauri::command]
pub async fn file_save(
    app: AppHandle,
    default_name: String,
    filters: Option<Vec<FileFilter>>,
    bytes: Vec<u8>,
) -> Result<SaveResult, String> {
    // The dialog blocks until the user answers, so it runs on the blocking
    // pool instead of stalling the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let name = if default_name.trim().is_empty() {
            "export.bin".to_string()
        } else {
            default_name
        };

        let mut builder = app.dialog().file().set_file_name(name);
        if let Some(filters) = filters {
            for filter in filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                if extensions.is_empty() {
                    continue;
                }
                builder = builder.add_filter(filter.name, &extensions);
            }
        }

        let Some(chosen) = builder.blocking_save_file() else {
            // The user closed the dialog.
            return Ok(SaveResult {
                saved: false,
                path: None,
            });
        };
        let path = chosen
            .into_path()
            .map_err(|e| format!("无法解析保存路径：{e}"))?;

        fs::write(&path, &bytes)
            .map_err(|e| format!("写入文件失败（{}）：{e}", path.display()))?;

        Ok(SaveResult {
            saved: true,
            path: Some(path.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|e| format!("保存文件任务执行失败：{e}"))?
}

/// Version and platform of the running app.
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}
