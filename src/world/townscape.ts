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
 * thirteen symbols a competitor must not cross.
 *
 * **Every dimension drawn here comes from `TownModel`** — the barrier's height,
 * its thickness, the water's outline, the deck's width — and the collider was
 * derived from those same numbers when the model was constructed. This file no
 * longer owns a collision index, and that is phase 1's point: the wall you see
 * and the wall that stops you are one object, so there is nothing left to keep
 * in step. See src/world/townModel.ts.
 *
 * Steps are the opposite case and deserve saying out loud: ISSprOM 532 is
 * runnable. They cost time and they are a handrail for navigation, but they are
 * not a barrier, so they are drawn and not blocked — which is why they are
 * emitted as their own mesh with its own role, rather than merged into the
 * masonry, so that a gate reading the scene graph can tell them apart.
 */

import * as THREE from 'three';
import type { QualityTier } from '@/core/capabilities';
import type { TerrainField } from './terrain';
import type { SurfaceTextures, TownscapeData } from './buildings';
import type { Asset } from './vegetation';
import { pointAt } from './surface';
import type { BridgeDecks, DeckSpan } from './surface';
import type { TownBarrier, TownModel } from './townModel';
import type { TownRole } from './roles';
import { tagRole } from './roles';

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
  /**
   * The crossings that stand above the bare earth.
   *
   * Given, the decks are drawn as real surfaces at the height the athlete is
   * placed on. Omitted — a venue with no bridges — nothing is drawn and nothing
   * changes. It must be the *same* `BridgeDecks` the scene founds the camera
   * on, or the athlete walks on a surface that is not the one under them.
   */
  decks?: BridgeDecks;
}

/**
 * How finely a bridge deck is tessellated along its length, metres.
 *
 * Matches `DECK_STEP_M` in surface.ts, which is what the lift was measured on:
 * drawing a deck coarser than it was measured would let a span pass the lift
 * test and then be drawn through the ground it was measured against.
 */
const DECK_SEGMENT_M = 2;

/** How far a deck's skirt sinks below the bare earth at the abutments, metres. */
const DECK_SKIRT_M = 0.5;

/**
 * What a barrier of each kind is made of.
 *
 * Material only. The *thickness* used to live here too, next to a second copy
 * in the extractor and a third in the gate; it is now one number in the model,
 * and this table has nothing to say about how wide a wall is or whether it
 * stops you.
 */
const WALL_MATERIAL: Record<number, 'stone' | 'metal' | 'hedge'> = {
  0: 'stone',
  1: 'stone',
  2: 'stone',
  3: 'metal',
  4: 'hedge',
};

export class Townscape {
  readonly group = new THREE.Group();

  readonly stats = { walls: 0, steps: 0, water: 0, decks: 0, trees: 0, triangles: 0 };

  private readonly water: THREE.MeshStandardMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly treeMeshes: THREE.InstancedMesh[] = [];
  private elapsed = 0;

  constructor(
    data: TownscapeData,
    model: TownModel,
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

    // One buffer per (material, role). The masonry is split three ways —
    // barrier, steps, deck — where it used to be merged into one mesh: two more
    // draw calls, in exchange for a scene graph in which every triangle says
    // whether it is something that should stop the athlete. That is what
    // `tools/ci/check-townmodel.mjs` reads, and a merged mesh made the question
    // unanswerable without going back to the data the mesh was built from,
    // which is the one source a gate must not be allowed to trust.
    const barrierBuf = buf();
    const stepsBuf = buf();
    const deckBuf = buf();
    const metalBuf = buf();
    const hedgeBuf = buf();
    const waterBuf = buf();

    for (const b of model.barriers) {
      const mat = WALL_MATERIAL[b.kind];
      if (!mat) continue;
      const target = mat === 'stone' ? barrierBuf : mat === 'metal' ? metalBuf : hedgeBuf;
      this.buildWall(target, b, field, model.crossableMaxH);
      this.stats.walls++;
    }

    for (const s of data.steps) {
      this.buildSteps(stepsBuf, s.p, s.n, s.w, field);
      this.stats.steps++;
    }

    // Before the water, so a deck drawn over the river wins the depth test at
    // its own edges rather than trading z-fighting with the surface below it.
    for (const span of opts.decks?.spans ?? []) {
      this.buildDeck(deckBuf, span, field);
      this.stats.decks++;
    }

    for (const w of model.waterAreas) {
      this.buildWaterArea(waterBuf, w.ring, w.level);
      this.stats.water++;
    }
    for (const c of model.waterCourses) {
      this.buildWaterRibbon(waterBuf, c.pts, c.width, field);
      this.stats.water++;
    }

    this.emit(barrierBuf, stoneMat, true, 'barrier');
    this.emit(metalBuf, metalMat, true, 'barrier');
    this.emit(hedgeBuf, hedgeMat, true, 'barrier');
    this.emit(stepsBuf, stoneMat, true, 'steps');
    this.emit(deckBuf, stoneMat, true, 'deck');
    this.emit(waterBuf, this.water, false, 'water');

    if (opts.beech) this.buildTrees(data, field, opts.beech, opts.tier);
  }

