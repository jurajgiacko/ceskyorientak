/**
 * Punch feedback.
 *
 * This is the most recognisable sound in orienteering and the one every
 * orienteer in the audience knows in their bones, so it gets its own module and
 * its own care. Two variants:
 *
 *   contact    the stick goes in the hole. Plastic contact first, then the
 *              station's piezo beep — a hard, bright, immediate ~2 kHz.
 *   touchfree  the card on your wrist beeps as you run through. Higher, shorter,
 *              thinner, no mechanical component at all, and slightly wetter
 *              because the source is a metre from your ear and moving.
 *
 * Character notes that matter to anyone who has punched a control:
 *   - the attack is *immediate*. 1.5 ms. Any softer and it reads as a game UI
 *     sound instead of a piece of timing hardware.
 *   - it does not vary. Real electronics produce an identical beep every time,
 *     so these buffers are rendered once and replayed unchanged. The only thing
 *     that moves is level and pan.
 *   - it is short. Under 100 ms including the tail. Orienteers punch and go.
 *
 * Naming: nothing in this system's buffers, render files or public API carries
 * a SPORTident trademark. The variants are `contact` and `touchfree`; the
 * rendered files are `punch-contact.wav` and `punch-touchfree.wav`. Only this
 * source file, which is documentation as much as code, names the technology.
 */

import { makeRng, normalisePeak, rand, renderModal, toBuffer, VoicePool, type Rng } from './synth';

export type PunchKind = 'contact' | 'touchfree';

export interface PunchOptions {
  /** 0..1 — attenuation, for a punch heard from a distance (a rival's). */
  level?: number;
  /** Stereo placement, −1..1. */
  pan?: number;
  /** Two beeps ~120 ms apart — the start and finish convention. */
  double?: boolean;
}

export class Punch {
  private readonly ctx: BaseAudioContext;
  private readonly pool: VoicePool;
  private readonly rng: Rng;
  private readonly beeps: Readonly<Record<PunchKind, AudioBuffer>>;
  private readonly click: AudioBuffer;

  constructor(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode, seed = 3103) {
    this.ctx = ctx;
    this.pool = new VoicePool(ctx, dry, wet, 6);
    this.rng = makeRng(seed);
    const sr = ctx.sampleRate;

    // --- the station beep --------------------------------------------------
    // 2 kHz fundamental with weak integer harmonics (a piezo disc is not a
    // sine) and one inharmonic partial at 4.72× standing in for the case
    // resonance. Slow-ish modal decay so the body is near-flat, then the
    // renderer's 20 ms release closes it: flat, then gone. That is the shape.
    const contact = renderModal(
      sr,
      2000,
      [
        { ratio: 1, gain: 1.0, decay: 0.45 },
        { ratio: 2, gain: 0.08, decay: 0.14 },
        { ratio: 3, gain: 0.05, decay: 0.1 },
        { ratio: 4.72, gain: 0.035, decay: 0.05 },
      ],
      0.088,
      { strikeNoise: 0.1, strikeMs: 2.2, seed: seed + 1 },
    );
    normalisePeak(contact, 0.9);

    // --- the card beep -----------------------------------------------------
    // Smaller emitter: higher, shorter, almost pure, and it dies faster.
    const touchfree = renderModal(
      sr,
      2600,
      [
        { ratio: 1, gain: 1.0, decay: 0.26 },
        { ratio: 2, gain: 0.045, decay: 0.08 },
        { ratio: 3.61, gain: 0.03, decay: 0.04 },
      ],
      0.056,
      { strikeNoise: 0.05, strikeMs: 1.4, seed: seed + 2 },
    );
    normalisePeak(touchfree, 0.85);

    this.beeps = { contact: toBuffer(ctx, contact), touchfree: toBuffer(ctx, touchfree) };

    // --- the plastic ------------------------------------------------------
    // The stick entering the station. Dry, tiny, 9 ms — you register it as
    // touch rather than as sound, which is exactly its job.
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
  fire(when: number, kind: PunchKind, opts: PunchOptions = {}): number {
    const level = opts.level ?? 1;
    const pan = opts.pan ?? (kind === 'touchfree' ? rand(this.rng, -0.22, -0.06) : 0);

    if (kind === 'contact') {
      // The plastic lands a hair before the electronics answer it.
      const t = when - 0.016;
      const v = this.pool.acquire(t);
      v.hp.frequency.setValueAtTime(700, t);
      v.peak.frequency.setValueAtTime(2600, t);
      v.peak.Q.setValueAtTime(1.4, t);
      v.peak.gain.setValueAtTime(5, t);
      v.lp.frequency.setValueAtTime(9000, t);
      v.pan.pan.setValueAtTime(pan, t);
      v.amp.gain.setValueAtTime(0.45 * level, t);
      v.amp.gain.setValueAtTime(0, t + 0.02);
      v.start(this.ctx, this.click, t, 0, 0.014, 1);
    }

    this.beep(when, kind, level, pan);
    if (opts.double) this.beep(when + 0.12, kind, level * 0.92, pan);
    return when;
  }

  private beep(when: number, kind: PunchKind, level: number, pan: number): void {
    const buf = this.beeps[kind];
    const v = this.pool.acquire(when);
    // Filters near-neutral: the buffer already is the sound. A beep that has
    // been EQ'd on the way out stops being a piece of hardware.
    v.hp.frequency.setValueAtTime(400, when);
    v.peak.frequency.setValueAtTime(kind === 'contact' ? 2000 : 2600, when);
    v.peak.Q.setValueAtTime(1.2, when);
    v.peak.gain.setValueAtTime(2, when);
    v.lp.frequency.setValueAtTime(16000, when);
    v.pan.pan.setValueAtTime(pan, when);
    // The card is on your wrist out in the open; the station is under your
    // hand. The card gets the room, the station does not.
    v.send.gain.setValueAtTime(kind === 'touchfree' ? 0.3 : 0.1, when);
    v.amp.gain.setValueAtTime((kind === 'contact' ? 0.62 : 0.5) * level, when);
    v.amp.gain.setValueAtTime(0, when + buf.duration + 0.005);
    v.start(this.ctx, buf, when, 0, buf.duration, 1);
  }
}
