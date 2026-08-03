#!/usr/bin/env node
/**
 * Passability gate for the sprint venue.
 *
 * Two phases, because "the venue is connected" and "the player can play" turned
 * out to be different claims twice over.
 *
 * **Phase 1, offline.** Reproduces, exactly, the three things
 * `SprintScene.blockedAt` consults at runtime — the shipped runnability raster,
 * the OSM building footprints, and the uncrossable barriers in
 * `Townscape.blocks` — and asks the only question that matters to a player:
 * from the arena, what can you reach? It runs **once per distinct raster the
 * manifest hands to a tier**, which is the lesson from the failure below.
 *
 * **Phase 2, in the real runtime.** Loads the production build in headless
 * Chrome, at several seeds and *every quality tier*, and checks the points the
 * athlete is actually placed on: the start, every control and the finish. None
 * may be inside a barrier or a building footprint; none may leave the eye
 * hovering off the surveyed ground; and from the start the athlete must be able
 * to reach open ground, tested with the runtime's own collision rather than
 * with a mask. Then it asks the question those points cannot answer on their
 * own: do two tiers, on one seed, produce the *same course on the same rules
 * surface*? Both are fingerprinted and compared exactly.
 *
 * ---------------------------------------------------------------------------
 * Why phase 2, and why "every tier"
 * ---------------------------------------------------------------------------
 *
 * This gate passed — 95.1 % reachable, no trap — while a phone was unplayable.
 * `TerrainField.load` gave the `low` tier a **4 m** runnability raster, and
 * Krumlov's alleys are 2–3 m wide, so the town sealed: 49 % of the centre came
 * back `Impassable`, the ground reachable from Náměstí Svornosti fell from
 * 97.2 % to **0.15 %**, `setCourse` could site **one** control instead of
 * fifteen, and the athlete was walled into a 3 000 m² pocket around the square.
 * The gate never saw it because it read `runnability.bin` and the phone read
 * `runnability-low.bin`. Same shape as D-025: green on one lucky draw.
 *
 * The raster is fixed (there is no low-detail class raster any more — see
 * `TerrainField.load`), and both halves of the blindness are closed here.
 *
 * Usage: node tools/ci/check-passable.mjs [--venue krumlov] [--step 0.5] [--offline]
 * Exit codes: 0 pass, 1 a trap or a disagreement was found, 2 harness failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from './chrome.mjs';
import { readModel, colliders } from '../terrain/townmodel.mjs';
import { derivePassable } from '../terrain/passable.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

/** Runnability.Impassable — see src/core/types.ts. */
const IMPASSABLE = 10;

/** The arena, from `START` in src/world/sprintScene.ts. */
const ARENA = { x: 1, z: 24 };

/** Half-extent of the playable area, metres. Per `VENUES.krumlov` in townscape.mjs. */
const PLAYABLE_R = 600;

/** `EYE_HEIGHT` in src/world/sprintScene.ts. */
const EYE_HEIGHT = 1.62;

/**
 * The longest single step the athlete can take, metres.
 *
 * `Race.step` moves `speed * dtS` and tests only the destination, and the
 * scene clamps `dtS` to 0.1 s. The fastest the athlete goes is BASE_MS 4.6 on
 * a road (`SPEED_BY_RUNNABILITY[Road]` = 1.0) with the downhill bonus capped
 * at 1.22, so 4.6 * 1.22 * 0.1 = 0.56 m. Rounded up, because a gate that is
 * exactly at the limit tests nothing.
 */
const MAX_STEP_M = 0.6;

/** BASE_MS in src/sim/race.ts. */
const BASE_MS = 4.6;

/** Downhill cap on `gradeMul`, same file. */
const DOWNHILL_MAX = 1.22;

/** SPEED_BY_RUNNABILITY in src/sim/athlete.ts, by class index. */
const SPEED_BY_CLASS = [1.0, 0.97, 0.9, 0.72, 0.8, 0.6, 0.4, 0.18, 0.45, 0.5, 0];

/** Class names, for reporting. */
const CLASS_NAME = ['Road', 'Path', 'OpenFast', 'OpenRough', 'ForestOpen', 'Green1',
  'Green2', 'Green3', 'Marsh', 'Rock', 'Impassable'];

/**
 * Thresholds.
 *
 * `minReachable` is a floor on the fraction of otherwise-open ground the arena
 * can reach, tested on a 0.5 m grid whose *edges* are checked at their
 * midpoints — because a barrier lying between two open cell centres is exactly
 * what a continuous collider stops you at and a naive cell test walks through.
 */
const LIMITS = {
  minReachable: 0.9,
  /**
   * Largest tolerated **sealed** pocket the arena cannot reach, m².
   *
   * Not zero, and deliberately. Krumlov has walled ground that is *supposed* to
   * be shut: the Baroque zámecká zahrada behind its garden wall is 0.9 ha of
   * genuinely enclosed parterre, and a handful of block interiors are reached
   * only through arched passages OSM maps as `tunnel=building_passage`, which a
   * footprint stamp closes. None of those is a trap — the athlete cannot get in
   * either, and the course generator will not site a control there.
   *
   * What the ceiling catches is the failure that actually shipped: sever the
   * bridges and the largest unreachable pocket is **54 hectares**.
   *
   * This applies **only to pockets the athlete cannot enter**. Ground they can
   * get into is judged by `maxTrapM2` below, at any size, because that is a
   * different bug with a different consequence.
   */
  maxPocketM2: 30_000,
  /**
   * The distinction this gate could not previously express, and the whole of
   * the bug class behind four separate "we are stuck" reports in this venue.
   *
   * A pocket that is not the arena's component is *fine* if the athlete can
   * never get into it, at any size. It is a **trap** if they can get in and
   * cannot get out, at any size — and the gate has to test entry, not just
   * exit, to tell the two apart.
   *
   * Entry is possible because `Race.step` tests only the **destination** of a
   * step, never the swept path: a step of length `MAX_STEP_M` crossed any
   * barrier band thinner than that — until `SWEEP_M` (see `floodFill`). The
   * figure is kept because it still bounds how far a single frame moves the
   * athlete. So a pocket is enterable when some point
   * inside it is within one step of open ground in the arena's component. Once
   * in, the athlete gets back out the same way only if they can build the same
   * step — and they may not be able to, because step length is speed × dt and
   * speed depends on the ground they are standing on. Entering off a road at
   * 4.6 m/s is a 0.46 m step; leaving from grass at 3.3 m/s is 0.33 m. That
   * asymmetry is what "we were locked in some little park on the grass" would
   * look like in the physics, so it is tested explicitly.
   *
   * `minWanderM2` is the area above which a symmetric gap stops being a way
   * out: below it the athlete is never more than a few strides from the hole
   * they came through, above it the hole is a needle. 150 m² is about 12 m
   * square. An *asymmetric* gap is a trap at any size at all.
   */
  minWanderM2: 150,
  /** Fraction of uncrossable barrier length that must appear in the raster. */
  minBarrierDrawn: 0.995,
  /**
   * Fraction of building interior that must come back impassable, sampled a
   * metre inside the footprint wall. Measured: 1.000.
   */
  minFootprintDrawn: 0.995,
  /**
   * Metres of barrier that may be drawn taller than `crossableMaxH` while
   * nothing stops the athlete at it. Zero, and it has to be zero: this is the
   * exact defect the client reported, and there is no tolerance band in which
   * "you can see it but you run through it" is acceptable.
   */
  maxDrawnLooseM: 0,
  /**
   * How much of the playable ground the raster may call impassable with nothing
   * drawn on it, as a fraction. Measured: 0.012.
   *
   * Not zero, and it cannot be. The runnability raster carries ZABAGED's
   * buildings and water bodies (build.mjs, layers 99 and 132) while the town is
   * *drawn* from OSM, and two national datasets do not trace the same outline
   * to the centimetre. At 1 m cells the residual is a one-cell rind round every
   * building and along both banks of the Vltava. 2 % leaves room for that and
   * none for a systematic displacement, which is a different shape of number
   * entirely — see `trend` and `directional` below.
   */
  maxGhostFraction: 0.02,
  /**
   * The rotation test, and the reason this gate exists in this shape.
   *
   * If a layer were left in the S-JTSK grid frame the disagreement would grow
   * with distance from the origin at tan(7.95°) ≈ 0.14 m per metre and every
   * offset would point the same way. `maxTrend` is metres of disagreement per
   * metre of radius; `maxDirectional` is the resultant length of the offset
   * bearings, which a real rotation drives towards 1. Krumlov measures ≈0 for
   * both. These are set an order of magnitude below the rotation signature and
   * an order above the noise, so they catch a frame error on the day it is
   * introduced and never fire on dataset drift.
   */
  maxTrend: 0.01,
  maxDirectional: 0.35,
  /**
   * How far the eye may sit from `terrain + EYE_HEIGHT`, metres.
   *
   * Tight, because this is a contract rather than a tolerance: the ground
   * follow in `SprintScene.frame` eases toward exactly that height, so anything
   * outside a centimetre means something else is driving the camera.
   */
  maxEyeErrorM: 0.05,
  /**
   * How far the tier's heightfield may sit from the surveyed 1 m DMR, metres.
   *
   * This is the levitation test proper. Buildings, walls, steps and street
   * trees are all founded on `field.heightAt`, so a heightfield that disagrees
   * with the survey does not make anything float on its own — but it is the
   * mechanism by which a cheaper tier stops being the same terrain, and 2.5 m
   * is already a storey. The measured worst case for `height-low` over the
   * playable extent is 8 m, at a cliff edge; over the town it is centimetres,
   * so this bites only if a course is ever sited on the cliff.
   */
  maxHeightDriftM: 2.5,
  /**
   * How much ground the athlete can actually walk on from the start, m²,
   * measured with the runtime's own continuous collision rather than with a
   * mask — and stated as an *area* rather than as a radius on purpose.
   *
   * "We are in some small circle and cannot continue" is a statement about
   * area. The pocket the `low` tier sealed the athlete into around Náměstí
   * Svornosti was 3 000 m² but 86 m across, so a radius threshold has to be
   * set above 86 m to catch it, and at that height it starts failing perfectly
   * good starts in a walled alley. Area separates the two cleanly, and it is
   * far cheaper to measure: the flood stops as soon as it exceeds the bound.
   *
   * 2 ha against an arena component of 104 ha is not a close call in either
   * direction.
   */
  minStartPocketM2: 20_000,
  /**
   * Floor on `reachableFraction`, as the *runtime* measures it.
   *
   * The same number phase 1 applies to the raster, asserted again on the other
   * side of `TerrainField.load`. That is not redundancy: the manifest is
   * decorative — `TerrainField.load` picks its files by name — so a phase that
   * reads the manifest can be told a raster is in use that is not. This asks
   * the running game.
   */
  minRuntimeReachable: 0.9,
  /**
   * What opening the venue may spend on venue-wide passes, ms, unthrottled.
   *
   * Phase 0 measured the two that existed at 2.6 s and 2.9 s on the
   * 4×-throttled Android proxy — 5 902 ms together, confirmed on the shipped
   * build before phase 2 touched it — and required them to move into the
   * build. They did, and the same instrument now reads 1 ms.
   *
   * 250 ms is therefore not a target, it is a tripwire: it is two orders below
   * the sweeps this replaced and two orders above what the reads cost, so
   * nothing but a venue-wide pass reappearing can trip it. This gate runs
   * unthrottled; `tools/perf/setup-cost.mjs` is where the phone is asked.
   */
  maxSetupMs: 250,
  /**
   * Fewest controls that make a race. Mirrors `MIN_CONTROLS_FOR_A_RACE` in
   * src/race/courseSetup.ts: below this the terrain has refused, and a sprint
   * of one control over 500 m is the shape a sealed venue produces.
   */
  minControls: 8,
  /**
   * How far a point sited on a bridge must stand above the water, metres.
   *
   * Only sited points over water are asked, and for those the answer used to be
   * *minus five*. Half a metre is not a clearance requirement — a real Krumlov
   * footbridge sits about a metre over the Vltava — it is the line between
   * "standing on the deck" and "standing in the river", and it wants to be
   * comfortably above the noise in the abutment heights the deck is derived
   * from.
   */
  minFreeboardM: 0.5,
  /**
   * How much of the fastest run between controls must be on the street network,
   * as a fraction of the whole course.
   *
   * The client's sentence is *"runs through the alleys"*, and controls sitting
   * near paved ground does not establish it: a control on a corner reached
   * across a meadow satisfies every per-control measure and fails the sentence.
   * So this measures the **legs**. For each leg the gate runs a Dijkstra over
   * the runnable mask with the athlete's own class speeds — the fastest way
   * there, which is the route an orienteer takes — and asks what fraction of it
   * is on Road or Path.
   *
   * 0.75 rather than 1.0 because a sprint in this town legitimately crosses
   * Náměstí Svornosti, the castle gardens and a couple of grassed terraces, and
   * a gate that forbade those would be setting a worse course than the one it
   * rejected. What it catches is a course whose legs are bearings over open
   * ground with streets merely nearby.
   */
  minLegsOnNetwork: 0.75,
  /**
   * Must the start and the finish **stand on** the street network, rather than
   * merely near it? **Fault 8, docs/PLAN-KRUMLOV-V2.md §1.**
   *
   * `minLegsOnNetwork` above scores the course as a whole and gave the shipped
   * Krumlov course 96 %. It is silent about its single most-looked-at point,
   * and that silence is what let the start walk into the woods: measured at
   * `krumlov-sprint-30814554`, the start stands in **ForestOpen**, on the edge
   * of the built-up area, with a `town.blocks` barrier 11 m ahead on the
   * bearing to control 1. Run out of the start and there is a wall — the
   * client's own sentence, and a regression introduced by re-picking the seed
   * to kill D-037's 12× leg.
   *
   * **Why this is a class test and not a distance test**, which is the whole
   * design of it. The shipped start is **1.4 m** from the nearest Road cell —
   * one diagonal cell of the 1 m raster. *Any* distance tolerance large enough
   * to absorb raster quantisation is large enough to pass the exact fault it
   * exists to catch, so there is no tolerance to tune and the rule is the plain
   * one: the cell the start is sited in is Road or Path, or it is not on the
   * network. Measured on the shipped course, the finish and 11 of 17 controls
   * already satisfy it, and Náměstí Svornosti — the arena, and where a start
   * belongs — is stamped Road for 1629 of the 1681 cells around it, so a start
   * on the square passes comfortably.
   *
   * Only the start and the finish. Controls are deliberately exempt: a sprint
   * control legitimately sits on the corner of a building or at the foot of a
   * stairway, off the carriageway by a metre — the shipped course's controls
   * run a median of 0.0 m and a p90 of 4.2 m off the network, and forbidding
   * that would be setting a worse course than the one it rejected.
   */
  endsOnNetwork: true,
  /**
   * How far a leg may run compared with the straight line between its ends —
   * `routedM / straightM`, per leg. **D-037.**
   *
   * The bug class this closes, stated once. Every leg measure in this file
   * before it was a *boolean*: `routed` says the leg can be run and
   * `pavedFraction` says what it is run on, and a course all of whose legs are
   * routable and paved can still be unplayable. The shipped Krumlov course had
   * controls 1 and 2 **58 m apart on opposite banks of the Vltava with no
   * bridge between them**: routable, 99 % street, and 810 m of running — 14×.
   * The player sees the flag across the water and runs a lap of the town. This
   * is the same shape as D-019 and D-023: the check could say connected or
   * not-connected and had no way to say *connected and absurd*. `route()`
   * already computed `lengthM` per leg and threw the comparison away.
   *
   * **Why 3.0, from the sport rather than from what passes.**
   *
   *  - A detour is *legitimate*. IOF Rule 16.3 measures a course as the
   *    straight line "deviating for, and only for, physically impassable
   *    obstructions" — so the rules positively expect legs to go round things,
   *    and Appendix 6 §1.1 makes the choice of *which* way round the point of
   *    the sprint format. A gate at 1.2 would forbid sprint orienteering.
   *  - But it is *small*. RESEARCH-SPORT §8.6 derives the whole-course detour
   *    factor `D` — run distance over stated length — as **1.05 for sprint**
   *    and 1.18 for forest, and notes the sprint figure is low precisely
   *    because the stated length already deviates round the impassables. Route
   *    efficiency (100 × straight / actual) is classed "high" above 90 and
   *    "low" below 50, i.e. elites live between **1.1× and 2.0×**, and 2.0 is
   *    the bottom of the published scale.
   *  - So 3.0 is half again beyond the worst leg the literature has a word
   *    for, and it is deliberately permissive: this is a floor under
   *    indefensible, not a definition of good. The two faults the client found
   *    ran 14.0× and 10.3×. A course that has to be defended at 2.9× should be
   *    rejected by `tools/sim/pick-course.mjs` on score long before it reaches
   *    here.
   *
   * The ratio is also what the course *description sheet* is lying about. Rule
   * 16.3 makes the stated length the deviated length, and `measureLength` in
   * src/sim/courseGen.ts sums straight lines — so a 14× leg is 750 m of running
   * that the printed 1558 m does not contain.
   */
  maxLegDetour: 3.0,
  /**
   * Metres of excess (`routedM − straightM`) below which the ratio is not
   * asked at all.
   *
   * Two reasons, and both are about the measurement rather than the sport.
   * The router walks a 2 m lattice with eight neighbours, which overstates a
   * true path by up to 8 %, and it snaps each end onto the nearest open cell,
   * which can move a control up to 3 m. On a 47 m sprint leg — legal at 25 m
   * running distance under Rule 19.4 — that noise alone is worth about 0.2 in
   * the ratio, and a leg that steps round one 20 m building block reads 1.6×
   * while costing the player thirty metres.
   *
   * 40 m is about eight seconds of a sprinter's race. Below it there is no
   * complaint to make: nobody has ever reported "I could see it across the
   * street". The two real faults carried 752 m and 455 m of excess.
   */
  minDetourExcessM: 40,
  /**
   * The same measure applied to the **generator** rather than to a course: the
   * median leg detour over every sampled seed and tier.
   *
   * Two different claims, and conflating them would be the mistake. `SEEDS`
   * above are menu-shaped samples of the generator's output space; nobody plays
   * them. The course that ships is *chosen*, by `tools/sim/pick-course.mjs`,
   * from several hundred candidates — and D-032's whole argument is that a
   * generator is not a course setter: "a real event does not take the first
   * course its planning software offers. A setter generates, walks, and picks."
   * Demanding that every seed be raceable is demanding the generator be the
   * setter, and it is not one; what it must be is *usually* right, so that the
   * setter has something to pick from.
   *
   * So: the per-leg limit is asserted absolutely on the shipped course, in
   * `stabilityPhase`, with no tolerance at all — that is the course the client
   * plays. Across the sampled seeds the gate asserts this population figure and
   * prints the whole distribution, which is what catches the generator getting
   * systematically worse.
   *
   * 1.6 is from RESEARCH-SPORT §8.6: real running distance "can be 30–60 %
   * longer than the stated length in sprint", so 1.6 is the top of the measured
   * real range for a whole sprint course, applied here to the median leg. It is
   * a tripwire and not a quality bar — the measured median is 1.13 — and it is
   * set where it is because a generator whose *typical* leg runs 1.6× its
   * straight line is no longer producing sprint courses at all.
   */
  maxMedianLegDetour: 1.6,
};

