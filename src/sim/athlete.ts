/**
 * The athlete simulation: the four stats, how they deplete, and how they feed
 * back into speed and navigation.
 *
 * EVERY constant here traces to a cited source. Where the orienteering
 * literature is silent — which is most of the time — the transfer source is
 * named explicitly. See docs/NUTRITION_PROTOCOL.md and docs/RESEARCH-SPORT.md.
 *
 * The honest headline, which shapes this whole file: **there is no published
 * evidence on carbohydrate intake, blood glucose or glycogen status in
 * orienteering.** Three papers exist on orienteering nutrition; none measures
 * fuelling. So this model is built by transfer from running, team-sport and
 * cycling research, and it says so rather than implying a rigour it lacks.
 */

import type { AthleteStats, AthleteState, Discipline } from '@/core/types';
import { Runnability } from '@/core/types';

// ---------------------------------------------------------------------------
// Calibration constants
// ---------------------------------------------------------------------------

/**
 * Oxygen cost of running in forest is **26% higher** than road running at the
 * same speed. Creagh & Reilly, Sports Med 1997;24(6):409–418.
 *
 * This single number is the backbone of the energy model: it is why an
 * orienteer burns through glycogen faster than a road runner holding the same
 * pace, and why terrain choice is an energy decision, not only a time one.
 */
export const FOREST_O2_PENALTY = 1.26;

/**
 * Speed multipliers by terrain class. Indexed by `Runnability`.
 *
 * Anchored on elite winning times (Long ~90 min for ~14–16 km with 500–600 m
 * climb; Sprint ~13–15 min for ~3.5 km) and on Hébert-Losier's measured
 * elite/amateur velocity differences across surfaces.
 */
export const SPEED_BY_RUNNABILITY: Readonly<Record<Runnability, number>> = {
  [Runnability.Road]: 1.0,
  [Runnability.Path]: 0.97,
  [Runnability.OpenFast]: 0.9,
  [Runnability.OpenRough]: 0.72,
  [Runnability.ForestOpen]: 0.8,
  [Runnability.Green1]: 0.6,
  [Runnability.Green2]: 0.4,
  [Runnability.Green3]: 0.18,
  [Runnability.Marsh]: 0.45,
  [Runnability.Rock]: 0.5,
  [Runnability.Impassable]: 0,
};

/**
 * Metabolic cost multiplier per terrain class. Deliberately NOT the inverse of
 * speed: fighting through dark green is slow *and* disproportionately
 * expensive, while a path is both fast and cheap. Decoupling them is what
 * makes route choice a real trade-off rather than pure arithmetic.
 */
export const COST_BY_RUNNABILITY: Readonly<Record<Runnability, number>> = {
  [Runnability.Road]: 1.0,
  [Runnability.Path]: 1.02,
  [Runnability.OpenFast]: 1.12,
  [Runnability.OpenRough]: 1.3,
  [Runnability.ForestOpen]: FOREST_O2_PENALTY,
  [Runnability.Green1]: 1.45,
  [Runnability.Green2]: 1.7,
  [Runnability.Green3]: 2.1,
  [Runnability.Marsh]: 1.8,
  [Runnability.Rock]: 1.5,
  [Runnability.Impassable]: 1,
};

/**
 * Smallest worthwhile enhancement in elite orienteering: **1.0–3.5%**.
 * Hébert-Losier et al., Med Sci Sports Exerc 2015;47(7):1523–1530
 * (within-athlete CV 4.9% in finals, 7.3% in qualification).
 *
 * This is our balance yardstick. Any modelled effect smaller than ~1% is below
 * the noise floor of the real sport and should not be given a visible UI
 * treatment; anything we let exceed ~5% had better be well evidenced.
 */
export const SMALLEST_WORTHWHILE_EFFECT = 0.01;

/** Race durations we actually simulate, seconds. Drives the fuelling bands. */
export const TYPICAL_DURATION_S: Readonly<Record<Discipline, number>> = {
  sprint: 14 * 60,
  middle: 33 * 60,
  long: 90 * 60,
  qualification: 35 * 60,
  relay: 35 * 60,
};

