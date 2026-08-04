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
import { siteRefreshments } from './refreshment';

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

/**
 * Routing over the venue's street network, as the course is being set.
 *
 * PLAN-KRUMLOV-V2 §3. This is the interface that ends fault 7: `routeCost`
 * below samples the *straight line*, so a leg with a river across it costs
 * `Infinity` and scores exactly the same as a leg into a courtyard — the
 * generator cannot tell "go round the block" from "go round the town", and
 * D-037's 12.3× leg is what that looks like on a description sheet.
 *
 * Kept to two methods on purpose. `src/sim` is calibrated against its own
 * harnesses and may not learn about three.js, packed buffers or broadphase
 * grids; what it needs to know is *how far is it really* and *is this point on
 * a street*, and both are numbers.
 */
export interface StreetRouting {
  /**
   * Metres from `p` to the nearest way a control may be sited on — Road, Path
   * or Steps. `Infinity` past the search radius.
   *
   * Deliberately not "the nearest network of any kind": the graph carries
   * chords across open ground so that a leg across a square is not measured
   * round it, and a control in the middle of a square is not a sprint control.
   */
  offNetworkM(p: World2): number;
  /**
   * The nearest point *on* a sitable way, or null if there is none within the
   * search radius. What makes "the start is on the network" a construction
   * rather than a filter.
   */
  snapToNetwork(p: World2): World2 | null;
  /**
   * Distances from `p` over the network. One Dijkstra; the closure answers
   * metres for any point, or `Infinity` where either end is off the network or
   * in another component.
   *
   * Null when `p` itself cannot be put on the network at all.
   */
  fieldFrom(p: World2): ((q: World2) => number) | null;
  /**
   * The bearings the network offers out of `p`, radians.
   *
   * Fault 8's question — *"you run out and there's a wall straight away"* — as
   * a property of the graph rather than of a raster ring.
   */
  exitsAt(p: World2): number[];
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
  /**
   * How much ground the athlete can reach from this point, m², measured with
   * the runtime's own collision, stopping once it is provably above `capM2`.
   *
   * Optional because a synthetic terrain in a harness has no collider. Where it
   * exists, the start and the finish are checked against it *here* rather than
   * only in `src/race/courseSetup.ts`: that layer can reject a whole course for
   * a sealed point and shop for another seed, which is a coarse and expensive
   * way to say "not that spot". See `FieldTerrain.escapeAreaM2`.
   */
  escapeAreaM2?(p: World2, capM2: number): { m2: number; sealed: boolean };
  /**
   * Metres to the nearest runnable paved way, or `Infinity` where the terrain
   * has no street network. Only meaningful in a town.
   *
   * This is what tells a garden from a street. A walled garden with a gate is
   * connected — the escape flood walks straight out through the gate and
   * reports open ground — so enclosure alone cannot see it; what it *is* is
   * ground well off the network, and that is measurable. See
   * `FieldTerrain.pavedDistanceAt`.
   */
  pavedDistanceAt?(x: number, z: number): number;
  /**
   * Is this point out of bounds? The athlete's own test.
   *
   * Optional because a synthetic terrain in a harness has no collider, and
   * absent in the forest for a better reason: there is nothing there the class
   * raster does not already say. Used for the start's run-out, which is a
   * continuous measurement — how far you get before something stops you — and
   * cannot be read off a class.
   */
  blockedAt?(x: number, z: number): boolean;
  /**
   * Can the athlete get here from the arena at all?
   *
   * The shipped passable space's own answer. Asked here so that projecting the
   * start onto the network cannot land it somewhere `setCourse` will
   * immediately drag it off again — the two would otherwise be pulling in
   * different directions, which is how a start ends up neither on the network
   * nor where the generator put it.
   */
  reachableAt?(x: number, z: number): boolean;
  /**
   * The street network, where the venue has one. See `StreetRouting`.
   *
   * Absent in the forest, and that is not an omission: a forest course is not
   * set on a network, every leg there audits between 1.0× and 1.1×, and the
   * one measure this would add is the one the forest has never failed.
   */
  network?: StreetRouting;
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
  /**
   * How far apart the start and the finish must be, metres.
   *
   * **They may share an arena. They are never adjacent.** Both in one arena is
   * normal and wanted — the spectators, the commentary and the big screen are
   * all in one place — but a start you can see the finish gantry from is not a
   * start, and the client played exactly that: *"I started in some garden and
   * the finish gate was right there"*. Nothing in this generator prevented it;
   * both points were drawn from an annulus around the same arena centre with no
   * relationship to each other, and over 40 menu-shaped Krumlov seeds the
   * closest pair came out 116 m apart with the first leg pointing 3° off the
   * bearing to the finish.
   *
   * Scaled to the discipline because a sight line is. A sprint arena is compact
   * and a town shuts the view down in fifty metres, so 200 m of separation there
   * is a finish you genuinely cannot see. Forest arenas are open fields and the
   * courses are five times longer, so the equivalent is 350 m.
   */
  minStartFinishM: number;
  /**
   * How close the course may come to the finish before the run-in, metres.
   *
   * The finish is the end of a run-in, not a roundabout. Without this the
   * generator happily threaded leg 6 within 2 m of the finish — the player runs
   * through the gantry mid-race, which is nonsense on the ground and nonsense on
   * the map, where the double circle means *the end*. Applied to whole legs
   * rather than to control sites, because a control 90 m clear of the finish on
   * a leg that sweeps past it at 10 m is the same fault.
   *
   * It doubles as the run-in length: the home bias aims the last legs at the
   * finish and this is what stops them arriving, so the last control settles
   * just outside the ring.
   */
  finishClearanceM: number;
}

