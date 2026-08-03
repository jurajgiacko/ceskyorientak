/**
 * The town's *walking* surface, as distinct from its terrain.
 *
 * `TerrainField.heightAt` answers a question about the ground: it is a
 * resampled ČÚZK DMR 5G, a bare-earth model, and under a bridge the bare earth
 * is the riverbed. Everything in the scene that stands on something has, until
 * now, been founded on it — including the athlete's eye, at
 * `field.heightAt + EYE_HEIGHT`.
 *
 * That is why the client started in the river.
 *
 * `tools/terrain/townscape.mjs` stamps bridge decks into the runnability raster
 * as passable, because the previous fix in this venue was that every Vltava
 * crossing was severed. It was the right fix for passability and it left the
 * *height* wrong: a point on a bridge deck is legal, open, paved, reachable by
 * every check we have, and renders 5 m under water. Measured along the 47
 * bridge-tagged ways in Krumlov, the bare earth sags as much as **5.2 m** below
 * the abutments over the main Vltava crossings.
 *
 * So this module carries the two facts the terrain does not know:
 *
 *  - `BridgeDecks` — where a deck stands above the ground, and how high. The
 *    height comes from the bridge way's own endpoints, which sit on the banks,
 *    exactly as the brief for this fix described.
 *  - `WaterIndex` — where water is *drawn*, and at what level. `blockedAt`
 *    already claims to enforce ISSprOM 301 (uncrossable water); it only ever
 *    did so through the runnability raster, which comes from ZABAGED while the
 *    river is drawn from OSM. The two national datasets do not trace the same
 *    outline, and about 5 300 m² of the venue was drawn as river and left
 *    runnable — enough for the course setter to put a control in the Vltava
 *    94 m from the nearest bridge, which it did.
 *
 * One line runs through both and is easy to get wrong, so it is stated here as
 * well as at `BridgeDecks.carriageways`: **everything this module contributes to
 * what is out of bounds is a pure function of `townscape.json`** — no heights,
 * no tier. Only the deck's *height* and the geometry drawn at it read the
 * heightfield, whose resolution is a per-tier rendering budget. A tier decides
 * how the venue is drawn, never what happens in the race; see D-027 and D-029,
 * `TerrainField.load` and `FieldTerrain.rulesHeightAt`.
 */

import type { PavedRecord, TownscapeData, WaterRecord } from './buildings';

/**
 * Anything that can say how high the ground is.
 *
 * `TerrainField` satisfies it, and so does `SprintScene`'s deck-aware wrapper —
 * which is the point: the pieces that stand on the ground (control flags, the
 * finish gantry, the beginner's bearing band) take this rather than a
 * `TerrainField`, so a venue with things built above the terrain can hand them
 * a surface that knows about them.
 */
export interface GroundSurface {
  heightAt(x: number, z: number): number;
}

/**
 * Least lift, metres, before a bridge way is treated as a deck at all.
 *
 * Below this the way is a bridge in OSM's sense — it has a `bridge` tag — but
 * it lies on the ground as far as the DMR is concerned: a culvert, a slab over
 * a gutter, a mill-race crossing a metre wide. Raising it would be inventing
 * relief the survey does not show, and 26 of Krumlov's 47 bridge ways are in
 * this class.
 */
const MIN_DECK_LIFT_M = 0.5;

/**
 * Most lift, metres, before a bridge way stops being treated as a deck.
 *
 * Above this it is not a street bridge but a viaduct, and in this venue it is
 * exactly one thing: the Plášťový most, thrown 20 m across the ravine below the
 * castle. `src/world/landmarks.ts` builds that as a modelled landmark with its
 * own deck, piers and arcade tiers, and a generic ramp invented under it would
 * fight the model rather than help it. 10 m is comfortably above the tallest
 * real crossing here (7.9 m, the Latrán ramp) and comfortably below the cloak
 * bridge's 19.6 m.
 */
const MAX_DECK_LIFT_M = 10;

/** How finely the deck's lift is sampled and drawn, metres. */
const DECK_STEP_M = 2;

/**
 * Half-width floor, metres.
 *
 * The same figure `stampRaster` uses when it paints the deck into the
 * runnability raster — `max(1.4, w / 2)` — so the ground you can stand on and
 * the ground that is drawn under you are the same band to the centimetre. They
 * have to be: a deck one cell wider than the raster says would let the athlete
 * walk off the surface, and one cell narrower would leave a passable strip at
 * riverbed height along both parapets.
 */
