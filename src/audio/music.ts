/**
 * Music, such as it is.
 *
 * The brief for this is almost entirely negative: not orchestral, not heroic,
 * not a loop, not present. What is left is a low drone that you stop noticing
 * within thirty seconds, and occasional single tones that arrive without
 * announcing themselves.
 *
 * Three deliberate choices:
 *
 *  - **No pulse.** Nothing here is on a grid. Events are Poisson-scheduled, so
 *    the music can never accidentally lock to the player's cadence, which would
 *    turn a race into a rhythm game.
 *
 *  - **Modal, not tonal.** The pitch set is D Phrygian — D E♭ F G A B♭ C. The
 *    flat second is the whole character: it will not resolve, it cannot sound
 *    triumphant, and it is idiomatic to Central European folk modality rather
 *    than to film scoring. Weighting shifts toward E♭ and B♭ as tension rises,
 *    so the mode sours without a key change.
 *
 *  - **Plucked, not bowed-as-cliché.** The tones are Karplus-Strong strings,
 *    rendered offline (see `synth.ts` for why not a live feedback loop). Dry,
 *    woody, close to a cimbalom left to ring. The sustained voices are quiet
 *    enough to read as part of the drone rather than as melody.
 *
 * Tension comes from the game — falling glycogen and falling focus — and moves
 * event density, register and the weighting of the two sour degrees. It never
 * moves the volume much. Getting louder is what a lesser system would do.
 */

import {
  clamp,
  makeRng,
  rand,
  renderPluck,
  toBuffer,
  VoicePool,
  type Rng,
} from './synth';

/** D Phrygian over two octaves, in Hz. Index 0 is the tonic. */
const SCALE: readonly number[] = [
  146.83, // D3
  155.56, // Eb3  — the flat second
  174.61, // F3
  196.0, // G3
  220.0, // A3
  233.08, // Bb3  — the flat sixth
  261.63, // C4
  293.66, // D4
  311.13, // Eb4
  349.23, // F4
  440.0, // A4
];

/**
 * Selection weight per degree at tension 0 and at tension 1. At rest the tonic
 * and fifth carry it; under load the flat second and flat sixth take over.
 */
const WEIGHT_CALM: readonly number[] = [3.2, 0.4, 1.6, 0.9, 2.6, 0.5, 0.9, 1.4, 0.2, 0.7, 0.3];
const WEIGHT_TENSE: readonly number[] = [1.6, 2.4, 1.1, 0.7, 1.8, 2.2, 0.8, 1.2, 1.6, 0.9, 0.9];

