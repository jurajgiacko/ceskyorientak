/**
 * Synthesis primitives. Everything the audio system makes noise with is
 * authored here, in code — there is not one sample file in this project.
 *
 * Three rules shape this file:
 *
 *  1. **Allocate at init, not at runtime.** Noise, impulse responses, plucked
 *     strings and struck bells are rendered into `AudioBuffer`s once, during
 *     `initAudio()`, and then replayed. The per-frame update path allocates
 *     nothing but `AudioBufferSourceNode`s, which the Web Audio API makes
 *     unavoidable (a source node is single-use by specification).
 *
 *  2. **Deterministic randomness.** Every generator takes a seed, so a build
 *     produces byte-identical buffers on every machine. That is what makes the
 *     offline verification in `tools/audio/` meaningful.
 *
 *  3. **No `AudioWorklet`.** All DSP that needs sample-level control happens
 *     here, at init, in plain JS writing into `Float32Array`s. What runs at
 *     realtime is only native nodes. This is what keeps iOS Safari happy and
 *     removes a whole class of "worklet failed to load" failure.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** mulberry32 — small, fast, good enough for noise and event timing. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rand(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Symmetric random detune expressed as a ratio, e.g. `jitter(rng, 0.1)` → 0.9..1.1. */
export function jitter(rng: Rng, amount: number): number {
  return 1 + (rng() * 2 - 1) * amount;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Buffer utilities
// ---------------------------------------------------------------------------

function createBuffer(ctx: BaseAudioContext, channels: number, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.round(seconds * ctx.sampleRate));
  return ctx.createBuffer(channels, len, ctx.sampleRate);
}

/**
 * One-pole DC blocker. Applied to every generated buffer — a DC offset in a
 * looped noise bed eats headroom silently and shows up as a verification
 * failure long before anyone hears it.
 */
function dcBlock(x: Float32Array): void {
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

function rmsOf(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, x.length));
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i] ?? 0);
    if (v > p) p = v;
  }
  return p;
}

function scaleBy(x: Float32Array, g: number): void {
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) * g;
}

/** Normalise to a target RMS, then hard-cap the peak so nothing can clip. */
function normaliseRms(x: Float32Array, targetRms: number, peakCap = 0.95): void {
  const r = rmsOf(x);
  if (r > 1e-9) scaleBy(x, targetRms / r);
  const p = peakOf(x);
  if (p > peakCap) scaleBy(x, peakCap / p);
}

/**
 * Make a buffer loop seamlessly by crossfading its tail into a copy of its head.
 * Noise beds run for the whole race; a click every 2.5 s would be the single
 * most obvious tell that the ambience is a loop.
 */
