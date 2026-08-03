#!/usr/bin/env node
/**
 * Townscape extractor — OSM + LiDAR → `public/data/<venue>/townscape.json`.
 *
 * The sprint venue is a town, so the thing that defines it is not a heightfield
 * but 1877 building footprints and the walls between them. This turns the raw
 * Overpass dump into a compact runtime asset.
 *
 * **Building height comes from the LiDAR, not from `building:levels`.**
 * `canopy.bin` for Krumlov is not canopy at all — it is the canopy height model,
 * DMP 1G minus DMR 5G, resampled into the world frame by `build.mjs` with
 * identical weights on both surfaces (see D-017). Over a roof that difference is
 * the measured roof surface above bare earth. So for every footprint we
 * rasterise the polygon, sample `DMR + CHM` inside it, and read the eave off a
 * low percentile and the ridge off a high one. That gives real roof pitch and
 * real ridge height per building — `building:levels` (present on 55 %) is only
 * the fallback, and it is a much worse one: it cannot tell a 45° Bohemian tile
 * roof from a flat one.
 *
 * Sources, kept separate by venue per D-016.5:
 *   - OSM (ODbL) — footprints, barriers, steps, water, trees. Attribution is
 *     carried in the output and surfaced in the scene.
 *   - ČÚZK DMR 5G + DMP 1G (CC BY 4.0) — every height in this file.
 * No Google data of any kind (D-016.4).
 *
 * Usage:  node tools/terrain/townscape.mjs [--venue krumlov] [--out public/data]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VENUES = {
  krumlov: {
    osm: 'research/raw/osm_krumlov_sprint.json',
    data: 'public/data/krumlov',
    origin: { lon: 14.315, lat: 48.8109 },
    /** Half-extent kept, metres. Playable is ±600; the extra is skyline. */
    reach: 700,
  },
};

/** Metres per storey where we have to fall back to `building:levels`. */
const STOREY_M = 3.2;

// ---------------------------------------------------------------------------
// Geo — must match src/core/geo.ts exactly
// ---------------------------------------------------------------------------

const A = 6378137.0;
const E2 = 0.00669437999014;

function metresPerDegLat(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  return ((Math.PI / 180) * A * (1 - E2)) / (w * w * w);
}

function metresPerDegLon(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - E2 * s * s);
  return ((Math.PI / 180) * A * Math.cos(lat)) / w;
}

function makeFrame(origin) {
  return {
    origin,
    mPerDegLat: metresPerDegLat(origin.lat),
    mPerDegLon: metresPerDegLon(origin.lat),
  };
}

function toWorld(f, lon, lat) {
  return [(lon - f.origin.lon) * f.mPerDegLon, -(lat - f.origin.lat) * f.mPerDegLat];
}

// ---------------------------------------------------------------------------
// Rasters
// ---------------------------------------------------------------------------

function loadRasters(dir) {
  const hMeta = JSON.parse(readFileSync(join(dir, 'height.json'), 'utf8'));
  const cMeta = JSON.parse(readFileSync(join(dir, 'canopy.json'), 'utf8'));
  const hBuf = readFileSync(join(dir, 'height.bin'));
  const heights = new Uint16Array(hBuf.buffer, hBuf.byteOffset, hBuf.length / 2);
  const canopy = new Uint8Array(readFileSync(join(dir, 'canopy.bin')));
  const hScale = (hMeta.maxH - hMeta.minH) / 65535;

  const cell = (i, j) => {
    const ci = i < 0 ? 0 : i >= hMeta.width ? hMeta.width - 1 : i;
    const cj = j < 0 ? 0 : j >= hMeta.height ? hMeta.height - 1 : j;
    return hMeta.minH + heights[cj * hMeta.width + ci] * hScale;
  };

  /** Bilinear bare-earth elevation, metres ASL. */
  const groundAt = (x, z) => {
    const fx = (x - hMeta.originX) / hMeta.resM;
    const fz = (z - hMeta.originZ) / hMeta.resM;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return (
      cell(i, j) * (1 - tx) * (1 - tz) +
      cell(i + 1, j) * tx * (1 - tz) +
      cell(i, j + 1) * (1 - tx) * tz +
      cell(i + 1, j + 1) * tx * tz
    );
  };

  /** Object height above bare earth, metres (DMP 1G − DMR 5G). */
  const chmAt = (x, z) => {
    const i = Math.round((x - cMeta.originX) / cMeta.resM);
    const j = Math.round((z - cMeta.originZ) / cMeta.resM);
    if (i < 0 || j < 0 || i >= cMeta.width || j >= cMeta.height) return 0;
    return (canopy[j * cMeta.width + i] / 255) * cMeta.maxCanopyM;
  };

  return { groundAt, chmAt, hMeta, cMeta };
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

function ringArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return a / 2;
}

function centroid(pts) {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cz += (pts[j][1] + pts[i][1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const p of pts) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / pts.length, sz / pts.length];
  }
  return [cx / (6 * a), cz / (6 * a)];
}

function pointInRing(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const zi = pts[i][1];
    const xj = pts[j][0];
    const zj = pts[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Minimum-area bounding rectangle by rotating calipers over the convex hull.
 *
 * Its long axis is the ridge direction. This is the single most load-bearing
 * geometric decision in the whole file: a Krumlov roof ridge runs along the
 * plot, and getting it 90° wrong turns a terrace of gables into a row of hips
 * pointing the wrong way, which is instantly readable as wrong from any angle.
 */
function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) {
    return { angle: 0, long: 1, short: 1 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const ux = ex / len;
    const uz = ez / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area) {
      best = { area, w, h, ux, uz };
    }
  }
  if (!best) return { angle: 0, long: 1, short: 1 };
  // Ridge runs along the longer side.
  const alongU = best.w >= best.h;
  const dx = alongU ? best.ux : -best.uz;
  const dz = alongU ? best.uz : best.ux;
  return {
    angle: Math.atan2(dx, -dz), // 0 = north (−z), clockwise positive
    long: Math.max(best.w, best.h),
    short: Math.min(best.w, best.h),
  };
}

function convexHull(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Drop collinear and near-duplicate vertices.
 *
 * RUIAN footprints carry a lot of 2 cm jogs. They cost geometry, they make the
 * min-area rectangle noisy, and no player will ever see them.
 */
function simplifyRing(pts, tol = 0.35) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < tol) continue;
    out.push(p);
  }
  while (
    out.length > 3 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < tol
  ) {
    out.pop();
  }
  if (out.length < 3) return out;
  // Collinear pass.
  const keep = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const base = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (base > 1e-6 && Math.abs(cross) / base < tol * 0.6) continue;
    keep.push(b);
  }
  return keep.length >= 3 ? keep : out;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const NAMED = {
  white: 0xf2ece2,
  beige: 0xe6d8bd,
  lightyellow: 0xf2e3ac,
  yellow: 0xe8cf7c,
  lightgrey: 0xd4d2cb,
  grey: 0xa8a49c,
  silver: 0xc6c3bc,
  tan: 0xd9bf95,
  orange: 0xdb9a5c,
  brown: 0x9c7248,
  red: 0xb04a37,
  maroon: 0x7d3a30,
  mint: 0xc4ddc9,
  aqua: 0xbcd8d8,
  lightpink: 0xe8cfcc,
  lightblue: 0xc3d3e0,
  lightgreen: 0xc9dcb4,
  green: 0x7d9463,
  lime: 0xbdd08a,
  blue: 0x8ba4c0,
  black: 0x3a3733,
  darkgrey: 0x6b6862,
  cream: 0xefe4cb,
};

function parseColour(v, fallback) {
  if (!v) return fallback;
  const s = String(v).trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{6})$/);
  if (hex) return parseInt(hex[1], 16);
  const short = s.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split('');
    return parseInt(r + r + g + g + b + b, 16);
  }
  return NAMED[s] ?? fallback;
}

