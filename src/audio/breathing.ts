/**
 * Breath.
 *
 * This is the single most important sound in the game. Everything else tells
 * you about the world; this tells you about the athlete, and it is the cue that
 * has to make the wall land in the player's chest before the HUD tells them
 * anything. `AthleteStats.glycogen` drives it directly.
 *
 * What changes as glycogen falls, in the order you notice it:
 *
 *   rate        ~38/min fresh at race pace → ~62/min emptied
 *   depth       quiet and efficient → loud, and the exhale outlasts the inhale
 *   tilt        a high-shelf opens: the mouth goes dry and the breath hisses
 *   raggedness  the exhale stops being one smooth gesture and breaks into 3–5
 *   the catch   the inhale hitches — up, stall, then a snatched second intake
 *   the groan   a low voiced component appears on some exhales, never all
 *   the pause   the rest between exhale and next inhale vanishes entirely
 *
 * Restraint is the difficulty. Every one of those, at full depth, on every
 * breath, is a cartoon. So: the groan is probabilistic and capped at −19 dB
 * relative to the breath noise, the catch never fires twice in a row, and the
 * raggedness is amplitude only — no pitch, because pitched distress reads as
 * comedy almost immediately.
 *
 * Zero allocation after `start()`. Two looping noise sources and one oscillator
 * are created once; a breath is nothing but scheduled `AudioParam` automation.
 */

import { clamp, jitter, makeRng, NoiseBank, rand, type Rng } from './synth';

export interface BreathInput {
  /** 0..1, from `AthleteStats.glycogen`. */
  glycogen: number;
  /** Ground speed, m/s. */
  speed: number;
  /** 0..1, from `AthleteStats.hydration`. Dryness adds hiss, nothing else. */
  hydration: number;
}

/** One noise chain: source → HP → turbulence BP → two formants → shelf → amp. */
interface Chain {
  hp: BiquadFilterNode;
  bp: BiquadFilterNode;
  f1: BiquadFilterNode;
  f2: BiquadFilterNode;
  shelf: BiquadFilterNode;
  amp: GainNode;
  pan: StereoPannerNode;
  src: AudioBufferSourceNode | null;
}

export class Breathing {
  private readonly ctx: BaseAudioContext;
  private readonly bank: NoiseBank;
  private readonly rng: Rng;

  private readonly inhale: Chain;
  private readonly exhale: Chain;

  /** The involuntary low groan. Silent unless the athlete is in trouble. */
  private readonly osc: OscillatorNode;
  private readonly oscLp: BiquadFilterNode;
  private readonly oscBp: BiquadFilterNode;
  private readonly oscAmp: GainNode;

