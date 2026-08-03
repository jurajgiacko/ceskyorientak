#!/usr/bin/env node
/**
 * PHASE 0 SPIKE — throwaway. The same bench, in a CPU-throttled headless Chrome.
 *
 * Desktop numbers alone cannot answer phase 0's question, and multiplying them
 * by a number I made up is not an improvement. So this runs the *identical*
 * `collision-bench.mjs` source inside Chrome under
 * `Emulation.setCPUThrottlingRate`, which is the mid-range-Android proxy this
 * project already uses to gate its frame budget — tools/perf/budget.mjs line
 * 270, "Mid-range Android proxy: 4x CPU throttle and a phone viewport", and the
 * 33.3 ms budget in that file was set against it. Reusing it means the collision
 * number and the frame budget it is being judged against were produced by the
 * same instrument.
 *
 * Three rates are measured, not one: 1× (so the Node→V8-in-Chrome difference is
 * visible and not smuggled into the verdict), 4× (the project's proxy), and 8×
 * (a deliberately pessimistic phone, because 4× throttling models a slower clock
 * and not a smaller cache, a shorter reorder window or a worse branch
 * predictor — all of which a real mid-range ARM core also has).
 *
 * Note what a CPU throttle is and is not: Chrome implements it by stalling the
 * main thread in slices, so it scales *time*, faithfully for scalar work like
 * this and less faithfully for anything memory-bound. The scatter pattern is the
 * memory-bound one, so its 4× number is the one to trust least, and it is called
 * out in the report rather than averaged away.
 *
 * Usage:
 *   node tools/perf/collision-spike-chrome.mjs [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { withChrome } from '../ci/chrome.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const jsonOut = argOf('--json', '');

const BENCH = readFileSync(resolve(ROOT, 'tools/perf/collision-bench.mjs'), 'utf8');
const TOWN = readFileSync(resolve(ROOT, 'public/data/krumlov/townscape.json'), 'utf8');

// A page with the bench module inlined, so Chrome runs the same bytes the Node
// driver imported rather than a copy that could drift.
const PAGE = `<!doctype html><meta charset="utf-8"><title>collision spike</title>
<script type="module">
${BENCH}
window.__bench = { buildModel, makePoints, benchMean, benchTail, benchFrames };
window.__ready = true;
</script>`;

const PORT = 8391 + Math.floor(Math.random() * 200);

function serveSpike(port) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/townscape.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(TOWN);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

/** A CDP tab that exposes `send`, which `openTab` in ci/chrome.mjs does not. */
async function tab(cdpPort, url) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await res.json();
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    sock.onopen = r;
    sock.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      sock.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval threw');
    }
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evaluate, close: async () => sock.close() };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(d));

const server = await serveSpike(PORT);
const out = { rates: {} };

