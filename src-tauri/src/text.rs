//! Compare what was read with what the speech recognizer heard, word by word.
//!
//! Both sides are turned into the same tokens first: lower case, no punctuation, and numbers as digits whichever
//! way they were written ("nineteen fifty-nine", "1959" -> "#1959"), so only real differences count.

use regex::Regex;
use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

static UNITS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
        .split(' ').enumerate().map(|(i, w)| (w, i as i64)).collect()
});
static TENS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    "twenty thirty forty fifty sixty seventy eighty ninety".split(' ').enumerate().map(|(i, w)| (w, 10 * (i as i64 + 2))).collect()
});
// "second" is left out on purpose: it is far more often the time unit ("twenty seconds") than the ordinal
static ORDINALS: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    [("first", 1), ("third", 3), ("fourth", 4), ("fifth", 5), ("sixth", 6), ("seventh", 7), ("eighth", 8), ("ninth", 9),
     ("tenth", 10), ("eleventh", 11), ("twelfth", 12), ("thirteenth", 13), ("fourteenth", 14), ("fifteenth", 15),
     ("sixteenth", 16), ("seventeenth", 17), ("eighteenth", 18), ("nineteenth", 19), ("twentieth", 20), ("thirtieth", 30),
     ("fortieth", 40), ("fiftieth", 50), ("sixtieth", 60), ("seventieth", 70), ("eightieth", 80), ("ninetieth", 90)]
        .into_iter().collect()
});
static SCALES: LazyLock<HashMap<&str, i64>> = LazyLock::new(|| {
    [("hundred", 100), ("thousand", 1_000), ("million", 1_000_000), ("billion", 1_000_000_000), ("trillion", 1_000_000_000_000)]
        .into_iter().collect()
});
/// words that are the same thing said two ways (text spelling / whisper spelling), or that whisper drops
static SAME: LazyLock<HashMap<&str, &str>> = LazyLock::new(|| {
    [("it's", "its"), ("percent", ""), ("%", ""), ("dollars", ""), ("dollar", ""), ("fahrenheit", "f"), ("degrees", ""),
     ("okay", "ok"), ("a.i", "ai"),
     // British spelling in the text; whisper small.en writes American
     ("kilometres", "kilometers"), ("metres", "meters"), ("litres", "liters"), ("centimetres", "centimeters"), ("grey", "gray"),
     ("colour", "color"), ("colours", "colors"), ("plough", "plow"), ("ploughs", "plows"), ("centre", "center"),
     ("programme", "program"), ("favourite", "favorite"), ("aluminium", "aluminum"), ("travelled", "traveled"),
     ("travelling", "traveling"), ("fibre", "fiber"), ("theatre", "theater"), ("defence", "defense"), ("licence", "license"),
     ("neighbour", "neighbor"), ("honour", "honor"), ("behaviour", "behavior"), ("catalogue", "catalog"),
     ("organise", "organize"), ("realise", "realize"), ("recognise", "recognize"), ("analyse", "analyze"),
     ("manoeuvre", "maneuver"), ("sulphur", "sulfur"), ("practise", "practice"), ("mould", "mold"), ("storey", "story")]
        .into_iter().collect()
});
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(?:[.,]\d+)*(?:st|nd|rd|th)?$").unwrap());
static CLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,2}\.[0-5]\d$").unwrap());
static RAW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?|[a-z][a-z'.]*").unwrap());
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(st|nd|rd|th)$").unwrap());

fn is_digits(t: &str) -> bool {
    DIGITS.is_match(t)
}

fn numeric(t: &str) -> bool {
    UNITS.contains_key(t) || TENS.contains_key(t) || ORDINALS.contains_key(t) || SCALES.contains_key(t) || is_digits(t)
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Unit,
    Tens,
    Digits,
    Scale,
}

/// A run of number tokens (words or digits) as one digit string: "sixty eight" -> 68, "nineteen eighty six" -> 1986,
/// "twenty twenty four" -> 2024, "three thirty" -> 330, "a hundred and fifty thousand" -> 150000,
/// "one point three million" -> 1300000, "twenty first" -> 21, and the same from whisper's digits.
/// Juxtaposed groups (a year, a clock time) are joined, later groups padded to two digits.
fn compose(run: &[String]) -> String {
    let mut groups: Vec<f64> = vec![];
    let (mut cur, mut total) = (0f64, 0f64);
    let mut frac: Option<String> = None;
    let mut prev: Option<Kind> = None;
    let fold = |cur: &mut f64, frac: &mut Option<String>| {
        if let Some(f) = frac.as_ref().filter(|f| !f.is_empty()) {
            *cur = format!("{}.{}", *cur as i64, f).parse().unwrap_or(*cur);
        }
        *frac = None;
    };
    for tok in run {
        let tok = tok.as_str();
        if tok == "a" || tok == "and" {
            if tok == "a" {
                cur = 1.0;
                prev = Some(Kind::Unit);
            }
            continue;
        }
        if tok == "point" {
            frac = Some(String::new());
            continue;
        }
        let (v, kind);
        if is_digits(tok) {
            let mut s = SUFFIX.replace(tok, "").replace(',', "");
            if CLOCK.is_match(&s) {
                s = s.replace('.', ""); // whisper writes "three-thirty" as "3.30": a clock time, not 3.3
            }
            v = s.parse::<f64>().unwrap_or(0.0);
            kind = Kind::Digits;
        } else if let Some(&m) = SCALES.get(tok) {
            fold(&mut cur, &mut frac);
            if m == 100 {
                cur = if cur == 0.0 { 1.0 } else { cur } * 100.0;
            } else {
                total += if cur == 0.0 { 1.0 } else { cur } * m as f64;
                cur = 0.0;
            }
            prev = Some(Kind::Scale);
            continue;
        } else {
            v = *UNITS.get(tok).or(TENS.get(tok)).or(ORDINALS.get(tok)).unwrap_or(&0) as f64;
            kind = if TENS.contains_key(tok) { Kind::Tens } else { Kind::Unit };
        }
        if let Some(f) = frac.as_mut() {
            f.push_str(&(v as i64).to_string());
            continue;
        }
        // a new group when a number follows one it cannot combine with (19 | 86, 20 | 24, 3 | 30)
        if matches!(prev, Some(Kind::Unit | Kind::Tens | Kind::Digits))
            && !(prev == Some(Kind::Tens) && kind == Kind::Unit && v < 10.0)
        {
            groups.push(total + cur);
            total = 0.0;
            cur = 0.0;
        }
        cur += v;
        prev = Some(kind);
    }
    fold(&mut cur, &mut frac);
    groups.push(total + cur);
    if groups.len() == 1 {
        let v = groups[0];
        return if v.fract() != 0.0 {
            format!("{v:.6}").trim_end_matches('0').trim_end_matches('.').to_string()
        } else {
            format!("{}", v as i64)
        };
    }
    let mut out = format!("{}", groups[0] as i64);
    for g in &groups[1..] {
        out += &format!("{:02}", *g as i64);
    }
    out
}

/// Lower-case word tokens; runs of number words or digits become one "#digits" token.
pub fn toks(s: &str) -> Vec<String> {
    let s = s.to_lowercase().replace('\u{2019}', "'").replace('-', " ").replace(':', " ");
    let mut words: Vec<String> = vec![];
    for m in RAW.find_iter(&s) {
        let mut w = m.as_str().trim_matches(|c| c == '\'' || c == '.').to_string();
        if w.ends_with("'s") && !numeric(&w[..w.len() - 2]) {
            w.truncate(w.len() - 2);
        }
        if let Some(r) = SAME.get(w.as_str()) {
            w = r.to_string();
        }
        if !w.is_empty() && !numeric(&w) && w.ends_with('s') {
            // "eighteens" / whisper "18s", "nineties" / "90s", "hundreds"
            let mut stem = w[..w.len() - 1].to_string();
            if stem.ends_with("ie") && TENS.contains_key(format!("{}y", &stem[..stem.len() - 2]).as_str()) {
                stem = format!("{}y", &stem[..stem.len() - 2]);
            }
            let s = stem.as_str();
            if UNITS.contains_key(s) || TENS.contains_key(s) || SCALES.contains_key(s) || is_digits(s) {
                words.push(stem);
                words.push("s".into());
                continue;
            }
        }
        if !w.is_empty() {
            words.push(w);
        }
    }
    let mut out = vec![];
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        let nxt = words.get(i + 1).map(String::as_str).unwrap_or("");
        let starts = numeric(w) || (w == "a" && SCALES.contains_key(nxt));
        if !starts {
            out.push(w.clone());
            i += 1;
            continue;
        }
        let mut run: Vec<String> = vec![];
        while i < words.len() {
            let w = words[i].as_str();
            let nxt = words.get(i + 1).map(String::as_str).unwrap_or("");
            if numeric(w)
                || (w == "a" && SCALES.contains_key(nxt) && run.is_empty())
                || (w == "and" && !run.is_empty() && numeric(nxt))
                || (w == "point" && !run.is_empty() && (UNITS.contains_key(nxt) || is_digits(nxt)))
            {
                run.push(w.to_string());
                i += 1;
            } else {
                break;
            }
        }
        out.push(format!("#{}", compose(&run)));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Replace,
    Delete,
    Insert,
}

/// Stretches where the two token lists really differ (joined spellings like "light day" / "lightday" are not).
pub fn diff_ops(a: &[String], b: &[String]) -> Vec<(Op, usize, usize, usize, usize)> {
    capture_diff_slices(Algorithm::Myers, a, b)
        .into_iter()
        .filter_map(|op| match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete { old_index, old_len, new_index } => Some((Op::Delete, old_index, old_index + old_len, new_index, new_index)),
            DiffOp::Insert { old_index, new_index, new_len } => Some((Op::Insert, old_index, old_index, new_index, new_index + new_len)),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                Some((Op::Replace, old_index, old_index + old_len, new_index, new_index + new_len))
            }
        })
        .filter(|(_, i1, i2, j1, j2)| a[*i1..*i2].concat() != b[*j1..*j2].concat())
        .collect()
}

