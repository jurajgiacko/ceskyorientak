#!/usr/bin/env node
/**
 * PHASE 0 SPIKE — throwaway. How many `blockedAt` calls does a frame make?
 *
 * The throughput spike answers "nanoseconds per query". Multiplying that into a
 * frame budget needs the other factor, and the plan states it only as "several
 * times per frame per moving body". Several is not a number, and the difference
 * between 2 and 200 is the difference between a verdict and a guess — so this
 * counts them in the shipping runtime instead of reading the movement code and
 * hoping nothing else calls it.
 *
 * It wraps `window.__world.blockedAt` with a counter and drives the race through
 * `RaceController.autopilot`, exactly as tools/sim/play-leg.mjs does. Two things
 * get counted separately, because they are budgeted separately:
 *
 *   - **setup** — everything before the first step: `bakedRaster`'s sweep of the
 *     venue and `buildReachability`'s fill. Thousands to millions, once.
 *   - **per step** — the steady state, which is what the 33.3 ms budget is about.
 *
 * It reads a prebuilt `dist/`. `--dist` points at one; the default is this
 * worktree's, which will not exist unless someone has built here. Nothing is
 * written and nothing is modified — it serves the directory read-only.
 *
 * Usage:
 *   node tools/perf/collision-callcount.mjs [--dist /path/to/dist] [--steps 600]
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from '../ci/chrome.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DIST = resolve(argOf('--dist', resolve(ROOT, 'dist')));
const STEPS = Number(argOf('--steps', '600'));

if (!existsSync(DIST)) {
  console.error(`✗ no dist at ${DIST} — pass --dist /path/to/an/existing/dist`);
  process.exit(2);
}

/**
 * Install the counter, then run the race a step at a time.
 *
 * The wrapper goes on after the race has mounted, so the setup batches are
 * already spent — they are recovered separately below by counting from a fresh
 * page load instead. `autopilot(1, dt)` is one simulation step, which is one
 * frame's worth of movement, which is the unit the budget is denominated in.
 */
const COUNT = (steps) => `(async () => {
  const w = window.__world, r = window.__race;
  const inner = w.blockedAt.bind(w);
  let n = 0;
  w.blockedAt = (x, z) => { n++; return inner(x, z); };
  // The athlete's calls are caught too: RaceController passes the blocker as
  // \`(x, z) => host.blockedAt(x, z)\` (src/race/controller.ts:211), which looks
  // the property up at call time rather than capturing it, so replacing it on
  // the scene is enough. If that ever becomes a captured reference this count
  // silently drops to the free camera's two per frame — which is why the
  // per-step p50 is printed rather than only the mean.
  const per = [];
  for (let i = 0; i < ${steps}; i++) {
    const before = n;
    r.autopilot(1, 1 / 60);
    per.push(n - before);
  }
  per.sort((a, b) => a - b);
  const sum = per.reduce((a, b) => a + b, 0);
  return JSON.stringify({
    steps: per.length,
    total: sum,
    mean: sum / per.length,
    p50: per[Math.floor(per.length * 0.5)],
    p99: per[Math.floor(per.length * 0.99)],
    max: per[per.length - 1],
    zero: per.filter((v) => v === 0).length,
  });
})()`;

/**
 * Setup cost, counted from the earliest moment the scene exists.
 *
 * Polls for `window.__world` and wraps immediately, so the count covers
 * whatever the race controller does when it is handed the blocker — the raster
 * bake and the reachability fill among them.
 */
const SETUP = `(async () => {
  const t0 = performance.now();
  let w = null;
  for (let i = 0; i < 1200 && !w; i++) {
    w = window.__world;
    if (!w) await new Promise((k) => setTimeout(k, 50));
  }
  if (!w) return JSON.stringify({ error: 'no world' });
  const inner = w.blockedAt.bind(w);
  let n = 0;
  w.blockedAt = (x, z) => { n++; return inner(x, z); };
  const seen = n;
  for (let i = 0; i < 400 && !window.__race; i++) await new Promise((k) => setTimeout(k, 50));
  // Let the race settle: the bake and the fill happen on the way to the first
  // playable frame, not synchronously with the scene's constructor.
  for (let i = 0; i < 120; i++) await new Promise((k) => requestAnimationFrame(k));
  return JSON.stringify({ afterMount: n - seen, ms: Math.round(performance.now() - t0) });
})()`;

const port = 8600 + Math.floor(Math.random() * 200);
const server = await serve(DIST, port);
try {
  await withChrome(async (cdpPort) => {
    const url = `http://127.0.0.1:${port}/?scene=sprint&race=1&debug=0&tier=low&discipline=sprint`;
    const tab = await openTab(cdpPort, url);

    const setup = JSON.parse(await tab.evaluate(SETUP));
    if (setup.error) {
      console.error('✗ the sprint scene never mounted');
      process.exitCode = 2;
      return;
    }
    console.log(`\n  setup batches after the scene existed: ${setup.afterMount.toLocaleString()} calls (${setup.ms} ms of page life)`);

    if (!(await tab.waitFor('!!(window.__race && window.__world)', 60_000))) {
      console.error('✗ the race never mounted');
      process.exitCode = 2;
      return;
    }
    const r = JSON.parse(await tab.evaluate(COUNT(STEPS)));
    await tab.close();

    console.log(`\n  blockedAt calls per simulation step, over ${r.steps} steps of the shipped course:\n`);
    console.log(`    total ${r.total.toLocaleString()}   mean ${r.mean.toFixed(1)}   p50 ${r.p50}   p99 ${r.p99}   max ${r.max}`);
    console.log(`    steps that made no call at all: ${r.zero}\n`);
  });
} finally {
  server.close();
}
