/**
 * Everything in the town that is not a building: walls, railings, hedges,
 * steps, the Vltava, and the street trees.
 *
 * This is where the sprint's character actually lives. A town rendered as
 * buildings alone is a set of open courtyards you can run straight through; it
 * is the 619 barriers between them that turn Krumlov into the route-choice
 * puzzle it is. ISSprOM makes the same point cartographically — §2.1: *"thick
 * black lines are only used for uncrossable features"* — and IOF Rule 17.2
 * makes it legal: 515 uncrossable wall and 518 uncrossable fence are two of the
 * thirteen symbols a competitor must not cross. So a wall over 1.5 m is
 * modelled here as geometry *and* registered as a hard blocker, from one flag
 * set once in the extractor.
 *
 * Steps are the opposite case and deserve saying out loud: ISSprOM 532 is
 * runnable. They cost time and they are a handrail for navigation, but they are
 * not a barrier, so they are drawn and not blocked.
 */

import * as THREE from 'three';
import type { QualityTier } from '@/core/capabilities';
import type { TerrainField } from './terrain';
import type { SurfaceTextures, TownscapeData, WallRecord } from './buildings';
import type { Asset } from './vegetation';

// ---------------------------------------------------------------------------
// Blocking segments
// ---------------------------------------------------------------------------

const CELL_M = 12;

/** Uniform-grid index of uncrossable line features. */
export class SegmentIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly seg: number[] = [];
  private readonly half: number[] = [];

  add(ax: number, az: number, bx: number, bz: number, halfWidth: number): void {
    const i = this.half.length;
    this.seg.push(ax, az, bx, bz);
    this.half.push(halfWidth);
    const minX = Math.min(ax, bx) - halfWidth;
    const maxX = Math.max(ax, bx) + halfWidth;
    const minZ = Math.min(az, bz) - halfWidth;
    const maxZ = Math.max(az, bz) + halfWidth;
    for (let cz = Math.floor(minZ / CELL_M); cz <= Math.floor(maxZ / CELL_M); cz++) {
      for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(i);
      }
    }
  }

  test(x: number, z: number): boolean {
    const key = Math.floor(x / CELL_M) * 100003 + Math.floor(z / CELL_M);
    const list = this.cells.get(key);
    if (!list) return false;
    for (const i of list) {
      const ax = this.seg[i * 4] as number;
      const az = this.seg[i * 4 + 1] as number;
      const bx = this.seg[i * 4 + 2] as number;
      const bz = this.seg[i * 4 + 3] as number;
      const h = this.half[i] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      if (px * px + pz * pz <= h * h) return true;
    }
    return false;
  }

  get size(): number {
    return this.half.length;
  }
}

// ---------------------------------------------------------------------------
// Geometry accumulation
// ---------------------------------------------------------------------------

