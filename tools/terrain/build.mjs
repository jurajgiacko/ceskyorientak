#!/usr/bin/env node
/**
 * Terrain binary export.
 *
 * Turns ČÚZK open data into the compressed binaries the game loads at runtime.
 * Nothing in `src/` ever calls a geo service — this script is the only place
 * that talks to ČÚZK, and `public/data/<venue>/` is its entire output contract.
 *
 * ---------------------------------------------------------------------------
 * The one non-obvious thing in here: S-JTSK grid north is not true north.
 * ---------------------------------------------------------------------------
 *
 * `src/core/geo.ts` defines the world frame as a local tangent plane with
 * x = east, z = south, i.e. **true** north at -z. EPSG:5514 is an oblique conic
 * whose grid north differs from true north by the meridian convergence, and at
 * Vyšší Brod that is **7.95°** (measured, see `probeAffine` below). Over our
 * 1.2 km half-extent that is a 166 m corner displacement — not a rounding
 * error, a completely different piece of forest.
 *
 * ImageServer only ever emits an axis-aligned raster in `imageSR`, so the
 * fetched rasters are on the rotated 5514 grid and every one of them has to be
 * resampled into the world frame. That resample is done here, once, offline.
 *
 * We do **not** transform coordinates ourselves (RESEARCH-GEODATA §6.3: a naive
 * 3-parameter Krovák shift carries a systematic −9.3 m northing bias). Instead
 * we probe ČÚZK for the 5514 position of three known world points and fit the
 * similarity transform from its own answers. Three tiny exportImage calls buy
 * the entire coordinate problem.
 *
 * ---------------------------------------------------------------------------
 * Tiling
 * ---------------------------------------------------------------------------
 *
 * A 2400 m world square at the 0.5 m sampling we want is 4801 px on a side, and
 * its 5514 axis-aligned envelope is ~5420 px. `MAX_EXPORT_PX` is 4100. So the
 * AOI is split into world-space tiles, each fetched separately, each resampled
 * into the shared world grid with a feathered weight so tile seams cross-fade
 * instead of creasing.
 *
 * DMR 5G and DMP 1G tiles are requested with identical parameters, which ČÚZK
 * returns on an identical grid (verified), and both are pushed through the
 * *same* resampling weights. The canopy height model is therefore an exact
 * per-cell difference even across a tile seam — no resampling error survives
 * into the CHM, which is what the runnability classifier keys off.
 *
 * Usage:
 *   node tools/terrain/build.mjs                # all venues
 *   node tools/terrain/build.mjs --venue=martinkov
 *   node tools/terrain/build.mjs --no-cache     # ignore the tile cache
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, constants } from 'node:zlib';

import { exportElevation, exportOrtho, queryZabagedAll, MAX_EXPORT_PX } from './cuzk.mjs';
import { parseFloat32GeoTiff } from './geotiff.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUT_ROOT = resolve(ROOT, 'public/data');
const CACHE = resolve(__dirname, '.cache');

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith('--venue='))?.slice('--venue='.length) ?? null;
const USE_CACHE = !args.includes('--no-cache');

// ---------------------------------------------------------------------------
// Venue configuration
//
// Mirrors src/core/venues.ts. The forest AOI is Lachovice — permitted training
// terrain — not the embargoed competition area; see DECISIONS.md D-015. Do not
// "fix" this to Martínkov.
// ---------------------------------------------------------------------------

const VENUES = [
  {
    id: 'martinkov',
    label: 'Lachovice (permitted training terrain)',
    origin: { lon: 14.2536, lat: 48.6229 },
    /** Playable area, metres. Matches LACHOVICE_AOI. */
    sizeX: 2000,
    sizeZ: 2000,
    /**
     * Terrain fetched beyond the playable area so the horizon is real relief
     * rather than a cliff into the fog. Costs bytes; 200 m is where the
     * silhouette stops mattering at eye height under 40 m fog.
     */
    skirtM: 200,
    /** Output resolution of the height and runnability rasters, metres/px. */
    resM: 1,
    /** Canopy height model resolution — vegetation placement, not physics. */
    canopyResM: 2,
    /** `low` tier resolution. */
    lowResM: 4,
    /** Source sampling resolution before the world-frame resample. */
    sourceResM: 0.5,
    /** World tiles per side. Each tile's 5514 envelope must stay under MAX_EXPORT_PX. */
    tiles: 2,
  },
  {
    id: 'krumlov',
    label: 'Český Krumlov old town',
    origin: { lon: 14.315, lat: 48.8109 },
    sizeX: 1200,
    sizeZ: 1200,
    skirtM: 200,
    resM: 1,
    canopyResM: 2,
    lowResM: 4,
    sourceResM: 0.5,
    tiles: 2,
  },
];

// ---------------------------------------------------------------------------
// Runnability enum — must stay identical to src/core/types.ts.
// D-002: one enum shared by the map renderer and the physics, so they cannot
// drift. That guarantee only holds if this table matches.
// ---------------------------------------------------------------------------

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