/**
 * A roof may be dark. It may not be a hole.
 *
 * Twenty-one footprints here carry a surveyed `roof:colour=black`, which the
 * name table renders as `#3a3733` — a linear luminance of **0.038**, darker
 * than fresh asphalt. Multiplied through a tile albedo map and lit at 08:00 by
 * a sun that is not on that slope, it comes out as a void in the roofscape:
 * from across the meander those twelve buildings read as missing roofs rather
 * than as dark ones. A slate or bitumen roof in daylight is charcoal, not
 * black, so the luminance is floored at 0.075 linear — about `#4d4a46` — and
 * the hue is kept by scaling rather than by lightening toward white.
 */
function liftRoof(hex) {
  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const lum = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  const FLOOR = 0.075;
  if (lum >= FLOOR || lum <= 0) return hex;
  // sRGB is close enough to a 2.2 power that scaling the encoded value by the
  // 1/2.2 root of the luminance ratio lands within a percent of the target.
  const k = Math.pow(FLOOR / lum, 1 / 2.2);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * 255 * k)));
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}

/** Deterministic per-feature jitter so a terrace is not one flat colour. */
function hashId(id) {
  let h = id >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Krumlov's plaster palette. Sampled by eye off the ČÚZK 12.5 cm orthophoto:
 * lime-wash creams and ochres, the occasional pale pink and celadon, almost
 * nothing saturated. Used only where OSM has no `building:colour`.
 */
const PLASTER = [
  0xefe6d2, 0xe8dcc0, 0xf0e7d8, 0xe3d4b4, 0xead9bd, 0xf1e8dc, 0xe7d9c6,
  0xdfd0b6, 0xf0e2c8, 0xe9dcc9, 0xecdcc4, 0xe4d8c4, 0xefe0cb, 0xe1d6c0,
  0xe8d6b8, 0xf2ebdd, 0xdccfba, 0xead2b4, 0xe6ddd0, 0xf0dfc4,
];

/**
 * Bohemian tile. The ortho is unambiguous: the old town is a field of warm
 * terracotta with a scatter of weathered brown-grey and a very few green
 * copper roofs. The spread matters more than the mean — a single roof colour
 * across 1800 buildings reads as a texture atlas, not as a town.
 */
const TILE = [
  0xb0563a, 0xa64c33, 0xbb5f3d, 0xa8523c, 0xc06844, 0x9d4a35, 0xb45c40,
  0xae5238, 0xc26b45, 0x9a4732, 0xb96040, 0xa44f38,
];
const TILE_WEATHERED = [0x9a6a52, 0x8d6450, 0xa4715a, 0x866355];

// ---------------------------------------------------------------------------
// Roof shapes
// ---------------------------------------------------------------------------

const ROOF = {
  FLAT: 0,
  GABLED: 1,
  HIPPED: 2,
  PYRAMIDAL: 3,
  SKILLION: 4,
  HALF_HIPPED: 5,
  MANSARD: 6,
  DOMED: 7,
};

const ROOF_TAG = {
  flat: ROOF.FLAT,
  gabled: ROOF.GABLED,
  pitched: ROOF.GABLED,
  saltbox: ROOF.GABLED,
  gambrel: ROOF.MANSARD,
  mansard: ROOF.MANSARD,
  hipped: ROOF.HIPPED,
  side_hipped: ROOF.HIPPED,
  'hipped-and-gabled': ROOF.HIPPED,
  'half-hipped': ROOF.HALF_HIPPED,
  'side_half-hipped': ROOF.HALF_HIPPED,
  pyramidal: ROOF.PYRAMIDAL,
  skillion: ROOF.SKILLION,
  dome: ROOF.DOMED,
  onion: ROOF.DOMED,
  round: ROOF.DOMED,
  cone: ROOF.PYRAMIDAL,
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function ringsFor(el) {
  if (el.type === 'way') {
    return el.geometry ? [el.geometry] : [];
  }
  if (el.type === 'relation') {
    return (el.members ?? [])
      .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry)
      .map((m) => m.geometry);
  }
  return [];
}

function main() {
  const args = process.argv.slice(2);
  const venueArg = args.find((a) => a.startsWith('--venue='));
  const venueId = venueArg ? venueArg.slice('--venue='.length) : 'krumlov';
  const cfg = VENUES[venueId];
  if (!cfg) {
    console.error(`✗ unknown venue "${venueId}"`);
    process.exit(2);
  }

  const dataDir = resolve(ROOT, cfg.data);
  const osmPath = resolve(ROOT, cfg.osm);
  if (!existsSync(osmPath)) {
    console.error(`✗ ${cfg.osm} missing — run the Overpass query first.`);
    process.exit(2);
  }

  const frame = makeFrame(cfg.origin);
  const { groundAt, chmAt } = loadRasters(dataDir);
  const osm = JSON.parse(readFileSync(osmPath, 'utf8'));
  const R = cfg.reach;

  const inReach = (x, z) => x >= -R && x <= R && z >= -R && z <= R;

  // Two passes over the buildings. The first collects every footprint into a
  // grid, because the second needs to know which cells belong to a *different*,
  // smaller building standing inside this one.
  //
  // This is not a corner case here. Zámecká věž is its own OSM way sitting
  // inside the Hrádek's footprint, and the CHM does not know that: sampling the
  // Hrádek picked up the tower's 54.5 m as its own p94 and extruded the whole
  // building to 45 m. The first build put a green onion dome on top of a
  // twenty-five-metre block of flats, which is a memorable way to learn that a
  // percentile is only as good as the mask it runs over.
  const footprintIndex = new Nested();
  for (const el of osm.elements) {
    if (!el.tags?.building || el.tags.building === 'no') continue;
    for (const geom of ringsFor(el)) {
      const ring = simplifyRing(
        geom.map((g) => toWorld(frame, g.lon, g.lat)),
        0.3,
      );
      if (ring.length < 3) continue;
      const c = centroid(ring);
      if (!inReach(c[0], c[1])) continue;
      footprintIndex.add(el.id, ring, Math.abs(ringArea(ring)));
    }
  }

  const buildings = [];
  const walls = [];
  const steps = [];
  const water = [];
  const trees = [];
  const areas = [];
  const bridges = [];
  const paved = [];

  let chmUsed = 0;
  let levelsUsed = 0;

  for (const el of osm.elements) {
    const tags = el.tags;
    if (!tags) continue;

    // --- buildings -------------------------------------------------------
    if (tags.building && tags.building !== 'no') {
      for (const geom of ringsFor(el)) {
        const b = makeBuilding(el, tags, geom, frame, groundAt, chmAt, inReach, footprintIndex);
        if (!b) continue;
        if (b.src === 'chm') chmUsed++;
        else levelsUsed++;
        delete b.src;
        buildings.push(b);
      }
      continue;
    }

    // --- barriers --------------------------------------------------------
    if (tags.barrier && el.type === 'way' && el.geometry) {
      const kind = tags.barrier;
      const spec = BARRIER[kind];
      if (!spec) continue;
      const line = polyline(el.geometry, frame, inReach);
      if (line.length < 2) continue;
      const h = Number(tags.height) || spec.h;
      walls.push({
        p: flatten(line),
        h: round1(h),
        k: spec.k,
        // ISSprOM 515/518 uncrossable wall/fence, Rule 17.2 — a legal boundary
        // rather than an advisory one. Under `CROSSABLE_MAX_H` it is 513.1/516
        // crossable, which here means drawn low enough to be read as something
        // you step over. See CROSSABLE_MAX_H for why the line is there and not
        // at ISSprOM's 1.5 m.
        u: h > CROSSABLE_MAX_H ? 1 : 0,
      });
      continue;
    }

    // --- the paved network -----------------------------------------------
    // ZABAGED's `street` polygon layer is what the runnability raster was built
    // from, and it stops at the carriageway: Náměstí Svornosti, every alley off
    // Latrán and the whole castle ramp came through as *open land*, i.e. grass.
    // That is wrong about the one surface a sprint is mostly run on, and it is
    // wrong in the direction that matters — ISSprOM 501 Paved area is the
    // venue's dominant symbol. OSM has the full network (1827 highway ways
    // against ZABAGED's 643 street features), so it is carried through here and
    // stamped into the raster at load.
    if (tags.highway && el.type === 'way' && el.geometry && HIGHWAY[tags.highway]) {
      const spec = HIGHWAY[tags.highway];
      const line = polyline(el.geometry, frame, inReach);
      if (line.length >= 2) {
        const w = Number(tags.width) || (Number(tags.lanes) ? Number(tags.lanes) * 3 : spec.w);
        const rec = { l: flatten(simplifyLine(line, 1.2)), w: round1(w), k: spec.k };
        // A bridge deck is the one thing allowed to cross ground the raster
        // calls impassable. Without this flag every crossing of the Vltava is
        // severed — see `stampRaster`.
        if (tags.bridge && tags.bridge !== 'no') rec.b = 1;
        paved.push(rec);
      }
      if (tags.highway !== 'steps') continue;
    }

    // --- steps -----------------------------------------------------------
    if (tags.highway === 'steps' && el.type === 'way' && el.geometry) {
      const line = polyline(el.geometry, frame, inReach);
      if (line.length < 2) continue;
      steps.push({
        p: flatten(line),
        n: Number(tags.step_count) || 0,
        w: Number(tags.width) || 1.6,
      });
      continue;
    }

    // --- water -----------------------------------------------------------
    if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir') {
      for (const geom of ringsFor(el)) {
        const ring = simplifyRing(polyline(geom, frame, inReach), 0.8);
        if (ring.length < 3) continue;
        if (Math.abs(ringArea(ring)) < 60) continue;
        const c = centroid(ring);
        water.push({ p: flatten(ring), y: round1(waterLevel(ring, groundAt)), c: [round1(c[0]), round1(c[1])] });
      }
      continue;
    }

    // --- river centreline (for the weirs and the narrow mill race) --------
    if (tags.waterway === 'river' || tags.waterway === 'canal') {
      if (el.type !== 'way' || !el.geometry) continue;
      const line = polyline(el.geometry, frame, inReach);
      if (line.length < 2) continue;
      water.push({
        l: flatten(line),
        w: Number(tags.width) || (tags.waterway === 'river' ? 24 : 6),
      });
      continue;
    }

    // --- trees -----------------------------------------------------------
    if (tags.natural === 'tree' && el.type === 'node') {
      const [x, z] = toWorld(frame, el.lon, el.lat);
      if (!inReach(x, z)) continue;
      const h = Math.max(4, Math.min(28, chmAt(x, z)));
      trees.push([round1(x), round1(z), round1(h)]);
      continue;
    }

    // --- surfaces worth drawing flat: squares, gardens, parking -----------
    if (
      tags.highway === 'pedestrian' ||
      tags.place === 'square' ||
      tags.leisure === 'park' ||
      tags.leisure === 'garden' ||
      tags.amenity === 'parking' ||
      tags.landuse === 'grass'
    ) {
      if (el.type !== 'way' || !el.geometry) continue;
      if (el.geometry.length < 4) continue;
      const ring = simplifyRing(polyline(el.geometry, frame, inReach), 0.8);
      if (ring.length < 3) continue;
      const a = Math.abs(ringArea(ring));
      if (a < 120) continue;
      const kind =
        tags.highway === 'pedestrian' || tags.place === 'square'
          ? 'paved'
          : tags.amenity === 'parking'
            ? 'paved'
            : 'grass';
      areas.push({ p: flatten(ring), k: kind === 'paved' ? 0 : 1 });
      continue;
    }

    // --- bridge decks ----------------------------------------------------
    if ((tags.man_made === 'bridge' || tags.bridge === 'viaduct') && el.geometry) {
      for (const geom of ringsFor(el)) {
        const ring = simplifyRing(polyline(geom, frame, inReach), 0.5);
        if (ring.length < 3) continue;
        bridges.push({
          p: flatten(ring),
          name: tags.name ?? '',
          id: el.id,
        });
      }
    }
  }

  const turned = faceGablesToStreet(buildings, paved);
  const stamp = stampRasters(dataDir, { paved, buildings, walls });

  // Landmark footprints are carried through by OSM id so the scene can
  // recognise them and replace the generic extrusion with a real model.
  const out = {
    venue: venueId,
    generatedAt: new Date().toISOString(),
    origin: cfg.origin,
    source: {
      footprints: 'OpenStreetMap contributors, ODbL 1.0',
      heights: 'ČÚZK DMR 5G + DMP 1G (CC BY 4.0) — DMP1G − DMR5G per footprint',
      note:
        'No Google Maps/Earth/Elevation data was used at any point — see DECISIONS.md D-016.4.',
    },
    stats: {
      buildings: buildings.length,
      heightFromLidar: chmUsed,
      heightFromLevels: levelsUsed,
      walls: walls.length,
      steps: steps.length,
      water: water.length,
      trees: trees.length,
      areas: areas.length,
      paved: paved.length,
      gablesToStreet: turned.turned,
      gableBays: turned.bays,
      ...stamp.stats,
    },
    /**
     * The runnability rasters in this directory carry the OSM network,
     * footprints and barriers. `SprintScene` reads it rather than re-deriving
     * it, so map, course setting and collision cannot disagree — see D-024.
     */
    rasterStamped: true,
    /**
     * The height at or below which a barrier is crossable, metres. Carried in
     * the file rather than duplicated as a third constant, so the renderer and
     * the CI gate check the number this data was actually built with.
     */
    crossableMaxH: CROSSABLE_MAX_H,
    buildings,
    walls,
    steps,
    water,
    trees,
    areas,
    paved,
    bridges,
  };

  mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(out);
  const file = join(dataDir, 'townscape.json');
  writeFileSync(file, json);

  const gz = gzipSync(Buffer.from(json)).length;
  console.log(`✓ ${file}`);
  console.log(`  buildings ${buildings.length}  (LiDAR ${chmUsed}, levels fallback ${levelsUsed})`);
  console.log(`  paved ways ${paved.length}`);
  console.log(`  walls ${walls.length}  steps ${steps.length}  water ${water.length}  trees ${trees.length}  areas ${areas.length}  bridges ${bridges.length}`);
  console.log(`  gables turned to the street ${turned.turned}  (${turned.bays} gable bays in total)`);
  console.log(
    `  raster stamped: network ${stamp.stats.stampedNetwork}, bridge deck ${stamp.stats.stampedBridgeDeck}, squares ${stamp.stats.stampedSquares}, buildings ${stamp.stats.stampedBuildings}, barriers ${stamp.stats.stampedBarriers} cells`,
  );
  console.log(`  ${(json.length / 1024).toFixed(0)} kB  (gzip ${(gz / 1024).toFixed(0)} kB)`);
}

