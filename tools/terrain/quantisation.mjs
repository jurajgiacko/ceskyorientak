#!/usr/bin/env node
/**
 * What the drawing costs the player, in alley widths.
 *
 * Phase 1 built exact vector geometry and D-038 recorded that the class raster
 * is *derived* from it, so the two cannot disagree. That is true and it is a
 * weaker property than being the same shape — and the difference is measured
 * in alley widths, which in Český Krumlov is the whole game.
 *
 * The athlete does not collide against `SprintScene.blockedAt`. `Race.step`'s
 * own `blocked` is `terrain.sample(x, z).runnability === Impassable`, and
 * `FieldTerrain.runnabilityAt` is `blocked?.(x, z) ? Impassable : <the 1 m
 * raster, nearest cell>`. So the effective barrier is the union of
 *
 *  - the vector collider, exact, and
 *  - every 1 m raster cell marked `Impassable`, as a 1 m × 1 m square of world,
 *    where that class was written by widening any feature narrower than the
 *    lattice out to half a cell diagonal (0.707 m) so it appears on the map as
 *    a line rather than as dots.
 *
 * A 0.10 m railing therefore stops the athlete over a band up to 2.4 m wide.
 * This measures what that does to the streets, by walking the town's own paved
 * centrelines and casting perpendicular to each — which is what "alley width"
 * means — under each predicate in turn.
 *
 * Usage: node tools/terrain/quantisation.mjs [--venue=krumlov] [--step=1]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModel, colliders } from './townmodel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const IMPASSABLE = 10;

/** How far a perpendicular cast looks before calling the street open, metres. */
const MAX_HALF_M = 12;
/** How finely it looks. Well under any collider in the venue. */
const PROBE_M = 0.02;
/** An alley, for the purposes of the phase 0 table this compares against. */
const ALLEY_M = 3;

const args = process.argv.slice(2);
const arg = (n, d) => {
  const a = args.find((v) => v.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const venue = arg('venue', 'krumlov');
const alongM = Number(arg('step', '1'));
const dataDir = resolve(ROOT, 'public/data', venue);

const town = JSON.parse(readFileSync(join(dataDir, 'townscape.json'), 'utf8'));
const { header, model } = readModel(dataDir);
const col = colliders(model);

const rMeta = JSON.parse(readFileSync(join(dataDir, 'runnability.json'), 'utf8'));
const rBuf = readFileSync(join(dataDir, 'runnability.bin'));
const raster = new Uint8Array(rBuf.buffer, rBuf.byteOffset, rBuf.length);

/** `TerrainField.runnabilityAt`, exactly — nearest cell, 1 m. */
const rasterAt = (x, z) => {
  const i = Math.round((x - rMeta.originX) / rMeta.resM);
  const j = Math.round((z - rMeta.originZ) / rMeta.resM);
  if (i < 0 || j < 0 || i >= rMeta.width || j >= rMeta.height) return 4;
  return raster[j * rMeta.width + i];
};

/** The two predicates, named for what they are rather than for where they live. */
const vector = (x, z) => col.blockedAt(x, z);
/** `Race.step`'s `blocked`: the model, or the drawing of it. */
const played = (x, z) => col.blockedAt(x, z) || rasterAt(x, z) === IMPASSABLE;

/** Distance from p along (ux,uz) to the first blocked point, or MAX_HALF_M. */
function reach(pred, x, z, ux, uz) {
  for (let d = PROBE_M; d <= MAX_HALF_M; d += PROBE_M) {
    if (pred(x + ux * d, z + uz * d)) return d - PROBE_M;
  }
  return MAX_HALF_M;
}

const R = header.playableR;
const rows = [];
for (const way of town.paved ?? []) {
  if (!way.l || way.l.length < 4) continue;
  // A bridge deck is a second surface and the raster paints its carriageway in
  // by hand; it is not an alley and it is not what this is about.
  if (way.b) continue;
  for (let i = 0; i + 3 < way.l.length; i += 2) {
    const ax = way.l[i];
    const az = way.l[i + 1];
    const bx = way.l[i + 2];
    const bz = way.l[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    // Perpendicular, which is the direction "width" is measured in.
    const px = -uz;
    const pz = ux;
    const n = Math.max(1, Math.round(len / alongM));
    for (let s = 0; s <= n; s++) {
      const t = (s / n) * len;
      const x = ax + ux * t;
      const z = az + uz * t;
      if (Math.abs(x) > R || Math.abs(z) > R) continue;
      // A centreline that runs through a building is OSM routing through a
      // passage the footprint closes. Not an alley being narrowed — a place
      // the athlete already could not stand — so it is out of the population
      // rather than counted as a total loss.
      if (vector(x, z)) continue;
      const vw = reach(vector, x, z, px, pz) + reach(vector, x, z, -px, -pz);
      const pw = played(x, z)
        ? 0
        : reach(played, x, z, px, pz) + reach(played, x, z, -px, -pz);
      rows.push([vw, pw]);
    }
  }
}

const alleys = rows.filter(([vw]) => vw <= ALLEY_M);
const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
const pct = (n, d) => `${((100 * n) / Math.max(1, d)).toFixed(1)} %`;
const med = (a, f) => {
  const v = a.map(f).sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
};

console.log(`\n· ${venue} — what the 1 m drawing costs, on ${rows.length} street-centreline points\n`);
console.log(`  measured perpendicular to the centreline, ${PROBE_M} m probe, ±${MAX_HALF_M} m cast`);
console.log('');
console.log(`  vector corridor, median            ${med(rows, (r) => r[0]).toFixed(2)} m`);
console.log(`  as the athlete meets it, median     ${med(rows, (r) => r[1]).toFixed(2)} m`);
console.log(
  `  width lost, mean                   ${(sum(rows, (r) => r[0] - r[1]) / rows.length).toFixed(2)} m` +
    `   (median ${med(rows, (r) => r[0] - r[1]).toFixed(2)} m)`,
);
console.log(
  `  centreline the athlete cannot stand on: ${rows.filter((r) => r[1] === 0).length} points, ` +
    pct(rows.filter((r) => r[1] === 0).length, rows.length),
);

console.log(`\n  of the ${alleys.length} points in a ≤${ALLEY_M} m corridor (${pct(alleys.length, rows.length)} of the network)\n`);
console.log(`    vector width, median              ${med(alleys, (r) => r[0]).toFixed(2)} m`);
console.log(`    played width, median              ${med(alleys, (r) => r[1]).toFixed(2)} m`);
console.log(
  `    width lost, mean                  ${(sum(alleys, (r) => r[0] - r[1]) / Math.max(1, alleys.length)).toFixed(2)} m`,
);
for (const [lo, hi] of [[0, 0.001], [0.001, 1], [1, 2], [2, 3], [3, 1e9]]) {
  const n = alleys.filter(([, pw]) => pw >= lo && pw < hi).length;
  const label = hi <= 0.001 ? 'sealed' : `${lo}–${hi === 1e9 ? '∞' : hi} m`;
  console.log(`    played width ${label.padEnd(10)} ${String(n).padStart(6)}  ${pct(n, alleys.length)}`);
}

const sealed = alleys.filter(([, pw]) => pw === 0).length;
const halved = alleys.filter(([vw, pw]) => pw > 0 && pw < vw * 0.5).length;
console.log(
  `\n  ${sealed} alley points sealed outright (${pct(sealed, alleys.length)}), ` +
    `${halved} more than halved (${pct(halved, alleys.length)})\n`,
);
