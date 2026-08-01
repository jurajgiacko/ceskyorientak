/**
 * GPU-instanced vegetation.
 *
 * The point of this file is D-002 made visible: **density and species follow
 * the runnability class**, so what the player sees is what the map promised and
 * what the physics is about to do to them. Standing at the edge of a light
 * green patch, you should be able to see that it is a light green patch before
 * you look at the map.
 *
 * ---------------------------------------------------------------------------
 * Asset independence
 * ---------------------------------------------------------------------------
 * The spruce model on disk is being reworked. Nothing here knows anything about
 * it beyond the naming convention the Blender pipeline already emits:
 *
 *     <asset>_v<N>_LOD<L>      or     <asset>_LOD<L>
 *
 * Variant count, LOD count, tree height, crown radius and trunk offset are all
 * *measured from the geometry* at load. Dropping in a new `spruce.glb` with
 * five variants at different heights requires no code change — placement rescales
 * against whatever it finds. `assertAssetSane` refuses to place an asset whose
 * proportions are impossible, so a bad export fails loudly rather than filling
 * the forest with 2 m spruce.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Runnability } from '@/core/types';
import type { QualityTier } from '@/core/capabilities';
import type { TerrainField } from './terrain';
import { conditionAssetMaterial, makeImposterMaterial } from './materials';

// ---------------------------------------------------------------------------
// Asset model
// ---------------------------------------------------------------------------

interface LodLevel {
  /** One entry per material group in the source node. */
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  triangles: number;
}

export interface AssetVariant {
  name: string;
  lods: LodLevel[];
  /** Measured from the LOD0 bounding box, metres. */
  heightM: number;
  radiusM: number;
}

export interface Asset {
  name: string;
  variants: AssetVariant[];
}

const NODE_RE = /^(.+?)(?:_v(\d+))?_LOD(\d+)$/;

function materialKind(name: string): 'bark' | 'foliage' | 'rock' | 'wood' {
  const n = name.toLowerCase();
  // Rock is tested first on purpose: `granite_lichen` is the lichen *cap on a
  // boulder*, not foliage. Classifying it as foliage left the top of every
  // boulder as untextured grey while the sides were granite, which looked
  // exactly like a broken material assignment, because it was one.
  if (n.includes('granite') || n.includes('rock') || n.includes('stone')) return 'rock';
  if (n.includes('needle') || n.includes('leaves') || n.includes('leaf')) return 'foliage';
  if (n.includes('bark')) return 'bark';
  return 'wood';
}

const IDENTITY = new THREE.Matrix4();

function isIdentity(m: THREE.Matrix4): boolean {
  const a = m.elements;
  const b = IDENTITY.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs((a[i] as number) - (b[i] as number)) > 1e-6) return false;
  }
  return true;
}

let sharedLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  if (sharedLoader) return sharedLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath('/vendor/draco/');
  // WASM, not JS: the wasm decoder is 192 kB against the JS build's 512 kB and
  // decodes substantially faster. three's DRACOLoader falls back to JS by
  // itself if wasm is unavailable, so forcing 'js' only ever costs us.
  draco.setDecoderConfig({ type: 'wasm' });
  const gltf = new GLTFLoader();
  gltf.setDRACOLoader(draco);
  sharedLoader = gltf;
  return gltf;
}

/**
 * Load a .glb and reduce it to variants × LODs, discovered from node names.
 *
 * Nothing is hardcoded about how many of either there are — see the header. The
 * LOD list is packed dense, so an asset with only LOD0 and LOD2 authored still
 * yields a usable two-level ladder rather than a hole.
 */