// ---------------------------------------------------------------------------
// One raster, and everything that decides passability burnt into it
// ---------------------------------------------------------------------------

/** Runnability codes — must match `Runnability` in src/core/types.ts. */
const R = {
  Road: 0,
  Path: 1,
  OpenFast: 2,
  OpenRough: 3,
  ForestOpen: 4,
  Green1: 5,
  Green2: 6,
  Green3: 7,
  Marsh: 8,
  Rock: 9,
  Impassable: 10,
};

/** Wall thickness by kind — must match `WALL_SPEC` in src/world/townscape.ts. */
const WALL_THICK = { 0: 0.45, 1: 1.15, 2: 0.6, 3: 0.1, 4: 0.95 };

/**
 * Burn the OSM network, footprints and barriers into the runnability rasters.
 *
 * **D-002 says the map, the physics and the course generator read one raster.**
 * They did not. The network and the footprints were stamped at scene load, and
 * the *barriers* were nowhere — 619 walls, city walls and railings that stop
 * the athlete under ISSprOM 515/518 existed only as collision volumes. Measured
 * before this change, **90.6 % of uncrossable barrier length blocked the player
 * without appearing in the raster the map draws**, which is precisely the
 * unfairness those symbols exist to prevent.
 *
 * And one omission was worse than unfair. `stampPaved` refused to paint over
 * `Impassable` — a guard written so that a footpath crossing the Vltava polygon
 * could not turn the river into a road. It also severed **every bridge in the
 * venue**: the Vltava is an unbroken impassable ribbon round the old town, and
 * with no deck to cross it the arena's connected component was the meander and
 * nothing else. Flood-filled from Náměstí Svornosti with the runtime's own
 * collision, **29.8 % of the open ground in the venue was reachable**, and the
 * largest thing the player could see and not get to was 54 hectares. That is
 * the "stuck on a little square and can't get out" the client reported: the map
 * draws bridges, and the bridges do not work.
 *
 * So the guard is kept and given the one exception it always needed: a way OSM
 * tags as `bridge` may cross impassable ground, and nothing else may.
 *
 * Order matters and is the order below: network, then bridges, then the
 * enclosed-square fill, then footprints, then barriers. Buildings and barriers
 * come last because they are the two things that must win.
 *
 * Barriers are stamped **without dilation**, cell centre in the collision band
 * and no wider. That is not caution, it is the lesson written into
 * `stampBuildings`: growing footprints by a single cell once took this venue
 * from 30 % connected to 1 %, because Krumlov's alleys are 2–3 m wide.
 */
