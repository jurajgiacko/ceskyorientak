/**
 * The Český Krumlov sprint screen.
 *
 * Structurally identical to `forestScreen.ts` — a `Screen`, so it goes through
 * `transitionTo` and cross-fades rather than cutting — with the venue's own
 * loading label, hint line and attribution, and with `blockedAt` handed to the
 * race so the walls, railings and the Vltava are out of bounds in the
 * simulation exactly as they are in the geometry. In a sprint that is IOF Rule
 * 17.2, not physics.
 *
 * The attribution line is not decoration: the footprints are OpenStreetMap
 * under ODbL 1.0, which requires it wherever the derived work is shown, and the
 * elevations are ČÚZK under CC BY 4.0, which requires it too. See
 * docs/DATA_LICENCES.md.
 */

import type { Screen } from '@/ui/shell';
import { getCapabilities, transitionTo } from '@/ui/shell';
import type { SprintScene } from '@/world/sprintScene';
import type { RaceController } from '@/race/controller';
import type { ScreenRaceSetup } from './beforeScreen';
import { getVenue } from '@/core/venues';
import { t } from '@/i18n';

export interface SprintScreenOptions {
  bench: boolean;
  weather: 'sunny' | 'overcast';
  debug: boolean;
  race?: ScreenRaceSetup;
}

export function makeSprintScreen(opts: SprintScreenOptions): Screen {
  let scene: SprintScene | null = null;
  let race: RaceController | null = null;
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
            opts.bench || opts.race
              ? ''
              : `<p class="world__hint">${escapeHtml(t('hint.freeRunSprint'))}</p>`
          }
          ${
            opts.bench
              ? ''
              : '<p class="world__credit">Budovy © přispěvatelé OpenStreetMap (ODbL) · výšky © ČÚZK (CC BY 4.0)</p>'
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

      if (opts.race) {
        if (step) step.textContent = 'course';
        const { RaceController } = await import('@/race/controller');
        const setup = opts.race;
        const s = scene;
        // The town, for the course setter.
        //
        // Fetched again rather than read off the scene, which keeps `src/world`
        // ignorant of what a control is — and it costs nothing, because the
        // scene has already loaded this exact URL and the browser serves it
        // from cache. A course that cannot read the townscape is still a
        // course; it just falls back to scoring sites off the raster, so this
        // is warned about rather than thrown.
        const { loadTownscape } = await import('@/world/buildings');
        let townscape;
        try {
          townscape = await loadTownscape('krumlov');
        } catch (err) {
          console.warn('[sprint] townscape unavailable — siting controls off the raster', err);
        }
        race = new RaceController(
          s,
          {
            anchor: getVenue('krumlov'),
            discipline: setup.request.discipline,
            seed: setup.request.seed,
            heat: setup.request.heat,
            preRace: setup.preRace,
            belt: setup.belt,
            startStats: setup.startStats,
            environment: 'town',
            touch: caps.touch,
            ...(townscape ? { townscape } : {}),
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
          const lines = Object.entries(stats).map(([k, v]) => `${k.padEnd(14)} ${String(v)}`);
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
