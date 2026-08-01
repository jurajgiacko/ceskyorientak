/**
 * Footfall synthesis.
 *
 * Every `GroundType` is its own recipe — different noise colour, different
 * band, different resonance, different envelope shape, different number of
 * grains, different body layer. None of them is a pitch-shift of another, which
 * you can hear and which the spectral-centroid table in `README.md` measures.
 *
 * A footfall is built from up to four layers:
 *
 *   body      low thud — the mass of the athlete arriving
 *   surface   the band that identifies the material
 *   grains    micro-bursts a few ms apart — crunch (leaf, gravel, rock)
 *   tail      material-specific afterthought (marsh suck, water droplets)
 *
 * plus a vegetation brush layer whenever `Runnability` says there is something
 * to push through. Running the green through the footstep bus rather than the
 * ambience bus matters: brushing is something *you* do, and it has to sit with
 * your feet and your breath, not with the forest.
 */

import { Runnability, type GroundType } from '@/core/types';
import {
  clamp,
  jitter,
  makeRng,
  NoiseBank,
  percussive,
  rand,
  VoicePool,
  type Rng,
  type Voice,
} from './synth';

type NoiseColour = 'white' | 'pink' | 'brown';

interface Recipe {
  colour: NoiseColour;
  /** Surface band. */
  hp: number;
  lp: number;
  /** The one resonance that names the material. */
  peakFreq: number;
  peakQ: number;
  peakDb: number;
  attack: number;
  decay: number;
  gain: number;
  /** Reverb send, 0..1. Hard surfaces in hard places send a lot. */
  send: number;
  /** Low body thump. */
  bodyFreq: number;
  bodyGain: number;
  /** Extra micro-bursts after the main one, and how far they spread (s). */
  grains: number;
  grainSpread: number;
  /**
   * Lowpass sweep across the strike, as an end/start ratio. <1 closes (marsh
   * settling into mud), >1 opens (water throwing spray upward).
   */
  lpSweep: number;
  /** Randomisation depth for filter frequencies and gain. */
  freqVar: number;
  gainVar: number;
}

/**
 * The nine surfaces. Numbers here were tuned by ear and then checked against
 * the offline spectral analysis; the centroid ordering
 * marsh < grass < asphalt < leaf < rock < water < needles < cobble < gravel
 * is deliberate and is the thing that makes them tell apart blind.
 */
const RECIPES: Readonly<Record<GroundType, Recipe>> = {
  // Šumava spruce floor. Soft, dry, high — closer to a brush than an impact.
  needles: {
    colour: 'pink',
    hp: 2100,
    lp: 8600,
    peakFreq: 5000,
    peakQ: 1.0,
    peakDb: 4,
    attack: 0.005,
    decay: 0.115,
    gain: 0.5,
    send: 0.06,
    bodyFreq: 140,
    bodyGain: 0.11,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.75,
    freqVar: 0.11,
    gainVar: 0.22,
  },
  // Beech litter. The crunch is the point: three offset grains, not one burst.
  leaf: {
    colour: 'white',
    hp: 620,
    lp: 6800,
    peakFreq: 2300,
    peakQ: 2.2,
    peakDb: 6,
    attack: 0.003,
    decay: 0.155,
    gain: 0.55,
    send: 0.07,
    bodyFreq: 118,
    bodyGain: 0.15,
    grains: 3,
    grainSpread: 0.019,
    lpSweep: 0.7,
    freqVar: 0.14,
    gainVar: 0.28,
  },
  // Swish, no click. Long soft envelope, low band, real body weight.
  grass: {
    colour: 'pink',
    hp: 430,
    lp: 3900,
    peakFreq: 1350,
    peakQ: 1.4,
    peakDb: 3,
    attack: 0.007,
    decay: 0.16,
    gain: 0.5,
    send: 0.05,
    bodyFreq: 95,
    bodyGain: 0.22,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.65,
    freqVar: 0.12,
    gainVar: 0.2,
  },
  // Granite. Short, hard, and it rings — Q6 at 2.7 kHz is the boulder field.
  rock: {
    colour: 'white',
    hp: 380,
    lp: 10500,
    peakFreq: 2750,
    peakQ: 6,
    peakDb: 11,
    attack: 0.0018,
    decay: 0.075,
    gain: 0.6,
    send: 0.13,
    bodyFreq: 155,
    bodyGain: 0.26,
    grains: 2,
    grainSpread: 0.011,
    lpSweep: 0.8,
    freqVar: 0.13,
    gainVar: 0.22,
  },
  // Wet. Brown noise, everything below 900 Hz, closing sweep, plus the suck.
  marsh: {
    colour: 'brown',
    hp: 70,
    lp: 900,
    peakFreq: 255,
    peakQ: 4,
    peakDb: 10,
    attack: 0.006,
    decay: 0.2,
    gain: 0.7,
    send: 0.03,
    bodyFreq: 72,
    bodyGain: 0.5,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.45,
    freqVar: 0.16,
    gainVar: 0.24,
  },
  // Loose stones. Four grains, wide band, nothing resonant — the brightest.
  gravel: {
    colour: 'white',
    hp: 1450,
    lp: 13500,
    peakFreq: 4200,
    peakQ: 1.2,
    peakDb: 4,
    attack: 0.002,
    decay: 0.125,
    gain: 0.52,
    send: 0.08,
    bodyFreq: 110,
    bodyGain: 0.17,
    grains: 4,
    grainSpread: 0.023,
    lpSweep: 0.85,
    freqVar: 0.15,
    gainVar: 0.3,
  },
  // Krumlov. A hard bright click, 45 ms end to end, thrown at the courtyard.
  cobble: {
    colour: 'white',
    hp: 1250,
    lp: 13000,
    peakFreq: 3450,
    peakQ: 8,
    peakDb: 14,
    attack: 0.0012,
    decay: 0.045,
    gain: 0.58,
    send: 0.45,
    bodyFreq: 195,
    bodyGain: 0.2,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.9,
    freqVar: 0.1,
    gainVar: 0.18,
  },
  // Flat slap. Dry, mid, short. Deliberately the least interesting surface.
  asphalt: {
    colour: 'white',
    hp: 700,
    lp: 6200,
    peakFreq: 1750,
    peakQ: 3,
    peakDb: 7,
    attack: 0.0016,
    decay: 0.058,
    gain: 0.5,
    send: 0.09,
    bodyFreq: 132,
    bodyGain: 0.2,
    grains: 0,
    grainSpread: 0,
    lpSweep: 0.8,
    freqVar: 0.1,
    gainVar: 0.16,
  },
  // Opening sweep — spray thrown up — then droplets falling back.
  water: {
    colour: 'white',
    hp: 260,
    lp: 4200,
    peakFreq: 950,
    peakQ: 1.1,
    peakDb: 3,
    attack: 0.004,
    decay: 0.28,
    gain: 0.62,
    send: 0.16,
    bodyFreq: 105,
    bodyGain: 0.3,
    grains: 0,
    grainSpread: 0,
    lpSweep: 2.6,
    freqVar: 0.13,
    gainVar: 0.24,
  },
};

