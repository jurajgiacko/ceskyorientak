/**
 * The BEFORE screen — the nutrition decision, and the one the client cares
 * about most.
 *
 * Two choices are made here and they are different choices:
 *
 *  - **Before the start.** Consumed now, in the quarantine, against a stated
 *    start time. This is where `NUTRITION_PROTOCOL.md` says the decision-making
 *    lives, precisely because in-race intake is near-zero for two of the three
 *    formats.
 *  - **On the belt.** Carried into the race, and every item is mass hauled over
 *    the climb. For Sprint and Middle the protocol's answer is *nothing*, and
 *    the screen says so plainly rather than nudging the player to load up.
 *
 * ## What this screen may and may not say
 *
 * `docs/CLAIMS_TO_REVIEW.md` §6.2 is a hard blocker: claim wordings must come
 * from the Czech and Slovak Official Journal texts, and the document ships
 * none. Czech is our primary locale. So every product panel here states
 * **composition only** — grams of carbohydrate, milligrams of sodium, per the
 * serving the SKU map defines — which is nutrition information under Reg.
 * 1169/2011, not a claim. No benefit is stated or implied anywhere on the
 * screen, so Art. 10(2)'s compliance block and Art. 10(3)'s accompaniment
 * requirement are not triggered.
 *
 * The guidance lines are about **the sport**: how long the race is, what
 * orienteers carry. That is not a health claim, and it is the honest answer.
 *
 * The Enervit mark appears as a partner credit — a sponsorship fact, which
 * §4.1 row 10 confirms is safe — never as an endorsement of an effect.
 */

import type { Screen } from './shell';
import { transitionTo } from './shell';
import { t } from '@/i18n';
import type { AthleteStats, Discipline, VenueId } from '@/core/types';
import { SKUS, skusForPhase } from '@/data/enervit';
import type { Sku } from '@/data/enervit';
import { FORMAT, applyPreRace, verdictKey, takeCostS } from '@/nutrition/protocol';
import { TYPICAL_DURATION_S } from '@/sim/athlete';

export interface RaceRequest {
  venue: VenueId;
  discipline: Discipline;
  seed: number;
  /** 0 = cool and dry, 1 = hot and humid. An August morning at Vyšší Brod. */
  heat: number;
  /** Minutes between now and the start time on the start list. */
  startInMin: number;
}

/** A handful, not a catalogue. The shop is not the mechanic. */
const BEFORE_CHOICES = [
  'pre-sport-jelly-orange',
  'isotonic-drink-lemon',
  'salt-caps',
] as const;

const BELT_CHOICES = [
  'gel-citrus',
  'liquid-gel-orange',
  'isotonic-gel-grapefruit',
  'carbo-bar-brownie',
  'carbo-gel-orange',
] as const;

