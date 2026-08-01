#!/usr/bin/env node
/**
 * tools/imagegen/ktx2.mjs — GPU-compressed texture emission.
 *
 * WHY. WebP is a *transfer* format: it decodes to full uncompressed RGBA in
 * GPU memory, so a 1024 albedo costs 4 MB of VRAM no matter how small the file
 * was. 16 materials x 4 maps at 1024 is ~256 MB of VRAM, which a mid-range
 * Android phone does not have. KTX2/Basis stays compressed on the GPU: BC7 or
 * ASTC 4x4 is 1 byte/px (4x saving) and ETC1S transcodes to BC1/ETC1 at
 * 0.5 byte/px (8x saving), and it carries a mip chain so there is no runtime
 * mip generation cost either.
 *
 * FORMAT CHOICE, per map type, configured in manifest.json under `ktx2`:
 *   normal            -> UASTC. A normal map is a vector field; the WebP work
 *                        already proved it does not survive an 8-bit-ish lossy
 *                        codec. UASTC is 8bpp and transcodes to BC7/ASTC/ETC2.
 *   albedo/rough/ao   -> ETC1S. 4x smaller again, and the loss is acceptable
 *                        on colour and on low-frequency scalar maps.
 *
 * TILING. basisu generates mipmaps with WRAPPING addressing by default —
 * `-mip_clamp` is opt-in. Never pass it: clamped mip filtering would pull the
 * opposite edge in and undo the seam work at every mip level.
 *
 * SOURCE. Encodes from the raw maps out of pbr.mjs, not from the WebP files,
 * so a KTX2 is never a lossy re-encode of a lossy encode.
 *
 * CLI:
 *   node tools/imagegen/ktx2.mjs                  # all textures, all tiers
 *   node tools/imagegen/ktx2.mjs --only=moss
 *   node tools/imagegen/ktx2.mjs --sizes=1024      # one tier
 *   node tools/imagegen/ktx2.mjs --measure         # + PSNR/SSIM vs source
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { arch, platform } from 'node:os';
import sharp from 'sharp';
import { read as readKTX2 } from 'ktx-parse';
import { computeMaps, mapAtSize, MAP_NAMES, SIZES, TEX_DIR, ROOT, MANIFEST_PATH } from './pbr.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '.cache/_ktx2tmp');

/* ------------------------------------------------------------- the encoder */

/** Official Binomial basisu, shipped as prebuilt binaries by @gpu-tex-enc/basis. */
function findBasisu() {
  const p = platform() === 'darwin' ? 'darwin' : platform() === 'win32' ? 'win32' : 'linux';
  const a = arch() === 'arm64' ? 'arm64' : 'x64';
  const bin = resolve(ROOT, 'node_modules/.bin', `basisu-${p}-${a}`);
  if (!existsSync(bin)) {
    throw new Error(
      `basisu not found at ${bin}\n` +
      `  install it with:  npm i -D @gpu-tex-enc/basis`
    );
  }
  return bin;
}
const BASISU = findBasisu();

/**
 * Always run basisu with cwd inside .cache/. In -unpack mode it ignores
 * -output_path and writes one PNG per transcode target per mip level into the
 * current directory — 209 files from a single 1024 normal map. Run from the
 * repo root once and they land next to package.json, where the next `git add`
 * sweeps them into a commit.
 */
function basisu(args, { cwd = TMP, quiet = true } = {}) {
  mkdirSync(cwd, { recursive: true });
  try {
    return execFileSync(BASISU, args, { encoding: 'utf8', cwd, stdio: quiet ? 'pipe' : 'inherit' });
  } catch (e) {
    throw new Error(`basisu failed: ${(e.stdout || '') + (e.stderr || e.message)}`.slice(0, 600));
  }
}

/* ---------------------------------------------------------------- CLI args */

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim())) : null;
const sizesArg = args.find((a) => a.startsWith('--sizes='));
const USE_SIZES = sizesArg ? sizesArg.slice(8).split(',').map(Number) : SIZES;
const MEASURE = args.includes('--measure');
/* Re-print the summary from the last run's JSON without re-encoding (~7 min). */
const REPORT_ONLY = args.includes('--report');
/* Rebuild the report by reading the .ktx2 files already on disk. Use after a
   partial --only run, or when the report and the files have drifted apart. */
