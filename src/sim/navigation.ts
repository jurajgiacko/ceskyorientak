/**
 * Dead reckoning — the heart of the game.
 *
 * There is no GPS dot. The map shows where the athlete *believes* they are,
 * and that belief drifts. Punching a control snaps it back to truth, and that
 * snap is the relocation dopamine hit the whole design is built around.
 *
 * The model is not "add random noise to a known position". It simulates the
 * two errors an orienteer actually makes:
 *
 *   - **Distance error** — you misjudge how far you have run. Systematic, not
 *     symmetric: under fatigue people consistently *over*-estimate distance
 *     covered, so the believed position runs ahead of the true one.
 *   - **Bearing error** — you drift off your compass line. Slow, correlated
 *     drift rather than per-frame jitter, because a person does not
 *     re-randomise their heading sixty times a second.
 *
 * Both grow with speed and shrink with map contact. That is the real tension:
 * run fast and lose contact, run slow and read perfectly.
 *
 * Calibration: see docs/RESEARCH-SPORT.md §6. Terminology note — a *leg* is
 * `úsek`, a *route* is `postup`; the parallel error is `paralelní chyba`.
 */

import type { AthleteStats, World2 } from '@/core/types';
import { navigationQuality, navErrorGrowth, parallelErrorRate } from './athlete';
import { bearing, dist2, wrapAngle } from '@/core/geo';

/**
 * Drift constants, tuned by simulation (`tools/sim/nav-check.mjs`) so that the
 * resulting errors match what real orienteers accumulate:
 *
 *   fresh, regular map contact, 500 m leg   → ~10–15 m
 *   fresh, no map contact, 500 m leg        → ~25–40 m
 *   tired, no map contact, 500 m leg        → ~60–100 m
 *
 * These are the numbers that make attack points, aiming off and catching
 * features *necessary* rather than decorative. Get them too small and the game
 * has no navigation problem; too large and careful play stops being rewarded.
 *
 * Units are per √second, because they drive a random walk.
 */
const BEARING_DRIFT = 1.9;
const DISTANCE_DRIFT = 0.55;
/** Per second, one-directional: fatigue makes you overestimate distance run. */
const DISTANCE_BIAS = 0.0016;

/** A seeded RNG so a given course plays identically for every player. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    // Avoid the degenerate zero state.
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  /** xorshift32 — cheap, adequate, and deterministic across platforms. */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  /** Symmetric in [-1, 1]. */
  signed(): number {
    return this.next() * 2 - 1;
  }
  /** Approximately standard normal, via the central limit theorem. */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.2;
  }
}

export interface NavState {
  /** What the player thinks their position is — this is what the map draws. */
  believed: World2;
  /** Slowly-varying bearing drift, radians. */
  bearingBias: number;
  /** Slowly-varying distance scale error. 1.0 = accurate. */
  distanceScale: number;
  /** True while a parallel error is active — the athlete is confidently wrong. */
  parallelError: ParallelError | null;
  /** Seconds since the last map read. */
  sinceMapContact: number;
}

/**
 * A parallel error: the athlete has matched the terrain to the *wrong* feature
 * on the map, and everything is consistent from their point of view.
 *
 * This is the classic orienteering mistake and the reason it is so
 * devastating: you are not lost, you are confident. It only resolves when
 * something contradicts the story — a punch, or a feature that cannot be
 * explained away.
 */
export interface ParallelError {
  /** Offset applied to the believed position, metres. Roughly constant. */
  offset: World2;
  /** How long it has been running, seconds. */
  ageS: number;
}

export function initNav(start: World2): NavState {
  return {
    believed: { x: start.x, z: start.z },
    bearingBias: 0,
    distanceScale: 1,
    parallelError: null,
    sinceMapContact: 0,
  };
}

export interface NavStepInput {
  /** True position after movement this frame. */
  truePos: World2;
  /** Distance actually moved this frame, metres. */
  movedM: number;
  /** Direction actually moved, radians. */
  movedHeading: number;
  speedMs: number;
  stats: AthleteStats;
  /**
   * Terrain complexity 0..1 — how hard this ground is to keep contact with.
   * Featureless flat forest is high; a path junction is low.
   */
  complexity: number;
  /**
   * Ambiguity 0..1 — how many similar features are nearby. This, not
   * complexity, drives parallel errors: five identical re-entrants is the
   * classic trap.
   */
  ambiguity: number;
  /** True while the player is actively reading the map this frame. */
  readingMap: boolean;
  dtS: number;
  rng: Rng;
}

/**
 * Advance the athlete's *belief* about their position.
 *
 * Note the believed position is integrated from the athlete's own perceived
 * motion, never from the true position plus an error term. That distinction
 * matters: errors compound along the route the way real ones do, so a long leg
 * without map contact ends far off, while a short one barely drifts.
 */
