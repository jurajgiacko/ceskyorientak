/**
 * Buildings — the sprint venue's terrain.
 *
 * In the forest the landform is the subject and the trees dress it. In a sprint
 * the buildings *are* the landform: they set every route choice, they cast every
 * shadow, and under IOF Rule 17.2 they are legally out of bounds, so they are
 * also the collision geometry. ISSprOM 521 lists Building among the thirteen
 * symbols a competitor must not enter — that is a rule of the sport, not a
 * cartographic hint, so `blocks()` here is the same fact the map draws.
 *
 * Where the heights come from
 * ---------------------------
 * Every eave and ridge in `townscape.json` is measured from ČÚZK LiDAR —
 * DMP 1G minus DMR 5G inside the footprint, fitted for pitch across the roof's
 * short axis (see `tools/terrain/townscape.mjs`). `building:levels` is the
 * fallback for the 16 % of footprints the CHM cannot resolve. That ordering
 * matters for this town specifically: Krumlov's silhouette is steep tile roofs,
 * and a storey count cannot tell a 45° roof from a flat one, so a levels-first
 * model produces a set of boxes with the right heights and the wrong skyline.
 *
 * Cost
 * ----
 * ~25 triangles per building over 1739 buildings. Batched into 150 m tiles,
 * two draw calls each (plaster, tile), frustum- and distance-culled. Nothing is
 * instanced because no two footprints in a medieval town are the same shape.
 */

import * as THREE from 'three';
import type { QualityTier } from '@/core/capabilities';
import type { TerrainField } from './terrain';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Roof shape codes, mirroring `ROOF` in tools/terrain/townscape.mjs. */
export const enum RoofShape {
  Flat = 0,
  Gabled = 1,
  Hipped = 2,
  Pyramidal = 3,
  Skillion = 4,
  HalfHipped = 5,
  Mansard = 6,
  Domed = 7,
}

export interface BuildingRecord {
  /** Footprint ring, flat [x0,z0,x1,z1,…], counter-clockwise, world metres. */
  p: number[];
  /** Ground elevation under the footprint, metres ASL. */
  b: number;
  /** Eave elevation, metres ASL. */
  e: number;
  /** Ridge elevation, metres ASL. */
  r: number;
  s: RoofShape;
  /** Ridge azimuth in degrees, 0 = north, clockwise. */
  a: number;
  /** Wall colour, 0xRRGGBB. */
  w: number;
  /** Roof colour, 0xRRGGBB. */
  c: number;
  /** 0 ordinary · 1 church · 2 castle · 3 tower · 4 outbuilding. */
  k: number;
  /** OSM id, present on named and non-ordinary buildings. */
  id?: number;
}

export interface WallRecord {
  p: number[];
  h: number;
  /** 0 wall · 1 city wall · 2 retaining wall · 3 fence/railing · 4 hedge. */
  k: number;
  /** 1 when ISSprOM 515/518 applies — over 1.5 m, and therefore forbidden. */
  u: number;
}

export interface StepRecord {
  p: number[];
  n: number;
  w: number;
}

export interface WaterRecord {
  /** Polygon ring, when this is an area. */
  p?: number[];
  /** Centreline, when this is a watercourse. */
  l?: number[];
  /** Surface elevation for an area, metres ASL. */
  y?: number;
  /** Width for a centreline, metres. */
  w?: number;
  c?: number[];
}

export interface PavedRecord {
  /** Centreline, flat [x0,z0,…], world metres. */
  l: number[];
  /** Carriageway width, metres. */
  w: number;
  /** 0 paved (Runnability.Road) · 1 unpaved (Runnability.Path). */
  k: number;
}

export interface AreaRecord {
  p: number[];
  /** 0 paved · 1 grass. */
  k: number;
}

export interface TownscapeData {
  venue: string;
  origin: { lon: number; lat: number };
  source: Record<string, string>;
  stats: Record<string, number>;
  buildings: BuildingRecord[];
  walls: WallRecord[];
  steps: StepRecord[];
  water: WaterRecord[];
  trees: number[][];
  areas: AreaRecord[];
  paved: PavedRecord[];
  bridges: { p: number[]; name: string; id: number }[];
}

