import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, output, viewChild } from '@angular/core';
import { Mode } from '../core/models';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';
import { ScoreRing } from './score-ring';
import { WordInspector } from './word-inspector';

@Component({
  selector: 'app-practice',
  imports: [Icon, ScoreRing, WordInspector],
  templateUrl: './practice.html',
  styleUrl: './practice.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'key($event)' },
})
export class Practice {
  protected store = inject(Store);
  readonly settings = output<void>();
  protected band = band;
  private list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly modes: { id: Mode; label: string }[] = [
    { id: 'whole', label: 'Whole text' },
    { id: 'sentences', label: 'Sentences' },
    { id: 'short', label: 'Short parts' },
  ];
  protected readonly rates = [0.6, 0.75, 0.9, 1];

  protected readonly result = this.store.result;
  protected readonly counts = computed(() => {
    const w = this.result()?.words ?? [];
    return { wrong: w.filter((x) => x.status === 'wrong').length, unclear: w.filter((x) => x.status === 'unclear').length };
  });
  protected readonly long = computed(() => this.store.words().length > 40);

  constructor() {
    // keep the current part visible in the list
    effect(() => {
      const i = this.store.index();
      queueMicrotask(() => this.list()?.nativeElement.children[i]?.scrollIntoView({ block: 'nearest' }));
    });
  }

  protected status(k: number) {
    return this.result()?.words[k]?.status ?? '';
  }

  protected wordClick(k: number) {
    this.store.selectWord(k);
    if (this.result()?.words[k]?.t && this.result()!.words[k].status !== 'good') this.store.compareWord(k);
    else this.store.sayWord(k);
  }

  protected time(id: string) {
    return `${id.slice(9, 11)}:${id.slice(11, 13)}`;
  }

  protected day(id: string) {
    const d = new Date(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8));
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? 'today'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected wpmNote(wpm: number) {
    return wpm < 120 ? 'a bit slow' : wpm > 175 ? 'a bit fast' : 'natural pace';
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
