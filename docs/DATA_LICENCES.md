# Data licences — obligations for a shipped commercial game

**Researched:** 2026-08-01. Companion to [`RESEARCH-GEODATA.md`](./RESEARCH-GEODATA.md).

**Product assumption throughout:** a publicly shipped, browser-based orienteering game used for
commercial marketing/promotion. Assets are baked at build time and served to anonymous users.

> This is engineering research, not legal advice. The clause quotations are verbatim from primary
> sources and were read directly; the *application* of them to our product is reasoned analysis.
> The two items flagged **⚑ LAWYER** at the end are worth a professional eye before launch.

---

## 0. Summary table

| Source | Licence | Commercial OK? | Redistribute derived works? | Share-alike? | Attribution required |
|---|---|---|---|---|---|
| **ČÚZK DMR 5G** | **CC BY 4.0** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **ČÚZK DMP 1G** | **CC BY 4.0** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **ČÚZK Ortofoto ČR** | **CC BY 4.0** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **ČÚZK Ortofoto CIR** | **CC BY 4.0** (same family) | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **ČÚZK ZABAGED** (Polohopis + Výškopis) | **CC BY 4.0** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **OpenStreetMap** | **ODbL 1.0** + DbCL 1.0 | ✅ Yes | ✅ Yes, *as Produced Work* | ⚠ Conditional | ✅ Yes |
| **Copernicus DEM GLO-30** | Free, redistribution permitted | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **SRTM (SRTMGL1)** | Public domain | ✅ Yes | ✅ Yes | ❌ No | ❌ (courtesy only) |
| **Google Maps Platform** | Proprietary ToS | ❌ **NO** | ❌ **NO** | — | — |
| **ČSOS map archive** (orienteering maps) | All rights reserved, per publisher | ❌ No | ❌ **NO** | — | — |
| **Event bulletins (wcup.cz / O-Tour)** | © organisers | ❌ No | ❌ No (quote only) | — | ✅ if quoted |

**Bottom line: the entire primary data path is clean.** ČÚZK CC BY 4.0 + OSM ODbL both permit
commercial marketing use and redistribution of derived works. The only real work is (a) getting
attribution right and (b) keeping OSM-derived assets on the "Produced Work" side of the ODbL line.

---

## 1. ČÚZK — CC BY 4.0

### 1.1 How this was established (CONFIRMED)

The ČÚZK geoportal's own metadata pages and the `Podminky.pdf` "Data and Services Use Policy"
(v. 20 March 2026) do **not** state a licence identifier — this was checked directly and is a real
documentation gap on ČÚZK's side. The services themselves only carry
`copyrightText: "© ČÚZK"` and `<Fees>© ČÚZK</Fees>`.

The authoritative, machine-readable declaration is in the **Czech national open data catalogue**
(`data.gov.cz`), which publishes DCAT-AP-CZ records with an explicit four-dimensional rights
specification. Queried live via SPARQL:

```bash
curl -G "https://data.gov.cz/sparql" -H "Accept: application/sparql-results+json" \
  --data-urlencode 'query=PREFIX dct:<http://purl.org/dc/terms/>
PREFIX dcat:<http://www.w3.org/ns/dcat#>
PREFIX pu:<https://data.gov.cz/slovník/podmínky-užití/>
SELECT DISTINCT ?title ?au ?db ?dbzp ?dl WHERE {
 ?d a dcat:Dataset ; dct:title ?title ; dcat:distribution ?dist .
 ?dist dct:license ?l .
 OPTIONAL{?l pu:autorské-dílo ?au}
 OPTIONAL{?l pu:databáze-jako-autorské-dílo ?db}
 OPTIONAL{?l pu:databáze-chráněná-zvláštními-právy ?dbzp}
 OPTIONAL{?dist dcat:downloadURL ?dl}
 FILTER(LANG(?title)="cs")
 FILTER(CONTAINS(LCASE(STR(?title)),"zabaged") || CONTAINS(LCASE(STR(?title)),"dmr 5g")
     || CONTAINS(LCASE(STR(?title)),"dmp 1g") || CONTAINS(LCASE(STR(?title)),"ortofoto české"))
} LIMIT 60'
```

