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
  // Layer 5 has no splat channel of its own. It is mixed in by the shader's
  // noise fields out of the moss/needle pool — see `floorBreakup` below. The
  // Šumava floor is not one surface, and painting it as one is what made the
  // ground read as a flat texture no matter what was drawn on top of it.
  'forest-floor-leaf',
] as const;

/**
 * World metres covered by one tile of each layer. Bigger = less obvious repeat.
 *
 * Deliberately not all the same, and deliberately not related by small integer
 * ratios: layers on commensurate tilings beat against each other and produce a
 * third, larger, and very visible periodicity.
 */
const LAYER_TILING_M = [2.2, 2.6, 3.0, 2.6, 3.4, 1.9] as const;

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
/*
 * Measured mean linear albedo of each source texture, for the record, because
 * the numbers below are only meaningful against them:
 *
 *   moss     0.174 0.157 0.020     needles  0.230 0.188 0.118
 *   dirt     0.326 0.206 0.115     meadow   0.181 0.179 0.056
 *   granite  0.286 0.299 0.233     leaf     0.272 0.129 0.065
 *
 * Note how much *lighter and warmer* needles, dirt and leaf are than moss. Any
 * mosaic that mixes them at equal gain therefore drifts the floor toward beige,
 * and the first pass at the noise breakup did exactly that: a Šumava spruce
 * floor came out looking like a dune. These gains bring all four into the same
 * value band as the moss so the mosaic changes *hue and texture* without
 * changing the value of the ground, which is what a real forest floor does.
 */
const LAYER_GAIN = [0.5, 0.3, 0.3, 0.46, 0.5, 0.3] as const;

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
      //
      // Relaxed from 0.25 + 0.75·ao. That range darkens a fully occluded texel
      // by 4×, which was defensible when this was the *only* occlusion term.
      // The terrain material now also applies a curvature term derived from the
      // heightfield, and the two stack multiplicatively: a hollow with dense
      // texture AO in it was going down by nearly 7×, which is what crushed the
      // floor detail to near-black. This is the texture-scale half only.
      const occ = 0.45 + 0.55 * ((o[i * 4] as number) / 255);
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
// Canopy light — shared between the ground and everything growing out of it
// ---------------------------------------------------------------------------

/**
 * The gap field that decides how much sun reaches the forest floor.
 *
 * This lives here, in one place, because it has to be applied to *every* surface
 * near the ground or the surfaces disagree with each other. It was written for
 * the terrain first, and the undergrowth — a separate `MeshStandardMaterial`
 * with no idea any of this existed — kept the full unattenuated key. The result
 * was visible immediately in a backlit frame: the ground correctly dropped to a
 * tenth of the sun while the tufts standing in it took all of it, so every tuft
 * lit up as a pale spike against dark moss. That is the exact failure this whole
 * pass started from, reintroduced through the back door.
 *
 * `ol_` prefixes because the terrain's own `<common>` block already defines
 * `hash21` and `vnoise` and GLSL has no namespaces.
 */
const CANOPY_LIGHT_GLSL = /* glsl */ `
  float ol_hash21( vec2 p ) {
    p = fract( p * vec2( 123.34, 456.21 ) );
    p += dot( p, p + 45.32 );
    return fract( p.x * p.y );
  }
  float ol_vnoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float a = ol_hash21( i );
    float b = ol_hash21( i + vec2( 1.0, 0.0 ) );
    float c = ol_hash21( i + vec2( 0.0, 1.0 ) );
    float d = ol_hash21( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }
  // canopyOpen: 1 for a clearing, ~0.55 under a closed 24 m stand.
  float ol_canopyLight( vec2 pp, float canopyOpen ) {
    float gap = 0.45 * ol_vnoise( pp / 9.0 + 3.3 )
              + 0.33 * ol_vnoise( pp / 3.2 - 11.7 )
              + 0.22 * ol_vnoise( pp / 1.1 + 27.4 );
    float pool = smoothstep( 0.46, 0.68, gap );
    float fine = 0.62 + 0.76 * ol_vnoise( pp / 0.62 + 5.1 );
    return 0.03 + 1.9 * pool * fine * canopyOpen;
  }
`;

