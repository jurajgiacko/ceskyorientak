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
  /**
   * Gable bays across the roof, when the extractor has decided this footprint
   * presents its gables to the street.
   *
   * Present means `a` is authoritative — it was derived from the street the
   * building fronts onto, not from the minimum-area rectangle — so the
   * renderer's long-axis guard must not override it. `n` > 1 asks for a comb:
   * that many parallel ridges running back from the frontage, which is what a
   * wide footprint on Náměstí Svornosti actually is (several medieval plots
   * mapped as one polygon).
   */
  n?: number;
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
  /**
   * True when `runnability.bin` in this directory already carries the OSM
   * network, the bridge decks, the footprints and the uncrossable barriers.
   * See `SprintScene.stampPaved` and D-024.
   */
  rasterStamped?: boolean;
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
 * Plaster, with a whole façade drawn into it.
 *
 * The openings are procedural rather than modelled, and they are not
 * decoration: a town of untextured plaster prisms reads as a massing study, and
 * the cheapest thing that turns it back into architecture is a storey grid of
 * dark openings. They are keyed off the wall's own UV — `u` is metres along the
 * wall, `v` is metres above the ground at that point — so the courses line up
 * across a whole terrace without any per-building work, and a 40 m castle wing
 * gets thirteen floors of them for free.
 *
 * `wallEave` carries the building's own eave height above its base, which is
 * what lets one shader draw a *façade* rather than a wallpaper of windows:
 *
 *   - a **ground-floor register** — an arched shopfront or a door in every bay.
 *     This is the single biggest eye-level omission the first build had. A
 *     façade whose bottom three metres are blank plaster reads as a boundary
 *     wall, and in a sprint the bottom three metres are the whole frame.
 *   - **storey windows** between the ground floor and the eave, so a 7 m
 *     burgher house gets one upper floor and a 14 m one gets three, instead of
 *     both getting the same infinite grid.
 *   - a **cornice** at the eave and a **gable field** above it, carrying one
 *     small attic opening rather than more of the grid. Krumlov's gables are
 *     mostly blind, and a gable peppered with full windows is the giveaway
 *     that a façade was generated rather than designed.
 *
 * A negative `wallEave` marks trim geometry — dormer cheeks, window reveals —
 * which takes the plaster and none of the drawing.
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
        attribute float wallEave;
        varying vec2 vWallUv;
        varying float vEave;
        `,
      )
      .replace(
        '#include <uv_vertex>',
        /* glsl */ `
        #include <uv_vertex>
        vWallUv = wallUv;
        vEave = wallEave;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec2 vWallUv;
        varying float vEave;

        // Storey pitch, bay pitch, opening size. Metres, and measured off the
        // ČÚZK 12.5 cm orthophoto rather than invented: Krumlov's burgher
        // houses run about 3.3 m floor to floor with roughly 1.1 m of window
        // every 3.4 m along the façade, over a ground floor about 3 m high.
        const float STOREY  = 3.3;
        const float BAY     = 3.4;
        const float WIN_W   = 1.15;
        const float WIN_H   = 1.62;
        // The building base is set 0.5 m below the drawn terrain so nothing
        // floats on a slope, so the pavement is at v = 0.5, not v = 0.
        const float GROUND  = 0.5;
        // Top of the ground-floor register, and the sill of the first floor
        // above it.
        const float SHOP_H  = 3.15;
        const float FIRST   = GROUND + 3.65;

        // A box in the façade plane, signed, negative inside. The parameter is
        // halfSize and not "half" because GLSL ES reserves that word: naming it
        // half fails the fragment compile, and a failed fragment compile shows
        // up as a town with no walls rather than as an error on the screen.
        // See D-019.
        float boxSdf( vec2 p, vec2 halfSize ) {
          vec2 d = abs( p ) - halfSize;
          return min( max( d.x, d.y ), 0.0 ) + length( max( d, 0.0 ) );
        }

        // Storey windows. x = glass, y = architrave, z = sill.
        //
        // The architrave is not trim on the trim: a Krumlov window is a dark
        // hole inside a painted white surround, and without the surround the
        // opening reads as a smudge on the plaster at any distance over about
        // ten metres. The sill is the same argument one storey down — it is the
        // only horizontal in the façade between the plinth and the cornice.
        vec3 windowMask( vec2 p, float eave ) {
          // Nothing in the ground-floor register (that has its own openings),
          // nothing within 0.55 m of the eave where the cornice runs, and
          // nothing at all in the gable field — see gableMask.
          if ( p.y < FIRST - 0.6 || p.y > eave - 0.5 ) return vec3( 0.0 );
          // p.x already carries a per-building phase offset (see buildWalls),
          // so neighbouring houses do not share a bay grid. Without it a
          // hundred-metre terrace reads as one building with a lot of windows.
          float bay = mod( p.x + BAY * 0.5, BAY ) - BAY * 0.5;
          float storey = mod( p.y - FIRST, STOREY );
          vec2 q = vec2( bay, storey - WIN_H * 0.5 );
          float d = boxSdf( q, vec2( WIN_W * 0.5, WIN_H * 0.5 ) );
          float glass = 1.0 - smoothstep( -0.05, 0.015, d );
          float frame = ( 1.0 - smoothstep( 0.14, 0.20, d ) ) - glass;
          float sill = ( 1.0 - smoothstep( 0.10, 0.15,
                          boxSdf( vec2( bay, storey + 0.16 ),
                                  vec2( WIN_W * 0.5 + 0.16, 0.07 ) ) ) );
          return vec3( glass, max( 0.0, frame ), sill );
        }

        // The ground floor. x = opening, y = surround, z = 1 for a door.
        //
        // Krumlov's street level is arcades, segmental-arched shop openings and
        // deep timber doorways — almost never a plain wall. One opening per
        // bay, roughly one bay in three a narrower door, and the head arched
        // because a square-headed hole reads as a garage.
        vec3 groundMask( vec2 p, float eave ) {
          if ( eave < 4.2 || p.y > SHOP_H + 0.6 || p.y < GROUND - 0.4 ) return vec3( 0.0 );
          float bayIdx = floor( ( p.x + BAY * 0.5 ) / BAY );
          float rnd = fract( sin( bayIdx * 12.9898 ) * 43758.5453 );
          float isDoor = step( rnd, 0.34 );
          float halfW = mix( 0.92, 0.52, isDoor );
          float top   = mix( SHOP_H, SHOP_H - 0.45, isDoor );
          float bx = mod( p.x + BAY * 0.5, BAY ) - BAY * 0.5;
          float spring = top - halfW;
          // Square-headed shaft up to the springing, then a semicircular head.
          float dShaft = max( abs( bx ) - halfW,
                              max( ( GROUND + 0.06 ) - p.y, p.y - spring ) );
          float dHead  = max( length( vec2( bx, p.y - spring ) ) - halfW, spring - p.y );
          float d = min( dShaft, dHead );
          float open = 1.0 - smoothstep( -0.05, 0.02, d );
          float sur  = ( 1.0 - smoothstep( 0.02, 0.22, d ) ) - open;
          return vec3( open, max( 0.0, sur ), isDoor );
        }

        // One small attic opening in the gable field, on the centre bay only.
        float gableMask( vec2 p, float eave ) {
          if ( p.y < eave + 0.5 ) return 0.0;
          float bay = mod( p.x + BAY * 0.5, BAY ) - BAY * 0.5;
          float d = boxSdf( vec2( bay, p.y - ( eave + 1.35 ) ), vec2( 0.34, 0.42 ) );
          return 1.0 - smoothstep( -0.04, 0.03, d );
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
        // 0.617 is this texture's own mean *linear* luminance, measured over
        // albedo@512. The first build divided by 0.42 — an sRGB-ish guess — so
        // the average texel came out at 1.47 and clamped to the 1.3 ceiling:
        // every façade in the town was pinned at its brightest, and the only
        // thing the map could still do was punch dark holes. That is why the
        // plaster read as grey damp on concrete rather than as lime wash. The
        // weight is down from 0.7 to 0.45 for the same reason: this is a
        // weathering map, and at 0.7 the weathering was the building.
        // The weight is 0.32, not the 0.7 the first build used, for the same
        // reason the divisor changed: this is a weathering map with damp
        // patches metres across, and at 0.7 those patches were the building.
        diffuseColor.rgb *= clamp( mix( 1.0, plasterLum / 0.617, 0.32 ), 0.80, 1.12 );

        // vEave < 0 marks trim — dormer cheeks and reveals — which wants the
        // plaster and none of the façade drawn on it.
        if ( vEave > 0.0 ) {
          vec3 win = windowMask( vWallUv, vEave );
          vec3 gnd = groundMask( vWallUv, vEave );
          float attic = gableMask( vWallUv, vEave );
          // Lime white, the colour every architrave, sill and arch surround in
          // this town is painted.
          vec3 trim = vec3( 0.86, 0.84, 0.79 );

          // Glass at 08:00 with the sun low and east: the east faces catch a
          // hard reflection of the sky, the west faces are near-black holes.
          // A flat dark rectangle reads as a painted-on window, which is worse
          // than none; the vertical gradient is what sells it.
          vec3 glass = mix( vec3( 0.055, 0.065, 0.082 ), vec3( 0.20, 0.24, 0.30 ),
                            fract( ( vWallUv.y - FIRST ) / STOREY ) );
          // Sill and architrave go down first so the glass cuts back into them.
          diffuseColor.rgb = mix( diffuseColor.rgb, trim, max( win.y, win.z ) * 0.9 );
          diffuseColor.rgb = mix( diffuseColor.rgb, glass, max( win.x, attic ) );

          // Ground floor. A shop opening is dark glass with the light of the
          // interior at the back of it; a door is dark oiled timber. Both sit
          // in a pale stone surround, which is what actually draws the arch.
          vec3 shopGlass = mix( vec3( 0.055, 0.060, 0.072 ), vec3( 0.16, 0.13, 0.09 ),
                                clamp( 1.0 - ( vWallUv.y - GROUND ) / 2.4, 0.0, 1.0 ) );
          vec3 timber = vec3( 0.055, 0.038, 0.026 );
          diffuseColor.rgb = mix( diffuseColor.rgb, trim, gnd.y * 0.9 );
          diffuseColor.rgb = mix( diffuseColor.rgb, mix( shopGlass, timber, gnd.z ), gnd.x );

          // Plinth and cornice. Two horizontal bands, and between them they do
          // most of the work of making a prism read as a building: the plinth
          // grounds it, the cornice gives the eave a line to stop against.
          float plinth = 1.0 - smoothstep( GROUND + 0.35, GROUND + 0.75, vWallUv.y );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.70, plinth * 0.85 );
          // The cornice is a *light* band at the eave, because that is where the
          // sun catches the moulding, with a shadow line under it. On a gabled
          // building it also draws the line where the wall becomes the gable,
          // which is the horizontal a blank triangle badly needs.
          float cornice = 1.0 - smoothstep( 0.16, 0.24, abs( vWallUv.y - ( vEave - 0.18 ) ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, trim, cornice * 0.75 );
          float shade = 1.0 - smoothstep( 0.09, 0.17, abs( vWallUv.y - ( vEave - 0.48 ) ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.72, shade * 0.8 );
        }
        `,
      );
  };

  mat.customProgramCacheKey = () => `town-wall-${tier}`;
  return mat;
}

/**
 * Bohemian tile.
 *
 * The colour handling is the same argument as the plaster's, and it had gone
 * unmade here: the tile albedo is itself a saturated terracotta whose mean
 * linear luminance is **0.146**, and it was being multiplied by a per-building
 * terracotta vertex colour of roughly the same darkness. The product is an
 * albedo near 0.02 — about the reflectance of asphalt — so a roof slope that
 * the 08:00 sun does not reach rendered as black. Half of Krumlov's roofscape
 * faces away from an eastern sun, and from the square that half was a row of
 * black holes with a red roof behind it.
 *
 * So the map modulates luminance and the vertex colour says what colour the
 * tile is, exactly as on the walls. Double-sided, because the eave overhang is
 * a single surface and the one place a roof is seen from below is standing in
 * the street under it — which is where this venue is played.
 */
function makeRoofMaterial(tex: SurfaceTextures, tier: QualityTier): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.albedo,
    normalMap: tier === 'low' ? null : tex.normal,
    roughnessMap: tex.roughness,
    aoMap: tex.ao,
    roughness: 0.86,
    metalness: 0,
    vertexColors: true,
    dithering: true,
    side: THREE.DoubleSide,
    // The tile AO map is authored for a close-up. Multiplied at full strength
    // over a whole roof plane already in shade it takes the north slopes to
    // black, and a Krumlov roofscape with black north slopes is a roofscape
    // with holes in it. At 0.55 it was still darkening the only light those
    // slopes get, which is the hemisphere.
    aoMapIntensity: 0.32,
  });

  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      vec4 tileTexel = texture2D( map, vMapUv );
      float tileLum = dot( tileTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      // 0.146 is this texture's own mean linear luminance, measured over
      // albedo@512. The floor is 0.82 rather than 0.62 because the map's dark
      // half is mortar joint, and a joint that swallows four fifths of the
      // light turns a slope the sun does not reach into a hole.
      diffuseColor.rgb *= clamp( mix( 1.0, tileLum / 0.146, 0.55 ), 0.82, 1.45 );
      // Fired clay reflects about a quarter of the light that falls on it. The
      // palette measured off the orthophoto is a *sunlit* terracotta, which as
      // an albedo is roughly half that — fine while the sun is on it and much
      // too dark on the slopes lit only by the sky, which at 08:00 in a north-
      // south street is half the roofscape.
      diffuseColor.rgb *= 1.35;
      `,
    );
  };
  mat.customProgramCacheKey = () => `town-roof-${tier}`;
  return mat;
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
  /** Per-vertex eave height above the building base; < 0 means trim. */
  eave: number[];
  idx: number[];
}

