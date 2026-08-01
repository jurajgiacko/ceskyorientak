/**
 * The third-person runner: the athlete you see, and the locomotion that moves
 * them.
 *
 * Three things this file is deliberately careful about.
 *
 * **Speed comes from the sim, not from the keyboard.** `SPEED_BY_RUNNABILITY`
 * and `speedFactor` are imported from `src/sim/athlete.ts` and are the same
 * numbers the race model uses. A key press sets an *intent* (0..1, plus a
 * sprint flag); what the athlete actually does with that intent is the terrain's
 * decision. Running from white forest into dark green visibly slows the
 * character and drops the animation from `run` to `jog` without anything here
 * knowing what a keyboard is. If the numbers ever move in `sim/`, this moves
 * with them.
 *
 * **The animation is phase-locked, and the machinery is shared.** Clip blending
 * lives in `gait.ts`, which the first-person hands use too — if the hands were
 * driving at 180 spm while the legs under them ran at 165, the game would be
 * lying about its own athlete twice a second. See that file for why the two
 * locomotion clips share one phase and why that phase is `stepsPerSecond` from
 * the audio layer.
 *
 * **This is the secondary camera.** First person, with the map in hand, is the
 * sport's own view and the one the map-reading mechanic is built on. Third
 * person exists because it was asked for and because it is genuinely useful for
 * reading terrain shape, not because it is the primary way to play.
 */

import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { GroundType, TerrainSample } from '@/core/types';
import { Runnability } from '@/core/types';
import { SPEED_BY_RUNNABILITY, freshStats, speedFactor } from '@/sim/athlete';
import { GaitBlender } from './gait';
import type { GaitSlot } from './gait';
import { conditionCharacterMaterial } from './materials';
import type { TerrainField } from './terrain';
import { gltfLoader } from './vegetation';

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Flat-road speed at full effort, m/s. `SPEED_BY_RUNNABILITY[Road]` is 1.0, so
 * this is the number every other class is a fraction of: white forest at 0.8
 * gives 4.1 m/s, which is a 4:04/km elite forest pace and matches the winning
 * times the sim is anchored on.
 */
const BASE_SPEED_MS = 5.15;

/** Cruise effort when Shift is not held. A racing orienteer is not jogging. */
const CRUISE_EFFORT = 0.62;

/** Where the animation ladder sits, m/s. Below `IDLE` the athlete stands. */
const IDLE_SPEED = 0.25;
const JOG_SPEED = 2.6;
const RUN_SPEED = 4.4;

/**
 * Turn rate, rad/s, at a standstill and at race pace.
 *
 * Momentum is the point. A runner at 4.5 m/s cannot reverse in place, and a
 * character that can is the single clearest tell that there is no body under
 * the camera — it is what makes a third-person game feel like a floating
 * camera with a model attached to it.
 */
const TURN_RATE_SLOW = 5.4;
const TURN_RATE_FAST = 2.3;

/** Acceleration time constants, seconds. Slower to spin up than to shut down. */
const ACCEL_TAU = 0.42;
const DECEL_TAU = 0.26;

/**
 * How far the body rolls onto the terrain normal, 0..1.
 *
 * Not 1.0. A runner on a 20° sideslope does not stand perpendicular to it —
 * they stay roughly vertical and take the angle in their ankles. Full alignment
 * looks like a sticker on a hillside; zero alignment looks like the feet are
 * hovering. Half is where the contact reads without the pose going wrong.
 */
const PLANT_BLEND = 0.5;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** What the player is asking for. Not what the athlete gets. */
export interface RunnerIntent {
  /** Desired direction of travel in world space. Need not be normalised. */
  dirX: number;
  dirZ: number;
  /** 0..1. Zero means no movement key is held. */
  throttle: number;
  /** Race pace rather than cruise. */
  sprint: boolean;
  /** Slowing to read the map. */
  reading: boolean;
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  field: TerrainField;
  /** Where to stand at spawn, world metres. */
  x: number;
  z: number;
  /** Initial facing, in the camera's yaw convention (forward = -sin, -cos). */
  heading: number;
}

export class RunnerCharacter {
  /** Everything the character owns. Add this to the scene. */
  readonly group = new THREE.Group();

  /** Planimetric position, world metres. */
  readonly position = new THREE.Vector2();

  /**
   * Facing, radians, in the **camera's** yaw convention: forward is
   * `(-sin h, 0, -cos h)`. `AthleteState.heading` in `core/types.ts` is the
   * mirror of this (0 = north, clockwise positive), so anything crossing into
   * the sim or the terrain sampler goes through `simHeading`.
   */
  heading = 0;

