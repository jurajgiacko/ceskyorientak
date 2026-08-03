#!/usr/bin/env node
/**
 * Throwaway diagnostic: what is actually in the way of a long-detour leg?
 *
 * Loads a seed in the real build, takes the sited points, routes every leg, and
 * for the worst ones walks the straight line reporting what stops the athlete
 * at each metre — water, a barrier, a building, or the raster.
 *
 * Usage: node tools/sim/leg-diag.mjs [--venue krumlov] [--seeds a,b,c]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from '../ci/chrome.mjs';
import { makeLegRouter, probeBlockers } from '../ci/check-passable.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const venue = argOf('--venue', 'krumlov');
const seeds = argOf('--seeds', '29760961,28803419').split(',').map(Number);
const scene = venue === 'krumlov' ? 'sprint' : 'forest';
const discipline = venue === 'krumlov' ? 'sprint' : 'middle';

const PROBE = `(async () => {
  const c = window.__race.course;
  const named = [{ n: 'start', p: c.start }]
    .concat(c.controls.map((k, i) => ({ n: String(i + 1), p: k.position })))
    .concat([{ n: 'finish', p: c.finish }]);
  return JSON.stringify({
    id: c.id,
    points: named.map((o) => ({ n: o.n, x: o.p.x, z: o.p.z })),
    seedsTried: window.__race.courseInfo.seedsTried,
  });
})()`;

const port = 8700 + Math.floor(Math.random() * 200);
const server = await serve(DIST, port);
const route = makeLegRouter(venue, 'runnability.bin', { radiusM: venue === 'krumlov' ? 600 : 1000 });
const why = probeBlockers(venue, 'runnability.bin');
try {
  await withChrome(async (cdpPort) => {
    for (const seed of seeds) {
      const url = `http://127.0.0.1:${port}/?scene=${scene}&race=1&debug=0&tier=high&discipline=${discipline}&seed=${seed}`;
      const tab = await openTab(cdpPort, url);
      if (!(await tab.waitFor('!!(window.__race && window.__world)', 60_000))) {
        console.log(`  ${seed}: never mounted`);
        await tab.close();
        continue;
      }
      const res = JSON.parse(await tab.evaluate(PROBE));
      await tab.close();
      const r = route(res.points);
      console.log(`\n· ${res.id} (seedsTried ${res.seedsTried})`);
      for (const l of r.legs) {
        if (!l.routed || l.detour < 2) continue;
        const a = res.points[l.leg];
        const b = res.points[l.leg + 1];
        const tally = new Map();
        const n = Math.max(2, Math.ceil(l.straightM / 1));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const k = why(x, z).join('+') || 'open';
          tally.set(k, (tally.get(k) ?? 0) + 1);
        }
        console.log(
          `  leg ${l.leg} ${a.n}→${b.n}  ${Math.round(l.straightM)} m straight, ${l.lengthM} m run` +
            ` (${l.detour.toFixed(1)}×)  from (${a.x.toFixed(0)},${a.z.toFixed(0)})` +
            ` to (${b.x.toFixed(0)},${b.z.toFixed(0)})`,
        );
        console.log(
          `      along the straight line: ` +
            [...tally].sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k} ${v}`).join(' · '),
        );
      }
    }
  });
} finally {
  server.close();
}
