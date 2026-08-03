#!/usr/bin/env node
/**
 * PHASE 0 SPIKE — throwaway. What resolution does the fallback raster need?
 *
 * §6 phase 0's fallback, if vector collision had failed the frame budget, is
 * "vector for the map and the graph, a fine raster *derived from it* for
 * per-frame collision". This measures what "fine" has to be, and it measures it
 * the way D-027 should have been measured before 4 m shipped: not by asserting
 * a Nyquist rule about a 2 m alley, but by deriving the raster at each candidate
 * cell size from the vector model and then asking the town whether it still
 * connects.
 *
 * Two numbers per resolution, and the second is the one that matters:
 *
 *  - **Passable area kept.** Coarse cells eat alleys from both sides.
 *  - **Street network reachable from the arena.** Every paved centreline point
 *    in `townscape.json`, flood-filled from Náměstí Svornosti through the
 *    derived raster. This is the town's own answer to "can you get anywhere",
 *    it is exactly the quantity that read 49% impassable and 30% connected in
 *    D-027, and it is a property of the streets rather than of the grid.
 *
 * Plus the honesty check the architecture actually rests on: sample the vector
 * model and the derived raster at the same points and count where they differ.
 * "Derived, so the two cannot disagree" is true about their *source*, not about
 * their answers — sampling is lossy, and the residual is worth a number.
 *
 * Usage:
 *   node tools/perf/collision-raster.mjs [--cells 2,1,0.5,0.25] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildModel } from './collision-bench.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CELLS = argOf('--cells', '4,2,1,0.75,0.5,0.25').split(',').map(Number);
const jsonOut = argOf('--json', '');

const town = JSON.parse(readFileSync(resolve(ROOT, 'public/data/krumlov/townscape.json'), 'utf8'));
const model = buildModel(town, { cellM: 12, barriers: 'all' });

/** `SprintScene`'s arena — Náměstí Svornosti, where the prologue starts. */
const ARENA = { x: 1, z: 24 };
/** The playable square. `manifest.json` puts it at 1200 m; the rest is skirt. */
const HALF = 600;

const pad = (s, n) => String(s).padEnd(n);

// ---------------------------------------------------------------------------
// The street network, as points to be reached
// ---------------------------------------------------------------------------

/**
 * Every paved way's centreline, sampled every metre.
 *
 * Not the junctions and not the ways — the *points a runner would be standing
 * on*. A way counts as severed if its middle is unreachable even though both
 * ends are fine, which is precisely how a 4 m grid closes an alley.
 */
const street = [];
for (const way of town.paved ?? []) {
  const l = way.l;
  for (let i = 0; i + 3 < l.length; i += 2) {
    const ax = l[i];
    const az = l[i + 1];
    const bx = l[i + 2];
    const bz = l[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(len));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (Math.abs(x) <= HALF && Math.abs(z) <= HALF) street.push(x, z);
    }
  }
}
const streetN = street.length / 2;

// The vector model's own verdict on those points, which is the target every
// raster is trying to reproduce. A street point the vector model itself calls
// blocked is a data fault, not a resolution fault, and must not be charged to
// the grid.
let streetOpenVec = 0;
for (let i = 0; i < streetN; i++) {
  if (!model.blockedAt(street[i * 2], street[i * 2 + 1])) streetOpenVec++;
}

console.log('\n═══ DERIVED RASTER — what resolution a 2 m alley needs ═══\n');
console.log(`  street centreline points sampled at 1 m: ${streetN.toLocaleString()}`);
console.log(
  `  of those, open in the vector model: ${streetOpenVec.toLocaleString()} ` +
    `(${((streetOpenVec / streetN) * 100).toFixed(1)}%) — the ceiling any raster can reach\n`,
);

// ---------------------------------------------------------------------------
// Derive, flood, measure
// ---------------------------------------------------------------------------

const rows = [];
console.log(
  `  ${pad('cell m', 8)} ${pad('grid', 12)} ${pad('open %', 8)} ${pad('street open %', 14)} ` +
    `${pad('street reachable %', 19)} ${pad('1-bit kB', 9)} ${pad('gz kB', 7)} derive ms`,
);

