//! MessagePack codec for the Fish live TTS frames.
//!
//! The Electron build shipped a hand written codec (`electron/fishMsgPack.cjs`)
//! because the renderer had to speak MessagePack over a browser WebSocket.
//! The Rust side uses `rmp-serde` for the same job, but the gateway mixes
//! strings, binary audio and fields that may show up later, so the decoder
//! stays forgiving: an unknown key is read and thrown away instead of failing
//! the whole frame, and a field that is not a string is rendered as text.
//!
//! The audio of an `audio` frame is a MessagePack binary. It must not be
//! decoded into `serde_json::Value` — that type has no byte string, so the
//! frame would be lost — which is why the decoder reads it into a `Vec<u8>`
//! of its own.

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::fmt;

/// One frame the Fish gateway sends.
#[derive(Debug, Clone, Default)]
pub struct ServerFrame {
    /// `audio`, `finish`, ... — empty when the gateway sent something else.
    pub event: String,
    /// The raw PCM payload of an `audio` frame.
    pub audio: Vec<u8>,
    /// Why the turn ended: `stop` or `error`.
    pub reason: Option<String>,
    /// The details of a failed turn. The gateway uses one of these four, so
    /// all of them are read.
    pub message: Option<String>,
    /// See [`ServerFrame::message`].
    pub error: Option<String>,
    /// See [`ServerFrame::message`].
    pub detail: Option<String>,
    /// See [`ServerFrame::message`].
    pub code: Option<String>,
}

/// Encodes one client frame.
///
/// Integers stay integers and floats stay floats: the gateway ignores a
/// `prosody.speed` that arrives as an integer, and a chunk length that
/// arrives as a float.
pub fn encode(value: &Value) -> Result<Vec<u8>, String> {
    rmp_serde::to_vec(value).map_err(|err| format!("MessagePack 编码失败: {err}"))
}

/// Decodes one server frame.
///
/// `None` means the frame was not a map this codec understands. The session
/// ignores such a frame, exactly like the Electron build did.
pub fn decode(bytes: &[u8]) -> Option<ServerFrame> {
    rmp_serde::from_slice::<ServerFrame>(bytes).ok()
}

impl<'de> Deserialize<'de> for ServerFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ServerFrameVisitor)
    }
}

struct ServerFrameVisitor;

impl<'de> Visitor<'de> for ServerFrameVisitor {
    type Value = ServerFrame;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a Fish server frame")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut frame = ServerFrame::default();
        while let Some(key) = map.next_key::<Text>()? {
            match key.as_str() {
                "event" => frame.event = map.next_value::<Text>()?.into_string(),
                "audio" => frame.audio = map.next_value::<Audio>()?.into_bytes(),
                "reason" => frame.reason = Some(map.next_value::<Text>()?.into_string()),
                "message" => frame.message = Some(map.next_value::<Text>()?.into_string()),
                "error" => frame.error = Some(map.next_value::<Text>()?.into_string()),
                "detail" => frame.detail = Some(map.next_value::<Text>()?.into_string()),
                "code" => frame.code = Some(map.next_value::<Text>()?.into_string()),
                // A field the gateway added later: it still has to be read so
                // the rest of the frame stays readable.
                _ => {
                    map.next_value::<Skip>()?;
                }
            }
        }
        Ok(frame)
    }
}

/// A field that is usually a string but may be a number, a boolean or an
/// object. The Electron build turned every one of them into a string, so the
/// same is done here.
struct Text(String);

impl Text {
    fn as_str(&self) -> &str {
        &self.0
    }

    fn into_string(self) -> String {
        self.0
    }
}

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(TextVisitor)
    }
}

struct TextVisitor;

impl<'de> Visitor<'de> for TextVisitor {
    type Value = Text;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a text field")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Text(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Text(value))
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E> {
        Ok(Text(String::from_utf8_lossy(value).into_owned()))
    }

    fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E> {
        Ok(Text(String::from_utf8_lossy(&value).into_owned()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Text(value.to_string()))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Text(value.to_string()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
        Ok(Text(value.to_string()))
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Text(value.to_string()))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Text(String::new()))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Text(String::new()))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    /// An array is rendered the way JavaScript would: `1,2,3`.
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut parts = Vec::new();
        while let Some(item) = seq.next_element::<Text>()? {
            parts.push(item.0);
        }
        Ok(Text(parts.join(",")))
    }

    /// An object is rendered as `key: value` pairs.
    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut parts = Vec::new();
        while let Some((key, value)) = map.next_entry::<Text, Text>()? {
            parts.push(format!("{}: {}", key.0, value.0));
        }
        Ok(Text(format!("{{{}}}", parts.join(", "))))
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        // An extension type carries no text; it only has to be read so the
        // rest of the frame stays in sync.
        deserializer.deserialize_seq(SkipVisitor)?;
        Ok(Text(String::new()))
    }
}

/// The audio payload of an `audio` frame: a MessagePack binary, or a list of
/// byte values when the gateway is in a chatty mood.
struct Audio(Vec<u8>);

impl Audio {
    fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

impl<'de> Deserialize<'de> for Audio {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(AudioVisitor)
    }
}

struct AudioVisitor;