function emptyMesh(): Mesh {
  return { pos: [], nrm: [], uv: [], col: [], wall: [], eave: [], idx: [] };
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
  eave = -1,
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
    m.eave.push(eave);
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

/**
 * Push a triangle for a roof, with the winding forced so the normal points up.
 *
 * Not defensive. `triangulateShape` returns faces in the winding of whatever
 * ring it was handed, and a Sutherland–Hodgman clip of a concave footprint can
 * hand it a reversed one — so a share of roof planes were built inside out.
 * With a front-facing material they were *culled*, which is to say a roof with
 * holes in it that looked from the ground exactly like a building with no roof;
 * with the double-sided material the eave soffit needs, they would instead be
 * lit as if facing the ground, which is a black roof. A roof faces up. Saying
 * so here costs a dot product and removes both failures at once.
 */
function pushUpTri(
  m: Mesh,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  uva: THREE.Vector2,
  uvb: THREE.Vector2,
  uvc: THREE.Vector2,
  colour: THREE.Color,
): void {
  if (triNormal(a, b, c).y < 0) pushTri(m, a, c, b, uva, uvc, uvb, colour);
  else pushTri(m, a, b, c, uva, uvb, uvc, colour);
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
    pushUpTri(m, a, c, b, uvAt(p0), uvAt(p2), uvAt(p1), colour);
    emitted++;
  }
  return emitted;
}