const SCAN = args.includes('--scan');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const KTX2_CFG = manifest.ktx2 || {};
const targets = manifest.assets.filter((a) => a.pbr && (!ONLY || ONLY.has(a.id)));

/* ------------------------------------------------------------- arg builder */

function encodeArgs(name, cfg, inPng, outKtx2) {
  const a = ['-file', inPng, '-output_file', outKtx2, '-ktx2', '-mipmap', '-mip_slow'];

  /* Colourspace. Only albedo is sRGB; normal/roughness/AO are data, and
     filtering them through an sRGB curve would be simply wrong. */
  if (cfg.colorspace === 'linear') a.push('-linear');

  if (cfg.mode === 'uastc') {
    a.push('-uastc');
    a.push('-uastc_level', String(cfg.uastcLevel ?? 2));
    if (cfg.rdoLambda) a.push('-uastc_rdo_l', String(cfg.rdoLambda));
    /* UASTC payloads are not entropy coded by the codec itself, so the KTX2
       container's zstd layer is what actually shrinks them. */
    a.push('-ktx2_zstandard_level', String(cfg.zstdLevel ?? 6));
  } else {
    a.push('-q', String(cfg.quality ?? 128));
    a.push('-comp_level', String(cfg.compLevel ?? 1));
  }

  /* -normal_map sets linear metrics, linear mip filtering and disables
     selector RDO; -mip_renorm renormalises to unit length after each mip
     filter, without which the mip chain drifts off the unit sphere and
     lighting goes flat at distance. */
  if (cfg.normalMap) a.push('-normal_map');
  if (cfg.mipRenorm) a.push('-mip_renorm');

  /* NOTE: -mip_clamp is deliberately never passed. basisu wraps by default,
     which is what keeps these tileable through the whole mip chain. */
  return a;
}

/* --------------------------------------------------------------- measuring */

/** Transcode the KTX2 back and compare against what went in. */
function measure(inPng, ktx2Path) {
  const dir = resolve(TMP, 'unpack');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    /* cwd, not -output_path: unpack ignores the latter. See basisu() above. */
    basisu(['-unpack', '-file', resolve(ktx2Path), '-no_ktx'], { cwd: dir });
  } catch {
    return null;
  }
  /* basisu writes <base>_unpacked_rgb_<fmt>_0_0000.png per transcode target;
     level 0 of the first RGB target is the one to compare. */
  const cands = readdirSync(dir).filter((f) => /_unpacked_rgb.*_0_0000\.png$/.test(f));
  if (!cands.length) return null;
  const got = resolve(dir, cands.sort()[0]);
  let out;
  try {
    out = basisu(['-compare', '-file', resolve(inPng), '-file', got], { cwd: dir });
  } catch {
    return null;
  }
  const psnr = /Peak signal-to-noise ratio:\s*([\d.]+)/i.exec(out)
    || /PSNR:\s*([\d.]+)/i.exec(out)
    || /RGB Avg:.*?PSNR\s*([\d.]+)/is.exec(out);
  const max = /Max\s*(?:component\s*)?error:\s*(\d+)/i.exec(out);
  return {
    psnr: psnr ? Number(psnr[1]) : null,
    maxErr: max ? Number(max[1]) : null,
    raw: out
  };
}

/* -------------------------------------------------------------------- main */

const REPORT_PATH = resolve(__dirname, 'ktx2-report.json');

let rows = [];
let totalWebp = 0, totalKtx2 = 0;

