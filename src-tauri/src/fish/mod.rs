//! Fish Audio live TTS — the Tauri replacement for the Electron `fish:*`
//! IPC bridge (`electron/fishSession.cjs`).
//!
//! A browser WebSocket cannot set the `Authorization` header Fish insists on,
//! so the socket has to live outside the renderer. Rust can send the header,
//! so the whole protocol runs here: the MessagePack frames `start`, `text`,
//! `flush` and `stop` go out, the frames `audio` and `finish` come in, and
//! the renderer only ever sees the `fish:event` event.
//!
//! # The protocol
//!
//! ```text
//! client -> server   { "event": "start", "request": { ... } }
//! client -> server   { "event": "text",  "text": "..." }
//! client -> server   { "event": "flush" }
//! client -> server   { "event": "stop" }
//! server -> client   { "event": "audio",  "audio": <binary> }
//! server -> client   { "event": "finish", "reason": "stop" | "error" }
//! ```
//!
//! Fish needs a drain window between `flush` and `stop`: sent back to back
//! they cut the tail of the audio off, so `stop` waits 800 ms.

use crate::types::{FishEvent, FishStart};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub mod msgpack;

/// The global event every live TTS event travels on.
const EVENT_NAME: &str = "fish:event";

/// Fish needs a drain window; flush and stop back to back cut the tail off.
const STOP_DRAIN_MS: u64 = 800;

/// The sample rate of the raw PCM the Fish gateway sends.
const FISH_PCM_SAMPLE_RATE: u32 = 24000;

const INVALID_URL: &str = "Fish Audio 地址无效。";
const CONNECT_FAILED: &str = "Fish Audio 连接失败，请检查 Key、模型 ID 和 Base URL。";
const SYNTH_FAILED: &str = "Fish Audio 合成失败。";

/// The socket of one live session.
type FishSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
/// The half of the socket the frames are written to.
type FishSink = SplitSink<FishSocket, Message>;
/// The half of the socket the frames are read from.
type FishStream = SplitStream<FishSocket>;

/// What the renderer asks a session to do.
enum Command {
    /// Synthesize this text.
    Text(String),
    /// Synthesize everything that was sent so far.
    Flush,
    /// End the turn.
    Stop,
}

/// One live session.
struct Session {
    /// The commands of the renderer, waiting for the background task.
    commands: mpsc::UnboundedSender<Command>,
    /// Stops the background task, which drops the socket.
    abort: tokio::task::AbortHandle,
    /// Set when the session is over, so a late cancel stays quiet.
    finished: Arc<AtomicBool>,
}

/// What one session remembers between frames.
struct SessionState {
    /// Set by `stop`: the turn is closing, new text is ignored.
    stopping: bool,
    /// When the `stop` frame has to go out.
    stop_at: Option<Instant>,
}

// ------------------------------------------------------------------ registry

