/**
 * The Český Krumlov sprint screen.
 *
 * Structurally identical to `forestScreen.ts` — a `Screen`, so it goes through
 * `transitionTo` and cross-fades rather than cutting — with the venue's own
 * loading label, hint line and attribution.
 *
 * The attribution line is not decoration: the footprints are OpenStreetMap
 * under ODbL 1.0, which requires it wherever the derived work is shown, and the
 * elevations are ČÚZK under CC BY 4.0, which requires it too. See
 * docs/DATA_LICENCES.md.
 */

import type { Screen } from '@/ui/shell';
import { getCapabilities } from '@/ui/shell';
import type { SprintScene } from '@/world/sprintScene';

export interface SprintScreenOptions {
  bench: boolean;
  weather: 'sunny' | 'overcast';
  debug: boolean;
}

export function makeSprintScreen(opts: SprintScreenOptions): Screen {
  let scene: SprintScene | null = null;
  let onResize: (() => void) | null = null;
  let overlayTimer = 0;

  return {
    id: 'sprint',

    async mount(host: HTMLElement): Promise<void> {
      host.innerHTML = `
        <div class="world">
          <canvas class="world__canvas"></canvas>
          <div class="world__loading" data-role="loading">
            <p class="world__loadingLabel">Český Krumlov</p>
            <div class="world__bar"><i data-role="bar"></i></div>
            <p class="world__loadingStep" data-role="step">terrain</p>
          </div>
          ${opts.debug ? '<pre class="world__debug" data-role="debug"></pre>' : ''}
          ${
            opts.bench
              ? ''
              : '<p class="world__hint">WASD move · mouse look (click to capture) · Q/E turn · R/F pitch · Shift sprint · N noclip</p>' +
                '<p class="world__credit">Budovy © přispěvatelé OpenStreetMap (ODbL) · výšky © ČÚZK (CC BY 4.0)</p>'
          }
        </div>`;

      const canvas = host.querySelector<HTMLCanvasElement>('.world__canvas');
      const loading = host.querySelector<HTMLElement>('[data-role="loading"]');
      const bar = host.querySelector<HTMLElement>('[data-role="bar"]');
      const step = host.querySelector<HTMLElement>('[data-role="step"]');
      const debug = host.querySelector<HTMLElement>('[data-role="debug"]');
      if (!canvas) throw new Error('sprint canvas missing');

      const caps = getCapabilities();
      const { createSprintScene } = await import('@/world/sprintScene');

      try {
        scene = await createSprintScene({
          canvas,
          caps,
          weather: opts.weather,
          bench: opts.bench,
          onProgress: (f, label) => {
            if (bar) bar.style.width = `${Math.round(f * 100)}%`;
            if (step) step.textContent = label;
          },
        });
      } catch (err) {
        if (step) step.textContent = `failed: ${String(err)}`;
        console.error('[sprint]', err);
        throw err;
      }

      const size = () => {
        const w = host.clientWidth || window.innerWidth;
        const h = host.clientHeight || window.innerHeight;
        scene?.resize(w, h);
      };
      size();
      onResize = size;
      window.addEventListener('resize', onResize);

      scene.attachInput(canvas);
      scene.start();

      loading?.classList.add('is-done');

      if (debug && scene) {
        const s = scene;
        overlayTimer = window.setInterval(() => {
          const stats = s.debugStats();
          const lines = Object.entries(stats).map(([k, v]) => `${k.padEnd(14)} ${String(v)}`);
          if (s.warnings.length) lines.push('', ...s.warnings.map((w) => `! ${w}`));
          debug.textContent = lines.join('\n');
        }, 250);
      }
    },

    unmount(): void {
      if (overlayTimer) window.clearInterval(overlayTimer);
      if (onResize) window.removeEventListener('resize', onResize);
      scene?.dispose();
      scene = null;
    },
  };
}
