use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    let key = std::env::var("FISH_KEY").expect("FISH_KEY");
    let url = std::env::var("FISH_URL").unwrap_or_else(|_| "wss://api.fish.audio/v1/tts/live".into());
    let mut req = url.clone().into_client_request().expect("request");
    {
        let headers = req.headers_mut();
        headers.insert("Authorization", format!("Bearer {key}").parse().unwrap());
        headers.insert("model", "s2.1-pro-free".parse().unwrap());
    }
    let started = std::time::Instant::now();
    match tokio_tungstenite::connect_async(req).await {
        Ok((mut ws, response)) => {
            println!("CONNECTED after {:?}: {}", started.elapsed(), response.status());
            let start = serde_json::json!({
                "event": "start",
                "request": {
                    "text": "",
                    "format": "pcm",
                    "latency": "balanced",
                    "chunk_length": 100,
                    "min_chunk_length": 20,
                    "sample_rate": 24000,
                    "reference_id": "8e2b29af90a64847879adf0601cc36f0"
                }
            });
            let bytes = rmp_serde::to_vec(&start).unwrap();
            ws.send(Message::Binary(bytes.into())).await.expect("start frame");
            let text = serde_json::json!({ "event": "text", "text": "你好，这是一次连接测试。" });
            ws.send(Message::Binary(rmp_serde::to_vec(&text).unwrap().into())).await.expect("text frame");
            ws.send(Message::Binary(rmp_serde::to_vec(&serde_json::json!({"event":"flush"})).unwrap().into())).await.ok();
            let mut total = 0usize;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
            loop {
                let read = tokio::time::timeout_at(deadline, futures_util::StreamExt::next(&mut ws)).await;
                match read {
                    Err(_) => { println!("TIMEOUT total_audio={total}"); break; }
                    Ok(None) => { println!("EOF total_audio={total}"); break; }
                    Ok(Some(Err(e))) => { println!("READ ERROR: {e:?} total={total}"); break; }
                    Ok(Some(Ok(Message::Binary(data)))) => {
                        total += data.len();
                        println!("binary frame {} bytes (total {})", data.len(), total);
                    }
                    Ok(Some(Ok(other))) => println!("frame: {:?}", other),
                }
            }
            ws.close(None).await.ok();
        }
        Err(err) => println!("CONNECT ERROR after {:?}: {err:?}", started.elapsed()),
    }
}
