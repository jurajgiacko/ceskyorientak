/**
 * Course generation.
 *
 * A course is not a random walk between points. Course setting is a craft with
 * rules, and an orienteer reads a bad course immediately — Judge O will check
 * for real route-choice legs and for whether a "Long" is actually long.
 *
 * The principles implemented here come from `docs/RESEARCH-SPORT.md` §7:
 *
 *  - **Legs must vary in length and direction.** A course of equal-length legs
 *    all heading the same way is the classic beginner's mistake.
 *  - **Direction changes at controls.** Leaving a control on the same bearing
 *    you arrived is dull and makes the control pointless.
 *  - **Route choice is the point of a Long leg.** A leg is only interesting if
 *    going around is genuinely competitive with going straight — that requires
 *    something in the way worth avoiding.
 *  - **The control must sit on a describable feature**, not in the middle of a
 *    featureless slope. This is what makes column D possible at all.
 *  - **No dog-legs.** Arriving and leaving on nearly the same line lets
 *    following runners see the control, which the rules discourage.
 *
 * Everything is seeded, so a given seed produces an identical course for every
 * player — which is what makes the daily challenge fair.
 */

import type { Course, Control, Discipline, World2, VenueAnchor } from '@/core/types';
import { Runnability } from '@/core/types';
import { Rng } from './navigation';
import { bearing, dist2, wrapAngle } from '@/core/geo';
import { COST_BY_RUNNABILITY, SPEED_BY_RUNNABILITY, TYPICAL_DURATION_S } from './athlete';

/**
 * What a control turned out to be sited on, in IOF column D/G terms.
 *
 * The terrain layer knows this and the generator does not: in a town a control
 * sits on a building corner or the foot of a stairway, and only the thing
 * holding the townscape can say which. See `FieldTerrain.siteAt`.
 */
export interface ControlSite {
  /** Column D symbol key — one of `COLUMN_D` in `src/map/pictograms.ts`. */
  d: string;
  /** Column G, where the feature has a describable part (`foot`, `top`). */
  g?: string;
}

/** What the generator needs to know about the ground. */
export interface CourseTerrain {
  runnabilityAt(x: number, z: number): Runnability;
  heightAt(x: number, z: number): number;
  /**
   * How describable the point is as a control site, 0..1. Derived from local
   * relief and class transitions — a knoll, a re-entrant head or a boulder
   * scores high; the middle of a flat white slope scores near zero. In a town
   * it is derived from the man-made feature set instead; see
   * `FieldTerrain.urbanScore`.
   */
  featureScoreAt(x: number, z: number): number;
  /**
   * What the site is, when the terrain can name it. Optional: a forest terrain
   * has no building corners and `describeControl` falls back to landform
   * vocabulary, which is the right vocabulary there.
   */
  siteAt?(x: number, z: number): ControlSite | null;
}

