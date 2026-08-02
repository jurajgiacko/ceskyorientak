/**
 * What a sprint control is allowed to sit on.
 *
 * A forest control sits on a landform, so relief finds it. A town control sits
 * on a **man-made feature** — the corner of a building, the foot of a stairway,
 * the mouth of a gate or passage, the end of a wall, the entrance to a
 * courtyard — and relief says nothing at all about where those are. Scoring
 * Krumlov on relief put the course on the castle rock and the river bank, which
 * is a cross-country run with a castle in the background rather than a sprint.
 * That is the client's report — *"the city should be running in the alleys, not
 * on the grass and by the water"* — and it is a course-setting fault, not a
 * rendering one.
 *
 * So this module derives the feature set directly from the geometry the venue
 * is already built from: `townscape.json`, extracted from OpenStreetMap by
 * `tools/terrain/townscape.mjs` under ODbL. It is the same 1739 footprints,
 * 619 barriers, 147 stairways and 1654 paved ways the scene draws, read as a
 * course setter reads a map rather than as a renderer reads a mesh.
 *
 * **Licensing.** OSM (ODbL) and ČÚZK (CC BY 4.0) only. No geometry here is
 * derived from Google Maps, Google Earth or Mapy.cz imagery — see
 * docs/DECISIONS.md D-016. We do not need them: OSM's footprint corners and
 * barrier ends are the actual ISSprOM feature set, which no orthophoto is.
 *
 * Two questions are answered, and they are different questions:
 *
 *  - `nearest` — *is there a describable feature here?* This is what makes
 *    column D possible and what makes the control findable.
 *  - `pavedDistance` — *can you get to it in a stride or two off a runnable
 *    way?* A control 40 m out into a meadow may still be beside a wall, and it
 *    is still the wrong control: the leg to it stops being a route-choice
 *    problem through a street network and becomes a run across a field.
 */

import type { TownscapeData } from '@/world/buildings';

/**
 * The feature classes we can site on, in ISSprOM/IOF terms.
 *
 * Each maps to exactly one column D symbol in `src/map/pictograms.ts`; see
 * `columnDFor`. Column D takes one symbol and only one — that is a spec rule,
 * and the type in `src/core/types.ts` enforces it.
 */
export type UrbanFeatureKind =
  | 'buildingCorner'
  | 'tower'
  | 'stair'
  | 'wallEnd'
  | 'fenceEnd'
  | 'gate'
  | 'bridge'
  | 'passage';

export interface UrbanFeature {
  x: number;
  z: number;
  kind: UrbanFeatureKind;
  /**
   * The far end of the linear feature this point belongs to, where there is
   * one — the top of the stairway whose foot this is, the other end of the
   * wall. Used to choose column G (`foot` / `top`), which needs a height
   * comparison this module cannot make: it has the geometry, not the terrain.
   */
  ox?: number;
  oz?: number;
}

