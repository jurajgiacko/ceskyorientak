/**
 * The first-person viewmodel: forearms, hands, the held map, the thumb compass.
 *
 * This is the sport's own posture, not a shooter's. An orienteer does not
 * *equip* a map — it is in the hand for the entire race, thumbed at the current
 * position, raised to read and dropped to run, and it never leaves. So there is
 * no draw animation, no holster and no equip state machine here: there is a
 * pose, and a blend between running with it low and reading it raised.
 *
 * ---------------------------------------------------------------------------
 * Why it is parented to the camera
 * ---------------------------------------------------------------------------
 * The asset is authored in camera space — origin at the eye, -Z forward — so
 * making the group a child of the camera means the arms are simply *there*, with
 * no per-frame transform to keep in sync. Two things fall out of that for free
 * and both are worth having:
 *
 *  - **Fog is correct and negligible.** The hands are half a metre away, so
 *    `FogExp2` contributes nothing, which is what you want. Positioning them in
 *    world space and hoping would have been an ongoing source of drift.
 *  - **The canopy light gate resolves at the camera's own position.** The hands
 *    are lit by the same `applyCanopyLight` field as the ground the player is
 *    standing on, so running from a glade into a closed stand darkens them along
 *    with everything else. A viewmodel that stays at full key while the world
 *    dims around it is the single loudest "this is a HUD element" tell there is.
 *
 * ---------------------------------------------------------------------------
 * The map surface is a contract, not a decoration
 * ---------------------------------------------------------------------------
 * The .glb carries a flat quad with UVs filling 0..1 under a material named
 * `map_face`. This file finds it by name and binds a `CanvasTexture` over a
 * canvas it owns and exposes. `src/map/renderer.ts`'s `renderMap(ctx, w, h, o)`
 * draws straight into that canvas, so what the player is holding is the actual
 * ISOM map with the actual course and the actual believed position on it — not
 * a picture of a map. See `mapCanvas` / `markMapDirty`.
 *
 * ---------------------------------------------------------------------------
 * It is deliberately not stabilised
 * ---------------------------------------------------------------------------
 * Bob and sway scale with speed and only *settle* when reading, they do not
 * stop. A map that is legible at a jog and a blur at a sprint is the central
 * tension of orienteering — you buy map contact with pace — and smoothing it out
 * would remove the mechanic while appearing to polish it.
 */

import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GaitBlender } from './gait';
import { conditionCharacterMaterial } from './materials';
import { gltfLoader } from './vegetation';

/** Material name in the .glb whose albedo is replaced by the live map canvas. */
const MAP_FACE_MATERIAL = 'map_face';

/**
 * Resolution of the in-hand map canvas.
 *
 * 768² and not more. The map plane is about 0.2 m across at ~0.45 m from the
 * eye, so at a 46° vertical FOV on a 1080-tall frame it covers roughly 500 px
 * even raised to read. 768 gives a little headroom for the read pose without
 * paying for a texture nobody can resolve — and this is redrawn by the race loop
 * whenever the athlete moves, so its cost is a per-frame cost, not a one-off.
 */
const MAP_TEXTURE_PX = 768;

/** Bob amplitudes at full sprint, metres. Scaled down by speed and by reading. */
const BOB_VERTICAL_M = 0.021;
const BOB_LATERAL_M = 0.014;

/** How much of the bob survives while reading. Not zero — see the header. */
const READ_SETTLE = 0.22;

/** Look-sway: how far the hands lag the camera, and how fast they catch up. */
const SWAY_GAIN = 0.055;
const SWAY_RATE = 9;
const SWAY_MAX = 0.11;

/**
 * A fixed translation applied to the whole viewmodel, in camera space.
 *
 * The trim between where an arm anatomically *is* and where it has to be to
 * appear in a 46° frame. The camera's vertical half-angle is 23°, so at 0.45 m
 * the visible frame is only 0.38 m tall — while a hand carried at chest height
 * sits 0.37 m below the eye, i.e. entirely below the bottom edge. Every
 * first-person game cheats this upward; naming the cheat and keeping it in one
 * constant is better than baking it into the asset's rest pose, where it would
 * be invisible and unadjustable without a Blender rebuild.
 *
 * Zero when the asset is authored to frame correctly on its own. It exists so a
 * few centimetres of drift in a re-export is a one-line fix here rather than a
 * pipeline round trip.
 */
const VIEWMODEL_ANCHOR = new THREE.Vector3(0, 0, 0);

export class Viewmodel {
  /**
   * The arms. **Add this as a child of the camera**, not of the scene — the
   * asset is authored in camera space and this file assumes it.
   */
  readonly group = new THREE.Group();

