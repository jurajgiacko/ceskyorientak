#!/usr/bin/env node
/**
 * The town model — one authoritative vector description of Krumlov.
 *
 * PLAN-KRUMLOV-V2 §2: *"One authoritative vector model of the town. Collision,
 * map and course generation are all derived from it. Nothing is stamped onto
 * anything."* This is the offline half of that, and phase 1's deliverable: it
 * reads the OSM assembly in `townscape.json` and writes the packed model that
 * `src/world/townModel.ts` constructs colliders from at load.
 *
 * ---------------------------------------------------------------------------
 * Why the model is built here and not at load
 * ---------------------------------------------------------------------------
 *
 * Phase 0 measured the vector collision at 520 ns a query on a 4×-throttled
 * mid-range-Android proxy — 1.07 % of a frame at the runtime's real 105 calls —
 * and found the one thing that is *not* cheap: a venue-wide sweep. Baking a 1 m
 * raster of the model costs 2.6 s at 4×, the reachability fill another 2.9 s.
 * So §2's "built offline, once" is taken literally: every venue-wide pass over
 * the model happens in this file, and what the runtime does at load is
 * construct indexes over what this file shipped — 14 ms at 4×.
 *
 * ---------------------------------------------------------------------------
 * What makes drawn ≡ solid unrepresentable rather than merely tested
 * ---------------------------------------------------------------------------
 *
 * D-029 shipped 13.8 km of barrier drawn as a solid slab with no collider,
 * because the extractor invented a drawing height for a fence and derived
 * crossability from a *different* number. The fix then was to make the two
 * numbers equal. The fix now is that there is only one number:
 *
 *   **The packed file carries a barrier's height and nothing about solidity.**
 *
 * There is no `u` field, no `solid` flag, no collider list. `TownModel` derives
 * `blocks = height > crossableMaxH` at construction, the renderer draws the
 * barrier at `height`, and the collider band is `thickness / 2 + skin` off the
 * same kind code the geometry is built from. A file that says "drawn tall,
 * not solid" cannot be written, because there is no field to write it in.
 *
 * The same applies to a building (every footprint is ISSprOM 521, no flag), to
 * water (drawn is out of bounds, ISSprOM 301) and to a bridge carriageway (a
 * deck is a surface, and the two rules it lifts are lifted in one place).
 *
 * ---------------------------------------------------------------------------
 * The passability class of the raster is derived here too
 * ---------------------------------------------------------------------------
 *
 * `runnability.bin` stays — it is the *speed and colour* surface (D-002), and
 * the map is drawn from it. What it may no longer do is disagree with the model
 * about what is out of bounds, and it did: measured on the shipped raster,
 * **19 674 m² of the playable square is `Impassable` with nothing solid in the
 * model there**, and `SPEED_BY_RUNNABILITY[Impassable]` is 0. Take the raster
 * clause out of `blockedAt` and the athlete walks into those cells and stops
 * dead at zero speed — the same "I'm stuck" report, arriving by a different
 * road. So this file rewrites the raster's `Impassable` class to be exactly the
 * model's solid set: derived, in one pass, from one source, rather than stamped
 * by five passes in an order no single place owns.
 *
 * Pipeline order, and it matters:  build.mjs → townscape.mjs → townmodel.mjs.
 *
 * Usage: node tools/terrain/townmodel.mjs [--venue krumlov] [--check] [--no-raster]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const VENUES = {
  krumlov: { data: 'public/data/krumlov', playableR: 600 },
};

/**
 * The height at or below which a barrier is crossable, metres.
 *
 * D-029's number, carried forward unchanged and for its own reasons: between
 * 0.9 m and ISSprOM's cartographic 1.5 m sits a band of barriers that look
 * solid from a 1.62 m eye and were not. It is *the* number of this model —
 * `blocks` is a function of it and of the barrier's drawn height, and of
 * nothing else.
 */
const CROSSABLE_MAX_H = 0.9;

/**
 * Barrier thickness by kind code, metres. Wall · city wall · retaining wall ·
 * fence or railing · hedge.
 *
 * Shipped in the model's header rather than only living in two source files,
 * because it is what the drawn slab and the collider band are both built from.
 */
const THICKNESS_BY_KIND = [0.45, 1.15, 0.6, 0.1, 0.95];