function specFor(d: Discipline, anchor: VenueAnchor): Spec {
  const extent = Math.min(anchor.sizeX, anchor.sizeZ);
  switch (d) {
    case 'sprint':
      // 1.5 km, and the citation this used to carry was wrong in a way worth
      // correcting rather than deleting.
      //
      // It read "a real sprint is 1.5–2.0 km ... (IOF Competition Rules,
      // appendix 2; RESEARCH-SPORT §7.2)". The rules say no such thing:
      // RESEARCH-SPORT §7.3 opens by stating that **the rules do not specify
      // course length in km, nor control count, for any format** — length is
      // derived backwards from the mandated winning time. §7.2 gives the times
      // and no distances. And the measured elite sprint *final* is 3.5–4.3 km
      // (Terezín 2021, Edinburgh 2024) at 3:30–4:20/km, which is more than
      // double what is written here, not less.
      //
      // What 1.5 km actually is: a **Knock-Out Sprint round**. §7.3's measured
      // table puts those at 1.6–2.4 km for the mandated 6–8 minutes, and that
      // is a real IOF format rather than a shortened one — 1:4000, technically
      // easy, urban, spectators along the course. Which is Krumlov. So the
      // course this generator sets is honestly describable; it is simply a
      // different event from the one the comment claimed.
      //
      // It has to be, because of the venue. See docs/DECISIONS.md D-030.
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
        minStartFinishM: 200,
        finishClearanceM: 75,
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
        minStartFinishM: 350,
        finishClearanceM: 130,
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
        minStartFinishM: 350,
        finishClearanceM: 130,
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
        minStartFinishM: 350,
        finishClearanceM: 130,
      };
  }
}

/**
 * The straight-line length a finished course of this discipline should land in,
 * metres.
 *
 * Exported because `setCourse` shops between seeds and needs to know what it is
 * shopping for.
 *
 * **This is not the figure the gate asserts against.** `COURSE_LENGTH_M` in
 * `tools/ci/check-race.mjs` states the sport's numbers independently, on the
 * argument written out there — a gate that reads the build's own target cannot
 * catch a wrong target, which is the one regression this venue has actually
 * had. The two are related by containment rather than by equality: **this band
 * must sit inside that one**, because a setter that accepts what the judge will
 * refuse is shopping for rejects. That containment is asserted rather than
 * maintained by hand — `setCourse` reports the band it used as
 * `lengthBandM` and the gate checks it against its own — which is what the low
 * edge below needed and did not have.
 *
 * The width is the terrain's, not the sport's. A sprint is *specified* at
 * 1.5–2.0 km; a generator laying out fifteen legs on a real street network,
 * under separation and climb rules that reject candidates unevenly, cannot hit
 * a 500 m window on every draw, and forcing it to would mean rejecting good
 * courses for arithmetic. A band a quarter wide at the top of the target is
 * what Krumlov actually yields, with the median sitting inside the IOF band.
 * (⚠ On where that 1.5–2.0 km itself comes from, and why the citation attached
 * to it here and in `specFor` does not check out, see the note under
 * `COURSE_LENGTH_M` in `tools/ci/check-race.mjs`. The figure is a sound *venue*
 * decision described as a sport one.)
 *
 * **The band is not symmetric, and the low edge is the interesting one.** It
 * used to be −25%, which put it at 1125 m for a sprint while
 * `tools/ci/check-race.mjs` rejects anything under 1200 — so `setCourse` was
 * shopping for a course the gate would refuse, and one seed in a hundred and
 * twenty duly landed in the gap. Once the finish clearance started rejecting
 * late legs it was three, and one of them was a seed the gate runs. A setter
 * whose acceptance test is looser than the judge's is not a setter. −20% puts
 * the low edge exactly on the number the sport gives, and costs 3 draws in 120,
 * which the ten-seed search absorbs without noticing.
 */
export function courseLengthBand(
  d: Discipline,
  anchor: VenueAnchor,
): { min: number; max: number } {
  const target = specFor(d, anchor).targetLengthM;
  return { min: Math.round(target * 0.8), max: Math.round(target * 1.25) };
}

/**
 * How much ground the start and the finish must open onto, m².
 *
 * The same number and the same reasoning as `MIN_ESCAPE_M2` in
 * `src/race/courseSetup.ts`, applied a layer earlier. That one can only reject
 * a whole course and go looking for another seed; this one rejects the *spot*,
 * which is what is actually wrong, and costs one flood rather than a
 * regeneration. Both are kept: this is a preference expressed while siting, and
 * that is the guarantee made about the course that ships.
 */
const MIN_ARENA_ESCAPE_M2 = 3_000;

/**
 * How far from a runnable way the start and the finish may sit in a town,
 * metres.
 *
 * The enclosure flood cannot see a walled garden that has a gate — it walks out
 * through the gate and reports the whole town. What distinguishes the garden is
 * that it is *off the network*: over 40 Krumlov seeds, 84% of sited controls
 * are within 2 m of a paved way and the furthest is 17.5 m, so a start more than
 * fifteen metres from anything you can run on is not on a street. Applied only
 * where there is a network to measure against — see `CourseTerrain.pavedDistanceAt`.
 */
const MAX_ARENA_PAVED_M = 15;

