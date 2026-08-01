/**
 * The world.
 *
 * Layered, procedural and continuously varying. The hard requirement is that it
 * must never present a detectable loop over a 90-minute Long distance, and the
 * three defences against that are, in order of how much work they do:
 *
 *  1. **Drifting playback rates.** Every looping noise source has its
 *     `playbackRate` on a slow seeded random walk between about 0.9 and 1.1.
 *     The buffer still loops, but its *period* is never the same twice, which
 *     destroys the autocorrelation peak that a fixed loop would produce. This
 *     is the trick that actually makes the 60 s autocorrelation test pass.
 *  2. **Random-walk modulation.** Gust strength, filter cutoffs, water band
 *     balance and crowd density all move by `setTargetAtTime` toward new seeded
 *     targets every few seconds. A random walk has no period at all, unlike a
 *     bank of LFOs, which is merely periodic with a long period.
 *  3. **Poisson events.** Birds, cowbell shakes, cheers, PA phrases and bell
 *     peals are scheduled from exponentially-distributed gaps.
 *
 * Layers: wind (two bands), arena PA, crowd, cowbells, river, monastery bells,
 * birds. `setEnvironment` crossfades a level vector and the convolution space
 * together, so forest → arena is one gesture and not eight.
 */

import type { EnvironmentId } from './engine';
import {
  clamp,
  jitter,
  makeRng,
  NoiseBank,
  percussive,
  rand,
  renderModal,
  toBuffer,
  VoicePool,
  type ReverbId,
  type Rng,
} from './synth';

type LayerId = 'windLow' | 'canopy' | 'pa' | 'crowd' | 'river' | 'birds' | 'cowbell' | 'bells';

interface EnvSpec {
  levels: Readonly<Record<LayerId, number>>;
  reverb: ReverbId;
  /** Mean seconds between events. */
  birdGap: number;
  cowbellGap: number;
  cheerGap: number;
  bellGap: number;
  /** Fraction of the time the PA is actually talking. */
  paDensity: number;
}

/**
 * Note the arena bleeding into the forest at 0.06/0.05: you hear Martínkov from
 * 800 m out in the trees, and it gets louder as you come back. Cutting it to
 * zero would be tidier and would sound wrong.
 */
const ENVIRONMENTS: Readonly<Record<EnvironmentId, EnvSpec>> = {
  forest: {
    levels: {
      windLow: 1,
      canopy: 1,
      pa: 0.05,
      crowd: 0.06,
      river: 0,
      birds: 1,
      cowbell: 0.1,
      bells: 0,
    },
    reverb: 'openForest',
    birdGap: 16,
    cowbellGap: 70,
    cheerGap: 150,
    bellGap: 0,
    paDensity: 0.25,
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
      bells: 0,
    },
    reverb: 'openArena',
    birdGap: 90,
    cowbellGap: 7,
    cheerGap: 26,
    bellGap: 0,
    paDensity: 0.62,
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
      bells: 1,
    },
    reverb: 'stoneCourtyard',
    birdGap: 40,
    cowbellGap: 55,
    cheerGap: 120,
    bellGap: 210,
    paDensity: 0.18,
  },
};

/** A looping noise bed with its own band, level and drifting rate. */
class NoiseLayer {
  readonly gain: GainNode;
  readonly hp: BiquadFilterNode;
  readonly bp: BiquadFilterNode;
  readonly lp: BiquadFilterNode;
  private src: AudioBufferSourceNode | null = null;
  private readonly buffer: AudioBuffer;
  private readonly ctx: BaseAudioContext;

  constructor(
    ctx: BaseAudioContext,
    buffer: AudioBuffer,
    dest: AudioNode,
    opts: { hp: number; bp: number; bpQ: number; lp: number; pan: number },
  ) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = opts.hp;
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'peaking';
    this.bp.frequency.value = opts.bp;
    this.bp.Q.value = opts.bpQ;
    this.bp.gain.value = 5;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = opts.lp;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = opts.pan;
    this.hp.connect(this.bp).connect(this.lp).connect(this.gain).connect(pan).connect(dest);
  }

  start(when: number, offset: number, rate: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(this.hp);
    src.start(when, offset % this.buffer.duration);
    this.src = src;
  }

  /** Nudge the loop period. The reason no two minutes are ever the same. */
  driftRate(when: number, target: number, tc: number): void {
    this.src?.playbackRate.setTargetAtTime(target, when, tc);
  }

  stop(when: number): void {
    this.src?.stop(when);
    this.src = null;
  }
}

