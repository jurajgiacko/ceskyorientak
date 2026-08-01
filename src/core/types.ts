/**
 * Shared domain types for ORIENTAK: VYŠŠÍ BROD.
 *
 * This file is the contract between the independently-developed subsystems
 * (terrain, map renderer, 3D world, nutrition, UI, audio). Change it
 * deliberately — everything downstream depends on these shapes.
 *
 * Coordinate conventions, stated once:
 *   - `Geo`    — WGS84 lon/lat degrees. Only used at pipeline boundaries.
 *   - `World`  — metres, local tangent plane, origin at the venue anchor.
 *                x = east, y = up, z = south.  (Right-handed, matches three.js:
 *                three's -z is north, so z = south keeps north as -z.)
 *   - `Map`    — millimetres on the printed map at its nominal scale.
 *                World→Map is a pure scale by 1000/scaleDenominator.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** WGS84 geographic position. */
export interface Geo {
  lon: number;
  lat: number;
}

/** Local metric position. y is up; omit it for planimetric work. */
export interface World {
  x: number;
  y: number;
  z: number;
}

/** Planimetric local position in metres (x east, z south). */
export interface World2 {
  x: number;
  z: number;
}

export type Vec2 = readonly [number, number];

/** Axis-aligned bounds in local metres. */
export interface Bounds2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

// ---------------------------------------------------------------------------
// Venue & terrain
// ---------------------------------------------------------------------------

export type VenueId = 'martinkov' | 'krumlov';

/** Anchor that ties a venue's local metric frame to the real world. */
export interface VenueAnchor {
  id: VenueId;
  /** Geographic origin of the local frame (World 0,0,0 sits here, at terrain height). */
  origin: Geo;
  /** Size of the playable area in metres. */
  sizeX: number;
  sizeZ: number;
  /** Nominal map scale denominator: 15000 / 10000 for forest, 4000 for sprint. */
  mapScale: number;
  /** Contour interval in metres (5 m forest, 2 m sprint typically). */
  contourInterval: number;
}

/**
 * ISOM/ISSprOM runnability classes. The numeric value is the *speed multiplier*
 * applied to base running speed — this is deliberately encoded in the enum so
 * the physics and the map renderer cannot drift apart.
 *
 * Authoritative source and calibration: docs/RESEARCH-SPORT.md §8.
 */
export enum Runnability {
  /** Paved / road — ISOM 502-503. */
  Road = 0,
  /** Path / track — ISOM 504-508. */
  Path = 1,
  /** Open land, ISOM 401 — fast. */
  OpenFast = 2,
  /** Rough open land, ISOM 403 — tussocks, heather. */
  OpenRough = 3,
  /** White: normal runnable forest — ISOM 405. */
  ForestOpen = 4,
  /** Light green: ~75% speed — ISOM 406 (undergrowth, slow run). */
  Green1 = 5,
  /** Medium green: ~50% speed — ISOM 408 (walk). */
  Green2 = 6,
  /** Dark green: ~20% speed — ISOM 410 ("fight"). */
  Green3 = 7,
  /** Marsh — ISOM 310. Slow, and drains hydration harder. */
  Marsh = 8,
  /** Bare rock / boulder field — ISOM 210-215. Slow and ankle-risky. */
  Rock = 9,
  /** Impassable: cliff, uncrossable water, wall, out-of-bounds. Blocks movement. */
  Impassable = 10,
}

/** Terrain sample at a point — what the physics layer needs to move the athlete. */
export interface TerrainSample {
  /** Elevation in metres above the local datum. */
  height: number;
  /** Uphill gradient along the direction of travel, as dh/ds (dimensionless). */
  slope: number;
  runnability: Runnability;
  /** Surface material, drives footstep audio and particle response. */
  ground: GroundType;
}

export type GroundType =
  | 'needles'
  | 'leaf'
  | 'grass'
  | 'rock'
  | 'marsh'
  | 'gravel'
  | 'cobble'
  | 'asphalt'
  | 'water';

// ---------------------------------------------------------------------------
// Course & controls
// ---------------------------------------------------------------------------

export type Discipline = 'sprint' | 'middle' | 'long' | 'qualification' | 'relay';

/**
 * An IOF control description, columns A–H.
 * Symbol identifiers follow the IOF Control Descriptions spec; see
 * docs/RESEARCH-SPORT.md §3 for the full table and the SVG geometry.
 */
