/**
 * The ISOM map renderer — the navigation layer.
 *
 * Draws a true orienteering map from the *same* terrain data the 3D world uses.
 * That shared source is the point: the map cannot promise a green the forest
 * does not deliver, because both read one `Runnability` raster (see D-002).
 *
 * Layering follows the normative ISOM colour order (`PAINT_ORDER` in isom.ts),
 * which is a printing order — lower entries print first and sit underneath.
 * Painting in that order is what makes the overprint behave: the course purple
 * sits above the detail, but never hides the black rock symbols an orienteer
 * needs to navigate by.
 */

import { ISOM, OVERPRINT, OVERPRINT_GAP_MM, RUNNABILITY_COLOUR } from './isom';
import type { Contour } from './contours';
import type { Course, Control, World2, VenueAnchor } from '@/core/types';
import { Runnability } from '@/core/types';
import { bearing, dist2 } from '@/core/geo';

export interface RunnabilityRaster {
  data: Uint8Array;
  width: number;
  height: number;
  /** Metres per cell. */
  resM: number;
  originX: number;
  originZ: number;
}

export interface MapView {
  /** World position at the centre of the viewport. */
  centre: World2;
  /** Map rotation in radians. 0 = north up. */
  rotation: number;
  /** Screen pixels per map millimetre. Zoom, effectively. */
  pxPerMm: number;
}

export interface MapRenderOptions {
  anchor: VenueAnchor;
  raster: RunnabilityRaster;
  /**
   * Render impassable cells as ISSprOM 521 *buildings* (black) rather than
   * ISOM 520 out-of-bounds (olive).
   *
   * This is not a style preference — it is what makes a sprint map legible.
   * In a town almost every impassable cell is a building, and a sprint map's
   * entire visual language is solid black blocks against light open space; that
   * contrast is how you read a route through a street network at a glance.
   * Painting them olive instead produced a map that was 38% out-of-bounds by
   * area and effectively unreadable, which is exactly what the client reported.
   *
   * Solid black, not black-50: ISSprOM reserves the 50% tint for buildings
   * over 75x75 m, and Krumlov's burgher houses are nowhere near that. Drawing
   * them all in the tint produced an undifferentiated grey mush in which the
   * street network was unreadable — the opposite of what a sprint map is for.
   *
   * Olive stays correct for the forest, where impassable really does mean
   * private land you must not enter.
   */
  buildingsAsBlack?: boolean;
  contours: Contour[];
  course?: Course;
  /** Where the athlete *believes* they are. There is no true-position marker. */
  believedPosition?: World2;
  /** Compass bearing being held, if any. */
  heldBearing?: number;
  /**
   * 0..1 navigation quality. Below 1 the map degrades at the edges — this is
   * how low Focus is communicated, rather than by a number on a bar.
   */
  clarity: number;
  view: MapView;
}

/**
 * Render the map to a 2D canvas.
 *
 * Deliberately immediate-mode rather than retained: the map is small, redraws
 * only when the player moves or reads, and an immediate renderer keeps the
 * "what the player currently believes" state in exactly one place.
 */
export function renderMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: MapRenderOptions,
): void {
  const { view, anchor } = o;
  // Metres per map millimetre at this scale, then to screen pixels.
  const mmPerM = 1000 / anchor.mapScale;
  const pxPerM = view.pxPerMm * mmPerM;

  ctx.save();
  ctx.clearRect(0, 0, w, h);

  // Paper. White is not "no ink" — it is the runnable-forest symbol (ISOM 405,
  // the 80–100% runnability band), so it must actually be painted.
  ctx.fillStyle = ISOM.white.hex;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w / 2, h / 2);
  ctx.rotate(-view.rotation);
  ctx.scale(pxPerM, pxPerM);
  ctx.translate(-view.centre.x, -view.centre.z);

  drawRunnability(ctx, o);
  drawContours(ctx, o);
  if (o.course) drawCourse(ctx, o.course, anchor);
  if (o.believedPosition) drawThumb(ctx, o.believedPosition, pxPerM);

  ctx.restore();

  if (o.clarity < 1) applyClarityFalloff(ctx, w, h, o.clarity);
  if (o.heldBearing !== undefined) drawCompassNeedle(ctx, w, h, o.heldBearing, view.rotation);
}

// ---------------------------------------------------------------------------
// Base map
// ---------------------------------------------------------------------------

/**
 * Paint the runnability raster as ISOM area colours.
 *
 * Drawn as run-length spans per row rather than per cell: at 1 m resolution a
 * 2 km venue is 5.7 M cells, and a fillRect each would be unusable. Spans cut
 * it to a few thousand rectangles because terrain is strongly autocorrelated —
 * forest comes in patches, not confetti.
 */
