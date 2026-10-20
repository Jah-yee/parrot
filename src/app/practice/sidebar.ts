import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { Store } from '../core/store';
import { Icon } from '../shared/icon';
import { Logo } from '../shared/logo';
import { band } from '../shared/score';

/** Your texts, always at hand while practising. */
@Component({
  selector: 'app-sidebar',
  imports: [Icon, Logo],
  template: `
    <button class="brand" (click)="store.home()" title="Home">
      <app-logo [size]="34" />
      <span>
        <b>Parrot</b>
        <small>say it right</small>
      </span>
    </button>

    <button class="btn primary new" (click)="store.home()"><app-icon name="plus" [size]="16" /> New text</button>

    <label class="search">
      <app-icon name="search" [size]="15" />
      <span class="sr-only">Search texts</span>
      <input placeholder="Search texts" [value]="query()" (input)="query.set($any($event.target).value)" />
    </label>

    <span class="eyebrow">Your texts</span>
    <nav aria-label="Your texts">
      @for (t of shown(); track t.id) {
        <button [class.on]="t.id === store.text()?.id" [attr.aria-current]="t.id === store.text()?.id ? 'page' : null" (click)="store.open(t.id)">
          <span class="what">
            <span class="t">{{ t.title }}</span>
            <span class="m">{{ t.words }} words · {{ t.practised ? t.practised + ' practised' : 'new' }}</span>
          </span>
          @if (t.average != null) {
            <span class="pill" [class]="band(t.average)">{{ t.average }}%</span>
          }
        </button>
      }
    </nav>

    <footer>
      <span class="dot" [class]="store.engineState()"></span>
      <span class="status">{{ status() }}</span>
      <button class="btn ghost square" (click)="settings.emit()" aria-label="Settings"><app-icon name="settings" [size]="17" /></button>
    </footer>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px 14px 12px;
      border-right: 1px solid var(--line);
      background: var(--side);
      min-height: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px 6px 6px;
      border: 0;
      background: none;
      text-align: left;
      span {
        display: flex;
        flex-direction: column;
      }
      b {
        font-family: var(--display);
        font-size: 20px;
        letter-spacing: -0.02em;
        line-height: 1;
      }
      small {
        font-size: 12px;
        color: var(--muted);
      }
    }
    .new {
      height: 40px;
      border-radius: 11px;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      border-radius: 10px;
      padding: 0 10px;
      background: var(--surface);
      border: 1px solid var(--line);
      color: var(--muted);
      input {
        border: 0;
        outline: 0;
        background: transparent;
        width: 100%;
        color: var(--ink);
      }
      &:focus-within {
        border-color: var(--accent);
      }
    }
    .eyebrow {
      padding: 4px 6px 0;
    }
    nav {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      button {
        display: flex;
        align-items: center;
        gap: 10px;
        text-align: left;
        padding: 9px 10px;
        border-radius: 11px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--ink-2);
        &:hover {
          background: var(--surface-2);
        }
        &.on {
          border-color: var(--line);
          background: var(--surface);
          color: var(--ink);
          box-shadow: var(--shadow-sm);
          .t {
            font-weight: 600;
          }
        }
      }
      .what {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .t {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .m {
        font-size: 12px;
        color: var(--muted);
      }
    }
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 2px 0 8px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      .status {
        flex: 1;
      }
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--bar);
      &.ready {
        background: var(--accent);
      }
      &.down {
        background: var(--rec);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected store = inject(Store);
  readonly settings = output<void>();
  protected band = band;
  protected query = signal('');
  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.store.texts().filter((t) => !q || t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
  });
  protected readonly status = computed(
    () => ({ checking: 'Starting…', ready: 'Offline · engine ready', down: 'Engine not running' })[this.store.engineState()],
  );
}