/**
 * How far the collider stands proud of the drawn face, metres.
 *
 * The athlete is a point and the wall is a slab; without a skin the point
 * reaches the plane of the face before anything stops it and the camera clips
 * through the masonry. 0.25 m is what `Townscape.buildWall` has always
 * registered, kept because it is the number the venue was played on.
 *
 * It is also the tolerance the drawn ≡ solid assertion has to allow in one
 * direction: solid may exceed drawn by the skin and by nothing else.
 */
const SKIN_M = 0.25;

/** Broadphase cell, metres. Phase 0 swept 3–32 m and found 8–12 optimal. */
const CELL_M = 12;

/** Half-width floor for a bridge carriageway, metres. See `DECK_HALF_MIN_M`. */
const DECK_HALF_MIN_M = 1.4;

/**
 * Half a cell's diagonal, in cells.
 *
 * The floor a thin feature is widened to when it is drawn into the raster.
 * Half a cell is not enough and the arithmetic says why: a barrier running at
 * 45° across a 1 m lattice passes 0.71 m from the cell centres it goes between,
 * so a 0.5 m band draws it as dots. Measured — 0.5 m leaves 2.8 % of the
 * venue's uncrossable barrier length off the map, 0.71 m leaves 0.4 %.
 */
const CELL_DIAGONAL_HALF = Math.SQRT1_2;

/** Runnability.Impassable — src/core/types.ts. */
const IMPASSABLE = 10;

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * A section writer: named typed-array blocks, concatenated, 4-byte aligned,
 * described in the JSON header so the runtime can wrap them without copying.
 */
class Pack {
  constructor() {
    this.parts = [];
    this.sections = {};
    this.bytes = 0;
  }

  add(name, type, values) {
    const arr =
      type === 'i32' ? Int32Array.from(values) : Float32Array.from(values);
    this.sections[name] = { type, offset: this.bytes, count: arr.length };
    this.parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    this.bytes += arr.byteLength;
    return arr;
  }

  buffer() {
    return Buffer.concat(this.parts);
  }
}

/** Polylines and rings share one shape: an offset table plus a point array. */
function packLines(pack, name, lines) {
  const off = [0];
  const pts = [];
  for (const l of lines) {
    for (const v of l) pts.push(v);
    off.push(pts.length / 2);
  }
  pack.add(`${name}Offset`, 'i32', off);
  pack.add(`${name}Pts`, 'f32', pts);
  return pts.length / 2;
}

// ---------------------------------------------------------------------------
// Geometry helpers — the same predicates the runtime uses
// ---------------------------------------------------------------------------

class Grid {
  constructor(cellM) {
    this.cellM = cellM;
    this.cells = new Map();
  }

  add(idx, minX, minZ, maxX, maxZ) {
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

  at(x, z) {
    const c = this.cellM;
    return this.cells.get(Math.floor(x / c) * 100003 + Math.floor(z / c));
  }
}

function inRing(p, x, z) {
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

function segDist2(ax, az, bx, bz, x, z) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return px * px + pz * pz;
}

function bounds(pts) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  return [minX, minZ, maxX, maxZ];
}

// ---------------------------------------------------------------------------
// The model, offline
// ---------------------------------------------------------------------------

/**
 * Everything in `townscape.json` that decides where the athlete may stand,
 * turned into the four kinds of object the model has and nothing else.
 *
 * Deliberately *not* everything the town contains: steps are ISSprOM 532 and
 * runnable, trees are run around, and the paved network's non-bridge ways are
 * the street graph, which is phase 3. What is here is what blocks, plus the one
 * thing that un-blocks — the carriageway of a bridge.
 */
function extract(town) {
  const buildings = [];
  for (const b of town.buildings) {
    if (!b.p || b.p.length < 6) continue;
    buildings.push(b.p.map(round2));
  }

  const barriers = [];
  for (const w of town.walls) {
    if (!w.p || w.p.length < 4) continue;
    const kind = THICKNESS_BY_KIND[w.k] === undefined ? 0 : w.k;
    barriers.push({ pts: w.p.map(round2), kind, height: round2(w.h) });
  }

  const waterAreas = [];
  const waterCourses = [];
  for (const w of town.water ?? []) {
    if (w.p && w.p.length >= 6 && w.y !== undefined) {
      waterAreas.push({ pts: w.p.map(round2), level: round2(w.y) });
    } else if (w.l && w.l.length >= 4 && w.w) {
      waterCourses.push({ pts: w.l.map(round2), width: round2(w.w) });
    }
  }

  // A bridge is an object, not an exception: its carriageway centreline and
  // width, carried whole. `BridgeDecks` derives the deck's *height* from the
  // chord between its abutments (D-031) — that stays in the runtime because it
  // needs the tier's own heightfield, and it is the one thing about a bridge
  // this file cannot know.
  const decks = [];
  for (const way of town.paved ?? []) {
    if (!way.b || !way.l || way.l.length < 4) continue;
    decks.push({ pts: way.l.map(round2), width: round2(way.w) });
  }

  return { buildings, barriers, waterAreas, waterCourses, decks };
}

