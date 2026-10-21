//! Shared serialisation types. These are the contract between the Rust side
//! and the renderer: the shapes here must match `src/services/platform/bridge.ts`
//! and the legacy `src/types/electron.d.ts` one-for-one, so the renderer code
//! does not have to change.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------- HTTP proxy

/// One streaming event of a proxied HTTP request.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HttpEvent {
    Meta {
        id: String,
        status: u16,
        status_text: String,
        headers: HashMap<String, String>,
    },
    Chunk {
        id: String,
        chunk: Vec<u8>,
    },
    End {
        id: String,
    },
    Error {
        id: String,
        name: Option<String>,
        message: String,
    },
}

/// The request body, mirroring the renderer's `ElectronHttpRequest`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestBody {
    pub body_type: Option<String>,
    pub body_text: Option<String>,
    pub body_bytes: Option<Vec<u8>>,
}

// ------------------------------------------------------------------ keyvault

// --------------------------------------------------------------------- files

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
}

// ------------------------------------------------------------------------ db

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterListRow {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub thumbnail: Option<Vec<u8>>,
    pub thumbnail_mime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterLayer {
    pub id: String,
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRecord {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub manifest: serde_json::Value,
    pub rig: serde_json::Value,
    pub persona: serde_json::Value,
    pub thumbnail: Option<Vec<u8>>,
    pub thumbnail_mime: Option<String>,
    pub layers: Vec<CharacterLayer>,
}

/// What the renderer sends to save a character.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterPayload {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub manifest: serde_json::Value,
    pub rig: serde_json::Value,
    pub persona: serde_json::Value,
    pub thumbnail: Option<CharacterBlob>,
    pub layers: Vec<CharacterLayer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBlob {
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCharacterResult {
    pub id: String,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------- fish

/// The live TTS session request, mirroring the renderer's `FishLiveStart`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FishStart {
    pub token: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub reference_id: String,
    pub format: String,
    pub latency: String,
    pub sample_rate: u32,
}

/// One live TTS event, mirroring the renderer's `FishLiveEvent`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FishEvent {
    Ready {
        token: String,
    },
    Audio {
        token: String,
        data: Vec<u8>,
    },
    Finish {
        token: String,
        reason: String,
    },
    Error {
        token: String,
        message: String,
    },
    Closed {
        token: String,
        code: u16,
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer and this crate only meet through the JSON payload of
    /// `fish_start`. This pins the field names so a rename on one side fails
    /// here instead of silently dropping the session.
    #[test]
    fn deserializes_the_live_tts_session_the_renderer_sends() {
        let raw = serde_json::json!({
            "token": "token-1",
            "baseUrl": "https://api.fish.audio",
            "apiKey": "key-1",
            "model": "s2.1-pro-free",
            "referenceId": "ref-1",
            "format": "pcm",
            "latency": "balanced",
            "sampleRate": 24000
        });
        let session: FishStart = serde_json::from_value(raw).expect("session payload");
        assert_eq!(session.token, "token-1");
        assert_eq!(session.base_url, "https://api.fish.audio");
        assert_eq!(session.api_key, "key-1");
        assert_eq!(session.model, "s2.1-pro-free");
        assert_eq!(session.reference_id, "ref-1");
        assert_eq!(session.format, "pcm");
        assert_eq!(session.latency, "balanced");
        assert_eq!(session.sample_rate, 24000);
    }
}
