#!/usr/bin/env node
/**
 * tools/imagegen/pbr.mjs — albedo PNG  ->  tileable PBR texture set.
 *
 * Pipeline per texture:
 *   1. load  .cache/<id>.png, resize to WORK (1024) sRGB RGB
 *   2. TILEABLE: 50% offset wrap, then heal the interior seam cross with
 *      (a) a 1-D Poisson / membrane correction  (removes the tonal step)
 *      (b) a narrow mirrored cross-blend        (removes the structural step)
 *   3. HEIGHT:  linear luminance, high-passed against a large blur so that
 *      broad albedo variation does not become geometry, then softened.
 *   4. NORMAL:  wrap-aware Sobel on height -> tangent space, OpenGL green-up.
 *   5. ROUGHNESS: local std-dev of luminance, percentile-normalised, remapped
 *      into the material's [lo,hi] range.
 *   6. AO: multi-scale cavity (blurred height minus height) over 4 radii.
 *   7. write 1024 / 512 / 256 WebP.  Down-scales are exact 2x/4x box filters,
 *      which are wrap-safe by construction (no resampler edge bleed).
 *
 * All neighbourhood ops wrap. Nothing in here breaks the tiling it just made.
 *
 * CLI:  node tools/imagegen/pbr.mjs [--only=a,b] [--force] [--work=1024]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '../..');
export const CACHE_DIR = resolve(__dirname, '.cache');
export const TEX_DIR = resolve(ROOT, 'public/textures');
export const MANIFEST_PATH = resolve(__dirname, 'manifest.json');

export const MAP_NAMES = ['albedo', 'normal', 'roughness', 'ao'];
export const SIZES = [1024, 512, 256];

const DEFAULT_MATERIAL = {
  heightStrength: 1.0,
  roughRange: [0.55, 0.9],
  aoStrength: 0.85,
  heightBlur: 0.7,
  /* fraction of half-width used by the membrane solve; 1.0 = harmonic */
  membrane: 1.0,
  /* mirrored blend band, fraction of width */
  mirrorBand: 0.02
};

/* ---------------------------------------------------------------- helpers */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);

/** Separable moving-average, wrap-around, horizontal. */
function boxH(src, dst, w, h, r) {
  r = Math.min(r, Math.floor((w - 1) / 2));
  if (r < 1) { dst.set(src); return; }
  const win = 2 * r + 1, inv = 1 / win;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + ((k % w) + w) % w];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv;
      const out = ((x - r) % w + w) % w;
      const inn = ((x + r + 1) % w + w) % w;
      sum += src[row + inn] - src[row + out];
    }
  }
}

/** Separable moving-average, wrap-around, vertical. */
function boxV(src, dst, w, h, r) {
  r = Math.min(r, Math.floor((h - 1) / 2));
  if (r < 1) { dst.set(src); return; }
  const win = 2 * r + 1, inv = 1 / win;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[(((k % h) + h) % h) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      const out = ((y - r) % h + h) % h;
      const inn = ((y + r + 1) % h + h) % h;
      sum += src[inn * w + x] - src[out * w + x];
    }
  }
}

/** 3 box passes ~= Gaussian, wrap-around. Returns a new plane. */
export function blurWrap(src, w, h, sigma) {
  if (sigma < 0.5) return Float32Array.from(src);
  const r = Math.max(1, Math.round(sigma * 0.9));
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  for (let p = 0; p < 3; p++) {
    boxH(a, b, w, h, r); boxV(b, a, w, h, r);
  }
  return a;
}

/** 1-D circular gaussian-ish smoothing of a profile (used on the seam jump). */
function smooth1D(src, sigma) {
  const n = src.length;
  const r = Math.max(1, Math.round(sigma * 0.9));
  let a = Float32Array.from(src), b = new Float32Array(n);
  for (let p = 0; p < 3; p++) {
    const win = 2 * r + 1, inv = 1 / win;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += a[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      b[i] = sum * inv;
      sum += a[((i + r + 1) % n + n) % n] - a[((i - r) % n + n) % n];
    }
    [a, b] = [b, a];
  }
  return a;
}

function percentile(plane, p) {
  const n = plane.length;
  const step = Math.max(1, Math.floor(n / 200000));
  const s = [];
  for (let i = 0; i < n; i += step) s.push(plane[i]);
  s.sort((x, y) => x - y);
  return s[clamp(Math.floor(p * (s.length - 1)), 0, s.length - 1)];
}