export function makeBeforeScreen(req: RaceRequest): Screen {
  const spec = FORMAT[req.discipline];
  const before: string[] = [];
  const belt: string[] = [];
  let cleanup: (() => void) | null = null;

  const pick = (id: string): Sku | undefined => SKUS.find((s) => s.id === id);

  return {
    id: 'before',

    mount(host) {
      const el = document.createElement('div');
      el.className = 'before';
      host.appendChild(el);

      const render = (): void => {
        const chosen = before.map(pick).filter(isSku);
        const carried = belt.map(pick).filter(isSku);
        const outcome = applyPreRace(chosen, req.discipline, { heat: req.heat });

        el.innerHTML = `
          <header class="before__head">
            <button class="before__back" data-act="back">${esc(t('common.back'))}</button>
            <div>
              <p class="before__kicker">${esc(t('nutrition.before'))}</p>
              <h1 class="before__title">${esc(t(`discipline.${req.discipline}`))} · ${esc(
                t(`venue.${req.venue}`),
              )}</h1>
            </div>
            <p class="before__clock">${esc(
              t('nutrition.startIn', { min: req.startInMin }),
            )}</p>
          </header>

          <p class="before__profile">${esc(
            t('nutrition.profile', {
              minutes: Math.round(TYPICAL_DURATION_S[req.discipline] / 60),
            }),
          )}</p>
          <p class="before__advice">${esc(t(spec.adviceKey))}</p>

          <section class="before__section">
            <h2>${esc(t('nutrition.before'))}</h2>
            <div class="before__grid">
              ${BEFORE_CHOICES.map((id) => card(pick(id), id, before, 'before')).join('')}
            </div>
          </section>

          <section class="before__section">
            <h2>${esc(t('nutrition.loadout'))} <span class="before__slots">${
              belt.length
            }/${spec.beltSlots}</span></h2>
            <p class="before__hint">${esc(
              t('nutrition.beltHint', { s: takeCostS(req.discipline).toFixed(1) }),
            )}</p>
            <div class="before__grid">
              ${BELT_CHOICES.map((id) => card(pick(id), id, belt, 'belt')).join('')}
            </div>
          </section>

          <footer class="before__foot">
            <p class="before__verdict" data-tone="${
              outcome.gutLoad > 0 ? 'warn' : 'ok'
            }">${esc(t(verdictKey(outcome, req.discipline)))}</p>
            <p class="before__sum">${esc(
              t('nutrition.summary', {
                carbs: outcome.carbsG,
                items: carried.length,
              }),
            )}</p>
            <button class="before__go" data-act="go">${esc(t('menu.start'))}</button>
            <p class="before__legal">${esc(t('nutrition.dataNote'))}</p>
            <div class="before__partner">
              <span>${esc(t('brand.mainPartner'))}</span>
              <img src="/brand/enervit.png" alt="Enervit" />
            </div>
          </footer>`;
      };

      const card = (
        s: Sku | undefined,
        id: string,
        list: string[],
        kind: 'before' | 'belt',
      ): string => {
        if (!s) return '';
        const n = list.filter((x) => x === id).length;
        const facts: string[] = [];
        if (s.carbsG !== null) facts.push(t('nutrition.carbs', { g: s.carbsG }));
        if (s.sodiumMg !== null) facts.push(t('nutrition.sodium', { mg: s.sodiumMg }));
        if (s.volumeMl !== null) facts.push(`${s.volumeMl} ml`);
        return `
          <article class="skucard${n ? ' is-on' : ''}">
            ${s.packshot ? `<img class="skucard__shot" src="${s.packshot}" alt="" />` : ''}
            <h3 class="skucard__name">${esc(s.nameCz ?? s.nameEn)}</h3>
            <p class="skucard__facts">${esc(facts.join(' · '))}</p>
            <div class="skucard__ctl">
              <button data-act="minus" data-kind="${kind}" data-id="${id}"
                      aria-label="−" ${n ? '' : 'disabled'}>−</button>
              <b>${n}</b>
              <button data-act="plus" data-kind="${kind}" data-id="${id}"
                      aria-label="+">+</button>
            </div>
          </article>`;
      };

      const onClick = (ev: Event) => {
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'back') {
          void (async () => {
            const { makeMenuScreen } = await import('./menuScreen');
            await transitionTo(makeMenuScreen());
          })();
          return;
        }
        if (act === 'go') {
          void launch(req, before.slice(), belt.map(pick).filter(isSku));
          return;
        }
        const id = btn.dataset.id;
        const list = btn.dataset.kind === 'belt' ? belt : before;
        if (!id) return;
        if (act === 'plus') {
          // The belt is bounded by its slots. The before phase is not — a
          // player must be able to over-do it, or the over-fuelling lesson
          // has nothing to teach.
          if (list === belt && belt.length >= spec.beltSlots) return;
          if (list === before && before.length >= 8) return;
          list.push(id);
        } else if (act === 'minus') {
          const i = list.lastIndexOf(id);
          if (i >= 0) list.splice(i, 1);
        }
        render();
      };

      el.addEventListener('click', onClick);
      cleanup = () => el.removeEventListener('click', onClick);
      render();
    },

    unmount() {
      cleanup?.();
      cleanup = null;
    },
  };
}

/** Everything the race screen needs that the BEFORE phase decided. */
export interface ScreenRaceSetup {
  request: RaceRequest;
  /** SKU ids consumed before the start, for the result log. */
  preRace: string[];
  belt: Sku[];
  startStats: AthleteStats;
}

async function launch(req: RaceRequest, before: string[], belt: Sku[]): Promise<void> {
  const chosen = before
    .map((id) => SKUS.find((s) => s.id === id))
    .filter(isSku);
  const outcome = applyPreRace(chosen, req.discipline, { heat: req.heat });

  const race: ScreenRaceSetup = {
    request: req,
    preRace: before,
    belt,
    startStats: outcome.stats,
  };

  if (req.venue === 'krumlov') {
    const { makeSprintScreen } = await import('./sprintScreen');
    await transitionTo(
      makeSprintScreen({ bench: false, weather: 'sunny', debug: false, race }),
    );
  } else {
    const { makeForestScreen } = await import('./forestScreen');
    await transitionTo(
      makeForestScreen({ bench: false, weather: 'sunny', debug: false, race }),
    );
  }
}

function isSku(s: Sku | undefined): s is Sku {
  return s !== undefined;
}

/** Available for a future AFTER screen; keeps the phase helper exercised. */
export function afterPhaseSkus(): Sku[] {
  return skusForPhase('after');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
