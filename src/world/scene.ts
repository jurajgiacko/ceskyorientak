/**
 * The forest scene: assembles terrain, vegetation, sky and renderer, owns the
 * update loop, and publishes the frame-time monitor for the CI perf gate.
 *
 * `exposeForHarness` is called unconditionally once the first frame has run.
 * The gate in `tools/perf/budget.mjs` reads `window.__perf` and *skips* any
 * scene that does not expose it, which is why every scene has silently passed
 * until now — a skip is not a pass, and the gate cannot tell the difference.
 */

import * as THREE from 'three';
import type { Capabilities, QualityTier } from '@/core/capabilities';
import { exposeForHarness } from '@/core/perf';
import { getVenue } from '@/core/venues';
import type { VenueId } from '@/core/types';
import { TerrainField, TerrainMesh, findForestSpawn, pickHeroYaw } from './terrain';
import { createTerrainMaterial, loadDetailTextures, loadGroundTextures } from './materials';
import type { GroundTextures } from './materials';
import { WorldRenderer, makeFog } from './renderer';
import { GodRays, SkyRig, RACE_MORNING } from './sky';
import type { Weather } from './sky';
import { Vegetation, assertAssetSane, loadAsset } from './vegetation';
import type { Asset } from './vegetation';
import { RunnerCharacter } from './runner';
import type { RunnerIntent } from './runner';
import { SpringArm, THIRD_PITCH_MAX, THIRD_PITCH_MIN } from './thirdPerson';
import { Viewmodel } from './viewmodel';

/** First person is the original camera; third is the spring-arm chase camera. */
export type CameraMode = 'first' | 'third';

export interface ForestSceneOptions {
  canvas: HTMLCanvasElement;
  caps: Capabilities;
  venue?: VenueId;
  weather?: Weather;
  /** Benchmark mode: deterministic camera path, no input, for the perf gate. */
  bench?: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

/** Eye height of a running orienteer. The camera is a person, not a drone. */
const EYE_HEIGHT = 1.62;

export class ForestScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: WorldRenderer;

  private field!: TerrainField;
  private terrain!: TerrainMesh;
  private vegetation!: Vegetation;
  private sky!: SkyRig;
  private godRays: GodRays | null = null;
  private ground!: GroundTextures;

  private readonly tier: QualityTier;
  private readonly bench: boolean;
  private readonly weather: Weather;
  private readonly venueId: VenueId;

  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private exposed = false;
  private running = false;

  /** Warnings surfaced from asset validation — shown in the debug overlay. */
  readonly warnings: string[] = [];

  // Free-look state.
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.06;
  private spawn = new THREE.Vector2();
  private pointerLocked = false;

  /**
   * The first-person hands, map and thumb compass.
   *
   * This is the primary view: an orienteer races with the map in hand for the
   * whole course, and the map-reading mechanic is built on top of it.
   */
  private viewmodel!: Viewmodel;

  // Third-person state.
  private runner!: RunnerCharacter;
  private readonly arm = new SpringArm();
  private cameraMode: CameraMode = 'first';
  private readonly lastEye = new THREE.Vector3();
  private readonly intent: RunnerIntent = {
    dirX: 0,
    dirZ: 0,
    throttle: 0,
    sprint: false,
    reading: false,
  };
  private readonly feet = new THREE.Vector3();

  constructor(opts: ForestSceneOptions) {
    this.tier = opts.caps.tier;
    this.bench = opts.bench ?? false;
    this.weather = opts.weather ?? 'sunny';
    this.venueId = opts.venue ?? 'martinkov';

    this.camera = new THREE.PerspectiveCamera(
      // 46° vertical — about 28 mm full-frame at 16:9, which is where the
      // reference sits. The first pass used 62° and it was a clear mistake:
      // at that width the near ground swallows three quarters of the frame,
      // the trunks splay outward from centre, and the canopy that gives a
      // spruce stand its whole vertical character never gets into shot.
      46,
      1,
      0.15,
      1400,
    );
    this.renderer = new WorldRenderer({ canvas: opts.canvas, caps: opts.caps });
  }