/**
 * Eave overhang.
 *
 * Up from 0.35 m, which is a gutter rather than an eave. A Bohemian tile roof
 * oversails its wall by half a metre to a metre and the shadow that throws
 * across the top of the plaster is most of what tells you, at eye level, that
 * there is a roof up there at all. The roof material is double-sided so the
 * soffit is drawn rather than culled.
 */
const OVERHANG_M = 0.62;

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
  /**
   * Where `wallTopAt` bends between two plan points, as parameters in (0, 1).
   *
   * This is the whole gable, and its absence was the thing that made Krumlov
   * unrecognisable from the ground. The wall builder emits one quad per
   * footprint edge, sampling `wallTopAt` at the two *corners* only — and on a
   * gabled roof the ridge crosses the gable-end edge at its **midpoint**, not
   * at a vertex. So the wall top ran flat from corner to corner at eave height
   * and the triangle under the ridge was simply never built: every gabled
   * building in the town had an open triangular hole under its roof, showing
   * the unlit underside of the far slope. From above the roofs cover it and
   * the town looks finished; from the square it reads as a flat-topped slab
   * with a black wedge on top, which is exactly what was reported.
   *
   * Returning the crossings lets the edge be split at the crease, so the gable
   * is built from the same height function that builds the roof and the two
   * cannot disagree.
   */
  creases(a: THREE.Vector2, b: THREE.Vector2, out: number[]): void;
  /** Eave elevation, for the cornice band and the dormers. */
  eave: number;
  /** Ridge elevation. */
  ridge: number;
}

