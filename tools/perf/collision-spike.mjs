#!/usr/bin/env node
/**
 * PHASE 0 SPIKE — throwaway. Drives tools/perf/collision-bench.mjs under Node.
 *
 * Answers the second of phase 0's two questions (docs/PLAN-KRUMLOV-V2.md §6):
 * can a broadphase grid over Krumlov's full vector set answer `blockedAt` well
 * inside the frame budget on the low tier? This half is the desk measurement;
 * `collision-spike-chrome.mjs` runs the same module under a CPU-throttled
 * headless Chrome, which is this project's own mid-range-Android proxy
 * (tools/perf/budget.mjs sets `Emulation.setCPUThrottlingRate: 4`).
 *
 * Usage:
 *   node tools/perf/collision-spike.mjs [--json out.json] [--sweep]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, makePoints, benchMean, benchTail, benchFrames } from './collision-bench.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const jsonOut = argOf('--json', '');
const sweep = args.includes('--sweep');

const town = JSON.parse(readFileSync(resolve(ROOT, 'public/data/krumlov/townscape.json'), 'utf8'));

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(d));

// ---------------------------------------------------------------------------
// 1. The set, stated before anything is timed
// ---------------------------------------------------------------------------

const full = buildModel(town, { cellM: 12, barriers: 'all' });
const v1 = buildModel(town, { cellM: 12, barriers: 'uncrossable' });

console.log('\n═══ KRUMLOV VECTOR COLLIDER SET ═══\n');
const s = full.stats;
console.log(`  building rings          ${pad(s.rings, 8)} (${s.ringVerts} vertices)`);
console.log(`  barrier segments        ${pad(s.segments, 8)} (v2, drawn ≡ solid — every barrier way)`);
console.log(`  barrier segments (v1)   ${pad(v1.stats.segments, 8)} (only ways tagged uncrossable)`);
console.log(`  bridge deck segments    ${pad(s.deckSegments, 8)} (the one exemption)`);
console.log(`  water area rings        ${pad(s.waterAreas, 8)} (${s.waterAreaVerts} vertices)`);
console.log(`  water course segments   ${pad(s.waterCourseSegments, 8)}`);
console.log(`  ─────────────────────────────────`);
console.log(`  primitives total        ${pad(s.primitives, 8)}`);
console.log(`  packed geometry         ${(s.geometryBytes / 1024).toFixed(0)} kB`);

console.log('\n  broadphase occupancy at cellM=12 (candidates examined per hit cell)');
console.log(`  ${pad('grid', 16)} ${pad('cells', 8)} ${pad('entries', 9)} ${pad('mean', 7)} ${pad('p50', 6)} ${pad('p99', 6)} max`);
for (const [k, g] of Object.entries(s.grids)) {
  console.log(
    `  ${pad(k, 16)} ${pad(g.cells, 8)} ${pad(g.entries, 9)} ${pad(num(g.meanPerCell, 2), 7)} ${pad(g.p50, 6)} ${pad(g.p99, 6)} ${g.max}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Throughput, per query pattern
// ---------------------------------------------------------------------------

const PATTERNS = ['athlete', 'scatter', 'scan'];
const N = 200000;
// The sweep gets a point per square metre of the venue — 1201², which is what
// `bakedRaster` actually walks — so its stride and its coverage are both the
// real ones. The other two patterns are sequences, not grids, and 200 k of each
// is already far more than any frame or any load issues.
const N_SCAN = 1201 * 1201;
const points = Object.fromEntries(
  PATTERNS.map((p) => [p, makePoints(p, p === 'scan' ? N_SCAN : N)]),
);

// What fraction of each pattern's points are actually blocked — a benchmark
// that only ever probes open ground measures the early-out and nothing else.
console.log('\n  blocked fraction by pattern (the predicate must be exercised, not skipped)');
for (const p of PATTERNS) {
  const { xs, zs } = points[p];
  let hit = 0;
  for (let i = 0; i < xs.length; i++) if (full.blockedAt(xs[i], zs[i])) hit++;
  console.log(`  ${pad(p, 10)} ${((hit / xs.length) * 100).toFixed(1)}% blocked`);
}

console.log('\n═══ THROUGHPUT — Node ' + process.version + ' on this desk ═══\n');
console.log(`  ${pad('model', 22)} ${pad('pattern', 10)} ${pad('mean ns', 9)} ${pad('p50 ns', 8)} ${pad('p99 ns', 8)} ${pad('p99.9 ns', 9)} max ns`);

const results = { host: 'node', version: process.version, set: s, rows: [] };
const models = [
  ['v2 all barriers', full],
  ['v1 uncrossable only', v1],
];
for (const [label, m] of models) {
  for (const p of PATTERNS) {
    const mean = benchMean(m.blockedAt, points[p], p === 'scan' ? 1 : 5);
    const tail = benchTail(m.blockedAt, makePoints(p, p === 'scan' ? N_SCAN : 200000, 999));
    console.log(
      `  ${pad(label, 22)} ${pad(p, 10)} ${pad(num(mean.nsPerQuery), 9)} ${pad(num(tail.p50Ns), 8)} ${pad(num(tail.p99Ns), 8)} ${pad(num(tail.p999Ns), 9)} ${num(tail.maxNs)}`,
    );
    // `batchMeanNs` is the untimed-loop mean and is the number the budget uses;
    // `tail.meanNs` is the block-timed mean and exists only to show how close
    // the instrumented loop stays to the uninstrumented one.
    results.rows.push({ model: label, pattern: p, ...tail, batchMeanNs: mean.nsPerQuery });
  }
}
console.log(
  `\n  tail columns are per-query over blocks of ${results.rows[0].blockSize}; ` +
    `${num(results.rows[0].overheadNs)} ns/query of clock overhead already subtracted.`,
);
console.log(
  '  `max` is the scheduler and the GC, not the collider — at 1 in 200 000 it is the OS taking the core.',
);

// ---------------------------------------------------------------------------
// 3. Per-frame cost, which is what the budget is about
// ---------------------------------------------------------------------------

console.log('\n═══ PER-FRAME COST — athlete locality ═══\n');
console.log(`  ${pad('queries/frame', 14)} ${pad('mean ms', 9)} ${pad('p99 ms', 9)} % of 33.3 ms`);
const frameRows = [];
for (const q of [2, 8, 32, 128]) {
  const f = benchFrames(full.blockedAt, points.athlete, q, 20000);
  console.log(
    `  ${pad(q, 14)} ${pad(f.meanMs.toFixed(4), 9)} ${pad(f.p99Ms.toFixed(4), 9)} ${((f.p99Ms / 33.3) * 100).toFixed(3)}%`,
  );
  frameRows.push(f);
}
results.frames = frameRows;

// ---------------------------------------------------------------------------
// 4. Load-time batches — what the generator actually costs
// ---------------------------------------------------------------------------

console.log('\n═══ LOAD-TIME BATCHES ═══\n');
const scanCells = 1601 * 1601;
const scanNs = results.rows.find((r) => r.model === 'v2 all barriers' && r.pattern === 'scan').meanNs;
const scatNs = results.rows.find((r) => r.model === 'v2 all barriers' && r.pattern === 'scatter').meanNs;
console.log(`  bakedRaster sweep   ${scanCells.toLocaleString()} cells × ${num(scanNs)} ns = ${((scanCells * scanNs) / 1e6).toFixed(0)} ms`);
console.log(`  reachability fill   ~${(1201 * 1201 * 2).toLocaleString()} edge probes × ${num(scanNs)} ns = ${((1201 * 1201 * 2 * scanNs) / 1e6).toFixed(0)} ms`);
for (const n of [10000, 100000, 1000000]) {
  console.log(`  generator probes    ${pad(n.toLocaleString(), 10)} scattered × ${num(scatNs)} ns = ${((n * scatNs) / 1e6).toFixed(1)} ms`);
}
results.loadTime = { scanCells, scanNs, scatNs };

// ---------------------------------------------------------------------------
// 5. Cell-size sweep — 12 m was chosen for footprints, never for barriers
// ---------------------------------------------------------------------------

if (sweep) {
  console.log('\n═══ BROADPHASE CELL SIZE SWEEP (v2 set) ═══\n');
  console.log(`  ${pad('cellM', 7)} ${pad('grid entries', 13)} ${pad('athlete ns', 11)} ${pad('scatter ns', 11)} scan ns`);
  results.sweep = [];
  for (const cellM of [3, 4, 6, 8, 12, 16, 24, 32]) {
    const m = buildModel(town, { cellM, barriers: 'all' });
    const entries = Object.values(m.stats.grids).reduce((a, g) => a + g.entries, 0);
    const a = benchMean(m.blockedAt, points.athlete, 5).nsPerQuery;
    const sc = benchMean(m.blockedAt, points.scatter, 5).nsPerQuery;
    const sn = benchMean(m.blockedAt, points.scan, 5).nsPerQuery;
    console.log(`  ${pad(cellM, 7)} ${pad(entries.toLocaleString(), 13)} ${pad(num(a), 11)} ${pad(num(sc), 11)} ${num(sn)}`);
    results.sweep.push({ cellM, entries, athleteNs: a, scatterNs: sc, scanNs: sn });
  }
}

if (jsonOut) {
  writeFileSync(resolve(ROOT, jsonOut), JSON.stringify(results, null, 2));
  console.log(`\n  written: ${jsonOut}`);
}
console.log('');
