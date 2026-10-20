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

pub fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn sha(s: &str) -> String {
    let d = Sha1::digest(norm(s).as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..10].to_string()
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
        if id.len() != 10 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("bad text id".into());
        }
        let d = self.texts().join(id);
        if d.join("text.txt").exists() { Ok(d) } else { Err(format!("not found: {id}")) }
    }

    /// The folder of one part of a text, checked to really be in the text.
    pub fn part_dir(&self, id: &str, part: &str) -> Result<PathBuf, String> {
        let d = self.text_dir(id)?;
        let full = fs::read_to_string(d.join("text.txt")).map_err(|e| e.to_string())?;
        if part.trim().is_empty() || !norm(&full).contains(&norm(part)) {
            return Err("that part is not in the text; reload".into());
        }
        Ok(d.join(format!("p-{}", sha(part))))
    }

    fn meta(d: &Path) -> serde_json::Map<String, Value> {
        fs::read_to_string(d.join("meta.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn save_meta(d: &Path, change: &[(&str, Option<Value>)]) -> Result<(), String> {
        let mut m = Self::meta(d);
        for (k, v) in change {
            if let Some(v) = v {
                m.insert(k.to_string(), v.clone());
            }
        }
        fs::write(d.join("meta.json"), serde_json::to_string_pretty(&m).unwrap()).map_err(|e| e.to_string())
    }

    fn read_attempts(dir: &Path) -> Vec<Attempt> {
        let mut files: Vec<PathBuf> = fs::read_dir(dir)
            .map(|r| r.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
            .unwrap_or_default();
        files.sort();
        files.iter().filter_map(|p| fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())).collect()
    }

    pub fn scores(&self, id: &str) -> Result<BTreeMap<String, PartScore>, String> {
        let d = self.text_dir(id)?;
        let mut out = BTreeMap::new();
        for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("p-") || !e.path().is_dir() {
                continue;
            }
            let tries = Self::read_attempts(&e.path());
            if let Some(last) = tries.last() {
                out.insert(name, PartScore { last: last.score, best: tries.iter().map(|t| t.score).max().unwrap_or(0), tries: tries.len() });
            }
        }
        Ok(out)
    }

    fn text_info(&self, d: &Path) -> Value {
        let id = d.file_name().unwrap().to_string_lossy().to_string();
        let body = fs::read_to_string(d.join("text.txt")).unwrap_or_default();
        let meta = Self::meta(d);
        let scores = self.scores(&id).unwrap_or_default();
        let last: Vec<i64> = scores.values().map(|s| s.last).collect();
        let created = meta.get("created").and_then(Value::as_str).map(String::from).unwrap_or_else(|| {
            fs::metadata(d.join("text.txt"))
                .and_then(|m| m.modified())
                .map(|t| chrono::DateTime::<Local>::from(t).format("%Y-%m-%dT%H:%M:%S").to_string())
                .unwrap_or_else(|_| now())
        });
        let title = meta
            .get("title")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
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
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.join("text.txt").exists()).map(|p| self.text_info(&p)).collect())
            .unwrap_or_default();
        let key = |v: &Value| v["opened"].as_str().or(v["created"].as_str()).unwrap_or("").to_string();
        out.sort_by_key(|v| std::cmp::Reverse(key(v)));
        out
    }

    pub fn add(&self, text: &str, title: Option<String>, mode: Option<String>) -> Result<Value, String> {
        let body = norm(text);
        if body.is_empty() {
            return Err("the text is empty".into());
        }
        let d = self.texts().join(sha(&body));
        fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        fs::write(d.join("text.txt"), &body).map_err(|e| e.to_string())?;
        let created = if d.join("meta.json").exists() { None } else { Some(json!(now())) };
        let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).map(Value::from);
        Self::save_meta(&d, &[("title", title), ("mode", mode.map(Value::from)), ("created", created)])?;
        Ok(self.text_info(&d))
    }

    pub fn update(&self, id: &str, title: Option<String>, mode: Option<String>, opened: bool) -> Result<Value, String> {
        let d = self.text_dir(id)?;
        let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).map(Value::from);
        let opened = if opened { Some(json!(now())) } else { None };
        Self::save_meta(&d, &[("title", title), ("mode", mode.map(Value::from)), ("opened", opened)])?;
        Ok(self.text_info(&d))
    }

    /// Moved to the trash folder, not deleted.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let d = self.text_dir(id)?;
        let trash = self.data.join("trash");
        fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        fs::rename(&d, trash.join(format!("{id}-{}", Local::now().format("%Y%m%d-%H%M%S")))).map_err(|e| e.to_string())
    }

    pub fn attempts(&self, id: &str, part: &str) -> Result<Vec<Value>, String> {
        let mut tries = Self::read_attempts(&self.part_dir(id, part)?);
        tries.reverse();
        Ok(tries.iter().map(|a| json!({"id": a.id, "when": a.when, "score": a.score, "wpm": a.wpm, "duration": a.duration})).collect())
    }

    pub fn attempt(&self, id: &str, part: &str, attempt: &str) -> Result<Attempt, String> {
        let name: String = attempt.chars().filter(|c| c.is_ascii_digit() || *c == '-').collect();
        let p = self.part_dir(id, part)?.join(format!("{name}.json"));
        serde_json::from_str(&fs::read_to_string(&p).map_err(|_| format!("not found: {name}"))?).map_err(|e| e.to_string())
    }

    pub fn save_attempt(&self, dir: &Path, a: &Attempt) -> Result<(), String> {
        fs::write(dir.join(format!("{}.json", a.id)), serde_json::to_string_pretty(a).unwrap()).map_err(|e| e.to_string())
    }

    /// Tries per day for the last 7 days (today last), and their average score.
    pub fn activity(&self) -> Value {
        let today = Local::now().date_naive();
        let mut days: BTreeMap<chrono::NaiveDate, usize> = (0..7).map(|k| (today - chrono::Duration::days(k), 0)).collect();
        let (mut total, mut n) = (0i64, 0i64);
        if let Ok(texts) = fs::read_dir(self.texts()) {
            for t in texts.flatten() {
                for p in fs::read_dir(t.path()).into_iter().flatten().flatten().filter(|p| p.file_name().to_string_lossy().starts_with("p-")) {
                    for f in fs::read_dir(p.path()).into_iter().flatten().flatten() {
                        let name = f.file_name().to_string_lossy().to_string();
                        if !name.ends_with(".json") || name.len() < 8 {
                            continue;
                        }
                        let Ok(day) = chrono::NaiveDate::parse_from_str(&name[..8], "%Y%m%d") else { continue };
                        if let Some(c) = days.get_mut(&day) {
                            *c += 1;
                            if let Some(a) = fs::read_to_string(f.path()).ok().and_then(|s| serde_json::from_str::<Attempt>(&s).ok()) {
                                total += a.score;
                                n += 1;
                            }
                        }
                    }
                }
            }
        }
        json!({
            "days": days.iter().map(|(d, c)| json!({"date": d.format("%Y-%m-%d").to_string(), "tries": c})).collect::<Vec<_>>(),
            "tries": n, "average": if n > 0 { json!((total as f64 / n as f64).round() as i64) } else { Value::Null },
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
        let s = Store { data: dir.clone() };
        let t = s.add("Hello there. How are you?", Some("Greeting".into()), Some("sentences".into())).unwrap();
        let id = t["id"].as_str().unwrap().to_string();
        assert_eq!(s.list().len(), 1);
        assert!(s.part_dir(&id, "How are you?").is_ok());
        assert!(s.part_dir(&id, "Something else").is_err());
        assert_eq!(s.update(&id, Some("Hi".into()), None, true).unwrap()["title"], "Hi");
        s.delete(&id).unwrap();
        assert!(s.list().is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