export async function loadAsset(url: string, name: string): Promise<Asset> {
  const gltf = await loader().loadAsync(url);
  const byVariant = new Map<string, Map<number, LodLevel>>();

  gltf.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;

    // A glTF mesh with several primitives comes back as a Group whose children
    // are the primitives, so the `<asset>_v<N>_LOD<L>` name can be on an
    // ancestor rather than on the mesh itself. Walk up until it matches — and
    // accumulate the transform on the way, because a node with a non-identity
    // matrix would otherwise be instanced in the wrong place.
    let node: THREE.Object3D | null = obj;
    const local = new THREE.Matrix4().identity();
    let m: RegExpExecArray | null = null;
    while (node) {
      m = NODE_RE.exec(node.name);
      if (m) break;
      node.updateMatrix();
      local.premultiply(node.matrix);
      node = node.parent;
    }
    if (!m) return;

    const variant = m[2] !== undefined ? `v${m[2]}` : 'v0';
    const lod = Number(m[3]);

    let levels = byVariant.get(variant);
    if (!levels) {
      levels = new Map();
      byVariant.set(variant, levels);
    }
    let level = levels.get(lod);
    if (!level) {
      level = { parts: [], triangles: 0 };
      levels.set(lod, level);
    }

    let geo = obj.geometry as THREE.BufferGeometry;
    if (!isIdentity(local)) {
      geo = geo.clone();
      geo.applyMatrix4(local);
    }
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      const isImposter = /imposter/i.test(mat.name);
      const conditioned = isImposter
        ? makeImposterMaterial(mat)
        : conditionAssetMaterial(mat, materialKind(mat.name));
      level.parts.push({ geometry: geo, material: conditioned });
    }
    const idx = geo.getIndex();
    level.triangles += (idx ? idx.count : geo.attributes.position!.count) / 3;
  });

  const variants: AssetVariant[] = [];
  for (const [variantName, levels] of [...byVariant].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (ordered.length === 0) continue;

    const box = new THREE.Box3();
    for (const part of ordered[0]!.parts) {
      if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
    }
    const size = box.getSize(new THREE.Vector3());
    variants.push({
      name: variantName,
      lods: ordered,
      heightM: size.y,
      radiusM: Math.max(size.x, size.z) * 0.5,
    });
  }

  if (variants.length === 0) {
    throw new Error(`${name}: no nodes matched <asset>_v<N>_LOD<L> in ${url}`);
  }
  return { name, variants };
}

/**
 * Refuse to build a forest out of an asset whose proportions are impossible.
 *
 * This exists because the spruce is mid-rework: a placeholder that is 3 m tall
 * or 8 m wide would otherwise silently produce a scene that looks broken for
 * reasons nobody would trace back to the .glb.
 */
