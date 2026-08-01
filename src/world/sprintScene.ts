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
import { exposeForHarness } from '@/core/perf';
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
import { Vegetation, loadAsset } from './vegetation';
import type { Asset } from './vegetation';
import { loadDetailTextures } from './materials';

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
  private data!: TownscapeData;
  private surfaces: SurfaceTextures[] = [];

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
    } catch (err) {
      // A missing tree asset must not take the town down with it — the trees
      // are scenery here, unlike in the forest where they are the subject.
      this.warnings.push(`vegetation assets unavailable: ${String(err)}`);
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
      });
      this.scene.add(this.vegetation.group);
    }

    // --- the five that have to be right ----------------------------------
    this.landmarks = new Landmarks(this.field, stone);
    this.scene.add(this.landmarks.group);

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
   * Burn the OSM paved network into the runnability raster.
   *
   * The raster was built from ZABAGED's `street` polygon layer, which stops at
   * the carriageway. That left Náměstí Svornosti, the alleys off Latrán and the
   * whole castle ramp classified as *open land* — i.e. grass, in the one town
   * whose entire surface is sett paving, and grass is what the first build
   * rendered on the main square.
   *
   * OSM has the full network (1654 ways carried through against ZABAGED's 643
   * street features), so it is stamped in here, at load, over the classes that
   * can legitimately be paved. The guard list matters: a footpath crossing a
   * river polygon must not turn the Vltava into a road, and a bridge over the
   * ravine must not fill the ravine in.
   *
   * This belongs in `tools/terrain/build.mjs` eventually, so that the 2D map
   * renderer sees the same surface the runner does — D-002 is explicit that map
   * and physics share one enum, and doing it at scene load means only the 3D
   * world currently knows. Recorded rather than hidden.
   */
  private stampPaved(): void {
    const m = this.field.rMeta;
    const r = this.field.runnability;
    let stamped = 0;

    const paintable = (v: number): boolean =>
      v === Runnability.OpenFast ||
      v === Runnability.OpenRough ||
      v === Runnability.ForestOpen ||
      v === Runnability.Green1 ||
      v === Runnability.Green2 ||
      v === Runnability.Green3 ||
      v === Runnability.Path;

    for (const way of this.data.paved ?? []) {
      const cls = way.k === 1 ? Runnability.Path : Runnability.Road;
      const half = Math.max(0.8, way.w * 0.5);
      const n = way.l.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const ax = way.l[i * 2] as number;
        const az = way.l[i * 2 + 1] as number;
        const bx = way.l[i * 2 + 2] as number;
        const bz = way.l[i * 2 + 3] as number;
        const minX = Math.min(ax, bx) - half;
        const maxX = Math.max(ax, bx) + half;
        const minZ = Math.min(az, bz) - half;
        const maxZ = Math.max(az, bz) + half;
        const i0 = Math.max(0, Math.floor((minX - m.originX) / m.resM));
        const i1 = Math.min(m.width - 1, Math.ceil((maxX - m.originX) / m.resM));
        const j0 = Math.max(0, Math.floor((minZ - m.originZ) / m.resM));
        const j1 = Math.min(m.height - 1, Math.ceil((maxZ - m.originZ) / m.resM));
        const dx = bx - ax;
        const dz = bz - az;
        const len2 = dx * dx + dz * dz;
        for (let j = j0; j <= j1; j++) {
          const wz = m.originZ + j * m.resM;
          for (let i = i0; i <= i1; i++) {
            const wx = m.originX + i * m.resM;
            let t = len2 > 1e-9 ? ((wx - ax) * dx + (wz - az) * dz) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t - wx;
            const pz = az + dz * t - wz;
            if (px * px + pz * pz > half * half) continue;
            const k = j * m.width + i;
            if (!paintable(r[k] as number)) continue;
            r[k] = cls;
            stamped++;
          }
        }
      }
    }
    this.stampedCells = stamped + this.fillPavedHoles() + this.stampBuildings();
  }

  /**
   * Stamp the OSM footprints into the raster as `Impassable`.
   *
   * Two jobs, one pass. It makes the raster agree with ISSprOM 521 — every
   * building is out of bounds, so no cell inside one should ever be classified
   * runnable — and it stops the vegetation scatter from planting spruce inside
   * courtyards and through walls, because `MIX[Impassable].density` is zero.
   * That second effect is not a side benefit, it is why this exists: the first
   * build had a mature spruce growing out of a house on Latrán.
   *
   * ZABAGED already had 1549 building polygons here; OSM has 1739 and they are
   * more current. Dilated by one cell so a trunk cannot end up flush against
   * plaster.
   */
  private stampBuildings(): number {
    const m = this.field.rMeta;
    const r = this.field.runnability;
    const marked: number[] = [];

    for (const b of this.data.buildings) {
      const p = b.p;
      const n = p.length / 2;
      if (n < 3) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = p[i * 2] as number;
        const z = p[i * 2 + 1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const i0 = Math.max(0, Math.floor((minX - m.originX) / m.resM));
      const i1 = Math.min(m.width - 1, Math.ceil((maxX - m.originX) / m.resM));
      const j0 = Math.max(0, Math.floor((minZ - m.originZ) / m.resM));
      const j1 = Math.min(m.height - 1, Math.ceil((maxZ - m.originZ) / m.resM));
      for (let j = j0; j <= j1; j++) {
        const wz = m.originZ + j * m.resM;
        for (let i = i0; i <= i1; i++) {
          const wx = m.originX + i * m.resM;
          let inside = false;
          for (let a = 0, b2 = n - 1; a < n; b2 = a++) {
            const xi = p[a * 2] as number;
            const zi = p[a * 2 + 1] as number;
            const xj = p[b2 * 2] as number;
            const zj = p[b2 * 2 + 1] as number;
            if (zi > wz !== zj > wz && wx < ((xj - xi) * (wz - zi)) / (zj - zi) + xi) {
              inside = !inside;
            }
          }
          if (!inside) continue;
          const k = j * m.width + i;
          if ((r[k] as number) === Runnability.Impassable) continue;
          marked.push(k);
        }
      }
    }

    for (const k of marked) r[k] = Runnability.Impassable;

    // There used to be a one-cell dilation here, "so the scatter keeps a metre
    // off the walls". It has been removed, and the reason matters.
    //
    // The raster is 1 m and Krumlov's alleys are 2–3 m wide. Growing every one
    // of 1739 footprints by a metre on each side takes a 3 m alley down to 1 m
    // and a 2 m alley to nothing. Measured on the finished raster, only **30%
    // of the runnable cells in this AOI were connected to Náměstí Svornosti**,
    // and requiring so much as a metre of running room in each direction cut
    // that to 1%: the old town was, navigationally, a hairline maze. Course
    // setting then produced sprints with an unreachable finish.
    //
    // What the dilation bought was cosmetic — a spruce standing flush against
    // plaster. What it cost was the venue. The footprints themselves are still
    // stamped, so the scatter still never plants *inside* a building, and
    // `blockedAt` still tests the real footprint polygons for collision, so
    // nobody runs through a wall either.
    return marked.length;
  }

  /**
   * Fill the enclosed holes the stamped network leaves behind.
   *
   * A square is not a road, and OSM does not map it as an area — Náměstí
   * Svornosti is six `highway=pedestrian` *lines* running round and across it.
   * Stamping those paves the edges and leaves a 26 × 20 m island of ZABAGED
   * "open land" in the middle, which the splat renders as mown grass. On the
   * main square of a town whose entire surface is sett paving.
   *
   * So: flood-fill the unpaved, non-building cells inward from the AOI border,
   * and anything the fill cannot reach is enclosed by paving or by walls.
   * Enclosed components under 4 000 m² become paved; larger ones are left
   * alone, because a big enclosed green space is a garden (the castle's Jelení
   * zahrada is exactly that) and paving it would be worse than the bug.
   *
   * Runs once, at load, over 2.56 M cells.
   */
  private fillPavedHoles(): number {
    const m = this.field.rMeta;
    const r = this.field.runnability;
    const w = m.width;
    const h = m.height;
    const n = w * h;

    const open = (k: number): boolean => {
      const v = r[k] as number;
      return v !== Runnability.Road && v !== Runnability.Path && v !== Runnability.Impassable;
    };

    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < w; i++) {
      for (const k of [i, (h - 1) * w + i]) if (open(k) && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    for (let j = 0; j < h; j++) {
      for (const k of [j * w, j * w + w - 1]) if (open(k) && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    while (stack.length) {
      const k = stack.pop() as number;
      const x = k % w;
      const y = (k / w) | 0;
      if (x > 0 && open(k - 1) && !seen[k - 1]) { seen[k - 1] = 1; stack.push(k - 1); }
      if (x < w - 1 && open(k + 1) && !seen[k + 1]) { seen[k + 1] = 1; stack.push(k + 1); }
      if (y > 0 && open(k - w) && !seen[k - w]) { seen[k - w] = 1; stack.push(k - w); }
      if (y < h - 1 && open(k + w) && !seen[k + w]) { seen[k + w] = 1; stack.push(k + w); }
    }

    // Second pass: label each enclosed component and pave the small ones.
    let filled = 0;
    const comp: number[] = [];
    for (let k0 = 0; k0 < n; k0++) {
      if (seen[k0] || !open(k0)) continue;
      comp.length = 0;
      seen[k0] = 1;
      stack.push(k0);
      while (stack.length) {
        const k = stack.pop() as number;
        comp.push(k);
        const x = k % w;
        const y = (k / w) | 0;
        if (x > 0 && open(k - 1) && !seen[k - 1]) { seen[k - 1] = 1; stack.push(k - 1); }
        if (x < w - 1 && open(k + 1) && !seen[k + 1]) { seen[k + 1] = 1; stack.push(k + 1); }
        if (y > 0 && open(k - w) && !seen[k - w]) { seen[k - w] = 1; stack.push(k - w); }
        if (y < h - 1 && open(k + w) && !seen[k + w]) { seen[k + w] = 1; stack.push(k + w); }
      }
      const areaM2 = comp.length * m.resM * m.resM;
      if (areaM2 > 4000) continue;
      for (const k of comp) {
        const v = r[k] as number;
        if (v !== Runnability.OpenFast && v !== Runnability.OpenRough) continue;
        r[k] = Runnability.Road;
        filled++;
      }
    }
    return filled;
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

  dispose(): void {
    this.stop();
    this.terrain?.dispose();
    this.buildings?.dispose();
    this.town?.dispose();
    this.vegetation?.dispose();
    this.landmarks?.dispose();
    this.sky?.dispose();
    this.ground?.dispose();
    for (const s of this.surfaces) s.dispose();
    this.renderer.dispose();
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
