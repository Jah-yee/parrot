import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The Parrot mark, the app icon without its shadow (design/app-icon.svg): a white parrot head with a hooked
 * yellow beak, saying something, on a green tile. */
@Component({
  selector: 'app-logo',
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="100 100 824 824" aria-hidden="true">
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#1E9E5A" />
      <g transform="translate(-58 0)">
        <circle cx="470" cy="512" r="212" fill="#FFFFFF" />
        <circle cx="488" cy="590" r="46" fill="#E5372B" opacity="0.9" />
        <circle cx="560" cy="452" r="36" fill="#14201A" />
        <circle cx="572" cy="440" r="11" fill="#FFFFFF" />
        <path d="M628 410 C756 396 832 470 806 600 C790 560 744 534 662 536 Z" fill="#FFC23D" />
        <path d="M662 536 C724 534 766 556 784 596 C744 628 690 618 654 584 Z" fill="#F29A1A" />
        <path d="M858 508 A72 72 0 0 1 858 612" stroke="#FFFFFF" stroke-width="30" fill="none" stroke-linecap="round" opacity="0.92" />
        <path d="M906 456 A140 140 0 0 1 906 664" stroke="#FFFFFF" stroke-width="30" fill="none" stroke-linecap="round" opacity="0.6" />
      </g>
    </svg>
  `,
  styles: ':host { display: inline-flex; flex-shrink: 0 }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Logo {
  readonly size = input(34);
}