fn registry() -> &'static Mutex<HashMap<String, Session>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The registry is only touched from short critical sections that never
/// await, but a panic in one session task must not take the whole bridge
/// down with a poisoned lock.
fn registry_lock() -> MutexGuard<'static, HashMap<String, Session>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Commands that arrived before their session was registered.
///
/// The renderer sends `text` / `flush` / `stop` right after it asks for the
/// session, and those invokes can reach us before `fish_start` has put the
/// session into the registry. Dropping them would leave the socket open with
/// nothing to synthesize: no audio and no `finish`.
fn pending_commands() -> &'static Mutex<HashMap<String, Vec<Command>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Vec<Command>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_lock() -> MutexGuard<'static, HashMap<String, Vec<Command>>> {
    pending_commands()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The most commands one early session may buffer.
const MAX_PENDING_COMMANDS: usize = 32;

/// Delivers a command to its session, or buffers it until the session exists.
fn send_or_buffer(token: &str, command: Command) {
    {
        let registry = registry_lock();
        if let Some(session) = registry.get(token) {
            let _ = session.commands.send(command);
            return;
        }
    }
    let mut pending = pending_lock();
    let queue = pending.entry(token.to_string()).or_default();
    if queue.len() < MAX_PENDING_COMMANDS {
        queue.push(command);
    }
}

// -------------------------------------------------------------------- events

/// Sends one event to the renderer.
fn emit(app: &AppHandle, event: FishEvent) {
    if let Err(err) = app.emit(EVENT_NAME, event) {
        eprintln!("[fish] 无法发送 {EVENT_NAME} 事件: {err}");
    }
}

/// Where a session reports its events.
///
/// The renderer always gets them through the global `fish:event` event; the
/// trait only exists so a session can be driven by a test without a Tauri
/// app around it.
trait EventSink {
    fn report(&self, event: FishEvent);
}

impl EventSink for AppHandle {
    fn report(&self, event: FishEvent) {
        emit(self, event);
    }
}

// ------------------------------------------------------------------ commands

/// Opens a live session.
///
/// The command returns as soon as the background task has been spawned; the
/// renderer waits for the `ready` event, exactly like the Electron build did.
#[tauri::command]
pub async fn fish_start(app: AppHandle, payload: FishStart) -> Result<(), String> {
    let token = payload.token.trim().to_string();
    if token.is_empty() {
        return Err("fish_start 需要一个会话 token".to_string());
    }

    // A new session replaces the one that used the same token.
    drop_session(&token);

    let (commands, receiver) = mpsc::unbounded_channel::<Command>();
    let queued_sender = commands.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&finished);
    let session_token = token.clone();

    let handle = tauri::async_runtime::spawn(async move {
        run_session(app, session_token.clone(), payload, receiver).await;

        // The session is over: mark it and take it out of the registry, so a
        // late cancel cannot turn a finished session into a second event.
        flag.store(true, Ordering::SeqCst);
        registry_lock().remove(&session_token);
    });

    let abort = handle.inner().abort_handle();
    registry_lock().insert(
        token.clone(),
        Session {
            commands,
            abort,
            finished: Arc::clone(&finished),
        },
    );
    // The task may already have finished before it could be registered.
    if finished.load(Ordering::SeqCst) {
        registry_lock().remove(&token);
    }

    // Hand over everything the renderer sent while the session was still
    // being registered. They are queued in the session's command channel and
    // go out right after the `start` frame.
    if let Some(queued) = pending_lock().remove(&token) {
        for command in queued {
            let _ = queued_sender.send(command);
        }
    }

    Ok(())
}

/// Sends text to the session.
///
/// The text is buffered when the renderer sends it before `fish_start` has
/// registered the session; the buffer is handed over as soon as it exists.
#[tauri::command]
pub async fn fish_text(_app: AppHandle, token: String, text: String) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    // The channel never blocks, and the session only reads it.
    send_or_buffer(&token, Command::Text(text));
    Ok(())
}

/// Asks the session to synthesize everything it got so far.
#[tauri::command]
pub async fn fish_flush(_app: AppHandle, token: String) -> Result<(), String> {
    send_or_buffer(&token, Command::Flush);
    Ok(())
}

/// Ends the turn: a `flush` first, the `stop` 800 ms later.
#[tauri::command]
pub async fn fish_stop(_app: AppHandle, token: String) -> Result<(), String> {
    send_or_buffer(&token, Command::Stop);
    Ok(())
}

/// Closes the session right away.
#[tauri::command]
pub async fn fish_cancel(app: AppHandle, token: String) -> Result<(), String> {
    // A cancel before the session exists must not leave a turn to start later.
    pending_lock().remove(&token);
    let session = registry_lock().remove(&token);
    if let Some(session) = session {
        if !session.finished.load(Ordering::SeqCst) {
            // Aborting the task drops the socket, which closes the connection.
            session.abort.abort();
            emit(
                &app,
                FishEvent::Closed {
                    token,
                    code: 1000,
                    reason: "client closed".to_string(),
                },
            );
        }
    }
    Ok(())
}

/// Drops a session without telling the renderer anything.
///
/// A session that is replaced by a new one must not report a close: the
/// renderer would take it for the new session, which carries the same token.
fn drop_session(token: &str) {
    if let Some(session) = registry_lock().remove(token) {
        session.abort.abort();
    }
}

// ------------------------------------------------------------------- session

