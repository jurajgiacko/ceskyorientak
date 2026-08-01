/**
 * The race HUD.
 *
 * Designed for one reader: a spectator standing in an arena, holding a phone,
 * in August sunlight, watching the big screen with one eye. That forces every
 * choice here — heavy type, opaque plates rather than glass, 56 px touch
 * targets, and nothing on screen that is not being used.
 *
 * The control description is a **pictogram**, not a word, because that is what
 * an orienteer reads. `src/map/pictograms.ts` draws the real IOF symbols.
 *
 * ## The energy meter
 *
 * This HUD used to draw no stats at all. It draws them now because an invisible
 * mechanic teaches nothing: a player who cannot see their own effort cannot
 * learn that effort is what costs them, and the nutrition decision the whole
 * game is built around was producing no feedback whatsoever.
 *
 * The headline is the athlete's own reserve, fed by `./energy.ts`. Every value
 * on that plate is a `depleteStats()` output, so it is spent by pace, terrain,
 * climb and heat and by nothing else. Running hard uphill empties it. That is
 * true in every build and carries no product attribution at all.
 *
 * Two rules hold regardless of `CLAIMS_SAFE`, because they are game design
 * before they are anything else:
 *
 *  - **Nothing prompts the player to eat, ever.** The belt dock hides itself
 *    when it is empty, there is no target line to fall short of, and no state
 *    is framed as the consequence of having declined something. For Sprint and
 *    Middle the protocol's answer is zero intake, so an empty belt is a correct
 *    race and the screen stays quiet.
 *  - **The gut row is the counterweight.** It is the one indicator that fills
 *    as more is consumed, and filling it is bad news — `overfuellingPenalty`
 *    is already costing the player pace by the time it shows.
 *
 * ## What the compliance flag changes here
 *
 * With `CLAIMS_SAFE` off — the default — the take confirmation names what moved
 * in the athlete, and a focus row appears, because caffeine is modelled and
 * modelling something the player cannot see is pointless. With it on, the
 * confirmation states composition and time cost only, the focus row is absent,
 * and nothing on screen attributes a gain to a SKU. See
 * `src/core/compliance.ts` for the full table and D-020 for why it is a switch.
 */

import { COLUMN_D, COLUMN_G, renderPictogram, isValidControlCode } from '@/map/pictograms';
import type { Pictogram } from '@/map/pictograms';
import type { RaceView } from '@/sim/race';
import type { Course, Discipline } from '@/core/types';
import { formatNumber, formatRaceTime, t } from '@/i18n';
import type { Sku } from '@/data/enervit';
import type { EnergyView } from './energy';
import { KNEE_BITE, KNEE_WALL } from './energy';
import type { IntakeEffect } from '@/nutrition/intake';
import { isVisible } from '@/nutrition/intake';
import { CLAIMS_SAFE } from '@/core/compliance';

export interface HudCallbacks {
  onToggleMap: () => void;
  onQuit: () => void;
  onTakeBelt: (index: number) => void;
}

export interface HudOptions extends HudCallbacks {
  course: Course;
  discipline: Discipline;
  belt: readonly Sku[];
  /** Touch layout on, i.e. the player has no keyboard. */
  touch: boolean;
}

export class RaceHud {
  readonly root: HTMLElement;

  private readonly opts: HudOptions;
  private readonly clock: HTMLElement;
  private readonly ctrlNo: HTMLElement;
  private readonly ctrlCode: HTMLElement;
  private readonly picto: HTMLElement;
  private readonly needle: HTMLElement;
  private readonly bearing: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly beltEl: HTMLElement;
  private readonly beltDock: HTMLElement;
  private readonly beltToggle: HTMLButtonElement;
  private readonly beltCount: HTMLElement;
  private readonly energy: HTMLElement;
  private readonly energyState: HTMLElement;
  private readonly reserveFill: HTMLElement;
  private readonly waterFill: HTMLElement;
  private readonly waterRow: HTMLElement;
  private readonly focusRow: HTMLElement;
  private readonly focusFill: HTMLElement;
  private readonly gutRow: HTMLElement;
  private readonly gutFill: HTMLElement;
  private readonly take: HTMLElement;

