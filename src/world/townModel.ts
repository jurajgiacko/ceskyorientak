/**
 * The town, as one vector model.
 *
 * PLAN-KRUMLOV-V2 §2, phase 1. Every wall, footprint, river and bridge that
 * decides where the athlete may stand is *one* object here, and everything
 * downstream — the collider, the geometry that is drawn, and in later phases
 * the map and the street graph — is derived from it. Nothing is stamped onto
 * anything, and there is no second opinion to reconcile.
 *
 * ---------------------------------------------------------------------------
 * The property this file exists to make structural
 * ---------------------------------------------------------------------------
 *
 * > **Anything that blocks and anything drawn as blocking are the same object.**
 *
 * Not asserted afterwards — unrepresentable. A `TownBarrier` carries a drawn
 * height and no solidity flag; `blocks` is `height > crossableMaxH`, computed
 * here, once. `Townscape` draws the slab at that same `height` and to
 * `halfThickness`; the collider band is `halfThickness + skin` off the same
 * kind code. There is no field in the packed file, and no argument to any
 * constructor, that can say "drawn tall, not solid" — which is D-029's 13.8 km
 * of collider-less barrier, and D-033's stamp-closed bridges, deleted as
 * *shapes of bug* rather than as instances.
 *
 * The two remaining ways for the town to draw something that does not block are
 * closed by construction as well:
 *
 *  - a **building** is a footprint and nothing else — ISSprOM 521 applies to
 *    every one of them, so there is no flag to unset. `KRUMLOV_SKIP` takes the
 *    castle tower away from the *generic extruder* because `Landmarks` draws it
 *    properly; until this file existed it took the collider away too, and you
 *    could run through the Zámecká věž.
 *  - anything the scene builds by hand — the Marian column, the fountain's jet
 *    pillar, the cloak bridge's piers — registers its footprint through
 *    `addStructure` *in the function that draws it*, before `seal()`. One call
 *    site, drawn and solid together.
 *
 * ---------------------------------------------------------------------------
 * A bridge is an object, not an exception
 * ---------------------------------------------------------------------------
 *
 * §2 rule 3. v1 carved the crossing out of the water test and then out of the
 * barrier test, in two places, and D-033 is what happens when the two get out
 * of step. Here a carriageway is a first-class surface: `blockedAt` asks which
 * surface you are on *before* it asks what the ground rules are, so the deck
 * lifts the river and the parapet in one line and cannot lift one without the
 * other. Its *height* is still `BridgeDecks`' chord between the abutments
 * (D-031) — that needs the tier's heightfield and stays in `surface.ts`, which
 * is sound and is carried over unchanged.
 */

// ---------------------------------------------------------------------------
// Shipped constants — read from the model, not declared beside it
// ---------------------------------------------------------------------------

/**
 * Fallbacks for a model file that predates a field. They are the numbers
 * `tools/terrain/townmodel.mjs` builds with; the file is authoritative, and a
 * mismatch is surfaced as a warning rather than silently resolved, because two
 * of these decide whether a wall stops you.
 */
export const MODEL_DEFAULTS = {
  crossableMaxH: 0.9,
  thicknessByKind: [0.45, 1.15, 0.6, 0.1, 0.95],
  skinM: 0.25,
  cellM: 12,
  deckHalfMinM: 1.4,
  playableR: 600,
} as const;

// ---------------------------------------------------------------------------
// The objects
// ---------------------------------------------------------------------------

/**
 * A wall, city wall, retaining wall, railing or hedge.
 *
 * `height` is the one number: it is drawn at it and it blocks because of it.
 * ISSprOM 515/518 and IOF Rule 17.2 above `crossableMaxH`, 513.1/516 below —
 * a thing you step over, drawn low enough to say so.
 */
export interface TownBarrier {
  /** Centreline, flat [x0,z0,…], world metres. */
  readonly pts: Float32Array;
  /** 0 wall · 1 city wall · 2 retaining wall · 3 fence/railing · 4 hedge. */
  readonly kind: number;
  /** Drawn height above the ground, metres. */
  readonly height: number;
  /** Half the drawn thickness, metres. */
  readonly halfThickness: number;
  /** `height > crossableMaxH`. Derived here and nowhere else. */
  readonly blocks: boolean;
}

/** A footprint that is out of bounds under ISSprOM 521 — every building is. */
export interface TownFootprint {
  readonly ring: Float32Array;
  /** What draws it: the generic extruder, or a hand-modelled landmark. */
  readonly source: 'building' | 'structure';
}

export interface TownWaterArea {
  readonly ring: Float32Array;
  /** Surveyed surface elevation, metres ASL. */
  readonly level: number;
}

export interface TownWaterCourse {
  readonly pts: Float32Array;
  readonly width: number;
}

