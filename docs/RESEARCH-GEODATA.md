# Geodata research — terrain pipeline for the browser orienteering game

**Researched:** 2026-08-01. Every endpoint marked CONFIRMED below was exercised with a real
`curl` request on that date and the response inspected. Untested claims are marked UNVERIFIED.

**Companion document:** [`DATA_LICENCES.md`](./DATA_LICENCES.md) — licence terms, attribution
strings and redistribution analysis for every source listed here.

---

## 0. TL;DR — what to build on

| Need | Source | Status |
|---|---|---|
| Terrain heightmap | **ČÚZK DMR 5G** via ArcGIS ImageServer `exportImage` → float32 GeoTIFF | ✅ CONFIRMED |
| Canopy / building height | **DMP 1G − DMR 5G** (both from the same ImageServer, identical grid) | ✅ CONFIRMED |
| Aerial imagery | **ČÚZK Ortofoto ČR** WMS, native 12.5 cm | ✅ CONFIRMED |
| Infrared / NDVI | **ČÚZK Ortofoto CIR** WMS, per-year layers 2010–2025 | ✅ CONFIRMED |
| Vector topography (forest AOI) | **ZABAGED Polohopis** ArcGIS `query` → GeoJSON, 149 layers | ✅ CONFIRMED |
| Vector detail (sprint AOI) | **OpenStreetMap** via Overpass API | ✅ CONFIRMED |
| Contours | ZABAGED Vrstevnice (1 m) — *but prefer generating your own from DMR 5G* | ✅ CONFIRMED |
| Elevation cross-check | Copernicus DEM GLO-30 | ✅ CONFIRMED (by sub-research) |
| Google Maps Platform | **DO NOT USE** — ToS explicitly prohibits our exact use case | ✅ CONFIRMED |

Everything in the primary path is **CC BY 4.0** (ČÚZK) or **ODbL** (OSM). Both are shippable in a
commercial marketing game with attribution. See `DATA_LICENCES.md`.

### Two AOIs used throughout

| AOI | Centre | WGS84 bbox (W,S,E,N) | Size |
|---|---|---|---|
| **FOREST** — Arena Martínkov | 48.6008 N, 14.2913 E | `14.27636,48.59091,14.30624,48.61069` | ~2.2 × 2.2 km |
| **SPRINT** — Český Krumlov old town | 48.8109 N, 14.3150 E | `14.30410,48.80550,14.32590,48.81630` | ~1.6 × 1.2 km |

