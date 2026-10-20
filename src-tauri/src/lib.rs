//! Parrot's engine, inside the app: the interface calls these commands. Texts and tries are files in the app's
//! data folder (store.rs); a take is cleaned (audio.rs), placed word by word and scored (align.rs), heard by
//! Whisper (asr.rs) and judged word by word (text.rs).

mod align;
mod asr;
mod audio;
mod models;
mod sounds;
mod store;
mod text;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use store::{Attempt, Store};
use tauri::{AppHandle, Manager, State};

pub struct Engine {
    store: Store,
    models: PathBuf,
    aligner: Mutex<Option<align::Aligner>>,
    recognizer: Mutex<Option<asr::Recognizer>>,
}

type Shared = Arc<Engine>;

impl Engine {
    fn with_aligner<T>(&self, f: impl FnOnce(&mut align::Aligner) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.aligner.lock().unwrap();
        if guard.is_none() {
            *guard = Some(align::Aligner::load(&models::path(&self.models, &models::ALIGNER))?);
        }
        f(guard.as_mut().unwrap())
    }

    fn with_recognizer<T>(&self, f: impl FnOnce(&asr::Recognizer) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.recognizer.lock().unwrap();
        if guard.is_none() {
            *guard = Some(asr::Recognizer::load(&models::path(&self.models, &models::WHISPER))?);
        }
        f(guard.as_ref().unwrap())
    }

    /// Load both models ahead of the first take, so it isn't slow.
    fn warm(&self) {
        if models::ALL.iter().all(|m| models::ready(&self.models, m)) {
            let _ = self.with_aligner(|_| Ok(()));
            let _ = self.with_recognizer(|_| Ok(()));
        }
    }

    /// Save a take (a WAV file), score it against `part` and keep the result next to it.
    fn check(&self, text_id: &str, part: &str, wav: &[u8]) -> Result<Attempt, String> {
        let dir = self.store.part_dir(text_id, part)?;
        let raw = audio::read_wav(wav)?;
        let take = audio::clean(raw).filter(|p| p.seconds() >= 0.5).ok_or("Nothing was heard in the recording. Is the microphone on?")?;
        let a16 = audio::resample(&take, 16000);
        let txt = store::norm(part);
        let mut mine = self.with_aligner(|a| a.align(&a16, &txt))?;
        let heard = self.with_recognizer(|r| r.transcribe(&a16, &mine, 25.0))?;
        // stopped before the end: the aligner squeezes the whole text into the take and the words that were said
        // score low, so score only the words up to the last one heard; the rest count as missed
        let (wrong, _) = text::heard_words(&txt, &heard);
        let said = wrong.iter().rposition(|w| w.is_none()).map(|i| i + 1).unwrap_or(0);
        if said > 0 && said < mine.len() && wrong[said..].iter().all(|w| w.as_deref() == Some("")) {
            let first: Vec<&str> = txt.split_whitespace().take(said).collect();
            let head = self.with_aligner(|a| a.align(&a16, &first.join(" ")))?;
            mine.splice(..said, head);
            for m in &mut mine[said..] {
                *m = text::WordTime { score: Some(0.0), ..Default::default() };
            }
        }
        let words = text::judge(&txt, &heard, &mine, None);
        let good = words.iter().filter(|w| w.status == "good").count();
        let spoken = if said > 0 && said < words.len() { said } else { words.len() };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let now = chrono::Local::now();
        let id = now.format("%Y%m%d-%H%M%S").to_string();
        let file = dir.join(format!("{id}.wav"));
        audio::write_wav(&file, &take)?;
        let secs = take.seconds();
        let attempt = Attempt {
            id,
            when: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
            text: txt,
            heard,
            score: (100.0 * good as f64 / words.len().max(1) as f64).round() as i64,
            wpm: if secs > 0.0 { (spoken as f64 / secs * 60.0).round() as i64 } else { 0 },
            words,
            duration: (secs * 100.0).round() / 100.0,
            audio: file.strip_prefix(&self.store.data).unwrap_or(&file).to_string_lossy().replace('\\', "/"),
        };
        self.store.save_attempt(&dir, &attempt)?;
        Ok(attempt)
    }
}

/// Run blocking engine work off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn info(engine: State<'_, Shared>) -> Value {
    json!({
        "data": engine.store.data,
        "models": models::ALL.iter().map(|m| (m.key, models::ready(&engine.models, m))).collect::<std::collections::BTreeMap<_, _>>(),
        "sizes": models::ALL.iter().map(|m| (m.key, m.bytes)).collect::<std::collections::BTreeMap<_, _>>(),
    })
}

#[tauri::command]
fn texts(engine: State<'_, Shared>) -> Vec<Value> {
    engine.store.list()
}

#[tauri::command]
fn add_text(engine: State<'_, Shared>, text: String, title: Option<String>, mode: Option<String>) -> Result<Value, String> {
    engine.store.add(&text, title, mode)
}

#[tauri::command]
fn update_text(engine: State<'_, Shared>, id: String, title: Option<String>, mode: Option<String>, opened: Option<bool>) -> Result<Value, String> {
    engine.store.update(&id, title, mode, opened.unwrap_or(false))
}