  async load(onProgress?: (f: number, label: string) => void): Promise<void> {
    const step = (f: number, label: string) => onProgress?.(f, label);

    step(0.05, 'terrain');
    this.field = await TerrainField.load(this.venueId, this.tier);

    step(0.3, 'textures');
    this.ground = await loadGroundTextures(this.tier);

    // Must complete before loadAsset: the asset materials pick these up as they
    // are conditioned, and a texture pack that arrives late would silently do
    // nothing.
    await loadDetailTextures(this.tier);

    step(0.55, 'models');
    const [spruce, beech, boulder, deadwood] = await Promise.all([
      loadAsset('/models/spruce.glb', 'spruce'),
      loadAsset('/models/beech.glb', 'beech'),
      loadAsset('/models/boulder-set.glb', 'boulder'),
      loadAsset('/models/deadwood.glb', 'deadwood'),
    ]);

    // The spruce is mid-rework. Check its proportions rather than trusting them,
    // so a bad drop-in is a named warning instead of a forest that looks off for
    // no discoverable reason.
    this.warnings.push(
      ...assertAssetSane(spruce, { minHeightM: 4, maxHeightM: 45, maxAspect: 0.55 }),
      ...assertAssetSane(beech, { minHeightM: 3, maxHeightM: 42, maxAspect: 1.6 }),
    );
    for (const w of this.warnings) console.warn('[vegetation]', w);

    // The spawn is needed before `build` now, because the runner is constructed
    // standing on it. It is otherwise the same call in the same place.
    this.spawn = findForestSpawn(this.field);

    step(0.72, 'runner');
    this.runner = new RunnerCharacter({
      field: this.field,
      x: this.spawn.x,
      z: this.spawn.y,
      heading: 0,
    });
    // Awaited rather than fired and forgotten: a character that fades in three
    // seconds after the loading bar clears is worse than three more seconds of
    // loading bar, and the perf harness would otherwise measure a scene that
    // does not contain the thing this change added.
    await this.runner.load();
    this.warnings.push(...this.runner.warnings);
    for (const w of this.runner.warnings) console.warn('[runner]', w);

    step(0.76, 'hands');
    this.viewmodel = new Viewmodel();
    await this.viewmodel.load();
    this.warnings.push(...this.viewmodel.warnings);
    for (const w of this.viewmodel.warnings) console.warn('[hands]', w);

    step(0.8, 'world');
    this.build({ spruce, beech, boulder, deadwood });
    step(1, 'ready');
  }

