/**
 * The third-person spring arm.
 *
 * A boom anchored on the athlete's shoulders, pointing backwards along the
 * player's look direction, shortened until nothing is between the camera and the
 * character. Deliberately close to the *Mafia* / *Max Payne* lineage the brief
 * asks for rather than a modern over-the-shoulder shooter camera: the athlete
 * sits low and slightly left of centre, the boom is long enough to keep the
 * whole body and the ground it is running over in frame, and the pitch range
 * stays shallow, because in a forest the useful information is at eye level and
 * ahead, not overhead.
 *
 * Three things it does not do, each on purpose:
 *
 *  - **It never rolls.** The orientation is rebuilt every frame from yaw and
 *    pitch through a `YXZ` Euler, so roll is not damped toward zero — it is
 *    structurally absent, and no amount of accumulated float error can
 *    introduce it.
 *  - **It does not lag on collision.** The boom shortens in a single frame and
 *    lengthens with damping. Damping the shorten is the intuitive thing to do
 *    and it is wrong: a camera that eases *into* clearance has already spent
 *    several frames inside a trunk, which is precisely the artefact the
 *    collision exists to prevent.
 *  - **It does not raycast the scene graph.** Vegetation is instanced with
 *    `frustumCulled = false` and rewritten four times a second, so a
 *    `THREE.Raycaster` would walk tens of thousands of instances per frame.
 *    `Vegetation.collectObstacles` hands over the placements as plain numbers
 *    and the tests below are 2D circle intersections against them.
 */

import * as THREE from 'three';
import type { TerrainField } from './terrain';
import type { Obstacle } from './vegetation';

/** Boom length with nothing in the way, metres. */
const REST_LENGTH = 4.3;

/** Never come closer than this, or the near plane eats the athlete's head. */
const MIN_LENGTH = 1.15;

/** Treat the camera as a small sphere, so it stops short of a surface. */
const CAMERA_RADIUS = 0.32;

/** Boom anchor above the feet. Shoulder height, not eye height. */
const PIVOT_HEIGHT = 1.42;

/** Lateral offset of the anchor, metres. Positive is the athlete's right. */
const SHOULDER_OFFSET = 0.36;

/**
 * How hard the anchor chases the athlete, per axis, as an exponential rate.
 *
 * Split on purpose. Horizontally the camera should stay with the runner or the
 * whole thing feels like towing a barge, so 14 is nearly rigid. Vertically it
 * must not: the terrain is a 1 m raster over Šumava micro-relief and a rigid
 * vertical follow transmits every hummock straight into the frame as bob. 4.5
 * is slow enough to ride over the small stuff and quick enough that a real
 * slope does not leave the athlete climbing out of shot.
 */
const FOLLOW_RATE_XZ = 14;
const FOLLOW_RATE_Y = 4.5;

/** How fast the boom returns to rest after a collision clears, m/s. */
const EXTEND_SPEED = 4.5;

/** Pitch limits in third person. Shallower than first person's ±1.2 by design. */
export const THIRD_PITCH_MIN = -0.85;
export const THIRD_PITCH_MAX = 0.5;

export class SpringArm {
  /** Smoothed anchor point. Public so the debug overlay can read it. */
  readonly pivot = new THREE.Vector3();

  /** Current boom length after collision, metres. */
  length = REST_LENGTH;

  /** True while something is pushing the camera in. For the overlay. */
  collided = false;

  private primed = false;
  private readonly desiredPivot = new THREE.Vector3();
  private readonly boom = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly obstacles: Obstacle[] = [];