if (REPORT_ONLY || SCAN) {
  if (SCAN) {
    for (const asset of targets) {
      for (const name of MAP_NAMES) {
        const cfg = { ...(KTX2_CFG[name] || {}), ...((asset.ktx2 || {})[name] || {}) };
        for (const size of USE_SIZES) {
          const base = size === SIZES[0] ? name : `${name}@${size}`;
          const k = resolve(TEX_DIR, asset.id, `${base}.ktx2`);
          const wp = resolve(TEX_DIR, asset.id, `${base}.webp`);
          if (!existsSync(k)) continue;
          const parsed = readKTX2(new Uint8Array(readFileSync(k)));
          rows.push({
            id: asset.id, map: name, size, mode: cfg.mode,
            levels: parsed.levels.length, w: parsed.pixelWidth, h: parsed.pixelHeight,
            supercompression: parsed.supercompressionScheme,
            webpBytes: existsSync(wp) ? statSync(wp).size : 0,
            ktx2Bytes: statSync(k).size, psnr: null, maxErr: null
          });
        }
      }
    }
    rows.sort((a, b) => a.id.localeCompare(b.id) || a.map.localeCompare(b.map) || b.size - a.size);
    writeFileSync(REPORT_PATH, JSON.stringify({ rows, generatedAt: new Date().toISOString(), scanned: true }, null, 2) + '\n');
    console.log(`▶ scanned ${rows.length} existing .ktx2 files`);
  } else {
    rows = JSON.parse(readFileSync(REPORT_PATH, 'utf8')).rows;
  }
  for (const r of rows) { totalWebp += r.webpBytes; totalKtx2 += r.ktx2Bytes; }
} else {

mkdirSync(TMP, { recursive: true });
console.log(
  `▶ ktx2 · ${targets.length} texture(s) · tiers ${USE_SIZES.join('/')} · ` +
  `${relative(ROOT, BASISU)}${MEASURE ? ' · measuring' : ''}`
);

for (const asset of targets) {
  const t0 = Date.now();
  const { maps, w, h } = await computeMaps(asset);

  for (const name of MAP_NAMES) {
    const cfg = { ...(KTX2_CFG[name] || {}), ...((asset.ktx2 || {})[name] || {}) };
    if (!cfg.mode) throw new Error(`no ktx2 config for map "${name}"`);
    const { buf, ch } = maps[name];

    for (const size of USE_SIZES) {
      const { buf: out, size: ow } = mapAtSize(name, buf, w, h, ch, size);

      /* basisu reads PNG; feed it the exact bytes, RGB (it ignores a 4th). */
      const inPng = resolve(TMP, `${asset.id}-${name}-${size}.png`);
      await sharp(out, { raw: { width: ow, height: ow, channels: ch } })
        .png({ compressionLevel: 1 })
        .toFile(inPng);

      const base = size === SIZES[0] ? name : `${name}@${size}`;
      const outKtx2 = resolve(TEX_DIR, asset.id, `${base}.ktx2`);
      basisu(encodeArgs(name, cfg, inPng, outKtx2));

      /* Verify it is a real KTX2 and record what the container actually says. */
      const parsed = readKTX2(new Uint8Array(readFileSync(outKtx2)));
      const ktx2Bytes = statSync(outKtx2).size;
      const webpPath = resolve(TEX_DIR, asset.id, `${base}.webp`);
      const webpBytes = existsSync(webpPath) ? statSync(webpPath).size : 0;
      totalWebp += webpBytes;
      totalKtx2 += ktx2Bytes;

      const m = MEASURE ? measure(inPng, outKtx2) : null;
      rows.push({
        id: asset.id, map: name, size,
        mode: cfg.mode,
        levels: parsed.levels.length,
        w: parsed.pixelWidth, h: parsed.pixelHeight,
        supercompression: parsed.supercompressionScheme,
        webpBytes, ktx2Bytes,
        psnr: m?.psnr ?? null, maxErr: m?.maxErr ?? null
      });
      rmSync(inPng, { force: true });
    }
  }
  console.log(`  ✓ ${asset.id.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

rmSync(TMP, { recursive: true, force: true });

/* Merge into the previous report, keyed by id/map/size, so a --only run does
   not silently reduce the summary to whatever subset was just encoded. */
let merged = [];
if (existsSync(REPORT_PATH)) {
  try { merged = JSON.parse(readFileSync(REPORT_PATH, 'utf8')).rows || []; } catch { /* rewrite */ }
}
const key = (r) => `${r.id}|${r.map}|${r.size}`;
const index = new Map(merged.map((r) => [key(r), r]));
for (const r of rows) index.set(key(r), r);
const all = [...index.values()].sort((a, b) =>
  a.id.localeCompare(b.id) || a.map.localeCompare(b.map) || b.size - a.size);
writeFileSync(REPORT_PATH, JSON.stringify({ rows: all, generatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/* ------------------------------------------------------------------ report */

const byMap = {};
for (const r of rows) {
  const k = `${r.map} (${r.mode})`;
  byMap[k] ??= { webp: 0, ktx2: 0, n: 0, psnr: [], levels: new Set() };
  byMap[k].webp += r.webpBytes;
  byMap[k].ktx2 += r.ktx2Bytes;
  byMap[k].n++;
  byMap[k].levels.add(r.levels);
  if (r.psnr != null) byMap[k].psnr.push(r.psnr);
}

const mb = (b) => (b / 1048576).toFixed(2).padStart(7);
console.log(`\n${'map (mode)'.padEnd(20)}${'files'.padStart(6)}${'WebP MB'.padStart(9)}${'KTX2 MB'.padStart(9)}${'ratio'.padStart(8)}${'mips'.padStart(6)}${MEASURE ? '   PSNR dB' : ''}`);
console.log('-'.repeat(MEASURE ? 68 : 58));
for (const [k, v] of Object.entries(byMap)) {
  const p = v.psnr.length ? (v.psnr.reduce((a, b) => a + b, 0) / v.psnr.length).toFixed(1) : '';
  console.log(
    k.padEnd(20) + String(v.n).padStart(6) + mb(v.webp) + mb(v.ktx2) +
    (v.webp / v.ktx2).toFixed(2).concat('x').padStart(8) +
    [...v.levels].join('/').padStart(6) +
    (MEASURE ? p.padStart(10) : '')
  );
}
console.log('-'.repeat(MEASURE ? 68 : 58));
console.log(
  'TOTAL'.padEnd(20) + String(rows.length).padStart(6) + mb(totalWebp) + mb(totalKtx2) +
  (totalWebp / totalKtx2).toFixed(2).concat('x').padStart(8)
);

/*
 * Per-tier budget. A device fetches exactly ONE tier, so these rows — not the
 * TOTAL above — are what the 4G and VRAM budgets are judged against.
 *
 * VRAM accounting, both sides on the same terms:
 *   WebP  decodes to RGBA8 (4 B/px) whatever the source channel count, because
 *         the browser hands three.js an ImageBitmap; mips are then generated on
 *         the GPU, so both paths carry the same 4/3 mip tail.
 *   KTX2  transcodes to BC7/ASTC 4x4 (1 B/px) for UASTC and BC1/ETC1
 *         (0.5 B/px) for ETC1S, and ships the mip chain already built.
 * On a device with no compressed-texture support at all the transcoder falls
 * back to RGBA8 and the saving is zero, but that is not a device this ships to.
 */
const MIP_TAIL = 4 / 3;
console.log('\nper-tier budget (one device downloads exactly one of these rows, all 16 materials):');
for (const size of USE_SIZES) {
  const t = rows.filter((r) => r.size === size);
  const wb = t.reduce((a, r) => a + r.webpBytes, 0);
  const kb = t.reduce((a, r) => a + r.ktx2Bytes, 0);
  const rgba = t.reduce((a, r) => a + r.w * r.h * 4, 0) * MIP_TAIL;
  const gpu = t.reduce((a, r) => a + r.w * r.h * (r.mode === 'uastc' ? 1 : 0.5), 0) * MIP_TAIL;
  console.log(
    `  ${String(size).padStart(4)}px  download ${mb(wb)} -> ${mb(kb)} MB` +
    `   VRAM ${mb(rgba)} -> ${mb(gpu)} MB  (${(rgba / gpu).toFixed(1)}x less)`
  );
}

console.log(`\n▶ ${relative(ROOT, REPORT_PATH)}`);