/** Warm bias applied to the direct term wherever the canopy lets sun through. */
const SUN_POOL_TINT = 'vec3( 1.17, 1.0, 0.66 )';

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
        attribute vec2 ground;
        varying vec4 vSplat;
        varying vec2 vGround;
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;
        `,
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
        #include <worldpos_vertex>
        vSplat = splat;
        vGround = ground;
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
        varying vec2 vGround;
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;

        #define LAYERS ${GROUND_LAYERS.length}

        ${CANOPY_LIGHT_GLSL}

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

        // --- floor breakup ---------------------------------------------------
        // The splat weights arrive from the runnability raster, which is a hard
        // per-class label — so a whole stand of ForestOpen came out as one
        // constant mix of moss and needles, i.e. a flat texture. Real ground is
        // mosaic at every scale: moss where it is damp and shaded, needle litter
        // under the crowns, beech leaf drifted into the hollows, bare mineral
        // soil scuffed through on the rises.
        //
        // Three octaves, roughly 17 m / 5 m / 1.6 m, redistribute the moss+
        // needle pool between four surfaces without touching the *total*, so the
        // class still governs how much forest floor there is — only the mixture
        // within it varies. That keeps D-002 intact: the map still tells the
        // truth about runnability.
        //
        // 1.6 m matters as much as 17 m. Without the fine octave the mosaic is
        // correct but too smooth, and smooth mosaic still reads as a gradient
        // rather than as litter.
        vec3 floorNoise( vec2 p ) {
          return vec3(
            vnoise( p / 17.0 + 4.1 ),
            vnoise( p / 5.0 - 28.7 ),
            vnoise( p / 1.6 + 61.4 )
          );
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
        w[5] = 0.0;

        // --- mosaic ----------------------------------------------------------
        {
          vec3 fn = floorNoise( vWorldPos.xz );
          float pool = w[0] + w[1];
          if ( pool > 0.01 ) {
            // Where in the moss-to-needle range this fragment sits. The class mean
            // is the centre; the noise swings a long way either side of it, so a
            // ForestOpen stand contains genuinely mossy and genuinely bare-litter
            // ground rather than one average of the two.
            // The swing has to stay modest. At 1.7 it saturated to pure needle
            // litter over about 40 % of the ground, and since needle litter is
            // the lighter surface the stand read as beige rather than as moss.
            // Moss stays the majority surface — that is what Sumava is.
            float mean = w[1] / pool;
            float swing = fn.x * 0.62 + fn.y * 0.26 + fn.z * 0.12 - 0.5;
            float needleFrac = clamp( mean + swing * 1.0, 0.0, 1.0 );

            // Leaf litter drifts: it wants the *hollows* (low curvature term)
            // and a high mid-scale noise. Capped low — this is Sumava spruce, a
            // beech-litter floor would put the venue in the wrong region (D-007).
            float leafFrac = smoothstep( 0.58, 0.92, fn.y * 0.65 + fn.z * 0.35 )
                           * smoothstep( 1.0, 0.72, vGround.x ) * 0.45;

            // Bare mineral soil scuffed through on the fine octave's peaks. This
            // is what puts actual gaps in the ground cover, which is what makes
            // the undergrowth clusters read as clusters.
            float bareFrac = smoothstep( 0.82, 0.97, fn.z * 0.7 + fn.x * 0.3 ) * 0.2;

            float rest = 1.0 - leafFrac - bareFrac;
            w[0] = pool * rest * ( 1.0 - needleFrac );
            w[1] = pool * rest * needleFrac;
            w[5] = pool * leafFrac;
            w[2] += pool * bareFrac;
          }
        }

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

        // Curvature occlusion from the heightfield (see terrain.ts). Tinted
        // rather than neutral: the light that survives into a hollow has bounced
        // off moss and litter on the way in, so it arrives green-brown. A flat
        // grey multiply here reads as dirt, not as shadow.
        float ao = clamp( vGround.x, 0.55, 1.12 );
        vec3 aoTint = mix( vec3( 0.72, 0.80, 0.62 ), vec3( 1.0 ), smoothstep( 0.55, 1.0, ao ) );

        // The moss map is extraordinarily chromatic — 0.174 / 0.157 / 0.020
        // linear, a blue channel one ninth of the red. Multiplied by a blue
        // skylight fill that leaves the *shaded* floor at rgb(25,27,8) where the
        // reference's shaded moss is rgb(24,31,19): the right value, almost no
        // blue. A shadow lit by sky has to carry some sky in it, and a
        // real moss mat is a mixture of species and dead litter, not one pigment.
        // Pulling 12 % toward its own luminance costs nothing in the sunlit
        // pools, where the warm direct term dominates, and puts the skylight
        // back into the shadows, which is where the eye reads "outdoors".
        vec3 groundAlbedo = mix(
          vec3( dot( accAlbedo, vec3( 0.2126, 0.7152, 0.0722 ) ) ), accAlbedo, 0.88 );

        diffuseColor.rgb *= groundAlbedo * macroVariation( vWorldPos.xz ) * ao * aoTint;
        vec3 blendedNormal = normalize( accNormal );
        float blendedRough = accRough;
        `,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          // --- warm sunlit pools ---------------------------------------------
          // The shafts already work; what was missing is *where they land*. In
          // the reference the contrast between the cold shaded floor and the
          // warm pools is most of the image, and it is not something the shadow
          // map gives you for free — a shadow map gives you a hard-edged patch
          // of the same light that lit everything else.
          //
          // Two things happen here, and only to the direct term, so the shaded
          // floor is untouched and this costs nothing where it would be wrong:
          //
          //  1. The sun contribution is pushed warm. Sunlight that has come
          //     through a spruce canopy is genuinely warmer than the blue
          //     skylight filling the shade, and the split is what makes the pool
          //     read as sunlight rather than as a bright spot.
          //  2. It is gated by a canopy-gap field, which is the part that
          //     actually creates pools. Measured before this existed: the sun
          //     raised the *whole* visible floor from 0.106 to 0.288 display and
          //     left 0.4 % of it above 0.45 — uniformly, weakly lit ground with
          //     no structure at all. The backdrop reference runs its shaded moss
          //     at 0.11–0.21 and its sunlit moss at 0.375 mean with peaks past
          //     0.9, i.e. mostly dark with a bright minority.
          //
          //     The shadow map cannot produce that on its own. It resolves the
          //     trunks and the crown silhouettes but nothing of the needle
          //     structure *inside* a crown, and a spruce crown is mostly hole.
          //     So the direct term is multiplied by a gap field at 7 m and 2.3 m
          //     (the openings) and broken up at 0.62 m (needle shadow inside an
          //     opening). It does not align with the near trunks, and it should
          //     not: in a mature stand the light on the floor comes from gaps
          //     twenty metres up, which is why real dapple never lines up with
          //     the trees you are standing next to.
          //
          //     The real shadow map still multiplies on top, so a trunk still
          //     casts its own shadow across a pool.
          //
          //     The gate is deliberately narrow and high. A gentle one
          //     (0.40 to 0.74) left the gap field sitting at 0.4-0.6 across most
          //     of the ground, which is not a pool, it is a haze: measured mean
          //     0.31 display against the reference's 0.135. Two smoothed value
          //     noises sum to something tightly clustered around 0.5, so the
          //     threshold has to sit well out on the shoulder to keep the lit
          //     fraction near a fifth, which is about what a closed spruce stand
          //     lets through.
          //
          //     Three octaves, not two. At two the pools came out as long smooth
          //     bands running across the slope - correctly placed, wrong shape.
          //     The 1.1 m octave is what turns a band into dapple.
          vec2 pp = vWorldPos.xz;
          // Peak gain is the number that decides whether a pool is sunlight or a
          // hole in the exposure. At 1.9 the pools clipped to a desaturated
          // near-white around 0.85 display and read as sand; the reference's
          // sunlit moss sits at 0.375 mean and keeps its colour all the way up.
          // Losing the hue is worse than losing the brightness, because the warm
          // pool against the cold shade *is* the effect.
          //     The gap field alone was not enough. It has no idea where the
          //     canopy actually is, so it put a bright, flat, khaki floor under
          //     a stand the LiDAR says carries 24 m of closed spruce. vGround.y
          //     is that canopy height model, sampled per vertex: it is the same
          //     raster the tree placement scales its variants against, so the
          //     light on the floor and the trees standing on it now agree.
          //
          //     Not a hard cut-off. A closed 24 m stand still passes about 45 %,
          //     because a spruce crown is not opaque and because a floor with no
          //     pools at all is as wrong as a floor that is all pool.
          float canopyOpen = 1.0 - 0.45 * smoothstep( 3.0, 20.0, vGround.y * 30.0 );
          float canopyLight = ol_canopyLight( pp, canopyOpen );
          reflectedLight.directDiffuse *= ${SUN_POOL_TINT} * canopyLight;

          // The specular has to be gated by the *same* field, and damped hard.
          // Measured: a sunlit pool came out at rgb(105,101,91) — the right
          // brightness (the reference's sunlit moss is rgb(106,97,54)) and
          // almost none of the colour. MeshStandardMaterial's fixed F0 of 0.04
          // puts a neutral, light-coloured specular lobe on the ground, and
          // against a moss albedo whose blue channel is 0.010 linear that lobe
          // *is* the blue channel. It was also completely ungated, so ground the
          // canopy field had put in shade still carried a full sun highlight.
          //
          // Moss and needle litter are as close to Lambertian as natural
          // surfaces get. 0.3 is generous.
          reflectedLight.directSpecular *= canopyLight * 0.3;
          reflectedLight.indirectSpecular *= 0.3;

          // A pool lights its own surroundings. Feeding a little of the direct
          // term back as warm indirect is a one-line stand-in for the bounce
          // that makes sunlit moss glow rather than merely be bright.
          reflectedLight.indirectDiffuse +=
            reflectedLight.directDiffuse * vec3( 0.26, 0.19, 0.08 );
        }
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
  /**
   * The spruce trunk pack: albedo, normal, roughness at the trunk's own repeat.
   *
   * Separate from `bark` because the repeat differs and a `THREE.Texture`
   * carries its own. `spruce.glb` authors the trunk UVs at 0.7 m per vertical
   * tile against two tiles round the circumference — on a 25 cm-radius bole that
   * is 0.79 m round against 0.7 m up, i.e. very nearly square. So the pack must
   * be at repeat 1.0: anything else both stretches the grain and slides the
   * fissures in the normal map off the fissures in the albedo.
   *
   * These are `clone()`s of the `bark` textures, not a second load. A clone
   * shares its `source`, so this costs one extra uv-transform and *no* extra
   * fetch or GPU upload — which the previous two-`loadAsync` version was paying
   * twice over for the same 1k normal map.
   */
  barkTrunk: THREE.Texture[];
}