/// Runs one live session from the handshake to the end of the turn.
async fn run_session<S: EventSink>(
    events: S,
    token: String,
    payload: FishStart,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let base_url = match socket_url(&payload.base_url) {
        Some(base_url) => base_url,
        None => {
            events.report(FishEvent::Error {
                token,
                message: INVALID_URL.to_string(),
            });
            return;
        }
    };

    let request = match build_request(&format!("{base_url}/v1/tts/live"), &payload) {
        Ok(request) => request,
        Err(message) => {
            events.report(FishEvent::Error { token, message });
            return;
        }
    };

    let (socket, _response) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(err) => {
            eprintln!("[fish] 连接失败: {err}");
            events.report(FishEvent::Error {
                token,
                message: CONNECT_FAILED.to_string(),
            });
            return;
        }
    };
    let (mut sink, mut stream): (FishSink, FishStream) = socket.split();

    // The `start` frame opens the turn.
    if let Err(message) = send_frame(&mut sink, &start_frame(&payload)).await {
        events.report(FishEvent::Error { token, message });
        return;
    }

    let mut state = SessionState {
        stopping: false,
        stop_at: None,
    };

    // The commands that arrived while the handshake was running go out now,
    // before the renderer is told that the session is live. The command
    // channel is the queue of the Electron build.
    while let Ok(command) = commands.try_recv() {
        if let Err(message) = handle_command(&mut sink, command, &mut state).await {
            events.report(FishEvent::Error { token, message });
            return;
        }
    }
    events.report(FishEvent::Ready { token: token.clone() });

    let mut ended = false;
    let mut closed: Option<(u16, String)> = None;
    let mut audio_bytes = 0usize;

    loop {
        // The `stop` frame is sent when the drain window is over.
        let deadline = state
            .stop_at
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));

        tokio::select! {
            command = commands.recv() => {
                match command {
                    // The renderer is gone.
                    None => break,
                    Some(command) => {
                        if let Err(message) = handle_command(&mut sink, command, &mut state).await {
                            events.report(FishEvent::Error {
                                token: token.clone(),
                                message,
                            });
                            break;
                        }
                    }
                }
            }
            message = stream.next() => {
                match message {
                    // The socket died without a close frame.
                    None => {
                        closed = Some((0, String::new()));
                        break;
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Some(frame) = msgpack::decode(&data) {
                            match frame.event.as_str() {
                                "audio" => {
                                    if !frame.audio.is_empty() {
                                        audio_bytes += frame.audio.len();
                                        events.report(FishEvent::Audio {
                                            token: token.clone(),
                                            data: frame.audio,
                                        });
                                    }
                                }
                                "finish" => {
                                    let reason = frame
                                        .reason
                                        .as_deref()
                                        .filter(|reason| !reason.is_empty())
                                        .unwrap_or("stop")
                                        .to_string();
                                    ended = true;
                                    // A turn that ends without audio means the
                                    // text never reached the socket; say so,
                                    // otherwise the renderer just stays silent.
                                    if audio_bytes == 0 && reason != "error" {
                                        eprintln!("[fish] 会话结束但没有任何音频（{reason}）");
                                    }
                                    if reason == "error" {
                                        events.report(FishEvent::Error {
                                            token: token.clone(),
                                            message: failure_message(&frame),
                                        });
                                    } else {
                                        events.report(FishEvent::Finish {
                                            token: token.clone(),
                                            reason,
                                        });
                                    }
                                    // The turn is over: say goodbye and close.
                                    let _ = sink
                                        .send(Message::Close(Some(CloseFrame {
                                            code: CloseCode::Normal,
                                            reason: "client closed".into(),
                                        })))
                                        .await;
                                    break;
                                }
                                // Any other event is informational; the socket
                                // stays open.
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Text(_))) => {}
                    // A ping is answered by the WebSocket layer itself.
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        closed = Some(match frame {
                            Some(frame) => (u16::from(frame.code), frame.reason.to_string()),
                            None => (1000, String::new()),
                        });
                        break;
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(err)) => {
                        eprintln!("[fish] 连接出错: {err}");
                        if !ended {
                            ended = true;
                            events.report(FishEvent::Error {
                                token: token.clone(),
                                message: CONNECT_FAILED.to_string(),
                            });
                        }
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline), if state.stop_at.is_some() => {
                state.stop_at = None;
                if let Err(message) =
                    send_frame(&mut sink, &json!({ "event": "stop" })).await
                {
                    events.report(FishEvent::Error {
                        token: token.clone(),
                        message,
                    });
                    break;
                }
            }
        }
    }

    // A session that did not end normally reports the close.
    if !ended {
        if let Some((code, reason)) = closed {
            events.report(FishEvent::Closed {
                token,
                code,
                reason,
            });
        }
    }
}