function drawRunnability(ctx: CanvasRenderingContext2D, o: MapRenderOptions): void {
  const r = o.raster;
  const res = r.resM;

  // Only touch cells inside the viewport. Without this we would paint the whole
  // venue on every frame regardless of zoom.
  const halfW = ctx.canvas.width / (2 * o.view.pxPerMm * (1000 / o.anchor.mapScale));
  const halfH = ctx.canvas.height / (2 * o.view.pxPerMm * (1000 / o.anchor.mapScale));
  // Generous margin so rotation cannot expose an unpainted corner.
  const margin = Math.hypot(halfW, halfH);

  const x0 = Math.max(0, Math.floor((o.view.centre.x - margin - r.originX) / res));
  const x1 = Math.min(r.width - 1, Math.ceil((o.view.centre.x + margin - r.originX) / res));
  const z0 = Math.max(0, Math.floor((o.view.centre.z - margin - r.originZ) / res));
  const z1 = Math.min(r.height - 1, Math.ceil((o.view.centre.z + margin - r.originZ) / res));

  for (let zi = z0; zi <= z1; zi++) {
    let spanStart = x0;
    let spanClass = r.data[zi * r.width + x0] ?? Runnability.ForestOpen;

    for (let xi = x0 + 1; xi <= x1 + 1; xi++) {
      const cls = xi <= x1 ? (r.data[zi * r.width + xi] ?? spanClass) : -1;
      if (cls === spanClass) continue;

      // White is already the paper colour — skipping it is a large saving,
      // since white is over half of a typical forest map.
      if (spanClass !== Runnability.ForestOpen) {
        const colour =
          o.buildingsAsBlack && spanClass === Runnability.Impassable
            ? ISOM.black
            : RUNNABILITY_COLOUR[spanClass as Runnability];
        if (colour) {
          ctx.fillStyle = colour.hex;
          ctx.fillRect(
            r.originX + spanStart * res,
            r.originZ + zi * res,
            (xi - spanStart) * res,
            res,
          );
        }
      }
      spanStart = xi;
      spanClass = cls;
    }
  }
}

function drawContours(ctx: CanvasRenderingContext2D, o: MapRenderOptions): void {
  ctx.strokeStyle = ISOM.brown.hex;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Line widths are specified in map millimetres, so convert to metres on the
  // ground — the whole point is that the map is 1:1 with the world.
  const mPerMm = o.anchor.mapScale / 1000;
  const normalW = 0.14 * mPerMm;
  const indexW = 0.25 * mPerMm;

  for (const pass of [false, true]) {
    ctx.lineWidth = pass ? indexW : normalW;
    ctx.beginPath();
    for (const c of o.contours) {
      if (c.index !== pass) continue;
      const pts = c.points;
      if (pts.length < 2) continue;
      ctx.moveTo(pts[0]!.x, pts[0]!.z);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.z);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Course overprint
// ---------------------------------------------------------------------------

/**
 * Draw the course: start triangle, numbered circles, connecting lines, finish.
 *
 * The gap rule is the interesting part. ISOM requires circles and lines to be
 * broken where they would obscure map detail — the control circle marks *where*
 * the feature is, and hiding the feature would defeat it. We implement it by
 * shortening every connecting line at both ends so it never enters a circle.
 */
function drawCourse(ctx: CanvasRenderingContext2D, course: Course, anchor: VenueAnchor): void {
  const mPerMm = anchor.mapScale / 1000;
  const spec = anchor.mapScale <= 5000 ? OVERPRINT.issprom : OVERPRINT.isom;

  const radius = (spec.controlCircleDiameterMm / 2) * mPerMm;
  const lineW = spec.lineWidthMm * mPerMm;
  const gap = OVERPRINT_GAP_MM * mPerMm;

  ctx.strokeStyle = ISOM.purple.hex;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'butt';

  const points: World2[] = [course.start, ...course.controls.map((c) => c.position), course.finish];

  // Connecting lines, trimmed clear of each circle.
  ctx.beginPath();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = dist2(a, b);
    if (d < 1e-6) continue;
    const ux = (b.x - a.x) / d;
    const uz = (b.z - a.z) / d;

    // The start is a triangle, the finish a double circle, so their clearances
    // differ from a plain control.
    const startClear = i === 0 ? (spec.startTriangleSideMm / 2) * mPerMm + gap : radius + gap;
    const endClear =
      i === points.length - 2 ? (spec.finishOuterMm / 2) * mPerMm + gap : radius + gap;

    if (d <= startClear + endClear) continue;
    ctx.moveTo(a.x + ux * startClear, a.z + uz * startClear);
    ctx.lineTo(b.x - ux * endClear, b.z - uz * endClear);
  }
  ctx.stroke();

  // Start triangle: equilateral, pointing at the first control.
  drawStartTriangle(
    ctx,
    course.start,
    points[1] ?? course.finish,
    spec.startTriangleSideMm * mPerMm,
    lineW,
  );

  // Control circles.
  ctx.beginPath();
  for (const c of course.controls) {
    ctx.moveTo(c.position.x + radius, c.position.z);
    ctx.arc(c.position.x, c.position.z, radius, 0, Math.PI * 2);
  }
  ctx.stroke();

  // Finish: double circle.
  ctx.beginPath();
  const ro = (spec.finishOuterMm / 2) * mPerMm;
  const ri = (spec.finishInnerMm / 2) * mPerMm;
  ctx.moveTo(course.finish.x + ro, course.finish.z);
  ctx.arc(course.finish.x, course.finish.z, ro, 0, Math.PI * 2);
  ctx.moveTo(course.finish.x + ri, course.finish.z);
  ctx.arc(course.finish.x, course.finish.z, ri, 0, Math.PI * 2);
  ctx.stroke();

  drawControlNumbers(ctx, course, radius, spec.numberHeightMm * mPerMm);
}

function drawStartTriangle(
  ctx: CanvasRenderingContext2D,
  at: World2,
  toward: World2,
  side: number,
  lineW: number,
): void {
  const b = bearing(at, toward);
  // Circumradius of an equilateral triangle.
  const r = side / Math.sqrt(3);
  ctx.lineWidth = lineW;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    // One vertex points along the bearing to the first control, per ISOM.
    const a = b + (k * 2 * Math.PI) / 3;
    const x = at.x + Math.sin(a) * r;
    const z = at.z - Math.cos(a) * r;
    if (k === 0) ctx.moveTo(x, z);
    else ctx.lineTo(x, z);
  }
  ctx.closePath();
  ctx.stroke();
}