/** IOF column D symbol for a feature class. Keys of `COLUMN_D`. */
export function columnDFor(kind: UrbanFeatureKind): string {
  switch (kind) {
    case 'buildingCorner':
      return 'building';
    case 'tower':
      return 'tower';
    case 'stair':
      return 'stairway';
    case 'wallEnd':
      return 'wall';
    case 'fenceEnd':
      return 'fence';
    case 'gate':
      return 'wall';
    case 'bridge':
      return 'bridge';
    case 'passage':
      return 'building';
  }
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

const CELL_M = 16;

function key(cx: number, cz: number): number {
  return cx * 100003 + cz;
}

/** Uniform grid over point features. */
class PointGrid {
  private readonly cells = new Map<number, UrbanFeature[]>();

  add(f: UrbanFeature): void {
    const k = key(Math.floor(f.x / CELL_M), Math.floor(f.z / CELL_M));
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(f);
  }

  nearest(x: number, z: number, maxR: number): { f: UrbanFeature; d: number } | null {
    const span = Math.ceil(maxR / CELL_M);
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    let best: { f: UrbanFeature; d: number } | null = null;
    for (let j = cz - span; j <= cz + span; j++) {
      for (let i = cx - span; i <= cx + span; i++) {
        const list = this.cells.get(key(i, j));
        if (!list) continue;
        for (const f of list) {
          const d = Math.hypot(f.x - x, f.z - z);
          if (d <= maxR && (!best || d < best.d)) best = { f, d };
        }
      }
    }
    return best;
  }

  get size(): number {
    let n = 0;
    for (const list of this.cells.values()) n += list.length;
    return n;
  }
}

/** Uniform grid over line segments, carrying a half-width. */
class SegGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly seg: number[] = [];
  private readonly half: number[] = [];

  add(ax: number, az: number, bx: number, bz: number, halfWidth: number): void {
    const i = this.half.length;
    this.seg.push(ax, az, bx, bz);
    this.half.push(halfWidth);
    const minX = Math.min(ax, bx) - halfWidth;
    const maxX = Math.max(ax, bx) + halfWidth;
    const minZ = Math.min(az, bz) - halfWidth;
    const maxZ = Math.max(az, bz) + halfWidth;
    for (let cz = Math.floor(minZ / CELL_M); cz <= Math.floor(maxZ / CELL_M); cz++) {
      for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
        const k = key(cx, cz);
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(i);
      }
    }
  }

  /** Distance to the nearest segment *edge*, 0 when inside one. */
  distance(x: number, z: number, maxR: number): number {
    const span = Math.ceil(maxR / CELL_M);
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    let best = Infinity;
    for (let j = cz - span; j <= cz + span; j++) {
      for (let i = cx - span; i <= cx + span; i++) {
        const list = this.cells.get(key(i, j));
        if (!list) continue;
        for (const s of list) {
          const ax = this.seg[s * 4] as number;
          const az = this.seg[s * 4 + 1] as number;
          const bx = this.seg[s * 4 + 2] as number;
          const bz = this.seg[s * 4 + 3] as number;
          const dx = bx - ax;
          const dz = bz - az;
          const len2 = dx * dx + dz * dz;
          let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - x;
          const pz = az + dz * t - z;
          const d = Math.hypot(px, pz) - (this.half[s] as number);
          if (d < best) best = d < 0 ? 0 : d;
          if (best === 0) return 0;
        }
      }
    }
    return best;
  }

  get size(): number {
    return this.half.length;
  }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface UrbanFeatureStats {
  features: number;
  pavedSegments: number;
  byKind: Record<string, number>;
}

export class UrbanFeatureIndex {
  private readonly points = new PointGrid();
  private readonly paved = new SegGrid();
  readonly stats: UrbanFeatureStats;

  constructor(features: readonly UrbanFeature[], paved: readonly number[][]) {
    const byKind: Record<string, number> = {};
    for (const f of features) {
      this.points.add(f);
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    }
    for (const s of paved) {
      this.paved.add(s[0] as number, s[1] as number, s[2] as number, s[3] as number, s[4] as number);
    }
    this.stats = { features: this.points.size, pavedSegments: this.paved.size, byKind };
  }

  /** The nearest describable urban feature, or null beyond `maxR`. */
  nearest(x: number, z: number, maxR = 14): { f: UrbanFeature; d: number } | null {
    return this.points.nearest(x, z, maxR);
  }