/** How much vegetation there is to brush past, by runnability class. */
function brushAmount(r: Runnability): number {
  switch (r) {
    case Runnability.Green1:
      return 0.35;
    case Runnability.Green2:
      return 0.7;
    case Runnability.Green3:
      return 1;
    case Runnability.OpenRough:
      return 0.25;
    default:
      return 0;
  }
}

export interface FootstepInput {
  ground: GroundType;
  /** m/s. Drives cadence, impact weight and brightness. */
  speed: number;
  runnability: Runnability;
  /** 0..1. Low glycogen adds scuffs, asymmetry and a heavier landing. */
  glycogen: number;
}

export class Footsteps {
  private readonly ctx: BaseAudioContext;
  private readonly bank: NoiseBank;
  private readonly pool: VoicePool;
  private readonly rng: Rng;

  /** Step phase, 0..1. Crossing 1 fires a foot. */
  private phase = 0;
  private leftFoot = true;
  /** Scheduling lookahead — enough to survive a dropped frame, short enough
   *  that the step still lines up with the animation. */
  private static readonly LOOKAHEAD = 0.03;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dry: AudioNode, wet: AudioNode, seed = 90210) {
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
  update(now: number, dt: number, input: FootstepInput): void {
    const rate = stepsPerSecond(input.speed);
    if (rate <= 0) {
      this.phase = 0;
      return;
    }
    this.phase += rate * dt;
    // Cap the catch-up so a long stall (tab restore) does not machine-gun.
    if (this.phase > 3) this.phase = 1;
    while (this.phase >= 1) {
      this.phase -= 1;
      // Fatigue makes the gait uneven, and it is one foot that goes first.
      const limp = (1 - input.glycogen) * (this.leftFoot ? 0.05 : -0.02);
      const when = now + Footsteps.LOOKAHEAD + (this.phase / rate) + limp / rate;
      this.strike(when, input);
      this.leftFoot = !this.leftFoot;
    }
  }

  /** Fire one footfall immediately. Used by the preview harness. */
  trigger(when: number, input: FootstepInput): void {
    this.strike(when, input);
    this.leftFoot = !this.leftFoot;
  }

  private strike(when: number, input: FootstepInput): void {
    const r = RECIPES[input.ground];
    const rng = this.rng;

    // Fast running lands harder and brighter; a walk is softer and duller.
    const effort = clamp(0.42 + input.speed * 0.16, 0.42, 1.08);
    const tired = 1 - input.glycogen;
    const pan = (this.leftFoot ? -1 : 1) * rand(rng, 0.1, 0.26);

    // --- body -------------------------------------------------------------
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
      // Tired athletes land heavier: the body layer grows, the surface does not.
      const g = r.bodyGain * effort * (1 + tired * 0.28) * jitter(rng, 0.15);
      percussive(v.amp.gain, when, g, 0.004, 0.09);
      this.play(v, 'brown', when, 0.16);
    }

    // --- surface ----------------------------------------------------------
    this.surface(when, r, effort * jitter(rng, r.gainVar), pan, 1);

    // --- grains -----------------------------------------------------------
    for (let i = 0; i < r.grains; i++) {
      const t = when + rand(rng, 0.002, r.grainSpread);
      this.surface(t, r, effort * rand(rng, 0.18, 0.45), pan + rand(rng, -0.08, 0.08), 0.55);
    }

    // --- material tails ---------------------------------------------------
    if (input.ground === 'marsh') this.marshSuck(when, effort, pan);
    if (input.ground === 'water') this.droplets(when, effort, pan);

    // --- vegetation -------------------------------------------------------
    const brush = brushAmount(input.runnability);
    if (brush > 0 && rng() < 0.45 + brush * 0.5) this.brush(when, brush, effort, pan);

    // --- fatigue scuff ----------------------------------------------------
    // Not every step, and never at full glycogen: a dragged toe, 30 ms late.
    if (tired > 0.45 && rng() < (tired - 0.45) * 1.1) {
      this.scuff(when + rand(rng, 0.02, 0.05), r, tired, pan);
    }
  }

  /** The identifying band of the material. `scale` shrinks it for grains. */
  private surface(when: number, r: Recipe, gain: number, pan: number, scale: number): void {
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
    // The sweep is what makes a strike feel like a movement rather than a hit.
    if (r.lpSweep !== 1) {
      v.lp.frequency.exponentialRampToValueAtTime(
        clamp(lp0 * r.lpSweep, 60, 20000),
        when + r.decay * scale,
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
  private marshSuck(when: number, effort: number, pan: number): void {
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
    // Slow attack: a suck is a pull, not an impact.
    const g = 0.34 * effort * jitter(rng, 0.2);
    v.amp.gain.setValueAtTime(0, t);
    v.amp.gain.linearRampToValueAtTime(g, t + 0.045);
    v.amp.gain.setTargetAtTime(0, t + 0.045, 0.028);
    v.amp.gain.setValueAtTime(0, t + 0.24);
    this.play(v, 'brown', t, 0.26);
  }

  /** Two or three drops falling back after a splash. */
  private droplets(when: number, effort: number, pan: number): void {
    const rng = this.rng;
    const n = 2 + ((rng() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const t = when + rand(rng, 0.06, 0.3);
      const v = this.pool.acquire(t);
      const f = rand(rng, 1400, 3600);
      v.hp.frequency.setValueAtTime(f * 0.5, t);
      v.peak.frequency.setValueAtTime(f, t);
      v.peak.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.03);
      v.peak.Q.setValueAtTime(14, t);
      v.peak.gain.setValueAtTime(18, t);
      v.lp.frequency.setValueAtTime(f * 2.2, t);
      v.pan.pan.setValueAtTime(pan + rand(rng, -0.3, 0.3), t);
      v.send.gain.setValueAtTime(0.22, t);
      percussive(v.amp.gain, t, 0.1 * effort * rand(rng, 0.5, 1), 0.001, 0.035);
      this.play(v, 'white', t, 0.06);
    }
  }

  /** Branches and undergrowth against arms and legs. */
  private brush(when: number, amount: number, effort: number, pan: number): void {
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
    this.play(v, 'pink', t, 0.3);
    // Dark green means real branches — an occasional snap on top of the swish.
    if (amount > 0.6 && rng() < 0.3) {
      const s = t + rand(rng, 0.01, 0.12);
      const sv = this.pool.acquire(s);
      sv.hp.frequency.setValueAtTime(900, s);
      sv.peak.frequency.setValueAtTime(rand(rng, 1800, 4200), s);
      sv.peak.Q.setValueAtTime(9, s);
      sv.peak.gain.setValueAtTime(16, s);
      sv.lp.frequency.setValueAtTime(9000, s);
      sv.pan.pan.setValueAtTime(-pan, s);
      sv.send.gain.setValueAtTime(0.2, s);
      percussive(sv.amp.gain, s, 0.16 * amount, 0.0008, 0.03);
      this.play(sv, 'white', s, 0.05);
    }
  }

  /** A dragged foot. Long, dull, quiet, and it only happens when it should. */
  private scuff(when: number, r: Recipe, tired: number, pan: number): void {
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

  private play(v: Voice, colour: NoiseColour, when: number, duration: number): void {
    const buf =
      colour === 'white' ? this.bank.white : colour === 'pink' ? this.bank.pink : this.bank.brown;
    // A random read offset per strike, so two footfalls never share a waveform.
    const offset = this.rng() * Math.max(0.05, buf.duration - duration - 0.05);
    v.start(this.ctx, buf, when, offset, duration, 1);
  }
}

/**
 * Cadence from speed.
 *
 * Elite orienteers hold 170–185 steps/min on runnable ground, and cadence falls
 * far less than speed does in green — you shorten the stride, you do not slow
 * the legs. Hence the shallow slope and the high floor: 4.2 m/s → 182 spm,
 * 1.5 m/s (fight) → 116 spm.
 */
export function stepsPerSecond(speed: number): number {
  if (speed < 0.15) return 0;
  return clamp(1.24 + speed * 0.42, 0.95, 3.3);
}
