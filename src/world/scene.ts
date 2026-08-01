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

    // --- camera ---
    // The venue origin is now chosen from the raster and is deep forest, so this
    // normally returns something within a chunk or two of (0,0). Kept as a
    // safety net for a future origin that lands badly — see terrain.ts.
    this.spawn = findForestSpawn(this.field);

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
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.2, 1.2);
      this.applyLook();
    });
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
    if (this.bench) this.benchCamera();
    else this.freeMove(dt);

    // Keep the eye on the ground. This is also the first real customer of
    // TerrainField.sample — if the heightfield is wrong, the camera sinks.
    const ground = this.field.heightAt(this.camera.position.x, this.camera.position.z);
    this.camera.position.y += (ground + EYE_HEIGHT - this.camera.position.y) * Math.min(1, dt * 12);

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

  /** Live counters for the debug overlay and the perf report. */
  debugStats(): Record<string, string | number> {
    const s = this.renderer.perf.sample();
    return {
      tier: this.tier,
      weather: this.weather,
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