const DECK_HALF_MIN_M = 1.4;

/** One accepted crossing: its centreline, its arc lengths, and its abutments. */
export interface DeckSpan {
  /** Flat [x0,z0,…], world metres — the OSM way's own centreline. */
  readonly line: readonly number[];
  /** Cumulative arc length at each vertex, metres. */
  readonly at: readonly number[];
  /** Total length, metres. */
  readonly length: number;
  /** Half the deck width, metres. */
  readonly half: number;
  /** Terrain height at the first and last vertex — the abutments, metres ASL. */
  readonly y0: number;
  readonly y1: number;
  /** The greatest height the deck stands above the bare earth, metres. */
  readonly lift: number;
}

/** Nearest point on a segment, as (distance, parameter). */
function projectOnSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  x: number,
  z: number,
): { d: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(ax + dx * t - x, az + dz * t - z), t };
}

/**
 * A uniform grid index over axis-aligned boxes.
 *
 * The same shape as the one in `tools/ci/check-passable.mjs`, deliberately: the
 * gate reproduces this file offline, and two spatial indexes that disagree
 * about which candidates a query sees are two different answers.
 */
class Grid<T> {
  private readonly cellM: number;
  private readonly cells = new Map<number, T[]>();

  constructor(cellM: number) {
    this.cellM = cellM;
  }

  add(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const c = this.cellM;
    for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
      for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(item);
      }
    }
  }

  at(x: number, z: number): readonly T[] {
    const c = this.cellM;
    return this.cells.get(Math.floor(x / c) * 100003 + Math.floor(z / c)) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Bridge decks
// ---------------------------------------------------------------------------

/**
 * Where the town stands above its own ground.
 *
 * The deck is the **chord** between the way's two endpoints: those sit on the
 * banks, on ground the DMR surveyed properly, and a street bridge is a straight
 * run between its abutments. Where that chord is below the bare earth — a way
 * tagged `bridge` that actually climbs a hillside, of which Krumlov has
 * several — the ground wins, so the surface is never lower than the terrain and
 * the two agree exactly at both ends. Nothing here can make the athlete sink.
 */
export class BridgeDecks {
  /**
   * The crossings that stand meaningfully above the ground, and so are raised
   * and drawn. A subset of `carriageways`, and — because the lift is measured
   * against a heightfield whose resolution is a per-tier rendering budget —
   * **not necessarily the same subset on every tier**. That is fine and is why
   * this is separated from the index below: which spans are raised decides only
   * what is *drawn* and how high the eye sits, never what is out of bounds.
   */
  readonly spans: DeckSpan[] = [];
  private readonly raised = new Grid<DeckSpan>(16);
  /**
   * Every bridge-tagged way, raised or not, indexed by its stamped footprint.
   *
   * This is what `covers` answers from, and it is a pure function of
   * `townscape.json`: no heights, no tier. It has to be, because `covers` is
   * what exempts a deck from the uncrossable-water rule *and* — since D-033 —
   * from the uncrossable-barrier rule, and a rule that changed with the
   * graphics settings would hand two players on one seed two different
   * courses. Same invariant as `FieldTerrain.rulesHeightAt`.
   *
   * The band is `max(1.4, w/2)`, which is `stampRaster`'s band to the
   * centimetre. Two exemptions of different widths would be two different
   * answers to "am I on the bridge", one in the raster and one in the collider.
   */
  private readonly carriageways = new Grid<DeckSpan>(16);

  /**
   * `heights` is the bare-earth surface, and only the raised set depends on it.
   */
  constructor(paved: readonly PavedRecord[], heights: (x: number, z: number) => number) {
    for (const way of paved) {
      if (!way.b) continue;
      const flat = this.outline(way);
      if (!flat) continue;
      this.index(this.carriageways, flat);
      const span = this.measure(flat, heights);
      if (!span) continue;
      this.spans.push(span);
      this.index(this.raised, span);
    }
  }

  /** The way's footprint, with no heights read. */
  private outline(way: PavedRecord): DeckSpan | null {
    const line = way.l;
    const n = line.length / 2;
    if (n < 2) return null;
    const at: number[] = [0];
    for (let i = 1; i < n; i++) {
      const dx = (line[i * 2] as number) - (line[i * 2 - 2] as number);
      const dz = (line[i * 2 + 1] as number) - (line[i * 2 - 1] as number);
      at.push((at[i - 1] as number) + Math.hypot(dx, dz));
    }
    const length = at[n - 1] as number;
    return {
      line,
      at,
      length,
      half: Math.max(DECK_HALF_MIN_M, way.w * 0.5),
      y0: 0,
      y1: 0,
      lift: 0,
    };
  }

  private measure(
    flat: DeckSpan,
    heights: (x: number, z: number) => number,
  ): DeckSpan | null {
    const { line, at, length } = flat;
    const n = line.length / 2;
    // Nothing to raise, and `heightAt` would divide by it. The carriageway
    // index above is deliberately not filtered this way: `stampRaster` walks
    // every bridge-tagged way whatever its length, and `covers` has to answer
    // over exactly the band the raster was stamped with. See D-033.
    if (length < 1) return null;

    const y0 = heights(line[0] as number, line[1] as number);
    const y1 = heights(line[(n - 1) * 2] as number, line[(n - 1) * 2 + 1] as number);

    // How far the chord stands above the bare earth, at its worst.
    let lift = 0;
    const steps = Math.max(2, Math.ceil(length / DECK_STEP_M));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const p = pointAt(line, at, length * t);
      const gap = y0 + (y1 - y0) * t - heights(p.x, p.z);
      if (gap > lift) lift = gap;
    }
    if (lift < MIN_DECK_LIFT_M || lift > MAX_DECK_LIFT_M) return null;

    return { line, at, length, half: flat.half, y0, y1, lift };
  }

  private index(grid: Grid<DeckSpan>, span: DeckSpan): void {
    const n = span.line.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const ax = span.line[i * 2] as number;
      const az = span.line[i * 2 + 1] as number;
      const bx = span.line[i * 2 + 2] as number;
      const bz = span.line[i * 2 + 3] as number;
      grid.add(
        span,
        Math.min(ax, bx) - span.half,
        Math.min(az, bz) - span.half,
        Math.max(ax, bx) + span.half,
        Math.max(az, bz) + span.half,
      );
    }
  }

  /** Deck height at (x, z), metres ASL, or `null` where nothing is raised. */
  heightAt(x: number, z: number): number | null {
    let best: number | null = null;
    for (const span of this.raised.at(x, z)) {
      const s = arcAt(span, x, z);
      if (s === null) continue;
      const y = span.y0 + (span.y1 - span.y0) * (s / span.length);
      if (best === null || y > best) best = y;
    }
    return best;
  }

  /**
   * Is (x, z) carried by a bridge?
   *
   * Every bridge-tagged way counts, whether or not it stands high enough to be
   * drawn as a deck: a culvert under the road is still a crossing, and the
   * question this answers is "is the athlete legitimately crossing here", which
   * the survey's opinion of the clearance has no bearing on.
   *
   * Two rules read this, and they are the two rules that can otherwise close a
   * crossing: uncrossable water (ISSprOM 301) and an uncrossable barrier
   * (515/518). Both are lifted over the carriageway and nowhere else.
   */
  covers(x: number, z: number): boolean {
    for (const span of this.carriageways.at(x, z)) {
      if (arcAt(span, x, z) !== null) return true;
    }
    return false;
  }
}