function stampRasters(dataDir, { paved, buildings, walls }) {
  const stats = {};
  for (const suffix of ['', '-low']) {
    const metaPath = join(dataDir, `runnability${suffix}.json`);
    const binPath = join(dataDir, `runnability${suffix}.bin`);
    if (!existsSync(metaPath) || !existsSync(binPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const r = new Uint8Array(readFileSync(binPath));
    const s = stampOne(r, meta, { paved, buildings, walls });
    writeFileSync(binPath, Buffer.from(r.buffer, r.byteOffset, r.length));
    if (!suffix) Object.assign(stats, s);
  }
  return { stats };
}

function stampOne(r, m, { paved, buildings, walls }) {
  const paintable = (v) =>
    v === R.OpenFast ||
    v === R.OpenRough ||
    v === R.ForestOpen ||
    v === R.Green1 ||
    v === R.Green2 ||
    v === R.Green3 ||
    v === R.Path;

  /** Walk the cells within `half` of a polyline, calling `fn(index)`. */
  const alongLine = (line, half, fn) => {
    const n = line.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const ax = line[i * 2];
      const az = line[i * 2 + 1];
      const bx = line[i * 2 + 2];
      const bz = line[i * 2 + 3];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - m.originX) / m.resM));
      const i1 = Math.min(m.width - 1, Math.ceil((Math.max(ax, bx) + half - m.originX) / m.resM));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - m.originZ) / m.resM));
      const j1 = Math.min(m.height - 1, Math.ceil((Math.max(az, bz) + half - m.originZ) / m.resM));
      for (let j = j0; j <= j1; j++) {
        const wz = m.originZ + j * m.resM;
        for (let i2 = i0; i2 <= i1; i2++) {
          const wx = m.originX + i2 * m.resM;
          let t = len2 > 1e-9 ? ((wx - ax) * dx + (wz - az) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - wx;
          const pz = az + dz * t - wz;
          if (px * px + pz * pz > half * half) continue;
          fn(j * m.width + i2);
        }
      }
    }
  };

  // --- 1. the paved network, over the classes that can legitimately be paved.
  let network = 0;
  for (const way of paved) {
    const cls = way.k === 1 ? R.Path : R.Road;
    alongLine(way.l, Math.max(0.8, way.w * 0.5), (k) => {
      if (!paintable(r[k])) return;
      r[k] = cls;
      network++;
    });
  }

  // --- 2. bridge decks, which are the one thing allowed through Impassable.
  //
  // Narrower than the carriageway on purpose: half the tagged width, floored at
  // 1.4 m. A bridge is a crossing point, and widening it eats the river bank
  // either side of the abutment for no gain.
  //
  // `carriageway` records the band whether or not the paint took, and step 5
  // reads it. A cell already Road is still a crossing; what makes it one is the
  // `bridge` tag, not what the class under it happened to be. See D-033.
  const carriageway = new Uint8Array(r.length);
  let decks = 0;
  for (const way of paved) {
    if (!way.b) continue;
    const cls = way.k === 1 ? R.Path : R.Road;
    alongLine(way.l, Math.max(1.4, way.w * 0.5), (k) => {
      carriageway[k] = 1;
      if (r[k] !== R.Impassable && !paintable(r[k])) return;
      if (r[k] === cls) return;
      r[k] = cls;
      decks++;
    });
  }

  // --- 3. squares. A square is not a road and OSM maps it as lines round and
  // across it, so the middle of Náměstí Svornosti comes through as open land,
  // i.e. mown grass. Anything enclosed by paving and small enough to be a yard
  // rather than a garden becomes paved.
  const filled = fillEnclosed(r, m);

  // --- 4. footprints. ISSprOM 521: every building is out of bounds.
  let inside = 0;
  for (const b of buildings) {
    const p = b.p;
    const n = p.length / 2;
    if (n < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (p[i * 2] < minX) minX = p[i * 2];
      if (p[i * 2] > maxX) maxX = p[i * 2];
      if (p[i * 2 + 1] < minZ) minZ = p[i * 2 + 1];
      if (p[i * 2 + 1] > maxZ) maxZ = p[i * 2 + 1];
    }
    const i0 = Math.max(0, Math.floor((minX - m.originX) / m.resM));
    const i1 = Math.min(m.width - 1, Math.ceil((maxX - m.originX) / m.resM));
    const j0 = Math.max(0, Math.floor((minZ - m.originZ) / m.resM));
    const j1 = Math.min(m.height - 1, Math.ceil((maxZ - m.originZ) / m.resM));
    for (let j = j0; j <= j1; j++) {
      const wz = m.originZ + j * m.resM;
      for (let i = i0; i <= i1; i++) {
        const wx = m.originX + i * m.resM;
        if (!pointInRing2(p, wx, wz)) continue;
        const k = j * m.width + i;
        if (r[k] === R.Impassable) continue;
        r[k] = R.Impassable;
        inside++;
      }
    }
  }

  // --- 5. barriers over 1.5 m. ISSprOM 411/515/518 plus IOF Rule 17.2: these
  // are a legal boundary, and the map has to draw the same line the athlete
  // runs into.
  let barrier = 0;
  for (const w of walls) {
    if (!w.u) continue;
    const thick = WALL_THICK[w.k];
    if (thick === undefined) continue;
    // The runtime's own band: half the thickness plus the 0.25 m margin
    // `Townscape.buildWall` adds. Stamping exactly this and not a centimetre
    // more is what keeps the raster and the collider saying the same thing.
    //
    // Except on a carriageway, which this may not close — the exception step 2
    // exists to grant, applied to the one stamp that was silently taking it
    // back. Krumlov's river wall and its bridge parapets are mapped as barrier
    // ways that run *onto* the deck, so stamping them here re-severed 17 of the
    // venue's 47 crossings after step 2 had opened them, and `Townscape.blocks`
    // enforced the same band at runtime. The athlete could see the far bank and
    // not reach it. Off the deck the barrier still blocks in full, so this opens
    // a gate exactly as wide as the way OSM tags as a bridge and no wider; the
    // river either side of it is still out of bounds under ISSprOM 301, which is
    // what stops anyone running off the parapet. See D-033.
    const mark = (k) => {
      if (carriageway[k]) return;
      if (r[k] === R.Impassable) return;
      r[k] = R.Impassable;
      barrier++;
    };
    alongLine(w.p, thick * 0.5 + 0.25, mark);
    // Plus every cell the centreline itself passes through. A 10 cm railing has
    // a band 60 cm wide, which on a 1 m grid can slip clean between two cell
    // centres — so the athlete meets a barrier the map draws with holes in it.
    // ISSprOM 515/518 exist to stop exactly that. This adds no width the
    // barrier does not already occupy; it only closes the line.
    traceLine(w.p, m, mark);
  }

  return {
    stampedNetwork: network,
    stampedBridgeDeck: decks,
    stampedSquares: filled,
    stampedBuildings: inside,
    stampedBarriers: barrier,
  };
}

