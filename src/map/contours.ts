/**
 * Contour generation from the heightmap, by marching squares.
 *
 * Contours are the single most information-dense thing on an orienteering map,
 * and the thing an orienteer reads first. Two properties matter more than
 * elegance here:
 *
 *  1. **Closed, continuous lines.** Broken contours are unreadable. The
 *     segment-joining pass exists for this and is not optional.
 *  2. **Correct index contours.** Every fifth contour is drawn thicker (ISOM
 *     102). Getting that wrong makes relief impossible to judge at a glance.
 *
 * The generator is deterministic — same heightmap in, same polylines out — so
 * the 2D map and the 3D terrain are guaranteed to agree about where a slope is.
 */

import type { World2 } from '@/core/types';

export interface Heightfield {
  data: Float32Array;
  width: number;
  height: number;
  /** Metres per cell. */
  cellSize: number;
  /** World position of cell (0,0). */
  originX: number;
  originZ: number;
  minH: number;
  maxH: number;
}

export interface Contour {
  /** Elevation of this line, metres. */
  level: number;
  /** True for every fifth contour — ISOM 102, drawn at double width. */
  index: boolean;
  /** True for a form line — ISOM 103, dashed, between full contours. */
  form: boolean;
  points: World2[];
}

/** Sample the field with clamping, so edge cells behave. */
function at(f: Heightfield, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= f.width ? f.width - 1 : x;
  const cy = y < 0 ? 0 : y >= f.height ? f.height - 1 : y;
  return f.data[cy * f.width + cx] ?? 0;
}

/** Linear interpolation of the crossing point along a cell edge. */
function lerp(a: number, b: number, level: number): number {
  const d = b - a;
  // Guard the degenerate case: a flat edge exactly at the level would divide
  // by zero and produce NaN vertices, which silently break the whole polyline.
  return Math.abs(d) < 1e-9 ? 0.5 : (level - a) / d;
}

/**
 * Extract contours at a fixed interval.
 *
 * @param interval  contour interval in metres — 5 m for the forest at 1:10000,
 *                  2 m for the sprint at 1:4000.
 */
export function generateContours(f: Heightfield, interval: number): Contour[] {
  const out: Contour[] = [];
  const first = Math.ceil(f.minH / interval) * interval;

  for (let level = first; level <= f.maxH; level += interval) {
    const segments = marchingSquares(f, level);
    if (segments.length === 0) continue;

    // ISOM 102: every fifth contour is an index contour. Anchored to absolute
    // elevation, not to the loop counter, so index contours land on round
    // heights (600, 625, 650…) exactly as a printed map does.
    const isIndex = Math.abs((level / (interval * 5)) % 1) < 1e-6;

    for (const points of joinSegments(segments, f.cellSize)) {
      if (points.length < 3) continue;
      out.push({ level, index: isIndex, form: false, points });
    }
  }
  return out;
}

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Marching squares over the grid.
 *
 * Cases 5 and 10 are the saddle ambiguity — two valid resolutions, and picking
 * arbitrarily produces contours that cross each other. We disambiguate on the
 * cell-centre average, which is the standard resolution and keeps lines nested.
 */
function marchingSquares(f: Heightfield, level: number): Segment[] {
  const segs: Segment[] = [];

  for (let y = 0; y < f.height - 1; y++) {
    for (let x = 0; x < f.width - 1; x++) {
      const tl = at(f, x, y);
      const tr = at(f, x + 1, y);
      const br = at(f, x + 1, y + 1);
      const bl = at(f, x, y + 1);

      let code = 0;
      if (tl > level) code |= 8;
      if (tr > level) code |= 4;
      if (br > level) code |= 2;
      if (bl > level) code |= 1;
      if (code === 0 || code === 15) continue;

      // Crossing points on each edge, in cell-local coordinates.
      const top = { x: x + lerp(tl, tr, level), y };
      const right = { x: x + 1, y: y + lerp(tr, br, level) };
      const bottom = { x: x + lerp(bl, br, level), y: y + 1 };
      const left = { x, y: y + lerp(tl, bl, level) };

      const push = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });

      switch (code) {
        case 1:
        case 14:
          push(left, bottom);
          break;
        case 2:
        case 13:
          push(bottom, right);
          break;
        case 3:
        case 12:
          push(left, right);
          break;
        case 4:
        case 11:
          push(top, right);
          break;
        case 6:
        case 9:
          push(top, bottom);
          break;
        case 7:
        case 8:
          push(left, top);
          break;
        case 5:
        case 10: {
          // Saddle. Resolve on the centre average so lines never cross.
          const centre = (tl + tr + br + bl) / 4;
          const centreAbove = centre > level;
          if ((code === 5) === centreAbove) {
            push(left, top);
            push(bottom, right);
          } else {
            push(left, bottom);
            push(top, right);
          }
          break;
        }
      }
    }
  }
  return segs;
}

