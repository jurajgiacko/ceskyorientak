#!/usr/bin/env node
/**
 * What a venue costs between "press start" and "the race exists", on a phone.
 *
 * PLAN-KRUMLOV-V2 §6 phase 0 found the one thing about vector collision that is
 * *not* cheap and wrote the requirement into phase 2: **any venue-wide sweep of
 * the model belongs in the build, not in the loading screen.** It measured
 * `bakedRaster`'s 2.56 M-cell sweep at 2.6 s and `buildReachability`'s fill at
 * another 2.9 s on the 4×-throttled mid-range-Android proxy.
 *
 * A budget with no instrument is a budget nobody can tell has been broken, so
 * this is the instrument. It loads the production build in headless Chrome at
 * the same `Emulation.setCPUThrottlingRate: 4` that `tools/perf/budget.mjs`
 * sets — this project's Android proxy, and the throttle every timing in
 * DECISIONS.md is stated against — and reads the phase timings the running game
 * recorded for itself (`FieldTerrain.costMs`) rather than re-timing them from
 * outside, where the measurement would include the harness.
 *
 * Usage: node tools/perf/setup-cost.mjs [--venue krumlov] [--rate 4] [--runs 2]
 * Exit codes: 0 measured (also when over budget — see `--assert`), 2 harness.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from '../ci/chrome.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const a = args.find((v) => v.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

const venue = arg('venue', 'krumlov');
const rate = Number(arg('rate', '4'));
const runs = Number(arg('runs', '2'));
const scene = venue === 'krumlov' ? 'sprint' : 'forest';

/**
 * The slice of the loading screen the venue-wide sweeps may have, ms.
 *
 * Not a frame budget — nothing here runs per frame — but a *waiting* budget,
 * and the number comes from the same place any loading figure does: a phone
 * user reads two seconds as loading and five as broken. 5 500 ms is what phase
 * 0 measured the two sweeps at together, so this asserts the direction of
 * travel rather than blessing the status quo: it is set at a tenth of it.
 */
const BUDGET_MS = 550;

if (!existsSync(DIST)) {
  console.error('✗ dist/ not found — run `npm run build` first.');
  process.exit(2);
}

const PORT = 4711 + Math.floor(Math.random() * 200);
const server = await serve(DIST, PORT);

const samples = [];
await withChrome(async (cdp) => {
  for (let run = 0; run < runs; run++) {
    const url = `http://127.0.0.1:${PORT}/?scene=${scene}&race=1&debug=0&tier=high`;
    const tab = await openTab(cdp, url);
    await tab.send('Emulation.setCPUThrottlingRate', { rate });
    const ready = await tab.waitFor('!!window.__race && !!window.__race.terrain', 300_000);
    if (!ready) {
      console.error('✗ the race never came up');
      console.error(tab.consoleErrors.slice(0, 5).join('\n'));
      await tab.close();
      process.exitCode = 2;
      return;
    }
    const r = await tab.evaluate(`(() => {
      const t = window.__race.terrain;
      const info = window.__race.courseInfo;
      return {
        costMs: { ...t.costMs },
        reachable: info.reachableFraction,
        controls: info.controls,
        lengthM: info.lengthM,
      };
    })()`);
    await tab.close();
    if (r) samples.push(r);
  }
});

server.close();

if (!samples.length) {
  console.error('✗ no samples');
  process.exit(2);
}

// The best of the runs, not the mean: a cold texture cache and a first-run JIT
// are load-order noise rather than properties of the code being measured, and
// they only ever add. `budget.mjs` takes the same view of frame times.
const phases = new Set(samples.flatMap((s) => Object.keys(s.costMs)));
const best = {};
for (const p of phases) {
  best[p] = Math.min(...samples.map((s) => s.costMs[p] ?? Infinity));
}
const total = Object.values(best).reduce((a, b) => a + b, 0);

console.log(`\n· ${venue} — race setup at ${rate}× CPU throttle, best of ${samples.length}\n`);
for (const [p, ms] of Object.entries(best).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(10)} ${ms.toFixed(0).padStart(6)} ms`);
}
console.log(`  ${'total'.padEnd(10)} ${total.toFixed(0).padStart(6)} ms   (budget ${BUDGET_MS} ms)`);
console.log(
  `  reachable ${(samples[0].reachable * 100).toFixed(1)} % · ` +
    `${samples[0].controls} controls, ${samples[0].lengthM} m`,
);

if (args.includes('--assert') && total > BUDGET_MS) {
  console.error(`\n✗ venue setup costs ${total.toFixed(0)} ms at ${rate}×, over the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
console.log('');
