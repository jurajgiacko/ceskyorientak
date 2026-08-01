/**
 * The audio graph and its lifecycle.
 *
 * Two objects live here, deliberately separated:
 *
 *  - `AudioGraph` is the topology — master chain, five sub-buses, shared
 *    convolution reverb. It is built on *any* `BaseAudioContext`, which is what
 *    lets `tools/audio/render.mjs` construct the identical graph inside an
 *    `OfflineAudioContext` and measure exactly what the game will produce.
 *
 *  - `AudioEngine` is the browser lifecycle around it: lazy context creation on
 *    the first user gesture (every browser blocks autoplay, and iOS Safari is
 *    the strictest), suspend/resume on tab visibility, and a hard mute.
 *
 * Signal flow:
 *
 *   voices ─┬─→ bus.input → bus.duck → bus.comp ─┐
 *           └─→ bus.aux ───────────────→ reverbSend → convA/convB → return ─┤
 *                                                                           ▼
 *          preMaster → width (M/S) → tone (LPF) → master → mute → limiter → out
 *
 * `bus.duck`, `width` and `tone` are owned by `mixer.ts`; nothing else touches
 * them. `bus.input` is the only thing `setBusGain` moves, so a game settings
 * slider and a map-reading duck can never fight over the same param.
 */

import { IR_PRESETS, renderImpulseResponse, type ReverbId } from './synth';

export type BusName = 'footsteps' | 'breath' | 'ambience' | 'ui' | 'music';

export const BUS_NAMES: readonly BusName[] = [
  'footsteps',
  'breath',
  'ambience',
  'ui',
  'music',
] as const;

export type EnvironmentId = 'forest' | 'arena' | 'town';

interface CompSpec {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/**
 * Per-bus compression. These are mix decisions, not safety limiting:
 * footsteps get glued so a sprint does not machine-gun, breath is held forward
 * so it never disappears under the forest, and `ui` is squeezed hard so the
 * punch beep cuts through whatever else is happening.
 */
const BUS_COMP: Readonly<Record<BusName, CompSpec>> = {
  footsteps: { threshold: -18, knee: 12, ratio: 3, attack: 0.004, release: 0.15 },
  breath: { threshold: -22, knee: 10, ratio: 2.5, attack: 0.01, release: 0.25 },
  ambience: { threshold: -24, knee: 14, ratio: 2, attack: 0.05, release: 0.4 },
  ui: { threshold: -12, knee: 4, ratio: 4, attack: 0.002, release: 0.08 },
  music: { threshold: -26, knee: 14, ratio: 2, attack: 0.02, release: 0.5 },
};

/** Default bus trims, in linear gain. Tuned by ear against the forest bed. */
const BUS_DEFAULT_GAIN: Readonly<Record<BusName, number>> = {
  footsteps: 0.85,
  breath: 0.8,
  ambience: 0.7,
  ui: 0.9,
  music: 0.45,
};

export interface Bus {
  /** Voices connect their dry output here. `setBusGain` moves this. */
  readonly input: GainNode;
  /** Owned by `mixer.ts`. Never set from anywhere else. */
  readonly duck: GainNode;
  readonly comp: DynamicsCompressorNode;
  /** Voices connect their reverb send here; feeds the shared convolvers. */
  readonly aux: GainNode;
}

export class AudioGraph {
  readonly ctx: BaseAudioContext;
  readonly buses: Readonly<Record<BusName, Bus>>;

  /** Sum of every bus, before the master processing chain. */
  readonly preMaster: GainNode;
  /** Side-signal gain of the M/S width network. 1 = normal, 0 = mono. */
  readonly width: GainNode;
  /** Master tone. Dropping its cutoff is how the mix "narrows" spectrally. */
  readonly tone: BiquadFilterNode;
  readonly master: GainNode;
  readonly mute: GainNode;
  readonly limiter: DynamicsCompressorNode;
  /** Final safety net. Guarantees |out| ≤ 0.97 no matter what. */
  readonly softClip: WaveShaperNode;
  readonly reverbSend: GainNode;
  readonly reverbReturn: GainNode;