/**
 * How far off the bearing to the finish the first leg must lead, radians.
 *
 * 70°. A real start is sited so the first leg takes the field *away* from the
 * arena — that is why the start triangle is a triangle, it has a direction —
 * and a first leg that runs back past the finish shows the player the gantry
 * before they have navigated anything. `tools/ci/check-race.mjs` asserts 60°,
 * deliberately looser: the gate states the sport's floor, this states what the
 * generator aims at, and the gap between them is the room the terrain gets.
 */
const FIRST_LEG_AWAY_RAD = 1.22;

/**
 * How much of the finish clearance a leg may give back when it has nowhere
 * else to go. See the retry in `generateCourse`.
 */
const RELAXED_CLEARANCE = 0.7;

/**
 * How much of the start–finish separation the last-resort start band keeps.
 *
 * The bands relax openness, ground speed and the sector; this is the one figure
 * they never give up entirely, because a start next to the finish is the whole
 * complaint. 85% of a number chosen for a sight line is still a sight line.
 */
const LAST_RESORT_SEPARATION = 0.85;

/**
 * How far a leg may run against its straight line, measured on the street
 * graph while the leg is being set.
 *
 * **The same 3.0× `tools/ci/check-passable.mjs` asserts, and stated here rather
 * than imported for the reason `COURSE_LENGTH_M` is stated there rather than
 * read out of the build**: a gate that reads the setter's own number cannot
 * catch a wrong number. What ties them together is containment, asserted rather
 * than maintained by hand — `setCourse` reports `detourLimit` and the gate
 * checks it is not looser than its own.
 *
 * D-037 derived 3.0 from the sport: RESEARCH-SPORT §8.6 puts elite leg route
 * efficiency between 1.1× and 2.0×, and 2.0 is the bottom of the published
 * scale, so 3.0 is a floor under indefensible rather than a definition of good.
 * The two faults the client found ran 14.0× and 10.3×.
 *
 * **What makes this different from D-037's three failed attempts** — which is
 * the whole of §3, so it is worth being exact about. Those measured the
 * straight line and could not see a detour at all: `routeCost` returns
 * `Infinity` for a leg with a river across it and `Infinity` for a leg into a
 * courtyard, so refusing on it starved the candidate pool and ended courses
 * early. This measures the route. A candidate refused here is refused because
 * the way to it is genuinely a lap of the venue, and a candidate accepted comes
 * with a **route the athlete can physically run** at that ratio — every edge of
 * the graph is swept-clear against the model.
 */
export const MAX_LEG_DETOUR = 3.0;

/**
 * Below this much excess the ratio is not measured. D-037's allowance, and the
 * same 40 m: it is a measurement allowance rather than a sporting one, and on a
 * 47 m leg — legal at 25 m under Rule 19.4 — snapping each end onto the network
 * is worth 0.2 of the ratio on its own.
 */
const MIN_DETOUR_EXCESS_M = 40;

/**
 * How far off the street network the start and the finish may sit, metres.
 *
 * **Fault 8, made structural.** `endpointFaults` in check-passable states the
 * same property as a *class* test — the cell the start stands in is Road or
 * Path, or it is not on the network — on the argument that any tolerance wide
 * enough to absorb 1 m quantisation is wide enough to pass the fault. On a
 * vector graph there is no quantisation to absorb: 2.5 m is one stride, it is
 * inside the carriageway of every way in the town, and the start this replaces
 * was 1.4 m from a Road cell *and in the woods* — because the raster's nearest
 * cell and the network are different questions. This one asks the network.
 */
const MAX_ENDPOINT_OFF_NETWORK_M = 2.5;

/**
 * How far the athlete must be able to run out of the start on the bearing to
 * control 1, metres.
 *
 * The measured shape of fault 8: the shipped start faced the right way, stood
 * on ForestOpen, and had a `town.blocks` barrier **11 m** ahead of it. Nothing
 * measured that, because every course measure was an aggregate and the start is
 * one point. 25 m is about five seconds of a sprinter's race and about the
 * length of a Krumlov block; a start you have to turn inside of is a start
 * sited against geometry.
 *
 * Applied to the first leg's candidates rather than to the start itself,
 * because it is a property of the pair: a start on a street with the first
 * control round the corner behind it is exactly the complaint, and the start
 * alone cannot see it.
 */
const START_RUN_OUT_M = 25;

/**
 * How far off the street network a control may be sited, metres.
 *
 * Looser than the start and the finish, and it has to be: **a sprint control on
 * the corner of a building is correct**, and D-037 measured the shipped
 * course's controls at a median 0.0 m off the network with a p90 of 4.2 m. What
 * this forbids is the other thing — a control fifteen metres into a courtyard
 * or a meadow with a wall between it and the street the leg comes down. 12 m is
 * `FEATURE_REACH` in `src/race/terrainAdapter.ts`, i.e. the furthest a control
 * may be from the feature that describes it, which is the same distance for the
 * same reason.
 */
const MAX_CONTROL_OFF_NETWORK_M = 12;

/**
 * How many candidate sites are worth an escape flood, per band.
 *
 * The flood is a couple of milliseconds — cheap once, ruinous sixty times. The
 * candidates are checked best-first, and in practice the first one passes:
 * every legitimate Krumlov site opens onto the whole town.
 */
const MAX_VERIFY = 3;

export interface GenerateOptions {
  venue: VenueAnchor;
  discipline: Discipline;
  seed: number;
  terrain: CourseTerrain;
  /** Where the arena is. Start and finish are placed near it. */
  arena?: World2;
}