/** Base pitches for the rendered strings. Everything is within ±3 semitones. */
const PLUCK_BASES: readonly number[] = [146.83, 220.0, 293.66];

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly out: GainNode;
  private readonly pool: VoicePool;
  private readonly wet: AudioNode;
  private readonly plucks: AudioBuffer[] = [];

  // Drone
  private readonly droneOscs: OscillatorNode[] = [];
  private readonly droneLp: BiquadFilterNode;
  private readonly droneGain: GainNode;
  private readonly bowOsc: OscillatorNode;
  private readonly bowBp: BiquadFilterNode;
  private readonly bowGain: GainNode;

  private tension = 0;
  private started = false;
  private tNext = 0;
  private tDrift = 0;
  /** Last degree played, so the generator can lean into or away from it. */
  private lastDegree = 0;

  constructor(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode, seed = 0x1517) {
    this.ctx = ctx;
    this.wet = wet;
    this.rng = makeRng(seed);
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dry);
    this.pool = new VoicePool(ctx, this.out, wet, 6);

    // --- drone -------------------------------------------------------------
    // Three saws a few cents apart. The beating between them is the only
    // movement it has, and it is enough: at 3–7 cents the period is a few
    // seconds, which reads as breathing rather than as detune.
    this.droneLp = ctx.createBiquadFilter();
    this.droneLp.type = 'lowpass';
    this.droneLp.frequency.value = 210;
    this.droneLp.Q.value = 1.4;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneLp.connect(this.droneGain).connect(this.out);

    const droneSpecs: readonly (readonly [number, number, OscillatorType])[] = [
      [36.71, 0, 'triangle'], // D1 — felt, not heard
      [73.42, -4, 'sawtooth'], // D2
      [73.42, 5, 'sawtooth'],
      [110.0, 3, 'sawtooth'], // A2
    ];
    for (const [freq, cents, type] of droneSpecs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = type === 'triangle' ? 0.5 : 0.22;
      o.connect(g).connect(this.droneLp);
      this.droneOscs.push(o);
    }

    // --- the bowed-ish upper voice -----------------------------------------
    // A saw through a high-Q bandpass an octave and a fifth up. Not a string
    // model; a resonance that swells and recedes and never quite arrives.
    this.bowOsc = ctx.createOscillator();
    this.bowOsc.type = 'sawtooth';
    this.bowOsc.frequency.value = 220;
    this.bowBp = ctx.createBiquadFilter();
    this.bowBp.type = 'bandpass';
    this.bowBp.frequency.value = 660;
    this.bowBp.Q.value = 4.5;
    this.bowGain = ctx.createGain();
    this.bowGain.gain.value = 0;
    this.bowOsc.connect(this.bowBp).connect(this.bowGain);
    this.bowGain.connect(this.out);
    const bowSend = ctx.createGain();
    bowSend.gain.value = 0.5;
    this.bowGain.connect(bowSend).connect(wet);

    // --- strings ------------------------------------------------------------
    for (let i = 0; i < PLUCK_BASES.length; i++) {
      const f = PLUCK_BASES[i] ?? 220;
      const data = renderPluck(ctx.sampleRate, {
        freq: f,
        seconds: 2.6,
        damping: 0.42,
        brightness: 0.3,
        sustain: 0.9994,
        seed: seed + 11 * (i + 1),
      });
      this.plucks.push(toBuffer(ctx, data));
    }
  }

  start(when: number): void {
    if (this.started) return;
    this.started = true;
    for (const o of this.droneOscs) o.start(when);
    this.bowOsc.start(when);
    this.droneGain.gain.setTargetAtTime(0.22, when, 4);
    this.tNext = when + rand(this.rng, 6, 16);
    this.tDrift = when + 3;
  }

  stop(when: number): void {
    if (!this.started) return;
    this.started = false;
    this.droneGain.gain.setTargetAtTime(0, when, 1.5);
    for (const o of this.droneOscs) o.stop(when + 6);
    this.bowOsc.stop(when + 6);
  }

  /** 0..1. Denser events, sourer degrees, a brighter drone. Not louder. */
  setTension(t: number): void {
    this.tension = clamp(t, 0, 1);
  }

  update(now: number, _dt: number): void {
    if (!this.started) return;
    const r = this.rng;
    const T = this.tension;

    if (now >= this.tDrift) {
      const t = now + 0.01;
      // The drone opens up under tension — more harmonic, less sub. It is the
      // only thing here that responds continuously rather than in events.
      this.droneLp.frequency.setTargetAtTime(rand(r, 150, 260) * (1 + T * 0.9), t, rand(r, 3, 8));
      this.droneGain.gain.setTargetAtTime(rand(r, 0.16, 0.28) * (0.8 + 0.3 * T), t, rand(r, 4, 10));
      // The bowed voice comes and goes on its own slow schedule.
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
      // 14 s apart at rest, 5 s under load — and a real chance of nothing.
      const mean = 14 - 9 * T;
      this.tNext = now + -Math.log(1 - r() * 0.999) * mean + 1.2;
    }
  }

  /** One musical gesture. Usually a single note. Sometimes two. */
  private event(when: number): void {
    const r = this.rng;
    const T = this.tension;
    const deg = this.pick();
    this.pluck(when, deg, rand(r, 0.1, 0.2) * (0.8 + 0.4 * T));

    // Under real tension, a second note a semitone away — the cluster is the
    // only overtly uneasy device in the whole system, so it stays rare.
    if (r() < 0.1 + 0.35 * T) {
      const near = clamp(deg + (r() < 0.5 ? 1 : -1), 0, SCALE.length - 1);
      this.pluck(when + rand(r, 0.18, 0.75), near, rand(r, 0.05, 0.12));
    } else if (r() < 0.25) {
      // Or an open fifth below, which settles rather than unsettles.
      const below = clamp(deg - 4, 0, SCALE.length - 1);
      this.pluck(when + rand(r, 0.5, 1.6), below, rand(r, 0.04, 0.09));
    }
    this.lastDegree = deg;
  }

  private pluck(when: number, degree: number, gain: number): void {
    const r = this.rng;
    const freq = SCALE[degree] ?? 220;
    // Nearest rendered string, then a playback-rate shift of at most a minor
    // third — beyond that the decay time stretches audibly and it stops
    // sounding like the same instrument.
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
    // Long, soft release rather than a stop — the string is let go, not damped.
    v.amp.gain.setTargetAtTime(0, when + dur * 0.55, dur * 0.2);
    v.amp.gain.setValueAtTime(0, when + dur);
    v.start(this.ctx, buf, when, 0, Math.min(dur, buf.duration / rate - 0.01), rate);
  }

  /** Weighted degree choice, interpolating calm→tense, avoiding repeats. */
  private pick(): number {
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
  get output(): GainNode {
    return this.out;
  }

  /** Exposed for the preview harness. */
  get reverbSend(): AudioNode {
    return this.wet;
  }
}
