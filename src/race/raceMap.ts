/**
 * The map the player actually reads.
 *
 * The first attempt at this put the map in the athlete's hands in 3D, at arm's
 * length, and it could not be read on a phone — 1:10 000 contours at 0.14 mm
 * are simply not legible on a texture that occupies a fifth of a 390 px-wide
 * screen. So the map is now what a real one is: a sheet held up to your face,
 * filling the view.
 *
 * Two surfaces, one renderer:
 *
 *  - the **overlay** — full screen, opened with M or the map button, panned,
 *    zoomed and rotated. This is the primary reading surface.
 *  - the **minimap** — a small always-visible corner window at a fixed close
 *    zoom, so the player is never completely blind while running.
 *
 * The rule both obey, and the whole design of the game: **the thumb marks the
 * believed position, never the true one.** `renderMap` is given
 * `believedPosition` and nothing else; there is no GPS dot anywhere in this
 * file, and there must never be. A player who wants to know where they are has
 * to read the ground against the map, or punch a control and be relocated.
 *
 * The other rule: opening the overlay does not pause anything. `Race.readingMap`
 * drops the athlete to 55% pace while it is open, which is the core tension of
 * the sport — run fast and lose contact, read well and lose time.
 */

import { renderMap } from '@/map/renderer';
import type { MapView, RunnabilityRaster } from '@/map/renderer';
import type { Contour } from '@/map/contours';
import type { Course, VenueAnchor, World2 } from '@/core/types';
import { t } from '@/i18n';
import type { RaceMapData } from './mapData';

/** What the map is allowed to know about the race. Note the absent true position. */
export interface MapSubject {
  believedPosition: World2;
  /** Direction of travel, radians. A compass is a legal instrument, not a fix. */
  heading: number;
  /** 0..1 — Focus, which degrades the sheet at the edges. */
  clarity: number;
}

export interface RaceMapOptions {
  anchor: VenueAnchor;
  data: RaceMapData;
  course: Course;
  subject: () => MapSubject;
  /** Called when the overlay opens or closes — drives `Race.readingMap`. */
  onReadingChange: (reading: boolean) => void;
}

/** A contour plus its bounds, so the viewport can reject it without walking it. */
interface BoundedContour {
  c: Contour;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Map width in metres at the default zoom, per scale denominator. */
const DEFAULT_ACROSS_M: Readonly<Record<number, number>> = { 4000: 190, 10000: 460 };
const MIN_ACROSS_M = 55;
const MAX_ACROSS_M = 1500;

/** The minimap shows the immediate surroundings only — a glance, not a plan. */
const MINI_ACROSS_M: Readonly<Record<number, number>> = { 4000: 85, 10000: 190 };

/** Redraw budget. The overlay is a 2D canvas over a live 3D scene. */
const OVERLAY_MIN_INTERVAL_MS = 45;
const MINI_MIN_INTERVAL_MS = 120;

export class RaceMap {
  readonly root: HTMLElement;

  private readonly opts: RaceMapOptions;
  private readonly bounded: BoundedContour[];
  private readonly raster: RunnabilityRaster;

  private readonly overlay: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly miniCtx: CanvasRenderingContext2D;
  private readonly northArrow: HTMLElement;
  private readonly orientBtn: HTMLButtonElement;

  private open = false;
  private acrossM: number;
  /** North-up is the default because a printed map has one north. */
  private travelUp = false;
  private follow = true;
  private pan: World2 = { x: 0, z: 0 };

  private lastOverlayAt = 0;
  private lastMiniAt = 0;
  private dpr = 1;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private pinchAcross = 0;
  private dragged = false;

  private readonly disposers: (() => void)[] = [];

