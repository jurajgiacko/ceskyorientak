#!/usr/bin/env node
/**
 * tools/imagegen/validate.mjs — numeric tiling / lighting validation.
 *
 * Three real measurements per tileable texture (no eyeballing):
 *
 * A) SEAM ENERGY.  For the wrap boundary in each axis, mean absolute
 *    difference across the boundary is compared against the distribution of
 *    MADs between every interior adjacent line pair. Reported as
 *      ratio = MAD(boundary) / mean(MAD(interior))
 *      z     = (MAD(boundary) - mean) / stddev
 *    A perfectly tiling texture has ratio ~1.0: the wrap is statistically
 *    indistinguishable from any other place you could cut the image.
 *
 * B) REPETITION BANDING.  Circular autocorrelation of the mean-subtracted
 *    luminance, computed with an FFT (ACF = IFFT(|FFT(x)|^2)) per row and per
 *    column, then averaged. The strongest normalised peak at a lag in
 *    [N/16, N/2] is reported with its lag. A large peak means the texture has
 *    a dominant low-frequency period, which reads as banding when tiled.
 *
 * C) BAKED ILLUMINATION.  Least-squares fit of a linear ramp (a*x+b*y+c) and
 *    of a radial vignette term to the luminance field. Reported as the
 *    peak-to-peak swing of the fitted component relative to mean luminance.
 *    Textures must be flat-lit, so both must be near zero.
 *
 * Usage:
 *   node tools/imagegen/validate.mjs
 *   node tools/imagegen/validate.mjs --map=normal --size=1024 --json
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TEX_DIR = resolve(ROOT, 'public/textures');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');

export const THRESHOLDS = {
  seamRatio: 1.35,   // boundary MAD may not exceed 1.35x the interior mean
  seamZ: 4.0,        // ...nor sit 4 sigma out in the interior MAD distribution
  acfPeak: 0.30,     // normalised autocorrelation peak at lag >= N/16
  illumRamp: 0.06,   // linear brightness ramp, fraction of mean luminance
  illumVignette: 0.05 // radial falloff, fraction of mean luminance
};

const args = process.argv.slice(2);
const mapArg = args.find((a) => a.startsWith('--map='));
const MAP = mapArg ? mapArg.slice(6) : 'albedo';
const sizeArg = args.find((a) => a.startsWith('--size='));
const SIZE = sizeArg ? Number(sizeArg.slice(7)) : 1024;
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const JSON_OUT = args.includes('--json');

/* -------------------------------------------------------------------- FFT */

/** In-place iterative radix-2 Cooley-Tukey. n must be a power of two. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Circular autocorrelation of one mean-subtracted line. Returns unnormalised. */
function acf1D(line, re, im) {
  const n = line.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += line[i];
  mean /= n;
  for (let i = 0; i < n; i++) { re[i] = line[i] - mean; im[i] = 0; }
  fft(re, im, false);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  return re;
}

const isPow2 = (n) => (n & (n - 1)) === 0 && n > 0;

/* ------------------------------------------------------------------ tests */

/** A) seam energy in one axis. */
function seamEnergy(L, w, h, axis) {
  const mads = [];
  let boundary = 0;
  if (axis === 'x') {
    for (let y = 0; y < h; y++) boundary += Math.abs(L[y * w] - L[y * w + w - 1]);
    boundary /= h;
    for (let x = 1; x < w; x++) {
      let m = 0;
      for (let y = 0; y < h; y++) m += Math.abs(L[y * w + x] - L[y * w + x - 1]);
      mads.push(m / h);
    }
  } else {
    for (let x = 0; x < w; x++) boundary += Math.abs(L[x] - L[(h - 1) * w + x]);
    boundary /= w;
    for (let y = 1; y < h; y++) {
      let m = 0;
      for (let x = 0; x < w; x++) m += Math.abs(L[y * w + x] - L[(y - 1) * w + x]);
      mads.push(m / w);
    }
  }
  const mean = mads.reduce((a, b) => a + b, 0) / mads.length;
  const varr = mads.reduce((a, b) => a + (b - mean) ** 2, 0) / mads.length;
  const sd = Math.sqrt(varr) || 1e-9;
  return { boundary, mean, sd, ratio: boundary / (mean || 1e-9), z: (boundary - mean) / sd };
}

/** B) dominant periodicity from averaged circular ACF. */
function repetition(L, w, h) {
  if (!isPow2(w) || !isPow2(h)) return { peak: NaN, lag: NaN, note: 'non-pow2' };
  const acc = new Float64Array(w);
  let acc0 = 0;
  const re = new Float64Array(w), im = new Float64Array(w), line = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = L[y * w + x];
    const a = acf1D(line, re, im);
    acc0 += a[0];
    for (let k = 0; k < w; k++) acc[k] += a[k];
  }
  const accV = new Float64Array(h);
  let accV0 = 0;
  const reV = new Float64Array(h), imV = new Float64Array(h), lineV = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) lineV[y] = L[y * w + x];
    const a = acf1D(lineV, reV, imV);
    accV0 += a[0];
    for (let k = 0; k < h; k++) accV[k] += a[k];
  }
  const scan = (acc, a0, n) => {
    const lo = Math.max(2, Math.floor(n / 16));
    const hi = Math.floor(n / 2);
    let peak = -Infinity, lag = -1;
    for (let k = lo; k <= hi; k++) {
      const v = acc[k] / (a0 || 1e-9);
      if (v > peak) { peak = v; lag = k; }
    }
    return { peak, lag };
  };
  const X = scan(acc, acc0, w);
  const Y = scan(accV, accV0, h);
  return X.peak >= Y.peak
    ? { peak: X.peak, lag: X.lag, axis: 'x' }
    : { peak: Y.peak, lag: Y.lag, axis: 'y' };
}

