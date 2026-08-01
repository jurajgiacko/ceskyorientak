/**
 * ISOM 2017-2 / ISSprOM 2019-2 colour system.
 *
 * Source: IOF *Printing and Colour Definitions* **Rev 4, September 2024** —
 * the normative document, read in full. The IOF publishes **CMYK only**; the
 * sRGB values below are a Euroscale Coated v2 → sRGB relative-colorimetric
 * conversion, i.e. what a printed orienteering map actually looks like, rather
 * than the naive `255*(1-c)*(1-k)` conversion that makes maps look like
 * highlighter pen.
 *
 * Three traps, all of which ship in real software today. An orienteer or an
 * IOF mapper will spot any of them instantly:
 *
 *  1. **Brown changed in September 2024**, from `0/56/100/18` to
 *     `25/75/100/0`. Anything older is the wrong brown.
 *  2. **Green is `80/0/100/0`**, not `76/0/91/0` — the latter is still shipped
 *     by OpenOrienteering Mapper.
 *  3. **The ISOM control circle is ø 5.0 mm**, not 6.0. ISSprOM's *is* 6.0.
 *     Copying the sprint value onto a forest map is a classic error.
 *
 * See docs/RESEARCH-SPORT.md §1.3 for the full table and provenance.
 */

/** A map colour, carrying its normative CMYK alongside the derived screen value. */
export interface MapColour {
  readonly name: string;
  /** Normative CMYK, 0–100. This is the authority; hex is derived from it. */
  readonly cmyk: readonly [number, number, number, number];
  /** Euroscale Coated v2 → sRGB. Derived, not IOF-normative. */
  readonly hex: string;
}

const c = (
  name: string,
  cmyk: readonly [number, number, number, number],
  hex: string,
): MapColour => ({ name, cmyk, hex });

export const ISOM = {
  // --- Course overprint -----------------------------------------------------
  /** The colour of the sport. Start triangle, circles, lines, finish. */
  purple: c('Purple for course overprint', [35, 85, 0, 0], '#B24996'),
  purple50: c('Purple 50% area', [18, 43, 0, 0], '#D3A2C8'),

  // --- Black: rock and man-made --------------------------------------------
  black: c('Black 100%', [0, 0, 0, 100], '#000000'),
  /** ISOM 521 — buildings larger than 75×75 m. */
  black50: c('Black 50%', [0, 0, 0, 50], '#9B9A9E'),
  /** ISOM 214 — bare rock. */
  black35: c('Black 35%', [0, 0, 0, 35], '#BABCBF'),
  /** ISOM 522 — canopy. */
  black20: c('Black 20%', [0, 0, 0, 20], '#D9DBDD'),

  // --- Blue: water ----------------------------------------------------------
  blue: c('Blue 100%', [100, 0, 0, 0], '#00A9EB'),
  blue70: c('Blue 70%', [70, 0, 0, 0], '#3DC0F1'),
  blue50: c('Blue 50%', [50, 0, 0, 0], '#85D1F4'),
  blue30: c('Blue 30%', [30, 0, 0, 0], '#BDE5F9'),

  // --- Brown: landforms. NOTE the Sept 2024 values. -------------------------
  brown: c('Brown 100%', [25, 75, 100, 0], '#C65E2A'),
  brown50: c('Brown 50%', [10, 35, 50, 0], '#E5B182'),
  brown30: c('Brown 30%', [6, 23, 33, 0], '#EFCCAD'),

  // --- Green: vegetation ----------------------------------------------------
  /** ISOM 416 green-line variant; ISSprOM 411. */
  darkGreen: c('Dark green', [100, 0, 80, 30], '#007D54'),
  /** "Fight" — ISOM 410. */
  green: c('Green 100%', [80, 0, 100, 0], '#43AA3A'),
  /** Walk — ISOM 408. */
  green60: c('Green 60%', [48, 0, 60, 0], '#9AC983'),
  /** Slow run — ISOM 406. */
  green30: c('Green 30%', [24, 0, 30, 0], '#CFE5C4'),

  // --- Yellow: open land ----------------------------------------------------
  yellow: c('Yellow 100%', [0, 27, 79, 0], '#FAC14C'),
  yellow75: c('Yellow 75%', [0, 20, 59, 0], '#FBD179'),

  /** Out of bounds. Printed as yellow 100% *over* green 50%, not as a flat ink. */
  olive: c('Olive green', [38, 27, 100, 0], '#B5A722'),

  /**
   * Runnable forest. Not a printed ink — it is the paper showing through.
   * Note this is the **80–100% runnability** band, not 100%: white does not
   * mean "as fast as a road", it means "runnable at near full speed".
   */
  white: c('White (paper)', [0, 0, 0, 0], '#FFFFFF'),
} as const;