/// Handles one command of the renderer.
async fn handle_command(
    sink: &mut FishSink,
    command: Command,
    state: &mut SessionState,
) -> Result<(), String> {
    match command {
        Command::Text(text) => {
            // A turn that is closing does not take new text.
            if state.stopping {
                return Ok(());
            }
            send_frame(sink, &json!({ "event": "text", "text": text })).await
        }
        Command::Flush => send_frame(sink, &json!({ "event": "flush" })).await,
        Command::Stop => {
            if state.stopping {
                return Ok(());
            }
            state.stopping = true;
            send_frame(sink, &json!({ "event": "flush" })).await?;
            // Fish needs a drain window; flush and stop back to back would cut
            // the tail of the audio off.
            state.stop_at = Some(Instant::now() + Duration::from_millis(STOP_DRAIN_MS));
            Ok(())
        }
    }
}

/// Sends one MessagePack frame.
async fn send_frame(sink: &mut FishSink, value: &Value) -> Result<(), String> {
    let bytes = msgpack::encode(value)?;
    sink.send(Message::Binary(bytes.into()))
        .await
        .map_err(|err| format!("Fish Audio 发送失败: {err}"))
}

/// The message of a failed turn.
///
/// The gateway puts the reason into one of `message`, `error`, `detail` or
/// `code`; they are joined the way the Electron build joined them.
fn failure_message(frame: &msgpack::ServerFrame) -> String {
    let detail = [
        frame.message.as_deref(),
        frame.error.as_deref(),
        frame.detail.as_deref(),
        frame.code.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    if detail.is_empty() {
        SYNTH_FAILED.to_string()
    } else {
        detail
    }
}

// -------------------------------------------------------------------- frames

/// The `start` frame: it opens the turn.
fn start_frame(payload: &FishStart) -> Value {
    let format = if payload.format.trim().is_empty() {
        "pcm".to_string()
    } else {
        payload.format.trim().to_lowercase()
    };
    let latency = if payload.latency.trim().is_empty() {
        "balanced".to_string()
    } else {
        payload.latency.trim().to_string()
    };

    let mut request = serde_json::Map::new();
    request.insert("text".to_string(), json!(""));
    request.insert("format".to_string(), json!(format));
    request.insert("latency".to_string(), json!(latency));
    // Small chunks let the engine emit audio before the whole turn is done.
    request.insert("chunk_length".to_string(), json!(100u64));
    request.insert("min_chunk_length".to_string(), json!(20u64));
    if format == "pcm" {
        let sample_rate = if payload.sample_rate == 0 {
            FISH_PCM_SAMPLE_RATE
        } else {
            payload.sample_rate
        };
        request.insert("sample_rate".to_string(), json!(sample_rate));
    }
    let reference_id = payload.reference_id.trim();
    if !reference_id.is_empty() {
        request.insert("reference_id".to_string(), json!(reference_id));
    }

    json!({ "event": "start", "request": request })
}

// ---------------------------------------------------------------- handshake

/// The WebSocket address of the live endpoint.
///
/// `https` becomes `wss`, `http` becomes `ws`; an address that already is a
/// WebSocket address is left alone. `None` means there is no address at all.
fn socket_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("ws://") || lower.starts_with("wss://") {
        return Some(trimmed.to_string());
    }
    if lower.starts_with("http") {
        // "http" turns into "ws" and "https" into "wss".
        return Some(format!("ws{}", &trimmed[4..]));
    }
    None
}