/** C) baked illumination: linear ramp + radial vignette, as fraction of mean. */
function illumination(L, w, h) {
  const n = w * h;
  let sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sL = 0, sXL = 0, sYL = 0;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1) - 0.5;
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1) - 0.5;
      const l = L[y * w + x];
      sX += u; sY += v; sXX += u * u; sYY += v * v; sXY += u * v;
      sL += l; sXL += u * l; sYL += v * l;
    }
  }
  const mean = sL / n;
  /* u and v are symmetric about 0 so the normal equations decouple cleanly */
  const a = (sXL - mean * sX) / (sXX - sX * sX / n);
  const b = (sYL - mean * sY) / (sYY - sY * sY / n);
  /* peak-to-peak of the fitted plane over u,v in [-0.5,0.5] */
  const ramp = (Math.abs(a) + Math.abs(b)) / (mean || 1e-9);

  /* radial term: fit l ~ c + d*r2 */
  let sR = 0, sRR = 0, sRL = 0;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1) - 0.5;
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1) - 0.5;
      const r2 = u * u + v * v;
      const l = L[y * w + x];
      sR += r2; sRR += r2 * r2; sRL += r2 * l;
    }
  }
  const d = (sRL - sR * sL / n) / (sRR - sR * sR / n);
  const vignette = Math.abs(d) * 0.5 / (mean || 1e-9); // r2 spans 0..0.5
  return { ramp, vignette, mean };
}

/* ------------------------------------------------------------------- main */

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const targets = manifest.assets.filter(
  (a) => a.tileable && (!ONLY || ONLY.has(a.id))
);

const rows = [];
for (const a of targets) {
  const file = SIZE === 1024 ? `${MAP}.webp` : `${MAP}@${SIZE}.webp`;
  const path = resolve(TEX_DIR, a.id, file);
  if (!existsSync(path)) { rows.push({ id: a.id, missing: true }); continue; }

  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const L = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    L[i] = ch === 1
      ? data[i]
      : 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2];
  }

  const sx = seamEnergy(L, w, h, 'x');
  const sy = seamEnergy(L, w, h, 'y');
  const rep = repetition(L, w, h);
  const ill = illumination(L, w, h);

  const fail = [];
  if (sx.ratio > THRESHOLDS.seamRatio || sx.z > THRESHOLDS.seamZ) fail.push('seam-x');
  if (sy.ratio > THRESHOLDS.seamRatio || sy.z > THRESHOLDS.seamZ) fail.push('seam-y');
  if (rep.peak > THRESHOLDS.acfPeak) fail.push('repeat');
  if (ill.ramp > THRESHOLDS.illumRamp) fail.push('ramp');
  if (ill.vignette > THRESHOLDS.illumVignette) fail.push('vignette');

  rows.push({ id: a.id, sx, sy, rep, ill, fail, pass: fail.length === 0 });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ map: MAP, size: SIZE, thresholds: THRESHOLDS, rows }, null, 2));
} else {
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : ' n/a');
  console.log(`\ntiling validation · map=${MAP} · ${SIZE}px`);
  console.log(
    `thresholds: seam ratio<=${THRESHOLDS.seamRatio} z<=${THRESHOLDS.seamZ} · ` +
    `acf peak<=${THRESHOLDS.acfPeak} · ramp<=${THRESHOLDS.illumRamp} · vign<=${THRESHOLDS.illumVignette}\n`
  );
  const head =
    'texture'.padEnd(24) + 'seamX'.padStart(7) + 'zX'.padStart(7) +
    'seamY'.padStart(7) + 'zY'.padStart(7) + 'acf'.padStart(7) +
    'lag'.padStart(6) + 'ramp'.padStart(7) + 'vign'.padStart(7) + '  result';
  console.log(head);
  console.log('-'.repeat(head.length + 6));
  for (const r of rows) {
    if (r.missing) { console.log(r.id.padEnd(24) + '  (not generated)'); continue; }
    console.log(
      r.id.padEnd(24) +
      f(r.sx.ratio).padStart(7) + f(r.sx.z, 1).padStart(7) +
      f(r.sy.ratio).padStart(7) + f(r.sy.z, 1).padStart(7) +
      f(r.rep.peak, 3).padStart(7) + String(r.rep.lag).padStart(6) +
      f(r.ill.ramp, 3).padStart(7) + f(r.ill.vignette, 3).padStart(7) +
      '  ' + (r.pass ? 'PASS' : 'FAIL ' + r.fail.join(','))
    );
  }
  const checked = rows.filter((r) => !r.missing);
  console.log(`\n${checked.filter((r) => r.pass).length}/${checked.length} pass` +
    (rows.length - checked.length ? ` · ${rows.length - checked.length} not generated` : ''));
}

if (rows.some((r) => !r.missing && !r.pass)) process.exit(2);
