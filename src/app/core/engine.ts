import { Injectable } from '@angular/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Activity, Attempt, AttemptSummary, Mode, PartScore, SoundsLike, TextItem } from './models';

/** True inside the desktop app: the engine is built in. In a plain browser (development, screenshots) the
 * interface talks to the Python prototype engine over HTTP instead. */
export const IN_APP = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The Python prototype engine (engine/server.py), for working in a browser. */
export const DEV_ENGINE = 'http://127.0.0.1:8770';

export class EngineError extends Error {}

export interface EngineInfo {
  data: string;
  /** whether each speech model is downloaded */
  models: Record<'whisper' | 'aligner', boolean>;
  sizes: Record<'whisper' | 'aligner', number>;
}

export interface ModelProgress {
  model: 'whisper' | 'aligner';
  received: number;
  total: number;
}

@Injectable({ providedIn: 'root' })
export class Engine {
  private dataDir = '';

  private async http<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(DEV_ENGINE + path, init);
    } catch {
      throw new EngineError('The speech engine is not running. Start it with: python engine/server.py');
    }
    const body = await res.json();
    if (!res.ok || body?.error) throw new EngineError(body?.error ?? `engine error ${res.status}`);
    return body as T;
  }

  private async app<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new EngineError(typeof e === 'string' ? e : String(e));
    }
  }

  private post<T>(path: string, data: unknown): Promise<T> {
    return this.http<T>(path, { method: 'POST', body: JSON.stringify(data) });
  }

  /** Where the data is kept and whether the speech models are ready. */
  async info(): Promise<EngineInfo> {
    if (IN_APP) {
      const i = await this.app<EngineInfo>('info');
      this.dataDir = i.data;
      return i;
    }
    const h = await this.http<{ data: string; whisper: boolean }>('/api/health');
    this.dataDir = h.data;
    return { data: h.data, models: { whisper: h.whisper, aligner: true }, sizes: { whisper: 0, aligner: 0 } };
  }

  /** Download the missing speech models, reporting progress. */
  async downloadModels(onProgress: (p: ModelProgress) => void): Promise<void> {
    const stop = await listen<ModelProgress>('model-progress', (e) => onProgress(e.payload));
    try {
      await this.app('download_models');
    } finally {
      stop();
    }
  }

  texts() {
    return IN_APP ? this.app<TextItem[]>('texts') : this.http<TextItem[]>('/api/texts');
  }

  addText(text: string, title: string, mode: Mode) {
    return IN_APP ? this.app<TextItem>('add_text', { text, title, mode }) : this.post<TextItem>('/api/texts', { text, title, mode });
  }

  updateText(id: string, change: { title?: string; mode?: Mode; opened?: boolean }) {
    return IN_APP ? this.app<TextItem>('update_text', { id, ...change }) : this.post<TextItem>('/api/texts/update', { id, ...change });
  }

  deleteText(id: string) {
    return IN_APP ? this.app<void>('delete_text', { id }) : this.post<void>('/api/texts/delete', { id });
  }

  scores(textId: string) {
    return IN_APP
      ? this.app<Record<string, PartScore>>('scores', { text: textId })
      : this.http<Record<string, PartScore>>(`/api/scores?text=${textId}`);
  }

  attempts(textId: string, part: string) {
    return IN_APP
      ? this.app<AttemptSummary[]>('attempts', { text: textId, part })
      : this.http<AttemptSummary[]>(`/api/attempts?text=${textId}&part=${encodeURIComponent(part)}`);
  }

  attempt(textId: string, part: string, id: string) {
    return IN_APP
      ? this.app<Attempt>('attempt', { text: textId, part, id })
      : this.http<Attempt>(`/api/attempt?text=${textId}&part=${encodeURIComponent(part)}&id=${id}`);
  }

  /** Score a take (a WAV recording) of one part of a text. */
  async check(textId: string, part: string, audio: Blob) {
    if (IN_APP) {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      try {
        return await invoke<Attempt>('check', bytes, { headers: { 'x-text': textId, 'x-part': encodeURIComponent(part) } });
      } catch (e) {
        throw new EngineError(typeof e === 'string' ? e : String(e));
      }
    }
    return this.http<Attempt>(`/api/check?text=${textId}&part=${encodeURIComponent(part)}`, {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/wav' },
      body: audio,
    });
  }

  activity() {
    return IN_APP ? this.app<Activity>('activity') : this.http<Activity>('/api/activity');
  }

  soundsLike(word: string) {
    return IN_APP ? this.app<SoundsLike>('pron', { w: word }) : this.http<SoundsLike>(`/api/pron?w=${encodeURIComponent(word)}`);
  }

  /** URL of a saved recording (paths from the first engine start with /files/). */
  audioUrl(path: string) {
    const rel = path.replace(/^\/?files\//, '').replace(/^\//, '');
    return IN_APP ? convertFileSrc(`${this.dataDir}/${rel}`) : `${DEV_ENGINE}/files/${rel}`;
  }
}