export interface AmbienceOptions {
  seed?: number;
  /** Skip the bird and bell buffer rendering on low-tier devices. */
  lean?: boolean;
}

export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly wet: AudioNode;
  private readonly bank: NoiseBank;

  // One pool per event layer, each wired to that layer's gain — so the
  // environment crossfade moves cowbells and birds along with everything else
  // instead of leaving them stuck at full level in the wrong place.
  private readonly poolCowbell: VoicePool;
  private readonly poolBird: VoicePool;
  private readonly poolBell: VoicePool;
  private readonly poolCrowd: VoicePool;

  private readonly layers: Record<LayerId, GainNode>;
  private readonly windLow: NoiseLayer;
  private readonly windGust: NoiseLayer;
  private readonly canopy: NoiseLayer;
  private readonly paChain: { src: NoiseLayer; formant: BiquadFilterNode; env: GainNode };
  private readonly crowd: NoiseLayer;
  private readonly riverBody: NoiseLayer;
  private readonly riverSpray: NoiseLayer;
  private readonly riverLow: NoiseLayer;

  private readonly cowbells: AudioBuffer[] = [];
  private readonly bells: AudioBuffer[] = [];

  private env: EnvSpec = ENVIRONMENTS.forest;
  private started = false;
  private windIntensity = 0.5;

  // Next-event timeline instants. All Poisson-scheduled.
  private tDrift = 0;
  private tBird = 0;
  private tCowbell = 0;
  private tCheer = 0;
  private tBell = 0;
  private paUntil = 0;
  private tPa = 0;

  constructor(
    ctx: BaseAudioContext,
    bank: NoiseBank,
    dry: AudioNode,
    wet: AudioNode,
    opts: AmbienceOptions = {},
  ) {
    this.ctx = ctx;
    this.bank = bank;
    this.wet = wet;
    this.rng = makeRng(opts.seed ?? 0xb0d);

    const mk = (): GainNode => {
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
      bells: mk(),
    };
    this.poolCowbell = new VoicePool(ctx, this.layers.cowbell, wet, 8);
    this.poolBird = new VoicePool(ctx, this.layers.birds, wet, 4);
    this.poolBell = new VoicePool(ctx, this.layers.bells, wet, 3);
    this.poolCrowd = new VoicePool(ctx, this.layers.crowd, wet, 6);

    // --- wind -------------------------------------------------------------
    // Two bands, because wind in a spruce stand is two sounds: a body you feel
    // in the low mids, and the canopy hiss thirty metres above your head.
    this.windLow = new NoiseLayer(ctx, bank.brown, this.layers.windLow, {
      hp: 45,
      bp: 190,
      bpQ: 0.7,
      lp: 620,
      pan: -0.15,
    });
    this.windGust = new NoiseLayer(ctx, bank.pink, this.layers.windLow, {
      hp: 120,
      bp: 480,
      bpQ: 0.8,
      lp: 1800,
      pan: 0.2,
    });
    this.canopy = new NoiseLayer(ctx, bank.white, this.layers.canopy, {
      hp: 1400,
      bp: 4200,
      bpQ: 0.6,
      lp: 11000,
      pan: 0.05,
    });

    // --- distant PA -------------------------------------------------------
    // Band-limited to a horn's passband, with one moving formant. It has to be
    // unmistakably a human voice and unmistakably not any particular word: the
    // moment a player thinks they heard a name, the illusion is doing the
    // opposite of its job.
    const paEnv = ctx.createGain();
    paEnv.gain.value = 0;
    paEnv.connect(this.layers.pa);
    // Distance: the PA is mostly reverb by the time it reaches the forest.
    const paSend = ctx.createGain();
    paSend.gain.value = 0.55;
    paEnv.connect(paSend).connect(wet);
    const paFormant = ctx.createBiquadFilter();
    paFormant.type = 'peaking';
    paFormant.frequency.value = 900;
    paFormant.Q.value = 3.5;
    paFormant.gain.value = 11;
    paFormant.connect(paEnv);
    const paSrc = new NoiseLayer(ctx, bank.pink, paFormant, {
      hp: 420,
      bp: 1850,
      bpQ: 1.2,
      lp: 2900,
      pan: 0,
    });
    paSrc.gain.gain.value = 1;
    this.paChain = { src: paSrc, formant: paFormant, env: paEnv };

    // --- crowd ------------------------------------------------------------
    this.crowd = new NoiseLayer(ctx, bank.pink, this.layers.crowd, {
      hp: 380,
      bp: 1100,
      bpQ: 0.9,
      lp: 3400,
      pan: 0,
    });
    this.crowd.gain.gain.value = 0.35;

    // --- the Vltava -------------------------------------------------------
    // Three bands with independent walks. A shallow rocky river is not one
    // hiss: it is a low body you feel, a mid churn, and spray on top, and the
    // balance between them shifts constantly as the flow moves.
    this.riverLow = new NoiseLayer(ctx, bank.brown, this.layers.river, {
      hp: 60,
      bp: 150,
      bpQ: 0.8,
      lp: 420,
      pan: -0.1,
    });
    this.riverBody = new NoiseLayer(ctx, bank.pink, this.layers.river, {
      hp: 320,
      bp: 900,
      bpQ: 0.7,
      lp: 2600,
      pan: 0.12,
    });
    this.riverSpray = new NoiseLayer(ctx, bank.white, this.layers.river, {
      hp: 2600,
      bp: 5200,
      bpQ: 0.5,
      lp: 12000,
      pan: -0.05,
    });
    this.riverLow.gain.gain.value = 0.5;
    this.riverBody.gain.gain.value = 0.5;
    this.riverSpray.gain.gain.value = 0.3;

    // --- struck metal -----------------------------------------------------
    if (!opts.lean) this.renderStruck(opts.seed ?? 0xb0d);
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
  private renderStruck(seed: number): void {
    const sr = this.ctx.sampleRate;
    for (let i = 0; i < 3; i++) {
      const f0 = 470 + i * 62;
      const data = renderModal(
        sr,
        f0,
        [
          { ratio: 1, gain: 0.7, decay: 0.28, beat: 0.004 },
          { ratio: 1.51, gain: 1, decay: 0.42, beat: 0.005 },
          { ratio: 2.13, gain: 0.62, decay: 0.3 },
          { ratio: 2.87, gain: 0.4, decay: 0.19 },
          { ratio: 3.71, gain: 0.26, decay: 0.12 },
          { ratio: 5.42, gain: 0.14, decay: 0.07 },
        ],
        0.75,
        { strikeNoise: 0.5, strikeMs: 2, seed: seed + 40 + i },
      );
      this.cowbells.push(toBuffer(this.ctx, data));
    }
    // Two bells a minor third apart, as a small monastery pair would be cast.
    for (let i = 0; i < 2; i++) {
      const prime = i === 0 ? 392 : 466.16;
      const data = renderModal(
        sr,
        prime,
        [
          { ratio: 0.5, gain: 0.85, decay: 7.5, beat: 0.0016 },
          { ratio: 1.0, gain: 1.0, decay: 5.2, beat: 0.002 },
          { ratio: 1.19, gain: 0.72, decay: 4.4, beat: 0.0025 },
          { ratio: 1.5, gain: 0.55, decay: 3.4, beat: 0.003 },
          { ratio: 2.0, gain: 0.68, decay: 2.6, beat: 0.0035 },
          { ratio: 2.5, gain: 0.3, decay: 1.6 },
          { ratio: 2.67, gain: 0.24, decay: 1.4 },
          { ratio: 3.0, gain: 0.26, decay: 1.1 },
          { ratio: 4.0, gain: 0.19, decay: 0.75 },
          { ratio: 5.33, gain: 0.11, decay: 0.45 },
          { ratio: 6.8, gain: 0.07, decay: 0.3 },
        ],
        4.6,
        { strikeNoise: 0.28, strikeMs: 5, seed: seed + 60 + i },
      );
      this.bells.push(toBuffer(this.ctx, data));
    }
  }

  start(when: number): void {
    if (this.started) return;
    this.started = true;
    const r = this.rng;
    // Mutually unrelated start offsets and rates: nothing begins in phase.
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
    this.applyLevels(when, 0.001);
  }

  stop(when: number): void {
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
      this.riverSpray,
    ]) {
      l.stop(when);
    }
  }

  /** 0..1 — how hard it is blowing. Ramps; safe to call every frame. */
  setWind(intensity: number, when: number, rampS = 3): void {
    this.windIntensity = clamp(intensity, 0, 1);
    const tc = Math.max(0.01, rampS / 3);
    this.layers.windLow.gain.setTargetAtTime(
      this.env.levels.windLow * (0.1 + 0.55 * this.windIntensity),
      when,
      tc,
    );
    this.layers.canopy.gain.setTargetAtTime(
      this.env.levels.canopy * (0.03 + 0.3 * this.windIntensity * this.windIntensity),
      when,
      tc,
    );
  }

  setEnvironment(id: EnvironmentId, when: number, rampS = 2.5): void {
    this.env = ENVIRONMENTS[id];
    this.applyLevels(when, rampS);
  }

  /** The active environment's reverb space, for the engine to crossfade to. */
  get reverb(): ReverbId {
    return this.env.reverb;
  }

  private applyLevels(when: number, rampS: number): void {
    const tc = Math.max(0.001, rampS / 3);
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
  update(now: number, _dt: number): void {
    if (!this.started) return;
    const r = this.rng;

    // --- random walks ------------------------------------------------------
    if (now >= this.tDrift) {
      const t = now + 0.01;
      // Loop-period drift. This is the anti-loop mechanism.
      this.windLow.driftRate(t, rand(r, 0.82, 0.95), 2.5);
      this.windGust.driftRate(t, rand(r, 1.04, 1.2), 2.5);
      this.canopy.driftRate(t, rand(r, 0.94, 1.12), 2.5);
      this.crowd.driftRate(t, rand(r, 0.98, 1.16), 3);
      this.riverBody.driftRate(t, rand(r, 1.0, 1.18), 3);
      this.riverSpray.driftRate(t, rand(r, 0.9, 1.06), 3);
      this.paChain.src.driftRate(t, rand(r, 0.88, 1.02), 3);

      // Gusts. Amplitude and brightness move together, as they do outdoors.
      const gust = rand(r, 0.25, 1) * (0.45 + 0.55 * this.windIntensity);
      this.windGust.gain.gain.setTargetAtTime(gust * 0.55, t, rand(r, 1.2, 3.4));
      this.windGust.lp.frequency.setTargetAtTime(rand(r, 900, 3000), t, rand(r, 1.5, 4));
      this.canopy.bp.frequency.setTargetAtTime(rand(r, 2800, 6200), t, rand(r, 2, 5));
      this.windLow.lp.frequency.setTargetAtTime(rand(r, 380, 900), t, rand(r, 2, 5));

      // River band balance.
      this.riverLow.gain.gain.setTargetAtTime(rand(r, 0.35, 0.62), t, rand(r, 2, 6));
      this.riverBody.gain.gain.setTargetAtTime(rand(r, 0.4, 0.66), t, rand(r, 2, 6));
      this.riverSpray.gain.gain.setTargetAtTime(rand(r, 0.18, 0.42), t, rand(r, 2, 6));

      // Crowd density.
      this.crowd.gain.gain.setTargetAtTime(rand(r, 0.24, 0.46), t, rand(r, 3, 8));

      this.tDrift = now + rand(r, 1.4, 3.2);
    }

    // --- PA phrases --------------------------------------------------------
    if (now >= this.tPa && this.env.levels.pa > 0.01) {
      this.speak(Math.max(now + 0.05, this.paUntil));
    }

    // --- Poisson events ----------------------------------------------------
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
  ringBells(when: number, strikes = 9): void {
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
  private speak(from: number): void {
    const r = this.rng;
    const g = this.paChain.env.gain;
    const density = this.env.paDensity;
    let t = from;
    const phrase = rand(r, 1.2, 3.6);
    const end = t + phrase;
    while (t < end) {
      const syl = rand(r, 0.07, 0.19);
      const level = rand(r, 0.22, 0.5) * (0.6 + 0.4 * density);
      // Vowel movement without words.
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
  private shake(from: number): void {
    const r = this.rng;
    const n = 5 + ((r() * 9) | 0);
    const pan = rand(r, -0.7, 0.7);
    const which = (r() * this.cowbells.length) | 0;
    const buf = this.cowbells[which] ?? this.cowbells[0];
    if (!buf) return;
    let t = from;
    for (let i = 0; i < n; i++) {
      const v = this.poolCowbell.acquire(t);
      v.hp.frequency.setValueAtTime(300, t);
      v.peak.frequency.setValueAtTime(rand(r, 900, 1500), t);
      v.peak.Q.setValueAtTime(1.1, t);
      v.peak.gain.setValueAtTime(3, t);
      v.lp.frequency.setValueAtTime(rand(r, 7000, 13000), t);
      v.pan.pan.setValueAtTime(pan + rand(r, -0.12, 0.12), t);
      v.send.gain.setValueAtTime(0.3, t);
      v.amp.gain.setValueAtTime(rand(r, 0.4, 1) * 0.55, t);
      v.amp.gain.setValueAtTime(0, t + 0.75);
      v.start(this.ctx, buf, t, 0, 0.7, jitter(r, 0.06));
      // Up-swing and down-swing are not evenly spaced. That asymmetry is the
      // difference between a hand and a sequencer.
      t += i % 2 === 0 ? rand(r, 0.12, 0.19) : rand(r, 0.19, 0.3);
    }
  }

  /** A crowd swell as a runner comes through the spectator control. */
  private cheer(when: number): void {
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
    // Claps scattered through the swell.
    const claps = 6 + ((r() * 14) | 0);
    for (let i = 0; i < claps; i++) {
      const t = when + rand(r, 0.1, rise + hold);
      const v = this.poolCrowd.acquire(t);
      v.hp.frequency.setValueAtTime(rand(r, 900, 1600), t);
      v.peak.frequency.setValueAtTime(rand(r, 1800, 3600), t);
      v.peak.Q.setValueAtTime(1.6, t);
      v.peak.gain.setValueAtTime(6, t);
      v.lp.frequency.setValueAtTime(rand(r, 6000, 11000), t);
      v.pan.pan.setValueAtTime(rand(r, -0.85, 0.85), t);
      v.send.gain.setValueAtTime(0.4, t);
      percussive(v.amp.gain, t, rand(r, 0.05, 0.16), 0.001, 0.03);
      const off = r() * (this.bank.white.duration - 0.1);
      v.start(this.ctx, this.bank.white, t, off, 0.05, 1);
    }
    // Bells come out at the same moment; that is what a spectator control is.
    if (this.cowbells.length > 0 && r() < 0.8) this.shake(when + rand(r, 0.1, 0.8));
  }

  /**
   * A peal. Two bells, alternating, with human unevenness in the swing and a
   * slow decay in strike force — the way a rope-rung pair actually sounds.
   */
  private peal(from: number, strikes = 0): void {
    const r = this.rng;
    const n = strikes > 0 ? strikes : 4 + ((r() * 8) | 0);
    let t = from;
    for (let i = 0; i < n; i++) {
      const buf = this.bells[i % this.bells.length] ?? this.bells[0];
      if (!buf) break;
      const v = this.poolBell.acquire(t);
      v.hp.frequency.setValueAtTime(90, t);
      v.peak.frequency.setValueAtTime(rand(r, 700, 1300), t);
      v.peak.Q.setValueAtTime(0.9, t);
      v.peak.gain.setValueAtTime(2.5, t);
      v.lp.frequency.setValueAtTime(rand(r, 6000, 10000), t);
      v.pan.pan.setValueAtTime(rand(r, -0.25, 0.25), t);
      v.send.gain.setValueAtTime(0.65, t);
      v.amp.gain.setValueAtTime(rand(r, 0.62, 0.95) * 0.5, t);
      v.amp.gain.setValueAtTime(0, t + 4.5);
      v.start(this.ctx, buf, t, 0, 4.4, jitter(r, 0.003));
      t += rand(r, 1.05, 1.35);
    }
  }

  /**
   * One bird. Six calls, chosen for a Czech August morning in a spruce stand —
   * which is a quiet place. The songbirds have finished breeding and stopped
   * singing; what is left is contact calls, alarm calls and raptors. A thrush
   * singing its heart out here in August would be as wrong as palm trees.
   */
  private bird(when: number): void {
    const r = this.rng;
    const pick = r();
    const pan = rand(r, -0.8, 0.8);
    const dist = rand(r, 0.25, 1);
    const send = 0.35 + 0.4 * (1 - dist);
    const out = this.layers.birds;

    if (pick < 0.22) {
      // Jay — the forest's burglar alarm, and the bird a runner actually
      // triggers. Harsh, noisy, two rasping syllables.
      const n = 1 + ((r() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const t = when + i * rand(r, 0.34, 0.52);
        const v = this.poolBird.acquire(t);
        v.hp.frequency.setValueAtTime(1100, t);
        const f = rand(r, 1900, 2600);
        v.peak.frequency.setValueAtTime(f, t);
        v.peak.frequency.linearRampToValueAtTime(f * 0.72, t + 0.4);
        v.peak.Q.setValueAtTime(3.2, t);
        v.peak.gain.setValueAtTime(14, t);
        v.lp.frequency.setValueAtTime(7000, t);
        v.pan.pan.setValueAtTime(pan, t);
        v.send.gain.setValueAtTime(send, t);
        const g = 0.34 * dist;
        v.amp.gain.setValueAtTime(0, t);
        v.amp.gain.linearRampToValueAtTime(g, t + 0.02);
        v.amp.gain.linearRampToValueAtTime(g * 0.75, t + 0.22);
        v.amp.gain.linearRampToValueAtTime(0, t + rand(r, 0.34, 0.46));
        v.start(this.ctx, this.bank.white, t, r() * 1.5, 0.5, 1);
      }
      return;
    }

    if (pick < 0.38) {
      // Buzzard, high and circling. A long descending mew with vibrato.
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
        dest: out,
      });
      return;
    }

    if (pick < 0.58) {
      // Great spotted woodpecker: a single hard "kik". Very short, very sharp.
      const n = 1 + (r() < 0.3 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const t = when + i * rand(r, 0.18, 0.35);
        const v = this.poolBird.acquire(t);
        v.hp.frequency.setValueAtTime(2200, t);
        v.peak.frequency.setValueAtTime(rand(r, 3600, 4600), t);
        v.peak.Q.setValueAtTime(6, t);
        v.peak.gain.setValueAtTime(17, t);
        v.lp.frequency.setValueAtTime(9000, t);
        v.pan.pan.setValueAtTime(pan, t);
        v.send.gain.setValueAtTime(send, t);
        percussive(v.amp.gain, t, 0.26 * dist, 0.001, 0.035);
        v.start(this.ctx, this.bank.white, t, r() * 1.5, 0.06, 1);
      }
      return;
    }

    if (pick < 0.8) {
      // Coal/crested tit contact calls: thin, high, three or four of them.
      const n = 3 + ((r() * 3) | 0);
      const base = rand(r, 6200, 7800);
      for (let i = 0; i < n; i++) {
        const t = when + i * rand(r, 0.1, 0.17);
        this.tone(t, {
          f0: base * jitter(r, 0.05),
          f1: base * rand(r, 0.82, 0.95),
          dur: rand(r, 0.05, 0.09),
          attack: 0.006,
          gain: 0.1 * dist,
          vibrato: 0,
          vibratoDepth: 0,
          noise: 0.12,
          pan,
          send,
          dest: out,
        });
      }
      return;
    }

    // Wood pigeon, five soft syllables, far off. The sound of a Czech August
    // morning more than any other.
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
        dest: out,
      });
      t += d + 0.08;
    }
  }

  /**
   * A glide with optional vibrato and a breath of noise. Allocates an
   * oscillator per syllable — acceptable here and nowhere else: birds fire on
   * the order of once every fifteen seconds, not once per frame.
   */
  private tone(
    when: number,
    o: {
      f0: number;
      f1: number;
      dur: number;
      attack: number;
      gain: number;
      vibrato: number;
      vibratoDepth: number;
      noise: number;
      pan: number;
      send: number;
      dest: AudioNode;
    },
  ): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
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

    // A breath of noise on top: no bird is a pure tone.
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
}

/** Exponentially-distributed gap with mean `meanS`. Poisson arrivals. */
function poisson(rng: Rng, meanS: number): number {
  return -Math.log(1 - rng() * 0.999) * meanS;
}