/** Target shape per discipline. Winning times are the IOF-specified quantity. */
interface Spec {
  legCount: [min: number, max: number];
  /** Straight-line course length, metres. */
  targetLengthM: number;
  minLegM: number;
  maxLegM: number;
  /**
   * Climb as a fraction of course length, the quantity course setters actually
   * work to. Roughly 4% for a forest course; a sprint is essentially flat.
   *
   * This is not cosmetic. Without it the generator produced a Long with 935 m
   * of climb over 11.2 km — 8.4%, about double what anyone sets — because
   * siting controls on distinctive features preferentially picks knolls and
   * spur ends, and stringing those together walks you over every high point on
   * the map. An orienteer reads that number off the description sheet before
   * they start and would know immediately that it was wrong.
   */
  climbRatio: number;
  /**
   * Minimum distance between any two controls, metres.
   *
   * A map-scale quantity, not a taste one. At 1:10000 an ISOM control circle is
   * 5 mm across — 50 m on the ground — so anything under ~90 m produces
   * visibly overlapping circles in the forest. At 1:4000 the same 5 mm is 20 m,
   * and IOF's rule for a sprint is 25 m between controls (30 m where the
   * features are similar). Carrying the forest's 110 m into a sprint is not
   * conservatism: with a 1.75 km course and fifteen controls the average leg is
   * 115 m, so a 110 m separation floor makes the course arithmetically
   * impossible and the generator quietly returns six controls instead.
   */
  minSeparationM: number;
  /**
   * How finely `routeCost` samples a leg, metres.
   *
   * In the forest 25 m is plenty — the classes change slowly. In a town it is
   * useless: Krumlov's blocks are 20–30 m across, so a coarse sample walks
   * straight through a building and reports the direct line as cheap, which is
   * exactly the opposite of the truth and destroys the route-choice score the
   * whole leg is chosen for.
   */
  routeStepM: number;
  /**
   * How far a single leg may overshoot the remaining climb budget, metres.
   *
   * The budget is a whole-course quantity and legs are placed one at a time, so
   * without a per-leg ceiling one leg over the castle rock spends the lot. 45 m
   * is right for a forest course with a 170 m allowance; on a sprint with a
   * 20 m allowance it is not a ceiling at all, and Krumlov duly produced 90 m
   * of climb over 2 km — 4.5%, four times what a sprint is set to.
   */
  maxLegClimbOverM: number;
}

function specFor(d: Discipline, anchor: VenueAnchor): Spec {
  const extent = Math.min(anchor.sizeX, anchor.sizeZ);
  switch (d) {
    case 'sprint':
      // A real sprint is 1.5–2.0 km of straight-line course for a 13–15 minute
      // winning time (IOF Competition Rules, appendix 2; RESEARCH-SPORT §7.2).
      //
      // The 3.4 km that used to be here is a *forest* number. At sprint pace —
      // call it 4 min/km on paved streets with the turns and the map reading —
      // 3.4 km is a 20-minute winner, and it forced the generator to spend the
      // course somewhere: Krumlov's old town is about 500 m across, so the only
      // way to lay out 3.4 km of legs was to leave it, run up the river and
      // out into the meadows. That is the run the client played and rightly
      // complained about. Fix the target and the course stays in the streets on
      // its own.
      return {
        legCount: [14, 20],
        targetLengthM: 1500,
        minLegM: 55,
        maxLegM: 190,
        climbRatio: 0.012,
        minSeparationM: 45,
        routeStepM: 2.5,
        maxLegClimbOverM: 7,
      };
    case 'middle':
      // ~30–35 min, constant direction change, technically demanding.
      return {
        legCount: [12, 16],
        targetLengthM: 4300,
        minLegM: 150,
        maxLegM: 550,
        climbRatio: 0.04,
        minSeparationM: 110,
        routeStepM: 25,
        maxLegClimbOverM: 45,
      };
    case 'long':
      // ~90 min, route choice, long legs. Capped by the venue we actually have.
      return {
        legCount: [10, 14],
        targetLengthM: Math.min(9000, extent * 4.5),
        minLegM: 300,
        maxLegM: Math.min(1400, extent * 0.7),
        climbRatio: 0.04,
        minSeparationM: 110,
        routeStepM: 25,
        maxLegClimbOverM: 45,
      };
    default:
      return {
        legCount: [12, 16],
        targetLengthM: 4300,
        minLegM: 150,
        maxLegM: 550,
        climbRatio: 0.04,
        minSeparationM: 110,
        routeStepM: 25,
        maxLegClimbOverM: 45,
      };
  }
}

/**
 * The straight-line length a finished course of this discipline should land in,
 * metres.
 *
 * Exported because `setCourse` shops between seeds and needs to know what it is
 * shopping for, and because `tools/ci/check-race.mjs` asserts on it: the band
 * and the target must come from the same place or the gate is checking a number
 * nobody is aiming at.
 *
 * The width is the terrain's, not the sport's. A sprint is *specified* at
 * 1.5–2.0 km; a generator laying out fifteen legs on a real street network,
 * under separation and climb rules that reject candidates unevenly, cannot hit
 * a 500 m window on every draw, and forcing it to would mean rejecting good
 * courses for arithmetic. ±25% around the target is what Krumlov actually
 * yields with the median sitting inside the IOF band.
 */