const R_NAME = Object.fromEntries(Object.entries(R).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------------------
// Local tangent plane — the same maths as src/core/geo.ts, duplicated because
// that file is TypeScript and this is a build script. If geo.ts changes, this
// must change with it.
// ---------------------------------------------------------------------------

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;

function metresPerDegLat(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  return ((Math.PI / 180) * WGS84_A * (1 - WGS84_E2)) / (w * w * w);
}

function metresPerDegLon(latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const s = Math.sin(lat);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  return ((Math.PI / 180) * WGS84_A * Math.cos(lat)) / w;
}

function makeFrame(origin) {
  return {
    origin,
    mPerDegLat: metresPerDegLat(origin.lat),
    mPerDegLon: metresPerDegLon(origin.lat),
  };
}

/** world (x east, z south) → WGS84 */
function worldToGeo(f, x, z) {
  return { lon: f.origin.lon + x / f.mPerDegLon, lat: f.origin.lat - z / f.mPerDegLat };
}

/** WGS84 → world (x east, z south) */
function geoToWorld(f, lon, lat) {
  return { x: (lon - f.origin.lon) * f.mPerDegLon, z: -(lat - f.origin.lat) * f.mPerDegLat };
}

// ---------------------------------------------------------------------------
// Coordinate probe: fit world → EPSG:5514 from ČÚZK's own reprojection
// ---------------------------------------------------------------------------

/**
 * Ask the ImageServer to reproject three ~4 m boxes and read the 5514 extent
 * back. For a box that small the envelope centre is the projected centre to
 * well under a millimetre, so three probes pin down a similarity transform.
 *
 * Returns { ax, bx, cx, ay, by, cy } such that
 *   X5514 = ax*x + bx*z + cx
 *   Y5514 = ay*x + by*z + cy
 * for world (x east, z south) in metres.
 */
async function probeAffine(frame) {
  const probe = async (x, z) => {
    const g = worldToGeo(frame, x, z);
    const d = 0.00002; // ≈ 2 m — small enough that the envelope is the point
    const r = await exportElevation(
      'dmr5g',
      { west: g.lon - d, south: g.lat - d, east: g.lon + d, north: g.lat + d },
      2,
      2,
    );
    return [(r.extent.xmin + r.extent.xmax) / 2, (r.extent.ymin + r.extent.ymax) / 2];
  };

  const [p0, pE, pS] = [await probe(0, 0), await probe(1000, 0), await probe(0, 1000)];
  const a = {
    cx: p0[0],
    cy: p0[1],
    ax: (pE[0] - p0[0]) / 1000,
    ay: (pE[1] - p0[1]) / 1000,
    bx: (pS[0] - p0[0]) / 1000,
    by: (pS[1] - p0[1]) / 1000,
  };

  // Convergence and scale, purely for the log — but worth printing, because a
  // convergence far from ~8° would mean the probe went wrong and everything
  // downstream would be silently rotated.
  a.convergenceDeg = (Math.atan2(a.ay, a.ax) * 180) / Math.PI;
  a.scale = Math.hypot(a.ax, a.ay);
  return a;
}

function worldToSjtsk(a, x, z) {
  return [a.ax * x + a.bx * z + a.cx, a.ay * x + a.by * z + a.cy];
}

// ---------------------------------------------------------------------------
// Elevation fetch + world-frame resample
// ---------------------------------------------------------------------------

async function cachedExport(service, bbox, w, h, key) {
  const path = join(CACHE, `${key}.tif`);
  if (USE_CACHE && existsSync(path)) {
    const buf = await readFile(path);
    return { buffer: buf, cached: true };
  }
  const r = await exportElevation(service, bbox, w, h);
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, r.buffer);
  return { buffer: r.buffer, cached: false };
}

/**
 * Fetch DMR 5G and DMP 1G across the AOI and resample both into the world grid.
 *
 * Feathering: each tile is given a weight that ramps to zero over the outermost
 * `FEATHER` cells of its own footprint, so overlapping tiles cross-fade. Both
 * rasters share the weight, so the CHM difference stays exact.
 */
async function fetchElevation(v, frame, affine, grid) {
  const n = grid.w * grid.h;
  const dtm = new Float64Array(n);
  const dsm = new Float64Array(n);
  const wsum = new Float64Array(n);

  const FEATHER = 24; // cells of cross-fade at each tile edge
  const OVERLAP_M = 60; // world metres each tile reaches past its share

  const tileW = grid.spanX / v.tiles;
  const tileH = grid.spanZ / v.tiles;
  let bytes = 0;
  let fetched = 0;

  for (let ty = 0; ty < v.tiles; ty++) {
    for (let tx = 0; tx < v.tiles; tx++) {
      // World footprint of this tile, with overlap.
      const x0 = grid.minX + tx * tileW - OVERLAP_M;
      const x1 = grid.minX + (tx + 1) * tileW + OVERLAP_M;
      const z0 = grid.minZ + ty * tileH - OVERLAP_M;
      const z1 = grid.minZ + (ty + 1) * tileH + OVERLAP_M;

      // Geographic AABB of that world rectangle. The 5514 envelope ČÚZK
      // returns for this AABB necessarily contains the world rectangle.
      const corners = [
        worldToGeo(frame, x0, z0),
        worldToGeo(frame, x1, z0),
        worldToGeo(frame, x0, z1),
        worldToGeo(frame, x1, z1),
      ];
      const bbox = {
        west: Math.min(...corners.map((c) => c.lon)),
        east: Math.max(...corners.map((c) => c.lon)),
        south: Math.min(...corners.map((c) => c.lat)),
        north: Math.max(...corners.map((c) => c.lat)),
      };

      // Pixel size: the 5514 envelope of that geographic box, at sourceResM.
      const env = envelopeSjtsk(affine, frame, bbox);
      const px = Math.ceil((env.xmax - env.xmin) / v.sourceResM);
      const py = Math.ceil((env.ymax - env.ymin) / v.sourceResM);
      if (px > MAX_EXPORT_PX || py > MAX_EXPORT_PX) {
        throw new Error(
          `tile ${tx},${ty} needs ${px}x${py} px — raise \`tiles\` for ${v.id}`,
        );
      }

      process.stdout.write(`    tile ${tx},${ty} ${px}x${py} px … `);
      const [a, b] = await Promise.all([
        cachedExport('dmr5g', bbox, px, py, `${v.id}_dmr_${tx}_${ty}`),
        cachedExport('dmp1g', bbox, px, py, `${v.id}_dmp_${tx}_${ty}`),
      ]);
      bytes += a.buffer.length + b.buffer.length;
      if (!a.cached || !b.cached) fetched++;

      const rasDtm = parseFloat32GeoTiff(a.buffer);
      const rasDsm = parseFloat32GeoTiff(b.buffer);

      // The "identical grid for identical params" claim, actually checked.
      if (
        rasDtm.width !== rasDsm.width ||
        rasDtm.height !== rasDsm.height ||
        Math.abs(rasDtm.origin[0] - rasDsm.origin[0]) > 1e-6 ||
        Math.abs(rasDtm.origin[1] - rasDsm.origin[1]) > 1e-6
      ) {
        throw new Error(
          `DMR/DMP grids diverged for tile ${tx},${ty} — the no-resampling assumption is broken`,
        );
      }
      console.log(`${a.cached && b.cached ? 'cache' : 'fetched'} (${rasDtm.width}x${rasDtm.height})`);

      accumulateTile(
        { dtm, dsm, wsum, grid },
        { rasDtm, rasDsm },
        affine,
        { x0, x1, z0, z1 },
        FEATHER,
      );
    }
  }

  // Resolve the accumulators.
  const height = new Float32Array(n);
  const canopy = new Float32Array(n);
  let holes = 0;
  for (let i = 0; i < n; i++) {
    if (wsum[i] > 1e-9) {
      const h = dtm[i] / wsum[i];
      height[i] = h;
      canopy[i] = Math.max(0, Math.min(60, dsm[i] / wsum[i] - h));
    } else {
      height[i] = NaN;
      holes++;
    }
  }
  if (holes > 0) fillHoles(height, grid.w, grid.h);
  return { height, canopy, bytes, fetched, holes };
}

