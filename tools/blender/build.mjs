#!/usr/bin/env node
/**
 * Headless Blender asset build driver.
 *
 *   node tools/blender/build.mjs [--force] [--only name,name] [--jobs N]
 *                               [--previews] [--seed N] [--no-validate]
 *
 * Runs every tools/blender/assets/<name>.py in its own Blender process.
 * Blender processes share nothing, so they parallelise safely; the only
 * serialised step is writing the manifest.
 *
 * Up-to-date outputs are skipped based on a content hash of the asset script
 * plus every file in lib/ plus the Blender version -- mtimes alone would
 * rebuild the world on every checkout.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ASSET_DIR = path.join(HERE, 'assets');
const LIB_DIR = path.join(HERE, 'lib');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const PREVIEW_DIR = path.join(HERE, 'previews');
const CACHE_DIR = path.join(HERE, '.cache');
const STATE_FILE = path.join(CACHE_DIR, 'build-state.json');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const BLENDER_CANDIDATES = [
  process.env.BLENDER,
  '/Applications/Blender.app/Contents/MacOS/Blender',
  `${os.homedir()}/Applications/Blender.app/Contents/MacOS/Blender`,
  '/usr/local/bin/blender',
  'blender',
].filter(Boolean);

/** Assets whose geometry is dense enough that Draco pays for itself. */
const DRACO = new Set(['boulder-set', 'spruce', 'beech', 'deadwood', 'finish-gantry']);

/** Explicit order: cheap props first so failures surface fast. */
const ORDER = [
  'control-flag', 'control-stand', 'si-unit', 'boulder-set', 'spruce',
  'beech', 'deadwood', 'race-belt', 'finish-gantry',
  'arena-tent', 'spectator-fence',
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function findBlender() {
  for (const cand of BLENDER_CANDIDATES) {
    try {
      if (cand === 'blender' || fs.existsSync(cand)) return cand;
    } catch { /* keep looking */ }
  }
  throw new Error('Blender not found. Set $BLENDER to the binary path.');
}

async function blenderVersion(bin) {
  const { stdout } = await execFileAsync(bin, ['--version'], { maxBuffer: 1 << 20 });
  return stdout.split('\n')[0].trim();
}

function sha(files, salt) {
  const h = crypto.createHash('sha256');
  h.update(salt);
  for (const f of files.sort()) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

function libFiles() {
  return fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.py'))
    .map((f) => path.join(LIB_DIR, f));
}

function discover() {
  if (!fs.existsSync(ASSET_DIR)) return [];
  const found = fs.readdirSync(ASSET_DIR)
    .filter((f) => f.endsWith('.py') && !f.startsWith('_'))
    .map((f) => path.basename(f, '.py'));
  const ordered = ORDER.filter((n) => found.includes(n));
  return [...ordered, ...found.filter((n) => !ordered.includes(n)).sort()];
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

async function runAsset(bin, name, { seed, force, state, libHash, version }) {
  const script = path.join(ASSET_DIR, `${name}.py`);
  const hash = sha([script, ...libFiles()], `${version}|${libHash}|seed=${seed}|draco=${DRACO.has(name)}`);
  const prev = state[name];

  const outputsExist = prev?.outputs?.length
    && prev.outputs.every((f) => fs.existsSync(path.join(OUT_DIR, f)));

  if (!force && prev?.hash === hash && outputsExist) {
    return { name, skipped: true, hash, metas: prev.metas ?? [], outputs: prev.outputs };
  }

  const args = [
    '--background', '--factory-startup', '--python', script, '--',
    '--out', OUT_DIR, '--seed', String(seed),
    DRACO.has(name) ? '--draco' : '--no-draco',
  ];

  const started = Date.now();
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync(bin, args, { maxBuffer: 1 << 26, cwd: ROOT });
    stdout = r.stdout; stderr = r.stderr;
  } catch (err) {
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? String(err);
    const tail = `${stdout}\n${stderr}`.split('\n').filter(Boolean).slice(-14).join('\n');
    return { name, failed: true, seconds: (Date.now() - started) / 1000, error: tail };
  }

  const metas = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('ASSETMETA ')) {
      try { metas.push(JSON.parse(line.slice(10))); } catch { /* ignore */ }
    }
  }
  if (!metas.length) {
    const tail = `${stdout}\n${stderr}`.split('\n').filter(Boolean).slice(-14).join('\n');
    return { name, failed: true, seconds: (Date.now() - started) / 1000, error: `no ASSETMETA emitted\n${tail}` };
  }

  return {
    name, hash, metas,
    outputs: metas.map((m) => m.file),
    seconds: (Date.now() - started) / 1000,
  };
}