export async function loadTownscape(venue: string): Promise<TownscapeData> {
  const url = `/data/${venue}/townscape.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const data = (await r.json()) as TownscapeData;
  if (!Array.isArray(data.buildings) || data.buildings.length === 0) {
    throw new Error(`${url}: no buildings — run tools/terrain/townscape.mjs`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function tierSuffix(tier: QualityTier): string {
  return tier === 'low' ? '@256' : tier === 'medium' ? '@512' : '';
}

export interface SurfaceTextures {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  ao: THREE.Texture;
  dispose(): void;
}

export async function loadSurface(
  name: string,
  tier: QualityTier,
  repeatM: number,
): Promise<SurfaceTextures> {
  const suffix = tierSuffix(tier);
  const loader = new THREE.TextureLoader();
  const get = async (map: string, srgb: boolean): Promise<THREE.Texture> => {
    const t = await loader.loadAsync(`/textures/${name}/${map}${suffix}.webp`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    // UVs are authored in world metres, so the repeat is the inverse of the
    // physical tile size and nothing downstream has to know the texture's
    // resolution.
    t.repeat.set(1 / repeatM, 1 / repeatM);
    t.anisotropy = tier === 'high' ? 8 : 4;
    return t;
  };
  const [albedo, normal, roughness, ao] = await Promise.all([
    get('albedo', true),
    get('normal', false),
    get('roughness', false),
    get('ao', false),
  ]);
  return {
    albedo,
    normal,
    roughness,
    ao,
    dispose() {
      albedo.dispose();
      normal.dispose();
      roughness.dispose();
      ao.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Plaster with windows drawn into it.
 *
 * The windows are procedural rather than modelled, and they are not decoration:
 * a town of untextured plaster prisms reads as a massing study, and the single
 * cheapest thing that turns it back into architecture is a regular grid of dark
 * openings at storey pitch. They are keyed off the wall's own UV — `u` is
 * metres along the wall, `v` is metres above the ground at that point — so the
 * courses line up across a whole terrace without any per-building work, and a
 * 40 m castle wing gets thirteen floors of them for free.
 *
 * The alternative, real window geometry, is roughly 24 extra triangles per
 * opening. Over 1739 buildings that is a quarter of a million triangles to say
 * something a texture lookup says just as well at 30 m.
 */
function makeWallMaterial(tex: SurfaceTextures, tier: QualityTier): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.albedo,
    normalMap: tier === 'low' ? null : tex.normal,
    roughnessMap: tex.roughness,
    aoMap: tex.ao,
    roughness: 0.92,
    metalness: 0,
    vertexColors: true,
    dithering: true,
  });

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec2 wallUv;
        varying vec2 vWallUv;
        `,
      )
      .replace(
        '#include <uv_vertex>',
        /* glsl */ `
        #include <uv_vertex>
        vWallUv = wallUv;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec2 vWallUv;

        // Storey pitch, opening pitch, opening size. Metres, and measured off
        // the ČÚZK 12.5 cm orthophoto rather than invented: Krumlov's burgher
        // houses run about 3.2 m floor to floor with roughly 1.2 m of window
        // every 2.7 m along the façade.
        const float STOREY = 3.3;
        const float BAY    = 3.4;
        const float WIN_W  = 1.05;
        const float WIN_H  = 1.45;
        const float SILL   = 1.15;

        // Returns x = glass mask, y = reveal (the shadowed frame around it).
        vec2 windowMask( vec2 p ) {
          // No openings in the plinth, and none in the top 0.6 m where the
          // eave and the gutter are.
          if ( p.y < 1.6 ) return vec2( 0.0 );
          // p.x already carries a per-building phase offset (see buildWalls),
          // so neighbouring houses do not share a bay grid. Without it a
          // hundred-metre terrace reads as one building with a lot of windows.
          float bay = mod( p.x + BAY * 0.5, BAY ) - BAY * 0.5;
          float storey = mod( p.y - SILL, STOREY );
          float dx = abs( bay ) - WIN_W * 0.5;
          float dy = abs( storey - WIN_H * 0.5 ) - WIN_H * 0.5;
          float d = max( dx, dy );
          float glass = 1.0 - smoothstep( -0.06, 0.02, d );
          float reveal = ( 1.0 - smoothstep( 0.02, 0.16, d ) ) - glass;
          return vec2( glass, max( 0.0, reveal ) );
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        // The plaster map is used as *modulation*, not as colour.
        //
        // Krumlov's façades are lime-washed cream, ochre, pale pink, celadon —
        // 364 of them carry a surveyed building:colour tag and the rest get the
        // palette measured off the orthophoto. All of that arrives in the
        // vertex colour. Multiplying a single saturated brown plaster texture
        // on top of it made every house the same dirty ochre and turned the
        // stains into wallpaper, which is exactly what the first build looked
        // like. Taking the texture's luminance instead keeps its grain, its
        // damp patches and its cracks, and lets the per-building colour say
        // what colour the building is.
        vec4 plasterTexel = texture2D( map, vMapUv );
        float plasterLum = dot( plasterTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        // 0.42 is the source texture's own mean luminance in sRGB.
        diffuseColor.rgb *= clamp( mix( 1.0, plasterLum / 0.42, 0.7 ), 0.58, 1.3 );
        {
          vec2 win = windowMask( vWallUv );
          // Glass at 08:00 with the sun low and east: the east faces catch a
          // hard reflection of the sky, the west faces are near-black holes.
          // A flat dark rectangle reads as a painted-on window, which is worse
          // than none; the vertical gradient is what sells it.
          vec3 glass = mix( vec3( 0.075, 0.085, 0.10 ), vec3( 0.22, 0.26, 0.31 ),
                            fract( ( vWallUv.y - SILL ) / STOREY ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, glass, win.x );
          // A painted reveal round the opening. Krumlov's façades almost all
          // have a white or ochre architrave, and it is what stops the window
          // reading as a hole punched in a wall.
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.05, win.y * 0.8 );

          // Plinth and cornice. Two horizontal bands, and between them they do
          // most of the work of making a prism read as a building: the plinth
          // grounds it, the cornice gives the eave a line to stop against.
          float plinth = 1.0 - smoothstep( 0.9, 1.35, vWallUv.y );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.72, plinth * 0.85 );
        }
        `,
      );
  };

  mat.customProgramCacheKey = () => `town-wall-${tier}`;
  return mat;
}