/**
 * Pave the enclosed unpaved pockets the network leaves behind.
 *
 * Flood-fills the unpaved, non-building cells inward from the border; anything
 * the fill cannot reach is enclosed by paving. Under 4 000 m² that is a square
 * or a yard and becomes paved; larger is a garden — the castle's Jelení zahrada
 * is exactly that — and paving it would be worse than the bug.
 */
function fillEnclosed(r, m) {
  const w = m.width;
  const h = m.height;
  const n = w * h;
  const open = (k) => r[k] !== R.Road && r[k] !== R.Path && r[k] !== R.Impassable;
  const seen = new Uint8Array(n);
  const stack = [];
  const push = (k) => {
    if (!seen[k] && open(k)) {
      seen[k] = 1;
      stack.push(k);
    }
  };
  for (let i = 0; i < w; i++) {
    push(i);
    push((h - 1) * w + i);
  }
  for (let j = 0; j < h; j++) {
    push(j * w);
    push(j * w + w - 1);
  }
  const spread = (k) => {
    const x = k % w;
    const y = (k / w) | 0;
    if (x > 0) push(k - 1);
    if (x < w - 1) push(k + 1);
    if (y > 0) push(k - w);
    if (y < h - 1) push(k + w);
  };
  while (stack.length) spread(stack.pop());

  let filled = 0;
  const comp = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (seen[k0] || !open(k0)) continue;
    comp.length = 0;
    seen[k0] = 1;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      spread(k);
    }
    if (comp.length * m.resM * m.resM > 4000) continue;
    for (const k of comp) {
      if (r[k] !== R.OpenFast && r[k] !== R.OpenRough) continue;
      r[k] = R.Road;
      filled++;
    }
  }
  return filled;
}

/**
 * Every cell a polyline passes through, sampled densely enough that a 1 m grid
 * cannot be skipped. Supercover rather than Bresenham, because a line that is
 * eight-connected still leaks diagonally on a four-connected flood fill.
 */
function traceLine(line, m, fn) {
  const n = line.length / 2;
  const step = m.resM * 0.25;
  for (let i = 0; i < n - 1; i++) {
    const ax = line[i * 2];
    const az = line[i * 2 + 1];
    const bx = line[i * 2 + 2];
    const bz = line[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6 || len > 120) continue;
    const steps = Math.ceil(len / step);
    let pi = -1;
    let pj = -1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i2 = Math.round((ax + (bx - ax) * t - m.originX) / m.resM);
      const j2 = Math.round((az + (bz - az) * t - m.originZ) / m.resM);
      if (i2 < 0 || j2 < 0 || i2 >= m.width || j2 >= m.height) continue;
      if (i2 === pi && j2 === pj) continue;
      // A diagonal hop leaves a four-connected gap; close it on both sides.
      if (pi >= 0 && i2 !== pi && j2 !== pj) {
        fn(pj * m.width + i2);
        fn(j2 * m.width + pi);
      }
      fn(j2 * m.width + i2);
      pi = i2;
      pj = j2;
    }
  }
}

/** Point in a flat [x0,z0,x1,z1,…] ring. */
function pointInRing2(p, x, z) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Which way the ridge runs
// ---------------------------------------------------------------------------

/**
 * Turn the ridge so the gable faces the street, and say how many gables.
 *
 * The minimum-area rectangle is the right default for a building standing on
 * its own and the wrong one for a medieval town, because it knows nothing about
 * the street. Measured on the finished data, **164 of the 347** gabled
 * footprints in the core carried a ridge running *along* the street — the roof
 * then slopes away behind the façade and from the pavement there is nothing
 * above the eave at all. That is the "flat-topped slab" the client saw, and it
 * is the half of the town where the min-area rectangle happens to be widest
 * along the frontage.
 *
 * Krumlov's plots are the other way round: narrow to the street, deep behind
 * it, ridge running back, **gable to the street** — which is the single thing
 * that makes the town read as itself at eye level. So where the fitted ridge
 * runs along the street, it is turned 90°, and where the footprint is wider
 * than one plot the roof becomes a *comb* of that many gables. That is not a
 * stylisation: a 30 m OSM polygon on Náměstí Svornosti is three or four
 * medieval houses that were merged by a later owner and mapped as one, and each
 * of them still has its own gable on the square.
 *
 * The bay width is 8.5 m, which is the median frontage of the footprints in the
 * core that already stand gable-on. The town measures its own plot width.
 */
function faceGablesToStreet(buildings, paved) {
  const grid = new SegGrid(paved);
  let turned = 0;
  let bays = 0;

  for (const b of buildings) {
    if (b.s !== ROOF.GABLED && b.s !== ROOF.HALF_HIPPED) continue;
    // Burgher houses only. A church, a castle wing or a tower is not a plot on
    // a street: it is a single designed mass with one long unified roof, and
    // combing it produced a row of 60° spikes across the castle terrace that
    // read as shark teeth from Latrán. `k` is 0 ordinary, 4 outbuilding.
    if (b.k !== 0 && b.k !== 4) continue;
    const n = b.p.length / 2;
    if (n < 3) continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += b.p[i * 2];
      cz += b.p[i * 2 + 1];
    }
    cx /= n;
    cz /= n;
    // The historic core plus Latrán. Outside it the settlement is nineteenth
    // and twentieth century, where a ridge along the street is simply correct.
    if (Math.hypot(cx, cz) > 340) continue;

    const st = grid.nearest(cx, cz);
    if (!st || st.d > 26) continue;
    const sl = Math.hypot(st.dx, st.dz);
    if (sl < 1e-6) continue;
    const ux = st.dx / sl;
    const uz = st.dz / sl;

    // Frontage and depth in the street's own frame.
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = b.p[i * 2];
      const z = b.p[i * 2 + 1];
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const frontage = u1 - u0;
    const depth = v1 - v0;
    // A ridge needs something to run along. Under about 4.5 m of depth the
    // building is a wall with a lid and turning the roof only makes a very
    // steep, very short tent.
    if (depth < 4.5 || frontage < 3.5) continue;

    const az = (b.a * Math.PI) / 180;
    const cosA = Math.abs(Math.sin(az) * ux + -Math.cos(az) * uz);
    // Already gable-on: leave the azimuth alone, but mark it authoritative so
    // the renderer's long-axis guard does not undo it.
    // The comb always divides the frontage, because with the ridge running back
    // from the street it is the frontage that the tents span.
    const combBays = (width) => {
      let k = Math.max(1, Math.min(6, Math.round(width / 8.5)));
      while (k > 1 && width / k < 5.5) k--;
      return k;
    };

    /**
     * Keep the measured ridge and move the eave to keep the pitch sane.
     *
     * The eave came out of a tent fit across the *minimum-area rectangle's*
     * short axis. Turning the ridge changes what the roof spans, and the rise
     * that was a 45° roof over an 11 m span is a 62° spike over an 8.5 m bay.
     * The ridge is the one measured quantity here — it is the p94 of the LiDAR
     * and it is the skyline — so the ridge is what is kept, and the eave, which
     * was always derived, moves. Bohemian tile lives between about 39° and 52°;
     * outside that the wall gets taller or shorter and the silhouette does not
     * change at all.
     */
    const refit = () => {
      const halfSpan = frontage / b.n / 2;
      const rise = b.r - b.e;
      const want = Math.min(Math.max(rise, halfSpan * 0.8), halfSpan * 1.3);
      b.e = round1(Math.min(b.r - 0.5, Math.max(b.b + 2.2, b.r - want)));
    };

    if (cosA <= Math.cos((35 * Math.PI) / 180)) {
      b.n = combBays(frontage);
      if (b.n > 1) refit();
      bays += b.n;
      continue;
    }

    // Turn it. The new ridge runs perpendicular to the street, i.e. back into
    // the plot; azimuth 0 is north (−z) and positive is clockwise.
    const nx = -uz;
    const nz = ux;
    b.a = Math.round((Math.atan2(nx, -nz) * 180) / Math.PI);
    b.n = combBays(frontage);
    refit();
    turned++;
    bays += b.n;
  }
  return { turned, bays };
}

