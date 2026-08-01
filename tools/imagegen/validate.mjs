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
 *    column, then averaged.
 *      acf    = peak over lags [N/8, N/2] — periods of 2..8 repeats per tile.
 *               This is the gated number. A structure at that scale is what
 *               makes the eye lock onto the tile grid across a terrain patch.
 *      acfAll = strongest local maximum over lags [8, N/2], informational
 *               only: the material's own rhythm (roof tile courses, masonry
 *               beds, bark ribs). Not a defect, so it does not fail. A local
 *               maximum is used rather than a plain max because the plain max
 *               over short lags is just the short-range correlation decay
 *               every photograph has, which carries no information.
 *
 * C) BAKED ILLUMINATION.  Least-squares fit of a linear ramp (a*x+b*y+c) and
 *    of a radial vignette term to the luminance field. Reported as the
 *    peak-to-peak swing of the fitted component relative to mean luminance.
 *    Textures must be flat-lit, so both must be near zero.
 *
 * SCOPE. The build gate is the albedo, because that is the map the tiling pass
 * actually operates on and the only one where "baked lighting" is a meaningful
 * concept — a brightness ramp in a roughness map just means one side of the
 * material is genuinely rougher. normal/roughness/AO are derived from the
 * tiled albedo using exclusively wrap-around operators, so they inherit its
 * tiling by construction; `--selftest` proves that mechanically by checking
 * the derivation is equivariant under a wrap shift. Running with `--map=`
 * anything other than albedo is therefore diagnostic and never fails the build.
 *
 * Usage:
 *   node tools/imagegen/validate.mjs                 # the gate
 *   node tools/imagegen/validate.mjs --selftest      # prove derived maps wrap
 *   node tools/imagegen/validate.mjs --map=normal --size=512 --json
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TEX_DIR = resolve(ROOT, 'public/textures');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');

/**
 * Thresholds calibrated against a control set, not guessed. Measuring the raw
 * generated PNGs (whose wrap boundary is a real photographic cut) against the
 * shipped tiles gave:
 *
 *   raw / untreated : seam ratio 1.18 .. 2.29, z 2.8 .. 16.6
 *   shipped tiles   : seam ratio 0.92 .. 1.11, z -1.3 .. 1.5
 *
 * so 1.25 / 2.5 sits in the gap and separates the two populations. It flags 11
 * of the 12 control axes and clears all 16 shipped textures.
 *
 * Per-asset overrides live in manifest.json under `validate`, so any exception
 * is visible in version control next to the reason for it.
 */
export const THRESHOLDS = {
  seamRatio: 1.25,   // boundary MAD may not exceed 1.25x the interior mean
  seamZ: 2.5,        // ...nor sit 2.5 sigma out in the interior MAD spread
  acfPeak: 0.30,     // autocorrelation peak over lags [N/8, N/2]
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
const SELFTEST = args.includes('--selftest');
const GATED = MAP === 'albedo';

/* ------------------------------------------------------- derived-map proof */

/**
 * The derived maps tile because every operator in their derivation wraps.
 * Rather than assert that, check it: a pipeline built only from wrap-around
 * operators is equivariant under a circular shift, so
 *
 *     maps(roll(albedo, d))  ==  roll(maps(albedo), d)
 *
 * must hold to the last bit. If it does, no shift of the source can expose an
 * edge the derivation treats specially — which is exactly what "tileable"
 * means for a derived map. If someone later swaps in a clamped blur or a
 * non-wrapping Sobel, this fails immediately.
 */
async function selftest() {
  const { buildHeight, buildNormal, buildRoughness, buildAO } = await import('./pbr.mjs');
  const N = 128, D = 37; // deliberately not a factor of N
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const lin = new Float32Array(N * N);
  for (let i = 0; i < lin.length; i++) lin[i] = rng();
  /* add low-frequency structure so the large-radius passes are exercised too */
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      lin[y * N + x] = clamp01(lin[y * N + x] * 0.4 +
        0.3 + 0.3 * Math.sin(2 * Math.PI * x / N) * Math.cos(4 * Math.PI * y / N));
    }
  }
  const roll = (src, ch) => {
    const out = src instanceof Float32Array ? new Float32Array(src.length) : Buffer.alloc(src.length);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const sy = (y - D + N) % N, sx = (x - D + N) % N;
        for (let c = 0; c < ch; c++) out[(y * N + x) * ch + c] = src[(sy * N + sx) * ch + c];
      }
    }
    return out;
  };
  const mat = { heightStrength: 1.2, roughRange: [0.5, 0.9], aoStrength: 0.85, heightBlur: 0.7 };
  const derive = (L) => {
    const hgt = buildHeight(L, N, N, mat);
    return {
      normal: { buf: buildNormal(hgt, N, N, mat.heightStrength), ch: 3 },
      roughness: { buf: buildRoughness(L, N, N, mat), ch: 1 },
      ao: { buf: buildAO(hgt, N, N, mat), ch: 1 }
    };
  };
  const a = derive(lin);
  const b = derive(roll(lin, 1));
  let ok = true;
  console.log(`\nwrap-equivariance selftest · ${N}x${N}, shift ${D}px\n`);
  for (const name of ['normal', 'roughness', 'ao']) {
    const expect = roll(a[name].buf, a[name].ch);
    const got = b[name].buf;
    let maxDiff = 0;
    for (let i = 0; i < got.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i] - expect[i]));
    const pass = maxDiff <= 1; // 1 LSB of rounding slack
    ok &&= pass;
    console.log(`  ${name.padEnd(12)} max |maps(roll(A)) - roll(maps(A))| = ${maxDiff}   ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\n${ok ? 'derived maps are wrap-equivariant: they tile exactly as well as the albedo'
    : 'a non-wrapping operator has been introduced into the derivation'}\n`);
  process.exit(ok ? 0 : 3);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
  const scan = (acc, a0, lo, hi) => {
    let peak = -Infinity, lag = -1;
    for (let k = lo; k <= hi; k++) {
      const v = acc[k] / (a0 || 1e-9);
      if (v > peak) { peak = v; lag = k; }
    }
    return { peak, lag };
  };
  /* A period shows up as a local maximum. The plain max over short lags is
     just the monotone short-range decay every photograph has, so it says
     nothing — only turning points are evidence of a repeating structure. */
  const scanPeriodic = (acc, a0, lo, hi) => {
    let peak = -Infinity, lag = -1;
    for (let k = lo; k <= hi; k++) {
      if (acc[k] > acc[k - 1] && acc[k] >= acc[k + 1]) {
        const v = acc[k] / (a0 || 1e-9);
        if (v > peak) { peak = v; lag = k; }
      }
    }
    return { peak: peak === -Infinity ? 0 : peak, lag: lag < 0 ? 0 : lag };
  };
  const best = (a, b) => (a.peak >= b.peak ? a : b);
  const lowFreq = best(
    { ...scan(acc, acc0, Math.max(2, w >> 3), w >> 1), axis: 'x' },
    { ...scan(accV, accV0, Math.max(2, h >> 3), h >> 1), axis: 'y' }
  );
  const all = best(
    { ...scanPeriodic(acc, acc0, 8, (w >> 1) - 1), axis: 'x' },
    { ...scanPeriodic(accV, accV0, 8, (h >> 1) - 1), axis: 'y' }
  );
  return { ...lowFreq, allPeak: all.peak, allLag: all.lag };
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

