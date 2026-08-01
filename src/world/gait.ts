/**
 * Gait clip blending, shared by the first-person hands and the third-person
 * body.
 *
 * Two of them exist and they must not drift apart — if the hands are driving at
 * 180 spm while the legs under them are at 165, the game is lying about its own
 * athlete twice a second. So the phase logic lives here once.
 *
 * Three decisions are baked in, each of which is the fix for a specific way
 * this goes wrong.
 *
 * **Speed picks the clip, never key state.** `update` takes metres per second.
 * Running into dark green slows the athlete and the animation drops from `run`
 * to `jog` on its own, because both are reading the same number. Blending on
 * "is W held" instead gives you a full sprint animation while wading through a
 * thicket at 0.8 m/s.
 *
 * **The two locomotion clips share one phase.** They are held at `timeScale = 0`
 * and their `time` is written every frame from `phase`. Letting the mixer
 * advance them independently and cross-fading is the standard way to get a
 * four-legged mush during the blend: the cycles drift apart within a second and
 * the transition lands mid-stride on one and mid-flight on the other. One
 * phase, two clips, always foot-to-foot.
 *
 * **That phase is `stepsPerSecond` from the audio layer** — the function itself,
 * not a copy of it. It is the same cadence curve `Footsteps` runs its own
 * accumulator on (elite orienteers hold 170–185 spm on runnable ground and lose
 * far less cadence than speed in green; you shorten the stride, you do not slow
 * the legs). Importing it means the feet and the sound are locked by
 * construction rather than by tuning.
 */

import * as THREE from 'three';
import { stepsPerSecond } from '@/audio/footsteps';

export const GAIT_SLOTS = ['idle', 'jog', 'run', 'special'] as const;
export type GaitSlot = (typeof GAIT_SLOTS)[number];

export interface GaitOptions {
  /** Clip name in the .glb for each slot. Matched case-insensitively. */
  clips: Record<GaitSlot, string>;
  /** Below this the athlete is standing, m/s. */
  idleSpeed?: number;
  /** Speed at which `jog` is at full weight, m/s. */
  jogSpeed?: number;
  /** Speed at which `run` is at full weight, m/s. */
  runSpeed?: number;
  /**
   * Steps per cycle of the locomotion clips.
   *
   * The clips are authored as one full stride — left contact through right and
   * back to left — which is the near-universal convention. If a clip is ever
   * re-authored as a single step, this is the one number to change and playback
   * rate and footfall events both follow.
   */
  stepsPerCycle?: number;
  /**
   * Cycle fractions at which a foot is down.
   *
   * Stated as an assumption because it *is* one: the clip is authored to start
   * at left-foot contact, so contacts fall at 0 and 0.5. Nothing verifies it
   * from the .glb — glTF has no notion of a foot — so if the animation is
   * re-authored from a different start pose, the footfall events drift and this
   * is where the fix goes.
   */
  contactPhases?: readonly number[];
  /** Cross-fade time into and out of the `special` clip, seconds. */
  specialFadeS?: number;
}

export class GaitBlender {
  readonly weights: Record<GaitSlot, number> = { idle: 1, jog: 0, run: 0, special: 0 };

  /** Cycle position, 0..1. Shared by `jog` and `run`. */
  phase = 0;

  /** Fired on each foot contact. `foot` is 0 for left, 1 for right. */
  onContact: ((foot: 0 | 1) => void) | null = null;

  /** Clips that were asked for and not found. Surfaced in the debug overlay. */
  readonly warnings: string[] = [];

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<GaitSlot, THREE.AnimationAction>();
  private readonly opts: Required<GaitOptions>;
  private specialBlend = 0;
  private lastPhase = 0;

