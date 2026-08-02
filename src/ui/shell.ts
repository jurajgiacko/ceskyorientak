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
import { courseSeed } from '@/core/venues';
import type { Discipline, VenueId } from '@/core/types';
import type { RaceRequest, ScreenRaceSetup } from '@/ui/beforeScreen';
import { applyPreRace, FORMAT } from '@/nutrition/protocol';
import { SKUS } from '@/data/enervit';
import type { Sku } from '@/data/enervit';

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
  if (scene === 'forest' || scene === 'sprint') {
    // D-004 keeps the tier out of the player's hands, but QA and the perf gate
    // need to exercise the other two code paths on demand — the low tier takes
    // a different branch through the terrain shader, and an untested branch is
    // a broken branch.
    const tierOverride = params.get('tier');
    if (tierOverride === 'low' || tierOverride === 'medium' || tierOverride === 'high') {
      caps = { ...caps, tier: tierOverride };
    }
    // The touch HUD is the layout most players will see and the hardest to
    // check on a desktop, so it is forceable. Same reasoning as `tier`.
    if (params.get('touch') === '1') caps = { ...caps, touch: true };

    const sceneOpts = {
      bench: params.get('bench') === '1',
      weather: (params.get('weather') === 'overcast' ? 'overcast' : 'sunny') as
        | 'overcast'
        | 'sunny',
      debug: params.get('debug') !== '0',
    };

    // `&race=1` drops straight into a competition with an empty belt and a
    // default pre-race plan, skipping the menu and the BEFORE screen. This is
    // how a race is reachable for QA and for a scripted smoke run; the
    // player's route in is always the menu.
    const race = params.get('race') === '1' ? deepLinkRace(scene, params) : undefined;

    if (scene === 'sprint') {
      const { makeSprintScreen } = await import('@/ui/sprintScreen');
      await transitionTo(makeSprintScreen({ ...sceneOpts, ...(race ? { race } : {}) }));
      return;
    }

    const { makeForestScreen } = await import('@/ui/forestScreen');
    await transitionTo(makeForestScreen({ ...sceneOpts, ...(race ? { race } : {}) }));
    return;
  }

  const { makeMenuScreen } = await import("@/ui/menuScreen");
  await transitionTo(makeMenuScreen());
}

export function getCapabilities(): Capabilities {
  return caps;
}

/**
 * Build the setup a `&race=1` deep link implies. Nothing is consumed.
 *
 * Two extra knobs, for the same reason `&tier=` exists: QA has to be able to
 * reach states the menu does not offer, and an unreachable state is an
 * unchecked one.
 *
 *  - `&discipline=long` — the only format whose protocol calls for in-race
 *    carbohydrate at all, and therefore the only one where the belt is more
 *    than an option. The menu offers Middle and Sprint only.
 *  - `&belt=N` — carry N items, so the belt UI can be exercised without going
 *    through the BEFORE screen. Bounded by the format's real slot count, so
 *    this cannot manufacture a loadout a player could not build.
 */
function deepLinkRace(scene: 'forest' | 'sprint', params: URLSearchParams): ScreenRaceSetup {
  const wanted = params.get('discipline');
  const discipline: Discipline =
    scene === 'sprint'
      ? 'sprint'
      : wanted === 'long' || wanted === 'middle'
        ? wanted
        : 'middle';
  const heat = scene === 'sprint' ? 0.45 : 0.4;
  const venue: VenueId = scene === 'sprint' ? 'krumlov' : 'martinkov';
  const request: RaceRequest = {
    venue,
    discipline,
    // No `&seed=` means the venue's own course — the one the menu opens and the
    // one a player races. It used to mean seed 7, which is a course no player
    // has ever seen, so a deep link checked something nobody plays.
    // `tools/ci/check-passable.mjs` asserts that repeated loads of exactly this
    // URL give exactly this course.
    seed: Number(params.get('seed') ?? courseSeed(venue)) || courseSeed(venue),
    heat,
    startInMin: 60,
  };

  const want = Math.max(0, Math.min(FORMAT[discipline].beltSlots, Number(params.get('belt') ?? 0) || 0));
  const belt = QA_BELT.slice(0, want)
    .map((id) => SKUS.find((s) => s.id === id))
    .filter((s): s is Sku => s !== undefined);

  return {
    request,
    preRace: [],
    belt,
    startStats: applyPreRace([], discipline, { heat }).stats,
  };
}

/**
 * The same during-race items the BEFORE screen offers, ordered so that a
 * one-item QA belt is the caffeinated 100 mg gel: it is the only loadout that
 * exercises the caffeine path, and an unexercised path is an unchecked one.
 */
const QA_BELT = [
  'carbo-gel-cola-caffeine',
  'gel-raspberry-caffeine',
  'gel-citrus',
  'liquid-gel-orange',
] as const;

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
