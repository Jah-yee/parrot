import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { Mode, TextItem } from '../core/models';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';
import { band } from '../shared/score';

@Component({
  selector: 'app-library',
  imports: [Icon],
  templateUrl: './library.html',
  styleUrl: './library.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Library {
  protected store = inject(Store);
  readonly settings = output<void>();

  protected query = signal('');
  protected composing = signal(false);
  protected draft = signal('');
  protected draftTitle = signal('');
  protected draftMode = signal<Mode>('sentences');
  protected renaming = signal<string | null>(null);
  protected confirming = signal<string | null>(null);
  protected band = band;

  protected readonly modes: { id: Mode; label: string; hint: string }[] = [
    { id: 'whole', label: 'Whole text', hint: 'read it all in one go' },
    { id: 'sentences', label: 'Sentences', hint: 'one sentence at a time' },
    { id: 'short', label: 'Short parts', hint: 'long sentences cut at commas' },
  ];

  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.store.texts().filter((t) => !q || t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
  });

  protected readonly draftWords = computed(() => this.draft().trim().split(/\s+/).filter(Boolean).length);

  protected start() {
    const text = this.draft().trim();
    if (!text) return;
    this.store.add(text, this.draftTitle(), this.draftMode());
    this.composing.set(false);
    this.draft.set('');
    this.draftTitle.set('');
  }

  protected async rename(t: TextItem, title: string) {
    this.renaming.set(null);
    if (title.trim() && title.trim() !== t.title) await this.store.rename(t.id, title.trim());
  }

  protected async remove(t: TextItem) {
    this.confirming.set(null);
    await this.store.remove(t.id);
  }

  protected day(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected modeLabel(m: Mode) {
    return this.modes.find((x) => x.id === m)?.label.toLowerCase();
  }
}
