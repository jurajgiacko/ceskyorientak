/**
 * Shared headless-Chrome harness for the CI gates.
 *
 * Two gates need the same three things — a static server over `dist/`, a
 * headless Chrome with a real GPU-backed WebGL context, and a CDP tab that
 * reports console errors as well as evaluation results. This was copied between
 * them; a copy that drifts is a gate that measures something different from the
 * gate beside it, so it lives here once.
 *
 * `--use-gl=angle --enable-gpu` is not decoration: with the software rasteriser
 * three.js still compiles shaders and still reports failures, but the frame
 * timings become meaningless and some drivers skip compilation entirely, which
 * would hide exactly the class of bug these gates exist to catch.
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
};

/** Serve `dir` on `port`. Unknown paths fall back to index.html (SPA routing). */
export function serve(dir, port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = resolve(dir, '.' + decodeURIComponent(url.pathname));
    if (!p.startsWith(dir)) return void res.writeHead(403).end();
    if (!existsSync(p) || p === dir) p = resolve(dir, 'index.html');
    try {
      const body = readFileSync(p);
      res.writeHead(200, {
        'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

export function findChrome() {
  return (
    [
      process.env.CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ]
      .filter(Boolean)
      .find((c) => existsSync(c)) ?? null
  );
}

/** Run `fn(cdpPort)` against a throwaway headless Chrome. Exits 2 if none. */
export async function withChrome(fn) {
  const bin = findChrome();
  if (!bin) {
    console.error('✗ No Chrome/Chromium found. Set CHROME_PATH.');
    process.exit(2);
  }
  const port = 9722 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'orientak-ci-'));
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--use-gl=angle',
    '--enable-gpu',
    '--no-sandbox',
    '--window-size=1280,800',
    'about:blank',
  ]);
  proc.on('error', (e) => {
    console.error('✗ Chrome failed to start:', e.message);
    process.exit(2);
  });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    proc.kill();
    console.error('✗ Chrome debugging endpoint never came up.');
    process.exit(2);
  }
  try {
    return await fn(port);
  } finally {
    proc.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* tmp profile; losing the race with Chrome's teardown is fine */
    }
  }
}

/** Open a tab at `url`. The returned object collects console errors as it goes. */
export async function openTab(cdpPort, url) {
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
  const consoleErrors = [];
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
    }
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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  /**
   * Poll until `expression` is truthy. Polling rather than a fixed sleep because
   * load time swings by a factor of three with the texture cache warm or cold,
   * and a sleep long enough for the cold case wastes minutes on every other run.
   */
  const waitFor = async (expression, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await evaluate(expression)) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  /**
   * A PNG of what the tab is showing, base64, or null if Chrome refused.
   *
   * The gates measure; this is for looking. A course fault like D-037's is
   * stated in metres but *reported* as "I can see it across the water and I
   * can't get across", and the frame from the athlete's own eye is the only
   * artefact that answers the sentence the client actually wrote.
   */
  const screenshot = async () => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    return r.result?.result?.data ?? r.result?.data ?? null;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  return {
    evaluate,
    waitFor,
    screenshot,
    consoleErrors,
    close: async () => {
      sock.close();
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
    },
  };
}
