/**
 * Venue definitions.
 *
 * The forest AOI is a **deliberate, switchable choice** — read `FOREST_AOI`
 * below before changing it, and see docs/DECISIONS.md D-015. This is the one
 * config value in the project with a reputational dimension rather than only a
 * technical one.
 */

import type { VenueAnchor, VenueId } from './types';

/**
 * Forest area of interest.
 *
 * The World Cup races run in an embargoed area around the abandoned village of
 * Martínkov. The embargo (213-vertex KML published by the organisers, ~51.4 km²)
 * restricts *physical access by competitors* — it places no restriction on
 * ČÚZK open data, which is CC BY 4.0.
 *
 * But a navigable, photoreal model of the actual competition terrain, published
 * before the races, delivers precisely the terrain familiarity the embargo
 * exists to deny. Legal and appropriate are not the same test.
 *
 * So the default AOI is **Lachovice** — one of four areas the organisers
 * themselves designated as *permitted training terrain* inside the same KML.
 * This is not a compromise:
 *
 *  - It is genuinely the same landscape: same granite, same spruce, same
 *    Vltava-valley relief, ~3 km from the competition area, and it comes from
 *    the same DMR 5G source at the same 2 m resolution.
 *  - It is where the athletes are actually allowed to train, so building the
 *    game there is aligned with the embargo's intent rather than tolerated by
 *    its letter.
 *  - It costs the player nothing. Nobody outside the sport can tell, and
 *    everybody inside it will recognise why we did it.
 *
 * `MARTINKOV_AOI` is kept ready. After the final race on 9 August 2026 the
 * embargo lapses, and switching to it is a one-line change plus a pipeline
 * re-run.
 */
/**
 * Origin note: the first value picked here (14.2536, 48.6229) was wrong — it
 * sat on a street in Loučovice, in the Vltava valley, rather than in the
 * training terrain. The 3D scene had to hunt for a spawn point to compensate.
 *
 * This origin was chosen from the data instead of the map: scoring every
 * 400 m-radius window of the built runnability raster for forest classes
 * against roads and out-of-bounds. It scores **98.7% forest, 0% road or
 * out-of-bounds**, against roughly 50% for the original point.
 */
export const LACHOVICE_AOI: VenueAnchor = {
  id: 'martinkov',
  origin: { lon: 14.25564, lat: 48.62695 },
  sizeX: 2000,
  sizeZ: 2000,
  mapScale: 10000,
  contourInterval: 5,
};

/** The real competition area. Do not enable before 9 August 2026. */
export const MARTINKOV_AOI: VenueAnchor = {
  id: 'martinkov',
  origin: { lon: 14.2913, lat: 48.6008 },
  sizeX: 2000,
  sizeZ: 2000,
  mapScale: 10000,
  contourInterval: 5,
};

/**
 * Český Krumlov, for the sprint.
 *
 * Note a correction to the original brief: the World Cup itself has **no
 * sprint** — it is four forest races at Martínkov. Český Krumlov hosts the
 * separate GAPP Czech O-Tour Prologue, at 1:4000 under ISSprOM 2019-2. We
 * still build it, because it is the better showcase venue and a genuinely
 * different kind of orienteering; we just describe it accurately.
 *
 * The old town is not embargoed — it is a public UNESCO site mapped in detail
 * by OSM (5973 elements in our AOI, against 133 for the forest).
 */
export const KRUMLOV_AOI: VenueAnchor = {
  id: 'krumlov',
  origin: { lon: 14.315, lat: 48.8109 },
  sizeX: 1200,
  sizeZ: 1200,
  mapScale: 4000,
  contourInterval: 2,
};

export const VENUES: Readonly<Record<VenueId, VenueAnchor>> = {
  martinkov: LACHOVICE_AOI,
  krumlov: KRUMLOV_AOI,
};

export function getVenue(id: VenueId): VenueAnchor {
  return VENUES[id];
}

