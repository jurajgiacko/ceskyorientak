/**
 * Frame-time instrumentation and the adaptive quality scaler.
 *
 * Two jobs, deliberately in one place:
 *  1. Expose a rolling frame-time record that the CI perf budget can read
 *     (`window.__perf`), so the measurement in CI is the same measurement the
 *     game uses to make decisions — not a parallel approximation.
 *  2. Nudge the quality tier at runtime when a device is missing its target.
 *
 * The target is 60 fps on desktop and ≥30 fps on mid-range mobile. We scale
 * render resolution before we drop visual features, because a slightly softer
 * image reads far better than popping foliage or a shadowless forest.
 */

import type { QualityTier } from './capabilities';

export interface PerfSample {
  /** Median frame time over the window, ms. */
  medianMs: number;
  /** 95th percentile frame time, ms. The number that actually feels bad. */
  p95Ms: number;
  fps: number;
  frames: number;
}

/**
 * Ring buffer of recent frame times.
 *
 * 240 frames (~4 s at 60 fps) was too short to be a CI gate. Headless, with
 * vsync off, the forest scene runs at ~500 fps, so 240 frames is half a second
 * of wall clock — one chunk build or one GC lands inside it and the p95 doubles.
 * The recorded baseline had to be taken as the slowest of five runs to stop the
 * 10 % regression gate flapping, which means the gate was measuring run-to-run
 * noise and not the renderer.
 *
 * 900 frames covers the whole 6 s measurement window on mobile and ~2 s of it on
 * desktop, which is long enough that a single hitch moves the p95 by a few per
 * cent rather than by a factor. The adaptive scaler is unaffected: it reads the
 * *median*, which was already stable, and it only acts once a second.
 */
const WINDOW = 900;

export class PerfMonitor {
  private times = new Float32Array(WINDOW);
  private idx = 0;
  private filled = 0;
  private last = 0;

  /** Total frames since start — used by the CI harness to know we really ran. */
  totalFrames = 0;

  /** Call once per rendered frame with the timestamp from rAF. */
  tick(now: number): void {
    if (this.last !== 0) {
      const dt = now - this.last;
      // Discard absurd deltas: tab restore, breakpoint, GC pause on load.
      // Including them would poison the median and trigger a needless downgrade.
      if (dt > 0 && dt < 500) {
        this.times[this.idx] = dt;
        this.idx = (this.idx + 1) % WINDOW;
        if (this.filled < WINDOW) this.filled++;
        this.totalFrames++;
      }
    }
    this.last = now;
  }

  sample(): PerfSample {
    const n = this.filled;
    if (n === 0) return { medianMs: 0, p95Ms: 0, fps: 0, frames: 0 };
    const arr = Array.from(this.times.subarray(0, n)).sort((a, b) => a - b);
    const median = arr[Math.floor(n * 0.5)] ?? 0;
    const p95 = arr[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    return {
      medianMs: median,
      p95Ms: p95,
      fps: median > 0 ? 1000 / median : 0,
      frames: this.totalFrames,
    };
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
    this.last = 0;
  }
}

/**
 * Adaptive resolution scaler. Holds a render-scale multiplier that the renderer
 * multiplies into its drawing buffer size.
 *
 * Hysteresis is asymmetric on purpose: drop fast (the player is suffering now),
 * recover slowly (oscillating resolution is more distracting than a slightly
 * soft frame).
 */
export class AdaptiveQuality {
  scale = 1;
  private cooldown = 0;

  constructor(
    private readonly targetMs: number,
    private readonly min = 0.6,
  ) {}

  static forTier(tier: QualityTier, touch: boolean): AdaptiveQuality {
    // Mobile targets 30 fps (33.3 ms), desktop 60 fps (16.7 ms), with a little
    // headroom so we are not downgrading on every stray frame.
    const target = touch ? 30 : 18;
    const floor = tier === 'low' ? 0.5 : 0.6;
    return new AdaptiveQuality(target, floor);
  }

  /** Call about once a second with a fresh sample. Returns true if scale changed. */
  update(s: PerfSample, dtS: number): boolean {
    if (s.frames < 30) return false;
    if (this.cooldown > 0) {
      this.cooldown -= dtS;
      return false;
    }

    const before = this.scale;
    if (s.medianMs > this.targetMs * 1.15) {
      this.scale = Math.max(this.min, this.scale - 0.1);
      this.cooldown = 1.5;
    } else if (s.medianMs < this.targetMs * 0.75 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.cooldown = 4;
    }
    return this.scale !== before;
  }
}

/**
 * Publish the monitor on `window` so the headless CI harness can read real
 * numbers out of a real run. Guarded so it costs nothing if unused.
 */
export function exposeForHarness(monitor: PerfMonitor): void {
  (window as unknown as Record<string, unknown>).__perf = {
    sample: () => monitor.sample(),
    reset: () => monitor.reset(),
  };
}