/**
 * Control numbers, placed so they clear both the circle and the connecting
 * lines. ISOM requires the number not to obscure map detail either, so we pick
 * the least-cluttered of eight candidate positions around the circle.
 */
function drawControlNumbers(
  ctx: CanvasRenderingContext2D,
  course: Course,
  radius: number,
  height: number,
): void {
  ctx.fillStyle = ISOM.purple.hex;
  ctx.font = `${height}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const pts: World2[] = [course.start, ...course.controls.map((c) => c.position), course.finish];

  course.controls.forEach((c, idx) => {
    const prev = pts[idx]!;
    const next = pts[idx + 2] ?? course.finish;
    // Put the number opposite the average direction of the two legs, so it
    // never sits on top of a connecting line.
    const away =
      Math.atan2(
        -(prev.x - c.position.x) - (next.x - c.position.x),
        (prev.z - c.position.z) + (next.z - c.position.z),
      ) + Math.PI;
    const d = radius + height * 0.85;
    ctx.fillText(
      String(idx + 1),
      c.position.x + Math.sin(away) * d,
      c.position.z - Math.cos(away) * d,
    );
  });
}

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

/**
 * The thumb.
 *
 * This marks the athlete's *believed* position, not their true one. It is
 * drawn as a thumb-shaped bracket rather than a dot precisely so it never reads
 * as a GPS fix — it is where you last knew you were, carried forward.
 */
function drawThumb(ctx: CanvasRenderingContext2D, at: World2, pxPerM: number): void {
  const r = 6 / pxPerM;
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.6 / pxPerM;
  ctx.beginPath();
  ctx.arc(at.x, at.z, r, Math.PI * 0.15, Math.PI * 1.85);
  ctx.stroke();
}

/**
 * Degrade the map toward the edges as Focus falls.
 *
 * This is how low Focus is *felt* rather than read: the centre stays legible,
 * the periphery goes soft, and planning a long route choice becomes genuinely
 * harder. A number on a bar would communicate the same fact and none of the
 * experience.
 */
function applyClarityFalloff(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  clarity: number,
): void {
  const inner = 0.18 + 0.55 * clarity;
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * inner,
    w / 2,
    h / 2,
    Math.hypot(w, h) * 0.55,
  );
  const strength = (1 - clarity) * 0.85;
  g.addColorStop(0, 'rgba(244,241,232,0)');
  g.addColorStop(1, `rgba(244,241,232,${strength.toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** The compass needle overlay — fixed to the screen, not the map. */
function drawCompassNeedle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  held: number,
  mapRotation: number,
): void {
  const cx = w - 42;
  const cy = h - 42;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(held - mapRotation);
  ctx.strokeStyle = ISOM.purple.hex;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 22);
  ctx.lineTo(0, -22);
  ctx.moveTo(-6, -14);
  ctx.lineTo(0, -22);
  ctx.lineTo(6, -14);
  ctx.stroke();
  ctx.restore();
}

/** Control positions for the description sheet, in course order. */
export function controlsInOrder(course: Course): Control[] {
  return course.controls;
}