/* --------------------------------------------------------------- tileable */

/** Wrap-offset an interleaved RGB plane set by (dx,dy). */
function offsetWrap(planes, w, h, dx, dy) {
  return planes.map((src) => {
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = ((y - dy) % h + h) % h;
      for (let x = 0; x < w; x++) {
        const sx = ((x - dx) % w + w) % w;
        dst[y * w + x] = src[sy * w + sx];
      }
    }
    return dst;
  });
}

/**
 * 1-D Poisson (membrane) correction across a vertical seam at column `c`.
 *
 * The discrete harmonic solution on a circular 1-D domain with a single jump
 * is a constant-slope ramp, so the correction is exactly linear in distance
 * from the seam and reaches 0 at the (already continuous) wrap boundary.
 * The jump profile is low-passed along the seam first: only the low-frequency
 * mismatch is what the eye reads as a seam, and spreading the high-frequency
 * part would imprint streaks.
 */
function membraneV(plane, w, h, c, bandFrac) {
  const B = Math.max(2, Math.round((w / 2) * bandFrac));
  const jump = new Float32Array(h);
  for (let y = 0; y < h; y++) jump[y] = plane[y * w + c] - plane[y * w + c - 1];
  const J = smooth1D(jump, h / 48);
  for (let y = 0; y < h; y++) {
    const half = J[y] * 0.5;
    const row = y * w;
    for (let d = 0; d < B; d++) {
      const wgt = 1 - d / (B - 1);
      const xl = c - 1 - d, xr = c + d;
      if (xl >= 0) plane[row + xl] += half * wgt;
      if (xr < w) plane[row + xr] -= half * wgt;
    }
  }
}

function membraneH(plane, w, h, c, bandFrac) {
  const B = Math.max(2, Math.round((h / 2) * bandFrac));
  const jump = new Float32Array(w);
  for (let x = 0; x < w; x++) jump[x] = plane[c * w + x] - plane[(c - 1) * w + x];
  const J = smooth1D(jump, w / 48);
  for (let x = 0; x < w; x++) {
    const half = J[x] * 0.5;
    for (let d = 0; d < B; d++) {
      const wgt = 1 - d / (B - 1);
      const yt = c - 1 - d, yb = c + d;
      if (yt >= 0) plane[yt * w + x] += half * wgt;
      if (yb < h) plane[yb * w + x] -= half * wgt;
    }
  }
}

/**
 * Mirrored cross-blend over a narrow band around the seam.
 * out[c+k] = (1-t)I[c+k] + t*I[c-1-k], out[c-1-k] = (1-t)I[c-1-k] + t*I[c+k]
 * with t = 0.5 at k=0 -> the two pixels straddling the seam become identical,
 * i.e. C0 continuity is guaranteed, not merely faded towards.
 */
function mirrorBlendV(plane, w, h, c, band) {
  const B = Math.max(2, band);
  const src = Float32Array.from(plane);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let k = 0; k < B; k++) {
      const s = 1 - k / B;              // 1 -> 0
      const t = 0.5 * s * s * (3 - 2 * s); // smoothstep, 0.5 at the seam
      const xr = c + k, xl = c - 1 - k;
      if (xr >= w || xl < 0) break;
      const a = src[row + xr], b = src[row + xl];
      plane[row + xr] = a * (1 - t) + b * t;
      plane[row + xl] = b * (1 - t) + a * t;
    }
  }
}

function mirrorBlendH(plane, w, h, c, band) {
  const B = Math.max(2, band);
  const src = Float32Array.from(plane);
  for (let x = 0; x < w; x++) {
    for (let k = 0; k < B; k++) {
      const s = 1 - k / B;
      const t = 0.5 * s * s * (3 - 2 * s);
      const yb = c + k, yt = c - 1 - k;
      if (yb >= h || yt < 0) break;
      const a = src[yb * w + x], b = src[yt * w + x];
      plane[yb * w + x] = a * (1 - t) + b * t;
      plane[yt * w + x] = b * (1 - t) + a * t;
    }
  }
}

