//! Where texts and tries are kept: plain files in the app's data folder, the same layout the first (Python) engine
//! used, so a library made with it opens unchanged.
//!
//!     texts/<id>/text.txt          the text (id: the first 10 hex digits of the SHA-1 of its words)
//!     texts/<id>/meta.json         title, practise mode, when created and last opened
//!     texts/<id>/p-<sha1>/         one folder per part that has been recorded, named after its words
//!         <time>.wav + <time>.json a try: the cleaned recording, and what was heard and scored
//!     trash/                       deleted texts, moved here rather than erased

use crate::text::WordResult;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn norm(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn sha(text: &str) -> String {
    let digest = Sha1::digest(norm(text).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()[..10].to_string()
}

fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PartScore {
    pub last: i64,
    pub best: i64,
    pub tries: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Attempt {
    pub id: String,
    pub when: String,
    pub text: String,
    pub heard: String,
    pub words: Vec<WordResult>,
    pub duration: f64,
    pub wpm: i64,
    pub score: i64,
    /// the recording, relative to the data folder (first-engine tries say /files/texts/...)
    pub audio: String,
}

pub struct Store {
    pub data: PathBuf,
}

impl Store {
    fn texts(&self) -> PathBuf {
        self.data.join("texts")
    }

    fn text_dir(&self, id: &str) -> Result<PathBuf, String> {
        if id.len() != 10 || !id.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("bad text id".into());
        }
        let dir = self.texts().join(id);
        if dir.join("text.txt").exists() { Ok(dir) } else { Err(format!("not found: {id}")) }
    }

    /// The folder of one part of a text, checked to really be in the text.
    pub fn part_dir(&self, id: &str, part: &str) -> Result<PathBuf, String> {
        let dir = self.text_dir(id)?;
        let full = fs::read_to_string(dir.join("text.txt")).map_err(|error| error.to_string())?;
        if part.trim().is_empty() || !norm(&full).contains(&norm(part)) {
            return Err("that part is not in the text; reload".into());
        }
        Ok(dir.join(format!("p-{}", sha(part))))
    }

    fn meta(dir: &Path) -> serde_json::Map<String, Value> {
        fs::read_to_string(dir.join("meta.json"))
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn save_meta(dir: &Path, change: &[(&str, Option<Value>)]) -> Result<(), String> {
        let mut meta = Self::meta(dir);
        for (key, value) in change {
            if let Some(value) = value {
                meta.insert(key.to_string(), value.clone());
            }
        }
        fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).map_err(|error| error.to_string())
    }

    fn read_attempts(dir: &Path) -> Vec<Attempt> {
        let mut files: Vec<PathBuf> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                    .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        files.iter().filter_map(|path| fs::read_to_string(path).ok().and_then(|contents| serde_json::from_str(&contents).ok())).collect()
    }

    pub fn scores(&self, id: &str) -> Result<BTreeMap<String, PartScore>, String> {
        let dir = self.text_dir(id)?;
        let mut out = BTreeMap::new();
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("p-") || !entry.path().is_dir() {
                continue;
            }
            let tries = Self::read_attempts(&entry.path());
            if let Some(last) = tries.last() {
                let best = tries.iter().map(|attempt| attempt.score).max().unwrap_or(0);
                out.insert(name, PartScore { last: last.score, best, tries: tries.len() });
            }
        }
        Ok(out)
    }

    fn text_info(&self, dir: &Path) -> Value {
        let id = dir.file_name().unwrap().to_string_lossy().to_string();
        let body = fs::read_to_string(dir.join("text.txt")).unwrap_or_default();
        let meta = Self::meta(dir);
        let scores = self.scores(&id).unwrap_or_default();
        let last: Vec<i64> = scores.values().map(|part| part.last).collect();
        let created = meta.get("created").and_then(Value::as_str).map(String::from).unwrap_or_else(|| {
            fs::metadata(dir.join("text.txt"))
                .and_then(|metadata| metadata.modified())
                .map(|modified| chrono::DateTime::<Local>::from(modified).format("%Y-%m-%dT%H:%M:%S").to_string())
                .unwrap_or_else(|_| now())
        });
        let title = meta
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("{}…", body.split_whitespace().take(6).collect::<Vec<_>>().join(" ")));
        json!({
            "id": id, "title": title, "text": body, "words": body.split_whitespace().count(), "created": created,
            "mode": meta.get("mode").cloned().unwrap_or(json!("sentences")), "opened": meta.get("opened").cloned(),
            "practised": last.len(), "scores": scores,
            "average": if last.is_empty() { Value::Null } else { json!((last.iter().sum::<i64>() as f64 / last.len() as f64).round() as i64) },
        })
    }

    pub fn list(&self) -> Vec<Value> {
        let mut out: Vec<Value> = fs::read_dir(self.texts())
            .map(|entries| {
                entries.flatten().map(|entry| entry.path()).filter(|path| path.join("text.txt").exists()).map(|path| self.text_info(&path)).collect()
            })
            .unwrap_or_default();
        let key = |text: &Value| text["opened"].as_str().or(text["created"].as_str()).unwrap_or("").to_string();
        out.sort_by_key(|text| std::cmp::Reverse(key(text)));
        out
    }

    pub fn add(&self, text: &str, title: Option<String>, mode: Option<String>) -> Result<Value, String> {
        let body = norm(text);
        if body.is_empty() {
            return Err("the text is empty".into());
        }
        let dir = self.texts().join(sha(&body));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::write(dir.join("text.txt"), &body).map_err(|error| error.to_string())?;
        let created = if dir.join("meta.json").exists() { None } else { Some(json!(now())) };
        let title = title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty()).map(Value::from);
        Self::save_meta(&dir, &[("title", title), ("mode", mode.map(Value::from)), ("created", created)])?;
        Ok(self.text_info(&dir))
    }

    pub fn update(&self, id: &str, title: Option<String>, mode: Option<String>, opened: bool) -> Result<Value, String> {
        let dir = self.text_dir(id)?;
        let title = title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty()).map(Value::from);
        let opened = if opened { Some(json!(now())) } else { None };
        Self::save_meta(&dir, &[("title", title), ("mode", mode.map(Value::from)), ("opened", opened)])?;
        Ok(self.text_info(&dir))
    }

    /// Moved to the trash folder, not deleted.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let dir = self.text_dir(id)?;
        let trash = self.data.join("trash");
        fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
        fs::rename(&dir, trash.join(format!("{id}-{}", Local::now().format("%Y%m%d-%H%M%S")))).map_err(|error| error.to_string())
    }

    pub fn attempts(&self, id: &str, part: &str) -> Result<Vec<Value>, String> {
        let mut tries = Self::read_attempts(&self.part_dir(id, part)?);
        tries.reverse();
        Ok(tries
            .iter()
            .map(|attempt| json!({"id": attempt.id, "when": attempt.when, "score": attempt.score, "wpm": attempt.wpm, "duration": attempt.duration}))
            .collect())
    }

    pub fn attempt(&self, id: &str, part: &str, attempt: &str) -> Result<Attempt, String> {
        let name: String = attempt.chars().filter(|character| character.is_ascii_digit() || *character == '-').collect();
        let path = self.part_dir(id, part)?.join(format!("{name}.json"));
        serde_json::from_str(&fs::read_to_string(&path).map_err(|_| format!("not found: {name}"))?).map_err(|error| error.to_string())
    }

    pub fn save_attempt(&self, dir: &Path, attempt: &Attempt) -> Result<(), String> {
        fs::write(dir.join(format!("{}.json", attempt.id)), serde_json::to_string_pretty(attempt).unwrap()).map_err(|error| error.to_string())
    }

    /// Tries per day for the last 7 days (today last), and their average score.
    pub fn activity(&self) -> Value {
        let today = Local::now().date_naive();
        let mut days: BTreeMap<chrono::NaiveDate, usize> = (0..7).map(|days_ago| (today - chrono::Duration::days(days_ago), 0)).collect();
        let (mut total, mut scored) = (0i64, 0i64);
        if let Ok(texts) = fs::read_dir(self.texts()) {
            for text in texts.flatten() {
                let parts = fs::read_dir(text.path()).into_iter().flatten().flatten();
                for part in parts.filter(|part| part.file_name().to_string_lossy().starts_with("p-")) {
                    for file in fs::read_dir(part.path()).into_iter().flatten().flatten() {
                        let name = file.file_name().to_string_lossy().to_string();
                        if !name.ends_with(".json") || name.len() < 8 {
                            continue;
                        }
                        let Ok(day) = chrono::NaiveDate::parse_from_str(&name[..8], "%Y%m%d") else { continue };
                        if let Some(tries) = days.get_mut(&day) {
                            *tries += 1;
                            let attempt = fs::read_to_string(file.path()).ok().and_then(|contents| serde_json::from_str::<Attempt>(&contents).ok());
                            if let Some(attempt) = attempt {
                                total += attempt.score;
                                scored += 1;
                            }
                        }
                    }
                }
            }
        }
        json!({
            "days": days.iter().map(|(date, tries)| json!({"date": date.format("%Y-%m-%d").to_string(), "tries": tries})).collect::<Vec<_>>(),
            "tries": scored, "average": if scored > 0 { json!((total as f64 / scored as f64).round() as i64) } else { Value::Null },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_python_engine() {
        // the same text ids the Python engine gives (sha1 of the normalised words), so its library opens unchanged
        assert_eq!(sha("Hello   there."), "95e3ac5665");
        assert_eq!(sha("I'm a front-end engineer with a bit over ten years"), "091ec5749e");
        assert_eq!(sha("I'm a front-end engineer").len(), 10);
    }

    #[test]
    fn texts_round_trip() {
        let dir = std::env::temp_dir().join(format!("parrot-store-{}", std::process::id()));
        let store = Store { data: dir.clone() };
        let added = store.add("Hello there. How are you?", Some("Greeting".into()), Some("sentences".into())).unwrap();
        let id = added["id"].as_str().unwrap().to_string();
        assert_eq!(store.list().len(), 1);
        assert!(store.part_dir(&id, "How are you?").is_ok());
        assert!(store.part_dir(&id, "Something else").is_err());
        assert_eq!(store.update(&id, Some("Hi".into()), None, true).unwrap()["title"], "Hi");
        store.delete(&id).unwrap();
        assert!(store.list().is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