function wrapCrossfade(x: Float32Array, fadeSamples: number): void {
  const n = x.length;
  const f = Math.min(fadeSamples, (n / 2) | 0);
  for (let i = 0; i < f; i++) {
    const w = i / f; // 0 → 1 across the fade
    const tail = x[n - f + i] ?? 0;
    const head = x[i] ?? 0;
    // equal-power so the noise floor does not dip through the splice
    const a = Math.cos((w * Math.PI) / 2);
    const b = Math.sin((w * Math.PI) / 2);
    x[n - f + i] = tail * a + head * b;
  }
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function fillWhite(out: Float32Array, rng: Rng): void {
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
}

/**
 * Pink noise, Voss-McCartney. 16 rows; one row is refreshed per sample chosen
 * by the trailing-zero count of a counter, plus a white top layer so the
 * highest octave is not stepped.
 */
function fillPink(out: Float32Array, rng: Rng): void {
  const ROWS = 16;
  const rows = new Float32Array(ROWS);
  let sum = 0;
  let counter = 0;
  for (let i = 0; i < out.length; i++) {
    counter = (counter + 1) >>> 0;
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

/** Brown/red noise: leaky integration of white, then DC-blocked. */
function fillBrown(out: Float32Array, rng: Rng): void {
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y = 0.996 * y + 0.04 * (rng() * 2 - 1);
    out[i] = y;
  }
  dcBlock(out);
}

/**
 * The three noise beds, generated once at init and shared by every voice in the
 * system. Footsteps, breath, wind, water and crowd all read from these — each
 * voice picks its own random offset and playback rate, which is what stops a
 * shared buffer from sounding shared.
 */
export class NoiseBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;

  constructor(ctx: BaseAudioContext, seed = 0x5f1de) {
    const fade = Math.round(0.05 * ctx.sampleRate);

    this.white = createBuffer(ctx, 2, 2.5);
    this.pink = createBuffer(ctx, 2, 3.0);
    this.brown = createBuffer(ctx, 1, 2.0);

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
  get bytes(): number {
    const of = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4;
    return of(this.white) + of(this.pink) + of(this.brown);
  }
}

// ---------------------------------------------------------------------------
// Impulse responses
// ---------------------------------------------------------------------------

export type ReverbId = 'openForest' | 'denseSpruce' | 'stoneCourtyard' | 'openArena';

export interface IrSpec {
  /** Total IR length in seconds. Also the nominal RT60. */
  seconds: number;
  /** Silence before the diffuse tail starts, seconds. Reads as room size. */
  predelay: number;
  /** Tail lowpass cutoff at t=0, Hz. */
  hfStart: number;
  /** Tail lowpass cutoff at t=seconds, Hz. Material + air absorption. */
  hfEnd: number;
  /** Tail highpass corner, Hz. Small hard rooms keep bass; forests do not. */
  lfCut: number;
  /**
   * Echo density 0..1. Low values leave audible discrete scatter — which is
   * exactly what a forest is: a sparse field of trunks, not a diffuse room.
   */
  density: number;
  /** Discrete early reflections as `[timeSeconds, gain]`. */
  early: readonly (readonly [number, number])[];
  seed: number;
}

/**
 * Procedural impulse responses.
 *
 * Model: exponentially-decaying noise, lowpass cutoff swept down over the tail
 * (high frequencies are absorbed first, in every real space), echo density
 * ramping up from the first reflection, plus a set of discrete early
 * reflections placed by hand per space. Channels are generated from independent
 * seeds and the early reflections are offset a few samples between them, which
 * is where the stereo width comes from.
 */
export function renderImpulseResponse(ctx: BaseAudioContext, spec: IrSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = createBuffer(ctx, 2, spec.seconds + spec.predelay + 0.02);
  const n = buf.length;

  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    const rng = makeRng(spec.seed + ch * 104729);
    const start = Math.round(spec.predelay * sr);

    // --- diffuse tail -----------------------------------------------------
    let lp = 0;
    let coef = 0;
    const densityRamp = Math.max(1, Math.round(0.09 * sr));
    for (let i = start; i < n; i++) {
      const t = (i - start) / sr;
      const frac = t / spec.seconds;

      // Recompute the one-pole coefficient every 64 samples; the sweep is far
      // slower than that and this keeps ~130k exp() calls out of init.
      if ((i & 63) === 0) {
        const fc = spec.hfStart * Math.pow(spec.hfEnd / spec.hfStart, Math.min(1, frac));
        coef = Math.exp((-2 * Math.PI * fc) / sr);
      }

      // -60 dB at t = seconds.
      const env = Math.pow(10, -3 * frac);

      // Echo density rises quadratically from the first reflection.
      const ramp = Math.min(1, (i - start) / densityRamp);
      const p = clamp(spec.density * ramp * ramp, 0.02, 1);
      const grain = rng() < p ? (rng() * 2 - 1) / Math.sqrt(p) : 0;

      lp = grain * (1 - coef) + lp * coef;
      out[i] = lp * env;
    }

    // --- discrete early reflections ---------------------------------------
    // A few samples of skew per channel and a couple of samples of smear per
    // reflection: a real reflecting surface is not a Dirac.
    const skew = ch === 0 ? 0 : Math.round(0.0011 * sr);
    for (const er of spec.early) {
      const at = Math.round((er[0] + spec.predelay) * sr) + skew;
      const width = Math.max(2, Math.round(0.0008 * sr));
      const sign = rng() < 0.5 ? -1 : 1;
      for (let k = 0; k < width; k++) {
        const idx = at + k;
        if (idx >= n) break;
        const w = 1 - k / width;
        out[idx] = (out[idx] ?? 0) + sign * er[1] * w * w * (rng() * 2 - 1);
      }
    }

    // --- highpass: strip the rumble the model does not earn ----------------
    const hpCoef = Math.exp((-2 * Math.PI * spec.lfCut) / sr);
    let hz = 0;
    for (let i = 0; i < n; i++) {
      const v = out[i] ?? 0;
      hz = v * (1 - hpCoef) + hz * hpCoef;
      out[i] = v - hz;
    }
    dcBlock(out);
  }

  // Normalise by L2 norm across both channels so convolution gain is roughly
  // unity regardless of IR length — otherwise the courtyard, being longest,
  // would simply be loudest. `ConvolverNode.normalize` is switched off in the
  // engine so that this is the only normalisation in play.
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

/**
 * The four spaces this game happens in.
 *
 * `stoneCourtyard` is Krumlov: rendered plaster and stone, five hard surfaces
 * within 15 m, and it must read as *distinctly* longer and brighter than the
 * forest. `denseSpruce` is the opposite extreme — a thicket is nearly anechoic,
 * short and very dark, and the absence of a tail is what sells it.
 */
export const IR_PRESETS: Readonly<Record<ReverbId, IrSpec>> = {
  openForest: {
    seconds: 1.1,
    predelay: 0.012,
    hfStart: 4200,
    hfEnd: 850,
    lfCut: 130,
    density: 0.22,
    early: [
      [0.009, 0.3],
      [0.021, 0.24],
      [0.038, 0.19],
      [0.061, 0.14],
      [0.094, 0.1],
      [0.142, 0.07],
    ],
    seed: 1201,
  },
  denseSpruce: {
    seconds: 0.55,
    predelay: 0.005,
    hfStart: 2400,
    hfEnd: 420,
    lfCut: 170,
    density: 0.5,
    early: [
      [0.004, 0.2],
      [0.011, 0.14],
      [0.019, 0.09],
    ],
    seed: 1202,
  },
  stoneCourtyard: {
    seconds: 2.55,
    predelay: 0.019,
    hfStart: 11000,
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
      [0.157, 0.17],
    ],
    seed: 1203,
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
      [0.131, 0.11],
    ],
    seed: 1204,
  },
};

