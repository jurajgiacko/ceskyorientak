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
 */

import type { Screen } from './shell';
import { transitionTo } from './shell';
import { t, getLocale, setLocale } from '@/i18n';
import { LOCALES } from '@/core/types';
import type { Locale } from '@/core/types';
import { getSettings, setSetting } from '@/core/settings';
import { courseSeed } from '@/core/venues';

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
  {
    id: 'sprint',
    labelKey: 'menu.sprint',
    sublabelKey: 'menu.sprintSub',
    go: async () => {
      const { makeBeforeScreen } = await import('@/ui/beforeScreen');
      await transitionTo(
        makeBeforeScreen({
          venue: 'krumlov',
          discipline: 'sprint',
          seed: courseSeed('krumlov'),
          heat: 0.45,
          startInMin: 45,
        }),
      );
    },
  },
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
               alt="Orienteering World Cup 2026" width="500" height="73" />
        </header>

        <div class="menu__body">
          <h1 class="menu__title">${t('app.title')}</h1>
          <p class="menu__meta">Vyšší Brod &middot; Český Krumlov &middot; 5–9. 8. 2026</p>

          <nav class="menu__nav">
            ${ENTRIES.map(
              (e, i) => `
              <button class="menu__item${e.soon ? ' is-soon' : ''}"
                      data-go="${e.id}" ${e.soon ? 'disabled' : ''}
                      style="--i:${i}">
                <span class="menu__itemLabel">${t(e.labelKey)}</span>
                <span class="menu__itemSub">${
                  e.soon ? t('menu.soon') : t(e.sublabelKey)
                }</span>
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
                  title="${t('settings.beginnerAidHelp')}">
            ${t('settings.beginnerAid')}
            <span class="menu__toggleState" data-role="state">${
              getSettings().beginnerAid ? t('settings.on') : t('settings.off')
            }</span>
          </button>
          <div class="menu__locales" role="group" aria-label="${t('menu.language')}">
            ${LOCALES.map(
              (l) =>
                `<button class="menu__locale${l === getLocale() ? ' is-on' : ''}"
                         data-locale="${l}">${l.toUpperCase()}</button>`,
            ).join('')}
          </div>
        </footer>

        <div class="menu__partners">
          <span class="menu__partnerLabel">${t('brand.mainPartner')}</span>
          <img src="/brand/enervit.png" alt="Enervit" class="menu__enervit" />
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