/**
 * Join loose segments into continuous polylines.
 *
 * Marching squares emits unordered segments; drawn as-is they look correct at a
 * glance but cannot be styled (dash patterns restart, index weight flickers)
 * and are far more expensive to render. Joining is what makes them a map.
 *
 * Uses a spatial hash on endpoints — quadratic matching is unusable at the grid
 * sizes we work with (a 2 km venue at 2 m is 1000×1000 cells).
 */
function joinSegments(segs: Segment[], cellSize: number): World2[][] {
  const KEY = 1e4;
  const key = (x: number, y: number) => `${Math.round(x * KEY)},${Math.round(y * KEY)}`;

  // Index BOTH endpoints, not just the start.
  //
  // Marching squares emits segments in whatever winding each cell case implies,
  // so a neighbour that continues the line may join by either of its ends.
  // Indexing only `a` misses about half of all connections — which fragments
  // long contours into short dashes that look like noise on the map.
  const ends = new Map<string, Segment[]>();
  const index = (k: string, s: Segment) => {
    const list = ends.get(k);
    if (list) list.push(s);
    else ends.set(k, [s]);
  };
  for (const s of segs) {
    index(key(s.ax, s.ay), s);
    index(key(s.bx, s.by), s);
  }

  const used = new Set<Segment>();
  const lines: World2[][] = [];

  /** Follow the chain from `pt`, appending to `into`. Returns when it dead-ends. */
  const walk = (pt: { x: number; y: number }, into: { x: number; y: number }[]) => {
    let cur = pt;
    for (;;) {
      const cand = ends.get(key(cur.x, cur.y))?.find((c) => !used.has(c));
      if (!cand) return;
      used.add(cand);
      // Continue from whichever end of the candidate is NOT the one we matched.
      const atA = key(cand.ax, cand.ay) === key(cur.x, cur.y);
      const next = atA ? { x: cand.bx, y: cand.by } : { x: cand.ax, y: cand.ay };
      into.push(next);
      cur = next;
      // Closed ring — stop before going round twice.
      if (key(cur.x, cur.y) === key(into[0]!.x, into[0]!.y)) return;
    }
  };

  for (const seed of segs) {
    if (used.has(seed)) continue;
    used.add(seed);

    const forward: { x: number; y: number }[] = [{ x: seed.bx, y: seed.by }];
    walk({ x: seed.bx, y: seed.by }, forward);

    // Also walk backwards from the seed's other end, otherwise a seed picked
    // from the middle of a contour yields only half of it.
    const backward: { x: number; y: number }[] = [{ x: seed.ax, y: seed.ay }];
    walk({ x: seed.ax, y: seed.ay }, backward);

    const pts = backward.reverse().concat(forward);
    lines.push(pts.map((p) => ({ x: p.x * cellSize, z: p.y * cellSize })));
  }
  return lines;
}

/**
 * Chaikin smoothing.
 *
 * Raw marching-squares output is visibly stair-stepped along grid axes, which
 * reads as a rendering artefact rather than terrain. Two iterations is enough
 * to look hand-drawn without displacing the line meaningfully — important,
 * because the contour has to keep agreeing with the 3D terrain it came from.
 */
export function smoothContour(points: World2[], iterations = 2): World2[] {
  let pts = points;
  const closed =
    pts.length > 2 &&
    Math.abs(pts[0]!.x - pts[pts.length - 1]!.x) < 1e-6 &&
    Math.abs(pts[0]!.z - pts[pts.length - 1]!.z) < 1e-6;

  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const next: World2[] = [];
    if (!closed) next.push(pts[0]!);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    if (closed) next.push(next[0]!);
    else next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

/**
 * Drop contours shorter than a threshold.
 *
 * Tiny fragments are almost always noise in the LiDAR rather than real
 * landform, and a mapper would not draw them. Keeping them makes the map look
 * grainy and untrustworthy.
 */
export function pruneContours(contours: Contour[], minLengthM = 12): Contour[] {
  return contours.filter((c) => {
    let len = 0;
    for (let i = 1; i < c.points.length; i++) {
      const a = c.points[i - 1]!;
      const b = c.points[i]!;
      len += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return len >= minLengthM;
  });
}
