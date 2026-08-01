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
