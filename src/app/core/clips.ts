import { Injectable } from '@angular/core';

/**
 * Takes as audio the interface can cut: the loudness for the waveform, and a single word cut out exactly, slowed
 * down without lowering the pitch. Decoded takes are cached (a few at most are in use at a time).
 */
@Injectable({ providedIn: 'root' })
export class Clips {
  private ctx: AudioContext | null = null;
  private cache = new Map<string, Promise<AudioBuffer>>();

  private decode(url: string): Promise<AudioBuffer> {
    let p = this.cache.get(url);
    if (!p) {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b));
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** The loudest sample of each of n equal slices of a take, scaled so the loudest slice is 1. */
  async peaks(url: string, n: number): Promise<number[]> {
    const data = (await this.decode(url)).getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / n));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = i * size; k < Math.min(data.length, (i + 1) * size); k++) m = Math.max(m, Math.abs(data[k]));
      out.push(m);
    }
    const top = Math.max(...out) || 1;
    return out.map((v) => v / top);
  }

  /** A stretch of a take as a WAV file (an object URL): played with playbackRate below 1 and pitch preserved, it
   * slows down without the voice dropping, and it stops exactly where the word ends. */
  async cut(url: string, from: number, to: number): Promise<string> {
    const buf = await this.decode(url);
    const rate = buf.sampleRate;
    const a = Math.max(0, Math.floor(from * rate));
    const b = Math.min(buf.length, Math.ceil(to * rate));
    const src = buf.getChannelData(0).subarray(a, b);
    const fade = Math.min(Math.floor(rate * 0.012), Math.floor(src.length / 4));
    const pcm = new Int16Array(src.length + Math.floor(rate * 0.05)); // a little silence after, so the end isn't clipped
    for (let i = 0; i < src.length; i++) {
      const g = i < fade ? i / fade : i > src.length - fade ? (src.length - i) / fade : 1;
      pcm[i] = Math.max(-1, Math.min(1, src[i] * g)) * 32767;
    }
    return URL.createObjectURL(wav(pcm, rate));
  }
}

/** 16-bit mono PCM as a WAV file. */
export function wav(pcm: Int16Array, rate: number): Blob {
  const head = new DataView(new ArrayBuffer(44));
  const text = (o: number, s: string) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  head.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVEfmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  text(36, 'data');
  head.setUint32(40, pcm.byteLength, true);
  return new Blob([head, pcm.buffer as ArrayBuffer], { type: 'audio/wav' });
}
