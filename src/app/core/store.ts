import { computed, inject, Injectable, signal } from '@angular/core';
import { Clips } from './clips';
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
  private clips = inject(Clips);
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
    const scores = this.scores();
    const done = parts.filter((part) => scores[part.key]);
    const avg = done.length
      ? Math.round(done.reduce((sum, part) => sum + scores[part.key].last, 0) / done.length)
      : null;
    return { total: parts.length, done: done.length, avg };
  });

  /** the score of the try before the one shown */
  readonly previousScore = computed(() => {
    const result = this.result();
    const history = this.history();
    const shownIndex = history.findIndex((attempt) => attempt.id === result?.id);
    return shownIndex >= 0 && shownIndex + 1 < history.length
      ? history[shownIndex + 1].score
      : null;
  });
  /** words of the shown try that came out wrong, for the reading tips */
  readonly troubleWords = computed(() =>
    (this.result()?.words ?? [])
      .filter((word) => word.status === 'wrong')
      .map((word) => bare(word.w)),
  );

  /** every play chain (mine, then the reference) checks this, so Stop really stops it */
  private run = 0;

  async loadTexts() {
    try {
      this.texts.set(await this.engine.texts());
      this.engineState.set('ready');
      this.error.set(null);
    } catch (error) {
      this.engineState.set('down');
      this.fail(error);
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
    const text = this.texts().find((item) => item.id === id);
    if (!text) return;
    this.stop();
    this.text.set(text);
    this.view.set('practice');
    writeSetting('text', id);
    this.engine.updateText(id, { opened: true }).catch(() => {});
    await this.build(
      text.mode,
      index != null ? String(index) : readSetting(`part:${id}:${text.mode}`, '0'),
    );
  }

  home() {
    this.stop();
    this.view.set('home');
    this.loadTexts();
    this.loadActivity();
  }

  async add(text: string, title: string, mode: Mode) {
    try {
      const added = await this.engine.addText(text, title, mode);
      this.texts.update((list) => [added, ...list.filter((item) => item.id !== added.id)]);
      await this.open(added.id);
    } catch (error) {
      this.fail(error);
    }
  }

  async rename(id: string, title: string) {
    const renamed = await this.engine.updateText(id, { title });
    this.texts.update((list) => list.map((item) => (item.id === id ? renamed : item)));
    if (this.text()?.id === id) this.text.set(renamed);
  }

  async remove(id: string) {
    await this.engine.deleteText(id);
    this.texts.update((list) => list.filter((item) => item.id !== id));
  }

  async setMode(mode: Mode) {
    const text = this.text();
    if (!text || text.mode === mode) return;
    const w0 = this.part()?.w0 ?? 0;
    this.stop();
    const saved = await this.engine.updateText(text.id, { mode });
    this.text.set(saved);
    this.texts.update((list) => list.map((item) => (item.id === text.id ? saved : item)));
    await this.build(mode, null, w0);
  }

  /** Split the open text and go to a part: the saved one, or the one holding word w0. */
  private async build(mode: Mode, savedIndex: string | null, w0?: number) {
    const text = this.text()!;
    const parts = await splitText(text.text, mode);
    this.parts.set(parts);
    this.scores.set(await this.engine.scores(text.id).catch(() => ({})));
    let partIndex =
      w0 != null ? parts.findLastIndex((part) => part.w0 <= w0) : Number(savedIndex ?? 0);
    if (!(partIndex >= 0 && partIndex < parts.length)) partIndex = 0;
    await this.select(partIndex);
  }

  async select(partIndex: number) {
    const text = this.text();
    const parts = this.parts();
    if (!text || partIndex < 0 || partIndex >= parts.length) return;
    this.stop();
    this.index.set(partIndex);
    this.result.set(null);
    this.history.set([]);
    this.selected.set(null);
    writeSetting(`part:${text.id}:${text.mode}`, String(partIndex));
    const part = parts[partIndex];
    if (!this.scores()[part.key]) return;
    const history = await this.engine.attempts(text.id, part.text);
    if (this.part() !== part || !history.length) return;
    this.history.set(history);
    this.show(await this.engine.attempt(text.id, part.text, history[0].id));
  }

  /** Show a try, and load its waveform. */
  private show(attempt: Attempt) {
    this.result.set(attempt);
    this.peaks.set(null);
    this.clips
      .peaks(this.engine.audioUrl(attempt.audio), this.bars)
      .then((peaks) => this.result() === attempt && this.peaks.set(peaks))
      .catch(() => {});
  }

  next() {
    this.select(this.index() + 1);
  }

  previous() {
    this.select(this.index() - 1);
  }

  async showAttempt(id: string) {
    const text = this.text();
    const part = this.part();
    if (!text || !part) return;
    this.stop();
    this.show(await this.engine.attempt(text.id, part.text, id));
  }

  setRate(rate: number) {
    this.rate.set(rate);
    writeSetting('rate', String(rate));
  }

  // ---- listening

  /** The reference reading of the part, with the word being spoken lit up. */
  playReference() {
    const part = this.part();
    if (!part) return Promise.resolve();
    const starts: number[] = [];
    let offset = 0;
    for (const word of part.text.split(' ')) {
      starts.push(offset);
      offset += word.length + 1;
    }
    return this.sound
      .speak(part.text, this.rate(), 'ref', (charIndex) =>
        this.nowRef.set(starts.findLastIndex((start) => start <= charIndex)),
      )
      .then(() => this.nowRef.set(null));
  }

  playMine() {
    const result = this.result();
    if (!result) return Promise.resolve();
    return this.sound
      .play(this.engine.audioUrl(result.audio), 'mine', (seconds) =>
        this.nowMine.set(
          result.words.findIndex(
            (word) => word.t && seconds >= word.t[0] - 0.02 && seconds <= word.t[1] + 0.06,
          ),
        ),
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (run === this.run) this.playReference();
  }

  stop() {
    this.run++;
    this.sound.stop();
    this.nowRef.set(null);
    this.nowMine.set(null);
  }

  // ---- words

  selectWord(wordIndex: number | null) {
    this.selected.set(wordIndex);
  }

  /** How the word should sound: spoken on its own by the reference voice. */
  sayWord(wordIndex: number, slow = false) {
    const word = this.words()[wordIndex];
    if (word) {
      this.run++;
      this.sound.speak(bare(word), slow ? 0.55 : 0.85, null);
    }
  }

  /** The word as you said it, cut out of your recording. */
  playMyWord(wordIndex: number) {
    const result = this.result();
    const word = result?.words[wordIndex];
    if (!result || !word?.t) return Promise.resolve();
    const before = result.words
      .slice(0, wordIndex)
      .reverse()
      .find((other) => other.t);
    const after = result.words.slice(wordIndex + 1).find((other) => other.t);
    const from = Math.max(before?.t ? before.t[1] : 0, word.t[0] - 0.03);
    const to = Math.min(after?.t ? after.t[0] : word.t[1] + 0.12, word.t[1] + 0.04);
    this.run++;
    this.nowMine.set(wordIndex);
    return this.clips
      .cut(this.engine.audioUrl(result.audio), from, to)
      .then((url) => this.sound.playClip(url).finally(() => URL.revokeObjectURL(url)))
      .then(() => this.nowMine.set(null));
  }

  async compareWord(wordIndex: number) {
    const run = ++this.run;
    await this.playMyWord(wordIndex);
    if (run !== this.run) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (run === this.run) this.sayWord(wordIndex);
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
    } catch (error) {
      this.error.set(
        `No microphone: ${(error as Error).message}. Allow Parrot to use the microphone.`,
      );
    }
  }

  private async finishRecording() {
    const text = this.text()!;
    const part = this.part()!;
    const blob = await this.recorder.stop();
    this.checking.set(true);
    try {
      const attempt = await this.engine.check(text.id, part.text, blob);
      this.scores.update((scores) => ({
        ...scores,
        [part.key]: {
          last: attempt.score,
          best: Math.max(attempt.score, scores[part.key]?.best ?? 0),
          tries: (scores[part.key]?.tries ?? 0) + 1,
        },
      }));
      this.loadTexts();
      if (this.part() !== part) return;
      this.history.set(await this.engine.attempts(text.id, part.text));
      this.show(attempt);
      const first = attempt.words.findIndex((word) => word.status !== 'good');
      this.selected.set(first >= 0 ? first : null);
      this.error.set(null);
    } catch (error) {
      this.fail(error);
    } finally {
      this.checking.set(false);
    }
  }

  private fail(error: unknown) {
    this.error.set(error instanceof EngineError ? error.message : String(error));
  }
}
