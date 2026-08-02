/**
 * The Český Krumlov sprint scene.
 *
 * A sibling of `scene.ts`, not a mode of it. It shares the renderer, the sky
 * rig, the terrain streamer, the triplanar splat material and the asset loader;
 * it replaces the things that are genuinely venue-specific — the ground layer
 * set, the light model, the 08:00 sun, the fog, and the fact that the world is
 * made of buildings rather than trees.
 *
 * What this venue is, accurately: the **GAPP Czech O-Tour Prologue**, an
 * ISSprOM 2019-2 sprint at 1:4 000 with a 2 m contour interval. It is *not* a
 * World Cup race — the World Cup at Vyšší Brod is four forest races and has no
 * sprint at all (DECISIONS.md D-016.1). We build Krumlov because it is the
 * better showcase and a genuinely different discipline, and we say what it is.
 *
 * Sources, and what is not one:
 *   - Footprints, barriers, steps, trees — OpenStreetMap, ODbL 1.0.
 *   - Every elevation, including every building height — ČÚZK DMR 5G and
 *     DMP 1G, CC BY 4.0.
 *   - No Google Maps, Earth or Elevation data at any stage, including as a
 *     dev-time check. Their terms name this use case (D-016.4).
 */

import * as THREE from 'three';
import type { Capabilities, QualityTier } from '@/core/capabilities';
import { clearHarness, exposeForHarness } from '@/core/perf';
import { getVenue } from '@/core/venues';
import { Runnability } from '@/core/types';
import { TerrainField, TerrainMesh, TOWN_SPLAT } from './terrain';
import { createTerrainMaterial, loadGroundTextures, TOWN_GROUND } from './materials';
import type { GroundTextures } from './materials';
import { WorldRenderer, makeTownFog } from './renderer';
import { SkyRig, SPRINT_MORNING } from './sky';
import type { Weather } from './sky';
import { Buildings, loadSurface, loadTownscape } from './buildings';
import type { SurfaceTextures, TownscapeData } from './buildings';
import { Townscape } from './townscape';
import { Landmarks, KRUMLOV_LANDMARKS, KRUMLOV_OVERRIDES, KRUMLOV_SKIP } from './landmarks';
import { Vegetation, disposeAsset, loadAsset } from './vegetation';
import type { Asset } from './vegetation';
import { loadDetailTextures } from './materials';
import { BearingBand, aidColour } from './bearingBand';
import type { BearingAim } from './bearingBand';
import { ControlMarkers, loadControlAssets } from './controlMarkers';
import type { ControlMarker, ControlMarkerAssets, ControlMarkerState } from './controlMarkers';

export interface SprintSceneOptions {
  canvas: HTMLCanvasElement;
  caps: Capabilities;
  weather?: Weather;
  bench?: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

const EYE_HEIGHT = 1.62;

/**
 * The start, on Náměstí Svornosti.
 *
 * A sprint arena is in the town, not outside it, and this is where the O-Tour
 * prologue's own start is. It also happens to be the frame that answers the
 * recognisability test: from the middle of the square you are looking up Horní
 * at the castle rock with the painted tower over the roofline, which is the
 * view every photograph of Krumlov is taken from some version of.
 */
const START = { x: 1, z: 24 };

export class SprintScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: WorldRenderer;

  /** Public: the race controller samples it through a thin adapter. */
  field!: TerrainField;
  private terrain!: TerrainMesh;
  private sky!: SkyRig;
  private ground!: GroundTextures;
  private buildings!: Buildings;
  private town!: Townscape;
  private vegetation: Vegetation | null = null;
  private landmarks!: Landmarks;
  /** The beginner's bearing aid. Null until the world is built. */
  private bearing: BearingBand | null = null;
  private aim: BearingAim | null = null;
  /** The control flags, start kite and finish gantry. See `ForestScene`. */
  private markers: ControlMarkers | null = null;
  private controlAssets: ControlMarkerAssets | null = null;
  private data!: TownscapeData;
  private surfaces: SurfaceTextures[] = [];
  /** See the same field on `ForestScene` — held so `dispose` can release it. */
  private assets: Asset[] = [];
  /** See `ForestScene.inputDisposers`. */
  private readonly inputDisposers: (() => void)[] = [];