/** A bridge carriageway: the surface a crossing is made of. */
export interface TownCarriageway {
  readonly pts: Float32Array;
  readonly width: number;
  /** Half-width the deck is drawn, stood on and exempted over, metres. */
  readonly half: number;
}

// ---------------------------------------------------------------------------
// Broadphase
// ---------------------------------------------------------------------------

/**
 * Uniform grid over primitive bounding boxes.
 *
 * Uniform rather than a quadtree because the old town is uniformly dense — a
 * quadtree over it would be a full tree and would buy nothing but pointer
 * chasing. Phase 0 swept 3–32 m against the real set and put the optimum at
 * 8–12 m, at a mean of 1.8–2.2 candidates per hit cell and a p99 of 9.
 */
class Grid {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly cellM: number) {}

  add(idx: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const c = this.cellM;
    for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
      for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(idx);
      }
    }
  }

  at(x: number, z: number): number[] | undefined {
    const c = this.cellM;
    return this.cells.get(Math.floor(x / c) * 100003 + Math.floor(z / c));
  }

  /** Occupancy, which is what decides the query cost. Reported by the gate. */
  occupancy(): { cells: number; entries: number; mean: number; max: number } {
    let entries = 0;
    let max = 0;
    for (const l of this.cells.values()) {
      entries += l.length;
      if (l.length > max) max = l.length;
    }
    return {
      cells: this.cells.size,
      entries,
      mean: this.cells.size ? entries / this.cells.size : 0,
      max,
    };
  }
}