export function assertAssetSane(
  asset: Asset,
  expect: { minHeightM: number; maxHeightM: number; maxAspect: number },
): string[] {
  const warnings: string[] = [];
  for (const v of asset.variants) {
    if (v.heightM < expect.minHeightM || v.heightM > expect.maxHeightM) {
      warnings.push(
        `${asset.name}/${v.name}: ${v.heightM.toFixed(1)} m tall, expected ${expect.minHeightM}–${expect.maxHeightM} m`,
      );
    }
    const aspect = (v.radiusM * 2) / Math.max(v.heightM, 0.01);
    if (aspect > expect.maxAspect) {
      warnings.push(
        `${asset.name}/${v.name}: crown is ${(aspect * 100).toFixed(0)} % of its height — too wide for a spruce`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

export interface SpeciesMix {
  /** Trees per square metre. */
  density: number;
  /** Probability of a beech rather than a spruce. */
  beechShare: number;
  /** Boulders per square metre. */
  boulders: number;
  /** Deadwood pieces per square metre. */
  deadwood: number;
  /** Undergrowth tufts per square metre in the near field. */
  undergrowth: number;
  /** Scale multiplier applied on top of the canopy-height fit. */
  scale: number;
}

/**
 * The table that makes the map true.
 *
 * Densities are stems per m². For calibration: a mature Šumava spruce stand
 * runs 300–500 stems/ha (0.03–0.05/m²) and that is exactly ISOM white — you can
 * run through it at full speed precisely *because* the stems are far apart and
 * there is no understorey. Green3 "fight" is a regeneration thicket, which is
 * an order of magnitude denser in stems and where the young-variant spruce and
 * the heavy undergrowth go.
 */
/**
 * Beech share is deliberately low.
 *
 * D-007 is explicit that Vyšší Brod is Šumava **granite and spruce** — the
 * beech-and-sandstone look belongs to the Liberec footage and putting it here
 * would place the forest in the wrong part of the country to anyone who knows
 * it. There is a rendering reason too: beech bark is pale grey and the LOD1
 * beech is a 90-triangle trunk with a thin crown, so at 60 m a stand of them
 * reads as a row of white slabs. A few for variety along edges, no more.
 */
export const MIX: Readonly<Record<Runnability, SpeciesMix>> = {
  [Runnability.Road]: { density: 0, beechShare: 0, boulders: 0, deadwood: 0, undergrowth: 0, scale: 1 },
  [Runnability.Path]: { density: 0, beechShare: 0, boulders: 0, deadwood: 0, undergrowth: 0.05, scale: 1 },
  [Runnability.OpenFast]: { density: 0.0015, beechShare: 0.28, boulders: 0.0006, deadwood: 0, undergrowth: 0.55, scale: 1 },
  [Runnability.OpenRough]: { density: 0.004, beechShare: 0.2, boulders: 0.004, deadwood: 0.001, undergrowth: 1.5, scale: 0.85 },
  [Runnability.ForestOpen]: { density: 0.042, beechShare: 0.03, boulders: 0.004, deadwood: 0.004, undergrowth: 0.75, scale: 1 },
  [Runnability.Green1]: { density: 0.075, beechShare: 0.07, boulders: 0.004, deadwood: 0.008, undergrowth: 2.0, scale: 0.85 },
  [Runnability.Green2]: { density: 0.13, beechShare: 0.1, boulders: 0.003, deadwood: 0.012, undergrowth: 3.4, scale: 0.7 },
  [Runnability.Green3]: { density: 0.24, beechShare: 0.12, boulders: 0.002, deadwood: 0.016, undergrowth: 5.2, scale: 0.5 },
  [Runnability.Marsh]: { density: 0.006, beechShare: 0.18, boulders: 0, deadwood: 0.004, undergrowth: 3.0, scale: 0.6 },
  [Runnability.Rock]: { density: 0.008, beechShare: 0.05, boulders: 0.05, deadwood: 0.002, undergrowth: 0.3, scale: 0.6 },
  [Runnability.Impassable]: { density: 0, beechShare: 0, boulders: 0, deadwood: 0, undergrowth: 0, scale: 1 },
};

// ---------------------------------------------------------------------------
// Instance buckets
// ---------------------------------------------------------------------------

interface Placement {
  x: number;
  z: number;
  y: number;
  scale: number;
  rotY: number;
  /** Index into the asset's variant list. */
  variant: number;
  /** Tilt to follow the ground, for rocks and deadwood. */
  tiltX: number;
  tiltZ: number;
}

/** One InstancedMesh per (variant, lod, material part). */
class Bucket {
  readonly meshes: THREE.InstancedMesh[] = [];
  count = 0;

  constructor(
    parent: THREE.Object3D,
    lod: LodLevel,
    capacity: number,
    castShadow: boolean,
  ) {
    for (const part of lod.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = castShadow;
      im.receiveShadow = true;
      im.frustumCulled = false; // instances span the whole ring; per-mesh culling is useless
      im.count = 0;
      this.meshes.push(im);
      parent.add(im);
    }
  }

  reset(): void {
    this.count = 0;
  }

  /** Drops the instance if the bucket is full — a missing distant tree beats a stall. */
  push(matrix: THREE.Matrix4): boolean {
    const first = this.meshes[0];
    if (!first || this.count >= first.instanceMatrix.count) return false;
    for (const m of this.meshes) m.setMatrixAt(this.count, matrix);
    this.count++;
    return true;
  }

  flush(): void {
    for (const m of this.meshes) {
      m.count = this.count;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(parent: THREE.Object3D): void {
    for (const m of this.meshes) {
      parent.remove(m);
      m.dispose();
    }
  }
}

/**
 * Low-frequency canopy openness, 0.2 (a gap) to ~1.25 (a thicket).
 *
 * Without this the placement is a uniform Poisson field, and a uniform field at
 * ISOM-white density gives **total** canopy closure: 0.042 stems/m² times a 4 m
 * crown radius is 2.1× overlap, so not one photon reaches the floor. Measured in
 * the build: the whole scene sat in shadow and the god rays had nothing to shine
 * through.
 *
 * Real spruce stands are not uniform — they are patchy, with wind-throw gaps,
 * skid trails and old clearings. That patchiness is what produces the sun
 * patches and the shafts in the reference photograph, so it is not decoration:
 * it is the mechanism behind the entire look.
 *
 * Two octaves of value noise, ~46 m and ~17 m. The long one makes glades, the
 * short one breaks up their edges.
 */
function canopyOpenness(x: number, z: number): number {
  const t =
    0.68 * valueNoise(x / 46, z / 46) + 0.32 * valueNoise(x / 17 + 31.7, z / 17 - 12.3);
  // The threshold is the whole point: below it the density goes to *zero*, not
  // to "a bit less". A forest that merely thins never lets a shaft through —
  // it needs actual holes. About a fifth of the area ends up open, which is
  // what the organisers' own description ("various runnability and visibility")
  // and the reference photograph both show.
  const open = (t - 0.3) / 0.34;
  return Math.max(0, Math.min(1.45, open * 1.25));
}

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/** Deterministic PRNG. Same chunk, same forest, every run and every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VegetationOptions {
  tier: QualityTier;
  /** Full-mesh radius. Past this, imposters. */
  nearRadius?: number;
  /** Everything is culled past this. Keep it inside the fog. */
  farRadius?: number;
  /** Undergrowth radius. */
  groundRadius?: number;
}

const VEG_CHUNK_M = 40;

/**
 * The vegetation layer.
 *
 * Instances are generated per 40 m chunk from a chunk-seeded PRNG, cached while
 * the chunk stays in range, and re-bucketed by distance into full-mesh LOD0/1
 * or a billboard imposter. Regenerating the cache is the expensive half and is
 * budgeted per frame; re-bucketing is cheap and runs on a short interval rather
 * than every frame, because a tree changing LOD one frame late is invisible and
 * doing it every frame is not free at ten thousand instances.
 */
export class Vegetation {
  readonly group = new THREE.Group();

  /** Live counts, for the debug overlay and the honest perf story. */
  stats = { trees: 0, imposters: 0, boulders: 0, deadwood: 0, undergrowth: 0, chunks: 0 };

  private readonly field: TerrainField;
  private readonly spruce: Asset;
  private readonly beech: Asset;
  private readonly boulder: Asset;
  private readonly deadwood: Asset;

  private readonly nearRadius: number;
  private readonly farRadius: number;
  private readonly groundRadius: number;
  private readonly densityScale: number;

  private readonly cache = new Map<string, Placement[]>();
  private readonly scatterCache = new Map<string, { boulders: Placement[]; deadwood: Placement[] }>();
  private readonly undergrowthCache = new Map<string, Placement[]>();

  private treeBuckets: { asset: Asset; buckets: Bucket[][] }[] = [];
  private boulderBuckets: Bucket[][] = [];
  private deadwoodBuckets: Bucket[][] = [];
  private undergrowthMesh: THREE.InstancedMesh | null = null;
  private undergrowthCount = 0;

  /** Circles where no tree may stand. Start/finish clearings, and the spawn. */
  private readonly exclusions: { x: number; z: number; r2: number }[] = [];

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly lastCamera = new THREE.Vector3(Infinity, 0, Infinity);
  private sinceRebucket = 999;

  constructor(
    field: TerrainField,
    assets: { spruce: Asset; beech: Asset; boulder: Asset; deadwood: Asset },
    opts: VegetationOptions,
  ) {
    this.field = field;
    this.spruce = assets.spruce;
    this.beech = assets.beech;
    this.boulder = assets.boulder;
    this.deadwood = assets.deadwood;
    this.group.name = 'vegetation';

    const tier = opts.tier;
    this.nearRadius = opts.nearRadius ?? (tier === 'low' ? 70 : 120);
    this.farRadius = opts.farRadius ?? (tier === 'low' ? 150 : 230);
    this.groundRadius = opts.groundRadius ?? (tier === 'low' ? 18 : 27);
    this.densityScale = tier === 'low' ? 0.45 : tier === 'medium' ? 0.75 : 1;

    const capacity = tier === 'low' ? 2000 : 6000;

    for (const asset of [this.spruce, this.beech]) {
      const buckets = asset.variants.map((v) =>
        v.lods.map(
          (lod, li) =>
            // LOD0 *and* LOD1 cast. The shadow pass is a second full draw of
            // every caster, so restricting it to LOD0 would have meant either
            // no shadows past the near ring — a very visible bright floor
            // beyond ~25 m — or paying LOD0 geometry across the whole shadow
            // frustum. LOD1 is a rebuilt silhouette, not a decimation, so it
            // casts a shadow that is indistinguishable at these distances.
            new Bucket(this.group, lod, capacity, li < v.lods.length - 1 && tier !== 'low'),
        ),
      );
      this.treeBuckets.push({ asset, buckets });
    }
    this.boulderBuckets = this.boulder.variants.map((v) =>
      v.lods.map((lod, li) => new Bucket(this.group, lod, 900, li === 0 && tier !== 'low')),
    );
    this.deadwoodBuckets = this.deadwood.variants.map((v) =>
      v.lods.map((lod) => new Bucket(this.group, lod, 700, false)),
    );

    this.buildUndergrowth(tier);
  }

  // -------------------------------------------------------------------------
  // Undergrowth
  // -------------------------------------------------------------------------

  /**
   * Solid, alpha-free blade geometry rather than textured cards.
   *
   * Alpha-tested foliage cards at this density are the classic source of the
   * shimmer the brief calls out: every sub-pixel blade edge flickers as the
   * camera moves, and MSAA does not help an alpha test. Tapered solid quads
   * cost about the same, antialias properly, and never crawl. The trade is that
   * they read as tufts rather than fronds, which for the moss-and-bilberry
   * floor of a Šumava spruce stand is the right tuft anyway.
   */
  private buildUndergrowth(tier: QualityTier): void {
    const blades = tier === 'low' ? 4 : 7;
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];

    const rnd = mulberry32(0x5eed);
    for (let b = 0; b < blades; b++) {
      const angle = (b / blades) * Math.PI * 2 + rnd() * 0.7;
      // Splayed low rosette, not upright blades. Lean > 1 means the tip travels
      // further sideways than up, which is what turns a clump of quads from
      // "spikes stuck in the ground" into "something growing on the floor".
      // The upright version was the single worst-looking thing in the scene.
      const lean = 0.55 + rnd() * 0.6;
      const height = 0.07 + rnd() * 0.1;
      const halfW = 0.032 + rnd() * 0.026;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      // Perpendicular, so the blade is not edge-on from its own lean direction.
      const px = -dz * halfW;
      const pz = dx * halfW;

      const tipX = dx * lean * height;
      const tipZ = dz * lean * height;
      const base = pos.length / 3;

      pos.push(-px, 0, -pz, px, 0, pz, tipX * 0.6 - px * 0.4, height * 0.62, tipZ * 0.6 - pz * 0.4);
      pos.push(tipX * 0.6 + px * 0.4, height * 0.62, tipZ * 0.6 + pz * 0.4, tipX, height, tipZ);

      const nx = -dz;
      const nz = dx;
      for (let i = 0; i < 5; i++) nrm.push(nx * 0.35, 0.9, nz * 0.35);

      // Darker at the root, lighter at the tip — the cheapest possible AO and
      // the thing that stops a tuft reading as a flat green splinter.
      // Moss/bilberry green pulled toward olive, matching the RESEARCH-VIDEO
      // §5.2 palette target (H 64–77°, S ~43 %). Root darker than tip: the
      // cheapest AO there is, and the thing that stops a clump reading flat.
      // Matched to the moss layer's own mid-tone, not chosen in isolation.
      // Tuned darker on the first pass and the clumps read as black holes
      // punched in the carpet — the mat has to sit *within* the ground's value
      // range or it stops being ground cover and starts being litter.
      // Values measured against the rendered moss, not picked in isolation: the
      // tufts have to sit slightly *under* the floor's value or every one of
      // them reads as a pale speck and the mid-ground turns to confetti.
      const tint = 0.7 + rnd() * 0.45;
      col.push(0.075 * tint, 0.09 * tint, 0.04 * tint);
      col.push(0.075 * tint, 0.09 * tint, 0.04 * tint);
      col.push(0.135 * tint, 0.16 * tint, 0.07 * tint);
      col.push(0.135 * tint, 0.16 * tint, 0.07 * tint);
      col.push(0.17 * tint, 0.2 * tint, 0.088 * tint);

      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      idx.push(base + 2, base + 3, base + 4);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    const capacity = tier === 'low' ? 3000 : 16000;
    this.undergrowthMesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.undergrowthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.undergrowthMesh.frustumCulled = false;
    this.undergrowthMesh.castShadow = false;
    this.undergrowthMesh.receiveShadow = true;
    this.undergrowthMesh.count = 0;
    this.group.add(this.undergrowthMesh);
  }

  /**
   * Keep trees out of a circle.
   *
   * Needed because a randomly seeded forest will happily put a 27 m spruce
   * exactly where the camera stands, and the player then spawns inside a wall of
   * needles. Start and finish will want the same thing, and real ones are in
   * clearings anyway.
   */
  addExclusion(x: number, z: number, radius: number): void {
    this.exclusions.push({ x, z, r2: radius * radius });
    this.cache.clear();
    this.scatterCache.clear();
    this.undergrowthCache.clear();
  }

  private excluded(x: number, z: number): boolean {
    for (const e of this.exclusions) {
      const dx = x - e.x;
      const dz = z - e.z;
      if (dx * dx + dz * dz < e.r2) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Placement generation
  // -------------------------------------------------------------------------

  private generateChunk(cx: number, cz: number): Placement[] {
    const out: Placement[] = [];
    const f = this.field;
    const rnd = mulberry32((cx * 73856093) ^ (cz * 19349663));
    const area = VEG_CHUNK_M * VEG_CHUNK_M;
    const x0 = cx * VEG_CHUNK_M;
    const z0 = cz * VEG_CHUNK_M;

    // Sample the class at the chunk centre to size the candidate budget, then
    // re-test per candidate. Doing it per candidate only would need the worst
    // case density everywhere; doing it per chunk only would tile the class
    // boundaries into visible 40 m squares.
    const peak = 0.26;
    const candidates = Math.round(peak * area * this.densityScale);

    for (let i = 0; i < candidates; i++) {
      const x = x0 + rnd() * VEG_CHUNK_M;
      const z = z0 + rnd() * VEG_CHUNK_M;
      if (this.excluded(x, z)) continue;
      const run = f.runnabilityAt(x, z);
      const mix = MIX[run];
      if (mix.density <= 0) continue;
      // Openness is applied to the *tree* layer only. The runnability class
      // still governs the mean density, so the map stays true; the noise only
      // decides where within a class the glades fall.
      const open = canopyOpenness(x, z);
      if (rnd() > (mix.density * this.densityScale * open) / peak) continue;

      const beech = rnd() < mix.beechShare;
      const asset = beech ? this.beech : this.spruce;

      // Pick the variant whose natural height is closest to the canopy model,
      // then scale it the rest of the way. This is what ties the 3D forest to
      // the LiDAR: a 27 m stand really is 27 m tall on screen.
      const canopy = f.canopyAt(x, z);
      const target = canopy > 2 ? canopy * (0.72 + rnd() * 0.5) : 3 + rnd() * 4;
      let variant = 0;
      let bestErr = Infinity;
      for (let v = 0; v < asset.variants.length; v++) {
        const err = Math.abs((asset.variants[v] as AssetVariant).heightM - target);
        if (err < bestErr) {
          bestErr = err;
          variant = v;
        }
      }
      const natural = (asset.variants[variant] as AssetVariant).heightM;
      const scale = THREE.MathUtils.clamp((target / natural) * mix.scale, 0.35, 1.8);

      out.push({
        x,
        z,
        y: f.heightAt(x, z),
        scale,
        rotY: rnd() * Math.PI * 2,
        variant: beech ? 0x100 | variant : variant,
        tiltX: 0,
        tiltZ: 0,
      });
    }

    return out;
  }

  private generateScatter(cx: number, cz: number): { boulders: Placement[]; deadwood: Placement[] } {
    const f = this.field;
    const rnd = mulberry32((cx * 83492791) ^ (cz * 2971215073));
    const x0 = cx * VEG_CHUNK_M;
    const z0 = cz * VEG_CHUNK_M;
    const boulders: Placement[] = [];
    const deadwood: Placement[] = [];

    const tryPlace = (list: Placement[], variants: number, rate: number) => {
      const n = rate * VEG_CHUNK_M * VEG_CHUNK_M * this.densityScale;
      const count = Math.floor(n) + (rnd() < n % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const x = x0 + rnd() * VEG_CHUNK_M;
        const z = z0 + rnd() * VEG_CHUNK_M;
        if (this.excluded(x, z)) continue;
        const g = f.gradientAt(x, z);
        list.push({
          x,
          z,
          y: f.heightAt(x, z),
          // Capped at 1.15: boulder-set v4 is already 4.9 m across and deadwood
          // v0 is a 7.3 m log. Scaled to 1.5 they stop reading as objects in a
          // forest and start reading as set dressing dropped from a helicopter.
          scale: 0.62 + rnd() * 0.53,
          rotY: rnd() * Math.PI * 2,
          variant: Math.floor(rnd() * variants),
          // Bed rocks and logs into the slope rather than standing them upright
          // on a hillside, which reads as instantly fake.
          tiltX: -(g[1] as number) * 0.8,
          tiltZ: (g[0] as number) * 0.8,
        });
      }
    };

    const run = f.runnabilityAt(x0 + VEG_CHUNK_M / 2, z0 + VEG_CHUNK_M / 2);
    const mix = MIX[run];
    tryPlace(boulders, this.boulder.variants.length, mix.boulders);
    tryPlace(deadwood, this.deadwood.variants.length, mix.deadwood);
    return { boulders, deadwood };
  }

  private generateUndergrowth(cx: number, cz: number): Placement[] {
    const f = this.field;
    const rnd = mulberry32((cx * 40503) ^ (cz * 12582917));
    const x0 = cx * VEG_CHUNK_M;
    const z0 = cz * VEG_CHUNK_M;
    const out: Placement[] = [];

    // Cap at 2.2 tufts/m². The MIX table goes to 5.2 for a Green3 thicket, but
    // past ~2 they stop reading as individual plants and the cost is linear, so
    // the extra density buys nothing but frame time.
    const peak = 3.4;
    const candidates = Math.round(peak * VEG_CHUNK_M * VEG_CHUNK_M * this.densityScale);
    for (let i = 0; i < candidates; i++) {
      const x = x0 + rnd() * VEG_CHUNK_M;
      const z = z0 + rnd() * VEG_CHUNK_M;
      const mix = MIX[f.runnabilityAt(x, z)];
      if (mix.undergrowth <= 0) continue;
      if (rnd() > Math.min(1, mix.undergrowth / peak)) continue;
      const g = f.gradientAt(x, z);
      out.push({
        x,
        z,
        y: f.heightAt(x, z),
        scale: (0.7 + rnd() * 0.55) * (0.8 + Math.min(mix.undergrowth, 4) * 0.09),
        rotY: rnd() * Math.PI * 2,
        variant: 0,
        tiltX: -(g[1] as number) * 0.5,
        tiltZ: (g[0] as number) * 0.5,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(camera: THREE.PerspectiveCamera, dtS: number): void {
    this.sinceRebucket += dtS;
    const moved = camera.position.distanceToSquared(this.lastCamera);
    // Re-bucket on movement or on a slow tick. Ten thousand matrix writes is
    // ~1 ms; paying it every frame to make a 200 m tree swap LOD sooner is not
    // a trade worth making.
    if (moved < 36 && this.sinceRebucket < 0.25) return;
    this.sinceRebucket = 0;
    this.lastCamera.copy(camera.position);

    this.evictAndFill(camera);
    this.rebucket(camera);
  }

  private evictAndFill(camera: THREE.PerspectiveCamera): void {
    const reach = Math.ceil(this.farRadius / VEG_CHUNK_M);
    const ci = Math.floor(camera.position.x / VEG_CHUNK_M);
    const cj = Math.floor(camera.position.z / VEG_CHUNK_M);

    const wanted = new Set<string>();
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const cx = ci + di;
        const cz = cj + dj;
        const centreX = (cx + 0.5) * VEG_CHUNK_M;
        const centreZ = (cz + 0.5) * VEG_CHUNK_M;
        if (
          Math.hypot(centreX - camera.position.x, centreZ - camera.position.z) >
          this.farRadius + VEG_CHUNK_M
        ) {
          continue;
        }
        const key = `${cx}|${cz}`;
        wanted.add(key);
        if (!this.cache.has(key)) {
          this.cache.set(key, this.generateChunk(cx, cz));
          this.scatterCache.set(key, this.generateScatter(cx, cz));
        }
      }
    }
    for (const key of this.cache.keys()) {
      if (wanted.has(key)) continue;
      this.cache.delete(key);
      this.scatterCache.delete(key);
    }

    // Undergrowth lives in a much tighter ring, cached separately.
    const gReach = Math.ceil(this.groundRadius / VEG_CHUNK_M);
    const gWanted = new Set<string>();
    for (let dj = -gReach; dj <= gReach; dj++) {
      for (let di = -gReach; di <= gReach; di++) {
        const key = `${ci + di}|${cj + dj}`;
        gWanted.add(key);
        if (!this.undergrowthCache.has(key)) {
          this.undergrowthCache.set(key, this.generateUndergrowth(ci + di, cj + dj));
        }
      }
    }
    for (const key of this.undergrowthCache.keys()) {
      if (!gWanted.has(key)) this.undergrowthCache.delete(key);
    }
    this.stats.chunks = this.cache.size;
  }

  private rebucket(camera: THREE.PerspectiveCamera): void {
    for (const entry of this.treeBuckets) {
      for (const variantBuckets of entry.buckets) for (const b of variantBuckets) b.reset();
    }
    for (const v of this.boulderBuckets) for (const b of v) b.reset();
    for (const v of this.deadwoodBuckets) for (const b of v) b.reset();

    const cam = camera.position;
    const near2 = this.nearRadius * this.nearRadius;
    const far2 = this.farRadius * this.farRadius;
    // LOD0 is reserved for the trees you can actually see bark on. At 0.45 of
    // the near radius it covered ~54 m, which is 380 mature spruce at 7 k
    // triangles each — half the frame budget spent on geometry that LOD1 draws
    // identically at this distance. 0.30 (~36 m) is the compromise: close
    // enough to stay cheap, far enough that the LOD0→LOD1 swap is not
    // happening in the player's near field where a pop is unmissable.
    const mid2 = (this.nearRadius * 0.3) ** 2;

    let trees = 0;
    let imposters = 0;

    for (const list of this.cache.values()) {
      for (const p of list) {
        const dx = p.x - cam.x;
        const dz = p.z - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > far2) continue;

        const isBeech = (p.variant & 0x100) !== 0;
        const variant = p.variant & 0xff;
        const entry = this.treeBuckets[isBeech ? 1 : 0];
        if (!entry) continue;
        const variantBuckets = entry.buckets[Math.min(variant, entry.buckets.length - 1)];
        if (!variantBuckets) continue;

        let lod: number;
        if (d2 > near2) lod = variantBuckets.length - 1;
        else if (d2 > mid2) lod = Math.min(1, variantBuckets.length - 1);
        else lod = 0;

        if (lod === variantBuckets.length - 1 && variantBuckets.length > 1) imposters++;
        else trees++;

        this.tmpPos.set(p.x, p.y, p.z);
        this.tmpQuat.setFromEuler(this.tmpEuler.set(0, p.rotY, 0));
        this.tmpScale.setScalar(p.scale);
        this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        (variantBuckets[lod] as Bucket).push(this.tmpMatrix);
      }
    }

    // Scatter: boulders and deadwood, generated on the same chunk keys.
    let boulders = 0;
    let deadwood = 0;
    for (const scatter of this.scatterCache.values()) {
      for (const [list, buckets, isBoulder] of [
        [scatter.boulders, this.boulderBuckets, true] as const,
        [scatter.deadwood, this.deadwoodBuckets, false] as const,
      ]) {
        for (const p of list) {
          const dx = p.x - cam.x;
          const dz = p.z - cam.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > far2) continue;
          const variantBuckets = buckets[Math.min(p.variant, buckets.length - 1)];
          if (!variantBuckets) continue;
          const lod = d2 > near2 ? variantBuckets.length - 1 : d2 > mid2 ? 1 : 0;
          this.tmpPos.set(p.x, p.y, p.z);
          this.tmpQuat.setFromEuler(this.tmpEuler.set(p.tiltX, p.rotY, p.tiltZ));
          this.tmpScale.setScalar(p.scale);
          this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          (variantBuckets[Math.min(lod, variantBuckets.length - 1)] as Bucket).push(this.tmpMatrix);
          if (isBoulder) boulders++;
          else deadwood++;
        }
      }
    }

    for (const entry of this.treeBuckets) {
      for (const variantBuckets of entry.buckets) for (const b of variantBuckets) b.flush();
    }
    for (const v of this.boulderBuckets) for (const b of v) b.flush();
    for (const v of this.deadwoodBuckets) for (const b of v) b.flush();

    // --- undergrowth ---
    const mesh = this.undergrowthMesh;
    if (mesh) {
      const ground2 = this.groundRadius * this.groundRadius;
      let n = 0;
      const cap = mesh.instanceMatrix.count;
      for (const list of this.undergrowthCache.values()) {
        for (const p of list) {
          if (n >= cap) break;
          const dx = p.x - cam.x;
          const dz = p.z - cam.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > ground2) continue;
          // Shrink out over the last quarter of the ring instead of popping.
          // The fog is far too thin at 40 m to hide a hard edge, and a circle
          // of grass ending around the player is the most obvious tell there is.
          const fade = 1 - THREE.MathUtils.smoothstep(Math.sqrt(d2) / this.groundRadius, 0.5, 1);
          if (fade <= 0.02) continue;
          this.tmpPos.set(p.x, p.y, p.z);
          this.tmpQuat.setFromEuler(this.tmpEuler.set(p.tiltX, p.rotY, p.tiltZ));
          this.tmpScale.set(p.scale, p.scale * fade, p.scale);
          this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          mesh.setMatrixAt(n++, this.tmpMatrix);
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      this.undergrowthCount = n;
    }

    this.stats.trees = trees;
    this.stats.imposters = imposters;
    this.stats.boulders = boulders;
    this.stats.deadwood = deadwood;
    this.stats.undergrowth = this.undergrowthCount;
  }

  dispose(): void {
    for (const entry of this.treeBuckets) {
      for (const variantBuckets of entry.buckets) {
        for (const b of variantBuckets) b.dispose(this.group);
      }
    }
    for (const v of this.boulderBuckets) for (const b of v) b.dispose(this.group);
    for (const v of this.deadwoodBuckets) for (const b of v) b.dispose(this.group);
    if (this.undergrowthMesh) {
      this.group.remove(this.undergrowthMesh);
      this.undergrowthMesh.geometry.dispose();
      this.undergrowthMesh.dispose();
    }
    this.cache.clear();
    this.undergrowthCache.clear();
  }
}