export function courseLengthBand(
  d: Discipline,
  anchor: VenueAnchor,
): { min: number; max: number } {
  const target = specFor(d, anchor).targetLengthM;
  return { min: Math.round(target * 0.75), max: Math.round(target * 1.25) };
}

export interface GenerateOptions {
  venue: VenueAnchor;
  discipline: Discipline;
  seed: number;
  terrain: CourseTerrain;
  /** Where the arena is. Start and finish are placed near it. */
  arena?: World2;
}

export function generateCourse(o: GenerateOptions): Course {
  const rng = new Rng(o.seed);
  const spec = specFor(o.discipline, o.venue);
  const halfX = o.venue.sizeX / 2;
  const halfZ = o.venue.sizeZ / 2;

  const inBounds = (p: World2) =>
    Math.abs(p.x) < halfX * 0.92 && Math.abs(p.z) < halfZ * 0.92;

  const arena = o.arena ?? { x: 0, z: 0 };
  // The start must be somewhere you can actually run out of in any direction.
  //
  // Relax progressively rather than falling straight through to "anywhere
  // legal": a dense old town may genuinely have no 75%-open spot near the
  // arena, but it always has somewhere better than a two-metre alley, and the
  // difference is whether the first ten seconds of the race feel broken.
  // Widening the annulus matters as much as lowering the bar — the open ground
  // in Krumlov is the square, and the square may be 400 m away.
  const start = pickOpenSite(arena, rng, o.terrain, inBounds, [
    { min: 120, max: 260, open: 0.75, speed: 0.8 },
    { min: 120, max: 420, open: 0.75, speed: 0.8 },
    { min: 80, max: 520, open: 0.6, speed: 0.72 },
    { min: 60, max: 600, open: 0.45, speed: 0.6 },
    { min: 60, max: 600, open: 0.45 },
    { min: 60, max: 600, open: 0 },
  ]) ?? arena;

  const targetLegs = spec.legCount[0] + Math.floor(rng.next() * (spec.legCount[1] - spec.legCount[0] + 1));
  const controls: Control[] = [];
  let current = start;
  let lastBearing = rng.next() * Math.PI * 2;
  let code = 31 + Math.floor(rng.next() * 40);
  // Whole-course climb allowance, spent down as legs are placed.
  let climbLeftM = spec.targetLengthM * spec.climbRatio;

  /**
   * Straight-line course length still to be spent, metres.
   *
   * Legs used to be drawn from the [min, max] band and the course length was
   * whatever fell out — which is how a sprint specified at 3.4 km shipped
   * anywhere between 2.7 and 4.3 km. Drawing each leg against the *remaining*
   * budget instead makes `targetLengthM` mean what it says, and it is what a
   * setter actually does: if a leg comes out longer than planned, the next ones
   * come in.
   *
   * Self-correcting rather than open-loop matters more than it sounds. Every
   * placement rule that rejects a candidate — control separation, the decoy
   * test, the climb ceiling — rejects *short* legs more often than long ones,
   * because a short leg lands near what is already placed. Open-loop, that bias
   * compounds over eighteen legs into a 20% overshoot; closed-loop, it is
   * absorbed by the next leg.
   */
  let lengthLeftM = spec.targetLengthM;

  for (let i = 0; i < targetLegs; i++) {
    // Legs still to place, counting the run-in to the finish.
    const legsLeft = targetLegs + 1 - i;
    const meanLegM = Math.max(
      spec.minLegM,
      Math.min(spec.maxLegM, lengthLeftM / legsLeft),
    );
    // Vary deliberately: real courses mix a couple of long route-choice legs
    // among shorter technical ones. The weights average to 1, so the mean is
    // the budget.
    const t = rng.next();
    const ratio =
      t < 0.2
        ? 1.4 + rng.next() * 0.4
        : t < 0.55
          ? 0.9 + rng.next() * 0.3
          : 0.55 + rng.next() * 0.3;
    const legLength = Math.max(spec.minLegM, Math.min(spec.maxLegM, meanLegM * ratio));

    const site = pickNextControl({
      from: current,
      lastBearing,
      legLength,
      rng,
      terrain: o.terrain,
      inBounds,
      minSeparationM: spec.minSeparationM,
      routeStepM: spec.routeStepM,
      maxLegClimbOverM: spec.maxLegClimbOverM,
      punchRadiusM: o.discipline === 'sprint' ? 6 : 9,
      // Late in the course, bend back toward the arena so the finish is not a
      // forced sprint across the whole map.
      homeBias: i >= targetLegs - 3 ? (i - (targetLegs - 4)) / 3 : 0,
      home: arena,
      // A floor, so an exhausted budget does not reject every candidate and
      // strand the course — but a floor proportional to the budget rather than
      // a flat 25 m, which on a sprint's 19 m allowance *is* the whole budget
      // and made the ceiling below meaningless.
      climbLeftM: Math.max(spec.targetLengthM * spec.climbRatio * 0.3, climbLeftM),
      placed: [start, ...controls.map((c) => c.position)],
    });
    if (!site) break;

    climbLeftM -= legClimbM(current, site, o.terrain);
    lengthLeftM -= dist2(current, site);

    controls.push({
      id: `c${i + 1}`,
      code,
      position: site,
      description: describeControl(site, o.terrain),
      // SIAC touch-free registers at roughly 30 cm laterally; we use a game-
      // legible radius rather than a literal one, or punching would be fiddly
      // rather than skilful.
      punchRadius: o.discipline === 'sprint' ? 6 : 9,
    });

    lastBearing = bearing(current, site);
    current = site;
    // Codes ascend but not consecutively, as real events allocate them.
    code += 1 + Math.floor(rng.next() * 4);
    if (code > 999) code = 31;
  }

  const finish = pickOpenSite(arena, rng, o.terrain, inBounds, [
    { min: 60, max: 180, open: 0.7, speed: 0.8 },
    { min: 60, max: 320, open: 0.55, speed: 0.72 },
    { min: 40, max: 420, open: 0.4, speed: 0.6 },
    { min: 40, max: 420, open: 0.4 },
    { min: 40, max: 420, open: 0 },
  ]) ?? arena;

  const lengthM = measureLength(start, controls, finish);
  const climbM = measureClimb(start, controls, finish, o.terrain);

  return {
    id: `${o.venue.id}-${o.discipline}-${o.seed}`,
    venue: o.venue.id,
    discipline: o.discipline,
    lengthM,
    climbM,
    start,
    finish,
    controls,
    expectedWinningTimeS: TYPICAL_DURATION_S[o.discipline],
    seed: o.seed,
  };
}