interface Buf {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

function buf(): Buf {
  return { pos: [], nrm: [], uv: [], idx: [] };
}

const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();

function quad(
  b: Buf,
  a: THREE.Vector3,
  bb: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  uMax: number,
  vMax: number,
): void {
  _u.subVectors(bb, a);
  _v.subVectors(d, a);
  _n.crossVectors(_u, _v).normalize();
  const base = b.pos.length / 3;
  const pts = [a, bb, c, d];
  const uvs = [
    [0, 0],
    [uMax, 0],
    [uMax, vMax],
    [0, vMax],
  ];
  for (let i = 0; i < 4; i++) {
    const p = pts[i] as THREE.Vector3;
    const t = uvs[i] as number[];
    b.pos.push(p.x, p.y, p.z);
    b.nrm.push(_n.x, _n.y, _n.z);
    b.uv.push(t[0] as number, t[1] as number);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function toGeometry(b: Buf): THREE.BufferGeometry | null {
  if (!b.idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * The Vltava.
 *
 * Krumlov exists because of this meander — the river wraps the old town on
 * three sides and the castle sits on the rock inside the fourth — so it is not
 * background, it is the thing that makes an aerial of the town recognisable.
 *
 * The material is a plain standard material with a two-wave normal
 * perturbation and a Fresnel sky term. There is no environment map in this
 * scene, so a physically-reflective water surface would render black; the
 * Fresnel term stands in for the sky reflection that actually dominates a river
 * seen from the bank at a low sun angle.
 */
function makeWaterMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1f3a36,
    roughness: 0.34,
    metalness: 0.02,
    dithering: true,
  });
  mat.userData.time = { value: 0 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = mat.userData.time as { value: number };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWaterPos;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWaterPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        varying vec3 vWaterPos;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        // Two crossing wave trains at different scales and speeds. The Vltava
        // here is a shallow, fast, weir-broken river, so the surface is choppy
        // rather than glassy.
        vec2 p = vWaterPos.xz;
        float a = sin( p.x * 0.9 + p.y * 0.4 + uTime * 1.7 );
        float b = sin( p.x * -0.35 + p.y * 1.15 + uTime * 1.15 );
        float c = sin( p.x * 2.7 - p.y * 2.1 + uTime * 3.1 );
        vec3 ripple = vec3( a * 0.045 + c * 0.018, 1.0, b * 0.045 - c * 0.018 );
        normal = normalize( mix( normal, normalize( ripple ), 0.8 ) );
        `,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          // Grazing angles catch the sky; looking straight down you see the
          // bed. The first pass ran this at 1.9 and the Vltava came out a
          // silver ribbon brighter than the roofs, which is what a river looks
          // like in a long exposure and not what it looks like at 08:00.
          float f = pow( 1.0 - abs( dot( normalize( vViewPosition ), normal ) ), 4.0 );
          reflectedLight.indirectSpecular += vec3( 0.20, 0.26, 0.32 ) * f * 0.55;
          reflectedLight.directSpecular *= 1.3;
        }
        `,
      );
  };
  mat.customProgramCacheKey = () => 'town-water';
  return mat;
}

// ---------------------------------------------------------------------------
// Townscape
// ---------------------------------------------------------------------------

export interface TownscapeOptions {
  tier: QualityTier;
  /** Beech, used for the street and garden trees. Optional. */
  beech?: Asset;
}

/**
 * Tallest a barrier may be drawn when nothing stops the athlete at it, metres.
 *
 * Must match `CROSSABLE_MAX_H` in tools/terrain/townscape.mjs, and the data
 * carries the number it was built with (`TownscapeData.crossableMaxH`) so the
 * two cannot drift apart silently.
 *
 * This is the fix for the report that reads "I go through some brown walls, and
 * then I'm stuck again", and it is worth being exact about what went wrong,
 * because the diagnosis that looked obvious was not the one. Nothing here is in
 * the wrong coordinate frame: walls, footprints and the water all come from OSM
 * lon/lat through the same tangent-plane transform `src/core/geo.ts` defines,
 * the ZABAGED overlay goes through the same `geoToWorld`, and only the *height*
 * rasters are resampled out of S-JTSK (D-017). Measured against the shipped
 * raster, 100 % of uncrossable barrier length is stamped and the impassable
 * cells with nothing visible on them are 1.2 % of the playable ground, a metre
 * from something drawn, with no preferred bearing. There is no rotation.
 *
 * What there was: 44 % of the barrier length in Krumlov was drawn as a solid
 * 1.5 m slab and registered no collider at all, because the extractor invented
 * that 1.5 m for every untagged fence and then decided crossability from it.
 * So the athlete ran through the visible barrier into the strip behind it and
 * jammed against the uncrossable wall on its far side — one event, both halves
 * of the sentence.
 */
export const CROSSABLE_MAX_H = 0.9;

const WALL_SPEC: Record<number, { thick: number; mat: 'stone' | 'metal' | 'hedge' }> = {
  0: { thick: 0.45, mat: 'stone' },
  1: { thick: 1.15, mat: 'stone' },
  2: { thick: 0.6, mat: 'stone' },
  3: { thick: 0.1, mat: 'metal' },
  4: { thick: 0.95, mat: 'hedge' },
};

export class Townscape {
  readonly group = new THREE.Group();
  /** Uncrossable line features — ISSprOM 411/515/518, all DSQ under Rule 17.2. */
  readonly blocks = new SegmentIndex();

  readonly stats = { walls: 0, steps: 0, water: 0, trees: 0, triangles: 0 };

  private readonly water: THREE.MeshStandardMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly treeMeshes: THREE.InstancedMesh[] = [];
  private elapsed = 0;

