//! API key storage in the app's own database.
//!
//! The keys live in the `secrets` table of the same SQLite file the
//! characters are in: the app data directory is already private to the user,
//! so a second credential store would only add a second thing that can drift
//! away from the rest of the configuration.

use crate::db;
use rusqlite::{params, OptionalExtension};
use tauri::AppHandle;

/// Writes a key.
#[tauri::command]
pub async fn keyvault_set(app: AppHandle, id: String, secret: String) -> Result<bool, String> {
    let path = db::database_path(&app)?;
    db::run_db(move || {
        let conn = db::open_connection(&path)?;
        let now = db::now_ms();
        conn.execute(
            "INSERT INTO secrets (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![id, secret, now],
        )
        .map_err(|e| format!("保存密钥失败：{e}"))?;
        Ok(true)
    })
    .await
}

/// Reads a key.
#[tauri::command]
pub async fn keyvault_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let path = db::database_path(&app)?;
    db::run_db(move || {
        let conn = db::open_connection(&path)?;
        let value = conn
            .query_row("SELECT value FROM secrets WHERE key = ?1", params![id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| format!("读取密钥失败：{e}"))?;
        Ok(value)
    })
    .await
}

/// Removes a key.
#[tauri::command]
pub async fn keyvault_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let path = db::database_path(&app)?;
    db::run_db(move || {
        let conn = db::open_connection(&path)?;
        let removed = conn
            .execute("DELETE FROM secrets WHERE key = ?1", params![id])
            .map_err(|e| format!("删除密钥失败：{e}"))?;
        Ok(removed > 0)
    })
    .await
}

/// Removes every key.
#[tauri::command]
pub async fn keyvault_clear(app: AppHandle) -> Result<bool, String> {
    let path = db::database_path(&app)?;
    db::run_db(move || {
        let conn = db::open_connection(&path)?;
        conn.execute("DELETE FROM secrets", [])
            .map_err(|e| format!("清空密钥失败：{e}"))?;
        Ok(true)
    })
    .await
}

/// Lists the ids of the stored keys.
#[tauri::command]
pub async fn keyvault_list(app: AppHandle) -> Result<Vec<String>, String> {
    let path = db::database_path(&app)?;
    db::run_db(move || {
        let conn = db::open_connection(&path)?;
        let mut stmt = conn
            .prepare("SELECT key FROM secrets ORDER BY key")
            .map_err(|e| format!("读取密钥列表失败：{e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取密钥列表失败：{e}"))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|e| format!("读取密钥列表失败：{e}"))?);
        }
        Ok(ids)
    })
    .await
}