/**
 * Effort as a fraction of what *this ground* allows, not of a road pace.
 *
 * This is the correction that makes terrain cost anything at all. The obvious
 * formulation — `speed / BASE_MS` — says an orienteer fighting through dark
 * green at 0.9 m/s is working at 20% effort, because they are moving slowly.
 * That is precisely backwards: dark green is where an orienteer works hardest
 * and moves least. Measured on the real course this file is calibrated against,
 * the naive form scored a runner in Green1 at **0.15 intensity**, which is a
 * brisk walk, while they were racing.
 *
 * An athlete in a race self-regulates to roughly constant *effort*, not
 * constant speed — the pace is whatever that effort buys on the ground
 * underfoot. So intensity is measured against the speed this runnability class
 * permits, and the metabolic difference between classes is carried entirely by
 * `COST_BY_RUNNABILITY`, which is what that table was always documented to be
 * for. Before this change the two cancelled and the Creagh & Reilly 26% did
 * nothing.
 *
 * @param speedMs   achieved ground speed, m/s
 * @param baseMs    the athlete's road speed at full effort, m/s
 */
export function relativeIntensity(
  speedMs: number,
  baseMs: number,
  runnability: Runnability,
): number {
  const permitted = baseMs * SPEED_BY_RUNNABILITY[runnability];
  // Impassable permits nothing; anyone still there is standing against it.
  if (permitted <= 0.01) return 0;
  return clamp01(speedMs / permitted);
}

/**
 * Fraction of energy expenditure drawn from carbohydrate, by intensity.
 *
 * **The crossover concept** — Brooks & Mercier, J Appl Physiol
 * 1994;76(6):2253–2261 — and the substrate measurements in Romijn et al.,
 * Am J Physiol 1993;265(3):E380–E391. As relative intensity rises, the fuel
 * mix shifts from fat toward carbohydrate: roughly 40% of energy from
 * carbohydrate at 40% VO2max, ~60% at 65% VO2max, ~80% at 85% VO2max.
 *
 * This is the single term that makes **pacing** a decision rather than
 * scenery. Without it, glycogen cost is linear in effort and the only way to
 * save fuel is to cover less ground — which is not a choice anybody would
 * make. With it, going out too hard on a Long costs carbohydrate
 * disproportionately, and the athlete who holds a sustainable effort arrives
 * at the last controls with something left. That is the actual lesson of long
 * distance racing, and it is why the refreshment points and the belt have
 * something to bite on.
 *
 * The linear fit below reproduces the three anchor points above to within a
 * few percent across the range a race actually occupies; the underlying curve
 * is sigmoid, but not over 0.4–1.0, and a fit that claimed more resolution
 * than the source data has would be false precision.
 */
export function carbFraction(intensity: number): number {
  return clamp01(0.35 + 0.55 * clamp01(intensity));
}

// ---------------------------------------------------------------------------
// Depletion
// ---------------------------------------------------------------------------

/**
 * Glycogen drain per second at reference effort **and** reference fuel mix, as
 * a fraction of full stores. Multiplied by `carbFraction()` at use, so the
 * headline number is not itself a race-length figure — read the arithmetic
 * below, not the constant.
 *
 * Sized against the one race that has a fuelling problem. A Long run at the
 * winner's pace spends ~5400 s at effort ≈ 1.35 (forest cost × the climb) and
 * a carbohydrate fraction ≈ 0.85, which is ~6200 reference-seconds, and lands
 * the athlete at the finish **around 0.15 — the wall knee in `speedFactor()`,
 * not through it.** That is the design intent stated as a number: a Long run
 * honestly and fuelled with nothing finishes *on the edge*, so the refreshment
 * points mandated by Rule 19.8 and anything on the belt are the difference
 * between arriving empty and arriving able to run the last two controls.
 *
 * The same constant leaves a 14-minute Sprint at ~0.88 and a 33-minute Middle
 * around 0.7. Sprint barely dents it and that is correct, not a flat bar to be
 * fixed: Sprint's story is navigation under load, and it is told by `focus`.
 *
 * Previously `1/(105*60)`, paired with an `intensity` that fell when terrain
 * slowed the athlete. The two errors partly cancelled; both are fixed here.
 */
const GLYCOGEN_DRAIN_PER_S = 1 / (120 * 60);