/**
 * Seeds, chosen to look like the ones players get.
 *
 * The menu seeds a course with `(Date.now() / 60000) | 0` — an eight-digit
 * number. Testing 3, 7, 19 and 42 exercises a corner of the generator's input
 * space that no player will ever see, and the tier bug above showed up only on
 * a menu-shaped seed. These are fixed so the gate is deterministic.
 */
const SEEDS = [29_760_961, 29_112_007, 28_803_419, 30_240_557];

/** Every tier `detectCapabilities` can return. `medium` reads the same files as `high`. */
const TIERS = ['low', 'high'];

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function venueDir(venue) {
  return resolve(ROOT, 'public/data', venue);
}

/**
 * Every distinct runnability raster the venue can be loaded with.
 *
 * Read from the manifest rather than assumed, so that reintroducing a per-tier
 * raster reintroduces a flood-fill of it rather than a blind spot.
 */
function tierRasters(venue) {
  const dir = venueDir(venue);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const byFile = new Map();
  for (const [tier, files] of Object.entries(manifest.tiers ?? {})) {
    const name = files.runnability ?? 'runnability.bin';
    if (!byFile.has(name)) byFile.set(name, []);
    byFile.get(name).push(tier);
  }
  if (!byFile.size) byFile.set('runnability.bin', ['high']);
  return [...byFile].map(([bin, tiers]) => ({ bin, tiers }));
}

/**
 * A venue's rules surface, offline.
 *
 * The townscape is **optional**, and that is what lets `makeLegRouter` serve
 * the forest as well as the town. Krumlov's collision is the raster plus
 * `Townscape.blocks` plus the water rule; Martínkov has no `SprintScene` and
 * therefore no `blockedAt` at all, so its collision is the raster alone — which
 * is exactly what an empty townscape produces here. Everything below reads
 * `town.walls`, `town.water` and friends through `?? []`, so the two cases run
 * the same code rather than a fork of it.
 */
function loadVenue(venue, bin) {
  const dir = venueDir(venue);
  const meta = bin.replace(/\.bin$/, '.json');
  const rMeta = JSON.parse(readFileSync(join(dir, meta), 'utf8'));
  const r = new Uint8Array(readFileSync(join(dir, bin)));
  const townPath = join(dir, 'townscape.json');
  const town = existsSync(townPath)
    ? JSON.parse(readFileSync(townPath, 'utf8'))
    : { buildings: [], walls: [], water: [], paved: [] };
  // The vector model, where the venue has one. Everything below that used to
  // reconstruct the runtime's colliders from `townscape.json` now reads the
  // artefact the game itself loads — see D-038. The forest has no model and
  // takes the raster-only path, which is what it has always had.
  const modelPath = join(dir, 'townmodel.bin');
  if (existsSync(modelPath)) {
    const { header, model } = readModel(dir);
    town.model = model;
    town.modelHeader = header;
  }
  return { rMeta, r, town };
}

/**
 * The lattice the venue's shipped passable space is on, or null if it has none.
 *
 * Read rather than assumed, so that the audit and the artefact cannot end up on
 * different grids — which is the D-027 shape (the gate read one file, the phone
 * read another) applied to a measurement instead of to a rule.
 */
function venuePassableRes(venue) {
  const p = join(venueDir(venue), 'passable.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).resM ?? null;
}

function pointInFlatRing(p, x, z) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// The runtime's continuous colliders
// ---------------------------------------------------------------------------

/** Mirrors WALL_SPEC in src/world/townscape.ts. */
const WALL_THICK = { 0: 0.45, 1: 1.15, 2: 0.6, 3: 0.1, 4: 0.95 };

class Colliders {
  constructor(town) {
    this.cell = 12;
    this.rings = new Map();
    this.segs = new Map();
    this.ringData = [];
    this.segData = [];

    // The vector model, where there is one: its footprints and the barriers it
    // derives solidity for, from the same height and thickness the geometry is
    // drawn to. Where there is not — the forest — nothing is added and the
    // caller's collision is the raster alone, as it has always been.
    const model = town.model;
    if (model) {
      const h = town.modelHeader;
      for (const ring of model.buildings) {
        if (ring.length >= 6) this.addRing(ring);
      }
      for (const b of model.barriers) {
        // `blocks` is `height > crossableMaxH`, derived here exactly as
        // `TownModel` derives it. There is no flag in the file to read instead.
        if (!(b.height > h.crossableMaxH)) continue;
        const half = h.thicknessByKind[b.kind] * 0.5 + h.skinM;
        for (let i = 0; i + 3 < b.pts.length; i += 2) {
          const ax = b.pts[i];
          const az = b.pts[i + 1];
          const bx = b.pts[i + 2];
          const bz = b.pts[i + 3];
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 0.15 || len > 120) continue;
          this.addSeg(ax, az, bx, bz, half);
        }
      }
      return;
    }

    for (const b of town.buildings ?? []) {
      if (b.p.length < 6) continue;
      this.addRing(b.p);
    }
    for (const w of town.walls ?? []) {
      const thick = WALL_THICK[w.k];
      if (thick === undefined || !w.u) continue;
      const half = thick * 0.5 + 0.25;
      const n = w.p.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const ax = w.p[i * 2];
        const az = w.p[i * 2 + 1];
        const bx = w.p[i * 2 + 2];
        const bz = w.p[i * 2 + 3];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.15 || len > 120) continue;
        this.addSeg(ax, az, bx, bz, half);
      }
    }
  }

  addRing(p) {
    const idx = this.ringData.length;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minZ) minZ = p[i + 1];
      if (p[i + 1] > maxZ) maxZ = p[i + 1];
    }
    this.ringData.push(p);
    this.index(this.rings, idx, minX, minZ, maxX, maxZ);
  }

  addSeg(ax, az, bx, bz, half) {
    const idx = this.segData.length;
    this.segData.push([ax, az, bx, bz, half]);
    this.index(
      this.segs,
      idx,
      Math.min(ax, bx) - half,
      Math.min(az, bz) - half,
      Math.max(ax, bx) + half,
      Math.max(az, bz) + half,
    );
  }

  index(map, idx, minX, minZ, maxX, maxZ) {
    for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
        const key = cx * 100003 + cz;
        let list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        list.push(idx);
      }
    }
  }

  inBuilding(x, z) {
    const list = this.rings.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return false;
    for (const i of list) if (pointInFlatRing(this.ringData[i], x, z)) return true;
    return false;
  }

  inBarrier(x, z) {
    const list = this.segs.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return false;
    for (const i of list) {
      const [ax, az, bx, bz, half] = this.segData[i];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      if (px * px + pz * pz <= half * half) return true;
    }
    return false;
  }
}

/**
 * `SprintScene.blockedAt`'s water clause, offline.
 *
 * Mirrors `TownSurface.inWater` in src/world/surface.ts: water is out of bounds
 * under ISSprOM 301 **unless a bridge carries you over it**. Both halves are
 * pure geometry out of `townscape.json` — no heights and no tier — which is
 * what lets this file reproduce them exactly.
 *
 * `DECK_HALF_MIN_M` is the same 1.4 m floor `stampRaster` paints the deck into
 * the raster with, so the ground that is passable and the ground that is
 * exempt from the water rule are one band.
 */
const DECK_HALF_MIN_M = 1.4;

class WaterBounds {
  constructor(town) {
    this.water = new Colliders({ buildings: [], walls: [] });
    this.decks = new Colliders({ buildings: [], walls: [] });
    const model = town.model;
    if (model) {
      for (const a of model.waterAreas) this.water.addRing(a.pts);
      for (const c of model.waterCourses) {
        for (let i = 0; i + 3 < c.pts.length; i += 2) {
          this.water.addSeg(c.pts[i], c.pts[i + 1], c.pts[i + 2], c.pts[i + 3], c.width * 0.5);
        }
      }
      for (const d of model.decks) {
        const half = Math.max(town.modelHeader.deckHalfMinM, d.width * 0.5);
        for (let i = 0; i + 3 < d.pts.length; i += 2) {
          this.decks.addSeg(d.pts[i], d.pts[i + 1], d.pts[i + 2], d.pts[i + 3], half);
        }
      }
      return;
    }
    for (const w of town.water ?? []) {
      if (w.p && w.p.length >= 6) this.water.addRing(w.p);
      else if (w.l && w.w) {
        for (let i = 0; i + 3 < w.l.length; i += 2) {
          this.water.addSeg(w.l[i], w.l[i + 1], w.l[i + 2], w.l[i + 3], w.w * 0.5);
        }
      }
    }
    for (const way of town.paved ?? []) {
      if (!way.b) continue;
      const half = Math.max(DECK_HALF_MIN_M, way.w * 0.5);
      for (let i = 0; i + 3 < way.l.length; i += 2) {
        this.decks.addSeg(way.l[i], way.l[i + 1], way.l[i + 2], way.l[i + 3], half);
      }
    }
  }

  /** Is water drawn over (x, z)? */
  wet(x, z) {
    return this.water.inBuilding(x, z) || this.water.inBarrier(x, z);
  }

  /** Is (x, z) on a bridge carriageway? Mirrors `BridgeDecks.covers`. */
  onDeck(x, z) {
    return this.decks.inBarrier(x, z);
  }

  /** Out of bounds because of water. */
  blocks(x, z) {
    return this.wet(x, z) && !this.onDeck(x, z);
  }
}

/**
 * `SprintScene.blockedAt`, offline and whole.
 *
 * Kept as one function rather than spelled out at each call site: it had been
 * written out twice, in `floodFill` and in `makeLegRouter`, and the second copy
 * is where a clause goes missing. Both now differ from the runtime in exactly
 * one way, which is that they cannot see the landmark footprints `Buildings`
 * skips — and that makes them stricter, never looser, because `Colliders` adds
 * every ring in the file.
 *
 * The `onDeck` term on the barrier clause is D-033: a bridge carriageway is a
 * crossing, and neither an uncrossable barrier nor the class under it may close
 * it. Water off the deck still does.
 */
function blockedAtOf(col, wb, rasterAt, useRaster = true, authoritativeR = null) {
  return (x, z) => {
    if (col.inBuilding(x, z)) return true;
    if (col.inBarrier(x, z) && !wb.onDeck(x, z)) return true;
    if (wb.blocks(x, z)) return true;
    if (!useRaster) return false;
    /**
     * Inside the model's own square the raster no longer answers, because in
     * the game it no longer answers either.
     *
     * `Race.step` used to collide against `FieldTerrain.runnabilityAt`, which
     * was the model *or* the 1 m class raster, so phase 1's exact colliders
     * were read through a lattice whose `Impassable` cells are 1 m squares of
     * world and whose class widens anything narrower than a cell out to half a
     * cell diagonal. `tools/terrain/quantisation.mjs` measured the bill on the
     * town's own centrelines: the median ≤3 m alley ran 1.80 m against the
     * model and 1.52 m through the raster, and **12.8 % of alley centreline was
     * ground the athlete could not stand on**. Phase 2 made the model the whole
     * answer inside `authoritativeR`; this follows it, because a gate that
     * keeps the old predicate is measuring a game nobody is playing.
     */
    if (authoritativeR !== null && Math.abs(x) <= authoritativeR && Math.abs(z) <= authoritativeR) {
      return false;
    }
    return rasterAt(x, z) === IMPASSABLE;
  };
}

// ---------------------------------------------------------------------------
// Phase 0 — does the world the player sees agree with the world that stops them
// ---------------------------------------------------------------------------

/**
 * Sample the drawn town against the raster, in both directions.
 *
 * Written for a report that read "I go through some brown walls, and then I'm
 * stuck again" — two symptoms of one disease, a barrier that exists in one
 * representation and not the other. It answers three questions the flood-fill
 * cannot, because a venue can be perfectly connected and still lie to the
 * player about where its walls are.
 *
 *  1. **Is anything drawn that does not stop you?** Every barrier taller than
 *     `crossableMaxH` must carry a collider. Below it, the athlete steps over
 *     and the geometry is drawn low enough to say so. There is no third case,
 *     and the one that shipped — 13 849 m drawn at 1.5 m with no collider —
 *     was 44 % of the barrier length in the venue.
 *  2. **Is anything enforced that is not drawn?** Uncrossable barriers and
 *     building footprints are sampled along their length and must come back
 *     `Impassable` from the raster, which is what the map draws.
 *  3. **Is the raster impassable where nothing is drawn at all?** These are the
 *     invisible walls. Reported as area, as the worst distance from the nearest
 *     visible feature, and — because a misregistered frame is the obvious
 *     suspect — with the two statistics that would prove it.
 *
 * **On the rotation hypothesis.** D-017 records that S-JTSK grid north is 7.95°
 * off true north here and that the rasters are resampled into the world frame,
 * so a passability layer left in the wrong frame would displace every barrier
 * by an amount growing with distance from the origin and in a consistent
 * direction. That is exactly the symptom, so this measures it directly: `trend`
 * is the least-squares slope of disagreement against radius (a rotation gives
 * ~0.14 m/m at 7.95°) and `concentration` is the resultant length of the offset
 * bearings, 1 for "all the same way" and 0 for scatter. Krumlov measures a
 * slope of about zero and a concentration near zero: the disagreement is
 * quantisation and ZABAGED-versus-OSM outline drift, not a frame error. The
 * numbers are printed every run so the next person does not have to take that
 * on trust.
 */