function makeRoofMaterial(tex: SurfaceTextures, tier: QualityTier): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex.albedo,
    normalMap: tier === 'low' ? null : tex.normal,
    roughnessMap: tex.roughness,
    aoMap: tex.ao,
    roughness: 0.86,
    metalness: 0,
    vertexColors: true,
    dithering: true,
    // The tile AO map is authored for a close-up. Multiplied at full strength
    // over a whole roof plane already in shade it takes the north slopes to
    // black, and a Krumlov roofscape with black north slopes is a roofscape
    // with holes in it.
    aoMapIntensity: 0.55,
  });
}

// ---------------------------------------------------------------------------
// Geometry building
// ---------------------------------------------------------------------------

interface Mesh {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  wall: number[];
  idx: number[];
}

function emptyMesh(): Mesh {
  return { pos: [], nrm: [], uv: [], col: [], wall: [], idx: [] };
}

function pushTri(
  m: Mesh,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  uva: THREE.Vector2,
  uvb: THREE.Vector2,
  uvc: THREE.Vector2,
  colour: THREE.Color,
  wallUv?: [THREE.Vector2, THREE.Vector2, THREE.Vector2],
): void {
  const n = triNormal(a, b, c);
  const base = m.pos.length / 3;
  const verts = [a, b, c];
  const uvs = [uva, uvb, uvc];
  for (let i = 0; i < 3; i++) {
    const v = verts[i] as THREE.Vector3;
    const u = uvs[i] as THREE.Vector2;
    m.pos.push(v.x, v.y, v.z);
    m.nrm.push(n.x, n.y, n.z);
    m.uv.push(u.x, u.y);
    m.col.push(colour.r, colour.g, colour.b);
    if (wallUv) {
      const w = wallUv[i] as THREE.Vector2;
      m.wall.push(w.x, w.y);
    } else {
      m.wall.push(0, -1);
    }
  }
  m.idx.push(base, base + 1, base + 2);
}

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
function triNormal(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 {
  _e1.subVectors(b, a);
  _e2.subVectors(c, a);
  return _e1.cross(_e2).normalize();
}

/** Sutherland–Hodgman clip of a ring against the half-plane `v ≤ limit`. */
function clipHalf(
  ring: THREE.Vector2[],
  vOf: (p: THREE.Vector2) => number,
  limit: number,
  keepBelow: boolean,
): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const inside = (p: THREE.Vector2) => (keepBelow ? vOf(p) <= limit : vOf(p) >= limit);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cur = ring[i] as THREE.Vector2;
    const prev = ring[j] as THREE.Vector2;
    const inCur = inside(cur);
    const inPrev = inside(prev);
    if (inCur !== inPrev) {
      const vp = vOf(prev);
      const vc = vOf(cur);
      const t = (limit - vp) / (vc - vp);
      out.push(new THREE.Vector2(prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t));
    }
    if (inCur) out.push(cur);
  }
  return out;
}