  private readonly tier: QualityTier;
  private readonly bench: boolean;
  private readonly weather: Weather;

  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private exposed = false;
  private running = false;

  /** See the same field on `ForestScene` — one defined place to step the race. */
  beforeFrame: ((dtS: number) => void) | null = null;
  private external: { x: number; z: number; yaw: number; pitch: number } | null = null;

  readonly warnings: string[] = [];

  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.02;
  private pointerLocked = false;
  /**
   * Collision and the ground clamp off, for inspecting the model. Toggled with
   * N, and also the hook QA uses to place the camera anywhere for a reference
   * frame — a scene you cannot get above is a scene you cannot check.
   */
  noclip = false;

  constructor(opts: SprintSceneOptions) {
    this.tier = opts.caps.tier;
    this.bench = opts.bench ?? false;
    this.weather = opts.weather ?? 'sunny';

    // Wider than the forest's 46°. A sprint is read at arm's length in a
    // street four metres across, and at 46° you cannot see both façades; the
    // sport's own visual field matters more here than the film reference does.
    this.camera = new THREE.PerspectiveCamera(56, 1, 0.12, 2200);
    this.renderer = new WorldRenderer({
      canvas: opts.canvas,
      caps: opts.caps,
      // See WorldRendererOptions.saturation. The forest's 0.74 turned the
      // terracotta to clay and the plaster to concrete.
      saturation: 0.94,
    });
  }

  async load(onProgress?: (f: number, label: string) => void): Promise<void> {
    const step = (f: number, label: string) => onProgress?.(f, label);

    step(0.05, 'terrain');
    this.field = await TerrainField.load('krumlov', this.tier);

    step(0.25, 'townscape');
    this.data = await loadTownscape('krumlov');

    step(0.4, 'textures');
    this.ground = await loadGroundTextures(this.tier, TOWN_GROUND);
    const [plaster, tile, stone] = await Promise.all([
      loadSurface('plaster-renaissance', this.tier, 8.5),
      loadSurface('roof-tile-bohemian', this.tier, 3.2),
      loadSurface('stone-wall-castle', this.tier, 3.0),
    ]);
    this.surfaces = [plaster, tile, stone];

    step(0.6, 'trees');
    // The wooded slopes above Latrán and inside the meander are 40 % of this
    // AOI's cells, and without them the town sits in a bare brown bowl. The
    // forest venue's scatter is reused wholesale — same assets, same
    // runnability-driven species mix — at much shorter radii, because here it
    // is scenery rather than the subject.
    await loadDetailTextures(this.tier);
    let assets: SlopeAssets | undefined;
    try {
      const [spruce, beech, boulder, deadwood] = await Promise.all([
        loadAsset('/models/spruce.glb', 'spruce'),
        loadAsset('/models/beech.glb', 'beech'),
        loadAsset('/models/boulder-set.glb', 'boulder'),
        loadAsset('/models/deadwood.glb', 'deadwood'),
      ]);
      assets = { spruce, beech, boulder, deadwood };
      this.assets = [spruce, beech, boulder, deadwood];
    } catch (err) {
      // A missing tree asset must not take the town down with it — the trees
      // are scenery here, unlike in the forest where they are the subject.
      this.warnings.push(`vegetation assets unavailable: ${String(err)}`);
    }

    step(0.7, 'controls');
    try {
      this.controlAssets = await loadControlAssets();
      const c = this.controlAssets;
      this.assets.push(c.flag, c.stand, c.si, c.gantry);
    } catch (err) {
      this.warnings.push(`control markers unavailable: ${String(err)}`);
    }

    step(0.8, 'buildings');
    this.build(plaster, tile, stone, assets);
    step(1, 'ready');
  }

