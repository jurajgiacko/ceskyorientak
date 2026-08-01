/**
 * Measurement DSP for the audio verification pass.
 *
 * Deliberately dependency-free and deliberately separate from `src/audio/`:
 * a test that shares code with the thing under test cannot fail honestly.
 * The FFT, the WAV writer and every statistic here are written from scratch.
 */

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, in-place)
// ---------------------------------------------------------------------------

export function fft(re, im) {
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
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Average magnitude spectrum, energy-weighted across frames. */
export function averageSpectrum(x, sampleRate, fftSize = 4096, hop = 2048, floorRms = 1e-5) {
  const w = hann(fftSize);
  const acc = new Float64Array(fftSize / 2);
  let frames = 0;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let start = 0; start + fftSize <= x.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < fftSize; i++) {
      const v = x[start + i];
      energy += v * v;
    }
    if (Math.sqrt(energy / fftSize) < floorRms) continue;
    for (let i = 0; i < fftSize; i++) {
      re[i] = x[start + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < fftSize / 2; k++) {
      acc[k] += Math.hypot(re[k], im[k]);
    }
    frames++;
  }
  if (frames === 0) return { mag: acc, frames: 0, binHz: sampleRate / fftSize };
  for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  return { mag: acc, frames, binHz: sampleRate / fftSize };
}

/** Spectral centroid in Hz from a magnitude spectrum. */
export function centroid(mag, binHz, loHz = 40, hiHz = 18000) {
  let num = 0;
  let den = 0;
  const k0 = Math.max(1, Math.round(loHz / binHz));
  const k1 = Math.min(mag.length - 1, Math.round(hiHz / binHz));
  for (let k = k0; k <= k1; k++) {
    num += k * binHz * mag[k];
    den += mag[k];
  }
  return den > 0 ? num / den : 0;
}

/** Frequency of the largest spectral peak, parabolically interpolated. */
export function dominantFrequency(mag, binHz, loHz = 50, hiHz = 16000) {
  let best = -1;
  let bestK = 0;
  const k0 = Math.max(1, Math.round(loHz / binHz));
  const k1 = Math.min(mag.length - 2, Math.round(hiHz / binHz));
  for (let k = k0; k <= k1; k++) {
    if (mag[k] > best) {
      best = mag[k];
      bestK = k;
    }
  }
  const a = mag[bestK - 1] ?? 0;
  const b = mag[bestK];
  const c = mag[bestK + 1] ?? 0;
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return (bestK + delta) * binHz;
}

const OCTAVE_CENTRES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Octave-band energies relative to the loudest band, in dB. */
export function octaveBands(mag, binHz) {
  const out = {};
  let peak = 0;
  const raw = [];
  for (const fc of OCTAVE_CENTRES) {
    const lo = fc / Math.SQRT2;
    const hi = fc * Math.SQRT2;
    let s = 0;
    for (let k = Math.max(1, Math.round(lo / binHz)); k <= Math.round(hi / binHz) && k < mag.length; k++) {
      s += mag[k] * mag[k];
    }
    raw.push(s);
    if (s > peak) peak = s;
  }
  OCTAVE_CENTRES.forEach((fc, i) => {
    out[fc] = peak > 0 ? +(10 * Math.log10(raw[i] / peak + 1e-12)).toFixed(1) : -99;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Level statistics
// ---------------------------------------------------------------------------

export function stats(channels) {
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  return {
    peak: +peak.toFixed(5),
    peakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(2),
    rms: +Math.sqrt(sumSq / n).toFixed(5),
    rmsDb: +(20 * Math.log10(Math.sqrt(sumSq / n) + 1e-12)).toFixed(2),
    dc: +(sum / n).toFixed(6),
  };
}

/** Sum to mono. */
export function mono(channels) {
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Amplitude envelope: rectify, then one-pole smooth at `tcS`. */
export function envelope(x, sampleRate, tcS = 0.01) {
  const a = Math.exp(-1 / (tcS * sampleRate));
  const out = new Float64Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    y = v > y ? v : v * (1 - a) + y * a;
    out[i] = y;
  }
  return out;
}

/**
 * Time for the envelope to fall `dropDb` below its peak, in seconds.
 * Measured from the peak forwards, which is what "decay time" means for a
 * one-shot.
 */
export function decayTime(x, sampleRate, dropDb = 20) {
  const env = envelope(x, sampleRate, 0.002);
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > peak) {
      peak = env[i];
      peakIdx = i;
    }
  }
  const target = peak * Math.pow(10, -dropDb / 20);
  for (let i = peakIdx; i < env.length; i++) {
    if (env[i] <= target) return +((i - peakIdx) / sampleRate).toFixed(4);
  }
  return null;
}

/** Duration from first to last sample above `thresholdDb` relative to peak. */
export function activeDuration(x, sampleRate, thresholdDb = -60) {
  const env = envelope(x, sampleRate, 0.003);
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  const t = peak * Math.pow(10, thresholdDb / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= t) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? 0 : +((last - first) / sampleRate).toFixed(4);
}

/**
 * Normalised autocorrelation of the (decimated, mean-removed) envelope over a
 * lag range. Returns the strongest peak and where it is.
 *
 * This is the loop detector. A buffer that repeats every N seconds produces a
 * correlation spike at lag N; genuinely aperiodic material does not.
 */
export function loopDetect(x, sampleRate, minLagS = 0.4, maxLagS = 30, decim = 200) {
  const env = envelope(x, sampleRate, 0.02);
  const sr = sampleRate / decim;
  const n = Math.floor(env.length / decim);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = env[i * decim];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i];
  mean /= n;
  for (let i = 0; i < n; i++) y[i] -= mean;
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += y[i] * y[i];
  if (e0 <= 0) return { peak: 0, lagS: 0, top: [] };

  const minLag = Math.max(1, Math.round(minLagS * sr));
  const maxLag = Math.min(n - 8, Math.round(maxLagS * sr));
  const results = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += y[i] * y[i + lag];
    // Normalise by the overlapping energy so long lags are not penalised.
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < n; i++) {
      ea += y[i] * y[i];
      eb += y[i + lag] * y[i + lag];
    }
    const denom = Math.sqrt(ea * eb);
    results.push({ lagS: lag / sr, r: denom > 0 ? s / denom : 0 });
  }
  results.sort((a, b) => b.r - a.r);
  const top = results.slice(0, 5).map((v) => ({ lagS: +v.lagS.toFixed(2), r: +v.r.toFixed(3) }));
  return { peak: +results[0].r.toFixed(3), lagS: +results[0].lagS.toFixed(2), top };
}

