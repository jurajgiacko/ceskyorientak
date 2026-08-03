/**
 * Terrain: the binary heightfield, the chunked LOD mesh, and the sampling API
 * the physics layer runs on.
 *
 * The rasters come from `tools/terrain/build.mjs` and nothing here ever touches
 * a geo service. Two facts from that pipeline matter to this file:
 *
 *  - Height is 16-bit normalised over the venue's own min/max, so decoding is
 *    `minH + v/65535 * (maxH - minH)`. Over the Vltava valley's 283 m range
 *    that is 4.3 mm per step — far finer than DMR 5G's own accuracy.
 *  - Raster cell (0,0) sits at world (originX, originZ), i east, j south. The
 *    world frame is `src/core/geo.ts`'s: x east, y up, z south.
 *
 * LOD is a fixed chunk grid rather than a quadtree. With fog closing the view
 * at ~120 m the visible set is small and roughly constant, so a quadtree's
 * adaptive subdivision would buy nothing over four flat levels and would cost a
 * far more delicate crack-stitching problem. Cracks between adjacent LODs are
 * hidden with a dropped skirt around each chunk — cheap, and invisible under
 * ground cover.
 */

import * as THREE from 'three';
import { Runnability } from '@/core/types';
import type { GroundType, TerrainSample } from '@/core/types';
import type { QualityTier } from '@/core/capabilities';

// ---------------------------------------------------------------------------
// Raster loading
// ---------------------------------------------------------------------------

interface RasterMetaBase {
  width: number;
  height: number;
  resM: number;
  originX: number;
  originZ: number;
}

interface HeightMeta extends RasterMetaBase {
  format: 'uint16le';
  minH: number;
  maxH: number;
  stepMm: number;
}

interface ClassMeta extends RasterMetaBase {
  format: 'uint8';
  /**
   * Set to `'townmodel'` when this raster's `Impassable` class was derived from
   * the town's vector model rather than stamped into it.
   *
   * The class raster is the *speed and colour* surface (D-002) and the map is
   * drawn from it; what it may not do is hold a second opinion about what is
   * out of bounds, because `Race.step` blocks on `Impassable` and the athlete
   * would be stopped by ground the collider let them into — or, worse, frozen
   * at zero speed standing in it. `SprintScene` warns when the marker is
   * missing, which is what a regenerated raster looks like.
   */
  impassableFrom?: string;
}

interface CanopyMeta extends RasterMetaBase {
  format: 'uint8';
  maxCanopyM: number;
}

async function loadJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function loadBin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * The heightfield plus its co-registered class rasters.
 *
 * Deliberately a plain data object with no three.js in it — the physics and the
 * map renderer need to sample terrain without dragging in a renderer, and the
 * headless course generator will need it too.
 */
export class TerrainField {
  readonly heights: Uint16Array;
  readonly runnability: Uint8Array;
  readonly canopy: Uint8Array;

  readonly hMeta: HeightMeta;
  readonly rMeta: ClassMeta;
  readonly cMeta: CanopyMeta;

  /** Metres of world span covered, x and z. */
  readonly spanX: number;
  readonly spanZ: number;

  private readonly hScale: number;

  private constructor(
    heights: Uint16Array,
    hMeta: HeightMeta,
    runnability: Uint8Array,
    rMeta: ClassMeta,
    canopy: Uint8Array,
    cMeta: CanopyMeta,
  ) {
    this.heights = heights;
    this.hMeta = hMeta;
    this.runnability = runnability;
    this.rMeta = rMeta;
    this.canopy = canopy;
    this.cMeta = cMeta;
    this.hScale = (hMeta.maxH - hMeta.minH) / 65535;
    this.spanX = (hMeta.width - 1) * hMeta.resM;
    this.spanZ = (hMeta.height - 1) * hMeta.resM;
  }

