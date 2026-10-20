import { Injectable } from '@angular/core';
import { Activity, Attempt, AttemptSummary, Mode, PartScore, SoundsLike, TextItem } from './models';

/** The local speech engine (engine/server.py for now). */
export const ENGINE = 'http://127.0.0.1:8770';

export class EngineError extends Error {}

@Injectable({ providedIn: 'root' })
export class Engine {
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(ENGINE + path, init);
    } catch {
      throw new EngineError('The speech engine is not running. Start it with: python engine/server.py');
    }
    const body = await res.json();
    if (!res.ok || body?.error) throw new EngineError(body?.error ?? `engine error ${res.status}`);
    return body as T;
  }

  private post<T>(path: string, data: unknown): Promise<T> {
    return this.call<T>(path, { method: 'POST', body: JSON.stringify(data) });
  }

  health() {
    return this.call<{ ok: boolean; data: string; whisper: boolean }>('/api/health');
  }

  texts() {
    return this.call<TextItem[]>('/api/texts');
  }

  addText(text: string, title: string, mode: Mode) {
    return this.post<TextItem>('/api/texts', { text, title, mode });
  }

  updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    return this.post<TextItem>('/api/texts/update', { id, ...change });
  }

  deleteText(id: string) {
    return this.post<{ ok: boolean }>('/api/texts/delete', { id });
  }

  scores(textId: string) {
    return this.call<Record<string, PartScore>>(`/api/scores?text=${textId}`);
  }

  attempts(textId: string, part: string) {
    return this.call<AttemptSummary[]>(`/api/attempts?text=${textId}&part=${encodeURIComponent(part)}`);
  }

  attempt(textId: string, part: string, id: string) {
    return this.call<Attempt>(`/api/attempt?text=${textId}&part=${encodeURIComponent(part)}&id=${id}`);
  }

  check(textId: string, part: string, audio: Blob) {
    return this.call<Attempt>(`/api/check?text=${textId}&part=${encodeURIComponent(part)}`, {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
    });
  }

  activity() {
    return this.call<Activity>('/api/activity');
  }

  /** The loudness of a saved recording in n slices, 0-1, for the waveform. */
  peaks(path: string, n: number) {
    return this.call<number[]>(`/api/peaks?f=${encodeURIComponent(path)}&n=${n}`);
  }

  soundsLike(word: string) {
    return this.call<SoundsLike>(`/api/pron?w=${encodeURIComponent(word)}`);
  }

  /** URL of a saved recording. */
  audioUrl(path: string) {
    return ENGINE + path;
  }

  /** URL of a stretch of a recording cut exactly, optionally slowed down without lowering the pitch. */
  clipUrl(path: string, from: number, to: number, rate = 1) {
    return `${ENGINE}/clip?f=${encodeURIComponent(path)}&a=${from.toFixed(3)}&b=${to.toFixed(3)}&rate=${rate}`;
  }
}
