import { Injectable, signal } from '@angular/core';
import { wav } from './clips';

/** Collects the microphone's samples on the audio thread and posts them in blocks. */
const CAPTURE = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('parrot-capture', Capture);
`;

/**
 * The microphone: one take at a time, with its length and a level for the meter. A take is plain PCM made into a
 * WAV file, the same on every system (no browser codec to decode in the engine).
 */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly recording = signal(false);
  readonly elapsed = signal(0);
  /** 0-1, the loudest sample of the last few milliseconds */
  readonly level = signal(0);
  /** the level every 100 ms of the take so far, for the live waveform */
  readonly trace = signal<number[]>([]);
  /** the microphone's name, once the browser has told us */
  readonly device = signal('');

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private timer = 0;
  private blocks: Float32Array[] = [];

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([CAPTURE], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'parrot-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.blocks = [];
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.blocks.push(e.data);
    source.connect(this.node);

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    let peak100 = 0;
    let last = t0;
    this.trace.set([]);
    this.device.set(this.stream.getAudioTracks()[0]?.label ?? '');
    this.recording.set(true);
    this.timer = window.setInterval(() => {
      this.elapsed.set((performance.now() - t0) / 1000);
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const level = Math.min(1, peak / 100);
      this.level.set(level);
      peak100 = Math.max(peak100, level);
      if (performance.now() - last >= 100) {
        this.trace.update((t) => [...t, peak100]);
        peak100 = 0;
        last = performance.now();
      }
    }, 25);
  }

  /** Stop and return the take as a WAV file. */
  async stop(): Promise<Blob> {
    if (!this.ctx) return new Blob();
    clearInterval(this.timer);
    // let the last block arrive from the audio thread
    await new Promise((r) => setTimeout(r, 60));
    const rate = this.ctx.sampleRate;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
    this.ctx = null;
    this.node = null;
    this.recording.set(false);
    this.level.set(0);
    const total = this.blocks.reduce((n, b) => n + b.length, 0);
    const pcm = new Int16Array(total);
    let at = 0;
    for (const b of this.blocks) {
      for (let i = 0; i < b.length; i++) pcm[at + i] = Math.max(-1, Math.min(1, b[i])) * 32767;
      at += b.length;
    }
    this.blocks = [];
    return wav(pcm, rate);
  }
}