export interface ControlDescription {
  /** Column A — control sequence number. */
  a: number;
  /** Column B — control code, 31..999 by convention. */
  b: number;
  /** Column C — which of any similar features (e.g. 'NW', 'upper'). */
  c?: string;
  /** Column D — the feature itself. Required. */
  d: string;
  /** Column E — appearance / second feature. */
  e?: string;
  /** Column F — dimensions or combination. */
  f?: string;
  /** Column G — location of the marker relative to the feature. */
  g?: string;
  /** Column H — other information (refreshment, first aid, crossing point). */
  h?: string;
}

export interface Control {
  /** Stable id, unique within a course. */
  id: string;
  /** Punching code shown on the flag and in column B. */
  code: number;
  position: World2;
  description: ControlDescription;
  /** Radius in metres within which a SIAC registers a punch. */
  punchRadius: number;
}

export interface Course {
  id: string;
  venue: VenueId;
  discipline: Discipline;
  /** Straight-line course length in metres, start→controls→finish. */
  lengthM: number;
  /** Total climb in metres, per IOF measurement convention. */
  climbM: number;
  start: World2;
  finish: World2;
  controls: Control[];
  /** Expected elite winning time in seconds — used to calibrate the field. */
  expectedWinningTimeS: number;
  /** Deterministic seed; identical seed ⇒ identical course. */
  seed: number;
}

// ---------------------------------------------------------------------------
// Athlete state — the four stats the Enervit system drives
// ---------------------------------------------------------------------------

/**
 * All four are normalised 0..1. See docs/NUTRITION_PROTOCOL.md for the
 * depletion model and the product→stat mapping.
 */
export interface AthleteStats {
  /** Muscle + liver glycogen. Empty ⇒ the wall: hard speed cap. */
  glycogen: number;
  /** Body water. Low ⇒ cramp risk and forced pace drop. */
  hydration: number;
  /** Blood glucose. Spikes and crashes; drives short-term power. */
  bloodSugar: number;
  /**
   * Cognitive focus. Degrades *navigation*, never raw speed:
   * map legibility, description parsing, compass drift, dead-reckoning error,
   * and parallel-error probability.
   */
  focus: number;
}

/** Live per-frame athlete state during a race. */
export interface AthleteState {
  stats: AthleteStats;
  position: World2;
  /** Heading in radians, 0 = north, clockwise positive. */
  heading: number;
  /** Ground speed in m/s. */
  speed: number;
  /** Accumulated race time in seconds. */
  timeS: number;
  /**
   * The athlete's *belief* about their own position — this is what the map
   * shows. Diverges from `position` through dead reckoning; a punch resets it.
   */
  believedPosition: World2;
  /** Current dead-reckoning error magnitude in metres, for UI feedback. */
  navErrorM: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface Split {
  controlId: string;
  /** Elapsed time at this control, seconds from start. */
  elapsedS: number;
  /** Leg time from the previous control, seconds. */
  legS: number;
}

export interface RunResult {
  courseId: string;
  venue: VenueId;
  discipline: Discipline;
  /** Total time in seconds. */
  timeS: number;
  splits: Split[];
  /** True if every control was punched in order. A mispunch is a DSQ. */
  valid: boolean;
  mispunch?: { expected: string; got: string | null };
  /** ISO-8601 timestamp of the run. */
  at: string;
  /** Recorded route for ghost replay, downsampled. */
  route: RoutePoint[];
  /** Nutrition choices made, for the post-race card. */
  nutrition: NutritionLog;
}

export interface RoutePoint {
  t: number;
  x: number;
  z: number;
}

export interface NutritionLog {
  before: string[];
  during: { skuId: string; atS: number }[];
  after: string[];
}

// ---------------------------------------------------------------------------
// Persistence — one interface, LocalStore in MVP, FirebaseStore post-MVP
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  name: string;
  timeS: number;
  at: string;
  valid: boolean;
}

export interface CareerProgress {
  /** Course ids completed, in order. */
  completed: string[];
  /** Cumulative World Cup points. */
  points: number;
  /** Carry-over stats into the next race day, set by the recovery phase. */
  carryOver: AthleteStats;
  locale: Locale;
}

export interface ScoreStore {
  submitRun(result: RunResult): Promise<void>;
  getLeaderboard(courseId: string, limit?: number): Promise<LeaderboardEntry[]>;
  getPersonalBests(): Promise<Record<string, RunResult>>;
  /** Best run for a course, used as the ghost. */
  getGhost(courseId: string): Promise<RunResult | null>;
  saveProgress(p: CareerProgress): Promise<void>;
  loadProgress(): Promise<CareerProgress | null>;
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

export type Locale = 'cs' | 'en' | 'sk';
export const LOCALES: readonly Locale[] = ['cs', 'en', 'sk'] as const;