  static async load(venue: string, tier: QualityTier): Promise<TerrainField> {
    const base = `/data/${venue}`;
    /**
     * The `low` tier trades 4 m terrain detail for a 16× smaller heightmap.
     * **Only the heightmap.** A tier is a rendering budget, not a rules budget.
     *
     * Runnability used to follow it, on the argument that physics and visuals
     * must agree about where a path is. That argument is wrong twice over. It
     * is cosmetically wrong — the ground splat is a per-vertex attribute, so a
     * 4 m mesh samples the class raster every 4 m whatever its resolution, and
     * nothing is drawn any differently. And it is *substantively* wrong,
     * because the class raster is not a texture: D-002 makes it the single
     * source of passability for the map, the course generator and collision
     * alike. Downsampling it changes the rules of the race.
     *
     * What that cost, measured: Český Krumlov's alleys are 2–3 m wide, so at
     * 4 m the town seals. 49 % of the centre came back `Impassable`, the ground
     * reachable from Náměstí Svornosti fell from **97.2 % to 0.15 %**, the
     * course generator could site **one** control instead of fifteen, and the
     * athlete was walled into a 3 000 m² pocket around the square with no way
     * out of it — on a phone, which is the device the brief is written for,
     * while every desktop looked fine. That is the "stuck in a small circle in
     * the city" the client reported, and it is why the gate in
     * `tools/ci/check-passable.mjs` now flood-fills every raster a tier can be
     * handed rather than only the default one.
     *
     * The bill is ~190 kB gzip on Krumlov and ~240 kB on Martinkov, against a
     * 25 MB device budget. Correct rules are worth a quarter of a megabyte.
     *
     * The heightmap could not be settled the same way — shipping it once at 1 m
     * costs the phone 4.2 MB gzip on Krumlov and 9.7 MB on Martinkov, which is
     * most of that budget — and it *is* read for rules: the course setter's
     * climb budget and the athlete's slope-driven speed both sample it, so a
     * tiered heightmap handed 3 of 4 Krumlov seeds a different sprint course on
     * a phone than on a desktop. It is settled instead by making the two files
     * agree where it matters: `height-low.bin` is a point decimation of
     * `height.bin` carrying its own `minH`/`maxH` (`tools/terrain/lowtier.mjs`),
     * so both hold the identical sample at every 4 m node, and the rules are
     * computed on that lattice by `FieldTerrain.rulesHeightAt`. What is loaded
     * here is therefore only what the venue is *drawn* on, which is what a
     * rendering budget should mean.
     */
    const heightSuffix = tier === 'low' ? '-low' : '';

    const [hMeta, rMeta, cMeta] = await Promise.all([
      loadJson<HeightMeta>(`${base}/height${heightSuffix}.json`),
      loadJson<ClassMeta>(`${base}/runnability.json`),
      loadJson<CanopyMeta>(`${base}/canopy.json`),
    ]);
    const [hBuf, rBuf, cBuf] = await Promise.all([
      loadBin(`${base}/height${heightSuffix}.bin`),
      loadBin(`${base}/runnability.bin`),
      loadBin(`${base}/canopy.bin`),
    ]);

    const heights = new Uint16Array(hBuf);
    if (heights.length !== hMeta.width * hMeta.height) {
      throw new Error(
        `height${heightSuffix}.bin is ${heights.length} samples, sidecar says ${hMeta.width}x${hMeta.height}`,
      );
    }
    return new TerrainField(
      heights,
      hMeta,
      new Uint8Array(rBuf),
      rMeta,
      new Uint8Array(cBuf),
      cMeta,
    );
  }

  get minX(): number {
    return this.hMeta.originX;
  }
  get minZ(): number {
    return this.hMeta.originZ;
  }
  get maxX(): number {
    return this.hMeta.originX + this.spanX;
  }
  get maxZ(): number {
    return this.hMeta.originZ + this.spanZ;
  }

  /** Raw height at a raster cell, clamped at the edges. */
  private cell(i: number, j: number): number {
    const m = this.hMeta;
    const ci = i < 0 ? 0 : i >= m.width ? m.width - 1 : i;
    const cj = j < 0 ? 0 : j >= m.height ? m.height - 1 : j;
    return m.minH + (this.heights[cj * m.width + ci] as number) * this.hScale;
  }

