/**
 * PBR materials for the world.
 *
 * The terrain material is the interesting one. It is triplanar and splatted by
 * runnability class, which is not decoration — D-002 says the map and the
 * physics share one enum, and this is the third consumer of it. If the map
 * prints light green and the runner slows down, the ground under their feet had
 * better also change. Splatting off the same raster is what makes that true by
 * construction rather than by art direction.
 *
 * Five surfaces are packed into three `DataArrayTexture`s rather than fifteen
 * separate samplers: WebGL2 gives us array textures, and fifteen bound units is
 * past what the low tier can spend on one material.
 *
 * Ambient occlusion is folded into albedo at load time. It costs one canvas
 * composite per layer and saves a whole array texture and five samples per
 * fragment, and terrain AO is static anyway.
 */

import * as THREE from 'three';
import type { QualityTier } from '@/core/capabilities';

// ---------------------------------------------------------------------------
// Texture loading
// ---------------------------------------------------------------------------

/**
 * Ground layers, in splat-channel order. Channel 4 (granite) is the implicit
 * remainder weight — see `SPLAT_FOR_RUNNABILITY` in terrain.ts.
 */
export const GROUND_LAYERS = [
  'moss',
  'forest-floor-needles',
  'dirt-path',
  'meadow-grass',
  'granite-lichen',
] as const;

/** World metres covered by one tile of each layer. Bigger = less obvious repeat. */
const LAYER_TILING_M = [2.2, 2.6, 3.0, 2.6, 3.4] as const;

/**
 * Per-layer albedo gain.
 *
 * The generated PBR set has mean albedos of 0.45–0.61 sRGB. Real forest floor
 * is 0.05–0.12: moss and needle litter are among the darkest natural surfaces
 * there are. Used raw they blow out the moment the sun reaches them and there
 * is no headroom left for the sun patches to *be* brighter than the shade,
 * which is the entire contrast structure of the reference frame.
 *
 * These are not a look — they are a units correction on the source textures.
 */
const LAYER_GAIN = [0.5, 0.42, 0.5, 0.5, 0.58] as const;

function textureSize(tier: QualityTier): 256 | 512 | 1024 {
  return tier === 'low' ? 256 : tier === 'medium' ? 512 : 1024;
}

function texturePath(name: string, map: string, size: 256 | 512 | 1024): string {
  return size === 1024
    ? `/textures/${name}/${map}.webp`
    : `/textures/${name}/${map}@${size}.webp`;
}