// ---------------------------------------------------------------------------
// Karplus-Strong
// ---------------------------------------------------------------------------

export interface PluckSpec {
  freq: number;
  seconds: number;
  /** 0..1 — loop lowpass amount. Higher = the high partials die sooner. */
  damping: number;
  /** 0..1 — how bright the initial excitation burst is. */
  brightness: number;
  /** Per-sample loop gain trim; below 1 shortens the whole decay. */
  sustain: number;
  seed: number;
}

/**
 * Extended Karplus-Strong, rendered offline into a `Float32Array`.
 *
 * Rendered rather than built as a live `DelayNode` feedback loop on purpose:
 * a Web Audio graph cycle carries a mandatory 128-sample latency, which puts a
 * hard ceiling of ~sampleRate/128 on the pitch and detunes everything below it.
 * Offline there is no such constraint and the tuning is exact.
 */
export function renderPluck(sampleRate: number, spec: PluckSpec): Float32Array {
  const n = Math.max(1, Math.round(spec.seconds * sampleRate));
  const out = new Float32Array(n);
  const rng = makeRng(spec.seed);

  const period = Math.max(2, Math.round(sampleRate / spec.freq));
  const line = new Float32Array(period);

  // Excitation: noise, lowpassed to taste. A dull pick sounds like a fingertip,
  // a bright one like a plectrum.
  let e = 0;
  const eCoef = Math.exp((-2 * Math.PI * (400 + 6000 * spec.brightness)) / sampleRate);
  for (let i = 0; i < period; i++) {
    e = (rng() * 2 - 1) * (1 - eCoef) + e * eCoef;
    line[i] = e;
  }
  // Remove DC from the excitation, otherwise the string starts with a thump.
  let mean = 0;
  for (let i = 0; i < period; i++) mean += line[i] ?? 0;
  mean /= period;
  for (let i = 0; i < period; i++) line[i] = (line[i] ?? 0) - mean;

  const a = 0.5 + 0.48 * (1 - spec.damping); // loop lowpass mix
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

  // Gentle release so the buffer never ends on a discontinuity.
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

// ---------------------------------------------------------------------------
// Modal synthesis
// ---------------------------------------------------------------------------

export interface Partial {
  /** Frequency as a ratio of `f0`. Inharmonic ratios are the whole point. */
  ratio: number;
  gain: number;
  /** -60 dB time for this partial, seconds. Low partials ring longest. */
  decay: number;
  /** Optional beating: a second, slightly detuned copy. Bells always beat. */
  beat?: number;
}

/**
 * Additive modal synthesis, rendered offline into a `Float32Array`.
 *
 * Used for the punch beep, the cowbells and the monastery bells. A struck body
 * is a bank of decaying sinusoids at inharmonic frequencies; that is the whole
 * model, and it is why a bell rendered this way sounds like a bell and a
 * detuned sawtooth never does.
 */
export function renderModal(
  sampleRate: number,
  f0: number,
  partials: readonly Partial[],
  seconds: number,
  opts: { strikeNoise?: number; strikeMs?: number; seed?: number } = {},
): Float32Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rng = makeRng(opts.seed ?? 4242);

  for (const p of partials) {
    const f = f0 * p.ratio;
    if (f >= sampleRate * 0.48) continue;
    const voices = p.beat ? [f, f * (1 + p.beat)] : [f];
    for (const fv of voices) {
      const w = (2 * Math.PI * fv) / sampleRate;
      // -60 dB after p.decay seconds
      const dec = Math.exp((-6.9078 / p.decay) * (1 / sampleRate));
      const phase0 = rng() * Math.PI * 2;
      let amp = (p.gain / voices.length) * 0.5;
      // Recurrence oscillator: two multiplies per sample instead of a sin().
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

  // The strike itself: a very short broadband transient. Without it a modal
  // body sounds switched on rather than hit.
  const strikeMs = opts.strikeMs ?? 3;
  const sn = Math.round((strikeMs / 1000) * sampleRate);
  const level = opts.strikeNoise ?? 0;
  if (level > 0) {
    let lp = 0;
    for (let i = 0; i < sn && i < n; i++) {
      lp = (rng() * 2 - 1) * 0.4 + lp * 0.6;
      const env = 1 - i / sn;
      out[i] = (out[i] ?? 0) + lp * level * env * env;
    }
  }

  // Attack ramp — 0.5 ms is inaudible as an attack but removes the step.
  const at = Math.max(1, Math.round(0.0005 * sampleRate));
  for (let i = 0; i < at && i < n; i++) out[i] = (out[i] ?? 0) * (i / at);
  // Release ramp for the same reason at the other end.
  const rel = Math.min(n, Math.round(0.02 * sampleRate));
  for (let i = 0; i < rel; i++) {
    const j = n - rel + i;
    out[j] = (out[j] ?? 0) * (1 - i / rel);
  }
  dcBlock(out);
  return out;
}

/** Wrap a rendered `Float32Array` as a mono `AudioBuffer`. */
export function toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}

/** Peak-normalise a rendered array to a target, never above it. */
export function normalisePeak(data: Float32Array, target: number): void {
  const p = peakOf(data);
  if (p > 1e-9) scaleBy(data, target / p);
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface Adsr {
  /** Attack, seconds. */
  a: number;
  /** Decay, seconds. */
  d: number;
  /** Sustain level, 0..1 relative to peak. */
  s: number;
  /** Release, seconds. */
  r: number;
}

/**
 * Schedule a full ADSR on a param and return the time it finishes.
 *
 * Uses `setTargetAtTime` for the exponential segments — the natural shape for
 * anything struck or breathed — and closes with an explicit `setValueAtTime(0)`
 * because `setTargetAtTime` is asymptotic and would otherwise leave the param
 * pinned just above zero forever.
 */
export function applyAdsr(
  param: AudioParam,
  when: number,
  env: Adsr,
  peak: number,
  holdS: number,
): number {
  const dTc = Math.max(1e-4, env.d / 3);
  const rTc = Math.max(1e-4, env.r / 3);
  param.cancelScheduledValues(when);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + env.a);
  param.setTargetAtTime(peak * env.s, when + env.a, dTc);
  const rel = when + env.a + holdS;
  param.setTargetAtTime(0, rel, rTc);
  const end = rel + env.r * 1.4;
  param.setValueAtTime(0, end);
  return end;
}

/**
 * Percussive envelope: linear attack, exponential decay to silence. This is the
 * shape of every footfall, every cowbell, every punch beep in the system.
 * Returns the time the envelope reaches zero.
 */
export function percussive(
  param: AudioParam,
  when: number,
  peak: number,
  attackS: number,
  decayS: number,
): number {
  const tc = Math.max(1e-4, decayS / 4.6); // −40 dB at decayS
  param.cancelScheduledValues(when);
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, when + attackS);
  param.setTargetAtTime(0, when + attackS, tc);
  const end = when + attackS + decayS * 1.25;
  param.setValueAtTime(0, end);
  return end;
}

