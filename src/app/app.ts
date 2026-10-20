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
    applyTheme(readSetting('theme', 'system'));
    await this.store.loadTexts();
    this.store.loadActivity();
  }
}
