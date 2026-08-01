#!/usr/bin/env node
/**
 * tools/imagegen/generate.mjs — build-time image generation.
 *
 * BUILD TIME ONLY. The shipped game never touches an image API; it only ever
 * loads the committed WebP files under public/.
 *
 * Usage:
 *   node tools/imagegen/generate.mjs
 *   node tools/imagegen/generate.mjs --force
 *   node tools/imagegen/generate.mjs --only=moss,granite-boulder
 *   node tools/imagegen/generate.mjs --no-pbr        # fetch only, skip raster
 *   node tools/imagegen/generate.mjs --kind=texture  # or art
 *
 * Env (from .env.local, auto-loaded, never printed, never committed):
 *   GEMINI_API_KEY   required
 *   GEMINI_MODEL     optional, default gemini-2.5-flash-image
 *   CONCURRENCY      optional, default 3
 *
 * Idempotent: an asset whose raw PNG is already in .cache/ is not re-fetched
 * unless --force. PBR/webp derivation always re-runs (it is free and local),
 * so you can tune material params without spending API calls.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildPbrSet, CACHE_DIR, ROOT, MANIFEST_PATH } from './pbr.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = resolve(__dirname, 'manifest.lock.json');
const ART_DIR = resolve(ROOT, 'public/art');

/* ------------------------------------------------------------ env loading */

function loadEnvLocal() {
  const p = resolve(ROOT, '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

/* --------------------------------------------------------------- CLI args */

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const NO_PBR = args.includes('--no-pbr');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
const kindArg = args.find((a) => a.startsWith('--kind='));
const KIND = kindArg ? kindArg.slice('--kind='.length) : null;

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const { styleAnchor, negativePrompt, defaults = {}, assets } = manifest;

const targets = assets.filter(
  (a) => (!ONLY || ONLY.has(a.id)) && (!KIND || a.kind === KIND)
);

if (!targets.length) {
  console.error('✗ no assets matched the filter');
  process.exit(1);
}
if (!API_KEY) {
  console.error('✗ GEMINI_API_KEY not set (expected in .env.local)');
  process.exit(1);
}

/* ----------------------------------------------------------------- prompt */

function buildFullPrompt(asset) {
  const style = asset.styleAnchor || styleAnchor[asset.kind] || '';
  const neg = asset.negativePrompt || negativePrompt[asset.kind] || '';
  const parts = [asset.prompt.trim().replace(/\.$/, '')];
  if (style) parts.push(style.trim().replace(/\.$/, ''));
  if (neg) parts.push(`Strictly avoid: ${neg}`);
  return parts.join('. ') + '.';
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function cachePath(asset) {
  return resolve(CACHE_DIR, `${asset.id}.png`);
}

/* ------------------------------------------------------------------ fetch */

async function fetchImage(asset, attempt = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: buildFullPrompt(asset) }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(asset.aspect && { imageConfig: { aspectRatio: asset.aspect } })
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = (await res.text()).slice(0, 300);
    /* 429/5xx get one backed-off retry; everything else is a hard fail */
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 4000 * attempt));
      return fetchImage(asset, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const reason = json?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`no image in response (finishReason=${reason})`);
  }
  return Buffer.from(b64, 'base64');
}

/* ----------------------------------------------------------- art encoding */

/**
 * Circular alpha mask. The model returns badge art on whatever corner
 * background it feels like (black, white, green), which reads as an
 * inconsistent set once six of them sit in a row in the UI. Masking to the
 * circle the art is already composed for removes the corners entirely.
 */
async function circleMask(src, size) {
  const { data } = await sharp(src)
    .removeAlpha()
    .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, r = size / 2, feather = size * 0.006;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const d = Math.hypot(x - c, y - c);
      const t = Math.max(0, Math.min(1, (r - d) / feather));
      out[i * 4] = data[i * 3];
      out[i * 4 + 1] = data[i * 3 + 1];
      out[i * 4 + 2] = data[i * 3 + 2];
      out[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    }
  }
  return sharp(out, { raw: { width: size, height: size, channels: 4 } });
}