// ---------------------------------------------------------------------------
// Voice pool
// ---------------------------------------------------------------------------

/**
 * One pre-wired one-shot voice:
 *
 *   source → highpass → peaking → lowpass → amp → panner ─┬─→ dry bus
 *                                                          └─→ reverb send
 *
 * Highpass and lowpass bracket the band; the peaking filter supplies the one
 * resonance that makes a material sound like that material (the 3.4 kHz ring of
 * a cobble, the 210 Hz body of wet ground). All of it is exposed so callers can
 * automate — the marsh suck is a lowpass sweep on a running voice.
 */
export class Voice {
  readonly hp: BiquadFilterNode;
  readonly peak: BiquadFilterNode;
  readonly lp: BiquadFilterNode;
  readonly amp: GainNode;
  readonly pan: StereoPannerNode;
  readonly send: GainNode;

  /** Timeline instant this voice is free again. Drives pool stealing. */
  busyUntil = 0;

  private src: AudioBufferSourceNode | null = null;

  constructor(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode | null) {
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.peak = ctx.createBiquadFilter();
    this.peak.type = 'peaking';
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
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
  reset(when: number): void {
    this.hp.frequency.cancelScheduledValues(when);
    this.hp.Q.cancelScheduledValues(when);
    this.peak.frequency.cancelScheduledValues(when);
    this.peak.gain.cancelScheduledValues(when);
    this.peak.Q.cancelScheduledValues(when);
    this.lp.frequency.cancelScheduledValues(when);
    this.lp.Q.cancelScheduledValues(when);
    this.hp.frequency.setValueAtTime(20, when);
    this.hp.Q.setValueAtTime(0.707, when);
    this.peak.frequency.setValueAtTime(1000, when);
    this.peak.gain.setValueAtTime(0, when);
    this.peak.Q.setValueAtTime(1, when);
    this.lp.frequency.setValueAtTime(20000, when);
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
  start(
    ctx: BaseAudioContext,
    buffer: AudioBuffer,
    when: number,
    offset: number,
    duration: number,
    rate: number,
  ): void {
    this.src?.disconnect();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.hp);
    const safeOffset = offset % Math.max(0.001, buffer.duration - duration * rate - 0.01);
    src.start(when, Math.max(0, safeOffset), duration * rate);
    src.stop(when + duration + 0.05);
    this.src = src;
    this.busyUntil = when + duration + 0.05;
  }
}

export class VoicePool {
  private readonly voices: Voice[] = [];

  constructor(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode | null, size: number) {
    for (let i = 0; i < size; i++) this.voices.push(new Voice(ctx, dry, wet));
  }

  /**
   * Take the voice that has been free longest; if none is free, steal the one
   * that started earliest. Fixed size, no growth, no allocation.
   */
  acquire(when: number): Voice {
    let best = this.voices[0] as Voice;
    for (let i = 1; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v && v.busyUntil < best.busyUntil) best = v;
    }
    best.reset(when);
    return best;
  }

  get size(): number {
    return this.voices.length;
  }
}
