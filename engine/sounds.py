"""How a word sounds, from the CMU Pronouncing Dictionary: a respelling with the stressed syllable marked
("an·SR" for answer, the way Google shows it) and its IPA.

CMUdict (BSD-style licence, about 135,000 words, American English) is downloaded into the models folder on first use.
"""
import os
import re
import subprocess

import paths

CMUDICT = os.path.join(paths.MODELS, "cmudict.dict")
CMUDICT_URL = "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict"
_cmu = None
VOWELS = {"AA": ("aa", "ɑ"), "AE": ("a", "æ"), "AH": ("uh", "ʌ"), "AO": ("aw", "ɔ"), "AW": ("ow", "aʊ"), "AY": ("ai", "aɪ"),
          "EH": ("eh", "ɛ"), "ER": ("ur", "ɝ"), "EY": ("ay", "eɪ"), "IH": ("i", "ɪ"), "IY": ("ee", "i"), "OW": ("oh", "oʊ"),
          "OY": ("oy", "ɔɪ"), "UH": ("u", "ʊ"), "UW": ("oo", "u")}
CONS = {"B": "b", "CH": ("ch", "tʃ"), "D": "d", "DH": ("dh", "ð"), "F": "f", "G": ("g", "ɡ"), "HH": "h", "JH": ("j", "dʒ"),
        "K": "k", "L": "l", "M": "m", "N": "n", "NG": ("ng", "ŋ"), "P": "p", "R": ("r", "ɹ"), "S": "s", "SH": ("sh", "ʃ"),
        "T": "t", "TH": ("th", "θ"), "V": "v", "W": "w", "Y": ("y", "j"), "Z": "z", "ZH": ("zh", "ʒ")}
ONSETS = {tuple(o.split()) for o in (
    "P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|T W|D W|K W|G W|TH W|"
    "S P R|S T R|S K R|S P L|S K W|P Y|B Y|K Y|F Y|M Y|V Y|HH Y|G Y|S K Y|S P Y").split("|")}


def cmu():
    """{word: [phones of the first pronunciation]}, downloaded once into the cache."""
    global _cmu
    if _cmu is None:
        if not os.path.exists(CMUDICT):
            os.makedirs(os.path.dirname(CMUDICT), exist_ok=True)
            subprocess.run(["curl", "-sSfL", "-o", CMUDICT, CMUDICT_URL], check=True)
        _cmu = {}
        for ln in open(CMUDICT, encoding="utf-8", errors="ignore"):
            parts = ln.split("#")[0].split()
            if parts and "(" not in parts[0]:
                _cmu[parts[0]] = parts[1:]
    return _cmu


def syllables(phones):
    """[(onset+nucleus+coda phones, stress)]: every vowel a syllable, consonants between two vowels given to the
    second as the longest legal English onset ("six-teen" S IH K | S T IY N)."""
    vi = [k for k, p in enumerate(phones) if p[-1].isdigit()]
    if not vi:
        return [(phones, None)]
    cuts = [0]
    for a, b in zip(vi, vi[1:]):
        mid = phones[a + 1:b]
        n = 0
        for m in range(len(mid), 0, -1):
            if m == 1 and mid[-1] != "NG" or tuple(mid[-m:]) in ONSETS:
                n = m
                break
        cuts.append(b - n)
    cuts.append(len(phones))
    return [(phones[c:d], int(phones[v][-1])) for c, d, v in zip(cuts, cuts[1:], vi)]


def sounds_like(word):
    """{"spell": [[syllable, stressed?], ...], "ipa": "/ˈæn.sɚ/"} or None for a word not in the dictionary."""
    d = cmu()
    parts = [p for p in re.split(r"[-–—/]", word.lower().replace("’", "'")) if p]
    spell, ipas = [], []
    for part in parts:
        ipa = []
        w = re.sub(r"[^a-z']", "", part).strip("'")
        ph = d.get(w)
        if ph is None:
            return None
        for syl, stress in syllables(ph):
            s, i = "", ""
            for k, p in enumerate(syl):
                base, digit = (p[:-1], p[-1]) if p[-1].isdigit() else (p, None)
                if digit is None:
                    c = CONS[base]
                    s, i = s + (c if isinstance(c, str) else c[0]), i + (c if isinstance(c, str) else c[1])
                    continue
                r, v = VOWELS[base]
                rest = syl[k + 1:]
                if digit == "0":
                    if base == "ER":
                        r, v = "r", "ɚ"
                    elif base == "AH":
                        # a weak "uh" before a final n or l after a consonant is the syllabic n/l ("shn", "tl")
                        r, v = ("", "ə") if rest in (["N"], ["L"]) and k > 0 else ("uh", "ə")
                    elif base == "IH":
                        v = "ɪ"
                s, i = s + r, i + v
            spell.append([s, stress == 1])
            ipa.append(("ˈ" if stress == 1 else "ˌ" if stress == 2 else "") + i)
        ipas.append(".".join(ipa).replace(".ˈ", "ˈ").replace(".ˌ", "ˌ"))
    return {"spell": spell, "ipa": "/" + " ".join(ipas) + "/"}
