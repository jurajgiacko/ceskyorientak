#!/usr/bin/env node
/**
 * Sprint course-setting harness.
 *
 * Generates Krumlov sprints over many seeds against the **real** venue data —
 * the shipped runnability raster, the OSM footprints, the uncrossable barriers
 * and the paved network — and reports the two distributions that decide whether
 * this is a sprint or a cross-country run with a castle in the background:
 *
 *   1. **Course length.** A sprint is 1.5–2.0 km straight-line for a 13–15
 *      minute winning time. Krumlov used to come out at 2.7–4.3 km.
 *   2. **Distance from the paved network.** A sprint control is a stride or two
 *      off a runnable way. A control 40 m out in a meadow is the thing the
 *      client complained about, and it is invisible to every other gate.
 *
 * It also prints the column D histogram, because "re-entrant" and "thicket" in
 * a town is the same fault showing up in the description sheet.
 *
 * This runs offline in a second and is where the tuning was done. The binding
 * assertions live in `tools/ci/check-race.mjs`, against the real runtime.
 *
 * Usage: node tools/sim/sprint-check.mjs [--seeds=24] [--svg=out.svg]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'public/data/krumlov');
const IMPASSABLE = 10;
const ARENA = { x: 0, z: 0 };

const { build } = await import('vite');
async function load(entry) {
  const out = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': join(ROOT, 'src') } },
    build: {
      write: false,
      lib: { entry: join(ROOT, entry), formats: ['es'], fileName: 'm' },
      rollupOptions: { external: ['three'] },
    },
  });
  const p = `/tmp/sc_${Math.abs([...entry].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}.mjs`;
  writeFileSync(p, out[0].output[0].code);
  return import(p);
}

const { FieldTerrain } = await load('src/race/terrainAdapter.ts');
const { buildUrbanFeatures } = await load('src/race/urbanFeatures.ts');
const { setCourse } = await load('src/race/courseSetup.ts');

// ---------------------------------------------------------------------------
// The venue, exactly as the runtime sees it
// ---------------------------------------------------------------------------

const rMeta = JSON.parse(readFileSync(join(DIR, 'runnability.json'), 'utf8'));
const runnability = new Uint8Array(readFileSync(join(DIR, 'runnability.bin')));
const hMeta = JSON.parse(readFileSync(join(DIR, 'height.json'), 'utf8'));
const hRaw = readFileSync(join(DIR, 'height.bin'));
const hBuf = new Uint16Array(hRaw.buffer, hRaw.byteOffset, hRaw.length / 2);
const town = JSON.parse(readFileSync(join(DIR, 'townscape.json'), 'utf8'));

function pointInFlatRing(p, x, z) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Mirrors WALL_SPEC in src/world/townscape.ts, as check-passable does. */
const WALL_THICK = { 0: 0.45, 1: 1.15, 2: 0.6, 3: 0.1, 4: 0.95 };

class Colliders {
  constructor(t) {
    this.cell = 12;
    this.rings = new Map();
    this.segs = new Map();
    this.ringData = [];
    this.segData = [];
    for (const b of t.buildings) if (b.p.length >= 6) this.addRing(b.p);
    for (const w of t.walls) {
      const thick = WALL_THICK[w.k];
      if (thick === undefined || !w.u) continue;
      const half = thick * 0.5 + 0.25;
      const n = w.p.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const ax = w.p[i * 2], az = w.p[i * 2 + 1], bx = w.p[i * 2 + 2], bz = w.p[i * 2 + 3];
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
    this.index(this.segs, idx, Math.min(ax, bx) - half, Math.min(az, bz) - half,
      Math.max(ax, bx) + half, Math.max(az, bz) + half);
  }
  index(map, idx, minX, minZ, maxX, maxZ) {
    for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++)
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
        const key = cx * 100003 + cz;
        let l = map.get(key);
        if (!l) { l = []; map.set(key, l); }
        l.push(idx);
      }
  }
  inBuilding(x, z) {
    const l = this.rings.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!l) return false;
    for (const i of l) if (pointInFlatRing(this.ringData[i], x, z)) return true;
    return false;
  }
  inBarrier(x, z) {
    const l = this.segs.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!l) return false;
    for (const i of l) {
      const [ax, az, bx, bz, half] = this.segData[i];
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x, pz = az + dz * t - z;
      if (px * px + pz * pz <= half * half) return true;
    }
    return false;
  }
}

const col = new Colliders(town);
const blockedAt = (x, z) => col.inBuilding(x, z) || col.inBarrier(x, z);