/**
 * Centimetres, at the precision the file is packed in.
 *
 * `Math.fround` is not decoration: the model ships as `Float32Array`, so the
 * runtime sees 123.44999694824219 where this tool would otherwise hold 123.45,
 * and a point-in-polygon test on a boundary flips. Measured before this line
 * existed: 62 cells of the venue where the raster derived from the tool's
 * numbers disagreed with the collider built from the file's. Sixty-two cells is
 * nothing to a player and everything to an assertion that has to be exact —
 * the gate would have had to carry a tolerance, and a tolerance is what every
 * fault in §1 hid inside.
 */
function round2(v) {
  return Math.fround(Math.round(v * 100) / 100);
}

/** The collider set the runtime will build, built here for the assertions. */
export function colliders(model) {
  const ringGrid = new Grid(CELL_M);
  const rings = [];
  const ringBB = [];
  for (const p of model.buildings) {
    ringGrid.add(rings.length, ...bounds(p));
    ringBB.push(bounds(p));
    rings.push(p);
  }

  const segGrid = new Grid(CELL_M);
  const segs = [];
  let solidLength = 0;
  let crossableLength = 0;
  for (const b of model.barriers) {
    const half = THICKNESS_BY_KIND[b.kind] * 0.5 + SKIN_M;
    const solid = b.height > CROSSABLE_MAX_H;
    for (let i = 0; i + 3 < b.pts.length; i += 2) {
      const ax = b.pts[i];
      const az = b.pts[i + 1];
      const bx = b.pts[i + 2];
      const bz = b.pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.15 || len > 120) continue;
      if (!solid) {
        crossableLength += len;
        continue;
      }
      solidLength += len;
      segGrid.add(
        segs.length,
        Math.min(ax, bx) - half,
        Math.min(az, bz) - half,
        Math.max(ax, bx) + half,
        Math.max(az, bz) + half,
      );
      segs.push([ax, az, bx, bz, half]);
    }
  }

  const waGrid = new Grid(CELL_M);
  const waRings = [];
  for (const a of model.waterAreas) {
    waGrid.add(waRings.length, ...bounds(a.pts));
    waRings.push(a.pts);
  }
  const wcGrid = new Grid(CELL_M);
  const wcSegs = [];
  for (const c of model.waterCourses) {
    const half = c.width * 0.5;
    for (let i = 0; i + 3 < c.pts.length; i += 2) {
      const ax = c.pts[i];
      const az = c.pts[i + 1];
      const bx = c.pts[i + 2];
      const bz = c.pts[i + 3];
      wcGrid.add(
        wcSegs.length,
        Math.min(ax, bx) - half,
        Math.min(az, bz) - half,
        Math.max(ax, bx) + half,
        Math.max(az, bz) + half,
      );
      wcSegs.push([ax, az, bx, bz, half]);
    }
  }

  const dkGrid = new Grid(CELL_M);
  const dkSegs = [];
  for (const d of model.decks) {
    const half = Math.max(DECK_HALF_MIN_M, d.width * 0.5);
    for (let i = 0; i + 3 < d.pts.length; i += 2) {
      const ax = d.pts[i];
      const az = d.pts[i + 1];
      const bx = d.pts[i + 2];
      const bz = d.pts[i + 3];
      dkGrid.add(
        dkSegs.length,
        Math.min(ax, bx) - half,
        Math.min(az, bz) - half,
        Math.max(ax, bx) + half,
        Math.max(az, bz) + half,
      );
      dkSegs.push([ax, az, bx, bz, half]);
    }
  }

  const hitSegs = (grid, data, x, z, minHalf = 0) => {
    const list = grid.at(x, z);
    if (!list) return false;
    for (const i of list) {
      const s = data[i];
      const h = s[4] > minHalf ? s[4] : minHalf;
      if (segDist2(s[0], s[1], s[2], s[3], x, z) <= h * h) return true;
    }
    return false;
  };

  const inBuilding = (x, z) => {
    const list = ringGrid.at(x, z);
    if (!list) return false;
    for (const i of list) {
      const bb = ringBB[i];
      if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
      if (inRing(rings[i], x, z)) return true;
    }
    return false;
  };

  const inWater = (x, z) => {
    const list = waGrid.at(x, z);
    if (list) for (const i of list) if (inRing(waRings[i], x, z)) return true;
    return hitSegs(wcGrid, wcSegs, x, z);
  };

  const onDeck = (x, z) => hitSegs(dkGrid, dkSegs, x, z);
  const inBarrier = (x, z) => hitSegs(segGrid, segs, x, z);

  // `TownModel.blockedAt`, and it must stay identical to it. A building is out
  // of bounds under every circumstance; a carriageway is a *surface*, so what
  // it carries you over — a river, a parapet running onto the deck — does not
  // apply while you are on it.
  const blockedAt = (x, z) => {
    if (inBuilding(x, z)) return true;
    if (onDeck(x, z)) return false;
    return inBarrier(x, z) || inWater(x, z);
  };

  /**
   * Does anything solid fall *within* this cell, rather than exactly on its
   * centre?
   *
   * The raster is a 1 m lattice and a railing's collider is 0.6 m across, so
   * sampling centres turns a diagonal fence into a dotted line: 4.4 % of the
   * venue's uncrossable barrier length stopped the athlete without appearing on
   * the map, which is the ISSprOM 515/518 unfairness D-002 exists to prevent.
   * A cell is impassable if the barrier crosses it anywhere, which is what the
   * old stamp's line rasteriser did and the one thing it was right about.
   */
  const blockedInCell = (x, z, halfCell) => {
    if (inBuilding(x, z)) return true;
    if (onDeck(x, z)) return false;
    if (hitSegs(segGrid, segs, x, z, halfCell)) return true;
    if (hitSegs(wcGrid, wcSegs, x, z, halfCell)) return true;
    return inWater(x, z);
  };
  void blockedInCell;

  /**
   * The raster's view: a feature narrower than a cell is drawn one cell wide.
   *
   * A wall is 0.95 m of collider and lands on the lattice as a line. A railing
   * is 0.60 m and lands as dots — 4.4 % of the venue's uncrossable barrier
   * length stopped the athlete without appearing on the map, which is exactly
   * the unfairness ISSprOM 515/518 exists to prevent and D-002 to structure.
   *
   * So thin features, and only thin features, are widened to the lattice they
   * have to be drawn on. Everything already wider is untouched, which matters
   * more than it sounds: widening *every* barrier by half a cell takes a 2.5 m
   * alley down to 0.9 m, and the course generator — which reads this raster —
   * responded by producing a course with five legs that could not be run.
   */
  const drawnInCell = (x, z, minHalf) => {
    if (inBuilding(x, z)) return true;
    if (onDeck(x, z)) return false;
    if (hitSegs(segGrid, segs, x, z, minHalf)) return true;
    if (hitSegs(wcGrid, wcSegs, x, z, minHalf)) return true;
    return inWater(x, z);
  };

  return {
    blockedAt,
    blockedInCell,
    drawnInCell,
    inBuilding,
    inBarrier,
    inWater,
    onDeck,
    counts: {
      buildingRings: rings.length,
      buildingVerts: rings.reduce((a, r) => a + r.length / 2, 0),
      barrierSegments: segs.length,
      waterAreas: waRings.length,
      waterCourseSegments: wcSegs.length,
      deckSegments: dkSegs.length,
      solidLengthM: Math.round(solidLength),
      crossableLengthM: Math.round(crossableLength),
    },
  };
}

