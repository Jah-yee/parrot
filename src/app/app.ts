import { ChangeDetectionStrategy, Component, inject, OnInit, viewChild } from '@angular/core';
import { readSetting } from './core/settings';
import { Store } from './core/store';
import { Home } from './home/home';
import { Practice } from './practice/practice';
import { applyTheme, Settings } from './settings/settings';

@Component({
  selector: 'app-root',
  imports: [Home, Practice, Settings],
  template: `
    <!-- the strip under the macOS window buttons: drags the window, as the hidden title bar did -->
    <div class="titlebar" data-tauri-drag-region></div>
    @if (store.view() === 'practice') {
      <app-practice (settings)="settings().open()" />
    } @else {
      <app-home (settings)="settings().open()" />
    }
    <app-settings />
  `,
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  protected store = inject(Store);
  protected settings = viewChild.required(Settings);

  async ngOnInit() {
    // in the desktop app on macOS the title bar is hidden and the window buttons sit over the app
    if ('__TAURI_INTERNALS__' in window && /Mac/.test(navigator.userAgent)) document.documentElement.classList.add('mac-app');
    applyTheme(readSetting('theme', 'system'));
    await this.store.loadTexts();
    this.store.loadActivity();
  }
}