/** Uniform grid over the paved centrelines, for a nearest-street query. */
class SegGrid {
  constructor(paved) {
    this.cell = 24;
    this.cells = new Map();
    this.seg = [];
    for (const w of paved) {
      const n = w.l.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const ax = w.l[i * 2];
        const az = w.l[i * 2 + 1];
        const bx = w.l[i * 2 + 2];
        const bz = w.l[i * 2 + 3];
        if (Math.hypot(bx - ax, bz - az) < 1.5) continue;
        const idx = this.seg.length;
        this.seg.push([ax, az, bx, bz]);
        const i0 = Math.floor(Math.min(ax, bx) / this.cell);
        const i1 = Math.floor(Math.max(ax, bx) / this.cell);
        const j0 = Math.floor(Math.min(az, bz) / this.cell);
        const j1 = Math.floor(Math.max(az, bz) / this.cell);
        for (let j = j0; j <= j1; j++) {
          for (let i2 = i0; i2 <= i1; i2++) {
            const key = i2 * 100003 + j;
            let list = this.cells.get(key);
            if (!list) {
              list = [];
              this.cells.set(key, list);
            }
            list.push(idx);
          }
        }
      }
    }
  }

  nearest(x, z) {
    let best = null;
    let bd = Infinity;
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(z / this.cell);
    // Two cells out covers the 26 m acceptance radius at a 24 m cell. Swept in
    // full rather than stopping at the first hit: the nearest segment is not
    // necessarily in the nearest cell.
    {
      const r = 2;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          const list = this.cells.get(i * 100003 + j);
          if (!list) continue;
          for (const k of list) {
            const s = this.seg[k];
            const dx = s[2] - s[0];
            const dz = s[3] - s[1];
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-9 ? ((x - s[0]) * dx + (z - s[1]) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = s[0] + dx * t - x;
            const pz = s[1] + dz * t - z;
            const dd = px * px + pz * pz;
            if (dd < bd) {
              bd = dd;
              best = { d: Math.sqrt(dd), dx, dz };
            }
          }
        }
      }
    }
    return best;
  }
}

/**
 * Highway classes worth stamping, with a default width and the runnability
 * class each maps to. `k` is 0 Road (ISSprOM 501 paved area) or 1 Path
 * (ISSprOM 505/506 unpaved footpath).
 */
const HIGHWAY = {
  motorway: { w: 10, k: 0 },
  trunk: { w: 9, k: 0 },
  primary: { w: 8.5, k: 0 },
  secondary: { w: 7.5, k: 0 },
  tertiary: { w: 6.5, k: 0 },
  unclassified: { w: 5.5, k: 0 },
  residential: { w: 5.5, k: 0 },
  living_street: { w: 5.5, k: 0 },
  pedestrian: { w: 7.0, k: 0 },
  service: { w: 4.0, k: 0 },
  cycleway: { w: 2.6, k: 0 },
  footway: { w: 2.2, k: 0 },
  steps: { w: 1.8, k: 0 },
  path: { w: 1.5, k: 1 },
  track: { w: 3.0, k: 1 },
};

/** Douglas–Peucker-lite: drop vertices closer than `tol` to their neighbour. */
function simplifyLine(pts, tol) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) < tol) continue;
    out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Modelled height per barrier tag, metres. **Only 9 of Krumlov's 701 barrier
 * ways carry a `height` tag**, so for 98.7 % of them this table is the height,
 * and — through `CROSSABLE_MAX_H` — it is also what decides whether the athlete
 * is stopped by it. That is a lot of weight on a default, so each one is chosen
 * to be unambiguous rather than average.
 *
 * `fence` used to be 1.5, which was the worst possible number: `u` was
 * `h > 1.5`, so every untagged fence — 210 ways, **13 849 m, 44 % of all the
 * barrier length in the venue** — landed exactly on the threshold and fell to
 * the crossable side, while still being *drawn* as a 1.5 m opaque slab. The
 * athlete ran straight through fourteen kilometres of visible barrier, which is
 * precisely the report this table now answers.
 *
 * The other way out — call an untagged fence uncrossable — was measured and is
 * worse. Flood-filled from Náměstí Svornosti it takes the reachable venue from
 * 95.1 % to 85.6 %, walling off 10.9 ha including 2.5 ha of *paved street*:
 * OSM does not map the gates, so a fenced plot with a drive in it becomes a
 * sealed pocket. Opening the fence where a paved way crosses it recovers only
 * 3.4 points. So the fence stays crossable and is drawn as what it is.
 */
const BARRIER = {
  wall: { h: 2.4, k: 0 },
  city_wall: { h: 6.5, k: 1 },
  retaining_wall: { h: 2.2, k: 2 },
  fence: { h: 0.9, k: 3 },
  hedge: { h: 1.7, k: 4 },
  guard_rail: { h: 0.9, k: 3 },
};

/**
 * The invariant that ties the geometry to the collider, metres.
 *
 * **A barrier is crossable if and only if it is drawn no taller than this.**
 * Not "1.5 m, because ISSprOM 515/518 say so" — that is the right *cartographic*
 * line and the wrong *game* one, because between 0.9 m and 1.5 m sits a band of
 * barriers that look solid from a 1.62 m eye and were not solid. Whatever the
 * player can see standing in front of them has to behave the way it looks:
 * step over it, or be stopped by it, with nothing in between.
 *
 * `Townscape.buildWall` in src/world/townscape.ts clamps to the same number, so
 * a stale townscape.json cannot put a wall back that is drawn tall and does not
 * block, and `tools/ci/check-passable.mjs` fails the build if one appears.
 */
const CROSSABLE_MAX_H = 0.9;

function polyline(geom, frame, inReach) {
  const out = [];
  for (const g of geom) {
    const p = toWorld(frame, g.lon, g.lat);
    if (!inReach(p[0], p[1])) {
      // Keep the run that is inside; a wall clipped at the AOI edge is better
      // than a wall that vanishes because one node is outside.
      if (out.length >= 2) break;
      continue;
    }
    out.push([round1(p[0]), round1(p[1])]);
  }
  return out;
}