/** No bends: flat, hipped and skillion wall tops are straight between corners. */
const NO_CREASE: RoofPlan['creases'] = () => {};

/**
 * Parameters in (0, 1) where the segment `va → vb` crosses each level.
 *
 * Used to split a footprint edge at every ridge and every valley the roof
 * profile puts across it.
 */
function crossings(va: number, vb: number, levels: number[], out: number[]): void {
  const span = vb - va;
  if (Math.abs(span) < 1e-6) return;
  for (const level of levels) {
    const t = (level - va) / span;
    if (t > 1e-3 && t < 1 - 1e-3) out.push(t);
  }
  out.sort((x, y) => x - y);
}

/** Clip a ring to the slab `lo ≤ v ≤ hi`. */
function clipSlab(
  ring: THREE.Vector2[],
  vOf: (p: THREE.Vector2) => number,
  lo: number,
  hi: number,
): THREE.Vector2[] {
  const upper = clipHalf(ring, vOf, hi, true);
  if (upper.length < 3) return [];
  return clipHalf(upper, vOf, lo, false);
}

/** Where the plaster half of a dormer goes, and in what colour. */
interface DormerTarget {
  mesh: Mesh;
  colour: THREE.Color;
}

function buildRoof(
  m: Mesh,
  b: BuildingRecord,
  ring: THREE.Vector2[],
  colour: THREE.Color,
  dormer?: DormerTarget,
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

  // Sanity guard: with no better information the ridge runs along the *longer*
  // axis of the footprint, because a single ridge across the short way of a
  // long plan is not a roof anyone has built.
  //
  // It is skipped when the extractor has set `n`, which means the azimuth came
  // from the street the building fronts onto rather than from the minimum-area
  // rectangle. That case is the whole point: a Krumlov plot is narrow to the
  // street and deep behind it, so the ridge runs *back* from the frontage and
  // the gable is what the street sees — and where one OSM polygon covers
  // several plots, `n` says how many of those gables to build.
  //
  // Rotating the ridge by 90° keeps the frame a proper rotation, so the winding
  // the hip builder relies on is unaffected.
  const bays = Math.max(1, Math.round(b.n ?? 0));
  const streetLed = (b.n ?? 0) >= 1;
  if (!streetLed && vMax - vMin > uMax - uMin) {
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
    return { heightAt: flat, wallTopAt: () => ridge, creases: NO_CREASE, eave: ridge, ridge };
  }

  if (shape === RoofShape.Skillion) {
    const span = Math.max(1, vMax - vMin);
    const h = (p: THREE.Vector2) => eave + ((vOf(p) - vMin) / span) * (ridge - eave);
    pushSurface(m, outer, h, (p) => tileUv(p, h(p)), colour);
    return { heightAt: h, wallTopAt: h, creases: NO_CREASE, eave, ridge };
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
    return { heightAt: h, wallTopAt: () => eave, creases: NO_CREASE, eave, ridge };
  }

  // Gabled, and possibly a comb of them.
  //
  // `bays` parallel ridges run along u, spaced evenly across v. One bay is the
  // ordinary gabled roof; more than one is the comb a wide Krumlov street
  // frontage actually carries, where several medieval plots sit behind one OSM
  // polygon. The valleys between bays come down to the eave, so the street
  // façade the wall builder raises against this profile is a row of gables
  // rather than one long parapet.
  const bayW = (vMax - vMin) / bays;
  const bayHalf = Math.max(0.6, bayW * 0.5);
  const baySlope = (ridge - eave) / bayHalf;
  const bayOf = (v: number): number =>
    Math.min(bays - 1, Math.max(0, Math.floor((v - vMin) / Math.max(1e-3, bayW))));
  const h =
    bays === 1
      ? (p: THREE.Vector2) => ridge - Math.abs(vOf(p) - vMid) * slope
      : (p: THREE.Vector2) => {
          const v = vOf(p);
          const centre = vMin + (bayOf(v) + 0.5) * bayW;
          return ridge - Math.abs(v - centre) * baySlope;
        };
  // Ridges and valleys, in v, for the wall builder to split its edges on.
  const levels: number[] = [];
  if (bays === 1) levels.push(vMid);
  else {
    for (let k = 0; k < bays; k++) {
      levels.push(vMin + (k + 0.5) * bayW);
      if (k > 0) levels.push(vMin + k * bayW);
    }
  }
  const creases: RoofPlan['creases'] = (a, b2, out) =>
    crossings(vOf(a), vOf(b2), levels, out);

  const before = m.idx.length;
  let ok = true;
  for (let k = 0; k < bays && ok; k++) {
    // The end bays swallow the overhang, so they are clipped open-ended.
    const lo = k === 0 ? -1e6 : vMin + k * bayW;
    const hi = k === bays - 1 ? 1e6 : vMin + (k + 1) * bayW;
    const centre = bays === 1 ? vMid : vMin + (k + 0.5) * bayW;
    const slab = bays === 1 ? outer : clipSlab(outer, vOf, lo, hi);
    if (slab.length < 3) {
      ok = false;
      break;
    }
    const lower = clipHalf(slab, vOf, centre, true);
    const upper = clipHalf(slab, vOf, centre, false);
    const nLower = pushSurface(m, lower, h, (p) => tileUv(p, h(p)), colour);
    const nUpper = pushSurface(m, upper, h, (p) => tileUv(p, h(p)), colour);
    if (nLower === 0 || nUpper === 0) ok = false;
  }

  if (ok) {
    if (dormer) {
      const centres: number[] = [];
      if (bays === 1) centres.push(vMid);
      else for (let k = 0; k < bays; k++) centres.push(vMin + (k + 0.5) * bayW);
      addDormers(m, dormer, ring, {
        dx,
        dz,
        uMin,
        uMax,
        centres,
        halfSpan: bays === 1 ? half : bayHalf,
        slope: bays === 1 ? slope : baySlope,
        ridge,
        colour,
      });
    }
    return { heightAt: h, wallTopAt: h, creases, eave, ridge };
  }

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
  m.eave.length = m.pos.length / 3;
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
  const hipHeight = (p: THREE.Vector2) =>
    Math.max(eave, ridge - Math.abs(vOf(p) - vMid) * slope);
  return {
    heightAt: hipHeight,
    wallTopAt: () => eave,
    creases: NO_CREASE,
    eave,
    ridge,
  };
}

