"""The two listeners: whisper writes down what it heard, the forced aligner places each word of the text in the
recording and scores how well the sounds match it. Plus the audio clean-up and the check of one recording.
"""
import datetime
import json
import os
import subprocess
import tempfile
import threading

import paths
import text

WHISPER_MODEL = os.environ.get("PARROT_WHISPER_MODEL", os.path.join(paths.MODELS, "ggml-small.en.bin"))
WHISPER_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"

_lock = threading.Lock()
_mms = None


def ensure_whisper_model():
    if not os.path.exists(WHISPER_MODEL):
        os.makedirs(os.path.dirname(WHISPER_MODEL), exist_ok=True)
        subprocess.run(["curl", "-sSfL", "-o", WHISPER_MODEL + ".part", WHISPER_URL], check=True)
        os.rename(WHISPER_MODEL + ".part", WHISPER_MODEL)


def aligner():
    """The forced aligner, loaded on first use (torch takes a few seconds).
    Prototype only: the MMS weights are CC-BY-NC; the Rust engine will use an Apache-2.0 English wav2vec2."""
    global _mms
    if _mms is None:
        from torchaudio.pipelines import MMS_FA
        _mms = (MMS_FA.get_model(with_star=False), MMS_FA.get_tokenizer(), MMS_FA.get_aligner(),
                set(MMS_FA.get_labels()) - {"-", "*"})
    return _mms


def warm():
    with _lock:
        aligner()
    ensure_whisper_model()


def to_wav16(src, dst):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", dst], check=True)


def duration(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                capture_output=True, text=True).stdout or 0)


def peaks(path, n=92):
    """The loudest sample of each of n equal slices of a recording, scaled so the loudest slice is 1."""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    a = np.abs(np.frombuffer(raw, dtype=np.int16).astype(np.float32))
    if not len(a):
        return []
    slices = np.array_split(a, n)
    p = np.array([s.max() if len(s) else 0 for s in slices])
    top = p.max() or 1
    return [round(float(v / top), 3) for v in p]


def align(wav16, txt):
    """[{"t": [start, end] or None, "score": 0-1 or None}] for every whitespace-separated word of txt."""
    import torch
    import torchaudio
    with _lock:
        model, tok, al, labels = aligner()
        wave, sr = torchaudio.load(wav16)
        sw = txt.split()
        clean = ["".join(c for c in w.lower().replace("’", "'") if c in labels) for w in sw]
        idx = [k for k, c in enumerate(clean) if c]
        out = [{"t": None, "score": None} for _ in sw]
        if not idx:
            return out
        with torch.inference_mode():
            emission, _ = model(wave)
            try:
                spans = al(emission[0], tok([clean[k] for k in idx]))
            except RuntimeError:
                # the recording is too short for the text (stopped early): nothing can be placed, every word scores 0
                return [{"t": None, "score": 0.0} for _ in sw]
    ratio = wave.size(1) / emission.size(1) / sr
    for k, sp in zip(idx, spans):
        frames = sum(s.end - s.start for s in sp) or 1
        out[k] = {"t": [round(sp[0].start * ratio, 3), round(sp[-1].end * ratio, 3)],
                  "score": round(sum(s.score * (s.end - s.start) for s in sp) / frames, 3)}
    return out


def transcribe(wav16, words=None, limit=25.0):
    """What whisper hears. whisper.cpp reads 30-second windows and on a long take it can drop everything up to the
    next window, so a take longer than limit is cut into chunks at the pauses between words (word times from the
    aligner) and each chunk is heard on its own."""
    def hear(path):
        r = subprocess.run(["whisper-cli", "-m", WHISPER_MODEL, "-f", path, "-nt", "-np"], capture_output=True, text=True)
        return " ".join(r.stdout.split())
    ensure_whisper_model()
    times = [w["t"] for w in (words or []) if w["t"]]
    if not times or times[-1][1] <= limit:
        return hear(wav16)
    gaps = [(a[1], b[0]) for a, b in zip(times, times[1:])]
    cuts, start = [], 0.0
    while times[-1][1] - start > limit:
        # the widest pause in the last 40% of the window, so every chunk keeps some context
        window = [(b - a, (a + b) / 2) for a, b in gaps if start + limit * 0.6 < (a + b) / 2 < start + limit]
        cut = max(window)[1] if window else start + limit
        cuts.append(cut)
        start = cut
    out, edges = [], [0.0] + cuts + [None]
    with tempfile.TemporaryDirectory() as tmp:
        for k, (a, b) in enumerate(zip(edges, edges[1:])):
            part = os.path.join(tmp, f"{k}.wav")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav16, "-ss", f"{a:.3f}",
                            *(["-to", f"{b:.3f}"] if b else []), part], check=True)
            out.append(hear(part))
    return " ".join(out)


def check(folder, txt, body, ext, ref=None):
    """Save a recording (trimmed, rumble removed, levelled), score it against txt, keep the result next to it."""
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    mp3 = os.path.join(folder, stamp + ".mp3")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in." + ext)
        open(src, "wb").write(body)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-af",
                        "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.15,"
                        "areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.25,areverse,"
                        "highpass=f=80,loudnorm=I=-18:TP=-1.5", "-ar", "48000", "-ac", "1", "-b:a", "160k", mp3],
                       check=True)
        wav = os.path.join(tmp, "a.wav")
        to_wav16(mp3, wav)
        dur = duration(wav)
        if dur < 0.5:
            os.remove(mp3)
            return {"error": "Nothing was heard in the recording. Is the microphone on?"}
        mine = align(wav, txt)
        heard = transcribe(wav, mine)
        if all(m["t"] is None for m in mine):
            # stopped before the end: score the words up to the last one whisper heard, the rest count as missed
            wrong, _ = text.heard_words(txt, heard)
            last = max((k for k, w in enumerate(wrong) if w is None), default=-1)
            if last >= 0:
                mine[:last + 1] = align(wav, " ".join(txt.split()[:last + 1]))
    words = text.judge(txt, heard, mine, ref)
    good = sum(w["status"] == "good" for w in words)
    r = {"id": stamp, "when": datetime.datetime.now().isoformat(timespec="seconds"), "text": txt, "heard": heard,
         "words": words, "duration": round(dur, 2), "wpm": round(len(words) / dur * 60) if dur else 0,
         "score": round(100 * good / max(1, len(words))),
         "audio": "/files/" + os.path.relpath(mp3, paths.DATA)}
    json.dump(r, open(os.path.join(folder, stamp + ".json"), "w"), indent=1)
    return r
