/**
 * The control flags — the objects the whole game is about running to.
 *
 * In orienteering the flag *is* the goal. Everything else the player does —
 * reading the map, holding a bearing, picking an attack point — is in service
 * of seeing an orange-and-white kite hanging in the trees exactly where they
 * said it would be. Until this file existed the player navigated correctly,
 * arrived, and found empty forest.
 *
 * ---------------------------------------------------------------------------
 * Three rules are built in rather than left to discipline
 * ---------------------------------------------------------------------------
 *
 *  1. **It is 30 cm and it stays 30 cm.** A real IOF kite is 30 × 30 cm a side
 *     and hangs at about chest height, and the asset is modelled at exactly
 *     that. Nothing here scales it up to make it easier to find. An orienteer
 *     picks a flag up at 20–50 m in forest and much further in the open; if it
 *     is hard to see in thick green then the terrain is doing its job and the
 *     search is the sport. `SCALE` is 1 and there is no reason to change it.
 *
 *  2. **Only the flags that should be visible are drawn.** The caller supplies
 *     a visibility mask and this module obeys it without opinion. A player who
 *     can see control 7 from control 1 does not have a navigation problem to
 *     solve, and the game is a navigation game.
 *
 *  3. **It agrees with the map by construction.** Positions come from
 *     `Course.controls[].position` through the race controller — the same
 *     values `RaceMap` draws its circles from — so the flag cannot be
 *     somewhere the circle is not.
 *
 * ---------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------------
 *
 * A control is three separate assets hung together, and the numbers that join
 * them are published by the Blender pipeline in `public/models/manifest.json`
 * rather than guessed here:
 *
 *   control-stand   `flagHangZ` 1.2172 at `flagHangX` 0.16, `siMountZ` 0.85
 *   control-flag    `hookTopZ` 0.354 — hang it so the hook top meets flagHangZ
 *   si-unit         foot sits on siMountZ
 *
 * (The manifest is written in Blender's +Z-up frame; glTF export rotates it, so
 * every one of those Z values is a Y here. The constants below are named for
 * the axis they end up on.)
 *
 * Each piece is drawn with an `InstancedMesh` per material per LOD, so a
 * fifteen-control course costs a fixed handful of draw calls rather than one
 * per object. `assertGeometry` checks the pieces against those numbers at load
 * and warns rather than trusting them, because a re-exported asset that moved
 * its origin would otherwise hang the kite in mid-air with every gate green.
 */

import * as THREE from 'three';
import { loadAsset } from './vegetation';
import type { Asset, AssetVariant } from './vegetation';
import type { GroundSurface } from './surface';
import { t } from '@/i18n';

// ---------------------------------------------------------------------------
// The published assembly numbers
// ---------------------------------------------------------------------------

/** control-stand: where the flag's hook top has to land, metres above ground. */
const STAND_FLAG_HANG_Y = 1.2172;
/** control-stand: how far along the hanging arm, metres from the mast. */
const STAND_FLAG_HANG_X = 0.16;
/** control-flag: top of the hook above the fabric's bottom opening, metres. */
const FLAG_HOOK_TOP_Y = 0.354;
/** control-stand: where the SI unit's foot sits, metres above ground. */
const STAND_SI_MOUNT_Y = 0.85;
/**
 * Centre of the stand's SI bracket in X, metres.
 *
 * Measured off `control-stand_LOD0`: the `stand_plastic` cradle at y ≈ 0.85
 * runs x −0.132 … 0.023, and the unit is 0.145 long, so its centre goes at the
 * middle of the cradle. Not in the manifest, which gives the height only.
 */
const STAND_SI_MOUNT_X = -0.0545;
/** si-unit: the LED, in the unit's own frame. Where the punch flash sits. */
const SI_LED = new THREE.Vector3(0.0155, 0.0539, 0);
/** finish-gantry: half the span, metres. Used to sit both legs on the ground. */
const GANTRY_HALF_SPAN = 3.3;

/**
 * Scale applied to every marker. One, and it should stay one — see rule 1.
 *
 * Named rather than inlined so that anyone tempted to make the flags easier to
 * find has to read the sentence above first.
 */
const SCALE = 1;

/** LOD switch distances, metres. Beyond the last one the coarsest LOD is used. */
const LOD_SWITCH_M = [55, 140];

