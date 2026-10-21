//! Streaming HTTP proxy — the Tauri replacement for the Electron
//! `http:start` / `http:abort` IPC bridge.
//!
//! The renderer hands us a request, we perform it for real and stream the
//! response back through the global `http:event` event:
//!
//! ```text
//! meta  -> { type: "meta",  id, status, statusText, headers }
//! chunk -> { type: "chunk", id, chunk: [u8, ...] }
//! end   -> { type: "end",   id }
//! error -> { type: "error", id, name, message }
//! ```
//!
//! `http_start` returns as soon as the background task has been spawned; the
//! renderer waits for the events, exactly like the Electron build did. The
//! port keeps the same guarantees as `electron/main.cjs`: only HTTP(S) is
//! allowed, `host` / `content-length` never leave the renderer, the response
//! headers are cleaned before they are handed over, and an aborted request
//! really stops the transfer.
//!
//! # Bodies
//!
//! `types.rs` is the shared contract and cannot grow a `parts` field, so the
//! three body shapes travel as:
//!
//! * `text` — `bodyText` holds the string.
//! * `bytes` — `bodyBytes` holds the raw bytes (a plain JSON number array).
//! * `formdata` — `bodyText` holds the parts as JSON, because the multipart
//!   body has to be rebuilt here (the renderer never sees the boundary):
//!
//! ```json
//! [
//!   { "name": "model", "value": "gpt-image-1" },
//!   { "name": "image", "filename": "image.png", "type": "image/png",
//!     "bytes": [137, 80, 78, 71] }
//! ]
//! ```
//!
//! A part with `value` is a plain form field, a part with `bytes` is a file.
//! `bytes` accepts a JSON number array or the `{"0": 1, "1": 2}` shape a
//! `Uint8Array` turns into once it is stringified.

use crate::types::{HttpEvent, HttpRequestBody};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::{Client, Method, RequestBuilder};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Emitter};
use url::Url;
use uuid::Uuid;

/// The global event every proxy event travels on.
const EVENT_NAME: &str = "http:event";

/// Request headers the renderer must not choose: `host` and `content-length`
/// describe the connection, not the request, and `accept-encoding` is dropped
/// because this build of `reqwest` has no decompression feature enabled — the
/// proxy could not decode a compressed body, so we never ask for one.
const SKIPPED_REQUEST_HEADERS: [&str; 3] = ["host", "content-length", "accept-encoding"];

/// Response headers that are never handed to the renderer: the length and
/// encoding describe the body as it travelled on the wire, and `connection` /
/// `set-cookie` are hop-by-hop headers a browser never exposes to `fetch`.
const SKIPPED_RESPONSE_HEADERS: [&str; 5] = [
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "set-cookie",
];

/// An error that is reported to the renderer as an `error` event.
struct ProxyError {
    name: Option<String>,
    message: String,
}

impl ProxyError {
    fn new(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: Some(name.to_string()),
            message: message.into(),
        }
    }
}

/// A request that is currently on the wire.
struct ActiveRequest {
    /// Cancels the background task, which drops the response and closes the
    /// connection.
    abort: tokio::task::AbortHandle,
    /// Set as soon as the request is over, so a late abort cannot turn a
    /// finished response into a spurious abort error.
    finished: Arc<AtomicBool>,
}

// ------------------------------------------------------------------ registry

fn registry() -> &'static Mutex<HashMap<String, ActiveRequest>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, ActiveRequest>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The registry is only touched from short critical sections that never
/// await, but a panic in one request task must not take the whole proxy down
/// with a poisoned lock.
fn registry_lock() -> MutexGuard<'static, HashMap<String, ActiveRequest>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One shared client so connections are pooled between requests.
fn client() -> Result<&'static Client, ProxyError> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        // The Electron build used `redirect: 'follow'`.
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| ProxyError::new("TypeError", format!("无法创建 HTTP 客户端: {err}")))?;
    Ok(CLIENT.get_or_init(|| client))
}

// -------------------------------------------------------------------- events

/// Serialises one proxy event and pushes it to the renderer.
///
/// `types.rs` tags the enum with `rename_all = "camelCase"`, which renames
/// the *variants* (`Meta` -> `meta`) but not the fields inside them, so
/// `status_text` would reach the renderer as `status_text`. The Electron
/// build — and `fetchShim.ts`, which copies it onto `Response.statusText` —
/// expects `statusText`, so the camelCase alias is added here instead of
/// touching the shared type.
fn emit(app: &AppHandle, event: HttpEvent) {
    let mut payload = match serde_json::to_value(&event) {
        Ok(payload) => payload,
        Err(err) => {
            eprintln!("[http] 无法序列化事件: {err}");
            return;
        }
    };
    if let Some(status_text) = payload.get("status_text").cloned() {
        if let Some(map) = payload.as_object_mut() {
            map.entry("statusText").or_insert(status_text);
        }
    }
    if let Err(err) = app.emit(EVENT_NAME, payload) {
        eprintln!("[http] 无法发送 {EVENT_NAME} 事件: {err}");
    }
}

