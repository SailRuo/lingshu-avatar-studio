//! Local character database (SQLite).
//!
//! This is a straight port of the Electron main process (`electron/main.cjs`):
//! the same schema, the same file name and — on the first launch of the Tauri
//! build — the same data, because the legacy database file is copied over
//! as-is (see [`migrate_legacy_database`]).
//!
//! Threading model: `rusqlite::Connection` is not `Sync`, so every command
//! opens its own short-lived connection and runs it on the blocking pool via
//! `tauri::async_runtime::spawn_blocking`. The payload of this app is tiny
//! (a handful of characters), so a connection per call costs far less than
//! sharing one behind a mutex, and it keeps the Tauri async runtime free.

use crate::types::{
    CharacterLayer, CharacterListRow, CharacterPayload, CharacterRecord, SaveCharacterResult,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// File name of the database, both for the Tauri build and the legacy one.
const DB_FILE_NAME: &str = "avatar-studio.db";

/// Directory name the Electron build used inside the platform "user data"
/// folder (`~/Library/Application Support/lingshu-avatar-studio` on macOS).
const LEGACY_DIR_NAME: &str = "lingshu-avatar-studio";

/// The schema has to stay compatible with the Electron build so that a legacy
/// database can be opened (and copied) without conversion.
const SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  manifest TEXT NOT NULL, rig TEXT NOT NULL, persona TEXT NOT NULL,
  thumbnail BLOB, thumbnail_mime TEXT
);
CREATE TABLE IF NOT EXISTS character_layers (
  character_id TEXT NOT NULL, layer_id TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (character_id, layer_id),
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
"#;

// --------------------------------------------------------------------- paths

/// Absolute path of the database inside the Tauri app data directory.
pub fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    Ok(dir.join(DB_FILE_NAME))
}

/// Path of the database the Electron build wrote, if this platform had one.
fn legacy_database_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let base = match std::env::consts::OS {
        "macos" => home.join("Library").join("Application Support"),
        "windows" => home.join("AppData").join("Roaming"),
        _ => home.join(".config"),
    };
    Some(base.join(LEGACY_DIR_NAME).join(DB_FILE_NAME))
}

/// SQLite sidecar files (`-wal` / `-shm`) live next to the database.
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

// ------------------------------------------------------------------ plumbing

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|_| 0)
}

/// Opens a connection with the pragmas the Electron build relied on.
///
/// `journal_mode` is persistent in the file header, but setting it again is
/// cheap and keeps a freshly copied legacy database consistent.
pub fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("打开数据库失败（{}）：{e}", path.display()))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置数据库等待超时失败：{e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("切换数据库到 WAL 模式失败：{e}"))?;
    // `foreign_keys` is per connection and drives the ON DELETE CASCADE that
    // removes the layers of a deleted character.
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| format!("开启数据库外键约束失败：{e}"))?;
    Ok(conn)
}

/// Runs a blocking database job on the blocking pool so the Tauri async
/// runtime is never stalled by SQLite.
pub async fn run_db<F, T>(job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("数据库任务执行失败：{e}"))?
}

// ----------------------------------------------------------------- migration

/// Copies the legacy Electron database over when the Tauri one does not exist
/// yet.
///
/// The schema is identical, so a plain file copy is enough: characters,
/// layers and the provider settings in `settings` all come along. The legacy
/// database runs in WAL mode, so the write-ahead log is checkpointed first —
/// otherwise the most recent writes would still sit in the `-wal` sidecar and
/// would be lost by the copy.
fn migrate_legacy_database(target: &Path) -> Result<bool, String> {
    if target.exists() {
        return Ok(false);
    }
    let Some(legacy) = legacy_database_path() else {
        return Ok(false);
    };
    if !legacy.is_file() {
        return Ok(false);
    }

    // Flush the WAL into the main database file. If the legacy app is still
    // running the checkpoint may fail; the fallback below copies the WAL
    // sidecar as well, so no data is lost either way.
    if let Ok(conn) = Connection::open(&legacy) {
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    }

    // A stale sidecar from an earlier run would be replayed onto the freshly
    // copied database and corrupt it.
    let _ = std::fs::remove_file(sidecar(target, "-wal"));
    let _ = std::fs::remove_file(sidecar(target, "-shm"));

    std::fs::copy(&legacy, target).map_err(|e| {
        format!(
            "复制旧版数据库失败（{} -> {}）：{e}",
            legacy.display(),
            target.display()
        )
    })?;

    // Keep the WAL when the checkpoint could not run: SQLite replays it the
    // first time the copy is opened.
    let legacy_wal = sidecar(&legacy, "-wal");
    if legacy_wal.is_file() {
        let has_data = std::fs::metadata(&legacy_wal)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        if has_data {
            std::fs::copy(&legacy_wal, sidecar(target, "-wal"))
                .map_err(|e| format!("复制旧版数据库 WAL 日志失败：{e}"))?;
        }
    }

    Ok(true)
}

