import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { soundUnits } from '../core/sounds';
import { bare } from '../core/split';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';

/** One word up close: how it should sound, what went wrong, and buttons to hear it both ways. */
@Component({
  selector: 'app-word-card',
  imports: [Icon],
  template: `
    <div class="head">
      <h2>{{ word() }}</h2>
      @switch (mine()?.status) {
        @case ('good') {
          <span class="pill good">clear</span>
        }
        @case ('unclear') {
          <span class="pill warn">sounded off</span>
        }
        @case ('wrong') {
          <span class="pill bad">{{ mine()?.heard ? 'misheard' : 'not heard' }}</span>
        }
      }
      <button class="btn ghost close" (click)="store.selectWord(null)" aria-label="Close"><app-icon name="close" [size]="16" /></button>
    </div>

    <div class="sounds">
      <span class="eyebrow">Sounds like</span>
      @if (sounds.value()?.spell; as spell) {
        <span class="spell">
          @for (s of spell; track $index; let last = $last) {
            @if (s[1]) {
              <b>{{ s[0].toUpperCase() }}</b>
            } @else {
              <span>{{ s[0] }}</span>
            }
            @if (!last) {
              <i>·</i>
            }
          }
        </span>
        <span class="ipa">{{ sounds.value()?.ipa }}</span>
      } @else if (sounds.hasValue()) {
        <span class="none">Not in the dictionary. Use Hear it.</span>
      }
    </div>

    @if (mine()?.score != null) {
      <div class="take">
        <div class="take-head">
          <span class="eyebrow">Your take</span>
          <span class="pct" [class]="mine()!.status"><b>{{ pct(mine()!.score) }}%</b> sound match</span>
        </div>
        @if (units().length) {
          <div class="units">
            @for (u of units(); track $index) {
              <span class="unit" [class]="u.level" [title]="u.score == null ? '' : pct(u.score) + '%'">{{ u.text }}</span>
            }
          </div>
        }
        @if (weak(); as weak) {
          <p class="weak" [innerHTML]="weak"></p>
        }
      </div>
    }

    @if (why()) {
      <p class="why" [innerHTML]="why()"></p>
    }

    <div class="buttons">
      <button class="btn primary" (click)="store.sayWord(index()!)"><app-icon name="volume" [size]="16" /> Hear it</button>
      <button class="btn" (click)="store.sayWord(index()!, true)"><app-icon name="turtle" [size]="16" /> Slowly</button>
      <button class="btn" [disabled]="!mine()?.t" (click)="store.playMyWord(index()!)"><app-icon name="play" [size]="13" /> Mine</button>
      <button class="btn" [disabled]="!mine()?.t" (click)="store.compareWord(index()!)"><app-icon name="swap" [size]="16" /> Compare</button>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h2 {
      font-size: 30px;
      font-weight: 700;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .close {
      margin-left: auto;
      width: 36px;
      height: 36px;
      padding: 0;
    }
    .sounds {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 64px;
    }
    .spell {
      font-size: 24px;
      font-weight: 500;
      b {
        color: var(--accent);
        font-weight: 800;
      }
      i {
        font-style: normal;
        color: var(--muted);
        margin: 0 4px;
      }
    }
    .ipa {
      font-size: 15px;
      color: var(--muted);
    }
    .none {
      color: var(--muted);
    }
    .take {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .take-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .pct {
      font-size: 13px;
      color: var(--muted);
      b {
        font-size: 20px;
        font-weight: 700;
        color: var(--good-ink);
        font-variant-numeric: tabular-nums;
      }
      &.unclear b {
        color: var(--warn-ink);
      }
      &.wrong b {
        color: var(--wrong-ink);
      }
    }
    .units {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .unit {
      font-size: 20px;
      font-weight: 600;
      line-height: 1;
      padding: 7px 9px;
      border-radius: 8px;
      background: var(--good-bg);
      color: var(--good-ink);
      &.warn {
        background: var(--warn-bg);
        color: var(--warn-ink);
        box-shadow: inset 0 -2px 0 var(--warn-line);
      }
      &.bad {
        background: var(--wrong-bg);
        color: var(--wrong-ink);
        box-shadow: inset 0 -2px 0 var(--wrong-ink);
      }
      &.none {
        background: var(--surface-2);
        color: var(--muted);
      }
    }
    .weak {
      margin: 0;
      font-size: 13px;
      color: var(--ink-2);
    }
    .why {
      margin: 0;
      font-size: 13px;
      color: var(--ink-2);
      background: var(--surface-2);
      border-radius: 12px;
      padding: 10px 12px;
    }
    .buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WordCard {
  protected store = inject(Store);
  protected readonly index = this.store.selected;
  protected readonly raw = computed(() => {
    const k = this.index();
    return k == null ? '' : (this.store.words()[k] ?? '');
  });
  protected readonly word = computed(() => bare(this.raw()));
  protected readonly mine = computed(() => {
    const k = this.index();
    return k == null || this.store.recorder.recording() ? null : (this.store.result()?.words[k] ?? null);
  });
  protected readonly sounds = resource({
    params: () => this.word() || undefined,
    loader: ({ params }) => this.store.soundsLike(params),
  });
  protected pct = (x: number | null) => Math.round((x ?? 0) * 100);
  /** the word's sounds as spelled, coloured by how surely each was heard; a word that passed both checks shows no
   * weak sounds (single-letter scores are rough, and a clear word should not look wrong) */
  protected readonly units = computed(() => {
    const m = this.mine();
    if (!m?.letters) return [];
    const units = soundUnits(m.w, m.letters);
    return m.status === 'good' ? units.map((u) => ({ ...u, level: u.level === 'none' ? u.level : ('good' as const) })) : units;
  });
  /** the weakest one or two sounds, in words */
  protected readonly weak = computed(() => {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const off = this.units()
      .filter((u) => u.level === 'bad' || u.level === 'warn')
      .sort((a, b) => a.score! - b.score!)
      .slice(0, 2);
    if (!off.length) return '';
    const said = (u: (typeof off)[0]) => `<b>${esc(u.text)}</b> ${u.level === 'bad' ? 'sounded wrong' : 'sounded off'} (${this.pct(u.score)}%)`;
    return 'The ' + off.map(said).join(', and the ') + '.';
  });
  /** a sentence or two on what happened, as safe HTML (only <b> around text we escape) */
  protected readonly why = computed(() => {
    const m = this.mine();
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    if (!m) return this.store.result() ? '' : 'Record this part to see how you said it.';
    const out: string[] = [];
    if (m.status === 'wrong') {
      out.push(m.heard ? `Heard as <b>“${esc(m.heard)}”</b>.` : 'Speech recognition did not hear this word.');
      // a capitalised word inside the sentence is usually a name
      const k = this.index() ?? 0;
      if (k > 0 && /^[A-Z]/.test(this.word()))
        out.push('Names are often heard as a common word: if you say it the way its owners do, you can ignore the red here.');
    }
    if (m.status !== 'good' && m.ref != null) out.push(`The reference voice scored ${this.pct(m.ref)}% here.`);
    if (m.extra) out.push(`Extra words heard after it: “${esc(m.extra)}”.`);
    return out.join(' ');
  });
}