export function makeTileable(planes, w, h, mat) {
  const out = offsetWrap(planes, w, h, w >> 1, h >> 1);
  const cx = w >> 1, cy = h >> 1;
  const band = Math.max(4, Math.round(w * mat.mirrorBand));
  for (const p of out) {
    membraneV(p, w, h, cx, mat.membrane);
    membraneH(p, w, h, cy, mat.membrane);
    mirrorBlendV(p, w, h, cx, band);
    mirrorBlendH(p, w, h, cy, band);
    for (let i = 0; i < p.length; i++) p[i] = clamp(p[i], 0, 1);
  }
  return out;
}

/* ----------------------------------------------------------------- height */

export function buildHeight(lin, w, h, mat) {
  /* high-pass: remove structure larger than ~1/8 of the tile so that a dark
     lichen patch does not become a crater, while per-cobble scale survives. */
  const lowPass = blurWrap(lin, w, h, w / 8);
  const hp = new Float32Array(w * h);
  for (let i = 0; i < hp.length; i++) hp[i] = lin[i] - lowPass[i];
  const lo = percentile(hp, 0.005), hi = percentile(hp, 0.995);
  const range = Math.max(1e-5, hi - lo);
  for (let i = 0; i < hp.length; i++) hp[i] = clamp((hp[i] - lo) / range, 0, 1);
  return mat.heightBlur > 0 ? blurWrap(hp, w, h, mat.heightBlur * 1.6) : hp;
}

/* ----------------------------------------------------------------- normal */

export function buildNormal(height, w, h, strength) {
  const rgb = Buffer.alloc(w * h * 3);
  const at = (x, y) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  const s = strength * 6.0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
      const ml = at(x - 1, y), mr = at(x + 1, y);
      const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
      /* Sobel, /8 to keep the operator normalised */
      const gx = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) / 8;
      const gy = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) / 8;
      /* image +y is down; texture V is up => dh/dV = -gy => n.y = +gy  */
      let nx = -gx * s, ny = gy * s, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * w + x) * 3;
      rgb[o] = clamp(Math.round((nx * 0.5 + 0.5) * 255), 0, 255);
      rgb[o + 1] = clamp(Math.round((ny * 0.5 + 0.5) * 255), 0, 255);
      rgb[o + 2] = clamp(Math.round((nz * 0.5 + 0.5) * 255), 0, 255);
    }
  }
  return rgb;
}

/* -------------------------------------------------------------- roughness */

export function buildRoughness(lin, w, h, mat) {
  const r = Math.max(2, Math.round(w / 256)); // ~4px at 1024
  const sq = new Float32Array(w * h);
  for (let i = 0; i < sq.length; i++) sq[i] = lin[i] * lin[i];
  const mean = blurWrap(lin, w, h, r);
  const meanSq = blurWrap(sq, w, h, r);
  const std = new Float32Array(w * h);
  for (let i = 0; i < std.length; i++) {
    std[i] = Math.sqrt(Math.max(0, meanSq[i] - mean[i] * mean[i]));
  }
  const lo = percentile(std, 0.05), hi = percentile(std, 0.95);
  const range = Math.max(1e-5, hi - lo);
  const [rl, rh] = mat.roughRange;
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < std.length; i++) {
    const t = clamp((std[i] - lo) / range, 0, 1);
    out[i] = clamp(Math.round((rl + (rh - rl) * t) * 255), 0, 255);
  }
  return out;
}

/* --------------------------------------------------------------------- AO */

const AO_SCALES = [
  { sigma: 3, weight: 0.34 },
  { sigma: 9, weight: 0.29 },
  { sigma: 24, weight: 0.22 },
  { sigma: 56, weight: 0.15 }
];

export function buildAO(height, w, h, mat) {
  const occ = new Float32Array(w * h);
  for (const { sigma, weight } of AO_SCALES) {
    const b = blurWrap(height, w, h, sigma * (w / 1024));
    for (let i = 0; i < occ.length; i++) {
      occ[i] += weight * clamp((b[i] - height[i]) * 3.0, 0, 1);
    }
  }
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < occ.length; i++) {
    out[i] = clamp(Math.round((1 - occ[i] * mat.aoStrength) * 255), 0, 255);
  }
  return out;
}

/* ------------------------------------------------------------ downscaling */

/** Exact NxN box decimation. Wrap-safe: never reads outside the tile. */
export function boxDecimate(buf, w, h, channels, factor) {
  const nw = w / factor, nh = h / factor;
  const out = Buffer.alloc(nw * nh * channels);
  const area = factor * factor;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * w;
          for (let dx = 0; dx < factor; dx++) {
            sum += buf[(row + x * factor + dx) * channels + c];
          }
        }
        out[(y * nw + x) * channels + c] = Math.round(sum / area);
      }
    }
  }
  return out;
}