function flatten(pts) {
  const out = new Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[i * 2] = pts[i][0];
    out[i * 2 + 1] = pts[i][1];
  }
  return out;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function waterLevel(ring, groundAt) {
  // The DMR is a bare-earth model and the river surface is in it, so the low
  // percentile of the ground inside the polygon *is* the water level.
  const vals = ring.map((p) => groundAt(p[0], p[1])).sort((a, b) => a - b);
  return percentile(vals, 0.25) + 0.15;
}

/**
 * One building: footprint, measured eave and ridge, roof shape, colours.
 */
/**
 * Grid index of footprints, used only to mask out nested ones.
 */
class Nested {
  constructor() {
    this.cells = new Map();
    this.rings = [];
    this.areas = [];
    this.ids = [];
    this.cell = 16;
  }

  add(id, ring, area) {
    const i = this.rings.length;
    this.rings.push(ring);
    this.areas.push(area);
    this.ids.push(id);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(i);
      }
    }
  }

  /** True if (x,z) is inside a different footprint smaller than `area`. */
  coveredBySmaller(x, z, id, area) {
    const key = Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
    const list = this.cells.get(key);
    if (!list) return false;
    for (const i of list) {
      if (this.ids[i] === id) continue;
      if (this.areas[i] >= area) continue;
      if (pointInRing(this.rings[i], x, z)) return true;
    }
    return false;
  }
}

function makeBuilding(el, tags, geom, frame, groundAt, chmAt, inReach, nested) {
  let ring = [];
  for (const g of geom) {
    ring.push(toWorld(frame, g.lon, g.lat));
  }
  // Overpass repeats the first node to close the way.
  if (
    ring.length > 1 &&
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.05
  ) {
    ring.pop();
  }
  ring = simplifyRing(ring, 0.3);
  if (ring.length < 3) return null;

  const c = centroid(ring);
  if (!inReach(c[0], c[1])) return null;

  let area = ringArea(ring);
  if (Math.abs(area) < 4) return null; // ISSprOM 521 minimum is 4 m²
  // Counter-clockwise in world (x east, z south) so the extruder's winding and
  // the outward normals agree without a per-building test.
  if (area < 0) {
    ring.reverse();
    area = -area;
  }

  const rect = minAreaRect(ring);

  // --- measured roof ------------------------------------------------------
  // Rasterise the footprint at 1 m and read DMR + CHM inside it. A 1 m step on
  // a 2 m CHM oversamples deliberately: small Krumlov footprints would
  // otherwise get two or three cells and no usable percentile.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }

  // Samples are kept in the min-area-rect frame: `v` is the signed distance
  // across the short axis, i.e. away from the ridge line. That is what makes
  // the pitch fit below possible.
  const ux = Math.sin(rect.angle);
  const uz = -Math.cos(rect.angle);
  const samples = [];
  const groundVals = [];
  const step = Math.max(0.6, Math.min(2, Math.sqrt(area) / 8));
  for (let z = minZ + step * 0.5; z <= maxZ; z += step) {
    for (let x = minX + step * 0.5; x <= maxX; x += step) {
      if (!pointInRing(ring, x, z)) continue;
      // A tower, a turret or an annexe mapped as its own footprint inside this
      // one is not part of this building's roof, and it dominates the
      // percentile if it is left in.
      if (nested && nested.coveredBySmaller(x, z, el.id, area)) continue;
      const g = groundAt(x, z);
      groundVals.push(g);
      const chm = chmAt(x, z);
      // Below 2 m is either an edge cell that caught the street or a genuinely
      // trivial structure; either way it must not drag the fit down.
      if (chm < 2) continue;
      const dx = x - c[0];
      const dz = z - c[1];
      samples.push({
        // Across the short axis — the tent profile of a ridge running along
        // the plot, which is the normal Krumlov case.
        v: Math.abs(-dx * uz + dz * ux),
        // Along the long axis — the tent profile of a ridge running across it,
        // which happens on the corner houses and on anything the minimum-area
        // rectangle called wrong.
        u: Math.abs(dx * ux + dz * uz),
        y: g + chm,
      });
    }
  }
  groundVals.sort((a, b) => a - b);
  const roofTop = samples.map((s) => s.y).sort((a, b) => a - b);

  const baseY = groundVals.length ? percentile(groundVals, 0.12) : groundAt(c[0], c[1]);

  const levels = Number(tags['building:levels']);
  const roofLevels = Number(tags['roof:levels']);
  const tagged = tags.height ? Number(tags.height) : NaN;

  let eaveY;
  let ridgeY;
  let src = 'levels';

  // A footprint needs enough roof samples for the fit to mean anything. Below
  // ~8 the CHM is describing the edge, not the roof.
  const coverage = samples.length / Math.max(1, groundVals.length);
  let measuredPitch = null;
  let roofSpread = 0;
  if (samples.length >= 8 && coverage > 0.45) {
    const top = percentile(roofTop, 0.94);
    if (top - baseY >= 2.2 && top - baseY < 80) {
      // Two separate things are read off the LiDAR here, and they want
      // different estimators.
      //
      // The **ridge** is a percentile of the samples — the top of the roof is
      // genuinely the highest thing inside the footprint, and p94 rejects the
      // odd chimney or overhanging lime without losing the ridge itself.
      //
      // The **pitch** is a least-squares fit of a tent profile across the
      // short axis. Reading the eave off a low percentile instead does not
      // work: a 2 m CHM cell straddling the gutter averages roof and street,
      // so the bottom of the distribution is contamination, not the eave.
      ridgeY = top;
      roofSpread = percentile(roofTop, 0.9) - percentile(roofTop, 0.1);
      // Fit the tent both ways round and keep whichever explains the LiDAR
      // better. Without this, the minimum-area rectangle alone decided the
      // ridge direction, and on a corner plot or a re-entrant footprint it is
      // regularly 90° out — which then showed up as a *flat* roof, because a
      // tent fitted across its own ridge has no gradient. That single failure
      // was putting flat roofs on 29 % of the old town.
      const alongLong = fitPitch(samples, 'v', rect.short * 0.5);
      const alongShort = fitPitch(samples, 'u', rect.long * 0.5);
      // Take the *steeper* of the two fits, but always express it across the
      // rectangle's short axis, which is where the ridge of a Krumlov house
      // runs. An earlier version also let the fit choose the ridge *direction*,
      // and that was a mistake: on an irregular footprint it regularly picked
      // the long axis, which puts the ridge line along the façade instead of
      // down the middle of the plot. The wall then builds up to the ridge over
      // its whole length and the result is a flat-topped slab with its roof
      // hidden behind it — which is exactly what stood on Náměstí Svornosti.
      const k = Math.max(alongLong?.pitch ?? 0, alongShort?.pitch ?? 0);
      if (alongLong || alongShort) {
        measuredPitch = { pitch: k, halfSpan: rect.short * 0.5, rms: 0 };
      }
      src = 'chm';
    }
  }

  if (src !== 'chm') {
    const n = Number.isFinite(levels) && levels > 0 ? levels : defaultLevels(tags);
    ridgeY = baseY + Math.max(3.0, n * STOREY_M) + (roofLevels === 0 ? 0.4 : 3.4);
  }

  if (Number.isFinite(tagged) && tagged > 3) {
    // An explicitly surveyed height wins over both — this is what carries the
    // castle tower's 54.5 m, which the CHM clips at its own 60 m ceiling.
    ridgeY = baseY + tagged;
  }

  // --- roof shape ---------------------------------------------------------
  const taggedShape = ROOF_TAG[String(tags['roof:shape'] ?? '').toLowerCase()];
  let shape = taggedShape;
  const measuredK = measuredPitch ? measuredPitch.pitch : null;
  // A pitched roof leaves a wide spread in the CHM whatever its plan shape.
  // This is the backstop for the ~20 % of the old town whose footprint is an L
  // or a double pile, where a single tent fit finds almost no gradient and the
  // building would otherwise be given a flat roof at 12 m — visibly wrong, and
  // wrong in the one place the skyline is being judged.
  const pitched = (measuredK !== null && measuredK >= 0.18) || roofSpread > 2.2;
  if (shape === undefined) {
    // A measured pitch under about 10° with no spread is a flat roof with a
    // fall on it: most of the twentieth-century town and all of the garages.
    if (measuredK !== null && !pitched) shape = ROOF.FLAT;
    else if (measuredK === null && (kindOf(tags) === 4 || !Number.isFinite(roofLevels)))
      shape = ROOF.GABLED;
    // A deep, roughly square plan under a steep roof is a hip, not a gable —
    // a 20 m gable over a 20 m-deep plan does not exist in this town.
    else if (rect.long / Math.max(1, rect.short) < 1.35 && rect.short > 9) shape = ROOF.HIPPED;
    else shape = ROOF.GABLED;
  }

  // --- eave ---------------------------------------------------------------
  // The eave is *derived*, never measured: ridge minus the pitch across the
  // half-width. The pitch floor is the honest part of this. A 2 m CHM cell is
  // an area average of a tent, so the fitted slope of a 10 m-wide house is
  // systematically shallow — measured median came out near 24°, and Bohemian
  // tile does not exist at 24°: it needs 40°+ to shed snow, which is why the
  // whole town has the silhouette it has. So the fit decides *whether* there
  // is a pitch and roughly how steep, and a 40° floor stops the smoothing from
  // flattening the skyline.
  // The old town has essentially no flat roofs. The ČÚZK orthophoto over the
  // meander is an unbroken field of pitched tile, and the handful of flat
  // patches in it are lift overruns and light wells, not roofs. So inside the
  // historic core an *untagged* building that the CHM read as flat is treated
  // as a measurement failure rather than as a flat roof — usually a narrow
  // burgher house whose ridge runs across two CHM cells and leaves no gradient
  // to fit. Outside the core, flat roofs are real and common and this does not
  // apply.
  const inCore = Math.hypot(c[0], c[1]) < 300;
  if (
    shape === ROOF.FLAT &&
    taggedShape === undefined &&
    inCore &&
    ridgeY - baseY > 6 &&
    kindOf(tags) !== 4
  ) {
    shape = rect.long / Math.max(1, rect.short) < 1.35 && rect.short > 9
      ? ROOF.HIPPED
      : ROOF.GABLED;
  }

  if (shape === ROOF.FLAT) {
    eaveY = ridgeY - 0.4;
  } else {
    const light = kindOf(tags) === 4; // garages and sheds are genuinely shallower
    const k = Math.max(measuredK ?? 0, light ? 0.45 : 0.84);
    const halfSpan = Math.max(1.2, measuredPitch ? measuredPitch.halfSpan : rect.short * 0.5);
    // p10..p90 of the CHM covers most but not all of a tent's range, and a 2 m
    // cell average clips both ends further, so the spread understates the rise
    // by roughly a quarter.
    const fromSpread = roofSpread > 2.2 ? roofSpread : 0;
    // A Bohemian tile roof is about a third of the building. The cap is what
    // stops a noisy CHM spread from eating the wall: measured without it, the
    // old town came out at 5.4 m of plaster under 6.5 m of tile, which is a
    // roof with a plinth rather than a townhouse.
    const rise = Math.min(Math.max(k * halfSpan, fromSpread), (ridgeY - baseY) * 0.42, 14);
    eaveY = ridgeY - Math.max(0.8, rise);
  }
  if (eaveY < baseY + 2.2) eaveY = Math.min(baseY + 2.2, ridgeY - 0.5);
  if (eaveY > ridgeY - 0.3) eaveY = ridgeY - 0.3;

  const kind = kindOf(tags);

  // --- colour -------------------------------------------------------------
  const r = hashId(el.id);
  const wall = parseColour(tags['building:colour'], PLASTER[Math.floor(r * PLASTER.length)]);
  const weathered = hashId(el.id ^ 0x9e3779b9) < 0.1;
  const roofDefault = weathered
    ? TILE_WEATHERED[Math.floor(hashId(el.id * 3 + 7) * TILE_WEATHERED.length)]
    : TILE[Math.floor(hashId(el.id * 5 + 11) * TILE.length)];
  const roofColour = liftRoof(parseColour(tags['roof:colour'], roofDefault));

  const b = {
    p: flatten(ring.map((p) => [round1(p[0]), round1(p[1])])),
    b: round1(baseY),
    e: round1(eaveY),
    r: round1(ridgeY),
    s: shape,
    a: Math.round((rect.angle * 180) / Math.PI),
    w: wall,
    c: roofColour,
    k: kind,
    src,
  };
  if (tags.name || kind > 0) b.id = el.id;
  return b;
}

