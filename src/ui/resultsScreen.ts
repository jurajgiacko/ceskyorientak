/**
 * The results screen: splits, total, and the disqualification when there is
 * one.
 *
 * A mispunch is shown as what it is — **DSQ**, not a time penalty. That is the
 * rule (IOF 21.2) and softening it would make control order meaningless, which
 * is the one thing this game is about. The elapsed time is still printed,
 * because a runner still wants to know, but it is struck through and it never
 * becomes a personal best (`LocalStore.submitRun` already sorts valid runs
 * first).
 */

import type { Screen } from './shell';
import { transitionTo } from './shell';
import { formatRaceTime, formatDistance, t } from '@/i18n';
import type { Course, RunResult } from '@/core/types';
import { LocalStore } from '@/store/LocalStore';
import { makeBeforeScreen } from './beforeScreen';
import type { RaceRequest } from './beforeScreen';

export function makeResultsScreen(
  result: RunResult,
  course: Course,
  request: RaceRequest,
): Screen {
  let cleanup: (() => void) | null = null;

  return {
    id: 'results',

    async mount(host) {
      const el = document.createElement('div');
      el.className = 'results';
      host.appendChild(el);

      const store = new LocalStore();
      await store.submitRun(result);
      const board = await store.getLeaderboard(course.id, 5);
      const best = board.find((b) => b.valid);

      const rows = result.splits
        .map((s, i) => {
          const c = course.controls[i];
          return `<tr>
            <td class="results__no">${i + 1}</td>
            <td class="results__code">${c ? c.code : '—'}</td>
            <td class="results__leg">${formatRaceTime(s.legS)}</td>
            <td class="results__elapsed">${formatRaceTime(s.elapsedS)}</td>
          </tr>`;
        })
        .join('');

      const dsq = !result.valid;
      const missed = result.mispunch
        ? course.controls.findIndex((c) => c.id === result.mispunch?.expected) + 1
        : 0;

      el.innerHTML = `
        <div class="results__card" data-dsq="${dsq ? '1' : '0'}">
          <p class="results__kicker">${esc(t(`discipline.${course.discipline}`))} · ${esc(
            t(`venue.${course.venue}`),
          )}</p>
          <h1 class="results__title">${esc(dsq ? t('race.disqualified') : t('results.title'))}</h1>
          <p class="results__time">${formatRaceTime(result.timeS)}</p>
          ${
            dsq
              ? `<p class="results__dsq">${esc(
                  t('results.mispunchAt', { n: missed > 0 ? missed : 1 }),
                )}</p>`
              : ''
          }
          <p class="results__meta">${esc(formatDistance(course.lengthM))} · ${
            course.climbM
          } m · ${course.controls.length} ${esc(t('race.controls').toLocaleLowerCase())}</p>

          <table class="results__splits">
            <thead>
              <tr>
                <th>${esc(t('race.control'))}</th>
                <th>${esc(t('race.punch'))}</th>
                <th>${esc(t('race.leg'))}</th>
                <th>${esc(t('race.time'))}</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="4">—</td></tr>`}</tbody>
          </table>

          ${
            best
              ? `<p class="results__pb">${esc(t('results.personalBest'))}: ${formatRaceTime(
                  best.timeS,
                )}</p>`
              : ''
          }

          <div class="results__actions">
            <button data-act="retry">${esc(t('results.retry'))}</button>
            <button data-act="menu">${esc(t('results.continue'))}</button>
          </div>
        </div>`;

      const onClick = (ev: Event) => {
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'retry') {
          // A new seed, or the retry is the same course twice — which teaches
          // memorisation rather than navigation.
          void transitionTo(
            makeBeforeScreen({ ...request, seed: (request.seed + 1) | 0 }),
          );
        } else {
          void (async () => {
            const { makeMenuScreen } = await import('./menuScreen');
            await transitionTo(makeMenuScreen());
          })();
        }
      };
      el.addEventListener('click', onClick);
      cleanup = () => el.removeEventListener('click', onClick);
    },

    unmount() {
      cleanup?.();
      cleanup = null;
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
