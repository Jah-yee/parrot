//! The two speech models Parrot needs, downloaded into the app's data folder the first time it opens.

use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

pub struct Model {
    pub key: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    /// the size it should have, to tell a finished download from a broken one
    pub bytes: u64,
}

pub const WHISPER: Model = Model {
    key: "whisper",
    file: "ggml-small.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    bytes: 487_614_201,
};

/// jonatasgrosman/wav2vec2-large-xlsr-53-english (Apache 2.0), exported to ONNX and quantised to 8 bits
pub const ALIGNER: Model = Model {
    key: "aligner",
    file: "wav2vec2-xlsr-53-english-int8.onnx",
    url: "https://github.com/qwertymuzaffar/parrot/releases/download/models-v1/wav2vec2-xlsr-53-english-int8.onnx",
    bytes: 317_292_394,
};

pub const ALL: [&Model; 2] = [&WHISPER, &ALIGNER];

pub fn path(dir: &Path, m: &Model) -> PathBuf {
    dir.join(m.file)
}

/// A model is ready when its file is there at the full size (a link to a file of that size counts).
pub fn ready(dir: &Path, m: &Model) -> bool {
    std::fs::metadata(path(dir, m)).map(|md| md.len() == m.bytes).unwrap_or(false)
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    model: &'a str,
    received: u64,
    total: u64,
}

/// Download every missing model, reporting "model-progress" events as it goes. A partial file is kept as
/// <file>.part and replaced on the next try.
pub async fn download_missing(app: &AppHandle, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().user_agent("Parrot").build().map_err(|e| e.to_string())?;
    for m in ALL {
        if ready(dir, m) {
            continue;
        }
        let res = client.get(m.url).send().await.map_err(|e| format!("could not download {}: {e}", m.file))?;
        if !res.status().is_success() {
            return Err(format!("could not download {}: {}", m.file, res.status()));
        }
        let total = res.content_length().unwrap_or(m.bytes);
        let part = dir.join(format!("{}.part", m.file));
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut received = 0u64;
        let mut last = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("the download of {} stopped: {e}", m.file))?;
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if received - last > 1_000_000 || received == total {
                last = received;
                let _ = app.emit("model-progress", Progress { model: m.key, received, total });
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if received != m.bytes {
            return Err(format!("{} arrived incomplete ({received} of {} bytes); try again", m.file, m.bytes));
        }
        std::fs::rename(&part, path(dir, m)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