impl<'de> Visitor<'de> for AudioVisitor {
    type Value = Audio;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("binary audio data")
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E> {
        Ok(Audio(value.to_vec()))
    }

    fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E> {
        Ok(Audio(value))
    }

    /// A text is not audio; the frame stays readable, but there is nothing to
    /// play.
    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(Audio(Vec::new()))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Audio(Vec::new()))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Audio(Vec::new()))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    /// A list of byte values.
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut bytes = Vec::new();
        while let Some(byte) = seq.next_element::<u64>()? {
            bytes.push((byte & 0xff) as u8);
        }
        Ok(Audio(bytes))
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(SkipVisitor)?;
        Ok(Audio(Vec::new()))
    }
}

/// Reads a value without looking at it.
///
/// `serde`'s own `IgnoredAny` would leave the decoder in the middle of a
/// nested map, so the value is read element by element instead.
struct Skip;

impl<'de> Deserialize<'de> for Skip {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(SkipVisitor)
    }
}

struct SkipVisitor;

impl<'de> Visitor<'de> for SkipVisitor {
    type Value = Skip;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_string<E>(self, _: String) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_bytes<E>(self, _: &[u8]) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_byte_buf<E>(self, _: Vec<u8>) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Skip)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while seq.next_element::<Skip>()?.is_some() {}
        Ok(Skip)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_entry::<Skip, Skip>()?.is_some() {}
        Ok(Skip)
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(SkipVisitor)?;
        Ok(Skip)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A MessagePack map with two entries: `event` and `audio`.
    fn audio_frame() -> Vec<u8> {
        let mut bytes = vec![0x82];
        bytes.extend_from_slice(b"\xa5event");
        bytes.extend_from_slice(b"\xa5audio");
        bytes.extend_from_slice(b"\xa5audio");
        bytes.push(0xc4); // bin8
        bytes.push(3);
        bytes.extend_from_slice(&[1, 2, 3]);
        bytes
    }

    #[test]
    fn decodes_an_audio_frame() {
        let frame = decode(&audio_frame()).expect("the frame decodes");
        assert_eq!(frame.event, "audio");
        assert_eq!(frame.audio, vec![1, 2, 3]);
    }

    #[test]
    fn decodes_a_finish_frame() {
        // { "event": "finish", "reason": "stop" }
        let mut bytes = vec![0x82];
        bytes.extend_from_slice(b"\xa5event");
        bytes.extend_from_slice(b"\xa6finish");
        bytes.extend_from_slice(b"\xa6reason");
        bytes.extend_from_slice(b"\xa4stop");
        let frame = decode(&bytes).expect("the frame decodes");
        assert_eq!(frame.event, "finish");
        assert_eq!(frame.reason.as_deref(), Some("stop"));
    }

    #[test]
    fn ignores_unknown_fields() {
        // { "event": "finish", "reason": "error", "code": 42, "extra": {...} }
        let mut bytes = vec![0x84];
        bytes.extend_from_slice(b"\xa5event");
        bytes.extend_from_slice(b"\xa6finish");
        bytes.extend_from_slice(b"\xa6reason");
        bytes.extend_from_slice(b"\xa5error");
        bytes.extend_from_slice(b"\xa4code");
        bytes.push(42);
        bytes.extend_from_slice(b"\xa5extra");
        bytes.push(0x81); // { "a": 1 }
        bytes.extend_from_slice(b"\xa1a");
        bytes.push(1);
        let frame = decode(&bytes).expect("the frame decodes");
        assert_eq!(frame.event, "finish");
        assert_eq!(frame.reason.as_deref(), Some("error"));
        assert_eq!(frame.code.as_deref(), Some("42"));
    }

    #[test]
    fn rejects_a_frame_that_is_not_a_map() {
        assert!(decode(&[0xc4, 1, 9]).is_none());
        assert!(decode(&[0x90]).is_none());
        assert!(decode(&[]).is_none());
    }

    #[test]
    fn encodes_a_text_frame() {
        let bytes = encode(&json!({ "event": "text", "text": "你好" })).expect("the frame encodes");
        let frame: Value = rmp_serde::from_slice(&bytes).expect("the frame decodes");
        assert_eq!(frame["event"], "text");
        assert_eq!(frame["text"], "你好");
    }

    #[test]
    fn keeps_integers_integers() {
        let bytes = encode(&json!({ "chunk_length": 100, "sample_rate": 24000 }))
            .expect("the frame encodes");
        let frame: Value = rmp_serde::from_slice(&bytes).expect("the frame decodes");
        assert!(frame["chunk_length"].is_u64());
        assert!(frame["sample_rate"].is_u64());
        assert_eq!(frame["sample_rate"].as_u64(), Some(24000));
    }

    #[test]
    fn keeps_floats_floats() {
        let bytes = encode(&json!({ "prosody": { "speed": 1.25 } })).expect("the frame encodes");
        // The last byte of a float64 is part of the double, the marker is
        // right in front of it.
        assert_eq!(bytes[bytes.len() - 9], 0xcb);
        let frame: Value = rmp_serde::from_slice(&bytes).expect("the frame decodes");
        assert_eq!(frame["prosody"]["speed"].as_f64(), Some(1.25));
    }
}
