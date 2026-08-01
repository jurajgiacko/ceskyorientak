/**
 * Sky, sun and god rays.
 *
 * D-008 governs the lighting: the default and marketing-facing look is the
 * brief's **sunny hero** — 10:00 sun, hard shadows, volumetric shafts through
 * the spruce canopy. **Overcast** ships as a weather state and is the condition
 * the client's own reference film was shot in (RESEARCH-VIDEO §3.1: no dappled
 * light, no shafts, hemisphere-dominant). They are not a compromise between
 * each other; they are two authentic Czech August conditions, and flat light is
 * a real difficulty modifier because it removes shadow as a navigation cue.
 *
 * The sun position is computed from an actual date, latitude and longitude
 * rather than dialled in by eye, so "10:00 on race day at Vyšší Brod" means the
 * angle it really is — about 43° up in the east-south-east, which is exactly
 * the low-ish raking light the backdrop reference shows.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { QualityTier } from '@/core/capabilities';
import type { PostEffect } from './renderer';

export type Weather = 'sunny' | 'overcast';

// ---------------------------------------------------------------------------
// Solar position
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

export interface SunAngles {
  /** Radians above the horizon. Negative is below. */
  altitude: number;
  /** Radians clockwise from true north. */
  azimuth: number;
}

/**
 * NOAA solar position. Accurate to well under a degree, which is far more than
 * a shadow direction needs, and it means the race-day light is genuinely the
 * light of 5 August 2026 rather than an art guess.
 */