/** 5514 axis-aligned envelope of a geographic AABB, via the fitted affine. */
function envelopeSjtsk(affine, frame, bbox) {
  const pts = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.west, bbox.north],
    [bbox.east, bbox.north],
  ].map(([lon, lat]) => {
    const w = geoToWorld(frame, lon, lat);
    return worldToSjtsk(affine, w.x, w.z);
  });
  return {
    xmin: Math.min(...pts.map((p) => p[0])),
    xmax: Math.max(...pts.map((p) => p[0])),
    ymin: Math.min(...pts.map((p) => p[1])),
    ymax: Math.max(...pts.map((p) => p[1])),
  };
}

/**
 * Bilinearly sample one source raster pair into the world grid, weighted.
 *
 * `ras.origin` / `ras.pixelScale` come from the GeoTIFF's own tiepoint and
 * pixel-scale tags, so the georeferencing is ČÚZK's, not ours.
 */
function accumulateTile(dst, src, affine, foot, feather) {
  const { dtm, dsm, wsum, grid } = dst;
  const { rasDtm, rasDsm } = src;

  const ox = rasDtm.origin[0];
  const oy = rasDtm.origin[1];
  const sx = rasDtm.pixelScale[0];
  const sy = rasDtm.pixelScale[1];
  const rw = rasDtm.width;
  const rh = rasDtm.height;
  const nod = rasDtm.noData;

  // World cell index range this tile can contribute to.
  const i0 = Math.max(0, Math.floor((foot.x0 - grid.minX) / grid.res));
  const i1 = Math.min(grid.w - 1, Math.ceil((foot.x1 - grid.minX) / grid.res));
  const j0 = Math.max(0, Math.floor((foot.z0 - grid.minZ) / grid.res));
  const j1 = Math.min(grid.h - 1, Math.ceil((foot.z1 - grid.minZ) / grid.res));

  const featherM = feather * grid.res;

  for (let j = j0; j <= j1; j++) {
    const z = grid.minZ + j * grid.res;
    // Distance from the tile's world footprint edge, in metres.
    const dz = Math.min(z - foot.z0, foot.z1 - z);
    if (dz < 0) continue;
    for (let i = i0; i <= i1; i++) {
      const x = grid.minX + i * grid.res;
      const dx = Math.min(x - foot.x0, foot.x1 - x);
      if (dx < 0) continue;

      const w = Math.min(1, dx / featherM) * Math.min(1, dz / featherM);
      if (w <= 0) continue;

      const [X, Y] = worldToSjtsk(affine, x, z);
      const fu = (X - ox) / sx;
      const fv = (oy - Y) / sy; // raster rows run north → south
      if (fu < 0 || fv < 0 || fu >= rw - 1 || fv >= rh - 1) continue;

      const u = Math.floor(fu);
      const vv = Math.floor(fv);
      const tu = fu - u;
      const tv = fv - vv;
      const k00 = vv * rw + u;
      const k10 = k00 + 1;
      const k01 = k00 + rw;
      const k11 = k01 + 1;

      const a00 = rasDtm.data[k00];
      const a10 = rasDtm.data[k10];
      const a01 = rasDtm.data[k01];
      const a11 = rasDtm.data[k11];
      if (a00 === nod || a10 === nod || a01 === nod || a11 === nod) continue;

      const wa = (1 - tu) * (1 - tv);
      const wb = tu * (1 - tv);
      const wc = (1 - tu) * tv;
      const wd = tu * tv;

      const hDtm = a00 * wa + a10 * wb + a01 * wc + a11 * wd;
      const hDsm =
        rasDsm.data[k00] * wa +
        rasDsm.data[k10] * wb +
        rasDsm.data[k01] * wc +
        rasDsm.data[k11] * wd;

      const idx = j * grid.w + i;
      dtm[idx] += hDtm * w;
      dsm[idx] += hDsm * w;
      wsum[idx] += w;
    }
  }
}