  /** Bilinear height at a world position. */
  heightAt(x: number, z: number): number {
    const m = this.hMeta;
    const fx = (x - m.originX) / m.resM;
    const fz = (z - m.originZ) / m.resM;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.cell(i, j);
    const h10 = this.cell(i + 1, j);
    const h01 = this.cell(i, j + 1);
    const h11 = this.cell(i + 1, j + 1);
    return (
      h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz
    );
  }

  /** Central-difference gradient, metres of rise per metre. `out` is [dy/dx, dy/dz]. */
  gradientAt(x: number, z: number, out: [number, number] = [0, 0]): [number, number] {
    const d = this.hMeta.resM;
    out[0] = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    out[1] = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return out;
  }

  /** Surface normal in world space (y up). */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const g = this.gradientAt(x, z);
    return out.set(-g[0], 1, -g[1]).normalize();
  }

  runnabilityAt(x: number, z: number): Runnability {
    const m = this.rMeta;
    const i = Math.round((x - m.originX) / m.resM);
    const j = Math.round((z - m.originZ) / m.resM);
    if (i < 0 || j < 0 || i >= m.width || j >= m.height) return Runnability.ForestOpen;
    return (this.runnability[j * m.width + i] as number) as Runnability;
  }

  /** Canopy height in metres at a world position. */
  canopyAt(x: number, z: number): number {
    const m = this.cMeta;
    const i = Math.round((x - m.originX) / m.resM);
    const j = Math.round((z - m.originZ) / m.resM);
    if (i < 0 || j < 0 || i >= m.width || j >= m.height) return 0;
    return ((this.canopy[j * m.width + i] as number) / 255) * m.maxCanopyM;
  }

  /**
   * Full sample for the physics layer.
   *
   * `slope` is the uphill gradient *along the direction of travel* — a runner
   * traversing a hillside is not climbing it, and the energy model has to see
   * that. `heading` is radians, 0 = north, clockwise positive, matching
   * `AthleteState.heading`.
   */
  sample(x: number, z: number, heading = 0): TerrainSample {
    const g = this.gradientAt(x, z);
    // Travel direction in world axes: north is -z, east is +x.
    const dx = Math.sin(heading);
    const dz = -Math.cos(heading);
    const run = this.runnabilityAt(x, z);
    return {
      height: this.heightAt(x, z),
      slope: (g[0] as number) * dx + (g[1] as number) * dz,
      runnability: run,
      ground: GROUND_FOR_RUNNABILITY[run],
    };
  }
}

/**
 * Surface material per runnability class — drives footstep audio and particles.
 *
 * D-002 keeps runnability itself shared between map and physics; this table is
 * the one place that maps it onward to a material, so a Šumava re-skin is one
 * edit rather than a hunt through the audio layer.
 */
export const GROUND_FOR_RUNNABILITY: Readonly<Record<Runnability, GroundType>> = {
  [Runnability.Road]: 'asphalt',
  [Runnability.Path]: 'gravel',
  [Runnability.OpenFast]: 'grass',
  [Runnability.OpenRough]: 'grass',
  [Runnability.ForestOpen]: 'needles',
  [Runnability.Green1]: 'needles',
  [Runnability.Green2]: 'needles',
  [Runnability.Green3]: 'leaf',
  [Runnability.Marsh]: 'marsh',
  [Runnability.Rock]: 'rock',
  [Runnability.Impassable]: 'water',
};

// ---------------------------------------------------------------------------
// Chunked LOD mesh
// ---------------------------------------------------------------------------

/** Chunk edge length in metres. 2400 / 80 divides exactly for both venues. */
const CHUNK_M = 80;

/** Vertex segments per chunk edge, finest to coarsest. LOD0 is 1 m. */
const LOD_SEGMENTS = [80, 40, 20, 10] as const;

/** Distance in metres at which each LOD takes over. */
const LOD_DISTANCE = [90, 180, 340, Infinity] as const;