// --------------------------------------------------------------------- init

/// Prepares the database at startup: creates the folder, migrates the legacy
/// database when needed and makes sure the schema exists.
pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path =
        database_path(app).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // A failed migration must not stop the app: the new database is still
    // created empty and the user can retry later.
    match migrate_legacy_database(&path) {
        Ok(true) => eprintln!("[db] 已迁移旧版数据库：{}", path.display()),
        Ok(false) => {}
        Err(e) => eprintln!("[db] 迁移旧版数据库失败：{e}"),
    }

    let conn = open_connection(&path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(())
}

// ---------------------------------------------------------------- characters

fn list_characters(path: &Path) -> Result<Vec<CharacterListRow>, String> {
    let conn = open_connection(path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, tier, created_at, updated_at, thumbnail, thumbnail_mime
             FROM characters ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("准备角色列表查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CharacterListRow {
                id: row.get(0)?,
                name: row.get(1)?,
                tier: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                thumbnail: row.get(5)?,
                thumbnail_mime: row.get(6)?,
            })
        })
        .map_err(|e| format!("读取角色列表失败：{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("读取角色列表失败：{e}"))?);
    }
    Ok(out)
}

fn get_character(path: &Path, id: &str) -> Result<Option<CharacterRecord>, String> {
    if id.is_empty() {
        return Ok(None);
    }
    let conn = open_connection(path)?;
    let row = conn
        .query_row(
            "SELECT id, name, tier, created_at, updated_at, manifest, rig, persona,
                    thumbnail, thumbnail_mime
             FROM characters WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("读取角色失败：{e}"))?;

    let Some((
        id,
        name,
        tier,
        created_at,
        updated_at,
        manifest,
        rig,
        persona,
        thumbnail,
        thumbnail_mime,
    )) = row
    else {
        return Ok(None);
    };

    let manifest = parse_json(&manifest, "manifest")?;
    let rig = parse_json(&rig, "rig")?;
    let persona = parse_json(&persona, "persona")?;

    let mut stmt = conn
        .prepare(
            "SELECT layer_id, mime, data FROM character_layers
             WHERE character_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| format!("准备角色图层查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![&id], |row| {
            Ok(CharacterLayer {
                id: row.get(0)?,
                mime: row.get(1)?,
                data: row.get(2)?,
            })
        })
        .map_err(|e| format!("读取角色图层失败：{e}"))?;

    let mut layers = Vec::new();
    for row in rows {
        layers.push(row.map_err(|e| format!("读取角色图层失败：{e}"))?);
    }

    Ok(Some(CharacterRecord {
        id,
        name,
        tier,
        created_at,
        updated_at,
        manifest,
        rig,
        persona,
        thumbnail,
        thumbnail_mime,
        layers,
    }))
}

fn parse_json(raw: &str, field: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(raw)
        .map_err(|e| format!("角色数据里的 {field} 不是合法 JSON：{e}"))
}

