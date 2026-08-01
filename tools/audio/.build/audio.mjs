// src/audio/synth.ts
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function rand(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}
function jitter(rng, amount) {
  return 1 + (rng() * 2 - 1) * amount;
}
function dbToGain(db) {
  return Math.pow(10, db / 20);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function createBuffer(ctx, channels, seconds) {
  const len = Math.max(1, Math.round(seconds * ctx.sampleRate));
  return ctx.createBuffer(channels, len, ctx.sampleRate);
}
function dcBlock(x) {
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] ?? 0;
    const y = xi - x1 + 0.9975 * y1;
    x1 = xi;
    y1 = y;
    x[i] = y;
  }
}
function rmsOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, x.length));
}
function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i] ?? 0);
    if (v > p) p = v;
  }
  return p;
}
function scaleBy(x, g) {
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * g;
}
function normaliseRms(x, targetRms, peakCap = 0.95) {
  const r = rmsOf(x);
  if (r > 1e-9) scaleBy(x, targetRms / r);
  const p = peakOf(x);
  if (p > peakCap) scaleBy(x, peakCap / p);
}
function wrapCrossfade(x, fadeSamples) {
  const n = x.length;
  const f = Math.min(fadeSamples, n / 2 | 0);
  for (let i = 0; i < f; i++) {
    const w = i / f;
    const tail = x[n - f + i] ?? 0;
    const head = x[i] ?? 0;
    const a = Math.cos(w * Math.PI / 2);
    const b = Math.sin(w * Math.PI / 2);
    x[n - f + i] = tail * a + head * b;
  }
}
function fillWhite(out, rng) {
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
}
function fillPink(out, rng) {
  const ROWS = 16;
  const rows = new Float32Array(ROWS);
  let sum = 0;
  let counter = 0;
  for (let i = 0; i < out.length; i++) {
    counter = counter + 1 >>> 0;
    let k = 0;
    let c = counter;
    while ((c & 1) === 0 && k < ROWS - 1) {
      c >>>= 1;
      k++;
    }
    const next = rng() * 2 - 1;
    sum += next - (rows[k] ?? 0);
    rows[k] = next;
    out[i] = (sum + (rng() * 2 - 1)) / (ROWS + 1);
  }
}
function fillBrown(out, rng) {
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = 0.996 * y + 0.04 * (rng() * 2 - 1);
    out[i] = y;
  }
  dcBlock(out);
}
var NoiseBank = class {
  white;
  pink;
  brown;
  constructor(ctx, seed = 389598) {
    const fade = Math.round(0.05 * ctx.sampleRate);
    this.white = createBuffer(ctx, 2, 2.5);
    this.pink = createBuffer(ctx, 2, 3);
    this.brown = createBuffer(ctx, 1, 2);
    for (let ch = 0; ch < 2; ch++) {
      const w = this.white.getChannelData(ch);
      fillWhite(w, makeRng(seed + ch * 7717));
      dcBlock(w);
      normaliseRms(w, 0.28);
      wrapCrossfade(w, fade);
      const p = this.pink.getChannelData(ch);
      fillPink(p, makeRng(seed + 131 + ch * 7717));
      dcBlock(p);
      normaliseRms(p, 0.28);
      wrapCrossfade(p, fade);
    }
    const b = this.brown.getChannelData(0);
    fillBrown(b, makeRng(seed + 977));
    normaliseRms(b, 0.28);
    wrapCrossfade(b, fade);
  }
  /** Total bytes held, for the memory budget report. */
  get bytes() {
    const of = (b) => b.length * b.numberOfChannels * 4;
    return of(this.white) + of(this.pink) + of(this.brown);
  }
};
function renderImpulseResponse(ctx, spec) {
  const sr = ctx.sampleRate;
  const buf = createBuffer(ctx, 2, spec.seconds + spec.predelay + 0.02);
  const n = buf.length;
  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    const rng = makeRng(spec.seed + ch * 104729);
    const start = Math.round(spec.predelay * sr);
    let lp = 0;
    let coef = 0;
    const densityRamp = Math.max(1, Math.round(0.09 * sr));
    for (let i = start; i < n; i++) {
      const t = (i - start) / sr;
      const frac = t / spec.seconds;
      if ((i & 63) === 0) {
        const fc = spec.hfStart * Math.pow(spec.hfEnd / spec.hfStart, Math.min(1, frac));
        coef = Math.exp(-2 * Math.PI * fc / sr);
      }
      const env = Math.pow(10, -3 * frac);
      const ramp = Math.min(1, (i - start) / densityRamp);
      const p = clamp(spec.density * ramp * ramp, 0.02, 1);
      const grain = rng() < p ? (rng() * 2 - 1) / Math.sqrt(p) : 0;
      lp = grain * (1 - coef) + lp * coef;
      out[i] = lp * env;
    }
    const skew = ch === 0 ? 0 : Math.round(11e-4 * sr);
    for (const er of spec.early) {
      const at = Math.round((er[0] + spec.predelay) * sr) + skew;
      const width = Math.max(2, Math.round(8e-4 * sr));
      const sign = rng() < 0.5 ? -1 : 1;
      for (let k = 0; k < width; k++) {
        const idx = at + k;
        if (idx >= n) break;
        const w = 1 - k / width;
        out[idx] = (out[idx] ?? 0) + sign * er[1] * w * w * (rng() * 2 - 1);
      }
    }
    const hpCoef = Math.exp(-2 * Math.PI * spec.lfCut / sr);
    let hz = 0;
    for (let i = 0; i < n; i++) {
      const v = out[i] ?? 0;
      hz = v * (1 - hpCoef) + hz * hpCoef;
      out[i] = v - hz;
    }
    dcBlock(out);
  }
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] ?? 0;
      energy += v * v;
    }
  }
  const norm = energy > 1e-12 ? 0.7 / Math.sqrt(energy) : 1;
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    scaleBy(d, norm);
    peak = Math.max(peak, peakOf(d));
  }
  if (peak > 0.9) {
    for (let ch = 0; ch < 2; ch++) scaleBy(buf.getChannelData(ch), 0.9 / peak);
  }
  return buf;
}
var IR_PRESETS = {
  openForest: {
    seconds: 1.1,
    predelay: 0.012,
    hfStart: 4200,
    hfEnd: 850,
    lfCut: 130,
    density: 0.22,
    early: [
      [9e-3, 0.3],
      [0.021, 0.24],
      [0.038, 0.19],
      [0.061, 0.14],
      [0.094, 0.1],
      [0.142, 0.07]
    ],
    seed: 1201
  },
  denseSpruce: {
    seconds: 0.55,
    predelay: 5e-3,
    hfStart: 2400,
    hfEnd: 420,
    lfCut: 170,
    density: 0.5,
    early: [
      [4e-3, 0.2],
      [0.011, 0.14],
      [0.019, 0.09]
    ],
    seed: 1202
  },
  stoneCourtyard: {
    seconds: 3,
    predelay: 0.019,
    hfStart: 11e3,
    hfEnd: 3100,
    lfCut: 85,
    density: 0.85,
    early: [
      [0.017, 0.5],
      [0.029, 0.42],
      [0.044, 0.38],
      [0.063, 0.31],
      [0.088, 0.26],
      [0.119, 0.21],
      [0.157, 0.17]
    ],
    seed: 1203
  },
  openArena: {
    seconds: 1.5,
    predelay: 0.028,
    hfStart: 6200,
    hfEnd: 1300,
    lfCut: 75,
    density: 0.38,
    early: [
      [0.023, 0.26],
      [0.049, 0.2],
      [0.082, 0.15],
      [0.131, 0.11]
    ],
    seed: 1204
  }
};
function renderPluck(sampleRate, spec) {
  const n = Math.max(1, Math.round(spec.seconds * sampleRate));
  const out = new Float32Array(n);
  const rng = makeRng(spec.seed);
  const period = Math.max(2, Math.round(sampleRate / spec.freq));
  const line = new Float32Array(period);
  let e = 0;
  const eCoef = Math.exp(-2 * Math.PI * (400 + 6e3 * spec.brightness) / sampleRate);
  for (let i = 0; i < period; i++) {
    e = (rng() * 2 - 1) * (1 - eCoef) + e * eCoef;
    line[i] = e;
  }
  let mean = 0;
  for (let i = 0; i < period; i++) mean += line[i] ?? 0;
  mean /= period;
  for (let i = 0; i < period; i++) line[i] = (line[i] ?? 0) - mean;
  const a = 0.5 + 0.48 * (1 - spec.damping);
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx] ?? 0;
    const y = (a * cur + (1 - a) * prev) * spec.sustain;
    prev = cur;
    line[idx] = y;
    out[i] = cur;
    idx = idx + 1 === period ? 0 : idx + 1;
  }
  const rel = Math.min(n, Math.round(0.06 * sampleRate));
  for (let i = 0; i < rel; i++) {
    const w = i / rel;
    const j = n - rel + i;
    out[j] = (out[j] ?? 0) * (1 - w) * (1 - w);
  }
  dcBlock(out);
  normaliseRms(out, 0.12, 0.9);
  return out;
}
function renderModal(sampleRate, f0, partials, seconds, opts = {}) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rng = makeRng(opts.seed ?? 4242);
  for (const p of partials) {
    const f = f0 * p.ratio;
    if (f >= sampleRate * 0.48) continue;
    const voices = p.beat ? [f, f * (1 + p.beat)] : [f];
    for (const fv of voices) {
      const w = 2 * Math.PI * fv / sampleRate;
      const dec = Math.exp(-6.9078 / p.decay * (1 / sampleRate));
      const phase0 = rng() * Math.PI * 2;
      let amp = p.gain / voices.length * 0.5;
      let s = Math.sin(phase0);
      let c = Math.cos(phase0);
      const sw = Math.sin(w);
      const cw = Math.cos(w);
      for (let i = 0; i < n; i++) {
        out[i] = (out[i] ?? 0) + s * amp;
        const ns = s * cw + c * sw;
        c = c * cw - s * sw;
        s = ns;
        amp *= dec;
        if (amp < 1e-6) break;
      }
    }
  }
  const strikeMs = opts.strikeMs ?? 3;
  const sn = Math.round(strikeMs / 1e3 * sampleRate);
  const level = opts.strikeNoise ?? 0;
  if (level > 0) {
    let lp = 0;
    for (let i = 0; i < sn && i < n; i++) {
      lp = (rng() * 2 - 1) * 0.4 + lp * 0.6;
      const env = 1 - i / sn;
      out[i] = (out[i] ?? 0) + lp * level * env * env;
    }
  }
  const at = Math.max(1, Math.round(5e-4 * sampleRate));
  for (let i = 0; i < at && i < n; i++) out[i] = (out[i] ?? 0) * (i / at);
  const rel = Math.min(n, Math.round(0.02 * sampleRate));
  for (let i = 0; i < rel; i++) {
    const j = n - rel + i;
    out[j] = (out[j] ?? 0) * (1 - i / rel);
  }
  dcBlock(out);
  return out;
}
function toBuffer(ctx, data) {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}
function normalisePeak(data, target) {
  const p = peakOf(data);
  if (p > 1e-9) scaleBy(data, target / p);
}
function percussive(param, when, peak, attackS, decayS) {
  const tc = Math.max(1e-4, decayS / 4.6);
  param.cancelScheduledValues(when);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attackS);
  param.setTargetAtTime(0, when + attackS, tc);
  const end = when + attackS + decayS * 1.25;
  param.setValueAtTime(0, end);
  return end;
}
var Voice = class {
  hp;
  peak;
  lp;
  amp;
  pan;
  send;
  /** Timeline instant this voice is free again. Drives pool stealing. */
  busyUntil = 0;
  src = null;
  constructor(ctx, dry, wet) {
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.peak = ctx.createBiquadFilter();
    this.peak.type = "peaking";
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.hp.connect(this.peak).connect(this.lp).connect(this.amp).connect(this.pan);
    this.pan.connect(dry);
    if (wet) this.pan.connect(this.send).connect(wet);
  }
  /** Reset filters to a neutral pass-through before a caller configures them. */
  reset(when) {
    this.hp.frequency.cancelScheduledValues(when);
    this.hp.Q.cancelScheduledValues(when);
    this.peak.frequency.cancelScheduledValues(when);
    this.peak.gain.cancelScheduledValues(when);
    this.peak.Q.cancelScheduledValues(when);
    this.lp.frequency.cancelScheduledValues(when);
    this.lp.Q.cancelScheduledValues(when);
    this.hp.frequency.setValueAtTime(20, when);
    this.hp.Q.setValueAtTime(0.707, when);
    this.peak.frequency.setValueAtTime(1e3, when);
    this.peak.gain.setValueAtTime(0, when);
    this.peak.Q.setValueAtTime(1, when);
    this.lp.frequency.setValueAtTime(2e4, when);
    this.lp.Q.setValueAtTime(0.707, when);
    this.send.gain.cancelScheduledValues(when);
    this.send.gain.setValueAtTime(0, when);
    this.pan.pan.cancelScheduledValues(when);
  }
  /**
   * Fire the voice. The `AudioBufferSourceNode` is the one object this system
   * allocates per event — the specification makes source nodes single-use, so
   * there is no way around it. Everything downstream is reused.
   */
  start(ctx, buffer, when, offset, duration, rate) {
    this.src?.disconnect();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.hp);
    const safeOffset = offset % Math.max(1e-3, buffer.duration - duration * rate - 0.01);
    src.start(when, Math.max(0, safeOffset), duration * rate);
    src.stop(when + duration + 0.05);
    this.src = src;
    this.busyUntil = when + duration + 0.05;
  }
};
var VoicePool = class {
  voices = [];
  constructor(ctx, dry, wet, size) {
    for (let i = 0; i < size; i++) this.voices.push(new Voice(ctx, dry, wet));
  }
  /**
   * Take the voice that has been free longest; if none is free, steal the one
   * that started earliest. Fixed size, no growth, no allocation.
   */
  acquire(when) {
    let best = this.voices[0];
    for (let i = 1; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v && v.busyUntil < best.busyUntil) best = v;
    }
    best.reset(when);
    return best;
  }
  get size() {
    return this.voices.length;
  }
};

