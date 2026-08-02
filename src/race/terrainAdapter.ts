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
 * The one piece of real logic here is `blocked`: Krumlov's uncrossable walls,
 * fences and railings live in mesh-space collision volumes rather than in the
 * runnability raster, and a race that let you run through a wall would be a
 * race with no sprint rules in it. Passing the scene's own `blockedAt` in makes
 * the simulation see exactly the geometry the player sees.
 */

import { Runnability } from '@/core/types';
import type { TerrainSample } from '@/core/types';
import type { TerrainField } from '@/world/terrain';
import type { CourseTerrain } from '@/sim/courseGen';
import type { RaceTerrain } from '@/sim/race';

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
}

export class FieldTerrain implements CourseTerrain, RaceTerrain {
  private readonly field: TerrainField;
  private readonly blocked: Blocker | null;
  private readonly urban: boolean;

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

  constructor(field: TerrainField, opts: FieldTerrainOptions = {}) {
    this.field = field;
    this.blocked = opts.blocked ?? null;
    this.urban = opts.urban ?? false;
  }

  // --- CourseTerrain -------------------------------------------------------

  heightAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  runnabilityAt(x: number, z: number): Runnability {
    if (this.blocked?.(x, z)) return Runnability.Impassable;
    return this.field.runnabilityAt(x, z);
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
    if (!this.blocked) {
      this.baked = this.field.runnability;
      return this.baked;
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
    return out;
  }

  private baked: Uint8Array | null = null;

  /** Is this exact point inside a barrier? Cheap wrapper over the scene test. */
  private isBlocked(x: number, z: number): boolean {
    return this.blocked ? this.blocked(x, z) : false;
  }

  buildReachability(from: { x: number; z: number }): { fraction: number } {
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

  /** Is this point in the arena's connected component? True before the fill. */
  reachableAt(x: number, z: number): boolean {
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
    for (let r = this.maskStep; r <= maxR; r += this.maskStep * 2) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / (this.maskStep * 2)));
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
      const x = k % w;
      const y = (k / w) | 0;
      const push = (n: number): void => {
        if (m[n] === 1 && dist[n] === -1) {
          dist[n] = d;
          queue[tail++] = n;
        }
      };
      // Same edge rule the reachability fill used, so the route the pilot is
      // handed is one the athlete can actually run.
      if (x > 0 && this.eastOk?.[k - 1]) push(k - 1);
      if (x < w - 1 && this.eastOk?.[k]) push(k + 1);
      if (y > 0 && this.southOk?.[k - w]) push(k - w);
      if (y < h - 1 && this.southOk?.[k]) push(k + w);
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
    lookahead = 6,
  ): { x: number; z: number } | null {
    let k = this.cellOf(from);
    if (k < 0 || dist[k]! < 0) return null;
    const w = this.maskW;
    for (let step = 0; step < lookahead; step++) {
      const d = dist[k]!;
      if (d === 0) break;
      let next = -1;
      const x = k % w;
      const y = (k / w) | 0;
      const consider = (n: number, ok: boolean): void => {
        if (!ok) return;
        const nd = dist[n];
        if (nd !== undefined && nd >= 0 && nd < d && (next < 0 || nd < dist[next]!)) next = n;
      };
      consider(k + 1, x < w - 1 && this.eastOk?.[k] === 1);
      consider(k - 1, x > 0 && this.eastOk?.[k - 1] === 1);
      consider(k + w, y < this.maskH - 1 && this.southOk?.[k] === 1);
      consider(k - w, y > 0 && this.southOk?.[k - w] === 1);
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
    // the axes, which would make the pilot run in staircases.
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
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
   * A sprint control site: a corner, and one you can actually run to.
   *
   * Three terms, in weight order:
   *
   *  - **Edge.** How much out-of-bounds is close by. A control against a wall,
   *    or just inside a courtyard entrance, is a real sprint control; one in
   *    the middle of an empty square is not, because there is nothing to
   *    describe and nothing to find.
   *  - **Reachable.** How much of the wider ring is runnable. This is what
   *    stops the generator siting a control inside a sealed courtyard — which
   *    it did: every candidate on the castle rock passed the relief test and
   *    none of them could be entered.
   *  - **Paved.** Standing on the street network, so the leg to it has a route.
   *
   * Relief is deliberately absent. Krumlov has 130 m of it and none of it is
   * what a sprint control is described by.
   */
  private urbanScore(x: number, z: number, cls: Runnability): number {
    let blockedRing = 0;
    const R = 7;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.runnabilityAt(x + Math.sin(a) * R, z - Math.cos(a) * R) === Runnability.Impassable) {
        blockedRing++;
      }
    }
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

    // One to three blocked octants is a corner. Six is a dead end.
    const edge =
      blockedRing === 0
        ? 0.15
        : blockedRing <= 3
          ? 1
          : Math.max(0, 1 - (blockedRing - 3) * 0.3);
    const reachable = openNear / 12;
    const paved = cls === Runnability.Road || cls === Runnability.Path ? 1 : 0.45;

    return Math.min(1, edge * 0.55 + reachable * 0.3 + paved * 0.25);
  }

  // --- RaceTerrain ---------------------------------------------------------

  sample(x: number, z: number): TerrainSample {
    const s = this.field.sample(x, z, this.heading);
    if (this.blocked?.(x, z)) {
      return { ...s, runnability: Runnability.Impassable };
    }
    return s;
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