/**
 * How far the skirt hangs below the chunk edge.
 *
 * 2.5 m covers the worst height difference a 10-segment chunk can have against
 * an 80-segment neighbour on this terrain (the valley sides run to ~30°) with
 * room to spare. Too small and cracks flash through as bright sky; too large
 * and the skirt pokes out of a convex ridge.
 */
const SKIRT_M = 2.5;

/**
 * Splat weights fed to the terrain material, one vec4 per vertex.
 *
 * Five surfaces from four stored weights: layer 4 (granite) is the implicit
 * remainder, `1 - (w0+w1+w2+w3)`. That keeps it to one attribute and makes
 * "no other surface claimed this vertex" mean bare rock, which is the right
 * default on a Šumava slope.
 */
export type SplatTable = Readonly<
  Record<Runnability, readonly [number, number, number, number]>
>;

const SPLAT_FOR_RUNNABILITY: SplatTable = {
    // moss, needles, dirt, meadow  (granite = remainder)
    [Runnability.Road]: [0, 0, 1, 0],
    [Runnability.Path]: [0, 0.15, 0.85, 0],
    [Runnability.OpenFast]: [0, 0, 0, 1],
    [Runnability.OpenRough]: [0.1, 0, 0, 0.9],
    // Moss-dominant, which is the Šumava spruce floor and the reference frame.
    // The needle-litter layer is the *lighter* of the two, so leaning on it
    // turns the floor beige; it belongs under the denser stands where the
    // canopy actually suppresses the moss.
    [Runnability.ForestOpen]: [0.78, 0.2, 0, 0],
    [Runnability.Green1]: [0.66, 0.32, 0, 0],
    [Runnability.Green2]: [0.5, 0.48, 0, 0],
    [Runnability.Green3]: [0.36, 0.62, 0, 0],
    [Runnability.Marsh]: [0.45, 0, 0, 0.5],
    [Runnability.Rock]: [0.18, 0, 0, 0],
    [Runnability.Impassable]: [0.2, 0.1, 0.2, 0.4],
  };

/** The forest venue's table, exported so a caller can pick one explicitly. */
export const FOREST_SPLAT: SplatTable = SPLAT_FOR_RUNNABILITY;

/**
 * Český Krumlov, against `TOWN_GROUND` in materials.ts:
 * 0 cobble · 1 gravel · 2 meadow grass · 3 leaf litter · 4 (remainder) granite.
 *
 * The mapping is not a re-skin of the forest table, it is a different reading
 * of the same enum. `Road` here means sett paving, not tarmac — Krumlov's old
 * town is cobbled throughout and it is 267 k of the venue's 1.6 M cells, the
 * single largest surface. And the forest classes, which in Šumava mean a
 * spruce floor of moss and needles, here mean the deciduous slope above Latrán
 * and the castle gardens, so they resolve to leaf litter instead.
 */
export const TOWN_SPLAT: SplatTable = {
  [Runnability.Road]: [1, 0, 0, 0],
  [Runnability.Path]: [0.12, 0.88, 0, 0],
  [Runnability.OpenFast]: [0, 0, 1, 0],
  [Runnability.OpenRough]: [0, 0.12, 0.8, 0.05],
  [Runnability.ForestOpen]: [0, 0, 0.28, 0.68],
  [Runnability.Green1]: [0, 0, 0.2, 0.76],
  [Runnability.Green2]: [0, 0, 0.12, 0.84],
  [Runnability.Green3]: [0, 0, 0.06, 0.9],
  [Runnability.Marsh]: [0, 0, 0.6, 0.3],
  // Bare rock: the cliffs the old town is built against, and the castle crag.
  [Runnability.Rock]: [0, 0, 0, 0.06],
  // Water and out-of-bounds. The river gets a real surface drawn over it by
  // townscape.ts, so what matters here is that the bed under it is not grass.
  [Runnability.Impassable]: [0, 0.1, 0.18, 0.3],
};