// src/audio/ambience.ts
var ENVIRONMENTS = {
  forest: {
    levels: {
      windLow: 1,
      canopy: 1,
      pa: 0.05,
      crowd: 0.06,
      river: 0,
      birds: 1,
      cowbell: 0.1,
      bells: 0
    },
    reverb: "openForest",
    birdGap: 16,
    cowbellGap: 70,
    cheerGap: 150,
    bellGap: 0,
    paDensity: 0.25
  },
  arena: {
    levels: {
      windLow: 0.45,
      canopy: 0.3,
      pa: 1,
      crowd: 1,
      river: 0,
      birds: 0.12,
      cowbell: 1,
      bells: 0
    },
    reverb: "openArena",
    birdGap: 90,
    cowbellGap: 7,
    cheerGap: 26,
    bellGap: 0,
    paDensity: 0.62
  },
  town: {
    levels: {
      windLow: 0.32,
      canopy: 0.14,
      pa: 0.12,
      crowd: 0.18,
      river: 0.9,
      birds: 0.3,
      cowbell: 0.15,
      bells: 1
    },
    reverb: "stoneCourtyard",
    birdGap: 40,
    cowbellGap: 55,
    cheerGap: 120,
    bellGap: 210,
    paDensity: 0.18
  }
};
var NoiseLayer = class {
  gain;
  hp;
  bp;
  lp;
  src = null;
  buffer;
  ctx;
  constructor(ctx, buffer, dest, opts) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = opts.hp;
    this.bp = ctx.createBiquadFilter();
    this.bp.type = "peaking";
    this.bp.frequency.value = opts.bp;
    this.bp.Q.value = opts.bpQ;
    this.bp.gain.value = 5;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = opts.lp;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = opts.pan;
    this.hp.connect(this.bp).connect(this.lp).connect(this.gain).connect(pan).connect(dest);
  }
  start(when, offset, rate) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(this.hp);
    src.start(when, offset % this.buffer.duration);
    this.src = src;
  }
  /** Nudge the loop period. The reason no two minutes are ever the same. */
  driftRate(when, target, tc) {
    this.src?.playbackRate.setTargetAtTime(target, when, tc);
  }
  stop(when) {
    this.src?.stop(when);
    this.src = null;
  }
};
var Ambience = class {
  ctx;
  rng;
  wet;
  bank;
  // One pool per event layer, each wired to that layer's gain — so the
  // environment crossfade moves cowbells and birds along with everything else
  // instead of leaving them stuck at full level in the wrong place.
  poolCowbell;
  poolBird;
  poolBell;
  poolCrowd;
  layers;
  windLow;
  windGust;
  canopy;
  paChain;
  crowd;
  riverBody;
  riverSpray;
  riverLow;
  cowbells = [];
  bells = [];
  env = ENVIRONMENTS.forest;
  started = false;
  windIntensity = 0.5;
  // Next-event timeline instants. All Poisson-scheduled.
  tDrift = 0;
  tBird = 0;
  tCowbell = 0;
  tCheer = 0;
  tBell = 0;
  paUntil = 0;
  tPa = 0;
  constructor(ctx, bank, dry, wet, opts = {}) {
    this.ctx = ctx;
    this.bank = bank;
    this.wet = wet;
    this.rng = makeRng(opts.seed ?? 2829);
    const mk = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(dry);
      return g;
    };
    this.layers = {
      windLow: mk(),
      canopy: mk(),
      pa: mk(),
      crowd: mk(),
      river: mk(),
      birds: mk(),
      cowbell: mk(),
      bells: mk()
    };
    this.poolCowbell = new VoicePool(ctx, this.layers.cowbell, wet, 8);
    this.poolBird = new VoicePool(ctx, this.layers.birds, wet, 4);
    this.poolBell = new VoicePool(ctx, this.layers.bells, wet, 3);
    this.poolCrowd = new VoicePool(ctx, this.layers.crowd, wet, 6);
    this.windLow = new NoiseLayer(ctx, bank.brown, this.layers.windLow, {
      hp: 45,
      bp: 190,
      bpQ: 0.7,
      lp: 620,
      pan: -0.15
    });
    this.windGust = new NoiseLayer(ctx, bank.pink, this.layers.windLow, {
      hp: 120,
      bp: 480,
      bpQ: 0.8,
      lp: 1800,
      pan: 0.2
    });
    this.canopy = new NoiseLayer(ctx, bank.white, this.layers.canopy, {
      hp: 1400,
      bp: 4200,
      bpQ: 0.6,
      lp: 11e3,
      pan: 0.05
    });
    const paEnv = ctx.createGain();
    paEnv.gain.value = 0;
    paEnv.connect(this.layers.pa);
    const paSend = ctx.createGain();
    paSend.gain.value = 0.55;
    paEnv.connect(paSend).connect(wet);
    const paFormant = ctx.createBiquadFilter();
    paFormant.type = "peaking";
    paFormant.frequency.value = 900;
    paFormant.Q.value = 3.5;
    paFormant.gain.value = 11;
    paFormant.connect(paEnv);
    const paSrc = new NoiseLayer(ctx, bank.pink, paFormant, {
      hp: 420,
      bp: 1850,
      bpQ: 1.2,
      lp: 2900,
      pan: 0
    });
    paSrc.gain.gain.value = 1;
    this.paChain = { src: paSrc, formant: paFormant, env: paEnv };
    this.crowd = new NoiseLayer(ctx, bank.pink, this.layers.crowd, {
      hp: 380,
      bp: 1100,
      bpQ: 0.9,
      lp: 3400,
      pan: 0
    });
    this.crowd.gain.gain.value = 0.35;
    this.riverLow = new NoiseLayer(ctx, bank.brown, this.layers.river, {
      hp: 60,
      bp: 150,
      bpQ: 0.8,
      lp: 420,
      pan: -0.1
    });
    this.riverBody = new NoiseLayer(ctx, bank.pink, this.layers.river, {
      hp: 320,
      bp: 900,
      bpQ: 0.7,
      lp: 2600,
      pan: 0.12
    });
    this.riverSpray = new NoiseLayer(ctx, bank.white, this.layers.river, {
      hp: 2600,
      bp: 5200,
      bpQ: 0.5,
      lp: 12e3,
      pan: -0.05
    });
    this.riverLow.gain.gain.value = 0.5;
    this.riverBody.gain.gain.value = 0.5;
    this.riverSpray.gain.gain.value = 0.3;
    if (!opts.lean) this.renderStruck(opts.seed ?? 2829);
  }
  /**
   * Cowbells and monastery bells, rendered once.
   *
   * Cowbell: five inharmonic partials, short decays, a hard strike transient.
   * Bell: the classic Western profile — hum an octave below the prime, a minor
   * -third tierce, a quint, and a nominal at 2×, with the low partials ringing
   * far longer than the high ones and every partial beating slightly against a
   * detuned twin. That beating is what stops additive synthesis sounding like
   * an organ, and it is why real bells shimmer.
   */
  renderStruck(seed) {
    const sr = this.ctx.sampleRate;
    for (let i = 0; i < 3; i++) {
      const f0 = 470 + i * 62;
      const data = renderModal(
        sr,
        f0,
        [
          { ratio: 1, gain: 0.7, decay: 0.28, beat: 4e-3 },
          { ratio: 1.51, gain: 1, decay: 0.42, beat: 5e-3 },
          { ratio: 2.13, gain: 0.62, decay: 0.3 },
          { ratio: 2.87, gain: 0.4, decay: 0.19 },
          { ratio: 3.71, gain: 0.26, decay: 0.12 },
          { ratio: 5.42, gain: 0.14, decay: 0.07 }
        ],
        0.75,
        { strikeNoise: 0.5, strikeMs: 2, seed: seed + 40 + i }
      );
      normalisePeak(data, 0.85);
      this.cowbells.push(toBuffer(this.ctx, data));
    }
    for (let i = 0; i < 2; i++) {
      const prime = i === 0 ? 392 : 466.16;
      const data = renderModal(
        sr,
        prime,
        [
          { ratio: 0.5, gain: 0.85, decay: 7.5, beat: 16e-4 },
          { ratio: 1, gain: 1, decay: 5.2, beat: 2e-3 },
          { ratio: 1.19, gain: 0.72, decay: 4.4, beat: 25e-4 },
          { ratio: 1.5, gain: 0.55, decay: 3.4, beat: 3e-3 },
          { ratio: 2, gain: 0.68, decay: 2.6, beat: 35e-4 },
          { ratio: 2.5, gain: 0.3, decay: 1.6 },
          { ratio: 2.67, gain: 0.24, decay: 1.4 },
          { ratio: 3, gain: 0.26, decay: 1.1 },
          { ratio: 4, gain: 0.19, decay: 0.75 },
          { ratio: 5.33, gain: 0.11, decay: 0.45 },
          { ratio: 6.8, gain: 0.07, decay: 0.3 }
        ],
        4.6,
        { strikeNoise: 0.28, strikeMs: 5, seed: seed + 60 + i }
      );
      normalisePeak(data, 0.85);
      this.bells.push(toBuffer(this.ctx, data));
    }
  }
  start(when) {
    if (this.started) return;
    this.started = true;
    const r = this.rng;
    this.windLow.start(when, rand(r, 0, 1.9), 0.87);
    this.windGust.start(when, rand(r, 0, 2.8), 1.13);
    this.canopy.start(when, rand(r, 0, 2.3), 1.03);
    this.paChain.src.start(when, rand(r, 0, 2.8), 0.94);
    this.crowd.start(when, rand(r, 0, 2.8), 1.07);
    this.riverLow.start(when, rand(r, 0, 1.9), 0.91);
    this.riverBody.start(when, rand(r, 0, 2.8), 1.09);
    this.riverSpray.start(when, rand(r, 0, 2.3), 0.97);
    this.tDrift = when;
    this.tBird = when + rand(r, 2, 8);
    this.tCowbell = when + rand(r, 1, 10);
    this.tCheer = when + rand(r, 20, 60);
    this.tBell = when + rand(r, 30, 200);
    this.tPa = when + rand(r, 1, 5);
    this.applyLevels(when, 1e-3);
  }
  stop(when) {
    if (!this.started) return;
    this.started = false;
    for (const l of [
      this.windLow,
      this.windGust,
      this.canopy,
      this.paChain.src,
      this.crowd,
      this.riverLow,
      this.riverBody,
      this.riverSpray
    ]) {
      l.stop(when);
    }
  }
  /** 0..1 — how hard it is blowing. Ramps; safe to call every frame. */
  setWind(intensity, when, rampS = 3) {
    this.windIntensity = clamp(intensity, 0, 1);
    const tc = Math.max(0.01, rampS / 3);
    this.layers.windLow.gain.setTargetAtTime(
      this.env.levels.windLow * (0.1 + 0.55 * this.windIntensity),
      when,
      tc
    );
    this.layers.canopy.gain.setTargetAtTime(
      this.env.levels.canopy * (0.03 + 0.3 * this.windIntensity * this.windIntensity),
      when,
      tc
    );
  }
  setEnvironment(id, when, rampS = 2.5) {
    this.env = ENVIRONMENTS[id];
    this.applyLevels(when, rampS);
  }
  /** The active environment's reverb space, for the engine to crossfade to. */
  get reverb() {
    return this.env.reverb;
  }
  applyLevels(when, rampS) {
    const tc = Math.max(1e-3, rampS / 3);
    const L = this.env.levels;
    const w = this.windIntensity;
    this.layers.windLow.gain.setTargetAtTime(L.windLow * (0.1 + 0.55 * w), when, tc);
    this.layers.canopy.gain.setTargetAtTime(L.canopy * (0.03 + 0.3 * w * w), when, tc);
    this.layers.pa.gain.setTargetAtTime(L.pa * 0.5, when, tc);
    this.layers.crowd.gain.setTargetAtTime(L.crowd * 0.34, when, tc);
    this.layers.river.gain.setTargetAtTime(L.river * 0.42, when, tc);
    this.layers.birds.gain.setTargetAtTime(L.birds * 0.5, when, tc);
    this.layers.cowbell.gain.setTargetAtTime(L.cowbell * 0.34, when, tc);
    this.layers.bells.gain.setTargetAtTime(L.bells * 0.5, when, tc);
  }
  /**
   * Advance the world. Schedules automation and events; the common case is a
   * handful of number comparisons and an early return.
   */
  update(now, _dt) {
    if (!this.started) return;
    const r = this.rng;
    if (now >= this.tDrift) {
      const t = now + 0.01;
      this.windLow.driftRate(t, rand(r, 0.82, 0.95), 2.5);
      this.windGust.driftRate(t, rand(r, 1.04, 1.2), 2.5);
      this.canopy.driftRate(t, rand(r, 0.94, 1.12), 2.5);
      this.crowd.driftRate(t, rand(r, 0.98, 1.16), 3);
      this.riverBody.driftRate(t, rand(r, 1, 1.18), 3);
      this.riverSpray.driftRate(t, rand(r, 0.9, 1.06), 3);
      this.paChain.src.driftRate(t, rand(r, 0.88, 1.02), 3);
      const gust = rand(r, 0.25, 1) * (0.45 + 0.55 * this.windIntensity);
      this.windGust.gain.gain.setTargetAtTime(gust * 0.55, t, rand(r, 1.2, 3.4));
      this.windGust.lp.frequency.setTargetAtTime(rand(r, 900, 3e3), t, rand(r, 1.5, 4));
      this.canopy.bp.frequency.setTargetAtTime(rand(r, 2800, 6200), t, rand(r, 2, 5));
      this.windLow.lp.frequency.setTargetAtTime(rand(r, 380, 900), t, rand(r, 2, 5));
      this.riverLow.gain.gain.setTargetAtTime(rand(r, 0.35, 0.62), t, rand(r, 2, 6));
      this.riverBody.gain.gain.setTargetAtTime(rand(r, 0.4, 0.66), t, rand(r, 2, 6));
      this.riverSpray.gain.gain.setTargetAtTime(rand(r, 0.18, 0.42), t, rand(r, 2, 6));
      this.crowd.gain.gain.setTargetAtTime(rand(r, 0.24, 0.46), t, rand(r, 3, 8));
      this.tDrift = now + rand(r, 1.4, 3.2);
    }
    if (now >= this.tPa && this.env.levels.pa > 0.01) {
      this.speak(Math.max(now + 0.05, this.paUntil));
    }
    if (now >= this.tBird && this.env.levels.birds > 0.02) {
      this.bird(now + rand(r, 0.05, 0.4));
      this.tBird = now + poisson(r, this.env.birdGap);
    }
    if (now >= this.tCowbell && this.env.levels.cowbell > 0.02 && this.cowbells.length > 0) {
      this.shake(now + rand(r, 0.05, 0.5));
      this.tCowbell = now + poisson(r, this.env.cowbellGap);
    }
    if (now >= this.tCheer && this.env.levels.crowd > 0.05) {
      this.cheer(now + 0.1);
      this.tCheer = now + poisson(r, this.env.cheerGap);
    }
    if (this.env.bellGap > 0 && now >= this.tBell && this.bells.length > 0) {
      this.peal(now + 0.2);
      this.tBell = now + poisson(r, this.env.bellGap);
    }
  }
  /** Ring the monastery. Exposed so a race start can be marked with it. */
  ringBells(when, strikes = 9) {
    this.peal(when, strikes);
  }
  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  /**
   * One PA phrase. A phrase is a run of syllables at 4–7 Hz with the formant
   * moving per syllable, then a gap. Level is deliberately just under the point
   * where you would start trying to parse it.
   */
  speak(from) {
    const r = this.rng;
    const g = this.paChain.env.gain;
    const density = this.env.paDensity;
    let t = from;
    const phrase = rand(r, 1.2, 3.6);
    const end = t + phrase;
    while (t < end) {
      const syl = rand(r, 0.07, 0.19);
      const level = rand(r, 0.22, 0.5) * (0.6 + 0.4 * density);
      this.paChain.formant.frequency.setTargetAtTime(rand(r, 520, 1650), t, 0.03);
      g.setValueAtTime(0.02, t);
      g.linearRampToValueAtTime(level, t + syl * 0.3);
      g.linearRampToValueAtTime(level * rand(r, 0.5, 0.9), t + syl * 0.75);
      g.linearRampToValueAtTime(0.01, t + syl);
      t += syl + rand(r, 0.01, 0.07);
    }
    g.setValueAtTime(0, t);
    this.paUntil = t;
    this.tPa = t + rand(r, 0.8, 5.5) / Math.max(0.15, density);
  }
  /** A spectator shaking a cowbell: a cluster, not a metronome. */
  shake(from) {
    const r = this.rng;
    const n = 5 + (r() * 9 | 0);
    const pan = rand(r, -0.7, 0.7);
    const which = r() * this.cowbells.length | 0;
    const buf = this.cowbells[which] ?? this.cowbells[0];
    if (!buf) return;
    let t = from;
    for (let i = 0; i < n; i++) {
      const v = this.poolCowbell.acquire(t);
      v.hp.frequency.setValueAtTime(300, t);
      v.peak.frequency.setValueAtTime(rand(r, 900, 1500), t);
      v.peak.Q.setValueAtTime(1.1, t);
      v.peak.gain.setValueAtTime(3, t);
      v.lp.frequency.setValueAtTime(rand(r, 7e3, 13e3), t);
      v.pan.pan.setValueAtTime(pan + rand(r, -0.12, 0.12), t);
      v.send.gain.setValueAtTime(0.3, t);
      v.amp.gain.setValueAtTime(rand(r, 0.4, 1) * 0.55, t);
      v.amp.gain.setValueAtTime(0, t + 0.75);
      v.start(this.ctx, buf, t, 0, 0.7, jitter(r, 0.06));
      t += i % 2 === 0 ? rand(r, 0.12, 0.19) : rand(r, 0.19, 0.3);
    }
  }
  /** A crowd swell as a runner comes through the spectator control. */
  cheer(when) {
    const r = this.rng;
    const g = this.crowd.gain.gain;
    const peak = rand(r, 0.7, 1.15);
    const rise = rand(r, 0.5, 1.2);
    const hold = rand(r, 0.8, 2.2);
    const fall = rand(r, 1.8, 3.6);
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(peak, when + rise);
    g.setValueAtTime(peak, when + rise + hold);
    g.linearRampToValueAtTime(rand(r, 0.26, 0.4), when + rise + hold + fall);
    const claps = 6 + (r() * 14 | 0);
    for (let i = 0; i < claps; i++) {
      const t = when + rand(r, 0.1, rise + hold);
      const v = this.poolCrowd.acquire(t);
      v.hp.frequency.setValueAtTime(rand(r, 900, 1600), t);
      v.peak.frequency.setValueAtTime(rand(r, 1800, 3600), t);
      v.peak.Q.setValueAtTime(1.6, t);
      v.peak.gain.setValueAtTime(6, t);
      v.lp.frequency.setValueAtTime(rand(r, 6e3, 11e3), t);
      v.pan.pan.setValueAtTime(rand(r, -0.85, 0.85), t);
      v.send.gain.setValueAtTime(0.4, t);
      percussive(v.amp.gain, t, rand(r, 0.05, 0.16), 1e-3, 0.03);
      const off = r() * (this.bank.white.duration - 0.1);
      v.start(this.ctx, this.bank.white, t, off, 0.05, 1);
    }
    if (this.cowbells.length > 0 && r() < 0.8) this.shake(when + rand(r, 0.1, 0.8));
  }
  /**
   * A peal. Two bells, alternating, with human unevenness in the swing and a
   * slow decay in strike force — the way a rope-rung pair actually sounds.
   */
  peal(from, strikes = 0) {
    const r = this.rng;
    const n = strikes > 0 ? strikes : 4 + (r() * 8 | 0);
    let t = from;
    for (let i = 0; i < n; i++) {
      const buf = this.bells[i % this.bells.length] ?? this.bells[0];
      if (!buf) break;
      const v = this.poolBell.acquire(t);
      v.hp.frequency.setValueAtTime(90, t);
      v.peak.frequency.setValueAtTime(rand(r, 700, 1300), t);
      v.peak.Q.setValueAtTime(0.9, t);
      v.peak.gain.setValueAtTime(2.5, t);
      v.lp.frequency.setValueAtTime(rand(r, 6e3, 1e4), t);
      v.pan.pan.setValueAtTime(rand(r, -0.25, 0.25), t);
      v.send.gain.setValueAtTime(0.65, t);
      v.amp.gain.setValueAtTime(rand(r, 0.62, 0.95) * 0.5, t);
      v.amp.gain.setValueAtTime(0, t + 4.5);
      v.start(this.ctx, buf, t, 0, 4.4, jitter(r, 3e-3));
      t += rand(r, 1.05, 1.35);
    }
  }
  /**
   * One bird. Six calls, chosen for a Czech August morning in a spruce stand —
   * which is a quiet place. The songbirds have finished breeding and stopped
   * singing; what is left is contact calls, alarm calls and raptors. A thrush
   * singing its heart out here in August would be as wrong as palm trees.
   */
  bird(when) {
    const r = this.rng;
    const pick = r();
    const pan = rand(r, -0.8, 0.8);
    const dist = rand(r, 0.25, 1);
    const send = 0.35 + 0.4 * (1 - dist);
    const out = this.layers.birds;
    if (pick < 0.22) {
      const n = 1 + (r() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const t2 = when + i * rand(r, 0.34, 0.52);
        const v = this.poolBird.acquire(t2);
        v.hp.frequency.setValueAtTime(1100, t2);
        const f = rand(r, 1900, 2600);
        v.peak.frequency.setValueAtTime(f, t2);
        v.peak.frequency.linearRampToValueAtTime(f * 0.72, t2 + 0.4);
        v.peak.Q.setValueAtTime(3.2, t2);
        v.peak.gain.setValueAtTime(14, t2);
        v.lp.frequency.setValueAtTime(7e3, t2);
        v.pan.pan.setValueAtTime(pan, t2);
        v.send.gain.setValueAtTime(send, t2);
        const g = 0.34 * dist;
        v.amp.gain.setValueAtTime(0, t2);
        v.amp.gain.linearRampToValueAtTime(g, t2 + 0.02);
        v.amp.gain.linearRampToValueAtTime(g * 0.75, t2 + 0.22);
        v.amp.gain.linearRampToValueAtTime(0, t2 + rand(r, 0.34, 0.46));
        v.start(this.ctx, this.bank.white, t2, r() * 1.5, 0.5, 1);
      }
      return;
    }
    if (pick < 0.38) {
      this.tone(when, {
        f0: rand(r, 1500, 1900),
        f1: rand(r, 760, 950),
        dur: rand(r, 0.75, 1.1),
        attack: 0.09,
        gain: 0.16 * dist,
        vibrato: 6.5,
        vibratoDepth: 0.035,
        noise: 0.35,
        pan,
        send: send + 0.2,
        dest: out
      });
      return;
    }
    if (pick < 0.58) {
      const n = 1 + (r() < 0.3 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const t2 = when + i * rand(r, 0.18, 0.35);
        const v = this.poolBird.acquire(t2);
        v.hp.frequency.setValueAtTime(2200, t2);
        v.peak.frequency.setValueAtTime(rand(r, 3600, 4600), t2);
        v.peak.Q.setValueAtTime(6, t2);
        v.peak.gain.setValueAtTime(17, t2);
        v.lp.frequency.setValueAtTime(9e3, t2);
        v.pan.pan.setValueAtTime(pan, t2);
        v.send.gain.setValueAtTime(send, t2);
        percussive(v.amp.gain, t2, 0.26 * dist, 1e-3, 0.035);
        v.start(this.ctx, this.bank.white, t2, r() * 1.5, 0.06, 1);
      }
      return;
    }
    if (pick < 0.8) {
      const n = 3 + (r() * 3 | 0);
      const base2 = rand(r, 6200, 7800);
      for (let i = 0; i < n; i++) {
        const t2 = when + i * rand(r, 0.1, 0.17);
        this.tone(t2, {
          f0: base2 * jitter(r, 0.05),
          f1: base2 * rand(r, 0.82, 0.95),
          dur: rand(r, 0.05, 0.09),
          attack: 6e-3,
          gain: 0.1 * dist,
          vibrato: 0,
          vibratoDepth: 0,
          noise: 0.12,
          pan,
          send,
          dest: out
        });
      }
      return;
    }
    const base = rand(r, 330, 400);
    const pattern = [0.42, 0.3, 0.36, 0.28, 0.34];
    let t = when;
    for (let i = 0; i < pattern.length; i++) {
      const d = pattern[i] ?? 0.3;
      this.tone(t, {
        f0: base * (i === 1 ? 1.14 : 1),
        f1: base * (i === 1 ? 1.02 : 0.93),
        dur: d,
        attack: 0.05,
        gain: 0.09 * dist,
        vibrato: 0,
        vibratoDepth: 0,
        noise: 0.06,
        pan,
        send: send + 0.15,
        dest: out
      });
      t += d + 0.08;
    }
  }
  /**
   * A glide with optional vibrato and a breath of noise. Allocates an
   * oscillator per syllable — acceptable here and nowhere else: birds fire on
   * the order of once every fifteen seconds, not once per frame.
   */
  tone(when, o) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(o.f0, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), when + o.dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(o.gain, when + o.attack);
    amp.gain.setTargetAtTime(0, when + o.dur * 0.65, o.dur * 0.2);
    amp.gain.setValueAtTime(0, when + o.dur + 0.12);
    const pan = ctx.createStereoPanner();
    pan.pan.value = o.pan;
    const send = ctx.createGain();
    send.gain.value = o.send;
    osc.connect(amp).connect(pan);
    pan.connect(o.dest);
    pan.connect(send).connect(this.wet);
    osc.start(when);
    osc.stop(when + o.dur + 0.15);
    if (o.vibrato > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.vibrato;
      const depth = ctx.createGain();
      depth.gain.value = o.f0 * o.vibratoDepth;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(when);
      lfo.stop(when + o.dur + 0.15);
    }
    if (o.noise > 0) {
      const v = this.poolBird.acquire(when);
      v.hp.frequency.setValueAtTime(o.f0 * 0.7, when);
      v.peak.frequency.setValueAtTime(o.f0, when);
      v.peak.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), when + o.dur);
      v.peak.Q.setValueAtTime(9, when);
      v.peak.gain.setValueAtTime(18, when);
      v.lp.frequency.setValueAtTime(o.f0 * 3, when);
      v.pan.pan.setValueAtTime(o.pan, when);
      v.send.gain.setValueAtTime(o.send, when);
      v.amp.gain.setValueAtTime(0, when);
      v.amp.gain.linearRampToValueAtTime(o.gain * o.noise, when + o.attack);
      v.amp.gain.setTargetAtTime(0, when + o.dur * 0.65, o.dur * 0.2);
      v.amp.gain.setValueAtTime(0, when + o.dur + 0.12);
      v.start(this.ctx, this.bank.white, when, this.rng() * 1.5, o.dur + 0.1, 1);
    }
  }
};
function poisson(rng, meanS) {
  return -Math.log(1 - rng() * 0.999) * meanS;
}