#[tauri::command]
fn delete_text(engine: State<'_, Shared>, id: String) -> Result<(), String> {
    engine.store.delete(&id)
}

#[tauri::command]
fn scores(engine: State<'_, Shared>, text: String) -> Result<Value, String> {
    engine.store.scores(&text).map(|s| json!(s))
}

#[tauri::command]
fn attempts(engine: State<'_, Shared>, text: String, part: String) -> Result<Vec<Value>, String> {
    engine.store.attempts(&text, &part)
}

#[tauri::command]
fn attempt(engine: State<'_, Shared>, text: String, part: String, id: String) -> Result<Attempt, String> {
    engine.store.attempt(&text, &part, &id)
}

#[tauri::command]
fn activity(engine: State<'_, Shared>) -> Value {
    engine.store.activity()
}

#[tauri::command]
fn pron(w: String) -> Value {
    sounds::sounds_like(&w).map(|s| json!(s)).unwrap_or(json!({}))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A take: the WAV file as the request body, the text id and the part (URI-encoded) in the headers.
#[tauri::command]
async fn check(engine: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<Attempt, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the recording as raw bytes".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let (text_id, part, wav) = (header("x-text"), header("x-part"), bytes.clone());
    let engine = engine.inner().clone();
    blocking(move || engine.check(&text_id, &part, &wav)).await
}

#[tauri::command]
async fn download_models(app: AppHandle, engine: State<'_, Shared>) -> Result<(), String> {
    let dir = engine.models.clone();
    models::download_missing(&app, &dir).await?;
    let engine = engine.inner().clone();
    std::thread::spawn(move || engine.warm());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // macOS: ~/Library/Application Support/io.github.qwertymuzaffar.parrot (the first engine's folder too)
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(data.join("texts"))?;
            let engine = Arc::new(Engine {
                models: data.join("models"),
                store: Store { data },
                aligner: Mutex::new(None),
                recognizer: Mutex::new(None),
            });
            let warm = engine.clone();
            std::thread::spawn(move || warm.warm());
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            info, texts, add_text, update_text, delete_text, scores, attempts, attempt, activity, pron, check, download_models
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A take through the whole engine, as the app runs it: needs the models on this machine.
    /// cargo test --lib whole_take -- --ignored --nocapture
    #[test]
    #[ignore]
    fn whole_take() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let models = home.join("Library/Application Support/io.github.qwertymuzaffar.parrot/models");
        let data = std::env::temp_dir().join(format!("parrot-e2e-{}", std::process::id()));
        std::fs::create_dir_all(data.join("texts")).unwrap();
        let engine = Engine { store: Store { data: data.clone() }, models, aligner: Mutex::new(None), recognizer: Mutex::new(None) };
        let text = "The northern lights are one of the most beautiful things you can see in the night sky.";
        let t = engine.store.add(text, Some("Lights".into()), Some("sentences".into())).unwrap();
        let id = t["id"].as_str().unwrap().to_string();
        let wav = std::fs::read(std::env::var("PARROT_TAKE").unwrap()).unwrap();
        let started = std::time::Instant::now();
        let a = engine.check(&id, text, &wav).unwrap();
        eprintln!("{:.1} s · score {} · {} wpm · heard: {}", started.elapsed().as_secs_f64(), a.score, a.wpm, a.heard);
        for w in a.words.iter().filter(|w| w.status != "good") {
            eprintln!("  {} {} heard={:?} score={:?}", w.w, w.status, w.heard, w.score);
        }
        if let Ok(out) = std::env::var("PARROT_E2E_OUT") {
            std::fs::write(out, serde_json::to_string(&a.words).unwrap()).unwrap();
        }
        let things = a.words.iter().find(|w| w.w == "things").unwrap();
        let letters = things.letters.as_ref().unwrap();
        eprintln!("  things letters: {letters:?}");
        let th = (letters[0].unwrap() + letters[1].unwrap()) / 2.0;
        let rest = letters[2..].iter().map(|l| l.unwrap()).sum::<f64>() / 4.0;
        assert!(th < rest, "the th of things said as sinks scores lowest: {th} vs {rest}");
        assert!(data.join(&a.audio).exists(), "the take is saved");
        assert_eq!(engine.store.attempts(&id, text).unwrap().len(), 1);
        assert_eq!(engine.store.scores(&id).unwrap().values().next().unwrap().last, a.score);
        assert!(a.words.iter().any(|w| w.w == "things" && w.status == "wrong" && w.heard.as_deref() == Some("sinks")));
        let silent = {
            let p = data.join("silence.wav");
            audio::write_wav(&p, &audio::Pcm { samples: vec![0.0; 48000], rate: 48000 }).unwrap();
            std::fs::read(p).unwrap()
        };
        assert!(engine.check(&id, text, &silent).unwrap_err().contains("Nothing was heard"));
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn headers_decode() {
        assert_eq!(super::percent_decode("I%E2%80%99m%20here%2C%20ok"), "I’m here, ok");
        assert_eq!(super::percent_decode("plain"), "plain");
    }
}