async function decode(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

function readPixels(bmp: ImageBitmap, size: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bmp, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

/**
 * Build one `DataArrayTexture` per map type from the layer list.
 *
 * All three arrays are built in a single pass over the decoded bitmaps so the
 * (large) ImageBitmaps can be closed immediately rather than all being held at
 * once — five layers of 1024² RGBA is 20 MB per array and the peak matters on a
 * 4 GB phone.
 */
export interface GroundTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  roughness: THREE.DataArrayTexture;
  size: number;
  dispose(): void;
}

export async function loadGroundTextures(tier: QualityTier): Promise<GroundTextures> {
  const size = textureSize(tier);
  const n = GROUND_LAYERS.length;
  const px = size * size;

  const albedoData = new Uint8Array(new ArrayBuffer(px * 4 * n));
  const normalData = new Uint8Array(new ArrayBuffer(px * 4 * n));
  const roughData = new Uint8Array(new ArrayBuffer(px * 4 * n));

  for (let layer = 0; layer < n; layer++) {
    const name = GROUND_LAYERS[layer] as string;
    const [alb, nrm, rgh, ao] = await Promise.all([
      decode(texturePath(name, 'albedo', size)),
      decode(texturePath(name, 'normal', size)),
      decode(texturePath(name, 'roughness', size)),
      decode(texturePath(name, 'ao', size)),
    ]);

    const a = readPixels(alb, size);
    const nn = readPixels(nrm, size);
    const r = readPixels(rgh, size);
    const o = readPixels(ao, size);
    alb.close();
    nrm.close();
    rgh.close();
    ao.close();

    const base = layer * px * 4;
    for (let i = 0; i < px; i++) {
      // AO folded into albedo. Lifted off zero so a dark AO map cannot crush a
      // surface to black — the reference's shadows are deep but never dead.
      const occ = 0.25 + 0.75 * ((o[i * 4] as number) / 255);
      albedoData[base + i * 4] = (a[i * 4] as number) * occ;
      albedoData[base + i * 4 + 1] = (a[i * 4 + 1] as number) * occ;
      albedoData[base + i * 4 + 2] = (a[i * 4 + 2] as number) * occ;
      albedoData[base + i * 4 + 3] = 255;

      normalData[base + i * 4] = nn[i * 4] as number;
      normalData[base + i * 4 + 1] = nn[i * 4 + 1] as number;
      normalData[base + i * 4 + 2] = nn[i * 4 + 2] as number;
      normalData[base + i * 4 + 3] = 255;

      roughData[base + i * 4] = r[i * 4] as number;
      roughData[base + i * 4 + 1] = r[i * 4] as number;
      roughData[base + i * 4 + 2] = r[i * 4] as number;
      roughData[base + i * 4 + 3] = 255;
    }
  }

  // `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`: three's
  // texture constructors take a `BufferSource`, which excludes SharedArrayBuffer.
  const make = (data: Uint8Array<ArrayBuffer>, srgb: boolean): THREE.DataArrayTexture => {
    const t = new THREE.DataArrayTexture(data, size, size, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };

  const albedo = make(albedoData, true);
  const normal = make(normalData, false);
  const roughness = make(roughData, false);

  return {
    albedo,
    normal,
    roughness,
    size,
    dispose() {
      albedo.dispose();
      normal.dispose();
      roughness.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Terrain material
// ---------------------------------------------------------------------------

/**
 * Triplanar, splatted terrain.
 *
 * Built on `MeshStandardMaterial` and patched through `onBeforeCompile` rather
 * than written as a raw `ShaderMaterial`, because that keeps three's lighting,
 * shadow, fog and tone-mapping chunks — reimplementing four of those to gain a
 * cleaner shader would be a bad trade, and shadows in particular are where the
 * reference's contrast lives.
 *
 * Cost control, in order of importance:
 *  - Layers whose splat weight is under 1 % are branched out entirely. A
 *    typical fragment touches one or two of the five.
 *  - Triplanar planes below 2 % weight are branched out. On terrain this flat
 *    that is usually two of the three.
 *  - The `low` tier drops to a plain Y projection and skips the normal maps.
 */
export function createTerrainMaterial(
  tex: GroundTextures,
  tier: QualityTier,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true, // the ground is a huge low-frequency gradient; 8-bit banding shows
  });

  const triplanar = tier !== 'low';
  const useNormals = tier !== 'low';

  const scales = LAYER_TILING_M.map((m) => 1 / m);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tAlbedo = { value: tex.albedo };
    shader.uniforms.tNormalArr = { value: tex.normal };
    shader.uniforms.tRough = { value: tex.roughness };
    shader.uniforms.uLayerScale = { value: new Float32Array(scales) };
    shader.uniforms.uLayerGain = { value: new Float32Array(LAYER_GAIN) };

    // --- vertex ---------------------------------------------------------
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 splat;
        varying vec4 vSplat;
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;
        `,
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
        #include <worldpos_vertex>
        vSplat = splat;
        vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vWorldNrm = normalize( mat3( modelMatrix ) * objectNormal );
        `,
      );

    // --- fragment -------------------------------------------------------
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray tAlbedo;
        uniform sampler2DArray tNormalArr;
        uniform sampler2DArray tRough;
        uniform float uLayerScale[ ${GROUND_LAYERS.length} ];
        uniform float uLayerGain[ ${GROUND_LAYERS.length} ];
        varying vec4 vSplat;
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;

        #define LAYERS ${GROUND_LAYERS.length}

        struct Surf { vec3 albedo; vec3 normal; float rough; };

        // --- macro variation -------------------------------------------------
        // A 2 m tile repeated across a 400 m view is a visible grid, and the
        // eye finds it instantly on a flat forest floor. Two octaves of very
        // low-frequency noise break the repeat without another texture fetch.
        float hash21( vec2 p ) {
          p = fract( p * vec2( 123.34, 456.21 ) );
          p += dot( p, p + 45.32 );
          return fract( p.x * p.y );
        }
        float vnoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          float a = hash21( i );
          float b = hash21( i + vec2( 1.0, 0.0 ) );
          float c = hash21( i + vec2( 0.0, 1.0 ) );
          float d = hash21( i + vec2( 1.0, 1.0 ) );
          return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
        }
        float macroVariation( vec2 p ) {
          return 0.78 + 0.30 * vnoise( p / 21.0 ) + 0.14 * vnoise( p / 6.5 + 17.3 );
        }

        // Triplanar weights, sharpened so the blend band is narrow enough not
        // to read as a smear on a 30 degree valley side.
        vec3 triWeights( vec3 n ) {
          vec3 w = pow( abs( n ), vec3( 6.0 ) );
          return w / max( w.x + w.y + w.z, 1e-4 );
        }

        Surf sampleLayer( int layer, float scale, vec3 p, vec3 n, vec3 tw ) {
          Surf s;
          s.albedo = vec3( 0.0 );
          s.normal = vec3( 0.0 );
          s.rough = 0.0;
          float l = float( layer );

          ${
            triplanar
              ? /* glsl */ `
          if ( tw.y > 0.02 ) {
            vec2 uv = p.xz * scale;
            s.albedo += texture( tAlbedo, vec3( uv, l ) ).rgb * tw.y;
            s.rough  += texture( tRough,  vec3( uv, l ) ).r   * tw.y;
            ${
              useNormals
                ? `vec3 ny = texture( tNormalArr, vec3( uv, l ) ).xyz * 2.0 - 1.0;
                   s.normal += vec3( ny.x, ny.z, ny.y ) * tw.y;`
                : `s.normal += vec3( 0.0, 1.0, 0.0 ) * tw.y;`
            }
          }
          if ( tw.x > 0.02 ) {
            vec2 uv = p.zy * scale;
            s.albedo += texture( tAlbedo, vec3( uv, l ) ).rgb * tw.x;
            s.rough  += texture( tRough,  vec3( uv, l ) ).r   * tw.x;
            ${
              useNormals
                ? `vec3 nx = texture( tNormalArr, vec3( uv, l ) ).xyz * 2.0 - 1.0;
                   s.normal += vec3( nx.z, nx.y, nx.x ) * tw.x;`
                : `s.normal += vec3( 1.0, 0.0, 0.0 ) * sign( n.x ) * tw.x;`
            }
          }
          if ( tw.z > 0.02 ) {
            vec2 uv = p.xy * scale;
            s.albedo += texture( tAlbedo, vec3( uv, l ) ).rgb * tw.z;
            s.rough  += texture( tRough,  vec3( uv, l ) ).r   * tw.z;
            ${
              useNormals
                ? `vec3 nz = texture( tNormalArr, vec3( uv, l ) ).xyz * 2.0 - 1.0;
                   s.normal += vec3( nz.x, nz.y, nz.z ) * tw.z;`
                : `s.normal += vec3( 0.0, 0.0, 1.0 ) * sign( n.z ) * tw.z;`
            }
          }`
              : /* glsl */ `
          vec2 uv = p.xz * scale;
          s.albedo = texture( tAlbedo, vec3( uv, l ) ).rgb;
          s.rough  = texture( tRough,  vec3( uv, l ) ).r;
          s.normal = vec3( 0.0, 1.0, 0.0 );`
          }
          return s;
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec3 wn = normalize( vWorldNrm );
        vec3 tw = triWeights( wn );

        // Weights: four stored, the fifth (granite) is the remainder. Steep
        // ground pulls granite up regardless of class — a 35 degree Sumava
        // slope is outcrop, whatever the vegetation raster says about it.
        float slopeRock = smoothstep( 0.62, 0.94, 1.0 - wn.y );
        vec4 sw = vSplat * ( 1.0 - slopeRock );
        float wRock = max( 0.0, 1.0 - ( sw.x + sw.y + sw.z + sw.w ) );
        float wsum = sw.x + sw.y + sw.z + sw.w + wRock;
        float inv = 1.0 / max( wsum, 1e-4 );

        float w[ LAYERS ];
        w[0] = sw.x * inv; w[1] = sw.y * inv; w[2] = sw.z * inv;
        w[3] = sw.w * inv; w[4] = wRock * inv;

        vec3 accAlbedo = vec3( 0.0 );
        vec3 accNormal = vec3( 0.0 );
        float accRough = 0.0;

        for ( int i = 0; i < LAYERS; i++ ) {
          if ( w[ i ] < 0.01 ) continue;
          Surf s = sampleLayer( i, uLayerScale[ i ], vWorldPos, wn, tw );
          accAlbedo += s.albedo * ( w[ i ] * uLayerGain[ i ] );
          accNormal += s.normal * w[ i ];
          accRough  += s.rough  * w[ i ];
        }

        diffuseColor.rgb *= accAlbedo * macroVariation( vWorldPos.xz );
        vec3 blendedNormal = normalize( accNormal );
        float blendedRough = accRough;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness * clamp( blendedRough, 0.05, 1.0 );
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        useNormals
          ? /* glsl */ `
        // World-space triplanar normals combined with the geometric normal.
        // The 0.55 keeps the detail from fighting the terrain's own relief —
        // pushed to 1.0 the 1 m heightfield stops reading as landform at all.
        normal = normalize( mix( normal, normalize( normal + blendedNormal * 0.55 ), 1.0 ) );
        `
          : '',
      );
  };

  // Force a distinct program from any other MeshStandardMaterial.
  mat.customProgramCacheKey = () => `terrain-${tier}`;
  return mat;
}

