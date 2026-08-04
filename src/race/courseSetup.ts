/**
 * Course setting against real ground, with the one guarantee `generateCourse`
 * cannot make on its own: **the course can actually be run.**
 *
 * `src/sim/courseGen.ts` is a good course setter — varied legs, real route
 * choice, controls on describable features, no dog-legs — and it is calibrated
 * and tested, so it is not touched. What it does not model is connectivity: it
 * checks that a site is not *in* impassable ground, not that a runner can get
 * there. In the forest those are almost the same statement. In Český Krumlov
 * they are not remotely the same statement, and a course with an unreachable
 * finish is not a race.
 *
 * So this is a thin wrapper: generate, check every point against the arena's
 * connected component, and if the seed produced a broken course, try the next
 * one. Only if a run of seeds all fail does it fall back to editing a course —
 * dropping the controls it cannot reach, which is what a setter does when the
 * terrain refuses.
 */

import { arenaFaults, courseLengthBand, generateCourse, MAX_LEG_DETOUR } from '@/sim/courseGen';
import { siteRefreshments } from '@/sim/refreshment';
import type { Course, Control, Discipline, VenueAnchor, World2 } from '@/core/types';
import { dist2 } from '@/core/geo';
import type { FieldTerrain } from './terrainAdapter';

export interface CourseSetupResult {
  course: Course;
  /** Diagnostics, surfaced in the debug overlay rather than swallowed. */
  seedsTried: number;
  droppedControls: number;
  reachableFraction: number;
  /**
   * The smallest escape area found under any sited point, m², measured with the
   * runtime's own collision. `Infinity` when every point opened onto more than
   * the cap. Reported rather than swallowed: it is the number that says whether
   * the course can strand a player, and the next report should not need a
   * bisect to find it.
   */
  tightestEscapeM2: number;
  /**
   * Metres from each control to the nearest runnable paved way, in course
   * order. Empty where the terrain has no street network to measure against.
   *
   * The number that says whether this is a sprint through a street network or a
   * cross-country run past a castle, and it is reported rather than merely
   * asserted: the client's complaint was a distribution, not a single failure.
   */
  pavedDistanceM: number[];
  /**
   * What is wrong with the arena, if anything — start and finish too close, a
   * first leg pointing back through the run-in, a leg passing the finish. Empty
   * on every course this function is willing to offer, and reported rather than
   * swallowed for the same reason `tightestEscapeM2` is: when it is not empty,
   * the terrain refused every seed and somebody should be able to see that
   * without a bisect.
   */
  arenaFaults: string[];
  /**
   * The length band this setup shopped against, metres — `courseLengthBand` for
   * the discipline and venue.
   *
   * Reported for `tools/ci/check-race.mjs`, and it is deliberately *not* the
   * number that gate asserts lengths against. That gate states the sport's
   * figures independently, because reading the build's own target back out of
   * the build would leave it unable to catch the regression it exists for — a
   * sprint aimed at 3.4 km passes any check derived from the 3.4 km.
   *
   * What it does with this is the other half: assert that the band the setter
   * *accepts* sits inside the band the gate *allows*. A setter whose acceptance
   * test is looser than the judge's is not a setter — it shops for courses that
   * will be refused downstream — and until this was surfaced the two edges were
   * kept in step by hand, which is how the low edge came to be 1125 m against a
   * gate floor of 1200.
   */
  lengthBandM: { min: number; max: number };
  /**
   * What the course looks like **on the street graph it was set on**.
   *
   * Reported rather than only asserted, for the reason every other number in
   * this interface is: PLAN-KRUMLOV-V2 §3 says the detour ratio should be known
   * *while the course is being set* instead of audited afterwards, and a
   * quantity that is known and not printed is a quantity nobody can check
   * without a bisect. `null` for a venue with no network — the forest.
   *
   *  - `legDetourM` — routed metres over straight metres, per leg, start→1
   *    first and the run-in last.
   *  - `limit` — the ceiling the setter applied. `tools/ci/check-race.mjs`
   *    asserts this is not looser than the one the gate applies, which is the
   *    containment `lengthBandM` above exists to state for lengths.
   *  - `offNetworkM` — how far the start and the finish ended up from a way a
   *    control may hang on. Fault 8's own measurement.
   *  - `startRunOutM` — metres of clear straight running out of the start
   *    toward control 1, capped. *"You run out and there's a wall straight
   *    away"* is this number being small.
   */
  street: {
    legDetour: number[];
    limit: number;
    offNetworkM: { start: number; finish: number };
    startRunOutM: number;
  } | null;
  /**
   * What setting the course cost, milliseconds.
   *
   * **Deliberately not in `FieldTerrain.costMs`.** That record is the
   * venue-wide passes over the model, and `check-passable` budgets their *sum*
   * at 250 ms as a tripwire for a sweep coming back (phase 0). Course setting
   * is not one of those and never was; folding it in there made the tripwire
   * fire on a cost that has always been paid and had simply never been looked
   * at — which is the wrong end of the same failure, a measure that is right
   * about what it measures and silent about what it does not.
   *
   * So it is measured here, where it happens, and reported for
   * `tools/perf/setup-cost.mjs` to print at the phone throttle. It is the
   * largest single thing opening a Krumlov race spends time on.
   */
  setupMs: number;
}

