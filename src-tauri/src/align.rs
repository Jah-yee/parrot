//! Forced alignment: where each word of the text is in a recording, and how sure the model is that its sounds match
//! the word (0-1). Uses an English wav2vec2 model fine-tuned on Mozilla Common Voice
//! (jonatasgrosman/wav2vec2-large-xlsr-53-english, Apache 2.0), quantised to 8 bits and run with ONNX Runtime.
//! Common Voice has thousands of speakers with every kind of accent and microphone, so a non-native speaker who is
//! understood scores high; a model trained on audiobooks (wav2vec2-base-960h) marked nearly every word of a
//! non-native reading as off. The alignment itself is the classic CTC Viterbi search over the per-frame letter
//! probabilities.

use crate::text::WordTime;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;
use std::sync::OnceLock;

static ENVIRONMENT: OnceLock<ort::environment::Environment> = OnceLock::new();

/// The ONNX Runtime environment, made once for the whole process: ONNX Runtime 1.23 (the Intel Mac build) allows
/// only one per process.
fn environment() -> Result<&'static ort::environment::Environment, String> {
    if let Some(env) = ENVIRONMENT.get() {
        return Ok(env);
    }
    let env = ort::init().with_name("parrot").build().map_err(|e| e.to_string())?;
    Ok(ENVIRONMENT.get_or_init(|| env))
}

/// the model's tokens: blank (0), word separator "|" (4), then ' - a b c ... z from 5
const TOKENS: usize = 33;
const LETTERS: &str = "'-abcdefghijklmnopqrstuvwxyz";
const BLANK: usize = 0;
const SEPARATOR: usize = 4;

fn token(c: char) -> Option<usize> {
    let c = if c == '\u{2019}' { '\'' } else { c.to_ascii_lowercase() };
    if c == '-' { None } else { LETTERS.find(c).map(|i| i + 5) }
}

pub struct Aligner {
    session: Session,
}

impl Aligner {
    pub fn load(model: &Path) -> Result<Self, String> {
        let session = Session::builder(environment()?)
            .and_then(|mut b| b.commit_from_file(model))
            .map_err(|e| format!("could not load the aligner: {e}"))?;
        Ok(Self { session })
    }