/** Fill NaN cells by iterative neighbour averaging. Rare — edges only. */
function fillHoles(a, w, h) {
  for (let pass = 0; pass < 8; pass++) {
    let filled = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!Number.isNaN(a[k])) continue;
        let s = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj;
            const ii = i + di;
            if (jj < 0 || ii < 0 || jj >= h || ii >= w) continue;
            const v = a[jj * w + ii];
            if (!Number.isNaN(v)) {
              s += v;
              n++;
            }
          }
        }
        if (n > 0) {
          a[k] = s / n;
          filled++;
        }
      }
    }
    if (filled === 0) break;
  }
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
}

// ---------------------------------------------------------------------------
// Orthophoto → GLI vegetation mask
//
// RESEARCH-GEODATA §5.2: the CIR service would give a real NIR band, but the
// documented `GR_ORTFOTORGB` CIR request does not return a decodable image
// today (checked). §5.4 sanctions the RGB fallback: GLI > 0.02.
//
// This mask is only ever used to separate *bare* ground (rock, paving, water)
// from *vegetated* open ground on cells where the canopy is under 0.5 m. It is
// never used as a runnability scale — §5.1/§5.2 are unambiguous that it cannot
// carry that load.
// ---------------------------------------------------------------------------

async function fetchVegMask(v, frame, grid) {
  const nw = worldToGeo(frame, grid.minX, grid.minZ);
  const se = worldToGeo(frame, grid.maxX, grid.maxZ);
  const bbox = { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };

  const px = Math.min(2048, Math.ceil(grid.spanX / 1.5));
  const py = Math.min(2048, Math.ceil(grid.spanZ / 1.5));

  let raw;
  const cachePath = join(CACHE, `${v.id}_ortho.png`);
  if (USE_CACHE && existsSync(cachePath)) {
    raw = await readFile(cachePath);
  } else {
    raw = await exportOrtho(bbox, px, py, false);
    await mkdir(CACHE, { recursive: true });
    await writeFile(cachePath, raw);
  }

  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(raw).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  // The WMS grid is a plain lon/lat rectangle, so the inverse is trivial.
  const mask = new Uint8Array(grid.w * grid.h);
  for (let j = 0; j < grid.h; j++) {
    const z = grid.minZ + j * grid.res;
    for (let i = 0; i < grid.w; i++) {
      const x = grid.minX + i * grid.res;
      const g = worldToGeo(frame, x, z);
      const u = Math.round(((g.lon - bbox.west) / (bbox.east - bbox.west)) * (info.width - 1));
      const vv = Math.round(((bbox.north - g.lat) / (bbox.north - bbox.south)) * (info.height - 1));
      if (u < 0 || vv < 0 || u >= info.width || vv >= info.height) continue;
      const o = (vv * info.width + u) * ch;
      const rr = data[o];
      const gg = data[o + 1];
      const bb = data[o + 2];
      const den = 2 * gg + rr + bb;
      const gli = den > 0 ? (2 * gg - rr - bb) / den : 0;
      mask[j * grid.w + i] = gli > 0.02 ? 1 : 0;
    }
  }
  return { mask, bytes: raw.length };
}

// ---------------------------------------------------------------------------
// Runnability classification
// ---------------------------------------------------------------------------

/** Local standard deviation of `a` over a (2r+1)² window, via summed-area tables. */
function localStdDev(a, w, h, r) {
  const s1 = new Float64Array((w + 1) * (h + 1));
  const s2 = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = a[j * w + i];
      const k = (j + 1) * (w + 1) + (i + 1);
      s1[k] = v + s1[k - 1] + s1[k - (w + 1)] - s1[k - (w + 1) - 1];
      s2[k] = v * v + s2[k - 1] + s2[k - (w + 1)] - s2[k - (w + 1) - 1];
    }
  }
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const j0 = Math.max(0, j - r);
    const j1 = Math.min(h - 1, j + r);
    for (let i = 0; i < w; i++) {
      const i0 = Math.max(0, i - r);
      const i1 = Math.min(w - 1, i + r);
      const n = (j1 - j0 + 1) * (i1 - i0 + 1);
      const box = (t) =>
        t[(j1 + 1) * (w + 1) + (i1 + 1)] -
        t[j0 * (w + 1) + (i1 + 1)] -
        t[(j1 + 1) * (w + 1) + i0] +
        t[j0 * (w + 1) + i0];
      const mean = box(s1) / n;
      const varr = Math.max(0, box(s2) / n - mean * mean);
      out[j * w + i] = Math.sqrt(varr);
    }
  }
  return out;
}

/**
 * The classifier from RESEARCH-GEODATA §5.4, evaluated in order.
 *
 * The counter-intuitive rule is load-bearing and deliberate: a 2–5 m
 * regeneration thicket is the *worst* thing to run through, worse than a 25 m
 * mature spruce stand, which is white. Getting this backwards is the single
 * most obvious way to make an orienteer distrust the whole map.
 */
function classify(canopy, rough, veg, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const chm = canopy[i];
    const rg = rough[i];
    let c;
    if (chm < 0.5) {
      if (!veg[i]) c = R.OpenFast; // paving, rock, water — ZABAGED refines below
      else if (rg < 0.25) c = R.OpenFast;
      else c = R.OpenRough;
    } else if (chm < 2.0) {
      c = R.Green1;
    } else if (chm < 5.0) {
      c = R.Green3; // low dense scrub — the "fight"
    } else if (chm < 12.0) {
      c = rg >= 1.6 ? R.Green2 : R.Green1;
    } else {
      c = rg < 2.2 ? R.ForestOpen : rg < 3.4 ? R.Green1 : R.Green2;
    }
    out[i] = c;
  }
  return out;
}