  private build(
    plaster: SurfaceTextures,
    tile: SurfaceTextures,
    stone: SurfaceTextures,
    assets?: SlopeAssets,
  ): void {
    const venue = getVenue('krumlov');
    this.stampPaved();

    this.scene.fog = makeTownFog(this.weather);
    this.scene.background = new THREE.Color((this.scene.fog as THREE.FogExp2).color.getHex());

    // --- sky and light ---------------------------------------------------
    // 08:00 CEST. See SPRINT_MORNING: the sun is about 26° up and nearly due
    // east, which is what produces the long west-running shadows that give a
    // town its depth.
    this.sky = new SkyRig({
      weather: this.weather,
      tier: this.tier,
      latDeg: venue.origin.lat,
      lonDeg: venue.origin.lon,
      date: SPRINT_MORNING,
      // Wider than the forest's 80 m. A building casts a 40 m shadow at this
      // sun angle and the castle casts a 120 m one; a tight frustum would clip
      // the shadow off the object that most needs to cast it.
      shadowRadius: this.tier === 'low' ? 110 : 165,
      // The forest rig is calibrated against a shaded spruce floor at ~0.015
      // linear. Sunlit lime plaster is roughly forty times that, and carrying
      // the forest key over put every east façade into the AgX shoulder. These
      // are the town's own numbers.
      sunIntensity: this.weather === 'sunny' ? 3.5 : 0.5,
      hemiSky: 0x9fbcd8,
      // Bounce off cobble and plaster, not off warm needle litter.
      hemiGround: 0x8b8377,
      hemiIntensity: this.weather === 'sunny' ? 2.35 : 2.2,
      ambientColour: 0x3d4550,
      ambientIntensity: 0.35,
    });
    this.scene.add(this.sky.group);

    // --- terrain ---------------------------------------------------------
    const material = createTerrainMaterial(this.ground, this.tier, TOWN_GROUND);
    this.terrain = new TerrainMesh(this.field, material, {
      // The castle has to be visible from the square, 400 m away, so the
      // terrain ring is much larger than the forest's 340 m.
      viewRadius: this.tier === 'low' ? 420 : 640,
      splat: TOWN_SPLAT,
      buildBudget: 2,
    });
    this.scene.add(this.terrain.group);

    // --- buildings -------------------------------------------------------
    for (const b of this.data.buildings) {
      if (b.id === undefined) continue;
      const over = KRUMLOV_OVERRIDES.get(b.id);
      if (over) Object.assign(b, over);
    }
    this.buildings = new Buildings(this.data, this.field, plaster, tile, {
      tier: this.tier,
      skip: KRUMLOV_SKIP,
      // Deliberately not larger than the terrain ring: a building drawn where
      // no ground has been built yet floats in the fog, which reads as a bug.
      viewRadius: this.tier === 'low' ? 420 : 640,
    });
    this.scene.add(this.buildings.group);

    // --- walls, steps, river, street trees --------------------------------
    this.town = new Townscape(this.data, this.field, stone, {
      tier: this.tier,
      beech: assets?.beech,
    });
    this.scene.add(this.town.group);

    // --- the wooded slopes ------------------------------------------------
    if (assets) {
      this.vegetation = new Vegetation(this.field, assets, {
        tier: this.tier,
        nearRadius: this.tier === 'low' ? 40 : 75,
        farRadius: this.tier === 'low' ? 130 : 240,
        groundRadius: this.tier === 'low' ? 8 : 13,
        townFloor: true,
      });
      this.scene.add(this.vegetation.group);
    }

    // --- the five that have to be right ----------------------------------
    this.landmarks = new Landmarks(this.field, stone);
    this.scene.add(this.landmarks.group);

    // --- the beginner's bearing aid ---------------------------------------
    this.bearing = new BearingBand(this.field, aidColour());
    this.scene.add(this.bearing.group);

    // --- the control flags -------------------------------------------------
    if (this.controlAssets) {
      this.markers = new ControlMarkers(this.field, this.controlAssets);
      this.warnings.push(...this.markers.warnings);
      for (const w of this.markers.warnings) console.warn('[controls]', w);
      this.scene.add(this.markers.group);
    }

    // --- camera ----------------------------------------------------------
    this.camera.position.set(
      START.x,
      this.field.heightAt(START.x, START.z) + EYE_HEIGHT,
      START.z,
    );
    this.yaw = headingTo(START, KRUMLOV_LANDMARKS.castleTower);
    // A shade above level: the tower's cupola sits 55 m up and 190 m away, so
    // it is 16° above the eye line and a level camera cuts it off.
    this.pitch = 0.1;
    this.applyLook();

    // Prime the streamer so the first measured frame is a built world rather
    // than an empty one filling in.
    for (let i = 0; i < 700; i++) this.terrain.update(this.camera);
    this.buildings.update(this.camera);
    this.town.update(this.camera, 1);
    this.vegetation?.update(this.camera, 1);
    this.renderer.refreshShadows();
  }

