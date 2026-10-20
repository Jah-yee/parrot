import { ChangeDetectionStrategy, Component, ElementRef, inject, resource, signal, viewChild } from '@angular/core';
import { Engine } from '../core/engine';
import { readSetting, writeSetting } from '../core/settings';
import { Sound } from '../core/sound';
import { Icon } from '../shared/icon';

type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

@Component({
  selector: 'app-settings',
  imports: [Icon],
  template: `
    <dialog #dialog (close)="0" (click)="backdrop($event)">
      <div class="box">
        <header>
          <h2>Settings</h2>
          <button class="btn ghost icon" (click)="close()" aria-label="Close"><app-icon name="close" /></button>
        </header>

        <section>
          <span class="label">Reference voice</span>
          <p class="hint">The voice that reads your texts and single words. Voices marked “online” send the text (never your recordings) to the provider.</p>
          <div class="row">
            <select class="field" [value]="sound.voiceName()" (change)="sound.setVoice($any($event.target).value)">
              @for (v of sound.voices(); track v.name) {
                <option [value]="v.name">{{ v.name }} · {{ v.lang }}{{ v.localService ? '' : ' · online' }}</option>
              }
            </select>
            <button class="btn" (click)="sound.speak('Parrot reads it, you repeat it.', 1, null)"><app-icon name="play" [size]="14" /> Try</button>
          </div>
        </section>

        <section>
          <span class="label">Appearance</span>
          <div class="seg">
            @for (t of themes; track t) {
              <button [class.on]="theme() === t" (click)="setTheme(t)">{{ t[0].toUpperCase() + t.slice(1) }}</button>
            }
          </div>
        </section>

        <section>
          <span class="label">Speech engine</span>
          @if (health.value(); as h) {
            <p class="ok"><span class="dot"></span> Running{{ h.whisper ? '' : ', downloading the speech model…' }}</p>
            <p class="hint">Texts and recordings are kept on this computer, in<br /><code>{{ h.data }}</code></p>
          } @else if (health.error()) {
            <p class="bad">Not running. Start it with <code>python engine/server.py</code>.</p>
          }
        </section>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 0;
      width: min(520px, calc(100vw - 32px));
      background: var(--surface);
      color: var(--ink);
      box-shadow: var(--shadow-lg);
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    .box {
      padding: 18px 22px 22px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      h2 {
        margin: 0;
        font-size: 18px;
      }
    }
    section {
      margin-top: 18px;
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .seg {
      margin-top: 8px;
    }
    .hint {
      color: var(--ink-2);
      font-size: 13px;
      margin: 4px 0 0;
    }
    code {
      font-size: 12px;
      word-break: break-all;
    }
    .ok,
    .bad {
      margin: 6px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bad {
      color: var(--wrong-ink);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected sound = inject(Sound);
  private engine = inject(Engine);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly themes: Theme[] = ['system', 'light', 'dark'];
  protected theme = signal<Theme>(readSetting<Theme>('theme', 'system'));
  private check = signal(0);
  protected health = resource({ params: () => this.check(), loader: () => this.engine.health() });

  open() {
    this.check.update((n) => n + 1);
    this.dialog().nativeElement.showModal();
  }

  close() {
    this.dialog().nativeElement.close();
  }

  protected backdrop(e: MouseEvent) {
    if (e.target === this.dialog().nativeElement) this.close();
  }

  protected setTheme(t: Theme) {
    this.theme.set(t);
    writeSetting('theme', t);
    applyTheme(t);
  }
}