const cellOf = (x, z, m) => {
  const i = Math.round((x - m.originX) / m.resM);
  const j = Math.round((z - m.originZ) / m.resM);
  if (i < 0 || j < 0 || i >= m.width || j >= m.height) return -1;
  return j * m.width + i;
};

/** Just enough of `TerrainField` for `FieldTerrain`. */
const field = {
  runnability,
  rMeta,
  spanX: (hMeta.width - 1) * hMeta.resM,
  spanZ: (hMeta.height - 1) * hMeta.resM,
  minX: hMeta.originX,
  minZ: hMeta.originZ,
  heightAt(x, z) {
    const i = cellOf(x, z, hMeta);
    return i < 0 ? hMeta.minH : hMeta.minH + (hBuf[i] / 65535) * (hMeta.maxH - hMeta.minH);
  },
  runnabilityAt(x, z) {
    const i = cellOf(x, z, rMeta);
    return i < 0 ? IMPASSABLE : runnability[i];
  },
  canopyAt() {
    return 0;
  },
  sample(x, z) {
    return { runnability: this.runnabilityAt(x, z), height: this.heightAt(x, z), slope: 0, canopy: 0 };
  },
};

const venue = {
  id: 'krumlov',
  origin: { lon: 14.315, lat: 48.8109 },
  sizeX: 1200,
  sizeZ: 1200,
  mapScale: 4000,
  contourInterval: 2,
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const nSeeds = Number((args.find((a) => a.startsWith('--seeds=')) ?? '--seeds=16').slice(8));
const svgPath = (args.find((a) => a.startsWith('--svg=')) ?? '').slice(6);

const tIdx0 = performance.now();
const features = buildUrbanFeatures(town);
const tIdx = performance.now() - tIdx0;
console.log(
  `urban features: ${features.stats.features} over ${features.stats.pavedSegments} paved segments ` +
    `(${tIdx.toFixed(0)} ms)`,
);
console.log(
  '  ' +
    Object.entries(features.stats.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(' · '),
);
console.log('');

// Menu-shaped seeds: the menu seeds with `(Date.now() / 60000) | 0`.
const seeds = [];
for (let i = 0; i < nSeeds; i++) seeds.push(29_760_961 + i * 1013);

const lengths = [];
const controlCounts = [];
const pavedAll = [];
const dHist = new Map();
const setupMs = [];
let first = null;
let doglegs = 0;
let tightTurns = 0;
let legTotal = 0;

// One terrain for the whole run, as the game has one per race: `bakedRaster`
// and the reachability flood are per-venue work, not per-seed, and timing them
// once per seed would report the venue's cost as the course setter's.
const terrain = new FieldTerrain(field, { blocked: blockedAt, urban: true, features });
const tR0 = performance.now();
const reach = terrain.buildReachability(ARENA);
console.log(
  `reachability: ${(reach.fraction * 100).toFixed(1)} % of open ground, ${(performance.now() - tR0).toFixed(0)} ms\n`,
);

for (const seed of seeds) {
  const t0 = performance.now();
  const set = setCourse(terrain, { venue, discipline: 'sprint', seed, arena: ARENA });
  setupMs.push(performance.now() - t0);
  const c = set.course;
  lengths.push(c.lengthM);
  controlCounts.push(c.controls.length);
  const paved = c.controls.map((k) => features.pavedDistance(k.position.x, k.position.z, 60));
  pavedAll.push(...paved);
  for (const k of c.controls) dHist.set(k.description.d, (dHist.get(k.description.d) ?? 0) + 1);

  // Dog-legs: arriving and leaving a control on nearly the same line lets
  // following runners see it, and the rules discourage it (RESEARCH-SPORT §7).
  const pts = [c.start, ...c.controls.map((k) => k.position), c.finish];
  for (let i = 1; i < pts.length - 1; i++) {
    const inB = Math.atan2(pts[i].x - pts[i - 1].x, -(pts[i].z - pts[i - 1].z));
    const outB = Math.atan2(pts[i + 1].x - pts[i].x, -(pts[i + 1].z - pts[i].z));
    let turn = Math.abs(((outB - inB + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    turn = (turn * 180) / Math.PI;
    legTotal++;
    if (turn < 40) tightTurns++;
    if (turn < 20) doglegs++;
  }
  if (!first) first = { course: c, terrain };
  console.log(
    `seed ${String(seed).padStart(9)} · ${String(c.controls.length).padStart(2)} controls · ` +
      `${String(c.lengthM).padStart(4)} m · ${String(c.climbM).padStart(3)} m climb · ` +
      `paved med ${median(paved).toFixed(1)} m / max ${Math.max(...paved).toFixed(1)} m · ` +
      `escape ${set.tightestEscapeM2 === Infinity ? 'open' : `${set.tightestEscapeM2} m²`} · ` +
      `${set.seedsTried} seed(s) · ${setupMs[setupMs.length - 1].toFixed(0)} ms`,
  );
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

console.log('');
console.log(`length      min ${Math.min(...lengths)} · median ${median(lengths)} · max ${Math.max(...lengths)} m`);
console.log(`controls    min ${Math.min(...controlCounts)} · median ${median(controlCounts)} · max ${Math.max(...controlCounts)}`);
console.log(
  `paved dist  median ${median(pavedAll).toFixed(1)} · p90 ${pct(pavedAll, 0.9).toFixed(1)} · ` +
    `max ${Math.max(...pavedAll).toFixed(1)} m  (${pavedAll.length} controls)`,
);
const buckets = [0, 2, 5, 10, 20, 40, 1e9];
const labels = ['0–2 m', '2–5 m', '5–10 m', '10–20 m', '20–40 m', '>40 m'];
for (let i = 0; i < labels.length; i++) {
  const n = pavedAll.filter((d) => d >= buckets[i] && d < buckets[i + 1]).length;
  const bar = '█'.repeat(Math.round((n / pavedAll.length) * 40));
  console.log(`  ${labels[i].padEnd(8)} ${String(n).padStart(4)}  ${bar}`);
}
console.log(
  `column D    ` +
    [...dHist].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '),
);
console.log(
  `turns       ${tightTurns}/${legTotal} under 40° · ${doglegs} dog-legs (under 20°)`,
);
console.log(`setup       median ${median(setupMs).toFixed(0)} ms · max ${Math.max(...setupMs).toFixed(0)} ms`);

if (svgPath && first) {
  writeFileSync(svgPath, courseSvg(first.course));
  console.log(`\nwrote ${svgPath}`);
}

/** A crude plan of the course over the footprints, for eyeballing. */
function courseSvg(c) {
  const R = 420;
  const s = 900 / (2 * R);
  const px = (x) => (x + R) * s;
  const pz = (z) => (z + R) * s;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900"><rect width="900" height="900" fill="#fff"/>`];
  for (const b of town.buildings) {
    const pts = [];
    for (let i = 0; i < b.p.length; i += 2) pts.push(`${px(b.p[i]).toFixed(1)},${pz(b.p[i + 1]).toFixed(1)}`);
    parts.push(`<polygon points="${pts.join(' ')}" fill="#333"/>`);
  }
  for (const w of town.paved) {
    const pts = [];
    for (let i = 0; i < w.l.length; i += 2) pts.push(`${px(w.l[i]).toFixed(1)},${pz(w.l[i + 1]).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#c80" stroke-width="${Math.max(0.6, w.w * s)}"/>`);
  }
  for (const w of town.walls) {
    if (!w.u) continue;
    const pts = [];
    for (let i = 0; i < w.p.length; i += 2) pts.push(`${px(w.p[i]).toFixed(1)},${pz(w.p[i + 1]).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#000" stroke-width="1.4"/>`);
  }
  const pts = [c.start, ...c.controls.map((k) => k.position), c.finish];
  parts.push(
    `<polyline points="${pts.map((p) => `${px(p.x).toFixed(1)},${pz(p.z).toFixed(1)}`).join(' ')}" fill="none" stroke="#a0f" stroke-width="1.6"/>`,
  );
  parts.push(`<polygon points="${px(c.start.x)},${pz(c.start.z) - 9} ${px(c.start.x) - 8},${pz(c.start.z) + 5} ${px(c.start.x) + 8},${pz(c.start.z) + 5}" fill="none" stroke="#a0f" stroke-width="1.6"/>`);
  c.controls.forEach((k, i) => {
    parts.push(`<circle cx="${px(k.position.x).toFixed(1)}" cy="${pz(k.position.z).toFixed(1)}" r="${(20 * s).toFixed(1)}" fill="none" stroke="#a0f" stroke-width="1.6"/>`);
    parts.push(`<text x="${(px(k.position.x) + 10).toFixed(1)}" y="${(pz(k.position.z) - 8).toFixed(1)}" font-family="sans-serif" font-size="12" fill="#a0f">${i + 1}</text>`);
  });
  parts.push(`<circle cx="${px(c.finish.x).toFixed(1)}" cy="${pz(c.finish.z).toFixed(1)}" r="${(24 * s).toFixed(1)}" fill="none" stroke="#a0f" stroke-width="1.6"/>`);
  parts.push('</svg>');
  return parts.join('\n');
}