  private stampedCells = 0;

  /**
   * Check that the shipped raster already carries what decides passability.
   *
   * It used to be *derived here*, at scene load: the OSM paved network, the
   * enclosed-square fill and the 1739 footprints were stamped into
   * `field.runnability` every time the venue opened. The barriers were never
   * stamped anywhere — 619 walls, city walls and railings existed only as
   * collision volumes — and the network stamp refused to paint over
   * `Impassable`, which severed **every bridge over the Vltava**.
   *
   * Both are now done once, offline, by `tools/terrain/townscape.mjs`, and this
   * is the only thing left: a check that it happened. That is D-002 taken
   * seriously — the map, the course generator and the collider read one raster,
   * and it is a build product rather than something three consumers each
   * reconstruct. `tools/ci/check-passable.mjs` gates it, and flood-fills the
   * venue with the runtime's own collision to prove the arena can reach it.
   *
   * The warning matters because the failure is silent and asymmetric:
   * `tools/terrain/build.mjs` writes a pristine raster, so regenerating the
   * terrain without re-running the townscape extractor puts the bridges back in
   * the river.
   */
  private stampPaved(): void {
    const stamped = this.data.stats?.stampedBuildings ?? 0;
    if (!this.data.rasterStamped) {
      this.warnings.push(
        'townscape.json predates raster stamping — run tools/terrain/townscape.mjs; ' +
          'walls will not be on the map and bridges will not cross',
      );
    }
    this.stampedCells =
      (this.data.stats?.stampedNetwork ?? 0) +
      (this.data.stats?.stampedSquares ?? 0) +
      (this.data.stats?.stampedBarriers ?? 0) +
      stamped;
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  /**
   * Is this point out of bounds?
   *
   * Three things make it so, and all three are IOF Rule 17.2 rather than
   * physics: ISSprOM 521 (every building), 515/518 (uncrossable wall, fence or
   * railing), and 301 (uncrossable water — the Vltava). In the forest these
   * would be a high traversal cost; in a sprint they are a binary fail state
   * and the geometry has to agree with the map about exactly where they are.
   */
  blockedAt(x: number, z: number): boolean {
    if (this.buildings.blocks.test(x, z)) return true;
    if (this.town.blocks.test(x, z)) return true;
    return this.field.runnabilityAt(x, z) === Runnability.Impassable;
  }

  /**
   * The sprint arena: Náměstí Svornosti, where the O-Tour prologue starts.
   * Course setting hangs the start and finish off this point.
   */
  get arena(): { x: number; z: number } {
    return { x: START.x, z: START.z };
  }

  /** Hand the camera to the race. See `ForestScene.setExternalPose`. */
  setExternalPose(x: number, z: number, yaw: number, pitch: number): void {
    this.external = { x, z, yaw, pitch };
  }

  /**
   * Aim the beginner's bearing band, or `null` to put it away.
   *
   * The scene knows nothing about controls; it is handed three points and
   * draws a corridor. Which points, and whether the aid is on at all, is the
   * race controller's business. See `BearingBand`.
   */
  setBearingAid(aim: BearingAim | null): void {
    this.aim = aim;
  }

  /** Put the course's flags on the ground. See `ForestScene.setCourseMarkers`. */
  setCourseMarkers(markers: readonly ControlMarker[]): void {
    this.markers?.setMarkers(markers);
  }

  setMarkerState(state: ControlMarkerState): void {
    this.markers?.setState(state);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  attachInput(target: HTMLElement): void {
    if (this.bench) return;

    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
      if (down && e.code === 'KeyN') this.noclip = !this.noclip;
      if (down && (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'Space')) {
        e.preventDefault();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => onKey(e, true);
    const onKeyUp = (e: KeyboardEvent) => onKey(e, false);
    const onClick = () => {
      if (!this.pointerLocked) void target.requestPointerLock();
    };
    const onPointerLock = () => {
      this.pointerLocked = document.pointerLockElement === target;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.2, 1.2);
      this.applyLook();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    target.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onPointerLock);
    target.addEventListener('mousemove', onMouseMove);

    this.inputDisposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('click', onClick);
      document.removeEventListener('pointerlockchange', onPointerLock);
      target.removeEventListener('mousemove', onMouseMove);
    });
  }