async function renderPreview(bin, name, file) {
  const out = path.join(PREVIEW_DIR, `${name}.png`);
  await execFileAsync(bin, [
    '--background', '--factory-startup', '--python', path.join(HERE, 'preview.py'),
    '--', '--glb', path.join(OUT_DIR, file), '--out', out,
  ], { maxBuffer: 1 << 26, cwd: ROOT });
  return out;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const bin = findBlender();
  const version = await blenderVersion(bin);
  const seed = Number(arg('seed', 20260805));
  const force = Boolean(arg('force', false));
  const previews = Boolean(arg('previews', false));
  const jobs = Number(arg('jobs', Math.max(1, Math.min(4, os.cpus().length - 1))));
  const only = arg('only', null);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  let names = discover();
  if (typeof only === 'string') {
    const wanted = new Set(only.split(',').map((s) => s.trim()));
    names = names.filter((n) => wanted.has(n));
  }
  if (!names.length) {
    console.error('No asset scripts found in tools/blender/assets/');
    process.exit(1);
  }

  console.log(`${version}\nbuilding ${names.length} asset(s) with ${jobs} job(s), seed ${seed}\n`);

  const state = readState();
  const libHash = sha(libFiles(), 'lib');
  const results = await pool(names, jobs, (name) =>
    runAsset(bin, name, { seed, force, state, libHash, version }));

  const nextState = { ...state };
  let failed = 0;

  for (const r of results) {
    if (r.failed) {
      failed += 1;
      delete nextState[r.name];
      console.error(`FAIL  ${r.name}  (${r.seconds.toFixed(1)}s)\n${r.error}\n`);
      continue;
    }
    nextState[r.name] = { hash: r.hash, metas: r.metas, outputs: r.outputs };
    const tris = r.metas.reduce((a, m) => a + (m.tris ?? 0), 0);
    console.log(r.skipped
      ? `skip  ${r.name.padEnd(18)} up to date`
      : `built ${r.name.padEnd(18)} ${String(tris).padStart(6)} tris LOD0  ${r.seconds.toFixed(1)}s`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));

  // The manifest describes everything currently in public/models, not just the
  // subset this invocation touched -- otherwise `--only foo` would silently
  // drop every other asset from the manifest.
  const entries = [];
  for (const [name, rec] of Object.entries(nextState)) {
    for (const m of rec.metas ?? []) {
      if (fs.existsSync(path.join(OUT_DIR, m.file))) entries.push(m);
      else console.warn(`warn  ${name}: ${m.file} listed in state but missing on disk`);
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    generator: `blender-asset-pipeline (${version})`,
    generatedAt: new Date().toISOString().slice(0, 10),
    seed,
    totalLod0Tris: entries.reduce((a, e) => a + (e.tris ?? 0), 0),
    totalBytes: entries.reduce((a, e) => a + (e.bytes ?? 0), 0),
    // Pass every extra an asset emits straight through. An earlier whitelist
    // here silently swallowed fields the assets were deliberately publishing
    // (spectator-fence's repeatPitchX, for one) -- the asset script is the
    // authority on what the runtime needs to know about it.
    assets: entries.map(({ trisAllLods, ...rest }) => ({
      name: rest.name,
      file: rest.file,
      bytes: rest.bytes,
      tris: rest.tris,
      lods: rest.lods,
      ...Object.fromEntries(
        Object.entries(rest).filter(
          ([k]) => !['name', 'file', 'bytes', 'tris', 'lods'].includes(k),
        ),
      ),
    })),
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nmanifest: ${path.relative(ROOT, MANIFEST)}  (${manifest.assets.length} assets, ${manifest.totalLod0Tris} LOD0 tris)`);

  if (previews) {
    console.log('\nrendering previews...');
    const jobsList = entries.map((e) => [e.name, e.file]);
    await pool(jobsList, Math.max(1, Math.min(3, jobs)), async ([name, file]) => {
      try {
        await renderPreview(bin, name, file);
        console.log(`preview ${name}`);
      } catch (err) {
        console.error(`preview FAILED ${name}: ${String(err).split('\n').slice(-3).join(' ')}`);
      }
    });
  }

  if (failed) {
    console.error(`\n${failed} asset(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
