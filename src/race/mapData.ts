/**
 * Everything `renderMap` needs, built once per race from the venue's own
 * rasters.
 *
 * Two jobs, both about cost rather than correctness:
 *
 *  - **The runnability raster is passed straight through.** `RunnabilityRaster`
 *    and `TerrainField`'s class raster are the same shape by construction
 *    (D-002 — one enum, one source), so there is no conversion here and there
 *    must never be one. If they ever drift apart, the map would start promising
 *    a green the forest does not deliver.
 *
 *  - **Contours are generated from a decimated heightfield.** Martínkov's
 *    height raster is 2401², i.e. 5.8 M cells, and marching squares over that
 *    at every one of ~58 levels is tens of seconds. Decimating to ~4 m cells
 *    costs nothing an orienteer can see at 1:10 000 — 4 m is 0.4 mm on the
 *    printed sheet — and brings it to well under a second.
 */

import { generateContours, pruneContours, smoothContour } from '@/map/contours';
import type { Contour, Heightfield } from '@/map/contours';
import type { RunnabilityRaster } from '@/map/renderer';
import type { TerrainField } from '@/world/terrain';
import type { VenueAnchor } from '@/core/types';

export interface RaceMapData {
  raster: RunnabilityRaster;
  contours: Contour[];
}

/**
 * Target cell size for contour extraction, metres.
 *
 * Chosen against the *map* rather than the terrain: at 1:10 000 this is 0.4 mm
 * and at 1:4 000 it is 1.0 mm, both below the 0.14 mm line width's ability to
 * show the difference once the line is smoothed.
 */
const CONTOUR_CELL_M = 4;

export function buildMapData(
  field: TerrainField,
  anchor: VenueAnchor,
  /**
   * Class data to draw, if it is not the field's own. The race passes the
   * baked raster from `FieldTerrain`, which carries the scene's walls and
   * building collision as out-of-bounds — so the map shows every barrier that
   * can actually stop the athlete. See `FieldTerrain.bakedRaster`.
   */
  data: Uint8Array = field.runnability,
): RaceMapData {
  return {
    raster: {
      data,
      width: field.rMeta.width,
      height: field.rMeta.height,
      resM: field.rMeta.resM,
      originX: field.rMeta.originX,
      originZ: field.rMeta.originZ,
    },
    contours: buildContours(field, anchor.contourInterval),
  };
}

function buildContours(field: TerrainField, intervalM: number): Contour[] {
  const m = field.hMeta;
  const stride = Math.max(1, Math.round(CONTOUR_CELL_M / m.resM));
  const cellSize = m.resM * stride;
  const width = Math.floor((m.width - 1) / stride) + 1;
  const height = Math.floor((m.height - 1) / stride) + 1;

  const data = new Float32Array(width * height);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < height; j++) {
    const wz = m.originZ + j * cellSize;
    for (let i = 0; i < width; i++) {
      const h = field.heightAt(m.originX + i * cellSize, wz);
      data[j * width + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  const f: Heightfield = {
    data,
    width,
    height,
    cellSize,
    originX: m.originX,
    originZ: m.originZ,
    minH,
    maxH,
  };

  // Smoothing is not cosmetic. Marching squares on a LiDAR-derived surface
  // produces a stepped polyline; a printed contour is a drawn line, and the
  // difference is immediately visible at map zoom.
  //
  // The translation is here because `joinSegments` in src/map/contours.ts emits
  // `cellIndex * cellSize` and never adds `Heightfield.originX/originZ`, even
  // though the interface documents those as "world position of cell (0,0)".
  // At Krumlov that puts every contour 800 m north-west of the ground it
  // describes, and the map draws no contours at all because they are all
  // outside the venue. This is a genuine defect in `contours.ts` — the only
  // existing caller, tools/sim/contour-check.mjs, passes origin 0,0 and so
  // cannot see it — but that file is calibrated and out of scope here, so the
  // frame conversion is done in the adapter and the defect is reported.
  const raw = generateContours(f, intervalM).map((c) => ({
    ...c,
    points: smoothContour(c.points, 2).map((p) => ({
      x: p.x + m.originX,
      z: p.z + m.originZ,
    })),
  }));

  // Below ~40 m on the ground a closed contour is 4 mm across at 1:10 000 —
  // smaller than the smallest feature ISOM asks for, and mostly LiDAR noise.
  return pruneContours(raw, Math.max(20, intervalM * 8));
}
