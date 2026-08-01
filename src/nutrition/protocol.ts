/**
 * The nutrition model, and the compliance boundary it is built inside.
 *
 * Read `docs/CLAIMS_TO_REVIEW.md` §5 before changing anything here. The three
 * provisions that shape this file, and how each is satisfied:
 *
 *  - **Art. 12(a) — no penalty for not consuming.** The athlete arrives at the
 *    start line ready to race whatever they choose. `baselineStats()` returns
 *    a state that is full except for what the *warm-up, the heat and the wait*
 *    have already cost, and those are the only causes. Taking nothing is a
 *    complete, unpunished answer, and for Sprint and Middle it is the answer
 *    the protocol actually recommends (`NUTRITION_PROTOCOL.md` §3.3: 0 g).
 *
 *  - **Art. 3(c) — no reward for excess.** Product effects are clamped at the
 *    ceiling, so a second identical item does nothing, and carbohydrate beyond
 *    the format's band produces `gutLoad`, which makes the athlete *worse*.
 *    During the race the same job is done by `overfuellingPenalty` in
 *    `src/sim/athlete.ts`, which is already calibrated; this is its pre-race
 *    counterpart.
 *
 *  - **Art. 2(2)(1) — a stat change is a claim.** Only `glycogen`, `hydration`
 *    and `bloodSugar` may move. **`focus` is never touched by any product**,
 *    here or anywhere else: no SKU in the range carries an authorised cognition
 *    claim and caffeine has no authorised claim at all. `Sku['stat']` has no
 *    focus field, and the generator refuses to emit one.
 *
 * ## Why this file contains no health claims
 *
 * §6.2 is a hard blocker: every claim string must come from the **Czech and
 * Slovak Official Journal** versions of Reg. 432/2012 and 2015/7, and
 * `CLAIMS_TO_REVIEW.md` states plainly that it "contains no shippable CZ or SK
 * copy". Czech is this game's primary locale. Translating the English wording
 * from the green list into Czech ourselves would breach flexibility Principle 2
 * as surely as inventing one.
 *
 * So the game states **composition only** — "25 g carbohydrate, 240 mg sodium",
 * which is nutrition information under Reg. 1169/2011 and not a claim — plus
 * sport-practice framing drawn from `NUTRITION_PROTOCOL.md`, which is about how
 * orienteers race rather than about health. No benefit is asserted, so no
 * Art. 10(2) compliance block is triggered and no Art. 10(3) accompaniment is
 * owed. When the official CZ/SK strings arrive they slot into the locked
 * `claim.*` namespace and the panels can carry them.
 */

import type { Discipline } from '@/core/types';
import type { AthleteStats } from '@/core/types';
import { freshStats } from '@/sim/athlete';
import type { Sku } from '@/data/enervit';

/**
 * What the sport says about a race of this length.
 *
 * Straight out of `NUTRITION_PROTOCOL.md` §2.3 and §3.3. Note what the Sprint
 * and Middle rows say: **zero** carbohydrate during, and the *before* phase
 * carrying the whole decision. That is Enervit's own published guidance, not a
 * softening for the regulator.
 */
export interface FormatProtocol {
  /** Carbohydrate the format's BEFORE band tops out at, grams. */
  preRaceCarbsBandG: number;
  /** In-race carbohydrate the format actually calls for, grams. Zero twice. */
  duringCarbsG: number;
  /** Belt slots offered. A sprinter carries nothing and the UI should say so. */
  beltSlots: number;
  /** Key into `nutrition.advice.*` — the sport-practice line for this format. */
  adviceKey: string;
}

export const FORMAT: Readonly<Record<Discipline, FormatProtocol>> = {
  sprint: {
    preRaceCarbsBandG: 30,
    duringCarbsG: 0,
    beltSlots: 2,
    adviceKey: 'nutrition.advice.sprint',
  },
  middle: {
    preRaceCarbsBandG: 55,
    duringCarbsG: 0,
    beltSlots: 3,
    adviceKey: 'nutrition.advice.middle',
  },
  long: {
    preRaceCarbsBandG: 55,
    duringCarbsG: 30,
    beltSlots: 4,
    adviceKey: 'nutrition.advice.long',
  },
  qualification: {
    preRaceCarbsBandG: 55,
    duringCarbsG: 0,
    beltSlots: 3,
    adviceKey: 'nutrition.advice.middle',
  },
  relay: {
    preRaceCarbsBandG: 55,
    duringCarbsG: 0,
    beltSlots: 3,
    adviceKey: 'nutrition.advice.middle',
  },
};

