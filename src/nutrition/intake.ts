/**
 * What taking something off the belt does to the athlete, mid-race.
 *
 * This is the **single application site** for in-race product effects. Nothing
 * else in the codebase may move a stat in response to a SKU; concentrating it
 * here is what makes the switch in `src/core/compliance.ts` a switch rather
 * than a search-and-replace.
 *
 * Its pre-race counterpart is `applyPreRace()` in `./protocol.ts`, and the two
 * share their shape deliberately: additive with a hard ceiling of 1.0, so the
 * closer to full the athlete is, the less a serving can add, and a second
 * identical item does close to nothing. That is what a full tank means, and it
 * is also why no amount of product can be stacked into an advantage.
 *
 * ## The compliance switch, and what it does here
 *
 * `CLAIMS_SAFE` off (the default, and what the client asked for) applies
 * everything below, caffeine included. `CLAIMS_SAFE` on suppresses the caffeine
 * term entirely — not hides it, suppresses it — because the constrained build's
 * defining property is that no product touches `focus` (D-013), and a hidden
 * mechanic that still decided the race would make that build a lie. Everything
 * else applies in both builds; the flag only changes whether the HUD names it.
 *
 * ## What does not change either way
 *
 * Carbohydrate taken here is counted by `Race` toward `overfuellingPenalty()`,
 * which costs speed once intake passes what the gut can absorb for the elapsed
 * duration. Combined with the ceiling above and the turnover in
 * `caffeineFocus()`, there is no monotone "more is better" path through this
 * function in either build. And nothing here punishes an empty belt: an athlete
 * who takes nothing simply keeps the state that pace, terrain and heat left
 * them with.
 */

import type { AthleteStats } from '@/core/types';
import type { Sku } from '@/data/enervit';
import { caffeineFocus } from '@/sim/athlete';
import { CLAIMS_SAFE } from '@/core/compliance';

/** How much each stat actually moved. Signed; a zero means "did not move". */
export interface IntakeEffect {
  glycogen: number;
  hydration: number;
  bloodSugar: number;
  focus: number;
}

export interface IntakeContext {
  /** Caffeine already consumed in this race, milligrams, before this item. */
  caffeineBeforeMg: number;
}

/**
 * Apply one item to the athlete. Mutates `stats`, like `depleteStats()` does,
 * and returns what actually changed so the HUD can show the athlete moving.
 */
export function applyIntake(
  stats: AthleteStats,
  sku: Sku,
  ctx: IntakeContext,
): IntakeEffect {
  const before = { ...stats };

  stats.glycogen = towardCeiling(stats.glycogen, sku.stat.glycogen);
  stats.hydration = towardCeiling(stats.hydration, sku.stat.hydration);
  stats.bloodSugar = towardCeiling(stats.bloodSugar, sku.stat.bloodSugar);

  if (!CLAIMS_SAFE) {
    // The cumulative dose–response, not a per-item bump: the fourth gel has to
    // be able to be worse than the third, and only a total can express that.
    const mg = sku.caffeineMg ?? 0;
    const delta =
      caffeineFocus(ctx.caffeineBeforeMg + mg) - caffeineFocus(ctx.caffeineBeforeMg);
    if (delta !== 0) stats.focus = clamp01(stats.focus + delta);
  }

  return {
    glycogen: round3(stats.glycogen - before.glycogen),
    hydration: round3(stats.hydration - before.hydration),
    bloodSugar: round3(stats.bloodSugar - before.bloodSugar),
    focus: round3(stats.focus - before.focus),
  };
}

/** True when anything moved enough to be worth drawing. */
export function isVisible(e: IntakeEffect): boolean {
  return (
    Math.abs(e.glycogen) >= 0.01 ||
    Math.abs(e.hydration) >= 0.01 ||
    Math.abs(e.bloodSugar) >= 0.01 ||
    Math.abs(e.focus) >= 0.01
  );
}

function towardCeiling(current: number, delta: number): number {
  if (delta <= 0) return clamp01(current + delta);
  return clamp01(current + delta * (1 - current));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