/** Is this plan point inside the footprint? */
function inPlanRing(ring: THREE.Vector2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i] as THREE.Vector2;
    const pj = ring[j] as THREE.Vector2;
    if (pi.y > z !== pj.y > z && x < ((pj.x - pi.x) * (z - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Push a triangle whose normal is made to agree with `want`. */
function pushOriented(
  m: Mesh,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  want: THREE.Vector3,
  uva: THREE.Vector2,
  uvb: THREE.Vector2,
  uvc: THREE.Vector2,
  colour: THREE.Color,
  wall: boolean,
): void {
  const n = triNormal(a, b, c);
  const flip = n.dot(want) < 0;
  const zero = new THREE.Vector2(0, -1);
  const w: [THREE.Vector2, THREE.Vector2, THREE.Vector2] = [zero, zero, zero];
  if (flip) pushTri(m, a, c, b, uva, uvc, uvb, colour, wall ? w : undefined, -1);
  else pushTri(m, a, b, c, uva, uvb, uvc, colour, wall ? w : undefined, -1);
}

/**
 * Gabled dormers on the roof slopes.
 *
 * Krumlov's roofscape is not plain tile — it is tile broken every few metres by
 * a dormer, because the attics were living space and every one of them needed
 * light. From the square the dormers are what stop a roof reading as a single
 * folded plane, and from a street they are most of what is above the eave.
 *
 * Eleven triangles each plus a two-triangle window, placed off the roof's own
 * height function so a dormer cannot float or sink. They are skipped where the
 * roof is too shallow to hide the back of one, and where the dormer's plan
 * position falls outside the footprint — which is what keeps them off the
 * overhang and out of the re-entrant corners of an L.
 */
function addDormers(
  roof: Mesh,
  dormer: DormerTarget,
  ring: THREE.Vector2[],
  o: {
    dx: number;
    dz: number;
    uMin: number;
    uMax: number;
    centres: number[];
    halfSpan: number;
    slope: number;
    ridge: number;
    colour: THREE.Color;
  },
): void {
  const { dx, dz, slope, halfSpan, ridge } = o;
  if (slope < 0.55 || halfSpan < 2.2) return;
  const uLen = o.uMax - o.uMin;
  if (uLen < 5) return;

  const W = (u: number, v: number, y: number): THREE.Vector3 =>
    new THREE.Vector3(u * dx - v * dz, y, u * dz + v * dx);

  const count = Math.min(3, Math.max(1, Math.floor(uLen / 7.5)));
  const step = uLen / count;
  const hw = 0.85;
  const glass = new THREE.Color(0.012, 0.014, 0.018);

  for (const vc of o.centres) {
    for (const s of [-1, 1]) {
      const dv = halfSpan * 0.55;
      const yf = ridge - dv * slope;
      const dormerH = Math.min(2.2, dv * slope * 0.78);
      if (dormerH < 1.15) continue;
      const eaveH = dormerH * 0.62;
      const vf = vc + s * dv;
      const vb = vc + s * (dv - dormerH / slope);
      const ve = vc + s * (dv - eaveH / slope);
      // Outward, i.e. down the slope, away from the ridge.
      const want = new THREE.Vector3(-dz * s, 0, dx * s);
      const up = new THREE.Vector3(0, 1, 0);

      for (let j = 0; j < count; j++) {
        const u = o.uMin + (j + 0.5) * step;
        const wx = u * dx - vf * dz;
        const wz = u * dz + vf * dx;
        if (!inPlanRing(ring, wx, wz)) continue;
        const bx = u * dx - vb * dz;
        const bz = u * dz + vb * dx;
        if (!inPlanRing(ring, bx, bz)) continue;

        const P0 = W(u - hw, vf, yf - 0.06);
        const P1 = W(u + hw, vf, yf - 0.06);
        const P2 = W(u + hw, vf, yf + eaveH);
        const P3 = W(u - hw, vf, yf + eaveH);
        const A = W(u, vf, yf + dormerH);
        const B = W(u, vb, yf + dormerH);
        const C0 = W(u - hw, ve, yf + eaveH);
        const C1 = W(u + hw, ve, yf + eaveH);

        const uv = (a: number, b2: number) => new THREE.Vector2(a, b2);
        const wm = dormer.mesh;
        const wc = dormer.colour;

        // Front, gable and cheeks — plaster.
        pushOriented(wm, P0, P1, P2, want, uv(u - hw, yf), uv(u + hw, yf), uv(u + hw, yf + eaveH), wc, true);
        pushOriented(wm, P0, P2, P3, want, uv(u - hw, yf), uv(u + hw, yf + eaveH), uv(u - hw, yf + eaveH), wc, true);
        pushOriented(wm, P3, P2, A, want, uv(u - hw, yf + eaveH), uv(u + hw, yf + eaveH), uv(u, yf + dormerH), wc, true);
        const left = new THREE.Vector3(-dx, 0, -dz);
        const right = new THREE.Vector3(dx, 0, dz);
        pushOriented(wm, P0, P3, C0, left, uv(vf, yf), uv(vf, yf + eaveH), uv(ve, yf + eaveH), wc, true);
        pushOriented(wm, P1, P2, C1, right, uv(vf, yf), uv(vf, yf + eaveH), uv(ve, yf + eaveH), wc, true);

        // The window, set 3 cm proud so it cannot z-fight the plaster behind it.
        const off = 0.03;
        const g0 = W(u - 0.5, vf + s * off, yf + 0.3);
        const g1 = W(u + 0.5, vf + s * off, yf + 0.3);
        const g2 = W(u + 0.5, vf + s * off, yf + eaveH - 0.18);
        const g3 = W(u - 0.5, vf + s * off, yf + eaveH - 0.18);
        pushOriented(wm, g0, g1, g2, want, uv(0, 0), uv(1, 0), uv(1, 1), glass, true);
        pushOriented(wm, g0, g2, g3, want, uv(0, 0), uv(1, 1), uv(0, 1), glass, true);

        // Two little roof slopes — tile.
        const slopeLen = Math.hypot(dormerH - eaveH, hw);
        pushOriented(roof, A, P3, C0, up, uv(u, slopeLen), uv(u - hw, 0), uv(u - hw, 0.6), o.colour, false);
        pushOriented(roof, A, C0, B, up, uv(u, slopeLen), uv(u - hw, 0.6), uv(u, slopeLen), o.colour, false);
        pushOriented(roof, A, C1, P2, up, uv(u, slopeLen), uv(u + hw, 0.6), uv(u + hw, 0), o.colour, false);
        pushOriented(roof, A, B, C1, up, uv(u, slopeLen), uv(u, slopeLen), uv(u + hw, 0.6), o.colour, false);
      }
    }
  }
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

  // Two long slopes. The winding of this rectangle depends on the sign of the
  // ridge direction, so it is forced upward rather than assumed — see
  // `pushUpTri`.
  pushUpTri(m, c00, r0, c10, uv(uMin, 0), uv(ru0, slopeLen), uv(uMax, 0), o.colour);
  pushUpTri(m, c10, r0, r1, uv(uMax, 0), uv(ru0, slopeLen), uv(ru1, slopeLen), o.colour);
  pushUpTri(m, c11, r1, c01, uv(uMax, 0), uv(ru1, slopeLen), uv(uMin, 0), o.colour);
  pushUpTri(m, c01, r1, r0, uv(uMin, 0), uv(ru1, slopeLen), uv(ru0, slopeLen), o.colour);

  // Two hip ends. Degenerate to nothing when the ridge reaches the gable, which
  // is what a half-hip with `inset` 0 would be.
  if (ru0 > uMin + 0.05) {
    pushUpTri(m, c01, r0, c00, uv(vMin, 0), uv(vMid, slopeLen), uv(vMax, 0), o.colour);
  }
  if (ru1 < uMax - 0.05) {
    pushUpTri(m, c10, r1, c11, uv(vMin, 0), uv(vMid, slopeLen), uv(vMax, 0), o.colour);
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
    const dormers = opts.tier !== 'low';

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

      const wallColour = new THREE.Color(rec.w).convertSRGBToLinear();
      colour.setHex(rec.c).convertSRGBToLinear();
      // Dormers cost eleven triangles plus a window and they are the difference
      // between a folded plane and a roofscape, so they are worth it above the
      // low tier — but only on a roof deep enough to carry one, which the
      // builder decides from the measured pitch.
      const plan = buildRoof(
        roofMesh,
        rec,
        ring,
        colour,
        dormers ? { mesh: wallMesh, colour: wallColour } : undefined,
      );

      this.buildWalls(wallMesh, ring, plan, field, wallColour);
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

    let meanBase = 0;
    for (const y of baseY) meanBase += y;
    meanBase /= Math.max(1, baseY.length);
    // The eave the façade shader draws its cornice, storeys and gable field
    // against. One number per building rather than per vertex, because a
    // cornice that follows the ground under it is not a cornice.
    const eaveAbove = Math.max(2.4, plan.eave - meanBase);

    // Per-building phase for the window grid, derived from the footprint so it
    // is stable across reloads.
    let along = ((ring[0] as THREE.Vector2).x * 7.31 + (ring[0] as THREE.Vector2).y * 3.17) % 3.4;
    const cuts: number[] = [];
    const pA = new THREE.Vector2();
    const pB = new THREE.Vector2();
    for (let i = 0; i < n; i++) {
      const a = ring[i] as THREE.Vector2;
      const b = ring[(i + 1) % n] as THREE.Vector2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;

      const ay = baseY[i] as number;
      const by = baseY[(i + 1) % n] as number;

      // Split the edge wherever the roof profile bends across it. Without this
      // the gable triangle under a ridge is never built — see RoofPlan.creases.
      cuts.length = 0;
      plan.creases(a, b, cuts);

      let t0 = 0;
      for (let k = 0; k <= cuts.length; k++) {
        const t1 = k === cuts.length ? 1 : (cuts[k] as number);
        if (t1 - t0 < 1e-3) continue;
        pA.set(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
        pB.set(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1);
        const say = ay + (by - ay) * t0;
        const sby = ay + (by - ay) * t1;
        const at = plan.wallTopAt(pA);
        const bt = plan.wallTopAt(pB);

        const p00 = new THREE.Vector3(pA.x, say, pA.y);
        const p10 = new THREE.Vector3(pB.x, sby, pB.y);
        const p11 = new THREE.Vector3(pB.x, bt, pB.y);
        const p01 = new THREE.Vector3(pA.x, at, pA.y);

        // uv is the plaster tiling; wallUv is metres along/up, for the façade.
        const u0 = along + len * t0;
        const u1 = along + len * t1;
        const uv00 = new THREE.Vector2(u0, say);
        const uv10 = new THREE.Vector2(u1, sby);
        const uv11 = new THREE.Vector2(u1, bt);
        const uv01 = new THREE.Vector2(u0, at);
        const w00 = new THREE.Vector2(u0, 0);
        const w10 = new THREE.Vector2(u1, 0);
        const w11 = new THREE.Vector2(u1, bt - sby);
        const w01 = new THREE.Vector2(u0, at - say);

        pushTri(m, p00, p01, p11, uv00, uv01, uv11, colour, [w00, w01, w11], eaveAbove);
        pushTri(m, p00, p11, p10, uv00, uv11, uv10, colour, [w00, w11, w10], eaveAbove);
        t0 = t1;
      }
      along += len;
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
      g.setAttribute('wallEave', new THREE.Float32BufferAttribute(m.eave, 1));
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