for (const c of CELLS) {
  const w = Math.ceil((HALF * 2) / c) + 1;
  const h = w;
  const t0 = process.hrtime.bigint();
  // 1 = open. Derived from the vector model by centre sampling, which is what
  // "derived" means in practice and is where the loss enters.
  const open = new Uint8Array(w * h);
  let openN = 0;
  for (let j = 0; j < h; j++) {
    const z = -HALF + j * c;
    for (let i = 0; i < w; i++) {
      if (!model.blockedAt(-HALF + i * c, z)) {
        open[j * w + i] = 1;
        openN++;
      }
    }
  }
  const deriveMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Flood from the arena, 4-connected — the connectivity a runner has, and the
  // same one `buildReachability` uses.
  const seen = new Uint8Array(w * h);
  const si = Math.round((ARENA.x + HALF) / c);
  const sj = Math.round((ARENA.z + HALF) / c);
  let reachN = 0;
  if (open[sj * w + si]) {
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = sj * w + si;
    seen[sj * w + si] = 1;
    while (sp > 0) {
      const k = stack[--sp];
      reachN++;
      const i = k % w;
      const j = (k - i) / w;
      if (i > 0 && open[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (i < w - 1 && open[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (j > 0 && open[k - w] && !seen[k - w]) { seen[k - w] = 1; stack[sp++] = k - w; }
      if (j < h - 1 && open[k + w] && !seen[k + w]) { seen[k + w] = 1; stack[sp++] = k + w; }
    }
  }

  // Score the streets against this raster.
  let streetOpen = 0;
  let streetReach = 0;
  let disagree = 0;
  for (let n = 0; n < streetN; n++) {
    const x = street[n * 2];
    const z = street[n * 2 + 1];
    const i = Math.round((x + HALF) / c);
    const j = Math.round((z + HALF) / c);
    const k = j * w + i;
    const rOpen = i >= 0 && i < w && j >= 0 && j < h && open[k] === 1;
    if (rOpen) streetOpen++;
    if (rOpen && seen[k]) streetReach++;
    if (rOpen === model.blockedAt(x, z)) disagree++;
  }

  const bits = Math.ceil((w * h) / 8);
  // The bitmask packed, so the shipped size is the shipped size.
  const packed = new Uint8Array(bits);
  for (let k = 0; k < w * h; k++) if (open[k]) packed[k >> 3] |= 1 << (k & 7);
  const gz = gzipSync(packed, { level: 9 }).length;

  const row = {
    cellM: c,
    w,
    h,
    cells: w * h,
    openPct: (openN / (w * h)) * 100,
    streetOpenPct: (streetOpen / streetN) * 100,
    streetReachPct: (streetReach / streetN) * 100,
    reachCells: reachN,
    disagreePct: (disagree / streetN) * 100,
    bitKb: bits / 1024,
    byteKb: (w * h) / 1024,
    gzKb: gz / 1024,
    deriveMs,
  };
  rows.push(row);
  console.log(
    `  ${pad(c, 8)} ${pad(`${w}×${h}`, 12)} ${pad(row.openPct.toFixed(1), 8)} ` +
      `${pad(row.streetOpenPct.toFixed(1), 14)} ${pad(row.streetReachPct.toFixed(1), 19)} ` +
      `${pad(row.bitKb.toFixed(0), 9)} ${pad(row.gzKb.toFixed(0), 7)} ${deriveMs.toFixed(0)}`,
  );
}

console.log('\n  street reachable % is the D-027 measurement: of the town\'s own street');
console.log('  centrelines, how many can a runner actually get to from the arena.');
console.log(
  `  The vector model reaches ${((streetOpenVec / streetN) * 100).toFixed(1)}% open; ` +
    'anything a raster loses below that, it lost to its own resolution.',
);

// ---------------------------------------------------------------------------
// v1's shipped raster, for the comparison the recommendation needs
// ---------------------------------------------------------------------------

const meta = JSON.parse(readFileSync(resolve(ROOT, 'public/data/krumlov/runnability.json'), 'utf8'));
const binBytes = readFileSync(resolve(ROOT, 'public/data/krumlov/runnability.bin')).length;
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'public/data/krumlov/manifest.json'), 'utf8'));
const gzShipped = manifest.files.find((f) => f.file === 'runnability.bin')?.gzipBytes ?? null;

console.log('\n═══ AGAINST v1\'s SHIPPED RASTER ═══\n');
console.log(`  runnability.bin  ${meta.width}×${meta.height} @ ${meta.resM} m, uint8 (11 classes)`);
console.log(`                   ${(binBytes / 1024).toFixed(0)} kB raw · ${gzShipped ? (gzShipped / 1024).toFixed(0) : '?'} kB gzipped`);
console.log('  It is a class raster and carries the speed model, so it stays either way.');
console.log('  A derived collision raster is 1 bit and is additional, not a replacement.\n');

if (jsonOut) {
  writeFileSync(resolve(ROOT, jsonOut), JSON.stringify({ streetN, streetOpenVec, rows, v1: { ...meta, binBytes, gzShipped } }, null, 2));
  console.log(`  written: ${jsonOut}\n`);
}