  constructor(o: RaceMapOptions) {
    this.opts = o;
    this.raster = o.data.raster;
    this.bounded = o.data.contours.map(bound);
    this.acrossM = DEFAULT_ACROSS_M[o.anchor.mapScale] ?? 400;

    this.root = document.createElement('div');
    this.root.className = 'racemap';
    this.root.innerHTML = `
      <div class="racemap__mini" data-role="mini">
        <canvas data-role="miniCanvas"></canvas>
      </div>
      <div class="racemap__overlay" data-role="overlay" hidden>
        <canvas class="racemap__canvas" data-role="canvas"></canvas>
        <div class="racemap__north" data-role="north" aria-hidden="true">
          <svg viewBox="0 0 24 40" width="26" height="42">
            <path d="M12 38 L12 6" stroke="currentColor" stroke-width="2.4" fill="none"/>
            <path d="M5 14 L12 3 L19 14 Z" fill="currentColor"/>
          </svg>
          <b>N</b>
        </div>
        <div class="racemap__tools">
          <button class="racemap__tool" data-act="orient" data-role="orient"></button>
          <button class="racemap__tool" data-act="zoomIn" aria-label="${esc(t('map.zoomIn'))}">+</button>
          <button class="racemap__tool" data-act="zoomOut" aria-label="${esc(t('map.zoomOut'))}">−</button>
          <button class="racemap__tool" data-act="recentre">${esc(t('map.recentre'))}</button>
        </div>
        <button class="racemap__close" data-act="close">${esc(t('map.close'))}</button>
        <p class="racemap__scale" data-role="scale"></p>
      </div>`;

    this.overlay = must(this.root, 'overlay');
    this.canvas = must<HTMLCanvasElement>(this.root, 'canvas');
    this.miniCanvas = must<HTMLCanvasElement>(this.root, 'miniCanvas');
    this.northArrow = must(this.root, 'north');
    this.orientBtn = must<HTMLButtonElement>(this.root, 'orient');

    const ctx = this.canvas.getContext('2d');
    const mctx = this.miniCanvas.getContext('2d');
    if (!ctx || !mctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.miniCtx = mctx;

    this.syncOrientLabel();
    this.bindInput();
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(v: boolean): void {
    if (v === this.open) return;
    this.open = v;
    this.overlay.hidden = !v;
    this.root.dataset.open = v ? '1' : '0';
    if (v) {
      // Re-entering the map always re-acquires your own thumb. Leaving the view
      // panned across the venue from last time is not how a sheet of paper
      // behaves in your hands.
      this.follow = true;
      this.pan = { x: 0, z: 0 };
      this.resize();
      this.lastOverlayAt = 0;
    }
    this.opts.onReadingChange(v);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Called every frame by the controller. Throttles itself. */
  update(nowMs: number): void {
    if (this.open && nowMs - this.lastOverlayAt >= OVERLAY_MIN_INTERVAL_MS) {
      this.lastOverlayAt = nowMs;
      this.drawOverlay();
    }
    if (nowMs - this.lastMiniAt >= MINI_MIN_INTERVAL_MS) {
      this.lastMiniAt = nowMs;
      this.drawMini();
    }
  }

  private drawOverlay(): void {
    const s = this.opts.subject();
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    const centre = this.follow
      ? s.believedPosition
      : { x: s.believedPosition.x + this.pan.x, z: s.believedPosition.z + this.pan.z };
    const rotation = this.travelUp ? s.heading : 0;
    const view: MapView = {
      centre,
      rotation,
      pxPerMm: (w / this.acrossM) * (this.opts.anchor.mapScale / 1000),
    };

    renderMap(this.ctx, w, h, {
      anchor: this.opts.anchor,
      raster: this.raster,
      // Sprint scales (1:4000 / 1:3000) are town maps: impassable means
      // building, and ISSprOM 521 draws those solid dark. See the note on
      // buildingsAsBlack in map/renderer.ts.
      buildingsAsBlack: this.opts.anchor.mapScale <= 5000,
      contours: this.cull(centre, w, h, view.pxPerMm),
      course: this.opts.course,
      believedPosition: s.believedPosition,
      heldBearing: s.heading,
      clarity: s.clarity,
      view,
    });

    this.northArrow.style.transform = `rotate(${(-rotation * 180) / Math.PI}deg)`;
    const scaleEl = this.root.querySelector<HTMLElement>('[data-role="scale"]');
    if (scaleEl) {
      scaleEl.textContent =
        `1:${this.opts.anchor.mapScale}  ·  ` +
        t('race.contourInterval') +
        ` ${this.opts.anchor.contourInterval} m  ·  ` +
        `${Math.round(this.acrossM)} m`;
    }
  }

  private drawMini(): void {
    const s = this.opts.subject();
    const w = this.miniCanvas.width;
    const h = this.miniCanvas.height;
    if (w === 0 || h === 0) return;

    const across = MINI_ACROSS_M[this.opts.anchor.mapScale] ?? 180;
    const view: MapView = {
      centre: s.believedPosition,
      // The minimap is always travel-up. It exists to answer "what is just
      // ahead of me", and a north-up thumbnail cannot answer that at a glance.
      rotation: s.heading,
      pxPerMm: (w / across) * (this.opts.anchor.mapScale / 1000),
    };
    renderMap(this.miniCtx, w, h, {
      anchor: this.opts.anchor,
      raster: this.raster,
      // Sprint scales (1:4000 / 1:3000) are town maps: impassable means
      // building, and ISSprOM 521 draws those solid dark. See the note on
      // buildingsAsBlack in map/renderer.ts.
      buildingsAsBlack: this.opts.anchor.mapScale <= 5000,
      contours: this.cull(s.believedPosition, w, h, view.pxPerMm),
      course: this.opts.course,
      believedPosition: s.believedPosition,
      clarity: s.clarity,
      view,
    });
  }

  /**
   * Reject contours whose bounds cannot touch the viewport.
   *
   * Martínkov's contour set is ~340 000 points. Stroking all of it twice per
   * frame is 30 ms of path building for a view that shows a fiftieth of it.
   * The radius test is deliberately generous — a rotating view has no
   * axis-aligned viewport.
   */
  private cull(centre: World2, w: number, h: number, pxPerMm: number): Contour[] {
    const pxPerM = pxPerMm * (1000 / this.opts.anchor.mapScale);
    const r = Math.hypot(w, h) / (2 * pxPerM) + 30;
    const out: Contour[] = [];
    for (const b of this.bounded) {
      if (b.maxX < centre.x - r || b.minX > centre.x + r) continue;
      if (b.maxZ < centre.z - r || b.minZ > centre.z + r) continue;
      out.push(b.c);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const fit = (el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * this.dpr));
      const h = Math.max(1, Math.round(r.height * this.dpr));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
    };
    if (this.open) fit(this.canvas);
    fit(this.miniCanvas);
    this.lastOverlayAt = 0;
    this.lastMiniAt = 0;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private bindInput(): void {
    const onClick = (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      switch (btn.dataset.act) {
        case 'close':
          this.setOpen(false);
          break;
        case 'zoomIn':
          this.zoomBy(1 / 1.35);
          break;
        case 'zoomOut':
          this.zoomBy(1.35);
          break;
        case 'orient':
          this.travelUp = !this.travelUp;
          this.syncOrientLabel();
          this.lastOverlayAt = 0;
          break;
        case 'recentre':
          this.follow = true;
          this.pan = { x: 0, z: 0 };
          this.lastOverlayAt = 0;
          break;
      }
    };
    this.overlay.addEventListener('click', onClick);
    this.disposers.push(() => this.overlay.removeEventListener('click', onClick));

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      this.zoomBy(ev.deltaY > 0 ? 1.12 : 1 / 1.12);
    };
    this.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => this.canvas.removeEventListener('wheel', onWheel));

    const down = (ev: PointerEvent) => {
      this.canvas.setPointerCapture(ev.pointerId);
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      this.dragged = false;
      if (this.pointers.size === 2) {
        this.pinchStart = this.pinchDistance();
        this.pinchAcross = this.acrossM;
      }
    };
    const move = (ev: PointerEvent) => {
      const prev = this.pointers.get(ev.pointerId);
      if (!prev) return;
      const next = { x: ev.clientX, y: ev.clientY };
      this.pointers.set(ev.pointerId, next);

      if (this.pointers.size === 2 && this.pinchStart > 0) {
        const d = this.pinchDistance();
        if (d > 4) {
          this.acrossM = clamp(
            (this.pinchAcross * this.pinchStart) / d,
            MIN_ACROSS_M,
            MAX_ACROSS_M,
          );
          this.lastOverlayAt = 0;
        }
        return;
      }

      const dxPx = next.x - prev.x;
      const dyPx = next.y - prev.y;
      if (Math.abs(dxPx) + Math.abs(dyPx) < 0.5) return;
      this.dragged = true;
      this.follow = false;

      // Screen delta back to world metres, undoing the map rotation.
      const pxPerM = (this.canvas.width / this.dpr) / this.acrossM;
      const rot = this.travelUp ? this.opts.subject().heading : 0;
      const c = Math.cos(-rot);
      const s = Math.sin(-rot);
      // Inverse of the canvas rotate(-rot): screen → world.
      const wx = (dxPx * c + dyPx * s) / pxPerM;
      const wz = (-dxPx * s + dyPx * c) / pxPerM;
      this.pan.x -= wx;
      this.pan.z -= wz;
      this.lastOverlayAt = 0;
    };
    const up = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinchStart = 0;
      if (!this.dragged && this.pointers.size === 0) {
        // A tap that did not drag is a request to look at your own thumb again.
        this.follow = true;
        this.pan = { x: 0, z: 0 };
        this.lastOverlayAt = 0;
      }
    };
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.disposers.push(() => {
      this.canvas.removeEventListener('pointerdown', down);
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
    });
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private zoomBy(f: number): void {
    this.acrossM = clamp(this.acrossM * f, MIN_ACROSS_M, MAX_ACROSS_M);
    this.lastOverlayAt = 0;
  }

  private syncOrientLabel(): void {
    this.orientBtn.textContent = this.travelUp ? t('map.travelUp') : t('map.northUp');
    this.orientBtn.setAttribute('aria-pressed', this.travelUp ? 'true' : 'false');
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------

function bound(c: Contour): BoundedContour {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of c.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { c, minX, minZ, maxX, maxZ };
}

function must<T extends HTMLElement = HTMLElement>(root: HTMLElement, role: string): T {
  const el = root.querySelector<T>(`[data-role="${role}"]`);
  if (!el) throw new Error(`racemap: missing [data-role="${role}"]`);
  return el;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
