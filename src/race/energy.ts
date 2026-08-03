/**
 * The athlete's energy state, as the HUD reads it.
 *
 * This file is a **read-only adapter**. It imports the pure, already-calibrated
 * functions from `src/sim/athlete.ts` and reshapes what `RaceView` already
 * exposes into something a bar can draw. It computes no physiology of its own
 * and it mutates nothing — change a number here and the race does not change,
 * only the picture of it does.
 *
 * ## What the meter says, and what it never says
 *
 * The headline value is the athlete's own reserve, and it is spent by **pace,
 * terrain, climb and heat** — those are literally the only inputs
 * `depleteStats()` takes. That is what makes an emptying bar a statement about
 * how the race has been run rather than about anything on the belt, and it is
 * why the meter is honest whether or not the player carries a thing.
 *
 * Two display rules hold in every build:
 *
 *  - **Nothing here reads as a punishment for an empty belt.** There is no
 *    "deficit", no target line to fall short of, and no prompt. An athlete who
 *    takes nothing on a Sprint has fuelled correctly and the plate stays calm.
 *  - **`gutLoad` is the counterweight.** It comes from `overfuellingPenalty()`
 *    and it is the one number that rises with consumption — and rising is bad.
 *    Without it the meter would imply more is better, which is both a bad
 *    mechanic and, in the constrained build, a prohibited one.
 *
 * ## The focus row
 *
 * `focus` is surfaced only when `CLAIMS_SAFE` is off. In the constrained build
 * no product may move focus at all (D-013), so there is nothing product-linked
 * to draw and the row is absent; focus keeps doing its real job either way,
 * which is softening the map at the edges. See `src/core/compliance.ts`.
 */

import type { RaceView } from '@/sim/race';
import type { AthleteStats } from '@/core/types';
import { overfuellingPenalty, speedFactor } from '@/sim/athlete';
import { CLAIMS_SAFE } from '@/core/compliance';

/**
 * Four bands, because a phone at arm's length in sunlight reads a colour and a
 * word, not a number.
 *
 * The two lower thresholds are not design taste — they are the knees already
 * calibrated in `speedFactor()`, where the glycogen speed cap starts to bite
 * (0.35) and where it collapses (0.15). Putting the band edges anywhere else
 * would mean the bar changed colour at a moment the athlete did not change.
 */
export type EnergyBand = 'strong' | 'steady' | 'digging' | 'empty';

/** Where `speedFactor()` starts capping pace. */
export const KNEE_BITE = 0.35;
/** Where `speedFactor()` collapses — "the wall", modelled as a hard knee. */
export const KNEE_WALL = 0.15;
/**
 * Above this the athlete is holding comfortably. **Presentation only** — it is
 * the one band edge with no physiological knee under it, because there is no
 * knee to find: between full and the first speed cap, nothing is happening to
 * the athlete that they would notice.
 *
 * It sits at 0.75 rather than 0.6 because of what the formats actually do. A
 * Middle run at race pace finishes near 0.68 (`tools/sim/energy-check.mjs`), so
 * at 0.6 the word under the bar read *"Máš sílu" / "Running strong"* for the
 * entire race while the bar itself fell by a third — the number was moving and
 * the label was not, which is the worst of both. At 0.75 a Middle crosses into
 * *"Držíš tempo" / "Holding pace"* around a third of the way in, which is both
 * legible and true: a quarter of the tank is gone and this is now a race.
 *
 * A Sprint still reads *strong* start to finish, and that stays correct rather
 * than being a flat bar to fix — 14 minutes barely touches glycogen. Sprint's
 * cost is navigational, and the focus row is where it shows.
 */
const KNEE_COMFORT = 0.75;

/**
 * The hydration knee, from `speedFactor()`. Below it, water starts costing
 * pace; above it, it is doing nothing at all and the indicator should be calm.
 */
export const KNEE_WATER = 0.55;

/**
 * Worst plausible value of `speedFactor()`: empty tank, dry, flat blood sugar.
 * Used only to normalise the pace cap for display.
 */
const WORST_PACE = 0.45 * 0.88 * 0.94;

export interface EnergyInput {
  view: RaceView;
  /**
   * Items still on the belt. The controller's own mirror of what it handed to
   * `Race.setBeltItems()` — `Race` owns the number, we only echo it.
   */
  beltItems: number;
  /** Carbohydrate consumed during this race, grams. Same mirroring rule. */
  consumedG: number;
}

export interface EnergyView {
  /** 0..1 carbohydrate reserve. Spent by pace, terrain, climb and heat. */
  reserve: number;
  /** 0..1 body water. Spent by sweating, which is heat and effort. */
  water: number;
  band: EnergyBand;
  /** True while water is low enough to be costing pace. */
  waterLow: boolean;
  /**
   * 0..1 — how far past what the gut can absorb for the elapsed duration the
   * intake has gone. Zero for every race run on protocol, which for Sprint and
   * Middle means taking nothing at all.
   */
  gutLoad: number;
  /** 0..1 — the fraction of top pace the body can still support. */
  paceCeiling: number;
  /**
   * True while a knee in `speedFactor()` is actually engaged, i.e. the reserve
   * or the water is now costing pace. Derived from the knees themselves rather
   * than from `paceCeiling`, whose blood-sugar term is never quite 1.
   */
  capped: boolean;
  /**
   * 0..1 navigation quality. Present only when the build shows product-linked
   * focus at all — see `CLAIMS_SAFE`. `null` means "do not draw this".
   */
  focus: number | null;
  /** Items still carried. Each one is mass over the climb. */
  beltItems: number;
}

/** Build the display model. Pure; safe to call every frame. */
export function readEnergy(i: EnergyInput): EnergyView {
  const v = i.view;

  // `speedFactor` wants the whole stat block. `focus` is not read by it — see
  // the Delphi consensus quoted in athlete.ts — so passing it through changes
  // nothing, and the value never leaves this function.
  const stats: AthleteStats = {
    glycogen: v.glycogen,
    hydration: v.hydration,
    bloodSugar: v.bloodSugar,
    focus: v.focus,
  };

  const raw = speedFactor(stats);
  const paceCeiling = clamp01((raw - WORST_PACE) / (1 - WORST_PACE));

  const { gutDistress } = overfuellingPenalty(i.beltItems, i.consumedG, v.timeS);

  return {
    reserve: clamp01(v.glycogen),
    water: clamp01(v.hydration),
    band: bandFor(v.glycogen),
    waterLow: v.hydration < KNEE_WATER,
    gutLoad: gutDistress,
    paceCeiling,
    capped: v.glycogen < KNEE_BITE || v.hydration < KNEE_WATER,
    focus: CLAIMS_SAFE ? null : clamp01(v.focus),
    beltItems: i.beltItems,
  };
}

export function bandFor(reserve: number): EnergyBand {
  if (reserve > KNEE_COMFORT) return 'strong';
  if (reserve > KNEE_BITE) return 'steady';
  if (reserve > KNEE_WALL) return 'digging';
  return 'empty';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