/** Normals must be re-normalised after averaging, or the mips go flat/wrong. */
function renormalize(buf, n) {
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let x = buf[o] / 127.5 - 1, y = buf[o + 1] / 127.5 - 1, z = buf[o + 2] / 127.5 - 1;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len; y /= len; z /= len;
    buf[o] = clamp(Math.round((x * 0.5 + 0.5) * 255), 0, 255);
    buf[o + 1] = clamp(Math.round((y * 0.5 + 0.5) * 255), 0, 255);
    buf[o + 2] = clamp(Math.round((z * 0.5 + 0.5) * 255), 0, 255);
  }
  return buf;
}

const WEBP_OPTS = {
  albedo: { quality: 92, effort: 5 },
  normal: { quality: 96, effort: 5, smartSubsample: false },
  roughness: { quality: 88, effort: 5 },
  ao: { quality: 88, effort: 5 }
};

/* --------------------------------------------------------------- the pass */

export async function buildPbrSet(asset, opts = {}) {
  const WORK = opts.work || 1024;
  const mat = { ...DEFAULT_MATERIAL, ...(asset.material || {}) };
  const src = resolve(CACHE_DIR, `${asset.id}.png`);
  if (!existsSync(src)) throw new Error(`no cached source: ${src}`);

  const { data, info } = await sharp(src)
    .removeAlpha()
    .resize(WORK, WORK, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, n = w * h;

  /* sRGB byte planes -> normalised float planes */
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    planes[0][i] = data[i * 3] / 255;
    planes[1][i] = data[i * 3 + 1] / 255;
    planes[2][i] = data[i * 3 + 2] / 255;
  }

  const tiled = asset.tileable === false ? planes : makeTileable(planes, w, h, mat);

  /* albedo bytes */
  const albedo = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    albedo[i * 3] = clamp(Math.round(tiled[0][i] * 255), 0, 255);
    albedo[i * 3 + 1] = clamp(Math.round(tiled[1][i] * 255), 0, 255);
    albedo[i * 3 + 2] = clamp(Math.round(tiled[2][i] * 255), 0, 255);
  }

  /* linear luminance from the tiled albedo */
  const lin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lin[i] = 0.2126 * SRGB_LUT[albedo[i * 3]] +
             0.7152 * SRGB_LUT[albedo[i * 3 + 1]] +
             0.0722 * SRGB_LUT[albedo[i * 3 + 2]];
  }

  const height = buildHeight(lin, w, h, mat);
  const maps = {
    albedo: { buf: albedo, ch: 3 },
    normal: { buf: buildNormal(height, w, h, mat.heightStrength), ch: 3 },
    roughness: { buf: buildRoughness(lin, w, h, mat), ch: 1 },
    ao: { buf: buildAO(height, w, h, mat), ch: 1 }
  };

  const outDir = resolve(TEX_DIR, asset.id);
  mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const name of MAP_NAMES) {
    const { buf, ch } = maps[name];
    for (const size of SIZES) {
      const factor = w / size;
      let out = buf, ow = w;
      if (factor !== 1) {
        out = boxDecimate(buf, w, h, ch, factor);
        ow = size;
        if (name === 'normal') renormalize(out, size * size);
      }
      const file = size === SIZES[0] ? `${name}.webp` : `${name}@${size}.webp`;
      const path = resolve(outDir, file);
      await sharp(out, { raw: { width: ow, height: ow, channels: ch } })
        .webp(WEBP_OPTS[name])
        .toFile(path);
      written.push(path);
    }
  }
  return written;
}

/* -------------------------------------------------------------------- CLI */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
  const workArg = args.find((a) => a.startsWith('--work='));
  const work = workArg ? Number(workArg.slice(7)) : 1024;

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const targets = manifest.assets.filter(
    (a) => a.pbr && (!ONLY || ONLY.has(a.id)) && existsSync(resolve(CACHE_DIR, `${a.id}.png`))
  );
  console.log(`▶ pbr: ${targets.length} texture(s) · work=${work}`);
  for (const a of targets) {
    const t0 = Date.now();
    try {
      const files = await buildPbrSet(a, { work });
      console.log(`  ✓ ${a.id.padEnd(24)} ${files.length} files · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`  ✗ ${a.id}: ${e.message}`);
    }
  }
}