  private build(assets: {
    spruce: Asset;
    beech: Asset;
    boulder: Asset;
    deadwood: Asset;
  }): void {
    const venue = getVenue(this.venueId);

    this.scene.fog = makeFog(this.weather);
    this.scene.background = new THREE.Color(
      (this.scene.fog as THREE.FogExp2).color.getHex(),
    );

    // --- sky and light ---
    this.sky = new SkyRig({
      weather: this.weather,
      tier: this.tier,
      latDeg: venue.origin.lat,
      lonDeg: venue.origin.lon,
      date: RACE_MORNING,
      shadowRadius: this.tier === 'low' ? 60 : 80,
    });
    this.scene.add(this.sky.group);

    // --- terrain ---
    const material = createTerrainMaterial(this.ground, this.tier);
    this.terrain = new TerrainMesh(this.field, material, {
      viewRadius: this.tier === 'low' ? 240 : 340,
    });
    this.scene.add(this.terrain.group);

    // --- vegetation ---
    this.vegetation = new Vegetation(this.field, assets, { tier: this.tier });
    // Trees are placed from a seeded scatter that does not know where the
    // player is, so without this the first frame is regularly the inside of a
    // spruce. A start clearing is also what a real arena looks like.
    this.vegetation.addExclusion(this.spawn.x, this.spawn.y, 9);
    this.scene.add(this.vegetation.group);

    this.camera.position.set(
      this.spawn.x,
      this.field.heightAt(this.spawn.x, this.spawn.y) + EYE_HEIGHT,
      this.spawn.y,
    );
    // Face into the sun where the terrain allows it. Forward is
    // (-sin yaw, 0, -cos yaw), so this is the heading that points along sunDir;
    // pickHeroYaw trades some of that alignment away when the sun happens to
    // sit behind a bank.
    const sunYaw = Math.atan2(-this.sky.sunDir.x, -this.sky.sunDir.z);
    this.yaw = pickHeroYaw(this.field, this.spawn, sunYaw);
    this.applyLook();

    // --- the athlete ---
    // Hidden in first person, so the default entry point looks exactly as it
    // did. In bench it is always on: the perf gate has to measure the skinned
    // draw, and a character that is only rendered in a mode CI never enters is
    // a cost nobody would see until a player did.
    this.runner.heading = this.yaw;
    this.runner.setVisible(this.bench);
    this.scene.add(this.runner.group);
    this.lastEye.copy(this.camera.position);

    // The viewmodel is authored in camera space, so it is a *child of the
    // camera*. That in turn means the camera has to be in the scene graph:
    // three renders the scene, and a camera outside it renders its own children
    // nowhere. This is the only reason `scene.add(camera)` is here.
    this.camera.add(this.viewmodel.group);
    this.scene.add(this.camera);

    // --- post ---
    if (this.tier !== 'low' && this.sky.isSunny) {
      // Strength is deliberately low. Shafts read as *atmosphere*; the moment
      // they read as a post-process the shot is lost, and at gain 1 the first
      // build put a white cone across half the frame.
      this.godRays = new GodRays(this.sky.sunDir, {
        scale: this.tier === 'high' ? 3 : 4,
        strength: 2.4,
      });
      this.renderer.effects.push(this.godRays);
    }

    // Prime a few frames' worth of chunks so the first frame is not an empty
    // world that fills in while the perf harness is already measuring.
    for (let i = 0; i < 200; i++) this.terrain.update(this.camera);
    this.vegetation.update(this.camera, 1);
    this.renderer.refreshShadows();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  attachInput(target: HTMLElement): void {
    if (this.bench) return;

    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
      if (down && e.code === 'KeyV' && !e.repeat) this.toggleCameraMode();
      if (down && (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'Space')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));

    target.addEventListener('click', () => {
      if (!this.pointerLocked) void target.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === target;
    });
    target.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = this.clampPitch(this.pitch - e.movementY * 0.0022);
      if (this.cameraMode === 'first') this.applyLook();
    });
  }

  /**
   * Pitch limits are per mode.
   *
   * First person keeps ±1.2 exactly as before. Third person is shallower: past
   * about 30° up the boom drives into the ground behind the athlete and the
   * collision has nowhere to put the camera, and past about 50° down it becomes
   * a top-down view of a head, which is not a camera anyone wants in a forest.
   */
  private clampPitch(p: number): number {
    return this.cameraMode === 'third'
      ? THREE.MathUtils.clamp(p, THIRD_PITCH_MIN, THIRD_PITCH_MAX)
      : THREE.MathUtils.clamp(p, -1.2, 1.2);
  }

  /** V. Also exposed on `window.__world` so the debug overlay can drive it. */
  toggleCameraMode(): CameraMode {
    return this.setCameraMode(this.cameraMode === 'first' ? 'third' : 'first');
  }

  setCameraMode(mode: CameraMode): CameraMode {
    if (mode === this.cameraMode) return mode;
    this.cameraMode = mode;
    this.pitch = this.clampPitch(this.pitch);
    if (mode === 'third') {
      // The boom has no history yet; without this it sweeps in from wherever
      // the first-person camera happened to be standing.
      this.arm.reset();
      this.runner.setVisible(true);
      // You cannot see your own hands from four metres behind your own back.
      this.viewmodel.setVisible(false);
    } else {
      // Hand the eye back to the body it was following, or the view jumps by
      // the length of the boom.
      this.camera.position.set(
        this.runner.position.x,
        this.field.heightAt(this.runner.position.x, this.runner.position.y) + EYE_HEIGHT,
        this.runner.position.y,
      );
      this.lastEye.copy(this.camera.position);
      this.runner.setVisible(this.bench);
      this.viewmodel.setVisible(true);
      this.applyLook();
    }
    return mode;
  }

  private applyLook(): void {
    this.camera.quaternion.setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'),
    );
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.elapsed += dt;
      this.frame(now, dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(now: number, dt: number): void {
    if (this.bench) {
      this.benchCamera();
      this.settleEye(dt);
      this.benchRunner(dt);
      this.viewmodel.update(dt, this.runner.speed, false, this.yaw, this.pitch);
    } else if (this.cameraMode === 'third') {
      this.thirdPersonStep(dt);
    } else {
      this.freeMove(dt);
      this.settleEye(dt);
      this.mirrorRunner(dt);
      // The hands run on the same speed the body does, and on the same M key
      // the third-person map pose uses. One athlete, two views of it.
      this.viewmodel.update(dt, this.runner.speed, this.keys.has('KeyM'), this.yaw, this.pitch);
    }

    this.terrain.update(this.camera);
    this.vegetation.update(this.camera, dt);
    if (this.sky.update(this.camera)) this.renderer.refreshShadows();

    this.renderer.render(this.scene, this.camera, now, dt);

    if (!this.exposed) {
      this.exposed = true;
      exposeForHarness(this.renderer.perf);
      (window as unknown as Record<string, unknown>).__world = this;
    }
  }

  /**
   * Keep the eye on the ground. This is also the first real customer of
   * TerrainField.sample — if the heightfield is wrong, the camera sinks.
   *
   * First person and bench only. In third person the spring arm owns the camera
   * position outright, and a second authority nudging `y` toward eye height
   * would fight it every frame.
   */
  private settleEye(dt: number): void {
    const ground = this.field.heightAt(this.camera.position.x, this.camera.position.z);
    this.camera.position.y += (ground + EYE_HEIGHT - this.camera.position.y) * Math.min(1, dt * 12);
  }

  // -------------------------------------------------------------------------
  // Third person
  // -------------------------------------------------------------------------

  /** Turn key state into a movement intent in world space. */
  private readIntent(): RunnerIntent {
    const i = this.intent;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    let dx = 0;
    let dz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      dx += fx;
      dz += fz;
    }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      dx -= fx;
      dz -= fz;
    }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
      dx -= rx;
      dz -= rz;
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
      dx += rx;
      dz += rz;
    }
    const len = Math.hypot(dx, dz);
    i.dirX = dx;
    i.dirZ = dz;
    i.throttle = len > 1e-3 ? 1 : 0;
    i.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    // M for map: the athlete slows and raises it. The clip exists whether or not
    // a map UI ever calls this.
    i.reading = this.keys.has('KeyM');
    return i;
  }

  private thirdPersonStep(dt: number): void {
    // Orbit with the same keys first person uses to look around, so the scene
    // stays inspectable without pointer lock.
    if (this.keys.has('KeyQ')) this.yaw += dt * 1.1;
    if (this.keys.has('KeyE')) this.yaw -= dt * 1.1;
    if (this.keys.has('KeyR')) this.pitch = this.clampPitch(this.pitch + dt * 0.9);
    if (this.keys.has('KeyF')) this.pitch = this.clampPitch(this.pitch - dt * 0.9);

    this.runner.update(dt, this.readIntent());
    this.feet.copy(this.runner.group.position);
    this.arm.update(
      this.camera,
      dt,
      this.feet,
      this.runner.heading,
      this.yaw,
      this.pitch,
      this.field,
      (x, z, r, out) => this.vegetation.collectObstacles(x, z, r, out),
    );
  }

  /**
   * First person: the camera moves, the (hidden) body follows it.
   *
   * The alternative — making the runner authoritative in both modes — would have
   * changed how first person feels, and the brief is explicit that first person
   * keeps working exactly as it does now. So the free-fly movement stays the
   * authority there and the athlete is reconciled to it, which is also what
   * makes toggling to third person instant rather than a snap across the
   * clearing.
   */
  private mirrorRunner(dt: number): void {
    const p = this.camera.position;
    const speed = dt > 0 ? Math.hypot(p.x - this.lastEye.x, p.z - this.lastEye.z) / dt : 0;
    this.lastEye.copy(p);
    this.runner.follow(p.x, p.z, this.yaw, Math.min(speed, 8), dt);
  }

  /**
   * Bench: run the athlete along in front of the deterministic camera path.
   *
   * The camera path itself is untouched, so the measurement is still comparable
   * with what it was measuring before — plus one skinned character, which is
   * the cost this change actually adds and the thing the gate should now see.
   */
  private benchRunner(dt: number): void {
    const p = this.camera.position;
    const x = p.x - Math.sin(this.yaw) * 3.2;
    const z = p.z - Math.cos(this.yaw) * 3.2;
    this.runner.follow(x, z, this.yaw, 4.2, dt);
  }

  /**
   * Deterministic benchmark path.
   *
   * A slow arc through the forest with a continuous pan, so the measurement
   * covers chunk streaming, LOD transitions and vegetation re-bucketing rather
   * than a static frame that any renderer can hold at 60 fps.
   */
  private benchCamera(): void {
    const t = this.elapsed * 0.12;
    const r = 55;
    const x = this.spawn.x + Math.cos(t) * r;
    const z = this.spawn.y + Math.sin(t * 0.83) * r;
    this.camera.position.x = x;
    this.camera.position.z = z;
    this.yaw = t * 0.7;
    this.pitch = Math.sin(this.elapsed * 0.21) * 0.14 - 0.05;
    this.applyLook();
  }

  private freeMove(dt: number): void {
    const speed = (this.keys.has('ShiftLeft') ? 14 : 4.2) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      this.camera.position.addScaledVector(forward, speed);
    }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      this.camera.position.addScaledVector(forward, -speed);
    }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
      this.camera.position.addScaledVector(right, -speed);
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
      this.camera.position.addScaledVector(right, speed);
    }
    // Arrow-key look, so the scene is inspectable without pointer lock.
    if (this.keys.has('KeyQ')) this.yaw += dt * 1.1;
    if (this.keys.has('KeyE')) this.yaw -= dt * 1.1;
    if (this.keys.has('KeyR')) this.pitch = Math.min(1.2, this.pitch + dt * 0.9);
    if (this.keys.has('KeyF')) this.pitch = Math.max(-1.2, this.pitch - dt * 0.9);
    this.applyLook();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * The held map's drawing surface — the seam for the race loop.
   *
   * `src/map/renderer.ts`'s `renderMap(ctx, w, h, options)` draws straight into
   * this canvas; call `markDirty()` afterwards and the texture on the map in the
   * athlete's hand updates. Nothing in `src/world/` knows what a course or a
   * believed position is, and it should not — this is the whole interface.
   *
   * Returns null before `load()` has run.
   */
  get mapSurface(): { canvas: HTMLCanvasElement; markDirty: () => void } | null {
    if (!this.viewmodel) return null;
    return {
      canvas: this.viewmodel.mapCanvas,
      markDirty: () => this.viewmodel.markMapDirty(),
    };
  }

  /** Live counters for the debug overlay and the perf report. */
  debugStats(): Record<string, string | number> {
    const s = this.renderer.perf.sample();
    return {
      tier: this.tier,
      weather: this.weather,
      camera: `${this.cameraMode} (V)`,
      hands: this.viewmodel
        ? `${this.viewmodel.pose}${this.viewmodel.isProxy ? ' PROXY' : ''}` +
          `${this.viewmodel.mapBound ? ' map:live' : ' map:UNBOUND'}`
        : '—',
      gait: this.runner ? `${this.runner.gait} ${this.runner.speed.toFixed(1)} m/s` : '—',
      boom: this.cameraMode === 'third'
        ? `${this.arm.length.toFixed(2)} m${this.arm.collided ? ' *' : ''}`
        : '—',
      fps: s.fps.toFixed(1),
      medianMs: s.medianMs.toFixed(2),
      p95Ms: s.p95Ms.toFixed(2),
      scale: this.renderer.adaptive.scale.toFixed(2),
      drawCalls: this.renderer.sceneCalls,
      triangles: this.renderer.sceneTriangles,
      terrainChunks: this.terrain.visibleCount,
      trees: this.vegetation.stats.trees,
      imposters: this.vegetation.stats.imposters,
      boulders: this.vegetation.stats.boulders,
      undergrowth: this.vegetation.stats.undergrowth,
      x: this.camera.position.x.toFixed(0),
      z: this.camera.position.z.toFixed(0),
      sunAltDeg: ((this.sky.angles.altitude * 180) / Math.PI).toFixed(1),
      sunAzDeg: ((this.sky.angles.azimuth * 180) / Math.PI).toFixed(1),
    };
  }

  dispose(): void {
    this.stop();
    this.viewmodel?.dispose();
    this.runner?.dispose();
    this.terrain?.dispose();
    this.vegetation?.dispose();
    this.sky?.dispose();
    this.ground?.dispose();
    this.renderer.dispose();
  }
}

/**
 * Convenience entry point used by the shell.
 */
export async function createForestScene(opts: ForestSceneOptions): Promise<ForestScene> {
  const scene = new ForestScene(opts);
  await scene.load(opts.onProgress);
  return scene;
}