// ---------------------------------------------------------------------------
// Vegetation materials
// ---------------------------------------------------------------------------

/**
 * Detail maps for asset materials that ship with a flat base colour.
 *
 * `boulder-set.glb` and `deadwood.glb` carry no textures at all — just a base
 * colour factor — and at the light levels this scene runs at they read as grey
 * plastic. The Blender pipeline gave them UVs, so the fix is to hand them the
 * granite and bark maps we already ship for the terrain.
 *
 * Loaded once and shared. `setDetailTextures` is module state rather than a
 * parameter because `loadAsset` walks a whole glTF scene graph and threading a
 * texture pack through every call site to serve two material names is worse.
 */
export interface DetailTextures {
  granite: THREE.Texture[];
  bark: THREE.Texture[];
}

let detail: DetailTextures | null = null;

export async function loadDetailTextures(tier: QualityTier): Promise<DetailTextures> {
  const size = textureSize(tier);
  const loader = new THREE.TextureLoader();
  // Repeat is per-pack. The Blender UVs are roughly 1 unit per metre, and at
  // 1:1 the granite grain is far too fine on a 4 m boulder — it reads as
  // gravel wrapped round a rock rather than as rock.
  const grab = async (
    name: string,
    map: string,
    srgb: boolean,
    repeat: number,
  ): Promise<THREE.Texture> => {
    const t = await loader.loadAsync(texturePath(name, map, size));
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
    return t;
  };
  detail = {
    granite: await Promise.all([
      grab('granite-boulder', 'albedo', true, 0.42),
      grab('granite-boulder', 'normal', false, 0.42),
      grab('granite-boulder', 'roughness', false, 0.42),
    ]),
    bark: await Promise.all([
      grab('bark-spruce', 'albedo', true, 1.6),
      grab('bark-spruce', 'normal', false, 1.6),
      grab('bark-spruce', 'roughness', false, 1.6),
    ]),
  };
  return detail;
}