/**
 * Hydration drain, per second, at full effort in neutral conditions.
 *
 * **The scale now means something.** `hydration` 1.0 is euhydrated and 0.0 is
 * a **5% body-mass fluid deficit**, which is the point at which the ACSM
 * position stand describes clear performance and thermoregulatory impairment.
 * That fixes the two knees to real numbers: `speedFactor()`'s 0.55 is a ~2.25%
 * deficit, sitting on the widely-cited 2% threshold, and it is why the knee is
 * where it is rather than being a taste.
 *
 * Sweat rate is the input. Distance runners in warm conditions sweat ~1.0–1.8
 * l/h; at 1.2 l/h a 70 kg athlete loses 3.5 l — the full scale — in just under
 * three hours, which is the rate below. Field data: competitive runners in
 * ~75–90 min events voluntarily drink only ~150 ml/h and finish ~2.4% down
 * without incident (ACSM 2007, Table 2), and whether 2% impairs performance at
 * all in real-world short events is genuinely contested — blinded studies
 * contradict each other.
 *
 * So this binds on a Long in the heat and nowhere else. See D-012: making
 * Sprint or Middle hydration-limited would be a gameplay lie.
 */
const HYDRATION_DRAIN_PER_S = 1 / (170 * 60);

/** Body-mass fluid deficit, in percent, represented by `hydration` = 0. */
export const HYDRATION_SCALE_DEFICIT_PCT = 5;

/**
 * Focus drain. The interesting one.
 *
 * Orienteers show measurable mental fatigue after competition (ES 0.93
 * post-race) that is **still elevated 48 h later** (ES 0.54) — Lam et al.,
 * J Sports Sci 2023;41(15):1423–1436. That is measured in orienteers, across
 * days, and it is the empirical basis for our career-mode carry-over.
 *
 * Expert consensus (Lam et al. Delphi, 2022) is that mental fatigue hits
 * *decision-making*, with no agreement that it affects running speed. Our model
 * follows that exactly: Focus never touches speed.
 *
 * **Why this is slower than it was.** At `1/(70*60)` a 90-minute Long reached
 * focus 0 at around the 50-minute mark, and `navigationQuality()` returns
 * `focus` directly — so the athlete spent the last 40 minutes at the floor,
 * navigating as badly as it is possible to navigate, with no further
 * distinction between a good race and a disastrous one. A stat that saturates
 * has stopped being a mechanic. At the rate below a Long finishes near 0.3,
 * a Middle near 0.75 and a Sprint near 0.9 *from time alone* — and the rest of
 * the spread comes from `controlApproachPenalty()`, which is where it belongs,
 * because that is the term the player controls.
 */
const FOCUS_DRAIN_PER_S = 1 / (180 * 60);

/** Blood sugar drifts toward a set point unless fed; fast timescale. */
const BLOOD_SUGAR_HALFLIFE_S = 420;

export interface DepletionInput {
  /** Fraction of maximal effort, 0..1. */
  intensity: number;
  runnability: Runnability;
  /** Uphill gradient as dh/ds; negative is downhill. */
  slope: number;
  /** 0 = cool and dry, 1 = hot and humid. */
  heat: number;
  dtS: number;
}

/**
 * Advance the four stats by one step.
 *
 * Pure and allocation-free — it mutates the passed object rather than
 * returning a new one, because this runs every frame.
 */
export function depleteStats(s: AthleteStats, i: DepletionInput): void {
  const terrainCost = COST_BY_RUNNABILITY[i.runnability];

  // Climbing is metabolically expensive; descending is cheap but not free.
  // Roughly linear in gradient over the range real terrain provides.
  const slopeCost = i.slope > 0 ? 1 + i.slope * 3.2 : 1 + Math.abs(i.slope) * 0.4;

  const effort = i.intensity * terrainCost * slopeCost;

  // Only the carbohydrate share of the energy cost comes out of glycogen; the
  // rest is fat, and the split moves with intensity. See `carbFraction()` —
  // this is what makes going out too hard expensive in a way that going far is
  // not, and it is the mechanic that pacing acts on.
  s.glycogen = clamp01(
    s.glycogen - GLYCOGEN_DRAIN_PER_S * effort * carbFraction(i.intensity) * i.dtS,
  );

  // Heat is the dominant term here, per ACSM: sweat rate, not duration, is what
  // moves hydration on this timescale. Climb is in it too — the extra work of
  // going up is dissipated as heat like any other, and a 735 m Long in August
  // is a sweat problem before it is anything else. Terrain class is *not*: a
  // slower surface costs metabolic energy, which is glycogen's business, but it
  // does not itself raise core temperature per unit of effort.
  s.hydration = clamp01(
    s.hydration -
      HYDRATION_DRAIN_PER_S * i.intensity * slopeCost * (0.6 + 1.4 * i.heat) * i.dtS,
  );

  // Blood sugar decays toward a level set by remaining glycogen: once the tank
  // is low, the liver can no longer hold the set point up.
  const target = 0.25 + 0.6 * s.glycogen;
  const k = Math.LN2 / BLOOD_SUGAR_HALFLIFE_S;
  s.bloodSugar += (target - s.bloodSugar) * (1 - Math.exp(-k * i.dtS));
  s.bloodSugar = clamp01(s.bloodSugar);

  // Focus is spent by navigating hard, and spent faster when fuel is low.
  // The low-fuel coupling is the mechanism behind late-race navigation errors.
  const fuelPenalty = s.bloodSugar < 0.4 ? 1 + (0.4 - s.bloodSugar) * 2.5 : 1;
  s.focus = clamp01(s.focus - FOCUS_DRAIN_PER_S * (0.5 + i.intensity) * fuelPenalty * i.dtS);
}