  private lastControl = -1;
  private lastFlashCode = -1;
  private flashTimer = 0;
  /** Cached so the meter writes to the DOM only when it has actually moved. */
  private shown = { reserve: -1, water: -1, focus: -1, gut: -1, band: '', capped: '' };
  private takeTimer = 0;
  private trayOpen = false;
  private readonly disposers: (() => void)[] = [];

  constructor(o: HudOptions) {
    this.opts = o;

    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.dataset.touch = o.touch ? '1' : '0';
    this.root.innerHTML = `
      <div class="hud__bar">
        <button class="hud__quit" data-act="quit" aria-label="${esc(t('common.back'))}">✕</button>
        <div class="hud__clock" data-role="clock">0:00</div>
        <div class="hud__compass" aria-label="${esc(t('hud.compass'))}">
          <div class="hud__rose" data-role="needle">
            <svg viewBox="0 0 60 60" width="52" height="52" aria-hidden="true">
              <circle cx="30" cy="30" r="27" class="hud__roseRing"/>
              <path d="M30 6 L37 30 L30 26 L23 30 Z" class="hud__roseN"/>
              <path d="M30 54 L23 30 L30 34 L37 30 Z" class="hud__roseS"/>
            </svg>
          </div>
          <span class="hud__bearing" data-role="bearing">0°</span>
        </div>
      </div>

      <div class="hud__target" data-role="target">
        <div class="hud__targetHead">
          <span class="hud__ctrlNo" data-role="ctrlNo">1</span>
          <span class="hud__ctrlCode" data-role="ctrlCode">31</span>
        </div>
        <div class="hud__picto" data-role="picto"></div>
      </div>

      <!--
        The athlete's own state. Everything on this plate is *spent* by running
        — pace, terrain, climb, heat — and only ever refilled by something the
        player chose to carry and chose to take. There is no target line and no
        prompt, so an empty belt is never framed as a shortfall.
      -->
      <div class="hud__energy" data-role="energy" data-band="strong"
           aria-label="${esc(t('hud.energyCause'))}">
        <div class="hud__energyHead">
          <span class="hud__energyLabel">${esc(t('hud.energy'))}</span>
          <span class="hud__energyState" data-role="energyState">${esc(
            t('hud.band.strong'),
          )}</span>
        </div>
        <div class="hud__gauge">
          <i class="hud__gaugeFill" data-role="reserveFill"></i>
          <i class="hud__gaugeTick" style="left:${KNEE_BITE * 100}%"></i>
          <i class="hud__gaugeTick" style="left:${KNEE_WALL * 100}%"></i>
        </div>
        <div class="hud__sub" data-role="waterRow">
          <span class="hud__subLabel">${esc(t('hud.water'))}</span>
          <div class="hud__subGauge"><i data-role="waterFill"></i></div>
        </div>
        <!--
          Navigation quality. Present only in the full-mechanic build: with
          CLAIMS_SAFE on, no product may move focus, so there is nothing
          product-linked to draw and the row is not rendered at all.
        -->
        <div class="hud__sub" data-role="focusRow" ${CLAIMS_SAFE ? 'hidden' : ''}>
          <span class="hud__subLabel">${esc(t('hud.focus'))}</span>
          <div class="hud__subGauge"><i data-role="focusFill"></i></div>
        </div>
        <div class="hud__sub hud__sub--gut" data-role="gutRow" hidden>
          <span class="hud__subLabel">${esc(t('hud.gut'))}</span>
          <div class="hud__subGauge"><i data-role="gutFill"></i></div>
        </div>
      </div>

      <p class="hud__flash" data-role="flash" hidden></p>

      <!-- What taking something off the belt actually did. Cost and facts. -->
      <div class="hud__take" data-role="take" hidden aria-live="polite"></div>

      <div class="hud__beltDock" data-role="beltDock" hidden>
        <div class="hud__belt" data-role="belt" hidden></div>
        <button class="hud__beltToggle" data-act="beltToggle" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M2 9h20v6H2z" class="hud__beltStrap"/>
            <path d="M9 7h6v10H9z" class="hud__beltBuckle"/>
          </svg>
          <span class="hud__beltName">${esc(t('hud.belt'))}</span>
          <span class="hud__beltCount" data-role="beltCount">0</span>
        </button>
      </div>

      <button class="hud__map" data-act="map">
        <span class="hud__mapKey">M</span>${esc(t('hud.map'))}
      </button>`;

    this.clock = must(this.root, 'clock');
    this.ctrlNo = must(this.root, 'ctrlNo');
    this.ctrlCode = must(this.root, 'ctrlCode');
    this.picto = must(this.root, 'picto');
    this.needle = must(this.root, 'needle');
    this.bearing = must(this.root, 'bearing');
    this.flash = must(this.root, 'flash');
    this.beltEl = must(this.root, 'belt');
    this.beltDock = must(this.root, 'beltDock');
    this.beltCount = must(this.root, 'beltCount');
    this.energy = must(this.root, 'energy');
    this.energyState = must(this.root, 'energyState');
    this.reserveFill = must(this.root, 'reserveFill');
    this.waterFill = must(this.root, 'waterFill');
    this.waterRow = must(this.root, 'waterRow');
    this.focusRow = must(this.root, 'focusRow');
    this.focusFill = must(this.root, 'focusFill');
    this.gutRow = must(this.root, 'gutRow');
    this.gutFill = must(this.root, 'gutFill');
    this.take = must(this.root, 'take');

    const toggle = this.root.querySelector<HTMLButtonElement>('.hud__beltToggle');
    if (!toggle) throw new Error('hud: missing belt toggle');
    this.beltToggle = toggle;

    this.renderBelt(o.belt.map(() => true));

    const onClick = (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      ev.preventDefault();
      if (btn.dataset.act === 'map') {
        this.setTray(false);
        o.onToggleMap();
      } else if (btn.dataset.act === 'quit') o.onQuit();
      else if (btn.dataset.act === 'beltToggle') this.setTray(!this.trayOpen);
      else if (btn.dataset.act === 'belt') o.onTakeBelt(Number(btn.dataset.index));
    };
    this.root.addEventListener('click', onClick);
    this.disposers.push(() => this.root.removeEventListener('click', onClick));
  }