// src/audio/breathing.ts
var Breathing = class {
  ctx;
  bank;
  rng;
  inhale;
  exhale;
  /** The involuntary low groan. Silent unless the athlete is in trouble. */
  osc;
  oscLp;
  oscBp;
  oscAmp;
  /** Timeline instant the next breath cycle begins. */
  nextBreathAt = 0;
  lastCatch = false;
  started = false;
  panSide = 1;
  constructor(ctx, bank, dry, wet, seed = 7331) {
    this.ctx = ctx;
    this.bank = bank;
    this.rng = makeRng(seed);
    this.inhale = makeChain(ctx, dry, wet);
    this.exhale = makeChain(ctx, dry, wet);
    this.osc = ctx.createOscillator();
    this.osc.type = "sawtooth";
    this.osc.frequency.value = 108;
    this.oscBp = ctx.createBiquadFilter();
    this.oscBp.type = "bandpass";
    this.oscBp.frequency.value = 320;
    this.oscBp.Q.value = 1.1;
    this.oscLp = ctx.createBiquadFilter();
    this.oscLp.type = "lowpass";
    this.oscLp.frequency.value = 430;
    this.oscLp.Q.value = 0.9;
    this.oscAmp = ctx.createGain();
    this.oscAmp.gain.value = 0;
    this.osc.connect(this.oscBp).connect(this.oscLp).connect(this.oscAmp).connect(dry);
  }
  /** Start the permanent sources. Call once, after the context is running. */
  start(when) {
    if (this.started) return;
    this.started = true;
    startChain(this.ctx, this.inhale, this.bank.white, when, 0.31);
    startChain(this.ctx, this.exhale, this.bank.pink, when, 1.27);
    this.osc.start(when);
    this.nextBreathAt = when + 0.05;
  }
  stop(when) {
    if (!this.started) return;
    this.started = false;
    this.inhale.src?.stop(when);
    this.exhale.src?.stop(when);
    this.osc.stop(when);
  }
  /**
   * Schedule breaths up to the lookahead horizon. Called every frame; does
   * nothing on most of them.
   */
  update(now, _dt, input) {
    if (!this.started) return;
    const horizon = now + 0.25;
    let guard = 0;
    while (this.nextBreathAt < horizon && guard++ < 8) {
      this.nextBreathAt = this.scheduleBreath(Math.max(this.nextBreathAt, now + 0.02), input);
    }
    if (this.nextBreathAt < now) this.nextBreathAt = now + 0.05;
  }
  /** Schedule exactly one breath cycle. Returns when the next one should start. */
  scheduleBreath(t0, input) {
    const rng = this.rng;
    const g = clamp(input.glycogen, 0, 1);
    const fatigue = 1 - g;
    const effort = clamp(input.speed / 4.5, 0, 1);
    const dry = clamp(1 - input.hydration, 0, 1);
    const bpm = 15 + 24 * effort + 26 * fatigue + 8 * effort * fatigue;
    const cycle = 60 / bpm * jitter(rng, 0.04 + 0.11 * fatigue);
    const inFrac = clamp(0.34 + 0.11 * effort + 0.05 * fatigue, 0.3, 0.48);
    const rest = cycle * clamp(0.16 - 0.16 * fatigue - 0.06 * effort, 0, 0.16);
    const active = cycle - rest;
    const tIn = active * inFrac;
    const tEx = active - tIn;
    const depth = clamp(0.2 + 0.34 * effort + 0.26 * fatigue, 0.2, 0.82);
    const catching = !this.lastCatch && rng() < clamp((fatigue - 0.35) * 0.85, 0, 0.5);
    this.lastCatch = catching;
    this.panSide = -this.panSide;
    const ic = this.inhale;
    const t1 = t0 + tIn;
    const bpLo = (620 + 320 * fatigue) * jitter(rng, 0.07);
    const bpHi = (1250 + 620 * fatigue + 260 * effort) * jitter(rng, 0.07);
    ic.bp.frequency.setValueAtTime(bpLo, t0);
    ic.bp.frequency.exponentialRampToValueAtTime(bpHi, t0 + tIn * 0.7);
    ic.bp.Q.setValueAtTime(0.62 + 0.3 * fatigue, t0);
    ic.f1.frequency.setValueAtTime(700 * jitter(rng, 0.06), t0);
    ic.f2.frequency.setValueAtTime((1180 + 340 * fatigue) * jitter(rng, 0.06), t0);
    ic.shelf.gain.setValueAtTime(-2 + 9 * fatigue + 4 * dry, t0);
    ic.pan.pan.setValueAtTime(this.panSide * 0.05, t0);
    const inPeak = depth * 0.95;
    const a = ic.amp.gain;
    a.setValueAtTime(0, t0);
    if (catching) {
      a.linearRampToValueAtTime(inPeak * 0.6, t0 + tIn * 0.2);
      a.linearRampToValueAtTime(inPeak * 0.17, t0 + tIn * 0.36);
      a.linearRampToValueAtTime(inPeak * 1.06, t0 + tIn * 0.66);
      a.linearRampToValueAtTime(inPeak * 0.3, t0 + tIn * 0.9);
    } else {
      a.linearRampToValueAtTime(inPeak, t0 + tIn * 0.48);
      a.linearRampToValueAtTime(inPeak * 0.34, t0 + tIn * 0.88);
    }
    a.linearRampToValueAtTime(0, t1);
    const ec = this.exhale;
    const t2 = t1 + tEx;
    const exLo = (480 + 210 * fatigue) * jitter(rng, 0.07);
    ec.bp.frequency.setValueAtTime(exLo * 1.5, t1);
    ec.bp.frequency.exponentialRampToValueAtTime(exLo * 0.72, t2);
    ec.bp.Q.setValueAtTime(0.55 + 0.25 * fatigue, t1);
    ec.f1.frequency.setValueAtTime(510 * jitter(rng, 0.06), t1);
    ec.f2.frequency.setValueAtTime((1050 + 280 * fatigue) * jitter(rng, 0.06), t1);
    ec.shelf.gain.setValueAtTime(-4 + 8 * fatigue + 3 * dry, t1);
    ec.pan.pan.setValueAtTime(-this.panSide * 0.05, t1);
    const exPeak = depth * (0.86 + 0.24 * fatigue);
    const b = ec.amp.gain;
    b.setValueAtTime(0, t1);
    b.linearRampToValueAtTime(exPeak, t1 + tEx * 0.16);
    const dips = fatigue < 0.35 ? 0 : 2 + (rng() * 3 | 0);
    if (dips > 0) {
      const depthOfDip = clamp((fatigue - 0.3) * 0.62, 0, 0.42);
      for (let i = 1; i <= dips; i++) {
        const f = 0.16 + 0.74 * i / (dips + 1);
        b.linearRampToValueAtTime(exPeak * (1 - depthOfDip * rand(rng, 0.6, 1)), t1 + tEx * f);
        b.linearRampToValueAtTime(
          exPeak * (0.86 + 0.14 * rng()),
          t1 + tEx * (f + 0.35 / (dips + 1))
        );
      }
    }
    b.linearRampToValueAtTime(0, t2);
    const groanP = clamp((fatigue - 0.5) * 1.15, 0, 0.55);
    const o = this.oscAmp.gain;
    if (rng() < groanP) {
      const f0 = rand(rng, 96, 132);
      this.osc.frequency.setValueAtTime(f0, t1);
      this.osc.frequency.linearRampToValueAtTime(f0 * rand(rng, 0.9, 0.96), t2);
      this.oscBp.frequency.setValueAtTime(f0 * rand(rng, 2.4, 3.2), t1);
      const gg = exPeak * 0.11 * clamp((fatigue - 0.45) * 2.2, 0, 1);
      o.setValueAtTime(0, t1 + tEx * 0.1);
      o.linearRampToValueAtTime(gg, t1 + tEx * 0.3);
      o.linearRampToValueAtTime(gg * 0.55, t1 + tEx * 0.7);
      o.linearRampToValueAtTime(0, t1 + tEx * 0.92);
    } else {
      o.setValueAtTime(0, t1);
    }
    return t2 + rest;
  }
};
function makeChain(ctx, dry, wet) {
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 180;
  hp.Q.value = 0.7;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 800;
  bp.Q.value = 0.6;
  const f1 = ctx.createBiquadFilter();
  f1.type = "peaking";
  f1.frequency.value = 620;
  f1.Q.value = 2.4;
  f1.gain.value = 9;
  const f2 = ctx.createBiquadFilter();
  f2.type = "peaking";
  f2.frequency.value = 1200;
  f2.Q.value = 1.8;
  f2.gain.value = 6;
  const shelf = ctx.createBiquadFilter();
  shelf.type = "highshelf";
  shelf.frequency.value = 3600;
  shelf.gain.value = -3;
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const pan = ctx.createStereoPanner();
  pan.pan.value = 0;
  hp.connect(bp).connect(f1).connect(f2).connect(shelf).connect(amp).connect(pan);
  pan.connect(dry);
  const send = ctx.createGain();
  send.gain.value = 0.07;
  pan.connect(send).connect(wet);
  return { hp, bp, f1, f2, shelf, amp, pan, src: null };
}
function startChain(ctx, chain, buffer, when, offset) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = buffer.duration;
  src.playbackRate.value = 0.97 + offset * 0.02;
  src.connect(chain.hp);
  src.start(when, offset % buffer.duration);
  chain.src = src;
}