    /// Per-frame log probabilities of the tokens, for 16 kHz mono audio.
    fn emissions(&mut self, audio: &[f32]) -> Result<(Vec<[f32; TOKENS]>, f64), String> {
        let n = audio.len().max(1);
        let mean = audio.iter().sum::<f32>() / n as f32;
        let var = audio.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / n as f32;
        let norm: Vec<f32> = audio.iter().map(|x| (x - mean) / (var + 1e-7).sqrt()).collect();
        let input = Tensor::from_array(([1usize, norm.len()], norm)).map_err(|e| e.to_string())?;
        let out = self.session.run(ort::inputs!["audio" => input]).map_err(|e| format!("aligner failed: {e}"))?;
        let (shape, logits) = out["logits"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let frames = shape[1] as usize;
        let rows = (0..frames)
            .map(|t| {
                let row = &logits[t * TOKENS..(t + 1) * TOKENS];
                let max = row.iter().cloned().fold(f32::MIN, f32::max);
                let lse = max + row.iter().map(|x| (x - max).exp()).sum::<f32>().ln();
                let mut r = [0f32; TOKENS];
                for (i, x) in row.iter().enumerate() {
                    r[i] = x - lse;
                }
                r
            })
            .collect();
        Ok((rows, audio.len() as f64 / frames.max(1) as f64 / 16000.0))
    }

    /// Where each whitespace-separated word of the text is (seconds) and how well it scored. Words with no letters
    /// (digits) get nothing; when the take is too short for the text, nothing can be placed and every word scores 0.
    pub fn align(&mut self, audio: &[f32], text: &str) -> Result<Vec<WordTime>, String> {
        let words: Vec<&str> = text.split_whitespace().collect();
        let mut out = vec![WordTime { t: None, score: None }; words.len()];
        // the target: each word's letters, words joined by the separator
        let mut targets: Vec<usize> = vec![];
        let mut owner: Vec<Option<usize>> = vec![]; // the word each target token spells, None for separators
        for (k, w) in words.iter().enumerate() {
            let letters: Vec<usize> = w.chars().filter_map(token).collect();
            if letters.is_empty() {
                continue;
            }
            if !targets.is_empty() {
                targets.push(SEPARATOR);
                owner.push(None);
            }
            for l in letters {
                targets.push(l);
                owner.push(Some(k));
            }
        }
        if targets.is_empty() {
            return Ok(out);
        }
        let (em, secs_per_frame) = self.emissions(audio)?;
        let Some(path) = viterbi(&em, &targets) else {
            return Ok(vec![WordTime { t: None, score: Some(0.0) }; words.len()]);
        };
        // per word: first and last frame, and the frame-weighted mean probability of its letters
        let mut first = vec![usize::MAX; words.len()];
        let mut last = vec![0usize; words.len()];
        let mut sum = vec![0f64; words.len()];
        let mut count = vec![0usize; words.len()];
        for (t, state) in path.iter().enumerate() {
            if let Some(j) = state
                && let Some(k) = owner[*j]
            {
                first[k] = first[k].min(t);
                last[k] = last[k].max(t);
                sum[k] += (em[t][targets[*j]] as f64).exp();
                count[k] += 1;
            }
        }
        for k in 0..words.len() {
            if count[k] > 0 {
                let r = |x: f64| (x * 1000.0).round() / 1000.0;
                out[k] = WordTime {
                    t: Some([r(first[k] as f64 * secs_per_frame), r((last[k] + 1) as f64 * secs_per_frame)]),
                    score: Some(r(sum[k] / count[k] as f64)),
                };
            }
        }
        Ok(out)
    }
}

/// The most likely way to spell the targets over the frames (CTC: blanks between and around the letters, a letter
/// may last several frames, a repeated letter needs a blank between). Per frame: Some(target index) when a letter
/// is being said, None for a blank. None overall when there are fewer frames than the text needs.
fn viterbi(em: &[[f32; TOKENS]], targets: &[usize]) -> Option<Vec<Option<usize>>> {
    let frames = em.len();
    let states = 2 * targets.len() + 1; // blank, t0, blank, t1, ... blank
    let label = |s: usize| if s % 2 == 0 { BLANK } else { targets[s / 2] };
    let needed = targets.len() + targets.windows(2).filter(|w| w[0] == w[1]).count();
    if frames < needed {
        return None;
    }
    const NEG: f32 = f32::NEG_INFINITY;
    let mut score = vec![NEG; states];
    let mut back = vec![vec![0u8; states]; frames]; // 0: stay, 1: from s-1, 2: from s-2
    score[0] = em[0][BLANK];
    score[1] = em[0][label(1)];
    for t in 1..frames {
        let prev = score.clone();
        for s in 0..states {
            let mut best = prev[s];
            let mut how = 0u8;
            if s >= 1 && prev[s - 1] > best {
                best = prev[s - 1];
                how = 1;
            }
            if s >= 2 && s % 2 == 1 && label(s) != label(s - 2) && prev[s - 2] > best {
                best = prev[s - 2];
                how = 2;
            }
            score[s] = if best == NEG { NEG } else { best + em[t][label(s)] };
            back[t][s] = how;
        }
    }
    let mut s = if score[states - 1] >= score[states - 2] { states - 1 } else { states - 2 };
    if score[s] == NEG {
        return None;
    }
    let mut path = vec![None; frames];
    for t in (0..frames).rev() {
        path[t] = if s % 2 == 1 { Some(s / 2) } else { None };
        if t > 0 {
            s -= back[t][s] as usize;
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn build_dir() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".cache/parrot-build")
    }

    /// Needs the model and a sample take in ~/.cache/parrot-build; skipped elsewhere (CI).
    #[test]
    fn aligns_a_real_take() {
        let dir = build_dir();
        let (model, wav) = (dir.join("wav2vec2-xlsr-53-english-int8.onnx"), dir.join("sample.wav"));
        if !model.exists() || !wav.exists() {
            eprintln!("skipped: no model or sample in {}", dir.display());
            return;
        }
        let mut a = Aligner::load(&model).unwrap();
        let pcm = crate::audio::read_wav(&std::fs::read(wav).unwrap()).unwrap();
        let text = "They happen when particles from the Sun hit the air high above the Earth.";
        let words = a.align(&pcm.samples, text).unwrap();
        for (w, r) in text.split_whitespace().zip(&words) {
            eprintln!("{w:12} {:?} {:?}", r.t, r.score);
        }
        assert!(words.iter().all(|w| w.t.is_some()));
        assert!(words.windows(2).all(|p| p[0].t.unwrap()[1] <= p[1].t.unwrap()[0] + 1e-6), "words in order");
        let mean = words.iter().map(|w| w.score.unwrap()).sum::<f64>() / words.len() as f64;
        assert!(mean > 0.7, "a clean reading scores high: {mean}");
        // the wrong text scores clearly lower
        let bad = a.align(&pcm.samples, "Seven green bottles were standing quietly on the kitchen wall at night.").unwrap();
        let bad_mean = bad.iter().filter_map(|w| w.score).sum::<f64>() / bad.len() as f64;
        assert!(bad_mean < mean - 0.2, "{bad_mean} vs {mean}");
    }

    /// Prints word scores for the takes listed in $PARROT_CALIBRATE ("wav|text" per line), to tune the
    /// "sounded off" thresholds in text.rs. cargo test --lib calibrate -- --ignored --nocapture
    #[test]
    #[ignore]
    fn calibrate() {
        let list = std::fs::read_to_string(std::env::var("PARROT_CALIBRATE").unwrap()).unwrap();
        let mut a = Aligner::load(&build_dir().join("wav2vec2-xlsr-53-english-int8.onnx")).unwrap();
        for line in list.lines().filter(|l| !l.is_empty()) {
            let (wav, text) = line.split_once('|').unwrap();
            let pcm = crate::audio::read_wav(&std::fs::read(wav).unwrap()).unwrap();
            let words = a.align(&pcm.samples, text).unwrap();
            let row: Vec<String> = text.split_whitespace().zip(&words).map(|(w, r)| format!("{w}:{:.2}", r.score.unwrap_or(-1.0))).collect();
            println!("{} || {}", wav.rsplit('/').nth(1).unwrap_or(""), row.join(" "));
        }
    }

    #[test]
    fn too_short_for_the_text_places_nothing() {
        let em = vec![[0f32; TOKENS]; 3];
        assert!(viterbi(&em, &[5, 6, 7, 8]).is_none());
        assert!(viterbi(&em, &[5, 5]).is_some()); // two equal letters need a blank between: 3 frames
        assert!(viterbi(&vec![[0f32; TOKENS]; 2], &[5, 5]).is_none());
    }
}