  /**
   * Metres from the edge of the nearest runnable paved way, 0 when standing on
   * one. Saturates at `maxR` so a point in the middle of a field is simply
   * "far" rather than expensive to measure.
   */
  pavedDistance(x: number, z: number, maxR = 40): number {
    const d = this.paved.distance(x, z, maxR);
    return Number.isFinite(d) ? Math.min(d, maxR) : maxR;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * How sharp a footprint vertex has to turn to be a corner worth standing at.
 *
 * OSM footprints carry a lot of near-collinear vertices — a traced facade with
 * a 5° kink in it is one wall, not two, and an orienteer told "building corner"
 * would never find it. 50° is a genuine corner: the classic Krumlov control on
 * the outside angle of a burgher house.
 */
const CORNER_TURN_RAD = (50 * Math.PI) / 180;

/**
 * How far outside the footprint the flag stands, metres.
 *
 * A control is hung *on* the corner, so the site has to be outside the wall or
 * it is inside a building and unreachable. 1.8 m clears the collider (the
 * footprint itself) and the one-cell rind the raster carries around it.
 */
const CORNER_OFFSET_M = 1.8;

/** Two barrier ends this close to each other are the two sides of a gap. */
const GATE_GAP_M = 7;

/** Dedupe grid, metres. Two features closer than this are the same feature. */
const DEDUPE_M = 4;

function pointInRing(p: readonly number[], x: number, z: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2] as number;
    const zi = p[i * 2 + 1] as number;
    const xj = p[j * 2] as number;
    const zj = p[j * 2 + 1] as number;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Derive the sprint feature set from the townscape.
 *
 * Deliberately generous about *what* counts and strict about *where* the point
 * goes. A course setter walking Krumlov would list far more features than this
 * — window ledges, drainpipes, the statue on the bridge — but every one of
 * those is a point the geometry does not carry, and inventing them would put
 * controls on features the player cannot see. Everything below is a thing that
 * is actually modelled, drawn and collided with.
 */
export function buildUrbanFeatures(town: TownscapeData): UrbanFeatureIndex {
  const out: UrbanFeature[] = [];
  const seen = new Set<number>();

  /** One feature per `DEDUPE_M` cell: a 12-sided courtyard is not 12 controls. */
  const push = (f: UrbanFeature): void => {
    const k = key(Math.round(f.x / DEDUPE_M), Math.round(f.z / DEDUPE_M));
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };

  // --- building corners ----------------------------------------------------
  //
  // The bread and butter of sprint course setting. Placed outside the wall
  // along the outward bisector — and *tested* rather than assumed outward,
  // because a footprint ring's winding is not something to take on trust and
  // a re-entrant corner's bisector points the other way.
  for (const b of town.buildings) {
    const p = b.p;
    const n = p.length / 2;
    if (n < 4) continue;
    const kind: UrbanFeatureKind = b.k === 3 ? 'tower' : 'buildingCorner';
    for (let i = 0; i < n; i++) {
      const px = p[((i - 1 + n) % n) * 2] as number;
      const pz = p[((i - 1 + n) % n) * 2 + 1] as number;
      const cx = p[i * 2] as number;
      const cz = p[i * 2 + 1] as number;
      const nx = p[((i + 1) % n) * 2] as number;
      const nz = p[((i + 1) % n) * 2 + 1] as number;

      const inLen = Math.hypot(cx - px, cz - pz);
      const outLen = Math.hypot(nx - cx, nz - cz);
      if (inLen < 1.2 || outLen < 1.2) continue;
      const inX = (cx - px) / inLen;
      const inZ = (cz - pz) / inLen;
      const outX = (nx - cx) / outLen;
      const outZ = (nz - cz) / outLen;
      const turn = Math.abs(Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ));
      if (turn < CORNER_TURN_RAD) continue;

      // Bisector of the two wall directions, pointing away from the corner.
      let bx = inX - outX;
      let bz = inZ - outZ;
      const bl = Math.hypot(bx, bz);
      if (bl < 1e-6) continue;
      bx /= bl;
      bz /= bl;
      const a = { x: cx + bx * CORNER_OFFSET_M, z: cz + bz * CORNER_OFFSET_M };
      const c = { x: cx - bx * CORNER_OFFSET_M, z: cz - bz * CORNER_OFFSET_M };
      const outside = !pointInRing(p, a.x, a.z) ? a : !pointInRing(p, c.x, c.z) ? c : null;
      if (!outside) continue;
      push({ x: outside.x, z: outside.z, kind });
    }
  }

  // --- stairways -----------------------------------------------------------
  //
  // ISSprOM 532 and a gift to a course setter: a stairway is unmistakable, it
  // is a handrail, and its two ends are different controls. `ox/oz` carries the
  // other end so the terrain layer can decide `foot` from `top`.
  for (const s of town.steps) {
    const p = s.p;
    const n = p.length / 2;
    if (n < 2) continue;
    const ax = p[0] as number;
    const az = p[1] as number;
    const bx = p[(n - 1) * 2] as number;
    const bz = p[(n - 1) * 2 + 1] as number;
    push({ x: ax, z: az, kind: 'stair', ox: bx, oz: bz });
    push({ x: bx, z: bz, kind: 'stair', ox: ax, oz: az });
  }

  // --- wall and fence ends, and the gaps between them ----------------------
  //
  // The end of an uncrossable wall is where the route choice is decided, which
  // is exactly why it is a control site. Two ends facing each other across a
  // few metres are a *gate* — the mouth of the gap — and that is the best
  // control in a sprint: you either saw it on the map or you ran round the
  // block.
  const ends: { x: number; z: number; wall: number }[] = [];
  town.walls.forEach((w, wi) => {
    const p = w.p;
    const n = p.length / 2;
    if (n < 2) return;
    const kind: UrbanFeatureKind = w.k === 3 ? 'fenceEnd' : 'wallEnd';
    const ax = p[0] as number;
    const az = p[1] as number;
    const bx = p[(n - 1) * 2] as number;
    const bz = p[(n - 1) * 2 + 1] as number;
    // A closed ring (a walled garden) has no end; its corners are not gates
    // and standing at one is standing against a wall in the middle of nowhere.
    if (Math.hypot(bx - ax, bz - az) < 2) return;
    push({ x: ax, z: az, kind, ox: bx, oz: bz });
    push({ x: bx, z: bz, kind, ox: ax, oz: az });
    if (w.u) {
      ends.push({ x: ax, z: az, wall: wi });
      ends.push({ x: bx, z: bz, wall: wi });
    }
  });

  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i] as { x: number; z: number; wall: number };
      const b = ends[j] as { x: number; z: number; wall: number };
      if (a.wall === b.wall) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 1 || d > GATE_GAP_M) continue;
      push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, kind: 'gate' });
    }
  }

  // --- bridges -------------------------------------------------------------
  //
  // ISSprOM 512.1. Krumlov has 25 of them and they are the choke points of the
  // whole venue, so both ends of the deck are worth a control.
  for (const br of town.bridges) {
    const p = br.p;
    const n = p.length / 2;
    if (n < 3) continue;
    // The two vertices furthest apart approximate the deck's long axis.
    let best = -1;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d =
          ((p[i * 2] as number) - (p[j * 2] as number)) ** 2 +
          ((p[i * 2 + 1] as number) - (p[j * 2 + 1] as number)) ** 2;
        if (d > best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const ax = p[bi * 2] as number;
    const az = p[bi * 2 + 1] as number;
    const bx = p[bj * 2] as number;
    const bz = p[bj * 2 + 1] as number;
    push({ x: ax, z: az, kind: 'bridge', ox: bx, oz: bz });
    push({ x: bx, z: bz, kind: 'bridge', ox: ax, oz: az });
  }

  // --- passages ------------------------------------------------------------
  //
  // A paved way that ends without meeting another paved way, inside the built
  // fabric, is the mouth of an arched passage or a courtyard entrance — OSM
  // maps a good many of Krumlov's as `tunnel=building_passage`, and where the
  // footprint stamp closes them the *mouth* is still a real place to stand.
  const pavedSegs: number[][] = [];
  const endpoints: { x: number; z: number }[] = [];
  for (const way of town.paved) {
    const l = way.l;
    const n = l.length / 2;
    if (n < 2) continue;
    const half = Math.max(0.6, way.w / 2);
    for (let i = 0; i < n - 1; i++) {
      pavedSegs.push([
        l[i * 2] as number,
        l[i * 2 + 1] as number,
        l[i * 2 + 2] as number,
        l[i * 2 + 3] as number,
        half,
      ]);
    }
    endpoints.push({ x: l[0] as number, z: l[1] as number });
    endpoints.push({ x: l[(n - 1) * 2] as number, z: l[(n - 1) * 2 + 1] as number });
  }

  // Squares and paved courtyards count as network too: Náměstí Svornosti is
  // where a Krumlov sprint breathes, and a control on a corner of it must not
  // be scored as "out in a field" merely because no centreline runs across it.
  for (const a of town.areas) {
    if (a.k !== 0) continue;
    const p = a.p;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pavedSegs.push([
        p[i * 2] as number,
        p[i * 2 + 1] as number,
        p[j * 2] as number,
        p[j * 2 + 1] as number,
        1.5,
      ]);
    }
  }

  const endCount = new Map<number, number>();
  for (const e of endpoints) {
    const k = key(Math.round(e.x / 3), Math.round(e.z / 3));
    endCount.set(k, (endCount.get(k) ?? 0) + 1);
  }

  // Which footprints have a vertex near a point, indexed rather than scanned:
  // 3 300 endpoints against 1 739 rings is 57 million distance tests done the
  // obvious way, and this runs while the player is looking at a loading bar.
  const wallVerts = new Map<number, Set<number>>();
  town.buildings.forEach((b, bi) => {
    for (let i = 0; i < b.p.length; i += 2) {
      const k = key(Math.floor((b.p[i] as number) / CELL_M), Math.floor((b.p[i + 1] as number) / CELL_M));
      let set = wallVerts.get(k);
      if (!set) {
        set = new Set();
        wallVerts.set(k, set);
      }
      set.add(bi);
    }
  });

  for (const e of endpoints) {
    if ((endCount.get(key(Math.round(e.x / 3), Math.round(e.z / 3))) ?? 0) !== 1) continue;
    // Only where it is genuinely enclosed — a lane ending at the edge of the
    // AOI is a clipped way, not a passage.
    const cx = Math.floor(e.x / CELL_M);
    const cz = Math.floor(e.z / CELL_M);
    const candidates = new Set<number>();
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        const set = wallVerts.get(key(i, j));
        if (set) for (const bi of set) candidates.add(bi);
      }
    }
    let near = 0;
    for (const bi of candidates) {
      const p = (town.buildings[bi] as { p: number[] }).p;
      for (let i = 0; i < p.length; i += 2) {
        if (Math.hypot((p[i] as number) - e.x, (p[i + 1] as number) - e.z) < 12) {
          near++;
          break;
        }
      }
      if (near >= 2) break;
    }
    if (near >= 2) push({ x: e.x, z: e.z, kind: 'passage' });
  }

  return new UrbanFeatureIndex(out, pavedSegs);
}
