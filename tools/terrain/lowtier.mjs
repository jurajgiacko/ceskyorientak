#!/usr/bin/env node
/**
 * The `low` tier heightfield, derived so that it *agrees* with the full one.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 *
 * `height-low.bin` used to be a box-average of the source elevation, re-encoded
 * over its own min/max. That is the obvious way to build a cheap heightmap and
 * it is wrong here, for a reason that has nothing to do with how the terrain
 * looks.
 *
 * The heightfield is not only drawn. `generateCourse` reads it for the per-leg
 * climb budget, and the athlete's speed reads its gradient. A box-average over
 * a *different* normalisation disagrees with the full raster by a couple of
 * millimetres everywhere — and a couple of millimetres is enough, because the
 * seeded RNG in `pickNextControl` is consumed inside geometry-dependent
 * branches: flip one candidate and every subsequent draw diverges. Measured on
 * Krumlov, 3 of 4 seeds produced a different sprint course on `low` than on
 * `high` — seed 29760961 gave 1441 m on a phone and 1787 m on a desktop. Two
 * players, one seed, two different races.
 *
 * So the low tier is a **point decimation of the encoded full raster**, sharing
 * its `minH`/`maxH`/`stepMm`. Every 4 m lattice node then holds the *identical
 * uint16* in both files and decodes through the identical scale, so the surface
 * `FieldTerrain` computes the rules on (see `RULES_CELL_M` in
 * `src/race/terrainAdapter.ts`) is bit-for-bit the same on every tier, at no
 * extra bytes. Shipping one heightfield would do it too, and costs the phone
 * 4.2 MB gzip on Krumlov and 9.7 MB on Martinkov against a 25 MB budget; this
 * costs nothing.
 *
 * Decimation loses the box-average's noise suppression. That is the right trade
 * twice over: DMR 5G is already a smoothed product at 1 m, and the 4 m lattice
 * is what the map's contours are extracted on (`CONTOUR_CELL_M`), where a
 * point sample is what you want anyway.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *
 *   node tools/terrain/lowtier.mjs                  # every built venue
 *   node tools/terrain/lowtier.mjs --venue=krumlov
 *
 * `build.mjs` imports `decimateHeight16` so the pipeline and this rewriter can
 * never drift apart. Running it standalone re-derives the low tier from the
 * `height.bin` already on disk, which is what you want when the full raster has
 * not changed and refetching ČÚZK would take an hour to produce the same bytes.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, '..', '..', 'public', 'data');

/**
 * Point-decimate an encoded uint16 heightfield by `factor`.
 *
 * Node (i, j) of the result is cell (i*factor, j*factor) of the source —
 * *unchanged*, not re-quantised — so the two rasters hold equal values at every
 * shared lattice node and decode identically as long as the caller carries the
 * source's `minH`/`maxH` into the sidecar. That equality is the whole point;
 * see the header.
 *
 * The output dimensions match what a box-average of the same factor produced,
 * so nothing downstream has to learn a new size.
 */
export function decimateHeight16(src, width, height, factor) {
  const w = Math.floor((width - 1) / factor) + 1;
  const h = Math.floor((height - 1) / factor) + 1;
  const out = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) {
    const sj = Math.min(height - 1, j * factor);
    for (let i = 0; i < w; i++) {
      const si = Math.min(width - 1, i * factor);
      out[j * w + i] = src[sj * width + si];
    }
  }
  return { data: out, w, h };
}

/**
 * The sidecar for a decimated tier.
 *
 * `minH`, `maxH` and `stepMm` are the *source's*, deliberately. Re-deriving
 * them from the decimated subset would narrow the range by a few centimetres
 * and re-scale every sample, which is exactly the disagreement this file
 * exists to remove.
 */
export function lowMeta(hMeta, w, h, factor) {
  return {
    format: 'uint16le',
    width: w,
    height: h,
    resM: hMeta.resM * factor,
    minH: hMeta.minH,
    maxH: hMeta.maxH,
    originX: hMeta.originX,
    originZ: hMeta.originZ,
    stepMm: hMeta.stepMm,
    /**
     * Read by nothing at runtime; here so that anyone holding the file can see
     * that it is not an independent survey but a view of `height.bin`.
     */
    derivedFrom: { file: 'height.bin', decimateBy: factor },
  };
}

// ---------------------------------------------------------------------------
// Standalone rewrite
// ---------------------------------------------------------------------------

async function rewrite(venue) {
  const dir = join(OUT_ROOT, venue);
  if (!existsSync(join(dir, 'height.bin'))) {
    console.log(`· ${venue}: no height.bin — nothing to derive from`);
    return false;
  }
  const hMeta = JSON.parse(await readFile(join(dir, 'height.json'), 'utf8'));
  const lowPath = join(dir, 'height-low.json');
  // The factor comes from the low sidecar already on disk, so this tool never
  // has to know a venue's tier policy — build.mjs owns that.
  const prev = existsSync(lowPath) ? JSON.parse(await readFile(lowPath, 'utf8')) : null;
  const factor = Math.round((prev?.resM ?? 4) / hMeta.resM);

  const buf = await readFile(join(dir, 'height.bin'));
  const src = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  if (src.length !== hMeta.width * hMeta.height) {
    throw new Error(
      `${venue}/height.bin is ${src.length} samples, sidecar says ${hMeta.width}x${hMeta.height}`,
    );
  }

  const { data, w, h } = decimateHeight16(src, hMeta.width, hMeta.height, factor);
  const meta = lowMeta(hMeta, w, h, factor);
  await writeFile(join(dir, 'height-low.bin'), Buffer.from(data.buffer, 0, data.byteLength));
  await writeFile(join(dir, 'height-low.json'), JSON.stringify(meta, null, 2) + '\n');

  // Prove the invariant here rather than trusting it downstream: every low node
  // must be the identical uint16 at the identical world position.
  const scale = (hMeta.maxH - hMeta.minH) / 65535;
  let worst = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const a = hMeta.minH + data[j * w + i] * scale;
      const b =
        hMeta.minH + src[Math.min(hMeta.height - 1, j * factor) * hMeta.width + Math.min(hMeta.width - 1, i * factor)] * scale;
      const d = Math.abs(a - b);
      if (d > worst) worst = d;
    }
  }
  if (worst !== 0) throw new Error(`${venue}: decimation is not exact (${worst} m)`);

  console.log(
    `· ${venue}: height-low.bin ${w}×${h} at ${meta.resM} m, decimated 1:${factor} from height.bin ` +
      `(${(data.byteLength / 1024).toFixed(0)} kB, exact at every shared node)`,
  );
  return true;
}

async function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--venue='));
  const venues = arg ? [arg.slice(8)] : ['krumlov', 'martinkov'];
  for (const v of venues) await rewrite(v);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