/**
 * The gain `bake_bark_png` bakes in when it downsamples the shared spruce
 * albedo into the .glb (tools/blender/assets/spruce.py, "it now only takes the
 * edge off"). Swapping that embedded 256 px map for the full-resolution one has
 * to reapply the gain, or every bole in the forest jumps ~19 % brighter than the
 * asset was tuned at. Linear, because `m.color` multiplies the sampled albedo in
 * linear space — same space Blender's `img.pixels` gain was applied in.
 */
const BARK_BAKE_GAIN = new THREE.Color(0.84, 0.84, 0.85);

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
  // Same image, different uv transform. `clone()` shares `source`, so the
  // renderer uploads the texture once however many repeats we need off it.
  const atRepeat1 = (t: THREE.Texture): THREE.Texture => {
    const c = t.clone();
    c.repeat.set(1, 1);
    return c;
  };

  const bark = await Promise.all([
    grab('bark-spruce', 'albedo', true, 1.6),
    grab('bark-spruce', 'normal', false, 1.6),
    grab('bark-spruce', 'roughness', false, 1.6),
  ]);
  detail = {
    granite: await Promise.all([
      grab('granite-boulder', 'albedo', true, 0.42),
      grab('granite-boulder', 'normal', false, 0.42),
      grab('granite-boulder', 'roughness', false, 0.42),
    ]),
    bark,
    barkTrunk: bark.map(atRepeat1),
  };
  return detail;
}