  /**
   * The canvas backing the held map's face.
   *
   * The seam for the race loop: call `renderMap(canvas.getContext('2d'), w, h,
   * options)` from `src/map/renderer.ts` and then `markMapDirty()`. Nothing here
   * knows what a course is, and it should not.
   */
  readonly mapCanvas: HTMLCanvasElement;

  /** Populated when the .glb could not be used. Surfaced in the debug overlay. */
  readonly warnings: string[] = [];

  /** True when the visible hands are the fallback proxy rather than the asset. */
  isProxy = true;

  private readonly mapTexture: THREE.CanvasTexture;
  private mixer: THREE.AnimationMixer | null = null;
  private gaitBlender: GaitBlender | null = null;
  private mapFaceBound = false;

  /** Smoothed bob/sway state. */
  private swayYaw = 0;
  private swayPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private primedLook = false;
  private readBlend = 0;
  private bobPhase = 0;

  private readonly baseOffset = new THREE.Vector3();

  /**
   * The proxy's map plane, if the proxy is in use.
   *
   * The proxy has no clips, so the raise-to-read has to be driven by hand. It is
   * kept because it makes the *seam* demonstrable before the asset lands: M
   * visibly brings the map up and the live canvas is on it, which is the part
   * the race loop plugs into. With the real asset this is null and the `read`
   * clip does the work.
   */
  private proxyMap: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'viewmodel';
    // Draw last within the opaque pass. This is an ordering hint only — it does
    // NOT make the arms immune to the depth buffer, and they are not.
    //
    // The honest limitation: first person has no body collision (it is the
    // original free-fly movement, deliberately unchanged), so a player can walk
    // into a trunk and the trunk will slice through the hands at ~0.3 m. The
    // usual fix is a second render pass with its own near plane, which means
    // touching the shared renderer and paying an extra clear + draw for a
    // handful of triangles. Not worth it for an artefact you have to walk into
    // a tree to see; if character collision lands, it stops happening at all.
    this.group.renderOrder = 10;

    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = MAP_TEXTURE_PX;
    this.mapCanvas.height = MAP_TEXTURE_PX;
    this.paintPlaceholderMap();

    this.mapTexture = new THREE.CanvasTexture(this.mapCanvas);
    this.mapTexture.colorSpace = THREE.SRGBColorSpace;
    this.mapTexture.anisotropy = 8;
    // The map is a flat sheet held at a shallow angle. Without anisotropic
    // filtering and a mip chain the fine ISOM linework aliases into noise the
    // moment it tilts away, which is exactly the range the player reads it in.
    this.mapTexture.generateMipmaps = true;
    this.mapTexture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /** Tell the renderer the map canvas has been redrawn. */
  markMapDirty(): void {
    this.mapTexture.needsUpdate = true;
  }

  /** True once the live canvas is actually bound to the asset's map face. */
  get mapBound(): boolean {
    return this.mapFaceBound;
  }

  /** Current clip, for the debug overlay. */
  get pose(): string {
    return this.gaitBlender ? this.gaitBlender.dominant : 'none';
  }

  // -------------------------------------------------------------------------
  // Asset
  // -------------------------------------------------------------------------