  // -------------------------------------------------------------------------
  // The belt
  // -------------------------------------------------------------------------

  /**
   * Open or close the belt tray.
   *
   * A tray rather than always-on tiles because the reader is holding a phone
   * with one thumb on a stick and one on the look area, and there is no corner
   * left that four packshots can live in without covering the minimap. It also
   * gives the belt a name and a count, which four unlabelled icons never did.
   */
  private setTray(open: boolean): void {
    this.trayOpen = open;
    this.beltEl.hidden = !open;
    this.beltToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.beltDock.dataset.open = open ? '1' : '0';
  }

  // -------------------------------------------------------------------------

  update(v: RaceView, nowMs: number, e: EnergyView): void {
    this.clock.textContent = formatRaceTime(v.timeS);
    this.updateEnergy(e);

    if (v.nextControl !== this.lastControl) {
      this.lastControl = v.nextControl;
      this.renderTarget(v);
    }

    const deg = ((v.heading * 180) / Math.PI + 360) % 360;
    this.needle.style.transform = `rotate(${-deg}deg)`;
    this.bearing.textContent = `${Math.round(deg)}°`;

    if (v.justPunched && v.justPunched.code !== this.lastFlashCode) {
      this.lastFlashCode = v.justPunched.code;
      this.showFlash(v.justPunched.code, v.justPunched.correctedM, nowMs);
    }
    if (this.flashTimer && nowMs > this.flashTimer) {
      this.flashTimer = 0;
      this.flash.hidden = true;
      this.root.dataset.punch = '0';
    }
    if (this.takeTimer && nowMs > this.takeTimer) {
      this.takeTimer = 0;
      this.take.hidden = true;
    }
  }

