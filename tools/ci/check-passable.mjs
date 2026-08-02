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
 * with a mask.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

/** Runnability.Impassable — see src/core/types.ts. */
const IMPASSABLE = 10;

/** The arena, from `START` in src/world/sprintScene.ts. */
const ARENA = { x: 1, z: 24 };

/** `EYE_HEIGHT` in src/world/sprintScene.ts. */
const EYE_HEIGHT = 1.62;

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
   * Largest tolerated pocket the arena cannot reach, m².
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
   */
  maxPocketM2: 30_000,
  /** Fraction of uncrossable barrier length that must appear in the raster. */
  minBarrierDrawn: 0.995,
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
   * Fewest controls that make a race. Mirrors `MIN_CONTROLS_FOR_A_RACE` in
   * src/race/courseSetup.ts: below this the terrain has refused, and a sprint
   * of one control over 500 m is the shape a sealed venue produces.
   */
  minControls: 8,
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

function loadVenue(venue, bin) {
  const dir = venueDir(venue);
  const meta = bin.replace(/\.bin$/, '.json');
  const rMeta = JSON.parse(readFileSync(join(dir, meta), 'utf8'));
  const r = new Uint8Array(readFileSync(join(dir, bin)));
  const town = JSON.parse(readFileSync(join(dir, 'townscape.json'), 'utf8'));
  return { rMeta, r, town };
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

    for (const b of town.buildings) {
      if (b.p.length < 6) continue;
      this.addRing(b.p);
    }
    for (const w of town.walls) {
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

// ---------------------------------------------------------------------------
// Phase 1 — flood-fill one raster
// ---------------------------------------------------------------------------

function floodFill(venue, bin, step) {
  const { rMeta, r, town } = loadVenue(venue, bin);
  const col = new Colliders(town);

  const rasterAt = (x, z) => {
    const i = Math.round((x - rMeta.originX) / rMeta.resM);
    const j = Math.round((z - rMeta.originZ) / rMeta.resM);
    if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return IMPASSABLE;
    return r[j * rMeta.width + i];
  };

  /** Exactly `SprintScene.blockedAt`. */
  const blocked = (x, z) =>
    col.inBuilding(x, z) || col.inBarrier(x, z) || rasterAt(x, z) === IMPASSABLE;

  // The playable extent, ±600 m, per VENUES.krumlov in townscape.mjs.
  const R = 600;
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

  // A trap is a pocket that is not the arena's component but is big enough to
  // stand in — i.e. somewhere a course could be set, or a player put, and not
  // be able to leave.
  const traps = [];
  for (let id = 0; id < sizes.length; id++) {
    if (id === arena) continue;
    const m2 = sizes[id] * cellM2;
    if (m2 < 6) continue;
    traps.push({ id, m2 });
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
  for (const o of named) {
    const { x, z } = o.p;
    if (blocked(x, z)) faults.push(o.n + ' is inside a barrier');
    else if (inAnyBuilding(x, z)) faults.push(o.n + ' is inside a building footprint');
    const drift = Math.abs(w.field.heightAt(x, z) - surveyed(x, z));
    if (drift > ${limits.maxHeightDriftM}) {
      faults.push(o.n + ' stands ' + drift.toFixed(1) + ' m off the surveyed ground');
    }
  }

  // The eye, measured where the scene actually put it.
  const cam = w.camera.position;
  const eyeErr = Math.abs(cam.y - (w.field.heightAt(cam.x, cam.z) + EYE));
  if (eyeErr > ${limits.maxEyeErrorM}) {
    faults.push('the eye is ' + eyeErr.toFixed(2) + ' m off terrain + eye height');
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

  return JSON.stringify({
    faults,
    controls: c.controls.length,
    lengthM: c.lengthM,
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
  /** The class raster each tier was handed, keyed by tier. */
  const rasterByTier = new Map();
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
        const ok = res.faults.length === 0 && res.renderErrors.length === 0;
        if (!ok) bad = true;
        console.log(
          `${ok ? '✓' : '✗'} ${res.controls} controls · ${res.lengthM} m · ` +
            `reachable ${(res.reachable * 100).toFixed(0)}% · ` +
            (res.pocketM2 < 0 ? 'start opens onto the venue' : `start pocket ${res.pocketM2} m²`),
        );
        for (const f of res.faults) console.log(`     ✗ ${f}`);
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
    console.log(`  disconnected pockets over 6 m²: ${f.traps.length}`);
    for (const t of f.traps.slice(0, 6)) {
      const c = f.centreOf(t.id);
      console.log(`    ${t.m2.toFixed(0).padStart(7)} m²  near (${c.x}, ${c.z})`);
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
    const worst = f.traps[0];
    if (worst && worst.m2 > LIMITS.maxPocketM2) {
      const c = f.centreOf(worst.id);
      console.error(
        `✗ ${bin}: a ${(worst.m2 / 1e4).toFixed(1)} ha pocket near (${c.x}, ${c.z}) is sealed off from the arena`,
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

main().catch((e) => {
  console.error('✗ harness error:', e);
  process.exit(2);
});
