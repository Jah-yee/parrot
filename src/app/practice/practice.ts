import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, output, viewChild } from '@angular/core';
import { Mode } from '../core/models';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';
import { ScoreRing } from './score-ring';
import { Sidebar } from './sidebar';
import { TriesChart } from './tries-chart';
import { Waveform } from './waveform';
import { WordCard } from './word-card';

@Component({
  selector: 'app-practice',
  imports: [Icon, ScoreRing, Sidebar, TriesChart, Waveform, WordCard],
  templateUrl: './practice.html',
  styleUrl: './practice.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'key($event)' },
})
export class Practice {
  protected store = inject(Store);
  readonly settings = output<void>();
  protected band = band;
  private stepper = viewChild<ElementRef<HTMLElement>>('stepper');

  protected readonly modes: { id: Mode; label: string }[] = [
    { id: 'whole', label: 'Whole text' },
    { id: 'sentences', label: 'Sentences' },
    { id: 'short', label: 'Short parts' },
  ];
  protected readonly rates = [0.6, 0.75, 1];

  protected readonly recording = this.store.recorder.recording;
  /** the try shown, unless a new one is being recorded */
  protected readonly result = computed(() => (this.recording() ? null : this.store.result()));
  protected readonly counts = computed(() => {
    const w = this.result()?.words ?? [];
    return { wrong: w.filter((x) => x.status === 'wrong').length, unclear: w.filter((x) => x.status === 'unclear').length };
  });
  protected readonly delta = computed(() => {
    const r = this.result();
    const p = this.store.previousScore();
    return r && p != null ? r.score - p : null;
  });
  protected readonly unit = computed(
    () => ({ whole: 'Text', sentences: 'Sentence', short: 'Part' })[this.store.text()?.mode ?? 'sentences'],
  );
  protected readonly size = computed(() => {
    const n = this.store.words().length;
    return n > 120 ? 'xl' : n > 45 ? 'long' : '';
  });

  constructor() {
    // keep the current part in view in the stepper
    effect(() => {
      const i = this.store.index();
      queueMicrotask(() =>
        this.stepper()?.nativeElement.children[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }),
      );
    });
  }

  protected status(k: number) {
    return this.result()?.words[k]?.status ?? '';
  }

  protected heard(k: number) {
    const w = this.result()?.words[k];
    return w?.status === 'wrong' ? (w.heard ? `heard “${w.heard}”` : 'not heard') : '';
  }

  protected wordClick(k: number) {
    this.store.selectWord(k);
    const w = this.result()?.words[k];
    if (w?.t && w.status !== 'good') this.store.compareWord(k);
    else this.store.sayWord(k);
  }

  protected pace(wpm: number) {
    return wpm < 120 ? 'slow · aim 140–165' : wpm < 140 ? 'a little slow · aim 140–165' : wpm > 175 ? 'fast · aim 140–165' : 'a natural pace';
  }

  protected key(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const s = this.store;
    switch (e.key) {
      case ' ':
        s.toggleReference();
        break;
      case 'r':
      case 'R':
        s.toggleRecord();
        break;
      case 'm':
      case 'M':
        s.toggleMine();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        s.next();
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        s.previous();
        break;
      case 'Escape':
        s.stop();
        s.selectWord(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