function agreement(venue, bin) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const capH = town.crossableMaxH ?? Infinity;

  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };

  // --- 1. drawn taller than the athlete can step over, and not enforced ----
  let drawnLoose = 0;
  let drawnLooseWays = 0;
  let worstLoose = 0;
  for (const w of town.walls) {
    if (w.u || w.h <= capH) continue;
    drawnLooseWays++;
    if (w.h > worstLoose) worstLoose = w.h;
    for (let i = 0; i + 3 < w.p.length; i += 2) {
      drawnLoose += Math.hypot(w.p[i + 2] - w.p[i], w.p[i + 3] - w.p[i + 1]);
    }
  }

  // --- what the player can see, and be legitimately stopped by -------------
  const col = new Colliders(town);
  const water = new Colliders({ buildings: [], walls: [] });
  for (const w of town.water) {
    if (w.p && w.p.length >= 6) water.addRing(w.p);
    else if (w.l && w.w) {
      for (let i = 0; i + 3 < w.l.length; i += 2) {
        water.addSeg(w.l[i], w.l[i + 1], w.l[i + 2], w.l[i + 3], w.w * 0.5);
      }
    }
  }
  const visible = (x, z) =>
    col.inBuilding(x, z) || col.inBarrier(x, z) || water.inBuilding(x, z) || water.inBarrier(x, z);

  // --- 2. enforced but not drawn on the map -------------------------------
  const missOf = (pts) => {
    let n = 0;
    let miss = 0;
    for (const [x, z] of pts) {
      if (Math.abs(x) > PLAYABLE_R || Math.abs(z) > PLAYABLE_R) continue;
      n++;
      if (rasterAt(x, z) !== IMPASSABLE) miss++;
    }
    return { n, miss };
  };

  // Sampled off the carriageways, because since D-033 a barrier does not
  // enforce there and the raster is right not to say it does. Skipping the
  // points rather than loosening the threshold keeps this measuring the thing
  // it was written for — barrier that stops the athlete and is not on the map —
  // and would still catch a whole wall going missing.
  const onDeck = new WaterBounds(town);
  const barrierPts = [];
  let barrierOnDeck = 0;
  for (const [ax, az, bx, bz] of col.segData) {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(len / 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (onDeck.onDeck(x, z)) {
        barrierOnDeck++;
        continue;
      }
      barrierPts.push([x, z]);
    }
  }
  const barrier = missOf(barrierPts);

  // Footprints are sampled a metre inside the wall rather than on it: a point
  // on the outline rounds to whichever cell centre is nearest, which is as
  // often outside the building as in, and that is the grid talking rather than
  // the data. A metre in is inside the smallest footprint here and is where the
  // athlete would actually be standing.
  const insidePts = [];
  for (const p of col.ringData) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2];
      const az = p[i * 2 + 1];
      const bx = p[((i + 1) % n) * 2];
      const bz = p[((i + 1) % n) * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / 1.5));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const mx = ax + (bx - ax) * t;
        const mz = az + (bz - az) * t;
        const nx = -(bz - az) / (len || 1);
        const nz = (bx - ax) / (len || 1);
        for (const sign of [1, -1]) {
          const px = mx + nx * sign;
          const pz = mz + nz * sign;
          if (pointInFlatRing(p, px, pz)) {
            insidePts.push([px, pz]);
            break;
          }
        }
      }
    }
  }
  const footprint = missOf(insidePts);

  // --- 3. impassable where nothing is drawn -------------------------------
  const ghosts = [];
  let cells = 0;
  let impassable = 0;
  for (let j = 0; j < rMeta.height; j++) {
    const z = rMeta.originZ + j * rMeta.resM;
    if (Math.abs(z) > PLAYABLE_R) continue;
    for (let i = 0; i < rMeta.width; i++) {
      const x = rMeta.originX + i * rMeta.resM;
      if (Math.abs(x) > PLAYABLE_R) continue;
      cells++;
      if (r[j * rMeta.width + i] !== IMPASSABLE) continue;
      impassable++;
      if (!visible(x, z)) ghosts.push([x, z]);
    }
  }
  const cellM2 = rMeta.resM * rMeta.resM;

  // Distance and bearing from each ghost cell to the nearest thing that is
  // drawn. Sub-sampled: the answer is a distribution, and 3 000 draws pin it
  // down far more cheaply than 18 000 do.
  const stride = Math.max(1, Math.floor(ghosts.length / 3000));
  const MAX_R = 16;
  let worstD = 0;
  let worstAt = null;
  let worstBrg = 0;
  let unexplained = 0;
  let sumR = 0;
  let sumD = 0;
  let sumRD = 0;
  let sumRR = 0;
  let n = 0;
  let sinSum = 0;
  let cosSum = 0;
  const dists = [];
  for (let k = 0; k < ghosts.length; k += stride) {
    const [x, z] = ghosts[k];
    let d = Infinity;
    let bx = 0;
    let bz = 0;
    for (let rad = 0.5; rad <= MAX_R; rad += 0.5) {
      const steps = Math.max(8, Math.ceil((2 * Math.PI * rad) / 0.5));
      for (let a = 0; a < steps; a++) {
        const th = (a / steps) * 2 * Math.PI;
        const px = x + Math.cos(th) * rad;
        const pz = z + Math.sin(th) * rad;
        if (visible(px, pz)) {
          d = rad;
          bx = px;
          bz = pz;
          break;
        }
      }
      if (d < Infinity) break;
    }
    n++;
    if (d === Infinity) {
      unexplained++;
      dists.push(MAX_R);
      continue;
    }
    dists.push(d);
    const radius = Math.hypot(x, z);
    sumR += radius;
    sumD += d;
    sumRD += radius * d;
    sumRR += radius * radius;
    if (d >= 1.5) {
      const brg = Math.atan2(bx - x, -(bz - z));
      sinSum += Math.sin(brg);
      cosSum += Math.cos(brg);
      if (d > worstD) {
        worstD = d;
        worstAt = [x, z];
        worstBrg = ((brg * 180) / Math.PI + 360) % 360;
      }
    }
  }
  dists.sort((a, b) => a - b);
  const trend = n > 1 ? (n * sumRD - sumR * sumD) / Math.max(1e-9, n * sumRR - sumR * sumR) : 0;
  const directional = Math.hypot(sinSum, cosSum) / Math.max(1, n);

  return {
    resM: rMeta.resM,
    crossableMaxH: town.crossableMaxH,
    drawnLoose,
    drawnLooseWays,
    worstLoose,
    barrierDrawn: 1 - barrier.miss / Math.max(1, barrier.n),
    footprintDrawn: 1 - footprint.miss / Math.max(1, footprint.n),
    ghostM2: ghosts.length * cellM2,
    ghostFraction: ghosts.length / Math.max(1, cells),
    impassableFraction: impassable / Math.max(1, cells),
    ghostP99: dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.99))] : 0,
    worstD,
    worstAt,
    worstBrg,
    unexplained: unexplained / Math.max(1, n),
    trend,
    directional,
  };
}

// ---------------------------------------------------------------------------
// Phase 0b — the shipped passable space
// ---------------------------------------------------------------------------

/**
 * Is the venue connected, and does the file that says so tell the truth?
 *
 * This is PLAN-KRUMLOV-V2 §2 rule 4 asserted where it belongs: *"passable space
 * is derived, then asserted connected, **before any course exists**"*. Every
 * other phase in this file runs against a course. This one does not — it runs
 * against the venue, and it would fail on a Krumlov that had never had a
 * control sited in it.
 *
 * Two claims, and the first is what makes the second worth anything.
 *
 * **The file is the model.** `passable.bin` is re-derived here from the shipped
 * `townmodel.bin` and compared **cell for cell** — 5.76 M of them, both planes
 * — rather than sampled. A scatter of probes is how every fault in §1's table
 * stayed hidden: each was small in area and total in consequence.
 *
 * **The venue is connected.** Not "mostly": every component that is not the
 * arena's is enumerated with its area and its centre, and classified by the
 * only question that matters to a player — *can they get into it, and if so can
 * they get back out?* Krumlov is supposed to have shut ground in it (the
 * zámecká zahrada is 0.9 ha of walled parterre) and shut ground strands nobody.
 * What strands somebody is ground you can enter and not leave.
 */
function passableSpacePhase(venue) {
  const dir = venueDir(venue);
  const metaPath = join(dir, 'passable.json');
  if (!existsSync(join(dir, 'townmodel.bin'))) return null;
  if (!existsSync(metaPath)) {
    return { bad: true, why: 'passable.json missing — run node tools/terrain/passable.mjs' };
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const buf = readFileSync(join(dir, 'passable.bin'));
  const bits = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const { header, model } = readModel(dir);
  const col = colliders(model);

  const errors = [];
  if (meta.modelBytes !== header.bytes) {
    errors.push(
      `passable.bin was derived from a ${meta.modelBytes}-byte townmodel.bin and the shipped one ` +
        `is ${header.bytes} bytes — re-run tools/terrain/passable.mjs`,
    );
  }

  const space = derivePassable(col, {
    res: meta.resM,
    playableR: header.playableR,
    arena: meta.arena ?? ARENA,
  });

  // --- the file against the derivation, cell for cell ----------------------
  const n = space.w * space.h;
  const bytes = Math.ceil(n / 8);
  const readBit = (base, k) => (bits[base + (k >> 3)] >> (k & 7)) & 1;
  let openDiff = 0;
  let reachDiff = 0;
  let reachNotOpen = 0;
  if (space.w !== meta.width || space.h !== meta.height) {
    errors.push(
      `passable.bin is ${meta.width}×${meta.height} and the model derives ${space.w}×${space.h}`,
    );
  } else {
    for (let k = 0; k < n; k++) {
      const o = readBit(meta.sections.open.offset, k);
      const rr = readBit(meta.sections.reach.offset, k);
      if (o !== space.open[k]) openDiff++;
      if (rr !== space.reach[k]) reachDiff++;
      // Reachable ground that is not open ground is not a rounding error, it
      // is a mask that has stopped meaning anything.
      if (rr && !o) reachNotOpen++;
    }
  }

  const cellM2 = meta.resM * meta.resM;
  const sealed = space.pockets.filter((p) => !p.reallyConnected && !p.enterable);
  const artifacts = space.pockets.filter((p) => p.reallyConnected);
  const porous = space.pockets.filter((p) => !p.reallyConnected && p.enterable && !p.trap);
  const traps = space.pockets.filter((p) => p.trap);

  console.log(
    `\n· ${venue} passable space · passable.bin (${meta.resM} m, every tier) · ` +
      `derived from townmodel.bin, ${bytes * 2} bytes packed\n`,
  );
  console.log(
    `  open ground          ${(space.openM2 / 1e4).toFixed(1)} ha of the ` +
      `${(((2 * header.playableR) ** 2) / 1e4).toFixed(0)} ha playable square`,
  );
  console.log(
    `  reachable from arena ${(space.fraction * 100).toFixed(1)} %  (${(space.reachM2 / 1e4).toFixed(1)} ha)`,
  );
  console.log(
    `  ${space.components} components · ${space.pockets.length} pockets over 6 m² ` +
      `(${sealed.length} sealed · ${porous.length} porous · ${artifacts.length} grid artifacts · ` +
      `${traps.length} traps)`,
  );
  console.log(
    `  8-connected, every edge swept at ${meta.sweepM} m — Race.step's own step test`,
  );
  for (const p of space.pockets.slice(0, 6)) {
    const how = p.reallyConnected
      ? 'GRID ARTIFACT — a clear way in the lattice cannot express'
      : p.trap
        ? 'TRAP — enterable and not escapable'
        : p.enterable
          ? `porous — ${p.minJumpM} m either way`
          : 'sealed — the athlete cannot get in either';
    console.log(`    ${String(p.m2).padStart(7)} m²  near (${p.at.x}, ${p.at.z})  ${how}`);
  }
  console.log(
    `  file vs derivation over ${n} cells: ${openDiff} open, ${reachDiff} reachable differ`,
  );

  if (openDiff || reachDiff) {
    errors.push(
      `passable.bin disagrees with the model it claims to be derived from — ` +
        `${Math.round(openDiff * cellM2)} m² of open, ${Math.round(reachDiff * cellM2)} m² of reachable`,
    );
  }
  if (reachNotOpen) {
    errors.push(`${reachNotOpen} cells are marked reachable and not open`);
  }
  // Ground the player can get into and not out of. A fault at any size.
  for (const p of traps) {
    errors.push(
      `a ${p.m2} m² pocket near (${p.at.x}, ${p.at.z}) can be entered and not left`,
    );
  }
  /**
   * A porous pocket is not a trap and is still a fault of this artefact.
   *
   * It means there is a way in and out that the component labelling does not
   * have an edge for — so the shipped `reach` plane says unreachable about
   * ground the athlete can stand on, and the course generator will refuse to
   * site a control there for a reason that is not true. Same for a grid
   * artifact, which is the same defect with nothing at all in the way.
   */
  for (const p of [...porous, ...artifacts]) {
    errors.push(
      `a ${p.m2} m² pocket near (${p.at.x}, ${p.at.z}) is reachable on foot and the shipped ` +
        `component labelling says it is not`,
    );
  }
  const worstSealed = sealed[0];
  if (worstSealed && worstSealed.m2 > LIMITS.maxPocketM2) {
    errors.push(
      `a ${(worstSealed.m2 / 1e4).toFixed(1)} ha pocket near (${worstSealed.at.x}, ` +
        `${worstSealed.at.z}) is sealed off from the arena`,
    );
  }
  if (space.fraction < LIMITS.minReachable) {
    errors.push(
      `only ${(space.fraction * 100).toFixed(1)} % of open ground is reachable from the arena`,
    );
  }

  return { bad: errors.length > 0, errors, space, meta };
}

// ---------------------------------------------------------------------------
// Phase 1 — flood-fill one raster
// ---------------------------------------------------------------------------

function floodFill(venue, bin, step) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const col = new Colliders(town);
  const wb = new WaterBounds(town);

  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };

  // Where there is a model it is the whole answer inside its own square, which
  // is what `FieldTerrain.blockedAt` now does and therefore what this must
  // measure. The forest has no model and keeps the raster, as it always has.
  const blocked = blockedAtOf(col, wb, rasterAt, true, town.modelHeader?.playableR ?? null);

  const R = PLAYABLE_R;
  const w = Math.floor((2 * R) / step) + 1;
  const h = w;
  const x0 = -R;
  const z0 = -R;

  const open = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < w; i++) {
      open[j * w + i] = blocked(x0 + i * step, z) ? 0 : 1;
    }
  }

  // Edge passability at the midpoint, which is what a continuous collider
  // actually enforces: a barrier lying between two open cell centres makes the
  // step between them impossible even though both cells look open.
  const eastOk = new Uint8Array(w * h);
  const southOk = new Uint8Array(w * h);
  const mid = step / 2;
  for (let j = 0; j < h; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!open[k]) continue;
      const x = x0 + i * step;
      if (i < w - 1 && open[k + 1] && !blocked(x + mid, z)) eastOk[k] = 1;
      if (j < h - 1 && open[k + w] && !blocked(x, z + mid)) southOk[k] = 1;
    }
  }

  // Connected components over that graph.
  const comp = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const queue = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!open[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    comp[s] = id;
    queue[tail++] = s;
    while (head < tail) {
      const k = queue[head++];
      if (eastOk[k] && comp[k + 1] < 0) { comp[k + 1] = id; queue[tail++] = k + 1; }
      if (k >= 1 && eastOk[k - 1] && comp[k - 1] < 0) { comp[k - 1] = id; queue[tail++] = k - 1; }
      if (southOk[k] && comp[k + w] < 0) { comp[k + w] = id; queue[tail++] = k + w; }
      if (k >= w && southOk[k - w] && comp[k - w] < 0) { comp[k - w] = id; queue[tail++] = k - w; }
    }
    sizes.push(tail);
  }

  const ai = Math.round((ARENA.x - x0) / step);
  const aj = Math.round((ARENA.z - z0) / step);
  let arena = comp[aj * w + ai];
  if (arena < 0) {
    // The arena centre itself is inside something; take the nearest open cell,
    // which is what `nearestReachable` does at runtime.
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (comp[k] < 0) continue;
        const d = (i - ai) ** 2 + (j - aj) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    arena = best >= 0 ? comp[best] : -1;
  }

  let openN = 0;
  for (let i = 0; i < open.length; i++) openN += open[i];
  const cellM2 = step * step;
  const reachN = arena >= 0 ? sizes[arena] : 0;

  // Every pocket that is not the arena's component and is big enough to stand
  // in, classified by the question that actually matters: **can the athlete get
  // into it, and if so can they get back out?**
  //
  // Being disconnected is not by itself a fault. Krumlov is supposed to have
  // shut ground in it — the zámecká zahrada behind its wall, block interiors
  // reached only through arched passages — and none of that can strand anybody,
  // because nobody can get in. What strands a player is ground they *can* enter
  // and cannot leave, and telling those apart needs an entry test, which is
  // what this gate was missing while four separate "we are stuck" reports came
  // in against it.
  const cellsOf = new Map();
  for (let k = 0; k < comp.length; k++) {
    const id = comp[k];
    if (id < 0 || id === arena) continue;
    let list = cellsOf.get(id);
    if (!list) { list = []; cellsOf.set(id, list); }
    list.push(k);
  }

  const compAt = (x, z) => {
    const i = Math.round((x - x0) / step);
    const j = Math.round((z - z0) / step);
    if (i < 0 || j < 0 || i >= w || j >= h) return -1;
    return comp[j * w + i];
  };

  const traps = [];
  for (const [id, cells] of cellsOf) {
    const m2 = cells.length * cellM2;
    if (m2 < 6) continue;

    // The tightest single step from the arena's component into this pocket.
    //
    // Only boundary cells can be within a step of anything outside, so only
    // boundary cells are probed — over 160 pockets that is the difference
    // between a second and a minute.
    let minJump = Infinity;
    let jumpAt = null;
    let outsideCls = IMPASSABLE;
    // True when some point of the pocket is joined to the arena's component by
    // a clear straight line — i.e. the pocket is not a pocket at all, the
    // 4-connected flood just could not turn the corner.
    let reallyConnected = false;
    for (const k of cells) {
      const boundary =
        (k % w > 0 && comp[k - 1] !== id) ||
        (k % w < w - 1 && comp[k + 1] !== id) ||
        (k >= w && comp[k - w] !== id) ||
        (k + w < comp.length && comp[k + w] !== id);
      if (!boundary) continue;
      const px = x0 + (k % w) * step;
      const pz = z0 + ((k / w) | 0) * step;
      for (let a = 0; a < 32; a++) {
        const th = (a / 32) * Math.PI * 2;
        const ux = Math.sin(th);
        const uz = -Math.cos(th);
        for (let d = 0.1; d <= MAX_STEP_M + 0.15; d += 0.05) {
          const qx = px + ux * d;
          const qz = pz + uz * d;
          if (blocked(qx, qz)) continue;
          // Not `break`: the first metre or two along this ray is still inside
          // the pocket, so a bearing has to be walked out to the full step
          // before it can be ruled out.
          if (compAt(qx, qz) !== arena) continue;
          // Is anything actually in the way?
          //
          // This distinguishes a step *over a barrier* from a step the flood
          // merely cannot see. The component graph is 4-connected on a 0.5 m
          // grid, so two diagonally adjacent open cells whose shared orthogonal
          // neighbours are both blocked land in different components — while
          // the athlete, who moves dx and dz in the same step, walks straight
          // between them. Without this test every such corner reads as a
          // sealed pocket entered by a 0.42 m "jump", which is the grid talking
          // and not the town.
          let crossed = false;
          const segN = Math.max(4, Math.ceil(d / 0.05));
          for (let t = 1; t < segN; t++) {
            if (blocked(px + ux * d * (t / segN), pz + uz * d * (t / segN))) {
              crossed = true;
              break;
            }
          }
          if (!crossed) {
            reallyConnected = true;
            continue;
          }
          if (d < minJump) {
            minJump = d;
            jumpAt = [qx, qz, px, pz];
            outsideCls = rasterAt(qx, qz);
          }
          break;
        }
      }
    }

    // Step length is speed × dt, and speed is the ground you are standing on.
    // Entering off a road buys a longer step than leaving from grass buys, so
    // "I got in" does not imply "I can get out".
    let insideCls = IMPASSABLE;
    for (const k of cells) {
      const c = rasterAt(x0 + (k % w) * step, z0 + ((k / w) | 0) * step);
      if ((SPEED_BY_CLASS[c] ?? 0) > (SPEED_BY_CLASS[insideCls] ?? 0)) insideCls = c;
    }
    const dt = 0.1;
    const stepIn = BASE_MS * (SPEED_BY_CLASS[outsideCls] ?? 0) * DOWNHILL_MAX * dt;
    const stepOut = BASE_MS * (SPEED_BY_CLASS[insideCls] ?? 0) * DOWNHILL_MAX * dt;

    /**
     * A pocket is enterable when there is a clear way in — and only then.
     *
     * This used to be "when the athlete's step is longer than the thinnest
     * barrier", because `Race.step` tested the destination of a step and not
     * its path, so anything thinner than 0.55 m could be jumped. `SWEEP_M` in
     * src/sim/race.ts ended that: a step is sampled every 0.20 m, which is
     * under the narrowest collider in either venue.
     *
     * The consequence is worth stating, because it deletes a whole class of
     * fault rather than fixing an instance of it: **entering and leaving are
     * now the same test**. A trap was made of the asymmetry — you arrived on
     * Road with a 0.56 m step and left through Green2 with 0.18 m — and with no
     * jump available in either direction there is no asymmetry left to trap
     * anybody with. `minJump` is still measured and printed, because how thin
     * the thinnest barrier is remains worth knowing.
     */
    const enterable = reallyConnected;
    const escapable = reallyConnected;

    traps.push({
      id, m2, minJump, jumpAt, enterable, escapable, reallyConnected,
      insideCls, outsideCls,
      // A trap is ground the player can get into and cannot get back out of —
      // either because the step back is beyond what the ground inside allows,
      // or because the pocket is too small to be anything but a cell.
      // A trap is ground the player can get into and realistically cannot get
      // back out of. Two ways that happens, and the size cuts opposite ways in
      // each:
      //
      //  - **Asymmetric.** The step that got you in is longer than any step the
      //    ground inside can produce. A fault at any size.
      //  - **Needle in a haystack.** The gap is symmetric, but the pocket is
      //    big enough to wander in and the way out is a 40 cm hole in a hedge.
      //    Nobody finds that twice. Below `minWanderM2` you are never more than
      //    a few strides from the gap you came through, which is annoying and
      //    not a trap.
      trap: !reallyConnected && enterable && (!escapable || m2 >= LIMITS.minWanderM2),
    });
  }
  traps.sort((a, b) => b.m2 - a.m2);

  // Where each of the biggest pockets is, so the number is actionable.
  const centreOf = (id) => {
    let sx = 0, sz = 0, n = 0;
    for (let k = 0; k < comp.length; k++) {
      if (comp[k] !== id) continue;
      sx += x0 + (k % w) * step;
      sz += z0 + ((k / w) | 0) * step;
      n++;
    }
    return { x: Math.round(sx / n), z: Math.round(sz / n) };
  };

  // How much of the barrier network the *map* can see. The map draws the
  // runnability raster with the scene's colliders baked in at cell centres, so
  // a barrier narrower than a cell can stop the athlete without ever being
  // drawn — which is the ISSprOM 515/518 fairness question, separate from
  // whether anyone is trapped.
  let barrierPts = 0;
  let barrierSeen = 0;
  for (const [ax, az, bx, bz] of col.segData) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.ceil(len / 0.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      barrierPts++;
      if (rasterAt(x, z) === IMPASSABLE) barrierSeen++;
    }
  }

  return {
    resM: rMeta.resM,
    openHa: (openN * cellM2) / 1e4,
    reachHa: (reachN * cellM2) / 1e4,
    fraction: openN ? reachN / openN : 0,
    traps,
    centreOf,
    barrierDrawn: barrierSeen / Math.max(1, barrierPts),
    arenaBlocked: blocked(ARENA.x, ARENA.z),
  };
}