// ---------------------------------------------------------------------------
// Control siting
// ---------------------------------------------------------------------------

interface PickOptions {
  from: World2;
  lastBearing: number;
  legLength: number;
  rng: Rng;
  terrain: CourseTerrain;
  inBounds: (p: World2) => boolean;
  homeBias: number;
  home: World2;
  /** Controls already placed, for separation and crossing checks. */
  placed: World2[];
  /**
   * Metres of climb still available before the course exceeds its target ratio.
   * Falls as the course is laid out, so late legs are pushed toward contouring
   * — which is exactly what a setter does when the climb budget is running out.
   */
  climbLeftM: number;
  /** See `Spec.minSeparationM`. */
  minSeparationM: number;
  /** See `Spec.routeStepM`. */
  routeStepM: number;
  /** How close a SIAC registers, metres. Used for the decoy test below. */
  punchRadiusM: number;
  /** See `Spec.maxLegClimbOverM`. */
  maxLegClimbOverM: number;
}

/** Perpendicular distance from `p` to the segment `a`–`b`, metres. */
function pointToSegmentM(p: World2, a: World2, b: World2): number {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const len2 = ux * ux + uz * uz;
  let t = len2 > 1e-9 ? ((p.x - a.x) * ux + (p.z - a.z) * uz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + ux * t - p.x, a.z + uz * t - p.z);
}