await withChrome(async (cdpPort) => {
  const t = await tab(cdpPort, `http://127.0.0.1:${PORT}/`);
  for (let i = 0; i < 80; i++) {
    if (await t.evaluate('!!window.__ready')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await t.evaluate('!!window.__bench'))) {
    console.error('✗ the bench module never loaded in the page');
    process.exit(2);
  }

  await t.evaluate(`(async () => {
    window.__town = await (await fetch('/townscape.json')).json();
    window.__models = {
      v2: __bench.buildModel(__town, { cellM: 12, barriers: 'all' }),
      v1: __bench.buildModel(__town, { cellM: 12, barriers: 'uncrossable' }),
    };
    window.__pts = {
      athlete: __bench.makePoints('athlete', 200000),
      scatter: __bench.makePoints('scatter', 200000),
      // A point per square metre of the venue, which is the grid bakedRaster
      // actually walks. Taking fewer would sample one corner of the map.
      scan: __bench.makePoints('scan', 1201 * 1201),
    };
    return 'ok';
  })()`);

  console.log('\n═══ THROUGHPUT — headless Chrome, CPU throttled ═══\n');
  console.log(
    `  ${pad('rate', 6)} ${pad('model', 6)} ${pad('pattern', 10)} ${pad('mean ns', 9)} ${pad('frame p99 ms @8q', 17)} % of 33.3 ms`,
  );

  for (const rate of [1, 4, 8]) {
    await t.send('Emulation.setCPUThrottlingRate', { rate });
    // Let the throttle settle; Chrome applies it by stalling the thread in
    // slices and the first slice after a change is not representative.
    await new Promise((r) => setTimeout(r, 300));
    out.rates[rate] = [];
    for (const model of ['v2', 'v1']) {
      for (const pattern of ['athlete', 'scatter', 'scan']) {
        // The sweep is 1.44 M points; one pass of it at 8× is already seconds.
        const reps = pattern === 'scan' ? 1 : rate >= 8 ? 1 : rate >= 4 ? 2 : 4;
        const r = await t.evaluate(`
          (() => {
            const m = __bench.benchMean(__models.${model}.blockedAt, __pts.${pattern}, ${reps});
            const f = __bench.benchFrames(__models.${model}.blockedAt, __pts.${pattern}, 8, 6000);
            return { meanNs: m.nsPerQuery, sink: m.sink, frameMeanMs: f.meanMs, frameP99Ms: f.p99Ms, frameMaxMs: f.maxMs };
          })()
        `);
        console.log(
          `  ${pad(rate + '×', 6)} ${pad(model, 6)} ${pad(pattern, 10)} ${pad(num(r.meanNs), 9)} ${pad(r.frameP99Ms.toFixed(4), 17)} ${((r.frameP99Ms / 33.3) * 100).toFixed(3)}%`,
        );
        out.rates[rate].push({ model, pattern, ...r });
      }
    }
  }

  // Per-frame at realistic query counts, at the proxy rate only.
  await t.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await new Promise((r) => setTimeout(r, 300));
  console.log('\n═══ PER-FRAME COST @ 4× (the project\'s mid-range Android proxy) ═══\n');
  console.log(`  ${pad('queries/frame', 14)} ${pad('mean ms', 9)} ${pad('p99 ms', 9)} ${pad('max ms', 9)} % of 33.3 ms (p99)`);
  out.frames = [];
  for (const q of [2, 8, 32, 128]) {
    const f = await t.evaluate(
      `__bench.benchFrames(__models.v2.blockedAt, __pts.athlete, ${q}, 20000)`,
    );
    console.log(
      `  ${pad(q, 14)} ${pad(f.meanMs.toFixed(4), 9)} ${pad(f.p99Ms.toFixed(4), 9)} ${pad(f.maxMs.toFixed(4), 9)} ${((f.p99Ms / 33.3) * 100).toFixed(3)}%`,
    );
    out.frames.push({ ...f, rate: 4 });
  }

  // Load-time batches at the proxy rate — the generator's thousands of probes.
  const scat = out.rates[4].find((r) => r.model === 'v2' && r.pattern === 'scatter').meanNs;
  const scan = out.rates[4].find((r) => r.model === 'v2' && r.pattern === 'scan').meanNs;
  console.log('\n═══ LOAD-TIME BATCHES @ 4× ═══\n');
  console.log(`  bakedRaster sweep  ${(1601 * 1601).toLocaleString()} cells × ${num(scan)} ns = ${((1601 * 1601 * scan) / 1e6).toFixed(0)} ms`);
  console.log(`  reachability fill  ${(1201 * 1201 * 2).toLocaleString()} probes × ${num(scan)} ns = ${((1201 * 1201 * 2 * scan) / 1e6).toFixed(0)} ms`);
  console.log(`  100 k scattered    ${((100000 * scat) / 1e6).toFixed(0)} ms`);
  console.log(`  1 M scattered      ${((1000000 * scat) / 1e6).toFixed(0)} ms`);
  out.loadTime = { scatNs: scat, scanNs: scan };

  // Build cost of the vector model itself, at the proxy rate.
  const buildMs = await t.evaluate(`
    (() => { const t0 = performance.now(); __bench.buildModel(__town, { cellM: 12, barriers: 'all' }); return performance.now() - t0; })()
  `);
  console.log(`\n  vector model construction @ 4×: ${buildMs.toFixed(0)} ms (once, at venue load)`);
  out.buildMs = buildMs;

  await t.close();
});

server.close();
if (jsonOut) {
  writeFileSync(resolve(ROOT, jsonOut), JSON.stringify(out, null, 2));
  console.log(`\n  written: ${jsonOut}`);
}
console.log('');
