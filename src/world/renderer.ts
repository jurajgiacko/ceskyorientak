/**
 * Renderer setup and the post chain.
 *
 * The grade is fixed by docs/RESEARCH-VIDEO.md §5.2 and it is not a matter of
 * taste:
 *
 *  - **AgX, not ACESFilmic.** ACES applies a saturated, contrasty S-curve with
 *    a warm highlight bias. This reference is the opposite — flat, low-key,
 *    desaturated, with the greens pulled toward olive. Running it through ACES
 *    produces a completely different, and wrong, film.
 *  - **Exposure 0.85.** Slightly under, targeting a median frame value near
 *    0.29 with the toe crushed to about 0.09.
 *  - **`FogExp2` in grey-olive, never white.** White fog reads as haze on a
 *    bright day. The reference is a desaturated veil the colour of the
 *    mid-distance canopy.
 *
 * When post-processing is on, the scene is rendered linear into a half-float
 * target and AgX is applied in the composite pass instead of per-material, so
 * the god rays are added in linear light where they belong. The composite
 * shader calls three's own `AgXToneMapping` — same curve, same code, applied
 * once.
 */

import * as THREE from 'three';
import type { Capabilities } from '@/core/capabilities';
import { AdaptiveQuality, PerfMonitor } from '@/core/perf';

/**
 * Grey-olive, matched to the mid-distance canopy. Not white, not blue.
 *
 * Darkened along with the lighting rig, and for a reason worth writing down:
 * `FogExp2` mixes toward this colour in **linear** light, so its brightness has
 * to be read against the scene it is fogging, not against a screenshot. At
 * 0x7c8163 the fog colour is 0.21 linear while the corrected shaded forest floor
 * is 0.015 — fourteen times darker. Nineteen per cent fog at 50 m therefore
 * quadrupled the value of the distant ground and produced a pale beige plateau
 * across the middle distance that looked exactly like a sunlit clearing and was
 * nothing of the kind. It was, briefly, mistaken for one during this work.
 *
 * 0x4d5646 is 0.09 linear: still clearly a veil, still grey-olive, but no longer
 * brighter than everything it sits in front of.
 */
export const FOG_COLOUR_SUNNY = 0x4d5646;
export const FOG_COLOUR_OVERCAST = 0x53523f;

export const EXPOSURE = 0.85;

/**
 * A post effect that consumes the scene colour and depth and returns something
 * to add on top, in linear light. Returning null means "nothing this frame".
 */
export interface PostEffect {
  evaluate(
    renderer: THREE.WebGLRenderer,
    colour: THREE.Texture,
    depth: THREE.DepthTexture,
    camera: THREE.PerspectiveCamera,
  ): THREE.Texture | null;
  setSize(width: number, height: number): void;
  dispose(): void;
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
#include <tonemapping_pars_fragment>

uniform sampler2D tScene;
uniform sampler2D tGlow;
uniform float uGlowStrength;
uniform float uGrain;
uniform float uTime;
uniform float uSaturation;
varying vec2 vUv;

// Cheap hash for the dither grain.
float hash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}