if (SELFTEST) await selftest();

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

  const th = { ...THRESHOLDS, ...(a.validate || {}) };
  const fail = [];
  if (sx.ratio > th.seamRatio || sx.z > th.seamZ) fail.push('seam-x');
  if (sy.ratio > th.seamRatio || sy.z > th.seamZ) fail.push('seam-y');
  if (rep.peak > th.acfPeak) fail.push('repeat');
  /* Baked lighting is only a meaningful concept for albedo. A ramp in a
     roughness or AO map is the material genuinely varying, not a lighting bug. */
  if (GATED && ill.ramp > th.illumRamp) fail.push('ramp');
  if (GATED && ill.vignette > th.illumVignette) fail.push('vignette');

  rows.push({ id: a.id, sx, sy, rep, ill, th, fail, pass: fail.length === 0, override: !!a.validate });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ map: MAP, size: SIZE, thresholds: THRESHOLDS, rows }, null, 2));
} else {
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : ' n/a');
  console.log(`\ntiling validation · map=${MAP} · ${SIZE}px` +
    (GATED ? '  [BUILD GATE]' : '  [diagnostic only — derived map, never fails the build]'));
  console.log(
    `thresholds: seam ratio<=${THRESHOLDS.seamRatio} z<=${THRESHOLDS.seamZ} · ` +
    `acf peak<=${THRESHOLDS.acfPeak} · ramp<=${THRESHOLDS.illumRamp} · vign<=${THRESHOLDS.illumVignette}\n`
  );
  const head =
    'texture'.padEnd(24) + 'seamX'.padStart(7) + 'zX'.padStart(7) +
    'seamY'.padStart(7) + 'zY'.padStart(7) + 'acf'.padStart(7) +
    'lag'.padStart(6) + 'acfAll'.padStart(8) + 'lag'.padStart(6) +
    'ramp'.padStart(7) + 'vign'.padStart(7) + '  result';
  console.log(head);
  console.log('-'.repeat(head.length + 6));
  for (const r of rows) {
    if (r.missing) { console.log(r.id.padEnd(24) + '  (not generated)'); continue; }
    console.log(
      r.id.padEnd(24) +
      f(r.sx.ratio).padStart(7) + f(r.sx.z, 1).padStart(7) +
      f(r.sy.ratio).padStart(7) + f(r.sy.z, 1).padStart(7) +
      f(r.rep.peak, 3).padStart(7) + String(r.rep.lag).padStart(6) +
      f(r.rep.allPeak, 3).padStart(8) + String(r.rep.allLag).padStart(6) +
      f(r.ill.ramp, 3).padStart(7) + f(r.ill.vignette, 3).padStart(7) +
      '  ' + (r.pass ? 'PASS' : 'FAIL ' + r.fail.join(',')) + (r.override ? ' *' : '')
    );
  }
  const checked = rows.filter((r) => !r.missing);
  console.log(`\n${checked.filter((r) => r.pass).length}/${checked.length} pass` +
    (rows.length - checked.length ? ` · ${rows.length - checked.length} not generated` : ''));
  if (checked.some((r) => r.override)) {
    console.log('* judged against a per-asset threshold override from manifest.json');
  }
}

if (GATED && rows.some((r) => !r.missing && !r.pass)) process.exit(2);
