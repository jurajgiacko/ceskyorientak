/**
 * The main menu.
 *
 * Replaces the placeholder boot screen that sat on "LOADING…" forever because
 * there was nothing to transition to.
 *
 * Design constraints, from the brief and from who actually plays this:
 *  - The player is a spectator standing in an arena on a phone, in sunlight,
 *    with about sixty seconds of patience. One obvious primary action.
 *  - No abrupt cuts — everything routes through `transitionTo`.
 *  - Partner marks sit in their own beige band and never share a surface with
 *    the event orange (see the colour-conflict note in styles/base.css).
 *  - That band now carries the full ČESKÝ ORIENŤÁK × ENERVIT lockup rather than
 *    a lone Enervit mark. Both sides are supplied files; see src/ui/lockup.ts
 *    for why neither is typeset and how the two are balanced.
 */

import type { Screen } from './shell';
import { transitionTo } from './shell';
import { t, getLocale, setLocale } from '@/i18n';
import { LOCALES } from '@/core/types';
import type { Locale } from '@/core/types';
import { getSettings, setSetting } from '@/core/settings';
import { courseSeed } from '@/core/venues';
import { partnerLockup } from '@/ui/lockup';

/*
 * On seeds.
 *
 * This file used to hold `seedNow()`, returning `(Date.now() / 60000) | 0` — a
 * new course every minute. The client's report on it is the shortest statement
 * of what was wrong: *"the city still starts at random places — it doesn't hold
 * to one race map"*. A venue has one course. You learn it, and the second run
 * is a comparison.
 *
 * Both entries below now take that venue's fixed seed from `COURSE_SEED` in
 * src/core/venues.ts, which is where the choice is documented and where the
 * tool that made it can be re-run. The rotating seed belongs to the daily
 * challenge, three entries down, seeded by the date; it is still "coming soon"
 * and building it is not this change.
 */

interface MenuEntry {
  id: string;
  labelKey: string;
  sublabelKey: string;
  /** Not yet built — shown, but marked, rather than hidden. */
  soon?: boolean;
  go?: () => Promise<void> | void;
}

const ENTRIES: MenuEntry[] = [
  {
    id: 'forest',
    labelKey: 'menu.forestRun',
    sublabelKey: 'menu.forestRunSub',
    go: async () => {
      const { makeBeforeScreen } = await import('@/ui/beforeScreen');
      await transitionTo(
        makeBeforeScreen({
          venue: 'martinkov',
          discipline: 'middle',
          seed: courseSeed('martinkov'),
          // An August morning in the Vltava valley. Warm, not brutal.
          heat: 0.4,
          startInMin: 60,
        }),
      );
    },
  },
  /**
   * Krumlov is **withheld from the menu on purpose**, not unfinished by accident.
   *
   * The client, after the course itself was finally sane: *"the town is
   * completely bewitched — you run out and there's a wall straight away, you
   * can't get anywhere. Look, the forest you've built superbly, we don't want
   * to wreck it."* His call, and the right one: ship the venue that works, stop
   * paying for the one that does not, and rebuild it deliberately rather than
   * patching it a sixth time.
   *
   * The record of why is worth keeping, because it is a pattern and not a run
   * of bad luck. Krumlov has produced, in order: severed bridges; a 4 m raster
   * on phones against 2–3 m alleys; 13.8 km of barrier drawn with no collider;
   * a start in the river; drawn water that was never out of bounds; a barrier
   * stamp that re-closed the bridges; and a course whose second leg ran 12×
   * its straight line. Every one was real, every one was found by the client
   * rather than by a gate, and every fix exposed the next. That is what a venue
   * looks like when its *representation* is wrong rather than its details: OSM
   * outlines, a ZABAGED raster and a bare-earth heightfield, three sources that
   * disagree about where a wall is, reconciled by stamping one onto another.
   *
   * The forest has none of this, from the same pipeline — 2111 legs measured,
   * not one over 1.55× — because a forest is a cost surface and a town is a
   * set of hard edges. A rebuild is a rebuild of that model, not a re-tune.
   *
   * `?scene=sprint` still reaches it, and every gate still exercises it. This
   * hides it from the player; it does not park the work.
   */
  { id: 'sprint', labelKey: 'menu.sprint', sublabelKey: 'menu.sprintSub', soon: true },
  { id: 'career', labelKey: 'menu.career', sublabelKey: 'menu.careerSub', soon: true },
  { id: 'daily', labelKey: 'menu.daily', sublabelKey: 'menu.dailySub', soon: true },
];