// ---------------------------------------------------------------------------
// The raster's passability class, derived from the model
// ---------------------------------------------------------------------------

/**
 * Rewrite `runnability.bin` so that `Impassable` is exactly the model's solid
 * set inside the playable square.
 *
 * Two directions, and they fail differently:
 *
 *  - **solid, not `Impassable`** — the map draws runnable ground where the
 *    model stops you. 5 375 m² on the shipped raster, most of it the Vltava
 *    where ZABAGED's outline and OSM's disagree (D-031's 5 300 m²).
 *  - **`Impassable`, not solid** — the athlete is let in by the collider and
 *    frozen by the speed model, because `SPEED_BY_RUNNABILITY[Impassable]` is
 *    0. 19 674 m², 70.6 % of it within 2 m of something solid: stamp dilation
 *    and cell quantisation rather than a feature.
 *
 * The band is the collider's own, floored at half a cell so that a feature
 * narrower than the lattice is still drawn as a line on it. Collision itself is
 * the model and is not widened by anything.
 *
 * A cell freed this way needs a *speed* class, and the model does not carry
 * one — it describes edges, not surfaces. It takes the nearest non-impassable
 * class in the raster itself, breadth-first, which for a dilation halo is the
 * alley or the courtyard it was eating into. That is an inference and it is
 * recorded as one; what it is not is a second opinion about passability, which
 * after this pass the raster no longer holds.
 */
