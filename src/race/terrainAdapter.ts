/**
 * The adapter between the world's `TerrainField` and the two interfaces the
 * simulation asks for: `CourseTerrain` (course setting) and `RaceTerrain`
 * (running the race).
 *
 * Deliberately an adapter and nothing else. `src/sim/*` is calibrated and
 * tested against its own harnesses (`tools/sim/course-check.mjs`,
 * `tools/sim/race-check.mjs`) and must not learn about three.js or about
 * rasters; equally the terrain layer must not learn what a control is. This
 * file is the seam, and the scoring functions below are the same ones those
 * harnesses already validate courses with — copied in shape deliberately, so
 * the game and the checker are looking at the same terrain.
 *
 * There is one thing here that is more than adaptation, and it is deliberate:
 * this class is where the **rules surface** is defined. `TerrainField` is the
 * surface the venue is *drawn* on and its resolution is a per-tier rendering
 * budget; the heights the course setter and the athlete's legs are costed
 * against may not be, so they come off a fixed 4 m lattice every tier can
 * reproduce exactly. See `rulesHeightAt`, which carries the failure that
 * motivated it.
 *
 * The one piece of real logic here is `blocked`: Krumlov's uncrossable walls,
 * fences and railings live in mesh-space collision volumes rather than in the
 * runnability raster, and a race that let you run through a wall would be a
 * race with no sprint rules in it. Passing the scene's own `blockedAt` in makes
 * the simulation see exactly the geometry the player sees.
 */

import { Runnability } from '@/core/types';
import type { TerrainSample } from '@/core/types';
import { GROUND_FOR_RUNNABILITY } from '@/world/terrain';
import type { TerrainField } from '@/world/terrain';
import type { ControlSite, CourseTerrain } from '@/sim/courseGen';
import type { RaceTerrain } from '@/sim/race';
import { columnDFor } from './urbanFeatures';
import type { UrbanFeatureIndex } from './urbanFeatures';
import type { PassableSpace } from '@/world/passable';

/** Extra out-of-bounds test the raster does not carry. */
export type Blocker = (x: number, z: number) => boolean;

/**
 * Sampling radii, metres.
 *
 * 12–14 m is roughly the diameter of the feature a control sits on, and it is
 * what `describeControl` in courseGen already probes at, so a site that scores
 * as a knoll here gets described as a knoll there.
 */
const FEATURE_R = 14;

/**
 * How far a sprint control may sit from the feature it is described by, metres.
 *
 * At 1:4000 a control circle is 5 mm across, i.e. 20 m on the ground, so a flag
 * more than about 10 m from the feature in the middle of it is not describing
 * that feature any more. 12 m leaves room for the offset a corner site already
 * carries without letting "building corner" mean "somewhere in this street".
 */
const FEATURE_REACH = 12;

/**
 * How far a sprint control may sit from a runnable way, metres.
 *
 * The number that decides whether this is a sprint or a cross-country run. A
 * control the athlete reaches in a stride or two off the network keeps the leg
 * a route-choice problem between streets; one 40 m out in a meadow turns it
 * into a bearing across a field, which is what the client played and did not
 * want. 18 m is about the depth of one Krumlov courtyard.
 */
const PAVED_REACH = 18;

/**
 * The lattice the rules are computed on, metres.
 *
 * 4 m because that is the coarsest heightfield any tier is handed, so it is the
 * only spacing every tier can reproduce exactly — see `rulesHeightAt`. It is
 * also, not by accident, the lattice `CONTOUR_CELL_M` extracts the printed
 * map's contours on, so the map and the rules read the same surface.
 */
const RULES_CELL_M = 4;

/** Four-connected steps, for `escapeAreaM2`. */
const NEIGHBOUR_STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -FEATURE_R],
  [0, FEATURE_R],
  [-FEATURE_R, 0],
  [FEATURE_R, 0],
  [-10, -10],
  [10, 10],
  [-10, 10],
  [10, -10],
];

export interface FieldTerrainOptions {
  /** Extra out-of-bounds geometry the raster does not carry. */
  blocked?: Blocker;
  /**
   * Score control sites the way a sprint course setter does.
   *
   * In the forest a control sits on a landform, so relief is the signal. In a
   * town it sits on a *corner* — a wall end, a stairway, the inside of a
   * courtyard entrance — and relief says nothing at all. Scoring Krumlov on
   * relief put the whole course on the castle rock and the wooded scarp above
   * Latrán, which is both the wrong sport and, at 56% out-of-bounds cells,
   * frequently unreachable.
   */
  urban?: boolean;
  /**
   * The town's own feature set — building corners, stairways, gates, wall ends,
   * bridges, passage mouths — derived from `townscape.json`.
   *
   * With it, `urbanScore` is answering *"is there a describable man-made
   * feature here, and can you get to it off a runnable way?"*, which is the
   * question a sprint course setter asks. Without it, it falls back to reading
   * out-of-bounds cells out of the raster, which is a proxy for a corner and
   * knows nothing about the street network. The fallback exists so that a venue
   * with no townscape still works; Krumlov always passes the index.
   */
  features?: UrbanFeatureIndex;
  /**
   * Half-extent of the square the vector model is authoritative over, metres.
   *
   * `TownModel.playableR`. Inside it the model is the only thing that decides
   * what is out of bounds; outside it the class raster still is, because the
   * heightfield runs 200 m past the model and nothing else out there knows
   * where the river is. Absent for a venue with no model — the forest — where
   * the raster is the answer everywhere and always was.
   */
  authoritativeR?: number;
  /**
   * The venue's passable space, derived and labelled offline.
   *
   * With it, `buildReachability` reads a bit instead of flooding 2.56 M cells,
   * and `reachableAt` answers off a 0.5 m lattice instead of a 1 m one. Absent
   * for a venue that ships no `passable.bin` — the forest — which keeps the
   * fill it has always had. See `src/world/passable.ts`.
   */
  passable?: PassableSpace;
}

export class FieldTerrain implements CourseTerrain, RaceTerrain {
  private readonly field: TerrainField;
  private readonly blocked: Blocker | null;
  private readonly urban: boolean;
  private readonly features: UrbanFeatureIndex | null;
  /** See `FieldTerrainOptions.authoritativeR`. */
  private readonly authoritativeR: number | null;
  /** See `FieldTerrainOptions.passable`. */
  private readonly passable: PassableSpace | null;