export function makeMenuScreen(): Screen {
  let cleanup: (() => void) | null = null;

  return {
    id: 'menu',

    mount(host) {
      const el = document.createElement('div');
      el.className = 'menu';

      el.innerHTML = `
        <div class="menu__bg" role="presentation"></div>
        <div class="menu__scrim" role="presentation"></div>

        <header class="menu__head">
          <img class="menu__logo" src="/brand/owcup26-hor.svg"
               alt="${esc(t('brand.owcup'))}" width="500" height="73" />
        </header>

        <div class="menu__body">
          <h1 class="menu__title">${esc(t('app.title'))}</h1>
          <p class="menu__meta">${esc(t('menu.venues'))}</p>

          <nav class="menu__nav">
            ${ENTRIES.map(
              (e, i) => `
              <button class="menu__item${e.soon ? ' is-soon' : ''}"
                      data-go="${e.id}" ${e.soon ? 'disabled' : ''}
                      style="--i:${i}">
                <span class="menu__itemLabel">${esc(t(e.labelKey))}</span>
                <span class="menu__itemSub">${esc(
                  e.soon ? t('menu.soon') : t(e.sublabelKey),
                )}</span>
              </button>`,
            ).join('')}
          </nav>
        </div>

        <!--
          This is a switch, not a button, and it used to be indistinguishable
          from one: the only thing separating on from off was a lime outline
          against a grey one. Clicking "Beginner hints" once, to read them, turned
          them off — and the thing it turns off is a pale band on the ground that
          a first-time player has never seen and so cannot miss. The state is now
          written out. -->
        <footer class="menu__foot">
          <button class="menu__toggle${getSettings().beginnerAid ? ' is-on' : ''}"
                  data-toggle="beginnerAid"
                  aria-pressed="${getSettings().beginnerAid ? 'true' : 'false'}"
                  title="${esc(t('settings.beginnerAidHelp'))}">
            ${esc(t('settings.beginnerAid'))}
            <span class="menu__toggleState" data-role="state">${esc(
              getSettings().beginnerAid ? t('settings.on') : t('settings.off'),
            )}</span>
          </button>
          <div class="menu__locales" role="group" aria-label="${esc(t('menu.language'))}">

            ${LOCALES.map(
              (l) =>
                `<button class="menu__locale${l === getLocale() ? ' is-on' : ''}"
                         data-locale="${l}">${l.toUpperCase()}</button>`,
            ).join('')}
          </div>
        </footer>

        <div class="menu__partners">
          ${partnerLockup()}
        </div>`;

      host.appendChild(el);

      const onClick = (ev: Event) => {
        const target = (ev.target as HTMLElement).closest('button');
        if (!target) return;

        const locale = target.dataset.locale as Locale | undefined;
        if (locale) {
          setLocale(locale);
          // Re-render in place: cheaper and less jarring than a screen
          // transition for what is only a language change.
          void transitionTo(makeMenuScreen());
          return;
        }

        const markToggle = (el: HTMLElement, on: boolean): void => {
          el.classList.toggle('is-on', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
          const state = el.querySelector('[data-role="state"]');
          if (state) state.textContent = on ? t('settings.on') : t('settings.off');
        };

        // The beginner aid. On by default; this is how an orienteer turns the
        // training wheels off. See src/world/bearingBand.ts.
        if (target.dataset.toggle === 'beginnerAid') {
          const next = !getSettings().beginnerAid;
          setSetting('beginnerAid', next);
          markToggle(target, next);
          return;
        }

        const go = target.dataset.go;
        const entry = ENTRIES.find((e) => e.id === go);
        if (entry?.go) void entry.go();
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