/**
 * Retune a material that arrived from a .glb.
 *
 * The tree assets are authored against Blender's own view transform, and dropped
 * straight into an AgX pipeline at exposure 0.85 they come out plasticky and a
 * stop too bright. This pass is deliberately conservative — it does not repaint
 * anything, it fixes the response.
 */
export function conditionAssetMaterial(
  mat: THREE.Material,
  kind: 'bark' | 'foliage' | 'rock' | 'wood',
): THREE.Material {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
  const m = mat;
  m.metalness = 0;
  m.envMapIntensity = kind === 'foliage' ? 0.55 : 0.75;

  // Untextured assets get the shared detail maps. The base colour factor stays
  // as the tint, so the granite palette the modeller chose per variant survives.
  if (!m.map && detail && (kind === 'rock' || kind === 'wood')) {
    const pack = kind === 'rock' ? detail.granite : detail.bark;
    m.map = pack[0] ?? null;
    m.normalMap = pack[1] ?? null;
    m.roughnessMap = pack[2] ?? null;
    m.normalScale.set(0.8, 0.8);
    // The flat factor was doing all the work before; lift it so the texture is
    // not multiplied down into mud.
    m.color.multiplyScalar(kind === 'rock' ? 2.4 : 2.0);
  }

  switch (kind) {
    case 'bark':
      m.roughness = Math.max(m.roughness, 0.92);
      // Beech bark is genuinely pale, but the asset's is pale *and* flat, and a
      // 90-triangle LOD1 trunk in that value reads as a white slab at 60 m.
      // Pulling it down keeps it recognisably beech without punching holes in
      // the mid-ground.
      if (/beech/i.test(m.name)) m.color.multiplyScalar(0.55);
      break;
    case 'foliage':
      // Spruce needles read as a solid dark mass in the reference; a little
      // transmitted light at the edges is what stops them looking like felt.
      m.roughness = 0.78;
      m.side = THREE.DoubleSide;
      break;
    case 'rock':
      m.roughness = Math.max(m.roughness, 0.88);
      break;
    case 'wood':
      m.roughness = 0.95;
      break;
  }
  if (m.map) m.map.anisotropy = 8;
  return m;
}