  /** Ground speed, m/s. This is what drives the animation. */
  speed = 0;

  /** Terrain under the feet this frame. */
  sample: TerrainSample;

  /**
   * Called on each foot contact.
   *
   * **Nothing consumes this today, and that is the honest state of it.** The
   * forest scene has no audio system attached — `src/audio/index.ts` is not
   * imported anywhere under `src/world/`, so there is no `Footsteps` instance to
   * hand a strike to. Wiring one up is a separate change with its own decisions
   * (unlock-on-gesture, bus routing, reverb environment) and it would have been
   * a bad thing to bolt onto a camera commit.
   *
   * What is done here is the part that would otherwise be wrong later: the
   * animation's stride rate *is* `stepsPerSecond(speed)`, the same function
   * `Footsteps.update` runs its own accumulator on (see `gait.ts`). So when the
   * audio system is attached, the two are already in phase — either by calling
   * `Footsteps.trigger` from this callback, or by leaving `Footsteps.update`
   * running its own clock, which will agree with the feet because it is the same
   * clock. `foot` is 0 for left, 1 for right.
   */
  onFootstep: ((foot: 0 | 1, ground: GroundType, speed: number) => void) | null = null;

  /** Populated when the .glb could not be used. Surfaced in the debug overlay. */
  readonly warnings: string[] = [];

  private readonly field: TerrainField;
  private readonly stats = freshStats();

  private mixer: THREE.AnimationMixer | null = null;
  private gaitBlender: GaitBlender | null = null;
  private lastHeading = 0;
  private bank = 0;

  /** True when the visible body is the fallback proxy rather than the asset. */
  isProxy = true;

  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpNormal = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tiltQuat = new THREE.Quaternion();
  private readonly leanQuat = new THREE.Quaternion();
  private readonly bankQuat = new THREE.Quaternion();
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly axisZ = new THREE.Vector3(0, 0, 1);

  constructor(opts: RunnerOptions) {
    this.field = opts.field;
    this.position.set(opts.x, opts.z);
    this.heading = opts.heading;
    this.group.name = 'runner';
    this.sample = this.field.sample(opts.x, opts.z, -opts.heading);
    this.group.position.set(opts.x, this.sample.height, opts.z);
  }

  /** The sim's heading convention — see the note on `heading`. */
  get simHeading(): number {
    return -this.heading;
  }

  /** Current dominant clip, for the debug overlay. */
  get gait(): GaitSlot | 'none' {
    return this.gaitBlender ? this.gaitBlender.dominant : 'none';
  }

  // -------------------------------------------------------------------------
  // Asset
  // -------------------------------------------------------------------------