  /**
   * Direction of travel, radians.
   *
   * `Race.step` calls `sample(x, z)` without a heading, so the gradient it gets
   * would otherwise always be the gradient due north — meaning a runner
   * traversing a hillside would be charged for climbing it. The controller sets
   * this each frame before stepping, which costs nothing and makes the slope
   * term mean what `athlete.ts` documents it to mean.
   */
  heading = 0;

  /**
   * What the venue's setup cost, milliseconds, by phase.
   *
   * Reported rather than swallowed, and it is not decoration: PLAN-KRUMLOV-V2
   * §6 phase 0 measured `bakedRaster`'s 2.56 M-cell sweep at 2.6 s and the
   * reachability fill at another 2.9 s on the 4×-throttled Android proxy, and
   * required phase 2 to honour "built offline, once" literally. A budget with
   * no instrument is a budget nobody can tell has been broken —
   * `tools/perf/setup-cost.mjs` reads this.
   */
  readonly costMs: Record<string, number> = {};

  /** Cells of `field` between rules-lattice nodes. See `rulesHeightAt`. */
  private readonly rStride: number;
  private readonly rW: number;
  private readonly rH: number;
  private readonly rCellM: number;
  private readonly rScale: number;

  constructor(field: TerrainField, opts: FieldTerrainOptions = {}) {
    this.field = field;
    this.blocked = opts.blocked ?? null;
    this.urban = opts.urban ?? false;
    this.features = opts.features ?? null;
    this.authoritativeR = opts.authoritativeR ?? null;
    this.passable = opts.passable ?? null;

    const m = field.hMeta;
    this.rStride = Math.max(1, Math.round(RULES_CELL_M / m.resM));
    this.rCellM = m.resM * this.rStride;
    this.rW = Math.floor((m.width - 1) / this.rStride) + 1;
    this.rH = Math.floor((m.height - 1) / this.rStride) + 1;
    this.rScale = (m.maxH - m.minH) / 65535;
  }

  // --- the rules surface ---------------------------------------------------

  /**
   * Raw rules-lattice node, clamped at the edges.
   *
   * Reads `field.heights` directly rather than going through `heightAt`,
   * because the point is to touch the *stored* sample and nothing between it
   * and the caller: `height-low.bin` is a point decimation of `height.bin`
   * carrying its min/max, so node (i, j) is the identical uint16 through the
   * identical scale whichever file the tier was handed.
   */
  private rulesCell(i: number, j: number): number {
    const m = this.field.hMeta;
    const ci = i < 0 ? 0 : i >= this.rW ? this.rW - 1 : i;
    const cj = j < 0 ? 0 : j >= this.rH ? this.rH - 1 : j;
    const k = cj * this.rStride * m.width + ci * this.rStride;
    return m.minH + (this.field.heights[k] as number) * this.rScale;
  }

  /**
   * Height on the surface the *rules* are computed on, metres.
   *
   * Not `field.heightAt`, and the difference is the whole reason this method
   * exists. `TerrainField.load` hands the `low` tier a 4 m heightmap and every
   * other tier a 1 m one, which is a fair rendering trade and an unfair racing
   * one: `generateCourse` reads heights for the per-leg climb budget, and the
   * seeded RNG in `pickNextControl` is drawn *inside* geometry-dependent
   * branches, so one flipped candidate makes every subsequent draw diverge.
   * Krumlov duly handed 3 of 4 seeds a different sprint course on a phone than
   * on a desktop — seed 29760961 gave 14 controls over 1441 m on `low` and over
   * 1787 m on `high`. The athlete's slope-driven speed read the same tiered
   * surface, so the physics diverged with it.
   *
   * This is the same invariant `TerrainField.load` already states for the class
   * raster — a tier is a rendering budget, never a rules budget — and the same
   * resolution as the fix there. The difference is the bill. Runnability could
   * simply be shipped once at 1 m for a quarter of a megabyte; the full
   * heightfield costs 4.5 MB gzip on Krumlov and 10.4 MB on Martinkov against a
   * 25 MB device budget, so "ship one heightfield" is not available. What is
   * available is to make every tier *agree on one lattice*: 4 m, the coarsest
   * any tier holds, which the low tier stores outright and the others hold
   * every fourth sample of. `tools/terrain/lowtier.mjs` derives the low file so
   * those samples are bit-identical, so this is exact rather than close —
   * "close" is worthless against a chaotic RNG stream.
   *
   * What it costs: the climb budget and the felt gradient are computed over 4 m
   * instead of 1 m. Climb is a whole-course quantity over legs of 55–190 m and
   * does not notice. The gradient is now a central difference over 8 m, which
   * is if anything closer to what a runner feels than an 8 mm-precision 1 m
   * lattice's local noise. Nothing *drawn* changes: the mesh, the vegetation,
   * the townscape and the eye all still read `TerrainField` at the tier's own
   * resolution, which is what a rendering budget is for.
   */
  rulesHeightAt(x: number, z: number): number {
    const m = this.field.hMeta;
    const fx = (x - m.originX) / this.rCellM;
    const fz = (z - m.originZ) / this.rCellM;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return (
      this.rulesCell(i, j) * (1 - tx) * (1 - tz) +
      this.rulesCell(i + 1, j) * tx * (1 - tz) +
      this.rulesCell(i, j + 1) * (1 - tx) * tz +
      this.rulesCell(i + 1, j + 1) * tx * tz
    );
  }

  /**
   * Gradient of the rules surface, metres of rise per metre, as [d/dx, d/dz].
   *
   * Stepped by the rules cell rather than the field's, so two tiers sampling
   * the same point get the same number — the same reason as `rulesHeightAt`.
   */
  private rulesGradient(x: number, z: number): [number, number] {
    const d = this.rCellM;
    return [
      (this.rulesHeightAt(x + d, z) - this.rulesHeightAt(x - d, z)) / (2 * d),
      (this.rulesHeightAt(x, z + d) - this.rulesHeightAt(x, z - d)) / (2 * d),
    ];
  }

  // --- CourseTerrain -------------------------------------------------------

  heightAt(x: number, z: number): number {
    return this.rulesHeightAt(x, z);
  }

  // --- what is out of bounds ------------------------------------------------