/** Push a ring, lifted by `heightAt`, as a triangulated surface. */
function pushSurface(
  m: Mesh,
  ring: THREE.Vector2[],
  heightAt: (p: THREE.Vector2) => number,
  uvAt: (p: THREE.Vector2) => THREE.Vector2,
  colour: THREE.Color,
): number {
  if (ring.length < 3) return 0;
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(ring, []);
  } catch {
    return 0;
  }
  let emitted = 0;
  for (const f of faces) {
    const p0 = ring[f[0] as number] as THREE.Vector2;
    const p1 = ring[f[1] as number] as THREE.Vector2;
    const p2 = ring[f[2] as number] as THREE.Vector2;
    if (!p0 || !p1 || !p2) continue;
    const a = new THREE.Vector3(p0.x, heightAt(p0), p0.y);
    const b = new THREE.Vector3(p1.x, heightAt(p1), p1.y);
    const c = new THREE.Vector3(p2.x, heightAt(p2), p2.y);
    // `triangulateShape` returns clockwise faces for a counter-clockwise
    // contour in its own (x, y) convention, which is (x, z) here — so the
    // winding has to be flipped for the normal to point up.
    pushTri(m, a, c, b, uvAt(p0), uvAt(p2), uvAt(p1), colour);
    emitted++;
  }
  return emitted;
}

const OVERHANG_M = 0.35;

/**
 * Offset a ring outward about its centroid.
 *
 * A true polygon offset (mitred, with self-intersection handling) is a large
 * piece of code for a 35 cm eave overhang. Scaling about the centroid is wrong
 * in the same way a perspective correction is wrong — proportionally, and
 * invisibly at this magnitude — and it cannot produce the self-intersections
 * that make a real offset hard.
 */
function expandRing(ring: THREE.Vector2[], by: number): THREE.Vector2[] {
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  cx /= ring.length;
  cy /= ring.length;
  let mean = 0;
  for (const p of ring) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= ring.length;
  const k = mean > 0.5 ? 1 + by / mean : 1;
  return ring.map((p) => new THREE.Vector2(cx + (p.x - cx) * k, cy + (p.y - cy) * k));
}

interface RoofPlan {
  /** Height of the roof surface directly above a plan point. */
  heightAt(p: THREE.Vector2): number;
  /** Where the *wall* stops. Gables run up to the roof; hips stop at the eave. */
  wallTopAt(p: THREE.Vector2): number;
}