/**
 * Canvas painting order.
 *
 * Derived from the normative *colour order* table, which is a printing order —
 * lower entries are printed first and therefore sit underneath. Painting in
 * this order is what makes overprint behave correctly, in particular the
 * upper/lower purple split: some purple sits *below* the black detail so that
 * a control circle never hides a boulder, and some sits above.
 */
export const PAINT_ORDER: readonly (keyof typeof ISOM)[] = [
  'white',
  'yellow',
  'yellow75',
  'green30',
  'green60',
  'green',
  'darkGreen',
  'olive',
  'blue30',
  'blue50',
  'blue70',
  'blue',
  'brown30',
  'brown50',
  'brown',
  'black20',
  'black35',
  'black50',
  'purple50',
  'black',
  'purple',
] as const;

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * Course overprint dimensions, in **millimetres at map scale**.
 *
 * The scale distinction matters: at 1:15000 a 5 mm circle covers 75 m of
 * ground; at 1:4000 a 6 mm circle covers 24 m.
 */
export const OVERPRINT = {
  isom: {
    /** ø 5.0 mm — NOT 6.0. That is the sprint value. */
    controlCircleDiameterMm: 5.0,
    lineWidthMm: 0.35,
    /** Equilateral, side length. */
    startTriangleSideMm: 7.0,
    /** Finish is a double circle. */
    finishOuterMm: 7.0,
    finishInnerMm: 5.0,
    /** Control number height. */
    numberHeightMm: 4.0,
  },
  issprom: {
    controlCircleDiameterMm: 6.0,
    lineWidthMm: 0.35,
    startTriangleSideMm: 6.0,
    finishOuterMm: 7.0,
    finishInnerMm: 5.0,
    numberHeightMm: 4.0,
  },
} as const;

/**
 * Gap left where a circle or connecting line would obscure map detail.
 *
 * ISOM mandates the gap but gives **no number** — this is our estimate, and it
 * is flagged as such rather than presented as spec. Course-setting software
 * uses comparable values.
 */
export const OVERPRINT_GAP_MM = 1.0;

// ---------------------------------------------------------------------------
// Runnability ↔ symbol
// ---------------------------------------------------------------------------

import { Runnability } from '@/core/types';

/**
 * The single mapping from a terrain runnability class to the ink used to draw
 * it. This is the join that keeps the map honest: the renderer and the physics
 * read the same enum, so the map cannot promise a green it does not deliver.
 *
 * Runnability percentages are the ISOM definitions:
 *   white   80–100%   green30 ~60%   green60 ~40%   green100 <20% ("fight")
 */
export const RUNNABILITY_COLOUR: Readonly<Record<Runnability, MapColour>> = {
  [Runnability.Road]: ISOM.brown50,
  [Runnability.Path]: ISOM.black,
  [Runnability.OpenFast]: ISOM.yellow,
  [Runnability.OpenRough]: ISOM.yellow75,
  [Runnability.ForestOpen]: ISOM.white,
  [Runnability.Green1]: ISOM.green30,
  [Runnability.Green2]: ISOM.green60,
  [Runnability.Green3]: ISOM.green,
  [Runnability.Marsh]: ISOM.blue,
  [Runnability.Rock]: ISOM.black35,
  [Runnability.Impassable]: ISOM.olive,
};

/** ISOM symbol number for each class, for the legend and for map export. */
export const RUNNABILITY_SYMBOL: Readonly<Record<Runnability, string>> = {
  [Runnability.Road]: '502',
  [Runnability.Path]: '505',
  [Runnability.OpenFast]: '401',
  [Runnability.OpenRough]: '403',
  [Runnability.ForestOpen]: '405',
  [Runnability.Green1]: '406',
  [Runnability.Green2]: '408',
  [Runnability.Green3]: '410',
  [Runnability.Marsh]: '310',
  [Runnability.Rock]: '214',
  [Runnability.Impassable]: '520',
};

/** Convert normative CMYK to sRGB the naive way — for comparison/debug only. */
export function naiveCmykToRgb(cmyk: readonly [number, number, number, number]): string {
  const [cy, m, y, k] = cmyk.map((v) => v / 100) as [number, number, number, number];
  const r = Math.round(255 * (1 - cy) * (1 - k));
  const g = Math.round(255 * (1 - m) * (1 - k));
  const b = Math.round(255 * (1 - y) * (1 - k));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