/** Arc length of the nearest point on `span` to (x, z), or null if off the deck. */
function arcAt(span: DeckSpan, x: number, z: number): number | null {
  const n = span.line.length / 2;
  let bestD = span.half;
  let bestS: number | null = null;
  for (let i = 0; i < n - 1; i++) {
    const ax = span.line[i * 2] as number;
    const az = span.line[i * 2 + 1] as number;
    const bx = span.line[i * 2 + 2] as number;
    const bz = span.line[i * 2 + 3] as number;
    const { d, t } = projectOnSegment(ax, az, bx, bz, x, z);
    if (d > bestD) continue;
    bestD = d;
    bestS = (span.at[i] as number) + ((span.at[i + 1] as number) - (span.at[i] as number)) * t;
  }
  return bestS;
}

/** Walk `s` metres along a polyline. */
export function pointAt(
  line: readonly number[],
  at: readonly number[],
  s: number,
): { x: number; z: number; tx: number; tz: number } {
  const n = line.length / 2;
  let i = 1;
  while (i < n - 1 && (at[i] as number) < s) i++;
  const l0 = at[i - 1] as number;
  const l1 = at[i] as number;
  const t = l1 > l0 ? (s - l0) / (l1 - l0) : 0;
  const ax = line[i * 2 - 2] as number;
  const az = line[i * 2 - 1] as number;
  const bx = line[i * 2] as number;
  const bz = line[i * 2 + 1] as number;
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return { x: ax + dx * t, z: az + dz * t, tx: dx / len, tz: dz / len };
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

interface WaterArea {
  readonly ring: readonly number[];
  readonly y: number;
}

interface WaterCourse {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly half: number;
}

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
 * Where water is drawn.
 *
 * Both shapes `Townscape` renders, and only those, so "over water" here means
 * exactly "water is drawn under your feet" and nothing looser:
 *
 *  - **areas** — `natural=water`, `waterway=riverbank`, reservoirs. A ring and
 *    a surveyed level, drawn flat at `y`.
 *  - **watercourses** — river and canal centrelines, widened to the tagged
 *    width or a default, drawn as a ribbon that follows the terrain. These are
 *    what carry the mill race and the weirs, which no polygon covers.
 */
export class WaterIndex {
  private readonly areas = new Grid<WaterArea>(24);
  private readonly courses = new Grid<WaterCourse>(24);

  constructor(water: readonly WaterRecord[]) {
    for (const w of water) {
      if (w.p && w.p.length >= 6 && w.y !== undefined) {
        const ring = w.p;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i] as number;
          const z = ring[i + 1] as number;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        this.areas.add({ ring, y: w.y }, minX, minZ, maxX, maxZ);
      } else if (w.l && w.w) {
        const half = w.w * 0.5;
        for (let i = 0; i + 3 < w.l.length; i += 2) {
          const ax = w.l[i] as number;
          const az = w.l[i + 1] as number;
          const bx = w.l[i + 2] as number;
          const bz = w.l[i + 3] as number;
          this.courses.add(
            { ax, az, bx, bz, half },
            Math.min(ax, bx) - half,
            Math.min(az, bz) - half,
            Math.max(ax, bx) + half,
            Math.max(az, bz) + half,
          );
        }
      }
    }
  }

  /** Is water drawn over (x, z)? */
  covers(x: number, z: number): boolean {
    for (const a of this.areas.at(x, z)) {
      if (pointInRing(a.ring, x, z)) return true;
    }
    for (const c of this.courses.at(x, z)) {
      if (projectOnSegment(c.ax, c.az, c.bx, c.bz, x, z).d <= c.half) return true;
    }
    return false;
  }

  /**
   * The height of the water surface at (x, z), metres ASL, or `null` where
   * none is drawn.
   *
   * An area is drawn flat at its surveyed level. A watercourse ribbon follows
   * the terrain at `+0.10 m` — see `Townscape.buildWaterRibbon` — so it needs
   * the ground to answer, and the caller passes it. Where both cover the point
   * the higher wins, which is the one you would be standing in.
   */
  levelAt(x: number, z: number, groundY: number): number | null {
    let best: number | null = null;
    for (const a of this.areas.at(x, z)) {
      if (!pointInRing(a.ring, x, z)) continue;
      if (best === null || a.y > best) best = a.y;
    }
    for (const c of this.courses.at(x, z)) {
      if (projectOnSegment(c.ax, c.az, c.bx, c.bz, x, z).d > c.half) continue;
      const y = groundY + RIBBON_RISE_M;
      if (best === null || y > best) best = y;
    }
    return best;
  }
}