// src/audio/engine.ts
var BUS_NAMES = [
  "footsteps",
  "breath",
  "ambience",
  "ui",
  "music"
];
var BUS_COMP = {
  footsteps: { threshold: -18, knee: 12, ratio: 3, attack: 4e-3, release: 0.15 },
  breath: { threshold: -22, knee: 10, ratio: 2.5, attack: 0.01, release: 0.25 },
  ambience: { threshold: -24, knee: 14, ratio: 2, attack: 0.05, release: 0.4 },
  ui: { threshold: -12, knee: 4, ratio: 4, attack: 2e-3, release: 0.08 },
  music: { threshold: -26, knee: 14, ratio: 2, attack: 0.02, release: 0.5 }
};
var BUS_DEFAULT_GAIN = {
  footsteps: 0.85,
  breath: 0.8,
  ambience: 0.7,
  ui: 0.9,
  music: 0.45
};
var AudioGraph = class {
  ctx;
  buses;
  /** Sum of every bus, before the master processing chain. */
  preMaster;
  /** Side-signal gain of the M/S width network. 1 = normal, 0 = mono. */
  width;
  /** Master tone. Dropping its cutoff is how the mix "narrows" spectrally. */
  tone;
  master;
  mute;
  limiter;
  /** Final safety net. Guarantees |out| ≤ 0.97 no matter what. */
  softClip;
  reverbSend;
  reverbReturn;
  convA;
  convB;
  gainA;
  gainB;
  irs = /* @__PURE__ */ new Map();
  activeIsA = true;
  currentReverb = null;
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = makeSoftClipCurve();
    this.softClip.oversample = "none";
    this.softClip.connect(destination);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 2e-3;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.softClip);
    this.mute = ctx.createGain();
    this.mute.gain.value = 1;
    this.mute.connect(this.limiter);
    this.master = ctx.createGain();
    this.master.gain.value = 0.62;
    this.master.connect(this.mute);
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 2e4;
    this.tone.Q.value = 0.5;
    this.tone.connect(this.master);
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const midL = ctx.createGain();
    const midR = ctx.createGain();
    const sideL = ctx.createGain();
    const sideR = ctx.createGain();
    const mid = ctx.createGain();
    const side = ctx.createGain();
    this.width = ctx.createGain();
    const widthNeg = ctx.createGain();
    midL.gain.value = 0.5;
    midR.gain.value = 0.5;
    sideL.gain.value = 0.5;
    sideR.gain.value = -0.5;
    this.width.gain.value = 1;
    widthNeg.gain.value = -1;
    this.preMaster = ctx.createGain();
    this.preMaster.connect(splitter);
    splitter.connect(midL, 0);
    splitter.connect(midR, 1);
    splitter.connect(sideL, 0);
    splitter.connect(sideR, 1);
    midL.connect(mid);
    midR.connect(mid);
    sideL.connect(side);
    sideR.connect(side);
    side.connect(this.width);
    this.width.connect(widthNeg);
    mid.connect(merger, 0, 0);
    mid.connect(merger, 0, 1);
    this.width.connect(merger, 0, 0);
    widthNeg.connect(merger, 0, 1);
    merger.connect(this.tone);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 1;
    this.reverbReturn.connect(this.preMaster);
    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.convA.normalize = false;
    this.convB.normalize = false;
    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();
    this.gainA.gain.value = 1;
    this.gainB.gain.value = 0;
    this.reverbSend.connect(this.convA).connect(this.gainA).connect(this.reverbReturn);
    this.reverbSend.connect(this.convB).connect(this.gainB).connect(this.reverbReturn);
    const buses = {};
    for (const name of BUS_NAMES) {
      const input = ctx.createGain();
      const duck = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      const aux = ctx.createGain();
      const spec = BUS_COMP[name];
      comp.threshold.value = spec.threshold;
      comp.knee.value = spec.knee;
      comp.ratio.value = spec.ratio;
      comp.attack.value = spec.attack;
      comp.release.value = spec.release;
      input.gain.value = BUS_DEFAULT_GAIN[name];
      duck.gain.value = 1;
      aux.gain.value = 1;
      input.connect(duck).connect(comp).connect(this.preMaster);
      aux.connect(this.reverbSend);
      buses[name] = { input, duck, comp, aux };
    }
    this.buses = buses;
  }
  /**
   * Render every impulse response. Roughly 25 ms of main-thread work at 48 kHz,
   * paid once, during `initAudio()` — after the unlock gesture but before the
   * first frame of the race.
   */
  buildReverbs() {
    if (this.irs.size > 0) return;
    for (const id of Object.keys(IR_PRESETS)) {
      this.irs.set(id, renderImpulseResponse(this.ctx, IR_PRESETS[id]));
    }
    this.setReverb("openForest", 0);
  }
  /**
   * Crossfade to another space over `rampS`. `when` defaults to now; the
   * offline renderer passes an explicit instant, because an
   * `OfflineAudioContext` sits at `currentTime === 0` until it renders.
   */
  setReverb(id, rampS = 1.5, when) {
    if (id === this.currentReverb) return;
    const ir = this.irs.get(id);
    if (!ir) return;
    const t = when ?? this.ctx.currentTime;
    const target = this.activeIsA ? this.convB : this.convA;
    const upGain = this.activeIsA ? this.gainB : this.gainA;
    const downGain = this.activeIsA ? this.gainA : this.gainB;
    target.buffer = ir;
    if (rampS <= 0) {
      upGain.gain.setValueAtTime(1, t);
      downGain.gain.setValueAtTime(0, t);
    } else {
      upGain.gain.cancelScheduledValues(t);
      downGain.gain.cancelScheduledValues(t);
      upGain.gain.setValueAtTime(upGain.gain.value, t);
      downGain.gain.setValueAtTime(downGain.gain.value, t);
      upGain.gain.linearRampToValueAtTime(1, t + rampS);
      downGain.gain.linearRampToValueAtTime(0, t + rampS);
    }
    this.activeIsA = !this.activeIsA;
    this.currentReverb = id;
  }
  /** Smoothly move a bus trim. `rampS = 0` snaps. */
  setBusGain(bus, value, rampS = 0.05) {
    const g = this.buses[bus].input.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (rampS <= 0) g.setValueAtTime(value, t);
    else g.linearRampToValueAtTime(value, t + rampS);
  }
  getBusGain(bus) {
    return this.buses[bus].input.gain.value;
  }
};
function getAudioContextCtor() {
  const w = globalThis;
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}
var AudioEngine = class {
  ctxInternal = null;
  graphInternal = null;
  opts;
  muted = false;
  suspendedByVisibility = false;
  listening = false;
  disposed = false;
  onGesture = () => {
    void this.unlock();
  };
  onVisibility = () => {
    const ctx = this.ctxInternal;
    if (!ctx || !isRealtime(ctx)) return;
    if (typeof document === "undefined") return;
    if (document.hidden) {
      if (ctx.state === "running") {
        this.suspendedByVisibility = true;
        void ctx.suspend();
      }
    } else if (this.suspendedByVisibility) {
      this.suspendedByVisibility = false;
      if (!this.muted) void ctx.resume();
    }
  };
  constructor(opts = {}) {
    this.opts = opts;
    if (opts.context) {
      this.attach(opts.context);
    } else {
      this.listen();
    }
  }
  get ctx() {
    return this.ctxInternal;
  }
  get graph() {
    return this.graphInternal;
  }
  get ready() {
    return this.graphInternal !== null;
  }
  /** Context timeline position, or 0 before the context exists. */
  get now() {
    return this.ctxInternal?.currentTime ?? 0;
  }
  get isMuted() {
    return this.muted;
  }
  /**
   * Create and start the context. Safe to call repeatedly; safe to call outside
   * a gesture (it just will not start until one arrives).
   *
   * The silent one-sample buffer at the end is the iOS Safari unlock ritual:
   * `resume()` alone can resolve while the context stays effectively muted
   * until some source has actually been started from inside a gesture handler.
   */
  async unlock() {
    if (this.disposed) return false;
    if (!this.ctxInternal) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return false;
      const ctx2 = new Ctor({ latencyHint: "interactive" });
      this.attach(ctx2);
    }
    const ctx = this.ctxInternal;
    if (!ctx || !isRealtime(ctx)) return false;
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      return false;
    }
    if (ctx.state === "running") {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
      this.stopListening();
      return true;
    }
    return false;
  }
  /**
   * Hard mute. Ramped over 40 ms rather than snapped, because a step to zero on
   * a running reverb tail is an audible click on every device.
   */
  setMuted(muted) {
    this.muted = muted;
    const g = this.graphInternal?.mute.gain;
    const ctx = this.ctxInternal;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(muted ? 0 : 1, t + 0.04);
  }
  setMasterGain(value, rampS = 0.1) {
    const g = this.graphInternal?.master.gain;
    const ctx = this.ctxInternal;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(value, t + rampS);
  }
  setBusGain(bus, value, rampS = 0.05) {
    this.graphInternal?.setBusGain(bus, value, rampS);
  }
  getBusGain(bus) {
    return this.graphInternal?.getBusGain(bus) ?? 0;
  }
  dispose() {
    this.disposed = true;
    this.stopListening();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    const ctx = this.ctxInternal;
    if (ctx && isRealtime(ctx)) void ctx.close();
    this.ctxInternal = null;
    this.graphInternal = null;
  }
  attach(ctx) {
    this.ctxInternal = ctx;
    const graph = new AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    this.graphInternal = graph;
    if (typeof document !== "undefined" && isRealtime(ctx)) {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    this.opts.onReady?.(graph);
  }
  listen() {
    if (this.listening) return;
    const target = this.opts.gestureTarget ?? (typeof window !== "undefined" ? window : null);
    if (!target) return;
    this.listening = true;
    for (const ev of GESTURES) {
      target.addEventListener(ev, this.onGesture, { passive: true, capture: true });
    }
  }
  stopListening() {
    if (!this.listening) return;
    const target = this.opts.gestureTarget ?? (typeof window !== "undefined" ? window : null);
    this.listening = false;
    if (!target) return;
    for (const ev of GESTURES) {
      target.removeEventListener(ev, this.onGesture, { capture: true });
    }
  }
};
var GESTURES = ["pointerdown", "touchend", "mousedown", "keydown"];
function makeSoftClipCurve() {
  const n = 2049;
  const knee = 0.7;
  const span = 0.25;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}