function buildRoof(
  m: Mesh,
  b: BuildingRecord,
  ring: THREE.Vector2[],
  colour: THREE.Color,
): RoofPlan {
  const eave = b.e;
  const ridge = b.r;
  const az = (b.a * Math.PI) / 180;
  // Ridge direction in world axes. Azimuth 0 = north = −z.
  let dx = Math.sin(az);
  let dz = -Math.cos(az);

  const uOf = (p: THREE.Vector2) => p.x * dx + p.y * dz;
  const vOf = (p: THREE.Vector2) => -p.x * dz + p.y * dx;

  let uMin = 0;
  let uMax = 0;
  let vMin = 0;
  let vMax = 0;
  const extents = (): void => {
    uMin = Infinity;
    uMax = -Infinity;
    vMin = Infinity;
    vMax = -Infinity;
    for (const p of ring) {
      const u = uOf(p);
      const v = vOf(p);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  };
  extents();

  // Sanity guard: the ridge must run along the *longer* axis of the footprint,
  // or the front wall stands at the ridge line and builds itself up to full
  // ridge height over its whole length — a flat-topped slab with its own roof
  // hidden behind it. That is what stood on the north side of Náměstí
  // Svornosti, and it looked exactly like a missing roof rather than like a
  // wrong one, which is why it survived three rounds of screenshots.
  //
  // Rotating the ridge by 90° keeps the frame a proper rotation, so the winding
  // the hip builder relies on is unaffected.
  if (vMax - vMin > uMax - uMin) {
    const t = dx;
    dx = -dz;
    dz = t;
    extents();
  }

  const vMid = (vMin + vMax) * 0.5;
  const half = Math.max(0.6, (vMax - vMin) * 0.5);
  const slope = (ridge - eave) / half;

  const outer = expandRing(ring, OVERHANG_M);

  const tileUv = (p: THREE.Vector2, h: number): THREE.Vector2 => {
    // Courses run horizontally along the ridge; the second axis is measured up
    // the slope, not in plan, so the tile pitch does not stretch on a steep
    // roof.
    const u = uOf(p);
    const rise = ridge - h;
    const run = Math.abs(vOf(p) - vMid);
    return new THREE.Vector2(u, Math.hypot(rise, run));
  };

  let shape = b.s;
  if (shape === RoofShape.Mansard) shape = RoofShape.Hipped;
  if (shape === RoofShape.Domed) shape = RoofShape.Pyramidal;

  if (shape === RoofShape.Flat) {
    const flat = () => ridge;
    pushSurface(m, outer, flat, (p) => new THREE.Vector2(p.x, p.y), colour);
    return { heightAt: flat, wallTopAt: () => ridge };
  }

  if (shape === RoofShape.Skillion) {
    const span = Math.max(1, vMax - vMin);
    const h = (p: THREE.Vector2) => eave + ((vOf(p) - vMin) / span) * (ridge - eave);
    pushSurface(m, outer, h, (p) => tileUv(p, h(p)), colour);
    return { heightAt: h, wallTopAt: h };
  }

  if (shape === RoofShape.Hipped || shape === RoofShape.Pyramidal || shape === RoofShape.HalfHipped) {
    // Hips are built on the minimum-area rectangle, not on the footprint. The
    // straight skeleton of an arbitrary concave polygon is a genuinely hard
    // piece of geometry and this is not where that budget belongs; the caller
    // only routes rectangular-enough footprints here (see `rectangularity`).
    hipMesh(m, outer, uOf, vOf, dx, dz, {
      uMin,
      uMax,
      vMin,
      vMax,
      eave,
      ridge,
      inset: shape === RoofShape.Pyramidal ? 1 : shape === RoofShape.HalfHipped ? 0.34 : 1,
      colour,
    });
    const h = (p: THREE.Vector2) => {
      const v = Math.abs(vOf(p) - vMid);
      return Math.max(eave, ridge - v * slope);
    };
    return { heightAt: h, wallTopAt: () => eave };
  }

  // Gabled. Clip the footprint at the ridge line and lift each half; the gable
  // ends then fall out of the wall builder for free, because the wall top
  // follows the same function all the way round.
  const h = (p: THREE.Vector2) => ridge - Math.abs(vOf(p) - vMid) * slope;
  const lower = clipHalf(outer, vOf, vMid, true);
  const upper = clipHalf(outer, vOf, vMid, false);
  const before = m.idx.length;
  const nLower = pushSurface(m, lower, h, (p) => tileUv(p, h(p)), colour);
  const nUpper = pushSurface(m, upper, h, (p) => tileUv(p, h(p)), colour);

  if (nLower > 0 && nUpper > 0) return { heightAt: h, wallTopAt: h };

  // Earcut refused one of the halves.
  //
  // This is not hypothetical and it was not visible from the air: clipping a
  // nineteen-vertex concave RUIAN footprint against its own ridge line with
  // Sutherland–Hodgman produces a ring with zero-area spurs joining the
  // disconnected parts, and `triangulateShape` returns nothing for it. The
  // failure was silent — a swallowed exception and an empty face list — so the
  // town looked right from above, where the roofs that *did* build cover the
  // view, and had flat-topped slabs standing on the main square at eye level.
  //
  // Falling back to the rectangular hip is not a compromise. It is built on the
  // minimum-area rectangle and cannot fail for any input, and a hip over an
  // irregular plan is a far better wrong answer than no roof at all.
  m.idx.length = before;
  m.pos.length = (before / 3) * 3 * 3;
  m.nrm.length = m.pos.length;
  m.uv.length = (before / 3) * 3 * 2;
  m.col.length = m.pos.length;
  m.wall.length = m.uv.length;
  hipMesh(m, outer, uOf, vOf, dx, dz, {
    uMin,
    uMax,
    vMin,
    vMax,
    eave,
    ridge,
    inset: 0.45,
    colour,
  });
  return { heightAt: h, wallTopAt: () => eave };
}

function hipMesh(
  m: Mesh,
  outer: THREE.Vector2[],
  uOf: (p: THREE.Vector2) => number,
  vOf: (p: THREE.Vector2) => number,
  dx: number,
  dz: number,
  o: {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
    eave: number;
    ridge: number;
    inset: number;
    colour: THREE.Color;
  },
): void {
  // Rebuild the rectangle in world space from the expanded ring's extent, so
  // the roof still overhangs.
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of outer) {
    const u = uOf(p);
    const v = vOf(p);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  const toWorld = (u: number, v: number, y: number): THREE.Vector3 =>
    new THREE.Vector3(u * dx - v * dz, y, u * dz + v * dx);

  const halfV = (vMax - vMin) * 0.5;
  const vMid = (vMin + vMax) * 0.5;
  const cut = Math.min(halfV * o.inset, (uMax - uMin) * 0.5 - 0.15);
  const ru0 = uMin + Math.max(0, cut);
  const ru1 = uMax - Math.max(0, cut);
  const slopeLen = Math.hypot(o.ridge - o.eave, halfV);

  const c00 = toWorld(uMin, vMin, o.eave);
  const c10 = toWorld(uMax, vMin, o.eave);
  const c11 = toWorld(uMax, vMax, o.eave);
  const c01 = toWorld(uMin, vMax, o.eave);
  const r0 = toWorld(ru0, vMid, o.ridge);
  const r1 = toWorld(ru1, vMid, o.ridge);

  const uv = (u: number, s: number) => new THREE.Vector2(u, s);

  // Two long slopes.
  pushTri(m, c00, r0, c10, uv(uMin, 0), uv(ru0, slopeLen), uv(uMax, 0), o.colour);
  pushTri(m, c10, r0, r1, uv(uMax, 0), uv(ru0, slopeLen), uv(ru1, slopeLen), o.colour);
  pushTri(m, c11, r1, c01, uv(uMax, 0), uv(ru1, slopeLen), uv(uMin, 0), o.colour);
  pushTri(m, c01, r1, r0, uv(uMin, 0), uv(ru1, slopeLen), uv(ru0, slopeLen), o.colour);

  // Two hip ends. Degenerate to nothing when the ridge reaches the gable, which
  // is what a half-hip with `inset` 0 would be.
  if (ru0 > uMin + 0.05) {
    pushTri(m, c01, r0, c00, uv(vMin, 0), uv(vMid, slopeLen), uv(vMax, 0), o.colour);
  }
  if (ru1 < uMax - 0.05) {
    pushTri(m, c10, r1, c11, uv(vMin, 0), uv(vMid, slopeLen), uv(vMax, 0), o.colour);
  }
}

/** Footprint area as a fraction of its minimum-area rectangle. */
function rectangularity(ring: THREE.Vector2[], az: number): number {
  const dx = Math.sin(az);
  const dz = -Math.cos(az);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of ring) {
    const u = p.x * dx + p.y * dz;
    const v = -p.x * dz + p.y * dx;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const rect = (uMax - uMin) * (vMax - vMin);
  if (rect < 1e-3) return 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i] as THREE.Vector2;
    const pj = ring[j] as THREE.Vector2;
    a += pj.x * pi.y - pi.x * pj.y;
  }
  return Math.abs(a / 2) / rect;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