// ---------------------------------------------------------------------------
// Stats → performance
// ---------------------------------------------------------------------------

/**
 * Speed multiplier from physiological state. Focus is deliberately absent —
 * see the Delphi consensus above.
 *
 * "The wall" is modelled as a hard knee rather than a smooth ramp, because
 * that is what it is: performance holds, then collapses.
 *
 * FRAMING RULE, and it is a legal one (Art. 12(a) — see
 * docs/CLAIMS_TO_REVIEW.md §5). Depletion here is caused by **effort, terrain,
 * climb and heat**. It is never caused by declining a product, and no UI copy
 * may present it that way: "claims which suggest that health could be affected
 * by not consuming the food" are prohibited outright, with no authorisation
 * route available.
 *
 * This costs us nothing, because it is also what is true. The correct
 * carbohydrate intake for Sprint and Middle is *zero* — so a player who takes
 * nothing in those races has fuelled correctly, and the model must agree with
 * them. Product is one lever among several (pacing, route choice, arriving
 * well-fuelled), not the price of not being punished.
 */
export function speedFactor(s: AthleteStats): number {
  // Below ~15% glycogen the speed cap collapses. Above ~35% it barely matters.
  const glyc =
    s.glycogen > 0.35
      ? 1
      : s.glycogen > 0.15
        ? 0.85 + 0.15 * ((s.glycogen - 0.15) / 0.2)
        : 0.45 + 0.4 * (s.glycogen / 0.15);

  // Hydration: gentle, and only past the contested 2%-equivalent threshold.
  const hyd = s.hydration > 0.55 ? 1 : 0.88 + 0.12 * (s.hydration / 0.55);

  // Blood sugar drives short-term power.
  const bs = 0.94 + 0.06 * s.bloodSugar;

  return glyc * hyd * bs;
}

/**
 * Navigation quality, 0..1. This is what Focus controls.
 *
 * Feeds four things: map legibility at the edges, control-description parsing,
 * compass bearing drift, and dead-reckoning error growth.
 *
 * **Focus is a function of fatigue and terrain ONLY. No product may move it,
 * directly or indirectly.** This is a hard boundary, not a balance choice —
 * see docs/CLAIMS_TO_REVIEW.md §5. No SKU in the Enervit range carries an
 * authorised EU cognition claim, and caffeine has *no* authorised claim at all
 * (the Commission's draft was vetoed by Parliament in 2016 and never
 * re-tabled). A product that visibly raised a focus bar would be a symbolic
 * health claim under Art. 2(2)(1).
 *
 * Note what is deliberately absent: `bloodSugar`. There is real evidence that
 * skill degrades around 3.9 mmol/L in intermittent exercise (Ali et al., MSSE
 * 2007). But blood sugar *is* movable by product, so routing it into navigation
 * would rebuild the prohibited pathway indirectly — and an inference the
 * consumer draws is still a claim under Art. 3(a), even when each step is
 * individually true.
 *
 * The science points the same way regardless: Carter et al. (2004) infused
 * glucose intravenously during a one-hour time trial and saw no performance
 * benefit, so carbohydrate availability is not limiting at Sprint or Middle
 * duration anyway. The compliant design and the honest design are the same
 * design.
 */
export function navigationQuality(s: AthleteStats): number {
  return clamp01(s.focus);
}

/**
 * Probability per second of a parallel error being *initiated*, given the
 * terrain's ambiguity and the athlete's current navigation quality.
 *
 * `ambiguity` comes from the terrain: how many similar features are nearby.
 * A re-entrant among five identical re-entrants is where this actually happens.
 */