function isRealtime(ctx) {
  return typeof ctx.resume === "function" && "baseLatency" in ctx;
}

// src/audio/footsteps.ts
var RECIPES = {
  // Šumava spruce floor. Soft, dry, high — closer to a brush than an impact.
  needles: {
    colour: "pink",
    hp: 2250,
    lp: 8700,
    peakFreq: 5100,
    peakQ: 1,
    peakDb: 4,
    attack: 5e-3,
    decay: 0.115,
    gain: 0.5,
    send: 0.06,
    bodyFreq: 140,
    bodyGain: 0.11,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.75,
    freqVar: 0.11,
    gainVar: 0.22
  },
  // Beech litter. The crunch is the point: three offset grains, not one burst.
  leaf: {
    colour: "white",
    hp: 540,
    lp: 5200,
    peakFreq: 2e3,
    peakQ: 2.2,
    peakDb: 6,
    attack: 3e-3,
    decay: 0.155,
    gain: 0.55,
    send: 0.07,
    bodyFreq: 118,
    bodyGain: 0.15,
    grains: 3,
    grainSpread: 0.019,
    lpSweep: 0.7,
    freqVar: 0.14,
    gainVar: 0.28
  },
  // Swish, no click. Long soft envelope, low band, real body weight.
  grass: {
    colour: "pink",
    hp: 430,
    lp: 3900,
    peakFreq: 1350,
    peakQ: 1.4,
    peakDb: 3,
    attack: 7e-3,
    decay: 0.16,
    gain: 0.5,
    send: 0.05,
    bodyFreq: 95,
    bodyGain: 0.22,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.65,
    freqVar: 0.12,
    gainVar: 0.2
  },
  // Granite. Short, hard, and it rings — Q6 at 2.7 kHz is the boulder field.
  rock: {
    colour: "white",
    hp: 520,
    lp: 10500,
    peakFreq: 2750,
    peakQ: 6,
    peakDb: 11,
    attack: 18e-4,
    decay: 0.075,
    gain: 0.6,
    send: 0.13,
    bodyFreq: 155,
    bodyGain: 0.26,
    grains: 2,
    grainSpread: 0.011,
    lpSweep: 0.8,
    freqVar: 0.13,
    gainVar: 0.22
  },
  // Wet. Brown noise, everything below 900 Hz, closing sweep, plus the suck.
  marsh: {
    colour: "brown",
    hp: 70,
    lp: 900,
    peakFreq: 255,
    peakQ: 4,
    peakDb: 10,
    attack: 6e-3,
    decay: 0.2,
    gain: 0.7,
    send: 0.03,
    bodyFreq: 72,
    bodyGain: 0.5,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.45,
    freqVar: 0.16,
    gainVar: 0.24
  },
  // Loose stones. Four grains, wide band, nothing resonant — the brightest.
  gravel: {
    colour: "white",
    hp: 2e3,
    lp: 15e3,
    peakFreq: 4600,
    peakQ: 1.2,
    peakDb: 4,
    attack: 2e-3,
    decay: 0.125,
    gain: 0.52,
    send: 0.08,
    bodyFreq: 110,
    bodyGain: 0.17,
    grains: 4,
    grainSpread: 0.023,
    lpSweep: 0.85,
    freqVar: 0.15,
    gainVar: 0.3
  },
  // Krumlov. A hard bright click, 45 ms end to end, thrown at the courtyard.
  cobble: {
    colour: "white",
    hp: 1700,
    lp: 14e3,
    peakFreq: 3450,
    peakQ: 8,
    peakDb: 14,
    attack: 12e-4,
    decay: 0.045,
    gain: 0.58,
    send: 0.45,
    bodyFreq: 195,
    bodyGain: 0.2,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.9,
    freqVar: 0.1,
    gainVar: 0.18
  },
  // Flat slap. Dry, mid, short. Deliberately the least interesting surface.
  asphalt: {
    colour: "white",
    hp: 620,
    lp: 4400,
    peakFreq: 1550,
    peakQ: 3,
    peakDb: 7,
    attack: 16e-4,
    decay: 0.058,
    gain: 0.5,
    send: 0.09,
    bodyFreq: 132,
    bodyGain: 0.2,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.8,
    freqVar: 0.1,
    gainVar: 0.16
  },
  // Opening sweep — spray thrown up — then droplets falling back.
  water: {
    colour: "white",
    hp: 180,
    lp: 2150,
    peakFreq: 640,
    peakQ: 1.1,
    peakDb: 3,
    attack: 4e-3,
    decay: 0.28,
    gain: 0.62,
    send: 0.16,
    bodyFreq: 105,
    bodyGain: 0.3,
    grains: 0,
    grainSpread: 0,
    lpSweep: 2.6,
    freqVar: 0.13,
    gainVar: 0.24
  }
};
function brushAmount(r) {
  switch (r) {
    case 5 /* Green1 */:
      return 0.35;
    case 6 /* Green2 */:
      return 0.7;
    case 7 /* Green3 */:
      return 1;
    case 3 /* OpenRough */:
      return 0.25;
    default:
      return 0;
  }
}
var Footsteps = class _Footsteps {
  ctx;
  bank;
  pool;
  rng;
  /** Step phase, 0..1. Crossing 1 fires a foot. */
  phase = 0;
  leftFoot = true;
  /** Scheduling lookahead — enough to survive a dropped frame, short enough
   *  that the step still lines up with the animation. */
  static LOOKAHEAD = 0.03;
  constructor(ctx, bank, dry, wet, seed = 90210) {
    this.ctx = ctx;
    this.bank = bank;
    this.pool = new VoicePool(ctx, dry, wet, 16);
    this.rng = makeRng(seed);
  }
  /**
   * Advance the gait. Allocates nothing: the phase accumulator is a number, the
   * voices are pooled, and the only object born per step is the source node the
   * Web Audio API forces on us.
   */
  update(now, dt, input) {
    const rate = stepsPerSecond(input.speed);
    if (rate <= 0) {
      this.phase = 0;
      return;
    }
    this.phase += rate * dt;
    if (this.phase > 3) this.phase = 1;
    while (this.phase >= 1) {
      this.phase -= 1;
      const limp = (1 - input.glycogen) * (this.leftFoot ? 0.05 : -0.02);
      const when = now + _Footsteps.LOOKAHEAD + this.phase / rate + limp / rate;
      this.strike(when, input);
      this.leftFoot = !this.leftFoot;
    }
  }
  /** Fire one footfall immediately. Used by the preview harness. */
  trigger(when, input) {
    this.strike(when, input);
    this.leftFoot = !this.leftFoot;
  }
  strike(when, input) {
    const r = RECIPES[input.ground];
    const rng = this.rng;
    const effort = clamp(0.42 + input.speed * 0.16, 0.42, 1.08);
    const tired = 1 - input.glycogen;
    const pan = (this.leftFoot ? -1 : 1) * rand(rng, 0.1, 0.26);
    if (r.bodyGain > 0) {
      const v = this.pool.acquire(when);
      const f = r.bodyFreq * jitter(rng, 0.09);
      v.hp.frequency.setValueAtTime(f * 0.35, when);
      v.peak.frequency.setValueAtTime(f, when);
      v.peak.Q.setValueAtTime(3.2, when);
      v.peak.gain.setValueAtTime(13, when);
      v.lp.frequency.setValueAtTime(f * 3.4, when);
      v.lp.Q.setValueAtTime(1.1, when);
      v.pan.pan.setValueAtTime(pan * 0.4, when);
      const g = r.bodyGain * effort * (1 + tired * 0.28) * jitter(rng, 0.15);
      percussive(v.amp.gain, when, g, 4e-3, 0.09);
      this.play(v, "brown", when, 0.16);
    }
    this.surface(when, r, effort * jitter(rng, r.gainVar), pan, 1);
    for (let i = 0; i < r.grains; i++) {
      const t = when + rand(rng, 2e-3, r.grainSpread);
      this.surface(t, r, effort * rand(rng, 0.18, 0.45), pan + rand(rng, -0.08, 0.08), 0.55);
    }
    if (input.ground === "marsh") this.marshSuck(when, effort, pan);
    if (input.ground === "water") this.droplets(when, effort, pan);
    const brush = brushAmount(input.runnability);
    if (brush > 0 && rng() < 0.45 + brush * 0.5) this.brush(when, brush, effort, pan);
    if (tired > 0.45 && rng() < (tired - 0.45) * 1.1) {
      this.scuff(when + rand(rng, 0.02, 0.05), r, tired, pan);
    }
  }
  /** The identifying band of the material. `scale` shrinks it for grains. */
  surface(when, r, gain, pan, scale) {
    const rng = this.rng;
    const v = this.pool.acquire(when);
    const fv = jitter(rng, r.freqVar);
    const lp0 = r.lp * fv;
    v.hp.frequency.setValueAtTime(r.hp * fv, when);
    v.hp.Q.setValueAtTime(0.7, when);
    v.peak.frequency.setValueAtTime(r.peakFreq * fv, when);
    v.peak.Q.setValueAtTime(r.peakQ, when);
    v.peak.gain.setValueAtTime(r.peakDb, when);
    v.lp.frequency.setValueAtTime(lp0, when);
    v.lp.Q.setValueAtTime(0.9, when);
    if (r.lpSweep !== 1) {
      v.lp.frequency.exponentialRampToValueAtTime(
        clamp(lp0 * r.lpSweep, 60, 2e4),
        when + r.decay * scale
      );
    }
    v.pan.pan.setValueAtTime(pan, when);
    v.send.gain.setValueAtTime(r.send * gain, when);
    percussive(v.amp.gain, when, r.gain * gain * scale, r.attack, r.decay * scale);
    this.play(v, r.colour, when, r.decay * scale + r.attack + 0.06);
  }
  /**
   * The wet suck. A separate, later voice with a *rising* resonant lowpass:
   * the foot leaving the mud, the cavity collapsing behind it. This is the one
   * footstep in the set that has two distinct events in it.
   */
  marshSuck(when, effort, pan) {
    const rng = this.rng;
    const t = when + rand(rng, 0.055, 0.085);
    const v = this.pool.acquire(t);
    const f0 = rand(rng, 190, 280);
    const f1 = f0 * rand(rng, 4.2, 6.5);
    v.hp.frequency.setValueAtTime(90, t);
    v.peak.frequency.setValueAtTime(f0, t);
    v.peak.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
    v.peak.Q.setValueAtTime(7.5, t);
    v.peak.gain.setValueAtTime(16, t);
    v.lp.frequency.setValueAtTime(f0 * 2.2, t);
    v.lp.frequency.exponentialRampToValueAtTime(f1 * 1.8, t + 0.12);
    v.lp.Q.setValueAtTime(3.5, t);
    v.pan.pan.setValueAtTime(pan * 0.8, t);
    const g = 0.34 * effort * jitter(rng, 0.2);
    v.amp.gain.setValueAtTime(0, t);
    v.amp.gain.linearRampToValueAtTime(g, t + 0.045);
    v.amp.gain.setTargetAtTime(0, t + 0.045, 0.028);
    v.amp.gain.setValueAtTime(0, t + 0.24);
    this.play(v, "brown", t, 0.26);
  }
  /** Two or three drops falling back after a splash. */
  droplets(when, effort, pan) {
    const rng = this.rng;
    const n = 2 + (rng() * 2 | 0);
    for (let i = 0; i < n; i++) {
      const t = when + rand(rng, 0.06, 0.3);
      const v = this.pool.acquire(t);
      const f = rand(rng, 900, 1900);
      v.hp.frequency.setValueAtTime(f * 0.5, t);
      v.peak.frequency.setValueAtTime(f, t);
      v.peak.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.03);
      v.peak.Q.setValueAtTime(14, t);
      v.peak.gain.setValueAtTime(18, t);
      v.lp.frequency.setValueAtTime(f * 2.2, t);
      v.pan.pan.setValueAtTime(pan + rand(rng, -0.3, 0.3), t);
      v.send.gain.setValueAtTime(0.22, t);
      percussive(v.amp.gain, t, 0.07 * effort * rand(rng, 0.5, 1), 1e-3, 0.035);
      this.play(v, "white", t, 0.06);
    }
  }
  /** Branches and undergrowth against arms and legs. */
  brush(when, amount, effort, pan) {
    const rng = this.rng;
    const t = when + rand(rng, -0.02, 0.06);
    const v = this.pool.acquire(t);
    const f = rand(rng, 1600, 3200);
    v.hp.frequency.setValueAtTime(f * 0.55, t);
    v.peak.frequency.setValueAtTime(f, t);
    v.peak.Q.setValueAtTime(1.1, t);
    v.peak.gain.setValueAtTime(5, t);
    v.lp.frequency.setValueAtTime(f * 3.2, t);
    v.lp.frequency.exponentialRampToValueAtTime(f * 1.2, t + 0.2);
    v.pan.pan.setValueAtTime(-pan * 0.7, t);
    v.send.gain.setValueAtTime(0.1, t);
    const g = 0.2 * amount * effort * jitter(rng, 0.3);
    v.amp.gain.setValueAtTime(0, t);
    v.amp.gain.linearRampToValueAtTime(g, t + 0.02);
    v.amp.gain.setTargetAtTime(0, t + 0.02, 0.05);
    v.amp.gain.setValueAtTime(0, t + 0.3);
    this.play(v, "pink", t, 0.3);
    if (amount > 0.6 && rng() < 0.3) {
      const s = t + rand(rng, 0.01, 0.12);
      const sv = this.pool.acquire(s);
      sv.hp.frequency.setValueAtTime(900, s);
      sv.peak.frequency.setValueAtTime(rand(rng, 1800, 4200), s);
      sv.peak.Q.setValueAtTime(9, s);
      sv.peak.gain.setValueAtTime(16, s);
      sv.lp.frequency.setValueAtTime(9e3, s);
      sv.pan.pan.setValueAtTime(-pan, s);
      sv.send.gain.setValueAtTime(0.2, s);
      percussive(sv.amp.gain, s, 0.16 * amount, 8e-4, 0.03);
      this.play(sv, "white", s, 0.05);
    }
  }
  /** A dragged foot. Long, dull, quiet, and it only happens when it should. */
  scuff(when, r, tired, pan) {
    const rng = this.rng;
    const v = this.pool.acquire(when);
    const f = r.peakFreq * 0.55 * jitter(rng, 0.2);
    v.hp.frequency.setValueAtTime(r.hp * 0.7, when);
    v.peak.frequency.setValueAtTime(f, when);
    v.peak.Q.setValueAtTime(1, when);
    v.peak.gain.setValueAtTime(3, when);
    v.lp.frequency.setValueAtTime(f * 2.4, when);
    v.lp.frequency.exponentialRampToValueAtTime(f * 1.1, when + 0.16);
    v.pan.pan.setValueAtTime(pan, when);
    const g = 0.13 * tired * jitter(rng, 0.25);
    v.amp.gain.setValueAtTime(0, when);
    v.amp.gain.linearRampToValueAtTime(g, when + 0.03);
    v.amp.gain.setTargetAtTime(0, when + 0.03, 0.045);
    v.amp.gain.setValueAtTime(0, when + 0.26);
    this.play(v, r.colour, when, 0.26);
  }
  play(v, colour, when, duration) {
    const buf = colour === "white" ? this.bank.white : colour === "pink" ? this.bank.pink : this.bank.brown;
    const offset = this.rng() * Math.max(0.05, buf.duration - duration - 0.05);
    v.start(this.ctx, buf, when, offset, duration, 1);
  }
};
function stepsPerSecond(speed) {
  if (speed < 0.15) return 0;
  return clamp(1.24 + speed * 0.42, 0.95, 3.3);
}