// ---------------------------------------------------------------------------
// Do the legs run through the alleys?
// ---------------------------------------------------------------------------

/**
 * Build a leg router for a venue: the fastest route from control to control,
 * and how much of it is street.
 *
 * A *factory* rather than a plain function because the expensive half — asking
 * the continuous collider about 360 000 lattice cells — depends only on the
 * venue, while the cheap half runs once per candidate course.
 * `tools/sim/pick-course.mjs` scores several hundred candidates against one
 * venue, so rebuilding the lattice each time would dominate everything else.
 *
 * Every other measure in this file is about a *point*: is the start out of the
 * river, is a control near a paved way, can the athlete escape the finish. The
 * client's sentence is about the *legs* — "runs through the alleys" — and a
 * course can satisfy every point-wise measure and still be a set of bearings
 * across open ground with streets incidentally nearby.
 *
 * So this routes each leg the way the athlete would run it: a Dijkstra on a 2 m
 * lattice over the same collision the game enforces, with edge cost = distance
 * divided by `SPEED_BY_CLASS`, which is the athlete's own speed model from
 * src/sim/athlete.ts. The result is the quickest way there, which for a sprint
 * is the route choice, and then the question is simply what fraction of it is
 * spent on Road or Path.
 *
 * 2 m rather than the 0.5 m the flood-fill uses because this runs sixteen times
 * per course and the answer is a fraction rather than a topology: at 2 m an
 * alley two cells wide is still an alley, and the route through it is the same
 * route. Cells the continuous collider rejects are excluded outright, so the
 * router cannot cut a corner the athlete could not.
 */
export function makeLegRouter(venue, bin, opts = {}) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const col = new Colliders(town);
  const wb = new WaterBounds(town);
  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };
  /**
   * The router asks the model and not the raster, where there is a model.
   *
   * The raster's impassable class *is* the model — see D-038 — but drawn at
   * 1 m: a cell is impassable if the model blocks anywhere inside it, because
   * a 0.60 m railing cannot be a continuous line on a 1 m lattice any other
   * way. That is right for the raster and wrong for a router walking a 2 m
   * lattice: it turns a 2.5 m alley into a 0.9 m one, which the athlete runs
   * through and this router cannot fit a node in. Measured: five legs of one
   * sampled seed came back "no route between its ends" through alleys that are
   * open. The model is the finer and the truer answer, so the router takes it.
   */
  const blocked = blockedAtOf(col, wb, rasterAt, !town.model);

  const step = 2;
  // The lattice has to contain the whole venue, and the venues are not the same
  // size: Krumlov is 1 200 m across and the Lachovice forest 2 000 m. A lattice
  // sized for the town silently clips a forest course, and a clipped lattice
  // does not report a shorter route — it reports an *unroutable* leg, which
  // reads as a sealed venue. Defaults to the town so nothing that already calls
  // this changes.
  const R = opts.radiusM ?? PLAYABLE_R;
  const w = Math.floor((2 * R) / step) + 1;
  const h = w;
  const idx = (i, j) => j * w + i;
  const xOf = (i) => -R + i * step;
  const zOf = (j) => -R + j * step;

  const speed = new Float32Array(w * h);
  const paved = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = xOf(i);
      const z = zOf(j);
      if (blocked(x, z)) continue;
      const cls = rasterAt(x, z);
      speed[idx(i, j)] = SPEED_BY_CLASS[cls] ?? 0;
      paved[idx(i, j)] = cls === 0 || cls === 1 ? 1 : 0;
    }
  }

  /**
   * The lattice cell a sited point is routed from, snapped to open ground.
   *
   * A control is sited to the centimetre and is guaranteed not to be inside a
   * barrier *at its own coordinates*; rounded onto a 2 m lattice it can easily
   * land on a cell centre that is, because a Krumlov control sits on a corner
   * and a corner is a metre from a wall. Left unsnapped, the router then walks
   * the entire 100 ha component before reporting a leg it cannot run — wrong
   * and slow at once.
   *
   * 3 m of search is half the lattice diagonal of the widest thing a control
   * can be sited against; beyond that the point really is enclosed and the
   * caller should hear about it.
   */
  const cellOf = (p) => {
    const i0 = Math.max(0, Math.min(w - 1, Math.round((p.x + R) / step)));
    const j0 = Math.max(0, Math.min(h - 1, Math.round((p.z + R) / step)));
    if (speed[idx(i0, j0)] > 0) return [i0, j0];
    const reach = Math.ceil(3 / step);
    let best = null;
    let bestD = Infinity;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        if (speed[idx(i, j)] <= 0) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = [i, j];
        }
      }
    }
    return best;
  };

  const NB = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  /**
   * A binary min-heap over (cost, cell), in two flat typed arrays.
   *
   * Worth the thirty lines. A linear scan for the minimum turns each leg into
   * an O(n²) walk over a 600 × 600 lattice, which is fine once in a gate and
   * ruinous in `tools/sim/pick-course.mjs`, where this runs sixteen times per
   * candidate over several hundred candidates.
   */
  let heapC = new Float64Array(1 << 16);
  let heapK = new Int32Array(1 << 16);
  let heapN = 0;
  const push = (c, k) => {
    if (heapN === heapC.length) {
      const c2 = new Float64Array(heapN * 2);
      const k2 = new Int32Array(heapN * 2);
      c2.set(heapC);
      k2.set(heapK);
      heapC = c2;
      heapK = k2;
    }
    let i = heapN++;
    heapC[i] = c;
    heapK[i] = k;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapC[p] <= heapC[i]) break;
      const tc = heapC[p], tk = heapK[p];
      heapC[p] = heapC[i]; heapK[p] = heapK[i];
      heapC[i] = tc; heapK[i] = tk;
      i = p;
    }
  };
  const pop = () => {
    const c = heapC[0];
    const k = heapK[0];
    heapN--;
    heapC[0] = heapC[heapN];
    heapK[0] = heapK[heapN];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heapN && heapC[l] < heapC[m]) m = l;
      if (r < heapN && heapC[r] < heapC[m]) m = r;
      if (m === i) break;
      const tc = heapC[m], tk = heapK[m];
      heapC[m] = heapC[i]; heapK[m] = heapK[i];
      heapC[i] = tc; heapK[i] = tk;
      i = m;
    }
    return [c, k];
  };

  // Float64, not Float32, and it matters: the heap holds the cost at full
  // precision, so a 32-bit `cost` array rounds every entry on the way in and
  // the `c > cost[k0]` staleness test then rejects roughly half of all valid
  // pops. The symptom is a router that reports every leg unroutable in ten
  // milliseconds, which reads exactly like a sealed venue.
  const cost = new Float64Array(w * h);
  const from = new Int32Array(w * h);
  const stamp = new Int32Array(w * h);
  let visit = 0;

  /** Road and Path — the two classes that are "the street network" everywhere
   * else in this file, including `paved` in the lattice above. */
  const onNetwork = (cls) => cls === 0 || cls === 1;

  /**
   * How far to the nearest Road or Path cell, in metres, searched outward in
   * rings. Diagnostic only — see `ends` on the returned object.
   */
  const nearestNet = (x, z, maxM = 60) => {
    if (onNetwork(rasterAt(x, z))) return 0;
    const res = rMeta.resM;
    for (let rad = 1; rad * res <= maxM; rad++) {
      let best = Infinity;
      for (let dj = -rad; dj <= rad; dj++) {
        for (let di = -rad; di <= rad; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== rad) continue;
          if (!onNetwork(rasterAt(x + di * res, z + dj * res))) continue;
          const d = Math.hypot(di, dj) * res;
          if (d < best) best = d;
        }
      }
      if (best < Infinity) return best;
    }
    return Infinity;
  };

  const endOf = (name, p) => {
    const cls = rasterAt(p.x, p.z);
    return {
      name,
      cls,
      className: rMeta.classes?.[cls] ?? String(cls),
      onNetwork: onNetwork(cls),
      nearestNetM: nearestNet(p.x, p.z),
    };
  };

  const ends = (points) =>
    points.length >= 2
      ? [endOf('start', points[0]), endOf('finish', points[points.length - 1])]
      : [];

  const route = function route(points) {
  const legs = [];
  for (let k = 0; k + 1 < points.length; k++) {
    // The straight line between the two ends, which is what the description
    // sheet prints and what the player sees when they look up. Kept for every
    // leg including the ones that cannot be routed, so a failure report can
    // still say how far apart the two flags were.
    const straightM =
      Math.hypot(points[k + 1].x - points[k].x, points[k + 1].z - points[k].z);
    const a = cellOf(points[k]);
    const b = cellOf(points[k + 1]);
    if (!a || !b) {
      legs.push({ leg: k, routed: false, pavedFraction: 0, lengthM: 0, straightM, detour: 0 });
      continue;
    }
    const goal = idx(b[0], b[1]);
    const start = idx(a[0], a[1]);

    // `stamp` replaces clearing two 360 000-entry arrays per leg.
    visit++;
    heapN = 0;
    cost[start] = 0;
    from[start] = -1;
    stamp[start] = visit;
    push(0, start);
    let found = false;
    while (heapN) {
      const [c, k0] = pop();
      if (c > cost[k0]) continue;
      if (k0 === goal) { found = true; break; }
      const i0 = k0 % w;
      const j0 = (k0 / w) | 0;
      for (const [di, dj, d] of NB) {
        const i1 = i0 + di;
        const j1 = j0 + dj;
        if (i1 < 0 || j1 < 0 || i1 >= w || j1 >= h) continue;
        const k1 = idx(i1, j1);
        const v = speed[k1];
        if (v <= 0) continue;
        // Diagonals may not cut a corner the collider closes.
        if (di && dj && (speed[idx(i0 + di, j0)] <= 0 || speed[idx(i0, j0 + dj)] <= 0)) continue;
        const nc = c + (d * step) / v;
        if (stamp[k1] === visit && nc >= cost[k1]) continue;
        stamp[k1] = visit;
        cost[k1] = nc;
        from[k1] = k0;
        push(nc, k1);
      }
    }

    if (!found) {
      legs.push({ leg: k, routed: false, pavedFraction: 0, lengthM: 0, straightM, detour: 0 });
      continue;
    }
    let lengthM = 0;
    let pavedM = 0;
    let cur = goal;
    while (from[cur] >= 0) {
      const prev = from[cur];
      const d =
        (prev % w) === (cur % w) || ((prev / w) | 0) === ((cur / w) | 0) ? step : step * Math.SQRT2;
      lengthM += d;
      if (paved[cur]) pavedM += d;
      cur = prev;
    }
    legs.push({
      leg: k,
      routed: true,
      lengthM: Math.round(lengthM),
      pavedFraction: lengthM > 0 ? pavedM / lengthM : 0,
      straightM,
      // Never below 1: a route cannot be shorter than the straight line, and a
      // lattice that says otherwise on a two-metre leg is quantisation rather
      // than a shortcut.
      detour: straightM > 0 ? Math.max(1, lengthM / straightM) : 1,
    });
  }

  const total = legs.reduce((a, l) => a + l.lengthM, 0);
  const onNet = legs.reduce((a, l) => a + l.lengthM * l.pavedFraction, 0);
  return {
    legs,
    totalM: Math.round(total),
    fraction: total > 0 ? onNet / total : 0,
    /**
     * The start and the finish, each read at its **own coordinates** rather
     * than at a lattice cell. `LIMITS.endsOnNetwork` explains why this cannot
     * be a distance test; reading it off the 2 m routing lattice would smuggle
     * a 2 m tolerance back in through the snap in `cellOf`, which is exactly
     * the tolerance that lets the fault through.
     *
     * `nearestNetM` is reported and never asserted. It is the number that makes
     * a failure legible — "in the woods, 1.4 m from the street" says which way
     * to move the start; "not on the network" does not.
     */
    ends: ends(points),
    /**
     * The whole course's detour factor — run distance over the length printed
     * on the description sheet. RESEARCH-SPORT §8.6 calls this `D` and puts it
     * at ≈1.05 for a sprint; it is the one number here that is directly
     * comparable with a real race.
     */
    courseDetour: (() => {
      const s = legs.reduce((a, l) => a + l.straightM, 0);
      return s > 0 ? total / s : 1;
    })(),
  };
  };
  // Diagnostics: how much of the lattice the router can stand on at all. If this
  // collapses, every leg comes back unroutable and the cause is the collision
  // model, not the course.
  let openCells = 0;
  for (let i = 0; i < speed.length; i++) if (speed[i] > 0) openCells++;
  route.openCells = openCells;
  route.latticeCells = w * h;
  return route;
}

