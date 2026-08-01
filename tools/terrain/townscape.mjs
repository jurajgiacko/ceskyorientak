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
        // ISSprOM 515/518: over 1.5 m is uncrossable, and Rule 17.2 makes that
        // legal rather than advisory. Under it, 513.1 passable wall.
        u: h > 1.5 ? 1 : 0,
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
        paved.push({ l: flatten(simplifyLine(line, 1.2)), w: round1(w), k: spec.k });
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
    },
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
  console.log(`  ${(json.length / 1024).toFixed(0)} kB  (gzip ${(gz / 1024).toFixed(0)} kB)`);
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

const BARRIER = {
  wall: { h: 2.4, k: 0 },
  city_wall: { h: 6.5, k: 1 },
  retaining_wall: { h: 2.2, k: 2 },
  fence: { h: 1.5, k: 3 },
  hedge: { h: 1.7, k: 4 },
  guard_rail: { h: 0.9, k: 3 },
};

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
  const roofColour = parseColour(tags['roof:colour'], roofDefault);

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
