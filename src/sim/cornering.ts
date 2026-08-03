/**
 * What a corner costs, and how long it takes to get the speed back.
 *
 * A sprint in a medieval old town is a sequence of tight corners, and the whole
 * reason route choice through an alley network is a *decision* is that corners
 * are expensive. Until this file existed the athlete held one speed regardless
 * of how sharply they were turning, which made Krumlov a shorter forest.
 *
 * Every constant below is either cited or explicitly marked as taste. The
 * split is stated once, at the bottom of this comment, so nobody has to
 * reverse-engineer which is which.
 *
 * ---------------------------------------------------------------------------
 * 1. Why the cost lands on speed and not on steering
 * ---------------------------------------------------------------------------
 * The change-of-direction literature says a single foot contact turns the
 * centre of mass by **at most ~15°** (Rovan et al.; Vanrenterghem et al., both
 * via Dos'Santos et al. 2018), so a 90° street corner genuinely takes four to
 * six steps — about a second. Implementing that as a cap on how fast the
 * player may bring the athlete round would be defensible physics and terrible
 * play: it is input lag, and this codebase has already had one movement model
 * rejected for feeling clumsy (see the header of `src/race/controls.ts`).
 *
 * So the athlete turns exactly as fast as the player asks and **pays in
 * speed**. A player who flicks 90° at racing pace gets the speed of someone
 * who planted, braked and pushed off — which is what actually happens on that
 * corner. The input is never delayed; the athlete is just slower coming out.
 *
 * ---------------------------------------------------------------------------
 * 2. Two limits, and the smaller one wins
 * ---------------------------------------------------------------------------
 * **The metabolic limit — Taboga & Kram, PeerJ 2019;7:e8222.** The only curve
 * model built for *sub-maximal distance running*, which is what an orienteer
 * is doing. Running a curve of radius `r` at speed `v` needs centripetal
 * acceleration `a = v²/r` on top of body-weight support, and the two combine
 * vectorially into an average axial leg force of
 * `F̄a = √(1 + v⁴/(g²r²)) = √(1 + (a/g)²)` body weights (their Eq 5; this is
 * also Usherwood & Wilson's "effective gravity", Biol Lett 2006;2(1):47–50,
 * and the quantity Greene's original flat-turn model was built on, J Biomech
 * Eng 1985;107(2):96–103). Their Eq 1 turns that into metabolic rate:
 * `f = 0.6234·F̄a + 0.3766`. Note the offset — only ~62% of the cost of
 * running scales with axial force, which is why a curve is expensive rather
 * than ruinous. Holding metabolic rate constant then gives the speed.
 *
 * **The biomechanical ceiling — Chang & Kram, J Exp Biol 2007;210:971–982.**
 * The metabolic model was fitted on athletics bends (r ≥ 17 m) and knows
 * nothing about a limit it never met. Extrapolated to a 2 m alley corner it
 * cheerfully returns 4.06 m/s — *faster than a trained sprinter can physically
 * run that radius*. Chang & Kram measured five sprinters at 7.70 m/s on the
 * straight and **3.77 m/s on a 2 m radius, 2.99 m/s on 1 m**, and fitted
 * `V_curve/V₀ = 0.746·(rg/V₀²)^0.363`. Their own conclusion is that the limit
 * is not a force budget — the sprinters produced *smaller* peak forces on the
 * curve — but a biomechanical threshold in the inside leg. That makes it a
 * hard ceiling rather than something you can trade metabolic rate against.
 *
 * So the athlete gets `min(metabolic, ceiling)`. Above about a 3.3 m radius
 * the metabolic term binds and the cost is gentle; below it the ceiling takes
 * over and a tight corner in a 3 m alley becomes genuinely expensive. The
 * crossover is not tuned — it is where the two published curves cross.
 *
 * ---------------------------------------------------------------------------
 * 3. Getting it back
 * ---------------------------------------------------------------------------
 * Most of what a corner actually costs is not the corner: it is the ten metres
 * afterwards spent rebuilding speed. `easeSpeed` therefore replaces the single
 * symmetric constant this simulation used to run on, which let a standing
 * athlete accelerate at ~15 m/s² and braked at the same rate.
 *
 * Acceleration follows Furusawa, Hill & Parkinson (Proc R Soc B 1927) —
 * `dv/dt = (v_top − v)/τ`, the exponential approach still used in modern
 * sprint mechanics (Samozino et al., Scand J Med Sci Sports 2016). Referencing
 * it to the athlete's *own top speed* rather than to whatever the current
 * target happens to be is the point: it is why leaving the start line is brisk
 * and why picking 4.6 m/s back up from 3.0 is not.
 *
 * Braking is a flat cap, and it is faster than acceleration because it is in
 * life: a plant-and-cut foot contact runs 0.25–0.35 s against 0.16 s on the
 * straight (Dos'Santos et al. 2018, Table 2), and eccentric braking produces
 * force a runner cannot produce concentrically.
 *
 * ---------------------------------------------------------------------------
 * 4. Cited vs taste
 * ---------------------------------------------------------------------------
 * **Cited, and checked against the source's own worked numbers:**
 * `METABOLIC_SLOPE`, `METABOLIC_OFFSET`, `VO2_SPEED_ELASTICITY` (Taboga &
 * Kram — this file returns 4.31 m/s for their 5 m/s runner on a 2 m radius,
 * against the ~4.3 m/s they publish); `CURVE_CEILING_*` (Chang & Kram's fit,
 * which reproduces their measured 2.99 / 3.77 / 4.49 / 5.07 / 5.66 m/s at
 * r = 1 / 2 / 3 / 4 / 6 m to within 0.08 m/s).
 *
 * **Taste:** `TURN_SMOOTHING_S` (its *value* is a stride datum; averaging at
 * all is a modelling choice), `MIN_SPEED_MUL`, `SPRINT_TOP_MS`, `ACCEL_TAU_S`
 * and `BRAKE_MS2` — the last three are plausible rather than measured, and
 * they are what was actually tuned by playing it.
 *
 * **Deliberately not modelled:** the metabolic side of turning. It is real —
 * Hatamoto et al. (Open Access J Sports Med 2013;4:117–122; PLOS ONE
 * 2014;9(1):e81850) measure 7–12 J/kg per 180° turn, and McNarry et al. (PLOS
 * ONE 2017;12(8):e0182333) find the cost convex in angle and near-free below
 * 45°. It is not wired into `depleteStats` because that function's `intensity`
 * input is already clamped at 1 and an orienteer on a road is already there,
 * so the term would silently do nothing. Giving it somewhere to go means
 * changing what `intensity` means, which belongs with the energy model.
 */

