import { ChangeDetectionStrategy, Component, inject, OnInit, viewChild } from '@angular/core';
import { readSetting } from './core/settings';
import { Store } from './core/store';
import { Library } from './library/library';
import { Practice } from './practice/practice';
import { applyTheme, Settings } from './settings/settings';

@Component({
  selector: 'app-root',
  imports: [Library, Practice, Settings],
  template: `
    @if (store.view() === 'practice') {
      <app-practice (settings)="settings().open()" />
    } @else {
      <app-library (settings)="settings().open()" />
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
    // back to the text that was open last time
    const last = readSetting('text', '');
    if (last && this.store.texts().some((t) => t.id === last)) this.store.open(last);
  }
}
