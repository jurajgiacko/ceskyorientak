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

  // Deep links. `?scene=forest` is how the 3D world is reachable before the
  // menu exists, and `?scene=forest&bench=1` is what tools/perf/budget.mjs
  // drives. Routing through transitionTo keeps the no-abrupt-cuts rule intact
  // even for a debug entry point.
  const params = new URLSearchParams(location.search);
  const scene = params.get('scene');
  if (scene === 'forest') {
    // D-004 keeps the tier out of the player's hands, but QA and the perf gate
    // need to exercise the other two code paths on demand — the low tier takes
    // a different branch through the terrain shader, and an untested branch is
    // a broken branch.
    const tierOverride = params.get('tier');
    if (tierOverride === 'low' || tierOverride === 'medium' || tierOverride === 'high') {
      caps = { ...caps, tier: tierOverride };
    }

    const { makeForestScreen } = await import('@/ui/forestScreen');
    await transitionTo(
      makeForestScreen({
        bench: params.get('bench') === '1',
        weather: params.get('weather') === 'overcast' ? 'overcast' : 'sunny',
        debug: params.get('debug') !== '0',
      }),
    );
    return;
  }

  const { makeMenuScreen } = await import("@/ui/menuScreen");
  await transitionTo(makeMenuScreen());
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