/**
 * Rate of a quasi-periodic envelope (breaths per minute), by autocorrelation
 * of the envelope over a plausible lag range.
 */
export function cycleRate(x, sampleRate, minS = 0.5, maxS = 5, decim = 400) {
  const env = envelope(x, sampleRate, 0.05);
  const sr = sampleRate / decim;
  const n = Math.floor(env.length / decim);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = env[i * decim];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i];
  mean /= n;
  for (let i = 0; i < n; i++) y[i] -= mean;
  let best = -2;
  let bestLag = 0;
  const minLag = Math.max(1, Math.round(minS * sr));
  const maxLag = Math.min(n - 4, Math.round(maxS * sr));
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < n; i++) {
      s += y[i] * y[i + lag];
      ea += y[i] * y[i];
      eb += y[i + lag] * y[i + lag];
    }
    const r = ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : 0;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  const periodS = bestLag / sr;
  return { periodS: +periodS.toFixed(3), perMinute: +(60 / periodS).toFixed(1), r: +best.toFixed(3) };
}

/** Count envelope peaks above a fraction of the max — a rate cross-check. */
export function countEvents(x, sampleRate, thresholdFrac = 0.28, minGapS = 0.25) {
  const env = envelope(x, sampleRate, 0.03);
  let max = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
  const th = max * thresholdFrac;
  const minGap = minGapS * sampleRate;
  let count = 0;
  let last = -1e9;
  let armed = true;
  for (let i = 0; i < env.length; i++) {
    if (armed && env[i] > th && i - last > minGap) {
      count++;
      last = i;
      armed = false;
    } else if (!armed && env[i] < th * 0.6) {
      armed = true;
    }
  }
  return count;
}

/** One-pole highpass. Used to lift plucks off the music drone before counting. */
export function highpass(x, sampleRate, fcHz) {
  const a = Math.exp((-2 * Math.PI * fcHz) / sampleRate);
  const out = new Float64Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = x[i] * (1 - a) + lp * a;
    out[i] = x[i] - lp;
  }
  return out;
}

/** Frequencies of the strongest spectral peaks, descending by magnitude. */
export function spectralPeaks(mag, binHz, count = 8, loHz = 100, hiHz = 8000) {
  const k0 = Math.max(2, Math.round(loHz / binHz));
  const k1 = Math.min(mag.length - 2, Math.round(hiHz / binHz));
  const peaks = [];
  for (let k = k0; k <= k1; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      const a = mag[k - 1];
      const b = mag[k];
      const c = mag[k + 1];
      const d = a - 2 * b + c;
      const delta = d !== 0 ? (0.5 * (a - c)) / d : 0;
      peaks.push({ hz: +((k + delta) * binHz).toFixed(1), mag: b });
    }
  }
  peaks.sort((x, y) => y.mag - x.mag);
  const top = peaks.slice(0, count);
  const max = top.length ? top[0].mag : 1;
  return top.map((p) => ({ hz: p.hz, db: +(20 * Math.log10(p.mag / max)).toFixed(1) }));
}

/** RMS in a sliding window, for tracing a duck. */
export function rmsTrace(x, sampleRate, windowS = 0.05) {
  const w = Math.max(1, Math.round(windowS * sampleRate));
  const out = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let k = 0; k < w; k++) s += x[i + k] * x[i + k];
    out.push({ t: +(i / sampleRate).toFixed(3), db: +(10 * Math.log10(s / w + 1e-12)).toFixed(2) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const numFrames = channels[0].length;
  const bytes = numFrames * numCh * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numCh * 2, 28);
  buf.writeUInt16LE(numCh * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  let o = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = channels[c][i];
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return buf;
}
