/**
 * The race HUD.
 *
 * Designed for one reader: a spectator standing in an arena, holding a phone,
 * in August sunlight, watching the big screen with one eye. That forces every
 * choice here — heavy type, opaque plates rather than glass, 56 px touch
 * targets, and nothing on screen that is not being used.
 *
 * What is deliberately **not** here: stat bars. Focus is communicated by the
 * map going soft at the edges, and fuel by the pace the athlete can hold. A row
 * of coloured bars would say the same thing and destroy both.
 *
 * There is a second reason, and it is a legal one. A bar that visibly refills
 * when the avatar consumes a named product is, under Art. 2(2)(1), a symbolic
 * health claim — `docs/CLAIMS_TO_REVIEW.md` §0 names exactly that mechanic.
 * Not drawing it is the cheapest possible way to stay clear of it, and it is
 * also the better interface.
 *
 * The control description is a **pictogram**, not a word, because that is what
 * an orienteer reads. `src/map/pictograms.ts` draws the real IOF symbols.
 */

import { COLUMN_D, COLUMN_G, renderPictogram, isValidControlCode } from '@/map/pictograms';
import type { Pictogram } from '@/map/pictograms';
import type { RaceView } from '@/sim/race';
import type { Course, Discipline } from '@/core/types';
import { formatRaceTime, t } from '@/i18n';
import type { Sku } from '@/data/enervit';

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

  private lastControl = -1;
  private lastFlashCode = -1;
  private flashTimer = 0;
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

      <p class="hud__flash" data-role="flash" hidden></p>

      <div class="hud__belt" data-role="belt"></div>

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

    this.renderBelt(o.belt.map(() => true));

    const onClick = (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      ev.preventDefault();
      if (btn.dataset.act === 'map') o.onToggleMap();
      else if (btn.dataset.act === 'quit') o.onQuit();
      else if (btn.dataset.act === 'belt') o.onTakeBelt(Number(btn.dataset.index));
    };
    this.root.addEventListener('click', onClick);
    this.disposers.push(() => this.root.removeEventListener('click', onClick));
  }

  // -------------------------------------------------------------------------

  update(v: RaceView, nowMs: number): void {
    this.clock.textContent = formatRaceTime(v.timeS);

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
  }

  /** Which belt slots are still full. */
  renderBelt(available: readonly boolean[]): void {
    if (this.opts.belt.length === 0) {
      this.beltEl.innerHTML = '';
      return;
    }
    this.beltEl.innerHTML = this.opts.belt
      .map((s, i) => {
        const on = available[i] ?? false;
        const name = skuLabel(s);
        return `<button class="hud__beltItem" data-act="belt" data-index="${i}"
                  ${on ? '' : 'disabled'} title="${esc(name)}">
          ${s.packshot ? `<img src="${s.packshot}" alt="" />` : ''}
          <span>${esc(name)}</span>
        </button>`;
      })
      .join('');
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