/**
 * The detour limit, applied. **D-037.**
 *
 * Exported and shared so that the gate and `tools/sim/pick-course.mjs` cannot
 * drift: a course this rejects must be one the picker could never have chosen,
 * and the only way to guarantee that is for both to call the same function.
 * The picker uses it as a **hard filter** rather than a score term — a course
 * with a 14× leg has to be unable to win, not merely to score badly, because a
 * score term is something the other seventy points can outvote.
 *
 * Named legs (`leg 0` is start→1) so the message is the thing the player would
 * say: "I could see it and I couldn't get to it".
 */
export function detourFaults(routed, limits = LIMITS) {
  const out = [];
  if (!routed) return out;
  for (const l of routed.legs) {
    if (!l.routed) continue;
    const excess = l.lengthM - l.straightM;
    if (excess < limits.minDetourExcessM) continue;
    if (l.detour <= limits.maxLegDetour) continue;
    out.push(
      `leg ${l.leg} runs ${l.lengthM} m for a ${Math.round(l.straightM)} m straight line — ` +
        `${l.detour.toFixed(1)}× the direct distance, over ${limits.maxLegDetour.toFixed(1)}×. ` +
        `The flag is in sight across an uncrossable feature and the way to it is a lap of the venue.`,
    );
  }
  return out;
}

/**
 * The start and the finish, asserted onto the street network. **Fault 8.**
 *
 * Separate from `detourFaults` because it is a different kind of statement.
 * Every other course measure in this file scores the course as a *whole* — 96 %
 * of the running on the network, a median leg detour, a reachable fraction —
 * and the shipped Krumlov course passed all of them with its start in the
 * woods. An aggregate cannot fail on one point, and the start is one point that
 * every single player looks at before anything else.
 *
 * `LIMITS.endsOnNetwork` carries the reasoning and the measurements behind it.
 */
export function endpointFaults(routed, limits = LIMITS) {
  const out = [];
  if (!routed || !limits.endsOnNetwork) return out;
  for (const e of routed.ends ?? []) {
    if (e.onNetwork) continue;
    const near =
      e.nearestNetM === Infinity
        ? 'no Road or Path within 60 m'
        : `the nearest Road or Path is ${e.nearestNetM.toFixed(1)} m away`;
    out.push(
      `the ${e.name} is sited on ${e.className}, not on the street network — ${near}. ` +
        `A sprint ${e.name === 'start' ? 'starts' : 'finishes'} on the street; ` +
        `this is the fault the client reported as "you run out and there's a wall straight away".`,
    );
  }
  return out;
}

/**
 * Why a point is out of bounds, named rather than as a boolean.
 *
 * `blockedAtOf` answers yes or no, which is what the athlete needs and useless
 * for diagnosing a course fault: "the leg is 10× its straight line" and "there
 * is a river in the way" are different sentences, and only the second one tells
 * anybody what to change. Used by tools/sim/leg-diag.mjs.
 */
export function probeBlockers(venue, bin) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const col = new Colliders(town);
  const wb = new WaterBounds(town);
  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };
  return (x, z) => {
    const out = [];
    if (col.inBuilding(x, z)) out.push('building');
    if (col.inBarrier(x, z) && !wb.onDeck(x, z)) out.push('barrier');
    if (wb.blocks(x, z)) out.push('water');
    if (rasterAt(x, z) === IMPASSABLE) out.push('raster');
    return out;
  };
}

/** Percentiles of the per-leg detour ratio, for reporting the whole distribution. */
/**
 * Audit one course, leg by leg: can every control be reached, and how far is
 * the way there. **D-037.**
 *
 * This exists because a merge of the first attempt at D-037 shipped a course
 * with six unreachable legs and a sealed control, and *nothing in this file
 * failed*. `makeLegRouter` said the legs were routable, because it walks a 2 m
 * lattice and Krumlov's alleys are 2–3 m wide — the exact aliasing
 * `FieldTerrain.buildReachability` refuses to accept, and which its own comment
 * warns about. The fault was found by hand, with a 1 m probe, after the merge.
 * A measurement that has to be made by hand after a merge is not a gate.
 *
 * So this is deliberately **not** `makeLegRouter` with different constants:
 *
 *  - **1 m, not 2 m.** Same resolution the runtime's own reachability fill
 *    uses, for the same reason.
 *  - **Distance, not time.** `makeLegRouter` minimises time at the athlete's
 *    class speeds, which is the right question for "does it run through the
 *    alleys" and the wrong one for "how far is it": the fastest way round can
 *    be longer than the shortest, and the ratio the sport talks about
 *    (RESEARCH-SPORT §8.6, route efficiency) is a distance ratio.
 *  - **Eight-connected with the corner rule**, so it cannot slip diagonally
 *    between two blocked cells — the same rule `makeLegRouter` uses, and the
 *    reason a plain four-connected flood reports "grid artifacts" this venue's
 *    athlete walks straight through.
 *  - **Sealed is distinct from unreachable.** A control with no open ground
 *    within `SNAP_M` is not a routing failure, it is a control sited inside a
 *    wall, and saying so is the difference between a five-minute fix and a
 *    day of bisecting.
 *
 * One Dijkstra per sited point rather than per leg, which is the same work and
 * gives the reachability of everything from the start for free.
 */
const SNAP_M = 3;

export function makeCourseAudit(venue, bin, opts = {}) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const col = new Colliders(town);
  const wb = new WaterBounds(town);
  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };
  // The 1 m audit walks the model for the same reason the 2 m router does: the
  // raster's impassable class is the model drawn at cell resolution, and a
  // lattice finer than a cell should ask the finer thing. See `makeLegRouter`.
  const blocked = blockedAtOf(col, wb, rasterAt, !town.model);

  /**
   * The audit's lattice, metres.
   *
   * Was 1 m, "the resolution the runtime's own reachability fill uses" — and
   * since phase 2 the runtime's own reachability is a **0.5 m** artefact, so
   * the sentence now points at 0.5. It is not a free refinement: a lattice
   * coarser than the alley it is measuring does not merely round the answer, it
   * *lengthens* it, because the shortest chain of open cells through a 2.5 m
   * passage is not the shortest path through the passage. D-037 recorded the
   * same effect in the other direction at 2 m, where six unroutable legs came
   * back routable.
   */
  const step = opts.stepM ?? (venuePassableRes(venue) ?? 1);
  const R = opts.radiusM ?? PLAYABLE_R;
  const w = Math.floor((2 * R) / step) + 1;
  const h = w;
  const idx = (i, j) => j * w + i;
  const xOf = (i) => -R + i * step;
  const zOf = (j) => -R + j * step;

  const open = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = zOf(j);
    for (let i = 0; i < w; i++) open[idx(i, j)] = blocked(xOf(i), z) ? 0 : 1;
  }
  // Edge passability at the midpoint — a barrier lying between two open cell
  // centres makes the step between them impossible while both cells look open.
  const eastOk = new Uint8Array(w * h);
  const southOk = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = zOf(j);
    for (let i = 0; i < w; i++) {
      const k = idx(i, j);
      if (!open[k]) continue;
      const x = xOf(i);
      if (i < w - 1 && open[k + 1] && !blocked(x + step / 2, z)) eastOk[k] = 1;
      if (j < h - 1 && open[k + w] && !blocked(x, z + step / 2)) southOk[k] = 1;
    }
  }

  /** The cell a sited point is routed from, snapped up to `SNAP_M` to open ground. */
  const cellOf = (p) => {
    const i0 = Math.max(0, Math.min(w - 1, Math.round((p.x + R) / step)));
    const j0 = Math.max(0, Math.min(h - 1, Math.round((p.z + R) / step)));
    if (open[idx(i0, j0)]) return idx(i0, j0);
    const reach = Math.ceil(SNAP_M / step);
    let best = -1;
    let bestD = Infinity;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        if (!open[idx(i, j)]) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = idx(i, j);
        }
      }
    }
    return best;
  };

  const NB = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  const passable = (i0, j0, di, dj) => {
    const k = idx(i0, j0);
    if (di === 1) return eastOk[k] === 1;
    if (di === -1) return i0 > 0 && eastOk[k - 1] === 1;
    if (dj === 1) return southOk[k] === 1;
    return j0 > 0 && southOk[k - w] === 1;
  };

  const dist = new Float64Array(w * h);
  const stamp = new Int32Array(w * h);
  let visit = 0;
  let heapC = new Float64Array(1 << 17);
  let heapK = new Int32Array(1 << 17);
  let heapN = 0;
  const push = (c, k) => {
    if (heapN === heapC.length) {
      const c2 = new Float64Array(heapN * 2);
      const k2 = new Int32Array(heapN * 2);
      c2.set(heapC); k2.set(heapK);
      heapC = c2; heapK = k2;
    }
    let i = heapN++;
    heapC[i] = c; heapK[i] = k;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapC[p] <= heapC[i]) break;
      const tc = heapC[p], tk = heapK[p];
      heapC[p] = heapC[i]; heapK[p] = heapK[i];
      heapC[i] = tc; heapK[i] = tk;
      i = p;
    }
  };
  const pop = () => {
    const c = heapC[0], k = heapK[0];
    heapN--;
    heapC[0] = heapC[heapN]; heapK[0] = heapK[heapN];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, rr = l + 1;
      let m = i;
      if (l < heapN && heapC[l] < heapC[m]) m = l;
      if (rr < heapN && heapC[rr] < heapC[m]) m = rr;
      if (m === i) break;
      const tc = heapC[m], tk = heapK[m];
      heapC[m] = heapC[i]; heapK[m] = heapK[i];
      heapC[i] = tc; heapK[i] = tk;
      i = m;
    }
    return [c, k];
  };

  /**
   * Shortest walking distance in metres from `src` to every cell, or -1.
   *
   * `goal` stops the search as soon as that cell is settled, which is what
   * makes the per-leg pass affordable: a full field over the forest's four
   * million cells costs seconds, and a 300 m leg only ever needed the disc
   * around it. Omit `goal` for the reachability pass, which genuinely wants
   * everything.
   */
  const distancesFrom = (src, targets, goal = -1) => {
    visit++;
    heapN = 0;
    dist[src] = 0;
    stamp[src] = visit;
    push(0, src);
    while (heapN) {
      const [c, k0] = pop();
      if (c > dist[k0]) continue;
      if (k0 === goal) break;
      const i0 = k0 % w;
      const j0 = (k0 / w) | 0;
      for (const [di, dj, d] of NB) {
        const i1 = i0 + di;
        const j1 = j0 + dj;
        if (i1 < 0 || j1 < 0 || i1 >= w || j1 >= h) continue;
        const k1 = idx(i1, j1);
        if (!open[k1]) continue;
        // A diagonal may not cut a corner the collider closes, and both of its
        // orthogonal edges have to be crossable.
        if (di && dj) {
          if (!passable(i0, j0, di, 0) || !passable(i0, j0, 0, dj)) continue;
          if (!passable(i0 + di, j0, 0, dj) || !passable(i0, j0 + dj, di, 0)) continue;
        } else if (!passable(i0, j0, di, dj)) continue;
        const nc = c + d * step;
        if (stamp[k1] === visit && nc >= dist[k1]) continue;
        stamp[k1] = visit;
        dist[k1] = nc;
        push(nc, k1);
      }
    }
    // **Answered here, as plain numbers, and never as a closure.**
    //
    // `dist` and `stamp` are one pair of scratch arrays shared by every search,
    // so a function that reads them later reads whatever the *last* search
    // wrote. That is not hypothetical: this returned `(k) => stamp[k] === visit
    // ? dist[k] : -1`, the reachability answers were read after sixteen
    // per-leg searches had overwritten the arrays, and the gate reported four
    // controls of a perfectly reachable course as unreachable. It only became
    // visible when the per-leg searches gained an early exit and stopped
    // incidentally re-covering the whole component — i.e. the bug was latent
    // and a *speed-up* exposed it.
    //
    // Returning values rather than a view makes the stale read impossible
    // rather than merely absent.
    return targets.map((k) => (k >= 0 && stamp[k] === visit ? dist[k] : -1));
  };

  /**
   * `points` is start, every control in order, then the finish — the same array
   * `makeLegRouter` takes.
   */
  return function audit(points) {
    const cells = points.map(cellOf);
    const names = points.map((p, i) =>
      i === 0 ? 'S' : i === points.length - 1 ? 'F' : String(i),
    );

    // Everything the athlete can reach from the start, which is the question
    // "can this course be completed at all". Read out immediately — see
    // `distancesFrom`.
    const fromStart =
      cells[0] >= 0 ? distancesFrom(cells[0], cells) : cells.map(() => -1);

    const rows = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const straightM = Math.hypot(
        points[k + 1].x - points[k].x,
        points[k + 1].z - points[k].z,
      );
      const name = `${names[k]}→${names[k + 1]}`;
      if (cells[k] < 0 || cells[k + 1] < 0) {
        rows.push({
          leg: k, name, straightM, walkedM: -1, detour: 0,
          status: 'SEALED',
          sealed: cells[k] < 0 ? names[k] : names[k + 1],
        });
        continue;
      }
      const walkedM = distancesFrom(cells[k], [cells[k + 1]], cells[k + 1])[0];
      if (walkedM < 0) {
        rows.push({ leg: k, name, straightM, walkedM: -1, detour: 0, status: 'UNREACHABLE' });
        continue;
      }
      rows.push({
        leg: k, name, straightM, walkedM,
        detour: straightM > 0 ? Math.max(1, walkedM / straightM) : 1,
        status: 'ok',
      });
    }

    // Reachability of every sited point from the start, reported separately
    // from the legs: a course can have every leg routable and still strand the
    // athlete, and the two failures read completely differently.
    const unreachableFromStart = [];
    for (let i = 1; i < cells.length; i++) {
      if (cells[i] < 0) continue;
      if (fromStart[i] < 0) unreachableFromStart.push(names[i]);
    }

    const straightTotal = rows.reduce((a, x) => a + x.straightM, 0);
    const walkedTotal = rows.reduce((a, x) => a + Math.max(0, x.walkedM), 0);
    return {
      rows,
      unreachableFromStart,
      sealed: [...new Set(rows.filter((x) => x.status === 'SEALED').map((x) => x.sealed))],
      straightTotal,
      walkedTotal,
      courseDetour: straightTotal > 0 ? walkedTotal / straightTotal : 1,
    };
  };
}