  /**
   * Is this point out of bounds? The one predicate the athlete meets.
   *
   * **Where a vector model exists, it is the whole answer.** That is the phase
   * 2 correction and it is not a refinement: this used to be
   * `runnabilityAt(x, z) === Impassable`, so Krumlov's centimetre-accurate
   * colliders were being read through a 1 m class raster whose `Impassable`
   * cells are 1 m squares of world — and whose class is written by widening any
   * feature narrower than the lattice out to half a cell diagonal, so that a
   * 0.10 m railing appears on the map as a line rather than as dots (D-038).
   * Fair on the map, and a wall up to 2.4 m thick in the physics.
   *
   * Measured on the town's own 62 741 paved centreline points
   * (`tools/terrain/quantisation.mjs`), casting perpendicular to each, which is
   * what alley width means:
   *
   * | | vector | through the raster |
   * |---|---|---|
   * | median ≤3 m alley | 1.80 m | **1.52 m** |
   * | alley centreline the athlete cannot stand on | 0 % | **12.8 %** |
   *
   * D-027 is this fault at 4 m and 49 % of the centre. It survived at 1 m and
   * 12.8 % because nobody measured the alleys, only the area — which is
   * precisely what phase 0 warned the area measurement could never catch.
   *
   * The raster keeps the ground the model does not cover. `TownModel` is built
   * over the playable square and the heightfield runs 200 m further, so beyond
   * `authoritativeR` the class raster is still the only thing that knows the
   * Vltava is there. Inside it, the model is alone and exact.
   */
  blockedAt(x: number, z: number): boolean {
    if (!this.blocked) return this.field.runnabilityAt(x, z) === Runnability.Impassable;
    if (this.blocked(x, z)) return true;
    if (this.authoritativeR !== null && Math.abs(x) <= this.authoritativeR && Math.abs(z) <= this.authoritativeR) {
      return false;
    }
    return this.field.runnabilityAt(x, z) === Runnability.Impassable;
  }

  /**
   * The class the athlete's speed is read off.
   *
   * Two things it must do, and the second only became necessary once
   * `blockedAt` stopped consulting the raster. `Impassable` carries a speed of
   * zero (`SPEED_BY_RUNNABILITY`), so a cell that the model calls open and the
   * raster calls impassable is now ground the athlete can walk into and never
   * leave — frozen at zero speed, which is the "I'm stuck" report arriving by
   * its third road. That is the widening halo: 0.24 m either side of a wall,
   * 0.41 m either side of a railing, about 1.5 ha of Krumlov.
   *
   * So the halo takes the nearest real class instead, by a ring search on the
   * raster's own lattice. It is the same rule `deriveRaster` applies offline to
   * the cells it frees — nearest non-impassable class — and it is deterministic
   * and tier-independent, because the raster is one file for every tier.
   */
  runnabilityAt(x: number, z: number): Runnability {
    if (this.blockedAt(x, z)) return Runnability.Impassable;
    const cls = this.field.runnabilityAt(x, z);
    if (cls !== Runnability.Impassable) return cls;
    return this.nearestClass(x, z);
  }