void main() {
  vec3 colour = texture2D( tScene, vUv ).rgb;
  colour += texture2D( tGlow, vUv ).rgb * uGlowStrength;

  colour = AgXToneMapping( colour );

  // Grade pass, RESEARCH-VIDEO §5.2 step 2: pull the midtones down to
  // S ~0.35-0.45 but leave anything already highly chromatic alone. That
  // exemption is the whole visual thesis of the brand — a muted world with the
  // control-flag orange and the Enervit red as the only saturated things in it.
  // Measured without it the frame sat at S 0.64, twice the reference.
  {
    float mx = max( colour.r, max( colour.g, colour.b ) );
    float mn = min( colour.r, min( colour.g, colour.b ) );
    float chroma = mx > 1e-4 ? ( mx - mn ) / mx : 0.0;
    float protect = smoothstep( 0.62, 0.86, chroma );
    float luma = dot( colour, vec3( 0.2126, 0.7152, 0.0722 ) );
    colour = mix( vec3( luma ), colour, mix( uSaturation, 1.0, protect ) );
  }

  // A trace of grain, applied after tone mapping. This is doing real work:
  // the fog is an enormous smooth gradient and 8-bit output banding across it
  // is the single most obvious artefact in a forest scene.
  float n = hash( gl_FragCoord.xy + vec2( uTime ) ) - 0.5;
  colour += n * uGrain;

  gl_FragColor = vec4( colour, 1.0 );
  #include <colorspace_fragment>
}
`;

export interface WorldRendererOptions {
  canvas: HTMLCanvasElement;
  caps: Capabilities;
  /** Disable the post chain entirely. The `low` tier does this. */
  post?: boolean;
}

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly perf = new PerfMonitor();
  readonly adaptive: AdaptiveQuality;

  /** Effects run in order; their outputs are summed into the composite. */
  effects: PostEffect[] = [];

  private readonly caps: Capabilities;
  private readonly usePost: boolean;
  private rt: THREE.WebGLRenderTarget | null = null;
  private composite: THREE.Mesh | null = null;
  private compositeScene: THREE.Scene | null = null;
  private compositeCam: THREE.OrthographicCamera | null = null;
  private compositeMat: THREE.ShaderMaterial | null = null;
  private readonly blackTexture: THREE.DataTexture;

  /** Draw calls and triangles for the *scene* pass, excluding post. */
  sceneCalls = 0;
  sceneTriangles = 0;

  private width = 1;
  private height = 1;
  private appliedScale = 1;
  private sinceAdapt = 0;

  constructor(opts: WorldRendererOptions) {
    this.caps = opts.caps;
    this.usePost = opts.post ?? opts.caps.tier !== 'low';

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // MSAA comes from the render target when post is on
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMappingExposure = EXPOSURE;
    // With post on, the scene target stays linear and AgX happens once in the
    // composite. With post off, three applies it per material.
    this.renderer.toneMapping = this.usePost ? THREE.NoToneMapping : THREE.AgXToneMapping;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows are static within a frame and the sun does not move mid-race;
    // updating the map only when the sun or the shadow frustum moves saves a
    // full extra scene pass every frame.
    this.renderer.shadowMap.autoUpdate = false;
    // The composite is its own render() call, and it would otherwise be the
    // only thing renderer.info describes. Reset manually, at frame start.
    this.renderer.info.autoReset = false;

    this.adaptive = AdaptiveQuality.forTier(opts.caps.tier, opts.caps.touch);

    // 1×1 black, used as the glow input when no effect produced one.
    this.blackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackTexture.needsUpdate = true;

    if (this.usePost) this.buildPost();
  }

  private buildPost(): void {
    const samples = this.caps.tier === 'high' ? 4 : 2;
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples,
      depthBuffer: true,
    });
    this.rt.depthTexture = new THREE.DepthTexture(1, 1);
    this.rt.depthTexture.type = THREE.UnsignedIntType;

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tGlow: { value: this.blackTexture },
        uGlowStrength: { value: 1 },
        uGrain: { value: 0.006 },
        uSaturation: { value: 0.74 },
        uTime: { value: 0 },
        toneMappingExposure: { value: EXPOSURE },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.composite.frustumCulled = false;
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(this.composite);
    this.compositeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** CSS pixel size of the canvas. Call on resize. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applyScale(true);
  }

  private applyScale(force = false): void {
    const scale = this.adaptive.scale;
    if (!force && Math.abs(scale - this.appliedScale) < 1e-3) return;
    this.appliedScale = scale;

    const dpr = Math.min(this.caps.dpr, this.caps.touch ? 2 : 2) * scale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);

    const bw = Math.max(1, Math.round(this.width * dpr));
    const bh = Math.max(1, Math.round(this.height * dpr));
    this.rt?.setSize(bw, bh);
    for (const e of this.effects) e.setSize(bw, bh);
  }

  /**
   * Render one frame.
   *
   * `now` is the rAF timestamp; it feeds the frame-time monitor that both the
   * adaptive scaler and the CI perf gate read, so there is exactly one
   * definition of how fast the game is running.
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, now: number, dtS: number): void {
    this.perf.tick(now);
    this.renderer.info.reset();

    this.sinceAdapt += dtS;
    if (this.sinceAdapt > 1) {
      this.sinceAdapt = 0;
      if (this.adaptive.update(this.perf.sample(), 1)) this.applyScale();
    }

    if (!this.usePost || !this.rt || !this.compositeScene || !this.compositeCam || !this.compositeMat) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      this.sceneCalls = this.renderer.info.render.calls;
      this.sceneTriangles = this.renderer.info.render.triangles;
      return;
    }

    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.sceneCalls = this.renderer.info.render.calls;
    this.sceneTriangles = this.renderer.info.render.triangles;

    let glow: THREE.Texture | null = null;
    for (const effect of this.effects) {
      const out = effect.evaluate(
        this.renderer,
        this.rt.texture,
        this.rt.depthTexture as THREE.DepthTexture,
        camera,
      );
      if (out) glow = out;
    }

    this.compositeMat.uniforms.tScene!.value = this.rt.texture;
    this.compositeMat.uniforms.tGlow!.value = glow ?? this.blackTexture;
    this.compositeMat.uniforms.uTime!.value = now * 0.001;

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.compositeCam);
  }

  /** Request one shadow-map refresh on the next render. */
  refreshShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }

  dispose(): void {
    for (const e of this.effects) e.dispose();
    this.rt?.dispose();
    this.rt?.depthTexture?.dispose();
    this.composite?.geometry.dispose();
    this.compositeMat?.dispose();
    this.blackTexture.dispose();
    this.renderer.dispose();
  }
}

/**
 * The scene fog.
 *
 * Density is the whole atmospheric read of the shot. Sunny sits where contrast
 * has visibly gone by ~120 m, which is what the backdrop reference shows;
 * overcast closes to ~55 m, which is the video's much tighter wet-air look.
 */
export function makeFog(weather: 'sunny' | 'overcast'): THREE.FogExp2 {
  return weather === 'sunny'
    ? new THREE.FogExp2(FOG_COLOUR_SUNNY, 0.0092)
    : new THREE.FogExp2(FOG_COLOUR_OVERCAST, 0.018);
}
