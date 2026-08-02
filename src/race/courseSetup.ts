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

import { courseLengthBand, generateCourse } from '@/sim/courseGen';
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
  const { fraction } = terrain.buildReachability(o.arena);
  const band = courseLengthBand(o.discipline, o.venue);

  let best: { course: Course; missing: number } | null = null;
  let complete: { course: Course; escape: number } | null = null;

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
        if (enough && inBand) {
          return {
            course,
            seedsTried: attempt + 1,
            droppedControls: 0,
            reachableFraction: fraction,
            tightestEscapeM2: escape,
            pavedDistanceM: pavedDistances(terrain, course),
          };
        }
        // Keep the best runner-up: enough controls first, then closest to the
        // middle of the band.
        const mid = (band.min + band.max) / 2;
        const better =
          !complete ||
          (complete.course.controls.length < MIN_CONTROLS_FOR_A_RACE && enough) ||
          (complete.course.controls.length >= MIN_CONTROLS_FOR_A_RACE === enough &&
            Math.abs(course.lengthM - mid) < Math.abs(complete.course.lengthM - mid));
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
  };
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

  return {
    ...course,
    controls,
    lengthM: Math.round(lengthM),
    // Rounded to 5 m, as printed on a control description sheet.
    climbM: Math.round(climbM / 5) * 5,
  };
}