const CELL_M = 12;

/**
 * Point-in-building test over a uniform grid.
 *
 * ISSprOM 521 plus Rule 17.2 make this a legal boundary, not a physical one:
 * every building in a sprint is out of bounds whether or not there is a door.
 * The grid is uniform rather than a quadtree because the town is uniformly
 * dense — a quadtree over Krumlov's old town would be a full tree.
 */
export class BlockIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly rings: Float32Array[] = [];
  private readonly bounds: Float32Array[] = [];

  add(ring: number[]): void {
    const idx = this.rings.length;
    const r = new Float32Array(ring);
    this.rings.push(r);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      const x = r[i] as number;
      const z = r[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    this.bounds.push(new Float32Array([minX, minZ, maxX, maxZ]));
    for (let cz = Math.floor(minZ / CELL_M); cz <= Math.floor(maxZ / CELL_M); cz++) {
      for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(idx);
      }
    }
  }

  test(x: number, z: number): boolean {
    const key = Math.floor(x / CELL_M) * 100003 + Math.floor(z / CELL_M);
    const list = this.cells.get(key);
    if (!list) return false;
    for (const i of list) {
      const bb = this.bounds[i] as Float32Array;
      if (x < (bb[0] as number) || x > (bb[2] as number)) continue;
      if (z < (bb[1] as number) || z > (bb[3] as number)) continue;
      if (inRing(this.rings[i] as Float32Array, x, z)) return true;
    }
    return false;
  }

  get size(): number {
    return this.rings.length;
  }
}