  constructor(mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[], opts: GaitOptions) {
    this.mixer = mixer;
    this.opts = {
      idleSpeed: 0.25,
      jogSpeed: 2.6,
      runSpeed: 4.4,
      stepsPerCycle: 2,
      contactPhases: [0, 0.5],
      specialFadeS: 0.35,
      ...opts,
    };

    for (const slot of GAIT_SLOTS) {
      const wanted = this.opts.clips[slot].toLowerCase();
      const clip =
        clips.find((c) => c.name.toLowerCase() === wanted) ??
        clips.find((c) => c.name.toLowerCase().includes(wanted));
      if (!clip) {
        this.warnings.push(`no '${this.opts.clips[slot]}' clip (slot ${slot})`);
        continue;
      }
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveWeight(slot === 'idle' ? 1 : 0);
      // Locomotion is driven from `phase`, so the mixer must not advance it.
      // `idle` and `special` are free-running — nothing has to line up under
      // them.
      action.timeScale = slot === 'jog' || slot === 'run' ? 0 : 1;
      action.play();
      this.actions.set(slot, action);
    }
  }

  /** The clip currently carrying most of the pose, for the debug overlay. */
  get dominant(): GaitSlot {
    let best: GaitSlot = 'idle';
    let bestW = -1;
    for (const slot of GAIT_SLOTS) {
      if (this.weights[slot] > bestW) {
        bestW = this.weights[slot];
        best = slot;
      }
    }
    return best;
  }

  /** How much of the pose the `special` clip is carrying, 0..1. */
  get specialWeight(): number {
    return this.specialBlend;
  }

  update(dt: number, speed: number, special: boolean): void {
    const o = this.opts;

    this.specialBlend +=
      ((special ? 1 : 0) - this.specialBlend) * Math.min(1, dt / o.specialFadeS);

    const locomotion = 1 - this.specialBlend;
    let wIdle: number;
    let wJog: number;
    let wRun: number;
    if (speed <= o.idleSpeed) {
      wIdle = 1;
      wJog = 0;
      wRun = 0;
    } else if (speed < o.jogSpeed) {
      const t = (speed - o.idleSpeed) / (o.jogSpeed - o.idleSpeed);
      wIdle = 1 - t;
      wJog = t;
      wRun = 0;
    } else {
      const t = THREE.MathUtils.clamp((speed - o.jogSpeed) / (o.runSpeed - o.jogSpeed), 0, 1);
      wIdle = 0;
      wJog = 1 - t;
      wRun = t;
    }
    this.weights.idle = wIdle * locomotion;
    this.weights.jog = wJog * locomotion;
    this.weights.run = wRun * locomotion;
    this.weights.special = this.specialBlend;

    // `stepsPerSecond` has a floor of 0.95 steps/s, which is right for audio (a
    // walking orienteer still lands) and wrong for someone standing still, so
    // the phase only advances while there is locomotion weight on it.
    const moving = wJog + wRun;
    if (moving > 0.001) {
      const cyclesPerSecond = stepsPerSecond(Math.max(speed, 0.2)) / o.stepsPerCycle;
      this.phase = (this.phase + cyclesPerSecond * dt) % 1;
      this.fireContacts(moving);
    }

    for (const slot of GAIT_SLOTS) {
      const action = this.actions.get(slot);
      if (!action) continue;
      action.setEffectiveWeight(this.weights[slot]);
      if (slot === 'jog' || slot === 'run') {
        action.time = this.phase * action.getClip().duration;
      }
    }

    this.mixer.update(dt);
  }

  private fireContacts(weight: number): void {
    if (!this.onContact) {
      this.lastPhase = this.phase;
      return;
    }
    const phases = this.opts.contactPhases;
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i] as number;
      const crossed =
        this.lastPhase <= this.phase
          ? this.lastPhase < p && this.phase >= p
          : this.lastPhase < p || this.phase >= p; // wrapped through 1
      if (crossed && weight > 0.05) this.onContact((i % 2) as 0 | 1);
    }
    this.lastPhase = this.phase;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.actions.clear();
  }
}