  /**
   * Paint the athlete's state.
   *
   * Writes are gated on a real change, because this runs every frame and a
   * layout-triggering style write per frame per bar is a measurable cost on the
   * phones this is built for.
   */
  private updateEnergy(e: EnergyView): void {
    const reserve = Math.round(e.reserve * 200) / 2;
    if (reserve !== this.shown.reserve) {
      this.shown.reserve = reserve;
      this.reserveFill.style.width = `${reserve}%`;
    }
    if (e.band !== this.shown.band) {
      this.shown.band = e.band;
      this.energy.dataset.band = e.band;
      this.energyState.textContent = t(`hud.band.${e.band}`);
    }

    // The pace cap is the thing the player actually feels. Marking the meter
    // when it engages turns "why am I slow" into "I am running on empty" —
    // which is a statement about effort, and about nothing else.
    const capped = e.capped ? '1' : '0';
    if (capped !== this.shown.capped) {
      this.shown.capped = capped;
      this.energy.dataset.capped = capped;
    }

    const water = Math.round(e.water * 100);
    if (water !== this.shown.water) {
      this.shown.water = water;
      this.waterFill.style.width = `${water}%`;
      this.waterRow.dataset.low = e.waterLow ? '1' : '0';
    }

    if (e.focus !== null) {
      const focus = Math.round(e.focus * 100);
      if (focus !== this.shown.focus) {
        this.shown.focus = focus;
        this.focusFill.style.width = `${focus}%`;
        this.focusRow.dataset.low = e.focus < 0.45 ? '1' : '0';
      }
    }

    // Art. 3(c): consumption past what the gut can take for the elapsed
    // duration is the one product-linked number on this plate, and it only ever
    // moves against the player. Hidden at zero, which is where every race run
    // on protocol sits — including every Sprint and Middle taking nothing.
    const gut = Math.round(e.gutLoad * 100);
    if (gut !== this.shown.gut) {
      this.shown.gut = gut;
      this.gutRow.hidden = gut < 2;
      this.gutFill.style.width = `${gut}%`;
      this.gutRow.dataset.heavy = gut > 45 ? '1' : '0';
    }
  }

  /** Which belt slots are still full. */
  renderBelt(available: readonly boolean[]): void {
    const left = available.filter(Boolean).length;

    // Nothing left to take, or nothing was ever carried: the dock disappears.
    // It must not linger as an empty reminder — taking nothing is the correct
    // Sprint and Middle protocol and the HUD may not imply otherwise.
    if (this.opts.belt.length === 0 || left === 0) {
      this.beltEl.innerHTML = '';
      this.beltDock.hidden = true;
      this.setTray(false);
      return;
    }

    this.beltDock.hidden = false;
    this.beltCount.textContent = String(left);
    this.beltEl.innerHTML = this.opts.belt
      .map((s, i) => {
        const on = available[i] ?? false;
        const name = skuLabel(s);
        // Composition only — grams and milligrams off the pack. Nutrition
        // information under Reg. 1169/2011, never a statement of effect.
        const facts: string[] = [];
        if (s.carbsG !== null) facts.push(t('nutrition.carbs', { g: s.carbsG }));
        if (s.sodiumMg !== null) facts.push(t('nutrition.sodium', { mg: s.sodiumMg }));
        // Two belt SKUs share the Czech pack name; this is what tells them
        // apart mid-race, when there is no time to remember which slot was
        // which.
        if (s.caffeineMg) facts.push(t('nutrition.caffeine', { mg: s.caffeineMg }));
        return `<button class="hud__beltItem" data-act="belt" data-index="${i}"
                  ${on ? '' : 'disabled'} title="${esc(name)}">
          ${s.packshot ? `<img src="${s.packshot}" alt="" />` : ''}
          <span class="hud__beltItemName">${esc(name)}</span>
          <span class="hud__beltItemFacts">${esc(facts.join(' · '))}</span>
          ${
            this.opts.touch
              ? ''
              : `<span class="hud__beltItemKey">${i + 1}</span>`
          }
        </button>`;
      })
      .join('');
  }