/**
 * What is wrong with a course's arena, in the reader's own words. Empty is good.
 *
 * Exported because `setCourse` shops between seeds and has to be able to say
 * "not that one": it pulls the start and the finish onto the reachable component
 * after generation, which can move them, so the guarantee this file makes while
 * siting has to be re-checked on the course that actually ships.
 *
 * Deliberately does not take the terrain. These are three statements about the
 * geometry of a course and nothing else, so they can be checked anywhere — which
 * is also why `tools/ci/check-race.mjs` re-derives them from its own constants
 * rather than importing these.
 */
export function arenaFaults(course: Course, discipline: Discipline, venue: VenueAnchor): string[] {
  const spec = specFor(discipline, venue);
  const out: string[] = [];
  // The **floors**, not the targets. `generateCourse` aims at the full figures
  // and gives a little of them back where the terrain refuses — the last start
  // band and the leg retry — so checking the targets here would reject courses
  // the generator deliberately accepted and send `setCourse` shopping for
  // nothing. What this states is what is guaranteed.
  const minSepM = spec.minStartFinishM * LAST_RESORT_SEPARATION;
  const minClearM = spec.finishClearanceM * RELAXED_CLEARANCE;
  const sep = dist2(course.start, course.finish);
  if (sep < minSepM) {
    out.push(`start ${Math.round(sep)} m from the finish, under ${Math.round(minSepM)} m`);
  }
  const first = course.controls[0]?.position;
  if (first) {
    const away = Math.abs(
      wrapAngle(bearing(course.start, first) - bearing(course.start, course.finish)),
    );
    if (away < FIRST_LEG_AWAY_RAD) {
      out.push(`first leg only ${Math.round((away * 180) / Math.PI)}° off the bearing to the finish`);
    }
  }
  // Every leg but the run-in. Ending at the finish is what the run-in is for.
  const points = [course.start, ...course.controls.map((c) => c.position), course.finish];
  for (let i = 0; i < points.length - 2; i++) {
    const d = pointToSegmentM(course.finish, points[i]!, points[i + 1]!);
    if (d < minClearM) {
      out.push(`leg ${i} passes ${Math.round(d)} m from the finish`);
      break;
    }
  }
  return out;
}

