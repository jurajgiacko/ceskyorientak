/**
 * IOF control description pictograms, drawn as real vectors.
 *
 * Source: **IOF Control Descriptions 2024**. The pictograms are embedded in the
 * IOF PDF as raster images, so no official vector source exists — these are
 * geometric reconstructions from the published descriptions, accurate enough to
 * redraw. See docs/RESEARCH-SPORT.md §3, which also lists the open-source
 * implementations (Purple Pen, OCAD, OpenOrienteering Mapper) to cross-check
 * against.
 *
 * Drawing conventions, applied uniformly:
 *   - viewBox `0 0 100 100`, symbol inside the central ~64×64 (margin ≈ 18)
 *   - stroke-width ≈ 7–8, round caps and joins, `fill="none"` unless stated
 *   - pure black on white
 *   - direction-bearing symbols are ONE base path rotated in 45° steps:
 *     N = 0°, NE = 45°, E = 90° … NW = 315°
 *
 * The sheet itself is not decoration — Rule 18.3 requires descriptions on the
 * front of the map, and column B codes must be >30 (Rule 19.6). Both are
 * enforced below.
 */

export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

const DIRECTION_DEG: Readonly<Record<Direction, number>> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export interface Pictogram {
  /** IOF reference, e.g. '1.3'. */
  ref: string;
  nameEn: string;
  nameCs: string;
  /** SVG path/shape markup, in the 0 0 100 100 viewBox. */
  body: string;
  /** True if this symbol encodes a compass direction by rotation. */
  rotatable?: boolean;
}

/** Shorthand: a stroked path. */
const p = (d: string, w = 7.5) =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Shorthand: a filled shape. */
const fill = (d: string) => `<path d="${d}" fill="#000" stroke="none"/>`;

const circleF = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/>`;

const ellipseS = (cx: number, cy: number, rx: number, ry: number, w = 7.5) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#000" stroke-width="${w}"/>`;

// ---------------------------------------------------------------------------
// Column C — which of any similar feature
// ---------------------------------------------------------------------------

export const COLUMN_C: Record<string, Pictogram> = {
  direction: {
    ref: '0.1',
    nameEn: 'Northern',
    nameCs: 'severní',
    rotatable: true,
    // Shaft plus an open V arrowhead at the top.
    body: p('M50 82 L50 22') + p('M38 34 L50 20 L62 34'),
  },
  upper: {
    ref: '0.3',
    nameEn: 'Upper',
    nameCs: 'horní',
    body: p('M30 38 L70 38') + p('M30 62 L70 62') + circleF(50, 38, 6),
  },
  lower: {
    ref: '0.4',
    nameEn: 'Lower',
    nameCs: 'dolní',
    body: p('M30 38 L70 38') + p('M30 62 L70 62') + circleF(50, 62, 6),
  },
  middle: {
    ref: '0.5',
    nameEn: 'Middle',
    nameCs: 'prostřední',
    body:
      p('M32 25 L32 75') + p('M50 25 L50 75') + p('M68 25 L68 75') + circleF(50, 50, 6),
  },
};

// ---------------------------------------------------------------------------
// Column D — the control feature
// ---------------------------------------------------------------------------

/**
 * Landforms, rock, water, vegetation and man-made features.
 *
 * Column D takes **exactly one** symbol, never two — that rule is enforced by
 * the type in `src/core/types.ts`, where `d` is a single string.
 */
