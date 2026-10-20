import { Injectable, signal } from '@angular/core';
import { readSetting, writeSetting } from './settings';

export type Track = 'ref' | 'mine';

/**
 * Everything that makes a sound: the reference voice (the system's English voices, through the Web Speech API),
 * saved recordings with a time callback for the word highlight, and single-word clips.
 * One thing plays at a time: starting anything stops the rest.
 */
@Injectable({ providedIn: 'root' })
export class Sound {
  readonly voices = signal<SpeechSynthesisVoice[]>([]);
  readonly voiceName = signal<string>(readSetting('voice', ''));
  /** which sentence-length track is playing, if any (single words don't count) */
  readonly playing = signal<Track | null>(null);
  readonly paused = signal(false);

  private player = new window.Audio();
  private clip = new window.Audio();
  private frame = 0;
  private onTime: ((t: number) => void) | null = null;
  private onEnd: (() => void) | null = null;
  private synthMode = false;
  private utterance: SpeechSynthesisUtterance | null = null;

  constructor() {
    const load = () => {
      const pref = ['Samantha', 'Ava', 'Allison', 'Alex', 'Daniel', 'Google US English'];
      const rank = (v: SpeechSynthesisVoice) => {
        const i = pref.findIndex((p) => v.name.includes(p));
        return (i < 0 ? 50 : i) + (v.localService ? 0 : 100);
      };
      const list = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      this.voices.set(list.sort((a, b) => rank(a) - rank(b)));
      if (!list.some((v) => v.name === this.voiceName()) && list.length) this.voiceName.set(list[0].name);
    };
    speechSynthesis.onvoiceschanged = load;
    load();
    this.player.onended = () => this.ended();
  }

  setVoice(name: string) {
    this.voiceName.set(name);
    writeSetting('voice', name);
  }

  /** The reference reading of a text by the system voice; onWord gets the character index of each word. */
  speak(text: string, rate = 1, track: Track | null = 'ref', onWord?: (charIndex: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voices().find((v) => v.name === this.voiceName()) ?? null;
      u.lang = 'en-US';
      u.rate = rate;
      if (onWord) u.onboundary = (e) => e.name === 'word' && onWord(e.charIndex);
      u.onend = u.onerror = () => {
        // cancel() ends the previous utterance a moment later: only the current one may reset the state
        if (this.utterance === u) this.reset();
        resolve();
      };
      this.utterance = u;
      this.synthMode = true;
      this.playing.set(track);
      speechSynthesis.speak(u);
    });
  }

  /** A whole recording (or a clip URL) with a time callback for the highlight. */
  play(url: string, track: Track, onTime?: (t: number) => void): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.player.src = url;
      this.onTime = onTime ?? null;
      this.onEnd = resolve;
      this.playing.set(track);
      this.player.play().then(() => this.tick()).catch(() => this.ended());
    });
  }

  /** A single word, cut by the engine. */
  playClip(url: string): Promise<void> {
    this.stop();
    return new Promise((resolve) => {
      this.clip.src = url;
      this.clip.onended = () => resolve();
      this.clip.play().catch(() => resolve());
    });
  }

  togglePause() {
    if (!this.playing()) return;
    if (this.synthMode) {
      speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause();
      this.paused.set(speechSynthesis.paused);
    } else if (this.player.paused) {
      this.player.play().then(() => this.tick());
      this.paused.set(false);
    } else {
      this.player.pause();
      this.paused.set(true);
    }
  }

  stop() {
    speechSynthesis.cancel();
    this.player.pause();
    this.clip.pause();
    const end = this.onEnd;
    this.reset();
    end?.();
  }

  private tick() {
    cancelAnimationFrame(this.frame);
    const step = () => {
      this.onTime?.(this.player.currentTime);
      if (!this.player.paused) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private ended() {
    const end = this.onEnd;
    this.reset();
    end?.();
  }

  private reset() {
    cancelAnimationFrame(this.frame);
    this.onTime = this.onEnd = null;
    this.synthMode = false;
    this.utterance = null;
    this.playing.set(null);
    this.paused.set(false);
  }
}