/** m/s². Standard gravity — what the axial-force ratio is measured against. */
const G = 9.81;

/**
 * Taboga & Kram Eq 1: metabolic rate multiplier per body weight of average
 * axial leg force. Slope and offset sum to 1 exactly, so the straight is free.
 */
const METABOLIC_SLOPE = 0.6234;
const METABOLIC_OFFSET = 0.3766;

/**
 * How much speed a given metabolic rate buys, as an elasticity.
 *
 * Taboga & Kram's Eq 8 carries the running VO₂ curve
 * `0.02724v³ + 1.7321v² − 0.4538v + 18.91` (ml/kg/min) and they solve it
 * numerically. We do not carry a cubic root-find into a per-frame path: the
 * log–log slope `d ln VO₂ / d ln v` is **1.41 at 4.6 m/s**, which is this
 * game's flat-road pace (`BASE_MS` in `src/sim/race.ts`), so holding VO₂
 * constant gives `v_curve / v_straight = f^(−1/1.41)`. Checked against the
 * exact solve of their Eq 8: 4.306 m/s against 4.309 for their worked case.
 *
 * The elasticity is not constant — ~0.95 at 3 m/s, ~1.5 at 5.5 — so fixing it
 * at race pace slightly *under*-penalises an athlete already crawling through
 * dark green. That is the right direction to be wrong in: they have paid.
 */