export const COLUMN_D: Record<string, Pictogram> = {
  // --- landforms ---------------------------------------------------------
  reentrant: {
    ref: '1.3',
    nameEn: 'Re-entrant',
    nameCs: 'údolíčko',
    // Inverted U. The single most common forest control feature.
    body: p('M32 85 L32 52 A18 18 0 0 1 68 52 L68 85'),
  },
  spur: {
    ref: '1.2',
    nameEn: 'Spur',
    nameCs: 'terénní hrana',
    // A nose projecting right, with the slope line at the left. Must read as
    // the complement of the re-entrant's inverted-U, not as a letter "P" —
    // an earlier reconstruction did exactly that.
    body: p('M26 18 L26 82') + p('M36 26 L54 26 A24 24 0 0 1 54 74 L36 74'),
  },
  earthBank: {
    ref: '1.4',
    nameEn: 'Earth bank',
    nameCs: 'sráz',
    body:
      p('M22 58 A34 34 0 0 1 78 58') +
      p('M30 50 L27 66', 5) +
      p('M43 42 L41 58', 5) +
      p('M57 42 L59 58', 5) +
      p('M70 50 L73 66', 5),
  },
  erosionGully: {
    ref: '1.7',
    nameEn: 'Erosion gully',
    nameCs: 'rýha',
    body: p('M32 80 L50 26 L68 80'),
  },
  hill: {
    ref: '1.9',
    nameEn: 'Hill',
    nameCs: 'kupa',
    body: ellipseS(50, 50, 32, 20),
  },
  knoll: {
    ref: '1.10',
    nameEn: 'Knoll',
    nameCs: 'hrbek',
    body: circleF(50, 50, 14),
  },
  saddle: {
    ref: '1.11',
    nameEn: 'Saddle',
    nameCs: 'sedlo',
    body: p('M34 22 A26 26 0 0 0 34 78') + p('M66 22 A26 26 0 0 1 66 78'),
  },
  depression: {
    ref: '1.12',
    nameEn: 'Depression',
    nameCs: 'prohlubeň',
    body: ellipseS(50, 50, 32, 20) + p('M18 50 L34 50', 6),
  },
  smallDepression: {
    ref: '1.13',
    nameEn: 'Small depression',
    nameCs: 'jáma',
    body: p('M30 30 L30 56 A20 20 0 0 0 70 56 L70 30'),
  },
  pit: {
    ref: '1.14',
    nameEn: 'Pit',
    nameCs: 'jamka',
    body: p('M28 28 L50 80 L72 28'),
  },
  brokenGround: {
    ref: '1.15',
    nameEn: 'Broken ground',
    nameCs: 'rozbité půdy',
    // Scattered small pit marks. Deliberately offset and unevenly sized:
    // an evenly-spaced two-up-one-below arrangement reads as a smiley face,
    // which is exactly what the first reconstruction produced.
    body:
      p('M24 38 A9 9 0 0 0 42 38', 6) +
      p('M52 30 A8 8 0 0 0 68 30', 6) +
      p('M34 62 A8 8 0 0 0 50 62', 6) +
      p('M60 56 A9 9 0 0 0 78 56', 6),
  },

  // --- rock and boulders --------------------------------------------------
  cliff: {
    ref: '2.1',
    nameEn: 'Cliff',
    nameCs: 'skalní stěna',
    body: p('M24 34 L76 34') + p('M30 34 L30 52', 5) + p('M45 34 L45 56', 5) + p('M60 34 L60 52', 5) + p('M72 34 L72 56', 5),
  },
  boulder: {
    ref: '2.4',
    nameEn: 'Boulder',
    nameCs: 'balvan',
    // A filled triangle. Reads instantly and is very common.
    body: fill('M50 26 L74 70 L26 70 Z'),
  },
  boulderField: {
    ref: '2.5',
    nameEn: 'Boulder field',
    nameCs: 'balvanité pole',
    body:
      fill('M36 28 L48 50 L24 50 Z') +
      fill('M68 30 L80 52 L56 52 Z') +
      fill('M50 54 L62 76 L38 76 Z'),
  },
  stonyGround: {
    ref: '2.7',
    nameEn: 'Stony ground',
    nameCs: 'kamenitá půda',
    body: circleF(34, 38, 6) + circleF(62, 34, 6) + circleF(44, 62, 6) + circleF(70, 62, 6),
  },
  cave: {
    ref: '2.9',
    nameEn: 'Cave',
    nameCs: 'jeskyně',
    body: p('M30 76 L30 46 A20 20 0 0 1 70 46 L70 76') + p('M22 76 L78 76'),
  },

  // --- water and marsh ----------------------------------------------------
  waterhole: {
    ref: '3.4',
    nameEn: 'Water hole',
    nameCs: 'vodní jáma',
    // The small-depression bowl WITH a water line across it. Without that line
    // it is pixel-identical to 1.13 Small depression, and two column-D symbols
    // that render the same is a real defect on a description sheet.
    body: p('M30 34 L30 58 A20 20 0 0 0 70 58 L70 34') + p('M34 56 L66 56', 6),
  },
  marsh: {
    ref: '3.6',
    nameEn: 'Marsh',
    nameCs: 'bažina',
    body: p('M24 40 L76 40') + p('M24 56 L76 56') + p('M32 68 L68 68'),
  },
  stream: {
    ref: '3.2',
    nameEn: 'Stream',
    nameCs: 'potok',
    body: p('M22 62 C36 40 48 78 62 52 C70 38 76 44 78 40'),
  },
  pond: {
    ref: '3.3',
    nameEn: 'Pond',
    nameCs: 'tůň',
    body: ellipseS(50, 50, 28, 18) + p('M32 58 L68 58', 5),
  },
  well: {
    ref: '3.8',
    nameEn: 'Well',
    nameCs: 'studna',
    body: p('M32 32 L68 32 L68 72 L32 72 Z') + p('M50 32 L50 72', 5),
  },

  // --- vegetation ---------------------------------------------------------
  openLand: {
    ref: '4.1',
    nameEn: 'Open land',
    nameCs: 'palouk',
    body: p('M26 30 L74 30 L74 70 L26 70 Z'),
  },
  clearing: {
    ref: '4.3',
    nameEn: 'Forest corner',
    nameCs: 'roh lesa',
    body: p('M26 26 L26 74 L74 74'),
  },
  thicket: {
    ref: '4.5',
    nameEn: 'Thicket',
    nameCs: 'hustník',
    body:
      p('M32 74 L32 44', 6) + p('M50 74 L50 34', 6) + p('M68 74 L68 44', 6) + p('M24 74 L76 74'),
  },
  distinctiveTree: {
    ref: '4.7',
    nameEn: 'Distinctive tree',
    nameCs: 'výrazný strom',
    body: circleF(50, 42, 15) + p('M50 57 L50 78', 6),
  },
  rootStock: {
    ref: '4.9',
    nameEn: 'Root stock',
    nameCs: 'vývrat',
    body: p('M28 70 L72 70') + p('M50 70 L50 44', 6) + p('M36 44 A16 16 0 0 1 64 44', 6),
  },

  // --- man-made -----------------------------------------------------------
  path: {
    ref: '5.5',
    nameEn: 'Path',
    nameCs: 'pěšina',
    body: p('M22 68 L78 34'),
  },
  ride: {
    ref: '5.7',
    nameEn: 'Ride',
    nameCs: 'průsek',
    body: p('M22 68 L78 34', 5) + p('M30 78 L86 44', 5),
  },
  bridge: {
    ref: '5.9',
    nameEn: 'Bridge',
    nameCs: 'most',
    body: p('M22 50 L78 50') + p('M34 34 L34 50', 5) + p('M66 34 L66 50', 5),
  },
  fence: {
    ref: '5.13',
    nameEn: 'Fence',
    nameCs: 'plot',
    body: p('M22 50 L78 50') + p('M34 34 L34 66', 5) + p('M50 34 L50 66', 5) + p('M66 34 L66 66', 5),
  },
  wall: {
    ref: '5.11',
    nameEn: 'Wall',
    nameCs: 'zeď',
    body: p('M22 40 L78 40') + p('M22 60 L78 60') + p('M40 40 L40 60', 5) + p('M62 40 L62 60', 5),
  },
  building: {
    ref: '5.15',
    nameEn: 'Building',
    nameCs: 'budova',
    body: fill('M28 34 L72 34 L72 72 L28 72 Z'),
  },
  ruin: {
    ref: '5.17',
    nameEn: 'Ruin',
    nameCs: 'zřícenina',
    body: p('M28 72 L28 40 L44 40') + p('M56 72 L56 48 L72 48 L72 72'),
  },
  tower: {
    ref: '5.21',
    nameEn: 'Tower',
    nameCs: 'věž',
    body: p('M32 74 L44 30 L56 30 L68 74') + p('M38 52 L62 52', 5),
  },
  monument: {
    ref: '5.23',
    nameEn: 'Monument',
    nameCs: 'pomník',
    body: p('M30 74 L70 74') + p('M38 74 L42 34 L58 34 L62 74'),
  },
  stairway: {
    ref: '5.25',
    nameEn: 'Stairway',
    nameCs: 'schodiště',
    body: p('M24 74 L40 74 L40 60 L56 60 L56 46 L72 46 L72 32', 6),
  },
};