export function generateCourse(o: GenerateOptions): Course {
  const rng = new Rng(o.seed);
  const spec = specFor(o.discipline, o.venue);
  const halfX = o.venue.sizeX / 2;
  const halfZ = o.venue.sizeZ / 2;

  const inBounds = (p: World2) =>
    Math.abs(p.x) < halfX * 0.92 && Math.abs(p.z) < halfZ * 0.92;

  const arena = o.arena ?? { x: 0, z: 0 };
  // ISSprOM territory: 1:4000 or closer is a town, and a town has a street
  // network worth measuring against. Same test as `RaceController` uses.
  const urban = o.venue.mapScale <= 5000;

  /**
   * Neither the start nor the finish may sit in an enclosed garden or courtyard.
   *
   * Two different questions, asked separately because they catch different
   * gardens. `escapeAreaM2` catches the sealed one — a courtyard whose gate is
   * shut — and is the expensive half, so it runs on the best few candidates
   * only. `pavedDistanceAt` catches the one with a gate, which the flood walks
   * straight out of and reports as open: what makes it a garden is that it is
   * off the network, and that is cheap to measure on every sample.
   */
  const net = o.terrain.network;
  const onNetwork = (p: World2): boolean => {
    // **On the graph, not near a paved cell.** Where the venue ships a street
    // network this is the whole test and the raster proxy below is not
    // consulted: the shipped start that produced fault 8 was 1.4 m from a Road
    // cell and standing in woodland, which is what a nearest-cell measure
    // cannot tell apart from a street.
    if (net) return net.offNetworkM(p) <= MAX_ENDPOINT_OFF_NETWORK_M;
    if (!urban || !o.terrain.pavedDistanceAt) return true;
    return o.terrain.pavedDistanceAt(p.x, p.z) <= MAX_ARENA_PAVED_M;
  };
  const opensOut = (p: World2): boolean => {
    if (!o.terrain.escapeAreaM2) return true;
    const e = o.terrain.escapeAreaM2(p, MIN_ARENA_ESCAPE_M2);
    return !e.sealed || e.m2 >= MIN_ARENA_ESCAPE_M2;
  };

  // **The finish is sited first, and the start is sited against it.**
  //
  // That order is the fix. Both used to be drawn from an annulus around the
  // arena with no relationship to each other, so nothing stopped them landing
  // a few metres apart — which is what the client played.
  /**
   * The last word on where an arena point is: **on the network**.
   *
   * The bands below relax, and they have to — a dense old town may have no
   * 75 %-open spot near the arena — but every one of the things they relax is a
   * matter of degree, and being on the street is not one. So wherever a graph
   * exists the chosen point is projected onto the nearest way a control may
   * hang on, and the property stops being something a later band can give away.
   * The projection is short by construction: the bands sample near the arena
   * and the network is never far from anywhere in a town.
   */
  const ontoNetwork = (p: World2): World2 => {
    if (!net) return p;
    const q = net.snapToNetwork(p);
    if (!q || blockedAt(o.terrain, q)) return p;
    if (o.terrain.reachableAt && !o.terrain.reachableAt(q.x, q.z)) return p;
    return q;
  };

  const finish = ontoNetwork(
    pickOpenSite(rng, o.terrain, inBounds, [
      { around: arena, min: 60, max: 180, open: 0.7, speed: 0.8, accept: onNetwork, verify: opensOut },
      { around: arena, min: 60, max: 320, open: 0.55, speed: 0.72, accept: onNetwork, verify: opensOut },
      { around: arena, min: 40, max: 420, open: 0.4, speed: 0.6, verify: opensOut },
      { around: arena, min: 40, max: 420, open: 0.4 },
      { around: arena, min: 40, max: 420, open: 0 },
    ]) ?? arena,
  );

  // The start must be somewhere you can actually run out of in any direction,
  // and it must be a long way from the finish on the far side of the arena.
  //
  // Relax progressively rather than falling straight through to "anywhere
  // legal": a dense old town may genuinely have no 75%-open spot near the
  // arena, but it always has somewhere better than a two-metre alley, and the
  // difference is whether the first ten seconds of the race feel broken.
  // Widening the annulus matters as much as lowering the bar — the open ground
  // in Krumlov is the square, and the square may be 400 m away.
  //
  // What is *not* relaxed away is the separation. Every band carries it, the
  // last two at a reduced figure rather than none, because a start next to the
  // finish is the failure this whole sequence exists to prevent and falling
  // back to it would make the rest theatre. The sector — the far side of the
  // arena from the finish, widening as the bands loosen — is how the separation
  // is met without simply pushing the start to the edge of the map.
  const away = bearing(finish, arena);
  const far = (m: number) => (p: World2) => dist2(p, finish) >= m;
  const sep = spec.minStartFinishM;
  const rawStart = pickOpenSite(rng, o.terrain, inBounds, [
    { around: arena, min: 120, max: 260, open: 0.75, speed: 0.8, sector: { centre: away, half: 1.05 }, accept: both(far(sep), onNetwork), verify: opensOut },
    { around: arena, min: 120, max: 420, open: 0.75, speed: 0.8, sector: { centre: away, half: 1.75 }, accept: both(far(sep), onNetwork), verify: opensOut },
    { around: arena, min: 80, max: 520, open: 0.6, speed: 0.72, sector: { centre: away, half: 2.45 }, accept: far(sep), verify: opensOut },
    { around: arena, min: 60, max: 600, open: 0.45, speed: 0.6, accept: far(sep) },
    { around: arena, min: 60, max: 600, open: 0.45, accept: far(sep * LAST_RESORT_SEPARATION) },
    // Last resort: sample around the *finish* rather than the arena, so the one
    // property that cannot be given up is met by construction.
    { around: finish, min: sep * LAST_RESORT_SEPARATION, max: sep * LAST_RESORT_SEPARATION + 260, open: 0 },
  ]) ?? arena;
  const start = ontoNetwork(rawStart);

  const targetLegs = spec.legCount[0] + Math.floor(rng.next() * (spec.legCount[1] - spec.legCount[0] + 1));
  const controls: Control[] = [];
  let current = start;
  // The bearing to the finish, standing in for the leg you have just run.
  //
  // `pickNextControl` turns away from whatever it is given here, so handing it
  // the direction of the finish makes the existing rule do the new job: the
  // first leg leaves into the course instead of back across the arena. It used
  // to be a random draw, which is why a first leg 3° off the finish was possible
  // at all. `awayFrom` below tightens the same constraint rather than fighting
  // it — the two agree on which way is wrong.
  let lastBearing = bearing(start, finish);
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

    /**
     * How far it really is from here, over the network. **One Dijkstra a leg.**
     *
     * Computed here rather than inside `pickNextControl` because it depends on
     * the leg and not on the candidate, and `pickNextControl` weighs ninety
     * candidates: per candidate this would be ninety floods a leg and the whole
     * idea would be unaffordable at load; per leg it is a quarter of a
     * millisecond and the ratio is simply known while the leg is being chosen.
     *
     * That is the whole of §3's second bullet, and it is why this is not one of
     * D-037's three failed variants — those had no route to consult.
     */
    const legField = net?.fieldFrom(current) ?? null;

    const leg = (
      finishClearanceM: number,
      lengthScale: number,
      strictNetwork: boolean,
    ): World2 | null => pickNextControl({
      from: current,
      lastBearing,
      legLength: legLength * lengthScale,
      strictNetwork,
      rng,
      terrain: o.terrain,
      inBounds,
      minSeparationM: spec.minSeparationM,
      routeStepM: spec.routeStepM,
      maxLegClimbOverM: spec.maxLegClimbOverM,
      punchRadiusM: o.discipline === 'sprint' ? 6 : 9,
      // Late in the course, bend back toward the finish so the run-in is not a
      // forced sprint across the whole map. The finish rather than the arena
      // centre, now that the two are deliberately not the same point: what the
      // course has to converge on is the thing it ends at.
      homeBias: i >= targetLegs - 3 ? (i - (targetLegs - 4)) / 3 : 0,
      home: finish,
      // The finish is not a control and the course does not pass it. Kept clear
      // by whole legs rather than by control sites — a control 90 m from the
      // finish reached on a leg that sweeps past it at 10 m is the same fault —
      // and it is what leaves a run-in for the last control to sit outside.
      clearOf: { p: finish, m: finishClearanceM },
      // Leg 1 only: leave the arena, do not run back through it.
      ...(i === 0 ? { awayFrom: { p: finish, rad: FIRST_LEG_AWAY_RAD } } : {}),
      // A floor, so an exhausted budget does not reject every candidate and
      // strand the course — but a floor proportional to the budget rather than
      // a flat 25 m, which on a sprint's 19 m allowance *is* the whole budget
      // and made the ceiling below meaningless.
      climbLeftM: Math.max(spec.targetLengthM * spec.climbRatio * 0.3, climbLeftM),
      placed: [start, ...controls.map((c) => c.position)],
      ...(net ? { net } : {}),
      ...(legField ? { legField } : {}),
      // The run-in is nobody's leg. `pickNextControl` never sites the finish —
      // it was placed before the first control — so the one leg no candidate
      // rule has ever seen is the last one, and D-037's shipped table has it as
      // the worst leg of the course at 1.3×. On the last control the route to
      // the finish is checked as well as the route from the previous control.
      ...(net && i === targetLegs - 1 ? { homeField: net.fieldFrom(finish) } : {}),
      // Leg 1 only: the athlete must be able to run out of the start. See
      // `START_RUN_OUT_M` — this is fault 8, as a property of the pair.
      ...(i === 0 ? { runOutM: START_RUN_OUT_M } : {}),
    });

    // Full clearance first; a narrower pass rather than no leg at all.
    //
    // Every rule here rejects candidates, and the finish clearance rejects them
    // where the home bias is pushing hardest — so on a tight seed the last leg
    // has nowhere to go and the loop breaks, which does not shorten the course
    // by one leg, it ends it. Measured over 120 menu-shaped Krumlov seeds, the
    // hard rule alone pushed five of them under the 1.2 km a sprint is
    // specified at, against one before. A setter faced with the same corner
    // accepts a tighter pass; so does this, once, and `RELAXED_CLEARANCE`
    // stays clear of what `tools/ci/check-race.mjs` will accept.
    //
    // **The ladder, and why the shorter leg is on it.** Where the network rules
    // refuse every candidate, the usual reason is not that this leg is
    // impossible but that a leg *of this length* in any direction the turn rule
    // allows lands across the Vltava — the town is 500 m wide and the river
    // loops right round it. Pulling the leg in is what a setter does there, and
    // it costs a little course length rather than a whole seed. Only when all
    // four passes fail does the last one settle for the best rule-breaker,
    // which is D-037's finding that refusing outright *ends* the course.
    const site =
      leg(spec.finishClearanceM, 1, true) ??
      leg(spec.finishClearanceM, 0.7, true) ??
      leg(spec.finishClearanceM * RELAXED_CLEARANCE, 1, true) ??
      leg(spec.finishClearanceM * RELAXED_CLEARANCE, 1, false);
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

  const lengthM = measureLength(start, controls, finish);
  const climbM = measureClimb(start, controls, finish, o.terrain);

  const course: Course = {
    id: `${o.venue.id}-${o.discipline}-${o.seed}`,
    venue: o.venue.id,
    discipline: o.discipline,
    lengthM,
    climbM,
    start,
    finish,
    controls,
    refreshments: [],
    expectedWinningTimeS: TYPICAL_DURATION_S[o.discipline],
    seed: o.seed,
  };

  // Rule 19.8 is a property of the finished course, not of the setter's
  // intentions, so it is applied last and derived from what was actually sited.
  // Empty for Sprint by the rule — see src/sim/refreshment.ts.
  course.refreshments = siteRefreshments(course);
  return course;
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
  /**
   * A point the whole leg must stay clear of, and by how much. The finish: see
   * `Spec.finishClearanceM`.
   */
  clearOf?: { p: World2; m: number };
  /**
   * A point the leg must lead away from, and by how much, in radians. Used for
   * the first leg only — see `FIRST_LEG_AWAY_RAD`.
   */
  awayFrom?: { p: World2; rad: number };
  /** The venue's street network, where it has one. See `StreetRouting`. */
  net?: StreetRouting;
  /**
   * Metres over the network from `from` to any point — one Dijkstra, computed
   * once for the leg by the caller. See the note where it is built.
   */
  legField?: (q: World2) => number;
  /** The same, from the finish. Present on the last leg only: the run-in. */
  homeField?: ((q: World2) => number) | null;
  /**
   * How far the athlete must be able to run straight out of `from` toward the
   * candidate before something stops them, metres. Leg 1 only.
   */
  runOutM?: number;
  /**
   * Refuse rather than settle. With it, a pass that finds no candidate meeting
   * the network's rules returns null instead of the best rule-breaker, so the
   * caller can try again with a different leg length. See the ladder in
   * `generateCourse`.
   */
  strictNetwork?: boolean;
}