const VO2_SPEED_ELASTICITY = 1.41;

/**
 * Chang & Kram's fit, `V_curve/V₀ = A·(rg/V₀²)^P`, with their subjects'
 * measured straight-line top speed. Used in absolute terms — this is a ceiling
 * on what a fit human can run a given radius at, not a fraction of whatever
 * our athlete happens to be doing — and clamped at V₀, which it reaches at
 * r ≈ 13.6 m.
 */
const CURVE_CEILING_V0_MS = 7.7;
const CURVE_CEILING_A = 0.746;
const CURVE_CEILING_P = 0.363;

/**
 * Averaging window for the turn rate, seconds.
 *
 * One step. A turn is executed by foot contacts, not continuously: contact
 * time on the straight is 0.159 s and step time at 4–5 m/s is about 0.30 s
 * (Chang & Kram 2007), so 0.30 s is the shortest interval over which a
 * direction change is physically a direction change rather than a wobble.
 *
 * It earns its keep twice. The rate is averaged **signed**, so a flick left
 * and back right nets to nothing — which is also what it costs a runner, and
 * it stops mouse jitter reading as cornering. And it keeps the total turn
 * honest: an instant 90° flick has the same `∫ω dt` as a 90° arc, so it is
 * spread over a step rather than discounted.
 */
const TURN_SMOOTHING_S = 0.3;

/**
 * Floor on the speed a corner may leave the athlete, as a fraction of their
 * straight-line target.
 *
 * A sustained spin lands near 0.3 on its own, so this is not shaping the
 * mechanic — it guards against one pathological frame (a tab restored after a
 * stall, a teleport) reading as an infinite turn rate and pinning the athlete.
 */
const MIN_SPEED_MUL = 0.3;

/**
 * The asymptote of the acceleration curve, m/s. **Not a speed cap** — nothing
 * in this game reaches it, and `SPEED_BY_RUNNABILITY` decides what the athlete
 * actually runs. What it sets is how hard they push at a given speed: the
 * closer to it they already are, the less is left.
 */
const SPRINT_TOP_MS = 7.0;

/** Time constant of the Furusawa–Hill acceleration curve, seconds. */
const ACCEL_TAU_S = 1.15;

/** Braking, m/s². Flat, and faster than acceleration — see §3 above. */
const BRAKE_MS2 = 5.0;

/**
 * Average axial leg force in body weights for a given lateral acceleration.
 * Taboga & Kram Eq 5 / Usherwood & Wilson's effective gravity.
 */
export function axialForceBw(lateralMs2: number): number {
  const ratio = lateralMs2 / G;
  return Math.sqrt(1 + ratio * ratio);
}

/** Taboga & Kram Eq 1. Exactly 1.0 on the straight. */
export function metabolicMultiplier(lateralMs2: number): number {
  return METABOLIC_SLOPE * axialForceBw(lateralMs2) + METABOLIC_OFFSET;
}

/**
 * The fraction of straight-line speed a curve leaves, at constant metabolic
 * rate. Gentle at every radius a forest leg contains; the binding limit only
 * at radii a town forces.
 */
export function metabolicSpeedMultiplier(lateralMs2: number): number {
  return Math.pow(metabolicMultiplier(lateralMs2), -1 / VO2_SPEED_ELASTICITY);
}

/**
 * The fastest anybody runs a curve of this radius, m/s. Chang & Kram's fit,
 * saturating at their subjects' straight-line speed.
 */
export function curveSpeedCeiling(radiusM: number): number {
  if (!(radiusM > 0)) return 0;
  const f =
    CURVE_CEILING_A *
    Math.pow((radiusM * G) / (CURVE_CEILING_V0_MS * CURVE_CEILING_V0_MS), CURVE_CEILING_P);
  return (f >= 1 ? 1 : f) * CURVE_CEILING_V0_MS;
}

