# 🦜 Parrot

**Read a text aloud and see which words came out wrong.**

Parrot is a free, open-source desktop app for practising spoken English. Paste anything you need to say out loud (a job
interview introduction, a talk, a script), listen to it read correctly, record yourself, and Parrot shows you word by
word what came out wrong, how each word should sound, and lets you hear yours and the correct one side by side.
Everything runs on your computer: your voice is never uploaded.

> Status: early development. The interface is being built first; the speech engine is a Python prototype that will
> be replaced by a Rust one inside the app.

## How it works

- **Listen.** Your text is split into sentences or short parts, and each one is read to you at the speed you choose,
  with the word being spoken lit up.
- **Record.** Read the part aloud. Parrot checks it two ways:
  - **Speech recognition** ([Whisper](https://github.com/openai/whisper) through
    [whisper.cpp](https://github.com/ggerganov/whisper.cpp)) writes down what it heard, without knowing the text. A word
    it heard as something else, or not at all, turns **red**, with what it heard.
  - **Forced alignment** finds each word of the text in your recording and scores how well the sounds match it. A word
    that scores clearly low turns **amber**: the listener guessed it, but it didn't sound right.
- **Fix.** Click any word to see how it sounds (a respelling like *sik·STEEN* and its IPA, from the
  [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)), hear it alone or slowly, hear your own, or both
  one after the other. Every try is kept, so you can watch your score go up.

## Development

Requirements: Node 22+, Rust (for the desktop shell), and for the prototype engine Python 3.10+ with `torch` and
`torchaudio`, plus `ffmpeg` and `whisper-cli` (whisper.cpp) on your PATH.

```bash
npm install
python engine/server.py      # the speech engine on 127.0.0.1:8770 (downloads the Whisper model on first run)
npm start                    # the interface on http://localhost:4200
npx tauri dev                # or the desktop app
npm test                     # unit tests
```

Texts and recordings are stored in the app's data folder (macOS:
`~/Library/Application Support/io.github.qwertymuzaffar.parrot`).

## Roadmap

1. The interface (Angular) on the prototype engine. *Now.*
2. The engine in Rust inside the app: whisper.cpp through `whisper-rs`, an Apache-2.0 English wav2vec2 aligner
   through ONNX Runtime, so no Python is needed.
3. A natural offline reference voice (Kokoro) for every text, which also makes the sound scores more exact.
4. Installers for macOS, Windows and Linux, and the project site on GitHub Pages.

## Licence

MIT. Note that the prototype engine's aligner (Meta's MMS) is licensed CC-BY-NC; the Rust engine will use an
Apache-2.0 model instead.