  private emit(b: Buf, material: THREE.Material, shadow: boolean, role: TownRole): void {
    const g = toGeometry(b);
    if (!g) return;
    this.geometries.push(g);
    this.stats.triangles += b.idx.length / 3;
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    tagRole(mesh, role);
    this.group.add(mesh);
  }

  /**
   * A barrier, drawn to the model's own dimensions.
   *
   * `height` and `halfThickness` are the numbers the model derived its collider
   * from — there is no clamp here, and there is nothing to clamp: a barrier
   * that is drawn tall *is* one that blocks, because `blocks` is a function of
   * this same height. The previous version of this method had to defend itself
   * against a stale file carrying a drawn height and a separate `u` flag that
   * disagreed with it; that file no longer has an `u` flag to disagree with.
   */
  private buildWall(
    b: Buf,
    w: TownBarrier,
    field: TerrainField,
    crossable: number,
  ): void {
    const n = w.pts.length / 2;
    if (n < 2) return;
    const half = w.halfThickness;
    const height = w.height;

    for (let i = 0; i < n - 1; i++) {
      const ax = w.pts[i * 2] as number;
      const az = w.pts[i * 2 + 1] as number;
      const bx = w.pts[i * 2 + 2] as number;
      const bz = w.pts[i * 2 + 3] as number;
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.15 || len > 120) continue;
      const px = (-dz / len) * half;
      const pz = (dx / len) * half;

      // How many pieces this run has to be drawn in to stay above the ground.
      //
      // A barrier way is mapped by its corners, so one segment can run eighty
      // metres over ground that rises and falls several times. Drawn as a
      // single quad its top is a straight line between the two ends, which
      // dives *under* every hump in between — the wall is there, it stops you,
      // and you cannot see it. Measured before this loop existed: 305 m² of
      // Krumlov. So the run is split until the straight top is within
      // `WALL_SAG_M` of the ground it is supposed to stand on, which on flat
      // ground is one piece and on the castle ramp is a dozen.
      // The wall may sag into the ground as far as it can and still stand
      // `crossable` proud of it — the same line D-029 drew, and the same one
      // `Buildings` now stands its footprints on. A barrier that does not block
      // may sag as far as it likes: nobody is stopped by it.
      const maxSag = w.blocks ? height - crossable : Infinity;
      let pieces = 1;
      while (pieces < 4 && maxSag < Infinity) {
        let worst = 0;
        for (let k = 1; k < pieces * 4; k++) {
          const t = k / (pieces * 4);
          const straight = this.pieceTop(field, ax, az, bx, bz, t, pieces);
          const sag = field.heightAt(ax + dx * t, az + dz * t) + height - straight;
          if (sag > worst) worst = sag;
        }
        if (worst <= maxSag) break;
        pieces *= 2;
      }

      // Each *face* follows the ground under itself rather than under the
      // centreline. On the castle ramp and the river bank the cross-slope is
      // steep enough that a city wall's two faces sit 40 cm apart in height,
      // which used to leave one buried and one floating. It also makes the
      // drawn height exact: every top vertex is the ground beneath it plus
      // `height`, which is what lets `check-townmodel` measure "does this
      // stand above the step-over line" without a tolerance to hide behind.
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      const vMax = height;

      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const sx = ax + dx * t0;
        const sz = az + dz * t0;
        const ex = ax + dx * t1;
        const ez = az + dz * t1;
        const uMax = len / pieces;

        const aL = field.heightAt(sx + px, sz + pz);
        const bL = field.heightAt(ex + px, ez + pz);
        const aR = field.heightAt(sx - px, sz - pz);
        const bR = field.heightAt(ex - px, ez - pz);

        // Two faces and a cap. No end caps: walls in the data are long runs and
        // the ends are almost always against a building or another wall.
        quad(b, v(sx + px, aL - 0.35, sz + pz), v(ex + px, bL - 0.35, ez + pz), v(ex + px, bL + height, ez + pz), v(sx + px, aL + height, sz + pz), uMax, vMax);
        quad(b, v(ex - px, bR - 0.35, ez - pz), v(sx - px, aR - 0.35, sz - pz), v(sx - px, aR + height, sz - pz), v(ex - px, bR + height, ez - pz), uMax, vMax);
        quad(b, v(sx - px, aR + height, sz - pz), v(ex - px, bR + height, ez - pz), v(ex + px, bL + height, ez + pz), v(sx + px, aL + height, sz + pz), uMax, half * 2);
      }
    }
  }

  /** The straight top of the piece of `[a,b]` that `t` falls in, metres ASL. */
  private pieceTop(
    field: TerrainField,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    t: number,
    pieces: number,
  ): number {
    const k = Math.min(pieces - 1, Math.floor(t * pieces));
    const t0 = k / pieces;
    const t1 = (k + 1) / pieces;
    const y0 = field.heightAt(ax + (bx - ax) * t0, az + (bz - az) * t0);
    const y1 = field.heightAt(ax + (bx - ax) * t1, az + (bz - az) * t1);
    const f = (t - t0) / (t1 - t0);
    return y0 + (y1 - y0) * f;
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

  /**
   * A bridge deck: the surface the athlete is actually standing on.
   *
   * Drawn because raising the athlete without it would trade one artefact for a
   * worse one — the client would have gone from starting in the river to
   * hovering over it. The deck is a paved strip at the chord height
   * `BridgeDecks` computes, with a skirt down each side to the bare earth so
   * the crossing reads as a solid thing rather than as a floating carpet, and
   * so there is no line of sight under it to the terrain below.
   *
   * Stone, off the shared surface set, because every road bridge in Krumlov is
   * masonry. No parapets: the railings along these decks are already in
   * `data.walls`, drawn and blocked from the same flag as every other barrier,
   * and inventing a second set here would put geometry in front of the athlete
   * that the map does not draw.
   */
  private buildDeck(b: Buf, span: DeckSpan, field: TerrainField): void {
    const steps = Math.max(2, Math.ceil(span.length / DECK_SEGMENT_M));
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    /** Deck top and skirt foot at arc length `s`. */
    const rib = (
      s: number,
    ): { x: number; z: number; px: number; pz: number; top: number; foot: number } => {
      const p = pointAt(span.line, span.at, s);
      const top = span.y0 + (span.y1 - span.y0) * (s / span.length);
      const ground = field.heightAt(p.x, p.z);
      return {
        x: p.x,
        z: p.z,
        px: -p.tz * span.half,
        pz: p.tx * span.half,
        // Never above the deck, and always far enough below it to bury the
        // joint: over the river the skirt reaches the water, on the abutments
        // it sinks a little into the bank.
        top: Math.max(top, ground),
        foot: Math.min(ground, top) - DECK_SKIRT_M,
      };
    };

    let a = rib(0);
    for (let k = 1; k <= steps; k++) {
      const c = rib((k / steps) * span.length);
      const u = span.length / steps;

      // The running surface.
      quad(
        b,
        v(a.x - a.px, a.top, a.z - a.pz),
        v(c.x - c.px, c.top, c.z - c.pz),
        v(c.x + c.px, c.top, c.z + c.pz),
        v(a.x + a.px, a.top, a.z + a.pz),
        u,
        span.half * 2,
      );
      // Both flanks, deck down to the bare earth.
      quad(
        b,
        v(a.x + a.px, a.foot, a.z + a.pz),
        v(c.x + c.px, c.foot, c.z + c.pz),
        v(c.x + c.px, c.top, c.z + c.pz),
        v(a.x + a.px, a.top, a.z + a.pz),
        u,
        a.top - a.foot,
      );
      quad(
        b,
        v(c.x - c.px, c.foot, c.z - c.pz),
        v(a.x - a.px, a.foot, a.z - a.pz),
        v(a.x - a.px, a.top, a.z - a.pz),
        v(c.x - c.px, c.top, c.z - c.pz),
        u,
        a.top - a.foot,
      );
      a = c;
    }
  }

  private buildWaterArea(b: Buf, p: Float32Array, y: number): void {
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

  private buildWaterRibbon(b: Buf, l: Float32Array, width: number, field: TerrainField): void {
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
      // Every segment the model carries is drawn, including the short ones.
      // Skipping segments under half a metre left 6 m² of the mill race
      // out of bounds and invisible — small, and exactly the shape of fault
      // this venue has shipped four times.
      if (len < 1e-6) continue;
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

    // A disc at every vertex, and it is not decoration.
    //
    // The collider is a capsule chain — distance to the segment, clamped —
    // so it is round at the joints, while a strip of quads leaves a wedge
    // missing on the outside of every bend. On a 0.45 m wall that gap is
    // millimetres. On the Vltava, mapped as a centreline 24 m wide, it is
    // metres of river that is out of bounds and not drawn, which is the
    // invisible-wall fault at its own scale: measured at 6 m² before this
    // loop existed. The union of the quads and these discs is exactly the
    // capsule the collider tests.
    for (let i = 0; i < n; i++) {
      const x = l[i * 2] as number;
      const z = l[i * 2 + 1] as number;
      this.buildDisc(b, x, field.heightAt(x, z) + 0.1, z, half);
    }
  }

  /** A flat fan, used to round off the joints of a water ribbon. */
  private buildDisc(b: Buf, cx: number, y: number, cz: number, r: number): void {
    const SIDES = 16;
    const base = b.pos.length / 3;
    b.pos.push(cx, y, cz);
    b.nrm.push(0, 1, 0);
    b.uv.push(cx, cz);
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      // Circumscribed rather than inscribed, so the polygon covers the whole
      // disc the collider tests instead of cutting its corners off.
      const rr = r / Math.cos(Math.PI / SIDES);
      b.pos.push(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr);
      b.nrm.push(0, 1, 0);
      b.uv.push(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr);
    }
    for (let i = 0; i < SIDES; i++) {
      b.idx.push(base, base + 1 + ((i + 1) % SIDES), base + 1 + i);
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
        tagRole(im, 'scenery');
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
      tagRole(im, 'scenery');
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
