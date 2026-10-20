import { ChangeDetectionStrategy, Component, computed, inject, output, resource, signal } from '@angular/core';
import { Mode, Part, TextItem } from '../core/models';
import { readSetting } from '../core/settings';
import { sentences, shortRanges, splitText } from '../core/split';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';
import { Logo } from '../shared/logo';
import { band } from '../shared/score';

interface Card {
  t: TextItem;
  parts: Part[];
  cells: string[];
  next: Part | null;
  nextIndex: number;
}

@Component({
  selector: 'app-home',
  imports: [Icon, Logo],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected store = inject(Store);
  readonly settings = output<void>();
  protected band = band;
  protected Math = Math;

  protected query = signal('');
  protected draft = signal('');
  protected draftTitle = signal('');
  protected draftMode = signal<Mode>('sentences');
  protected renaming = signal<string | null>(null);
  protected confirming = signal<string | null>(null);

  protected readonly words = computed(() => this.draft().trim().split(/\s+/).filter(Boolean).length);
  /** how many parts each way of practising would give the draft */
  protected readonly counts = computed(() => {
    const text = this.draft().trim();
    const list = text ? sentences(text) : [];
    const short = list.reduce((n, s) => n + shortRanges(s.split(' ')).length, 0);
    return { whole: text ? 1 : 0, sentences: list.length, short };
  });
  protected readonly modes: { id: Mode; label: string; unit: (n: number) => string }[] = [
    { id: 'whole', label: 'Whole text', unit: () => 'in one go' },
    { id: 'sentences', label: 'Sentences', unit: (n) => `${n} sentence${n === 1 ? '' : 's'}` },
    { id: 'short', label: 'Short parts', unit: (n) => `${n} part${n === 1 ? '' : 's'}` },
  ];

  /** every text split the way it is practised, with a colour per part */
  private readonly cards = resource({
    params: () => this.store.texts(),
    loader: ({ params }) =>
      Promise.all(
        params.map(async (t): Promise<Card> => {
          const parts = await splitText(t.text, t.mode);
          const cells = parts.map((p) => band(t.scores[p.key]?.last) || 'none');
          const saved = Number(readSetting(`part:${t.id}:${t.mode}`, '0'));
          const order = [...parts.keys()].map((k) => (k + saved) % parts.length);
          const nextIndex = order.find((k) => !t.scores[parts[k].key]) ?? saved;
          return { t, parts, cells, next: parts[nextIndex] ?? null, nextIndex };
        }),
      ),
  });

  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.cards.value() ?? [];
    return list.filter((c) => !q || c.t.title.toLowerCase().includes(q) || c.t.text.toLowerCase().includes(q));
  });

  /** the text opened last */
  protected readonly resume = computed(() => {
    const list = this.cards.value() ?? [];
    const last = readSetting('text', '');
    const opened = [...list].filter((c) => c.t.opened).sort((a, b) => b.t.opened!.localeCompare(a.t.opened!));
    return list.find((c) => c.t.id === last) ?? opened[0] ?? null;
  });

  protected readonly week = computed(() => {
    const a = this.store.activity();
    const top = Math.max(1, ...(a?.days.map((d) => d.tries) ?? [1]));
    return (a?.days ?? []).map((d, i, all) => ({
      day: new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' }),
      tries: d.tries,
      h: 6 + Math.round((d.tries / top) * 64),
      tone: i === all.length - 1 && d.tries ? 'today' : d.tries ? 'some' : 'none',
    }));
  });

  protected readonly practisedParts = computed(() => this.store.texts().reduce((n, t) => n + t.practised, 0));

  protected ring(c: Card) {
    const total = c.parts.length || 1;
    const done = c.parts.filter((p) => c.t.scores[p.key]).length;
    const len = 2 * Math.PI * 27;
    return { done, total, dash: `${(len * done) / total} ${len}` };
  }

  protected start() {
    const text = this.draft().trim();
    if (!text) return;
    this.store.add(text, this.draftTitle(), this.draftMode());
    this.draft.set('');
    this.draftTitle.set('');
  }

  protected continue(c: Card) {
    this.store.open(c.t.id, c.nextIndex);
  }

  protected async rename(t: TextItem, title: string) {
    this.renaming.set(null);
    if (title.trim() && title.trim() !== t.title) await this.store.rename(t.id, title.trim());
  }

  protected async remove(t: TextItem) {
    this.confirming.set(null);
    await this.store.remove(t.id);
  }

  protected when(iso: string | null) {
    if (!iso) return '';
    const d = new Date(iso);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (new Date().toDateString() === d.toDateString()) return 'today';
    if (days < 2) return 'yesterday';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected modeName(m: Mode) {
    return { whole: 'whole text', sentences: 'sentences', short: 'short parts' }[m];
  }
}