export function parallelErrorRate(s: AthleteStats, ambiguity: number): number {
  const q = navigationQuality(s);
  // Rises sharply as quality falls — a tired orienteer in vague terrain is a
  // different animal from a fresh one in the same place.
  //
  // The coefficient is tuned by simulation (tools/sim/nav-check.mjs), not
  // guessed. At 0.02 a tired athlete in ambiguous terrain took a parallel
  // error on ~80% of long legs, which is far too often to be believable: a
  // parallel error is a memorable disaster, not a routine event. At 0.006 it
  // lands around 10–15% on a bad leg and ~40% on a genuinely awful one, which
  // is closer to how often it actually ruins someone's race.
  return ambiguity * Math.pow(1 - q, 2.2) * 0.006;
}

/**
 * Extra dead-reckoning error accumulated per metre travelled, in metres.
 *
 * Growing with speed is the core tension of the sport: run fast and lose
 * contact with the map, run slow and read perfectly.
 */
export function navErrorGrowth(s: AthleteStats, speedMs: number, complexity: number): number {
  const q = navigationQuality(s);
  const base = 0.012 * (1 - q * 0.8);
  const speedTerm = 1 + Math.max(0, speedMs - 2.5) * 0.35;
  return base * speedTerm * (0.5 + complexity);
}

// ---------------------------------------------------------------------------
// Over-fuelling
// ---------------------------------------------------------------------------

/**
 * Penalty for carrying and consuming more than the race needs.
 *
 * Required by Art. 3(c) — a mechanic may never reward consumption without
 * limit. But it is also simply correct, which is why it makes the game better
 * rather than merely legal:
 *
 * - **Gut tolerance.** Carbohydrate beyond what the gut can absorb causes
 *   distress, not performance. The real ceiling is ~60 g/h for single-source
 *   and ~90 g/h for multiple-transportable, and only in events long enough to
 *   need it.
 * - **Carrying weight.** Every gel on the belt is mass carried over 500 m of
 *   climb.
 * - **Duration.** 60 g/h in a 32-minute race is not cautious, it is useless.
 *   Enervit's own guidance conditions that figure on efforts over two hours,
 *   and their running page states outright that carbohydrate is typically
 *   unnecessary under 60 minutes.
 *
 * So a player who loads the belt "to be safe" should finish slower than one who
 * read the course profile. That is the lesson the BEFORE screen exists to
 * teach.
 *
 * @param carriedItems  count of items on the belt at the start
 * @param consumedG     carbohydrate actually consumed, grams
 * @param durationS     race duration so far, seconds
 */
export function overfuellingPenalty(
  carriedItems: number,
  consumedG: number,
  durationS: number,
): { speedMul: number; gutDistress: number } {
  // Mass carried: each gel/flask is ~40 g. Small but real over a Long.
  const carryMul = 1 - Math.max(0, carriedItems - 2) * 0.004;

  // What the gut can actually take, given how long we have been running.
  const hours = durationS / 3600;
  const tolerableG = hours < 0.75 ? 0 : Math.min(90, 60 * hours);
  const excessG = Math.max(0, consumedG - tolerableG);

  // Distress ramps once past tolerance; caps so it never becomes a death
  // spiral — being wrong should cost time, not end the race.
  const gutDistress = clamp01(excessG / 60);

  return {
    speedMul: carryMul * (1 - gutDistress * 0.14),
    gutDistress,
  };
}

// ---------------------------------------------------------------------------
// Caffeine
// ---------------------------------------------------------------------------

/**
 * Reference body mass, kg. Caffeine dosing is per-kilogram everywhere in the
 * literature, and the game has no body-mass model, so it assumes one athlete.
 */
export const REFERENCE_MASS_KG = 70;

/**
 * Total focus offset from the caffeine taken so far in this race, as a function
 * of cumulative dose.
 *
 * **This function is pure and unconditional.** It is the physiology, stated
 * once. Whether the game *applies* it is decided at a single call site in
 * `src/nutrition/intake.ts` and governed by `src/core/compliance.ts` — see the
 * table there, and D-013/D-020 in docs/DECISIONS.md for why that switch exists.
 * Keeping the model here rather than behind the flag means both builds share
 * one physics and only one of them draws it.
 *
 * The shape, and why it is a hump rather than a ramp:
 *
 * - **It rises fast and then stops rising.** Ergogenic effects plateau around
 *   3 mg/kg; the dose–response literature is consistent that 6 mg/kg does no
 *   more than 3 mg/kg for endurance or vigilance. So the exponential
 *   saturation, not a linear term.
 * - **It turns over.** Past roughly 3.5 mg/kg the costs start showing up —
 *   restlessness, heart-rate drift, GI upset — and for a task that is
 *   *decision-making under load*, which is what Focus governs in this game,
 *   those are not neutral. A third caffeinated gel leaves an orienteer worse at
 *   reading a contour than a second one did.
 *
 * That turnover is deliberate and is not negotiable by a flag: a mechanic where
 * the optimum is "consume everything" has no decision in it. It is also what
 * keeps the design clear of Art. 3(c), in the build that needs to be.
 *
 * @param totalMg cumulative caffeine consumed in this race, milligrams
 * @returns focus offset, roughly −0.12 … +0.22
 */