/** Do segments ab and cd properly intersect? */
function segmentsCross(a: World2, b: World2, c: World2, d: World2): boolean {
  const side = (p: World2, q: World2, r: World2) =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const d1 = side(a, b, c);
  const d2 = side(a, b, d);
  const d3 = side(c, d, a);
  const d4 = side(c, d, b);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0;
}

/**
 * How many already-placed legs would this leg cross?
 *
 * The last placed point is `from` itself, so the final segment is skipped —
 * consecutive legs share an endpoint and always "touch".
 */
function countCrossings(from: World2, to: World2, placed: World2[]): number {
  let n = 0;
  for (let i = 0; i < placed.length - 2; i++) {
    if (segmentsCross(from, to, placed[i]!, placed[i + 1]!)) n++;
  }
  return n;
}

/**
 * Choose the next control.
 *
 * Samples candidate bearings, rejects the ones that would make a dog-leg or a
 * repeated direction, then scores the survivors on how good a control site they
 * are and how interesting the leg to them is.
 */
function pickNextControl(o: PickOptions): World2 | null {
  let best: { p: World2; score: number } | null = null;

  for (let attempt = 0; attempt < 90; attempt++) {
    // Turn away from the incoming direction. A change of at least ~40° keeps
    // the control meaningful and avoids the dog-leg the rules discourage.
    const turn = (0.7 + o.rng.next() * 1.6) * (o.rng.next() < 0.5 ? 1 : -1);
    let b = wrapAngle(o.lastBearing + turn);

    if (o.homeBias > 0) {
      const toHome = bearing(o.from, o.home);
      b = wrapAngle(b + wrapAngle(toHome - b) * o.homeBias * 0.7);
    }

    const len = o.legLength * (0.85 + o.rng.next() * 0.3);
    const p = { x: o.from.x + Math.sin(b) * len, z: o.from.z - Math.cos(b) * len };
    if (!o.inBounds(p)) continue;

    // Nudge onto the best nearby feature — a control belongs ON something.
    // Controls may sit tight against a wall — that is legitimate sprint course
    // setting — but not in a pocket with no way out.
    //
    // The search radius is a fraction of the leg, not a flat 45 m. On a 900 m
    // forest leg 45 m is a rounding error; on a 60 m sprint leg it is most of
    // the leg, and a displacement that large undoes the direction change the
    // bearing was chosen for — which is how a generator that explicitly rejects
    // dog-legs produces them anyway. In a town it costs nothing: there is a
    // corner every few metres.
    const nudgeR = Math.max(12, Math.min(45, o.legLength * 0.3));
    const sited = findControlSite(p, 0, nudgeR, o.rng, o.terrain, o.inBounds, 0.5);
    if (!sited) continue;

    const feature = o.terrain.featureScoreAt(sited.x, sited.z);
    if (feature < 0.25) continue;

    // The turn as *placed*, not as intended.
    //
    // The bearing was drawn at least 40° off the incoming leg, but two things
    // move the endpoint afterwards — the home bias, and the nudge onto a
    // feature — and on a short sprint leg either can undo the turn entirely.
    // A dog-leg lets the runners behind you see the control you are leaving,
    // which the rules discourage, so it is measured where it can be measured:
    // on the leg that is actually going to be printed.
    const realTurn = Math.abs(wrapAngle(bearing(o.from, sited) - o.lastBearing));
    // Relaxed while bending home, where a slightly flat turn beats a finish
    // leg across the whole map.
    if (realTurn < (o.homeBias > 0.5 ? 0.45 : 0.62)) continue;

    // Controls must not crowd each other. Two circles closer than this overlap
    // on the printed map, and a runner arriving at one can see the other —
    // which is exactly what control separation rules exist to prevent.
    if (o.placed.some((q) => dist2(q, sited) < o.minSeparationM)) continue;

    // Nor may an old control sit on the line of the new leg.
    //
    // Separation alone does not cover this: two controls can be a legal 45 m
    // apart and one of them still sit 8 m off the route to the other, where a
    // competitor running on the bearing punches it without ever choosing to.
    // That is a course fault rather than a runner's mistake — it is the same
    // property `tools/ci/check-race.mjs` calls a decoy — and the margin here is
    // the same one that gate uses.
    // The last entry in `placed` is `from` itself, which is on the line by
    // definition; the leg starts there.
    if (
      o.placed
        .slice(0, -1)
        .some((q) => pointToSegmentM(q, o.from, sited) < o.punchRadiusM + 14)
    ) {
      continue;
    }

    // Crossing legs make runners meet head-on and follow each other, so a
    // setter avoids them where the terrain allows — but only where it allows.
    // Hard-rejecting every crossing starved the candidate pool badly enough
    // that a Long came out with six controls instead of fourteen. It is a
    // strong preference, not a rule.
    const crossings = countCrossings(o.from, sited, o.placed);

    // Climb cost of this leg, against what the course can still afford.
    //
    // Siting on distinctive features preferentially picks knolls and spur ends,
    // and simply chaining those walks the runner over every high point on the
    // map. Without this term the generated Long climbed 8.4% of its length,
    // roughly double what is ever set.
    const legClimb = legClimbM(o.from, sited, o.terrain);
    const overBudget = Math.max(0, legClimb - o.climbLeftM);
    if (overBudget > o.maxLegClimbOverM) continue;
    const climbPenalty = legClimb / Math.max(30, o.climbLeftM);

    const interest = legInterest(o.from, sited, o.terrain, o.routeStepM);
    const score =
      feature * 1.0 +
      interest * 1.3 -
      climbPenalty * 1.15 -
      crossings * 0.9 +
      o.rng.next() * 0.15;
    if (!best || score > best.score) best = { p: sited, score };
  }

  return best?.p ?? null;
}