  async load(url = '/models/orienteer-hands.glb'): Promise<void> {
    let gltf: GLTF;
    try {
      gltf = await gltfLoader().loadAsync(url);
    } catch (err) {
      this.warnings.push(`hands: ${url} failed to load (${String(err)}) — using proxy`);
      this.buildProxy();
      return;
    }

    const root = gltf.scene;
    let meshes = 0;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      meshes++;
      // A viewmodel casting a shadow throws a pair of disembodied forearms onto
      // the ground in front of the player. It also receives nothing useful: it
      // is inside the camera's own shadow frustum bias.
      obj.castShadow = false;
      obj.receiveShadow = false;
      // A SkinnedMesh's bounds are the rest pose unless recomputed every frame,
      // and this one is 40 cm from the near plane. Culling it against a stale
      // box is how a hand disappears when it raises the map.
      obj.frustumCulled = false;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const next = mats.map((m: THREE.Material) => this.conditionMaterial(m));
      obj.material = Array.isArray(obj.material) ? next : (next[0] as THREE.Material);
    });

    if (meshes === 0) {
      this.warnings.push(`hands: ${url} contained no meshes — using proxy`);
      this.buildProxy();
      return;
    }

    this.group.add(root);
    this.isProxy = false;

    if (!this.mapFaceBound) {
      this.warnings.push(
        `hands: no material named '${MAP_FACE_MATERIAL}' in ${url} — the live map cannot be bound`,
      );
    }

    if (gltf.animations.length === 0) {
      this.warnings.push('hands: .glb carries no animation clips — the arms will not move');
      return;
    }
    this.mixer = new THREE.AnimationMixer(root);
    this.gaitBlender = new GaitBlender(this.mixer, gltf.animations, {
      clips: { idle: 'idle', jog: 'jog', run: 'run', special: 'read' },
    });
    this.warnings.push(...this.gaitBlender.warnings.map((w) => `hands: ${w}`));
  }

  /**
   * Bind the live canvas to the map face; condition everything else normally.
   *
   * Keyed on the material *name*, which is the same contract `spruce_bark`
   * already has with `conditionAssetMaterial`. The asset ships a placeholder
   * albedo so it looks right opened standalone; nothing renders that in game.
   */
  private conditionMaterial(mat: THREE.Material): THREE.Material {
    if (mat.name === MAP_FACE_MATERIAL && mat instanceof THREE.MeshStandardMaterial) {
      mat.map = this.mapTexture;
      // Paper. Flat, bright, and not lit like plastic — the base colour factor
      // is dropped to white so the canvas is what is seen rather than the
      // canvas times whatever tint the placeholder carried.
      mat.color.setScalar(1);
      mat.roughness = 0.94;
      mat.metalness = 0;
      // A held map is a self-lit-looking object in a dark forest because paper
      // is the highest-albedo thing in the scene by a wide margin. A little
      // emissive keeps it legible under a closed canopy without turning it into
      // a lamp — this is the one surface the player must be able to read.
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveMap = this.mapTexture;
      mat.emissiveIntensity = 0.28;
      mat.needsUpdate = true;
      this.mapFaceBound = true;
      return mat;
    }
    return conditionCharacterMaterial(mat, materialKind(mat.name));
  }

  /**
   * A crude stand-in, used only when the asset is unusable.
   *
   * Deliberately obvious. If this is on screen the asset pipeline has failed,
   * and that should be unmistakable rather than something a reviewer squints at
   * wondering whether the model is meant to look like that. It still carries a
   * map plane with the live texture on it, so the map seam stays testable when
   * the arms are not.
   */
  private buildProxy(): void {
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a6a4a, roughness: 0.68, metalness: 0 });
    // Placed against the frustum, not against anatomy. At 46° vertical the
    // frame is 0.38 m tall at 0.45 m, so a forearm carried where a real one
    // would be (0.37 m below the eye) is entirely below the bottom edge. See
    // `VIEWMODEL_ANCHOR`.
    const arm = (x: number, rot: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.3), skin);
      m.position.set(x, -0.175, -0.42);
      m.rotation.set(-0.42, rot, 0);
      m.castShadow = false;
      m.frustumCulled = false;
      this.group.add(m);
    };
    arm(-0.185, 0.2);
    arm(0.215, -0.2);

    const face = new THREE.MeshStandardMaterial({
      map: this.mapTexture,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: this.mapTexture,
      emissiveIntensity: 0.28,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const map = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.17), face);
    map.position.set(-0.185, -0.2, -0.5);
    map.rotation.set(-1.05, 0.42, 0.18);
    map.frustumCulled = false;
    this.group.add(map);
    this.proxyMap = map;
    this.mapFaceBound = true;
    this.isProxy = true;
  }

  /**
   * A neutral sheet, so the map reads as a map before a course exists.
   *
   * Not a fake map. Three contour-brown strokes and a fold crease on ISOM white
   * is enough for the object in the hand to be legible as paper; drawing
   * convincing fake terrain would risk someone mistaking the placeholder for the
   * real renderer's output, which is a much more expensive mistake than a plain
   * sheet.
   */
  private paintPlaceholderMap(): void {
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    const n = MAP_TEXTURE_PX;
    // ISOM 405 white is the runnable-forest symbol, so it is painted, not left
    // blank — the same reasoning as in map/renderer.ts.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, n, n);
    ctx.strokeStyle = '#d4a06a';
    ctx.lineWidth = n * 0.006;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const x = t * n;
        const y = n * (0.22 * i) + Math.sin(t * 5 + i) * n * 0.05;
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = n * 0.004;
    ctx.beginPath();
    ctx.moveTo(n * 0.5, 0);
    ctx.lineTo(n * 0.5, n);
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------

  /**
   * Advance the arms.
   *
   * @param speed   ground speed in m/s — the same number the body runs on
   * @param reading true while the athlete is bringing the map up
   * @param yaw     camera yaw, for look-sway
   * @param pitch   camera pitch, likewise
   */
  update(dt: number, speed: number, reading: boolean, yaw: number, pitch: number): void {
    this.readBlend += ((reading ? 1 : 0) - this.readBlend) * Math.min(1, dt / 0.3);
    this.gaitBlender?.update(dt, speed, reading);

    // --- bob ---
    // Driven from the same cadence the clips are, so the hands rise and fall
    // with the stride rather than on an independent sine that beats against it.
    const cadence = this.gaitBlender ? this.gaitBlender.phase : this.freeBob(dt, speed);
    this.bobPhase = cadence;

    // Amplitude is the mechanic. At a jog the map is steady enough to read; at a
    // sprint it is not, and that is the price of pace. Reading settles it to a
    // fifth — not to zero, see the header.
    const effort = THREE.MathUtils.clamp(speed / 4.4, 0, 1.15);
    const settle = THREE.MathUtils.lerp(1, READ_SETTLE, this.readBlend);
    const amp = effort * effort * settle;

    const theta = cadence * Math.PI * 2;
    // Vertical bob is at twice the stride frequency — one rise per *foot*, not
    // per cycle. Lateral is at the stride frequency, because the body sways to
    // whichever side is loaded.
    this.baseOffset.set(
      Math.sin(theta) * BOB_LATERAL_M * amp,
      Math.abs(Math.sin(theta)) * BOB_VERTICAL_M * amp - BOB_VERTICAL_M * 0.5 * amp,
      0,
    );

    // --- look sway ---
    // The arms have mass; they lag a fast look and catch up. Without it the
    // hands are welded to the frame and turning the head reads as the whole
    // world rotating around a decal.
    if (!this.primedLook) {
      this.primedLook = true;
      this.lastYaw = yaw;
      this.lastPitch = pitch;
    }
    const dYaw = wrapPi(yaw - this.lastYaw);
    const dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;

    const k = 1 - Math.exp(-SWAY_RATE * dt);
    const swayScale = SWAY_GAIN * (dt > 0 ? 1 / Math.max(dt, 1e-3) : 0) * settle;
    this.swayYaw += (THREE.MathUtils.clamp(dYaw * swayScale, -SWAY_MAX, SWAY_MAX) - this.swayYaw) * k;
    this.swayPitch +=
      (THREE.MathUtils.clamp(dPitch * swayScale, -SWAY_MAX, SWAY_MAX) - this.swayPitch) * k;

    // Proxy only: hand-driven raise-to-read, so the map seam is demonstrable
    // before the rigged asset exists.
    if (this.proxyMap) {
      const t = this.readBlend;
      this.proxyMap.position.set(
        THREE.MathUtils.lerp(-0.185, -0.045, t),
        THREE.MathUtils.lerp(-0.2, -0.075, t),
        THREE.MathUtils.lerp(-0.5, -0.52, t),
      );
      this.proxyMap.rotation.set(
        THREE.MathUtils.lerp(-1.05, -0.16, t),
        THREE.MathUtils.lerp(0.42, 0.06, t),
        THREE.MathUtils.lerp(0.18, 0.02, t),
      );
    }

    this.group.position.copy(this.baseOffset).add(VIEWMODEL_ANCHOR);
    this.group.rotation.set(
      this.swayPitch * 0.6,
      this.swayYaw,
      // A little roll from the lateral sway, so a hard turn banks the hands.
      -this.swayYaw * 0.35,
      'YXZ',
    );
  }

  /**
   * Bob phase for the case where there are no clips to take it from.
   *
   * Same cadence curve, so the proxy bobs at the rate the real arms would.
   */
  private freeBob(dt: number, speed: number): number {
    if (speed < 0.25) return this.bobPhase;
    // stepsPerSecond is imported by the blender; duplicating the constant here
    // would be the exact drift this module exists to prevent, so approximate it
    // only in the fallback path and say so.
    const cyclesPerSecond = (1.24 + speed * 0.42) / 2;
    return (this.bobPhase + cyclesPerSecond * dt) % 1;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.gaitBlender?.dispose();
    this.mixer = null;
    this.mapTexture.dispose();
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.group.clear();
  }
}

function wrapPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

/**
 * Classify a viewmodel material by name — the runtime half of the asset's
 * naming contract.
 */
function materialKind(name: string): 'kit' | 'skin' | 'gear' {
  const n = name.toLowerCase();
  if (/skin|flesh|hand|arm|thumb/.test(n)) return 'skin';
  // `si` has to be anchored: a bare substring test matches *singlet*.
  if (/compass|needle|si[-_]?(stick|unit|card)|control[-_]?card|strap|band|map/.test(n)) {
    return 'gear';
  }
  return 'kit';
}
