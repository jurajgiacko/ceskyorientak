#!/usr/bin/env node
/**
 * Perf budget gate.
 *
 * Serves the production build, drives it in headless Chrome, reads the game's
 * OWN frame-time monitor (window.__perf, see src/core/perf.ts), and fails the
 * build if the median frame time regresses past budget or beyond the recorded
 * baseline.
 *
 * Reading the game's own monitor rather than measuring independently is
 * deliberate: it means CI and the runtime adaptive scaler can never disagree
 * about what "slow" means.
 *
 * Usage:
 *   node tools/perf/budget.mjs                 # measure and gate
 *   node tools/perf/budget.mjs --update        # accept current numbers as baseline
 *   node tools/perf/budget.mjs --scene=forest  # gate one scene
 *
 * Exit codes: 0 pass, 1 regression, 2 harness failure.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');
const BASELINE = resolve(__dirname, 'baseline.json');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const sceneArg = args.find((a) => a.startsWith('--scene='));
const ONLY = sceneArg ? sceneArg.slice('--scene='.length) : null;

/**
 * Absolute budgets. These come from the brief and are not negotiable by a
 * baseline update — a baseline can only ever be *stricter* than these.
 */
const HARD_BUDGET = {
  desktopMedianMs: 16.7, // 60 fps
  desktopP95Ms: 25.0,
  mobileMedianMs: 33.3, // 30 fps
  mobileP95Ms: 50.0,
  /** Initial payload the browser must fetch before first play. */
  initialLoadMb: 15,
};

/** A regression larger than this fraction over baseline fails the build. */
const REGRESSION_TOLERANCE = 0.1;

/** Scenes to measure. Each is a URL the built game can be deep-linked to. */
const SCENES = [
  { id: 'menu', url: '/?scene=menu', settleMs: 2000, measureMs: 4000 },
  { id: 'forest', url: '/?scene=forest&bench=1', settleMs: 4000, measureMs: 6000 },
  { id: 'sprint', url: '/?scene=sprint&bench=1', settleMs: 4000, measureMs: 6000 },
];

// ---------------------------------------------------------------------------
// Static server for dist/
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

function serve(dir, port) {
  let bytesServed = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = resolve(dir, '.' + decodeURIComponent(url.pathname));
    if (!p.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(p) || p === dir) p = resolve(dir, 'index.html');
    try {
      const body = readFileSync(p);
      bytesServed += body.length;
      const ext = p.slice(p.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) =>
    server.listen(port, () => r({ server, getBytes: () => bytesServed })),
  );
}

// ---------------------------------------------------------------------------
// Chrome driver — CDP over the DevTools protocol, no Puppeteer dependency
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function withChrome(fn) {
  const bin = findChrome();
  if (!bin) {
    console.error(
      '✗ No Chrome/Chromium found. Set CHROME_PATH, or install Chrome.\n' +
        '  In CI use: browser-actions/setup-chrome.',
    );
    process.exit(2);
  }
  const port = 9222 + Math.floor(Math.random() * 500);
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    // We want real GPU rasterisation; SwiftShader numbers are meaningless here.
    '--use-gl=angle',
    '--enable-gpu',
    '--no-sandbox',
    '--window-size=1280,720',
    'about:blank',
  ]);
  proc.on('error', (e) => {
    console.error('✗ Chrome failed to start:', e.message);
    process.exit(2);
  });

  // Wait for the debugging endpoint.
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      ws = j.webSocketDebuggerUrl;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!ws) {
    proc.kill();
    console.error('✗ Chrome debugging endpoint never came up.');
    process.exit(2);
  }

  try {
    return await fn(port);
  } finally {
    proc.kill();
  }
}