/**
 * How much of a ring around `p` is passable, 0..1.
 *
 * A point can be perfectly passable itself and still be a slot you cannot get
 * out of. The Krumlov start landed in exactly that: the cell was Road, but more
 * than half the ring at 8 m was building, so running into the wall slid at
 * reduced speed and read as "WASD does not work in the city".
 */
function openness(p: World2, terrain: CourseTerrain, radiusM: number): number {
  let open = 0;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = p.x + Math.sin(a) * radiusM;
    const z = p.z - Math.cos(a) * radiusM;
    if (terrain.runnabilityAt(x, z) !== Runnability.Impassable) open++;
  }
  return open / N;
}

/**
 * Try successively looser (radius, openness) bands until one yields a site.
 * Returns the first hit, or null if even the loosest band fails.
 */
function pickOpenSite(
  around: World2,
  rng: Rng,
  terrain: CourseTerrain,
  inBounds: (p: World2) => boolean,
  bands: { min: number; max: number; open: number; speed?: number }[],
): World2 | null {
  for (const b of bands) {
    const p = findControlSite(
      around, b.min, b.max, rng, terrain, inBounds, b.open, b.speed ?? 0,
    );
    if (p) return p;
  }
  return null;
}

/** Find a describable feature near a point. */
function findControlSite(
  around: World2,
  minR: number,
  maxR: number,
  rng: Rng,
  terrain: CourseTerrain,
  inBounds: (p: World2) => boolean,
  minOpenness = 0,
  minSpeed = 0,
): World2 | null {
  let best: { p: World2; s: number } | null = null;
  for (let i = 0; i < 60; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = minR + rng.next() * (maxR - minR);
    const p = { x: around.x + Math.sin(a) * r, z: around.z - Math.cos(a) * r };
    if (!inBounds(p)) continue;
    // A control may not sit in impassable ground — in sprint that is a DSQ
    // offence for the runner, so it must never be the target.
    if (terrain.runnabilityAt(p.x, p.z) === Runnability.Impassable) continue;
    // Require room to move, not just a legal cell to stand on.
    if (minOpenness > 0 && openness(p, terrain, 8) < minOpenness) continue;
    // And require ground worth standing on. A start can be perfectly open and
    // still be in scrub: the Krumlov start landed on Green2 at 0.4x speed, so
    // the first strides crawled and the game read as broken even though
    // nothing was blocking. Openness and runnability are different problems.
    if (minSpeed > 0 && (SPEED_BY_RUNNABILITY[terrain.runnabilityAt(p.x, p.z)] ?? 0) < minSpeed) {
      continue;
    }
    const s = terrain.featureScoreAt(p.x, p.z);
    if (!best || s > best.s) best = { p, s };
  }
  return best?.p ?? null;
}