**Result — every relevant dataset returns `https://creativecommons.org/licenses/by/4.0/` on all
three rights dimensions:**

| Dataset | Copyright work | Database as work | Database *sui generis* right |
|---|---|---|---|
| ZABAGED® – Výškopis – DMR 5G (S-JTSK, Bpv) | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| ZABAGED® – Výškopis – DMP 1G (S-JTSK / ETRS89) | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| ZABAGED® – Výškopis – DMR 4G | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| ZABAGED® – Výškopis – vrstevnice (contours) | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| ZABAGED® – Polohopis | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| Ortofoto České republiky | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |
| DMP z obrazové korelace | CC BY 4.0 | CC BY 4.0 | CC BY 4.0 |

All also declare `neobsahuje osobní údaje` — **contains no personal data**, so no GDPR analysis is
needed for these layers.

> **Why all three dimensions matter.** Czech law (and EU law) treats a spatial dataset as
> potentially three separate protected objects: the copyright work, the database as a creative work,
> and the *sui generis* database right (the EU Database Directive's investment-protection right).
> ČÚZK has waived all three down to CC BY 4.0. If only the copyright dimension were CC BY, the
> database right could still have blocked systematic extraction. It doesn't. **This is a complete
> release.**

**Historical note:** ČÚZK's core datasets became free of charge as open data following amendments
effective **1 January 2023**. Data obtained before that date may have been under different terms —
irrelevant for us since we fetch live.

### 1.2 What CC BY 4.0 gives us

Under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) § 2(a)(1), the licensor
grants a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable licence to:

> "(A) reproduce and Share the Licensed Material, in whole or in part; and
> (B) produce, reproduce, and Share Adapted Material."

Explicitly **including commercial use** — § 2(a)(1) covers "any purpose, even commercially".

For us this means:
- ✅ Download DMR 5G / DMP 1G / ortho / ZABAGED.
- ✅ Derive heightmaps, canopy models, vegetation rasters, contours, textures, meshes.
- ✅ Bake them into shipped game assets.
- ✅ Serve them to the public from our own CDN.
- ✅ Use in a commercial marketing product.
- ❌ **No share-alike.** CC BY has no ShareAlike term — our game code, our art, our non-ČÚZK data
  stay entirely proprietary. (This is the crucial difference from CC BY-SA.)
- ⚠ **No sublicensing**, but § 2(a)(5)(A) handles this: "Every recipient of the Licensed Material
  automatically receives an offer from the Licensor" — downstream users get their licence directly
  from ČÚZK, which is exactly what we need.

### 1.3 Attribution obligations

CC BY 4.0 § 3(a)(1) requires, "in any reasonable manner based on the medium, means, and context",
retention of: identification of the creator, a copyright notice, a notice referring to the licence,
a disclaimer notice, and a URI/hyperlink to the material; **plus** § 3(a)(1)(B) an indication if the
material was modified, and § 3(a)(2) a link to the licence text.

**We are unambiguously creating "Adapted Material"** (heightmaps, classified rasters, meshes), so
the modification indication is mandatory.

**Use this string:**

```
Terrain, elevation and imagery data © Český úřad zeměměřický a katastrální (ČÚZK),
licensed under CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
Modified: resampled, reprojected and derived into terrain, canopy and vegetation models.
Source: https://geoportal.cuzk.gov.cz/
```

Short form for an in-game corner credit:

```
Terrain © ČÚZK, CC BY 4.0
```

…linking to the full credit. The short form alone is not sufficient as the *only* attribution —
the full form must be reachable (about/credits screen).