function inRing(r: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2] as number;
    const zi = r[i * 2 + 1] as number;
    const xj = r[j * 2] as number;
    const zj = r[j * 2 + 1] as number;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface BuildingsOptions {
  tier: QualityTier;
  /** OSM ids to leave out — the landmarks build their own geometry. */
  skip?: ReadonlySet<number>;
  viewRadius?: number;
}

interface Tile {
  key: number;
  meshes: THREE.Mesh[];
  centre: THREE.Vector3;
  radius: number;
}

const TILE_M = 150;

export class Buildings {
  readonly group = new THREE.Group();
  readonly blocks = new BlockIndex();

  readonly stats = { buildings: 0, triangles: 0, tiles: 0, visible: 0 };

  private readonly tiles: Tile[] = [];
  private readonly wallMat: THREE.MeshStandardMaterial;
  private readonly roofMat: THREE.MeshStandardMaterial;
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly viewRadius: number;

  constructor(
    data: TownscapeData,
    field: TerrainField,
    plaster: SurfaceTextures,
    tile: SurfaceTextures,
    opts: BuildingsOptions,
  ) {
    this.group.name = 'buildings';
    this.viewRadius = opts.viewRadius ?? 720;
    this.wallMat = makeWallMaterial(plaster, opts.tier);
    this.roofMat = makeRoofMaterial(tile, opts.tier);

    const walls = new Map<number, Mesh>();
    const roofs = new Map<number, Mesh>();
    const colour = new THREE.Color();

    for (const b of data.buildings) {
      if (b.id !== undefined && opts.skip?.has(b.id)) continue;
      const ring: THREE.Vector2[] = [];
      for (let i = 0; i < b.p.length; i += 2) {
        ring.push(new THREE.Vector2(b.p[i] as number, b.p[i + 1] as number));
      }
      if (ring.length < 3) continue;

      this.blocks.add(b.p);
      this.stats.buildings++;

      let cx = 0;
      let cz = 0;
      for (const p of ring) {
        cx += p.x;
        cz += p.y;
      }
      cx /= ring.length;
      cz /= ring.length;
      const key = tileKey(cx, cz);

      let roofMesh = roofs.get(key);
      if (!roofMesh) {
        roofMesh = emptyMesh();
        roofs.set(key, roofMesh);
      }
      let wallMesh = walls.get(key);
      if (!wallMesh) {
        wallMesh = emptyMesh();
        walls.set(key, wallMesh);
      }

      // A hip over an L-shaped plan is built on the bounding rectangle and
      // would hang over the courtyard. Demote those to a gable, which is built
      // on the footprint itself and cannot.
      const rec = { ...b };
      if (
        (rec.s === RoofShape.Hipped ||
          rec.s === RoofShape.HalfHipped ||
          rec.s === RoofShape.Pyramidal ||
          rec.s === RoofShape.Mansard) &&
        rectangularity(ring, (rec.a * Math.PI) / 180) < 0.8
      ) {
        rec.s = RoofShape.Gabled;
      }

      colour.setHex(rec.c).convertSRGBToLinear();
      const plan = buildRoof(roofMesh, rec, ring, colour);

      colour.setHex(rec.w).convertSRGBToLinear();
      this.buildWalls(wallMesh, ring, plan, field, colour);
    }

    for (const [key, mesh] of walls) {
      const roof = roofs.get(key);
      const meshes: THREE.Mesh[] = [];
      const wm = this.finish(mesh, this.wallMat, true);
      if (wm) meshes.push(wm);
      if (roof) {
        const rm = this.finish(roof, this.roofMat, false);
        if (rm) meshes.push(rm);
      }
      if (!meshes.length) continue;

      const box = new THREE.Box3();
      for (const mm of meshes) {
        mm.geometry.computeBoundingBox();
        if (mm.geometry.boundingBox) box.union(mm.geometry.boundingBox);
        this.group.add(mm);
      }
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
      this.tiles.push({ key, meshes, centre, radius });
    }
    this.stats.tiles = this.tiles.length;
  }