function deriveRaster(dataDir, col, playableR) {
  const metaPath = join(dataDir, 'runnability.json');
  const binPath = join(dataDir, 'runnability.bin');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const buf = readFileSync(binPath);
  const r = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);

  const { width, height, resM, originX, originZ } = meta;
  const inPlay = (x, z) => Math.abs(x) <= playableR && Math.abs(z) <= playableR;

  let sealed = 0;
  let sealedOutside = 0;
  let freed = 0;
  const freedIdx = [];
  for (let j = 0; j < height; j++) {
    const z = originZ + j * resM;
    for (let i = 0; i < width; i++) {
      const x = originX + i * resM;
      const k = j * width + i;
      const solid = col.drawnInCell(x, z, resM * CELL_DIAGONAL_HALF);
      /**
       * Outside the playable square the two directions are not symmetric, and
       * that asymmetry is the point.
       *
       * The model is built over the playable square but its ways run on past
       * it — the extract's bounding box is ±706 m — so there is real geometry
       * out there that the map must draw, and `bakedRaster` used to sweep the
       * whole raster at load precisely to catch it. Sealing it here is what
       * lets that sweep go.
       *
       * *Freeing* is a different claim and is not made out there. Inside the
       * square the model is complete, so `Impassable` may be replaced by it
       * outright; outside, ZABAGED still carries water bodies and buildings the
       * model has never seen, and taking those away would open the Vltava
       * upstream of the town.
       */
      if (!inPlay(x, z)) {
        if (solid && r[k] !== IMPASSABLE) {
          r[k] = IMPASSABLE;
          sealedOutside++;
        }
        continue;
      }
      if (solid && r[k] !== IMPASSABLE) {
        r[k] = IMPASSABLE;
        sealed++;
      } else if (!solid && r[k] === IMPASSABLE) {
        freedIdx.push(k);
        freed++;
      }
    }
  }

  // Nearest non-impassable class, by a multi-source breadth-first pass over the
  // whole raster seeded from every cell that already has one.
  //
  // It walks *through* impassable ground rather than round it, which is the
  // difference between a nearest class and a nearest *reachable* class. The
  // first cut did the latter and left 647 freed cells — the ones enclosed by
  // solid ground — still `Impassable`, and a rule that holds for 99.97 % of the
  // venue is the shape of every fault in §1. The invariant is exact:
  // **inside the playable square, `Impassable` is the model's solid set.**
  if (freedIdx.length) {
    const nearest = new Uint8Array(width * height).fill(255);
    const queue = new Int32Array(width * height);
    let tail = 0;
    for (let k = 0; k < r.length; k++) {
      if (r[k] !== IMPASSABLE) {
        nearest[k] = r[k];
        queue[tail++] = k;
      }
    }
    for (let head = 0; head < tail; head++) {
      const k = queue[head];
      const cls = nearest[k];
      const i = k % width;
      const j = (k / width) | 0;
      const step = (ni, nj) => {
        if (ni < 0 || nj < 0 || ni >= width || nj >= height) return;
        const nk = nj * width + ni;
        if (nearest[nk] !== 255) return;
        nearest[nk] = cls;
        queue[tail++] = nk;
      };
      step(i + 1, j);
      step(i - 1, j);
      step(i, j + 1);
      step(i, j - 1);
    }
    for (const k of freedIdx) r[k] = nearest[k] === 255 ? 3 : nearest[k];
  }

  // Verify the invariant on the bytes that are about to be written, rather
  // than on the intention. Two passes over 2.6 M cells cost nothing offline.
  let residual = 0;
  for (let j = 0; j < height; j++) {
    const z = originZ + j * resM;
    for (let i = 0; i < width; i++) {
      const x = originX + i * resM;
      if (!inPlay(x, z)) continue;
      if ((r[j * width + i] === IMPASSABLE) !== col.drawnInCell(x, z, resM * CELL_DIAGONAL_HALF)) residual++;
    }
  }

  const histogram = {};
  const names = meta.classes;
  for (let k = 0; k < r.length; k++) {
    const name = names[String(r[k])] ?? String(r[k]);
    histogram[name] = (histogram[name] ?? 0) + 1;
  }
  meta.histogram = histogram;
  /**
   * The marker that says this raster's `Impassable` class is a view of the
   * model rather than a stamp. `check-townmodel` fails without it, which is
   * what stops a regenerated raster from silently going back to disagreeing.
   */
  meta.impassableFrom = 'townmodel';
  meta.playableR = playableR;

  writeFileSync(binPath, buf);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { sealed, sealedOutside, freed, residual, playableR };
}