// src/audio/mixer.ts
var MAP_DUCK_DB = {
  footsteps: -9,
  breath: -4.5,
  ambience: -15,
  music: -12,
  ui: 0
};
var SIDECHAIN_DB = {
  footsteps: -1.5,
  breath: 0,
  ambience: -4,
  music: -4,
  ui: 0
};
var TONE_OPEN = 2e4;
var TONE_DUCKED = 1700;
var WIDTH_OPEN = 1;
var WIDTH_DUCKED = 0.35;
var REVERB_OPEN = 1;
var REVERB_DUCKED = 0.55;
var TC_DOWN = 0.1;
var TC_UP = 0.185;
var Mixer = class {
  graph;
  /** Per-bus map-duck factor, 0..1. The sidechain multiplies on top of this. */
  base;
  mapOpen = false;
  constructor(graph) {
    this.graph = graph;
    this.base = { footsteps: 1, breath: 1, ambience: 1, music: 1, ui: 1 };
  }
  get isMapOpen() {
    return this.mapOpen;
  }
  /**
   * Raise or lower the map. Idempotent — calling it every frame while the
   * button is held costs nothing and schedules nothing.
   */
  duckForMap(on, when) {
    if (on === this.mapOpen) return;
    this.mapOpen = on;
    const tc = on ? TC_DOWN : TC_UP;
    for (const bus of BUS_NAMES) {
      const target = on ? dbToGain(MAP_DUCK_DB[bus]) : 1;
      this.base[bus] = target;
      this.graph.buses[bus].duck.gain.setTargetAtTime(target, when, tc);
      this.graph.buses[bus].aux.gain.setTargetAtTime(target, when, tc);
    }
    const tone = this.graph.tone.frequency;
    tone.cancelScheduledValues(when);
    tone.setValueAtTime(Math.max(20, tone.value), when);
    tone.exponentialRampToValueAtTime(on ? TONE_DUCKED : TONE_OPEN, when + (on ? 0.32 : 0.6));
    this.graph.width.gain.setTargetAtTime(on ? WIDTH_DUCKED : WIDTH_OPEN, when, tc);
    this.graph.reverbReturn.gain.setTargetAtTime(on ? REVERB_DUCKED : REVERB_OPEN, when, tc);
  }
  /**
   * Momentary dip so a foreground event cuts through. Composes with the map
   * duck: the target is always `base × sidechain`, never an absolute.
   */
  sidechain(when, holdS = 0.18) {
    for (const bus of BUS_NAMES) {
      const db = SIDECHAIN_DB[bus];
      if (db === 0) continue;
      const g = this.graph.buses[bus].duck.gain;
      const dipped = this.base[bus] * dbToGain(db);
      g.cancelScheduledValues(when);
      g.setValueAtTime(g.value, when);
      g.setTargetAtTime(dipped, when, 0.014);
      g.setTargetAtTime(this.base[bus], when + holdS, 0.09);
    }
  }
  /**
   * Master trim with a ramp, for fade-in at race start and fade-out at finish.
   * Distinct from the engine's hard mute, which is a user control.
   */
  fade(to, when, seconds) {
    const g = this.graph.master.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(clamp(to, 0, 1) * 0.8, when + Math.max(0.01, seconds));
  }
  /** Diagnostic: the current duck factor applied to a bus, 0..1. */
  duckFactor(bus) {
    return this.base[bus];
  }
};

