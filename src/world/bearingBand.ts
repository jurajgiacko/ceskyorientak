/**
 * The beginner's bearing band — a translucent light-blue corridor laid on the
 * ground, pointing the way to the next control.
 *
 * ---------------------------------------------------------------------------
 * What this is allowed to be, and what it must never become
 * ---------------------------------------------------------------------------
 *
 * The whole game is that there is **no GPS dot**. Where you are on the map is
 * your own estimate and it drifts (`Race.believedPosition`), and recovering
 * from that is the sport. A hint that drew a line from your true position to
 * the exact control would delete all of it.
 *
 * So three rules are built into the geometry rather than left to discipline:
 *
 *  1. **It is a bearing, not a path.** A straight corridor along the direction
 *     to the control — it does not route round the building in front of you,
 *     and in Krumlov it frequently points straight at a wall. Reading the map
 *     to find the way round is the thing the player is meant to learn.
 *  2. **It flares.** The corridor opens at `HALF_ANGLE_DEG` a side, which is
 *     the running "rough compass" error a real orienteer accepts
 *     (RESEARCH-SPORT §6.1: ~10° at speed). It cannot be read as a precise
 *     line to a precise spot, because it is not one.
 *  3. **It lets go near the control.** Opacity falls to nothing between
 *     `FADE_FAR_M` and `FADE_NEAR_M`, so the aid gets you out of the start and
 *     off in the right direction and then leaves you to do the actual
 *     orienteering — the attack point and the final approach — yourself.
 *
 * And the honest part, which is the point of the whole design: the caller
 * derives the bearing from the athlete's **believed** position, so if the
 * player has drifted the band drifts with them and points somewhere wrong.
 * Punching a control corrects the belief, and the band snaps straight along
 * with it. The aid is inside the mechanic instead of a way around it.
 */

import * as THREE from 'three';
import type { TerrainField } from './terrain';

/** Half-width of the corridor at the athlete's feet, metres. */
const NEAR_HALF_W = 0.9;
/** How far the corridor opens per metre of length — RESEARCH-SPORT §6.1. */
const HALF_ANGLE_DEG = 7;
/** Longest corridor drawn, metres. Long enough to commit to, short of a leg. */
const MAX_LEN_M = 55;
const MIN_LEN_M = 14;
/** Ground clearance, metres. Enough to clear the terrain between samples. */
const LIFT_M = 0.14;
/** Sample spacing along the corridor, metres. */
const SEG_M = 2.5;

/** Full strength beyond this distance to the control, metres. */
const FADE_FAR_M = 130;
/** Gone by this distance. Inside it, the sport is the search. */
const FADE_NEAR_M = 55;

/** Peak opacity. Deliberately faint — a hint, not a road marking. */
const PEAK_ALPHA = 0.34;
/** How fast the drawn opacity chases the target, per second. */
const FADE_RATE = 3.5;

export interface BearingAim {
  /** Where the corridor is drawn from — the athlete's true position. */
  from: { x: number; z: number };
  /**
   * Where the athlete *believes* they are. The bearing is measured from here,
   * which is what makes the aid drift when the player is lost.
   */
  believed: { x: number; z: number };
  /** The next control, or the finish. */
  to: { x: number; z: number };
}

export class BearingBand {
  readonly group = new THREE.Group();

  private readonly field: TerrainField;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly segs: number;

  private alpha = 0;