/**
 * Morphological open-then-close on the vegetation classes, then a
 * connected-component area filter.
 *
 * §5.4 step 6 flags this as not optional: the raw classifier output is speckly
 * and over-traces forest edges. ISOM's minimum area for a green patch is about
 * 200 m², so anything smaller is noise the mapper would never have drawn.
 */
function generalise(cls, w, h, resM, minAreaM2) {
  const modeFilter = (src, r) => {
    const dst = new Uint8Array(src.length);
    const counts = new Uint16Array(11);
    for (let j = 0; j < h; j++) {
      const j0 = Math.max(0, j - r);
      const j1 = Math.min(h - 1, j + r);
      for (let i = 0; i < w; i++) {
        counts.fill(0);
        const i0 = Math.max(0, i - r);
        const i1 = Math.min(w - 1, i + r);
        for (let jj = j0; jj <= j1; jj++) {
          for (let ii = i0; ii <= i1; ii++) counts[src[jj * w + ii]]++;
        }
        let best = src[j * w + i];
        let bestN = counts[best];
        for (let c = 0; c < 11; c++) {
          if (counts[c] > bestN) {
            bestN = counts[c];
            best = c;
          }
        }
        dst[j * w + i] = best;
      }
    }
    return dst;
  };

  let cur = modeFilter(cls, 1);
  cur = modeFilter(cur, 2);

  // Drop components below the ISOM minimum patch area, absorbing them into the
  // most common neighbouring class.
  const minCells = Math.max(4, Math.round(minAreaM2 / (resM * resM)));
  const seen = new Uint8Array(cur.length);
  const stack = new Int32Array(cur.length);
  const comp = new Int32Array(cur.length);

  for (let start = 0; start < cur.length; start++) {
    if (seen[start]) continue;
    const c = cur[start];
    let sp = 0;
    let cn = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const k = stack[--sp];
      comp[cn++] = k;
      const i = k % w;
      const j = (k / w) | 0;
      if (i > 0 && !seen[k - 1] && cur[k - 1] === c) (seen[k - 1] = 1), (stack[sp++] = k - 1);
      if (i < w - 1 && !seen[k + 1] && cur[k + 1] === c) (seen[k + 1] = 1), (stack[sp++] = k + 1);
      if (j > 0 && !seen[k - w] && cur[k - w] === c) (seen[k - w] = 1), (stack[sp++] = k - w);
      if (j < h - 1 && !seen[k + w] && cur[k + w] === c) (seen[k + w] = 1), (stack[sp++] = k + w);
    }
    if (cn >= minCells) continue;

    // Too small: replace with the dominant class around its boundary.
    const counts = new Uint32Array(11);
    for (let t = 0; t < cn; t++) {
      const k = comp[t];
      const i = k % w;
      const j = (k / w) | 0;
      if (i > 0 && cur[k - 1] !== c) counts[cur[k - 1]]++;
      if (i < w - 1 && cur[k + 1] !== c) counts[cur[k + 1]]++;
      if (j > 0 && cur[k - w] !== c) counts[cur[k - w]]++;
      if (j < h - 1 && cur[k + w] !== c) counts[cur[k + w]]++;
    }
    let best = c;
    let bestN = 0;
    for (let ci = 0; ci < 11; ci++) {
      if (counts[ci] > bestN) {
        bestN = counts[ci];
        best = ci;
      }
    }
    if (bestN > 0) for (let t = 0; t < cn; t++) cur[comp[t]] = best;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// ZABAGED overlay
//
// ZABAGED is *primary* for the forest venue: OSM has 133 elements there against
// 5973 in the sprint AOI (RESEARCH-GEODATA §4). Keeping the sources split by
// venue also sidesteps ODbL share-alike.
// ---------------------------------------------------------------------------

/**
 * Applied in ascending priority — later layers overwrite earlier ones.
 * `strokeM` is the rendered half-width for line geometry, in metres.
 */
const ZABAGED_LAYERS = [
  { id: 140, name: 'forest with shrub layer', apply: 'promote', to: R.Green1 },
  { id: 141, name: 'dwarf pine', apply: 'set', to: R.Green3 },
  { id: 139, name: 'permanent grassland', apply: 'openOnly', to: R.OpenFast },
  { id: 138, name: 'arable land', apply: 'openOnly', to: R.OpenFast },
  { id: 129, name: 'landslide, scree', apply: 'set', to: R.Rock },
  { id: 130, name: 'rock formations', apply: 'set', to: R.Rock },
  { id: 93, name: 'watercourse', apply: 'set', to: R.Marsh, strokeM: 1.5 },
  { id: 131, name: 'marsh, swamp', apply: 'set', to: R.Marsh },
  { id: 16, name: 'forest ride / firebreak', apply: 'set', to: R.OpenRough, strokeM: 3 },
  { id: 82, name: 'footpath', apply: 'set', to: R.Path, strokeM: 0.8 },
  { id: 150, name: 'marked hiking route', apply: 'set', to: R.Path, strokeM: 0.8 },
  { id: 83, name: 'track / unpaved road', apply: 'set', to: R.Path, strokeM: 1.6 },
  { id: 79, name: 'road, motorway', apply: 'set', to: R.Road, strokeM: 3 },
  { id: 84, name: 'street', apply: 'set', to: R.Road, strokeM: 3.5 },
  { id: 132, name: 'water body', apply: 'set', to: R.Impassable },
  { id: 99, name: 'building', apply: 'set', to: R.Impassable },
];

/** Scanline-fill a polygon ring set into the raster. */
function fillPolygon(rings, grid, visit) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
  }
  const j0 = Math.max(0, Math.floor((minZ - grid.minZ) / grid.res));
  const j1 = Math.min(grid.h - 1, Math.ceil((maxZ - grid.minZ) / grid.res));
  const xs = [];

  for (let j = j0; j <= j1; j++) {
    const z = grid.minZ + j * grid.res;
    xs.length = 0;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (a[1] === b[1]) continue;
        if (z >= Math.min(a[1], b[1]) && z < Math.max(a[1], b[1])) {
          xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - grid.minX) / grid.res));
      const i1 = Math.min(grid.w - 1, Math.floor((xs[k + 1] - grid.minX) / grid.res));
      for (let i = i0; i <= i1; i++) visit(j * grid.w + i);
    }
  }
}