/**
 * How interesting is this leg?
 *
 * Interest means genuine route choice: a straight line that is *expensive*
 * while a detour is competitive. We sample the direct line, and compare it with
 * two offset alternatives. If they are close in cost, the runner has a real
 * decision — which is exactly what a good course setter is trying to create.
 *
 * **The blocked-straight case is the whole sprint.** A leg whose direct line
 * runs through a block of buildings has an infinite direct cost and two finite
 * ways round it, and that is the best leg a sprint course setter can set: the
 * runner has to pick a side, at speed, off the map. The old code returned 0 for
 * it — `if (direct === Infinity) return 0` — so every leg the town actually
 * makes interesting was scored as worthless, and the generator preferred legs
 * across open ground where the straight line is runnable. That single line is
 * a large part of why the course ran through the park.
 *
 * Whether "straight" is correctly infinite depends on `stepM` being fine enough
 * to hit the buildings at all; see `Spec.routeStepM`.
 */
function legInterest(a: World2, b: World2, terrain: CourseTerrain, stepM: number): number {
  const legM = dist2(a, b);
  const direct = routeCost(a, b, terrain, 0, stepM);
  const left = routeCost(a, b, terrain, 0.28, stepM);
  const right = routeCost(a, b, terrain, -0.28, stepM);
  const alt = Math.min(left, right);

  // Longer legs carry more route choice, so weight them slightly.
  const lengthBonus = Math.min(1, legM / 700) * 0.35;

  if (!Number.isFinite(direct)) {
    // Straight is impossible. If a way round exists, this is a block leg and
    // the decision is forced and real; if both bows are shut too, the leg has
    // no route at all and is worth nothing.
    if (!Number.isFinite(alt)) return 0;
    // One way round or two? Two competitive sides is the better leg.
    const bothWays = Number.isFinite(left) && Number.isFinite(right);
    return (bothWays ? 1 : 0.7) * 0.9 + lengthBonus;
  }
  if (!Number.isFinite(alt)) return lengthBonus * 0.5;

  // Ratio near 1 means the alternatives are competitive: a real choice.
  // Much greater than 1 means straight is obviously right and there is no
  // decision to make.
  const ratio = alt / direct;
  const choice = 1 - Math.min(1, Math.abs(ratio - 1) / 0.35);

  return choice * 0.8 + lengthBonus;
}

/**
 * Ascent along the straight line from a to b, in metres.
 *
 * Only ascent counts, matching the IOF climb convention — a course that drops
 * 200 m and climbs 20 m has 20 m of climb, not 220.
 */
function legClimbM(a: World2, b: World2, terrain: CourseTerrain): number {
  const steps = Math.max(4, Math.round(dist2(a, b) / 25));
  let climb = 0;
  let prev = terrain.heightAt(a.x, a.z);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const h = terrain.heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (h > prev) climb += h - prev;
    prev = h;
  }
  return climb;
}

/**
 * Approximate traversal cost along a bowed path from a to b.
 *
 * `stepM` is the sampling interval along the path. It is a parameter rather
 * than a constant because the right value is a property of the terrain: 25 m is
 * fine in a forest whose classes change slowly, and hopeless in a town whose
 * blocks are 20–30 m across, where it steps clean over a building and reports
 * the straight line through it as cheap.
 */