/**
 * Material for the billboard imposters used past the near ring.
 *
 * Alpha *test*, not alpha blend: blended foliage at this density needs correct
 * back-to-front sorting per instance, which an InstancedMesh cannot give, and
 * the result flickers as the camera turns. A hard cut plus the fog is stable,
 * and at 120 m the difference is not visible.
 */
export function makeImposterMaterial(source: THREE.Material): THREE.Material {
  const src = source as THREE.MeshStandardMaterial;

  // Unlit, on purpose. The imposter atlas is a *render* of the tree, so its
  // shading is already baked in; running it through the lighting model again
  // lights it twice, and because a crossed quad's normals point outward it
  // catches the sky hard and comes out as a pale cutout — which is exactly what
  // the first build did, with a row of white slabs behind the LOD1 trees.
  //
  // Basic still respects fog, which is what actually matters at 120 m+, and it
  // is the cheapest material in the engine for the most numerous object in the
  // scene.
  const m = new THREE.MeshBasicMaterial({
    map: src.map,
    alphaTest: 0.42,
    transparent: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  // Matched by eye against the LOD1 trees at the swap distance. The atlas was
  // baked under Blender's view transform, which is brighter than ours.
  m.color.setScalar(0.42);
  m.name = `${src.name}_imposter`;
  return m;
}