  /** Timeline instant the next breath cycle begins. */
  private nextBreathAt = 0;
  private lastCatch = false;
  private started = false;
  private panSide = 1;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dry: AudioNode, wet: AudioNode, seed = 7331) {
    this.ctx = ctx;
    this.bank = bank;
    this.rng = makeRng(seed);
    this.inhale = makeChain(ctx, dry, wet);
    this.exhale = makeChain(ctx, dry, wet);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 108;
    this.oscBp = ctx.createBiquadFilter();
    this.oscBp.type = 'bandpass';
    this.oscBp.frequency.value = 320;
    this.oscBp.Q.value = 1.1;
    this.oscLp = ctx.createBiquadFilter();
    this.oscLp.type = 'lowpass';
    // Only the first three or four harmonics survive. Any more and it is a
    // voice saying something, which is exactly what this must not be.
    this.oscLp.frequency.value = 430;
    this.oscLp.Q.value = 0.9;
    this.oscAmp = ctx.createGain();
    this.oscAmp.gain.value = 0;
    this.osc.connect(this.oscBp).connect(this.oscLp).connect(this.oscAmp).connect(dry);
  }

  /** Start the permanent sources. Call once, after the context is running. */
  start(when: number): void {
    if (this.started) return;
    this.started = true;
    startChain(this.ctx, this.inhale, this.bank.white, when, 0.31);
    startChain(this.ctx, this.exhale, this.bank.pink, when, 1.27);
    this.osc.start(when);
    this.nextBreathAt = when + 0.05;
  }

  stop(when: number): void {
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
  update(now: number, _dt: number, input: BreathInput): void {
    if (!this.started) return;
    const horizon = now + 0.25;
    let guard = 0;
    while (this.nextBreathAt < horizon && guard++ < 8) {
      this.nextBreathAt = this.scheduleBreath(Math.max(this.nextBreathAt, now + 0.02), input);
    }
    // If the game was paused, do not try to catch up on a minute of breathing.
    if (this.nextBreathAt < now) this.nextBreathAt = now + 0.05;
  }

  /** Schedule exactly one breath cycle. Returns when the next one should start. */
  private scheduleBreath(t0: number, input: BreathInput): number {
    const rng = this.rng;
    const g = clamp(input.glycogen, 0, 1);
    const fatigue = 1 - g;
    // Effort saturates around 4.5 m/s — flat-out for an orienteer in forest.
    const effort = clamp(input.speed / 4.5, 0, 1);
    const dry = clamp(1 - input.hydration, 0, 1);

    // --- cycle geometry ---------------------------------------------------
    const bpm = 15 + 24 * effort + 26 * fatigue + 8 * effort * fatigue;
    // Timing regularity is one of the first things to go.
    const cycle = (60 / bpm) * jitter(rng, 0.04 + 0.11 * fatigue);
    // Inhale:exhale moves toward 1:1 under load, but the exhale always leads.
    const inFrac = clamp(0.34 + 0.11 * effort + 0.05 * fatigue, 0.3, 0.48);
    // The rest between breaths is the first casualty of the wall.
    const rest = cycle * clamp(0.16 - 0.16 * fatigue - 0.06 * effort, 0, 0.16);
    const active = cycle - rest;
    const tIn = active * inFrac;
    const tEx = active - tIn;

    const depth = clamp(0.2 + 0.34 * effort + 0.26 * fatigue, 0.2, 0.82);
    const catching = !this.lastCatch && rng() < clamp((fatigue - 0.35) * 0.85, 0, 0.5);
    this.lastCatch = catching;
    this.panSide = -this.panSide;

    // --- inhale -----------------------------------------------------------
    const ic = this.inhale;
    const t1 = t0 + tIn;
    // Air accelerating through the throat: the turbulence band rises through
    // the intake and fatigue pushes the whole thing brighter and thinner.
    const bpLo = (620 + 320 * fatigue) * jitter(rng, 0.07);
    const bpHi = (1250 + 620 * fatigue + 260 * effort) * jitter(rng, 0.07);
    ic.bp.frequency.setValueAtTime(bpLo, t0);
    ic.bp.frequency.exponentialRampToValueAtTime(bpHi, t0 + tIn * 0.7);
    ic.bp.Q.setValueAtTime(0.62 + 0.3 * fatigue, t0);
    ic.f1.frequency.setValueAtTime(700 * jitter(rng, 0.06), t0);
    ic.f2.frequency.setValueAtTime((1180 + 340 * fatigue) * jitter(rng, 0.06), t0);
    // The dry-mouth shelf. Hydration contributes, glycogen contributes more.
    ic.shelf.gain.setValueAtTime(-2 + 9 * fatigue + 4 * dry, t0);
    ic.pan.pan.setValueAtTime(this.panSide * 0.05, t0);

    const inPeak = depth * 0.95;
    const a = ic.amp.gain;
    a.setValueAtTime(0, t0);
    if (catching) {
      // The hitch: a rush, a stall, then a snatched second intake. Three
      // segments where there is normally one. Nothing else in the system
      // sounds like this, which is why it works so hard.
      a.linearRampToValueAtTime(inPeak * 0.6, t0 + tIn * 0.2);
      a.linearRampToValueAtTime(inPeak * 0.17, t0 + tIn * 0.36);
      a.linearRampToValueAtTime(inPeak * 1.06, t0 + tIn * 0.66);
      a.linearRampToValueAtTime(inPeak * 0.3, t0 + tIn * 0.9);
    } else {
      a.linearRampToValueAtTime(inPeak, t0 + tIn * 0.48);
      a.linearRampToValueAtTime(inPeak * 0.34, t0 + tIn * 0.88);
    }
    a.linearRampToValueAtTime(0, t1);

    // --- exhale -----------------------------------------------------------
    const ec = this.exhale;
    const t2 = t1 + tEx;
    const exLo = (480 + 210 * fatigue) * jitter(rng, 0.07);
    ec.bp.frequency.setValueAtTime(exLo * 1.5, t1);
    // Falling, always: an exhale is a collapse.
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
    // Raggedness: the smooth exhale breaks into pulses. Amplitude only.
    const dips = fatigue < 0.35 ? 0 : 2 + ((rng() * 3) | 0);
    if (dips > 0) {
      const depthOfDip = clamp((fatigue - 0.3) * 0.62, 0, 0.42);
      for (let i = 1; i <= dips; i++) {
        const f = 0.16 + (0.74 * i) / (dips + 1);
        b.linearRampToValueAtTime(exPeak * (1 - depthOfDip * rand(rng, 0.6, 1)), t1 + tEx * f);
        b.linearRampToValueAtTime(
          exPeak * (0.86 + 0.14 * rng()),
          t1 + tEx * (f + 0.35 / (dips + 1)),
        );
      }
    }
    b.linearRampToValueAtTime(0, t2);

    // --- the groan --------------------------------------------------------
    // Never on every breath, never above −19 dB relative to the breath, and it
    // falls in pitch across the exhale. Involuntary, not performed.
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
}

function makeChain(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode): Chain {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 180;
  hp.Q.value = 0.7;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 800;
  bp.Q.value = 0.6;

  // Two peaking filters standing in for vocal-tract formants. Not a real tract
  // model — a breath is voiceless, so what matters is only that the noise has
  // resonances at plausible places instead of being flat.
  const f1 = ctx.createBiquadFilter();
  f1.type = 'peaking';
  f1.frequency.value = 620;
  f1.Q.value = 2.4;
  f1.gain.value = 9;

  const f2 = ctx.createBiquadFilter();
  f2.type = 'peaking';
  f2.frequency.value = 1200;
  f2.Q.value = 1.8;
  f2.gain.value = 6;

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 3600;
  shelf.gain.value = -3;

  const amp = ctx.createGain();
  amp.gain.value = 0;

  const pan = ctx.createStereoPanner();
  pan.pan.value = 0;

  hp.connect(bp).connect(f1).connect(f2).connect(shelf).connect(amp).connect(pan);
  pan.connect(dry);
  // A little send keeps the breath in the same room as the footsteps; too much
  // and the athlete sounds like they are somewhere else.
  const send = ctx.createGain();
  send.gain.value = 0.07;
  pan.connect(send).connect(wet);

  return { hp, bp, f1, f2, shelf, amp, pan, src: null };
}

function startChain(
  ctx: BaseAudioContext,
  chain: Chain,
  buffer: AudioBuffer,
  when: number,
  offset: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  // Different offsets and slightly different rates so the inhale and exhale
  // chains are never reading the same noise, which would correlate them.
  src.loopStart = 0;
  src.loopEnd = buffer.duration;
  src.playbackRate.value = 0.97 + offset * 0.02;
  src.connect(chain.hp);
  src.start(when, offset % buffer.duration);
  chain.src = src;
}