/** Stamp a stroked polyline of half-width `hw` metres. */
function strokeLine(pts, hw, grid, visit) {
  const r = Math.max(1, Math.ceil(hw / grid.res));
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (grid.res * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const ci = Math.round((x - grid.minX) / grid.res);
      const cj = Math.round((z - grid.minZ) / grid.res);
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (di * di + dj * dj > r * r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) continue;
          visit(j * grid.w + i);
        }
      }
    }
  }
}

function geometryToWorld(geom, frame) {
  const conv = (c) => {
    const w = geoToWorld(frame, c[0], c[1]);
    return [w.x, w.z];
  };
  switch (geom?.type) {
    case 'Polygon':
      return { polys: [geom.coordinates.map((r) => r.map(conv))], lines: [] };
    case 'MultiPolygon':
      return { polys: geom.coordinates.map((p) => p.map((r) => r.map(conv))), lines: [] };
    case 'LineString':
      return { polys: [], lines: [geom.coordinates.map(conv)] };
    case 'MultiLineString':
      return { polys: [], lines: geom.coordinates.map((l) => l.map(conv)) };
    default:
      return { polys: [], lines: [] };
  }
}

/** Classes considered "open ground" — the only ones landuse polygons may recolour. */
const OPEN_CLASSES = new Set([R.OpenFast, R.OpenRough]);
/** Classes a `promote` layer is allowed to darken. */
const PROMOTABLE = new Set([R.ForestOpen, R.OpenFast, R.OpenRough]);