  /**
   * Confirm that an item left the belt, and show the athlete respond.
   *
   * The invariant parts: what it was, what it is made of, and what it **cost**
   * in running time. The composition line is grams and milligrams off the pack
   * — nutrition information under Reg. 1169/2011 — and the cost is real, paid
   * as a forced slow in the controller's frame loop.
   *
   * The variable part is the chip row. With the full mechanic on it names the
   * athlete's stats that actually moved, so the player can connect a choice to
   * a consequence; a chip can be negative, and over a third caffeinated gel it
   * will be. With `CLAIMS_SAFE` on the row is not rendered, and no gain is
   * attributed to a SKU anywhere on screen.
   *
   * Either way the number shown is the athlete's stat moving, never a figure
   * belonging to the product.
   */
  showTake(sku: Sku, costS: number, nowMs: number, effect: IntakeEffect | null): void {
    const facts: string[] = [];
    if (sku.carbsG !== null) facts.push(t('nutrition.carbs', { g: sku.carbsG }));
    if (sku.sodiumMg !== null) facts.push(t('nutrition.sodium', { mg: sku.sodiumMg }));
    if (sku.caffeineMg) facts.push(t('nutrition.caffeine', { mg: sku.caffeineMg }));

    const chips =
      !CLAIMS_SAFE && effect && isVisible(effect) ? this.chipRow(effect) : '';

    const durationMs = Math.max(1200, costS * 1000);
    this.take.innerHTML = `
      ${sku.packshot ? `<img class="hud__takeShot" src="${sku.packshot}" alt="" />` : ''}
      <div class="hud__takeBody">
        <b class="hud__takeName">${esc(skuLabel(sku))}</b>
        <span class="hud__takeFacts">${esc(facts.join(' · '))}</span>
        ${chips}
      </div>
      <span class="hud__takeCost">${esc(
        t('hud.takeCost', { s: formatNumber(costS) }),
      )}</span>
      <i class="hud__takeBar" style="animation-duration:${Math.round(durationMs)}ms"></i>`;
    this.take.hidden = false;
    this.takeTimer = nowMs + durationMs + 1400;

    // The meter acknowledges the moment even when nothing moved — the player
    // pressed something and time is being spent, and silence reads as a bug.
    this.energy.dataset.bump = '1';
    window.setTimeout(() => {
      this.energy.dataset.bump = '0';
    }, 700);

    // The tray has done its job; get it out of the way of the running.
    this.setTray(false);
  }

  /** One chip per stat that moved. Signed, and a fall is shown as a fall. */
  private chipRow(e: IntakeEffect): string {
    const rows: [string, number][] = [
      ['hud.energy', e.glycogen],
      ['hud.water', e.hydration],
      ['hud.focus', e.focus],
    ];
    const chips = rows
      .filter(([, v]) => Math.abs(v) >= 0.01)
      .map(([key, v]) => {
        const sign = v > 0 ? '+' : '−';
        const pct = Math.round(Math.abs(v) * 100);
        return `<span class="hud__chip" data-dir="${v > 0 ? 'up' : 'down'}">${esc(
          t(key),
        )} ${sign}${pct}</span>`;
      })
      .join('');
    return chips ? `<span class="hud__chips">${chips}</span>` : '';
  }

  private renderTarget(v: RaceView): void {
    const target = v.target;
    if (!target) {
      this.ctrlNo.textContent = '';
      this.ctrlCode.textContent = t('race.finish');
      this.picto.innerHTML = '';
      this.root.dataset.phase = 'finish';
      return;
    }
    this.root.dataset.phase = 'control';
    this.ctrlNo.textContent = `${v.nextControl + 1}/${this.opts.course.controls.length}`;
    // Rule 19.6: codes below 31 collide with SI station function codes. If the
    // generator ever produced one, say so rather than printing it as if valid.
    this.ctrlCode.textContent = isValidControlCode(target.code)
      ? String(target.code)
      : '—';

    const symbols: Pictogram[] = [];
    const d = COLUMN_D[target.description.d];
    if (d) symbols.push(d);
    const g = target.description.g ? COLUMN_G[target.description.g] : undefined;
    if (g) symbols.push(g);
    this.picto.innerHTML = symbols
      .map((s) => `<i class="hud__symbol" title="${esc(s.nameCs)}">${renderPictogram(
        { symbol: s },
        34,
      )}</i>`)
      .join('');
  }

  private showFlash(code: number, correctedM: number, nowMs: number): void {
    // The relocation snap is the punch's real payoff: the moment the belief
    // collapses back onto the truth, and the number is how wrong you were.
    const snap =
      correctedM >= 1 ? ` · ${t('race.relocatedBy', { m: Math.round(correctedM) })}` : '';
    this.flash.textContent = `${code} ✓${snap}`;
    this.flash.hidden = false;
    this.root.dataset.punch = '1';
    this.flashTimer = nowMs + 2200;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}

export function skuLabel(s: Sku): string {
  return s.nameCz ?? s.nameEn;
}

function must(root: HTMLElement, role: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-role="${role}"]`);
  if (!el) throw new Error(`hud: missing [data-role="${role}"]`);
  return el;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