/// The Electron build accepted any non-null object (arrays included).
fn is_json_container(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

fn save_character(path: &Path, payload: CharacterPayload) -> Result<SaveCharacterResult, String> {
    let id = payload.id.clone();
    if id.is_empty() {
        return Err("角色缺少 ID。".to_string());
    }
    if !is_json_container(&payload.manifest)
        || !is_json_container(&payload.rig)
        || !is_json_container(&payload.persona)
    {
        return Err("角色数据不完整。".to_string());
    }

    let manifest = &payload.manifest;
    let name = {
        let trimmed = payload.name.trim();
        if !trimmed.is_empty() {
            trimmed.to_string()
        } else {
            manifest
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "未命名角色".to_string())
        }
    };
    let tier = if !payload.tier.is_empty() {
        payload.tier.clone()
    } else {
        manifest
            .get("tier")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "portrait".to_string())
    };

    let now = now_ms();
    let created_at = payload.created_at.unwrap_or(now);
    let updated_at = now;

    let manifest_json =
        serde_json::to_string(manifest).map_err(|e| format!("序列化角色 manifest 失败：{e}"))?;
    let rig_json =
        serde_json::to_string(&payload.rig).map_err(|e| format!("序列化角色 rig 失败：{e}"))?;
    let persona_json = serde_json::to_string(&payload.persona)
        .map_err(|e| format!("序列化角色 persona 失败：{e}"))?;

    let (thumbnail, thumbnail_mime) = match payload.thumbnail {
        Some(blob) => {
            let mime = if blob.mime.is_empty() {
                "image/png".to_string()
            } else {
                blob.mime.clone()
            };
            (Some(blob.data), Some(mime))
        }
        None => (None, None),
    };

    let mut conn = open_connection(path)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启数据库事务失败：{e}"))?;

    tx.execute(
        "INSERT INTO characters (
            id, name, tier, created_at, updated_at, manifest, rig, persona, thumbnail, thumbnail_mime
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            tier = excluded.tier,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            manifest = excluded.manifest,
            rig = excluded.rig,
            persona = excluded.persona,
            thumbnail = excluded.thumbnail,
            thumbnail_mime = excluded.thumbnail_mime",
        params![
            &id,
            &name,
            &tier,
            created_at,
            updated_at,
            &manifest_json,
            &rig_json,
            &persona_json,
            &thumbnail,
            &thumbnail_mime
        ],
    )
    .map_err(|e| format!("保存角色失败：{e}"))?;

    // The layer set is replaced wholesale, like the Electron build did.
    tx.execute(
        "DELETE FROM character_layers WHERE character_id = ?1",
        params![&id],
    )
    .map_err(|e| format!("清理角色图层失败：{e}"))?;

    for layer in &payload.layers {
        if layer.id.is_empty() {
            continue;
        }
        let mime = if layer.mime.is_empty() {
            "image/png"
        } else {
            layer.mime.as_str()
        };
        tx.execute(
            "INSERT INTO character_layers (character_id, layer_id, mime, data)
             VALUES (?1, ?2, ?3, ?4)",
            params![&id, &layer.id, mime, &layer.data],
        )
        .map_err(|e| format!("保存角色图层失败：{e}"))?;
    }

    tx.commit().map_err(|e| format!("提交角色事务失败：{e}"))?;

    Ok(SaveCharacterResult { id, updated_at })
}

fn delete_character(path: &Path, id: &str) -> Result<bool, String> {
    if id.is_empty() {
        return Ok(false);
    }
    let conn = open_connection(path)?;
    // The layers go away with the character (ON DELETE CASCADE).
    conn.execute("DELETE FROM characters WHERE id = ?1", params![id])
        .map_err(|e| format!("删除角色失败：{e}"))?;
    Ok(true)
}

// ------------------------------------------------------------------ settings

fn get_setting(path: &Path, key: &str) -> Result<Option<String>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    let conn = open_connection(path)?;
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取设置失败：{e}"))?;
    Ok(value)
}

fn set_setting(path: &Path, key: &str, value: &str) -> Result<bool, String> {
    if key.is_empty() {
        return Ok(false);
    }
    let conn = open_connection(path)?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|e| format!("保存设置失败：{e}"))?;
    Ok(true)
}

// ------------------------------------------------------------------ commands

/// Lists every character, newest update first.
#[tauri::command]
pub async fn db_characters_list(app: AppHandle) -> Result<Vec<CharacterListRow>, String> {
    let path = database_path(&app)?;
    run_db(move || list_characters(&path)).await
}

/// Reads one character with its layers, or `None` when it does not exist.
#[tauri::command]
pub async fn db_characters_get(app: AppHandle, id: String) -> Result<Option<CharacterRecord>, String> {
    let path = database_path(&app)?;
    run_db(move || get_character(&path, &id)).await
}

/// Creates or updates a character and replaces its layer set.
#[tauri::command]
pub async fn db_characters_save(
    app: AppHandle,
    payload: CharacterPayload,
) -> Result<SaveCharacterResult, String> {
    let path = database_path(&app)?;
    run_db(move || save_character(&path, payload)).await
}

/// Deletes a character (its layers go with it).
#[tauri::command]
pub async fn db_characters_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let path = database_path(&app)?;
    run_db(move || delete_character(&path, &id)).await
}

/// Reads one setting, `None` when it was never written.
#[tauri::command]
pub async fn db_settings_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = database_path(&app)?;
    run_db(move || get_setting(&path, &key)).await
}

/// Writes one setting.
#[tauri::command]
pub async fn db_settings_set(app: AppHandle, key: String, value: String) -> Result<bool, String> {
    let path = database_path(&app)?;
    run_db(move || set_setting(&path, &key, &value)).await
}

/// Absolute path of the database file, shown in the settings screen.
#[tauri::command]
pub async fn db_file(app: AppHandle) -> Result<String, String> {
    Ok(database_path(&app)?.to_string_lossy().to_string())
}