interface Chunk {
  cx: number;
  cz: number;
  mesh: THREE.Mesh;
  lod: number;
  centre: THREE.Vector3;
}

function chunkKey(cx: number, cz: number): string {
  return `${cx}|${cz}`;
}

/**
 * Builds and maintains the visible terrain mesh.
 *
 * Chunks are created on demand within `viewRadius` of the camera and released
 * beyond it, with a per-frame build budget so a fast traverse degrades into a
 * slightly late chunk rather than a 200 ms hitch.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();

  private readonly chunks = new Map<string, Chunk>();
  private readonly field: TerrainField;
  private readonly material: THREE.Material;
  private readonly viewRadius: number;
  private readonly buildBudget: number;

  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();

  /** Chunks currently drawn, for the debug overlay. */
  visibleCount = 0;
  triangleCount = 0;

  private readonly splat: SplatTable;

  constructor(
    field: TerrainField,
    material: THREE.Material,
    opts: { viewRadius?: number; buildBudget?: number; splat?: SplatTable } = {},
  ) {
    this.field = field;
    this.material = material;
    this.splat = opts.splat ?? SPLAT_FOR_RUNNABILITY;
    this.viewRadius = opts.viewRadius ?? 420;
    // One chunk per frame. An LOD0 chunk is 6 724 vertices, each needing five
    // bilinear heightfield samples for position and normal, so three per frame
    // is a 15 ms spike every time the player crosses a chunk boundary — which
    // is exactly the p95 the perf gate measures.
    this.buildBudget = opts.buildBudget ?? 1;
    this.group.name = 'terrain';
    this.group.matrixAutoUpdate = false;
  }

  /**
   * Pull chunks in and out around the camera, pick LODs, and frustum-cull.
   *
   * Called every frame. The expensive half (geometry build) is budgeted; the
   * cheap half (visibility) is not.
   */
  update(camera: THREE.PerspectiveCamera): void {
    const cam = camera.position;
    const f = this.field;

    const c0x = Math.floor((f.minX - CHUNK_M) / CHUNK_M);
    const c1x = Math.ceil(f.maxX / CHUNK_M);
    const c0z = Math.floor((f.minZ - CHUNK_M) / CHUNK_M);
    const c1z = Math.ceil(f.maxZ / CHUNK_M);

    const ci = Math.floor(cam.x / CHUNK_M);
    const cj = Math.floor(cam.z / CHUNK_M);
    const reach = Math.ceil(this.viewRadius / CHUNK_M);

    // --- create ---
    let built = 0;
    const wanted = new Set<string>();
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const cx = ci + di;
        const cz = cj + dj;
        if (cx < c0x || cx > c1x || cz < c0z || cz > c1z) continue;

        const centreX = (cx + 0.5) * CHUNK_M;
        const centreZ = (cz + 0.5) * CHUNK_M;
        const dist = Math.hypot(centreX - cam.x, centreZ - cam.z);
        if (dist > this.viewRadius + CHUNK_M) continue;

        const key = chunkKey(cx, cz);
        wanted.add(key);
        const lod = pickLod(dist);
        const existing = this.chunks.get(key);
        if (existing) {
          if (existing.lod !== lod && built < this.buildBudget) {
            this.rebuild(existing, lod);
            built++;
          }
        } else if (built < this.buildBudget) {
          this.chunks.set(key, this.build(cx, cz, lod));
          built++;
        }
      }
    }

    // --- release ---
    for (const [key, chunk] of this.chunks) {
      if (wanted.has(key)) continue;
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      this.chunks.delete(key);
    }

    // --- cull ---
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    this.visibleCount = 0;
    this.triangleCount = 0;
    for (const chunk of this.chunks.values()) {
      const sphere = chunk.mesh.geometry.boundingSphere;
      const visible = sphere ? this.frustum.intersectsSphere(sphere) : true;
      chunk.mesh.visible = visible;
      if (visible) {
        this.visibleCount++;
        const idx = chunk.mesh.geometry.getIndex();
        this.triangleCount += idx ? idx.count / 3 : 0;
      }
    }
  }

  private rebuild(chunk: Chunk, lod: number): void {
    chunk.mesh.geometry.dispose();
    chunk.mesh.geometry = this.buildGeometry(chunk.cx, chunk.cz, lod);
    chunk.lod = lod;
  }

  private build(cx: number, cz: number, lod: number): Chunk {
    const geo = this.buildGeometry(cx, cz, lod);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = false; // terrain self-shadowing is handled by the sun's own pass
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false; // we cull explicitly, with our own bounding sphere
    this.group.add(mesh);
    return {
      cx,
      cz,
      mesh,
      lod,
      centre: new THREE.Vector3((cx + 0.5) * CHUNK_M, 0, (cz + 0.5) * CHUNK_M),
    };
  }

  private buildGeometry(cx: number, cz: number, lod: number): THREE.BufferGeometry {
    const f = this.field;
    const seg = LOD_SEGMENTS[lod] as number;
    const step = CHUNK_M / seg;
    const n = seg + 1;

    const x0 = cx * CHUNK_M;
    const z0 = cz * CHUNK_M;

    // Interior grid plus a one-ring skirt: (n+2)² vertices.
    const gn = n + 2;
    const vertCount = gn * gn;
    const pos = new Float32Array(vertCount * 3);
    const nrm = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const splat = new Float32Array(vertCount * 4);
    // Per-vertex ground info: x = curvature occlusion, y = canopy height as a
    // fraction of 30 m. Both are consumed by the terrain material; packed into
    // one vec2 attribute rather than two floats to keep the attribute count
    // down, since the low tier is already close to its varying budget.
    const ground = new Float32Array(vertCount * 2);

    let minY = Infinity;
    let maxY = -Infinity;

    for (let j = 0; j < gn; j++) {
      // Skirt ring clamps to the edge column/row, then drops in y.
      const jj = Math.min(n - 1, Math.max(0, j - 1));
      const isSkirtZ = j === 0 || j === gn - 1;
      for (let i = 0; i < gn; i++) {
        const ii = Math.min(n - 1, Math.max(0, i - 1));
        const isSkirtX = i === 0 || i === gn - 1;

        const wx = x0 + ii * step;
        const wz = z0 + jj * step;
        const h = f.heightAt(wx, wz);
        const y = isSkirtX || isSkirtZ ? h - SKIRT_M : h;

        const k = j * gn + i;
        pos[k * 3] = wx;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = wz;

        // Height samples around the vertex, reused twice: once for the normal
        // (central difference) and once for the curvature term. Sharing them is
        // why the AO below is nearly free — it is four extra samples per vertex,
        // not the twelve a proper hemisphere occlusion sweep would want.
        const d = f.hMeta.resM;
        const hxp = f.heightAt(wx + d, wz);
        const hxm = f.heightAt(wx - d, wz);
        const hzp = f.heightAt(wx, wz + d);
        const hzm = f.heightAt(wx, wz - d);

        // Normal of y = h(x,z) is (-dh/dx, 1, -dh/dz), normalised.
        const nx = -(hxp - hxm) / (2 * d);
        const nz = -(hzp - hzm) / (2 * d);
        const inv = 1 / Math.hypot(nx, 1, nz);
        nrm[k * 3] = nx * inv;
        nrm[k * 3 + 1] = inv;
        nrm[k * 3 + 2] = nz * inv;

        // Curvature occlusion. The Laplacian of the heightfield is positive on
        // a ridge and negative in a hollow, and a hollow is exactly where light
        // does not reach: re-entrants, the inside of a gully, the base of a
        // slope break. Two scales — 1 m catches the micro-relief the 1 m raster
        // resolves, 7 m catches the landform. Without this the floor is one flat
        // value across a whole hillside and reads as a painted plane no matter
        // how good the texture on it is.
        const lapFine = (hxp + hxm + hzp + hzm) * 0.25 - h;
        const D = 7;
        const lapWide =
          (f.heightAt(wx + D, wz) +
            f.heightAt(wx - D, wz) +
            f.heightAt(wx, wz + D) +
            f.heightAt(wx, wz - D)) *
            0.25 -
          h;
        // Negative Laplacian = hollow. Clamped hard so a cliff edge does not
        // punch a black hole, and biased so convex ground is only slightly lit.
        const hollow = Math.min(1, Math.max(0, -lapFine * 6 + -lapWide * 0.55));
        const ridge = Math.min(1, Math.max(0, lapFine * 4 + lapWide * 0.35));
        ground[k * 2] = 1 - hollow * 0.42 + ridge * 0.1;

        // Canopy height above this vertex, as a fraction of 30 m. The material
        // uses it to decide how much sun can reach the floor here — which ties
        // the sunlit pools to the LiDAR rather than to a noise field alone. It
        // is the same raster the tree placement scales against, so the light on
        // the ground and the trees standing on it agree about where the canopy
        // is closed.
        ground[k * 2 + 1] = Math.min(1, f.canopyAt(wx, wz) / 30);

        uv[k * 2] = wx;
        uv[k * 2 + 1] = wz;

        const w = this.splat[f.runnabilityAt(wx, wz)];
        splat[k * 4] = w[0];
        splat[k * 4 + 1] = w[1];
        splat[k * 4 + 2] = w[2];
        splat[k * 4 + 3] = w[3];

        if (!isSkirtX && !isSkirtZ) {
          if (h < minY) minY = h;
          if (h > maxY) maxY = h;
        }
      }
    }

    // A 3×3 box blur over the splat weights. The class raster is a hard
    // per-cell label; without this every green patch edge is a visible
    // staircase in the ground texture, which no ISOM mapper would ever draw.
    smoothSplat(splat, gn);

    const idx = new Uint32Array(gn * gn * 6);
    let p = 0;
    for (let j = 0; j < gn - 1; j++) {
      for (let i = 0; i < gn - 1; i++) {
        const a = j * gn + i;
        const b = a + 1;
        const c = a + gn;
        const d = c + 1;
        idx[p++] = a;
        idx[p++] = c;
        idx[p++] = b;
        idx[p++] = b;
        idx[p++] = c;
        idx[p++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geo.setAttribute('ground', new THREE.BufferAttribute(ground, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, p), 1));

    // Explicit bounds — the skirt would otherwise inflate them downward and
    // our own culling would keep chunks alive well past the fog.
    const cxw = x0 + CHUNK_M / 2;
    const czw = z0 + CHUNK_M / 2;
    const cyw = (minY + maxY) / 2;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(cxw, cyw, czw),
      Math.hypot(CHUNK_M * 0.7072, (maxY - minY) / 2 + SKIRT_M),
    );
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(x0, minY - SKIRT_M, z0),
      new THREE.Vector3(x0 + CHUNK_M, maxY, z0 + CHUNK_M),
    );
    return geo;
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    this.chunks.clear();
    // The splat material is built per scene by `createTerrainMaterial` and is
    // held by nothing else. Its ground textures belong to `GroundTextures`,
    // which the scene disposes separately, so this releases the program and the
    // uniforms rather than the arrays.
    this.material.dispose();
  }
}

