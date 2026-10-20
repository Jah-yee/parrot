import { Injectable, signal } from '@angular/core';

/** The microphone: one take at a time, with its length and a level for the meter. */
@Injectable({ providedIn: 'root' })
export class Recorder {
  readonly recording = signal(false);
  readonly elapsed = signal(0);
  /** 0-1, the loudest sample of the last few milliseconds */
  readonly level = signal(0);

  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer = 0;
  private chunks: Blob[] = [];
  private done: ((b: Blob) => void) | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const type = ['audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : {});
    this.chunks = [];
    this.rec.ondataavailable = (e) => this.chunks.push(e.data);
    this.rec.onstop = () => this.done?.(new Blob(this.chunks, { type: this.chunks[0]?.type || type || 'audio/webm' }));
    this.rec.start();

    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    this.recording.set(true);
    this.timer = window.setInterval(() => {
      this.elapsed.set((performance.now() - t0) / 1000);
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      this.level.set(Math.min(1, peak / 100));
    }, 50);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(new Blob());
      this.done = resolve;
      this.rec.stop();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close();
      clearInterval(this.timer);
      this.rec = null;
      this.recording.set(false);
      this.level.set(0);
    });
  }
}