/// How alike two words are, 0-1 (difflib's ratio: twice the matching characters over the total).
fn ratio(x: &str, y: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (x.chars().collect(), y.chars().collect());
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let matched: usize = capture_diff_slices(Algorithm::Myers, &a, &b)
        .iter()
        .map(|op| if let DiffOp::Equal { len, .. } = op { *len } else { 0 })
        .sum();
    2.0 * matched as f64 / (a.len() + b.len()) as f64
}

/// {index in xs: index in ys}: an in-order pairing that maximises how alike the paired words are
/// (pairs below floor are not made).
pub fn pair_up(xs: &[String], ys: &[String], floor: f64) -> HashMap<usize, usize> {
    let (n, m) = (xs.len(), ys.len());
    let sim: Vec<Vec<f64>> = xs.iter().map(|x| ys.iter().map(|y| ratio(x, y)).collect()).collect();
    let mut best = vec![vec![0f64; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            let take = if sim[i][j] >= floor { sim[i][j] + best[i + 1][j + 1] } else { -1.0 };
            best[i][j] = take.max(best[i + 1][j]).max(best[i][j + 1]);
        }
    }
    let mut out = HashMap::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if sim[i][j] >= floor && (best[i][j] - (sim[i][j] + best[i + 1][j + 1])).abs() < 1e-12 {
            out.insert(i, j);
            i += 1;
            j += 1;
        } else if (best[i][j] - best[i + 1][j]).abs() < 1e-12 {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// For each word of the text: None if whisper heard it, else what it heard instead ("" = nothing);
/// plus the extra words whisper heard after each word.
pub fn heard_words(text: &str, heard: &str) -> (Vec<Option<String>>, Vec<String>) {
    let sw: Vec<&str> = text.split_whitespace().collect();
    // which word owns each token: numbers spelled over several words become one token ("nineteen fifty-nine")
    let mut owner: Vec<usize> = vec![];
    let mut n = 0;
    for k in 0..sw.len() {
        let m = toks(&sw[..=k].join(" ")).len();
        for _ in n..m.max(n) {
            owner.push(k);
        }
        n = n.max(m);
    }
    let (a, b) = (toks(text), toks(heard));
    let mut wrong: Vec<Option<String>> = vec![None; sw.len()];
    let mut extra: Vec<String> = vec![String::new(); sw.len()];
    let clean = |t: &str| t.replace('#', "");
    let push = |s: &mut String, t: &str| {
        if !s.is_empty() {
            s.push(' ');
        }
        s.push_str(t);
    };
    for (op, i1, i2, j1, j2) in diff_ops(&a, &b) {
        match op {
            Op::Insert => {
                let k = if i1 > 0 { owner[i1 - 1] } else { 0 };
                for t in &b[j1..j2] {
                    push(&mut extra[k], &clean(t));
                }
            }
            Op::Delete => {
                for i in i1..i2 {
                    wrong[owner[i]] = Some(String::new());
                }
            }
            Op::Replace => {
                // each word paired with the heard word most like it: "suite of about two hundred" heard as "suit"
                // gives "suite" -> "suit", and the rest were not heard
                let pairs = pair_up(&a[i1..i2], &b[j1..j2], 0.4);
                for i in i1..i2 {
                    let k = owner[i];
                    let heard_as = pairs.get(&(i - i1)).map(|j| clean(&b[j1 + j])).unwrap_or_default();
                    wrong[k] = Some(match &wrong[k] {
                        Some(w) if !w.is_empty() && !heard_as.is_empty() => format!("{w} {heard_as}"),
                        Some(w) if !w.is_empty() => w.clone(),
                        _ => heard_as,
                    });
                }
                let paired: HashSet<usize> = pairs.values().copied().collect();
                for j in 0..(j2 - j1) {
                    if paired.contains(&j) {
                        continue;
                    }
                    // heard but matching no word of the text: an extra after the word before it
                    let before = pairs.iter().filter(|(_, jj)| **jj < j).map(|(i, _)| *i).max();
                    let k = match before {
                        Some(i) => owner[i1 + i],
                        None if i1 > 0 => owner[i1 - 1],
                        None => owner[i1],
                    };
                    push(&mut extra[k], &clean(&b[j1 + j]));
                }
            }
        }
    }
    // words that own no token of their own share the verdict of the word before ("fifty-nine" of "nineteen fifty-nine")
    let owned: HashSet<usize> = owner.iter().copied().collect();
    for k in 1..sw.len() {
        if !owned.contains(&k) {
            wrong[k] = wrong[k - 1].clone();
        }
    }
    (wrong, extra)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WordTime {
    pub t: Option<[f64; 2]>,
    pub score: Option<f64>,
    /// how surely each character of the word was heard, None for characters that aren't letters (punctuation)
    pub letters: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WordResult {
    pub w: String,
    pub t: Option<[f64; 2]>,
    pub score: Option<f64>,
    #[serde(rename = "ref")]
    pub reference: Option<f64>,
    pub status: String,
    pub heard: Option<String>,
    pub extra: String,
    /// the score of each character of the word (takes from before 0.1.2 have none)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letters: Option<Vec<Option<f64>>>,
}

/// How far a word's sound score may fall below the reference's before it counts as "sounded off", and the plain
/// floor when there is no reference reading. Tuned for the wav2vec2 aligner (see the tests in align.rs).
pub const OFF_VS_REFERENCE: f64 = 0.2;
pub const OFF_BELOW: f64 = 0.75;
pub const OFF_FLOOR: f64 = 0.5;

/// Per-word verdicts: good, unclear (sounded off) or wrong (heard as another word, or not heard).
pub fn judge(text: &str, heard: &str, mine: &[WordTime], reference: Option<&[WordTime]>) -> Vec<WordResult> {
    let (wrong, extra) = heard_words(text, heard);
    text.split_whitespace()
        .enumerate()
        .map(|(k, w)| {
            let s = mine.get(k).and_then(|m| m.score);
            let r = reference.and_then(|r| r.get(k)).and_then(|m| m.score);
            let status = if wrong[k].is_some() {
                "wrong"
            } else {
                match (s, r) {
                    (Some(s), Some(r)) if s < OFF_BELOW && r - s > OFF_VS_REFERENCE => "unclear",
                    (Some(s), None) if s < OFF_FLOOR => "unclear",
                    _ => "good",
                }
            };
            WordResult {
                w: w.to_string(),
                t: mine.get(k).and_then(|m| m.t),
                score: s,
                reference: r,
                status: status.into(),
                heard: wrong[k].clone(),
                extra: extra[k].clone(),
                letters: mine.get(k).and_then(|m| m.letters.clone()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(text: &str, h: &str) -> Vec<(String, String)> {
        let (w, _) = heard_words(text, h);
        text.split_whitespace().zip(w).filter_map(|(t, w)| w.map(|w| (t.to_string(), w))).collect()
    }

    #[test]
    fn numbers_become_digits() {
        assert_eq!(toks("nineteen fifty-nine"), vec!["#1959"]);
        assert_eq!(toks("in 1959"), vec!["in", "#1959"]);
        assert_eq!(toks("the seventh and the eleventh"), vec!["the", "#7", "and", "the", "#11"]);
        assert_eq!(toks("up to seventy metres."), vec!["up", "to", "#70", "meters"]);
        assert_eq!(toks("about two hundred tests"), toks("about 200 tests"));
        assert_eq!(toks("one point three million"), vec!["#1300000"]);
        assert_eq!(toks("at three thirty"), toks("at 3:30"));
    }

    #[test]
    fn misheard_words_get_what_was_heard() {
        assert_eq!(
            heard("some GPS-guided tractors veered off course or", "some GPS guided tractors weird of course or"),
            vec![("veered".into(), "weird".into()), ("off".into(), "of".into())]
        );
        assert_eq!(heard("NASA's Ice Sat Two satellite lost altitude", "NASA's ice set to satellite lost attitude")
            .into_iter().find(|(w, _)| w == "altitude"), Some(("altitude".into(), "attitude".into())));
    }

    #[test]
    fn a_dropped_stretch_is_not_heard() {
        let got = heard(
            "I built a Playwright suite of about two hundred tests. On the backend side, I started",
            "I built a playwright suit. I started",
        );
        assert_eq!(got[0], ("suite".into(), "suit".into()));
        assert!(got[1..].iter().all(|(_, h)| h.is_empty()), "{got:?}");
        assert!(got.iter().any(|(w, _)| w == "hundred"));
    }

    #[test]
    fn same_words_said_differently_match() {
        assert!(heard("I'm a front-end engineer with ten years in Angular", "I'm a frontend engineer with 10 years in Angular").is_empty());
        assert!(heard("practise the colour", "practice the color").is_empty());
    }

    #[test]
    fn judge_marks_wrong_and_unclear() {
        let text = "the beautiful things";
        let mine = [
            WordTime { t: Some([0.0, 0.2]), score: Some(0.95), letters: None },
            WordTime { t: Some([0.2, 0.7]), score: Some(0.4), letters: None },
            WordTime { t: Some([0.7, 1.0]), score: Some(0.9), letters: None },
        ];
        let reference = vec![WordTime { t: None, score: Some(0.95), letters: None }; 3];
        let r = judge(text, "the beautiful sinks", &mine, Some(&reference));
        assert_eq!(r.iter().map(|w| w.status.as_str()).collect::<Vec<_>>(), vec!["good", "unclear", "wrong"]);
        assert_eq!(r[2].heard.as_deref(), Some("sinks"));
    }
}
