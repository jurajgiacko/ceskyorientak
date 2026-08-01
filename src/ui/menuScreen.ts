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
      const { makeForestScreen } = await import('@/ui/forestScreen');
      await transitionTo(makeForestScreen({ bench: false, weather: 'sunny', debug: false }));
    },
  },
  {
    id: 'sprint',
    labelKey: 'menu.sprint',
    sublabelKey: 'menu.sprintSub',
    go: async () => {
      const { makeSprintScreen } = await import('@/ui/sprintScreen');
      await transitionTo(makeSprintScreen({ bench: false, weather: 'sunny', debug: false }));
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

        <footer class="menu__foot">
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