/**
 * The audit, judged. Every fault here is a hard failure on the shipped course.
 *
 * Ordered so the first line of the report is the worst thing that is true: a
 * sealed control is a control inside a wall, an unreachable one is a course
 * that cannot be completed, and a detour is a course that can be completed and
 * should not have been set.
 */
export function auditFaults(a, limits = LIMITS) {
  const out = [];
  for (const p of a.sealed) {
    out.push(`control ${p} is sealed — no open ground within ${SNAP_M} m of where it is sited`);
  }
  if (a.unreachableFromStart.length) {
    out.push(
      `control(s) ${a.unreachableFromStart.join(', ')} cannot be reached from the start at all — ` +
        `this course cannot be completed`,
    );
  }
  for (const x of a.rows) {
    if (x.status === 'UNREACHABLE') {
      out.push(`leg ${x.name} has no route between its ends (${Math.round(x.straightM)} m apart)`);
    }
  }
  for (const x of a.rows) {
    if (x.status !== 'ok') continue;
    if (x.walkedM - x.straightM < limits.minDetourExcessM) continue;
    if (x.detour <= limits.maxLegDetour) continue;
    out.push(
      `leg ${x.name} walks ${Math.round(x.walkedM)} m for a ${Math.round(x.straightM)} m ` +
        `straight line — ${x.detour.toFixed(1)}×, over ${limits.maxLegDetour.toFixed(1)}×`,
    );
  }
  return out;
}

/** The per-leg table, in the shape a human reads it. */
export function auditTable(a, indent = '    ') {
  const cell = (x) =>
    x.status === 'ok'
      ? `${String(Math.round(x.straightM)).padStart(4)}/${String(Math.round(x.walkedM)).padEnd(5)}` +
        ` ${x.detour.toFixed(1)}×`
      : `${String(Math.round(x.straightM)).padStart(4)}/${x.status}`;
  const lines = [];
  const half = Math.ceil(a.rows.length / 2);
  for (let i = 0; i < half; i++) {
    const l = a.rows[i];
    const r = a.rows[i + half];
    lines.push(
      indent + `${l.name.padEnd(6)}${cell(l).padEnd(24)}` + (r ? `${r.name.padEnd(6)}${cell(r)}` : ''),
    );
  }
  lines.push(
    indent +
      `total ${Math.round(a.straightTotal)} m straight, ${Math.round(a.walkedTotal)} m walked ` +
      `— D ${a.courseDetour.toFixed(2)}`,
  );
  return lines.join('\n');
}