// ---------------------------------------------------------------------------
// Column G — location of the control flag
// ---------------------------------------------------------------------------

export const COLUMN_G: Record<string, Pictogram> = {
  northSide: {
    ref: '9.1',
    nameEn: 'North side',
    nameCs: 'severní strana',
    rotatable: true,
    body: p('M26 62 L74 62') + circleF(50, 40, 8),
  },
  northEdge: {
    ref: '9.5',
    nameEn: 'North edge',
    nameCs: 'severní okraj',
    rotatable: true,
    body: p('M26 50 L74 50') + circleF(50, 34, 8),
  },
  foot: {
    ref: '9.11',
    nameEn: 'Foot',
    nameCs: 'pata',
    rotatable: true,
    body: p('M30 34 L30 66 L70 66') + circleF(48, 52, 8),
  },
  top: {
    ref: '9.13',
    nameEn: 'Top',
    nameCs: 'vrchol',
    body: p('M26 62 A24 24 0 0 1 74 62') + circleF(50, 34, 8),
  },
};

// ---------------------------------------------------------------------------
// Column H — other information
// ---------------------------------------------------------------------------

export const COLUMN_H: Record<string, Pictogram> = {
  firstAid: {
    ref: '13.1',
    nameEn: 'First aid post',
    nameCs: 'první pomoc',
    body: p('M50 28 L50 72', 12) + p('M28 50 L72 50', 12),
  },
  refreshment: {
    ref: '13.2',
    nameEn: 'Refreshment point',
    nameCs: 'občerstvení',
    body: p('M34 28 L66 28 L60 72 L40 72 Z') + p('M66 38 A10 10 0 0 1 66 56', 5),
  },
  radioControl: {
    ref: '13.4',
    nameEn: 'Radio or TV control',
    nameCs: 'rádiová kontrola',
    body: p('M50 72 L50 46') + p('M34 40 A22 22 0 0 1 66 40') + circleF(50, 38, 7),
  },
  mannedControl: {
    ref: '13.3',
    nameEn: 'Manned control',
    nameCs: 'obsazená kontrola',
    body: circleF(50, 34, 10) + p('M32 74 A18 18 0 0 1 68 74'),
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface SymbolRef {
  symbol: Pictogram;
  direction?: Direction;
}

/** Render one pictogram as a standalone SVG string. */
export function renderPictogram(ref: SymbolRef, sizePx = 28): string {
  const rot =
    ref.symbol.rotatable && ref.direction
      ? ` transform="rotate(${DIRECTION_DEG[ref.direction]} 50 50)"`
      : '';
  return (
    `<svg viewBox="0 0 100 100" width="${sizePx}" height="${sizePx}" ` +
    `role="img" aria-label="${ref.symbol.nameEn}">` +
    `<g${rot}>${ref.symbol.body}</g></svg>`
  );
}

/**
 * Validate a control code against Rule 19.6.
 *
 * "Numbers less than 31 must not be used." This is a real rule with a real
 * reason — low numbers collide with SI station function codes — and a generated
 * course that violates it is one of the first things an orienteer would notice.
 */
export function isValidControlCode(code: number): boolean {
  return Number.isInteger(code) && code > 30 && code <= 999;
}

/**
 * Rows are separated by a thicker rule after every third description, per the
 * sheet format. Exposed so the renderer and any export share one definition.
 */
export function isThickRuleAfter(rowIndex: number): boolean {
  return (rowIndex + 1) % 3 === 0;
}