  /**
   * Load `orienteer.glb` and take its skeleton, mesh and clips.
   *
   * Not `loadAsset()` from vegetation.ts: that reduces a .glb to
   * `{ geometry, material }` pairs so they can be fed to `InstancedMesh`, which
   * is exactly right for forty thousand trees and throws away the skeleton, the
   * skin binding and the animation clips. A character needs the scene graph.
   *
   * A failure here is survivable by design. The camera, the locomotion and the
   * whole of this file are testable against a box figure, and shipping a broken
   * scene because one asset 404'd would be worse than shipping a visible
   * placeholder plus a warning in the overlay.
   */
  async load(url = '/models/orienteer.glb'): Promise<void> {
    let gltf: GLTF;
    try {
      gltf = await gltfLoader().loadAsync(url);
    } catch (err) {
      this.warnings.push(`orienteer: ${url} failed to load (${String(err)}) — using proxy figure`);
      this.buildProxy();
      return;
    }

    const root = gltf.scene;
    let meshes = 0;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      meshes++;
      obj.castShadow = true;
      obj.receiveShadow = true;
      // One object, always near the camera, and a SkinnedMesh's bounding volume
      // is the *rest pose* unless it is recomputed every frame. Culling against
      // a stale box is how a character disappears when it raises an arm.
      obj.frustumCulled = false;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const next = mats.map((m: THREE.Material) =>
        conditionCharacterMaterial(m, materialKind(m.name)),
      );
      obj.material = Array.isArray(obj.material) ? next : (next[0] as THREE.Material);
    });

    if (meshes === 0) {
      this.warnings.push(`orienteer: ${url} contained no meshes — using proxy figure`);
      this.buildProxy();
      return;
    }

    this.group.add(root);
    this.isProxy = false;

    // --- clips ---
    if (gltf.animations.length === 0) {
      this.warnings.push('orienteer: .glb carries no animation clips — the runner will not move');
      return;
    }
    this.mixer = new THREE.AnimationMixer(root);
    this.gaitBlender = new GaitBlender(this.mixer, gltf.animations, {
      clips: { idle: 'idle', jog: 'jog', run: 'run', special: 'map' },
      idleSpeed: IDLE_SPEED,
      jogSpeed: JOG_SPEED,
      runSpeed: RUN_SPEED,
    });
    this.gaitBlender.onContact = (foot) =>
      this.onFootstep?.(foot, this.sample.ground, this.speed);
    this.warnings.push(...this.gaitBlender.warnings.map((w) => `orienteer: ${w}`));
  }

  /**
   * A blocky stand-in, used only when the asset is unusable.
   *
   * Deliberately crude and deliberately orange. If this is ever on screen, the
   * asset pipeline has failed and that should be unmistakable rather than
   * something a reviewer squints at wondering whether the model is meant to
   * look like that.
   */
  private buildProxy(): void {
    const kit = new THREE.MeshStandardMaterial({ color: 0xd8541f, roughness: 0.9, metalness: 0 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a6a4a, roughness: 0.7, metalness: 0 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    };
    add(new THREE.BoxGeometry(0.42, 0.62, 0.24), kit, 0, 1.16, 0);
    add(new THREE.SphereGeometry(0.115, 12, 8), skin, 0, 1.62, 0);
    add(new THREE.BoxGeometry(0.13, 0.82, 0.15), skin, -0.13, 0.42, 0);
    add(new THREE.BoxGeometry(0.13, 0.82, 0.15), skin, 0.13, 0.42, 0);
    add(new THREE.BoxGeometry(0.1, 0.56, 0.11), skin, -0.29, 1.15, 0);
    add(new THREE.BoxGeometry(0.1, 0.56, 0.11), skin, 0.29, 1.15, 0);
    this.isProxy = true;
  }

  // -------------------------------------------------------------------------
  // Locomotion
  // -------------------------------------------------------------------------

  /**
   * Advance the athlete by one frame.
   *
   * Order matters: sample the terrain the athlete is standing on, decide what
   * speed that terrain allows, turn toward the intent at a rate the current
   * speed permits, integrate, then plant and pose. Turning before integrating is
   * what makes the character carve a corner instead of sliding round it.
   */
  update(dt: number, intent: RunnerIntent): void {
    const f = this.field;

    // --- what the terrain allows ---
    this.sample = f.sample(this.position.x, this.position.y, this.simHeading);
    const effort = intent.throttle * (intent.sprint ? 1 : CRUISE_EFFORT);
    const reading = intent.reading ? 0.35 : 1;

    let target =
      BASE_SPEED_MS *
      SPEED_BY_RUNNABILITY[this.sample.runnability] *
      slopeSpeedFactor(this.sample.slope) *
      speedFactor(this.stats) *
      effort *
      reading;

    // --- turn ---
    const wantLen = Math.hypot(intent.dirX, intent.dirZ);
    if (wantLen > 1e-3 && intent.throttle > 1e-3) {
      // Camera-space forward is (-sin h, -cos h), so the heading that points
      // along (dx, dz) is atan2(-dx, -dz).
      const wanted = Math.atan2(-intent.dirX / wantLen, -intent.dirZ / wantLen);
      let delta = wrapPi(wanted - this.heading);
      const rate = THREE.MathUtils.lerp(
        TURN_RATE_SLOW,
        TURN_RATE_FAST,
        THREE.MathUtils.clamp(this.speed / RUN_SPEED, 0, 1),
      );
      const step = rate * dt;
      const applied = THREE.MathUtils.clamp(delta, -step, step);
      this.heading = wrapPi(this.heading + applied);
      delta -= applied;
      // Facing away from where you want to go costs speed. Without this the
      // athlete circles at full pace, which looks like a car on rails.
      target *= THREE.MathUtils.lerp(0.28, 1, Math.max(0, Math.cos(delta)));
    } else {
      target = 0;
    }

    // --- accelerate ---
    const tau = target > this.speed ? ACCEL_TAU : DECEL_TAU;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / tau));
    if (this.speed < 1e-3) this.speed = 0;

    // --- integrate ---
    if (this.speed > 0) {
      const nx = this.position.x - Math.sin(this.heading) * this.speed * dt;
      const nz = this.position.y - Math.cos(this.heading) * this.speed * dt;
      // Impassable is a wall, not a slow patch: `SPEED_BY_RUNNABILITY` already
      // returns 0 for it, but that only stops the athlete *once they are in it*.
      // Testing the destination is what stops them entering.
      if (f.runnabilityAt(nx, nz) !== Runnability.Impassable) {
        this.position.set(
          THREE.MathUtils.clamp(nx, f.minX + 2, f.maxX - 2),
          THREE.MathUtils.clamp(nz, f.minZ + 2, f.maxZ - 2),
        );
      } else {
        this.speed *= 0.3;
      }
    }

    this.pose(dt);
    this.animate(dt, intent.reading);
  }

  /**
   * Mirror an externally-driven position onto the character.
   *
   * First person keeps its original free-fly movement untouched, so in that mode
   * the camera is the authority and the (hidden) body follows it. Without this
   * the two would diverge and toggling to third person would snap the athlete
   * across the clearing.
   */
  follow(x: number, z: number, heading: number, speed: number, dt: number): void {
    this.position.set(x, z);
    this.heading = heading;
    this.speed = speed;
    this.sample = this.field.sample(x, z, this.simHeading);
    this.pose(dt);
    this.animate(dt, false);
  }

  /** Plant on the surface, face the heading, lean into the slope. */
  private pose(dt: number): void {
    const f = this.field;
    const x = this.position.x;
    const z = this.position.y;
    this.group.position.set(x, this.sample.height, z);

    // Body axis: part-way from world up toward the surface normal.
    f.normalAt(x, z, this.tmpNormal);
    this.tmpNormal.lerp(this.tmpUp, 1 - PLANT_BLEND).normalize();
    this.tiltQuat.setFromUnitVectors(this.tmpUp, this.tmpNormal);

    this.tmpQuat.setFromAxisAngle(this.tmpUp, this.heading);
    this.tmpQuat.premultiply(this.tiltQuat);

    // Forward lean: uphill drives it, speed adds to it. `sample.slope` is
    // already the gradient *along the direction of travel*, which is the whole
    // reason it is computed that way — traversing a hillside is not climbing it,
    // and the athlete should not lean as if it were.
    const lean =
      THREE.MathUtils.clamp(this.sample.slope * 0.55, -0.16, 0.3) +
      (this.speed / RUN_SPEED) * 0.09;
    this.leanQuat.setFromAxisAngle(this.axisX, lean);
    this.tmpQuat.multiply(this.leanQuat);

    // A small inward bank while turning hard at speed. Capped low: this is the
    // body, not the camera, and the camera is never rolled at all.
    const turnRate = wrapPi(this.heading - this.lastHeading) / Math.max(dt, 1e-4);
    this.lastHeading = this.heading;
    this.bank += (THREE.MathUtils.clamp(turnRate * this.speed * 0.022, -0.13, 0.13) - this.bank) *
      Math.min(1, dt * 6);
    this.bankQuat.setFromAxisAngle(this.axisZ, this.bank);
    this.tmpQuat.multiply(this.bankQuat);

    this.group.quaternion.copy(this.tmpQuat);
  }

  /**
   * Blend the clips.
   *
   * The ladder is a function of `speed` only — never of key state. Running into
   * green slows the athlete and the animation drops to `jog` on its own, because
   * both are reading the same number. The machinery is in `gait.ts`.
   */
  private animate(dt: number, reading: boolean): void {
    this.gaitBlender?.update(dt, this.speed, reading);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Speed response to gradient.
 *
 * Not the inverse of the sim's *metabolic* slope cost, on purpose — climbing is
 * disproportionately expensive but only proportionally slow, and a gentle
 * descent is genuinely faster than the flat while a steep one is slower again
 * because you are braking. That last part is why this is not monotonic.
 */
function slopeSpeedFactor(slope: number): number {
  if (slope >= 0) return 1 / (1 + slope * 3.4);
  const down = -slope;
  // Peak assistance around 8 % downhill, gone by 30 %, braking below that.
  return down < 0.08 ? 1 + down * 1.4 : Math.max(0.55, 1.112 - (down - 0.08) * 1.5);
}

function wrapPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * Classify a character material by name.
 *
 * The .glb names its surfaces; this is the runtime half of that contract, the
 * same arrangement `spruce_bark` already has with `conditionAssetMaterial`.
 * Anything unrecognised falls to `kit`, which is the safe default — cloth.
 */
function materialKind(name: string): 'kit' | 'skin' | 'gear' {
  const n = name.toLowerCase();
  if (/skin|flesh|face|limb/.test(n)) return 'skin';
  // `si` has to be anchored. A bare substring test matches *singlet*, which is
  // cloth, and would have quietly put the athlete's vest on the SI-stick recipe.
  if (/shoe|sole|\bmap\b|si[-_]?(stick|unit|card)|control[-_]?card|strap|band/.test(n)) {
    return 'gear';
  }
  return 'kit';
}