  private buildWalls(
    m: Mesh,
    ring: THREE.Vector2[],
    plan: RoofPlan,
    field: TerrainField,
    colour: THREE.Color,
  ): void {
    const n = ring.length;
    // The base follows the drawn terrain, dropped 0.5 m so nothing floats over
    // a slope and nothing shows a seam where the LOD changes under it.
    const baseY: number[] = [];
    for (const p of ring) baseY.push(field.heightAt(p.x, p.y) - 0.5);

    // Per-building phase for the window grid, derived from the footprint so it
    // is stable across reloads.
    let along = ((ring[0] as THREE.Vector2).x * 7.31 + (ring[0] as THREE.Vector2).y * 3.17) % 3.4;
    for (let i = 0; i < n; i++) {
      const a = ring[i] as THREE.Vector2;
      const b = ring[(i + 1) % n] as THREE.Vector2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;

      const ay = baseY[i] as number;
      const by = baseY[(i + 1) % n] as number;
      const at = plan.wallTopAt(a);
      const bt = plan.wallTopAt(b);

      const p00 = new THREE.Vector3(a.x, ay, a.y);
      const p10 = new THREE.Vector3(b.x, by, b.y);
      const p11 = new THREE.Vector3(b.x, bt, b.y);
      const p01 = new THREE.Vector3(a.x, at, a.y);

      // uv is the plaster tiling; wallUv is metres along/up, for the windows.
      const u0 = along;
      const u1 = along + len;
      const uv00 = new THREE.Vector2(u0, ay);
      const uv10 = new THREE.Vector2(u1, by);
      const uv11 = new THREE.Vector2(u1, bt);
      const uv01 = new THREE.Vector2(u0, at);
      const w00 = new THREE.Vector2(u0, 0);
      const w10 = new THREE.Vector2(u1, 0);
      const w11 = new THREE.Vector2(u1, bt - by);
      const w01 = new THREE.Vector2(u0, at - ay);

      pushTri(m, p00, p01, p11, uv00, uv01, uv11, colour, [w00, w01, w11]);
      pushTri(m, p00, p11, p10, uv00, uv11, uv10, colour, [w00, w11, w10]);
      along = u1;
    }
  }

  private finish(
    m: Mesh,
    material: THREE.Material,
    withWallUv: boolean,
  ): THREE.Mesh | null {
    if (!m.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
    // aoMap needs a second UV channel; the same world-metre UVs serve.
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(m.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
    if (withWallUv) {
      g.setAttribute('wallUv', new THREE.Float32BufferAttribute(m.wall, 2));
    }
    g.setIndex(m.idx);
    g.computeBoundingSphere();
    this.stats.triangles += m.idx.length / 3;

    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  update(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj);
    this.stats.visible = 0;
    const cam = camera.position;
    for (const t of this.tiles) {
      const d = Math.hypot(t.centre.x - cam.x, t.centre.z - cam.z) - t.radius;
      let vis = d < this.viewRadius;
      if (vis) {
        _sphere.center.copy(t.centre);
        _sphere.radius = t.radius;
        vis = this.frustum.intersectsSphere(_sphere);
      }
      for (const m of t.meshes) m.visible = vis;
      if (vis) this.stats.visible++;
    }
  }

  dispose(): void {
    for (const t of this.tiles) {
      for (const m of t.meshes) {
        m.geometry.dispose();
        this.group.remove(m);
      }
    }
    this.tiles.length = 0;
    this.wallMat.dispose();
    this.roofMat.dispose();
  }
}

const _sphere = new THREE.Sphere();

function tileKey(x: number, z: number): number {
  return Math.floor(x / TILE_M) * 100003 + Math.floor(z / TILE_M);
}
