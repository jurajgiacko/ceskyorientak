/**
 * The audio system's public face.
 *
 * The game should only ever need what is exported here:
 *
 *   initAudio()                    once at boot — costs nothing until a gesture
 *   updateAudio(state, dt, scene)  once a frame
 *   punch(kind)                    on a control
 *   setEnvironment(env)            forest / arena / town
 *   duckForMap(bool)               map up / map down
 *
 * Everything else — buses, reverb, pools, the mixer — is reachable through
 * `getAudio()` for the settings screen and for the preview harness, and is not
 * something a gameplay system should be touching.
 *
 * `AudioSystem` is also exported directly, because `tools/audio/render.mjs`
 * builds one on an `OfflineAudioContext` to render and measure every sound in
 * this system. Nothing in the class knows or cares whether its context is
 * realtime; every method that schedules takes an explicit `now`.
 */

import type { AthleteState, GroundType } from '@/core/types';
import { Runnability } from '@/core/types';
import { Ambience } from './ambience';
import { Breathing } from './breathing';
import {
  AudioEngine,
  type AudioGraph,
  type BusName,
  type EnvironmentId,
} from './engine';
import { Footsteps } from './footsteps';
import { Mixer } from './mixer';
import { Music } from './music';
import { Punch, type PunchKind, type PunchOptions } from './sportident';
import { clamp, NoiseBank } from './synth';

export { AudioEngine, AudioGraph, BUS_NAMES } from './engine';
export type { BusName, EnvironmentId } from './engine';
export type { PunchKind, PunchOptions } from './sportident';
export type { ReverbId } from './synth';

/** Per-frame world context the athlete state does not carry. */
export interface AudioScene {
  ground?: GroundType;
  runnability?: Runnability;
  environment?: EnvironmentId;
  /** 0..1 — wind strength, from the weather state. */
  wind?: number;
  /** 0..1 — override the musical tension. Derived from stats if omitted. */
  tension?: number;
}

export interface AudioSystemOptions {
  seed?: number;
  /** Skip bell and cowbell rendering. Set on the `low` quality tier. */
  lean?: boolean;
}

/**
 * Everything, wired to one graph. Construct it with a realtime context for the
 * game or an `OfflineAudioContext` for verification; it does not know which.
 */
export class AudioSystem {
  readonly graph: AudioGraph;
  readonly bank: NoiseBank;
  readonly footsteps: Footsteps;
  readonly breathing: Breathing;
  readonly punch: Punch;
  readonly ambience: Ambience;
  readonly music: Music;
  readonly mixer: Mixer;

  private started = false;
  private ground: GroundType = 'needles';
  private runnability: Runnability = Runnability.ForestOpen;
  private environment: EnvironmentId = 'forest';