/** How long the punch flash lasts, seconds. Short — it is a beep with a light. */
const FLASH_S = 0.55;
/**
 * Diameter of the punch flash, start and end, metres.
 *
 * Both are much larger than an LED, and that is not decoration. The station
 * sits on the mast *behind* the kite — the flag hangs on the side the athlete
 * arrives from, which is the whole point of it — so the glow is depth-tested
 * away wherever the fabric covers it. Measured in the running scene: at 0.18 m
 * the flash was entirely behind a 0.31 m kite and invisible from the one angle
 * a player ever sees it from. At half a metre and up it spills round the flag,
 * which is what a light behind an object actually looks like.
 */
const FLASH_MIN_M = 0.5;
const FLASH_MAX_M = 1.4;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MarkerKind = 'start' | 'control' | 'finish';

/**
 * One thing to put on the ground.
 *
 * Deliberately says nothing about controls, codes or courses — this is a point,
 * a facing and a kind. What a control *is* belongs to `src/sim`, and the scene
 * that hosts this has no business knowing.
 */
export interface ControlMarker {
  kind: MarkerKind;
  x: number;
  z: number;
  /**
   * Where the athlete comes from, as a world position. The kite is hung on the
   * side of the mast that faces it, and the finish banner is squared across it.
   */
  from: { x: number; z: number };
}

export interface ControlMarkerState {
  /** One flag per marker, in the order they were given. */
  visible: readonly boolean[];
  /** Index just punched — non-null for exactly one frame, then null again. */
  punched: number | null;
  /**
   * Which markers are behind the athlete, in the same order.
   *
   * Distinct from `punched`, which is the *event* — one frame, a beep and a
   * light. This is the *state*, and it is the thing that was missing: a control
   * you have punched stays on the ground looking exactly like the one you are
   * hunting, so a player who comes back past it has no way to tell that it is
   * spent. Optional, because a scene given no array simply draws every flag
   * live, which is what it did before.
   */
  done?: readonly boolean[];
}

export interface ControlMarkerAssets {
  flag: Asset;
  stand: Asset;
  si: Asset;
  gantry: Asset;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Condition a control-furniture material.
 *
 * Not `conditionAssetMaterial`: that function's fallback branch hands any
 * untextured material the shared *bark* pack, which would wrap the control
 * flag in spruce bark. These surfaces are fabric, powder-coated steel and
 * moulded plastic and they carry their colour as a base factor, which is all
 * they need.
 */
function conditionMarkerMaterial(mat: THREE.Material): THREE.Material {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
  const m = mat;
  // glTF shares one material instance across every LOD that references it, so
  // `loadAsset`'s per-mesh traverse hands us the same material two or three
  // times. Most of what follows is idempotent; allocating the banner texture is
  // not — a second call would orphan the first canvas on the GPU. Same guard,
  // and the same reasoning, as `conditionAssetMaterial`.
  const state = m.userData as { markerConditioned?: boolean };
  if (state.markerConditioned) return m;
  state.markerConditioned = true;

  const name = m.name;

  if (name === 'flag_orange') {
    // The kite's orange is a design token, not a number in a .glb: `--c-flag`
    // exists in base.css precisely because the flag is a physical object with
    // its own IOF colour, distinct from the event orange.
    m.color.copy(flagColour());
    m.roughness = 0.86;
    m.metalness = 0;
    // Nylon flag fabric, seen from both sides as it turns in the wind.
    m.side = THREE.DoubleSide;
  } else if (name === 'flag_white') {
    m.roughness = 0.86;
    m.metalness = 0;
    m.side = THREE.DoubleSide;
  } else if (name === 'si_led') {
    // A live station's LED is on, faintly, before anyone punches it. Emissive
    // rather than a bright base colour so it reads as a light at 2 m and as
    // nothing at all at 40 m, which is what an indicator LED does.
    m.emissive.copy(m.color);
    m.emissiveIntensity = 1.4;
    m.roughness = 0.4;
    m.metalness = 0;
  } else if (name === 'BRAND_BANNER') {
    // The gantry's banner. The manifest declares this material's UV island
    // fills 0..1, which is the whole contract — the pipeline authored a place
    // to put a word and this is the word.
    m.map = makeBannerTexture();
    // The base factor is a near-white the print would be multiplied down by.
    m.color.setRGB(1, 1, 1);
    m.roughness = 0.9;
    m.metalness = 0;
    // Printed both sides, as a real finish banner is.
    m.side = THREE.DoubleSide;
  } else if (/steel|hook|plate/.test(name)) {
    m.roughness = 0.52;
    m.metalness = 0.55;
  } else {
    m.roughness = 0.78;
    m.metalness = 0;
  }
  m.envMapIntensity = 0.75;
  return m;
}

/**
 * A design token as a three.js colour.
 *
 * Same contract as `aidColour()` in bearingBand.ts: the value lives in
 * base.css with every other colour in the project, and the literal here is a
 * boot-order fallback rather than a second definition.
 */
function token(name: string, fallback: string): THREE.Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const col = new THREE.Color();
  try {
    col.setStyle(raw || fallback, THREE.SRGBColorSpace);
  } catch {
    col.setStyle(fallback, THREE.SRGBColorSpace);
  }
  return col;
}