/** `Townscape.buildWaterRibbon` lifts the ribbon this far off the terrain. */
export const RIBBON_RISE_M = 0.1;

/**
 * The two facts about a venue that the terrain does not carry, together.
 *
 * Held as one object because the answer to "may the athlete stand here, and how
 * high are they" needs both: water is out of bounds **unless a deck carries you
 * over it**, which is the whole of the bridge rule in one sentence.
 */
export class TownSurface {
  readonly decks: BridgeDecks;
  readonly water: WaterIndex;

  constructor(data: TownscapeData, heights: (x: number, z: number) => number) {
    this.decks = new BridgeDecks(data.paved ?? [], heights);
    this.water = new WaterIndex(data.water ?? []);
  }

  /** Ground the athlete stands on at (x, z): the deck if there is one, else the terrain. */
  groundAt(x: number, z: number, terrainY: number): number {
    const deck = this.decks.heightAt(x, z);
    return deck === null || deck < terrainY ? terrainY : deck;
  }

  /**
   * Out of bounds under ISSprOM 301 — uncrossable water.
   *
   * A bridge deck is the exception and the only one, exactly as it is the only
   * exception `stampRaster` grants when it paints the network into the raster.
   */
  inWater(x: number, z: number): boolean {
    if (!this.water.covers(x, z)) return false;
    return !this.decks.covers(x, z);
  }
}
