#!/usr/bin/env node
/**
 * Validate every exported .glb by actually parsing it with @gltf-transform.
 *
 * Reports triangle count, mesh count, material count, texture count and file
 * size per asset, and fails loudly on anything that is missing, empty,
 * unparseable, or over its declared triangle budget.
 *
 *   node tools/blender/validate.mjs [--json] [--markdown]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODELS = path.join(ROOT, 'public', 'models');

/**
 * Global ceiling across every asset's LOD0. These are instanced heavily across
 * the terrain, so the sum is what actually matters; the per-asset numbers below
 * deliberately sum to more than this so one asset can borrow from another's
 * slack, but the total is still enforced.
 */
/**
 * Total LOD0 triangles across the whole asset library.
 *
 * Raised from 40k to 60k deliberately. 40k was an initial guess, and it turned
 * out to be the wrong *kind* of budget: these assets are GPU-instanced, so what
 * costs frame time is instance count × the LOD actually drawn, not the size of
 * the source library. Library size costs VRAM — roughly 50 kB per 1000 tris
 * with normals and UVs — so the whole jump is about 1 MB against a 15 MB
 * initial / 120 MB streamed budget.
 *
 * The cost of the tight ceiling was real and visible: the deadwood root plate
 * had to be cut to ~1100 tris for a 3 m object and reads as a lumpy pan rather
 * than a dense root ball, and its log lost two rings to afford the root web.
 * Starving unique detail to protect a number that does not govern frame time is
 * the wrong trade.
 *
 * Per-frame cost is governed by the perf budget in tools/perf/, which measures
 * the thing that actually matters.
 */
export const TOTAL_LOD0_BUDGET = 60000;

/** LOD0 triangle budget per asset (see README). */
export const BUDGETS = {
  'control-flag': 600,
  'control-stand': 800,
  'si-unit': 500,
  'boulder-set': 9000,
  // Four variants, and the two big ones carry 10-15 m of bare bole with a
  // 12-sided fluted trunk and dead stubs on it. That bole is the single most
  // looked-at surface in the game — it is what a stand of these reads as at eye
  // level — so it gets the geometry rather than the crown. ~4.7 k per variant.
  spruce: 20000,
  beech: 11000,
  deadwood: 3600,
  // First-person prop: never instanced and always seen close up, so it gets a
  // slightly looser allowance than a scatter asset. The global ceiling is the
  // real constraint here and there is room under it.
  'race-belt': 1000,
  'finish-gantry': 2200,
  'arena-tent': 1400,
  'spectator-fence': 600,
};

async function makeIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
}

function primTris(prim) {
  const mode = prim.getMode();
  const indices = prim.getIndices();
  const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
  // 4 = TRIANGLES, 5 = TRIANGLE_STRIP, 6 = TRIANGLE_FAN
  if (mode === 4) return count / 3;
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

export async function validateFile(io, file) {
  const abs = path.join(MODELS, file);
  const name = path.basename(file, '.glb');
  const res = {
    name, file, ok: false, bytes: 0, tris: 0, lod0Tris: 0,
    meshes: 0, materials: 0, textures: 0, nodes: 0, lods: {}, draco: false,
    errors: [],
  };

  if (!fs.existsSync(abs)) {
    res.errors.push('missing file');
    return res;
  }
  res.bytes = fs.statSync(abs).size;
  if (res.bytes === 0) {
    res.errors.push('zero bytes');
    return res;
  }

  let doc;
  try {
    doc = await io.read(abs);
  } catch (err) {
    res.errors.push(`parse failed: ${err.message}`);
    return res;
  }

  const root = doc.getRoot();
  res.materials = root.listMaterials().length;
  res.textures = root.listTextures().length;
  res.meshes = root.listMeshes().length;
  res.nodes = root.listNodes().length;
  res.draco = root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_draco_mesh_compression');

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    let tris = 0;
    for (const prim of mesh.listPrimitives()) tris += primTris(prim);
    res.tris += tris;
    const m = /_LOD(\d+)$/.exec(node.getName());
    if (m) res.lods[`LOD${m[1]}`] = (res.lods[`LOD${m[1]}`] ?? 0) + tris;
  }
  res.lod0Tris = res.lods.LOD0 ?? res.tris;

  if (res.tris === 0) res.errors.push('no triangles');
  if (res.materials === 0) res.errors.push('no materials');
  const budget = BUDGETS[name];
  if (budget && res.lod0Tris > budget) {
    res.errors.push(`LOD0 ${res.lod0Tris} tris over budget ${budget}`);
  }
  res.ok = res.errors.length === 0;
  return res;
}