export interface RaceConditions {
  /** 0 = cool and dry, 1 = hot and humid. */
  heat: number;
}

/**
 * The state the athlete would start in having done nothing but warm up.
 *
 * This is the Art. 12(a) anchor. Glycogen is full — they ate breakfast, like
 * every athlete does — and the only shortfall is the water a warm-up in the sun
 * costs, which is caused by **heat and effort**. Declining a product never
 * moves this number, so declining a product can never be shown as harm.
 */
export function baselineStats(c: RaceConditions): AthleteStats {
  const s = freshStats();
  // ~4% of body water over a warm-up at 25 °C, scaling with heat. Well inside
  // the range ACSM treats as unremarkable, and it recovers with any drink —
  // including plain water, which is why this is not a product hook.
  s.hydration = clamp01(1 - 0.16 * c.heat);
  return s;
}

export interface PreRaceOutcome {
  stats: AthleteStats;
  /** Total carbohydrate taken before the start, grams. */
  carbsG: number;
  /** 0..1 — how far past the format's band the intake went. */
  gutLoad: number;
}

/**
 * Apply a pre-race selection.
 *
 * Effects are additive with a hard ceiling of 1.0, so a second identical item
 * contributes nothing: there is no route by which more product is more
 * performance. Past the format's band, carbohydrate starts costing — the
 * osmotic load of a concentrated carbohydrate dose draws water into the gut,
 * which is real physiology and which the model expresses as a hydration cost
 * and a blood-sugar overshoot that decays away before the gun.
 */
export function applyPreRace(
  chosen: readonly Sku[],
  discipline: Discipline,
  c: RaceConditions,
): PreRaceOutcome {
  const spec = FORMAT[discipline];
  const s = baselineStats(c);

  let carbsG = 0;
  for (const sku of chosen) {
    carbsG += sku.carbsG ?? 0;
    // Diminishing returns toward the ceiling: the closer to full, the less a
    // serving can add, which is what a full tank means.
    s.glycogen = towardCeiling(s.glycogen, sku.stat.glycogen);
    s.hydration = towardCeiling(s.hydration, sku.stat.hydration);
    s.bloodSugar = towardCeiling(s.bloodSugar, sku.stat.bloodSugar);
    // focus is deliberately absent. See the file header.
  }

  const overG = Math.max(0, carbsG - spec.preRaceCarbsBandG);
  // 60 g past the band is a thoroughly uncomfortable start line.
  const gutLoad = clamp01(overG / 60);
  if (gutLoad > 0) {
    s.hydration = clamp01(s.hydration - gutLoad * 0.22);
    // The overshoot has already peaked and is on its way down at the gun.
    s.bloodSugar = clamp01(s.bloodSugar - gutLoad * 0.25);
  }

  return { stats: s, carbsG: round1(carbsG), gutLoad };
}

/**
 * How the plan reads against the format, as a key into `nutrition.verdict.*`.
 *
 * Note there is no "you should have taken something" verdict, and there cannot
 * be one: an empty selection returns `onProtocol` for Sprint and Middle,
 * because for those formats it is on protocol.
 */
export function verdictKey(o: PreRaceOutcome, discipline: Discipline): string {
  if (o.gutLoad > 0.34) return 'nutrition.verdict.heavy';
  if (o.gutLoad > 0) return 'nutrition.verdict.overBand';
  void discipline;
  return 'nutrition.verdict.onProtocol';
}

/** Carbohydrate a belt of these items would put in, grams. */
export function beltCarbsG(items: readonly Sku[]): number {
  return round1(items.reduce((a, s) => a + (s.carbsG ?? 0), 0));
}

/**
 * Seconds of running time a single item on the belt costs to take.
 *
 * Real: you slow to a jog, get it out, open it and swallow. Sitting at the
 * bottom of the 3–5 s the brief specifies, scaled by how awkward the format is
 * — you are not opening a sachet cleanly at sprint pace through an alley.
 */
export function takeCostS(discipline: Discipline): number {
  return discipline === 'sprint' ? 5 : 3.5;
}

function towardCeiling(current: number, delta: number): number {
  if (delta <= 0) return clamp01(current + delta);
  return clamp01(current + delta * (1 - current));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