async function applyZabaged(cls, grid, frame) {
  const nw = worldToGeo(frame, grid.minX, grid.minZ);
  const se = worldToGeo(frame, grid.maxX, grid.maxZ);
  const bbox = { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };

  const report = [];
  for (const layer of ZABAGED_LAYERS) {
    let fc;
    const cachePath = join(CACHE, `${frame.origin.lon.toFixed(4)}_L${layer.id}.geojson`);
    if (USE_CACHE && existsSync(cachePath)) {
      fc = JSON.parse(await readFile(cachePath, 'utf8'));
    } else {
      try {
        fc = await queryZabagedAll(layer.id, bbox);
      } catch (e) {
        console.log(`    ! L${layer.id} ${layer.name}: ${e.message}`);
        report.push({ layer: layer.id, name: layer.name, features: 0, cells: 0, error: e.message });
        continue;
      }
      await mkdir(CACHE, { recursive: true });
      await writeFile(cachePath, JSON.stringify(fc));
    }

    // Count cells this layer actually *changed*, not brush visits — a stroked
    // line stamps the same cell many times and a visit counter reads ~10x high.
    let cells = 0;
    const visit = (k) => {
      const cur = cls[k];
      if (layer.apply === 'openOnly' && !OPEN_CLASSES.has(cur)) return;
      if (layer.apply === 'promote' && !PROMOTABLE.has(cur)) return;
      if (cur === layer.to) return;
      cls[k] = layer.to;
      cells++;
    };

    for (const f of fc.features ?? []) {
      const { polys, lines } = geometryToWorld(f.geometry, frame);
      for (const p of polys) fillPolygon(p, grid, visit);
      for (const l of lines) strokeLine(l, layer.strokeM ?? 1, grid, visit);
    }
    const n = (fc.features ?? []).length;
    console.log(
      `    L${String(layer.id).padStart(3)} ${layer.name.padEnd(26)} ${String(n).padStart(5)} features → ${cells} cells`,
    );
    report.push({ layer: layer.id, name: layer.name, features: n, cells });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Encoding + output
// ---------------------------------------------------------------------------

/**
 * 16-bit unsigned, normalised over the venue's own min/max.
 *
 * A ~300 m range across 65536 steps is 4.6 mm — two orders of magnitude finer
 * than DMR 5G's own 0.18 m vertical accuracy, so the quantisation is free.
 * Float32 would double the bytes for precision the source does not have.
 */
function encodeHeight16(height) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < height.length; i++) {
    const v = height[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const out = new Uint16Array(height.length);
  for (let i = 0; i < height.length; i++) {
    out[i] = Math.max(0, Math.min(65535, Math.round(((height[i] - min) / span) * 65535)));
  }
  return { data: out, min, max, stepMm: (span / 65535) * 1000 };
}

/** Box-average downsample of a float field. */
function downsampleFloat(src, w, h, factor) {
  const nw = Math.floor((w - 1) / factor) + 1;
  const nh = Math.floor((h - 1) / factor) + 1;
  const out = new Float32Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      let s = 0;
      let n = 0;
      for (let dj = 0; dj < factor; dj++) {
        const jj = Math.min(h - 1, j * factor + dj);
        for (let di = 0; di < factor; di++) {
          const ii = Math.min(w - 1, i * factor + di);
          s += src[jj * w + ii];
          n++;
        }
      }
      out[j * nw + i] = s / n;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Majority downsample of a class field — never invent a class by averaging. */
function downsampleClass(src, w, h, factor) {
  const nw = Math.floor((w - 1) / factor) + 1;
  const nh = Math.floor((h - 1) / factor) + 1;
  const out = new Uint8Array(nw * nh);
  const counts = new Uint16Array(11);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      counts.fill(0);
      for (let dj = 0; dj < factor; dj++) {
        const jj = Math.min(h - 1, j * factor + dj);
        for (let di = 0; di < factor; di++) {
          const ii = Math.min(w - 1, i * factor + di);
          counts[src[jj * w + ii]]++;
        }
      }
      let best = 0;
      let bestN = -1;
      for (let c = 0; c < 11; c++) {
        if (counts[c] > bestN) {
          bestN = counts[c];
          best = c;
        }
      }
      out[j * nw + i] = best;
    }
  }
  return { data: out, w: nw, h: nh };
}

const files = [];

async function emit(dir, name, buf) {
  const path = join(dir, name);
  await writeFile(path, buf);
  const gz = gzipSync(buf, { level: constants.Z_BEST_COMPRESSION }).length;
  const rec = {
    file: name,
    bytes: buf.length,
    gzipBytes: gz,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  files.push(rec);
  return rec;
}

function mb(n) {
  return (n / (1024 * 1024)).toFixed(2);
}

// ---------------------------------------------------------------------------
// Per-venue build
// ---------------------------------------------------------------------------

async function buildVenue(v) {
  console.log(`\n=== ${v.id} — ${v.label} ===`);
  const t0 = Date.now();
  files.length = 0;

  const frame = makeFrame(v.origin);
  const spanX = v.sizeX + 2 * v.skirtM;
  const spanZ = v.sizeZ + 2 * v.skirtM;
  const grid = {
    res: v.resM,
    minX: -spanX / 2,
    minZ: -spanZ / 2,
    maxX: spanX / 2,
    maxZ: spanZ / 2,
    spanX,
    spanZ,
    w: Math.round(spanX / v.resM) + 1,
    h: Math.round(spanZ / v.resM) + 1,
  };
  console.log(`  world grid ${grid.w}x${grid.h} @ ${v.resM} m  (${spanX}x${spanZ} m incl. ${v.skirtM} m skirt)`);

  console.log('  probing ČÚZK for the world→EPSG:5514 transform …');
  const affine = await probeAffine(frame);
  console.log(
    `    origin 5514 = ${affine.cx.toFixed(1)}, ${affine.cy.toFixed(1)} · ` +
      `grid convergence ${affine.convergenceDeg.toFixed(3)}° · scale ${affine.scale.toFixed(6)}`,
  );
  if (Math.abs(affine.convergenceDeg) > 15 || Math.abs(affine.scale - 1) > 0.001) {
    throw new Error('probe produced an implausible transform — refusing to build on it');
  }

  console.log(`  fetching DMR 5G + DMP 1G, ${v.tiles}x${v.tiles} tiles @ ${v.sourceResM} m …`);
  const elev = await fetchElevation(v, frame, affine, grid);
  console.log(
    `    ${mb(elev.bytes)} MB of GeoTIFF · ${elev.holes} unresolved cells`,
  );

  console.log('  orthophoto → GLI vegetation mask …');
  let veg;
  try {
    const r = await fetchVegMask(v, frame, grid);
    veg = r.mask;
    console.log(`    ${mb(r.bytes)} MB PNG · ${((veg.reduce((a, b) => a + b, 0) / veg.length) * 100).toFixed(1)}% vegetated`);
  } catch (e) {
    console.log(`    ! ortho unavailable (${e.message}) — treating all open ground as vegetated`);
    veg = new Uint8Array(grid.w * grid.h).fill(1);
  }

  console.log('  canopy roughness + classification …');
  // 11 m window, as validated. r = 5 cells at 1 m.
  const roughR = Math.max(1, Math.round(5.5 / v.resM));
  const rough = localStdDev(elev.canopy, grid.w, grid.h, roughR);
  let cls = classify(elev.canopy, rough, veg, grid.w * grid.h);
  cls = generalise(cls, grid.w, grid.h, v.resM, 200);

  console.log('  ZABAGED overlay …');
  const zab = await applyZabaged(cls, grid, frame);

  // Distribution, for the honest report.
  const hist = new Array(11).fill(0);
  for (let i = 0; i < cls.length; i++) hist[cls[i]]++;
  console.log('  runnability distribution:');
  for (let c = 0; c < 11; c++) {
    if (!hist[c]) continue;
    console.log(`    ${R_NAME[c].padEnd(11)} ${((hist[c] / cls.length) * 100).toFixed(2)} %`);
  }

  // --- write ---------------------------------------------------------------
  const dir = join(OUT_ROOT, v.id);
  await mkdir(dir, { recursive: true });

  const enc = encodeHeight16(elev.height);
  const heightRec = await emit(dir, 'height.bin', Buffer.from(enc.data.buffer, 0, enc.data.byteLength));
  const heightMeta = {
    format: 'uint16le',
    width: grid.w,
    height: grid.h,
    resM: v.resM,
    minH: enc.min,
    maxH: enc.max,
    /** World coordinates of raster cell (0,0). x east, z south. */
    originX: grid.minX,
    originZ: grid.minZ,
    stepMm: enc.stepMm,
  };
  await emit(dir, 'height.json', Buffer.from(JSON.stringify(heightMeta, null, 2)));

  await emit(dir, 'runnability.bin', Buffer.from(cls.buffer, 0, cls.byteLength));
  await emit(
    dir,
    'runnability.json',
    Buffer.from(
      JSON.stringify(
        {
          format: 'uint8',
          width: grid.w,
          height: grid.h,
          resM: v.resM,
          originX: grid.minX,
          originZ: grid.minZ,
          classes: R_NAME,
          histogram: Object.fromEntries(hist.map((n, c) => [R_NAME[c], n]).filter(([, n]) => n > 0)),
        },
        null,
        2,
      ),
    ),
  );

  // Canopy height model, for vegetation placement. 0..60 m in 8 bits = 0.235 m
  // steps, which is finer than DMP 1G's own 0.7 m accuracy over vegetation.
  const canDown = downsampleFloat(elev.canopy, grid.w, grid.h, Math.round(v.canopyResM / v.resM));
  const can8 = new Uint8Array(canDown.data.length);
  for (let i = 0; i < can8.length; i++) {
    can8[i] = Math.max(0, Math.min(255, Math.round((canDown.data[i] / 60) * 255)));
  }
  await emit(dir, 'canopy.bin', Buffer.from(can8.buffer, 0, can8.byteLength));
  await emit(
    dir,
    'canopy.json',
    Buffer.from(
      JSON.stringify(
        {
          format: 'uint8',
          width: canDown.w,
          height: canDown.h,
          resM: v.canopyResM,
          originX: grid.minX,
          originZ: grid.minZ,
          maxCanopyM: 60,
        },
        null,
        2,
      ),
    ),
  );

  // --- low tier ------------------------------------------------------------
  const lowF = Math.round(v.lowResM / v.resM);
  const hLow = downsampleFloat(elev.height, grid.w, grid.h, lowF);
  const encLow = encodeHeight16(hLow.data);
  await emit(dir, 'height-low.bin', Buffer.from(encLow.data.buffer, 0, encLow.data.byteLength));
  await emit(
    dir,
    'height-low.json',
    Buffer.from(
      JSON.stringify(
        {
          format: 'uint16le',
          width: hLow.w,
          height: hLow.h,
          resM: v.lowResM,
          minH: encLow.min,
          maxH: encLow.max,
          originX: grid.minX,
          originZ: grid.minZ,
          stepMm: encLow.stepMm,
        },
        null,
        2,
      ),
    ),
  );

  const cLow = downsampleClass(cls, grid.w, grid.h, lowF);
  await emit(dir, 'runnability-low.bin', Buffer.from(cLow.data.buffer, 0, cLow.data.byteLength));
  await emit(
    dir,
    'runnability-low.json',
    Buffer.from(
      JSON.stringify(
        {
          format: 'uint8',
          width: cLow.w,
          height: cLow.h,
          resM: v.lowResM,
          originX: grid.minX,
          originZ: grid.minZ,
          classes: R_NAME,
        },
        null,
        2,
      ),
    ),
  );

  // --- manifest ------------------------------------------------------------
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  const totalGzip = files.reduce((a, f) => a + f.gzipBytes, 0);
  const manifest = {
    venue: v.id,
    label: v.label,
    generatedAt: new Date().toISOString(),
    source: {
      elevation: 'ČÚZK DMR 5G + DMP 1G via ArcGIS ImageServer exportImage',
      imagery: 'ČÚZK Ortofoto ČR (WMS)',
      vectors: 'ČÚZK ZABAGED',
      licence: 'CC BY 4.0 — © ČÚZK. See docs/DATA_LICENCES.md',
    },
    origin: v.origin,
    playable: { sizeX: v.sizeX, sizeZ: v.sizeZ },
    skirtM: v.skirtM,
    sjtsk: {
      epsg: 5514,
      originX: affine.cx,
      originY: affine.cy,
      gridConvergenceDeg: affine.convergenceDeg,
      scale: affine.scale,
    },
    tiers: {
      high: { height: 'height.bin', runnability: 'runnability.bin', canopy: 'canopy.bin' },
      medium: { height: 'height.bin', runnability: 'runnability.bin', canopy: 'canopy.bin' },
      low: { height: 'height-low.bin', runnability: 'runnability-low.bin', canopy: 'canopy.bin' },
    },
    zabaged: zab,
    files,
    totalBytes,
    totalGzipBytes: totalGzip,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `  wrote ${files.length} files · ${mb(totalBytes)} MB raw · ${mb(totalGzip)} MB gzip · ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
  for (const f of files) {
    console.log(`    ${(f.bytes / 1024).toFixed(0).padStart(8)} kB  ${(f.gzipBytes / 1024).toFixed(0).padStart(8)} kB gz  ${f.file}`);
  }
  return { venue: v.id, totalBytes, totalGzip };
}

async function main() {
  await mkdir(OUT_ROOT, { recursive: true });
  const summary = [];
  for (const v of VENUES) {
    if (ONLY && v.id !== ONLY) continue;
    summary.push(await buildVenue(v));
  }

  const raw = summary.reduce((a, s) => a + s.totalBytes, 0);
  const gz = summary.reduce((a, s) => a + s.totalGzip, 0);
  console.log(`\nTOTAL terrain payload: ${mb(raw)} MB raw · ${mb(gz)} MB gzip`);

  // The streamed budget is 120 MB and textures already spend ~39 MB of it.
  const textures = await dirBytes(resolve(ROOT, 'public/textures'));
  const models = await dirBytes(resolve(ROOT, 'public/models'));
  const streamed = raw + textures + models;
  console.log(
    `Streamed content: terrain ${mb(raw)} + textures ${mb(textures)} + models ${mb(models)} = ${mb(streamed)} MB (budget 120 MB)`,
  );
  if (streamed > 120 * 1024 * 1024) {
    console.error('✗ streamed budget blown');
    process.exit(1);
  }
}

async function dirBytes(dir) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  const walk = async (d) => {
    for (const name of await readdir(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  if (existsSync(dir)) await walk(dir);
  return total;
}

main().catch((e) => {
  console.error('✗ terrain build failed:', e);
  process.exit(1);
});
