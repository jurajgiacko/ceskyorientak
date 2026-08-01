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
  /** Streamed content — not in the initial budget, but not unbounded either. */
  streamedMb: 120,
};

/** Paths under dist/ that stream in after the menu is interactive. */
const STREAMED = ['data/', 'models/', 'textures/', 'audio/'];

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

console.log('Payload budget\n');
row('entry (brotli)', entryBrotli / 1024, BUDGETS.entryBrotliKb, 'kB');
row('initial load', initialBytes / MB, BUDGETS.initialMb, 'MB');
row('streamed content', streamedBytes / MB, BUDGETS.streamedMb, 'MB');

console.log('\nLargest initial files:');
for (const f of [...initial].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  const g = extname(f.rel).match(/\.(js|css|html|json|svg)$/)
    ? ` (gzip ${(gzipSync(readFileSync(f.path)).length / 1024).toFixed(1)} kB)`
    : '';
  console.log(`   ${(f.bytes / 1024).toFixed(1).padStart(9)} kB  ${f.rel}${g}`);
}

console.log(failed ? '\n✗ PAYLOAD BUDGET FAILED' : '\n✓ payload budget OK');
process.exit(failed ? 1 : 0);
