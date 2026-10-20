import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { WordResult } from '../core/models';

type Tone = 'idle' | 'plain' | 'wrong' | 'unclear' | 'now' | 'live';

/**
 * Your take as bars: the loudness of each slice of the recording, coloured where a word came out wrong
 * (red) or sounded off (amber), and lit while that word plays. While recording, the live level fills in.
 */
@Component({
  selector: 'app-waveform',
  template: `
    @for (b of shown(); track $index) {
      <span [class]="b.tone" [style.height.px]="b.h"></span>
    }
  `,
  styles: `
    :host {
      height: 56px;
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 0 2px;
    }
    span {
      flex: 1;
      min-width: 2px;
      border-radius: 3px;
      background: var(--bar);
      transition: height 0.12s;
    }
    .idle {
      background: var(--bar-light);
    }
    .wrong {
      background: var(--wrong-ink);
    }
    .unclear {
      background: var(--warn-line);
    }
    .now {
      background: var(--now);
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
    }
    .live {
      background: var(--accent);
    }
  `,
  host: { 'aria-hidden': 'true' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Waveform {
  readonly bars = input(92);
  readonly peaks = input<number[] | null>(null);
  readonly words = input<WordResult[]>([]);
  readonly duration = input(0);
  /** the word playing now, lit in the bars */
  readonly now = input<number | null>(null);
  /** while recording: the level every 100 ms so far */
  readonly live = input<number[] | null>(null);

  protected readonly shown = computed(() => {
    const n = this.bars();
    const live = this.live();
    const height = (v: number) => 6 + Math.round(v * 44);
    if (live) {
      const tail = live.slice(-n);
      return Array.from({ length: n }, (_, i) =>
        i < tail.length ? { h: height(tail[i]), tone: 'live' as Tone } : { h: 6, tone: 'idle' as Tone },
      );
    }
    const peaks = this.peaks();
    if (!peaks?.length) return Array.from({ length: n }, () => ({ h: 6, tone: 'idle' as Tone }));
    const d = this.duration() || 1;
    const words = this.words();
    const now = this.now();
    return peaks.map((v, i) => {
      const a = (i / peaks.length) * d;
      const b = ((i + 1) / peaks.length) * d;
      const k = words.findIndex((w) => w.t && w.t[0] < b && w.t[1] > a);
      const w = words[k];
      const tone: Tone = k >= 0 && k === now ? 'now' : w?.status === 'wrong' ? 'wrong' : w?.status === 'unclear' ? 'unclear' : 'plain';
      return { h: height(v), tone };
    });
  });
}
