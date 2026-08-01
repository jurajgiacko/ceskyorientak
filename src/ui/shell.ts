/**
 * The application shell: owns the screen stack and the transitions between
 * screens. Every screen change goes through here.
 *
 * Design rule from the brief: no abrupt cuts anywhere. `transitionTo` is the
 * only way to change screen, so that rule is structurally enforced rather than
 * left to discipline.
 *
 * MVP scope note: this currently mounts the boot screen only. Menu, prerace,
 * race and results screens land as they are built — see docs/ROADMAP.md.
 */

import type { Capabilities } from '@/core/capabilities';
import { t } from '@/i18n';

export interface Screen {
  readonly id: string;
  mount(host: HTMLElement): Promise<void> | void;
  unmount(): Promise<void> | void;
}

let host: HTMLElement | null = null;
let currentScreen: Screen | null = null;
let caps: Capabilities;

export async function mountShell(root: HTMLElement, capabilities: Capabilities): Promise<void> {
  caps = capabilities;
  root.innerHTML = '';

  host = document.createElement('div');
  host.className = 'screen-host';
  root.appendChild(host);

  await transitionTo(makeBootScreen());
}

export function getCapabilities(): Capabilities {
  return caps;
}

/** Cross-fade from the current screen to the next. Never cut. */
export async function transitionTo(next: Screen): Promise<void> {
  if (!host) throw new Error('shell not mounted');

  if (currentScreen) {
    host.dataset.state = 'out';
    await settle(caps.prefersReducedMotion ? 0 : 260);
    await currentScreen.unmount();
    host.innerHTML = '';
  }

  currentScreen = next;
  await next.mount(host);
  host.dataset.state = 'in';
}

function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Placeholder boot screen. Proves the pipeline end to end — i18n, tokens,
 * capability tier, deploy — before any of the heavy subsystems exist.
 */
function makeBootScreen(): Screen {
  return {
    id: 'boot',
    mount(h) {
      // The official OWCUP26 lockup, not a typeset imitation of it.
      // Partner marks sit in their own band — see the colour-conflict note in
      // src/styles/base.css: Enervit red and event orange may not share a surface.
      h.innerHTML = `
        <div class="boot">
          <img class="boot__logo" src="/brand/owcup26-ver.svg"
               alt="Orienteering World Cup 2026" width="354" height="186" />
          <h1 class="boot__title">${t('app.title')}</h1>
          <p class="boot__meta">Vyšší Brod &middot; Český Krumlov &middot; 5–9. 8. 2026</p>
          <p class="boot__status">${t('app.loading')}</p>
        </div>
        <div class="boot__partners">
          <span class="boot__partnerLabel">${t('brand.mainPartner')}</span>
          <img src="/brand/enervit.png" alt="Enervit" class="boot__enervit" />
        </div>
        <p class="boot__tier">tier ${caps.tier} &middot; webgl2 ${caps.webgl2} &middot; dpr ${caps.dpr}</p>`;
    },
    unmount() {
      /* nothing to release yet */
    },
  };
}