/// The handshake: the address plus the headers Fish insists on.
fn build_request(url: &str, payload: &FishStart) -> Result<Request<()>, String> {
    let mut request = url
        .to_string()
        .into_client_request()
        .map_err(|err| format!("{INVALID_URL} {err}"))?;
    let headers = request.headers_mut();

    let api_key = payload.api_key.trim();
    if !api_key.is_empty() {
        let value = format!("Bearer {api_key}")
            .parse()
            .map_err(|_| "Fish Audio API Key 无效。".to_string())?;
        headers.insert("Authorization", value);
    }

    let model = payload.model.trim();
    if !model.is_empty() {
        let value = model
            .parse()
            .map_err(|_| "Fish Audio 模型 ID 无效。".to_string())?;
        headers.insert("model", value);
    }

    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> FishStart {
        FishStart {
            token: "fish_test".to_string(),
            base_url: "https://api.fish.audio".to_string(),
            api_key: "key".to_string(),
            model: "s2.1-pro-free".to_string(),
            reference_id: "ref".to_string(),
            format: "pcm".to_string(),
            latency: "balanced".to_string(),
            sample_rate: 24000,
        }
    }

    #[test]
    fn turns_the_base_url_into_a_socket_url() {
        assert_eq!(
            socket_url("https://api.fish.audio"),
            Some("wss://api.fish.audio".to_string())
        );
        assert_eq!(
            socket_url("http://127.0.0.1:8080/"),
            Some("ws://127.0.0.1:8080".to_string())
        );
        assert_eq!(
            socket_url("wss://api.fish.audio"),
            Some("wss://api.fish.audio".to_string())
        );
        assert_eq!(
            socket_url("ws://api.fish.audio"),
            Some("ws://api.fish.audio".to_string())
        );
        assert_eq!(socket_url("   "), None);
        assert_eq!(socket_url(""), None);
    }

    #[test]
    fn builds_the_start_frame() {
        let frame = start_frame(&payload());
        let request = &frame["request"];
        assert_eq!(frame["event"], "start");
        assert_eq!(request["text"], "");
        assert_eq!(request["format"], "pcm");
        assert_eq!(request["latency"], "balanced");
        assert_eq!(request["reference_id"], "ref");
        assert!(request["chunk_length"].is_u64());
        assert!(request["min_chunk_length"].is_u64());
        assert!(request["sample_rate"].is_u64());
        assert_eq!(request["sample_rate"].as_u64(), Some(24000));
    }

    #[test]
    fn leaves_the_sample_rate_away_for_other_formats() {
        let mut payload = payload();
        payload.format = "mp3".to_string();
        let frame = start_frame(&payload);
        assert!(frame["request"].get("sample_rate").is_none());
    }

    #[test]
    fn leaves_the_reference_id_away_when_it_is_empty() {
        let mut payload = payload();
        payload.reference_id = "  ".to_string();
        let frame = start_frame(&payload);
        assert!(frame["request"].get("reference_id").is_none());
    }

    #[test]
    fn adds_the_handshake_headers() {
        let request = build_request("wss://api.fish.audio/v1/tts/live", &payload())
            .expect("the request is built");
        assert_eq!(
            request.headers().get("Authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer key")
        );
        assert_eq!(
            request.headers().get("model").and_then(|v| v.to_str().ok()),
            Some("s2.1-pro-free")
        );
    }

    #[test]
    fn leaves_the_authorization_away_without_a_key() {
        let mut payload = payload();
        payload.api_key = String::new();
        let request = build_request("wss://api.fish.audio/v1/tts/live", &payload)
            .expect("the request is built");
        assert!(request.headers().get("Authorization").is_none());
    }

    #[test]
    fn joins_the_details_of_a_failed_turn() {
        let frame = msgpack::ServerFrame {
            message: Some("模型不可用".to_string()),
            code: Some("4001".to_string()),
            ..Default::default()
        };
        assert_eq!(failure_message(&frame), "模型不可用 · 4001");

        let frame = msgpack::ServerFrame::default();
        assert_eq!(failure_message(&frame), SYNTH_FAILED);
    }

    // ------------------------------------------------------- against a server

    /// Collects the events of a session instead of sending them to a renderer.
    #[derive(Clone)]
    struct Collect(mpsc::UnboundedSender<FishEvent>);

    impl EventSink for Collect {
        fn report(&self, event: FishEvent) {
            let _ = self.0.send(event);
        }
    }

    /// A gateway that answers with audio and ends the turn.
    fn audio_payload() -> Vec<u8> {
        let mut bytes = vec![0x82];
        bytes.extend_from_slice(b"\xa5event");
        bytes.extend_from_slice(b"\xa5audio");
        bytes.extend_from_slice(b"\xa5audio");
        bytes.push(0xc4); // bin8
        bytes.push(3);
        bytes.extend_from_slice(&[7, 8, 9]);
        bytes
    }

    /// A gateway that ends the turn.
    fn finish_payload() -> Vec<u8> {
        let mut bytes = vec![0x82];
        bytes.extend_from_slice(b"\xa5event");
        bytes.extend_from_slice(b"\xa6finish");
        bytes.extend_from_slice(b"\xa6reason");
        bytes.extend_from_slice(b"\xa4stop");
        bytes
    }

    /// Reads the next frame the client sent.
    async fn next_frame<S>(stream: &mut S) -> Value
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        loop {
            match stream.next().await {
                Some(Ok(Message::Binary(data))) => {
                    return rmp_serde::from_slice::<Value>(&data).expect("the frame decodes");
                }
                Some(Ok(_)) => continue,
                other => panic!("the client sends a frame: {other:?}"),
            }
        }
    }

    /// A session that talks to a local gateway.
    struct Session {
        events: mpsc::UnboundedReceiver<FishEvent>,
        commands: mpsc::UnboundedSender<Command>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Session {
        /// Starts a session that connects to the gateway on `address`.
        async fn start(address: std::net::SocketAddr) -> Session {
            let (events, events_rx) = mpsc::unbounded_channel();
            let (commands, commands_rx) = mpsc::unbounded_channel();
            let mut payload = payload();
            payload.base_url = format!("http://{address}");

            let handle = tokio::spawn(run_session(
                Collect(events),
                payload.token.clone(),
                payload,
                commands_rx,
            ));

            Session {
                events: events_rx,
                commands,
                handle,
            }
        }

        async fn next_event(&mut self) -> FishEvent {
            tokio::time::timeout(std::time::Duration::from_secs(5), self.events.recv())
                .await
                .expect("the event arrives")
                .expect("the session is open")
        }
    }

    #[tokio::test]
    async fn speaks_the_protocol_with_the_gateway() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let address = listener.local_addr().expect("the address is known");

        let gateway = tokio::spawn(async move {
            let (stream, _address) = listener.accept().await.expect("the client connects");
            let socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("the socket is accepted");
            let (mut sink, mut stream) = socket.split();

            // The turn opens with the `start` frame.
            let start = next_frame(&mut stream).await;
            assert_eq!(start["event"], "start");
            assert_eq!(start["request"]["format"], "pcm");
            assert_eq!(start["request"]["sample_rate"], 24000);

            // The text of the renderer follows.
            let text = next_frame(&mut stream).await;
            assert_eq!(text["event"], "text");
            assert_eq!(text["text"], "你好");

            // The gateway answers with audio and ends the turn.
            sink.send(Message::Binary(audio_payload().into()))
                .await
                .expect("the audio goes out");
            sink.send(Message::Binary(finish_payload().into()))
                .await
                .expect("the finish goes out");
        });

        let mut session = Session::start(address).await;
        // The text arrives before the handshake is done; it has to wait.
        session
            .commands
            .send(Command::Text("你好".to_string()))
            .expect("the command is queued");

        match session.next_event().await {
            FishEvent::Ready { .. } => {}
            other => panic!("the session is ready: {other:?}"),
        }
        match session.next_event().await {
            FishEvent::Audio { data, .. } => assert_eq!(data, vec![7, 8, 9]),
            other => panic!("the audio arrives: {other:?}"),
        }
        match session.next_event().await {
            FishEvent::Finish { reason, .. } => assert_eq!(reason, "stop"),
            other => panic!("the turn ends: {other:?}"),
        }

        gateway.await.expect("the gateway is done");
        let _ = session.handle.await;
    }

    #[tokio::test]
    async fn waits_for_the_drain_window_before_the_stop_frame() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let address = listener.local_addr().expect("the address is known");

        let gateway = tokio::spawn(async move {
            let (stream, _address) = listener.accept().await.expect("the client connects");
            let socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("the socket is accepted");
            let (_sink, mut stream) = socket.split();

            let start = next_frame(&mut stream).await;
            assert_eq!(start["event"], "start");

            let text = next_frame(&mut stream).await;
            assert_eq!(text["event"], "text");

            let flush = next_frame(&mut stream).await;
            assert_eq!(flush["event"], "flush");
            let flushed_at = std::time::Instant::now();

            let stop = next_frame(&mut stream).await;
            assert_eq!(stop["event"], "stop");
            // Fish needs the drain window; flush and stop back to back would
            // cut the tail of the audio off.
            assert!(flushed_at.elapsed() >= std::time::Duration::from_millis(700));
        });

        let mut session = Session::start(address).await;
        session
            .commands
            .send(Command::Text("你好".to_string()))
            .expect("the command is queued");
        session
            .commands
            .send(Command::Stop)
            .expect("the command is queued");

        match session.next_event().await {
            FishEvent::Ready { .. } => {}
            other => panic!("the session is ready: {other:?}"),
        }

        gateway.await.expect("the gateway is done");
        let _ = session.handle.await;
    }
}