/** Metres of clear straight running from `a` toward `b`, capped at `capM`. */
function clearRunM(a: World2, b: World2, terrain: CourseTerrain, capM: number): number {
  // Called through the terrain rather than lifted into a local, because
  // `FieldTerrain.blockedAt` is a method and a detached one loses `this` —
  // which fails at *course setting* time, i.e. before the venue has drawn a
  // frame, and reads as "the town will not load".
  if (!terrain.blockedAt) return capM;
  const blocked = (x: number, z: number) => terrain.blockedAt!(x, z);
  const total = dist2(a, b);
  const reach = Math.min(capM, total);
  const ux = (b.x - a.x) / (total || 1);
  const uz = (b.z - a.z) / (total || 1);
  // Half a metre, which is under the narrowest collider in either venue and is
  // the spacing `Race.step` itself would meet a wall at over one stride.
  for (let d = 0.5; d <= reach; d += 0.5) {
    if (blocked(a.x + ux * d, a.z + uz * d)) return d - 0.5;
  }
  return reach;
}

/** Is this point out of bounds, where the terrain can say? */
function blockedAt(terrain: CourseTerrain, p: World2): boolean {
  return terrain.blockedAt ? terrain.blockedAt(p.x, p.z) : false;
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
  /**
   * The least bad candidate that broke a network rule. See the return below.
   *
   * Ranked by **detour and not by score**, which is the opposite of `best` and
   * deliberately so. Among candidates that are all allowed, the question is
   * which is the better control; among candidates that are all disallowed, the
   * question is which does least damage, and the score cannot answer it — the
   * detour preference term is zero for every one of them by construction, so
   * scoring would pick between 3.5× and 16× on feature quality alone.
   */
  let fallback: { p: World2; score: number; detour: number } | null = null;

  /**
   * How many bearings to try.
   *
   * 90 without a network and 200 with one, and the difference is not
   * arbitrary: the network adds three more ways for a candidate to be refused —
   * off the street, unroutable, over the detour limit — and 90 draws was tuned
   * against a loop that had none of them. Measured on Krumlov, going back to 90
   * with the network rules in place leaves the fallback firing on the late
   * home-bias legs, which is where a course that has wandered to the far bank
   * cannot get back. Each extra draw costs one snap and one array lookup; the
   * Dijkstra is the leg's, not the candidate's.
   */
  const attempts = o.net ? 200 : 90;
  for (let attempt = 0; attempt < attempts; attempt++) {
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
    const sited = findControlSite({
      around: p,
      minR: 0,
      maxR: nudgeR,
      rng: o.rng,
      terrain: o.terrain,
      inBounds: o.inBounds,
      minOpenness: 0.5,
    });
    if (!sited) continue;

    const feature = o.terrain.featureScoreAt(sited.x, sited.z);
    if (feature < 0.25) continue;

    // The finish is the end of a run-in, not somewhere the course goes past.
    // Measured against the whole leg rather than against the endpoint: the
    // seed that produced this rule threaded a leg within 2 m of the finish
    // while both its controls were comfortably clear of it.
    if (o.clearOf && pointToSegmentM(o.clearOf.p, o.from, sited) < o.clearOf.m) continue;

    // Leg 1: leave the arena. See `FIRST_LEG_AWAY_RAD`.
    if (
      o.awayFrom &&
      Math.abs(wrapAngle(bearing(o.from, sited) - bearing(o.from, o.awayFrom.p))) <
        o.awayFrom.rad
    ) {
      continue;
    }

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
    let score =
      feature * 1.0 +
      interest * 1.3 -
      climbPenalty * 1.15 -
      crossings * 0.9 +
      o.rng.next() * 0.15;

    // --- what the network says, while the leg is being set -------------------
    //
    // Everything above this line is a judgement about the *straight line*. The
    // three tests below are the ones §3 exists for, and each of them is a
    // question no straight-line probe can answer.
    let legal = true;
    /** How far round the leg goes, on the graph. 1 where there is no graph. */
    let legDetour = 1;
    if (o.net) {
      // A control must be on the street network. Not "near paved cells" — a
      // wall's other side is one metre from a street and a courtyard is fifteen
      // — but within a stride of a way the graph says you can run along.
      if (o.net.offNetworkM(sited) > MAX_CONTROL_OFF_NETWORK_M) continue;

      // How far it really is. `legField` is the leg's own Dijkstra and this is
      // a lookup; `detourOf` returns 1 where the excess is under the
      // measurement allowance, so a 47 m leg is not judged on 8 % of lattice.
      const there = o.legField ? o.legField(sited) : Infinity;
      // **Unroutable is not a long leg — it is not a control site at all.**
      //
      // Rejected outright rather than kept as a fallback, which is the
      // difference between the two ways this loop can say no. The graph has
      // twelve components: the arena's holds 98.6 % of it and the rest are
      // streets whose only link to it runs outside the playable square or
      // across ground the chords do not span. A control there has no bounded
      // route to the previous one *by any measure this setter has*, and
      // accepting one as a least-bad option is how a course with a leg of
      // sixteen times its straight line gets set.
      if (!Number.isFinite(there)) continue;
      const detour = detourOf(dist2(o.from, sited), there);
      legDetour = detour;
      if (detour > MAX_LEG_DETOUR) legal = false;
      // The run-in, on the last leg. See `homeField`.
      if (o.homeField) {
        const home = o.homeField(sited);
        if (!Number.isFinite(home)) continue;
        const runIn = detourOf(dist2(sited, o.home), home);
        legDetour = Math.max(legDetour, runIn);
        if (runIn > MAX_LEG_DETOUR) legal = false;
      }
      // A preference on top of the rule, so that 1.2× beats 2.8× among legs
      // that are both allowed. Zero at the limit, so it can never pull a
      // candidate back over it — `pick-course.mjs`'s own term, and the same
      // reasoning.
      score += Math.max(0, 0.9 * (1 - (detour - 1) / (MAX_LEG_DETOUR - 1)));
    }

    // Fault 8: run out of the start and hit a wall. Leg 1 only, and measured
    // toward the control the athlete is actually going to head for.
    if (o.runOutM !== undefined && clearRunM(o.from, sited, o.terrain, o.runOutM) < o.runOutM) {
      legal = false;
    }

    if (legal) {
      if (!best || score > best.score) best = { p: sited, score };
    } else if (
      !fallback ||
      legDetour < fallback.detour ||
      (legDetour === fallback.detour && score > fallback.score)
    ) {
      fallback = { p: sited, score, detour: legDetour };
    }
  }

  // **The network's rules are hard, and the fallback is why they can be.**
  //
  // D-037 measured what happens when a leg rule has no fallback: on a leg where
  // every candidate is across the obstacle, `generateCourse` breaks out of its
  // loop and the course does not lose a leg, it *ends* — Krumlov came out at 12
  // controls against the 14 a sprint is specified at, and two seeds in three
  // had to be shopped away from. A setter facing the same corner takes the best
  // bad option and moves on; the picker and the gate then decide whether the
  // finished course is raceable, which is D-032's division of labour.
  //
  // So an over-limit leg is possible and rare rather than impossible and
  // ruinous — and the caller tries three more times before it settles for one.
  if (best) return best.p;
  return o.strictNetwork ? null : (fallback?.p ?? null);
}

