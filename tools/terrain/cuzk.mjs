/**
 * ČÚZK open-data client.
 *
 * Every endpoint here was exercised with real requests during research — see
 * docs/RESEARCH-GEODATA.md, which records the working call and the actual
 * response for each. Two findings shape this file and are worth stating up
 * front because both cost real time to discover:
 *
 *  1. **There is no WCS.** The documented WCS endpoint returns HTTP 400 and
 *     does not exist. Elevation comes from the ArcGIS ImageServer
 *     `exportImage` operation, which is more capable here anyway because it
 *     reprojects server-side.
 *
 *  2. **Never transform S-JTSK yourself.** An independent Krovák
 *     implementation was measured against ČÚZK's own output: easting agrees to
 *     ~1 m, but the standard three-parameter datum shift carries a systematic
 *     **−9.3 m northing bias** — four to five pixels at 2 m resolution. We pass
 *     `bboxSR=4326` and let ČÚZK do it.
 *
 * Also note the instance split, which is not guessable: elevation lives on
 * `arcgis2`, orthophoto on `arcgis1`. Using the wrong one returns HTTP 400.
 *
 * Licence: CC BY 4.0, including the sui generis database right — confirmed via
 * the national open-data catalogue's SPARQL endpoint, because the geoportal
 * itself does not state a licence. See docs/DATA_LICENCES.md.
 */

import { writeFile } from 'node:fs/promises';

const AGS2 = 'https://ags.cuzk.gov.cz/arcgis2/rest/services';
const AGS1 = 'https://ags.cuzk.gov.cz/arcgis1/services';
/**
 * ZABAGED is a *third* instance, and the service is `ZABAGED_POLOHOPIS`, not
 * `zabaged`. Getting either wrong returns HTTP 404 for every layer id, which
 * looks exactly like "that layer does not exist in this AOI" — a silent
 * failure that ships an empty vector overlay. The URL below is the one in
 * RESEARCH-GEODATA §4 and is re-verified by the terrain build on every run.
 */
const AGS_ZABAGED = 'https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_POLOHOPIS/MapServer';

/** ArcGIS caps a single export at this many pixels on the long edge. */
export const MAX_EXPORT_PX = 4100;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * Export an elevation raster as float32 GeoTIFF.
 *
 * @param {'dmr5g'|'dmp1g'} service  dmr5g = bare terrain, dmp1g = surface incl.
 *   canopy and buildings. Subtracting them gives the canopy height model, which
 *   is what actually drives our runnability classification.
 * @param {{west:number,south:number,east:number,north:number}} bbox  WGS84 degrees
 * @param {number} width  output pixels
 * @param {number} height output pixels
 * @returns {Promise<{buffer:Buffer, extent:object, width:number, height:number}>}
 */
export async function exportElevation(service, bbox, width, height) {
  if (width > MAX_EXPORT_PX || height > MAX_EXPORT_PX) {
    throw new Error(
      `exportImage caps at ${MAX_EXPORT_PX}px; asked for ${width}x${height}. Tile the request.`,
    );
  }

  const params = new URLSearchParams({
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    // WGS84 in, S-JTSK out. Server-side reprojection — see the header note.
    bboxSR: '4326',
    imageSR: '5514',
    size: `${width},${height}`,
    format: 'tiff',
    pixelType: 'F32',
    noData: '-9999',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'json',
  });

  // Step 1: request the export; the service replies with an href, not the image.
  const metaRes = await fetch(
    `${AGS2}/${service}/ImageServer/exportImage?${params}`,
    { headers: { 'User-Agent': UA } },
  );
  if (!metaRes.ok) {
    throw new Error(`${service} exportImage failed: HTTP ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  if (!meta.href) {
    throw new Error(`${service} exportImage returned no href: ${JSON.stringify(meta).slice(0, 300)}`);
  }

  // Step 2: fetch the generated GeoTIFF.
  const tifRes = await fetch(meta.href, { headers: { 'User-Agent': UA } });
  if (!tifRes.ok) throw new Error(`GeoTIFF download failed: HTTP ${tifRes.status}`);
  const buffer = Buffer.from(await tifRes.arrayBuffer());

  return { buffer, extent: meta.extent, width: meta.width, height: meta.height };
}

/**
 * Fetch orthophoto imagery via WMS.
 *
 * Native resolution is 12.5 cm. Note this is `arcgis1` — the elevation instance
 * returns HTTP 400 for this service.
 *
 * @param {object} bbox WGS84
 * @param {number} width
 * @param {number} height
 * @param {boolean} cir  request the colour-infrared layer instead of RGB.
 *   CIR carries a real NIR band. It is **User-Agent gated**: a bare client gets
 *   a 302 to the terms PDF; a browser UA plus Referer gets 200.
 */
export async function exportOrtho(bbox, width, height, cir = false) {
  const params = new URLSearchParams({
    service: 'WMS',
    request: 'GetMap',
    version: '1.3.0',
    layers: cir ? 'GR_ORTFOTORGB' : '0',
    crs: 'CRS:84',
    bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    width: String(width),
    height: String(height),
    format: 'image/png',
    styles: '',
  });

  const res = await fetch(`${AGS1}/ORTOFOTO/MapServer/WMSServer?${params}`, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://ags.cuzk.gov.cz/',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`ortho WMS failed: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  // A redirect to the terms PDF is the documented failure mode; catch it rather
  // than writing a PDF to disk named .png and discovering it much later.
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') {
    throw new Error('ortho WMS returned the terms PDF — User-Agent gate not satisfied');
  }
  return buf;
}

/**
 * Query a ZABAGED vector layer as GeoJSON.
 *
 * ZABAGED is the primary source for the FOREST venue: OSM coverage there is
 * 133 elements against 5973 in the sprint AOI. Keeping the two sources split by
 * venue also sidesteps ODbL share-alike, which would be triggered by merging
 * our own or ZABAGED data into an OSM feature type.
 *
 * @param {number} layerId  see docs/RESEARCH-GEODATA.md for the 149-layer index
 * @param {object} bbox WGS84
 */
export async function queryZabaged(layerId, bbox, { resultOffset = 0, pageSize = 2000 } = {}) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    resultOffset: String(resultOffset),
    resultRecordCount: String(pageSize),
    f: 'geojson',
  });

  const res = await fetch(`${AGS_ZABAGED}/${layerId}/query?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`ZABAGED layer ${layerId} failed: HTTP ${res.status}`);
  return res.json();
}

/** Page through a ZABAGED layer until exhausted. */
export async function queryZabagedAll(layerId, bbox) {
  const features = [];
  for (let offset = 0; ; offset += 2000) {
    const page = await queryZabaged(layerId, bbox, { resultOffset: offset });
    const got = page.features ?? [];
    features.push(...got);
    if (got.length < 2000) break;
    if (features.length > 50000) {
      console.warn(`  ! layer ${layerId} exceeded 50k features — truncating`);
      break;
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Convenience for scripts: fetch and write in one step. */
export async function saveElevation(service, bbox, w, h, path) {
  const { buffer, extent } = await exportElevation(service, bbox, w, h);
  await writeFile(path, buffer);
  return { bytes: buffer.length, extent };
}