/**
 * Move the athlete's speed toward `targetMs` over `dtS`.
 *
 * Asymmetric on purpose: see §3. Never overshoots the target in either
 * direction, so a target the athlete is already holding is a no-op.
 */
export function easeSpeed(currentMs: number, targetMs: number, dtS: number): number {
  if (targetMs > currentMs) {
    const push = Math.max(0, (SPRINT_TOP_MS - currentMs) / ACCEL_TAU_S);
    return Math.min(targetMs, currentMs + push * dtS);
  }
  return Math.max(targetMs, currentMs - BRAKE_MS2 * dtS);
}

/**
 * Per-athlete cornering state: the smoothed turn rate and what it costs.
 *
 * Stateful because a turn rate is a derivative and derivatives need a previous
 * sample. Kept out of `Race` so the model can be exercised on its own, and
 * exposed on `Race` so the debug overlay and the gates can read it.
 */
export class Cornering {
  /** Smoothed rate of change of the movement heading, rad/s. Signed. */
  private rate = 0;
  private lastHeading: number | null = null;

  /** Centripetal acceleration demanded on the last step, m/s². */
  lateralMs2 = 0;
  /** Radius of the arc the athlete is currently describing, m. */
  radiusM = Infinity;
  /** What the last step's turn did to the speed target, 0..1. */
  speedMul = 1;

  /** Smoothed turn rate, rad/s. Signed; positive is toward the east. */
  get turnRate(): number {
    return this.rate;
  }

  /**
   * Advance the turn rate one step.
   *
   * @param dtS     step, seconds
   * @param heading movement heading — the direction of *travel*, not of the
   *                camera; strafing decouples them (see `src/race/controls.ts`)
   * @param speedMs the athlete's current speed. The cost of a turn scales with
   *                it, which is why pivoting on the spot is free and doing the
   *                same thing at 4.6 m/s is not.
   */
  step(dtS: number, heading: number, speedMs: number): void {
    if (dtS <= 0) return;

    if (this.lastHeading === null) {
      this.lastHeading = heading;
    } else {
      const raw = wrapPi(heading - this.lastHeading) / dtS;
      this.lastHeading = heading;
      // `1 - exp(-dt/τ)` rather than `dt/τ`, so the filter is frame-rate
      // independent: the autopilot steps at 100 ms and a phone at 16, and they
      // have to agree about what a corner costs.
      this.rate += (raw - this.rate) * (1 - Math.exp(-dtS / TURN_SMOOTHING_S));
    }

    const w = Math.abs(this.rate);
    const v = Math.max(0, speedMs);
    this.lateralMs2 = w * v;
    this.radiusM = w > 1e-3 ? v / w : Infinity;
  }

  /**
   * The speed this turn allows, given what the athlete could do on a straight.
   *
   * `min(metabolic, biomechanical ceiling)`, floored. Call after `step`.
   */
  limit(straightMs: number): number {
    if (straightMs <= 0) {
      this.speedMul = 1;
      return straightMs;
    }
    const metabolic = straightMs * metabolicSpeedMultiplier(this.lateralMs2);
    const ceiling = Number.isFinite(this.radiusM)
      ? curveSpeedCeiling(this.radiusM)
      : Infinity;
    const allowed = Math.max(straightMs * MIN_SPEED_MUL, Math.min(metabolic, ceiling));
    this.speedMul = allowed / straightMs;
    return allowed;
  }

  /** Forget the history. Used when the athlete is placed rather than moved. */
  reset(): void {
    this.rate = 0;
    this.lastHeading = null;
    this.lateralMs2 = 0;
    this.radiusM = Infinity;
    this.speedMul = 1;
  }
}

/** Normalise to (−π, π], so a turn takes the short way round. */
function wrapPi(rad: number): number {
  let r = rad % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}