  constructor(field: TerrainField, colour: THREE.ColorRepresentation) {
    this.field = field;
    this.group.name = 'bearingBand';
    this.segs = Math.ceil(MAX_LEN_M / SEG_M);

    const rows = this.segs + 1;
    this.positions = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const index: number[] = [];
    for (let i = 0; i < rows; i++) {
      const u = i / this.segs;
      uv[(i * 2) * 2] = u;
      uv[(i * 2) * 2 + 1] = 0;
      uv[(i * 2 + 1) * 2] = u;
      uv[(i * 2 + 1) * 2 + 1] = 1;
      if (i < this.segs) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(index);

    this.material = new THREE.MeshBasicMaterial({
      color: colour,
      map: makeFalloffTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Depth *test* stays on, deliberately. In Krumlov the band must be hidden
      // by the building it points into — a hint that shines through a wall
      // would be telling the player the wall is not there.
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  /**
   * Rebuild the corridor for this frame. `aim` null hides it — the setting is
   * off, the race has not started, or there is nothing left to point at.
   */
  update(aim: BearingAim | null, dtS: number): void {
    const target = aim ? this.rebuild(aim) : 0;
    this.alpha += (target - this.alpha) * Math.min(1, dtS * FADE_RATE);
    if (this.alpha < 0.004) {
      this.alpha = 0;
      this.mesh.visible = false;
      this.material.opacity = 0;
      return;
    }
    this.mesh.visible = true;
    this.material.opacity = this.alpha;
  }

  /** Lay the strip along the bearing and return the opacity it wants. */
  private rebuild(aim: BearingAim): number {
    // The bearing comes from the belief; the corridor is drawn from the feet.
    // Anything else either lies about the direction or draws a ribbon starting
    // several metres to one side of the player, which reads as a bug.
    const dx = aim.to.x - aim.believed.x;
    const dz = aim.to.z - aim.believed.z;
    const believedDist = Math.hypot(dx, dz);
    if (believedDist < 1) return 0;

    const strength = clamp01((believedDist - FADE_NEAR_M) / (FADE_FAR_M - FADE_NEAR_M));
    if (strength <= 0) return 0;

    const ux = dx / believedDist;
    const uz = dz / believedDist;
    // Perpendicular in the ground plane.
    const px = -uz;
    const pz = ux;

    const len = Math.min(MAX_LEN_M, Math.max(MIN_LEN_M, believedDist - FADE_NEAR_M * 0.5));
    const flare = Math.tan((HALF_ANGLE_DEG * Math.PI) / 180);

    const pos = this.positions;
    for (let i = 0; i <= this.segs; i++) {
      const s = (i / this.segs) * len;
      const half = NEAR_HALF_W + s * flare;
      const cx = aim.from.x + ux * s;
      const cz = aim.from.z + uz * s;
      for (const side of [-1, 1]) {
        const x = cx + px * half * side;
        const z = cz + pz * half * side;
        const k = (i * 2 + (side < 0 ? 0 : 1)) * 3;
        pos[k] = x;
        pos[k + 1] = this.field.heightAt(x, z) + LIFT_M;
        pos[k + 2] = z;
      }
    }
    this.posAttr.needsUpdate = true;
    this.geometry.computeBoundingSphere();

    return PEAK_ALPHA * strength;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

/**
 * The corridor's alpha, baked into a small texture.
 *
 * A texture rather than a custom shader on purpose. A shader that fails to
 * compile makes geometry vanish while every other check stays green, and this
 * project has shipped that twice; `MeshBasicMaterial` with a map is a path
 * three.js compiles for every scene already.
 *
 * u runs along the corridor, v across it.
 */
function makeFalloffTexture(): THREE.Texture {
  const W = 64;
  const H = 32;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    // Soft edges, and a stronger spine down the middle so the corridor reads as
    // a band with a direction rather than as a rectangle of tint.
    const v = (j + 0.5) / H;
    const edge = smoothstep(0.5, 0.24, Math.abs(v - 0.5));
    const spine = 0.72 + 0.28 * smoothstep(0.3, 0, Math.abs(v - 0.5));
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      // Fades in over the first few metres and out over the far half. The
      // fade-in is not cosmetic: at 1.62 m of eye height the ground within
      // about five metres fills the bottom of the screen, so a band at full
      // strength from the toes is a wash over the view rather than a direction
      // in it. The fade-out is the design rule — it reads as a direction, not
      // as a destination.
      const along = smoothstep(0.02, 0.16, u) * smoothstep(1, 0.45, u);
      const k = (j * W + i) * 4;
      img.data[k] = 255;
      img.data[k + 1] = 255;
      img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(255 * edge * spine * along);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 0 at `edge0`, 1 at `edge1`, smooth between. Works with edge0 > edge1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The band's colour, from the design tokens.
 *
 * `--c-aid` lives in src/styles/base.css with every other colour in the
 * project. Falls back to the same value only if the stylesheet has not been
 * applied yet, which is a boot-order accident rather than a design decision.
 */
export function aidColour(): THREE.Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--c-aid').trim();
  const col = new THREE.Color();
  try {
    col.setStyle(raw || '#7ec8f2', THREE.SRGBColorSpace);
  } catch {
    col.setStyle('#7ec8f2', THREE.SRGBColorSpace);
  }
  return col;
}
