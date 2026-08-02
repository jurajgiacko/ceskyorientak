#!/usr/bin/env node
/**
 * Passability gate for the sprint venue.
 *
 * Reproduces, offline and exactly, the three things `SprintScene.blockedAt`
 * consults at runtime — the shipped runnability raster, the OSM building
 * footprints, and the uncrossable barriers in `Townscape.blocks` — and then
 * asks the only question that matters to a player: **from the arena, what can
 * you reach?**
 *
 * It exists because "all legs routable" and "the player is stuck" are not the
 * same claim. `check-race.mjs` drives an autopilot round one course and passes
 * if the finish is punched; it says nothing about the ground beside the route.
 * This walks the whole venue.
 *
 * Usage: node tools/ci/check-passable.mjs [--venue krumlov] [--step 0.5]
 * Exit codes: 0 pass, 1 a trap or a disagreement was found, 2 harness failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** Runnability.Impassable — see src/core/types.ts. */
const IMPASSABLE = 10;

/** The arena, from `START` in src/world/sprintScene.ts. */
const ARENA = { x: 1, z: 24 };

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
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function loadVenue(venue) {
  const dir = resolve(ROOT, 'public/data', venue);
  const rMeta = JSON.parse(readFileSync(join(dir, 'runnability.json'), 'utf8'));
  const r = new Uint8Array(readFileSync(join(dir, 'runnability.bin')));
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
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const venue = (args.find((a) => a.startsWith('--venue=')) ?? '--venue=krumlov').slice(8);
  const step = Number((args.find((a) => a.startsWith('--step=')) ?? '--step=0.5').slice(7));

  const dir = resolve(ROOT, 'public/data', venue);
  if (!existsSync(join(dir, 'townscape.json'))) {
    console.log(`· ${venue}: no townscape — nothing to check`);
    process.exit(0);
  }

  const { rMeta, r, town } = loadVenue(venue);
  if (!town.rasterStamped) {
    console.error(
      `✗ ${venue}: runnability.bin has not been stamped with the OSM network, footprints and barriers.\n` +
        `  Run \`node tools/terrain/townscape.mjs --venue=${venue}\`. This happens if the terrain\n` +
        `  was regenerated after the townscape was — build.mjs writes a pristine raster.`,
    );
    process.exit(1);
  }

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

  const fraction = openN ? reachN / openN : 0;
  const worst = traps[0];

  console.log(`· ${venue} passability, ${step} m grid over ±${R} m`);
  console.log(`  open ground        ${(openN * cellM2 / 1e4).toFixed(1)} ha`);
  console.log(`  reachable from arena ${(fraction * 100).toFixed(1)} %  (${(reachN * cellM2 / 1e4).toFixed(1)} ha)`);
  console.log(`  disconnected pockets over 6 m²: ${traps.length}`);
  for (const t of traps.slice(0, 6)) {
    const c = centreOf(t.id);
    console.log(`    ${t.m2.toFixed(0).padStart(7)} m²  near (${c.x}, ${c.z})`);
  }
  console.log(
    `  uncrossable barriers drawn on the map: ${((barrierSeen / Math.max(1, barrierPts)) * 100).toFixed(1)} %`,
  );

  let bad = false;
  if (blocked(ARENA.x, ARENA.z)) {
    console.error(`✗ the arena (${ARENA.x}, ${ARENA.z}) is itself inside a barrier`);
    bad = true;
  }
  if (fraction < LIMITS.minReachable) {
    console.error(`✗ only ${(fraction * 100).toFixed(1)} % of open ground is reachable from the arena`);
    bad = true;
  }
  if (worst && worst.m2 > LIMITS.maxPocketM2) {
    const c = centreOf(worst.id);
    console.error(
      `✗ a ${(worst.m2 / 1e4).toFixed(1)} ha pocket near (${c.x}, ${c.z}) is sealed off from the arena`,
    );
    bad = true;
  }
  if (barrierSeen / Math.max(1, barrierPts) < LIMITS.minBarrierDrawn) {
    console.error(
      `✗ ${(100 - (barrierSeen / barrierPts) * 100).toFixed(1)} % of uncrossable barrier length blocks the athlete without appearing in the raster the map draws (ISSprOM 515/518, D-002)`,
    );
    bad = true;
  }

  if (bad) process.exit(1);
  console.log('✓ passability OK');
}

main();