async function encodeArt(asset) {
  const outDir = resolve(ART_DIR, asset.category);
  mkdirSync(outDir, { recursive: true });
  const src = cachePath(asset);
  const meta = await sharp(src).metadata();
  const masked = asset.mask === 'circle';

  const full = resolve(outDir, `${asset.id}.webp`);
  const half = resolve(outDir, `${asset.id}@half.webp`);

  if (masked) {
    const size = Math.min(meta.width, meta.height);
    await (await circleMask(src, size)).webp({ quality: 90, effort: 5, alphaQuality: 100 }).toFile(full);
    await (await circleMask(src, Math.round(size / 2))).webp({ quality: 86, effort: 5, alphaQuality: 100 }).toFile(half);
  } else {
    await sharp(src).webp({ quality: 88, effort: 5 }).toFile(full);
    await sharp(src)
      .resize(Math.round(meta.width / 2), Math.round(meta.height / 2), { kernel: 'lanczos3' })
      .webp({ quality: 84, effort: 5 })
      .toFile(half);
  }
  return [full, half];
}

/* ------------------------------------------------------------------ tasks */

async function processOne(asset) {
  const cache = cachePath(asset);
  mkdirSync(CACHE_DIR, { recursive: true });

  let fetched = false;
  if (FORCE || !existsSync(cache)) {
    const buf = await fetchImage(asset);
    writeFileSync(cache, buf);
    fetched = true;
  }

  let outputs = [];
  if (!NO_PBR) {
    outputs = asset.pbr ? await buildPbrSet(asset) : await encodeArt(asset);
  }

  return {
    id: asset.id,
    fetched,
    promptHash: sha256(buildFullPrompt(asset)).slice(0, 16),
    seed: asset.seed ?? null,
    model: MODEL,
    aspect: asset.aspect,
    source: {
      path: relative(ROOT, cache),
      bytes: statSync(cache).size,
      sha256: sha256(readFileSync(cache))
    },
    outputs: outputs.map((p) => ({
      path: relative(ROOT, p),
      bytes: statSync(p).size,
      sha256: sha256(readFileSync(p))
    })),
    generatedAt: new Date().toISOString()
  };
}

async function runAll() {
  const queue = [...targets];
  const results = [];
  const errors = [];
  let idx = 0;

  async function worker() {
    while (idx < queue.length) {
      const asset = queue[idx++];
      const t0 = Date.now();
      try {
        const r = await processOne(asset);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        const tag = r.fetched ? '✓ gen ' : '· cached';
        const kb = (r.source.bytes / 1024).toFixed(0);
        console.log(`  ${tag} ${asset.id.padEnd(24)} ${kb.padStart(5)} KB · ${r.outputs.length} out · ${dt}s`);
        results.push(r);
      } catch (e) {
        console.error(`  ✗ ${asset.id}: ${e.message}`);
        errors.push({ id: asset.id, error: e.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { results, errors };
}

/* ------------------------------------------------------------------- main */

console.log(
  `▶ imagegen · ${targets.length} asset(s) · model=${MODEL} · concurrency=${CONCURRENCY}` +
  `${FORCE ? ' · FORCE' : ''}${NO_PBR ? ' · no-pbr' : ''}`
);

const t0 = Date.now();
const { results, errors } = await runAll();
const dt = ((Date.now() - t0) / 1000).toFixed(1);

/* ---- merge into the lock so partial runs never drop unrelated entries ---- */
let lock = { version: 1, model: MODEL, assets: {} };
if (existsSync(LOCK_PATH)) {
  try { lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); } catch { /* rewrite */ }
}
lock.model = MODEL;
lock.assets = lock.assets || {};
for (const r of results) lock.assets[r.id] = r;
lock.updatedAt = new Date().toISOString();
lock.assets = Object.fromEntries(Object.entries(lock.assets).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');

console.log(
  `\n▶ done in ${dt}s · ${results.filter((r) => r.fetched).length} generated · ` +
  `${results.filter((r) => !r.fetched).length} cached · ${errors.length} error(s)`
);
console.log(`▶ lock: ${relative(ROOT, LOCK_PATH)} (${Object.keys(lock.assets).length} entries)`);

if (errors.length) {
  console.log('\nFailed:');
  for (const e of errors) console.log(`  - ${e.id}: ${e.error}`);
  process.exit(1);
}