  /**
   * Place the camera for this frame.
   *
   * @param target  the athlete's ground position (feet), world metres
   * @param heading the athlete's facing, for the shoulder offset only
   * @param yaw     where the *player* is looking
   * @param pitch   likewise, already clamped by the caller
   */
  update(
    camera: THREE.PerspectiveCamera,
    dt: number,
    target: THREE.Vector3,
    heading: number,
    yaw: number,
    pitch: number,
    field: TerrainField,
    obstacleSource: ((x: number, z: number, r: number, out: Obstacle[]) => Obstacle[]) | null,
  ): void {
    // --- anchor ---
    // The shoulder offset follows the *body*, not the camera. Hanging it off the
    // camera yaw instead makes the athlete swing across the frame every time the
    // player looks around, which reads as the character sliding sideways.
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    this.desiredPivot.set(
      target.x + rightX * SHOULDER_OFFSET,
      target.y + PIVOT_HEIGHT,
      target.z + rightZ * SHOULDER_OFFSET,
    );

    if (!this.primed) {
      this.primed = true;
      this.pivot.copy(this.desiredPivot);
    } else {
      const kXZ = 1 - Math.exp(-FOLLOW_RATE_XZ * dt);
      const kY = 1 - Math.exp(-FOLLOW_RATE_Y * dt);
      this.pivot.x += (this.desiredPivot.x - this.pivot.x) * kXZ;
      this.pivot.z += (this.desiredPivot.z - this.pivot.z) * kXZ;
      this.pivot.y += (this.desiredPivot.y - this.pivot.y) * kY;
    }

    // --- boom direction ---
    // Look direction is the same convention as the first-person camera:
    // forward = (-sin yaw, 0, -cos yaw) tilted by pitch. The boom is its
    // opposite, so the camera sits behind the athlete and rises as the player
    // pitches down.
    const cp = Math.cos(pitch);
    this.boom.set(Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp).normalize();

    // --- how far it can extend ---
    let safe = REST_LENGTH;
    if (obstacleSource) {
      obstacleSource(this.pivot.x, this.pivot.z, REST_LENGTH + 2, this.obstacles);
      safe = Math.min(safe, this.trunkLimit(field));
    }
    safe = Math.min(safe, this.terrainLimit(field));
    safe = Math.max(MIN_LENGTH, safe);

    this.collided = safe < REST_LENGTH - 1e-3;

    // Shorten now, lengthen slowly. See the header.
    if (safe < this.length) this.length = safe;
    else this.length = Math.min(safe, this.length + EXTEND_SPEED * dt);

    camera.position.copy(this.pivot).addScaledVector(this.boom, this.length);

    // Last resort: even a correct boom can end up under a convex lip, because
    // the terrain march below samples discretely. One unconditional lift is
    // cheaper than densifying the march and cannot fail.
    const ground = field.heightAt(camera.position.x, camera.position.z) + 0.45;
    if (camera.position.y < ground) camera.position.y = ground;

    // Roll is absent by construction, not corrected. See the header.
    this.euler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
  }

  /**
   * Longest boom that keeps the camera sphere out of every nearby trunk.
   *
   * The tests are 2D. A vertical cylinder is a circle in plan, the boom is a
   * segment, and the only extra condition is that the camera is below the top of
   * the obstacle at the point where it would enter — which is what stops a
   * 0.9 m boulder pushing a camera that is sailing two metres over it.
   */
  private trunkLimit(field: TerrainField): number {
    let limit = REST_LENGTH;
    const ox = this.pivot.x;
    const oz = this.pivot.z;
    const dx = this.boom.x;
    const dz = this.boom.z;
    const dd = dx * dx + dz * dz;
    if (dd < 1e-6) return limit;

    for (const o of this.obstacles) {
      const r = o.radius + CAMERA_RADIUS;
      const fx = ox - o.x;
      const fz = oz - o.z;
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - r * r;
      if (c < 0) {
        // The anchor is already inside this circle's footprint — the athlete is
        // hugging the trunk. Backing out along the boom is not going to help,
        // so pull all the way in rather than picking a bogus root.
        const topHere = field.heightAt(o.x, o.z) + o.height;
        if (this.pivot.y < topHere) limit = Math.min(limit, MIN_LENGTH);
        continue;
      }
      const disc = b * b - 4 * dd * c;
      if (disc <= 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * dd);
      if (t <= 0 || t >= limit) continue;

      // Vertical test at the entry point.
      const y = this.pivot.y + this.boom.y * t;
      const top = field.heightAt(o.x, o.z) + o.height;
      if (y < top + CAMERA_RADIUS) limit = t;
    }
    return limit;
  }

  /**
   * Longest boom that stays above the ground.
   *
   * Marched rather than solved: the heightfield is a bilinear raster with no
   * closed form, and twelve samples over four metres resolves anything the 1 m
   * raster can express. Sampling from the far end inwards means the common case
   * (nothing in the way) exits on the first sample.
   */
  private terrainLimit(field: TerrainField): number {
    const STEPS = 12;
    for (let i = 0; i <= STEPS; i++) {
      const t = REST_LENGTH * (1 - i / STEPS);
      if (t < MIN_LENGTH) break;
      this.probe.copy(this.pivot).addScaledVector(this.boom, t);
      if (this.probe.y > field.heightAt(this.probe.x, this.probe.z) + 0.45) return t;
    }
    return MIN_LENGTH;
  }

  /** Drop the smoothing state, so the next frame snaps rather than sweeps. */
  reset(): void {
    this.primed = false;
    this.length = REST_LENGTH;
  }
}