export function caffeineFocus(totalMg: number, massKg = REFERENCE_MASS_KG): number {
  const perKg = Math.max(0, totalMg) / massKg;
  // Saturating rise: ~63% of the ceiling by 1.1 mg/kg, ~95% by 3.3 mg/kg.
  const rise = 1 - Math.exp(-perKg / 1.1);
  const over = Math.max(0, perKg - 3.5);
  const v = 0.22 * rise - 0.09 * over;
  return v < -0.12 ? -0.12 : v;
}

// ---------------------------------------------------------------------------
// The control-approach mechanic
// ---------------------------------------------------------------------------

/**
 * Heart-rate/effort surge on arriving at a control without having planned the
 * next leg.
 *
 * This is drawn from a real, measured difference. National-standard orienteers
 * show a ΔHR at controls of 5 ± 1 bpm; club-standard show 17 ± 4 bpm — and the
 * authors attribute the gap directly to *"failing to plan ahead before arriving
 * at the controls"* (Bird et al., Br J Sports Med 2003;37(3):254–257). National
 * orienteers also hold a much lower within-race HR variability (6 ± 2 vs
 * 12 ± 2 bpm).
 *
 * So planning the next leg *before* you punch is not a UI nicety we invented to
 * have something to do — it is the measurable difference between a good
 * orienteer and an average one, and it costs energy when you get it wrong.
 * Expert orienteers achieve it by distributing map processing over time rather
 * than reading in bursts (Eccles & Arsal, J Sports Sci 2015).
 */
export function controlApproachPenalty(plannedAhead: boolean): {
  glycogenCost: number;
  focusCost: number;
} {
  return plannedAhead
    ? { glycogenCost: 0.0008, focusCost: 0.004 }
    : { glycogenCost: 0.0027, focusCost: 0.019 };
}

// ---------------------------------------------------------------------------
// Multi-day recovery
// ---------------------------------------------------------------------------

/**
 * Carry-over into the next race day.
 *
 * Two evidence-led choices that make this less forgiving than a naive model:
 *
 * 1. **24 h is not enough after real competition.** In lab conditions with
 *    ≥7 g/kg/day, 24 h restores glycogen fully. But after actual competition
 *    with eccentric loading, the team-sport literature consistently shows a
 *    ~27% deficit at 24 h and type II fibres still depleted at 48 h *despite*
 *    high carbohydrate intake (Krustrup 2011; Gunnarsson 2013). Off-road
 *    running with descents sits closer to that case than to cycling.
 *
 * 2. **Mental fatigue recovers even more slowly**, and this is measured in
 *    orienteers specifically: still elevated at 48 h (Lam et al. 2023).
 *
 * So Focus carries the longest shadow across a race week — which is exactly
 * right for a sport whose defining skill is cognitive.
 */
export function recoverOvernight(s: AthleteStats, recoveryQuality: number): AthleteStats {
  const q = clamp01(recoveryQuality);

  // Even perfect refuelling does not fully restore after competition.
  const glycogenCeiling = 0.82 + 0.16 * q;
  const focusCeiling = 0.74 + 0.2 * q;

  return {
    glycogen: Math.min(glycogenCeiling, s.glycogen + (0.45 + 0.4 * q)),
    hydration: Math.min(0.97, s.hydration + (0.4 + 0.45 * q)),
    bloodSugar: 0.8,
    focus: Math.min(focusCeiling, s.focus + (0.35 + 0.35 * q)),
  };
}

export function freshStats(): AthleteStats {
  return { glycogen: 1, hydration: 1, bloodSugar: 0.85, focus: 1 };
}

export function initialState(x: number, z: number, heading: number): AthleteState {
  return {
    stats: freshStats(),
    position: { x, z },
    heading,
    speed: 0,
    timeS: 0,
    believedPosition: { x, z },
    navErrorM: 0,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