  constructor(
    data: TownscapeData,
    field: TerrainField,
    stone: SurfaceTextures,
    opts: TownscapeOptions,
  ) {
    this.group.name = 'townscape';

    const stoneMat = new THREE.MeshStandardMaterial({
      map: stone.albedo,
      normalMap: opts.tier === 'low' ? null : stone.normal,
      roughnessMap: stone.roughness,
      aoMap: stone.ao,
      roughness: 0.95,
      metalness: 0,
      color: 0xb9b0a2,
    });
    // Wrought iron and painted steel railings. Krumlov has a lot of them along
    // the river wall and the castle ramps.
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x2b2a28,
      roughness: 0.55,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });
    const hedgeMat = new THREE.MeshStandardMaterial({
      color: 0x4a5c39,
      roughness: 0.98,
      metalness: 0,
    });
    this.water = makeWaterMaterial();
    this.materials.push(stoneMat, metalMat, hedgeMat, this.water);

    const stoneBuf = buf();
    const metalBuf = buf();
    const hedgeBuf = buf();
    const waterBuf = buf();

    for (const w of data.walls) {
      const spec = WALL_SPEC[w.k];
      if (!spec) continue;
      const target =
        spec.mat === 'stone' ? stoneBuf : spec.mat === 'metal' ? metalBuf : hedgeBuf;
      this.buildWall(target, w, spec.thick, field);
      this.stats.walls++;
    }

    for (const s of data.steps) {
      this.buildSteps(stoneBuf, s.p, s.n, s.w, field);
      this.stats.steps++;
    }

    for (const w of data.water) {
      if (w.p && w.y !== undefined) {
        this.buildWaterArea(waterBuf, w.p, w.y);
        this.stats.water++;
      } else if (w.l && w.w) {
        this.buildWaterRibbon(waterBuf, w.l, w.w, field);
        this.stats.water++;
      }
    }

    this.emit(stoneBuf, stoneMat, true);
    this.emit(metalBuf, metalMat, true);
    this.emit(hedgeBuf, hedgeMat, true);
    this.emit(waterBuf, this.water, false);

