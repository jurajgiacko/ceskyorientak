/**
 * Ducking.
 *
 * Two jobs, one owner. Nothing outside this file touches `bus.duck`, the master
 * `tone` filter, the M/S `width` gain or `reverbReturn` — which is what stops a
 * settings slider and a map duck from fighting over the same `AudioParam` and
 * producing the classic bug where the mix never comes back up.
 *
 * ### Map reading
 *
 * The brief asks for "full mix ducking during map reading". The literal reading
 * — pull everything down — is wrong, and it is worth saying why. Raising the map
 * is not muting the world; it is *narrowing attention*. The world does not stop.
 * So the duck is shaped:
 *
 *   footsteps  −9.0 dB   still there. You are still running.
 *   ambience  −15.0 dB   the forest recedes furthest. This is the big move.
 *   music     −12.0 dB
 *   breath     −4.5 dB   the shallowest duck by a wide margin — deliberately.
 *   ui          0.0 dB   a punch must never be ducked.
 *
 * The first version of this table used −1.7 dB on breath, which read correctly
 * on paper and measured as a 1.6 dB duck overall: breath is the loudest thing
 * in the mix at low glycogen, so leaving it almost untouched left the whole
 * duck almost untouched. −4.5 dB still puts breath 4.5–10.5 dB forward of
 * everything else, which is the relationship that matters, and the mix now
 * actually moves.
 *
 * plus two things a level change alone cannot do:
 *
 *   the master lowpass sweeps 20 kHz → 1.7 kHz — the mix goes dull and close
 *   the M/S side gain collapses 1.0 → 0.35 — the stereo image narrows to you
 *
 * Breath staying up is the point of the whole gesture. When the player lifts
 * the map, what fills the space the forest left is their own breathing. On a
 * Long distance at glycogen 0.2 that is genuinely unpleasant, and it should be.
 *
 * Timing is exponential, not linear, and asymmetric: ~300 ms down, ~550 ms up.
 * Slower coming back is what makes it read as a musical duck rather than a
 * gate — gates are symmetric and you hear them switch.
 *
 * ### Punch sidechain
 *
 * A short, shallow dip on ambience and music so the punch beep lands in a hole
 * rather than fighting the forest. 4 dB, 40 ms in, 260 ms out. It composes with
 * the map duck by multiplication rather than by overwriting, so ducking while
 * reading the map does not strand a bus at the wrong level.
 */

import { BUS_NAMES, type AudioGraph, type BusName } from './engine';
import { clamp, dbToGain } from './synth';

/** Map-reading duck targets, in dB. */
const MAP_DUCK_DB: Readonly<Record<BusName, number>> = {
  footsteps: -9,
  breath: -4.5,
  ambience: -15,
  music: -12,
  ui: 0,
};

/** Punch sidechain depth, in dB. */
const SIDECHAIN_DB: Readonly<Record<BusName, number>> = {
  footsteps: -1.5,
  breath: 0,
  ambience: -4,
  music: -4,
  ui: 0,
};

const TONE_OPEN = 20000;
const TONE_DUCKED = 1700;
const WIDTH_OPEN = 1;
const WIDTH_DUCKED = 0.35;
const REVERB_OPEN = 1;
const REVERB_DUCKED = 0.55;

/** Time constants. Down is quick and deliberate; up is slow and forgiving. */
const TC_DOWN = 0.1;
const TC_UP = 0.185;

export class Mixer {
  private readonly graph: AudioGraph;
  /** Per-bus map-duck factor, 0..1. The sidechain multiplies on top of this. */
  private readonly base: Record<BusName, number>;
  private mapOpen = false;

  constructor(graph: AudioGraph) {
    this.graph = graph;
    this.base = { footsteps: 1, breath: 1, ambience: 1, music: 1, ui: 1 };
  }

  get isMapOpen(): boolean {
    return this.mapOpen;
  }

  /**
   * Raise or lower the map. Idempotent — calling it every frame while the
   * button is held costs nothing and schedules nothing.
   */
  duckForMap(on: boolean, when: number): void {
    if (on === this.mapOpen) return;
    this.mapOpen = on;
    const tc = on ? TC_DOWN : TC_UP;

    for (const bus of BUS_NAMES) {
      const target = on ? dbToGain(MAP_DUCK_DB[bus]) : 1;
      this.base[bus] = target;
      this.graph.buses[bus].duck.gain.setTargetAtTime(target, when, tc);
      // The reverb send follows its bus, so the room recedes with it.
      this.graph.buses[bus].aux.gain.setTargetAtTime(target, when, tc);
    }

    // The filter sweep is exponential in Hz because pitch perception is, and a
    // linear approach from 20 kHz would spend its first 200 ms doing nothing
    // audible and then lurch.
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
  sidechain(when: number, holdS = 0.18): void {
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
  fade(to: number, when: number, seconds: number): void {
    const g = this.graph.master.gain;
    g.cancelScheduledValues(when);
    g.setValueAtTime(g.value, when);
    g.linearRampToValueAtTime(clamp(to, 0, 1) * 0.8, when + Math.max(0.01, seconds));
  }

  /** Diagnostic: the current duck factor applied to a bus, 0..1. */
  duckFactor(bus: BusName): number {
    return this.base[bus];
  }
}
