import { computed, inject, Injectable, signal } from '@angular/core';
import { Engine, EngineError } from './engine';
import { Activity, Attempt, AttemptSummary, Mode, Part, PartScore, TextItem } from './models';
import { Recorder } from './recorder';
import { readSetting, writeSetting } from './settings';
import { Sound } from './sound';
import { bare, splitText } from './split';

/** The app's state: the library, the open text and its parts, and the part being practised. */
@Injectable({ providedIn: 'root' })
export class Store {
  private engine = inject(Engine);
  readonly sound = inject(Sound);
  readonly recorder = inject(Recorder);

  readonly view = signal<'home' | 'practice'>('home');
  readonly engineState = signal<'checking' | 'ready' | 'down'>('checking');
  readonly activity = signal<Activity | null>(null);
  readonly texts = signal<TextItem[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  readonly text = signal<TextItem | null>(null);
  readonly parts = signal<Part[]>([]);
  readonly index = signal(0);
  readonly scores = signal<Record<string, PartScore>>({});

  readonly result = signal<Attempt | null>(null);
  readonly history = signal<AttemptSummary[]>([]);
  readonly checking = signal(false);
  readonly selected = signal<number | null>(null);
  /** the word being spoken: in the reference line and in your own */
  readonly nowRef = signal<number | null>(null);
  readonly nowMine = signal<number | null>(null);
  readonly rate = signal(Number(readSetting('rate', '1')));
  /** the loudness of the shown try, for the waveform (null while loading) */
  readonly peaks = signal<number[] | null>(null);
  readonly bars = 92;

  readonly part = computed(() => this.parts()[this.index()] ?? null);
  readonly words = computed(() => this.part()?.text.split(' ') ?? []);
  readonly progress = computed(() => {
    const parts = this.parts();
    const s = this.scores();
    const done = parts.filter((p) => s[p.key]);
    const avg = done.length ? Math.round(done.reduce((a, p) => a + s[p.key].last, 0) / done.length) : null;
    return { total: parts.length, done: done.length, avg };
  });

  /** the score of the try before the one shown */
  readonly previousScore = computed(() => {
    const r = this.result();
    const h = this.history();
    const i = h.findIndex((x) => x.id === r?.id);
    return i >= 0 && i + 1 < h.length ? h[i + 1].score : null;
  });
  /** words of the shown try that came out wrong, for the reading tips */
  readonly troubleWords = computed(() =>
    (this.result()?.words ?? []).filter((w) => w.status === 'wrong').map((w) => bare(w.w)),
  );

  /** every play chain (mine, then the reference) checks this, so Stop really stops it */
  private run = 0;

  async loadTexts() {
    try {
      this.texts.set(await this.engine.texts());
      this.engineState.set('ready');
      this.error.set(null);
    } catch (e) {
      this.engineState.set('down');
      this.fail(e);
      // try again until the engine is up, so starting it is enough
      setTimeout(() => this.engineState() === 'down' && this.loadTexts().then(() => this.loadActivity()), 3000);
    } finally {
      this.loaded.set(true);
    }
  }

  async loadActivity() {
    this.activity.set(await this.engine.activity().catch(() => null));
  }

  /** Open a text at a part: the given one, else where it was left. */
  async open(id: string, index?: number) {
    const t = this.texts().find((x) => x.id === id);
    if (!t) return;
    this.stop();
    this.text.set(t);
    this.view.set('practice');
    writeSetting('text', id);
    this.engine.updateText(id, { opened: true }).catch(() => {});
    await this.build(t.mode, index != null ? String(index) : readSetting(`part:${id}:${t.mode}`, '0'));
  }

  home() {
    this.stop();
    this.view.set('home');
    this.loadTexts();
    this.loadActivity();
  }

  async add(text: string, title: string, mode: Mode) {
    try {
      const t = await this.engine.addText(text, title, mode);
      this.texts.update((list) => [t, ...list.filter((x) => x.id !== t.id)]);
      await this.open(t.id);
    } catch (e) {
      this.fail(e);
    }
  }

  async rename(id: string, title: string) {
    const t = await this.engine.updateText(id, { title });
    this.texts.update((list) => list.map((x) => (x.id === id ? t : x)));
    if (this.text()?.id === id) this.text.set(t);
  }

  async remove(id: string) {
    await this.engine.deleteText(id);
    this.texts.update((list) => list.filter((x) => x.id !== id));
  }

  async setMode(mode: Mode) {
    const t = this.text();
    if (!t || t.mode === mode) return;
    const w0 = this.part()?.w0 ?? 0;
    this.stop();
    const saved = await this.engine.updateText(t.id, { mode });
    this.text.set(saved);
    this.texts.update((list) => list.map((x) => (x.id === t.id ? saved : x)));
    await this.build(mode, null, w0);
  }

  /** Split the open text and go to a part: the saved one, or the one holding word w0. */
  private async build(mode: Mode, savedIndex: string | null, w0?: number) {
    const t = this.text()!;
    const parts = await splitText(t.text, mode);
    this.parts.set(parts);
    this.scores.set(await this.engine.scores(t.id).catch(() => ({})));
    let i = w0 != null ? parts.findLastIndex((p) => p.w0 <= w0) : Number(savedIndex ?? 0);
    if (!(i >= 0 && i < parts.length)) i = 0;
    await this.select(i);
  }

  async select(i: number) {
    const t = this.text();
    const parts = this.parts();
    if (!t || i < 0 || i >= parts.length) return;
    this.stop();
    this.index.set(i);
    this.result.set(null);
    this.history.set([]);
    this.selected.set(null);
    writeSetting(`part:${t.id}:${t.mode}`, String(i));
    const p = parts[i];
    if (!this.scores()[p.key]) return;
    const history = await this.engine.attempts(t.id, p.text);
    if (this.part() !== p || !history.length) return;
    this.history.set(history);
    this.show(await this.engine.attempt(t.id, p.text, history[0].id));
  }

  /** Show a try, and load its waveform. */
  private show(r: Attempt) {
    this.result.set(r);
    this.peaks.set(null);
    this.engine
      .peaks(r.audio, this.bars)
      .then((p) => this.result() === r && this.peaks.set(p))
      .catch(() => {});
  }

  next() {
    this.select(this.index() + 1);
  }

  previous() {
    this.select(this.index() - 1);
  }

  async showAttempt(id: string) {
    const t = this.text();
    const p = this.part();
    if (!t || !p) return;
    this.stop();
    this.show(await this.engine.attempt(t.id, p.text, id));
  }

  setRate(r: number) {
    this.rate.set(r);
    writeSetting('rate', String(r));
  }

  // ---- listening

  /** The reference reading of the part, with the word being spoken lit up. */
  playReference() {
    const p = this.part();
    if (!p) return Promise.resolve();
    const starts: number[] = [];
    let c = 0;
    for (const w of p.text.split(' ')) {
      starts.push(c);
      c += w.length + 1;
    }
    return this.sound
      .speak(p.text, this.rate(), 'ref', (ci) => this.nowRef.set(starts.findLastIndex((s) => s <= ci)))
      .then(() => this.nowRef.set(null));
  }

  playMine() {
    const r = this.result();
    if (!r) return Promise.resolve();
    return this.sound
      .play(this.engine.audioUrl(r.audio), 'mine', (t) =>
        this.nowMine.set(r.words.findIndex((w) => w.t && t >= w.t[0] - 0.02 && t <= w.t[1] + 0.06)),
      )
      .then(() => this.nowMine.set(null));
  }

  toggleReference() {
    if (this.sound.playing() === 'ref') return this.sound.togglePause();
    this.playReference();
  }

  toggleMine() {
    if (this.sound.playing() === 'mine') return this.sound.togglePause();
    this.playMine();
  }

  async compare() {
    const run = ++this.run;
    await this.playMine();
    if (run !== this.run) return;
    await new Promise((r) => setTimeout(r, 400));
    if (run === this.run) this.playReference();
  }

  stop() {
    this.run++;
    this.sound.stop();
    this.nowRef.set(null);
    this.nowMine.set(null);
  }

  // ---- words

  selectWord(k: number | null) {
    this.selected.set(k);
  }

  /** How the word should sound: spoken on its own by the reference voice. */
  sayWord(k: number, slow = false) {
    const w = this.words()[k];
    if (w) {
      this.run++;
      this.sound.speak(bare(w), slow ? 0.55 : 0.85, null);
    }
  }

  /** The word as you said it, cut out of your recording. */
  playMyWord(k: number) {
    const r = this.result();
    const w = r?.words[k];
    if (!r || !w?.t) return Promise.resolve();
    const before = r.words.slice(0, k).reverse().find((x) => x.t);
    const after = r.words.slice(k + 1).find((x) => x.t);
    const a = Math.max(before?.t ? before.t[1] : 0, w.t[0] - 0.03);
    const b = Math.min(after?.t ? after.t[0] : w.t[1] + 0.12, w.t[1] + 0.04);
    this.run++;
    this.nowMine.set(k);
    return this.sound.playClip(this.engine.clipUrl(r.audio, a, b)).then(() => this.nowMine.set(null));
  }

  async compareWord(k: number) {
    const run = ++this.run;
    await this.playMyWord(k);
    if (run !== this.run) return;
    await new Promise((r) => setTimeout(r, 350));
    if (run === this.run) this.sayWord(k);
  }

  soundsLike(word: string) {
    return this.engine.soundsLike(bare(word));
  }

  // ---- recording

  async toggleRecord() {
    if (this.recorder.recording()) return this.finishRecording();
    if (this.checking() || !this.part()) return;
    this.stop();
    try {
      await this.recorder.start();
      this.error.set(null);
    } catch (e) {
      this.error.set(`No microphone: ${(e as Error).message}. Allow Parrot to use the microphone.`);
    }
  }

  private async finishRecording() {
    const t = this.text()!;
    const p = this.part()!;
    const blob = await this.recorder.stop();
    this.checking.set(true);
    try {
      const r = await this.engine.check(t.id, p.text, blob);
      this.scores.update((s) => ({
        ...s,
        [p.key]: { last: r.score, best: Math.max(r.score, s[p.key]?.best ?? 0), tries: (s[p.key]?.tries ?? 0) + 1 },
      }));
      this.loadTexts();
      if (this.part() !== p) return;
      this.history.set(await this.engine.attempts(t.id, p.text));
      this.show(r);
      const first = r.words.findIndex((w) => w.status !== 'good');
      this.selected.set(first >= 0 ? first : null);
      this.error.set(null);
    } catch (e) {
      this.fail(e);
    } finally {
      this.checking.set(false);
    }
  }

  private fail(e: unknown) {
    this.error.set(e instanceof EngineError ? e.message : String(e));
  }
}