/**
 * The course each venue races.
 *
 * **One course per venue, chosen deliberately, and it does not move.**
 *
 * It used to be `(Date.now() / 60000) | 0`, which gave a new course every
 * minute. The intent was "a fresh course every few minutes, and the same course
 * for everyone starting within the same minute", and it was wrong in a way that
 * quietly removed the point of the game: a real event has *one* course, you
 * learn it, and a second run on it is a comparison rather than a different
 * race. It also meant `LocalStore` — which keys personal bests and ghosts by
 * `course.id`, and `course.id` is `venue-discipline-seed` — had never once read
 * a saved run back, because the id it looked under had changed before the
 * player could return to it.
 *
 * A rotating seed is the **daily challenge's** job, seeded by the date so that
 * everybody gets the same course that day and two players can compare. That is
 * in docs/ROADMAP.md and still marked "coming soon" in the menu; this is what
 * stops the main entries from behaving like it in the meantime.
 *
 * ---------------------------------------------------------------------------
 * How these two numbers were chosen
 * ---------------------------------------------------------------------------
 *
 * Not picked, *set* — by `tools/sim/pick-course.mjs`, which loads the real game
 * headless at several hundred menu-shaped candidate seeds and scores each on
 * the properties the client actually asked for: one course, a start on the
 * ground and on the network, a finish arrived at once at the end, and legs that
 * run through the streets rather than across open ground. The winners were then
 * looked at. See the tool's header for the scoring and docs/DECISIONS.md D-032.
 *
 * Re-running the tool after a change to the generator or the terrain is the
 * right way to revisit them; changing them by hand is not.
 *
 * ---------------------------------------------------------------------------
 * krumlov 30521551 — 15 controls, 1558 m, 45 m climb
 * ---------------------------------------------------------------------------
 *
 * Of 160 candidates 59 were viable, and this one wins at 142.9 against 141.5
 * for the runner-up. It is worth recording *why* it wins, because the margin is
 * thin and the reasons are the client's sentence almost word for word:
 *
 *  - **Every one of its 17 sited points is on Road or Path** — 100 % runnable
 *    ground. Control-to-paved distance is a median of 0.0 m, a p90 of 0.1 m,
 *    and the worst control in the whole course is **0.4 m** off the network.
 *  - **99 % of the fastest running between controls is on the street network**,
 *    measured by routing every leg over the game's own collision with the
 *    athlete's own class speeds.
 *  - **It stays in the old town** — x −157…242, z −200…172: Latrán, the square
 *    and the Plešivec bank. The runner-up 30474037 finishes 260 m east and 15 m
 *    up the hill outside the town, reached by a 364 m run-in that is both its
 *    longest leg and its least interesting one, and puts two of its controls in
 *    scrub.
 *  - Legs run 47–226 m with the longest last: short technical work, then a
 *    run-in, which is the shape a sprint should have.
 *  - The start is a cobbled street between buildings in Latrán; the finish is
 *    465 m away across the river, so the two are visibly different places and
 *    no leg passes the finish on its way anywhere.
 *  - 2.9 % climb per kilometre. A Knock-Out Sprint round is technically hard
 *    and physically flat; see D-030.
 *
 * ---------------------------------------------------------------------------
 * martinkov 29658380 — 15 controls, 4367 m, 235 m climb
 * ---------------------------------------------------------------------------
 *
 * Fourth on raw score of 120 candidates, and again chosen after looking. The
 * forest disqualifies almost nothing — it has no river to fall in and no street
 * network to leave — so the shortlist is long and the ranking is decided by
 * matters of degree, which is exactly where a setter's eye is worth more than a
 * weight:
 *
 *  - **88 % of its sited points are on runnable ground, and none is in
 *    Green3.** The raw winner on the previous scoring put six of sixteen points
 *    in Green2 at 0.4× speed, which is bushwhacking to find a flag rather than
 *    navigating to it (ISOM 403/406). Eight of this course's points are open
 *    forest, four open land.
 *  - 5.4 % climb per kilometre — a middle in the Vltava valley, not a hill
 *    session. Several higher-scoring candidates run 6–7 %.
 *  - Legs of 151–479 m with a median of 270 m: short technical work alternating
 *    with route choice, which is what a middle is for.
 *  - It uses one compact 790 × 960 m block of the Lachovice training terrain
 *    rather than sprawling across the whole 2 km AOI.
 *
 * What put it fourth rather than first is the start–finish term, which is
 * capped at 480 m — a figure tuned for a 1 200 m town and close to meaningless
 * in a 2 000 m forest, where 416 m and 488 m are the same answer. Worth knowing
 * before reading too much into the ordering of the forest shortlist.
 */
export const COURSE_SEED: Readonly<Record<VenueId, number>> = {
  krumlov: 30_521_551,
  martinkov: 29_658_380,
};

/** The seed a venue's one course is generated from. */
export function courseSeed(id: VenueId): number {
  return COURSE_SEED[id];
}