  /** Nearest non-impassable class on the raster lattice. See `runnabilityAt`. */
  private nearestClass(x: number, z: number): Runnability {
    const res = this.field.rMeta.resM;
    for (let r = 1; r <= 3; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const c = this.field.runnabilityAt(x + di * res, z + dj * res);
          if (c !== Runnability.Impassable) return c;
        }
      }
    }
    // Three cells out and still nothing: the halo is never this deep, so this
    // is a courtyard the model opened inside a block of ZABAGED building.
    // OpenRough is the honest guess and it is not fast.
    return Runnability.OpenRough;
  }

  /**
   * How describable this point is as a control site, 0..1.
   *
   * Relief against the local mean finds knolls, re-entrants and depressions;
   * the maximum single deviation finds edges the mean smooths away; and rock
   * and marsh get a bonus because they are describable in their own right
   * regardless of relief.
   */
  featureScoreAt(x: number, z: number): number {
    const cls = this.runnabilityAt(x, z);
    // A control may not be sited out of bounds — in a sprint that is a rule,
    // not a preference (ISSprOM 521, IOF Rule 17.2).
    if (cls === Runnability.Impassable) return 0;
    // Nor anywhere the athlete cannot get to. See `buildReachability`.
    if (!this.reachableAt(x, z)) return 0;
    return this.urban ? this.urbanScore(x, z, cls) : this.forestScore(x, z, cls);
  }

  // --- reachability --------------------------------------------------------

  private mask: Uint8Array | null = null;
  /** Edge passability east and south of each cell. See `buildReachability`. */
  private eastOk: Uint8Array | null = null;
  private southOk: Uint8Array | null = null;
  private maskStep = 1;
  private maskW = 0;
  private maskH = 0;
  private maskX0 = 0;
  private maskZ0 = 0;
  /** Where the reachability was asked from, for the lazy routing fill. */
  private arena: { x: number; z: number } | null = null;

  /**
   * Flood-fill the ground the athlete can actually get to from the arena.
   *
   * This is not defensive programming, it is a course-setting rule that the
   * generator has no way to know about: **every control must be reachable from
   * the start.** Without it Krumlov produces courses that cannot be completed,
   * and the reason is worth recording.
   *
   * `SprintScene.stampBuildings` burns all 1739 OSM footprints into the
   * runnability raster as `Impassable`, then dilates by one cell. The dilation
   * spares paved cells, but the primary stamp does not — so wherever an OSM
   * footprint overlaps an alley (which in a medieval town is very often; the
   * footprints are approximate and the alleys are 2–3 m wide) the alley is
   * sealed. Measured from the finished raster: only **30% of the runnable
   * cells in the AOI are connected to Náměstí Svornosti**, and a straight
   * `generateCourse` put 7 of 17 controls and the finish outside that
   * component.
   *
   * The right long-term fix is in the terrain pipeline — the paved network
   * should win over the footprint, as `SprintScene.stampPaved`'s own comment
   * anticipates. This is the fix that makes the race playable today, and it is
   * correct on its own terms regardless.
   */
  /**
   * The raster the map should draw, with the scene's own collision baked in.
   *
   * `SprintScene.blockedAt` knows about three things the runnability raster
   * does not: building collision volumes, and Krumlov's uncrossable walls and
   * railings from `Townscape.blocks`. A wall that stops the athlete but does
   * not appear on the map is unfair in a way an orienteer would rightly
   * complain about — ISSprOM 515/518 exist precisely so that uncrossable
   * barriers are *on the map* — and it is also what made the athlete wedge
   * against geometry the navigation layer could not see.
   *
   * Baking is a per-cell test over the venue, ~150 ms once at race setup. The
   * result feeds both the map and the reachability fill, so the picture the
   * player reads, the ground the course is set on, and the walls that stop them
   * are finally the same three things.
   */
  bakedRaster(): Uint8Array {
    if (this.baked) return this.baked;
    const t0 = now();
    if (!this.blocked) {
      this.baked = this.field.runnability;
      this.costMs.baked = now() - t0;
      return this.baked;
    }
    /**
     * With a shipped passable space there is nothing left to bake, and that is
     * a proved statement rather than an optimistic one.
     *
     * `tools/terrain/townmodel.mjs` writes the raster's `Impassable` class from
     * the same model this would sweep, and `tools/ci/check-townmodel.mjs`
     * asserts both directions of it over the playable square every run: 0 m² is
     * solid and not on the map. The one thing the file cannot contain is what
     * the scene registers by hand after it was written — the Marian column, the
     * cloak bridge's piers, 94 m² of venue — and `PassableSpace.punch` has
     * already found exactly those cells. So the bake is a copy plus a handful
     * of stamps, instead of 2.56 M collision queries at 1452 ms on a phone.
     */
    if (this.passable) {
      const rm = this.field.rMeta;
      const out = new Uint8Array(this.field.runnability);
      const pts = this.passable.punchedPoints;
      for (let p = 0; p + 1 < pts.length; p += 2) {
        const i = Math.round(((pts[p] as number) - rm.originX) / rm.resM);
        const j = Math.round(((pts[p + 1] as number) - rm.originZ) / rm.resM);
        if (i < 0 || j < 0 || i >= rm.width || j >= rm.height) continue;
        out[j * rm.width + i] = Runnability.Impassable;
      }
      this.baked = out;
      this.costMs.baked = now() - t0;
      return out;
    }
    const m = this.field.rMeta;
    const out = new Uint8Array(this.field.runnability);
    // One sample per cell, at its centre — no dilation. Krumlov's alleys are
    // 2–3 m wide and `SprintScene.stampBuildings` has already dilated the
    // footprints by a metre; widening the barriers again here sealed the town
    // outright (the reachable component fell from 36% of the map to 1%).
    //
    // Barriers thinner than a cell are therefore invisible *to this raster*.
    // They are not invisible to the athlete, so the reachability fill tests
    // the edges between cells rather than trusting it — see `buildReachability`.
    for (let j = 0; j < m.height; j++) {
      const z = m.originZ + j * m.resM;
      for (let i = 0; i < m.width; i++) {
        const k = j * m.width + i;
        if (out[k] === Runnability.Impassable) continue;
        if (this.blocked(m.originX + i * m.resM, z)) out[k] = Runnability.Impassable;
      }
    }
    this.baked = out;
    this.costMs.baked = now() - t0;
    return out;
  }

  private baked: Uint8Array | null = null;

  /** Is this exact point inside a barrier? Cheap wrapper over the scene test. */
  private isBlocked(x: number, z: number): boolean {
    return this.blocked ? this.blocked(x, z) : false;
  }

  /**
   * Shipped, so there is nothing to fill.
   *
   * Connectivity is a global property of the venue, so establishing it costs a
   * venue-wide flood however it is written — 4450 ms of one on the 4×-throttled
   * Android proxy, measured, every time the venue opened, to recompute an
   * answer that cannot change between one load and the next.
   * `tools/terrain/passable.mjs` does it once, at 0.5 m rather than 1 m, over an
   * 8-connected graph whose every edge is swept at `SWEEP_M` — the athlete's
   * own step test — instead of a 4-connected one with a single midpoint probe.
   * Better answer, and it is not in the loading screen.
   *
   * The routing lattice the autopilot wants is *not* built here (see
   * `ensureRouting`): it is a test hook, it is the only thing left that still
   * needs a sweep, and a test hook may not spend a player's loading time.
   */
  buildReachability(from: { x: number; z: number }): { fraction: number } {
    const t0 = now();
    this.arena = from;
    const r = this.passable
      ? { fraction: this.passable.reachableFraction }
      : this.fillReachability(from);
    this.costMs.reach = now() - t0;
    return r;
  }

  /** The flood itself. Also what `ensureRouting` runs, off the loading path. */
  private fillReachability(from: { x: number; z: number }): { fraction: number } {
    // 1 m where the venue is small enough to afford it: Krumlov's alleys are
    // 2–3 m wide and a 2 m grid disconnects them by aliasing alone.
    const span = Math.max(this.field.spanX, this.field.spanZ);
    const step = span <= 1600 ? 1 : 2;
    const x0 = this.field.minX;
    const z0 = this.field.minZ;
    const w = Math.floor(this.field.spanX / step) + 1;
    const h = Math.floor(this.field.spanZ / step) + 1;

    const baked = this.bakedRaster();
    const rm = this.field.rMeta;
    const open = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const rj = Math.round((z0 + j * step - rm.originZ) / rm.resM);
      for (let i = 0; i < w; i++) {
        const ri = Math.round((x0 + i * step - rm.originX) / rm.resM);
        const inside = ri >= 0 && rj >= 0 && ri < rm.width && rj < rm.height;
        open[j * w + i] =
          inside && baked[rj * rm.width + ri] !== Runnability.Impassable ? 1 : 0;
      }
    }

    // Edge passability, tested at the midpoint between adjacent cell centres.
    //
    // This is what catches Krumlov's walls and railings, which are collision
    // volumes a few centimetres thick: a wall lying between two cell centres
    // leaves both cells "open" while making the step between them impossible.
    // Without this the fill routed straight through a railing, the course
    // generator sited a control on the far side, and the athlete stopped dead
    // nine metres short of it against something the map does not draw.
    const eastOk = new Uint8Array(w * h);
    const southOk = new Uint8Array(w * h);
    const mid = step / 2;
    for (let j = 0; j < h; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!open[k]) continue;
        const x = x0 + i * step;
        if (i < w - 1 && open[k + 1] && !this.isBlocked(x + mid, z)) eastOk[k] = 1;
        if (j < h - 1 && open[k + w] && !this.isBlocked(x, z + mid)) southOk[k] = 1;
      }
    }

    // Cells with at least one way in or out. A cell with none is an isolated
    // pixel between two barriers and can only ever be a trap.
    //
    // Note what this deliberately is *not*: an erosion. Requiring room on two
    // or three sides sounds obviously right and is a disaster here — with the
    // old building dilation in place it cut Krumlov's reachable ground from
    // 35% of the map to 1%. The dilation is now gone (see
    // `SprintScene.stampBuildings`), which is the fix that actually widened the
    // alleys; this only drops the pixels that lead nowhere.
    const roomy = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!open[k]) continue;
        const anyWay =
          (i < w - 1 && eastOk[k] === 1) ||
          (i > 0 && eastOk[k - 1] === 1) ||
          (j < h - 1 && southOk[k] === 1) ||
          (j > 0 && southOk[k - w] === 1);
        roomy[k] = anyWay ? 1 : 0;
      }
    }

    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;

    const seed = this.nearestOpen(roomy, w, h, step, x0, z0, from);
    if (seed >= 0) {
      seen[seed] = 1;
      queue[tail++] = seed;
    }
    while (head < tail) {
      const k = queue[head++]!;
      if (eastOk[k] && roomy[k + 1] && !seen[k + 1]) {
        seen[k + 1] = 1;
        queue[tail++] = k + 1;
      }
      if (k >= 1 && eastOk[k - 1] && roomy[k - 1] && !seen[k - 1]) {
        seen[k - 1] = 1;
        queue[tail++] = k - 1;
      }
      if (southOk[k] && roomy[k + w] && !seen[k + w]) {
        seen[k + w] = 1;
        queue[tail++] = k + w;
      }
      if (k >= w && southOk[k - w] && roomy[k - w] && !seen[k - w]) {
        seen[k - w] = 1;
        queue[tail++] = k - w;
      }
    }

    let openN = 0;
    for (let i = 0; i < open.length; i++) openN += open[i]!;

    this.eastOk = eastOk;
    this.southOk = southOk;
    this.mask = seen;
    this.maskStep = step;
    this.maskW = w;
    this.maskH = h;
    this.maskX0 = x0;
    this.maskZ0 = z0;
    return { fraction: openN ? tail / openN : 0 };
  }

  /**
   * How much ground the athlete can actually walk on from `p`, m², measured
   * with the runtime's **own continuous collision** rather than with the mask.
   *
   * This is the enclosure guarantee, and the reason it does not simply consult
   * `reachableAt` is the whole point of it. The mask is a 1 m grid whose edges
   * are tested at one midpoint; the thing that stops the player is a continuous
   * collider. The two agree closely — measured over Krumlov, 73 m² out of
   * 103.7 ha, all of it at the clip edge of the sample box — but "closely" is
   * not a guarantee, and a course point is exactly where the difference would
   * hurt. So the sited points are checked against the collider itself.
   *
   * Cells at 0.5 m with the edges tested at their midpoints, which is what a
   * continuous collider actually enforces: a barrier lying between two open
   * cell centres makes the step between them impossible even though both cells
   * look open. The flood stops as soon as the pocket is provably bigger than
   * `capM2`, so open ground costs a fixed and small amount of work — about
   * 12 000 cells, a couple of milliseconds. `sealed` is true only when the
   * flood ran out of frontier, i.e. the athlete really is walled in.
   */
  escapeAreaM2(p: { x: number; z: number }, capM2: number): { m2: number; sealed: boolean } {
    if (this.isBlocked(p.x, p.z)) return { m2: 0, sealed: true };
    const step = 0.5;
    const cellM2 = step * step;
    const capCells = Math.ceil(capM2 / cellM2);
    const seen = new Set<number>([0]);
    const queue: number[] = [0, 0];
    let head = 0;
    while (head < queue.length) {
      if (seen.size > capCells) return { m2: seen.size * cellM2, sealed: false };
      const i = queue[head++] as number;
      const j = queue[head++] as number;
      const x = p.x + i * step;
      const z = p.z + j * step;
      for (const [di, dj] of NEIGHBOUR_STEPS) {
        const ni = i + di;
        const nj = j + dj;
        const k = ni * 100003 + nj;
        if (seen.has(k)) continue;
        const nx = p.x + ni * step;
        const nz = p.z + nj * step;
        if (this.runnabilityAt(nx, nz) === Runnability.Impassable) continue;
        // The edge, at its midpoint: a barrier thinner than a cell sits between
        // two open centres and is invisible to both of them.
        if (this.isBlocked(x + di * step * 0.5, z + dj * step * 0.5)) continue;
        seen.add(k);
        queue.push(ni, nj);
      }
    }
    return { m2: seen.size * cellM2, sealed: true };
  }

  /**
   * The routing lattice.
   *
   * **With a shipped passable space this is that space and nothing else**, and
   * that is not an optimisation — it is the fault `check-race` found when it was
   * not. `reachableAt` answered off the 0.5 m shipped plane while `routeField`
   * floods its own 1 m one, so the course setter sited a control on ground the
   * router then called unroutable: *two reachability answers in one runtime*,
   * which is the second-opinion failure this whole phase exists to delete,
   * reintroduced by me in the one place I left a flood behind.
   *
   * So there is one graph. Its cells are the shipped `reach` plane and its edges
   * are plain 8-adjacency between them — a **superset** of the swept graph the
   * components were labelled with, so anything the strict graph joins this joins
   * too, and `tools/terrain/passable.mjs` measures the converse and ships it as
   * `looseUnreachable`, which the gate asserts is zero. Reachable therefore
   * means routable, by construction rather than by hope.
   *
   * Without a space — the forest — this is the fill it has always had, built on
   * demand rather than at load, because the autopilot is a test hook and a test
   * hook may not spend a player's loading time.
   */
  private ensureRouting(): void {
    if (this.mask || !this.arena) return;
    const t0 = now();
    if (this.passable) {
      const p = this.passable;
      this.maskStep = p.resM;
      this.maskW = p.width;
      this.maskH = p.height;
      this.maskX0 = p.originX;
      this.maskZ0 = p.originZ;
      const m = new Uint8Array(p.width * p.height);
      for (let j = 0; j < p.height; j++) {
        const z = p.originZ + j * p.resM;
        for (let i = 0; i < p.width; i++) {
          m[j * p.width + i] = p.reachableAt(p.originX + i * p.resM, z) ? 1 : 0;
        }
      }
      this.mask = m;
      this.eastOk = null;
      this.southOk = null;
    } else {
      this.fillReachability(this.arena);
    }
    this.costMs.routing = now() - t0;
  }

  /**
   * Every cell the athlete can step to from `k`, on whichever graph is in use.
   *
   * Eight-connected over the shipped space; four-connected over the fill's own
   * edge planes, which carry a midpoint test the plain adjacency does not need
   * because the shipped space was swept when it was built.
   */
  private eachNeighbour(k: number, visit: (n: number) => void): void {
    const w = this.maskW;
    const x = k % w;
    const y = (k / w) | 0;
    if (this.eastOk && this.southOk) {
      if (x < w - 1 && this.eastOk[k]) visit(k + 1);
      if (x > 0 && this.eastOk[k - 1]) visit(k - 1);
      if (y < this.maskH - 1 && this.southOk[k]) visit(k + w);
      if (y > 0 && this.southOk[k - w]) visit(k - w);
      return;
    }
    const m = this.mask;
    if (!m) return;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= this.maskH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
        const n = yy * w + xx;
        if (m[n] === 1) visit(n);
      }
    }
  }

  /** Is this point in the arena's connected component? True before the fill. */
  reachableAt(x: number, z: number): boolean {
    if (this.passable) return this.passable.reachableAt(x, z);
    const m = this.mask;
    if (!m) return true;
    const i = Math.round((x - this.maskX0) / this.maskStep);
    const j = Math.round((z - this.maskZ0) / this.maskStep);
    if (i < 0 || j < 0 || i >= this.maskW || j >= this.maskH) return false;
    return m[j * this.maskW + i] === 1;
  }

  /**
   * The nearest reachable point to `p`, or `p` itself if it already is one.
   * Used to pull a start or finish that landed in a sealed courtyard back onto
   * ground the athlete can stand on.
   */
  nearestReachable(p: { x: number; z: number }, maxR = 220): { x: number; z: number } {
    // Both tests, and the second one is not belt and braces.
    //
    // `reachableAt` answers about the nearest cell of a 1 m mask; the athlete
    // stands at a continuous point, which can be most of a metre from that cell
    // centre and inside a wall's collision band. `Race.step` reads its speed
    // target from the runnability *at the athlete's own position*, and that
    // target is zero on impassable ground — so an athlete placed inside a
    // barrier has a speed target of zero for the rest of the race and cannot
    // move in any direction. A start or finish half a metre out is a race that
    // never begins.
    const ok = (x: number, z: number): boolean =>
      this.reachableAt(x, z) && !this.isBlocked(x, z);
    if (ok(p.x, p.z)) return p;
    // The spiral steps by the lattice the *answer* comes off, which with a
    // shipped passable space is 0.5 m and not the routing mask's 1 m — and the
    // routing mask may not exist at all, because nothing but the autopilot
    // builds it.
    const step = this.passable ? this.passable.resM : this.maskStep;
    for (let r = step; r <= maxR; r += step * 2) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / (step * 2)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const q = { x: p.x + Math.sin(a) * r, z: p.z - Math.cos(a) * r };
        if (ok(q.x, q.z)) return q;
      }
    }
    return p;
  }

  /**
   * Breadth-first distances, in cells, to `to` over the reachable component.
   *
   * Used only by the autopilot in `controller.ts`, which is a test hook — a
   * player navigates by reading the map, which is the entire game. It exists
   * because a naive "head for the control and sidestep" pilot cannot leave a
   * concave corner, and a 4 km middle takes twenty minutes to run by hand.
   */
  routeField(
    to: { x: number; z: number },
    /**
     * Ground to route around. The pilot passes the controls it has not reached
     * yet: straying inside one is a mispunch and a mispunch is a
     * disqualification, so avoiding them is not caution, it is the sport.
     */
    avoid: readonly { x: number; z: number; r: number }[] = [],
  ): Int32Array | null {
    this.ensureRouting();
    const m = this.mask;
    if (!m) return null;
    const w = this.maskW;
    const h = this.maskH;
    const dist = new Int32Array(w * h).fill(-1);
    const goal = this.cellOf(this.nearestReachable(to));
    if (goal < 0) return null;

    // -2 marks a cell that exists but must not be entered, so the fill goes
    // round it rather than treating it as unvisited.
    for (const a of avoid) {
      const cells = Math.ceil(a.r / this.maskStep);
      const ci = Math.round((a.x - this.maskX0) / this.maskStep);
      const cj = Math.round((a.z - this.maskZ0) / this.maskStep);
      for (let j = cj - cells; j <= cj + cells; j++) {
        if (j < 0 || j >= h) continue;
        for (let i = ci - cells; i <= ci + cells; i++) {
          if (i < 0 || i >= w) continue;
          if ((i - ci) ** 2 + (j - cj) ** 2 > cells * cells) continue;
          const k = j * w + i;
          if (k !== goal) dist[k] = -2;
        }
      }
    }

    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    dist[goal] = 0;
    queue[tail++] = goal;
    while (head < tail) {
      const k = queue[head++]!;
      const d = dist[k]! + 1;
      // The graph the mask was built on, and only that one — see
      // `eachNeighbour`. Routing on a rule the reachability was not established
      // with is how a sited control becomes an unroutable leg.
      this.eachNeighbour(k, (n) => {
        if (m[n] === 1 && dist[n] === -1) {
          dist[n] = d;
          queue[tail++] = n;
        }
      });
    }
    return dist;
  }

  /** Distance in cells to the field's goal, or -1 if unreachable from here. */
  routeDistance(p: { x: number; z: number }, dist: Int32Array): number {
    const i = Math.round((p.x - this.maskX0) / this.maskStep);
    const j = Math.round((p.z - this.maskZ0) / this.maskStep);
    if (i < 0 || j < 0 || i >= this.maskW || j >= this.maskH) return -1;
    return dist[j * this.maskW + i] ?? -1;
  }

  /**
   * A point a few metres along the route, reached only by edges the athlete
   * can actually cross.
   *
   * The obvious implementation — take the lowest-distance cell in a 7×7 window
   * and head for it — is wrong, and wrong in a way that took a while to see: it
   * happily picks a cell on the far side of a wall, because the *field* knows
   * that cell is 900 m from the goal without caring how you get there from
   * here. Walking one edge-validated step at a time and aiming at where that
   * chain ends up keeps the heading smooth and the route real.
   */
  routeWaypoint(
    from: { x: number; z: number },
    dist: Int32Array,
    /**
     * How far to look, **metres**. It used to be cells, which was the same
     * thing while the lattice was always 1 m; on the shipped 0.5 m space it
     * would have quietly halved the pilot's lookahead and made its heading
     * twitch. The pilot's behaviour is a distance, so it is written as one.
     */
    lookaheadM = 6,
  ): { x: number; z: number } | null {
    let k = this.cellOf(from);
    if (k < 0 || dist[k]! < 0) return null;
    const w = this.maskW;
    const lookahead = Math.max(1, Math.round(lookaheadM / this.maskStep));
    for (let step = 0; step < lookahead; step++) {
      const d = dist[k]!;
      if (d === 0) break;
      let next = -1;
      this.eachNeighbour(k, (n) => {
        const nd = dist[n];
        if (nd !== undefined && nd >= 0 && nd < d && (next < 0 || nd < dist[next]!)) next = n;
      });
      if (next < 0) break;
      k = next;
    }
    return {
      x: this.maskX0 + (k % w) * this.maskStep,
      z: this.maskZ0 + ((k / w) | 0) * this.maskStep,
    };
  }

  /** Downhill on a `routeField`, as a bearing. Null when off the field. */
  routeHeading(from: { x: number; z: number }, dist: Int32Array): number | null {
    const w = this.maskW;
    const here = this.cellOf(from);
    if (here < 0 || dist[here]! < 0) return null;
    let best = dist[here]!;
    let bestK = -1;
    // A wider stencil than 4-connectivity so the heading is not quantised to
    // the axes, which would make the pilot run in staircases. Three metres of
    // it, not three cells — see `routeWaypoint`'s `lookaheadM`.
    const r = Math.max(1, Math.round(3 / this.maskStep));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        const k = here + dy * w + dx;
        if (k < 0 || k >= dist.length) continue;
        const d = dist[k]!;
        if (d < 0) continue;
        if (d < best) {
          best = d;
          bestK = k;
        }
      }
    }
    if (bestK < 0) return null;
    const hx = here % w;
    const hy = (here / w) | 0;
    const bx = bestK % w;
    const by = (bestK / w) | 0;
    return Math.atan2(bx - hx, -(by - hy));
  }

  private cellOf(p: { x: number; z: number }): number {
    const i = Math.round((p.x - this.maskX0) / this.maskStep);
    const j = Math.round((p.z - this.maskZ0) / this.maskStep);
    if (i < 0 || j < 0 || i >= this.maskW || j >= this.maskH) return -1;
    const k = j * this.maskW + i;
    return this.mask && this.mask[k] ? k : -1;
  }

  private nearestOpen(
    open: Uint8Array,
    w: number,
    h: number,
    step: number,
    x0: number,
    z0: number,
    from: { x: number; z: number },
  ): number {
    const at = (x: number, z: number): number => {
      const i = Math.round((x - x0) / step);
      const j = Math.round((z - z0) / step);
      if (i < 0 || j < 0 || i >= w || j >= h) return -1;
      const k = j * w + i;
      return open[k] ? k : -1;
    };
    const direct = at(from.x, from.z);
    if (direct >= 0) return direct;
    // The arena anchor can itself sit under a stamped footprint. Spiral out.
    for (let r = step; r <= 120; r += step) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const k = at(from.x + Math.sin(a) * r, from.z - Math.cos(a) * r);
        if (k >= 0) return k;
      }
    }
    return -1;
  }

  private forestScore(x: number, z: number, cls: Runnability): number {
    const h = this.heightAt(x, z);
    let mean = 0;
    let maxDev = 0;
    for (const [dx, dz] of NEIGHBOURS) {
      const v = this.heightAt(x + dx, z + dz);
      mean += v;
      const d = Math.abs(v - h);
      if (d > maxDev) maxDev = d;
    }
    mean /= NEIGHBOURS.length;

    const relief = Math.min(1, Math.abs(h - mean) / 2.2);
    const rough = Math.min(1, maxDev / 4.5);
    const clsBonus = cls === Runnability.Rock ? 0.35 : cls === Runnability.Marsh ? 0.25 : 0;

    return Math.min(1, relief * 0.6 + rough * 0.3 + clsBonus);
  }

  /**
   * A sprint control site: a man-made feature, on the street network.
   *
   * This is the fix for the client's report. A sprint is a route-choice problem
   * through a street network, and the skill is picking between two ways round a
   * block and reading passages, steps and gates at speed. So a control belongs
   * on an **urban feature** — a building corner, the foot of a staircase, a
   * gate, a wall end, a passage mouth, the end of a bridge — and it belongs
   * within a stride or two of ground you can run on.
   *
   * Two of the three terms are therefore hard gates rather than preferences,
   * and that is deliberate. Making them soft is what produced the course the
   * client played: every one of its fifteen points scored respectably on
   * "some out-of-bounds cells are nearby", and the course ran up the river bank
   * and across the meadows south of the town.
   *
   *  - **Feature.** There must be a describable feature within `FEATURE_REACH`.
   *    No feature, no control — that is IOF course-setting principle, not a
   *    tuning knob: column D has to say something.
   *  - **Paved.** The site must be within `PAVED_REACH` of a runnable way or a
   *    paved square. A control 40 m out into a meadow may still be beside a
   *    wall and is still the wrong control.
   *  - **Reachable.** How much of the wider ring is runnable, which is what
   *    stops the generator siting inside a sealed courtyard.
   *
   * Relief is deliberately absent. Krumlov has 130 m of it and none of it is
   * what a sprint control is described by.
   */
  private urbanScore(x: number, z: number, cls: Runnability): number {
    let openNear = 0;
    const RR = 22;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      if (this.runnabilityAt(x + Math.sin(a) * RR, z - Math.cos(a) * RR) !== Runnability.Impassable) {
        openNear++;
      }
    }
    // Sealed in. No leg can end here, whatever else the site has going for it.
    if (openNear < 5) return 0;
    const reachable = openNear / 12;

    const idx = this.features;
    if (!idx) return this.rasterUrbanScore(x, z, cls, reachable);

    const near = idx.nearest(x, z, FEATURE_REACH);
    if (!near) return 0;
    const paved = idx.pavedDistance(x, z, PAVED_REACH + 1);
    if (paved > PAVED_REACH) return 0;

    // Right against the feature is the control; the score falls off with the
    // distance an orienteer would have to search over.
    const feature = 1 - Math.min(1, Math.max(0, near.d - 2) / (FEATURE_REACH - 2));
    // On the network, or one stride off it.
    const street = 1 - Math.min(1, Math.max(0, paved - 3) / (PAVED_REACH - 3));
    // A gate, a passage or a stairway is a better control than a plain corner:
    // there are 12 000 corners in Krumlov and 47 gates.
    const rarity =
      near.f.kind === 'gate' || near.f.kind === 'passage'
        ? 0.18
        : near.f.kind === 'stair' || near.f.kind === 'bridge' || near.f.kind === 'tower'
          ? 0.12
          : 0;

    return clamp01(feature * 0.45 + street * 0.3 + reachable * 0.15 + rarity);
  }

  /**
   * The old proxy, kept for a venue with no townscape to read.
   *
   * Counts out-of-bounds cells in a ring: one to three blocked octants is a
   * corner, six is a dead end. It is a guess at where the corners are, and the
   * whole point of `urbanFeatures.ts` is that we do not have to guess.
   */
  private rasterUrbanScore(
    x: number,
    z: number,
    cls: Runnability,
    reachable: number,
  ): number {
    let blockedRing = 0;
    const R = 7;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.runnabilityAt(x + Math.sin(a) * R, z - Math.cos(a) * R) === Runnability.Impassable) {
        blockedRing++;
      }
    }
    const edge =
      blockedRing === 0 ? 0.15 : blockedRing <= 3 ? 1 : Math.max(0, 1 - (blockedRing - 3) * 0.3);
    const paved = cls === Runnability.Road || cls === Runnability.Path ? 1 : 0.45;
    return Math.min(1, edge * 0.55 + reachable * 0.3 + paved * 0.25);
  }

  /**
   * What the control is actually sited on, for column D.
   *
   * `describeControl` in `src/sim/courseGen.ts` asks this before falling back
   * to landform vocabulary. Returning null in the forest is correct: there is
   * no building corner in Lachovice and a re-entrant is the right word there.
   */
  siteAt(x: number, z: number): ControlSite | null {
    const idx = this.features;
    if (!idx || !this.urban) return null;
    const near = idx.nearest(x, z, FEATURE_REACH);
    if (!near) return null;
    const f = near.f;
    const site: ControlSite = { d: columnDFor(f.kind) };

    // Column G, where the geometry supports it. A stairway has a foot and a
    // top and an orienteer needs to know which; the index carries the other end
    // of the flight precisely so this comparison can be made here, where the
    // terrain is.
    if (f.kind === 'stair' && f.ox !== undefined && f.oz !== undefined) {
      const here = this.heightAt(f.x, f.z);
      const there = this.heightAt(f.ox, f.oz);
      if (Math.abs(here - there) > 1) site.g = here < there ? 'foot' : 'top';
    }
    return site;
  }

  /** Metres to the nearest runnable paved way. `Infinity` with no index. */
  pavedDistanceAt(x: number, z: number): number {
    return this.features ? this.features.pavedDistance(x, z) : Infinity;
  }

  // --- RaceTerrain ---------------------------------------------------------

  /**
   * Full sample for the physics layer.
   *
   * Built here rather than delegated to `TerrainField.sample`, because the
   * slope is a rules quantity and must come off the rules lattice: the athlete's
   * speed reads `slope`, so a tiered gradient means two players on one seed run
   * at different paces. `height` follows the same surface for consistency —
   * nothing in `Race.step` reads it, and everything that puts a body or an eye
   * on the ground goes to `TerrainField` directly, where the drawn surface is.
   */
  sample(x: number, z: number): TerrainSample {
    const g = this.rulesGradient(x, z);
    // Travel direction in world axes: north is -z, east is +x.
    const dx = Math.sin(this.heading);
    const dz = -Math.cos(this.heading);
    const run = this.runnabilityAt(x, z);
    return {
      height: this.rulesHeightAt(x, z),
      slope: g[0] * dx + g[1] * dz,
      runnability: run,
      ground: GROUND_FOR_RUNNABILITY[run],
    };
  }

  /**
   * How hard this ground is to keep map contact with, 0..1.
   *
   * The inverse of describability, essentially: a path junction is trivial, a
   * flat featureless white slope is where contact is lost. Canopy adds to it —
   * you cannot read a hillside you cannot see out of.
   */
  complexityAt(x: number, z: number): number {
    const feature = this.featureScoreAt(x, z);
    const cls = this.runnabilityAt(x, z);
    // Linear features are handrails; being on one is the easiest navigation
    // there is.
    const handrail = cls === Runnability.Road || cls === Runnability.Path ? 0.55 : 0;
    const canopy = Math.min(1, this.field.canopyAt(x, z) / 28) * 0.2;
    return clamp01(0.75 - feature * 0.55 - handrail + canopy);
  }

  /**
   * How many similar features are nearby, 0..1 — the parallel-error driver.
   *
   * Measured as how uniform the surroundings are: a ring of sample points that
   * all score alike as control sites is the classic trap of five identical
   * re-entrants. A ring with one obvious feature and seven blanks is not
   * ambiguous at all, it is a landmark.
   */
  ambiguityAt(x: number, z: number): number {
    const here = this.featureScoreAt(x, z);
    let similar = 0;
    const R = 55;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = this.featureScoreAt(x + Math.sin(a) * R, z - Math.cos(a) * R);
      if (Math.abs(s - here) < 0.14) similar++;
    }
    const cls = this.runnabilityAt(x, z);
    // On a road or a path you always know where you are.
    const handrail = cls === Runnability.Road || cls === Runnability.Path ? 0.5 : 0;
    return clamp01((similar / 8) * 0.85 - handrail);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** `performance.now`, and `Date.now` where there is no `performance` (Node harnesses). */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