    if (opts.beech) this.buildTrees(data, field, opts.beech, opts.tier);
  }

  private emit(b: Buf, material: THREE.Material, shadow: boolean): void {
    const g = toGeometry(b);
    if (!g) return;
    this.geometries.push(g);
    this.stats.triangles += b.idx.length / 3;
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
  }

  private buildWall(b: Buf, w: WallRecord, thick: number, field: TerrainField): void {
    const n = w.p.length / 2;
    if (n < 2) return;
    const half = thick * 0.5;
    // Draw only what the collider below will actually enforce. With current
    // data this clamp never bites — the extractor already derives `u` from the
    // same number — but it is what makes a stale townscape.json degrade into a
    // low fence rather than back into a wall you can walk through.
    const height = w.u ? w.h : Math.min(w.h, CROSSABLE_MAX_H);

    for (let i = 0; i < n - 1; i++) {
      const ax = w.p[i * 2] as number;
      const az = w.p[i * 2 + 1] as number;
      const bx = w.p[i * 2 + 2] as number;
      const bz = w.p[i * 2 + 3] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.15 || len > 120) continue;
      const px = (-dz / len) * half;
      const pz = (dx / len) * half;

      // Both ends follow the ground so a wall on the castle ramp does not float
      // at one end and bury itself at the other.
      const ag = field.heightAt(ax, az) - 0.35;
      const bg = field.heightAt(bx, bz) - 0.35;
      const at = field.heightAt(ax, az) + height;
      const bt = field.heightAt(bx, bz) + height;

      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      const uMax = len;
      const vMax = height;

      // Two faces and a cap. No end caps: walls in the data are long runs and
      // the ends are almost always against a building or another wall.
      quad(b, v(ax + px, ag, az + pz), v(bx + px, bg, bz + pz), v(bx + px, bt, bz + pz), v(ax + px, at, az + pz), uMax, vMax);
      quad(b, v(bx - px, bg, bz - pz), v(ax - px, ag, az - pz), v(ax - px, at, az - pz), v(bx - px, bt, bz - pz), uMax, vMax);
      quad(b, v(ax - px, at, az - pz), v(bx - px, bt, bz - pz), v(bx + px, bt, bz + pz), v(ax + px, at, az + pz), uMax, thick);

      // ISSprOM 515/518 and 411 — a legal boundary under Rule 17.2, so it
      // blocks. Below `CROSSABLE_MAX_H` it is 513.1/516 crossable and does not,
      // which is only defensible because the quad above is now drawn at a
      // height a runner is obviously stepping over.
      if (w.u) this.blocks.add(ax, az, bx, bz, half + 0.25);
    }
  }

  /**
   * A flight of steps.
   *
   * Generated from the polyline and the ground fall along it rather than from
   * `step_count`, because the tag is missing on a fifth of them and the LiDAR
   * always knows the drop. Riser height is pinned at 0.16 m and the tread count
   * follows, which is what makes a long Krumlov flight read as a *flight*
   * rather than as a ramp with lines on it.
   */
  private buildSteps(
    b: Buf,
    p: number[],
    tagged: number,
    width: number,
    field: TerrainField,
  ): void {
    const n = p.length / 2;
    if (n < 2) return;
    const x0 = p[0] as number;
    const z0 = p[1] as number;
    const x1 = p[(n - 1) * 2] as number;
    const z1 = p[(n - 1) * 2 + 1] as number;
    const y0 = field.heightAt(x0, z0);
    const y1 = field.heightAt(x1, z1);
    const drop = Math.abs(y1 - y0);
    if (drop < 0.4) return;

    const count = Math.max(2, Math.min(60, tagged > 0 ? tagged : Math.round(drop / 0.16)));
    const half = Math.max(0.6, width * 0.5);
    const up = y1 > y0;

    // Walk the polyline by arc length so the treads follow a curving flight.
    const lengths: number[] = [0];
    for (let i = 1; i < n; i++) {
      const dx = (p[i * 2] as number) - (p[i * 2 - 2] as number);
      const dz = (p[i * 2 + 1] as number) - (p[i * 2 - 1] as number);
      lengths.push((lengths[i - 1] as number) + Math.hypot(dx, dz));
    }
    const total = lengths[n - 1] as number;
    if (total < 0.8) return;

    const at = (s: number): { x: number; z: number; tx: number; tz: number } => {
      let i = 1;
      while (i < n - 1 && (lengths[i] as number) < s) i++;
      const l0 = lengths[i - 1] as number;
      const l1 = lengths[i] as number;
      const t = l1 > l0 ? (s - l0) / (l1 - l0) : 0;
      const ax = p[i * 2 - 2] as number;
      const az = p[i * 2 - 1] as number;
      const bx = p[i * 2] as number;
      const bz = p[i * 2 + 1] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      return { x: ax + dx * t, z: az + dz * t, tx: dx / len, tz: dz / len };
    };

    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (let k = 0; k < count; k++) {
      const s0 = (k / count) * total;
      const s1 = ((k + 1) / count) * total;
      const a = at(s0);
      const c = at(s1);
      const ya = y0 + (up ? 1 : -1) * (drop * k) / count;
      const yb = y0 + (up ? 1 : -1) * (drop * (k + 1)) / count;

      const apx = -a.tz * half;
      const apz = a.tx * half;
      const cpx = -c.tz * half;
      const cpz = c.tx * half;

      // Tread, held level at the *upper* of its two ends.
      const y = up ? yb : ya;
      quad(
        b,
        v(a.x - apx, y, a.z - apz),
        v(c.x - cpx, y, c.z - cpz),
        v(c.x + cpx, y, c.z + cpz),
        v(a.x + apx, y, a.z + apz),
        s1 - s0,
        half * 2,
      );
      // Riser.
      const yLow = Math.min(ya, yb) - 0.05;
      const rx = up ? a.x : c.x;
      const rz = up ? a.z : c.z;
      const rpx = up ? apx : cpx;
      const rpz = up ? apz : cpz;
      quad(
        b,
        v(rx - rpx, yLow, rz - rpz),
        v(rx + rpx, yLow, rz + rpz),
        v(rx + rpx, y, rz + rpz),
        v(rx - rpx, y, rz - rpz),
        half * 2,
        Math.abs(y - yLow),
      );
    }
  }

  private buildWaterArea(b: Buf, p: number[], y: number): void {
    const ring: THREE.Vector2[] = [];
    for (let i = 0; i < p.length; i += 2) {
      ring.push(new THREE.Vector2(p[i] as number, p[i + 1] as number));
    }
    if (ring.length < 3) return;
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(ring, []);
    } catch {
      return;
    }
    const base = b.pos.length / 3;
    for (const pt of ring) {
      b.pos.push(pt.x, y, pt.y);
      b.nrm.push(0, 1, 0);
      b.uv.push(pt.x, pt.y);
    }
    for (const f of faces) {
      b.idx.push(base + (f[0] as number), base + (f[2] as number), base + (f[1] as number));
    }
  }

  private buildWaterRibbon(b: Buf, l: number[], width: number, field: TerrainField): void {
    const n = l.length / 2;
    if (n < 2) return;
    const half = width * 0.5;
    for (let i = 0; i < n - 1; i++) {
      const ax = l[i * 2] as number;
      const az = l[i * 2 + 1] as number;
      const bx = l[i * 2 + 2] as number;
      const bz = l[i * 2 + 3] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const px = (-dz / len) * half;
      const pz = (dx / len) * half;
      const ya = field.heightAt(ax, az) + 0.1;
      const yb = field.heightAt(bx, bz) + 0.1;
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      quad(
        b,
        v(ax - px, ya, az - pz),
        v(ax + px, ya, az + pz),
        v(bx + px, yb, bz + pz),
        v(bx - px, yb, bz - pz),
        width,
        len,
      );
    }
  }

  /**
   * Street and garden trees from the OSM `natural=tree` nodes, with the LiDAR's
   * own crown height for each one.
   *
   * Two instanced meshes rather than the forest's full LOD ladder: the 24
   * nearest get beech LOD1, everything else gets the crossed-billboard LOD2.
   * At 3070 triangles a LOD1 beech is not a street tree budget — 301 of them
   * would be 900 k triangles for scenery that is never the subject of the shot.
   */
  private buildTrees(
    data: TownscapeData,
    field: TerrainField,
    beech: Asset,
    tier: QualityTier,
  ): void {
    const variant = beech.variants[0];
    if (!variant || variant.lods.length === 0) return;
    const nearLod = variant.lods[Math.min(1, variant.lods.length - 1)];
    const farLod = variant.lods[variant.lods.length - 1];
    if (!nearLod || !farLod) return;

    const trees = data.trees.filter(
      (t) => Math.abs(t[0] as number) < 640 && Math.abs(t[1] as number) < 640,
    );
    this.stats.trees = trees.length;
    if (!trees.length) return;

    const nearCap = tier === 'low' ? 0 : 24;
    const matrices: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const t of trees) {
      const x = t[0] as number;
      const z = t[1] as number;
      const h = Math.max(5, Math.min(26, t[2] as number));
      const s = h / Math.max(1, variant.heightM);
      pos.set(x, field.heightAt(x, z) - 0.2, z);
      q.setFromAxisAngle(UP, (x * 0.37 + z * 0.11) % (Math.PI * 2));
      scl.set(s, s, s);
      matrices.push(new THREE.Matrix4().compose(pos, q, scl));
    }

    this.treeSets = { near: [], far: [], matrices, nearCap };

    if (nearCap > 0 && nearLod !== farLod) {
      for (const part of nearLod.parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, nearCap);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        this.group.add(im);
        this.treeMeshes.push(im);
        this.treeSets.near.push(im);
      }
    }
    for (const part of farLod.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      this.group.add(im);
      this.treeMeshes.push(im);
      this.treeSets.far.push(im);
    }
  }

  private treeSets: {
    near: THREE.InstancedMesh[];
    far: THREE.InstancedMesh[];
    matrices: THREE.Matrix4[];
    nearCap: number;
  } | null = null;

  private sinceRebucket = 99;
  private readonly lastCam = new THREE.Vector3(Infinity, 0, Infinity);

  update(camera: THREE.PerspectiveCamera, dtS: number): void {
    this.elapsed += dtS;
    (this.water.userData.time as { value: number }).value = this.elapsed;

    const sets = this.treeSets;
    if (!sets) return;
    this.sinceRebucket += dtS;
    const moved = this.lastCam.distanceTo(camera.position);
    if (moved < 20 && this.sinceRebucket < 0.4) return;
    this.sinceRebucket = 0;
    this.lastCam.copy(camera.position);

    const cam = camera.position;
    const order = sets.matrices
      .map((mm, i) => ({
        i,
        d: (mm.elements[12] as number - cam.x) ** 2 + (mm.elements[14] as number - cam.z) ** 2,
      }))
      .sort((a, b) => a.d - b.d);

    let near = 0;
    let far = 0;
    for (const o of order) {
      const mm = sets.matrices[o.i] as THREE.Matrix4;
      if (near < sets.nearCap && sets.near.length && o.d < 90 * 90) {
        for (const im of sets.near) im.setMatrixAt(near, mm);
        near++;
      } else {
        for (const im of sets.far) im.setMatrixAt(far, mm);
        far++;
      }
    }
    for (const im of sets.near) {
      im.count = near;
      im.instanceMatrix.needsUpdate = true;
    }
    for (const im of sets.far) {
      im.count = far;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const im of this.treeMeshes) {
      this.group.remove(im);
      im.dispose();
    }
    this.geometries.length = 0;
    this.treeMeshes.length = 0;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
