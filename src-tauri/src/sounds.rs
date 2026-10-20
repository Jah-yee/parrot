//! How a word sounds, from the CMU Pronouncing Dictionary (built into the app, BSD-style licence, about 135,000
//! words of American English): a respelling with the stressed syllable marked ("an·SR" for answer, the way Google
//! shows it) and its IPA.

use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::LazyLock;

static DICT: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let mut raw = String::new();
    GzDecoder::new(&include_bytes!("../assets/cmudict.dict.gz")[..]).read_to_string(&mut raw).expect("cmudict");
    let mut out = HashMap::new();
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("");
        let mut parts = line.split_whitespace();
        if let Some(word) = parts.next() {
            if !word.contains('(') {
                out.insert(word.to_string(), parts.map(String::from).collect());
            }
        }
    }
    out
});

/// respelling and IPA of each vowel
fn vowel(p: &str) -> Option<(&'static str, &'static str)> {
    Some(match p {
        "AA" => ("aa", "ɑ"), "AE" => ("a", "æ"), "AH" => ("uh", "ʌ"), "AO" => ("aw", "ɔ"), "AW" => ("ow", "aʊ"),
        "AY" => ("ai", "aɪ"), "EH" => ("eh", "ɛ"), "ER" => ("ur", "ɝ"), "EY" => ("ay", "eɪ"), "IH" => ("i", "ɪ"),
        "IY" => ("ee", "i"), "OW" => ("oh", "oʊ"), "OY" => ("oy", "ɔɪ"), "UH" => ("u", "ʊ"), "UW" => ("oo", "u"),
        _ => return None,
    })
}

/// respelling and IPA of each consonant
fn consonant(p: &str) -> (&'static str, &'static str) {
    match p {
        "B" => ("b", "b"), "CH" => ("ch", "tʃ"), "D" => ("d", "d"), "DH" => ("dh", "ð"), "F" => ("f", "f"),
        "G" => ("g", "ɡ"), "HH" => ("h", "h"), "JH" => ("j", "dʒ"), "K" => ("k", "k"), "L" => ("l", "l"),
        "M" => ("m", "m"), "N" => ("n", "n"), "NG" => ("ng", "ŋ"), "P" => ("p", "p"), "R" => ("r", "ɹ"),
        "S" => ("s", "s"), "SH" => ("sh", "ʃ"), "T" => ("t", "t"), "TH" => ("th", "θ"), "V" => ("v", "v"),
        "W" => ("w", "w"), "Y" => ("y", "j"), "Z" => ("z", "z"), "ZH" => ("zh", "ʒ"),
        _ => ("", ""),
    }
}

/// consonant clusters that can start an English syllable
static ONSETS: LazyLock<HashSet<Vec<&'static str>>> = LazyLock::new(|| {
    "P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|T W|D W|K W|G W|TH W|\
     S P R|S T R|S K R|S P L|S K W|P Y|B Y|K Y|F Y|M Y|V Y|HH Y|G Y|S K Y|S P Y"
        .split('|')
        .map(|o| o.split(' ').collect())
        .collect()
});

/// Every vowel a syllable; the consonants between two vowels go to the second as the longest legal onset
/// ("six-teen": S IH K | S T IY N).
fn syllables(phones: &[String]) -> Vec<(&[String], Option<u8>)> {
    let vi: Vec<usize> = (0..phones.len()).filter(|&k| phones[k].ends_with(|c: char| c.is_ascii_digit())).collect();
    if vi.is_empty() {
        return vec![(phones, None)];
    }
    let mut cuts = vec![0];
    for w in vi.windows(2) {
        let mid: Vec<&str> = phones[w[0] + 1..w[1]].iter().map(String::as_str).collect();
        let mut n = 0;
        for m in (1..=mid.len()).rev() {
            let tail = mid[mid.len() - m..].to_vec();
            if (m == 1 && mid[mid.len() - 1] != "NG") || ONSETS.contains(&tail) {
                n = m;
                break;
            }
        }
        cuts.push(w[1] - n);
    }
    cuts.push(phones.len());
    cuts.windows(2)
        .zip(&vi)
        .map(|(c, &v)| (&phones[c[0]..c[1]], phones[v].chars().last().and_then(|c| c.to_digit(10)).map(|d| d as u8)))
        .collect()
}

#[derive(Serialize)]
pub struct SoundsLike {
    /// the syllables, each with whether it carries the main stress
    pub spell: Vec<(String, bool)>,
    pub ipa: String,
}

pub fn sounds_like(word: &str) -> Option<SoundsLike> {
    let lower = word.to_lowercase().replace('\u{2019}', "'");
    let mut spell = vec![];
    let mut ipas = vec![];
    for part in lower.split(['-', '–', '—', '/']).filter(|p| !p.is_empty()) {
        let w: String = part.chars().filter(|c| c.is_ascii_lowercase() || *c == '\'').collect();
        let phones = DICT.get(w.trim_matches('\''))?;
        let mut ipa = vec![];
        for (syl, stress) in syllables(phones) {
            let (mut s, mut i) = (String::new(), String::new());
            for (k, p) in syl.iter().enumerate() {
                let digit = p.chars().last().filter(|c| c.is_ascii_digit());
                let base = if digit.is_some() { &p[..p.len() - 1] } else { p.as_str() };
                match (digit, vowel(base)) {
                    (Some(d), Some((mut r, mut v))) => {
                        if d == '0' {
                            let rest: Vec<&str> = syl[k + 1..].iter().map(String::as_str).collect();
                            match base {
                                "ER" => (r, v) = ("r", "ɚ"),
                                // a weak "uh" before a final n or l after a consonant is the syllabic n/l ("shn", "tl")
                                "AH" if k > 0 && (rest == ["N"] || rest == ["L"]) => (r, v) = ("", "ə"),
                                "AH" => (r, v) = ("uh", "ə"),
                                _ => {}
                            }
                        }
                        s.push_str(r);
                        i.push_str(v);
                    }
                    _ => {
                        let (r, v) = consonant(base);
                        s.push_str(r);
                        i.push_str(v);
                    }
                }
            }
            spell.push((s, stress == Some(1)));
            ipa.push(match stress {
                Some(1) => format!("ˈ{i}"),
                Some(2) => format!("ˌ{i}"),
                _ => i,
            });
        }
        ipas.push(ipa.join(".").replace(".ˈ", "ˈ").replace(".ˌ", "ˌ"));
    }
    Some(SoundsLike { spell, ipa: format!("/{}/", ipas.join(" ")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spelled(w: &str) -> String {
        sounds_like(w).unwrap().spell.iter().map(|(s, b)| if *b { s.to_uppercase() } else { s.clone() }).collect::<Vec<_>>().join("·")
    }

    #[test]
    fn respellings_match_the_python_engine() {
        assert_eq!(spelled("answer"), "AN·sr");
        assert_eq!(spelled("sixteen"), "sik·STEEN");
        assert_eq!(spelled("eleventh"), "i·LEH·vuhnth");
        assert_eq!(spelled("station"), "STAY·shn");
        assert_eq!(spelled("things"), "THINGZ");
        assert_eq!(sounds_like("answer").unwrap().ipa, "/ˈæn.sɚ/");
        assert_eq!(spelled("GPS-guided"), "GEE·pee·EHS·GAI·duhd");
    }

    #[test]
    fn unknown_words_have_no_respelling() {
        assert!(sounds_like("Cougaar").is_none());
    }
}