/**
 * Patch a material so it is lit by the canopy-gap field.
 *
 * Anything that sits *on* the forest floor has to share the ground's light or it
 * disagrees with it. Boulders were the clearest case: `granite_light` ends up at
 * 0.045 effective linear albedo, which is **darker than the moss around it** at
 * 0.074 — and it still rendered as the brightest object in the frame, because it
 * was taking the full 9.5 key while the ground beside it was taking a tenth of
 * it. Darkening the albedo to compensate would have been treating the symptom
 * and would have made the boulder wrong in a clearing.
 *
 * Deliberately **not** applied to bark or foliage. A 25 m spruce is genuinely
 * lit from above along most of its length; imposing a ground-level gap field on
 * it would put canopy shadows forty feet up in the air.
 *
 * `canopyOpen` is a constant for the same reason as in the undergrowth: these
 * are near-field objects and threading a per-instance canopy sample through the
 * scatter path is not worth the difference.
 */
function applyCanopyLight(mat: THREE.MeshStandardMaterial, key: string): void {
  // Idempotence guard — required, not defensive.
  //
  // This chains onto any existing `onBeforeCompile`, so patching the same
  // material twice runs both handlers, and each one replaces `#include <common>`
  // again. The result is `varying vec3 vGroundWorld;` declared N times and the
  // helper functions redefined N times, which fails GLSL compilation outright
  // and makes the object VANISH rather than look wrong.
  //
  // Materials arrive here more than once in practice: glTF assets share
  // material instances across variants and LODs, so a single `granite_lichen`
  // is reachable from many meshes.
  const patched = mat.userData as { canopyLit?: string };
  if (patched.canopyLit) return;
  patched.canopyLit = key;

  const previous = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    previous?.call(mat, shader, renderer);

    // Second, stronger guard: check the shader source itself.
    //
    // The userData flag above stops us patching one material twice, but it
    // cannot stop a handler CHAIN from running twice over the same source —
    // and glTF materials are cloned per variant and LOD, which copies
    // `onBeforeCompile` along with the chain already attached to it. Testing
    // the source is the only check that cannot be defeated by how the material
    // got here.
    if (shader.vertexShader.includes('vGroundWorld')) return;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n        varying vec3 vGroundWorld;',
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
        #include <worldpos_vertex>
        vGroundWorld = ( modelMatrix
          #ifdef USE_INSTANCING
            * instanceMatrix
          #endif
          * vec4( transformed, 1.0 ) ).xyz;
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n        varying vec3 vGroundWorld;\n        ${CANOPY_LIGHT_GLSL}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          float canopyLight = ol_canopyLight( vGroundWorld.xz, 0.7 );
          reflectedLight.directDiffuse *= ${SUN_POOL_TINT} * canopyLight;
          reflectedLight.directSpecular *= canopyLight * 0.5;
        }
        `,
      );
  };
  const previousKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${previousKey ? previousKey.call(mat) : ''}|canopy-${key}`;
  mat.needsUpdate = true;
}

