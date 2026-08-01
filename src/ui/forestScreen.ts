/**
 * The 3D forest screen.
 *
 * A `Screen` like any other, so it goes through `transitionTo` and cross-fades
 * rather than cutting. It owns the canvas, the loading state and the debug
 * overlay; everything below the canvas lives in `src/world/`.
 *
 * With a `race` in the options it also hosts an actual competition: the scene
 * becomes a puppet of `Race`, and `RaceController` mounts the HUD, the map and
 * the touch controls over the canvas. Without one it is still the free-run
 * sandbox the perf gate drives at `?scene=forest&bench=1`, unchanged.
 */

import type { Screen } from '@/ui/shell';
import { getCapabilities, transitionTo } from '@/ui/shell';
import type { ForestScene } from '@/world/scene';
import type { RaceController } from '@/race/controller';
import type { ScreenRaceSetup } from './beforeScreen';
import { getSettings } from '@/core/settings';
import { getVenue } from '@/core/venues';
import { t } from '@/i18n';

export interface ForestScreenOptions {
  bench: boolean;
  weather: 'sunny' | 'overcast';
  debug: boolean;
  race?: ScreenRaceSetup;
}

export function makeForestScreen(opts: ForestScreenOptions): Screen {
  let scene: ForestScene | null = null;
  let race: RaceController | null = null;
  let onResize: (() => void) | null = null;
  let overlayTimer = 0;

  return {
    id: 'forest',

    async mount(host: HTMLElement): Promise<void> {
      const settings = getSettings();
      host.innerHTML = `
        <div class="world">
          <canvas class="world__canvas"></canvas>
          <div class="world__loading" data-role="loading">
            <p class="world__loadingLabel">Vyšší Brod</p>
            <div class="world__bar"><i data-role="bar"></i></div>
            <p class="world__loadingStep" data-role="step">terrain</p>
          </div>
          ${opts.debug ? '<pre class="world__debug" data-role="debug"></pre>' : ''}
          ${
            opts.bench || opts.race
              ? ''
              : `<p class="world__hint">${escapeHtml(t('hint.freeRun'))}</p>`
          }
        </div>`;

      const canvas = host.querySelector<HTMLCanvasElement>('.world__canvas');
      const loading = host.querySelector<HTMLElement>('[data-role="loading"]');
      const bar = host.querySelector<HTMLElement>('[data-role="bar"]');
      const step = host.querySelector<HTMLElement>('[data-role="step"]');
      const debug = host.querySelector<HTMLElement>('[data-role="debug"]');
      if (!canvas) throw new Error('forest canvas missing');

      const caps = getCapabilities();
      const { createForestScene } = await import('@/world/scene');

      try {
        scene = await createForestScene({
          canvas,
          caps,
          venue: 'martinkov',
          weather: opts.weather,
          bench: opts.bench,
          viewmodel: opts.bench || settings.showHands,
          onProgress: (f, label) => {
            if (bar) bar.style.width = `${Math.round(f * 100)}%`;
            if (step) step.textContent = label;
          },
        });
      } catch (err) {
        if (step) step.textContent = `failed: ${String(err)}`;
        console.error('[forest]', err);
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

      if (opts.race) {
        if (step) step.textContent = 'course';
        const { RaceController } = await import('@/race/controller');
        const setup = opts.race;
        race = new RaceController(
          scene,
          {
            anchor: getVenue('martinkov'),
            discipline: setup.request.discipline,
            seed: setup.request.seed,
            heat: setup.request.heat,
            preRace: setup.preRace,
            belt: setup.belt,
            startStats: setup.startStats,
            environment: 'forest',
            touch: caps.touch,
            onFinish: (result, course) => {
              void (async () => {
                const { makeResultsScreen } = await import('./resultsScreen');
                await transitionTo(makeResultsScreen(result, course, setup.request));
              })();
            },
            onQuit: () => {
              void (async () => {
                const { makeMenuScreen } = await import('./menuScreen');
                await transitionTo(makeMenuScreen());
              })();
            },
          },
          canvas,
        );
        host.querySelector('.world')?.appendChild(race.root);
      } else {
        scene.attachInput(canvas);
      }

      scene.start();
      loading?.classList.add('is-done');

      if (debug && scene) {
        const s = scene;
        overlayTimer = window.setInterval(() => {
          const stats = s.debugStats();
          const lines = Object.entries(stats).map(
            ([k, v]) => `${k.padEnd(14)} ${String(v)}`,
          );
          if (s.warnings.length) lines.push('', ...s.warnings.map((w) => `! ${w}`));
          debug.textContent = lines.join('\n');
        }, 250);
      }
    },

    unmount(): void {
      if (overlayTimer) window.clearInterval(overlayTimer);
      if (onResize) window.removeEventListener('resize', onResize);
      race?.dispose();
      race = null;
      scene?.dispose();
      scene = null;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