  private readonly convA: ConvolverNode;
  private readonly convB: ConvolverNode;
  private readonly gainA: GainNode;
  private readonly gainB: GainNode;
  private readonly irs: Map<ReverbId, AudioBuffer> = new Map();
  private activeIsA = true;
  private currentReverb: ReverbId | null = null;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;

    // --- master chain, built back-to-front ---------------------------------
    // `DynamicsCompressorNode` is a compressor, not a limiter: its detector is
    // smoothed and its minimum attack is ~3 ms, so isolated transients walk
    // straight through it. Measured, that let the arena mix reach +2.9 dBFS.
    // So the compressor does the musical work and a waveshaper backstops it.
    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = makeSoftClipCurve();
    // 'none': the resampling filters in 2x/4x mode can overshoot the curve's
    // endpoint by a few percent, and the whole point of this node is a bound
    // that holds absolutely. The knee is gentle enough that the aliasing it
    // trades away is negligible.
    this.softClip.oversample = 'none';
    this.softClip.connect(destination);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.softClip);

    this.mute = ctx.createGain();
    this.mute.gain.value = 1;
    this.mute.connect(this.limiter);

    this.master = ctx.createGain();
    // Headroom, chosen from the measured worst case (arena, everything at
    // once, punching): it puts that mix at about −18 dBFS RMS and leaves the
    // limiter tidying peaks rather than rescuing them.
    this.master.gain.value = 0.62;
    this.master.connect(this.mute);

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 20000;
    this.tone.Q.value = 0.5;
    this.tone.connect(this.master);

    // --- mid/side width network -------------------------------------------
    // M = (L+R)/2, S = (L−R)/2, then L' = M + wS, R' = M − wS.
    // Collapsing S is a far more convincing "the world recedes" than turning
    // things down is, and it costs ten nodes built once.
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

    // --- shared convolution reverb, double-buffered ------------------------
    // Two convolvers so an environment change crossfades instead of dropping a
    // tail on the floor when `.buffer` is reassigned.
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 1;
    this.reverbReturn.connect(this.preMaster);

    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    // Level is set by the L2 normalisation in `renderImpulseResponse`, so the
    // node's own equal-power normalisation would only fight it.
    this.convA.normalize = false;
    this.convB.normalize = false;
    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();
    this.gainA.gain.value = 1;
    this.gainB.gain.value = 0;
    this.reverbSend.connect(this.convA).connect(this.gainA).connect(this.reverbReturn);
    this.reverbSend.connect(this.convB).connect(this.gainB).connect(this.reverbReturn);

    // --- buses -------------------------------------------------------------
    const buses = {} as Record<BusName, Bus>;
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
  buildReverbs(): void {
    if (this.irs.size > 0) return;
    for (const id of Object.keys(IR_PRESETS) as ReverbId[]) {
      this.irs.set(id, renderImpulseResponse(this.ctx, IR_PRESETS[id]));
    }
    this.setReverb('openForest', 0);
  }

  /**
   * Crossfade to another space over `rampS`. `when` defaults to now; the
   * offline renderer passes an explicit instant, because an
   * `OfflineAudioContext` sits at `currentTime === 0` until it renders.
   */
  setReverb(id: ReverbId, rampS = 1.5, when?: number): void {
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
  setBusGain(bus: BusName, value: number, rampS = 0.05): void {
    const g = this.buses[bus].input.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (rampS <= 0) g.setValueAtTime(value, t);
    else g.linearRampToValueAtTime(value, t + rampS);
  }

  getBusGain(bus: BusName): number {
    return this.buses[bus].input.gain.value;
  }
}

export interface AudioEngineOptions {
  /**
   * Inject a context instead of creating one. The offline renderer uses this;
   * the game never does.
   */
  context?: BaseAudioContext;
  /** Element to listen on for the unlock gesture. Defaults to `window`. */
  gestureTarget?: EventTarget;
  /** Called once, immediately after the context and graph exist. */
  onReady?: (graph: AudioGraph) => void;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Lifecycle owner. Construct it at boot; it does nothing and costs nothing
 * until a real user gesture arrives.
 */
export class AudioEngine {
  private ctxInternal: BaseAudioContext | null = null;
  private graphInternal: AudioGraph | null = null;
  private readonly opts: AudioEngineOptions;
  private muted = false;
  private suspendedByVisibility = false;
  private listening = false;
  private disposed = false;