Their projected extents in EPSG:5514 (returned by ČÚZK's own reprojection, see §6):

```
FOREST  xmin=-776083.385  ymin=-1206734.540  xmax=-773596.944  ymax=-1204248.099
SPRINT  xmin=-770832.353  ymin=-1183293.695  xmax=-768952.236  ymax=-1181883.607
```

> **Note on server hostnames.** ČÚZK is migrating `*.cuzk.cz` → `*.cuzk.gov.cz`. Both currently
> resolve and serve identical content for the ArcGIS endpoints. The `.gov.cz` form is the one
> published in the current metadata — **prefer it**. The legacy geoportal WMS endpoints
> (`geoportal.cuzk.cz/WMS_ORTOFOTO_PUB/…`) are **decommissioned**: they 302 to
> `images/no_mapservice.png`. Use the ArcGIS endpoints instead.

---

## 1. ČÚZK elevation models — DMR 5G and DMP 1G

### 1.1 Service discovery

The elevation ImageServers live on the `arcgis2` instance. Service listing:

```bash
curl -s "https://ags.cuzk.gov.cz/arcgis2/rest/services?f=json" | jq .
```

Relevant services: `dmr5g`, `dmp1g`, `dmr4g`, `dmp`, `dmp_obrazova_korelace`,
`INSPIRE_Nadmorska_vyska` (all `ImageServer`).

> **A WCS endpoint does not exist for these.** `…/dmr5g/ImageServer/WCSServer?service=WCS&request=GetCapabilities`
> returns **HTTP 400** (`ArcGIS Server Error`, `http.400`). The capability string on the service is
> `"Catalog,Mensuration,Image,Metadata"` — no WCSServer, no WMSServer. **Use the ArcGIS REST
> `exportImage` operation**, which is strictly more capable here anyway (it does the reprojection
> for you and returns float32 GeoTIFF).

### 1.2 Service metadata (CONFIRMED)

`GET https://ags.cuzk.gov.cz/arcgis2/rest/services/{dmr5g|dmp1g}/ImageServer?f=json`

| Property | DMR 5G | DMP 1G |
|---|---|---|
| `pixelSizeX/Y` | **2 m** | **2 m** |
| `pixelType` | `F32` | `F32` |
| `bandCount` | 1 | 1 |
| `spatialReference` | wkid **102067**, latestWkid **5514**, vcs 8357 (Bpv) | same |
| `maxImageWidth` × `maxImageHeight` | **15000 × 4100** | **15000 × 4100** |
| value range (national) | 9.76 – 1603.58 m | 38.18 – 1615.90 m |
| `copyrightText` | `© ČÚZK` | `© ČÚZK` |
| capabilities | `Catalog,Mensuration,Image,Metadata` | `Catalog,Image,Metadata` |

Vertical datum is **Bpv** (Balt po vyrovnání / Baltic after adjustment), EPSG vcs **8357** — *not*
EGM96 and *not* ellipsoidal. Stated accuracy (from the service description):

- **DMR 5G**: mean height error **0.18 m in open terrain, 0.3 m in forested terrain**.
- **DMP 1G**: mean height error **0.4 m for sharply defined objects (buildings), 0.7 m for
  indistinct objects (forest and other vegetation)**.

> ⚠ **`maxImageWidth` is 15000 but `maxImageHeight` is only 4100.** A square request larger than
> 4100 px will be silently clipped/refused on the height axis. Tile any AOI needing >4100 px rows.
> At 2 m native that is 8.2 km of northing per request — not a practical constraint for us.

### 1.3 Working request — DMR 5G, FOREST AOI (CONFIRMED)

Two-step: `f=json` returns an `href` to a generated GeoTIFF, which you then download.

```bash
# Step 1 - request the export, get the href
curl -s -G "https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage" \
  --data-urlencode "bbox=14.27636,48.59091,14.30624,48.61069" \
  --data-urlencode "bboxSR=4326" \
  --data-urlencode "imageSR=5514" \
  --data-urlencode "size=1100,1100" \
  --data-urlencode "format=tiff" \
  --data-urlencode "pixelType=F32" \
  --data-urlencode "noData=-9999" \
  --data-urlencode "interpolation=RSP_BilinearInterpolation" \
  --data-urlencode "f=json"
```

Actual response:

```json
{
  "href": "https://ags.cuzk.cz/arcgis2/rest/directories/arcgisoutput/dmr5g_ImageServer/_ags_99b09aee_70d3_405c_b75b_e625e2fc1186.tif",
  "width": 1100, "height": 1100,
  "extent": {
    "xmin": -776083.38495665544, "ymin": -1206734.5399277189,
    "xmax": -773596.94411314849, "ymax": -1204248.099084212,
    "spatialReference": { "wkid": 102067, "latestWkid": 5514 }
  },
  "scale": 0
}
```

```bash
# Step 2 - download it
curl -o dmr5g_forest.tif "<href from step 1>"
```

**Verified output** (`research/raw/dmr5g_forest.tif`, 5 310 430 bytes):

```
TIFF, little-endian, 1100x1100, 32 bit/sample, uncompressed, BlackIsZero
ModelPixelScale : (2.2604, 2.2604, 0.0)
ModelTiepoint   : (0,0,0, -776083.3849566554, -1204248.099084212, 0.0)
GeoKeyDirectory : GeographicTypeGeoKey=4156 (S-JTSK), ProjectedCSTypeGeoKey=6156, ...
GDAL_NODATA     : -9999
valid pixels    : 1210000 / 1210000  (no voids)
elevation       : min 621.94  max 941.12  mean 763.01 m
percentiles 1/50/99 : 649.28 / 758.02 / 901.38
```

This is a **fully georeferenced GeoTIFF with correct GeoKeys** — GDAL/rasterio read it directly with
no sidecar. Elevation range 622–941 m matches the bulletins' stated *"Altitude between 700 – 1,000
meters a.s.l."* for the race terrain.

> **`href` files are temporary.** They live in `arcgisoutput/` and are garbage-collected. Download
> immediately; do not store the href. You can also pass `f=image` to stream the raster back
> directly in one request, avoiding the two-step entirely — useful for a pipeline.

### 1.4 All four exports (CONFIRMED)

Same call shape, all four succeeded:

| File | Service | AOI | Size | Pixel | Elevation range |
|---|---|---|---|---|---|
| `dmr5g_forest.tif` | dmr5g | FOREST | 1100×1100 | 2.2604 m | 621.94 – 941.12 |
| `dmp1g_forest.tif` | dmp1g | FOREST | 1100×1100 | 2.2604 m | 622.40 – 961.03 |
| `dmr5g_sprint.tif` | dmr5g | SPRINT | 800×600 | 2.3501 m | 474.51 – 592.46 |
| `dmp1g_sprint.tif` | dmp1g | SPRINT | 800×600 | 2.3501 m | 474.71 – 623.04 |

Sprint minimum 474.5 m is the Vltava water surface through Český Krumlov — correct.

> **The DMR and DMP exports are pixel-identical in grid** when you pass the same `bbox`, `bboxSR`,
> `imageSR` and `size`. Same `ModelPixelScale`, same `ModelTiepoint`. **You can subtract them
> directly with no resampling.** This is the single most important practical fact in this document.

### 1.5 Native resolution — do not over-request

The bulk open-data distribution (§4) is **LAZ point cloud**, not raster. Parsing the header of
`VBRO92.laz` (DMR 5G, one SM5 sheet):

```
LAS 1.4, point format 6 (compressed)
points      : 489,533
extent      : X 2500 m x Y 2000 m = 5.00 km2
density     : 0.10 pts/m2
mean spacing: 3.20 m
```

**DMR 5G is an irregular TIN with ~3.2 m mean point spacing**, not a 2 m grid. The ImageServer's
2 m raster is already an interpolation of that TIN. Requesting a finer `size` than ~2 m/px yields
smooth interpolation, not more information. **Sample at 2 m and upsample in the engine if you need
a denser mesh.**

### 1.6 Canopy Height Model — DMP1G − DMR5G (CONFIRMED)

Computed on the verified rasters:

```
=== FOREST (2.49 x 2.49 km)
    CHM min=-1.51  max=56.10  mean=18.36 m
    percentiles 5/25/50/75/90/99: -0.05 / 11.93 / 21.64 / 25.75 / 28.50 / 32.75
    bare/open (<0.5 m)  12.33%
    low scrub 0.5-2 m    1.18%
    scrub 2-5 m          3.26%
    young/medium 5-15 m 12.73%
    mature >15 m        70.50%

=== SPRINT (1.88 x 1.41 km)
    CHM min=-3.32  max=63.09  mean=5.72 m
    percentiles 5/25/50/75/90/99: -0.11 / 0.00 / 2.13 / 9.39 / 17.71 / 28.39
    bare/open (<0.5 m)  42.84%
    low scrub 0.5-2 m    6.63%
    scrub 2-5 m         12.11%
    young/medium 5-15 m 24.50%
    mature >15 m        13.93%
```

70.5 % mature forest in the forest AOI is exactly what you expect for this terrain.

> ⚠ **CHM includes buildings, not just vegetation.** In the sprint AOI most of the 5–15 m band is
> roofs, not trees. You **must** mask with building footprints (ZABAGED layer 99 or OSM
> `building=*`) before calling it a canopy model. Conversely this is a *feature*: masked the other
> way it gives you **per-building height** for the sprint 3D, which is far more reliable than OSM's
> sparse `height` tag (21 buildings out of 1877 in Krumlov have `height`).
>
> Small negative CHM values (down to −3.3 m) are normal: DSM/DTM interpolation disagreement over
> water and steep banks. Clamp to 0.

---

## 2. ČÚZK Ortofoto ČR (RGB) and Ortofoto CIR (infrared)

### 2.1 RGB orthophoto — WMS (CONFIRMED)

Endpoint (note: **`arcgis1`**, not `arcgis2` — using the wrong instance returns HTTP 400):

```
https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer
```

| Property | Value |
|---|---|
| Service title | *Prohlížecí služba pro ortofoto ČR* |
| Layer name | **`0`** (ArcGIS MapServer WMS — the layer is literally named `0`) |
| WMS versions | 1.1.1 and 1.3.0 both work |
| CRS | 5514, 4326, 4258, 3857, 32633, 32634, 5221, 3034/3035/3045/3046, 102066/102067/102100, 28403/28404, 3333/3334 |
| Formats | `image/jpeg`, `image/png`, `image/png8/24/32`, `image/tiff`, `image/gif`, `image/bmp` |
| **MaxWidth / MaxHeight** | **4096 × 4096** |
| `AccessConstraints` | `https://geoportal.cuzk.gov.cz/Dokumenty/Podminky.pdf` |
| `Fees` | `© ČÚZK` |

**Working request — sprint overview** (CONFIRMED, returned 1 528 462 bytes of JPEG, visually
verified as Český Krumlov: the Vltava double meander, old town peninsula, castle gardens):

```bash
curl -o ortofoto_sprint.jpg -G "https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer" \
  --data-urlencode "service=WMS" --data-urlencode "version=1.1.1" \
  --data-urlencode "request=GetMap" \
  --data-urlencode "layers=0" --data-urlencode "styles=" \
  --data-urlencode "srs=EPSG:4326" \
  --data-urlencode "bbox=14.30410,48.80550,14.32590,48.81630" \
  --data-urlencode "width=4096" --data-urlencode "height=2048" \
  --data-urlencode "format=image/jpeg"
```

**Working request — native 12.5 cm resolution** (CONFIRMED, 5 125 019 bytes PNG). 256 m of ground
at 2048 px = **0.125 m/px**, over Krumlov castle:

```bash
curl -o ortofoto_castle.png -G "https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer" \
  --data-urlencode "service=WMS" --data-urlencode "version=1.3.0" \
  --data-urlencode "request=GetMap" \
  --data-urlencode "layers=0" --data-urlencode "styles=" \
  --data-urlencode "crs=EPSG:5514" \
  --data-urlencode "bbox=-770100,-1182700,-769844,-1182444" \
  --data-urlencode "width=2048" --data-urlencode "height=2048" \
  --data-urlencode "format=image/png"
```

**Resolution and tiling.** Ortofoto ČR is 12.5 cm GSD in the current cycle (20 cm in older
coverage). At the 4096 px cap, one request covers:

| Target GSD | Ground per request | Requests for FOREST (2.2 km) | for SPRINT (1.6×1.2 km) |
|---|---|---|---|
| 0.125 m | 512 m | 5 × 5 = 25 | 4 × 3 = 12 |
| 0.25 m | 1024 m | 3 × 3 = 9 | 2 × 2 = 4 |
| 0.50 m | 2048 m | 2 × 2 = 4 | 1 × 1 = 1 |

> **Axis order gotcha.** WMS 1.3.0 + EPSG:4326 uses **lat,lon** order; WMS 1.1.1 + `srs=EPSG:4326`
> uses **lon,lat**. EPSG:5514 is lon-like/lat-like (easting,northing) in both. To avoid the trap
> entirely, **do all ortho requests in EPSG:5514** — which is also what you want for co-registration
> with the DEMs.

### 2.2 Co-registering ortho with the DEM (CONFIRMED)

Pass the **exact projected extent the ImageServer returned** and the **same pixel size**. This
yields pixel-perfect alignment with no resampling:

```bash
curl -o ortofoto_forest.png -G "https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer" \
  --data-urlencode "service=WMS" --data-urlencode "version=1.3.0" \
  --data-urlencode "request=GetMap" --data-urlencode "layers=0" --data-urlencode "styles=" \
  --data-urlencode "crs=EPSG:5514" \
  --data-urlencode "bbox=-776083.38495665544,-1206734.5399277189,-773596.94411314849,-1204248.099084212" \
  --data-urlencode "width=1100" --data-urlencode "height=1100" \
  --data-urlencode "format=image/png"
```

Returned 1100×1100 RGB PNG, 2 506 901 bytes — same grid as `dmr5g_forest.tif`.

### 2.3 Ortofoto CIR — colour infrared (CONFIRMED, and it needs a trick)

This gives a **real NIR band**, so you can compute a true NDVI rather than an RGB proxy.

```
https://geoportal.cuzk.gov.cz/WMS_ORTOFOTO_CIR/WMService.aspx
```

> ⚠ **This endpoint is User-Agent gated.** A bare `curl` gets **HTTP 302 → `Dokumenty/Podminky.pdf`**.
> Sending a browser `User-Agent` **and** a `Referer` of `https://geoportal.cuzk.gov.cz/` returns
> **HTTP 200**. This is the difference between "the service is broken" and "the service works" —
> it cost real time to find.

| Property | Value |
|---|---|
| WMS version | 1.3.0 |
| Layers | **one per year: `2010` … `2025`** (16 layers) — no `default` mosaic across years |
| CRS | 5514, 4326, 4258, 3857, 32633, 32634, 5221, 3034/3035/3045/3046, 102066, 3835/3836, 900913 |
| Formats | `image/jpeg`, `image/png`, `image/png8`, `image/webp`, `image/jpgpng`, `image/gif` |
| **MaxWidth / MaxHeight** | **2560 × 2048** (smaller than the RGB service) |

Working request (CONFIRMED, 3 287 255 bytes, co-registered to the forest DEM grid):

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
curl -o ortocir_forest.png -A "$UA" -e "https://geoportal.cuzk.gov.cz/" \
  -G "https://geoportal.cuzk.gov.cz/WMS_ORTOFOTO_CIR/WMService.aspx" \
  --data-urlencode "service=WMS" --data-urlencode "version=1.3.0" \
  --data-urlencode "request=GetMap" \
  --data-urlencode "layers=2025" --data-urlencode "styles=" \
  --data-urlencode "crs=EPSG:5514" \
  --data-urlencode "bbox=-776083.38495665544,-1206734.5399277189,-773596.94411314849,-1204248.099084212" \
  --data-urlencode "width=1100" --data-urlencode "height=1100" \
  --data-urlencode "format=image/png"
```

CIR channel mapping is the standard false-colour convention: **R = NIR, G = Red, B = Green**, so

```
NDVI = (R_cir - G_cir) / (R_cir + G_cir)
```

See §5 for what NDVI actually turned out to be worth (short version: less than you'd hope).

---

## 3. ZABAGED — vector topographic base

Two ArcGIS MapServers on the **`arcgis`** instance (no digit):

```
https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_POLOHOPIS/MapServer   # planimetry, 149 layers
https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_VRSTEVNICE/MapServer  # contours, 1 layer
```

`capabilities: "Map,Query,Data"`, `maxRecordCount: 2000`,
`supportedQueryFormats: "JSON, geoJSON, PBF"`. **`f=geojson` works** — you get RFC-7946 GeoJSON
straight out, no GML wrangling.

A WFS is also published (`…/ZABAGED_POLOHOPIS/MapServer/WFSServer`, WFS 1.0, 149 feature types,
`CountDefault=1000`, `ImplementsResultPaging=TRUE`) but its output formats are GML2/GML3/GML32/KML
only — **no GeoJSON**. The ArcGIS REST `query` endpoint is strictly easier; use it.

### 3.1 Layers that matter for orienteering

| ID | Czech name | Meaning | ISOM/ISSprOM relevance |
|---|---|---|---|
| 142 | Lesní půda se stromy | forest with trees | white/green base |
| 140 | Lesní půda s křovinatým porostem | forest with shrub layer | **green candidate** |
| 141 | Lesní půda s kosodřevinou | dwarf pine | dark green |
| 139 | Trvalý travní porost | permanent grassland | yellow |
| 138 | Orná půda | arable land | yellow/olive |
| 134 | Udržovaná zeleň | maintained greenery / park | 402/403 |
| 16 | **Lesní průsek** | forest ride / firebreak | 501-ish, big navigational feature |
| 15 | Liniová vegetace | linear vegetation, tree row | 416 |
| 82 | **Pěšina** | footpath | 505/506/507 |
| 83 | **Cesta** | track / unpaved road | 502–504 |
| 84 | Ulice | street | sprint 501 |
| 79 | Silnice, dálnice | road, motorway | 502 |
| 150 | Turistická trasa | marked hiking route | 515 |
| 93 | Vodní tok | watercourse | 305–307 |
| 132 | Vodní plocha | water body | 301 |
| 131 | Bažina, močál | marsh, swamp | 308–310 |
| 130 | **Skalní útvary** | rock formations | 201–203 |
| 129 | Sesuv půdy, suť | landslide, scree | 210 stony ground |
| 95 | **Stupeň, sráz** | step, escarpment | 201/104 earth bank |
| 94 | Rokle, výmol | gully, erosion gully | 107/108 |
| 10 | Osamělý balvan, skála | boulder, rock, rock pinnacle | 206 boulder |
| 12/13 | Skupina balvanů | boulder cluster (point/line) | 208 |
| 99 | Budova (plocha) | building polygon | 521 |
| 39 | **Zeď** | wall | 513/515 |
| 38 | Hradba, val, bašta, opevnění | rampart, bastion, fortification | 515 sprint |
| 54 | Zábrana | barrier | 518 |
| 101/102 | Hrad / Zámek | castle / chateau | landmark |
| 73 | Most | bridge | 512 |
| 66/67 | Lávka | footbridge (point/line) | 512 |
| 26 | Věž | tower | 526 |
| 112 | Břehová čára | shoreline | 301 edge |
| 9 | Kótovaný bod | spot height | contour QA |

### 3.2 Working query (CONFIRMED)

```bash
BASE="https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_POLOHOPIS/MapServer"
curl -G "$BASE/83/query" \
  --data-urlencode "geometry=14.27636,48.59091,14.30624,48.61069" \
  --data-urlencode "geometryType=esriGeometryEnvelope" \
  --data-urlencode "inSR=4326" \
  --data-urlencode "outSR=4326" \
  --data-urlencode "spatialRel=esriSpatialRelIntersects" \
  --data-urlencode "outFields=*" \
  --data-urlencode "returnGeometry=true" \
  --data-urlencode "f=geojson"
```

### 3.3 Actual feature counts returned

**FOREST AOI** (all CONFIRMED, saved as `research/raw/zabaged_forest_L*.geojson`):

| Layer | Features | Layer | Features |
|---|---|---|---|
| 142 forest w/ trees | 2 *(large multipolygons, 272 KB)* | 95 escarpment | **71** |
| 140 forest w/ shrub | 5 | 16 forest ride | 9 |
| 82 path | 6 | 139 grassland | 9 |
| 83 track | **146** | 99 buildings | 23 |
| 93 watercourse | 7 | 10 boulder | 5 |
| 132 water area | 1 | 130 rock formations | 4 |
| 131 marsh | 0 | 129 scree | 0 |
| 94 gully | 0 | | |

Note **146 tracks vs 6 paths** — this matches the bulletins exactly: *"rather good vehicle track
network and sparse path network"*. The 71 escarpments and 5 boulders + 4 rock formations are the
"rocky towns" the organisers describe, though ZABAGED clearly under-represents them relative to
what an orienteering map shows (see §7).

**SPRINT AOI** (all CONFIRMED, `research/raw/zabaged_sprint_L*.geojson`):

| Layer | Features | Layer | Features |
|---|---|---|---|
| 99 building polygons | **1157** | 132 water area | 5 |
| 84 street | **534** | 93 watercourse | 30 |
| 39 wall | **187** | 134 maintained greenery | 39 |
| 112 shoreline | 57 | 82 path | 20 |
| 73 bridge | 15 | 26 tower | 10 |
| 67 footbridge | 8 | 102 zámek (chateau) | 3 |
| 54 barrier | 3 | 101 hrad (castle) | 0 |
| 38 rampart/fortification | **0** | 115 other urban area | 4 |

> Interesting: ZABAGED tags the Krumlov castle complex as `Zámek` (102, chateau) with 0 in
> `Hrad` (101) and **0 in layer 38 (fortification)** — the massive castle walls appear in layer 39
> (`Zeď`, wall) instead. Don't assume layer 38 covers historic fortifications.

Sample attributes:

```json
// L83 Cesta
{"OBJECTID":6923,"fid_zbg":"4475234556051456","typcesty_k":"025",
 "typcesty_p":"cesta neudržovaná","povrch_k":null,"povrch_p":null,
 "jmeno":null,"Shape_Length":133.097}

// L99 Budova
{"OBJECTID":4587,"fid_zbg":"7586575185608704","jmeno":null,
 "druhbud":"budova blíže neurčená","Shape_Length":42.24,"Shape_Area":106.81}
```

`typcesty_p` (track type) and `povrch_p` (surface) are directly usable for choosing ISOM path
symbols 502/503/504/505/506/507.

### 3.4 Contours — and pagination (CONFIRMED)

```bash
curl -G "https://ags.cuzk.gov.cz/arcgis/rest/services/ZABAGED_VRSTEVNICE/MapServer/0/query" \
  --data-urlencode "geometry=14.27636,48.59091,14.30624,48.61069" \
  --data-urlencode "geometryType=esriGeometryEnvelope" \
  --data-urlencode "inSR=4326" --data-urlencode "outSR=4326" \
  --data-urlencode "spatialRel=esriSpatialRelIntersects" \
  --data-urlencode "outFields=*" --data-urlencode "f=geojson"
```

- Total in FOREST AOI: **4957** (via `returnCountOnly=true`).
- First page returns **2000** with `"exceededTransferLimit": true`.
- **Pagination works**: `resultOffset=2000&resultRecordCount=2000` returned the next 2000.
- Attributes: `{"VYSKA":849,"TYP_K":"010","ZOBRAZ_K":"0"}` — `VYSKA` is the elevation in metres.
- Observed values 684, 686, 687, 690, 691, 692 … → **1 m contour interval**.

> **Recommendation: generate your own contours from DMR 5G instead.** The race maps use a **5 m
> interval** (all four WC races, per Bulletin 4). ZABAGED's 1 m contours are cartographically
> generalised for a 1:10 000 topographic map, not for orienteering, and they are a large download
> (5.7 MB for 2.2 km²). Marching-squares on the DMR 5G raster with your own smoothing gives you
> full control over interval, generalisation and the form-line detail that makes an O-map read
> correctly. Use ZABAGED contours only as a sanity check.

---

## 4. Bulk download — ATOM feeds and map sheets

Declared in the national open-data catalogue. Feed URL pattern:

```
https://atom.cuzk.cz/get.ashx?theme=<THEME>
```

| Theme | Dataset |
|---|---|
| `DMR5G-SJTSK` / `DMR5G-ETRS89` | DMR 5G |
| `DMP1G-SJTSK` / `DMP1G-ETRS89` | DMP 1G |
| `DMR4G-SJTSK` / `DMR4G-SJTSK-TIFF` | DMR 4G (**TIFF variant exists**) |
| `DMPOK-SJTSK-LAZ` / `-TIFF` | DSM from image correlation |
| `ZABAGED-FGDB` / `ZABAGED-GPKG` | ZABAGED planimetry (**GeoPackage!**) |
| `ZABAGED-vyskopis` / `-DGN` | ZABAGED contours |
| `ORTOFOTO` | Ortofoto ČR |

> Note **DMR 5G and DMP 1G have no `-TIFF` variant** — only LAZ. DMR 4G does. If you want raster
> DMR 5G, the ImageServer (§1) is the only route.

### 4.1 Finding the right sheet (CONFIRMED)

Files are per **SM5 map sheet** (2.5 × 2 km = 5 km²). Query the sheet index — layer **24** of
`KladyMapovychListu` is the one used by Ortofoto/DMR/DMP:

```bash
curl -G "https://ags.cuzk.gov.cz/arcgis/rest/services/KladyMapovychListu/MapServer/24/query" \
  --data-urlencode "geometry=14.27636,48.59091,14.30624,48.61069" \
  --data-urlencode "geometryType=esriGeometryEnvelope" \
  --data-urlencode "inSR=4326" --data-urlencode "spatialRel=esriSpatialRelIntersects" \
  --data-urlencode "outFields=*" --data-urlencode "returnGeometry=false" \
  --data-urlencode "f=json"
```

The **`MAPNOM`** attribute is the download filename stem:

| AOI | Sheets (`MAPNAME` → `MAPNOM`) |
|---|---|
| FOREST | Vyšší Brod 9-2 → **VBRO92**, Vyšší Brod 9-3 → **VBRO93**, Přední Výtoň 0-2 → **PRVY02**, Přední Výtoň 0-3 → **PRVY03** |
| SPRINT | Český Krumlov 8-1 → **CKRU81**, 7-1 → **CKRU71**, 8-0 → **CKRU80**, 7-0 → **CKRU70** |

### 4.2 Direct download URLs (all 16 CONFIRMED HTTP 200)

```
https://openzu.cuzk.gov.cz/opendata/DMR5G/epsg-5514/{MAPNOM}.zip
https://openzu.cuzk.gov.cz/opendata/DMP1G/epsg-5514/{MAPNOM}.zip
```

| Sheet | DMR5G | DMP1G | | Sheet | DMR5G | DMP1G |
|---|---|---|---|---|---|---|
| VBRO92 | 3 098 522 | 2 790 149 | | CKRU81 | 2 920 164 | 3 535 006 |
| VBRO93 | 3 560 441 | 2 465 227 | | CKRU71 | 2 850 607 | 3 901 792 |
| PRVY02 | 3 478 056 | 2 290 733 | | CKRU80 | 2 722 309 | 3 486 263 |
| PRVY03 | 3 276 295 | 1 975 507 | | CKRU70 | 2 969 840 | 4 336 826 |

Each zip contains a single `.laz`:

```
Archive:  VBRO92_dmr5g.zip
  3098235  12-02-2025 17:39   VBRO92.laz
```

Header verified: `LASF`, LAS 1.4, point format 6, 489 533 points, scale 0.01, offset
(−780000, −1200000, 0), extent X −774999.99…−772500.01, Y −1205999.99…−1204000.02, Z 559.05…847.28.

> **You need a LAZ decoder** (`laszip`, PDAL, or `laspy[lazrs]`) to read these — none was installed
> in this environment, so point-level content is **UNVERIFIED** (header only). For the pipeline the
> ImageServer raster route avoids the dependency entirely; the LAZ route is only worth it if you
> want the raw TIN vertices for sharper break-line reconstruction.

---

## 5. Vegetation classification → ISOM runnability

This is the part that needed real experimentation, so the numbers below come from an actual run
over the FOREST AOI. Reproduce with `research/veg-classify-experiment.py`.

### 5.1 The negative result that shapes the design

**RGB vegetation indices are nearly useless for runnability.** Computed on the co-registered
1100×1100 ortho:

| Index | 1st pct | 25th | 50th | 75th | 99th |
|---|---|---|---|---|---|
| GLI `(2G−R−B)/(2G+R+B)` | 0.007 | 0.061 | 0.078 | 0.096 | 0.137 |
| ExG `2G−R−B` | 0.008 | 0.067 | 0.090 | 0.122 | 0.200 |
| VARI `(G−R)/(G+R−B)` | −0.023 | 0.112 | 0.143 | 0.178 | 0.345 |

Broken down by canopy height class:

| CHM class | n | GLI (mean ± sd) |
|---|---|---|
| < 1 m (open) | 155 203 | +0.094 ± 0.027 |
| 1–3 m (low veg) | 18 054 | +0.084 ± 0.029 |
| 3–12 m (thicket/young) | 130 525 | +0.081 ± 0.027 |
| > 12 m (mature) | 906 213 | +0.074 ± 0.026 |

The class means span 0.020 while the within-class standard deviation is 0.027. **The distributions
overlap almost completely.** In a summer orthophoto of a Bohemian forest, *everything is green*.

### 5.2 True NDVI from CIR does not rescue it

With the real NIR band from the CIR service (§2.3):

| CHM class | n | NDVI (mean ± sd) |
|---|---|---|
| < 0.5 m (open) | 149 236 | **+0.330** ± 0.111 |
| 0.5–2 m | 14 306 | +0.311 ± 0.140 |
| 2–5 m | 39 435 | +0.296 ± 0.139 |
| 5–12 m | 100 805 | +0.281 ± 0.139 |
| > 12 m (mature) | 906 218 | **+0.200** ± 0.144 |

NDVI is **anti-correlated with canopy height** — mature spruce scores *lower* than open meadow.
That is expected (conifer canopy has lower NIR reflectance than grass, plus self-shadowing), but it
means NDVI cannot be read as "denser vegetation → higher value".

**What NDVI *is* good for:** the vegetation / non-vegetation cut. `NDVI < 0.1` isolated **15.92 %**
of the AOI — roads, roofs, water, bare rock. Use it as a mask, not as a runnability scale.

> ⚠ NDVI here is computed from an 8-bit, display-stretched WMS rendering, **not** calibrated
> reflectance. Absolute values are not physically meaningful; only relative ordering within one
> request is. Do not port thresholds between years or areas without re-checking.

### 5.3 What actually discriminates: height + canopy roughness

Runnability in forest is governed by **understorey density and structure**, and the LiDAR proxies
for that are:

1. **CHM** = DMP1G − DMR5G — how tall the vegetation is.
2. **Canopy roughness** = local standard deviation of CHM in a ~11 m window. A closed mature
   canopy is smooth; a thicket, a regenerating clear-cut, or storm-damaged forest is rough.

Measured roughness (5×5 px ≈ 11 m window) by class:

| CHM class | mean roughness |
|---|---|
| < 1 m open | 0.68 |
| 1–3 m | 2.95 |
| 3–12 m | 2.90 |
| > 12 m mature | **1.79** |

Mature forest is markedly *smoother* than young/thicket despite being far taller — exactly the
signal we want.

### 5.4 Recommended algorithm

```
Inputs, all on the identical 2 m EPSG:5514 grid:
  DTM   = DMR 5G
  DSM   = DMP 1G
  RGB   = Ortofoto CR
  NIR   = Ortofoto CIR (optional but recommended)
  BLDG  = ZABAGED L99 / OSM building=*   (rasterised mask)

1. CHM   = clamp(DSM - DTM, 0, 60)
2. CHM[BLDG] = 0                       # buildings are not vegetation
3. ROUGH = local_stddev(CHM, 11 m window)
4. NDVI  = (NIR - RED) / (NIR + RED)   # if CIR available
5. VEG   = NDVI > 0.10                 # else fall back to GLI > 0.02

Classification (evaluated in order):

  CHM <  0.5  and not VEG                      -> OPEN / paved / water / rock  (401 white-yellow, 501)
  CHM <  0.5  and VEG and ROUGH < 0.25         -> OPEN LAND, smooth            (401 yellow)
  CHM <  0.5  and VEG and ROUGH >= 0.25        -> ROUGH OPEN                   (403 yellow w/ dots)
  0.5 <= CHM < 2.0                             -> GREEN 25%   (404 slow run)
  2.0 <= CHM < 5.0                             -> DARK GREEN  (410 fight)      # low dense scrub
  5.0 <= CHM < 12.0 and ROUGH >= 1.6           -> GREEN 50%   (408 walk)
  5.0 <= CHM < 12.0 and ROUGH <  1.6           -> GREEN 25%   (404)
  CHM >= 12.0 and ROUGH <  2.2                 -> WHITE, runnable forest       (405)
  CHM >= 12.0 and 2.2 <= ROUGH < 3.4           -> GREEN 25%   (404)
  CHM >= 12.0 and ROUGH >= 3.4                 -> GREEN 50%   (408)

6. Generalise: morphological open then close with a ~3 px disc, then drop
   connected components smaller than ~200 m2 (ISOM minimum area for a green patch).
```

The counter-intuitive rule — **low vegetation (2–5 m) is the *worst* to run through, not the
tallest** — is the whole point. A 25 m spruce stand is white; a 3 m regeneration thicket is a fight.

### 5.5 Validation against the FOREST AOI

Running the above (before generalisation):

| Class | Share |
|---|---|
| open land (yellow) | 9.02 % |
| rough open | 3.31 % |
| **WHITE runnable forest** | **58.52 %** |
| green 25 % | 13.54 % |
| green 50 % | 12.35 % |
| dark green (fight) | 3.26 % |

Visual check against the orthophoto: the classifier correctly picks out the arena clearing and
field system, the track network, and puts green along forest edges and regeneration patches. This
is a plausible ISOM distribution and lines up with the organisers' description (*"Dominantly good
runnability with some larger thickets and some areas with undergrowth"*, *"various runnability and
visibility from very good to impenetrable green"*).

> **Known weaknesses.** (a) Output is speckly and over-traces forest edges — step 6 generalisation
> is not optional. (b) Thresholds are tuned on *this* AOI in *this* season; re-check on the sprint
> AOI and on any new area. (c) Shadow in the ortho depresses NDVI on north-facing slopes; the
> CHM/roughness path is unaffected, which is another reason to lean on it.

### 5.6 Third option: ZABAGED / OSM landuse

ZABAGED layer **140** (`Lesní půda s křovinatým porostem`, forest with shrub layer) is an explicit
"this forest has an understorey" polygon — 5 features in the FOREST AOI. Layer **141** (dwarf pine)
maps to dark green. These are **low-recall but high-precision**: use them to *promote* a region's
green class, never as the primary classifier. Same for OSM `natural=scrub` (2 in the forest AOI).

---

## 6. EPSG:5514 — S-JTSK / Krovak East North

### 6.1 Definitions

**proj4** (from epsg.io, CONFIRMED):

```
+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778
+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=589,76,480,0,0,0,0
+units=m +no_defs +type=crs
```

**OGC WKT**: `PROJCS["S-JTSK / Krovak East North", … PROJECTION["Krovak"],
PARAMETER["latitude_of_center",49.5], PARAMETER["longitude_of_center",24.8333333333333],
PARAMETER["azimuth",30.2881397527778], PARAMETER["pseudo_standard_parallel_1",78.5],
PARAMETER["scale_factor",0.9999], … AUTHORITY["EPSG","5514"]]`

### 6.2 Things that will bite you

1. **Coordinates are negative.** In EPSG:5514 the Czech Republic sits at roughly
   X ∈ [−905 000, −432 000], Y ∈ [−1 227 000, −935 000]. Our AOIs are around
   X ≈ −775 000, Y ≈ −1 205 000. Code that assumes positive easting/northing will break.

2. **5514 vs 5513 vs 102067.** EPSG:**5513** is Krovak *South-West* (positive southing/westing).
   EPSG:**5514** is Krovak *East North* — the axes negated and swapped. ArcGIS reports
   `wkid: 102067` with `latestWkid: 5514`; **102067 is Esri's code for the same CRS**. Treat them
   as equivalent, but always request `imageSR=5514` so downstream tools read the EPSG code.

3. **The grid is rotated ~30°.** A lat/lon rectangle does **not** map to a rectangle in 5514.
   ArcGIS densifies envelope edges when reprojecting, so the extent you get back is slightly
   larger than the projection of the four corners.

4. **The Ferro meridian trap.** `+lon_0=24.8333333333333` is **24°50′ east of Greenwich**, which is
   *already* the Greenwich-referenced central meridian (= 42°30′ Ferro). Adding the 17°40′
   Ferro offset yourself puts you **~1300 km off**. Verified the hard way — see
   `research/verify-krovak-5514.py`.

### 6.3 Measured transformation accuracy (CONFIRMED)

I implemented Krovak independently and compared against ČÚZK's own reprojection (obtained by
handing the ImageServer a 20 m bbox in EPSG:4326 and reading back the EPSG:5514 extent):

| Datum shift | site | ΔX | ΔY |
|---|---|---|---|
| 3-param `towgs84=589,76,480` | Martínkov | −0.12 / −0.83 m | **−9.43 m** |
| 3-param `towgs84=589,76,480` | Krumlov | −0.89 / −1.67 m | **−9.17 m** |

**Easting agrees to ~1 m; northing carries a systematic ≈ −9.3 m bias.** At a 2 m pixel that is
**4–5 pixels of misregistration** — enough to shift a building off its footprint or a contour off
its slope.

> **Therefore: do not transform coordinates yourself.** Every ČÚZK service accepts `bboxSR=4326` /
> `inSR=4326` and reprojects server-side with the authoritative transformation. Hand them WGS84,
> take back EPSG:5514, and use the returned `extent` verbatim as your grid definition. This
> eliminates the entire error class for free.
>
> If you *must* transform client-side (e.g. converting OSM WGS84 geometry into the DEM grid),
> use PROJ with the full EPSG:5514 definition — and be aware that a naive 3-parameter shift
> introduces the ~9 m northing bias above. A 7-parameter variant was tested and came out *worse*
> (≈ 27 m), but that is **UNVERIFIED** as a fair test: the rotation sign convention
> (position-vector vs coordinate-frame) was not independently confirmed, so do not read it as
> evidence against the 7-parameter approach.

For the game itself, work in a **local metric frame**: take the AOI's 5514 extent, subtract the
origin, and you have metres with X east / Y north. No projection maths at runtime.

---

## 7. OpenStreetMap / Overpass

### 7.1 Endpoint and limits (CONFIRMED)

```
POST https://overpass-api.de/api/interpreter      body: data=<Overpass QL>
```

`GET https://overpass-api.de/api/status` returned:

```
Connected as: 3109790978
Rate limit: 2
2 slots available now.
```

- **Rate limit: 2 concurrent slots** per client IP on the main instance.
- The main instance returned **HTTP 504** twice on a broad forest query, then succeeded on retry.
  **Implement retry with backoff and a mirror fallback.**
- Mirror **`https://overpass.kumi.systems/api/interpreter`** CONFIRMED working — but its data was
  **2 months stale** (`timestamp_osm_base: 2026-05-31`) versus the main instance
  (`2026-08-01T10:09:00Z`). For a one-off extraction always prefer the main instance; use the
  mirror only as a fallback and record which one produced the data.
- Attribution is returned in every response and is **not optional** — see `DATA_LICENCES.md`:
  > `"The data included in this document is from www.openstreetmap.org. The data is made available under ODbL."`

### 7.2 Sprint query — Český Krumlov (CONFIRMED)

Stored at `research/overpass-krumlov-sprint.overpassql`. Run with:

```bash
curl -X POST "https://overpass-api.de/api/interpreter" \
     --data-urlencode "data@research/overpass-krumlov-sprint.overpassql" \
     -o osm_krumlov_sprint.json
```

```overpassql
[out:json][timeout:180][bbox:48.80550,14.30410,48.81630,14.32590];
(
  way["building"];
  relation["building"];
  way["building:part"];
  way["man_made"="bridge"];
  relation["man_made"="bridge"];

  way["barrier"~"^(wall|fence|hedge|retaining_wall|city_wall|handrail|guard_rail|kerb|bollard|gate|chain)$"];
  node["barrier"~"^(gate|bollard|lift_gate|kissing_gate|stile|block)$"];
  way["historic"="citywalls"];

  way["highway"~"^(footway|path|pedestrian|steps|track|service|residential|living_street|unclassified|tertiary|secondary|primary|cycleway|corridor)$"];
  way["highway"="steps"];
  way["tunnel"]["highway"];
  way["covered"="yes"]["highway"];

  way["waterway"];
  relation["waterway"];
  way["natural"="water"];
  relation["natural"="water"];

  way["landuse"];
  relation["landuse"];
  way["natural"~"^(wood|scrub|grassland|heath|wetland|scree|cliff|rock|bare_rock|tree_row|water)$"];
  relation["natural"~"^(wood|scrub|grassland|wetland)$"];
  way["leisure"~"^(park|garden|pitch|playground|sports_centre)$"];
  node["natural"="tree"];

  way["historic"];
  relation["historic"];
  node["historic"];
  way["tourism"="attraction"];

  way["access"~"^(private|no)$"];
  way["man_made"~"^(embankment|pier|tower|wastewater_plant)$"];
);
out geom qt;
```

**Result: HTTP 200, 5 536 834 bytes, 10.2 s wall clock, 5973 elements** (563 nodes, 5331 ways,
79 relations). Saved as `research/raw/osm_krumlov_sprint.json`.

| Tag | Count | Tag | Count |
|---|---|---|---|
| `building` | **1877** | `highway=steps` | **155** |
| `building:levels` | **1024** (55 %) | `highway=footway` | 879 |
| `roof:shape` | **612** | `highway=path` | 75 |
| `height` | 21 (1 %) | `highway=pedestrian` | 144 |
| `barrier=wall` | 212 | `waterway` | 34 |
| `barrier=fence` | 271 | `landuse` | 377 |
| `barrier=hedge` | 102 | `natural=tree_row` | 10 |
| `city_wall`/`historic=citywalls` | 28 | `natural=tree` | 318 |
| `man_made=bridge` | 25 | `historic=castle` | 6 |
| `tunnel` | 42 | | |

`landuse` breakdown: grass 269, garages 23, forest 20, residential 20, allotments 10, flowerbed 10,
meadow 6, vineyard 4.

Castle features found include `hrad a zámek Český Krumlov` (way 797155316, `name:en` = *Castle and
Chateau Český Krumlov*), `Nové purkrabství`, `Dolní hrad`.

> **Krumlov is exceptionally well mapped.** 55 % of buildings carry `building:levels` and a third
> carry `roof:shape` — enough to extrude convincing 3D geometry directly. Only 1 % carry `height`,
> so derive height as `building:levels × 3.0 m` and **cross-check against the DMP1G CHM**, which
> gives a measured per-building height for all 1877.

### 7.3 Forest query — Martínkov (CONFIRMED)

Stored at `research/overpass-martinkov-forest.overpassql`. The initial broad query (`way["highway"]`
etc. unfiltered) **timed out with HTTP 504**; narrowing the tag regexes fixed it.

**Result: HTTP 200, 177 267 bytes, 133 elements.**

| Tag | Count |
|---|---|
| `highway=track` | 45 |
| `highway=path` | 14 |
| `highway=tertiary` | 7 |
| `highway=service` | 4 |
| `landuse=meadow` | 11 |
| `waterway=stream` | 4 |
| `landuse=forest` | 3 |
| `natural=scrub` | 2 |
| `natural=peak` | 2 |
| `natural=spring` | 1 |

### 7.4 The architectural conclusion

**133 elements in the forest AOI vs 5973 in the sprint AOI.** OSM coverage is wildly asymmetric:

| | FOREST (Martínkov) | SPRINT (Krumlov) |
|---|---|---|
| **Primary vector source** | **ZABAGED** (146 tracks, 71 escarpments, boulders, rock) | **OSM** (1877 buildings, 212 walls, 155 steps) |
| **OSM role** | supplementary — path network cross-check, `natural=peak`/`spring` | primary |
| **ZABAGED role** | primary | supplementary — cross-check footprints, walls (187), streets (534) |
| **Terrain/vegetation** | DMR5G + DMP1G + ortho (§5) | DMR5G + DMP1G, building-masked |

Notably OSM has **3** `landuse=forest` polygons for the forest AOI while ZABAGED has detailed
forest, shrub-forest, grassland and escarpment geometry. Conversely ZABAGED has **no** equivalent
of `building:levels` or `roof:shape` for the sprint. **Use both, per venue, per the table above.**

---

## 8. Google Maps Platform — DO NOT USE

Full analysis and verbatim clause quotations are in `DATA_LICENCES.md` §5. Summary:

**Google's ToS names our exact use case as a prohibited example.** Google Maps Platform Terms of
Service § 3.2.3(c) "No Creating Content From Google Maps Content":

> "Customer will not create content based on Google Maps Content. For example, Customer will not:
> … **(iii) build terrain models based on elevation values from the Elevation API**; …
> (vii) use Google Maps Content to improve machine learning and artificial intelligence models,
> including to train, test, validate or fine-tune the models."

Four independent clauses each independently prohibit shipping Google-derived terrain, and
§ 3.2.3(e) separately forbids displaying Google content on a non-Google map — which an orienteering
map surface inherently is.

**Even dev-time cross-checking is not safe**: § 3.2.3(b) permits caching only where the Service
Specific Terms grant a carve-out, and there is **no Elevation API section** in those terms at all —
so the permitted cache duration is zero.

**Verdict: remove Google Maps Platform from the data path entirely.** We lose nothing: DMR 5G is
0.18 m vertical accuracy against Google's documented 4.8–19 m resolution, and Google explicitly
warns that batched `path`+`samples` requests return *coarser* data. For non-Czech areas use
**Copernicus DEM GLO-30** (redistributable with attribution, keyless COG over HTTP range requests).

---

## 9. Real orienteering material for the area

### 9.1 Event structure — a correction worth noting

**The World Cup round has no sprint.** Bulletin 4: *"The sprint season is over, let us return to
the forest."* IOF World Cup 2026 Round 3 (Vyšší Brod, 5–9 Aug 2026) is **four forest races**, all
from **Arena Martínkov (48.6008 N, 14.2913 E)**:

| Date | Race | Scale | Contour |
|---|---|---|---|
| Wed 5 Aug | Qualification (3 heats) | 1:10 000 | 5 m |
| Thu 6 Aug | Long final | **1:15 000** | 5 m |
| Sat 8 Aug | Middle final | 1:10 000 | 5 m |
| Sun 9 Aug | Relay | 1:10 000 | 5 m |

The **Český Krumlov sprint is a separate event** — the GAPP Czech O-Tour "Prologue", a public race
on 5 Aug, **not** a World Cup competition. Its map is **1:4 000, contour interval 2.5 m,
ISSprOM 2019-2 rev 6**, surveyed July 2026 by Martin Klein.

All WC maps: **ISOM 2017-2 rev. 6**, cartographers Zdeněk Sokolář, Daniel Lebar, Jan Drbal,
Ondřej Prášil; revision Zdeněk Rajnošek, Zdeněk Janů.

Special symbols across all WC races: **brown triangle = small plateau**, **black cross = small
man-made feature** (the spectator control 100 is at an *"exposed car"*).

### 9.2 Terrain in the organisers' own words

Master description (Bulletin 3 §12.1, Bulletin 1/2 §12.1):

> "Altitude between 700 - 1,000 meters a.s.l. Submountainous forest with rocky towns and stony
> areas and details, in some parts marshy areas, rather good vehicle track network and sparse path
> network, various runnability and visibility from very good to impenetrable green."

Per race:

- **Qualification** — *"Irregular path network, chaotic vegetation in some places."*
- **Long** — *"Dominantly good runnability with some larger thickets and some areas with
  undergrowth. Remains of abandoned villages."*
- **Middle** — *"Runnability decreased by stony ground in most parts and by vegetation in some
  parts."*
- **Relay** — *"rather good vehicle track and path network, rather good runnability and visibility,
  some thicket areas."*
- **Model event (Loučovice)** — *"Submountainous forest with stony areas and details, only a few
  major tracks. Some open areas with harsh undergrowth and fallen trees – these are to be avoided.
  Altitude: 650–900 metres above sea level."*

Czech O-Tour Bulletin 2 (same terrain, fuller):

> "A foothill forest with rocky labyrinths and rocky passages, in some parts marshy, a relatively
> dense network of roads and paths, plenty of earthen and stone walls, remnants of displaced
> villages. In some places tall underbrush (blueberry bushes and such) and remains of cut young
> trees are present. The runnability is quite variable (very fast to almost impossible). Hilly
> terrain with many peaks, altitude between 610–890 m above sea level."

Sprint (O-Tour Bulletin 2 Krumlov):

> "The historical center of Český Krumlov city, narrow streets, squares, parks and gardens,
> bridges, stairs. Minimal car traffic. Heavy tourist pedestrian traffic, especially in the
> afternoon."

Notable ISSprOM detail for the sprint: symbol **501 (paved area)** is used at **two darkness
levels** — 50 % brown for heavy-tourist streets where slower running is expected, 30 % for less
frequented streets. That is a directly implementable runnability signal.

### 9.3 Expected winning times

| Race | Class | WT (min) | km | climb (m) | controls |
|---|---|---|---|---|---|
| Qualification | M / W heats | 50 | 7.9–8.0 / 6.5 | 440–465 / 370–380 | 21 / 17 |
| Long | M A / W A | 90 | 15.2 / 12.9 | 735 / 595 | 30 / 30 |
| Long | M B / W B | 88 | 13.5 / 11.1 | 555 / 490 | 22 / 17 |
| Middle | M A / W A | 32 | 5.4 / 4.5 | 150 / 120 | 22 / 18 |
| Relay | M / W per leg | 30 | 5.4–5.6 / 4.9–5.1 | 285 / 235 | 19–20 / 17–18 |
| **Sprint (O-Tour)** | all | **20–25** | — | — | — |

Climb ratio on the Long is 735 m over 15.2 km ≈ **4.8 %**; Qualification ≈ 5.6 %. Useful as a
calibration target for generated courses.

### 9.4 Embargo

Official embargo published as a Google My Maps KML (saved to `research/raw/embargo_map.kml`):
**213 vertices, ≈ 51.4 km²**, bbox **48.5669–48.6327 N, 14.1660–14.3221 E** (~7.3 km N–S ×
11.5 km E–W). Bounded south by the Austrian border, east by Vyšší Brod/Studánky and road 161,
north by the Vltava valley and Loučovice/Lipno, west toward Přední Výtoň.

Inside: **Martínkov (abandoned)**, **Kapličky**, **Mnichovice**, Nové Domky, Medvědí hora,
**Rašeliniště Kapliček** (peat bog), Vodopády Svatého Wolfganga, Přírodní park Vyšebrodsko.

Permitted training areas (also in the KML): Lachovice (2.83 km²), Luč (1.29 km²),
Napoleonova hlava (3.67 km²), Lipno–Kramolín (1.72 km²).

> **Our FOREST AOI sits inside the embargo.** That has no bearing on using open geodata — the
> embargo restricts *physical access by competitors*, not data use — but it does mean no
> current-generation orienteering map of the area is public, and it is worth being deliberate
> about how the game is positioned relative to the live competition.

### 9.5 ČSOS map archive

**`https://mapy.ceskyorientak.cz/`** (`mapy.orientacnisporty.cz` 301-redirects here). 13 650 maps.
Undocumented DataTables JSON index at
`https://mapy.ceskyorientak.cz/cs/maps.json?length=20000&start=0&draw=1` (saved locally, 4.4 MB).
Detail pages at `/mapa/<slug>`, previews at `/data/jpg/<id><letter>.jpg`.

Maps covering or adjacent to the competition terrain:

| Map | Publisher | Year | Scale / interval | Area | URL slug |
|---|---|---|---|---|---|
| **Martínkov 2** | VSP USK Praha | 1998 | 1:10 000 / 5 m | 6.17 km² | `/mapa/martinkov-2-1998` |
| **Mnichovice** | VSP USK Praha | 1998 | 1:10 000 / 5 m | 6.34 km² | `/mapa/mnichovice-1998` |
| Martínkov | VSP USK Praha | 1997 | 1:10 000 / 5 m | 10.35 km² | `/mapa/martinkov-1997` |
| **Kühberg** | SKP Č. Budějovice | **2026** | 1:10 000 / 5 m | 2.74 km² | `/mapa/kuhberg-2026` |
| Hrudkov | SKP ČB | 2025 | 1:10 000 / 5 m | 1.88 km² | `/mapa/hrudkov-2025` |
| Lachovice | SKP ČB | 2025 | 1:10 000 / 5 m | 1.39 km² | `/mapa/lachovice-2025` |
| Krumlov | — | 2020 | 1:4 000 / 5 m | 0.83 km² | `/mapa/krumlov-2020` |
| Český Krumlov | KOB Č. Krumlov | 1997 | 1:5 000 | — | id 2460 |

**Martínkov 2 (1998)** and **Mnichovice (1998)** are the historical mapping of the actual 2026 race
terrain — Bulletin 4 §7.3 lists exactly these as the "Previous Orienteering Maps".
**Kühberg 2026 / Hrudkov 2025 / Lachovice 2025** are by the *same cartographers*, same year, same
spec, 3 km from the embargo edge — the best publicly viewable proxy for the WC map style.

The 2026 competition maps themselves are registered (`WcupQ` 14810, `WcupL` 14811, `WcupM` 14812,
`WcupR` 14813) but carry **`Blokace do 2035`** (blocked until 2035) with no preview.

> ⚠ **The archive is not openly licensed.** Copyright rests with each map's publisher; previews are
> watermarked and may not be used for organised events without consent. **Reference only — do not
> redistribute, do not trace into shipped assets.** See `DATA_LICENCES.md` §6.

### 9.6 Terrain character → generator parameters

Synthesising bulletins, the Kühberg 2026 preview and bulletin terrain photos:

- **Relief dominates.** 700–1000 m, 5 m contours, "many peaks", ~5 % climb ratio. Contour density
  is the primary map texture. Our DMR 5G AOI measured 622–941 m — consistent.
- **Rock is the signature feature.** "Rocky towns" (*skalní města* — clusters of house-sized granite
  blocks), "rocky labyrinths and passages", "plenty of earthen and stone walls". Expect a heavy
  boulder / boulder-cluster / stony-ground / cliff symbol load. **ZABAGED gives only 5 boulders and
  4 rock formations in the AOI — it materially under-represents this.** Derive additional rock
  detail from DMR 5G micro-relief (local curvature / slope thresholds) rather than trusting ZABAGED.
- **Vegetation is bimodal**, not a gradient: mostly white mature spruce punctuated by discrete
  light-green patches (~20–30 % of forest area), dark green rare and small. Our classifier produced
  58.5 % white / 13.5 % green25 / 12.4 % green50 / 3.3 % fight — a good match.
- **"Tall underbrush (blueberry bushes and such)"** — a 0.3–0.8 m understorey that slows running but
  is *invisible to the CHM* (below DMP 1G's 0.7 m vegetation accuracy). This is a real limit of the
  LiDAR approach; consider a stochastic overlay informed by ZABAGED layer 140.
- **Paths are asymmetric**: many drivable tracks, few small paths. ZABAGED confirmed 146 tracks
  vs 6 paths.
- **Anthropogenic relics**: remains of villages depopulated after 1945 — stone walls, earth banks,
  ruins, building platforms (the "small plateau" brown triangle symbol). Look for these in DMR 5G
  micro-relief; they are exactly the kind of sharp, regular break-line LiDAR captures well.
- **Marsh** present ("in some parts marshy", Rašeliniště Kapliček peat bog). ZABAGED layer 131
  returned **0** in our AOI — again under-representing. Consider deriving from DMR 5G flatness +
  low NDVI + hydrological accumulation.

---

## 10. Reproducing this research

Saved artefacts (note `research/raw/` is **gitignored** — ~200 MB, regenerate rather than commit):

| Path | Contents |
|---|---|
| `research/overpass-krumlov-sprint.overpassql` | tested sprint Overpass query |
| `research/overpass-martinkov-forest.overpassql` | tested forest Overpass query |
| `research/verify-krovak-5514.py` | independent Krovak implementation + accuracy check vs ČÚZK |
| `research/veg-classify-experiment.py` | vegetation classifier + threshold validation |
| `research/raw/dmr5g_*.tif`, `dmp1g_*.tif` | verified float32 DEM exports, both AOIs |
| `research/raw/ortofoto_*.png/jpg`, `ortocir_forest.png` | verified imagery, RGB + CIR |
| `research/raw/zabaged_{forest,sprint}_L*.geojson` | 31 verified ZABAGED layer extracts |
| `research/raw/osm_*.json` | verified Overpass responses |
| `research/raw/*_caps.xml`, `*_imageserver.json` | service capability documents |
| `research/raw/atom_dmr5g_sjtsk.xml`, `VBRO92.laz` | bulk-download feed + one verified LAZ sheet |
| `research/raw/bulletin*.pdf`, `otour_bulletin2_*.pdf` | event bulletins (+ extracted `.txt`) |
| `research/raw/embargo_map.kml` | official embargo polygon |
| `research/raw/maps/` | ČSOS archive map previews (reference only, not redistributable) |
| `research/raw/csos_map_archive_all.json` | full ČSOS archive index |

---

## 11. Open questions / UNVERIFIED

1. **LAZ point-level content** — only the LAS header was parsed; no LAZ decoder was available.
   Install `laspy[lazrs]` or PDAL before committing to the point-cloud route.
2. **7-parameter datum transformation** — tested and rejected, but the rotation sign convention was
   not independently confirmed. Re-test with PROJ before concluding anything about it.
3. **Ortofoto native GSD** — 12.5 cm is achievable from the WMS (verified by request), but ČÚZK's
   published GSD *per acquisition year* for this specific area was not confirmed. Older coverage
   may be 20 cm.
4. **CIR calibration** — WMS output is display-stretched 8-bit, not reflectance. Absolute NDVI
   thresholds are not portable across years or regions.
5. **Vegetation thresholds** — tuned on the FOREST AOI only. Validate on the SPRINT AOI and against
   the Kühberg 2026 map preview before shipping.
6. **IOF Eventor documents** — behind a Cloudflare bot challenge; the two 1998 "previous map" PDFs
   and the Eventor-hosted embargo PDF were obtained from ČSOS archive equivalents instead.
7. **`arcgisoutput` retention** — `href` lifetime is unknown; the pipeline should download
   immediately or use `f=image`.
8. **Overpass reliability** — the main instance 504'd twice during this research. Production
   extraction needs retry + mirror fallback + recording of `timestamp_osm_base`.