// ---------------------------------------------------------------------------
// The assertion: drawn ≡ solid, over the whole venue
// ---------------------------------------------------------------------------

/**
 * Rasterise what the model says is *drawn as blocking*, and compare it with
 * what the model's colliders *stop you at*, cell by cell over the venue.
 *
 * This is the offline half of phase 1's gate. It cannot fail on the model as
 * built — that is the point of §2 rule 2, and this measures it rather than
 * asserting it by construction — but it can and does fail on a hand-edited
 * model file, and it is the same sweep `tools/ci/check-townmodel.mjs` runs
 * against the *real scene graph*, which is where a fault can still hide.
 *
 * The drawn side is built from the drawn dimensions: a barrier's slab is
 * `thickness / 2` about its centreline and it is drawn as blocking when it
 * stands above `crossableMaxH`; a building is its footprint; water is its
 * surface. The solid side adds `skin` and nothing else, so the two may differ
 * by the skin in one direction and by nothing in the other.
 */
export function drawnVsSolid(model, col, step, playableR) {
  const drawnGrid = new Grid(CELL_M);
  const drawnSegs = [];
  for (const b of model.barriers) {
    if (b.height <= CROSSABLE_MAX_H) continue;
    const half = THICKNESS_BY_KIND[b.kind] * 0.5;
    for (let i = 0; i + 3 < b.pts.length; i += 2) {
      const ax = b.pts[i];
      const az = b.pts[i + 1];
      const bx = b.pts[i + 2];
      const bz = b.pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.15 || len > 120) continue;
      // Indexed with a metre of padding so `outsideDrawn` can still find the
      // face a point is standing just outside; the containment test below uses
      // the drawn half-thickness itself and is unaffected by the padding.
      drawnGrid.add(
        drawnSegs.length,
        Math.min(ax, bx) - half - 1,
        Math.min(az, bz) - half - 1,
        Math.max(ax, bx) + half + 1,
        Math.max(az, bz) + half + 1,
      );
      drawnSegs.push([ax, az, bx, bz, half]);
    }
  }
  const drawnBarrier = (x, z) => {
    const list = drawnGrid.at(x, z);
    if (!list) return false;
    for (const i of list) {
      const s = drawnSegs[i];
      if (segDist2(s[0], s[1], s[2], s[3], x, z) <= s[4] * s[4]) return true;
    }
    return false;
  };

  const drawnBlocking = (x, z) => {
    if (col.inBuilding(x, z)) return true;
    if (col.onDeck(x, z)) return false;
    return drawnBarrier(x, z) || col.inWater(x, z);
  };

  /**
   * How far a solid point stands outside the drawn face, metres.
   *
   * Exact rather than probed: for a barrier it is the distance to the
   * centreline less the drawn half-thickness, and a building or a water surface
   * is drawn over its whole footprint so the gap is zero. A railing is drawn
   * 0.10 m thick, which a ring of sample probes steps clean over — the first
   * cut of this check did exactly that and reported 188 m² of phantom
   * disagreement, which is D-029's own lesson arriving from the other side.
   */
  const outsideDrawn = (x, z) => {
    const list = drawnGrid.at(x, z);
    if (!list) return Infinity;
    let best = Infinity;
    for (const i of list) {
      const s = drawnSegs[i];
      const d = Math.sqrt(segDist2(s[0], s[1], s[2], s[3], x, z)) - s[4];
      if (d < best) best = d;
    }
    return best;
  };

  let drawnNotSolid = 0;
  let solidNotDrawn = 0;
  let worstGap = 0;
  let cells = 0;
  const area = step * step;
  for (let z = -playableR; z <= playableR; z += step) {
    for (let x = -playableR; x <= playableR; x += step) {
      cells++;
      const drawn = drawnBlocking(x, z);
      const solid = col.blockedAt(x, z);
      if (drawn && !solid) drawnNotSolid++;
      else if (solid && !drawn) {
        solidNotDrawn++;
        const gap = outsideDrawn(x, z);
        if (gap > worstGap) worstGap = gap;
      }
    }
  }
  return {
    step,
    cells,
    drawnNotSolidM2: Math.round(drawnNotSolid * area),
    /** All of it is the collider skin; `worstGapM` is what says so. */
    solidNotDrawnM2: Math.round(solidNotDrawn * area),
    worstGapM: Math.round(worstGap * 1000) / 1000,
    skinM: SKIN_M,
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/**
 * Unpack the shipped artefact into the same shape `extract` produces.
 *
 * `tools/ci/check-townmodel.mjs` reads through this rather than re-deriving
 * from `townscape.json`, because the thing that has to be right is the file
 * that ships. The header's three tying numbers are checked against this
 * module's own, since a model built with a different `crossableMaxH` is a model
 * whose barriers block at a height this code does not expect.
 */
export function readModel(dataDir) {
  const header = JSON.parse(readFileSync(join(dataDir, 'townmodel.json'), 'utf8'));
  const buf = readFileSync(join(dataDir, 'townmodel.bin'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

  if (header.crossableMaxH !== CROSSABLE_MAX_H) {
    throw new Error(
      `townmodel.json was built with crossableMaxH ${header.crossableMaxH}, this tool uses ${CROSSABLE_MAX_H}`,
    );
  }
  if (header.skinM !== SKIN_M || String(header.thicknessByKind) !== String(THICKNESS_BY_KIND)) {
    throw new Error('townmodel.json was built with different barrier dimensions — rebuild it');
  }

  const arr = (name) => {
    const s = header.sections[name];
    if (!s) return [];
    return s.type === 'i32'
      ? new Int32Array(ab, s.offset, s.count)
      : new Float32Array(ab, s.offset, s.count);
  };
  const lines = (name) => {
    const off = arr(`${name}Offset`);
    const pts = arr(`${name}Pts`);
    const out = [];
    for (let i = 0; i + 1 < off.length; i++) {
      out.push(Array.from(pts.subarray(off[i] * 2, off[i + 1] * 2)));
    }
    return out;
  };

  const kinds = arr('barrierKind');
  const heights = arr('barrierHeight');
  const levels = arr('waterAreaLevel');
  const courseW = arr('waterCourseWidth');
  const deckW = arr('deckWidth');

  const model = {
    buildings: lines('building'),
    barriers: lines('barrier').map((pts, i) => ({ pts, kind: kinds[i], height: heights[i] })),
    waterAreas: lines('waterArea').map((pts, i) => ({ pts, level: levels[i] })),
    waterCourses: lines('waterCourse').map((pts, i) => ({ pts, width: courseW[i] })),
    decks: lines('deck').map((pts, i) => ({ pts, width: deckW[i] })),
  };
  return { header, model };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const venueArg = args.find((a) => a.startsWith('--venue='));
  const venueId = venueArg ? venueArg.slice('--venue='.length) : 'krumlov';
  const cfg = VENUES[venueId];
  if (!cfg) {
    console.error(`✗ unknown venue "${venueId}"`);
    process.exit(2);
  }
  const stepArg = args.find((a) => a.startsWith('--step='));
  const step = stepArg ? Number(stepArg.slice('--step='.length)) : 0.5;

  const dataDir = resolve(ROOT, cfg.data);
  const src = join(dataDir, 'townscape.json');
  if (!existsSync(src)) {
    console.error(`✗ ${src} missing — run tools/terrain/townscape.mjs first.`);
    process.exit(2);
  }

  const town = JSON.parse(readFileSync(src, 'utf8'));
  const t0 = Date.now();
  const model = extract(town);
  const col = colliders(model);

  // --- pack -----------------------------------------------------------------
  const pack = new Pack();
  packLines(pack, 'building', model.buildings);
  packLines(pack, 'barrier', model.barriers.map((b) => b.pts));
  pack.add('barrierKind', 'i32', model.barriers.map((b) => b.kind));
  pack.add('barrierHeight', 'f32', model.barriers.map((b) => b.height));
  packLines(pack, 'waterArea', model.waterAreas.map((a) => a.pts));
  pack.add('waterAreaLevel', 'f32', model.waterAreas.map((a) => a.level));
  packLines(pack, 'waterCourse', model.waterCourses.map((c) => c.pts));
  pack.add('waterCourseWidth', 'f32', model.waterCourses.map((c) => c.width));
  packLines(pack, 'deck', model.decks.map((d) => d.pts));
  pack.add('deckWidth', 'f32', model.decks.map((d) => d.width));

  const bin = pack.buffer();

  // --- the assertion --------------------------------------------------------
  const checks = drawnVsSolid(model, col, step, cfg.playableR);

  // --- the derived raster ---------------------------------------------------
  const raster = args.includes('--no-raster')
    ? { sealed: 0, freed: 0, skipped: true }
    : deriveRaster(dataDir, col, cfg.playableR);

  const header = {
    venue: venueId,
    generatedAt: new Date().toISOString(),
    from: 'townscape.json',
    source: town.source,
    /**
     * The three numbers that tie the drawing to the collider. Shipped rather
     * than only declared in two source files: `TownModel` reads them from here,
     * so the geometry and the collider cannot be built from different ones.
     */
    crossableMaxH: CROSSABLE_MAX_H,
    thicknessByKind: THICKNESS_BY_KIND,
    skinM: SKIN_M,
    cellM: CELL_M,
    deckHalfMinM: DECK_HALF_MIN_M,
    playableR: cfg.playableR,
    counts: {
      buildings: model.buildings.length,
      barriers: model.barriers.length,
      barriersSolid: model.barriers.filter((b) => b.height > CROSSABLE_MAX_H).length,
      waterAreas: model.waterAreas.length,
      waterCourses: model.waterCourses.length,
      decks: model.decks.length,
      ...col.counts,
      primitives:
        col.counts.buildingRings +
        col.counts.barrierSegments +
        col.counts.waterAreas +
        col.counts.waterCourseSegments +
        col.counts.deckSegments,
    },
    checks,
    raster,
    sections: pack.sections,
    bytes: bin.length,
  };

  writeFileSync(join(dataDir, 'townmodel.bin'), bin);
  writeFileSync(join(dataDir, 'townmodel.json'), `${JSON.stringify(header, null, 2)}\n`);

  const gz = gzipSync(bin).length;
  console.log(`✓ ${join(cfg.data, 'townmodel.bin')}`);
  console.log(
    `  ${header.counts.buildings} buildings (${col.counts.buildingVerts} verts) · ` +
      `${header.counts.barriers} barriers, ${header.counts.barriersSolid} solid ` +
      `(${(col.counts.solidLengthM / 1000).toFixed(2)} km solid, ${(col.counts.crossableLengthM / 1000).toFixed(2)} km crossable) · ` +
      `${header.counts.waterAreas} water areas · ${header.counts.waterCourses} watercourses · ` +
      `${header.counts.decks} bridge carriageways`,
  );
  console.log(`  ${header.counts.primitives} collision primitives, ${CELL_M} m broadphase`);
  console.log(
    `  drawn ≡ solid over ${(cfg.playableR * 2) ** 2 / 1e4} ha at ${step} m: ` +
      `drawn-not-solid ${checks.drawnNotSolidM2} m², solid-not-drawn ${checks.solidNotDrawnM2} m² ` +
      `(worst gap ${checks.worstGapM} m against a ${SKIN_M} m skin)`,
  );
  if (!raster.skipped) {
    console.log(
      `  runnability.bin: Impassable derived from the model — ${raster.sealed} cells sealed, ` +
        `${raster.freed} freed, ${raster.sealedOutside} sealed outside the playable square`,
    );
  }
  console.log(`  ${(bin.length / 1024).toFixed(0)} kB  (gzip ${(gz / 1024).toFixed(0)} kB)  built in ${Date.now() - t0} ms`);
}

// Only when run, not when the gate imports the pieces above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