function pickLod(dist: number): number {
  for (let i = 0; i < LOD_DISTANCE.length; i++) {
    if (dist < (LOD_DISTANCE[i] as number)) return i;
  }
  return LOD_DISTANCE.length - 1;
}

function smoothSplat(splat: Float32Array, gn: number): void {
  const src = splat.slice();
  for (let j = 0; j < gn; j++) {
    for (let i = 0; i < gn; i++) {
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= gn) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= gn) continue;
          const k = (jj * gn + ii) * 4;
          a += src[k] as number;
          b += src[k + 1] as number;
          c += src[k + 2] as number;
          d += src[k + 3] as number;
          n++;
        }
      }
      const k = (j * gn + i) * 4;
      splat[k] = a / n;
      splat[k + 1] = b / n;
      splat[k + 2] = c / n;
      splat[k + 3] = d / n;
    }
  }
}

/**
 * Find a spot that actually looks like the reference: mature closed canopy,
 * away from the valley floor and the town.
 *
 * **This is now a safety net, not the mechanism.** The Lachovice origin used to
 * be a street in Loučovice, so world (0,0) was tarmac and this function had to
 * go hunting up to 900 m for somewhere plausible. The origin has since been
 * re-chosen from the built raster (98.7 % forest, 0 % road inside 400 m), so the
 * expected answer is now "near (0,0)".
 *
 * It is kept because the venue origin is a config value and a future one may
 * again land badly — but the radius is down to 260 m and there is a distance
 * penalty, so it corrects a bad spawn without silently relocating the scene
 * half a kilometre from the venue anchor.
 */
