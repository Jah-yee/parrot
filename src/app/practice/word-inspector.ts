import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { Store } from '../core/store';
import { bare } from '../core/split';
import { Icon } from '../shared/icon';

/** One word up close: how it should sound, what went wrong, and buttons to hear it both ways. */
@Component({
  selector: 'app-word-inspector',
  imports: [Icon],
  template: `
    @if (index() == null) {
      <div class="empty">
        <app-icon name="ear" [size]="26" />
        <p>Click a word in the sentence to see how it sounds and hear it alone.</p>
      </div>
    } @else {
      <div class="head">
        <span class="word">{{ word() }}</span>
        @switch (mine()?.status) {
          @case ('good') {
            <span class="badge good">clear</span>
          }
          @case ('unclear') {
            <span class="badge warn">sounded off</span>
          }
          @case ('wrong') {
            <span class="badge bad">{{ mine()?.heard ? 'heard as another word' : 'not heard' }}</span>
          }
        }
        <button class="btn ghost icon close" (click)="store.selectWord(null)" title="Close"><app-icon name="close" [size]="16" /></button>
      </div>

      <div class="sounds">
        @if (sounds.value()?.spell; as spell) {
          <span class="label">Sounds like</span>
          <div class="spell">
            @for (s of spell; track $index; let last = $last) {
              <span [class.stress]="s[1]">{{ s[0] }}</span>
              @if (!last) {
                <span class="sep">·</span>
              }
            }
          </div>
          <div class="ipa">{{ sounds.value()?.ipa }}</div>
        } @else if (sounds.hasValue()) {
          <span class="label">Sounds like</span>
          <div class="muted">Not in the dictionary. Use Hear it to listen.</div>
        }
      </div>

      @if (why()) {
        <p class="why">{{ why() }}</p>
      }

      <div class="buttons">
        <button class="btn primary" (click)="store.sayWord(index()!)"><app-icon name="volume" [size]="16" /> Hear it</button>
        <button class="btn" (click)="store.sayWord(index()!, true)"><app-icon name="turtle" [size]="16" /> Slowly</button>
        <button class="btn" [disabled]="!mine()?.t" (click)="store.playMyWord(index()!)"><app-icon name="play" [size]="14" /> Mine</button>
        <button class="btn" [disabled]="!mine()?.t" (click)="store.compareWord(index()!)"><app-icon name="swap" [size]="16" /> Compare</button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .empty {
      height: 100%;
      min-height: 150px;
      display: grid;
      place-content: center;
      justify-items: center;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
      p {
        max-width: 240px;
        margin: 8px 0 0;
      }
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .word {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .close {
      margin-left: auto;
    }
    .sounds {
      margin-top: 8px;
      min-height: 62px;
    }
    .spell {
      font-size: 22px;
      margin-top: 2px;
      .stress {
        color: var(--accent);
        font-weight: 700;
        text-transform: uppercase;
      }
      .sep {
        color: var(--muted);
        margin: 0 3px;
      }
    }
    .ipa {
      color: var(--muted);
      font-size: 15px;
    }
    .why {
      font-size: 14px;
      color: var(--ink-2);
      background: var(--bg);
      border-radius: 10px;
      padding: 8px 12px;
      margin: 10px 0 0;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .muted {
      color: var(--muted);
      font-size: 14px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WordInspector {
  protected store = inject(Store);
  protected readonly index = this.store.selected;
  protected readonly word = computed(() => {
    const k = this.index();
    return k == null ? '' : bare(this.store.words()[k] ?? '');
  });
  protected readonly mine = computed(() => {
    const k = this.index();
    return k == null ? null : (this.store.result()?.words[k] ?? null);
  });
  protected readonly sounds = resource({
    params: () => this.word() || undefined,
    loader: ({ params }) => this.store.soundsLike(params),
  });
  protected readonly why = computed(() => {
    const m = this.mine();
    if (!m) return this.store.result() ? '' : 'Record this part to see how you said it.';
    const parts: string[] = [];
    if (m.status === 'wrong') parts.push(m.heard ? `Speech recognition heard “${m.heard}”.` : 'Speech recognition did not hear this word.');
    if (m.score != null && m.status !== 'good') {
      parts.push(
        `Sound match ${Math.round(m.score * 100)}%` + (m.ref != null ? ` (the reference: ${Math.round(m.ref * 100)}%).` : '.'),
      );
    }
    if (m.extra) parts.push(`Extra words heard after it: “${m.extra}”.`);
    return parts.join(' ');
  });
}