/** How many seeds to try before accepting an edited course. */
const MAX_SEEDS = 10;

/**
 * How much ground a sited point must open onto, m².
 *
 * This is the enclosure guarantee, and it is stated as an **area** rather than
 * as "is it in the arena's component" on purpose. Component membership is a
 * property of a mask; area is the player's own question — *"we were locked in
 * some little park on the grass"* is a statement about how much ground there
 * was, and a pocket can be perfectly connected on a 1 m grid and still be a
 * courtyard you cannot leave once the continuous collider has its say.
 *
 * 3 000 m² against an arena component of 104 ha is not a close call in either
 * direction: no legitimate Krumlov control site is enclosed by less (the
 * tightest measured is unbounded — every one opens onto the whole town), and
 * the pocket the `low` tier once sealed the athlete into around Náměstí
 * Svornosti was exactly 3 000 m². The cap also bounds the work: the flood stops
 * at 12 000 cells whatever the venue looks like.
 */
const MIN_ESCAPE_M2 = 3_000;

/**
 * Below this a course is not a race, whatever its length.
 *
 * The shortest World Cup format is a sprint at 14–20 controls; eight is well
 * under any of them and is the point at which it is worth spending nine more
 * generations looking for terrain that cooperates.
 */
const MIN_CONTROLS_FOR_A_RACE = 8;

