#!/usr/bin/env node
/**
 * tools/imagegen/inspect.mjs — visual QA helper (dev only, no API calls).
 *
 * Writes contact sheets into tools/imagegen/.cache/_inspect/ :
 *   <id>.tile2x2.png   albedo repeated 2x2 at 512 each — seams show instantly
 *   <id>.maps.png      albedo | normal | roughness | ao side by side
 *
 * Usage: node tools/imagegen/inspect.mjs [--only=a,b] [--px=512]
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TEX = resolve(ROOT, 'public/textures');
const OUT = resolve(__dirname, '.cache/_inspect');

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const pxArg = args.find((a) => a.startsWith('--px='));
const PX = pxArg ? Number(pxArg.slice(5)) : 400;

const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

for (const a of manifest.assets.filter((x) => x.pbr && (!ONLY || ONLY.has(x.id)))) {
  const dir = resolve(TEX, a.id);
  if (!existsSync(resolve(dir, 'albedo.webp'))) continue;

  const cell = await sharp(resolve(dir, 'albedo.webp')).resize(PX, PX).png().toBuffer();
  await sharp({ create: { width: PX * 2, height: PX * 2, channels: 3, background: '#000' } })
    .composite([
      { input: cell, left: 0, top: 0 }, { input: cell, left: PX, top: 0 },
      { input: cell, left: 0, top: PX }, { input: cell, left: PX, top: PX }
    ])
    .png().toFile(resolve(OUT, `${a.id}.tile2x2.png`));

  const maps = [];
  for (const [i, m] of ['albedo', 'normal', 'roughness', 'ao'].entries()) {
    const buf = await sharp(resolve(dir, `${m}.webp`)).resize(PX, PX).toColourspace('srgb')
      .removeAlpha().ensureAlpha().png().toBuffer();
    maps.push({ input: buf, left: i * PX, top: 0 });
  }
  await sharp({ create: { width: PX * 4, height: PX, channels: 3, background: '#000' } })
    .composite(maps).png().toFile(resolve(OUT, `${a.id}.maps.png`));

  console.log(`  ✓ ${a.id}`);
}
console.log(`▶ ${OUT}`);