export function sunAngles(date: Date, latDeg: number, lonDeg: number): SunAngles {
  const julian = date.getTime() / 86400000 + 2440587.5;
  const n = julian - 2451545.0;

  const meanLong = (280.46 + 0.9856474 * n) % 360;
  const meanAnom = (357.528 + 0.9856003 * n) % 360;
  const eclipticLong =
    meanLong + 1.915 * Math.sin(meanAnom * DEG) + 0.02 * Math.sin(2 * meanAnom * DEG);
  const obliquity = 23.439 - 0.0000004 * n;

  const ra = Math.atan2(
    Math.cos(obliquity * DEG) * Math.sin(eclipticLong * DEG),
    Math.cos(eclipticLong * DEG),
  );
  const dec = Math.asin(Math.sin(obliquity * DEG) * Math.sin(eclipticLong * DEG));

  // Greenwich mean sidereal time → local hour angle.
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = ((gmst * 15 + lonDeg) % 360) * DEG;
  const hourAngle = lst - ra;

  const lat = latDeg * DEG;
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle),
  );
  // Azimuth measured clockwise from north.
  const azimuth = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle),
  );

  return { altitude, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

/**
 * Sun angles → world direction *towards* the sun.
 *
 * World frame is `src/core/geo.ts`'s: x east, y up, z south. North is therefore
 * -z, so a bearing θ clockwise from north is (sin θ, ·, -cos θ). Getting this
 * sign wrong puts the morning sun in the west and every shadow in the scene
 * points the wrong way — subtle enough to survive a screenshot and obvious to
 * anyone who has stood in that forest.
 */
export function sunDirection(a: SunAngles, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(a.altitude);
  return out.set(Math.sin(a.azimuth) * c, Math.sin(a.altitude), -Math.cos(a.azimuth) * c);
}

/** 10:00 local on the first Vyšší Brod forest race day. Forest races start at 10. */
export const RACE_MORNING = new Date('2026-08-05T08:00:00Z'); // 10:00 CEST

// ---------------------------------------------------------------------------
// Sky + lighting rig
// ---------------------------------------------------------------------------

export interface SkyRigOptions {
  weather: Weather;
  tier: QualityTier;
  latDeg: number;
  lonDeg: number;
  date?: Date;
  /** Half-extent of the shadow-casting region around the camera, metres. */
  shadowRadius?: number;
}

/**
 * Sky dome, sun, and the lights.
 *
 * Shadow strategy is deliberately *not* cascaded. Fog closes the useful view at
 * ~120 m, so one tight orthographic frustum of ±110 m over a 4096 map is 5 cm
 * per texel — better than any three-cascade split would give at the same cost,
 * and without CSM's material patching, which would collide with the terrain
 * material's own `onBeforeCompile`.
 *
 * The frustum is snapped to whole texels as it follows the camera. Without that
 * the shadow edges crawl and shimmer whenever the player moves, which is far
 * more distracting than a slightly coarser map.
 */
export class SkyRig {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly sunDir = new THREE.Vector3();
  readonly angles: SunAngles;

  private readonly sky: Sky;
  private readonly shadowRadius: number;
  private readonly texelSnap: number;
  private weather: Weather;
  private lastTarget = new THREE.Vector3(Infinity, Infinity, Infinity);

  constructor(opts: SkyRigOptions) {
    this.weather = opts.weather;
    this.shadowRadius = opts.shadowRadius ?? 110;

    this.angles = sunAngles(opts.date ?? RACE_MORNING, opts.latDeg, opts.lonDeg);
    sunDirection(this.angles, this.sunDir);

    // --- sky dome ---------------------------------------------------------
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sky.name = 'sky';
    const u = this.sky.material.uniforms;
    u.sunPosition!.value.copy(this.sunDir);
    if (opts.weather === 'sunny') {
      u.turbidity!.value = 3.2;
      u.rayleigh!.value = 1.35;
      u.mieCoefficient!.value = 0.006;
      u.mieDirectionalG!.value = 0.82;
    } else {
      // Overcast: kill the Mie forward lobe and flatten Rayleigh so the dome
      // goes to an even, slightly warm white rather than a blue gradient.
      u.turbidity!.value = 12;
      u.rayleigh!.value = 0.35;
      u.mieCoefficient!.value = 0.03;
      u.mieDirectionalG!.value = 0.2;
    }
    this.group.add(this.sky);

    // --- lights -----------------------------------------------------------
    // 2048 over a ±80 m frustum is 7.8 cm per texel, which is finer than the
    // shadow of a 30 cm trunk needs. 4096 doubled the shadow-pass fill cost for
    // detail the fog eats: contrast is gone by 100 m, so a bigger frustum has
    // nothing to resolve.
    const shadowMapSize = opts.tier === 'high' ? 2048 : opts.tier === 'medium' ? 1536 : 1024;
    this.texelSnap = (2 * this.shadowRadius) / shadowMapSize;

    // Sunny key. Measured against the ground rather than guessed: at exposure
    // 0.85 through AgX, a lit moss floor clips above about 2.6, and the
    // reference's sunlit patches are bright but never blown. 2.1 puts the sun
    // patches just under the shoulder and leaves headroom for the god rays,
    // which add on top in linear light.
    this.sun = new THREE.DirectionalLight(0xffeed2, opts.weather === 'sunny' ? 5.6 : 0.3);
    this.sun.position.copy(this.sunDir).multiplyScalar(400);
    this.sun.castShadow = opts.weather === 'sunny';
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -this.shadowRadius;
    cam.right = this.shadowRadius;
    cam.top = this.shadowRadius;
    cam.bottom = -this.shadowRadius;
    cam.near = 1;
    cam.far = 900;
    // normalBias beats a constant bias on a heightfield: a flat bias big
    // enough to kill acne on a 35 degree slope detaches every trunk from its
    // own shadow on the flat.
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.blurSamples = opts.tier === 'high' ? 12 : 8;
    this.sun.shadow.radius = opts.tier === 'low' ? 1 : 2.5;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    // Hemisphere carries the fill. RESEARCH-VIDEO §5.2 is specific that the
    // ground colour must be the warm brown of the litter, not green — the
    // bounce colour is what sells a forest floor.
    // Under a closed spruce canopy the sun reaches almost nothing, so the
    // shaded floor is *entirely* this light. Too weak and the forest reads as
    // a black hole with a bright hole in the roof; the reference floor is
    // clearly legible moss. The blue is deliberately restrained — a strong
    // blue skylight turns granite the colour of a swimming pool.
    this.hemi = new THREE.HemisphereLight(
      opts.weather === 'sunny' ? 0xa7bcd2 : 0xedeae4,
      0x4a4130,
      opts.weather === 'sunny' ? 3.6 : 2.2,
    );
    this.group.add(this.hemi);

    // A whisper of ambient so the deepest canopy shadow keeps some colour
    // instead of clipping to black under AgX's very soft toe.
    this.ambient = new THREE.AmbientLight(0x38412c, opts.weather === 'sunny' ? 1.1 : 0.5);
    this.group.add(this.ambient);
  }

  get isSunny(): boolean {
    return this.weather === 'sunny';
  }

  /**
   * Keep the shadow frustum around the camera. Returns true when it moved far
   * enough to need a shadow-map refresh.
   */
  update(camera: THREE.PerspectiveCamera): boolean {
    // Centre the frustum a little ahead of the camera — half the shadow budget
    // is wasted behind the viewer otherwise.
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const target = new THREE.Vector3()
      .copy(camera.position)
      .addScaledVector(forward, this.shadowRadius * 0.45);

    // Snap to whole shadow texels so the edges do not crawl.
    const s = this.texelSnap;
    target.x = Math.round(target.x / s) * s;
    target.z = Math.round(target.z / s) * s;
    target.y = Math.round(target.y / s) * s;

    if (target.distanceToSquared(this.lastTarget) < s * s * 0.25) return false;
    this.lastTarget.copy(target);

    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(target).addScaledVector(this.sunDir, 400);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sky.position.set(camera.position.x, 0, camera.position.z);
    return true;
  }

  dispose(): void {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// God rays
// ---------------------------------------------------------------------------

const GODRAY_MASK_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
varying vec2 vUv;

void main() {
  float d = texture2D( tDepth, vUv ).x;
  vec3 c = texture2D( tScene, vUv ).rgb;

  // Only unoccluded sky contributes. Everything the canopy blocks is the
  // occluder, which is precisely what makes the shafts show the gaps.
  float sky = step( 0.99999, d );
  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

  // Fall off hard with distance from the sun. At 1.6 the whole visible sky
  // seeded the blur and the result was a white cone across half the frame —
  // the shafts have to come from *near* the sun or they are just a smear.
  vec2 delta = ( vUv - uSun ) * vec2( uAspect, 1.0 );
  float fall = exp( -dot( delta, delta ) * 5.5 );

  // Only genuinely bright sky contributes; the pale fog at the horizon is not
  // a light source.
  gl_FragColor = vec4( c * sky * smoothstep( 0.9, 2.4, lum ) * fall, 1.0 );
}
`;

const GODRAY_BLUR_FRAG = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uSun;
uniform float uDensity;
uniform float uDecay;
uniform float uGain;
varying vec2 vUv;

#define SAMPLES 16

void main() {
  vec2 delta = ( vUv - uSun ) * ( uDensity / float( SAMPLES ) );
  vec2 uv = vUv;
  float weight = 1.0;
  vec3 acc = vec3( 0.0 );

  for ( int i = 0; i < SAMPLES; i++ ) {
    uv -= delta;
    acc += texture2D( tMask, uv ).rgb * weight;
    weight *= uDecay;
  }
  gl_FragColor = vec4( acc * ( uGain / float( SAMPLES ) ), 1.0 );
}
`;

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/**
 * Screen-space volumetric shafts.
 *
 * A true volumetric march through the canopy is not affordable at 60 fps on an
 * iGPU, and it is not necessary: the shafts in the reference are a radial
 * scatter of sky luminance around the sun, occluded by the trunks and crowns.
 * That is exactly what a radial blur of an occlusion mask computes — and it
 * gets the *shape* right, which is what the eye reads. It also degrades
 * gracefully: when the sun is behind the camera the whole pass switches off.
 *
 * Two things stop it looking like a cheap filter:
 *  1. The mask is built from the *depth buffer*, so only genuinely unoccluded
 *     sky seeds a shaft. Canopy gaps produce shafts; solid crown does not.
 *  2. It runs at quarter resolution and is added in linear light before tone
 *     mapping, so AgX rolls the shaft highlights off the same way it rolls off
 *     everything else instead of leaving a bright screen-space decal.
 */
export class GodRays implements PostEffect {
  private readonly maskRt: THREE.WebGLRenderTarget;
  private readonly blurRt: THREE.WebGLRenderTarget;
  private readonly maskMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;

  private readonly sunWorld = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly div: number;
  private enabled = true;

  strength: number;
  lastFade = 0;

  constructor(sunDir: THREE.Vector3, opts: { scale?: number; strength?: number } = {}) {
    this.sunWorld.copy(sunDir).multiplyScalar(6000);
    this.div = opts.scale ?? 4;

    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace };
    this.maskRt = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurRt = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    this.maskMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uSun: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GODRAY_MASK_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tMask: { value: null },
        uSun: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: 0.42 },
        uDecay: { value: 0.955 },
        uGain: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: GODRAY_BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maskMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.strength = opts.strength ?? 1;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / this.div));
    const h = Math.max(1, Math.round(height / this.div));
    this.maskRt.setSize(w, h);
    this.blurRt.setSize(w, h);
    this.maskMat.uniforms.uAspect!.value = width / height;
  }

  evaluate(
    renderer: THREE.WebGLRenderer,
    colour: THREE.Texture,
    depth: THREE.DepthTexture,
    camera: THREE.PerspectiveCamera,
  ): THREE.Texture | null {
    if (!this.enabled) return null;

    // Sun position in NDC. Behind the camera means no shafts, full stop —
    // projecting it anyway mirrors the sun onto the wrong side of the screen
    // and produces shafts converging on nothing.
    this.projected.copy(camera.position).add(this.sunWorld).project(camera);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const facing = forward.dot(this.sunWorld.clone().normalize());
    if (facing <= 0.05) return null;

    const su = this.projected.x * 0.5 + 0.5;
    const sv = this.projected.y * 0.5 + 0.5;

    // Fade out as the sun leaves the frame, otherwise the shafts pop off.
    const edge = Math.max(Math.abs(su - 0.5), Math.abs(sv - 0.5));
    const fade = THREE.MathUtils.clamp(1.6 - edge * 1.6, 0, 1) * THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
    if (fade <= 0.001) return null;

    (this.maskMat.uniforms.uSun!.value as THREE.Vector2).set(su, sv);
    (this.blurMat.uniforms.uSun!.value as THREE.Vector2).set(su, sv);
    // Gain is applied inside the blur, not in the composite, so the strength
    // and the screen-edge fade are baked into the texture the compositor adds.
    this.blurMat.uniforms.uGain!.value = 1;
    this.maskMat.uniforms.tScene!.value = colour;
    this.maskMat.uniforms.tDepth!.value = depth;

    const prevTarget = renderer.getRenderTarget();

    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.maskRt);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCam);

    this.blurMat.uniforms.tMask!.value = this.maskRt.texture;
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurRt);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCam);

    // Second pass at a longer stride: 16 taps alone leave visible banding in
    // the shaft, and a second sweep over the first is far cheaper than 32.
    this.blurMat.uniforms.tMask!.value = this.blurRt.texture;
    this.blurMat.uniforms.uDensity!.value = 0.22;
    this.blurMat.uniforms.uGain!.value = this.strength * fade;
    renderer.setRenderTarget(this.maskRt);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCam);
    this.blurMat.uniforms.uDensity!.value = 0.42;

    renderer.setRenderTarget(prevTarget);
    this.lastFade = fade;
    return this.maskRt.texture;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  dispose(): void {
    this.maskRt.dispose();
    this.blurRt.dispose();
    this.maskMat.dispose();
    this.blurMat.dispose();
    this.quad.geometry.dispose();
  }
}
