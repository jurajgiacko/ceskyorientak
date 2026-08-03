/**
 * Refreshment points, sited by the rule that puts them there.
 *
 * ## The rule
 *
 * **IOF Competition Rules 19.8:** where the winning time is **30 minutes or
 * more**, refreshments must be provided **at least every 25 minutes at the
 * winner's pace**. **19.10:** where the winning time is **60 minutes or more**,
 * a WADA-compliant **sports drink must be available in addition to pure
 * water** at World Cup, WOC and JWOC events. Both are quoted in
 * `docs/RESEARCH-SPORT.md` §4.5.
 *
 * This is not decoration and it is not a sponsor placement. It is a condition
 * an IOF event has to satisfy before it is allowed to run, and it is the reason
 * every orienteer over 30 minutes has drunk something handed to them on a
 * course. The game modelled none of it, which meant it was wrong about a rule
 * of the sport — and it meant the only way product reached an athlete was off
 * their own belt, which inverts how the sport actually works.
 *
 * Read the thresholds carefully, because they say something the design needs:
 *
 * | Format | Winning time | Rule 19.8 | Rule 19.10 |
 * |---|---|---|---|
 * | **Sprint** | 12–25 min | **below the threshold — none** | — |
 * | **Middle** | 30–35 min | one, around 75% of the way | below |
 * | **Long** | 88–92 min | three at minimum | **sports drink required** |
 *
 * So Sprint having nothing to pick up is not an omission to be corrected. It
 * is the rule, and the ISSprOM spec agrees: **symbol 713 does not exist in
 * ISSprOM**, only in ISOM. There is no way to draw a refreshment point on a
 * sprint map because there is never one on a sprint course. Whatever a sprinter
 * does about fuelling, they did it before the start.
 *
 * ## Where they go
 *
 * `siteRefreshments()` places them by the rule — at each 25-minute mark at the
 * winner's pace — and then snaps each to the nearest control, because that is
 * where a manned point actually stands: it needs access, it needs officials,
 * and putting it anywhere else means an athlete on their own route choice never
 * sees it. Snapping is also what makes the mechanic playable, since the one
 * place every athlete is guaranteed to pass is a control.
 *
 * **Checked against the real event.** Bulletin 4 for Vyšší Brod
 * (`docs/NUTRITION_PROTOCOL.md` §1) publishes the actual stations: the Middle,
 * winning time 32 min, has exactly **one at 72% of the course** for men and 63%
 * for women. The rule predicts one at 25/32 = **78%**. The Long, winning time
 * 90 min, has five; the rule requires three. So the rule is a floor that real
 * course setters exceed, and this model implements the floor and says so rather
 * than inventing the extras.
 */

import type { Course, CupKind, RefreshmentPoint, World2 } from '@/core/types';
import { dist2 } from '@/core/geo';

export type { CupKind, RefreshmentPoint };

/**
 * Rule 19.8 — the winning time at or above which refreshments are mandatory.
 */
export const REFRESHMENT_MIN_WINNING_TIME_S = 30 * 60;

/**
 * Rule 19.8 — the maximum interval between refreshment points, measured as
 * time at the *winner's* pace, not at the player's.
 */
export const REFRESHMENT_INTERVAL_S = 25 * 60;

/**
 * Rule 19.10 — the winning time at or above which a sports drink must be
 * offered in addition to water at World Cup / WOC / JWOC.
 */
export const SPORTS_DRINK_MIN_WINNING_TIME_S = 60 * 60;

/**
 * How many points Rule 19.8 requires for a given winning time.
 *
 * "At least every 25 minutes" means the gap between the start and the first
 * point, and between any two points, may not exceed 25 minutes. A 90-minute
 * course therefore needs points at 25, 50 and 75 minutes — three. The gap from
 * the last point to the finish is *not* constrained by the rule, and is not
 * treated as though it were.
 */
export function requiredCount(winningTimeS: number): number {
  if (winningTimeS < REFRESHMENT_MIN_WINNING_TIME_S) return 0;
  return Math.max(1, Math.ceil(winningTimeS / REFRESHMENT_INTERVAL_S) - 1);
}

/** True where Rule 19.10 obliges a sports drink alongside the water. */
export function sportsDrinkRequired(winningTimeS: number): boolean {
  return winningTimeS >= SPORTS_DRINK_MIN_WINNING_TIME_S;
}

/**
 * Cumulative straight-line distance to each control, and the course total.
 *
 * Straight line start → controls → finish is the **IOF measurement
 * convention** (Rule 16.3), and it is deliberately not the distance the
 * athlete runs, which is 10–25% longer in forest. Using the convention is what
 * lets the siting be checked against a published course percentage.
 */
function cumulative(course: Course): { atControl: number[]; totalM: number } {
  const points: World2[] = [
    course.start,
    ...course.controls.map((c) => c.position),
    course.finish,
  ];
  const atControl: number[] = [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += dist2(points[i - 1]!, points[i]!);
    // points[i] is control i-1, except the last which is the finish.
    if (i - 1 < course.controls.length) atControl.push(acc);
  }
  return { atControl, totalM: acc };
}

/**
 * Place the refreshment points a course of this winning time must carry.
 *
 * Pure and deterministic: same course in, same points out. Returns an empty
 * array for anything under 30 minutes, which is the Sprint and is correct.
 */
export function siteRefreshments(course: Course): RefreshmentPoint[] {
  const winningTimeS = course.expectedWinningTimeS;
  const n = requiredCount(winningTimeS);
  if (n === 0 || course.controls.length === 0) return [];

  const { atControl, totalM } = cumulative(course);
  if (totalM <= 0) return [];

  const offers: readonly CupKind[] = sportsDrinkRequired(winningTimeS)
    ? (['water', 'sportsDrink'] as const)
    : (['water'] as const);

  const out: RefreshmentPoint[] = [];
  const used = new Set<number>();

  for (let k = 1; k <= n; k++) {
    const atS = k * REFRESHMENT_INTERVAL_S;
    const wantFraction = atS / winningTimeS;

    // Snap to the control nearest that point on the course, skipping the last
    // control: a station on the run-in serves nobody, and the rule does not
    // constrain the gap from the final point to the finish.
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < course.controls.length - 1; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(atControl[i]! / totalM - wantFraction);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best < 0) break;
    used.add(best);

    out.push({
      id: `${course.id}-refresh-${k}`,
      atControl: best,
      position: course.controls[best]!.position,
      courseFraction: atControl[best]! / totalM,
      atWinnerPaceS: atS,
      offers,
      // 15 m: an athlete running through a control has already slowed, and the
      // table stands beside them rather than on the flag.
      reachM: 15,
    });
  }

  return out.sort((a, b) => a.atControl - b.atControl);
}
