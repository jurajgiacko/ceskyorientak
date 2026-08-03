/**
 * What is actually in the cup at a refreshment point, and what drinking it does.
 *
 * ## This is not a product placement, it is the event specification
 *
 * Bulletin 4 for the Orienteering World Cup at Vyšší Brod, §11.14, verbatim
 * (`docs/NUTRITION_PROTOCOL.md` §1):
 *
 * > *"Refreshment points within courses will offer water (transparent cups) and
 * > ENERVIT Isotonic Drink (branded cups) – sport drink prepared as hypotonic
 * > (15 grams of Enervit instant product per 500 ml of water)."*
 *
 * Two things follow, and both matter more than the branding.
 *
 * **The mix is deliberately half strength.** The standard Isotonic Drink dose
 * is 30 g per 500 ml; the event specifies **15 g**. That is the correct call for
 * a 30 °C August race — a hypotonic drink empties from the stomach faster than
 * an isotonic one, and nobody is out there for the calories — and it means the
 * carbohydrate in a cup is *small*. We publish the small number.
 *
 * **A cup is not a bottle.** An athlete running through a control takes a paper
 * cup and drinks maybe 200 ml of it, at a jog, losing some down their front.
 * The arithmetic below is done on 200 ml, not on the 500 ml the dose is
 * specified against, which is why one cup is about **5 g of carbohydrate** — a
 * sixth of a gel.
 *
 * ## The design consequence, which is the whole point
 *
 * The course gives you **fluid and sodium**. It does not give you meaningful
 * carbohydrate, and it cannot: no realistic volume of a deliberately dilute
 * drink does. So the two decisions stay genuinely separate —
 *
 *  - **the cup** is a hydration decision, free, available only where Rule 19.8
 *    puts it, and costing only the seconds you lose slowing to drink;
 *  - **the belt** is a carbohydrate decision, yours, available whenever you
 *    want it, and costing what carrying and swallowing it costs.
 *
 * A player who drinks at every station on a Long and carries nothing still
 * arrives low on fuel, because the cups were never going to fix that. A player
 * who carries a gel and skips the cups arrives fuelled and dry. That is a real
 * trade-off and it is the one the sport actually has.
 *
 * ## Hydration is volumetric here, and that is deliberate
 *
 * `AthleteStats.hydration` now has a physical scale — 1.0 euhydrated, 0.0 a 5%
 * body-mass deficit, i.e. 3.5 l for the 70 kg reference athlete
 * (`HYDRATION_SCALE_DEFICIT_PCT` in `src/sim/athlete.ts`). So 200 ml of fluid
 * restores 200/3500 of the scale and nothing more, and this file computes it
 * rather than choosing it. See D-034 for the note that the SKU table's own
 * `stat.hydration` figures predate that scale and are generous against it.
 */

import type { AthleteStats, CupKind } from '@/core/types';
import { HYDRATION_SCALE_DEFICIT_PCT, REFERENCE_MASS_KG } from '@/sim/athlete';

/**
 * Volume an athlete actually gets down from a cup taken at racing pace, ml.
 *
 * **[U] — estimate.** No orienteering source measures this. 200 ml is the
 * volume commonly cited for a road-race cup taken on the move, and it is the
 * upper end of plausible rather than the lower, so the model is not quietly
 * flattering the mechanic.
 */
export const CUP_ML = 200;

/** Bulletin 4's event dose: grams of instant product per 500 ml. */
export const EVENT_DOSE_G_PER_500ML = 15;

/**
 * Standard-dose composition of Enervit Isotonic Drink, per 500 ml at 30 g.
 * Both figures **[V]** — read off the product panel, see
 * `docs/ENERVIT_SKU_MAP.json` (`isotonic-drink-lemon`, `verified: true`).
 */
const STANDARD_PER_500ML = { doseG: 30, carbsG: 25, sodiumMg: 240 };

/** Litres of fluid represented by the full 0..1 `hydration` scale. */
const SCALE_L = (REFERENCE_MASS_KG * HYDRATION_SCALE_DEFICIT_PCT) / 100;

export interface CupContents {
  kind: CupKind;
  volumeMl: number;
  carbsG: number;
  sodiumMg: number;
}

/** Composition of one cup, derived from the event dose. Never invented. */
export function cupContents(kind: CupKind): CupContents {
  if (kind === 'water') {
    return { kind, volumeMl: CUP_ML, carbsG: 0, sodiumMg: 0 };
  }
  const strength = EVENT_DOSE_G_PER_500ML / STANDARD_PER_500ML.doseG; // 0.5
  const share = (CUP_ML / 500) * strength;
  return {
    kind,
    volumeMl: CUP_ML,
    carbsG: round1(STANDARD_PER_500ML.carbsG * share),
    sodiumMg: Math.round(STANDARD_PER_500ML.sodiumMg * share),
  };
}

export interface CupEffect {
  hydration: number;
  bloodSugar: number;
  glycogen: number;
}

/**
 * Drink one cup. Mutates `stats`, like `depleteStats()` and `applyIntake()` do,
 * and returns what actually moved so the HUD can show it.
 *
 * **Nothing here touches `focus`**, and nothing here can: there is no caffeine
 * in a cup of water or a hypotonic sports drink, and the focus boundary in
 * `docs/CLAIMS_TO_REVIEW.md` §5 holds regardless. This function is therefore
 * identical under `CLAIMS_SAFE` in both builds, which is why — unlike
 * `applyIntake()` — it takes no compliance branch.
 *
 * Sodium earns its keep by *retention*, not by moving a bar of its own: a
 * sodium-containing drink is held rather than urinated out, so the same volume
 * does more. The literature puts meaningful retention benefit at 40–100 mmol/l;
 * the event's hypotonic mix is well under that, so the bonus modelled here is
 * deliberately small.
 */
export function drinkCup(stats: AthleteStats, kind: CupKind): CupEffect {
  const c = cupContents(kind);
  const before = { ...stats };

  // Volumetric, then a small retention bonus for the sodium. Fluid taken when
  // already full does nothing — you cannot bank water — which `Math.min`
  // expresses more honestly than a diminishing-returns curve would.
  const retention = c.sodiumMg > 0 ? 1.08 : 1.0;
  const gained = (c.volumeMl / 1000 / SCALE_L) * retention;
  stats.hydration = clamp01(stats.hydration + gained);

  // ~5 g of carbohydrate is a real but modest blood-sugar nudge and is far too
  // little to move glycogen at all. Saying so is the point: see the header.
  if (c.carbsG > 0) {
    stats.bloodSugar = clamp01(stats.bloodSugar + Math.min(0.12, c.carbsG * 0.02));
  }

  return {
    hydration: round3(stats.hydration - before.hydration),
    bloodSugar: round3(stats.bloodSugar - before.bloodSugar),
    glycogen: 0,
  };
}

/**
 * Seconds of running lost to taking a cup.
 *
 * You slow to a jog, take it, drink, and throw the cup. It is cheaper than
 * opening a gel on the move because somebody hands it to you, but it is not
 * free, and on a Middle with one station it is the entire cost of the decision.
 */
export const CUP_COST_S = 2.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