/** Open a page, run it, and pull the perf sample out of the game itself. */
async function measureScene(cdpPort, base, scene, mobile) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(
    base + scene.url,
  )}`, { method: 'PUT' });
  const target = await res.json();

  // Minimal CDP client. Node 22+ ships a global WebSocket, so no dependency.
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    sock.onopen = r;
    sock.onerror = j;
  });

  let msgId = 0;
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
      const id = ++msgId;
      pending.set(id, r);
      sock.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  if (mobile) {
    // Mid-range Android proxy: 4x CPU throttle and a phone viewport.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }

  await new Promise((r) => setTimeout(r, scene.settleMs));
  const has = await evaluate('typeof window.__perf === "object"');
  if (!has) {
    sock.close();
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
    return { skipped: true, reason: 'window.__perf not exposed (scene not built yet)' };
  }
  await evaluate('window.__perf.reset()');
  await new Promise((r) => setTimeout(r, scene.measureMs));
  const sample = await evaluate('JSON.stringify(window.__perf.sample())');

  sock.close();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
  return { skipped: false, ...JSON.parse(sample) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ dist/ not found. Run `npm run build` first.');
    process.exit(2);
  }

  const port = 8123;
  const { server } = await serve(DIST, port);
  const base = `http://127.0.0.1:${port}`;

  const baseline = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : { scenes: {} };

  const results = {};
  let failed = false;

  await withChrome(async (cdpPort) => {
    for (const scene of SCENES) {
      if (ONLY && scene.id !== ONLY) continue;
      for (const mobile of [false, true]) {
        const key = `${scene.id}.${mobile ? 'mobile' : 'desktop'}`;
        process.stdout.write(`▶ ${key} … `);
        const r = await measureScene(cdpPort, base, scene, mobile);
        if (r.skipped) {
          console.log(`skip (${r.reason})`);
          continue;
        }
        results[key] = { medianMs: r.medianMs, p95Ms: r.p95Ms, fps: r.fps, frames: r.frames };
        console.log(
          `median ${r.medianMs.toFixed(2)} ms · p95 ${r.p95Ms.toFixed(2)} ms · ${r.fps.toFixed(1)} fps · ${r.frames} frames`,
        );

        const hardMedian = mobile ? HARD_BUDGET.mobileMedianMs : HARD_BUDGET.desktopMedianMs;
        const hardP95 = mobile ? HARD_BUDGET.mobileP95Ms : HARD_BUDGET.desktopP95Ms;

        if (r.frames < 30) {
          console.log(`  ✗ only ${r.frames} frames measured — the scene did not run`);
          failed = true;
          continue;
        }
        if (r.medianMs > hardMedian) {
          console.log(
            `  ✗ over hard budget: ${r.medianMs.toFixed(2)} ms > ${hardMedian} ms`,
          );
          failed = true;
        }
        if (r.p95Ms > hardP95) {
          console.log(`  ✗ p95 over budget: ${r.p95Ms.toFixed(2)} ms > ${hardP95} ms`);
          failed = true;
        }
        const prev = baseline.scenes?.[key];
        if (prev && r.medianMs > prev.medianMs * (1 + REGRESSION_TOLERANCE)) {
          const pct = ((r.medianMs / prev.medianMs - 1) * 100).toFixed(1);
          console.log(
            `  ✗ regression: ${r.medianMs.toFixed(2)} ms vs baseline ${prev.medianMs.toFixed(2)} ms (+${pct}%)`,
          );
          failed = true;
        }
      }
    }
  });

  server.close();

  if (UPDATE) {
    writeFileSync(
      BASELINE,
      JSON.stringify({ updatedAt: new Date().toISOString(), scenes: results }, null, 2) + '\n',
    );
    console.log(`\n✓ baseline updated (${Object.keys(results).length} entries)`);
    process.exit(0);
  }

  if (Object.keys(results).length === 0) {
    console.log('\n· no scenes measured yet — nothing to gate');
    process.exit(0);
  }

  console.log(failed ? '\n✗ PERF BUDGET FAILED' : '\n✓ perf budget OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('✗ harness error:', e);
  process.exit(2);
});