export function setCourse(
  terrain: FieldTerrain,
  o: { venue: VenueAnchor; discipline: Discipline; seed: number; arena: World2 },
): CourseSetupResult {
  const t0 = now();
  const { fraction } = terrain.buildReachability(o.arena);
  const band = courseLengthBand(o.discipline, o.venue);

  let best: { course: Course; missing: number } | null = null;
  let complete: { course: Course; escape: number } | null = null;

  /**
   * The arena, re-checked on the course that ships rather than trusted.
   *
   * `generateCourse` sites the finish first and the start against it, so the
   * separation, the first leg's bearing and the clearance round the finish hold
   * when it hands the course over. Then the two lines below pull both points
   * onto the arena's connected component, which can move them — and a start
   * dragged 200 m to get out of a courtyard is a start that may now be next to
   * the finish. So the property is asserted where it has to be true.
   */
  const arenaOf = (c: Course): string[] => arenaFaults(c, o.discipline, o.venue);

  for (let attempt = 0; attempt < MAX_SEEDS; attempt++) {
    const seed = (o.seed + attempt * 7919) | 0;
    const raw = generateCourse({ ...o, seed, terrain });

    // The start and finish come from `findControlSite`, which returns the best
    // of its samples even when every sample scored zero — so unlike the
    // controls they are not filtered by reachability and have to be pulled back
    // onto the component by hand.
    const course: Course = {
      ...raw,
      start: terrain.nearestReachable(raw.start),
      finish: terrain.nearestReachable(raw.finish),
    };

    const missing = course.controls.filter(
      (c) => !terrain.reachableAt(c.position.x, c.position.z),
    ).length;

    if (missing === 0 && terrain.reachableAt(course.start.x, course.start.z)) {
      // **Generate against the runtime, not against the raster.**
      //
      // Being in the arena's component is a claim about a 1 m mask. Being able
      // to leave is a claim about the collider that actually stops the player,
      // and it is the claim that matters: four separate reports of "we are
      // stuck" in this venue have each had a different real cause, and what
      // they had in common is that every mask-shaped check was green. So every
      // point the athlete is *placed* on — start, controls, finish — is flooded
      // with the runtime's own collision, and a course with any point that
      // cannot get out is not offered to the player at all.
      const escape = tightestEscape(terrain, course);
      if (escape >= MIN_ESCAPE_M2) {
        // Normally the first workable seed is the answer. Two things make it
        // worth looking at another: too few controls to be a race, and a length
        // outside the band the discipline is specified at — a 2.4 km sprint is
        // a 20-minute winning time and reads wrong on the description sheet
        // before the runner has taken a step. Both are cheap to check and most
        // seeds satisfy both first time.
        const enough = course.controls.length >= MIN_CONTROLS_FOR_A_RACE;
        const inBand = course.lengthM >= band.min && course.lengthM <= band.max;
        const arena = arenaOf(course);
        if (enough && inBand && arena.length === 0) {
          return {
            course,
            seedsTried: attempt + 1,
            droppedControls: 0,
            reachableFraction: fraction,
            tightestEscapeM2: escape,
            pavedDistanceM: pavedDistances(terrain, course),
            arenaFaults: arena,
            lengthBandM: band,
            street: streetReport(terrain, course),
            setupMs: now() - t0,
          };
        }
        // Keep the best runner-up: a sound arena first, then enough controls,
        // then closest to the middle of the band. Arena first because the other
        // two are matters of degree — a 1.3 km sprint is a short sprint — and a
        // start you can see the finish from is not a race at all.
        const mid = (band.min + band.max) / 2;
        const soundNow = arena.length === 0;
        const soundBefore = complete ? arenaOf(complete.course).length === 0 : false;
        const better =
          !complete ||
          (soundNow && !soundBefore) ||
          (soundNow === soundBefore &&
            ((complete.course.controls.length < MIN_CONTROLS_FOR_A_RACE && enough) ||
              (complete.course.controls.length >= MIN_CONTROLS_FOR_A_RACE === enough &&
                Math.abs(course.lengthM - mid) < Math.abs(complete.course.lengthM - mid))));
        if (better) complete = { course, escape };
      }
    }
    if (!best || missing < best.missing) best = { course, missing };
  }

  if (complete) {
    return {
      course: complete.course,
      seedsTried: MAX_SEEDS,
      droppedControls: 0,
      reachableFraction: fraction,
      tightestEscapeM2: complete.escape,
      pavedDistanceM: pavedDistances(terrain, complete.course),
      arenaFaults: arenaOf(complete.course),
      lengthBandM: band,
      street: streetReport(terrain, complete.course),
      setupMs: now() - t0,
    };
  }

  const fallback = best!.course;
  const kept = fallback.controls.filter((c) =>
    terrain.reachableAt(c.position.x, c.position.z),
  );
  const edited = renumber(fallback, kept, terrain);
  return {
    course: edited,
    seedsTried: MAX_SEEDS,
    droppedControls: fallback.controls.length - kept.length,
    reachableFraction: fraction,
    tightestEscapeM2: tightestEscape(terrain, edited),
    pavedDistanceM: pavedDistances(terrain, edited),
    arenaFaults: arenaOf(edited),
    lengthBandM: band,
    street: streetReport(terrain, edited),
    setupMs: now() - t0,
  };
}

/**
 * The course as the graph sees it — the numbers §3 says should be known while
 * the course is being set, read back off the course that was.
 *
 * Costs one Dijkstra a leg on a 1 900-node graph, which is a quarter of a
 * millisecond each and is the same measurement the setter has already made;
 * making it again on the *finished* course is the point, because `setCourse`
 * moves the start and the finish after `generateCourse` has handed them over.
 */