// src/audio/music.ts
var SCALE = [
  146.83,
  // D3
  155.56,
  // Eb3  — the flat second
  174.61,
  // F3
  196,
  // G3
  220,
  // A3
  233.08,
  // Bb3  — the flat sixth
  261.63,
  // C4
  293.66,
  // D4
  311.13,
  // Eb4
  349.23,
  // F4
  440
  // A4
];
var WEIGHT_CALM = [3.2, 0.4, 1.6, 0.9, 2.6, 0.5, 0.9, 1.4, 0.2, 0.7, 0.3];
var WEIGHT_TENSE = [1.6, 2.4, 1.1, 0.7, 1.8, 2.2, 0.8, 1.2, 1.6, 0.9, 0.9];
var PLUCK_BASES = [146.83, 220, 293.66];
var Music = class {
  ctx;
  rng;
  out;
  pool;
  wet;
  plucks = [];
  // Drone
  droneOscs = [];
  droneLp;
  droneGain;
  bowOsc;
  bowBp;
  bowGain;
  tension = 0;
  started = false;
  tNext = 0;
  tDrift = 0;
  /** Last degree played, so the generator can lean into or away from it. */
  lastDegree = 0;
  constructor(ctx, dry, wet, seed = 5399) {
    this.ctx = ctx;
    this.wet = wet;
    this.rng = makeRng(seed);
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dry);
    this.pool = new VoicePool(ctx, this.out, wet, 6);
    this.droneLp = ctx.createBiquadFilter();
    this.droneLp.type = "lowpass";
    this.droneLp.frequency.value = 210;
    this.droneLp.Q.value = 0.85;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneLp.connect(this.droneGain).connect(this.out);
    const droneSpecs = [
      [36.71, 0, "triangle"],
      // D1 — felt, not heard
      [73.42, -4, "sawtooth"],
      // D2
      [73.42, 5, "sawtooth"],
      [110, 3, "sawtooth"]
      // A2
    ];
    for (const [freq, cents, type] of droneSpecs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = type === "triangle" ? 0.3 : 0.12;
      o.connect(g).connect(this.droneLp);
      this.droneOscs.push(o);
    }
    this.bowOsc = ctx.createOscillator();
    this.bowOsc.type = "sawtooth";
    this.bowOsc.frequency.value = 220;
    this.bowBp = ctx.createBiquadFilter();
    this.bowBp.type = "bandpass";
    this.bowBp.frequency.value = 660;
    this.bowBp.Q.value = 4.5;
    this.bowGain = ctx.createGain();
    this.bowGain.gain.value = 0;
    this.bowOsc.connect(this.bowBp).connect(this.bowGain);
    this.bowGain.connect(this.out);
    const bowSend = ctx.createGain();
    bowSend.gain.value = 0.5;
    this.bowGain.connect(bowSend).connect(wet);
    for (let i = 0; i < PLUCK_BASES.length; i++) {
      const f = PLUCK_BASES[i] ?? 220;
      const data = renderPluck(ctx.sampleRate, {
        freq: f,
        seconds: 2.6,
        damping: 0.42,
        brightness: 0.3,
        sustain: 0.9994,
        seed: seed + 11 * (i + 1)
      });
      this.plucks.push(toBuffer(ctx, data));
    }
  }
  start(when) {
    if (this.started) return;
    this.started = true;
    for (const o of this.droneOscs) o.start(when);
    this.bowOsc.start(when);
    this.droneGain.gain.setTargetAtTime(0.2, when, 4);
    this.tNext = when + rand(this.rng, 6, 16);
    this.tDrift = when + 3;
  }
  stop(when) {
    if (!this.started) return;
    this.started = false;
    this.droneGain.gain.setTargetAtTime(0, when, 1.5);
    for (const o of this.droneOscs) o.stop(when + 6);
    this.bowOsc.stop(when + 6);
  }
  /** 0..1. Denser events, sourer degrees, a brighter drone. Not louder. */
  setTension(t) {
    this.tension = clamp(t, 0, 1);
  }
  update(now, _dt) {
    if (!this.started) return;
    const r = this.rng;
    const T = this.tension;
    if (now >= this.tDrift) {
      const t = now + 0.01;
      this.droneLp.frequency.setTargetAtTime(rand(r, 150, 260) * (1 + T * 0.9), t, rand(r, 3, 8));
      this.droneGain.gain.setTargetAtTime(rand(r, 0.14, 0.24) * (0.8 + 0.3 * T), t, rand(r, 4, 10));
      if (r() < 0.35 + 0.3 * T) {
        const dur = rand(r, 6, 16);
        const deg = this.pick();
        this.bowOsc.frequency.setTargetAtTime((SCALE[deg] ?? 220) * 2, t, 2.5);
        this.bowBp.frequency.setTargetAtTime(rand(r, 500, 1100), t, 3);
        const g = rand(r, 0.02, 0.055) * (0.7 + 0.5 * T);
        this.bowGain.gain.setTargetAtTime(g, t, dur * 0.3);
        this.bowGain.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.25);
      }
      this.tDrift = now + rand(r, 5, 11);
    }
    if (now >= this.tNext) {
      this.event(now + rand(r, 0.05, 0.4));
      const mean = 14 - 9 * T;
      this.tNext = now + -Math.log(1 - r() * 0.999) * mean + 1.2;
    }
  }
  /** One musical gesture. Usually a single note. Sometimes two. */
  event(when) {
    const r = this.rng;
    const T = this.tension;
    const deg = this.pick();
    this.pluck(when, deg, rand(r, 0.1, 0.2) * (0.8 + 0.4 * T));
    if (r() < 0.1 + 0.35 * T) {
      const near = clamp(deg + (r() < 0.5 ? 1 : -1), 0, SCALE.length - 1);
      this.pluck(when + rand(r, 0.18, 0.75), near, rand(r, 0.05, 0.12));
    } else if (r() < 0.25) {
      const below = clamp(deg - 4, 0, SCALE.length - 1);
      this.pluck(when + rand(r, 0.5, 1.6), below, rand(r, 0.04, 0.09));
    }
    this.lastDegree = deg;
  }
  pluck(when, degree, gain) {
    const r = this.rng;
    const freq = SCALE[degree] ?? 220;
    let bestIdx = 0;
    let best = Infinity;
    for (let i = 0; i < PLUCK_BASES.length; i++) {
      const d = Math.abs(Math.log((PLUCK_BASES[i] ?? 1) / freq));
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    const buf = this.plucks[bestIdx];
    if (!buf) return;
    const rate = freq / (PLUCK_BASES[bestIdx] ?? freq);
    const v = this.pool.acquire(when);
    v.hp.frequency.setValueAtTime(freq * 0.5, when);
    v.peak.frequency.setValueAtTime(freq * rand(r, 2, 3.4), when);
    v.peak.Q.setValueAtTime(1.2, when);
    v.peak.gain.setValueAtTime(rand(r, 2, 5), when);
    v.lp.frequency.setValueAtTime(rand(r, 1800, 4200), when);
    v.pan.pan.setValueAtTime(rand(r, -0.4, 0.4), when);
    v.send.gain.setValueAtTime(rand(r, 0.35, 0.6), when);
    const dur = 2.5 / rate;
    v.amp.gain.setValueAtTime(gain, when);
    v.amp.gain.setTargetAtTime(0, when + dur * 0.55, dur * 0.2);
    v.amp.gain.setValueAtTime(0, when + dur);
    v.start(this.ctx, buf, when, 0, Math.min(dur, buf.duration / rate - 0.01), rate);
  }
  /** Weighted degree choice, interpolating calm→tense, avoiding repeats. */
  pick() {
    const T = this.tension;
    let total = 0;
    for (let i = 0; i < SCALE.length; i++) {
      const w = (WEIGHT_CALM[i] ?? 0) * (1 - T) + (WEIGHT_TENSE[i] ?? 0) * T;
      total += i === this.lastDegree ? w * 0.25 : w;
    }
    let x = this.rng() * total;
    for (let i = 0; i < SCALE.length; i++) {
      const w = (WEIGHT_CALM[i] ?? 0) * (1 - T) + (WEIGHT_TENSE[i] ?? 0) * T;
      x -= i === this.lastDegree ? w * 0.25 : w;
      if (x <= 0) return i;
    }
    return 0;
  }
  /** Exposed so a race result screen can let the drone go. */
  get output() {
    return this.out;
  }
  /** Exposed for the preview harness. */
  get reverbSend() {
    return this.wet;
  }
};

