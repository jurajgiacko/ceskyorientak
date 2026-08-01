/**
 * Coordinate transforms between WGS84, the local metric frame, and map mm.
 *
 * We deliberately avoid a full projection library. Both venues are ~4 km
 * across, so a local tangent-plane (equirectangular about the anchor latitude)
 * approximation is well under 1 cm of error across the playable area — far
 * below the 0.2 m vertical accuracy of the DMR 5G source data.
 *
 * The heavy S-JTSK (EPSG:5514) work happens once, offline, in tools/terrain/.
 * Nothing at runtime needs to know about Krovák.
 */

import type { Geo, World2, VenueAnchor } from './types';

/** WGS84 semi-major axis, metres. */
const A = 6378137.0;
/** WGS84 first eccentricity squared. */
const E2 = 0.00669437999014;

/** Metres per degree of latitude at a given latitude. */
export function metresPerDegLat(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  // Meridional radius of curvature.
  return ((Math.PI / 180) * A * (1 - E2)) / (w * w * w);
}

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegLon(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  // Prime-vertical radius of curvature, scaled by cos(lat).
  return ((Math.PI / 180) * A * Math.cos(lat)) / w;
}

/**
 * A frozen conversion pair for one venue. Build it once at load and reuse —
 * the trig above is not free and this runs in hot paths (map render, HUD).
 */
export interface GeoFrame {
  origin: Geo;
  mPerDegLat: number;
  mPerDegLon: number;
}

export function makeFrame(origin: Geo): GeoFrame {
  return {
    origin,
    mPerDegLat: metresPerDegLat(origin.lat),
    mPerDegLon: metresPerDegLon(origin.lat),
  };
}

export function frameForVenue(anchor: VenueAnchor): GeoFrame {
  return makeFrame(anchor.origin);
}

/** WGS84 → local metres. x east, z south (so north is -z, matching three.js). */
export function geoToWorld(f: GeoFrame, g: Geo): World2 {
  return {
    x: (g.lon - f.origin.lon) * f.mPerDegLon,
    z: -(g.lat - f.origin.lat) * f.mPerDegLat,
  };
}

/** Local metres → WGS84. */
export function worldToGeo(f: GeoFrame, w: World2): Geo {
  return {
    lon: f.origin.lon + w.x / f.mPerDegLon,
    lat: f.origin.lat - w.z / f.mPerDegLat,
  };
}

/** Local metres → millimetres on the printed map at the given scale. */
export function worldToMapMm(w: World2, scaleDenominator: number): World2 {
  const k = 1000 / scaleDenominator;
  return { x: w.x * k, z: w.z * k };
}

/** Millimetres on the map → local metres. */
export function mapMmToWorld(m: World2, scaleDenominator: number): World2 {
  const k = scaleDenominator / 1000;
  return { x: m.x * k, z: m.z * k };
}

// ---------------------------------------------------------------------------
// Planimetric helpers
// ---------------------------------------------------------------------------

export function dist2(a: World2, b: World2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

export function distSq2(a: World2, b: World2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Bearing from a to b, in radians, 0 = north (grid north), clockwise positive.
 * This matches how an orienteer reads a compass, and how column G directions
 * are expressed.
 */
export function bearing(a: World2, b: World2): number {
  // North is -z, east is +x. atan2(east, north).
  return Math.atan2(b.x - a.x, -(b.z - a.z));
}

/** Normalise an angle to (-π, π]. */
export function wrapAngle(rad: number): number {
  let r = rad % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Signed smallest difference from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Radians → the 0–360 degree bearing an orienteer would dial on a compass. */
export function toCompassDegrees(rad: number): number {
  const d = (rad * 180) / Math.PI;
  return (d + 360) % 360;
}
