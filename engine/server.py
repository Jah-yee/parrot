#!/usr/bin/env python3
"""Parrot's speech engine, as a local HTTP server for the app (a prototype: the Rust engine replaces it).

    python engine/server.py [--port 8770]

Needs ffmpeg and whisper-cli (whisper.cpp) on PATH, and torch + torchaudio for the aligner. The whisper model
(small.en) and the pronunciation dictionary are downloaded into the models folder on first use.

Texts live in <data>/texts/<id>/ (text.txt, meta.json); every part of a text that has been recorded gets a folder
named after its words (p-<sha1>), holding each try as <time>.mp3 + <time>.json.
"""
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths    # noqa: E402
import sounds   # noqa: E402
import speech   # noqa: E402

PORT = 8770
ID = re.compile(r"[0-9a-f]{10}")


def norm(s):
    return " ".join(s.split())


def sha(s):
    return hashlib.sha1(norm(s).encode()).hexdigest()[:10]


def text_dir(tid):
    if not ID.fullmatch(tid or ""):
        raise ValueError("bad text id")
    d = os.path.join(paths.TEXTS, tid)
    if not os.path.exists(os.path.join(d, "text.txt")):
        raise FileNotFoundError(tid)
    return d


def text_info(d):
    meta = json.load(open(os.path.join(d, "meta.json"))) if os.path.exists(os.path.join(d, "meta.json")) else {}
    body = open(os.path.join(d, "text.txt")).read()
    created = meta.get("created") or datetime.datetime.fromtimestamp(
        os.path.getmtime(os.path.join(d, "text.txt"))).isoformat(timespec="seconds")
    per_part = scores(os.path.basename(d))
    last = [v["last"] for v in per_part.values()]
    return {"id": os.path.basename(d), "title": meta.get("title") or " ".join(body.split()[:6]) + "…", "text": body,
            "words": len(body.split()), "created": created, "mode": meta.get("mode", "sentences"),
            "opened": meta.get("opened"), "practised": len(last), "scores": per_part,
            "average": round(sum(last) / len(last)) if last else None}


def texts():
    out = [text_info(os.path.dirname(t)) for t in glob.glob(os.path.join(paths.TEXTS, "*", "text.txt"))]
    return sorted(out, key=lambda c: c["opened"] or c["created"], reverse=True)


def save_meta(d, **kw):
    path = os.path.join(d, "meta.json")
    meta = json.load(open(path)) if os.path.exists(path) else {}
    meta.update({k: v for k, v in kw.items() if v is not None})
    json.dump(meta, open(path, "w"), indent=1)


def part_dir(tid, part):
    """The folder of one part of a text, checked to really be in the text."""
    d = text_dir(tid)
    if not part or norm(part) not in norm(open(os.path.join(d, "text.txt")).read()):
        raise ValueError("that part is not in the text; reload")
    return os.path.join(d, "p-" + sha(part))


def scores(tid):
    """{part key: {"last": score, "best": score, "tries": n}} for every recorded part of a text."""
    out = {}
    for d in glob.glob(os.path.join(text_dir(tid), "p-*", "")):
        rs = [json.load(open(j)) for j in sorted(glob.glob(os.path.join(d, "*.json")))]
        if rs:
            out[os.path.basename(os.path.dirname(d))] = {"last": rs[-1]["score"], "best": max(r["score"] for r in rs),
                                                         "tries": len(rs)}
    return out


def activity(days=7):
    """Tries per day for the last days (today last), and the average score of those tries."""
    today = datetime.date.today()
    counts = {today - datetime.timedelta(days=k): 0 for k in range(days)}
    total, n = 0, 0
    for js in glob.glob(os.path.join(paths.TEXTS, "*", "p-*", "*.json")):
        stem = os.path.basename(js)[:8]
        try:
            day = datetime.date(int(stem[:4]), int(stem[4:6]), int(stem[6:8]))
        except ValueError:
            continue
        if day in counts:
            counts[day] += 1
            total += json.load(open(js))["score"]
            n += 1
    return {"days": [{"date": d.isoformat(), "tries": counts[d]} for d in sorted(counts)],
            "tries": n, "average": round(total / n) if n else None}


def attempts(folder):
    out = []
    for js in sorted(glob.glob(os.path.join(folder, "*.json")), reverse=True):
        r = json.load(open(js))
        out.append({k: r[k] for k in ("id", "when", "score", "wpm", "duration")})
    return out