// ------------------------------------------------------------------ commands

/// Starts a proxied request.
///
/// The command returns immediately: the request itself runs in a background
/// task and reports through the `http:event` event.
#[tauri::command]
pub async fn http_start(
    app: AppHandle,
    id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<HttpRequestBody>,
) -> Result<(), String> {
    if id.is_empty() {
        return Err("http_start 需要一个请求 id".to_string());
    }

    let finished = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&finished);
    let request_id = id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let outcome = perform(&app, &request_id, &url, &method, &headers, body).await;

        // The request is over: mark it as finished and drop it from the
        // registry *before* the last event goes out, so that an abort racing
        // with the end of the response cannot add a second, wrong event.
        flag.store(true, Ordering::SeqCst);
        registry_lock().remove(&request_id);

        match outcome {
            Ok(()) => emit(&app, HttpEvent::End { id: request_id }),
            Err(err) => emit(&app, HttpEvent::Error {
                id: request_id,
                name: err.name,
                message: err.message,
            }),
        }
    });

    let abort = handle.inner().abort_handle();
    registry_lock().insert(
        id.clone(),
        ActiveRequest {
            abort,
            finished: Arc::clone(&finished),
        },
    );
    // The task may already have finished before it could be registered.
    if finished.load(Ordering::SeqCst) {
        registry_lock().remove(&id);
    }

    Ok(())
}

/// Cancels a request that is still running.
#[tauri::command]
pub async fn http_abort(app: AppHandle, id: String) -> Result<(), String> {
    let entry = registry_lock().remove(&id);
    if let Some(entry) = entry {
        // The request already finished; there is nothing to cancel and no
        // error to report.
        if entry.finished.load(Ordering::SeqCst) {
            return Ok(());
        }
        entry.abort.abort();
        emit(
            &app,
            HttpEvent::Error {
                id,
                name: Some("AbortError".to_string()),
                message: "Request aborted".to_string(),
            },
        );
    }
    Ok(())
}

// ------------------------------------------------------------------- request

/// Performs the request and streams the response back to the renderer.
async fn perform(
    app: &AppHandle,
    id: &str,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<HttpRequestBody>,
) -> Result<(), ProxyError> {
    let parsed = Url::parse(url)
        .map_err(|_| ProxyError::new("TypeError", "Invalid request URL".to_string()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ProxyError::new(
            "TypeError",
            "Only HTTP(S) is supported".to_string(),
        ));
    }

    let method = Method::from_bytes(method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| ProxyError::new("TypeError", format!("Invalid HTTP method: {method}")))?;

    let client = client()?;
    let mut builder: RequestBuilder = client.request(method, parsed);

    // A multipart body owns its content type, so the one the renderer sent
    // is dropped here and replaced with the one that carries the boundary.
    let is_multipart = body
        .as_ref()
        .and_then(|body| body.body_type.as_deref())
        == Some("formdata");

    let mut header_map = HeaderMap::new();
    for (key, value) in headers {
        let name = key.trim().to_ascii_lowercase();
        if SKIPPED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        if is_multipart && name == "content-type" {
            continue;
        }
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| ProxyError::new("TypeError", format!("Invalid header name: {key}")))?;
        let header_value = HeaderValue::from_str(value).map_err(|_| {
            ProxyError::new("TypeError", format!("Invalid header value for: {key}"))
        })?;
        header_map.insert(header_name, header_value);
    }
    builder = builder.headers(header_map);

    builder = match body {
        Some(body) => match body.body_type.as_deref() {
            Some("text") => builder.body(body.body_text.unwrap_or_default()),
            Some("bytes") => builder.body(body.body_bytes.unwrap_or_default()),
            Some("formdata") => {
                let text = body.body_text.ok_or_else(|| {
                    ProxyError::new(
                        "TypeError",
                        "formdata 请求缺少 bodyText（表单分片的 JSON）".to_string(),
                    )
                })?;
                let parts = parse_form_parts(&text)?;
                let (payload, content_type) = encode_multipart(&parts);
                builder.header(CONTENT_TYPE, content_type).body(payload)
            }
            _ => builder,
        },
        None => builder,
    };

    let mut response = builder
        .send()
        .await
        .map_err(|err| ProxyError::new("TypeError", describe(&err)))?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default().to_string();
    emit(
        app,
        HttpEvent::Meta {
            id: id.to_string(),
            status: status.as_u16(),
            status_text,
            headers: clean_response_headers(response.headers()),
        },
    );

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| ProxyError::new("TypeError", describe(&err)))?
    {
        if chunk.is_empty() {
            continue;
        }
        emit(
            app,
            HttpEvent::Chunk {
                id: id.to_string(),
                chunk: chunk.to_vec(),
            },
        );
    }

    Ok(())
}