/**
 * Fit `y = ridge − k·|v|` to the roof samples, robustly.
 *
 * `v` is distance from the ridge line across the short axis. One least-squares
 * pass, then a second with anything more than 1.8 m below the first fit thrown
 * out — those are the gutter cells where a 2 m CHM footprint hangs half over
 * the street, and left in they roughly double the apparent pitch.
 *
 * Returns null when the fit is degenerate (all samples at one `v`, e.g. a
 * long narrow footprint one cell wide).
 */
function fitPitch(samples, axis, halfSpan) {
  const solve = (set) => {
    let n = 0;
    let sv = 0;
    let sy = 0;
    let svv = 0;
    let svy = 0;
    for (const s of set) {
      const v = s[axis];
      n++;
      sv += v;
      sy += s.y;
      svv += v * v;
      svy += v * s.y;
    }
    if (n < 4) return null;
    const den = n * svv - sv * sv;
    if (Math.abs(den) < 1e-6) return null;
    const slope = (n * svy - sv * sy) / den;
    const intercept = (sy - slope * sv) / n;
    return { ridge: intercept, k: -slope };
  };

  const rms = (set, f) => {
    let acc = 0;
    for (const s of set) {
      const d = s.y - (f.ridge - f.k * s[axis]);
      acc += d * d;
    }
    return Math.sqrt(acc / Math.max(1, set.length));
  };

  const f = solve(samples);
  if (!f) return null;
  const kept = samples.filter((s) => s.y > f.ridge - f.k * s[axis] - 1.8);
  const f2 = kept.length >= 6 ? (solve(kept) ?? f) : f;
  const use = kept.length >= 6 ? kept : samples;

  // Bohemian tile sits between about 8° and 60°. Outside that the fit has
  // found something that is not a roof plane.
  const k = Math.max(0, Math.min(1.73, f2.k));
  return { pitch: k, halfSpan, rms: rms(use, f2) };
}

/** 0 ordinary · 1 church · 2 castle · 3 tower · 4 outbuilding. */
function kindOf(tags) {
  if (tags.building === 'church' || tags.amenity === 'place_of_worship') return 1;
  if (tags.historic === 'castle' || tags.building === 'castle') return 2;
  if (tags.man_made === 'tower' || tags['tower:type']) return 3;
  if (
    tags.building === 'garage' ||
    tags.building === 'garages' ||
    tags.building === 'shed' ||
    tags.building === 'greenhouse' ||
    tags.building === 'roof'
  ) {
    return 4;
  }
  return 0;
}

function defaultLevels(tags) {
  switch (tags.building) {
    case 'garage':
    case 'shed':
    case 'greenhouse':
    case 'roof':
      return 1;
    case 'apartments':
    case 'hotel':
    case 'hospital':
      return 3;
    default:
      return 2;
  }
}

main();