export function detourStats(legRuns) {
  const rs = [];
  for (const r of legRuns) for (const l of r.legs) if (l.routed) rs.push(l.detour);
  rs.sort((a, b) => a - b);
  if (!rs.length) return null;
  const at = (p) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  return {
    n: rs.length,
    min: rs[0],
    median: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: rs[rs.length - 1],
    over: (t) => rs.filter((v) => v > t).length,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — the points the athlete is actually placed on
// ---------------------------------------------------------------------------

/**
 * Evaluated inside the page. Everything it needs is already exposed:
 * `window.__world` is the scene (`blockedAt`, `field`, `camera`, `data`), and
 * `window.__race` is the controller (`course`).
 *
 * Three properties per sited point, and one for the start:
 *
 *  1. **Not out of bounds.** `blockedAt` is the runtime's own test, and the
 *     footprint sweep beside it is deliberately stricter — a landmark building
 *     is skipped by `Buildings` and so contributes no collider, which means
 *     `blockedAt` alone cannot see it.
 *  2. **Not levitating.** The eye must sit exactly `EYE_HEIGHT` above the
 *     heightfield the ground-follow reads, and that heightfield must agree with
 *     the surveyed 1 m DMR.
 *  3. **Able to leave.** A flood from the start over the runtime's continuous
 *     collision, on a 0.5 m grid with the edges tested at their midpoints. This
 *     is the player's own question — not "is the venue connected" but "can I
 *     get out of here".
 */
const PROBE = (limits) => `(async () => {
  const w = window.__world, r = window.__race;
  const EYE = ${EYE_HEIGHT};

  // The surveyed surface, independent of whatever the tier loaded.
  const [hm, hb] = await Promise.all([
    fetch('/data/krumlov/height.json').then((x) => x.json()),
    fetch('/data/krumlov/height.bin').then((x) => x.arrayBuffer()),
  ]);
  const hi = new Uint16Array(hb);
  const hScale = (hm.maxH - hm.minH) / 65535;
  const surveyed = (x, z) => {
    const fx = (x - hm.originX) / hm.resM, fz = (z - hm.originZ) / hm.resM;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const c = (a, b) => {
      const ca = a < 0 ? 0 : a >= hm.width ? hm.width - 1 : a;
      const cb = b < 0 ? 0 : b >= hm.height ? hm.height - 1 : b;
      return hm.minH + hi[cb * hm.width + ca] * hScale;
    };
    return c(i, j) * (1 - tx) * (1 - tz) + c(i + 1, j) * tx * (1 - tz)
         + c(i, j + 1) * (1 - tx) * tz + c(i + 1, j + 1) * tx * tz;
  };

  // Every OSM footprint, including the ones Buildings skips for a landmark.
  const rings = w.data.buildings.filter((b) => b.p.length >= 6).map((b) => b.p);
  const inRing = (p, x, z) => {
    let inside = false; const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i*2], zi = p[i*2+1], xj = p[j*2], zj = p[j*2+1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const inAnyBuilding = (x, z) => rings.some((p) => inRing(p, x, z));

  const blocked = (x, z) => w.blockedAt(x, z);

  /**
   * The ground reachable on foot from p, in m², with the runtime's own
   * collision — cells at 0.5 m, edges tested at their midpoints, which is what
   * a continuous collider actually enforces.
   *
   * Stops as soon as the pocket is provably bigger than \`cap\`, so an open
   * venue costs a fixed and small amount of work. \`sealed\` is true only when
   * the flood ran out of frontier, i.e. the athlete really is walled in.
   */
  const startPocket = (px, pz, capM2) => {
    if (blocked(px, pz)) return { m2: 0, maxR: 0, sealed: true };
    const step = 0.5;
    const cellM2 = step * step;
    const capCells = Math.ceil(capM2 / cellM2);
    const seen = new Set([0]); const q = [[0, 0]];
    let head = 0, maxR = 0;
    while (head < q.length) {
      if (seen.size > capCells) return { m2: seen.size * cellM2, maxR, sealed: false };
      const [i, j] = q[head++];
      const x = px + i * step, z = pz + j * step;
      const d = Math.hypot(i * step, j * step);
      if (d > maxR) maxR = d;
      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const ni = i + di, nj = j + dj, k = ni * 100003 + nj;
        if (seen.has(k)) continue;
        if (blocked(px + ni * step, pz + nj * step)) continue;
        if (blocked(x + di * step * 0.5, z + dj * step * 0.5)) continue;
        seen.add(k); q.push([ni, nj]);
      }
    }
    return { m2: seen.size * cellM2, maxR, sealed: true };
  };

  const c = r.course;
  const named = [{ n: 'start', p: c.start }]
    .concat(c.controls.map((k, i) => ({ n: String(i + 1), p: k.position })))
    .concat([{ n: 'finish', p: c.finish }]);

  const faults = [];

  /**
   * Is a sited point in the river, and if so how deep?
   *
   * This is the client's own report — *"I even started in the river"* — turned
   * into an assertion, and it is asked of the running game rather than
   * reconstructed here, because the scene is the thing that decides both halves
   * of it: \`surface.water\` is the geometry that is drawn, and \`groundAt\` is
   * the height the athlete is placed at. A gate that rebuilt either would be
   * checking its own arithmetic against itself.
   *
   * Two separate failures are caught, and they had separate causes:
   *
   *  - **over water at all.** ISSprOM 301 — the Vltava is out of bounds, so no
   *    control, start or finish may be sited in it. The exception, and the only
   *    one, is a bridge deck.
   *  - **below the waterline.** A point may be legally on a bridge and still
   *    render underwater, because the heightfield is bare earth and the bare
   *    earth under a bridge is the riverbed. That is what actually shipped: the
   *    main Vltava crossing sags 5.2 m, so the eye sat at the water surface.
   *
   * \`freeboard\` is metres from the athlete's feet to the water they are over;
   * the distribution is reported whether or not anything failed, because the
   * client's complaint was one draw out of a distribution.
   */
  const wetness = [];
  const surf = w.surface;
  for (const o of named) {
    const { x, z } = o.p;
    if (blocked(x, z)) faults.push(o.n + ' is inside a barrier');
    else if (inAnyBuilding(x, z)) faults.push(o.n + ' is inside a building footprint');
    const drift = Math.abs(w.field.heightAt(x, z) - surveyed(x, z));
    if (drift > ${limits.maxHeightDriftM}) {
      faults.push(o.n + ' stands ' + drift.toFixed(1) + ' m off the surveyed ground');
    }
    if (!surf) continue;
    const terrainY = w.field.heightAt(x, z);
    const level = surf.water.levelAt(x, z, terrainY);
    if (level === null) continue;
    const feet = w.groundAt(x, z);
    const onDeck = surf.decks.covers(x, z);
    wetness.push({ n: o.n, onDeck, freeboard: Number((feet - level).toFixed(2)) });
    if (!onDeck) {
      faults.push(
        o.n + ' is sited over water (ISSprOM 301) with no bridge under it, at ' +
        x.toFixed(0) + ',' + z.toFixed(0),
      );
    } else if (feet < level + ${limits.minFreeboardM}) {
      faults.push(
        o.n + ' stands on a bridge but ' + (level - feet).toFixed(2) +
        ' m below the water surface',
      );
    }
  }

  // The eye, measured where the scene actually put it.
  //
  // Against \`groundAt\`, not \`field.heightAt\`: the heightfield is a bare-earth
  // DMR and the athlete may legitimately be standing on something built over
  // it. The contract is unchanged — the eye sits exactly EYE_HEIGHT above the
  // surface it is standing on — it is the surface that got a name.
  const cam = w.camera.position;
  const eyeErr = Math.abs(cam.y - (w.groundAt(cam.x, cam.z) + EYE));
  if (eyeErr > ${limits.maxEyeErrorM}) {
    faults.push('the eye is ' + eyeErr.toFixed(2) + ' m off ground + eye height');
  }
  // And the eye itself must be out of the water, wherever the race put it.
  {
    const level = surf ? surf.water.levelAt(cam.x, cam.z, w.field.heightAt(cam.x, cam.z)) : null;
    if (level !== null && cam.y < level + EYE * 0.5) {
      faults.push('the eye is ' + (level - cam.y).toFixed(2) + ' m under the water surface');
    }
  }

  const pocket = startPocket(c.start.x, c.start.z, ${limits.minStartPocketM2});
  if (pocket.sealed && pocket.m2 < ${limits.minStartPocketM2}) {
    faults.push(
      'the start is sealed into a pocket of ' + pocket.m2.toFixed(0) + ' m² (' +
      pocket.maxR.toFixed(0) + ' m across) with no way out',
    );
  }

  // What the running game thinks it can reach, and whether it could set a race
  // on it. Asked here rather than only of the raster because TerrainField.load
  // chooses its files by name and the manifest is not consulted — so this is
  // the only place that sees what a *player on this tier* is actually given.
  const reachable = r.courseInfo.reachableFraction;
  if (reachable < ${limits.minRuntimeReachable}) {
    faults.push(
      'only ' + (reachable * 100).toFixed(1) + ' % of the venue is reachable from the arena',
    );
  }
  if (c.controls.length < ${limits.minControls}) {
    faults.push(
      'the course collapsed to ' + c.controls.length + ' control(s) over ' + c.lengthM + ' m',
    );
  }

  // Two fingerprints the caller compares across tiers. Both are full precision
  // on purpose: the RNG stream in \`pickNextControl\` is consumed inside
  // geometry-dependent branches, so a millimetre of disagreement is not a small
  // difference in the answer, it is a different answer. Rounding before
  // comparing would hide exactly the thing being checked.
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  // The course as printed: every point, every code, in order.
  const courseKey = fnv(JSON.stringify([
    c.start.x, c.start.z, c.finish.x, c.finish.z, c.lengthM, c.climbM,
    c.controls.map((k) => [k.code, k.position.x, k.position.z]),
  ]));

  // The surface the *rules* run on — what the course is a function of, and what
  // the athlete's slope-driven speed reads. Sampled off-lattice so the
  // interpolation is exercised too, not only the stored nodes.
  let rulesKey = 'absent';
  if (r.terrain && typeof r.terrain.heightAt === 'function') {
    const hs = [];
    for (let j = 0; j < 24; j++) {
      for (let i = 0; i < 24; i++) {
        hs.push(r.terrain.heightAt(-560 + i * 47.3, -560 + j * 47.3));
      }
    }
    rulesKey = fnv(hs.join(','));
  }

  /**
   * The passable space, as the running game holds it.
   *
   * Tier independence is meant to be true *by construction* here — the loader
   * takes no tier and there is no second file to pick from — but D-027 and
   * D-029 were both meant to be true by argument too, and both shipped a phone
   * running a different race. So the property is also measured, on the object
   * the game is using rather than on the manifest: 90 000 samples of the
   * reachable and open planes at 4 m over the playable square, after the
   * hand-registered structures have been punched in, plus the fraction the
   * course generator was handed. If a tier ever gets its own space, this moves.
   */
  let passableKey = 'absent';
  let passableInfo = null;
  const wp = window.__world && window.__world.passable;
  if (wp) {
    const bits = [];
    for (let j = 0; j < 300; j++) {
      const z = -598 + j * 4;
      for (let i = 0; i < 300; i++) {
        const x = -598 + i * 4;
        bits.push((wp.reachableAt(x, z) ? 1 : 0) + (wp.openAt(x, z) ? 2 : 0));
      }
    }
    passableKey = fnv([wp.resM, wp.reachableFraction, wp.punchedPoints.length, bits.join('')].join('|'));
    passableInfo = {
      resM: wp.resM,
      fraction: wp.reachableFraction,
      punched: wp.punchedPoints.length / 2,
      census: wp.census,
    };
  }

  return JSON.stringify({
    faults,
    controls: c.controls.length,
    lengthM: c.lengthM,
    climbM: c.climbM,
    courseId: c.id,
    courseKey,
    rulesKey,
    passableKey,
    passableInfo,
    /** What the venue-wide passes cost this load, ms. See tools/perf/setup-cost.mjs. */
    setupMs: r.terrain && r.terrain.costMs ? { ...r.terrain.costMs } : null,
    wetness,
    // Every sited point, so the caller can route the legs over the same
    // collision the game enforces and ask whether they run in the streets.
    points: named.map((o) => ({ n: o.n, x: o.p.x, z: o.p.z })),
    // What the **runtime** thinks it can reach, point by point, so the caller
    // can hold its offline reconstruction of \`blockedAt\` to account. The
    // runtime is the truth here: it is what stops the player. An offline model
    // that is stricter is safe when it passes a course and dangerous when it
    // refuses one, because it will refuse courses that play perfectly and the
    // picker will never find a seed. See \`makeCourseAudit\`.
    runtimeReachable: named.map((o) => !!r.terrain.reachableAt(o.p.x, o.p.z)),
    startFinishM: Number(
      Math.hypot(c.start.x - c.finish.x, c.start.z - c.finish.z).toFixed(1),
    ),
    pavedDistanceM: r.courseInfo.pavedDistanceM,
    arenaFaults: r.courseInfo.arenaFaults,
    reachable: Number(reachable.toFixed(3)),
    pocketM2: pocket.sealed ? Number(pocket.m2.toFixed(0)) : -1,
    eyeErr: Number(eyeErr.toFixed(3)),
    // The class raster the tier was actually handed. Compared across tiers by
    // the caller: a tier is a rendering budget, so passability may not differ
    // between them — see \`TerrainField.load\`.
    raster: { resM: w.field.rMeta.resM, width: w.field.rMeta.width },
    renderErrors: (window.__renderErrors || []).slice(0, 3),
  });
})()`;

async function runtimePhase(venue, port) {
  let bad = false;
  /**
   * How many sampled (tier, seed) pairs started or finished off the network.
   *
   * A population statistic, not a fault — see the note at `endpointNotes`. It is
   * printed with the detour distribution so a generator drifting toward the
   * woods shows up as a rising rate rather than as a suddenly red gate on a seed
   * nobody races.
   */
  let offNetworkStarts = 0;
  /** The class raster each tier was handed, keyed by tier. */
  const rasterByTier = new Map();
  /** The course each (tier, seed) produced, so tiers can be compared. */
  const courseByTierSeed = new Map();
  /** Every sited point that sat over water, for the distribution below. */
  const wetnessAll = [];
  /** How much of each course's legs ran on the street network. */
  const legsAll = [];
  /** The passable space each load actually held, for the tier-independence claim. */
  const passableSeen = [];
  /** What the venue-wide passes cost each load. Phase 0's budget, instrumented. */
  const setupSeen = [];
  /** Which raster each tier reads, so the leg router uses the same one. */
  const tierBin = new Map();
  {
    const dir = venueDir(venue);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const [tier, files] of Object.entries(manifest.tiers ?? {})) {
      tierBin.set(tier, files.runnability ?? 'runnability.bin');
    }
  }
  /** One router per raster, built lazily and reused across seeds. */
  const routers = new Map();
  const routerFor = (tier) => {
    const bin = tierBin.get(tier) ?? 'runnability.bin';
    if (!routers.has(bin)) routers.set(bin, makeLegRouter(venue, bin));
    return routers.get(bin);
  };
  await withChrome(async (cdpPort) => {
    for (const tier of TIERS) {
      for (const seed of SEEDS) {
        const url =
          `http://127.0.0.1:${port}/?scene=sprint&race=1&debug=0&tier=${tier}&seed=${seed}`;
        process.stdout.write(`  ${tier.padEnd(6)} seed ${seed} … `);
        const tab = await openTab(cdpPort, url);
        const ready = await tab.waitFor('!!(window.__race && window.__world)', 45_000);
        if (!ready) {
          console.log('✗ the race never mounted');
          if (tab.consoleErrors.length) console.log(`     ${tab.consoleErrors[0]}`);
          bad = true;
          await tab.close();
          continue;
        }
        const raw = await tab.evaluate(PROBE(LIMITS));
        const res = JSON.parse(raw);
        rasterByTier.set(tier, res.raster);

        // Do the legs run through the streets? Routed offline, over the same
        // collision the page just enforced, so the answer is about the course
        // and not about which tier drew it.
        const routed = routerFor(tier)(res.points);
        if (routed.fraction < LIMITS.minLegsOnNetwork) {
          res.faults.push(
            `the legs run ${(routed.fraction * 100).toFixed(0)} % on the street network, ` +
              `under ${(LIMITS.minLegsOnNetwork * 100).toFixed(0)} %`,
          );
        }
        const unroutable = routed.legs.filter((l) => !l.routed);
        for (const l of unroutable) {
          res.faults.push(`leg ${l.leg} cannot be run at all — no route between its ends`);
        }
        // The start and the finish, on the network rather than near it —
        // **reported** on a sampled seed, **asserted** on the course that ships.
        //
        // This was asserted everywhere at first, on the argument that a start in
        // the woods is not a matter of degree and we want to know from the first
        // seed that can produce one. The argument is good and the scope was
        // wrong: it asserts a property we have decided not to require. The
        // generator cannot guarantee a street start on an arbitrary seed — 300
        // candidates say so — and *that is why a course is picked rather than
        // taken*. Asserting it here failed the gate on seed 29112007, which no
        // player will ever run, while the shipped course was correct.
        //
        // So it follows the same rule as the per-leg detour immediately below,
        // and for the same reason: assert the shipped course absolutely, measure
        // the generator as a population. The count still prints, so a generator
        // that starts drifting toward the woods is still visible.
        const endpointNotes = endpointFaults(routed, LIMITS);
        if (endpointNotes.length) offNetworkStarts++;
        // Routable is not the same as runnable — but on a *sampled* seed the
        // per-leg limit is reported rather than asserted, and the reason is in
        // `LIMITS.maxMedianLegDetour`. The assertion lives on the course that
        // ships, in `stabilityPhase`.
        const detourNotes = detourFaults(routed, LIMITS);

        courseByTierSeed.set(`${tier}|${seed}`, {
          controls: res.controls,
          lengthM: res.lengthM,
          climbM: res.climbM,
          courseId: res.courseId,
          courseKey: res.courseKey,
          rulesKey: res.rulesKey,
          passableKey: res.passableKey,
        });
        if (res.passableInfo) passableSeen.push({ tier, seed, ...res.passableInfo });
        if (res.setupMs) setupSeen.push({ tier, seed, ms: res.setupMs });
        wetnessAll.push(...res.wetness.map((x) => ({ ...x, tier, seed })));
        legsAll.push({ tier, seed, ...routed });
        const ok = res.faults.length === 0 && res.renderErrors.length === 0;
        if (!ok) bad = true;
        console.log(
          `${ok ? '✓' : '✗'} ${res.controls} controls · ${res.lengthM} m · ` +
            `legs ${(routed.fraction * 100).toFixed(0)}% street · ` +
            `reachable ${(res.reachable * 100).toFixed(0)}% · ` +
            (res.pocketM2 < 0 ? 'start opens onto the venue' : `start pocket ${res.pocketM2} m²`),
        );
        for (const f of res.faults) console.log(`     ✗ ${f}`);
        // Noted, not failed: this is a sampled seed, not the one that ships.
        for (const f of detourNotes) console.log(`     · ${f}`);
        for (const f of endpointNotes) console.log(`     · ${f}`);
        for (const e of res.renderErrors) console.log(`     ✗ render: ${e}`);
        if (!ok && tab.consoleErrors.length) console.log(`     console: ${tab.consoleErrors[0]}`);
        await tab.close();
      }
    }
  });

  // The rules may not depend on the graphics settings.
  //
  // This is the invariant the whole failure violated, stated once: a quality
  // tier decides how the venue is *drawn*, never what is out of bounds. Two
  // players on the same seed and different phones must be running the same
  // race. Checked against what each tier actually loaded rather than against
  // the manifest, which `TerrainField.load` never reads.
  const shapes = [...rasterByTier.entries()];
  const first = shapes[0]?.[1];
  let agree = true;
  for (const [tier, r] of shapes) {
    if (first && (r.resM !== first.resM || r.width !== first.width)) {
      console.log(
        `  ✗ ${tier} loaded a ${r.resM} m passability raster where ${shapes[0][0]} loaded ${first.resM} m` +
          `\n    A tier is a rendering budget. Two players on one seed and two phones must be` +
          `\n    running the same race — see TerrainField.load.`,
      );
      agree = false;
      bad = true;
    }
  }
  if (first && agree) {
    console.log(`  passability raster: ${first.resM} m, identical on every tier`);
  }

  // Does one seed give two players the same course on two phones?
  //
  // Enforced, like the raster above, and for the same reason. This was reported
  // only for one release, while `TerrainField.load` handed the `low` tier a 4 m
  // heightmap: `generateCourse` reads heights for the per-leg climb budget and
  // the seeded RNG in `pickNextControl` is drawn *inside* geometry-dependent
  // branches, so one flipped candidate diverges every subsequent draw. Krumlov
  // gave 3 of 4 seeds a different course per tier — seed 29760961 ran 1441 m on
  // a phone and 1787 m on a desktop. The athlete's slope-driven speed read the
  // same tiered surface, so the physics diverged with it.
  //
  // The fix is not a rounder comparison. `FieldTerrain.rulesHeightAt` computes
  // the rules on a fixed 4 m lattice that every tier holds bit-identically —
  // `tools/terrain/lowtier.mjs` derives `height-low.bin` by decimating
  // `height.bin` so that it does — so equality here is exact, and a tolerance
  // would only let the next regression in. Both keys are checked: the course is
  // the symptom, the rules surface is the cause, and naming which one moved is
  // the difference between a five-minute fix and a day of bisecting.
  const seedsSeen = [...new Set([...courseByTierSeed.keys()].map((k) => k.split('|')[1]))];
  const tiersSeen = [...rasterByTier.keys()];
  let divergent = 0;
  let surfaceDivergent = 0;
  for (const seed of seedsSeen) {
    const rows = tiersSeen
      .map((t) => [t, courseByTierSeed.get(`${t}|${seed}`)])
      .filter(([, v]) => v);
    if (rows.length < 2) continue;
    const [, ref] = rows[0];

    if (rows.some(([, v]) => v.rulesKey !== ref.rulesKey)) {
      surfaceDivergent++;
      console.error(
        `  ✗ seed ${seed}: the tiers are computing the rules on different ground — ` +
          rows.map(([t, v]) => `${t} ${v.rulesKey}`).join(' · ') +
          `\n    FieldTerrain.rulesHeightAt must return the same metres on every tier. If` +
          `\n    height-low.bin was rebuilt by anything but tools/terrain/lowtier.mjs it will not.`,
      );
      bad = true;
    }
    if (rows.some(([, v]) => v.courseKey !== ref.courseKey)) {
      divergent++;
      console.error(
        `  ✗ seed ${seed} gives a different course per tier: ` +
          rows.map(([t, v]) => `${t} ${v.controls}/${v.lengthM} m/${v.climbM} m climb`).join(' · ') +
          `\n    A tier is a rendering budget. Two players on one seed and two phones must be` +
          `\n    running the same race — see FieldTerrain.rulesHeightAt.`,
      );
      bad = true;
    }
  }
  if (!divergent && !surfaceDivergent) {
    console.log(
      `  every seed gives the same course, on the same rules surface, on every tier`,
    );
  }

  // --- one passable space, every tier --------------------------------------
  //
  // PLAN-KRUMLOV-V2 §6 phase 2: *"tier independence by construction, not by
  // assertion."* The construction is that `loadPassable` takes no tier and
  // there is no `passable-low.bin` to generate. This is the assertion anyway,
  // because D-027 and D-029 were both true by construction in somebody's head.
  if (passableSeen.length) {
    const keys = [...courseByTierSeed.values()].map((v) => v.passableKey);
    const same = keys.every((k) => k === keys[0]);
    const p = passableSeen[0];
    console.log(
      `  passable space: ${p.resM} m, ${(p.fraction * 100).toFixed(1)} % reachable, ` +
        `${p.census.pockets} pockets (${p.census.sealed} sealed · ${p.census.porous} porous · ` +
        `${p.census.gridArtifacts} grid artifacts · ${p.census.traps} traps), ` +
        `${p.punched} cells punched for hand-modelled structures`,
    );
    if (!same || keys[0] === 'absent') {
      console.error(
        keys[0] === 'absent'
          ? '  ✗ the running game holds no passable space — run tools/terrain/passable.mjs'
          : '  ✗ the tiers are not holding the same passable space: ' +
            [...new Set(keys)].join(' · '),
      );
      bad = true;
    } else {
      console.log(`  every tier holds the identical passable space (${keys[0]})`);
    }
    if (p.census.traps > 0 || p.census.porous > 0 || p.census.gridArtifacts > 0) {
      console.error(
        `  ✗ the shipped census is not clean: ${p.census.traps} traps, ${p.census.porous} porous, ` +
          `${p.census.gridArtifacts} grid artifacts`,
      );
      bad = true;
    }
  }

  // --- what the venue cost to open -----------------------------------------
  //
  // Phase 0: *"any venue-wide sweep of the vector model belongs in the build,
  // not in the loading screen"*, measured at 2.6 s for the bake and 2.9 s for
  // the reachability fill on the 4×-throttled Android proxy. This gate is not
  // throttled, so the number here is a desk number and the budget is set
  // accordingly — it exists to catch a sweep coming *back*, which is a factor
  // of a thousand, not a factor of two. `tools/perf/setup-cost.mjs` is where
  // the phone figure is measured.
  if (setupSeen.length) {
    const total = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    const worst = setupSeen.reduce((a, b) => (total(a.ms) > total(b.ms) ? a : b));
    console.log(
      `  venue setup, worst of ${setupSeen.length} loads: ` +
        Object.entries(worst.ms).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(' · '),
    );
    if (total(worst.ms) > LIMITS.maxSetupMs) {
      console.error(
        `  ✗ opening the venue cost ${total(worst.ms).toFixed(0)} ms of venue-wide passes on an ` +
          `unthrottled desktop, against a ${LIMITS.maxSetupMs} ms budget — something is sweeping ` +
          'the model at load again',
      );
      bad = true;
    }
  }

  // --- how close to the water did anything get? --------------------------
  //
  // Reported whether or not anything failed, because the client's report was a
  // draw out of a distribution rather than a single event, and the number that
  // says whether this is fixed is *how much freeboard the worst point had*, not
  // *did the assertion pass today*. Before this change, sited points over water
  // were routine — 1 menu-shaped seed in 40 put the start itself in the Vltava,
  // 9 in 40 put some control there — and the worst freeboard was −5.2 m.
  if (!wetnessAll.length) {
    console.log('  no sited point on any seed or tier stood over water at all');
  } else {
    const fb = wetnessAll.map((x) => x.freeboard).sort((a, b) => a - b);
    const onDeck = wetnessAll.filter((x) => x.onDeck).length;
    console.log(
      `  ${wetnessAll.length} sited point(s) stood over water, ${onDeck} of them on a bridge` +
        `\n    freeboard min ${fb[0].toFixed(2)} m · median ${fb[fb.length >> 1].toFixed(2)} m` +
        ` · max ${fb[fb.length - 1].toFixed(2)} m`,
    );
  }

  // --- do the legs run through the alleys? -------------------------------
  if (legsAll.length) {
    const fr = legsAll.map((l) => l.fraction).sort((a, b) => a - b);
    console.log(
      `  legs on the street network: min ${(fr[0] * 100).toFixed(0)} %` +
        ` · median ${(fr[fr.length >> 1] * 100).toFixed(0)} %` +
        ` · max ${(fr[fr.length - 1] * 100).toFixed(0)} %`,
    );
  }

  // --- and is any of them a lap of the town? -----------------------------
  //
  // The whole distribution, not just the failures, for the same reason the
  // freeboard distribution above is printed: the number that says whether this
  // is fixed is *how bad the worst leg was*, not *did the assertion pass*. The
  // course that shipped ran a median of 1.4× with a worst leg of 14.0×, and a
  // gate reporting only "pass" would have hidden the second fault at 10.3×
  // behind the first.
  const st = detourStats(legsAll);
  if (st) {
    const cd = legsAll.map((l) => l.courseDetour).sort((a, b) => a - b);
    console.log(
      `  leg detour (run distance ÷ straight line), ${st.n} legs:` +
        ` min ${st.min.toFixed(2)}× · median ${st.median.toFixed(2)}×` +
        ` · p90 ${st.p90.toFixed(2)}× · max ${st.max.toFixed(2)}×` +
        `\n    ${st.over(2)} leg(s) over 2.0× (the bottom of the published route-efficiency` +
        ` scale), ${st.over(LIMITS.maxLegDetour)} over ${LIMITS.maxLegDetour.toFixed(1)}×` +
        `\n    whole-course detour factor D: ${cd[0].toFixed(2)}–${cd[cd.length - 1].toFixed(2)}` +
        ` against ≈1.05 for a real sprint (RESEARCH-SPORT §8.6)`,
    );
    if (st.median > LIMITS.maxMedianLegDetour) {
      console.error(
        `  ✗ the generator's median leg runs ${st.median.toFixed(2)}× its straight line, ` +
          `over ${LIMITS.maxMedianLegDetour.toFixed(2)}×` +
          `\n    A sprint course runs 1.05× its stated length and at most about 1.6× ` +
          `(RESEARCH-SPORT §8.6).` +
          `\n    This is the generator, not one course: see LIMITS.maxMedianLegDetour.`,
      );
      bad = true;
    }
  }

  // The population rate for endpoints, printed for the same reason the detour
  // distribution is: one course is picked out of hundreds, so what matters about
  // the generator is the rate at which it needs picking. A rising number here is
  // the early warning that a change has pushed starts toward open ground.
  if (courseByTierSeed.size) {
    console.log(
      `  starts or finishes off the street network: ${offNetworkStarts} of ` +
        `${courseByTierSeed.size} sampled (tier, seed) pairs` +
        `\n    Reported, not failed — the shipped course is asserted separately and absolutely.`,
    );
  }

  return bad;
}

/**
 * The same course, every time the venue is opened.
 *
 * The client's sentence begins *"always the same course"*, and until this
 * change the menu seeded every race with `(Date.now() / 60000) | 0` — a new
 * course every minute, which is why the personal bests and ghosts in
 * `LocalStore`, keyed by course id, had never once been read back.
 *
 * Cross-*tier* agreement was already asserted above and is a different claim: it
 * says two phones agree, not that two runs agree. So this loads the venue the
 * way a player does — the deep link with **no seed**, which falls through to the
 * venue's own fixed seed exactly as the menu does — several times, and requires
 * the course id and the full course fingerprint to be identical every time. Two
 * loads would catch a clock-derived seed; four also catch one that changes
 * every few minutes rather than every minute.
 *
 * **And it is the only phase that sees the course that ships.** `SEEDS` above
 * are menu-shaped samples of the generator, chosen so the gate is deterministic
 * and broad; none of them is `COURSE_SEED`. So the leg measures — the street
 * fraction and, since D-037, the detour ratio — are asserted here as well,
 * against the course the client actually plays. Both faults he reported were in
 * this course and in none of the four sampled seeds.
 */
async function stabilityPhase(venue, port, runs = 4) {
  let bad = false;
  const seen = [];
  let shipped = null;
  await withChrome(async (cdpPort) => {
    for (let i = 0; i < runs; i++) {
      const url = `http://127.0.0.1:${port}/?scene=sprint&race=1&debug=0&tier=high`;
      const tab = await openTab(cdpPort, url);
      const ready = await tab.waitFor('!!(window.__race && window.__world)', 45_000);
      if (!ready) {
        console.log(`  ✗ run ${i + 1}: the race never mounted`);
        bad = true;
        await tab.close();
        continue;
      }
      const raw = await tab.evaluate(PROBE(LIMITS));
      const res = JSON.parse(raw);
      seen.push({ id: res.courseId, key: res.courseKey, n: res.controls, m: res.lengthM });
      if (!shipped) shipped = res;
      await tab.close();
      // A minute apart would be the honest test of a per-minute seed, and this
      // gate cannot afford four minutes. It does not need to: the seed is now a
      // constant, so any clock in it shows up as a *different constant* between
      // two loads only if the clock moved — which is why the id is compared as
      // well as the fingerprint. A seed derived from the date would pass here
      // and is the daily challenge's business, not the main entries'.
    }
  });
  if (seen.length < 2) return bad;
  const ref = seen[0];
  const same = seen.every((s) => s.id === ref.id && s.key === ref.key);
  if (!same) {
    console.error(
      `  ✗ ${venue} does not hold to one course: ` +
        seen.map((s) => `${s.id} (${s.n}/${s.m} m)`).join(' · ') +
        `\n    A venue has one course. A rotating seed belongs to the daily challenge —` +
        `\n    see VENUES in src/core/venues.ts and docs/ROADMAP.md.`,
    );
    bad = true;
  } else {
    console.log(
      `  ${seen.length} separate loads all gave course ${ref.id} — ${ref.n} controls, ${ref.m} m`,
    );
  }

  // --- the shipped course, audited leg by leg ------------------------------
  //
  // Every fault here is hard. This is the course the client plays, and the
  // whole of D-037 is that "the gates were green and the course was
  // unplayable" has now happened twice: once for the detour, and once for a
  // merge that made six legs unreachable while `makeLegRouter` — 2 m lattice,
  // alleys 2–3 m wide — reported every one of them routable. See
  // `makeCourseAudit` for why this is a separate measurement rather than the
  // same one with different constants.
  if (shipped) {
    const bins = [...new Set(tierRasters(venue).map((t) => t.bin))];
    const bin = bins[0] ?? 'runnability.bin';
    const a = makeCourseAudit(venue, bin)(shipped.points);
    const routed = makeLegRouter(venue, bin)(shipped.points);
    const faults = auditFaults(a, LIMITS);

    // --- and does the offline model still agree with the runtime? ----------
    //
    // The audit is a reconstruction of `SprintScene.blockedAt` outside the
    // browser, and its own `blockedAtOf` comment records that it cannot see the
    // landmark footprints `Buildings` skips — so it is *stricter*, never
    // looser. Stricter is the safe direction for passing a course and the
    // dangerous direction for refusing one: a gate harsher than the game
    // refuses courses that play perfectly, and the picker sharing it would then
    // reject good seeds forever and report "no seed passes" for a reason that
    // is an artifact rather than a fact about the venue.
    //
    // So the two are compared directly, and a disagreement is its own fault
    // with its own message. It is not the same bug as a bad course and must
    // never be reported as one.
    const names = shipped.points.map((p) => p.n);
    const disagree = [];
    for (let i = 0; i < names.length; i++) {
      const offlineOk = !a.sealed.includes(names[i]) && !a.unreachableFromStart.includes(names[i]);
      const runtimeOk = shipped.runtimeReachable?.[i] ?? true;
      if (offlineOk !== runtimeOk) {
        disagree.push(`${names[i]}: offline says ${offlineOk ? 'reachable' : 'not'}, the game says ${runtimeOk ? 'reachable' : 'not'}`);
      }
    }
    if (disagree.length) {
      faults.push(
        `the offline collision model and the runtime disagree about ${disagree.length} point(s) — ` +
          disagree.join('; ') +
          `\n    The runtime is the truth: it is what stops the player. Fix the audit, not the` +
          `\n    course. See blockedAtOf and makeCourseAudit in this file.`,
      );
    } else {
      console.log(
        `  the offline model and the runtime agree on all ${names.length} sited points`,
      );
    }
    if (routed.fraction < LIMITS.minLegsOnNetwork) {
      faults.push(
        `the legs run ${(routed.fraction * 100).toFixed(0)} % on the street network, ` +
          `under ${(LIMITS.minLegsOnNetwork * 100).toFixed(0)} %`,
      );
    }
    for (const f of endpointFaults(routed, LIMITS)) faults.push(f);
    // Printed whether or not it fails, because "the start is on Road" is the
    // line that says the course begins where the client's acceptance test says
    // it does — *"it starts at the start and runs through the alleys"*.
    for (const e of routed.ends ?? []) {
      console.log(
        `  the ${e.name} stands on ${e.className}` +
          (e.onNetwork ? '' : ` — ${e.nearestNetM.toFixed(1)} m off the street network`),
      );
    }
    console.log(
      `  the shipped course walks ${Math.round(a.walkedTotal)} m for a printed ${ref.m} m ` +
        `— D ${a.courseDetour.toFixed(2)}, ${(routed.fraction * 100).toFixed(0)} % of it street`,
    );
    console.log(auditTable(a, '    '));
    for (const f of faults) console.error(`  ✗ ${f}`);
    if (faults.length) bad = true;
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const venue = (args.find((a) => a.startsWith('--venue=')) ?? '--venue=krumlov').slice(8);
  const step = Number((args.find((a) => a.startsWith('--step=')) ?? '--step=0.5').slice(7));
  const offlineOnly = args.includes('--offline');

  const dir = venueDir(venue);
  if (!existsSync(join(dir, 'townscape.json'))) {
    console.log(`· ${venue}: no townscape — nothing to check`);
    process.exit(0);
  }

  const town = JSON.parse(readFileSync(join(dir, 'townscape.json'), 'utf8'));
  if (!town.rasterStamped) {
    console.error(
      `✗ ${venue}: runnability.bin has not been stamped with the OSM network, footprints and barriers.\n` +
        `  Run \`node tools/terrain/townscape.mjs --venue=${venue}\`. This happens if the terrain\n` +
        `  was regenerated after the townscape was — build.mjs writes a pristine raster.`,
    );
    process.exit(1);
  }

  let bad = false;

  // --- phase 0 -------------------------------------------------------------
  for (const { bin, tiers } of tierRasters(venue)) {
    if (!existsSync(join(dir, bin))) continue;
    const a = agreement(venue, bin);
    console.log(`· ${venue} geometry ↔ raster · ${bin} (tiers: ${tiers.join(', ')})`);
    if (a.crossableMaxH === undefined) {
      console.error(
        `✗ ${bin}: townscape.json predates the crossable-height invariant — re-run tools/terrain/townscape.mjs`,
      );
      bad = true;
    }
    console.log(
      `  drawn above ${a.crossableMaxH ?? '?'} m with nothing to stop you: ` +
        `${a.drawnLoose.toFixed(0)} m over ${a.drawnLooseWays} barrier(s)` +
        (a.drawnLoose > 0 ? `, tallest ${a.worstLoose} m` : ''),
    );
    console.log(
      `  uncrossable barrier on the map ${(a.barrierDrawn * 100).toFixed(1)} % · ` +
        `building interior ${(a.footprintDrawn * 100).toFixed(1)} %`,
    );
    console.log(
      `  impassable with nothing drawn on it: ${(a.ghostM2 / 1e4).toFixed(2)} ha, ` +
        `${(a.ghostFraction * 100).toFixed(1)} % of the playable ground ` +
        `(${(a.impassableFraction * 100).toFixed(1)} % is impassable in all)`,
    );
    console.log(
      `  worst disagreement ${a.worstD.toFixed(1)} m` +
        (a.worstAt ? ` at (${a.worstAt[0]}, ${a.worstAt[1]}), bearing ${a.worstBrg.toFixed(0)}°` : '') +
        ` · p99 ${a.ghostP99.toFixed(1)} m`,
    );
    console.log(
      `  rotation test: ${a.trend >= 0 ? '+' : ''}${a.trend.toFixed(4)} m per metre of radius, ` +
        `bearings ${(a.directional * 100).toFixed(0)} % aligned ` +
        `(a 7.95° frame error would read ≈0.14 and ≈100)`,
    );

    if (a.drawnLoose > LIMITS.maxDrawnLooseM) {
      console.error(
        `✗ ${bin}: ${a.drawnLoose.toFixed(0)} m of barrier is drawn up to ${a.worstLoose} m tall and does not stop the athlete.\n` +
          `  This is "I go through some brown walls": the geometry and the collider are the same\n` +
          `  feature and must agree. Either give it a collider or draw it no taller than\n` +
          `  ${a.crossableMaxH} m — see CROSSABLE_MAX_H in tools/terrain/townscape.mjs.`,
      );
      bad = true;
    }
    if (a.footprintDrawn < LIMITS.minFootprintDrawn) {
      console.error(
        `✗ ${bin}: ${(100 - a.footprintDrawn * 100).toFixed(1)} % of building interior is passable in the raster the map draws (ISSprOM 521)`,
      );
      bad = true;
    }
    if (a.ghostFraction > LIMITS.maxGhostFraction) {
      console.error(
        `✗ ${bin}: ${(a.ghostFraction * 100).toFixed(1)} % of the playable ground is out of bounds with nothing drawn on it — an invisible wall is where a player gets stuck`,
      );
      bad = true;
    }
    if (Math.abs(a.trend) > LIMITS.maxTrend || a.directional > LIMITS.maxDirectional) {
      console.error(
        `✗ ${bin}: the disagreement grows with radius (${a.trend.toFixed(3)} m/m) and points ${(a.directional * 100).toFixed(0)} % one way.\n` +
          `  That is the signature of a layer left in the wrong frame. S-JTSK grid north is 7.95° off\n` +
          `  true north here and the rasters are resampled into the world frame — see D-017.`,
      );
      bad = true;
    }
    console.log('');
  }

  // --- phase 0b: the venue, before any course exists ------------------------
  {
    const p = passableSpacePhase(venue);
    if (p?.why) {
      console.error(`✗ ${p.why}`);
      bad = true;
    } else if (p?.bad) {
      for (const e of p.errors) console.error(`✗ ${e}`);
      bad = true;
    }
  }

  // --- phase 1 -------------------------------------------------------------
  for (const { bin, tiers } of tierRasters(venue)) {
    if (!existsSync(join(dir, bin))) {
      console.error(`✗ ${venue}: the manifest gives ${tiers.join('/')} a ${bin} that does not exist`);
      bad = true;
      continue;
    }
    const f = floodFill(venue, bin, step);
    console.log(
      `· ${venue} passability · ${bin} (${f.resM} m, tiers: ${tiers.join(', ')}) · ${step} m grid over ±600 m`,
    );
    console.log(`  open ground          ${f.openHa.toFixed(1)} ha`);
    console.log(
      `  reachable from arena ${(f.fraction * 100).toFixed(1)} %  (${f.reachHa.toFixed(1)} ha)`,
    );
    // Four kinds, and only one of them is a bug.
    const artifact = f.traps.filter((t) => t.reallyConnected);
    const sealed = f.traps.filter((t) => !t.reallyConnected && !t.enterable);
    const porous = f.traps.filter((t) => !t.reallyConnected && t.enterable && !t.trap);
    const trapped = f.traps.filter((t) => t.trap);
    console.log(
      `  disconnected pockets over 6 m²: ${f.traps.length}  ` +
        `(${sealed.length} sealed shut · ${porous.length} porous both ways · ` +
        `${artifact.length} grid artifacts · ${trapped.length} traps)`,
    );
    if (artifact.length) {
      console.log(
        `    grid artifacts are 4-connectivity corners: open diagonally, so the athlete walks` +
          ` through them\n    and only this 0.5 m flood thinks they are shut. Not a fault; see` +
          ` \`reallyConnected\`.`,
      );
    }
    for (const t of f.traps.slice(0, 6)) {
      const c = f.centreOf(t.id);
      const how = t.reallyConnected
        ? 'grid artifact — open on the diagonal, the athlete walks through'
        : !t.enterable
        ? 'sealed — the athlete cannot get in either'
        : t.trap
          ? `TRAP — enter over ${t.minJump.toFixed(2)} m from ${CLASS_NAME[t.outsideCls]}, ` +
            `leave needs the same from ${CLASS_NAME[t.insideCls]}`
          : `porous — ${t.minJump.toFixed(2)} m step either way`;
      console.log(`    ${t.m2.toFixed(0).padStart(7)} m²  near (${c.x}, ${c.z})  ${how}`);
    }
    console.log(
      `  uncrossable barriers drawn on the map: ${(f.barrierDrawn * 100).toFixed(1)} %`,
    );

    if (f.arenaBlocked) {
      console.error(`✗ ${bin}: the arena (${ARENA.x}, ${ARENA.z}) is itself inside a barrier`);
      bad = true;
    }
    if (f.fraction < LIMITS.minReachable) {
      console.error(
        `✗ ${bin}: only ${(f.fraction * 100).toFixed(1)} % of open ground is reachable from the arena` +
          (f.resM > 1
            ? `\n  This raster is ${f.resM} m and Krumlov's alleys are 2–3 m. A class raster is not a` +
              `\n  texture — D-002 makes it the passability the map, the course setter and collision` +
              `\n  all read, so downsampling it changes the rules. See TerrainField.load.`
            : ''),
      );
      bad = true;
    }
    // Ground the player can get into and not out of. A fault at any size —
    // this is the bug class, and a 40 m² one ends the race just as completely
    // as a 4 000 m² one.
    for (const t of f.traps.filter((x) => x.trap)) {
      const c = f.centreOf(t.id);
      const [qx, qz, px, pz] = t.jumpAt ?? [0, 0, 0, 0];
      console.error(
        `✗ ${bin}: a ${t.m2.toFixed(0)} m² pocket near (${c.x}, ${c.z}) can be entered and not left.\n` +
          `  A step of ${t.minJump.toFixed(2)} m from (${qx.toFixed(1)}, ${qz.toFixed(1)}) lands inside at` +
          ` (${px.toFixed(1)}, ${pz.toFixed(1)}).\n` +
          `  Race.step tests only the destination of a step, so any barrier thinner than the step is\n` +
          `  crossable; the ground inside is ${CLASS_NAME[t.insideCls]}, the ${CLASS_NAME[t.outsideCls]} outside\n` +
          `  buys a longer one. Close the gap or widen the barrier — see LIMITS.minWanderM2.`,
      );
      bad = true;
    }
    // A large pocket nobody can enter is legitimate, but a *very* large one is
    // the severed-bridge failure wearing a hat.
    const worstSealed = f.traps.filter((t) => !t.enterable)[0];
    if (worstSealed && worstSealed.m2 > LIMITS.maxPocketM2) {
      const c = f.centreOf(worstSealed.id);
      console.error(
        `✗ ${bin}: a ${(worstSealed.m2 / 1e4).toFixed(1)} ha pocket near (${c.x}, ${c.z}) is sealed off from the arena`,
      );
      bad = true;
    }
    if (f.barrierDrawn < LIMITS.minBarrierDrawn) {
      console.error(
        `✗ ${bin}: ${(100 - f.barrierDrawn * 100).toFixed(1)} % of uncrossable barrier length blocks the athlete without appearing in the raster the map draws (ISSprOM 515/518, D-002)`,
      );
      bad = true;
    }
  }

  // --- phase 2 -------------------------------------------------------------
  if (offlineOnly) {
    console.log('\n· runtime phase skipped (--offline)');
  } else if (!existsSync(DIST)) {
    console.error('\n✗ dist/ not found — the runtime phase needs it. Run `npm run build`,');
    console.error('  or pass --offline to run the raster phase alone.');
    bad = true;
  } else {
    console.log(`\n· ${venue} sited points, ${SEEDS.length} seeds × ${TIERS.length} tiers`);
    const port = 8237;
    const server = await serve(DIST, port);
    try {
      if (await runtimePhase(venue, port)) bad = true;
      console.log(`\n· ${venue} holds to one course`);
      if (await stabilityPhase(venue, port)) bad = true;
    } finally {
      server.close();
    }
  }

  if (bad) {
    console.log('\n✗ PASSABILITY CHECK FAILED');
    process.exit(1);
  }
  console.log('\n✓ passability OK');
}

// Guarded so the course-setting tool can import `routeLegs` — the measure that
// decides whether a candidate course runs through the alleys — rather than
// keeping a second copy of it that could drift from the gate's.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('✗ harness error:', e);
    process.exit(2);
  });
}
