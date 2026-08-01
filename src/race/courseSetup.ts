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

import { generateCourse } from '@/sim/courseGen';
import type { Course, Control, Discipline, VenueAnchor, World2 } from '@/core/types';
import { dist2 } from '@/core/geo';
import type { FieldTerrain } from './terrainAdapter';

export interface CourseSetupResult {
  course: Course;
  /** Diagnostics, surfaced in the debug overlay rather than swallowed. */
  seedsTried: number;
  droppedControls: number;
  reachableFraction: number;
}

/** How many seeds to try before accepting an edited course. */
const MAX_SEEDS = 10;

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

  let best: { course: Course; missing: number } | null = null;
  let complete: Course | null = null;

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
      // Normally the first workable seed is the answer: `generateCourse` has
      // already aimed at the right length for the discipline and second-
      // guessing it would only inflate the course.
      //
      // The exception is terrain that fights the generator. Krumlov's reachable
      // ground is a third of its own map, and there the seeds differ enormously
      // in how much of it they use — the first workable one gave 7 controls
      // over 1.4 km, the best of ten gives 13 over 2.7 km. So: accept the first
      // course that is a race, and go shopping only when it is not.
      if (course.controls.length >= MIN_CONTROLS_FOR_A_RACE) {
        return {
          course,
          seedsTried: attempt + 1,
          droppedControls: 0,
          reachableFraction: fraction,
        };
      }
      if (
        !complete ||
        course.controls.length > complete.controls.length ||
        (course.controls.length === complete.controls.length &&
          course.lengthM > complete.lengthM)
      ) {
        complete = course;
      }
    }
    if (!best || missing < best.missing) best = { course, missing };
  }

  if (complete) {
    return {
      course: complete,
      seedsTried: MAX_SEEDS,
      droppedControls: 0,
      reachableFraction: fraction,
    };
  }

  const fallback = best!.course;
  const kept = fallback.controls.filter((c) =>
    terrain.reachableAt(c.position.x, c.position.z),
  );
  return {
    course: renumber(fallback, kept, terrain),
    seedsTried: MAX_SEEDS,
    droppedControls: fallback.controls.length - kept.length,
    reachableFraction: fraction,
  };
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