  private applyLook(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
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
    this.beforeFrame?.(dt);

    if (this.external) {
      this.camera.position.x = this.external.x;
      this.camera.position.z = this.external.z;
      this.yaw = this.external.yaw;
      this.pitch = this.external.pitch;
      this.applyLook();
    } else if (this.bench) this.benchCamera();
    else this.freeMove(dt);

    if (!this.noclip) {
      const ground = this.field.heightAt(this.camera.position.x, this.camera.position.z);
      this.camera.position.y +=
        (ground + EYE_HEIGHT - this.camera.position.y) * Math.min(1, dt * 12);
    }

    this.bearing?.update(this.aim, dt);
    this.markers?.update(this.camera, dt);

    this.terrain.update(this.camera);
    this.buildings.update(this.camera);
    this.town.update(this.camera, dt);
    this.vegetation?.update(this.camera, dt);
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
   * A slow circuit of the old town at rooftop height with a continuous pan, so
   * the measurement covers building-tile streaming, terrain LOD changes and the
   * shadow refresh rather than one static street. Deliberately above the eave
   * line: that is the worst case for this scene, because from up there almost
   * every tile is in frustum at once.
   */
  private benchCamera(): void {
    const t = this.elapsed * 0.14;
    const r = 130;
    const x = Math.cos(t) * r;
    const z = 20 + Math.sin(t * 0.81) * r * 0.7;
    this.camera.position.x = x;
    this.camera.position.z = z;
    this.yaw = t * 0.8 + Math.PI;
    this.pitch = Math.sin(this.elapsed * 0.23) * 0.12 + 0.02;
    this.applyLook();
  }

  private freeMove(dt: number): void {
    const speed = (this.keys.has('ShiftLeft') ? 16 : 4.6) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    let dx = 0;
    let dz = 0;
    const push = (v: THREE.Vector3, s: number) => {
      dx += v.x * s;
      dz += v.z * s;
    };
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) push(forward, speed);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) push(forward, -speed);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) push(right, -speed);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) push(right, speed);

    if (dx !== 0 || dz !== 0) {
      const p = this.camera.position;
      if (this.noclip) {
        p.x += dx;
        p.z += dz;
        if (this.keys.has('Space')) p.y += speed;
        if (this.keys.has('ControlLeft')) p.y -= speed;
      } else {
        // Slide along the obstacle rather than stopping dead. Running a wall
        // in a sprint is a normal thing to do and stopping on contact makes an
        // alley feel like a trap.
        if (!this.blockedAt(p.x + dx, p.z)) p.x += dx;
        if (!this.blockedAt(p.x, p.z + dz)) p.z += dz;
      }
    }

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

  debugStats(): Record<string, string | number> {
    const s = this.renderer.perf.sample();
    return {
      venue: 'krumlov',
      tier: this.tier,
      weather: this.weather,
      fps: s.fps.toFixed(1),
      medianMs: s.medianMs.toFixed(2),
      p95Ms: s.p95Ms.toFixed(2),
      scale: this.renderer.adaptive.scale.toFixed(2),
      drawCalls: this.renderer.sceneCalls,
      triangles: this.renderer.sceneTriangles,
      terrainChunks: this.terrain.visibleCount,
      buildings: this.buildings.stats.buildings,
      bldTiles: `${this.buildings.stats.visible}/${this.buildings.stats.tiles}`,
      bldTris: this.buildings.stats.triangles,
      walls: this.town.stats.walls,
      steps: this.town.stats.steps,
      streetTrees: this.town.stats.trees,
      slopeTrees: this.vegetation ? this.vegetation.stats.trees : 0,
      flags: this.markers
        ? `${this.markers.stats.drawn}/${this.markers.stats.markers}`
        : 'none',
      paved: this.stampedCells,
      landmarkTris: this.landmarks.stats.triangles,
      blockedHere: this.blockedAt(this.camera.position.x, this.camera.position.z) ? 'yes' : 'no',
      noclip: this.noclip ? 'on' : 'off',
      x: this.camera.position.x.toFixed(0),
      z: this.camera.position.z.toFixed(0),
      sunAltDeg: ((this.sky.angles.altitude * 180) / Math.PI).toFixed(1),
      sunAzDeg: ((this.sky.angles.azimuth * 180) / Math.PI).toFixed(1),
    };
  }

  /** See `ForestScene.dispose` — same contract, same ordering reason. */
  dispose(): void {
    this.stop();
    this.beforeFrame = null;
    this.external = null;
    this.aim = null;
    for (const d of this.inputDisposers) d();
    this.inputDisposers.length = 0;

    this.bearing?.dispose();
    this.bearing = null;
    this.markers?.dispose();
    this.markers = null;
    this.controlAssets = null;
    this.terrain?.dispose();
    this.buildings?.dispose();
    this.town?.dispose();
    this.vegetation?.dispose();
    this.landmarks?.dispose();
    this.sky?.dispose();
    this.ground?.dispose();
    for (const s of this.surfaces) s.dispose();
    this.surfaces = [];
    // The street trees on Latrán are instanced from the same `beech` asset the
    // slope scatter uses, so this must run after both `town` and `vegetation`
    // have let go of it. `disposeAsset` is idempotent regardless.
    for (const a of this.assets) disposeAsset(a);
    this.assets = [];

    this.scene.clear();
    this.scene.background = null;
    this.scene.fog = null;

    this.renderer.dispose();

    clearHarness();
    const w = window as unknown as Record<string, unknown>;
    if (w.__world === this) delete w.__world;
  }
}

/** Yaw that points the camera from `from` at `to`. Forward is (−sin, −cos). */
function headingTo(
  from: { x: number; z: number },
  to: { x: number; z: number },
): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

interface SlopeAssets {
  spruce: Asset;
  beech: Asset;
  boulder: Asset;
  deadwood: Asset;
}

export async function createSprintScene(opts: SprintSceneOptions): Promise<SprintScene> {
  const scene = new SprintScene(opts);
  await scene.load(opts.onProgress);
  return scene;
}