/// A readable message for a `reqwest` failure.
fn describe(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        format!("请求超时: {err}")
    } else if err.is_connect() {
        format!("无法连接到服务器: {err}")
    } else {
        err.to_string()
    }
}

/// Drops the headers the renderer must not see and joins the repeated ones
/// the way the Fetch spec does.
fn clean_response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (name, value) in headers.iter() {
        if SKIPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let text = match value.to_str() {
            Ok(text) => text.to_string(),
            Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
        };
        match out.get_mut(name.as_str()) {
            Some(existing) => {
                existing.push_str(", ");
                existing.push_str(&text);
            }
            None => {
                out.insert(name.as_str().to_string(), text);
            }
        }
    }
    out
}

// ----------------------------------------------------------------- multipart

/// One part of a `multipart/form-data` body.
#[derive(Debug, Clone, Deserialize)]
struct FormPart {
    name: String,
    #[serde(default, alias = "text")]
    value: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default, rename = "type", alias = "contentType")]
    content_type: Option<String>,
    #[serde(default, alias = "data")]
    bytes: Option<Value>,
}

/// The parts of a multipart body, either as a bare array or wrapped in an
/// object with a `parts` key.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FormParts {
    List(Vec<FormPart>),
    Wrapped { parts: Vec<FormPart> },
}

impl FormParts {
    fn into_parts(self) -> Vec<FormPart> {
        match self {
            Self::List(parts) => parts,
            Self::Wrapped { parts } => parts,
        }
    }
}

/// Reads the parts out of the JSON the renderer sent.
fn parse_form_parts(text: &str) -> Result<Vec<FormPart>, ProxyError> {
    let value: Value = serde_json::from_str(text).map_err(|err| {
        ProxyError::new(
            "TypeError",
            format!("formdata 请求的 bodyText 不是合法的 JSON: {err}"),
        )
    })?;
    let parts: FormParts = serde_json::from_value(value).map_err(|err| {
        ProxyError::new(
            "TypeError",
            format!("formdata 请求的 bodyText 必须是分片数组: {err}"),
        )
    })?;
    Ok(parts.into_parts())
}

/// Encodes the parts as `multipart/form-data` and returns the body together
/// with the `Content-Type` header that describes it.
///
/// The boundary is generated here, so the renderer never has to know it.
fn encode_multipart(parts: &[FormPart]) -> (Vec<u8>, String) {
    let boundary = format!("----LingShuAvatarStudio{}", Uuid::new_v4().simple());
    let mut out: Vec<u8> = Vec::new();

    for part in parts {
        let binary = part_binary(part);
        let mut disposition = format!(
            "Content-Disposition: form-data; name=\"{}\"",
            sanitize(&part.name)
        );
        if binary.is_some() {
            // A file part carries a file name; the Electron build fell back
            // to the field name when the renderer did not send one.
            let filename = part.filename.clone().unwrap_or_else(|| part.name.clone());
            disposition.push_str(&format!("; filename=\"{}\"", sanitize(&filename)));
        }
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        out.extend_from_slice(disposition.as_bytes());
        out.extend_from_slice(b"\r\n");
        if binary.is_some() {
            let content_type = part
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string());
            out.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        match binary {
            Some(bytes) => out.extend_from_slice(&bytes),
            None => out.extend_from_slice(part.value.as_deref().unwrap_or_default().as_bytes()),
        }
        out.extend_from_slice(b"\r\n");
    }

    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (out, format!("multipart/form-data; boundary={boundary}"))
}

/// The bytes of a file part, if it has any.
fn part_binary(part: &FormPart) -> Option<Vec<u8>> {
    let raw = part.bytes.as_ref()?;
    match raw {
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_u64().filter(|n| *n <= 255).map(|n| n as u8))
            .collect(),
        Value::Object(map) => {
            let mut indexed: Vec<(usize, u8)> = Vec::with_capacity(map.len());
            for (key, item) in map {
                let index: usize = key.parse().ok()?;
                let byte: u8 = item.as_u64().filter(|n| *n <= 255)? as u8;
                indexed.push((index, byte));
            }
            indexed.sort_by_key(|(index, _)| *index);
            Some(indexed.into_iter().map(|(_, byte)| byte).collect())
        }
        _ => None,
    }
}

/// Keeps a header parameter from breaking out of its quotes or injecting a
/// header of its own.
fn sanitize(value: &str) -> String {
    value
        .replace('\\', "%5C")
        .replace('"', "%22")
        .replace(['\r', '\n'], "")
}
