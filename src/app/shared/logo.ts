import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The parrot mark: a green round head, white face, yellow beak, a red smile. */
@Component({
  selector: 'app-logo',
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="#1E9E5A" />
      <path d="M11 24c0-8 5-14 12-14 5 0 8 3 8 7 0 3-2 5-5 5h-4c-3 0-5 2-5 5v3c-4-1-6-3-6-6z" fill="#FFFFFF" />
      <path d="M25 17c4 0 7 2 7 6-2-1-4-1-6 0z" fill="#FFC23D" />
      <circle cx="22" cy="15.5" r="1.8" fill="#14201A" />
      <path d="M13 29c3 1 7 1 10-1" stroke="#E5372B" stroke-width="2.4" fill="none" stroke-linecap="round" />
    </svg>
  `,
  styles: ':host { display: inline-flex; flex-shrink: 0 }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Logo {
  readonly size = input(34);
}