function flagColour(): THREE.Color {
  return token('--c-flag', '#f25c19');
}

/**
 * What a punched control is multiplied by.
 *
 * A *tint*, not a colour: three multiplies the material's own diffuse by the
 * instance colour, so this darkens and slightly cools everything the marker is
 * made of — the kite, the mast, the station — rather than repainting any of it.
 * That is the right treatment for "spent": the flag is still an IOF kite, still
 * orange, still 30 cm, and still exactly where the map says it is. It has just
 * stopped being the thing you are looking for.
 *
 * Repainting it some other hue was the alternative and it is wrong twice over.
 * The kite's orange is a specification, and a second flag colour in the terrain
 * would teach a beginner that orange-and-white means something conditional.
 */
function spentColour(): THREE.Color {
  return token('--c-spent', '#9aa39c');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadControlAssets(): Promise<ControlMarkerAssets> {
  const [flag, stand, si, gantry] = await Promise.all([
    loadAsset('/models/control-flag.glb', 'control-flag', conditionMarkerMaterial),
    loadAsset('/models/control-stand.glb', 'control-stand', conditionMarkerMaterial),
    loadAsset('/models/si-unit.glb', 'si-unit', conditionMarkerMaterial),
    loadAsset('/models/finish-gantry.glb', 'finish-gantry', conditionMarkerMaterial),
  ]);
  return { flag, stand, si, gantry };
}

/**
 * Check the pieces against the numbers this file assembles them with.
 *
 * A re-exported asset that moved its origin, or a kite scaled to "make it
 * easier to see", produces a control that looks subtly wrong in a way nobody
 * would trace back to the .glb. Warnings, not throws: a mis-hung flag is still
 * better than no flag.
 */
export function assertGeometry(assets: ControlMarkerAssets): string[] {
  const out: string[] = [];
  const check = (label: string, got: number, want: number, tol: number): void => {
    if (Math.abs(got - want) > tol) {
      out.push(`${label}: ${got.toFixed(3)} m, expected ${want.toFixed(3)} m`);
    }
  };
  const v = (a: Asset): AssetVariant | undefined => a.variants[0];
  const flag = v(assets.flag);
  const stand = v(assets.stand);
  const si = v(assets.si);
  if (flag) {
    check('control-flag height', flag.heightM, FLAG_HOOK_TOP_Y, 0.02);
    // The kite is 30 cm a side by specification. Anything else is not a kite.
    check('control-flag width', flag.radiusM * 2, 0.31, 0.03);
  }
  if (stand) check('control-stand height', stand.heightM, 1.2555, 0.03);
  if (si) check('si-unit height', si.heightM, 0.052, 0.01);
  return out;
}

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------

type Lod = AssetVariant['lods'][number];

/**
 * One asset, instanced, with a LOD ladder.
 *
 * The same shape as `Vegetation`'s `Bucket` and for the same reason, with one
 * difference that matters here: an empty level sets `visible = false` rather
 * than leaving a zero-count draw in the render list. A course has fifteen
 * markers and at most a handful are on screen, so most levels are empty most
 * of the time and three.js should not walk them at all.
 */
class Instanced {
  private readonly levels: { meshes: THREE.InstancedMesh[]; count: number }[] = [];

  constructor(parent: THREE.Object3D, variant: AssetVariant, capacity: number) {
    for (const lod of variant.lods as Lod[]) {
      const meshes: THREE.InstancedMesh[] = [];
      for (const part of lod.parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Per-instance tint, which is how a punched control reads as spent
        // without a second material or a second draw call. three multiplies
        // the material's diffuse by this in the fragment shader; setting the
        // attribute at all is what switches that on, so it is allocated here
        // and left at white for everything that has not been punched.
        //
        // Deliberately *not* a custom shader. `bearingBand.ts` states the rule
        // and this file's own flash texture follows it: a shader that fails to
        // compile makes geometry vanish while every gate stays green, and this
        // project has shipped that twice. `instanceColor` is stock three.
        im.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(capacity * 3).fill(1),
          3,
        );
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = true;
        im.receiveShadow = true;
        // Instances are scattered over the whole course, so the mesh's own
        // bounding sphere describes none of them and per-mesh culling would
        // remove flags that are on screen.
        im.frustumCulled = false;
        im.count = 0;
        im.visible = false;
        meshes.push(im);
        parent.add(im);
      }
      this.levels.push({ meshes, count: 0 });
    }
  }

  reset(): void {
    for (const l of this.levels) l.count = 0;
  }

  push(lod: number, matrix: THREE.Matrix4, tint: THREE.Color): void {
    const level = this.levels[Math.min(lod, this.levels.length - 1)];
    if (!level) return;
    const first = level.meshes[0];
    if (!first || level.count >= first.instanceMatrix.count) return;
    for (const m of level.meshes) {
      m.setMatrixAt(level.count, matrix);
      m.setColorAt(level.count, tint);
    }
    level.count++;
  }

  flush(): void {
    for (const l of this.levels) {
      for (const m of l.meshes) {
        m.count = l.count;
        m.visible = l.count > 0;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  }

  dispose(parent: THREE.Object3D): void {
    for (const l of this.levels) {
      for (const m of l.meshes) {
        parent.remove(m);
        m.dispose();
      }
    }
    this.levels.length = 0;
  }
}

// ---------------------------------------------------------------------------
// The markers
// ---------------------------------------------------------------------------

interface Placed {
  kind: MarkerKind;
  x: number;
  z: number;
  stand: THREE.Matrix4 | null;
  flag: THREE.Matrix4 | null;
  si: THREE.Matrix4 | null;
  gantry: THREE.Matrix4 | null;
  /** Where the punch flash goes: the SI unit's LED, in world space. */
  led: THREE.Vector3;
}

export class ControlMarkers {
  readonly group = new THREE.Group();
  readonly warnings: string[] = [];

  private readonly field: GroundSurface;
  private readonly assets: ControlMarkerAssets;

  private stand: Instanced | null = null;
  private flag: Instanced | null = null;
  private si: Instanced | null = null;
  private gantry: Instanced | null = null;

  private placed: Placed[] = [];
  private visible: readonly boolean[] = [];
  private done: readonly boolean[] = [];

  /** Per-instance tints: live is white (no change), spent is the token below. */
  private readonly liveTint = new THREE.Color(1, 1, 1);
  private readonly spentTint = new THREE.Color(1, 1, 1);

  /** The punch flash: one additive billboard, hidden except for half a second. */
  private readonly flash: THREE.Mesh;
  private readonly flashMaterial: THREE.MeshBasicMaterial;
  private flashLeft = 0;

  private readonly camPos = new THREE.Vector3();

  /** Live counts for the debug overlay. */
  readonly stats = { markers: 0, drawn: 0 };

  constructor(field: GroundSurface, assets: ControlMarkerAssets) {
    this.field = field;
    this.assets = assets;
    this.group.name = 'controlMarkers';
    this.warnings.push(...assertGeometry(assets));
    this.spentTint.copy(spentColour());

    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: token('--c-lime', '#d0ec34'),
      map: makeFlashTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Not tone-mapped: this is a light being emitted at the camera, not a
      // surface being lit, and grading it with the scene mutes the one frame
      // it exists for.
      toneMapped: false,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMaterial);
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 4;
    this.flash.visible = false;
    this.group.add(this.flash);
  }

  /**
   * Lay the course out. Called once, when a race is set up.
   *
   * Everything expensive — the terrain sampling, the trigonometry, the piece
   * offsets — happens here, so the per-frame job is a distance test and a
   * matrix copy per visible marker.
   */
  setMarkers(markers: readonly ControlMarker[]): void {
    this.buildBuckets(markers.length);
    this.placed = markers.map((m) => this.place(m));
    this.visible = markers.map(() => false);
    this.done = markers.map(() => false);
    this.stats.markers = this.placed.length;
    this.flashLeft = 0;
    this.flash.visible = false;
  }

  /** Which markers are drawn this frame, and whether one has just been punched. */
  setState(state: ControlMarkerState): void {
    this.visible = state.visible;
    this.done = state.done ?? this.done;
    const i = state.punched;
    if (i !== null && i >= 0 && i < this.placed.length) {
      this.flashLeft = FLASH_S;
      this.flash.position.copy(this.placed[i]!.led);
    }
  }

  /**
   * Re-bucket by distance and animate the flash.
   *
   * A course has at most a couple of dozen markers, so this walks all of them
   * every frame rather than maintaining a spatial index — the index would cost
   * more to keep than the loop costs to run.
   */
  update(camera: THREE.Camera, dtS: number): void {
    this.stand?.reset();
    this.flag?.reset();
    this.si?.reset();
    this.gantry?.reset();

    camera.getWorldPosition(this.camPos);
    let drawn = 0;

    for (let i = 0; i < this.placed.length; i++) {
      if (!this.visible[i]) continue;
      const p = this.placed[i]!;
      const d = Math.hypot(p.x - this.camPos.x, p.z - this.camPos.z);
      let lod = 0;
      while (lod < LOD_SWITCH_M.length && d > LOD_SWITCH_M[lod]!) lod++;
      drawn++;

      const tint = this.done[i] ? this.spentTint : this.liveTint;
      if (p.stand) this.stand?.push(lod, p.stand, tint);
      if (p.flag) this.flag?.push(lod, p.flag, tint);
      if (p.si) this.si?.push(lod, p.si, tint);
      if (p.gantry) this.gantry?.push(lod, p.gantry, tint);
    }
    this.stats.drawn = drawn;

    this.stand?.flush();
    this.flag?.flush();
    this.si?.flush();
    this.gantry?.flush();

    this.updateFlash(camera, dtS);
  }

  /**
   * The punch, made visible.
   *
   * SIAC punching is touch-free — you run within range, the card beeps and the
   * station's light answers it. There is nothing to press and nothing to aim
   * at, so if the world says nothing the player has no way to know a punch
   * happened at all. This grows out of the LED and fades, on the same frame as
   * the beep (`RaceController` fires both from one branch).
   */
  private updateFlash(camera: THREE.Camera, dtS: number): void {
    if (this.flashLeft <= 0) {
      if (this.flash.visible) {
        this.flash.visible = false;
        this.flashMaterial.opacity = 0;
      }
      return;
    }
    this.flashLeft = Math.max(0, this.flashLeft - dtS);
    const t = 1 - this.flashLeft / FLASH_S;
    // Snaps on and eases away: hardware, not a UI animation.
    const size = FLASH_MIN_M + (FLASH_MAX_M - FLASH_MIN_M) * Math.sqrt(t);
    this.flash.scale.setScalar(size);
    this.flashMaterial.opacity = (1 - t) * (1 - t);
    this.flash.quaternion.copy(camera.quaternion);
    this.flash.visible = true;
  }

  private buildBuckets(capacity: number): void {
    this.releaseBuckets();
    if (capacity <= 0) return;
    const v = (a: Asset): AssetVariant | undefined => a.variants[0];
    const flag = v(this.assets.flag);
    const stand = v(this.assets.stand);
    const si = v(this.assets.si);
    const gantry = v(this.assets.gantry);
    if (stand) this.stand = new Instanced(this.group, stand, capacity);
    if (flag) this.flag = new Instanced(this.group, flag, capacity);
    if (si) this.si = new Instanced(this.group, si, capacity);
    // One finish, but the ladder is the same code path.
    if (gantry) this.gantry = new Instanced(this.group, gantry, capacity);
  }

  private releaseBuckets(): void {
    this.stand?.dispose(this.group);
    this.flag?.dispose(this.group);
    this.si?.dispose(this.group);
    this.gantry?.dispose(this.group);
    this.stand = null;
    this.flag = null;
    this.si = null;
    this.gantry = null;
  }

  /** Turn one marker into the matrices its pieces are drawn with. */
  private place(m: ControlMarker): Placed {
    const y = this.field.heightAt(m.x, m.z);
    // The mast's +X carries the hanging arm, so pointing it back down the leg
    // puts the kite between the mast and the athlete: you see the fabric, not
    // the pole in front of it.
    const dx = m.from.x - m.x;
    const dz = m.from.z - m.z;
    const yaw = Math.hypot(dx, dz) > 1e-3 ? Math.atan2(-dz, dx) : 0;

    const out: Placed = {
      kind: m.kind,
      x: m.x,
      z: m.z,
      stand: null,
      flag: null,
      si: null,
      gantry: null,
      led: new THREE.Vector3(m.x, y + STAND_SI_MOUNT_Y + SI_LED.y, m.z),
    };

    if (m.kind === 'finish') {
      // The gantry's arch runs along its own +X, so it is squared *across* the
      // run-in rather than along it — a finish you run through, not past.
      const across = yaw + Math.PI / 2;
      // Both feet on the ground: on a slope the lower one would otherwise
      // float, and a floating gantry is the most obvious artefact there is.
      const lx = Math.cos(across) * GANTRY_HALF_SPAN;
      const lz = -Math.sin(across) * GANTRY_HALF_SPAN;
      const foot = Math.min(
        y,
        this.field.heightAt(m.x + lx, m.z + lz),
        this.field.heightAt(m.x - lx, m.z - lz),
      );
      out.gantry = new THREE.Matrix4().compose(
        new THREE.Vector3(m.x, foot, m.z),
        new THREE.Quaternion().setFromAxisAngle(UP, across),
        new THREE.Vector3(SCALE, SCALE, SCALE),
      );
      out.led.set(m.x, foot + 1, m.z);
      return out;
    }

    const base = new THREE.Matrix4().compose(
      new THREE.Vector3(m.x, y, m.z),
      new THREE.Quaternion().setFromAxisAngle(UP, yaw),
      new THREE.Vector3(SCALE, SCALE, SCALE),
    );
    out.stand = base.clone();
    out.flag = base
      .clone()
      .multiply(offset(STAND_FLAG_HANG_X, STAND_FLAG_HANG_Y - FLAG_HOOK_TOP_Y, 0));
    out.si = base.clone().multiply(offset(STAND_SI_MOUNT_X, STAND_SI_MOUNT_Y, 0));
    // The LED in world space, for the flash. Same transform, applied by hand
    // because a Matrix4 is not a point.
    out.led
      .set(STAND_SI_MOUNT_X + SI_LED.x, STAND_SI_MOUNT_Y + SI_LED.y, SI_LED.z)
      .applyMatrix4(base);
    return out;
  }

  dispose(): void {
    this.releaseBuckets();
    this.flash.geometry.dispose();
    this.flashMaterial.map?.dispose();
    this.flashMaterial.dispose();
    this.group.clear();
    this.placed = [];
    this.visible = [];
    this.done = [];
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function offset(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

/**
 * The finish banner's print.
 *
 * The word is the only user-visible string this module draws, so it comes from
 * `src/i18n` like every other one — a Czech player runs through CÍL and an
 * English one through FINISH. Aspect matches the banner's 5.6 × 1.1 m island.
 *
 * `flipY = false` because the geometry's UVs are glTF's: v = 0 is the *top* of
 * the island, which is also row 0 of a canvas. Leaving three's default on would
 * print the word upside down.
 */
function makeBannerTexture(): THREE.Texture {
  const W = 1024;
  const H = 200;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;

  const paint = (): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = css('--c-event', '#fe5900');
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = css('--c-paper', '#f4f1e8');
    ctx.fillRect(0, 0, W, 10);
    ctx.fillRect(0, H - 10, W, 10);
    ctx.font = `700 108px 'Space Grotesk', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '18px';
    ctx.fillText(t('race.finish').toUpperCase(), W / 2, H / 2 + 6);
    tex.needsUpdate = true;
  };
  paint();
  // The UI webfont may still be loading when the scene builds. Repaint once it
  // is there rather than shipping a banner set in the fallback face.
  void document.fonts?.ready.then(paint).catch(() => undefined);
  return tex;
}

/** A design token as a CSS colour string, for canvas work. */
function css(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * The flash's falloff, baked into a small texture.
 *
 * A texture rather than a custom shader, for the reason stated at length in
 * `bearingBand.ts`: a shader that fails to compile makes geometry vanish while
 * every gate stays green, and this project has shipped that twice.
 */
function makeFlashTexture(): THREE.Texture {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(S, S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = (i + 0.5) / S - 0.5;
      const v = (j + 0.5) / S - 0.5;
      const r = Math.hypot(u, v) * 2;
      // A hot core with a soft halo — an LED seen from a few metres, not a
      // smooth blob.
      const core = Math.max(0, 1 - r / 0.34);
      const halo = Math.max(0, 1 - r);
      const a = Math.min(1, core * core + halo * halo * halo * 0.55);
      const k = (j * S + i) * 4;
      img.data[k] = 255;
      img.data[k + 1] = 255;
      img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