function streetReport(terrain: FieldTerrain, course: Course): CourseSetupResult['street'] {
  const net = terrain.network;
  if (!net) return null;
  const points = [course.start, ...course.controls.map((c) => c.position), course.finish];
  const legDetour: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const field = net.fieldFrom(points[i]!);
    const routed = field ? field(points[i + 1]!) : Infinity;
    const straight = dist2(points[i]!, points[i + 1]!);
    legDetour.push(
      Number.isFinite(routed) && straight > 0
        ? Math.round(Math.max(1, routed / straight) * 100) / 100
        : Infinity,
    );
  }
  const first = course.controls[0]?.position ?? course.finish;
  return {
    legDetour,
    limit: MAX_LEG_DETOUR,
    offNetworkM: {
      start: Math.round(net.offNetworkM(course.start) * 10) / 10,
      finish: Math.round(net.offNetworkM(course.finish) * 10) / 10,
    },
    startRunOutM: Math.round(runOutM(terrain, course.start, first) * 10) / 10,
  };
}

/**
 * Metres of clear straight running from the start toward the first control,
 * capped at `RUN_OUT_CAP_M`.
 *
 * The same measurement `pickNextControl` makes while choosing leg 1, made again
 * on the course that ships. Capped because the answer wanted is "is there a
 * run-out", not "how long is this street".
 */
const RUN_OUT_CAP_M = 60;

function runOutM(terrain: FieldTerrain, from: World2, toward: World2): number {
  const total = dist2(from, toward);
  if (total < 1e-6) return 0;
  const reach = Math.min(RUN_OUT_CAP_M, total);
  const ux = (toward.x - from.x) / total;
  const uz = (toward.z - from.z) / total;
  for (let d = 0.5; d <= reach; d += 0.5) {
    if (terrain.blockedAt(from.x + ux * d, from.z + uz * d)) return d - 0.5;
  }
  return reach;
}

/** `performance.now`, and `Date.now` where there is none (the Node harnesses). */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** How far each control sits from the street network, metres. */
function pavedDistances(terrain: FieldTerrain, course: Course): number[] {
  return course.controls
    .map((c) => terrain.pavedDistanceAt(c.position.x, c.position.z))
    .filter((d) => Number.isFinite(d))
    .map((d) => Math.round(d * 10) / 10);
}

/**
 * The smallest ground any sited point opens onto, m².
 *
 * `Infinity` when every point escaped the cap, which is the normal answer and
 * the one that says the course cannot strand anybody.
 */
function tightestEscape(terrain: FieldTerrain, course: Course): number {
  let worst = Infinity;
  const points = [course.start, ...course.controls.map((c) => c.position), course.finish];
  for (const p of points) {
    const { m2, sealed } = terrain.escapeAreaM2(p, MIN_ESCAPE_M2);
    if (!sealed) continue;
    if (m2 < worst) worst = m2;
  }
  return worst;
}

/**
 * Rebuild a course around a reduced control set.
 *
 * Ids and column A must stay dense and in order — an orienteer reads "3/12" off
 * the description sheet and a gap in it is a printing error. Length and climb
 * are re-measured because they are printed on the sheet too and a stale figure
 * is worse than none.
 */
function renumber(course: Course, kept: Control[], terrain: FieldTerrain): Course {
  const controls: Control[] = kept.map((c, i) => ({
    ...c,
    id: `c${i + 1}`,
    description: { ...c.description, a: i + 1 },
  }));

  const points = [course.start, ...controls.map((c) => c.position), course.finish];
  let lengthM = 0;
  let climbM = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    lengthM += dist2(a, b);
    const steps = Math.max(4, Math.round(dist2(a, b) / 25));
    let prev = terrain.heightAt(a.x, a.z);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const h = terrain.heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (h > prev) climbM += h - prev;
      prev = h;
    }
  }

  const next: Course = {
    ...course,
    controls,
    lengthM: Math.round(lengthM),
    // Rounded to 5 m, as printed on a control description sheet.
    climbM: Math.round(climbM / 5) * 5,
    refreshments: [],
  };

  // Dropping unreachable controls renumbers the course and moves every
  // percentage along it, so the Rule 19.8 siting has to be recomputed rather
  // than carried over — a station indexed at old control 9 is not the same
  // place, or even the same control, once three have gone.
  next.refreshments = siteRefreshments(next);
  return next;
}
