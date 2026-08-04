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
 * krumlov 30814554 — 17 controls, 1756 m, 60 m climb
 * ---------------------------------------------------------------------------
 *
 * **Replaces 30521551, which was unplayable.** D-037. That course had control 2
 * fifty-eight metres from control 1 on the far bank of the Vltava with no
 * bridge between them: the player saw the flag across the water and the only
 * way to it was **717 m** of town, 12.3× the straight line. Control 13 was the
 * same fault again at 8.5×. The client found both. Every gate passed it,
 * because every leg measure in the project was a *boolean* — the leg was
 * routable, and 98 % of it was street.
 *
 * So the picker gained a hard filter on `routedM / straightM` and a 1 m audit
 * that is the same function `check:passable` judges the shipped course by, and
 * both venues were re-picked. What that turned up about this town is worth
 * knowing before anyone changes the seed by hand:
 *
 * > Across 240 menu-shaped candidates, the **median course's worst leg runs
 * > 8.71×** its straight line. Only 39 of 240 keep every leg under 3.0×, and
 * > only 11 under 2.0×.
 *
 * The Vltava loops right around the old town, the bridges are hundreds of
 * metres apart, and a 1.5 km course with fifteen-plus controls in a 500 m-wide
 * town puts consecutive controls on opposite banks constantly. **The fault is
 * the venue's, not the generator's**, which is exactly why the answer is to
 * pick rather than to change the generator — see D-037 for the three generator
 * fixes that were tried and measured and all made things worse.
 *
 * This one is the fourth-highest scorer of the seven viable, and it is the
 * highest that survives the 1 m audit: the three above it fail on one leg each,
 * at 5.0×, 3.4× and 3.0×. What it gets right:
 *
 *  - **No leg over 1.6×**, and only two over 1.3×. The whole course walks
 *    2007 m for a printed 1756 m — a detour factor of **1.14** against the
 *    ≈1.05 a real elite sprint runs (RESEARCH-SPORT §8.6).
 *  - **96 % of the running is on the street network**, and the controls sit a
 *    median of 0.6 m off it with a p90 of 3.3 m.
 *  - 17 controls over 1756 m — legs of 47–384 m with the run-in last, which is
 *    the shape a sprint should have, and a leg spread of 0.78.
 *  - 3.4 % climb per kilometre. A Knock-Out Sprint round is technically hard
 *    and physically flat; see D-030.
 *  - The start is 376 m from the finish, so the two are visibly different
 *    places and no leg passes the finish on its way anywhere.
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
 *
 * **Re-picked under D-037's detour filter and deliberately left alone.** The
 * filter that condemned the Krumlov seed finds nothing whatever wrong here:
 * audited at 1 m, every leg of this course runs between 1.0× and 1.1× its
 * straight line and the whole course walks 4587 m for a printed 4367 m — a
 * detour factor of **1.05**. Nor is that this seed being lucky. Across 140
 * forest candidates, *every one* keeps *every* leg under 1.6×, and the worst
 * leg anywhere in 2111 legs is 1.55×.
 *
 * Which is the control on the Krumlov finding above: the detour fault is the
 * **Vltava**, not the generator. Lachovice has no uncrossable water and no
 * street network to be forced onto, so the shortest way between two controls is
 * very nearly the straight line, everywhere, on every seed.
 *
 * The re-pick's own top scorer was 29975140 at 69.9 against this course's 66.8,
 * and it was not taken: it carries **12** controls where a middle is specified
 * at 14, and six places on a shortlist whose spread is 69.9 to 65.6 is inside
 * the noise of a scoring function whose start–finish term is admitted above to
 * be miscalibrated for this venue. Changing a fixed seed also throws away every
 * personal best and ghost `LocalStore` holds under the old `course.id`, which
 * is a real cost and needs a real reason. There isn't one here.
 */
export const COURSE_SEED: Readonly<Record<VenueId, number>> = {
  /**
   * D-040, and the first Krumlov seed since D-032 that is **chosen** rather
   * than inherited.
   *
   * The three before it each fixed the last one's fault and were overtaken by
   * the geometry: `30_521_551` had a 12.3× leg; `30_814_554` fixed that and put
   * the start in the woods; `31_804_429` was picked with the start-on-network
   * assertion but then re-rolled twice underneath the seed as phases 1 and 2
   * changed the passable surface, because the generator's RNG is drawn inside
   * geometry-dependent branches (D-029). D-039 said so out loud: the gate's
   * strictest assertion was being applied to an unchosen sample that happened
   * to pass, *"and phase 3 is where it stops being luck."*
   *
   * This one is chosen on the street graph, out of 200 menu-shaped candidates,
   * by `tools/sim/pick-course.mjs` — top of 12 viable on score, and the first
   * of them the 0.5 m audit accepted:
   *
   *   14 controls · 1750 m · 55 m climb · start 402 m from the finish
   *   **95 % of the running on the street network**
   *   control distance to paved: median 0.0 m, p90 4.3 m, worst 5.6 m
   *   worst leg **2.1×** against a 3.0× limit, D 1.36
   *   start and finish **0.0 m** off the network, and the run-out toward
   *   control 1 hits the 60 m measuring cap without meeting anything
   *
   * The whole-course D is higher than `30_814_554`'s 1.14, and that is the same
   * trade this file has already recorded once: a slightly loopier course you
   * can run out of beats a tight one that opens on a wall. What is different is
   * that the trade is now made by a setter looking at both numbers rather than
   * discovered by an audit afterwards.
   */
  krumlov: 30_640_336,
  martinkov: 29_658_380,
};

/** The seed a venue's one course is generated from. */
export function courseSeed(id: VenueId): number {
  return COURSE_SEED[id];
}