export function stepNav(nav: NavState, i: NavStepInput): void {
  const q = navigationQuality(i.stats);

  if (i.readingMap) {
    // Map contact corrects the accumulated bias, but never instantly and never
    // completely — you are matching terrain to a map, not consulting an oracle.
    // How well it works depends on Focus, which is the point of the stat.
    const correction = 0.25 + 0.35 * q;
    nav.bearingBias *= 1 - correction;
    nav.distanceScale += (1 - nav.distanceScale) * correction;
    nav.sinceMapContact = 0;

    // A read also introduces its own small error: you are identifying your
    // position against terrain features, and that identification is itself
    // imprecise. Without this the model drives error to nearly zero under
    // frequent reading, which is wrong — even an elite orienteer in constant
    // map contact carries something like 10 m of positional uncertainty.
    const readErrorM = (1 - q) * 6 + 2;
    nav.believed.x += i.rng.normal() * readErrorM * 0.4;
    nav.believed.z += i.rng.normal() * readErrorM * 0.4;

    // Good map contact can also break a parallel error — you notice the
    // feature that does not fit. Poor contact confirms it instead.
    if (nav.parallelError && i.rng.next() < q * 0.35 * i.dtS) {
      nav.parallelError = null;
    }
  } else {
    nav.sinceMapContact += i.dtS;
  }

  // --- drift accumulation -------------------------------------------------
  // Correlated random walk, not per-frame jitter: a person holds a slightly
  // wrong bearing for a while rather than re-randomising continuously.
  //
  // Noise scales with sqrt(dt), NOT dt. A random walk's variance grows
  // linearly in time, so scaling the per-step noise by dt would make the total
  // accumulated error depend on the frame rate — a player on a 30 fps phone
  // would navigate measurably better than one on a 120 Hz desktop.
  const sqrtDt = Math.sqrt(i.dtS);
  const growth = navErrorGrowth(i.stats, i.speedMs, i.complexity);

  // Calibrated against how accurately people actually hold a bearing: a skilled
  // orienteer keeps to roughly ±3°, a tired or careless one ±8–10°. Over a
  // 500 m leg 3° is about 26 m of lateral error, which is exactly why attack
  // points and aiming off exist as techniques.
  nav.bearingBias = wrapAngle(nav.bearingBias + i.rng.normal() * growth * BEARING_DRIFT * sqrtDt);

  // Distance error is biased, not symmetric: fatigue makes people overestimate
  // ground covered, so the believed position tends to run ahead of the truth.
  // Typical pacing accuracy is ±5% fresh, worse tired.
  const fatigue = 1 - i.stats.glycogen;
  nav.distanceScale +=
    i.rng.normal() * growth * DISTANCE_DRIFT * sqrtDt + DISTANCE_BIAS * fatigue * i.dtS;
  nav.distanceScale = Math.max(0.85, Math.min(1.15, nav.distanceScale));

  // --- integrate the believed position ------------------------------------
  const perceivedHeading = i.movedHeading + nav.bearingBias;
  const perceivedDist = i.movedM * nav.distanceScale;
  nav.believed.x += Math.sin(perceivedHeading) * perceivedDist;
  nav.believed.z -= Math.cos(perceivedHeading) * perceivedDist;

  // --- parallel error -----------------------------------------------------
  if (nav.parallelError) {
    nav.parallelError.ageS += i.dtS;
  } else if (i.ambiguity > 0 && !i.readingMap) {
    const rate = parallelErrorRate(i.stats, i.ambiguity);
    if (i.rng.next() < rate * i.dtS) {
      // Snap the belief onto a plausible neighbouring feature. The offset is
      // roughly perpendicular to travel, because that is how parallel features
      // are arranged — a line of re-entrants along a hillside.
      const perp = i.movedHeading + (i.rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
      const mag = 40 + i.rng.next() * 90;
      nav.parallelError = {
        offset: { x: Math.sin(perp) * mag, z: -Math.cos(perp) * mag },
        ageS: 0,
      };
      nav.believed.x += nav.parallelError.offset.x;
      nav.believed.z += nav.parallelError.offset.z;
    }
  }

  void i.truePos;
}

/**
 * Punch a control: the belief snaps to truth.
 *
 * Everything resets — bias, scale, and any parallel error. This is the moment
 * the game is built around, so it is deliberately total rather than partial.
 */
export function punchRelocate(nav: NavState, truth: World2): { correctedM: number } {
  const correctedM = dist2(nav.believed, truth);
  nav.believed.x = truth.x;
  nav.believed.z = truth.z;
  nav.bearingBias = 0;
  nav.distanceScale = 1;
  nav.parallelError = null;
  nav.sinceMapContact = 0;
  return { correctedM };
}

/**
 * Deliberate relocation: the athlete stops, works out where they are from the
 * terrain, and re-establishes contact. Costs time, and succeeds partially —
 * how partially depends on Focus and on how distinctive the surroundings are.
 */
export function relocate(
  nav: NavState,
  truth: World2,
  stats: AthleteStats,
  distinctiveness: number,
  rng: Rng,
): { success: boolean; residualM: number } {
  const q = navigationQuality(stats);
  const chance = 0.25 + 0.5 * q + 0.25 * distinctiveness;

  if (rng.next() > chance) {
    // Failed relocation makes things worse — you have now convinced yourself
    // of a second wrong story.
    nav.bearingBias = wrapAngle(nav.bearingBias + rng.signed() * 0.3);
    return { success: false, residualM: dist2(nav.believed, truth) };
  }

  // Success lands you near, not exactly on, the truth.
  const residual = (1 - q) * 30 * rng.next();
  const dir = rng.next() * Math.PI * 2;
  nav.believed.x = truth.x + Math.sin(dir) * residual;
  nav.believed.z = truth.z - Math.cos(dir) * residual;
  nav.bearingBias *= 0.2;
  nav.distanceScale = 1;
  nav.parallelError = null;
  return { success: true, residualM: residual };
}

/** Current error magnitude in metres — for the HUD and post-race analysis. */
export function navError(nav: NavState, truth: World2): number {
  return dist2(nav.believed, truth);
}

/**
 * Compass bearing the athlete would read toward a target, from their *believed*
 * position — including their bearing bias.
 *
 * This is why a compass does not rescue you: it is accurate about direction and
 * says nothing about where you are starting from.
 */
export function believedBearingTo(nav: NavState, target: World2): number {
  return wrapAngle(bearing(nav.believed, target) - nav.bearingBias);
}