  constructor(graph: AudioGraph, opts: AudioSystemOptions = {}) {
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
      lean: opts.lean ?? false,
    });
    this.music = new Music(ctx, b.music.input, b.music.aux, seed + 5);
    this.mixer = new Mixer(graph);
  }

  /** Start the continuous voices. Idempotent. */
  start(when: number): void {
    if (this.started) return;
    this.started = true;
    this.breathing.start(when);
    this.ambience.start(when);
    this.music.start(when);
  }

  stop(when: number): void {
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
  update(now: number, dt: number, state: AthleteState, scene?: AudioScene): void {
    if (!this.started) return;
    if (scene?.ground) this.ground = scene.ground;
    if (scene?.runnability !== undefined) this.runnability = scene.runnability;
    if (scene?.environment && scene.environment !== this.environment) {
      this.setEnvironment(scene.environment, now);
    }
    if (scene?.wind !== undefined) this.ambience.setWind(scene.wind, now);

    const stats = state.stats;
    this.footsteps.update(now, dt, {
      ground: this.ground,
      speed: state.speed,
      runnability: this.runnability,
      glycogen: stats.glycogen,
    });
    this.breathing.update(now, dt, {
      glycogen: stats.glycogen,
      speed: state.speed,
      hydration: stats.hydration,
    });
    this.ambience.update(now, dt);

    // Tension: the athlete emptying out, and the athlete losing the map. Both
    // matter, and losing the map matters slightly less because it is
    // recoverable.
    const tension =
      scene?.tension ?? clamp(0.55 * (1 - stats.glycogen) + 0.45 * (1 - stats.focus), 0, 1);
    this.music.setTension(tension);
    this.music.update(now, dt);
  }

  setEnvironment(id: EnvironmentId, now: number, rampS = 2.5): void {
    this.environment = id;
    this.ambience.setEnvironment(id, now, rampS);
    this.graph.setReverb(this.ambience.reverb, rampS, now);
  }

  /** Fire a control punch. Returns the instant the beep starts, for the flash. */
  firePunch(now: number, kind: PunchKind = 'contact', opts?: PunchOptions): number {
    const at = now + 0.01;
    this.mixer.sidechain(at);
    return this.punch.fire(at, kind, opts);
  }

  duckForMap(on: boolean, now: number): void {
    this.mixer.duckForMap(on, now);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — what the game actually calls
// ---------------------------------------------------------------------------

export interface InitAudioOptions extends AudioSystemOptions {
  /** Start muted, e.g. because the player turned sound off last session. */
  muted?: boolean;
  /** Where to listen for the unlock gesture. Defaults to `window`. */
  gestureTarget?: EventTarget;
  /** Called once the context exists and the graph is live. */
  onReady?: (system: AudioSystem) => void;
}

let engine: AudioEngine | null = null;
let system: AudioSystem | null = null;

/**
 * Call once at boot. Returns immediately and creates no `AudioContext`: the
 * context appears on the first pointerdown / touchend / keydown anywhere in the
 * page, which is what every browser requires and what iOS Safari requires
 * strictly. Until then every function below is a safe no-op.
 */
export function initAudio(opts: InitAudioOptions = {}): void {
  if (engine) return;
  engine = new AudioEngine({
    ...(opts.gestureTarget ? { gestureTarget: opts.gestureTarget } : {}),
    onReady: (graph) => {
      const sys = new AudioSystem(graph, opts);
      sys.start(graph.ctx.currentTime + 0.05);
      system = sys;
      if (opts.muted) engine?.setMuted(true);
      opts.onReady?.(sys);
    },
  });
}

/** Force the unlock, e.g. from an explicit "enable sound" button. */
export async function unlockAudio(): Promise<boolean> {
  return (await engine?.unlock()) ?? false;
}

export function isAudioReady(): boolean {
  return system !== null;
}

/** The live system, for the settings screen and the preview harness. */
export function getAudio(): AudioSystem | null {
  return system;
}

/** One frame. Safe to call before the player has ever touched the screen. */
export function updateAudio(state: AthleteState, dt: number, scene?: AudioScene): void {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.update(e.now, dt, state, scene);
}

/** Punch a control. Returns the timeline instant of the beep, or 0. */
export function punch(kind: PunchKind = 'contact', opts?: PunchOptions): number {
  const sys = system;
  const e = engine;
  if (!sys || !e) return 0;
  return sys.firePunch(e.now, kind, opts);
}

export function setEnvironment(env: EnvironmentId, rampS = 2.5): void {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.setEnvironment(env, e.now, rampS);
}

export function duckForMap(on: boolean): void {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.duckForMap(on, e.now);
}

export function setMuted(muted: boolean): void {
  engine?.setMuted(muted);
}

export function isMuted(): boolean {
  return engine?.isMuted ?? false;
}

export function setBusGain(bus: BusName, value: number, rampS = 0.05): void {
  engine?.setBusGain(bus, value, rampS);
}

export function getBusGain(bus: BusName): number {
  return engine?.getBusGain(bus) ?? 0;
}

export function setMasterGain(value: number, rampS = 0.1): void {
  engine?.setMasterGain(value, rampS);
}

/** Ring the Vyšší Brod monastery bells — a race start, or a finish. */
export function ringBells(strikes = 9): void {
  const sys = system;
  const e = engine;
  if (!sys || !e) return;
  sys.ambience.ringBells(e.now + 0.1, strikes);
}

export function disposeAudio(): void {
  const e = engine;
  if (e && system) system.stop(e.now);
  e?.dispose();
  engine = null;
  system = null;
}