> ⚠ **"ZABAGED®" is a registered trademark** (note the ® in ČÚZK's own dataset titles). Use it to
> *describe the source* — nominative fair use — and do not use it as branding for our product or
> in a way implying ČÚZK endorsement. CC BY 4.0 § 2(b)(2) is explicit: "no trademark or patent
> rights held by Licensor are waived, limited, or licensed hereunder."
>
> Likewise CC BY 4.0 § 3(a)(1) requires attribution be removed on request if the licensor asks, and
> our attribution must not imply ČÚZK sponsors or endorses the game (§ 3(a)(1) / § 2(a)(5)(B)).

---

## 2. OpenStreetMap — ODbL 1.0

OSM is dual-layered: **ODbL 1.0** on the database, **DbCL 1.0** on the individual contents.
All quotations below are verbatim from
[opendatacommons.org/licenses/odbl/1-0/](https://opendatacommons.org/licenses/odbl/1-0/) and the
OSMF Licence Working Group community guidelines, read directly.

### 2.1 Commercial and marketing use — explicitly permitted

ODbL **§ 3.1**:

> "the Licensor grants to You a worldwide, royalty-free, non-exclusive, terminable (but only under
> Section 9) license to Use the Database for the duration of any applicable copyright and Database
> Rights. **These rights explicitly include commercial use, and do not exclude any field of
> endeavour.** To the extent possible in the relevant jurisdiction, these rights may be exercised
> in all media and formats whether now known or created in the future."

**No field-of-use restriction. Advertising/marketing use is permitted.** DbCL § 2.1 repeats the
identical language for the Contents.

The only constraint on *us* is § 4.7(a): we may not "impose … any terms or any technological
measures … that alter or restrict the terms of this License."

### 2.2 The four definitions that decide everything (§ 1.0)

- **Database** — "A collection of material (the Contents) arranged in a systematic or methodical way
  and individually accessible by electronic or other means offered under the terms of this License."
- **Derivative Database** — "a database based upon the Database, and includes any translation,
  adaptation, arrangement, modification, or any other alteration of the Database or of a Substantial
  part of the Contents. This includes, but is not limited to, Extracting or Re-utilising the whole
  or a Substantial part of the Contents in a new Database."
- **Produced Work** — "a work (such as an image, audiovisual material, text, or sounds) resulting
  from using the whole or a Substantial part of the Contents (via a search or other query) from this
  Database, a Derivative Database, or this Database as part of a Collective Database."
- **Substantial** — "substantial in terms of quantity or quality or a combination of both. The
  repeated and systematic Extraction or Re-utilisation of insubstantial parts of the Contents may
  amount to the Extraction or Re-utilisation of a Substantial part of the Contents."

**Our extraction is Substantial.** The OSMF *Substantial* guideline (endorsed 2014-06-06) sets the
insubstantial threshold at "Less than 100 Features" or "an area of up to 1,000 inhabitants", and
names systematic extraction of "all castles within an area" as Substantial. Our Krumlov pull was
**5973 elements including 1877 buildings** — orders of magnitude past the threshold. Assume every
Substantial-triggered clause applies.

### 2.3 The share-alike trigger — § 4.4 and § 4.5

**§ 4.4(a):**
> "Any Derivative Database that You Publicly Use must be only under the terms of: i. This License;
> ii. A later version of this License similar in spirit…; or iii. A compatible license."

**§ 4.4(b):**
> "Extraction or Re-utilisation of the whole or a Substantial part of the Contents into a new
> database is a Derivative Database and must comply with Section 4.4."

**§ 4.4(c) — the clause most people miss:**
> "A Derivative Database is Publicly Used and so must comply with Section 4.4. if a Produced Work
> created from the Derivative Database is Publicly Used."

**§ 4.5 Limits of Share Alike:**
> "The requirements of Section 4.4 do not apply in the following: … b. **Using this Database, a
> Derivative Database, or this Database as part of a Collective Database to create a Produced Work
> does not create a Derivative Database for purposes of Section 4.4**; and c. Use of a Derivative
> Database internally within an organisation is not to the public and therefore does not fall under
> the requirements of Section 4.4."

**Rendered map images are Produced Works** — attribution only, no share-alike. Confirmed by the
OSMF *Produced Work* guideline: "We can clearly define things that are USUALLY Produced Works:
.PNG, JPG, .PDF, SVG images and any raster image".

### 2.4 The hard question — is a baked collision grid / heightmap / mesh a Produced Work?

The controlling test from the OSMF **Produced Work guideline** is a *purpose* test, not a format
test:

> "If the published result of your project is intended for the extraction of the original data,
> then it is a database and not a Produced Work. Otherwise it is a Produced Work."

**Assessment (INTERPRETATION, well-grounded): a baked passability/collision grid is a Produced
Work.** It is a rasterised scalar field consumed by physics and pathfinding. It is not intended for
extraction of the original data, it discards feature identity, tags and OSM IDs, and its cells are
not "individually accessible" Contents in the § 1.0 sense. The OSMF *Trivial Transformations*
guideline supports this, listing "Faster access for a game" and "Various forms of algorithm-driven
generalizations" as non-share-triggering, provided "no other source of data is involved".

**The counter-risk is real.** The Attribution Guideline states the limiting principle:

> "note that if a Produced Work is used to extract, copy, or recreate substantial parts of the
> OpenStreetMap data, it is considered to be a Derivative Database."

A grid fine enough to cleanly vectorise building footprints back out is arguably a Derivative
Database in raster clothing. **Mitigations (adopt all):** bake at gameplay resolution
(decimetre-to-metre cells, not centimetre), store quantised occupancy/cost rather than per-feature
classes, and carry no OSM IDs or tag strings into shipped assets.

**3D building meshes sit on weaker footing** than the raster — a mesh retains per-building geometry
at near-lossless fidelity, which is closer to "intended for extraction". Ship them as **merged,
batched, decimated scene geometry without per-building IDs**, not as a queryable per-building
record set.

> ⚑ **Status caveat (CONFIRMED discrepancy).** The OSMF guideline index lists *Trivial
> Transformations* among guidelines "endorsed by the OSMF board", but the guideline page itself
> lacks the `Status: Endorsed` line the other five carry and states "This is at the proposal stage
> in our process - it may change after discussion by the OpenStreetMap community." Treat it as
> persuasive, not settled.

### 2.5 § 4.3 — the notice that must accompany a Produced Work

Verbatim:

> "**4.3 Notice for using output (Contents).** Creating and Using a Produced Work does not require
> the notice in Section 4.2. However, if you Publicly Use a Produced Work, You must include a notice
> associated with the Produced Work reasonably calculated to make any Person that uses, views,
> accesses, interacts with, or is otherwise exposed to the Produced Work aware that Content was
> obtained from the Database, Derivative Database, or the Database as part of a Collective Database,
> and that it is available under this License.
>
> a. Example notice. The following text will satisfy notice under Section 4.3:
>
> &nbsp;&nbsp;&nbsp;&nbsp;*Contains information from DATABASE NAME, which is made available here
> under the Open Database License (ODbL).*
>
> DATABASE NAME should be replaced with the name of the Database and a hyperlink to the URI of the
> Database. 'Open Database License' should contain a hyperlink to the URI of the text of this
> License. If hyperlinks are not possible, You should include the plain text of the required URI's
> with the above notice."

### 2.6 § 4.6 — if we ever do ship a Derivative Database

Verbatim:

> "**4.6 Access to Derivative Databases.** If You Publicly Use a Derivative Database or a Produced
> Work from a Derivative Database, You must also offer to recipients of the Derivative Database or
> Produced Work a copy in a machine readable form of:
>
> a. The entire Derivative Database; or
>
> b. A file containing all of the alterations made to the Database or the method of making the
> alterations to the Database (such as an algorithm), including any additional Contents, that make
> up all the differences between the Database and the Derivative Database.
>
> The Derivative Database (under a.) or alteration file (under b.) must be available at no more than
> a reasonable production cost for physical distributions and free of charge if distributed over the
> internet."

**Option (b) is our escape hatch** — publishing the Overpass query plus a description of the
processing algorithm satisfies § 4.6 without shipping any data dump.

Also relevant if assets are ever bundled behind DRM: **§ 4.7(b)** then requires parallel
distribution of an "Unrestricted Database" at no additional fee, "at least as accessible to the
recipient as a practical matter as the Restricted Database."

### 2.7 Required attribution (OSMF Attribution Guideline, adopted 2021-06-25)

> "Attribution must be to 'OpenStreetMap'." … it "must also make it clear that the data is available
> under the Open Database License. This may be done by making the text 'OpenStreetMap' a link to
> openstreetmap.org/copyright".

**Exact string to use:**

```
© OpenStreetMap contributors
```

…with **"OpenStreetMap" hyperlinked to `https://www.openstreetmap.org/copyright`**.

Placement rules, per medium:

| Medium | Requirement |
|---|---|
| **Interactive browser display** | "the credit should typically appear in a corner of the map", or adjacent to it, or on a startup splash. May fade/collapse on dismiss, on map interaction, or "automatically after five seconds" — but the user "must still be able to find the licence information if they look for it" (an '(i)' button or About menu). |
| **Static rendered image** | "Static images must be generally attributed the same way as interactive maps." One instance suffices across multiple images in one document. **Exemptions do not help us**: they cover "static images of fewer than 100 features" and "areas less than 10,000 m²" — our sprint venue vastly exceeds both. |
| **Baked game assets** | The guideline has a dedicated *Computer games and simulations* section: "attribution can be provided either by a splash screen on application startup, in the game view, during gameplay, on the credits page, in the menu, or in another suitable location." Splash text "must be easily legible and visible such that the typical viewer has time to comprehend the attribution". |

General requirement: attribution "should not require individuals to interact with the map or
produced work to see the attribution" — **a credit buried only behind a menu is not enough.**

### 2.8 DbCL 1.0 — the contents layer

[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) covers the individual contents. § 2.1
grants a "perpetual, irrevocable copyright license to do any act that is restricted by copyright
over anything within the Contents", including sublicensing. § 2.4: "The Licensor takes the position
that factual information is not covered by copyright." § 2.2 is the sting: "**You must comply with
the ODbL.**"

**Practical meaning:** individual facts (one building's outline) carry essentially no copyright
encumbrance. Our entire exposure is the *sui generis database right* on Substantial systematic
extraction — which is precisely what we are doing. So the ODbL analysis above is the whole game.

### 2.9 ODbL never touches our engine

**§ 2.3(a):** "This License does not apply to computer programs used in the making or operation of
the Database." Our game code, rendering engine and non-OSM assets are entirely unaffected.

### 2.10 Compliance architecture — do this

1. **Cleave the pipeline from the product.** Build offline: Overpass → intermediate geodata → bake.
   Ship only baked artefacts. Per § 4.5(c) the intermediate is internal use, outside § 4.4.
2. **Ship no vector geodata to the browser.** No GeoJSON, no per-feature records, no OSM IDs, no tag
   strings. Ship PNG/WebP rasters, merged binary meshes, quantised occupancy/cost grids.
3. **Keep the OSM-derived pipeline OSM-only** — purely algorithmic, no external observation data
   merged into the same feature types. This preserves the *Trivial Transformations* argument.
4. **Put non-OSM data in separate feature types.** Per the *Horizontal Map Layers* guideline: "if
   all data for that Feature Type is from non-OpenStreetMap sources, then the ODbL share-alike
   conditions do not apply to that Feature Type". Control points, courses and gameplay metadata are
   unrelated feature types — safe. Avoid cross-references keyed to OSM elements.
5. **Pre-empt § 4.4(c) / § 4.6.** Our bake almost certainly constructs an intermediate Derivative
   Database. Publish a § 4.6(b) alteration statement: the Overpass query, the bbox, the extraction
   date and `timestamp_osm_base`, and a description of the transformation. Cheap, and it closes the
   highest-probability compliance gap. **The tested queries in
   `research/overpass-*.overpassql` are already written to serve as this artefact.**
6. **Attribution in three places:** splash screen on load, persistent corner credit in the game view,
   and a credits/about entry — all with `© OpenStreetMap contributors` linking to
   `https://www.openstreetmap.org/copyright`. Add the § 4.3 notice to the about page.

### 2.11 What WOULD drag us into share-alike

- ❌ Shipping vector building/wall/path geometry as a queryable asset (GeoJSON, vector tiles, PBF, a
  per-feature JSON array) — that is a Derivative Database under § 4.4(b).
- ❌ Retaining OSM IDs or tag key/values in shipped assets, making them re-extractable.
- ❌ Exposing any API/endpoint that returns OSM-derived features individually.
- ❌ **Merging our own surveyed data into the same feature type as OSM data** — e.g. adding walls OSM
  missed, or correcting OSM building outlines from ČÚZK/our survey. *Horizontal Map Layers*: "If you
  improve data used in the OpenStreetMap layer, such as additions or factual corrections, then you
  need to share those improvements." **This is the single most likely way we get caught** — and note
  it directly constrains the tempting idea of fusing ZABAGED building polygons with OSM ones.
- ❌ Defining a non-OSM layer *relative to* OSM ("all fences not in OSM") — explicitly called out.
- ❌ Cross-referencing our data to OSM by key — the *Collective Database* guideline treats a join key
  as a reference destroying independence.
- ❌ Baking a grid/mesh at fidelity high enough to reconstruct OSM geometry.
- ❌ Publishing our intermediate pipeline database without ODbL terms.

> **Design consequence worth flagging to the team.** § 2.11's fourth bullet means the ZABAGED
> ↔ OSM fusion strategy needs care. **Safe:** use ZABAGED as the sole source for the forest venue
> and OSM as the sole source for the sprint venue (which is exactly what `RESEARCH-GEODATA.md` §7.4
> recommends on data-quality grounds anyway — the licensing and the engineering point the same way).
> **Risky:** merging ZABAGED walls into the OSM wall layer for Krumlov to fill gaps. If we want
> both, keep them as **separate, independently-derived feature types** that are composited only at
> render/bake time, never joined.

---

## 3. Copernicus DEM GLO-30 (fallback / non-Czech areas)

- **Access (keyless, no registration):**
  `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{N|S}YY_00_{E|W}XXX_00_DEM/…_DEM.tif`
- Cloud-Optimized GeoTIFF — **HTTP range requests work**, so you can pull just the window you need.
- **Licence:** free for public use, **redistribution explicitly permitted with attribution**.
- **Required notice (verbatim):**

```
© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under
COPERNICUS by the European Union and ESA; all rights reserved.
```

- Note it is a **DSM** (includes buildings and vegetation), not a bare-earth DTM.
- Docs: <https://registry.opendata.aws/copernicus-dem/> · licence:
  <https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf>

**SRTMGL1** (`https://s3.amazonaws.com/elevation-tiles-prod/skadi/N50/N50E014.hgt.gz`) is **public
domain** (NASA/USGS) — the most permissive option, but older and noisier. Fine as a sanity check.

**EU-DEM v1.1 is deprecated** — no longer maintained or disseminated; superseded by Copernicus DEM.
Do not use.

---

## 4. ISOM / ISSprOM specifications

The map specifications themselves (**ISOM 2017-2**, **ISSprOM 2019-2**) are published by the
**International Orienteering Federation**. They are freely downloadable specifications, but:

- ✅ Implementing the *symbol semantics and colour values* is fine — these are functional standards,
  and colours/dimensions are facts.
- ⚠ **Do not redistribute the specification PDFs** or reproduce their symbol artwork wholesale as an
  asset library without checking IOF terms.
- ⚠ Do not imply IOF endorsement or certification of the game.

**UNVERIFIED:** the precise IOF licensing terms on the specification documents were not retrieved in
this research. If we ship a symbol set derived from the spec, confirm before launch.

---

## 5. Google Maps Platform — PROHIBITED

All quotations verbatim from the live
[Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms/) and
[Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms),
fetched 2026-08-01.

### 5.1 Our exact use case is a named prohibited example

**ToS § 3.2.3(c) "No Creating Content From Google Maps Content":**

> "Customer will not create content based on Google Maps Content. For example, Customer will not:
> (i) trace or digitize roadways, building outlines, utility posts, or electrical lines from the
> Maps JavaScript API Satellite base map type; (ii) create 3D building models from 45° Imagery from
> Maps JavaScript API; **(iii) build terrain models based on elevation values from the Elevation
> API**; (iv) use latitude/longitude values from the Places API as an input for point-in-polygon
> analysis; (v) construct an index of tree locations within a city from Street View imagery;
> (vi) convert text-based driving times into synthesized speech results; or (vii) use Google Maps
> Content to improve machine learning and artificial intelligence models, including to train, test,
> validate or fine-tune the models."

Clause **(iii)** is a verbatim description of baking a terrain heightmap from Elevation API values.
Clause **(i)** kills tracing from satellite imagery. Clause **(vii)** kills any ML/classification
use.

### 5.2 Zero caching is permitted for the services we'd want

**§ 3.2.3(b) "No Caching":**

> "Customer will not cache Google Maps Content **except as expressly permitted under the Maps
> Service Specific Terms**."

This is default-deny. Enumerating every service heading in Section B of the Service Specific Terms
confirms there is **no Elevation API section, no Maps Static API section, and no Map Tiles API
section**. The 30-day caching allowances exist only for *other* services (e.g. § B.6.3.1 for
Geocoding lat/lng). **Therefore the permitted cache duration for elevation values, static maps and
tiles is zero.**

**§ 3.2.3(a) "No Scraping"** names them explicitly:

> "Customer will not export, extract, or otherwise scrape Google Maps Content for use outside the
> Services. For example, Customer will not: (i) pre-fetch, index, store, reshare, or rehost Google
> Maps Content outside the services; (ii) **bulk download** Google Maps tiles, Street View images,
> geocodes, directions, distance matrix results, roads information, places information, **elevation
> values**, and time zone details…"

### 5.3 Google content may not appear on a non-Google map

**§ 3.2.3(e) "No Use With Non-Google Maps":**

> "To avoid quality issues and/or brand confusion, Customer will not use the Google Maps Core
> Services with or near a non-Google Map in a Customer Application. For example, Customer will not
> (i) display or use Places content on a non-Google Map, (ii) display Street View imagery and
> non-Google Maps on the same screen, or (iii) link a Google Map to non-Google Maps Content or a
> non-Google Map."

**An orienteering map is inherently a non-Google map surface.** This clause independently forbids
mixing Google terrain data into our renderer even if everything else were permitted.

### 5.4 No redistribution

**§ 3.1 License Grant** — "non-exclusive, **non-transferable, non-sublicensable**".
**§ 3.2.1(b)** — "sell, resell, sublicense, transfer, or distribute the Services" is prohibited.

Shipping a heightmap asset to a browser inherently distributes the content. Not permitted.

Additionally **§ 3.2.3(d)(iii)** prohibits use "to create or augment an advertising product" — a
promotional marketing game is arguably exactly that. (**UNVERIFIED** how aggressively Google reads
this in practice, but it is live exposure for our specific framing.)

**Enforcement:** § 5.2 allows Google to "**immediately** Suspend" for § 3.2 violations; § A.4 of the
Service Specific Terms permits a demanded corporate-officer compliance certification and an annual
third-party audit.

### 5.5 Verdict

| Use | Verdict |
|---|---|
| **(a) Shipped game data** | ❌ **PROHIBITED** — four independent clauses each kill it |
| **(b) Dev-time cross-check only** | ❌ **LEGALLY UNSAFE** — zero permitted cache; and using Google values to validate our DEM is itself "build terrain models based on elevation values" (cf. (vii), which prohibits using Content to "test" and "validate") |
| **(c) Not at all** | ✅ **RECOMMENDED** |

We lose nothing. DMR 5G is **0.18 m** vertical accuracy versus Google's documented 4.8–19 m
`resolution` values, and Google's own docs warn that batched `path`+`samples` requests return
*coarser* data. **Remove Google Maps Platform from the data path entirely.**

The only legitimate appearance would be a live, interactive Google map rendered by Google's own SDK
with branding intact, on a screen entirely separate from the orienteering map surface (§ 3.2.3(e)).
That is a product decision, not a data-sourcing one.

---

## 6. Orienteering map material — reference only, NOT redistributable

### 6.1 ČSOS map archive (`mapy.ceskyorientak.cz`)

Terms, from the archive's own about page (verbatim):

> "Autorská práva k užití jednotlivých map mají jejich vydavatelé uvedení v databázi a tiráži mapy."
> — *Copyright in the use of individual maps rests with their publishers, as listed in the database
> and the map's imprint.*

> "Náhledy map zpřístupněné mapovým portálem neopravňují bez souhlasu vydavatele mapy k jejich
> použití pro organizované či hromadné akce."
> — *Previews made available by the map portal do not entitle their use for organised or mass events
> without the map publisher's consent.*

**No open licence.** Previews are watermarked "Mapový portál ČSOS". Print-quality files must be
requested from the named map administrator.

| Use | Verdict |
|---|---|
| View for terrain understanding | ✅ Yes |
| Cite in internal research docs | ✅ Yes |
| **Trace into shipped game assets** | ❌ **NO** |
| **Redistribute previews** | ❌ **NO** |
| Use as ground truth to validate our classifier, internally | ⚠ Grey — internal, transient, non-distributed comparison only |

> The downloaded previews in `research/raw/maps/` are **local research artefacts under a gitignored
> path**. They must not be committed, published, or used as a tracing source.

The 2026 competition maps (`WcupQ/L/M/R`) are additionally marked **`Blokace do 2035`** — blocked
until 2035, no preview available.

### 6.2 Event bulletins (wcup.cz, o-tour.cz) and the embargo KML

© the organisers. Terrain descriptions may be **quoted short and attributed** (as done in
`RESEARCH-GEODATA.md` §9.2) under normal quotation practice. Bulletin PDFs, map samples and
photographs must not be redistributed as part of the game.

The embargo KML is published via Google My Maps — the *geometry* is factual (a boundary), but it
was obtained through a Google service. Treat the polygon as organiser-published event information,
cite the organisers, and do not present it as our own data.

> ⚠ **Reputational, not legal:** the FOREST AOI lies inside a live competition embargo for an event
> running 5–9 August 2026. Publishing a detailed, navigable 3D reconstruction of embargoed terrain
> during the embargo would be poorly received by the orienteering community regardless of data
> licensing, and could be read as undermining the competition. **This deserves a deliberate decision
> about launch timing and framing, and ideally a conversation with the organisers** — who are also
> the most natural marketing partner for the game.

---

## 7. Consolidated attribution block

Place in an about/credits screen, reachable from the game view, plus a persistent short credit.

```
DATA SOURCES

Terrain elevation, surface model, orthophoto and topographic data
© Český úřad zeměměřický a katastrální (ČÚZK)
Licensed under CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
Source: https://geoportal.cuzk.gov.cz/
Modified: resampled, reprojected, and derived into terrain, canopy
and vegetation runnability models.

Map data © OpenStreetMap contributors
https://www.openstreetmap.org/copyright
Contains information from OpenStreetMap, which is made available
here under the Open Database License (ODbL).

[if used] Elevation data outside Czechia:
© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
provided under COPERNICUS by the European Union and ESA; all rights reserved.
```

Persistent in-view short credit (must link to the block above):

```
Terrain © ČÚZK (CC BY 4.0) · Map data © OpenStreetMap contributors
```

Also publish, to satisfy ODbL § 4.6(b) pre-emptively (see § 2.10 item 5): the Overpass queries,
bboxes, extraction dates and `timestamp_osm_base`, and a description of the bake pipeline.

---

## 8. Action checklist

- [ ] Add the § 7 attribution block to an about/credits screen.
- [ ] Add persistent short credit to the game view (visible without interaction).
- [ ] Add attribution to the loading splash.
- [ ] Publish the ODbL § 4.6(b) alteration statement (queries + algorithm description).
- [ ] Verify no shipped asset contains OSM IDs, tag strings, or per-feature vector records.
- [ ] Verify baked grids are at gameplay resolution, quantised, not vectorisable back to footprints.
- [ ] Keep ZABAGED-derived and OSM-derived feature types **separate** — no merging, no join keys.
- [ ] Confirm IOF terms before shipping an ISOM/ISSprOM-derived symbol asset library.
- [ ] Ensure `research/raw/` (containing non-redistributable ČSOS previews and bulletins) stays
      gitignored and unpublished. *(already gitignored — verified)*
- [ ] Decide launch timing/framing relative to the 5–9 Aug 2026 embargo; consider contacting the
      organisers.

### ⚑ LAWYER — two items worth professional review

1. **The Produced Work boundary for our baked assets** (§ 2.4). The analysis is well-grounded but
   the *Trivial Transformations* guideline we partly rely on has an unresolved endorsement status,
   and the *Produced Work* guideline contains a sentence — "if you publish a produced work, the
   underlying database has to be published as well" — that reads broader than ODbL § 4.6 actually
   is. Recommendation § 2.10(5) makes this moot in practice, but confirm.
2. **The advertising-product framing** (§ 5.4) if any Google surface is ever reintroduced, and more
   generally whether "commercial marketing game" creates issues under any source's terms. Neither
   CC BY 4.0 nor ODbL has a field-of-use restriction, so this is a low but non-zero concern.