/**
 * Material for the instanced ground-cover tufts.
 *
 * It lives here rather than in vegetation.ts for one reason: it has to be lit by
 * the *same* canopy-gap field as the terrain it grows out of. See
 * `CANOPY_LIGHT_GLSL`. Anything that skips that gate takes the full 9.5 key
 * while the ground beside it takes a fifth of it, and turns into a pale speck —
 * which is the single defect this whole pass exists to remove.
 *
 * `canopyOpen` is a constant 0.6 rather than a sampled value. The tufts only
 * exist inside a 22 m ring, the canopy height model barely moves over that
 * distance, and threading a per-instance attribute through for the difference
 * would cost more than it is worth. 0.6 is a closed-to-moderate stand: erring
 * toward *less* light is the safe direction for this layer.
 */
export function createUndergrowthMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vTuftWorld;
        `,
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
        #include <worldpos_vertex>
        vTuftWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vTuftWorld;
        ${CANOPY_LIGHT_GLSL}
        `,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          float canopyLight = ol_canopyLight( vTuftWorld.xz, 0.6 );
          reflectedLight.directDiffuse *= ${SUN_POOL_TINT} * canopyLight;
          // Leaves are not glossy at this scale and a specular lobe on a
          // sub-pixel blade is pure aliasing.
          reflectedLight.directSpecular *= canopyLight * 0.15;
          reflectedLight.indirectSpecular *= 0.15;
        }
        `,
      );
  };

  mat.customProgramCacheKey = () => 'undergrowth';
  return mat;
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

  // Run once per material, not once per mesh — the same reason
  // `applyCanopyLight` carries its own guard, but with a quieter failure mode.
  //
  // A glTF material instance is shared by every primitive that references it,
  // so `loadAsset`'s per-mesh traverse hands us the same `spruce_bark` once per
  // variant × LOD. Most of what follows is idempotent; the `m.color` multiplies
  // are not. They compound, and unlike a duplicated shader patch nothing errors
  // — the colour is simply wrong and stays wrong.
  //
  // Measured off the running scene before this guard: `beech_bark` took its
  // 0.55 darkening six times and arrived at 0.030, a black slab rather than the
  // pale bole that branch exists to produce. Granite took its 1.25 lift eight
  // times. Every one of those constants was tuned by eye against the reference,
  // so raising them to the eighth power makes the tuning meaningless.
  const state = m.userData as { conditioned?: boolean };
  if (state.conditioned) return m;
  state.conditioned = true;

  m.metalness = 0;
  m.envMapIntensity = kind === 'foliage' ? 0.55 : 0.75;

  // Untextured assets get the shared detail maps. The base colour factor stays
  // as the tint, so the granite palette the modeller chose per variant survives.
  // `bark` belongs here as much as `wood` does. `deadwood.glb` names its two
  // surfaces `dw_wood` and `dw_bark`, and only the first classified into this
  // branch — so the *bark* on a fallen log rendered as a flat brown factor while
  // the stripped wood beside it got the full bark pack. A log lying across the
  // route is near-field furniture the player runs straight past, so it showed.
  if (!m.map && detail && (kind === 'rock' || kind === 'wood' || kind === 'bark')) {
    const pack = kind === 'rock' ? detail.granite : detail.bark;
    m.map = pack[0] ?? null;
    m.normalMap = pack[1] ?? null;
    m.roughnessMap = pack[2] ?? null;
    m.normalScale.set(0.8, 0.8);
    // The flat factor was doing all the work before; lift it so the texture is
    // not multiplied down into mud. 2.4/2.0 was too far the other way: granite
    // at 0.29 linear albedo lifted that much is brighter than anything else in
    // the frame, and a boulder that out-values the canopy reads as a polystyrene
    // prop. Šumava granite under lichen is a dark, cool grey.
    // 2.4 was far too hot; 0.8, tried next, was chasing the wrong variable. The
    // boulders were not too light in *albedo* — measured, `granite_light` came
    // out at 0.045 effective linear against a moss floor at 0.074, i.e. already
    // darker than the ground — they were too bright because they were taking the
    // full key while the ground took a tenth of it. That is fixed properly in
    // `applyCanopyLight` below. 1.25 is then just the honest value for lichened
    // Sumava granite.
    m.color.multiplyScalar(kind === 'rock' ? 1.25 : 1.0);
  }

  switch (kind) {
    case 'bark':
      m.roughness = Math.max(m.roughness, 0.92);
      // A trunk with an embedded albedo used to fall through every branch in
      // this function and get nothing: the detail-pack block above only fires
      // when `!m.map`, and `spruce_bark` ships a 512 px albedo baked into the
      // .glb. So the bole had colour and no relief, and inside about two metres
      // it read as a painted cylinder — at eye height in a colonnade stand that
      // is the closest, largest thing in the frame.
      //
      // The .glb deliberately carries albedo only ("the rest would dwarf the
      // geometry"), with the material name as the binding key. This is the
      // runtime half of that contract.
      //
      // Spruce only. `beech_bark` is authored against `bark-beech`, and putting
      // spruce fissures on a smooth beech bole would be worse than flat.
      if (m.map && detail && /spruce/i.test(m.name)) {
        // The albedo goes too, not just the relief. The embedded one is 256 px
        // for a surface the player stands a metre from — it is the blurriest
        // thing in the near field once the 1k normal map is sharpening the
        // fissures around it, and the mismatch reads as a decal on a smooth
        // pole. The .glb only carries that map so the asset looks right opened
        // standalone; the whole point of binding by material name is that the
        // runtime can do better. Reapply the bake gain so the value does not
        // move — see `BARK_BAKE_GAIN`.
        if (detail.barkTrunk[0]) {
          m.map = detail.barkTrunk[0];
          m.color.multiply(BARK_BAKE_GAIN);
        }
        m.normalMap = detail.barkTrunk[1] ?? null;
        m.roughnessMap = detail.barkTrunk[2] ?? null;
        // Full strength. Spruce bark is deeply fissured and this is the only
        // surface relief a bole has; the terrain's 0.55 exists to avoid fighting
        // the heightfield, which does not apply here.
        m.normalScale.set(1, 1);
      }
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
      // Sits on the floor, so it is lit by the floor's light. See
      // `applyCanopyLight`. Without this a boulder in a closed stand is three
      // times brighter than the ground it is resting on.
      applyCanopyLight(m, 'rock');
      break;
    case 'wood':
      m.roughness = 0.95;
      applyCanopyLight(m, 'wood');
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