  private readonly onGesture = (): void => {
    void this.unlock();
  };

  private readonly onVisibility = (): void => {
    const ctx = this.ctxInternal;
    if (!ctx || !isRealtime(ctx)) return;
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        this.suspendedByVisibility = true;
        void ctx.suspend();
      }
    } else if (this.suspendedByVisibility) {
      this.suspendedByVisibility = false;
      if (!this.muted) void ctx.resume();
    }
  };

  constructor(opts: AudioEngineOptions = {}) {
    this.opts = opts;
    if (opts.context) {
      this.attach(opts.context);
    } else {
      this.listen();
    }
  }

  get ctx(): BaseAudioContext | null {
    return this.ctxInternal;
  }

  get graph(): AudioGraph | null {
    return this.graphInternal;
  }

  get ready(): boolean {
    return this.graphInternal !== null;
  }

  /** Context timeline position, or 0 before the context exists. */
  get now(): number {
    return this.ctxInternal?.currentTime ?? 0;
  }

  get isMuted(): boolean {
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
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.ctxInternal) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return false;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.attach(ctx);
    }
    const ctx = this.ctxInternal;
    if (!ctx || !isRealtime(ctx)) return false;
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      return false;
    }
    if (ctx.state === 'running') {
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
  setMuted(muted: boolean): void {
    this.muted = muted;
    const g = this.graphInternal?.mute.gain;
    const ctx = this.ctxInternal;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(muted ? 0 : 1, t + 0.04);
  }

  setMasterGain(value: number, rampS = 0.1): void {
    const g = this.graphInternal?.master.gain;
    const ctx = this.ctxInternal;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(value, t + rampS);
  }

  setBusGain(bus: BusName, value: number, rampS = 0.05): void {
    this.graphInternal?.setBusGain(bus, value, rampS);
  }

  getBusGain(bus: BusName): number {
    return this.graphInternal?.getBusGain(bus) ?? 0;
  }

  dispose(): void {
    this.disposed = true;
    this.stopListening();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    const ctx = this.ctxInternal;
    if (ctx && isRealtime(ctx)) void ctx.close();
    this.ctxInternal = null;
    this.graphInternal = null;
  }

  private attach(ctx: BaseAudioContext): void {
    this.ctxInternal = ctx;
    const graph = new AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    this.graphInternal = graph;
    if (typeof document !== 'undefined' && isRealtime(ctx)) {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.opts.onReady?.(graph);
  }

  private listen(): void {
    if (this.listening) return;
    const target = this.opts.gestureTarget ?? (typeof window !== 'undefined' ? window : null);
    if (!target) return;
    this.listening = true;
    for (const ev of GESTURES) {
      target.addEventListener(ev, this.onGesture, { passive: true, capture: true });
    }
  }

  private stopListening(): void {
    if (!this.listening) return;
    const target = this.opts.gestureTarget ?? (typeof window !== 'undefined' ? window : null);
    this.listening = false;
    if (!target) return;
    for (const ev of GESTURES) {
      target.removeEventListener(ev, this.onGesture, { capture: true });
    }
  }
}

const GESTURES: readonly string[] = ['pointerdown', 'touchend', 'mousedown', 'keydown'];

/**
 * Soft-clip transfer curve.
 *
 * A `WaveShaperNode` maps input −1…+1 across the whole curve array and clamps
 * anything outside that to the endpoints, so the curve must be defined on
 * exactly that domain. (Defining it over −4…+4, which is the intuitive thing to
 * do and which this code did first, silently applies about 11 dB of gain to
 * everything quiet. It measured as louder peaks, not softer ones.)
 *
 * Identity below 0.7 (−3.1 dBFS) — bit-transparent on the overwhelming majority
 * of samples — then a `tanh` knee. Because input is clamped at ±1, the output
 * can never exceed the curve's endpoint, which is 0.908. That is the hard
 * guarantee behind the "peak < 0.99" line in the verification report.
 */
function makeSoftClipCurve() {
  const n = 2049;
  const knee = 0.7;
  const span = 0.25;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

function isRealtime(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof (ctx as AudioContext).resume === 'function' && 'baseLatency' in ctx;
}