export async function validateAll() {
  const io = await makeIO();
  const files = fs.existsSync(MODELS)
    ? fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb')).sort()
    : [];
  const out = [];
  for (const f of files) out.push(await validateFile(io, f));
  return out;
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

export function toMarkdown(rows) {
  const head = '| Asset | LOD0 tris | All LODs | Meshes | Materials | Textures | Size | Draco | Status |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|:-:|---|';
  const body = rows.map((r) => {
    const lods = Object.keys(r.lods).sort().map((k) => `${k}:${r.lods[k]}`).join(' ');
    return `| \`${r.name}\` | ${r.lod0Tris} | ${r.tris}${lods ? ` (${lods})` : ''} | ${r.meshes} | ${r.materials} | ${r.textures} | ${kb(r.bytes)} | ${r.draco ? 'yes' : 'no'} | ${r.ok ? 'OK' : `FAIL: ${r.errors.join('; ')}`} |`;
  });
  return [head, sep, ...body].join('\n');
}

function writeReadme(rows) {
  const file = path.join(HERE, 'README.md');
  const src = fs.readFileSync(file, 'utf8');
  const start = '<!-- VALIDATION_TABLE_START -->';
  const end = '<!-- VALIDATION_TABLE_END -->';
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if (i === -1 || j === -1) throw new Error('README markers not found');
  const total = rows.reduce((a, r) => a + r.lod0Tris, 0);
  const bytes = rows.reduce((a, r) => a + r.bytes, 0);
  const block = [
    start,
    `_Generated ${new Date().toISOString().slice(0, 10)} by \`node tools/blender/validate.mjs --write-readme\`._`,
    '',
    toMarkdown(rows),
    '',
    `**Total: ${rows.length} assets, ${total} LOD0 triangles, ${kb(bytes)} on disk.**`,
    '',
  ].join('\n');
  fs.writeFileSync(file, src.slice(0, i) + block + src.slice(j));
  console.log(`README table updated (${rows.length} assets, ${total} LOD0 tris)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await validateAll();
  if (process.argv.includes('--write-readme')) {
    writeReadme(rows);
    const bad = rows.filter((r) => !r.ok);
    if (bad.length) {
      console.error(`${bad.length} asset(s) failed validation`);
      process.exit(1);
    }
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (process.argv.includes('--markdown')) {
    console.log(toMarkdown(rows));
  } else {
    for (const r of rows) {
      const lods = Object.keys(r.lods).sort().map((k) => `${k}=${r.lods[k]}`).join(' ');
      console.log(
        `${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(18)} tris=${String(r.tris).padStart(6)} ` +
        `${lods.padEnd(34)} meshes=${r.meshes} mats=${r.materials} tex=${r.textures} ` +
        `${kb(r.bytes).padStart(10)}${r.draco ? ' draco' : ''}` +
        (r.ok ? '' : `  <- ${r.errors.join('; ')}`),
      );
    }
    const total = rows.reduce((a, r) => a + r.lod0Tris, 0);
    const bytes = rows.reduce((a, r) => a + r.bytes, 0);
    console.log(`\n${rows.length} assets, LOD0 total ${total} tris, ${kb(bytes)} on disk`);
    const bad = rows.filter((r) => !r.ok);
    if (total > TOTAL_LOD0_BUDGET) {
      console.error(`\nOVER GLOBAL BUDGET: ${total} > ${TOTAL_LOD0_BUDGET} LOD0 tris`);
    }
    if (bad.length || total > TOTAL_LOD0_BUDGET) {
      if (bad.length) console.error(`\n${bad.length} asset(s) failed validation`);
      process.exit(1);
    }
  }
}
