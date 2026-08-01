/**
 * Platform capability probe. Runs once at boot, before anything heavy loads,
 * and decides the quality tier.
 *
 * The tier is not a user setting (though settings can override it) — it is the
 * thing that lets us hold 60 fps on a 2021 laptop iGPU and ≥30 fps on a
 * mid-range Android phone from the same build. See docs/DECISIONS.md.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface Capabilities {
  webgl2: boolean;
  webgpu: boolean;
  touch: boolean;
  /** Device pixel ratio, clamped — rendering at native DPR on a phone is a trap. */
  dpr: number;
  hardwareConcurrency: number;
  /** navigator.deviceMemory in GB where available, else null. */
  deviceMemoryGb: number | null;
  tier: QualityTier;
  /** Renderer string from WEBGL_debug_renderer_info, when exposed. */
  renderer: string | null;
  prefersReducedMotion: boolean;
}

function probeGl(): { webgl2: boolean; renderer: string | null } {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return { webgl2: false, renderer: null };
  let renderer: string | null = null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (ext) {
    const v = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    renderer = typeof v === 'string' ? v : null;
  }
  // Release the context immediately — some drivers cap the number of live ones.
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { webgl2: true, renderer };
}

function pickTier(o: {
  touch: boolean;
  cores: number;
  memGb: number | null;
  renderer: string | null;
}): QualityTier {
  const r = (o.renderer ?? '').toLowerCase();

  // Known-weak mobile GPUs: start low and let the adaptive scaler climb.
  if (/mali-g5|mali-g3|adreno \(tm\) 6[0-3]|powervr/.test(r)) return 'low';

  if (o.touch) {
    // Phones: memory is the better signal than core count, which lies on big.LITTLE.
    if (o.memGb !== null && o.memGb <= 4) return 'low';
    return 'medium';
  }

  if (o.cores <= 4) return 'medium';
  // Integrated Intel/AMD laptop graphics: medium is the honest default.
  if (/intel|uhd graphics|iris/.test(r)) return 'medium';
  return 'high';
}

export function detectCapabilities(): Capabilities {
  const { webgl2, renderer } = probeGl();
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const cores = navigator.hardwareConcurrency || 4;
  const memGb =
    'deviceMemory' in navigator ? ((navigator as { deviceMemory?: number }).deviceMemory ?? null) : null;

  return {
    webgl2,
    webgpu: 'gpu' in navigator,
    touch,
    // 2.0 is the ceiling worth paying for; beyond that it is pure fill cost.
    dpr: Math.min(window.devicePixelRatio || 1, touch ? 2 : 2),
    hardwareConcurrency: cores,
    deviceMemoryGb: memGb,
    renderer,
    tier: pickTier({ touch, cores, memGb, renderer }),
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}
