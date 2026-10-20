import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Store } from '../core/store';

/** Every try of the part as a bar, oldest first; click one to see it. */
@Component({
  selector: 'app-tries-chart',
  template: `
    <div class="head">
      <span class="eyebrow">Tries of this part</span>
      <span class="hint">{{ store.history().length > 6 ? 'last 6 of ' : '' }}{{ store.history().length }}</span>
    </div>
    <div class="bars">
      @for (attempt of tries(); track attempt.id) {
        <button type="button" [class.on]="attempt.on" (click)="store.showAttempt(attempt.id)" [title]="attempt.title">
          <b>{{ attempt.score }}</b>
          <span class="bar" [style.height.px]="attempt.h"></span>
          <span class="time">{{ attempt.time }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      min-height: 0;
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
    }
    .hint {
      font-size: 12px;
      color: var(--muted);
    }
    .bars {
      flex: 1;
      overflow: hidden;
      display: flex;
      align-items: flex-end;
      gap: 8px;
      min-height: 80px;
    }
    button {
      // bars share the width and may get narrow: nothing in them sets a minimum
      flex: 1 1 0;
      min-width: 0;
      max-width: 52px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      border: 0;
      background: transparent;
      padding: 0;
      color: var(--ink-2);
    }
    b {
      font-size: 12px;
      font-weight: 700;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .bar {
      width: 100%;
      max-width: 38px;
      border-radius: 8px 8px 4px 4px;
      background: var(--bar);
      transition: height 0.3s;
    }
    .on .bar {
      background: var(--accent);
    }
    .time {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      max-width: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TriesChart {
  protected store = inject(Store);
  protected readonly tries = computed(() => {
    const shown = this.store.result()?.id;
    return this.store
      .history()
      .slice(0, 6)
      .reverse()
      .map((attempt) => ({
        id: attempt.id,
        score: attempt.score,
        on: attempt.id === shown,
        h: 8 + Math.round(Math.max(0, attempt.score) * 0.6),
        time: `${attempt.id.slice(9, 11)}:${attempt.id.slice(11, 13)}`,
        title: `${attempt.id.slice(6, 8)}/${attempt.id.slice(4, 6)} ${attempt.id.slice(9, 11)}:${attempt.id.slice(11, 13)} · ${attempt.wpm} words a minute`,
      }));
  });
}
