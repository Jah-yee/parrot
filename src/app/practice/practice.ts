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
  host: { '(document:keydown)': 'key($event)', '(window:resize)': 'fit()' },
})
export class Practice {
  protected store = inject(Store);
  readonly settings = output<void>();
  protected band = band;
  private stepper = viewChild<ElementRef<HTMLElement>>('stepper');
  private sentence = viewChild<ElementRef<HTMLElement>>('sentence');

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
    const words = this.result()?.words ?? [];
    return { wrong: words.filter((word) => word.status === 'wrong').length, unclear: words.filter((word) => word.status === 'unclear').length };
  });
  protected readonly delta = computed(() => {
    const result = this.result();
    const previousScore = this.store.previousScore();
    return result && previousScore != null ? result.score - previousScore : null;
  });
  protected readonly unit = computed(
    () => ({ whole: 'Text', sentences: 'Sentence', short: 'Part' })[this.store.text()?.mode ?? 'sentences'],
  );
  protected readonly size = computed(() => {
    const wordCount = this.store.words().length;
    return wordCount > 120 ? 'xl' : wordCount > 45 ? 'long' : '';
  });

  constructor() {
    // the sentence as large as the card allows: shrink the type until it fits (long texts still scroll at 18 px)
    effect(() => {
      this.store.words();
      this.size();
      this.result();
      queueMicrotask(() => this.fit());
    });
    // keep the current part in view in the stepper
    effect(() => {
      const partIndex = this.store.index();
      queueMicrotask(() =>
        this.stepper()?.nativeElement.children[partIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }),
      );
    });
  }

  protected fit() {
    const el = this.sentence()?.nativeElement;
    if (!el) return;
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollHeight > el.clientHeight + 1 && size > 18) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  protected status(wordIndex: number) {
    return this.result()?.words[wordIndex]?.status ?? '';
  }

  protected heard(wordIndex: number) {
    const word = this.result()?.words[wordIndex];
    return word?.status === 'wrong' ? (word.heard ? `heard “${word.heard}”` : 'not heard') : '';
  }

  protected wordClick(wordIndex: number) {
    this.store.selectWord(wordIndex);
    const word = this.result()?.words[wordIndex];
    if (word?.t && word.status !== 'good') this.store.compareWord(wordIndex);
    else this.store.sayWord(wordIndex);
  }

  protected pace(wpm: number) {
    return wpm < 120 ? 'slow · aim 140–165' : wpm < 140 ? 'a little slow · aim 140–165' : wpm > 175 ? 'fast · aim 140–165' : 'a natural pace';
  }

  protected key(event: KeyboardEvent) {
    const el = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const store = this.store;
    switch (event.key) {
      case ' ':
        store.toggleReference();
        break;
      case 'r':
      case 'R':
        store.toggleRecord();
        break;
      case 'm':
      case 'M':
        store.toggleMine();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        store.next();
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        store.previous();
        break;
      case 'Escape':
        store.stop();
        store.selectWord(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