export function findForestSpawn(field: TerrainField, searchRadius = 260): THREE.Vector2 {
  let best = new THREE.Vector2(0, 0);
  let bestScore = -Infinity;
  const step = 20;

  for (let z = -searchRadius; z <= searchRadius; z += step) {
    for (let x = -searchRadius; x <= searchRadius; x += step) {
      // Score the neighbourhood, not the point — one good cell in a car park
      // is not a forest.
      let score = 0;
      for (let dz = -40; dz <= 40; dz += 20) {
        for (let dx = -40; dx <= 40; dx += 20) {
          const r = field.runnabilityAt(x + dx, z + dz);
          const canopy = field.canopyAt(x + dx, z + dz);
          if (r === Runnability.ForestOpen) score += 3;
          else if (r === Runnability.Green1) score += 1.5;
          else if (r === Runnability.Green2) score += 0.5;
          else if (r === Runnability.Impassable) score -= 12;
          else if (r === Runnability.Road) score -= 8;
          else score -= 1;
          // Tall canopy is what makes the reference frame read as Šumava.
          if (canopy > 18) score += 2;
        }
      }
      // Mild bonus for gentle relief; a dead-flat plate looks synthetic.
      const g = field.gradientAt(x, z);
      const slope = Math.hypot(g[0] as number, g[1] as number);
      score += Math.min(slope, 0.35) * 12;

      // Stay near the venue anchor unless the ground there is genuinely bad.
      // Without this the search wanders to whatever the single best cell in the
      // radius happens to be, and the scene silently stops being *this* venue.
      score -= Math.hypot(x, z) / 40;

      if (score > bestScore) {
        bestScore = score;
        best = new THREE.Vector2(x, z);
      }
    }
  }
  return best;
}