function routeCost(
  a: World2,
  b: World2,
  terrain: CourseTerrain,
  bow: number,
  stepM: number,
): number {
  const steps = Math.max(8, Math.min(400, Math.round(dist2(a, b) / Math.max(0.5, stepM))));
  const perpX = -(b.z - a.z);
  const perpZ = b.x - a.x;
  const d = Math.hypot(perpX, perpZ) || 1;
  let cost = 0;
  let prevH = terrain.heightAt(a.x, a.z);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Sine bow so the detour departs and rejoins smoothly.
    const off = Math.sin(t * Math.PI) * bow;
    const x = a.x + (b.x - a.x) * t + (perpX / d) * off * dist2(a, b) * 0.5;
    const z = a.z + (b.z - a.z) * t + (perpZ / d) * off * dist2(a, b) * 0.5;

    const cls = terrain.runnabilityAt(x, z);
    if (cls === Runnability.Impassable) return Infinity;

    const h = terrain.heightAt(x, z);
    const segment = dist2(a, b) / steps;
    const climb = Math.max(0, h - prevH);
    prevH = h;

    const speed = SPEED_BY_RUNNABILITY[cls] || 0.05;
    cost += (segment / speed) * COST_BY_RUNNABILITY[cls] + climb * 8;
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Descriptions and measurement
// ---------------------------------------------------------------------------

/**
 * Derive an IOF control description from the terrain at the site.
 *
 * Column D takes exactly one symbol — that is a spec rule, and the type in
 * `src/core/types.ts` enforces it.
 *
 * **Ask the terrain first.** In a town the control is on a building corner, the
 * foot of a stairway, a gate or the end of a bridge, and those are ISSprOM
 * man-made symbols (RESEARCH-SPORT §3.4.5) that `src/map/pictograms.ts` already
 * draws. Handing a Krumlov sprint the landform vocabulary below produced
 * "re-entrant" and "thicket" for controls hung on burgher houses, which is not
 * a description an orienteer can use and not a description of anything that is
 * there. The landform branch stays because in the forest it is right.
 */
function describeControl(p: World2, terrain: CourseTerrain): Control['description'] {
  const site = terrain.siteAt?.(p.x, p.z);
  if (site) return { a: 0, b: 0, d: site.d, ...(site.g ? { g: site.g } : {}) };

  const cls = terrain.runnabilityAt(p.x, p.z);
  const h = terrain.heightAt(p.x, p.z);
  const n = terrain.heightAt(p.x, p.z - 12);
  const s = terrain.heightAt(p.x, p.z + 12);
  const e = terrain.heightAt(p.x + 12, p.z);
  const w = terrain.heightAt(p.x - 12, p.z);
  const mean = (n + s + e + w) / 4;
  const relief = h - mean;

  let d = 'reentrant';
  if (cls === Runnability.Rock) d = 'boulder';
  else if (cls === Runnability.Marsh) d = 'marsh';
  else if (relief > 1.6) d = 'knoll';
  else if (relief < -1.6) d = 'depression';
  else if (Math.abs(relief) < 0.4) d = 'thicket';

  return { a: 0, b: 0, d, ...(relief > 1.6 ? { g: 'top' } : {}) };
}

function measureLength(start: World2, controls: Control[], finish: World2): number {
  let total = 0;
  let prev = start;
  for (const c of controls) {
    total += dist2(prev, c.position);
    prev = c.position;
  }
  return Math.round(total + dist2(prev, finish));
}

/** Climb, per the IOF convention: the sum of ascent along the straight route. */
function measureClimb(
  start: World2,
  controls: Control[],
  finish: World2,
  terrain: CourseTerrain,
): number {
  const points = [start, ...controls.map((c) => c.position), finish];
  let climb = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const steps = Math.max(4, Math.round(dist2(a, b) / 25));
    let prev = terrain.heightAt(a.x, a.z);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const h = terrain.heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (h > prev) climb += h - prev;
      prev = h;
    }
  }
  // Rounded to the nearest 5 m, as printed on a control description sheet.
  return Math.round(climb / 5) * 5;
}
