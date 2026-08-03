#!/usr/bin/env node
/**
 * Payload budget gate.
 *
 * The brief is specific: initial load ≤ 15 MB and time-to-first-play ≤ 8 s on
 * 4G. Time-to-first-play is measured by the perf harness; this gate guards the
 * thing that causes it — bytes.
 *
 * "Initial" means what the browser must fetch before the menu is interactive:
 * index.html, its synchronously-imported JS/CSS, and anything in public/ that
 * the shell needs. Terrain, models and textures stream later and are budgeted
 * separately so a big forest cannot quietly blow the first-load number.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../../dist');

const MB = 1024 * 1024;

const BUDGETS = {
  /** Entry JS + CSS the browser blocks on, brotli. The number that gates TTFP. */
  entryBrotliKb: 350,
  /** Everything fetched before first play, uncompressed on disk. */
  initialMb: 15,
  /**
   * Everything on the origin that is not fetched before first play.
   *
   * This is a *hosting* bound, not a per-device one, and the distinction
   * matters now that we ship textures in two formats: `dist/` carries both
   * WebP and KTX2 for all 16 materials, plus three resolution tiers of each,
   * and a device fetches exactly one format at one tier. The number that
   * governs the player's experience is `deviceFetchMb` below.
   */
  streamedMb: 160,
  /**
   * What a single device actually pulls for a race: one texture format, one
   * tier, one venue's terrain, plus models and audio. This is the figure that
   * has to hold on 4G, and the one to defend.
   */
  deviceFetchMb: 25,
};

/**
 * Paths under dist/ that stream in after the menu is interactive.
 *
 * `vendor/` is here because DRACOLoader fetches its decoder on demand, when the
 * first compressed model loads — never during boot. It also holds a JS decoder
 * that exists purely as a fallback for browsers without WASM, so counting it
 * against time-to-first-play would penalise us for a file almost nobody fetches.
 */
const STREAMED = ['data/', 'models/', 'textures/', 'audio/', 'vendor/'];

if (!existsSync(DIST)) {
  console.error('✗ dist/ not found. Run `npm run build` first.');
  process.exit(2);
}

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, rel));
    else out.push({ rel, path: p, bytes: st.size });
  }
  return out;
}

const files = walk(DIST);
const isStreamed = (rel) => STREAMED.some((p) => rel.startsWith(p));

const initial = files.filter((f) => !isStreamed(f.rel));
const streamed = files.filter((f) => isStreamed(f.rel));

const initialBytes = initial.reduce((a, f) => a + f.bytes, 0);
const streamedBytes = streamed.reduce((a, f) => a + f.bytes, 0);

// Entry cost: the HTML plus every JS/CSS asset it references directly.
const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
const entryFiles = initial.filter(
  (f) => f.rel === 'index.html' || referenced.includes(f.rel),
);
const entryBrotli = entryFiles.reduce((a, f) => {
  const buf = readFileSync(f.path);
  return (
    a +
    brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length
  );
}, 0);

let failed = false;
const row = (label, value, budget, unit) => {
  const ok = value <= budget;
  if (!ok) failed = true;
  console.log(
    `${ok ? '✓' : '✗'} ${label.padEnd(28)} ${value.toFixed(1).padStart(8)} ${unit}  (budget ${budget} ${unit})`,
  );
};

/**
 * The exact file set a `low`-tier device pulls for one venue.
 *
 * Must stay in step with `TerrainField.load`. Note that `runnability.bin` is
 * *not* the downsampled variant and there is no longer a downsampled variant to
 * pick: a tier is a rendering budget, so the heightmap gets cheaper on a phone
 * and the class raster — which is the passability the map, the course generator
 * and collision all read — does not. See the comment on `TerrainField.load`.
 */
const LOW_TIER_TERRAIN = [
  'height-low.bin', 'height-low.json',
  'runnability.bin', 'runnability.json',
  'canopy.bin', 'canopy.json',
  /**
   * The town's vector model and the passable space derived from it. Both are
   * per-venue, both are fetched by `SprintScene.load` on every tier, and
   * neither was counted here — phase 1 added the first and phase 2 the second,
   * and a device-fetch estimate that quietly omits 1.5 MB is not an estimate.
   * `townscape.json` is counted for the same reason: `loadTownscape` fetches
   * it before the scene can be built.
   */
  'townmodel.bin', 'townmodel.json',
  'passable.bin', 'passable.json',
  'townscape.json',
];

/**
 * Estimate what one mid-range phone actually downloads for one race:
 * the 512px tier, KTX2 only, one venue's terrain at the low-tier file set,
 * models and audio.
 *
 * Measured from the files themselves rather than assumed, so it tracks reality
 * as the asset set grows.
 */
function deviceFetchBytes() {
  const oneOf = (pred) => streamed.filter(pred).reduce((a, f) => a + f.bytes, 0);
  const textures = oneOf(
    (f) => f.rel.startsWith('textures/') && f.rel.endsWith('.ktx2') && f.rel.includes('@512'),
  );
  // Only the venue the phone is racing, and only the files that venue's low
  // tier actually asks for. Averaged over the venues so adding a third does not
  // inflate what any one device fetches.
  const terrainAll = streamed.filter(
    (f) => f.rel.startsWith('data/') && LOW_TIER_TERRAIN.includes(f.rel.split('/')[2] ?? ''),
  );
  const venues = new Set(terrainAll.map((f) => f.rel.split('/')[1]));
  const terrain = venues.size
    ? terrainAll.reduce((a, f) => a + f.bytes, 0) / venues.size
    : 0;
  const models = oneOf((f) => f.rel.startsWith('models/'));
  const audio = oneOf((f) => f.rel.startsWith('audio/'));
  return textures + terrain + models + audio;
}

console.log('Payload budget\n');
row('entry (brotli)', entryBrotli / 1024, BUDGETS.entryBrotliKb, 'kB');
row('initial load', initialBytes / MB, BUDGETS.initialMb, 'MB');
row('device fetch (1 race)', deviceFetchBytes() / MB, BUDGETS.deviceFetchMb, 'MB');
row('total on origin', streamedBytes / MB, BUDGETS.streamedMb, 'MB');

console.log('\nLargest initial files:');
for (const f of [...initial].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  const g = extname(f.rel).match(/\.(js|css|html|json|svg)$/)
    ? ` (gzip ${(gzipSync(readFileSync(f.path)).length / 1024).toFixed(1)} kB)`
    : '';
  console.log(`   ${(f.bytes / 1024).toFixed(1).padStart(9)} kB  ${f.rel}${g}`);
}

console.log(failed ? '\n✗ PAYLOAD BUDGET FAILED' : '\n✓ payload budget OK');
process.exit(failed ? 1 : 0);