// src/audio/sportident.ts
var Punch = class {
  ctx;
  pool;
  rng;
  beeps;
  click;
  constructor(ctx, dry, wet, seed = 3103) {
    this.ctx = ctx;
    this.pool = new VoicePool(ctx, dry, wet, 6);
    this.rng = makeRng(seed);
    const sr = ctx.sampleRate;
    const contact = renderModal(
      sr,
      2e3,
      [
        { ratio: 1, gain: 1, decay: 0.45 },
        { ratio: 2, gain: 0.08, decay: 0.14 },
        { ratio: 3, gain: 0.05, decay: 0.1 },
        { ratio: 4.72, gain: 0.035, decay: 0.05 }
      ],
      0.088,
      { strikeNoise: 0.1, strikeMs: 2.2, seed: seed + 1 }
    );
    normalisePeak(contact, 0.9);
    const touchfree = renderModal(
      sr,
      2600,
      [
        { ratio: 1, gain: 1, decay: 0.26 },
        { ratio: 2, gain: 0.045, decay: 0.08 },
        { ratio: 3.61, gain: 0.03, decay: 0.04 }
      ],
      0.056,
      { strikeNoise: 0.05, strikeMs: 1.4, seed: seed + 2 }
    );
    normalisePeak(touchfree, 0.85);
    this.beeps = { contact: toBuffer(ctx, contact), touchfree: toBuffer(ctx, touchfree) };
    const clickLen = Math.round(0.012 * sr);
    const click = new Float32Array(clickLen);
    const rng = makeRng(seed + 3);
    let lp = 0;
    for (let i = 0; i < clickLen; i++) {
      lp = (rng() * 2 - 1) * 0.55 + lp * 0.45;
      const env = Math.exp(-i / (clickLen * 0.18));
      click[i] = lp * env;
    }
    normalisePeak(click, 0.6);
    this.click = toBuffer(ctx, click);
  }
  /**
   * Fire the feedback. Returns the timeline instant the beep starts, so the
   * renderer can put the control-flag flash on exactly the same frame — the
   * beep and the flash arriving together is most of what sells a punch.
   */
  fire(when, kind, opts = {}) {
    const level = opts.level ?? 1;
    const pan = opts.pan ?? (kind === "touchfree" ? rand(this.rng, -0.22, -0.06) : 0);
    if (kind === "contact") {
      const t = when - 0.016;
      const v = this.pool.acquire(t);
      v.hp.frequency.setValueAtTime(700, t);
      v.peak.frequency.setValueAtTime(2600, t);
      v.peak.Q.setValueAtTime(1.4, t);
      v.peak.gain.setValueAtTime(5, t);
      v.lp.frequency.setValueAtTime(9e3, t);
      v.pan.pan.setValueAtTime(pan, t);
      v.amp.gain.setValueAtTime(0.45 * level, t);
      v.amp.gain.setValueAtTime(0, t + 0.02);
      v.start(this.ctx, this.click, t, 0, 0.014, 1);
    }
    this.beep(when, kind, level, pan);
    if (opts.double) this.beep(when + 0.12, kind, level * 0.92, pan);
    return when;
  }
  beep(when, kind, level, pan) {
    const buf = this.beeps[kind];
    const v = this.pool.acquire(when);
    v.hp.frequency.setValueAtTime(400, when);
    v.peak.frequency.setValueAtTime(kind === "contact" ? 2e3 : 2600, when);
    v.peak.Q.setValueAtTime(1.2, when);
    v.peak.gain.setValueAtTime(2, when);
    v.lp.frequency.setValueAtTime(16e3, when);
    v.pan.pan.setValueAtTime(pan, when);
    v.send.gain.setValueAtTime(kind === "touchfree" ? 0.3 : 0.1, when);
    v.amp.gain.setValueAtTime((kind === "contact" ? 0.62 : 0.5) * level, when);
    v.amp.gain.setValueAtTime(0, when + buf.duration + 5e-3);
    v.start(this.ctx, buf, when, 0, buf.duration, 1);
  }
};

// src/audio/index.ts
var AudioSystem = class {
  graph;
  bank;
  footsteps;
  breathing;
  punch;
  ambience;
  music;
  mixer;
  started = false;
  ground = "needles";
  runnability = 4 /* ForestOpen */;
  environment = "forest";
  constructor(graph, opts = {}) {
    const ctx = graph.ctx;
    const seed = opts.seed ?? 20260805;
    this.graph = graph;
    this.bank = new NoiseBank(ctx, seed);
    const b = graph.buses;
    this.footsteps = new Footsteps(ctx, this.bank, b.footsteps.input, b.footsteps.aux, seed + 1);
    this.breathing = new Breathing(ctx, this.bank, b.breath.input, b.breath.aux, seed + 2);
    this.punch = new Punch(ctx, b.ui.input, b.ui.aux, seed + 3);
    this.ambience = new Ambience(ctx, this.bank, b.ambience.input, b.ambience.aux, {
      seed: seed + 4,
      lean: opts.lean ?? false
    });
    this.music = new Music(ctx, b.music.input, b.music.aux, seed + 5);
    this.mixer = new Mixer(graph);
  }
  /** Start the continuous voices. Idempotent. */
  start(when) {
    if (this.started) return;
    this.started = true;
    this.breathing.start(when);
    this.ambience.start(when);
    this.music.start(when);
  }
  stop(when) {
    if (!this.started) return;
    this.started = false;
    this.breathing.stop(when);
    this.ambience.stop(when);
    this.music.stop(when);
  }
  /**
   * One frame. Allocates nothing in the common path — the only objects born
   * here are the `AudioBufferSourceNode`s the specification requires for a
   * one-shot, and those only on frames where something actually fires.
   */
  update(now, dt, state, scene) {
    if (!this.started) return;
    if (scene?.ground) this.ground = scene.ground;
    if (scene?.runnability !== void 0) this.runnability = scene.runnability;
    if (scene?.environment && scene.environment !== this.environment) {
      this.setEnvironment(scene.environment, now);
    }
    if (scene?.wind !== void 0) this.ambience.setWind(scene.wind, now);
    const stats = state.stats;
    this.footsteps.update(now, dt, {
      ground: this.ground,
      speed: state.speed,
      runnability: this.runnability,
      glycogen: stats.glycogen
    });
    this.breathing.update(now, dt, {
      glycogen: stats.glycogen,
      speed: state.speed,
      hydration: stats.hydration
    });
    this.ambience.update(now, dt);
    const tension = scene?.tension ?? clamp(0.55 * (1 - stats.glycogen) + 0.45 * (1 - stats.focus), 0, 1);
    this.music.setTension(tension);
    this.music.update(now, dt);
  }
  setEnvironment(id, now, rampS = 2.5) {
    this.environment = id;
    this.ambience.setEnvironment(id, now, rampS);
    this.graph.setReverb(this.ambience.reverb, rampS, now);
  }
  /** Fire a control punch. Returns the instant the beep starts, for the flash. */
  firePunch(now, kind = "contact", opts) {
    const at = now + 0.01;
    this.mixer.sidechain(at);
    return this.punch.fire(at, kind, opts);
  }
  duckForMap(on, now) {
    this.mixer.duckForMap(on, now);
  }
};
var engine = null;
var system = null;
function initAudio(opts = {}) {
  if (engine) return;
  engine = new AudioEngine({
    ...opts.gestureTarget ? { gestureTarget: opts.gestureTarget } : {},
    onReady: (graph) => {
      const sys = new AudioSystem(graph, opts);
      sys.start(graph.ctx.currentTime + 0.05);
      system = sys;
      if (opts.muted) engine?.setMuted(true);
      opts.onReady?.(sys);
    }
  });
}
async function unlockAudio() {
  return await engine?.unlock() ?? false;
}
function isAudioReady() {
  return system !== null;
}
function getAudio() {
  return system;
}
function updateAudio(state, dt, scene) {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.update(e.now, dt, state, scene);
}
function punch(kind = "contact", opts) {
  const sys = system;
  const e = engine;
  if (!sys || !e) return 0;
  return sys.firePunch(e.now, kind, opts);
}
function setEnvironment(env, rampS = 2.5) {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.setEnvironment(env, e.now, rampS);
}
function duckForMap(on) {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.duckForMap(on, e.now);
}
function setMuted(muted) {
  engine?.setMuted(muted);
}
function isMuted() {
  return engine?.isMuted ?? false;
}
function setBusGain(bus, value, rampS = 0.05) {
  engine?.setBusGain(bus, value, rampS);
}
function getBusGain(bus) {
  return engine?.getBusGain(bus) ?? 0;
}
function setMasterGain(value, rampS = 0.1) {
  engine?.setMasterGain(value, rampS);
}
function ringBells(strikes = 9) {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.ambience.ringBells(e.now + 0.1, strikes);
}
function disposeAudio() {
  const e = engine;
  if (e && system) system.stop(e.now);
  e?.dispose();
  engine = null;
  system = null;
}
export {
  AudioEngine,
  AudioGraph,
  AudioSystem,
  BUS_NAMES,
  disposeAudio,
  duckForMap,
  getAudio,
  getBusGain,
  initAudio,
  isAudioReady,
  isMuted,
  punch,
  ringBells,
  setBusGain,
  setEnvironment,
  setMasterGain,
  setMuted,
  unlockAudio,
  updateAudio
};