function ringBounds(p: Float32Array): [number, number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i] as number;
    const z = p[i + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

function inRing(p: Float32Array, x: number, z: number): boolean {
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

/** Rings, indexed. Buildings, hand-modelled structures and water areas. */
class RingIndex {
  private readonly grid: Grid;
  private readonly rings: Float32Array[] = [];
  private readonly bb: number[] = [];

  constructor(cellM: number) {
    this.grid = new Grid(cellM);
  }

  add(ring: Float32Array): void {
    if (ring.length < 6) return;
    const [minX, minZ, maxX, maxZ] = ringBounds(ring);
    this.grid.add(this.rings.length, minX, minZ, maxX, maxZ);
    this.bb.push(minX, minZ, maxX, maxZ);
    this.rings.push(ring);
  }

  test(x: number, z: number): boolean {
    const list = this.grid.at(x, z);
    if (list === undefined) return false;
    for (let k = 0; k < list.length; k++) {
      const i = list[k] as number;
      if (x < (this.bb[i * 4] as number) || x > (this.bb[i * 4 + 2] as number)) continue;
      if (z < (this.bb[i * 4 + 1] as number) || z > (this.bb[i * 4 + 3] as number)) continue;
      if (inRing(this.rings[i] as Float32Array, x, z)) return true;
    }
    return false;
  }

  get size(): number {
    return this.rings.length;
  }

  occupancy(): ReturnType<Grid['occupancy']> {
    return this.grid.occupancy();
  }
}

/** Segments with a half-width, indexed. Barriers, watercourses, carriageways. */
class SegIndex {
  private readonly grid: Grid;
  private readonly seg: number[] = [];
  private readonly half: number[] = [];

  constructor(cellM: number) {
    this.grid = new Grid(cellM);
  }

  add(ax: number, az: number, bx: number, bz: number, half: number): void {
    this.grid.add(
      this.half.length,
      Math.min(ax, bx) - half,
      Math.min(az, bz) - half,
      Math.max(ax, bx) + half,
      Math.max(az, bz) + half,
    );
    this.seg.push(ax, az, bx, bz);
    this.half.push(half);
  }

  test(x: number, z: number): boolean {
    const list = this.grid.at(x, z);
    if (list === undefined) return false;
    for (let k = 0; k < list.length; k++) {
      const i = list[k] as number;
      const ax = this.seg[i * 4] as number;
      const az = this.seg[i * 4 + 1] as number;
      const dx = (this.seg[i * 4 + 2] as number) - ax;
      const dz = (this.seg[i * 4 + 3] as number) - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      const h = this.half[i] as number;
      if (px * px + pz * pz <= h * h) return true;
    }
    return false;
  }

  get size(): number {
    return this.half.length;
  }

  occupancy(): ReturnType<Grid['occupancy']> {
    return this.grid.occupancy();
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface Section {
  type: 'f32' | 'i32';
  offset: number;
  count: number;
}

interface TownModelHeader {
  venue: string;
  crossableMaxH?: number;
  thicknessByKind?: number[];
  skinM?: number;
  cellM?: number;
  deckHalfMinM?: number;
  playableR?: number;
  counts?: Record<string, number>;
  checks?: Record<string, number>;
  sections: Record<string, Section>;
}

/** The packed model, as it comes off the wire. */
export interface TownModelData {
  header: TownModelHeader;
  buffer: ArrayBuffer;
}

export async function loadTownModel(venue: string): Promise<TownModelData> {
  const base = `/data/${venue}/townmodel`;
  const [headerRes, binRes] = await Promise.all([fetch(`${base}.json`), fetch(`${base}.bin`)]);
  if (!headerRes.ok) throw new Error(`${base}.json: HTTP ${headerRes.status}`);
  if (!binRes.ok) throw new Error(`${base}.bin: HTTP ${binRes.status}`);
  const header = (await headerRes.json()) as TownModelHeader;
  const buffer = await binRes.arrayBuffer();
  if (!header.sections?.buildingOffset) {
    throw new Error(`${base}.json: no model — run tools/terrain/townmodel.mjs`);
  }
  return { header, buffer };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export class TownModel {
  readonly venue: string;
  readonly crossableMaxH: number;
  readonly skinM: number;
  readonly cellM: number;
  readonly deckHalfMinM: number;
  readonly playableR: number;
  readonly thicknessByKind: readonly number[];

  readonly barriers: readonly TownBarrier[];
  readonly waterAreas: readonly TownWaterArea[];
  readonly waterCourses: readonly TownWaterCourse[];
  readonly carriageways: readonly TownCarriageway[];
  /** Buildings, plus whatever `addStructure` registered before `seal`. */
  get footprints(): readonly TownFootprint[] {
    return this.footprintList;
  }

  readonly warnings: string[] = [];

  private readonly footprintList: TownFootprint[] = [];
  private readonly rings: RingIndex;
  private readonly barrierSegs: SegIndex;
  private readonly waterRings: RingIndex;
  private readonly waterSegs: SegIndex;
  private readonly deckSegs: SegIndex;
  private sealed = false;

  constructor(data: TownModelData) {
    const h = data.header;
    this.venue = h.venue;
    this.crossableMaxH = h.crossableMaxH ?? MODEL_DEFAULTS.crossableMaxH;
    this.skinM = h.skinM ?? MODEL_DEFAULTS.skinM;
    this.cellM = h.cellM ?? MODEL_DEFAULTS.cellM;
    this.deckHalfMinM = h.deckHalfMinM ?? MODEL_DEFAULTS.deckHalfMinM;
    this.playableR = h.playableR ?? MODEL_DEFAULTS.playableR;
    this.thicknessByKind = h.thicknessByKind ?? MODEL_DEFAULTS.thicknessByKind;

    if (this.crossableMaxH !== MODEL_DEFAULTS.crossableMaxH) {
      this.warnings.push(
        `townmodel.json was built with crossableMaxH ${this.crossableMaxH}, not ` +
          `${MODEL_DEFAULTS.crossableMaxH} — barriers will block at a height this build ` +
          'does not expect',
      );
    }

    const f32 = (name: string): Float32Array => {
      const s = h.sections[name];
      if (!s) return new Float32Array(0);
      return new Float32Array(data.buffer, s.offset, s.count);
    };
    const i32 = (name: string): Int32Array => {
      const s = h.sections[name];
      if (!s) return new Int32Array(0);
      return new Int32Array(data.buffer, s.offset, s.count);
    };
    /** Slice `name` into its runs, without copying the point array. */
    const lines = (name: string): Float32Array[] => {
      const off = i32(`${name}Offset`);
      const pts = f32(`${name}Pts`);
      const out: Float32Array[] = [];
      for (let i = 0; i + 1 < off.length; i++) {
        const a = (off[i] as number) * 2;
        const b = (off[i + 1] as number) * 2;
        if (b > a) out.push(pts.subarray(a, b));
      }
      return out;
    };

    this.rings = new RingIndex(this.cellM);
    this.barrierSegs = new SegIndex(this.cellM);
    this.waterRings = new RingIndex(this.cellM);
    this.waterSegs = new SegIndex(this.cellM);
    this.deckSegs = new SegIndex(this.cellM);

    // --- buildings: ISSprOM 521, no flag to unset -----------------------------
    for (const ring of lines('building')) {
      this.footprintList.push({ ring, source: 'building' });
      this.rings.add(ring);
    }

    // --- barriers: one height, drawn and enforced ----------------------------
    const kinds = i32('barrierKind');
    const heights = f32('barrierHeight');
    const barriers: TownBarrier[] = [];
    lines('barrier').forEach((pts, i) => {
      const kind = kinds[i] ?? 0;
      const height = heights[i] ?? 0;
      const halfThickness =
        (this.thicknessByKind[kind] ?? (MODEL_DEFAULTS.thicknessByKind[0] as number)) * 0.5;
      const blocks = height > this.crossableMaxH;
      barriers.push({ pts, kind, height, halfThickness, blocks });
      if (!blocks) return;
      this.addBarrierColliders(pts, halfThickness + this.skinM);
    });
    this.barriers = barriers;

    // --- water: ISSprOM 301 ---------------------------------------------------
    const levels = f32('waterAreaLevel');
    this.waterAreas = lines('waterArea').map((ring, i) => {
      this.waterRings.add(ring);
      return { ring, level: levels[i] ?? 0 };
    });
    const widths = f32('waterCourseWidth');
    this.waterCourses = lines('waterCourse').map((pts, i) => {
      const width = widths[i] ?? 0;
      for (let k = 0; k + 3 < pts.length; k += 2) {
        this.waterSegs.add(
          pts[k] as number,
          pts[k + 1] as number,
          pts[k + 2] as number,
          pts[k + 3] as number,
          width * 0.5,
        );
      }
      return { pts, width };
    });

    // --- bridge carriageways: surfaces, not exceptions ------------------------
    const deckWidths = f32('deckWidth');
    this.carriageways = lines('deck').map((pts, i) => {
      const width = deckWidths[i] ?? 0;
      const half = Math.max(this.deckHalfMinM, width * 0.5);
      for (let k = 0; k + 3 < pts.length; k += 2) {
        this.deckSegs.add(
          pts[k] as number,
          pts[k + 1] as number,
          pts[k + 2] as number,
          pts[k + 3] as number,
          half,
        );
      }
      return { pts, width, half };
    });
  }

  /**
   * `Townscape.buildWall`'s own segment filter, applied to the collider.
   *
   * The two have to reject the same segments or a barrier is drawn in pieces
   * the collider does not have, or the reverse. 0.15 m is below the resolution
   * anything is mapped at; 120 m is a way whose vertices have been dropped
   * across the AOI edge and which would otherwise index into a hundred cells.
   */
  private addBarrierColliders(pts: Float32Array, half: number): void {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i] as number;
      const az = pts[i + 1] as number;
      const bx = pts[i + 2] as number;
      const bz = pts[i + 3] as number;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.15 || len > 120) continue;
      this.barrierSegs.add(ax, az, bx, bz, half);
    }
  }

  /**
   * Register a footprint the scene draws by hand.
   *
   * For anything modelled outside the generic extruder that stands in the
   * athlete's way: the Marian column's plinth, the fountain's jet pillar, the
   * cloak bridge's piers. **Call it from the function that builds the
   * geometry**, so the drawn thing and the solid thing have one author.
   *
   * Sealed once the scene is built, because a collider that can appear after
   * the venue has been swept is a collider the gate never saw.
   */
  addStructure(ring: readonly number[]): void {
    if (this.sealed) throw new Error('TownModel: addStructure after seal');
    const r = ring instanceof Float32Array ? ring : Float32Array.from(ring);
    this.footprintList.push({ ring: r, source: 'structure' });
    this.rings.add(r);
  }

  seal(): void {
    this.sealed = true;
  }

  /**
   * Is this point out of bounds?
   *
   * IOF Rule 17.2 rather than physics, in the order the town is actually built:
   *
   *  1. **A building** is out of bounds everywhere, ISSprOM 521, with or
   *     without a door, on or off a bridge. Nothing lifts it.
   *  2. **The surface you are on.** A bridge carriageway is a surface, so what
   *     it carries you over does not apply while you are on it. One line, and
   *     it is the whole of the bridge rule — D-033 is what two of them cost.
   *  3. **The ground rules** — an uncrossable barrier (515/518) and drawn water
   *     (301).
   */
  blockedAt(x: number, z: number): boolean {
    if (this.rings.test(x, z)) return true;
    if (this.deckSegs.test(x, z)) return false;
    if (this.barrierSegs.test(x, z)) return true;
    return this.waterRings.test(x, z) || this.waterSegs.test(x, z);
  }

  /** Is (x, z) carried by a bridge? The scene founds the deck's height on it. */
  onCarriageway(x: number, z: number): boolean {
    return this.deckSegs.test(x, z);
  }

  /** Is water drawn over (x, z)? Out of bounds unless a deck carries you. */
  waterCovers(x: number, z: number): boolean {
    return this.waterRings.test(x, z) || this.waterSegs.test(x, z);
  }

  get stats(): Record<string, number> {
    return {
      footprints: this.rings.size,
      structures: this.footprintList.filter((f) => f.source === 'structure').length,
      barriers: this.barriers.length,
      barriersSolid: this.barriers.filter((b) => b.blocks).length,
      barrierSegments: this.barrierSegs.size,
      waterAreas: this.waterRings.size,
      waterCourseSegments: this.waterSegs.size,
      deckSegments: this.deckSegs.size,
      broadphaseMaxPerCell: Math.max(
        this.rings.occupancy().max,
        this.barrierSegs.occupancy().max,
      ),
    };
  }
}