/**
 * A leg's detour ratio, with D-037's measurement allowance applied.
 *
 * Under `MIN_DETOUR_EXCESS_M` of excess the ratio is not a fact about the
 * course, it is a fact about snapping two points onto a network: 40 m is about
 * eight seconds of a sprinter's race, and nobody has ever reported "I could see
 * it across the street".
 */
function detourOf(straightM: number, routedM: number): number {
  if (!Number.isFinite(routedM)) return Infinity;
  if (routedM - straightM < MIN_DETOUR_EXCESS_M) return 1;
  return straightM > 0 ? Math.max(1, routedM / straightM) : 1;
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

/** One attempt at siting a start or a finish. Tried in order, loosest last. */
interface SiteBand extends Omit<SiteOptions, 'rng' | 'terrain' | 'inBounds'> {
  /** Legacy shorthand kept at the call sites: openness at 8 m, 0..1. */
  open: number;
  /** Minimum ground speed factor, 0..1. */
  speed?: number;
}

/**
 * Try successively looser bands until one yields a site.
 * Returns the first hit, or null if even the loosest band fails.
 */
function pickOpenSite(
  rng: Rng,
  terrain: CourseTerrain,
  inBounds: (p: World2) => boolean,
  bands: SiteBand[],
): World2 | null {
  for (const b of bands) {
    const p = findControlSite({
      ...b,
      rng,
      terrain,
      inBounds,
      minOpenness: b.open,
      minSpeed: b.speed ?? 0,
    });
    if (p) return p;
  }
  return null;
}

/** Both predicates, as one. Reads better at the band table than `&&` does. */
function both(
  a: (p: World2) => boolean,
  b: (p: World2) => boolean,
): (p: World2) => boolean {
  return (p) => a(p) && b(p);
}

interface SiteOptions {
  around: World2;
  minR?: number;
  maxR?: number;
  /** Shorthands used by the band tables. */
  min?: number;
  max?: number;
  rng: Rng;
  terrain: CourseTerrain;
  inBounds: (p: World2) => boolean;
  minOpenness?: number;
  minSpeed?: number;
  /**
   * Restrict sampled bearings to ±`half` radians around `centre`.
   *
   * Not a filter — the samples are *drawn* inside the sector, so a 60° window
   * costs the same sixty samples a full circle does. That matters: the start is
   * wanted on the far side of the arena from the finish, and rejecting five
   * sixths of a uniform circle would leave ten usable draws to pick from.
   */
  sector?: { centre: number; half: number };
  /** A cheap test every sample must pass. */
  accept?: (p: World2) => boolean;
  /**
   * An expensive test, run on the best candidates only — at most `MAX_VERIFY`
   * of them, best first. The escape flood.
   */
  verify?: (p: World2) => boolean;
}

/** Find a describable feature near a point. */
function findControlSite(o: SiteOptions): World2 | null {
  const minR = o.minR ?? o.min ?? 0;
  const maxR = o.maxR ?? o.max ?? 0;
  const minOpenness = o.minOpenness ?? 0;
  const minSpeed = o.minSpeed ?? 0;
  const found: { p: World2; s: number }[] = [];

  for (let i = 0; i < 60; i++) {
    const a = o.sector
      ? wrapAngle(o.sector.centre + (o.rng.next() * 2 - 1) * o.sector.half)
      : o.rng.next() * Math.PI * 2;
    const r = minR + o.rng.next() * (maxR - minR);
    const p = { x: o.around.x + Math.sin(a) * r, z: o.around.z - Math.cos(a) * r };
    if (!o.inBounds(p)) continue;
    // A control may not sit in impassable ground — in sprint that is a DSQ
    // offence for the runner, so it must never be the target.
    if (o.terrain.runnabilityAt(p.x, p.z) === Runnability.Impassable) continue;
    // Require room to move, not just a legal cell to stand on.
    if (minOpenness > 0 && openness(p, o.terrain, 8) < minOpenness) continue;
    // And require ground worth standing on. A start can be perfectly open and
    // still be in scrub: the Krumlov start landed on Green2 at 0.4x speed, so
    // the first strides crawled and the game read as broken even though
    // nothing was blocking. Openness and runnability are different problems.
    if (minSpeed > 0 && (SPEED_BY_RUNNABILITY[o.terrain.runnabilityAt(p.x, p.z)] ?? 0) < minSpeed) {
      continue;
    }
    if (o.accept && !o.accept(p)) continue;
    found.push({ p, s: o.terrain.featureScoreAt(p.x, p.z) });
  }

  if (!found.length) return null;
  found.sort((a, b) => b.s - a.s);
  if (!o.verify) return found[0]!.p;
  for (let i = 0; i < Math.min(MAX_VERIFY, found.length); i++) {
    if (o.verify(found[i]!.p)) return found[i]!.p;
  }
  return null;
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