/**
 * Pick the opening heading for a spawn.
 *
 * Left to itself the camera faces the sun, which on a slope means it often
 * faces a bank three metres away and the whole frame is ground. The reference
 * shot needs a *sightline*: level or falling terrain, so the trunks recede and
 * the canopy gets into frame.
 *
 * Scored over 32 headings: mostly "how far can I see", with a real but
 * secondary pull toward the sun, because the shafts only exist when the light
 * is behind what you are looking at.
 */
export function pickHeroYaw(
  field: TerrainField,
  spawn: THREE.Vector2,
  sunYaw: number,
): number {
  let best = sunYaw;
  let bestScore = -Infinity;
  const eye = field.heightAt(spawn.x, spawn.y) + 1.62;

  for (let i = 0; i < 32; i++) {
    const yaw = (i / 32) * Math.PI * 2;
    // Forward is (-sin yaw, -cos yaw): the same convention the camera uses.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);

    // How much of the sightline the ground blocks, out to 60 m.
    let blocked = 0;
    for (let d = 5; d <= 60; d += 5) {
      const h = field.heightAt(spawn.x + fx * d, spawn.y + fz * d);
      // Ground rising above the eye line is what kills the shot.
      if (h > eye) blocked += (h - eye) / d;
    }

    const align = Math.cos(yaw - sunYaw);
    const score = -blocked * 6 + align * 1.1;
    if (score > bestScore) {
      bestScore = score;
      best = yaw;
    }
  }
  return best;
}