def media(rel):
    """A recording under the data folder, or None."""
    p = os.path.realpath(os.path.join(paths.DATA, urllib.parse.unquote(rel)))
    ok = p.endswith(".mp3") and p.startswith(os.path.realpath(paths.TEXTS) + os.sep) and os.path.exists(p)
    return p if ok else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if self.command == "POST":
            sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    def send(self, code, body, ctype="application/json", extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # the app's webview (tauri://localhost, or the Angular dev server) is another origin
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def file(self, path):
        """With Range, so the player can seek."""
        data = open(path, "rb").read()
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m:
            a = int(m.group(1) or 0)
            b = int(m.group(2)) if m.group(2) else len(data) - 1
            return self.send(206, data[a:b + 1], "audio/mpeg",
                             {"Content-Range": f"bytes {a}-{b}/{len(data)}", "Accept-Ranges": "bytes"})
        self.send(200, data, "audio/mpeg", {"Accept-Ranges": "bytes"})

    def route(self, method):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        p = u.path
        if method == "GET":
            if p == "/api/health":
                return {"ok": True, "data": paths.DATA, "whisper": os.path.exists(speech.WHISPER_MODEL)}
            if p == "/api/texts":
                return texts()
            if p == "/api/scores":
                return scores(q["text"])
            if p == "/api/attempts":
                return attempts(part_dir(q["text"], q["part"]))
            if p == "/api/attempt":
                return json.load(open(os.path.join(part_dir(q["text"], q["part"]), os.path.basename(q["id"]) + ".json")))
            if p == "/api/activity":
                return activity()
            if p == "/api/peaks":
                # the loudness of a recording in n slices, 0-1, for the waveform
                f = media(q["f"].removeprefix("/files/"))
                if not f:
                    return self.send(404, {"error": "not found"})
                return speech.peaks(f, int(q.get("n", 92)))
            if p == "/api/pron":
                return sounds.sounds_like(q["w"]) or {}
            if p.startswith("/files/"):
                f = media(p[7:])
                return self.file(f) if f else self.send(404, {"error": "not found"})
            if p == "/clip":
                # one word cut exactly (a playing file can't be stopped on time from the page), slowed with atempo
                f = media(q["f"].removeprefix("/files/"))
                if not f:
                    return self.send(404, {"error": "not found"})
                a, b, rate = float(q["a"]), float(q["b"]), max(0.5, min(1.0, float(q.get("rate", 1))))
                fade = min(0.015, (b - a) / 4)
                wav = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", f,
                                      "-af", f"afade=t=in:d={fade:.3f},areverse,afade=t=in:d={fade:.3f},areverse,"
                                      f"atempo={rate},apad=pad_dur=0.05", "-ac", "1", "-f", "wav", "-"],
                                     capture_output=True).stdout
                return self.send(200, wav, "audio/wav")
        else:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if p == "/api/texts":
                d = json.loads(body)
                body_text = norm(d["text"])
                if not body_text:
                    raise ValueError("the text is empty")
                td = os.path.join(paths.TEXTS, sha(body_text))
                os.makedirs(td, exist_ok=True)
                open(os.path.join(td, "text.txt"), "w").write(body_text)
                created = None if os.path.exists(os.path.join(td, "meta.json")) else \
                    datetime.datetime.now().isoformat(timespec="seconds")
                save_meta(td, title=(d.get("title") or "").strip() or None, mode=d.get("mode"), created=created)
                return text_info(td)
            if p == "/api/texts/update":
                d = json.loads(body)
                td = text_dir(d["id"])
                save_meta(td, title=(d.get("title") or "").strip() or None, mode=d.get("mode"),
                          opened=datetime.datetime.now().isoformat(timespec="seconds") if d.get("opened") else None)
                return text_info(td)
            if p == "/api/texts/delete":
                # moved to the trash folder, not deleted
                td = text_dir(json.loads(body)["id"])
                os.makedirs(paths.TRASH, exist_ok=True)
                os.rename(td, os.path.join(paths.TRASH, os.path.basename(td) + "-" +
                                           datetime.datetime.now().strftime("%Y%m%d-%H%M%S")))
                return {"ok": True}
            if p == "/api/check":
                folder = part_dir(q["text"], q["part"])
                ext = "mp4" if "mp4" in self.headers.get("Content-Type", "") else "webm"
                return speech.check(folder, norm(q["part"]), body, ext)
        return self.send(404, {"error": "not found"})

    def handle_method(self, method):
        try:
            r = self.route(method)
            if r is not None:
                self.send(200, r)
        except (KeyError, FileNotFoundError) as e:
            self.send(404, {"error": f"not found: {e}"})
        except ValueError as e:
            self.send(400, {"error": str(e)})
        except subprocess.CalledProcessError as e:
            self.send(500, {"error": f"could not read the recording ({e})"})
        except Exception as e:      # a message in the app, not a dropped connection
            self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT
    os.makedirs(paths.TEXTS, exist_ok=True)
    threading.Thread(target=speech.warm, daemon=True).start()
    print(f"Parrot engine on http://127.0.0.1:{port} (data in {paths.DATA}); Ctrl-C to stop")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
