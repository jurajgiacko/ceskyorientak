# RESEARCH-SPORT.md — Orienteering domain reference for `ceskyorientak`

**Purpose.** Implementation-ready reference for the orienteering browser-game simulator. Everything here is
sourced from the current normative IOF documents (fetched and read in full) or from cited secondary sources.
Numbers are given exactly as the specs state them. Where a value is derived or estimated, it is marked
**[derived]** or **[estimate]**.

**Normative documents used (all fetched and read):**

| Doc | Version used | URL |
|---|---|---|
| ISOM — International Specification for Orienteering Maps | **ISOM 2017-2, Revision 6, January 2024** (valid 1 Feb 2024, mandatory 1 Jan 2025) | https://www.ffcorientation.fr/media/cms_page_media/72/IOF%20ISOM%202017-2%20Revision%206%20January%202024.pdf |
| ISSprOM — International Specification for Sprint Orienteering Maps | **ISSprOM 2019-2, Revision 6, January 2024** | https://www.ffcorientation.fr/media/cms_page_media/72/IOF%20ISSprOM%202019-2%20Revision%206%20January%202024.pdf |
| IOF Map Specifications — Printing and Colour Definitions | **Revision 4, September 2024** (valid 1 Dec 2024) | https://o-maps.spb.ru/rules/iof_printing_rev_4_2024_omaps.pdf |
| International Specification for Control Descriptions | **2024** (supersedes 2018) | https://baoc.org/wiki/images/d/da/IOF_Control_Descriptions_2024.pdf |
| IOF Competition Rules for Foot Orienteering | **2025** | https://orientacao.pt/wp-content/uploads/2025/04/IOF-Competition-Rules-Foot-O-2025.pdf |
| ISOM 2017 (first edition — for historical symbol 411) | 2017 | https://o-sport.de/assets/dokumente/allgemein/kartenwesen/isom2017en.pdf |
| IOF Control Descriptions landing page | — | https://orienteering.sport/iof/rules/control-descriptions/ |
| O-Map Wiki (IOF Map Commission) | — | https://omapwiki.orienteering.sport/specifications/issprom/ |

## Contents

1. [**ISOM 2017-2** — forest maps 1:15 000 / 1:10 000](#1-isom-2017-2-forest-maps-115-000-110-000) — colours (CMYK + hex), the five-colour logic, runnability bands, the full symbol tables, minimum dimensions
2. [**ISSprOM 2019-2** — sprint maps 1:4 000 / 1:3 000](#2-issprom-2019-2-sprint-maps-14-000-13-000) — the black-line-width passability ladder, canopy vs building, multi-level, the olive/DSQ rule
3. [**IOF Control Descriptions 2024**](#3-iof-control-descriptions) — sheet format and every column A–H pictogram with SVG-ready geometry
4. [**Course overprint**](#4-course-overprint-isom-37-issprom-47-iof-rules-1519-appendix-2) — start triangle, control circles, the gap rule, marked routes, crossing points, control flags
5. [**SportIdent**](#5-sportident) — card generations, SIAC/AIR+, feedback, station types, splits, mispunch rules, start modes
6. [**Navigation technique as game mechanics**](#6-navigation-technique-as-game-mechanics) — compass, handrails, attack points, aiming off, the parallel error, relocation, time-loss calibration
7. [**Race formats**](#7-race-formats-iof-competition-rules-2025-15-16-appendix-2-appendix-6) — winning times, real WOC course specs, design philosophy, forking, qualification structure
8. [**Running speed model**](#8-running-speed-model) — Tobler, Minetti, Strava GAP, ISOM terrain multipliers, the combined formula + reference implementation
9. [**Czech / Slovak / English terminology**](#9-czech-slovak-english-terminology-i18n-source-of-truth) — ~200 terms for i18n
* [Appendix A — audit risks, open questions, corrected priors](#appendix-a-consolidated-audit-risks-and-open-questions)

**Conventions used throughout this file**

* All ISOM dimensions are **mm at 1:15 000**. All ISSprOM dimensions are **mm at 1:4 000**.
* `(OM)` = outside measure, `(IM)` = inside measure, `(CC)` = centre-to-centre.
* "Footprint" = the ground distance a map dimension corresponds to
  (`footprint_m = mm × scale / 1000`; at 1:15 000, 1 mm = 15 m; at 1:10 000, 1 mm = 10 m; at 1:4 000, 1 mm = 4 m).
* ISOM/ISSprOM wording: **Impassable / Uncrossable** means *"too difficult or dangerous to go through or over
  by the average elite orienteer under normal conditions. It is not forbidden, but it may pose a risk"* (ISOM §1.1).
  This is a **cartographic** statement, not a legal one — except in Sprint, where Competition Rule 17.2 turns a
  specific list of ISSprOM symbols into hard, DSQ-enforced prohibitions (see §2.6).

---
---

# 1. ISOM 2017-2 — Forest maps (1:15 000 / 1:10 000)

## 1.1 Scale, contour interval, enlargement

| Property | Value | Source |
|---|---|---|
| Base scale | **1:15 000** | ISOM §2.9 |
| Generalisation | must follow the requirements for 1:15 000 at all scales | ISOM §2.9 |
| Enlargement to 1:10 000 | **all lines, symbols and screens ×150 %** — including course-planning symbols | ISOM §2.9.1 |
| Enlargement to 1:5 000 | course-planning symbols ×300 % | ISOM §3.7 |
| Contour interval | **5 m**. 2.5 m permitted only if the slope is < 5 % (contours > 7 mm apart) **over the whole area**. Mixed intervals on one map are forbidden. | ISOM §2.10 |
| Form lines | at most **one** between neighbouring contours; a form line makes terrain look ~2× steeper — use sparingly | ISOM §2.10 |
| Magnetic north line spacing | **20 mm** on the map = **300 m on the ground** at 1:15 000 (→ 30 mm on a 1:10 000 enlargement) | ISOM 601 |
| Max paper size | A3 (larger should be avoided); cut maps must not be smaller than A5 | ISOM §2.9.1 |
| Mandatory peripheral info | map scale, contour interval | ISOM §2.13 |

**Game implication:** the contour interval is the single most useful number for the terrain model —
5 m vertical per contour line in forest, 2 m or 2.5 m in sprint.

## 1.2 The colour semantics (the "five-colour logic")

ISOM §2.2, verbatim:

> Blue is used for features that relate to water; Yellow is used for open areas; Green is used for vegetation
> features; Brown is used for landforms; Black and Grey are used for everything else, including rock and cliffs,
> paths and roads, and most man-made objects; Purple is used for course information.

So the encoding a programmer should implement is:

| Hue | Semantic axis | Encodes |
|---|---|---|
| **White** | vegetation | *typical open runnable forest* — 100 % runnability baseline. White is **not** "nothing"; it is a positive statement. |
| **Yellow** (3 levels) | openness | absence of tree canopy; more yellow = more open |
| **Green** (3 levels + dark) | vegetation density | reduced runnability / reduced visibility |
| **Blue** (4 levels) | water | water + water-caused vegetation (marsh) |
| **Brown** (3 levels) | landform | contours, banks, knolls, pits, broken ground, paved-area & road infill |
| **Black / grey** (5 levels) | everything else | rock, boulders, stony ground, bare rock, paths, roads, walls, fences, buildings, canopy |
| **Olive** (yellow+green 50 %) | prohibition | out-of-bounds / settlement (ISOM 520) |
| **Purple / magenta** | overprint | course information (701–715) |

## 1.3 EXACT colour definitions (normative CMYK + derived RGB)

Source: **IOF Map Specifications — Printing and Colour Definitions, Revision 4, September 2024**, Chapter 6
("Colour order"). CMYK is the only normative definition — the IOF does **not** publish RGB. Two RGB columns are
given below:

* **RGB (naive)** — the "device" conversion `R = 255·(1−C)·(1−K)` etc. This is what OCAD and OpenOrienteering
  Mapper store as the screen colour, and what most o-software shows. It is very saturated (green looks neon).
* **RGB (sRGB, coated)** — a colorimetric conversion through the **Euroscale Coated v2** CMYK ICC profile to sRGB
  (relative colorimetric). **This is what a printed orienteering map actually looks like, and it is the set you
  should use for the game canvas.** *(computed locally with LittleCMS; **[derived]**, not IOF-normative.)*

### 1.3.1 Master colour table

| Colour name (IOF) | C | M | Y | K | RGB naive | HEX naive | HEX sRGB coated | Used by |
|---|---:|---:|---:|---:|---|---|---|---|
| Upper purple for course overprint | 35 | 85 | 0 | 0 | 166,38,255 | `#A626FF` | **`#B24996`** | ISOM/ISSprOM/ISSkiOM/ISMTBOM |
| Lower purple for course overprint | 35 | 85 | 0 | 0 | 166,38,255 | `#A626FF` | **`#B24996`** | all |
| Purple 50 % area symbol | 18 | 43 | 0 | 0 | 209,145,255 | `#D191FF` | **`#D3A2C8`** | ISSprOM 714, ISMTBOM |
| White for course overprint | 0 | 0 | 0 | 0 | 255,255,255 | `#FFFFFF` | `#FFFFFF` | ISSprOM/ISSkiOM/ISMTBOM (removed from ISOM 2017-2, errata 16.09.2022) |
| Black 100 % | 0 | 0 | 0 | 100 | 0,0,0 | `#000000` | `#000000` * | all |
| Black 60 % (buildings) | 0 | 0 | 0 | 60 | 102,102,102 | `#666666` | `#858488` | ISMTBOM |
| Black 50 % (large buildings) | 0 | 0 | 0 | 50 | 128,128,128 | `#808080` | **`#9B9A9E`** | ISOM 521 (>75×75 m), ISSprOM 521 |
| Black 35 % (area symbols) | 0 | 0 | 0 | 35 | 166,166,166 | `#A6A6A6` | **`#BABCBF`** | ISOM 214 Bare rock, ISSprOM 214 |
| Black 20 % (canopy) | 0 | 0 | 0 | 20 | 204,204,204 | `#CCCCCC` | **`#D9DBDD`** | ISOM 522, ISSprOM 522 |
| Blue 100 % | 100 | 0 | 0 | 0 | 0,255,255 | `#00FFFF` | **`#00A9EB`** | all — water |
| Blue 70 % | 70 | 0 | 0 | 0 | 77,255,255 | `#4DFFFF` | **`#3DC0F1`** | ISOM 301 dominant lakes, ISSprOM 301 |
| Blue 50 % | 50 | 0 | 0 | 0 | 128,255,255 | `#80FFFF` | **`#85D1F4`** | ISOM 302 shallow water |
| Blue 30 % | 30 | 0 | 0 | 0 | 178,255,255 | `#B2FFFF` | **`#BDE5F9`** | ISSprOM 302 shallow water |
| **Brown 100 %** | **25** | **75** | **100** | **0** | 191,64,0 | `#BF4000` | **`#C65E2A`** | contours, landforms. *(changed Sept 2024 from 0/56/100/18)* |
| Brown 50 % (road / paved infill) | 10 | 35 | 50 | 0 | 230,166,128 | `#E6A680` | **`#E5B182`** | ISOM 501/502, ISSprOM 501 heavy traffic. *(changed Sept 2024 from 0/28/50/9)* |
| Brown 30 % (road / paved infill) | 6 | 23 | 33 | 0 | 240,196,171 | `#F0C4AB` | **`#EFCCAD`** | ISSprOM 501 light traffic. *(changed Sept 2024 from 0/17/30/5)* |
| **Dark green** (forest edges / uncrossable veg.) | 100 | 0 | 80 | 30 | 0,178,36 | `#00B224` | **`#007D54`** | ISOM 416 green-line variant; ISSprOM 411 |
| **Green 100 %** | **80** | **0** | **100** | **0** | 51,255,0 | `#33FF00` | **`#43AA3A`** | ISOM/ISSprOM 407, 409, 410, 413, 414, 417, 418, 419 |
| **Green 60 %** | 48 | 0 | 60 | 0 | 133,255,102 | `#85FF66` | **`#9AC983`** | ISOM/ISSprOM 408 |
| **Green 30 %** | 24 | 0 | 30 | 0 | 194,255,178 | `#C2FFB2` | **`#CFE5C4`** | ISOM/ISSprOM 406 |
| **Olive green** | 38 | 27 | 100 | 0 | 158,186,0 | `#9EBA00` | **`#B5A722`** | ISOM 520 / ISSprOM 520 out-of-bounds. Printed as yellow 100 % **over** green 50 %. |
| **Yellow 100 %** | **0** | **27** | **79** | **0** | 255,186,54 | `#FFBA36` | **`#FAC14C`** | ISOM/ISSprOM 401, 402, 412 |
| Yellow 75 % | 0 | 20 | 59 | 0 | 255,204,105 | `#FFCC69` | **`#FBD179`** | ISOM 401/402 when yellow dominates |
| Yellow 50 % | 0 | 14 | 40 | 0 | 255,219,153 | `#FFDB99` | **`#FCDFA6`** | ISOM/ISSprOM 403, 404, 213 |
| Orange (Ski-O / MTBO) | 0 | 60 | 100 | 0 | 255,102,0 | `#FF6600` | `#EF7E19` | ISSkiOM / ISMTBOM only |
| Green for Ski-O | 91 | 0 | 83 | 0 | 23,255,43 | `#17FF2B` | `#00A460` | ISSkiOM only |

\* Black 100 % converts through a coated CMYK profile to about `#323235` (L*≈20, because K-only black on coated
stock is not a true black). **For the game, force black to `#000000`.**

> **Historical note / trap:** OpenOrienteering Mapper's shipped `ISOM 2017-2_15000.omap` still carries the *old*
> pre-2024 values — Brown `0/56/100/18` and **Green `76/0/91/0`** (an ISOM 2000 hold-over), not the current
> `25/75/100/0` and `80/0/100/0`. If you copy colours out of an OOM/OCAD file, you will get the wrong green and
> brown. Use the table above.
> (source: https://raw.githubusercontent.com/OpenOrienteering/mapper/master/symbol%20sets/15000/ISOM%202017-2_15000.omap)

### 1.3.2 Colour (printing) order — this is a rendering z-order, implement it literally

The Revision-4 table is printed **in colour order**: the first row prints last (on top), the last row prints first
(at the bottom). For a canvas renderer, paint **bottom-up** from the last row. The ISOM 2017-2 subset, from
**bottom (painted first)** to **top (painted last)**:

```
 1  Yellow 50 %  → 2 Yellow 75 % → 3 Yellow 100 %
 4  Black for cultivated land and sandy ground
 5  White over yellow
 6  Black 35 % area symbols
 7  Green 30 % → 8 Green 60 % → 9 Green 100 % (area)
10  Olive green
11  Brown 50 % for paved area
12  White over green and brown
13  Blue 50 % → 14 Blue 70 % → 15 Blue 100 % (area)
16  Black 20 % for canopy
17  Black 50 % for large buildings
18  Black 100 % for road outline
19  Brown 50 % for road infill
20  Brown 100 % (line symbols)
21  LOWER PURPLE for course overprint      ← course lines/circles sit HERE
22  Dark green for forest edges
23  Blue 100 % line symbols
24  Green 100 % point symbols
25  Brown 100 % point symbols
26  Blue 100 % point symbols
27  Black 100 %
28  White for railroad
29  UPPER PURPLE for course overprint      ← marked routes, OOB areas sit HERE
```

**The two purples are the whole trick.** They have *identical* CMYK (35/85/0/0) but different priority:

* **Lower purple** (control circles, course lines, start triangle, finish, control numbers, crossing points,
  first-aid, refreshment) is drawn **below** Black 100 %, Brown 100 % lines and Blue 100 % lines. Result: contours,
  cliffs, boulders, paths and streams **show through** the course overprint. ISOM §3.7: *"All course planning symbols
  shall be printed over the map content. They shall not mask out map detail of at least black, brown and blue 100 %."*
* **Upper purple** (marked route 707, out-of-bounds area 709, out-of-bounds route 711, map-issue point 702) is drawn
  **on top of everything** — because those must be unmissable.

In offset printing this is achieved with a real Pantone Purple spot plate that overprints transparently; in laser
printing it is *simulated* purely by z-order (Printing & Colour Definitions §4). **For the game: just use two draw
layers with the same colour and no alpha.**

## 1.4 Runnability — the normative scale (ISOM §2.3)

> "Runnability is divided into five categories of speed. If speed through flat and open runnable forest is 4 min/km…"

| # | Runnability | Description | Examples | Approx. speed (min/km) | Distance covered in 4 min |
|---|---|---|---|---|---|
| 1 | **> 100 %** | Easy running | Lawns, paved areas, paths | **< 4:00** | > 1000 m |
| 2 | **80–100 %** | Normal running speed | Rough open land, forest | **< 5:00** | 800–1000 m |
| 3 | **60–80 %** | Slow running | Stony ground, undergrowth, dense vegetation | **5:00–6:40** | 600–800 m |
| 4 | **20–60 %** | Walk / difficult to run | Very stony ground, undergrowth, dense vegetation | **6:40–20:00** | 200–600 m |
| 5 | **< 20 %** | Fight | Extremely stony ground, very dense vegetation | **> 20:00** | < 200 m |

ISOM §2.3 also states two facts a simulator must honour:

1. **Combination is multiplicative-ish, and worse than either alone:** *"A combination of a green screen and stony
   ground means that the runnability will be worse than for each of them in isolation."*
2. **Slope reduces runnability:** *"The steepness of the terrain may also influence runnability (the steeper the
   terrain, the less runnable)."*

## 1.5 Symbol tables

### 1.5.1 Landforms — brown (ISOM §3.1)

| # | Name | Type | Colour | Key dimensions (mm @1:15 000) | Min. real-world size | Notes for simulation |
|---|---|---|---|---|---|---|
| 101 | Contour | L | brown | line **0.14**; slope-line tag 0.4 (OM) | knoll/depr. min height/depth **1 m** | 5 m interval. Smallest bend 0.25 mm CC (footprint 4 m); re-entrant/spur mouth > 0.5 mm CC (8 m). Min contour knoll 0.9×0.6 mm OM (13.5×9 m); min depression 1.1×0.7 mm OM (16.5×10.5 m). Height may be shifted ≤ 25 % of interval. |
| 102 | Index contour | L, T | brown | line **0.25**; label height **1.5 mm** sans-serif | — | every 5th contour |
| 103 | Form line | L | brown | line **0.14**, dash **2.0**, gap **0.25** | height/depth ≥ 1 m | min 2 dashes; min closed form 1.1 mm OM |
| 104 | Earth bank | L | brown | line **0.25**, tag 0.4, tags 0.5 CC | height ≥ 1 m | min length 0.6 mm (9 m). Impassable banks → 201. Slows running. |
| 105.1 | Earth wall | L | brown | line 0.18, ø0.45 dots, 2.0 CC | height ≥ 1 m | min length 1.4 mm (21 m) |
| 105.2 | Retaining earth wall | L | brown | line 0.18, ø0.45, 1.0 CC, offset 0.07 | height ≥ 0.5 m | min length 1.4 mm; half-dots point to the lower side |
| 106 | Ruined earth wall | L | brown | line 0.18, dashed | height ≥ 0.5 m | min 2 dashes (3.65 mm = 55 m) |
| 107 | Erosion gully | L | brown | tapered line 0.25→0.75 | depth ≥ 1 m | min length 1.15 mm (17.25 m) |
| 108 | Small erosion gully | L | brown | dots ø0.25, 0.45 CC | depth ≥ 0.5 m | min 2 dots (0.7 mm = 10.5 m); contours **shall** be broken around it |
| 109 | Small knoll | P | brown | ø0.5 filled dot | height ≥ 1 m | footprint 7.5 × 7.5 m; must not touch contours |
| 110 | Small elongated knoll | P | brown | 0.8 × 0.4 | height ≥ 1 m | footprint 12 × 6 m |
| 111 | Small depression | P | brown | 0.8 × 0.4 (OM), line 0.18, semicircle | depth ≥ 1 m, width ≥ 2 m | footprint 12 × 6 m, oriented to north |
| 112 | Pit | P | brown | 0.7 × 0.8 (OM), line 0.18, V-shape | depth ≥ 1 m, width ≥ 1 m | footprint 10.5 × 12 m; > 5×5 m → use 104 |
| 113 | Broken ground | A | brown | dots ø0.2; **3–4 dots/mm²**; CC 0.5–0.6 | ≥ 3 dots (10×10 m) | *little* impact on runnability |
| 114 | Very broken ground | A | brown | dots ø0.2; **7–9 dots/mm²**; CC 0.25–0.38 | ≥ 3 dots (7×7 m) | **does** affect runnability |
| 115 | Prominent landform feature | P | brown | 0.9 × 0.9 (OM), line 0.18 | — | meaning must be defined on the map |

### 1.5.2 Rock and boulders — black (+ grey) (ISOM §3.2)

| # | Name | Type | Colour | Key dimensions | Min. real size | Runnability effect |
|---|---|---|---|---|---|---|
| 201 | **Impassable cliff** | L | black | top line **0.35**, tags **0.12** @ 0.5 CC, tag length 0.4 | — | min length 0.6 mm (9 m). Gap between two impassable cliffs must exceed **0.25 mm**. **Barrier.** |
| 202 | Cliff | L | black | line **0.25**, tags 0.12 @ 0.5 CC | height ≥ 1 m | min length 0.6 mm (9 m); passage between cliffs ≥ 0.15 mm. *"Crossing a cliff will normally slow progress."* |
| 203.1 | Rocky pit or cave | P | black | 0.7 × 0.8 (OM), line 0.16 | depth ≥ 1 m | footprint 10.5 × 12 m |
| 203.2 | **Dangerous pit** | P | black + white | ø 0.9 (OM) | — | footprint 13.5 m ø. *New in Rev 6 (2024).* "fall could cause severe injury or death" — strongly not recommended as a control; tape it if on a route choice. |
| 204 | Boulder | P | black | **ø 0.4** filled (may be enlarged to ø 0.5) | height > 1 m | footprint 6 m ø |
| 205 | Large boulder | P | black | **ø 0.6** filled (may be reduced to ø 0.5) | height > 2 m | footprint 9 m ø |
| 206 | Gigantic boulder / rock pillar | A | black | plan shape; min width 0.25 mm; min area 0.3 mm² | 3.75 m wide, 67 m² | **Barrier.** Gap to other impassable ≥ 0.15 mm |
| 207 | Boulder cluster | P | black | equilateral triangle edge **0.8** (may be 0.96 = 120 %) | — | footprint 12 × 10 m, oriented north |
| 208 | Boulder field | A | black | solid triangles, **sides ratio 8 : 6 : 5** (0.8/0.6/0.5 mm), inner angles **92.9° / 48.5° / 38.6°**, random rotation. Density **0.8–1 symbol/mm²**, CC 0.75–1.2 | ≥ 2 triangles | *generally does not* reduce runnability |
| 209 | Dense boulder field | A | black | same triangle, density **2–3 symbols/mm²**, CC ≤ 0.6 | ≥ 2 triangles | **does** reduce runnability |
| 210 | Stony ground, slow running | A | black | dots ø0.2, **3–4 dots/mm²**, CC 0.45–0.6 | ≥ 3 dots (10×10 m) | **60–80 %** of normal speed |
| 211 | Stony ground, walk | A | black | dots ø0.2, **6–8 dots/mm²**, CC 0.32–0.4 | ≥ 3 dots (8×8 m) | **20–60 %** of normal speed |
| 212 | Stony ground, fight | A | black | dots ø0.16, **10–12 dots/mm²**, CC 0.25–0.32 | ≥ 3 dots (7×7 m) | **< 20 %** of normal speed |
| 213 | Sandy ground | A | **yellow 50 % + black** | black dot screen at 45° | min 1 × 1 mm (15 × 15 m) | runnability **< 80 %** |
| 214 | Bare rock | A | **black 35 %** | flat screen | min 1 × 1 mm (15 × 15 m) | runnable rock; less-runnable bare rock → 210–212 |
| 215 | Trench | L | black | 3 lines @ 0.10 | depth ≥ 1 m | min length 1 mm (15 m); impassable trench → 201 |

### 1.5.3 Water and marsh — blue (ISOM §3.3)

> **Rule of thumb the whole group hangs on:** *"A black line around a water feature indicates that it is uncrossable."*

| # | Name | Type | Colour | Key dimensions | Min. size | Notes |
|---|---|---|---|---|---|---|
| 301 | **Uncrossable body of water** | A | blue 100 % (70 % for dominant areas) + **black outline 0.12** | — | min inside width **0.3 mm**; min inside area 0.55 × 0.55 mm (8 × 8 m) | **Barrier / danger.** Narrow parts always full colour. |
| 302 | Shallow body of water | A | **blue 50 %** + blue outline 0.10 | — | min inside width 0.3 mm; area 0.7 × 0.7 mm (10.5 × 10.5 m); full-colour variant 0.55 × 0.55 mm | crossable, < 0.5 m deep, runnable. Dashed outline = seasonal. |
| 303 | Waterhole | P | blue | 0.7 × 0.8 (OM), line 0.18 | — | footprint 10.5 × 12 m |
| 304 | Crossable watercourse | L | blue | line **0.30** | width > 2 m | min length 1 mm (15 m) |
| 305 | Small crossable watercourse | L | blue | line **0.18** | width < 2 m | min length 1 mm (15 m) |
| 306 | Minor / seasonal water channel | L | blue | line 0.18, dash 1.25, gap 0.25 | — | min 2 dashes (2.75 mm = 41 m) |
| 307 | **Uncrossable marsh** | A | blue + **black outline 0.12** | blue lines 0.12 @ 0.5 CC | min width 2 lines or 0.8 mm IM | **Barrier / danger.** Black outline omitted where it meets 301. |
| 308 | Marsh | A | blue | lines 0.1 @ 0.3 CC | min 0.5 × 0.4 mm (7.5 × 6 m) | crossable, distinct edge; combine with yellow/green for openness & runnability |
| 309 | Narrow marsh | L | blue | dots ø0.25 @ 0.45 CC | min 2 dots (0.7 mm = 10.5 m) | < ~5 m wide |
| 310 | Indistinct marsh | A | blue | lines 0.1 @ 0.3 CC, longer gaps | min 2.0 × 0.7 mm (30 × 10.5 m) | gradual transition |
| 311 | Well / fountain / water tank | P | blue | 0.8 × 0.8 (OM), line 0.18 | — | footprint 12 × 12 m |
| 312 | Spring | P | blue | 0.9 × 0.45 (OM), line 0.18 | — | footprint 13.5 × 7 m; opens downstream |
| 313 | Prominent water feature | P | blue | 0.9 × 0.9 (OM), line 0.16, 72° star | — | definition must be on the map |

### 1.5.4 Vegetation — the yellow/white/green system (ISOM §3.4)

**The core principle (ISOM §3.4):** *white = typical open forest; yellow = open areas (several categories);
green = density of forest and undergrowth according to runnability (several categories).*

The two axes are **orthogonal**:
* **yellow ↔ white** = how open the canopy is (visibility / sky)
* **white → green 30 % → green 60 % → green 100 %** = how much the undergrowth slows you

| # | Name | Type | Colour (exact) | **Runnability** | Min. area / width | Notes |
|---|---|---|---|---|---|---|
| 401 | **Open land** | A | **yellow 100 %** (or 75 % if yellow dominates) | **> 100 %** — better than open forest | 0.55 × 0.55 mm (8 × 8 m) | grass/moss ground cover. Only combinable with 113, 208, 308, 310. |
| 402 | Open land with scattered trees | A | yellow 100 % (or 75 %) with **ø 0.4 holes at 0.7 CC, 45°** — holes **white** (trees) or **green 60 %** (bushes) | ~ as 401 | width ≥ 1.5 mm (22.5 m); area 2 × 2 mm (30 × 30 m) | oriented to north |
| 403 | **Rough open land** | A | **yellow 50 %** | **80–100 %** — same as typical open forest | 1 × 1 mm (15 × 15 m) | heath, moorland, **felled areas (paseka)**, new plantation < 1 m. May combine with 407/409 to reduce. |
| 404 | Rough open land with scattered trees | A | yellow 50 % with **ø 0.5 holes at 0.8 CC, 45°** — white or green 60 % | as 403 | width ≥ 1.5 mm; area 2.5 × 2.5 mm (37.5 × 37.5 m) | only the *white-dot* variant may combine with 407/409 |
| 405 | **Forest** | A | **white** | **100 % (the baseline)** | 1 × 1 mm (15 × 15 m) generally; 0.7 × 0.7 in 408 and in 401; 0.55 × 0.55 in 410 | *"If no part of the forest is easily runnable then no white should appear on the map."* |
| 406 | **Vegetation: slow running** | A | **green 30 %** | **60–80 %** | area 1 × 1 mm (15 × 15 m); width 0.4 mm (6 m) | **low visibility.** White stripes = better running in one direction |
| 407 | Vegetation: slow running, **good visibility** | A | **green 100 %**, horizontal lines **0.12 @ 0.84 CC** | **60–80 %** | 1.5 × 1 mm (22.5 × 15 m) | undergrowth (brambles, heather, cut branches) under open canopy; oriented to north |
| 408 | **Vegetation: walk** | A | **green 60 %** (stripes may be green 30 %) | **20–60 %** | area 0.7 × 0.7 mm (10.5 × 10.5 m); width 0.3 mm (4.5 m) | dense trees / thickets, low visibility |
| 409 | Vegetation: walk, **good visibility** | A | **green 100 %**, horizontal lines **0.14 @ 0.42 CC** | **20–60 %** | 1 × 1 mm (15 × 15 m) | oriented to north |
| 410 | **Vegetation: fight** | A | **green 100 %** (stripes green 60 % / 30 % / white) | **< 20 %** | area 0.55 × 0.55 mm (8 × 8 m); width 0.25 mm (3.8 m) | barely passable |
| *411* | *(does not exist in ISOM 2017-2)* | — | — | — | — | **In ISOM 2017 (1st ed.) 411 was "Vegetation, impassable"; it was deleted in ISOM 2017-2.** In **ISSprOM 2019-2**, 411 = "Uncrossable vegetation" (dark green). Do not reuse 411 for forest maps. |
| 412 | Cultivated land | A | **yellow 100 % + black dots ø0.2 @ 0.8 CC** | variable — *avoid for courses* | 3 × 3 mm (45 × 45 m) | combine with 709 if entry forbidden |
| 413 | Orchard | A | green dots ø0.45 @ 0.8 CC on yellow 100 % or yellow 50 % | as underlying yellow | 2 × 2 mm (30 × 30 m) | dot rows may show planting direction |
| 414 | Vineyard or similar | A | green lines on yellow 100 % / 50 % | good along the rows | 2 × 2 mm (30 × 30 m) | ≥ 3 lines visible |
| 415 | Distinct cultivation boundary | L | **black**, line **0.10** | — | min length 2 mm (30 m) | *errata 2020: 0.14 → 0.10 mm* |
| 416 | Distinct vegetation boundary | L | **dark green (100/0/80/30) dashed** *or* **black dotted** — only one variant per map | — | black-dot variant: 5 dots (2.0 mm = 30 m); green-dash variant: 4 dashes (1.8 mm = 27 m) | green line cannot be used around/inside 410 |
| 417 | Prominent large tree | P | green + **white mask** | — | 0.9 mm OM ring, white mask to 1.1 mm OM, line 0.18 | footprint 13.5 × 13.5 m |
| 418 | Prominent bush or small tree | P | green filled ø0.6 with **white dot 0.2 OM** inside | — | — | footprint 9 × 9 m. White dot is a **colour-vision-deficiency aid**. Use sparingly — easily confused with 109 Small knoll. |
| 419 | Prominent vegetation feature | P | green cross + white mask (mask line 0.36, extends 0.18 beyond) | — | 0.9 × 0.9 mm OM, line 0.18 | e.g. root stock / stump; definition must be on the map |

**Permissible screen combinations (ISOM §2.11.4).** Only these pairs may be overlaid:

* **Base area symbols** that may take a modifier: 302, 308, 310, 401, 402 (white or green dots), 403, 404 (white
  or green dots), 405, 406, 408, 410.
* **Modifier screens** that may be laid on them: 113–114 Broken ground, 208 Boulder field, 209 Dense boulder field,
  210–212 Stony ground, 307 Uncrossable marsh, 308 Marsh, 310 Indistinct marsh, 407 Vegetation slow/good visibility,
  409 Vegetation walk/good visibility.
* Anything not in that matrix must **not** be combined.

### 1.5.5 Man-made features — black (ISOM §3.5)

| # | Name | Type | Colour | Exact dimensions | Min. length / area | Notes |
|---|---|---|---|---|---|---|
| 501 | Paved area | A | **brown 50 % + black outline 0.1** | — | 1 × 1 mm (15 × 15 m) | runnability > 100 % |
| 502 | Wide road | L | **black 0.14 outlines + brown 50 % infill** | drawn to scale; min total width `0.3 + 2×0.14` mm (footprint **8.7 m**) | — | road > 5 m wide. Outer lines may be replaced by 513/515/516/518 if a wall/fence hugs the edge. |
| 503 | Road | L | black | **solid 0.35** | — | maintained road < 5 m wide |
| 504 | Vehicle track | L | black | **0.35**, dash **3.0**, gap **0.25** | 2 dashes (6.25 mm = 94 m) | distinct junction → dashes joined |
| 505 | Footpath | L | black | **0.25**, dash **2.0**, gap **0.25** | 2 dashes (4.25 mm = 64 m) | "easily runnable path" |
| 506 | Small footpath | L | black | **0.18**, dash **1.0**, gap **0.25** | 2 dashes (2.25 mm = 34 m) | followable at competition speed |
| 507 | Less distinct small footpath | L | black | **0.18**, dashes **1.0 / 0.8**, gap 0.25 (double-dash groups) | 2 groups (5.3 mm = 79.5 m) | |
| 508 | Narrow ride / linear trace | L | black | **0.14**, dash **2.0**, gap 0.25, **background line 0.45** | 2 dashes (3.25 mm = 48 m) | **The background colour encodes runnability of the ride:** yellow 100 % = easy running; white-in-green = normal; green 30 % = slow; green 60 % = walk; no background = same as surroundings. *(This is the Czech* **průsek** *.)* |
| 509 | Railway | L | black + white | 0.35 CC bar pattern, line 0.1 | 2 black dashes (4 mm = 60 m) | combine with 711 if running along is forbidden; with 520/709 if crossing is forbidden |
| 510 | Power line / cableway / skilift | L, P | black | line 0.14, pylon bar 0.3 OM | 5 mm (75 m) | bars = exact pylon positions |
| 511 | Major power line | L, P | black | double line | — | very large masts → 521 or 524 |
| 512 | Bridge / tunnel | L, P | black | baseline min 0.4 mm (6 m) | — | if you cannot get through, omit it |
| 513.1 | Wall | L | black | line 0.14, dots ø0.4 @ 1.0 CC | 1.4 mm (21 m) | height ≥ 1 m — **passable** |
| 513.2 | Retaining wall | L | black | line 0.14, half-dots ø0.4 @ 1.0 CC offset 0.05 | 1.4 mm (21 m) | height ≥ 0.5 m; half-dot points to the lower level |
| 514 | Ruined wall | L | black | dashed | 2 dashes (3.65 mm = 55 m) | height ≥ 0.5 m |
| 515 | **Impassable wall** | L | black | **line 0.35**, dots ø0.6 @ 3.0 CC | 3 mm (45 m) | normally > 1.5 m high. **Barrier.** |
| 516 | Fence | L | black | line **0.14**, tags **0.4 OM** @ **2.0 CC**, 60° | 1.5 mm (22.5 m) | < 1.5 m high — **crossable**. Tags inside an enclosure. |
| 517 | Ruined fence | L | black | dashed with tags | 2 dashes (3.65 mm = 55 m) | |
| 518 | **Impassable fence** | L | black | **line 0.25**, tags **0.4 OM** @ **2.0 CC**, 60°, plus a 0.6 marker | 2 mm (30 m) | normally > 1.5 m. **Barrier.** |
| 519 | Crossing point | P | black | two 0.18 marks, gap 0.6 CC, 1.0 long | — | gate/stile. For uncrossable features the line **must** be broken at the crossing. |
| 520 | **Area that shall not be entered** | A | **yellow 100 % + green 50 % = OLIVE**, black boundary 0.18 if the border is clear | 1 × 1 mm (15 × 15 m) | Private house, garden, factory. Only contours + prominent features (railways, large buildings) shown inside. Discontinued where a path passes through (white background, 0.15 mm overlap each side). **Shall not be entered — Competition Rule 17.2.** |
| 521 | Building | A | **black outline + black fill** (buildings > 75 × 75 m: outline + **black 50 %**) | 0.5 × 0.5 mm (7.5 × 7.5 m) | passages through buildings ≥ **0.4 mm** (6 m); gap to other impassable features ≥ 0.4 mm |
| 522 | Canopy | A | **black 20 % + black outline 0.1** | isolated 0.6 × 0.6 mm (9 × 9 m); inside width ≥ 0.4 mm (6 m) | accessible & runnable area with a roof |
| 523 | Ruin | L/A | black, line 0.16–0.25 | 0.8 × 0.8 mm OM (12 × 12 m) | |
| 524 | High tower | P | black, ring ø0.8, 1.4 × 1.4 | — | footprint 21 m ø |
| 525 | Small tower | P | black, 1.0 × 1.0 OM, line 0.16 | — | footprint 15 × 15 m; elevated platform/seat |
| 526 | Cairn | P | black, 0.8 OM, line 0.16, dot ø0.14 | height ≥ 0.5 m | footprint 12 m ø |
| 527 | Fodder rack | P | black, 0.9 × 0.9 OM, line 0.16, 60° | — | footprint 13.5 × 13.5 m |
| 528 | Prominent line feature | L | black, line 0.14, tick 0.4 OM @ 2.0 CC, 45° | 1.5 mm (22.5 m) | e.g. low pipeline |
| 529 | Prominent **uncrossable** line feature | L | black, line **0.25**, tick 0.4 OM @ 2.0 CC, 45°, marker 0.6 | 2 mm (30 m) | **Barrier.** |
| 530 | Prominent man-made feature — ring | P | black ring 0.8 OM, line 0.16 | — | footprint 12 m ø; definition on map |
| 531 | Prominent man-made feature — × | P | black cross 0.8 × 0.8, line 0.16 | — | footprint 12 × 12 m |
| 532 | Stairway | L | black, lines 0.1, min inside width 0.4 (IM) | ≥ 3 graphical steps | easily runnable / indistinct stairway → draw as a footpath instead |

### 1.5.6 Technical symbols (ISOM §3.6)

| # | Name | Colour | Spec |
|---|---|---|---|
| 601 | Magnetic north line | black **0.1** or blue **0.12** | spacing **20 mm** = 300 m @ 1:15 000; may be broken for legibility |
| 602 | Registration mark | all printing colours | ≥ 3 in the corners, 4 mm |
| 603 | Spot height | black, dot ø0.3 | font sans-serif **1.5 mm**, non-bold, non-italic; water levels shown without the dot |

## 1.6 Minimum graphical dimensions (ISOM §2.11) — the legibility budget

These apply **at 1:15 000** and scale by ×1.5 for a 1:10 000 enlargement.

| Rule | Value |
|---|---|
| General minimum **gap** between symbols (outline to outline) | **0.15 mm** |
| Gap between symbols representing **impassable/uncrossable** features (a *passage*) | **0.40 mm** — exceptions: 201 Impassable cliff and 206 Gigantic boulder use 0.25 / 0.15 mm |
| Opening in an impassable line symbol (fence/wall) | ≥ **0.40 mm** |
| Opening in any other line feature | ≥ **0.25 mm** |
| Min. **width** of a 100 % green area | **0.25 mm** (footprint 3.75 m) |
| Min. **width** of a 100 % yellow area | **0.30 mm** (footprint 4.5 m) |
| Min. **width** of a colour screen area | **0.40 mm** (footprint 6 m) |
| Min. area enclosed by a dotted line | **ø 1.5 mm with 5 dots** |
| Shortest dashed line | **2 dashes**; dashes never shorter than 0.8 × the specified length |
| Shortest dotted line | **2 dots**; gaps never shorter than 0.8 × specified |
| Styled line | end length = **half** the distance between style symbols |
| Contour example | for Cliff (202) min map length 0.6 mm @1:15 000 → **0.9 mm @1:10 000** |

Permitted overlaps (exceptions to the 0.15 mm gap): joins/crossings of network symbols (earth walls, watercourses,
roads/tracks/paths, power lines, walls, fences); contours × earth walls/erosion gullies; wall × footpath;
major power line × fence; contours × earth bank; **contours and cliffs should at least partly overlap**;
watercourses × contours; fences × watercourses. Cliffs may overlap knolls.

---
---

# 2. ISSprOM 2019-2 — Sprint maps (1:4 000 / 1:3 000)

## 2.1 The one-sentence difference

> ISSprOM §1: *"The most important difference between ISOM 2017-2 and this specification is that **thick black
> lines are only used for uncrossable features**."*

In the forest, black line width encodes *what kind of thing it is* (road vs track vs path). In sprint, black line
width encodes **passability**, and nothing else. This is the single mechanic to implement.

## 2.2 The black-line-width ladder (ISSprOM §2.2)

| Line weight | Meaning | Symbols |
|---|---|---|
| **Thick black (0.25–0.35 mm)** | **Uncrossable — must not be crossed** | 201 Uncrossable cliff (0.50 top line), 515 Uncrossable wall (0.4 + 0.9), 518 Uncrossable fence/railing (0.4 + 0.9), 529 Prominent uncrossable line feature (0.4 + 0.9), 521 Building (0.14 outline + black 50 % fill — solid = uncrossable) |
| **Medium black (~0.14–0.21 mm)** | **Crossable obstacle** — costs time to cross | 202 Passable rock face (0.30 top line), 513.1 Passable wall (0.21), 513.2 Passable retaining wall (0.21), 516 Passable fence or railing (0.14 + tags), 528 Prominent line feature (0.14) |
| **Very thin black (0.10 mm)** | **Crossed at full speed** — navigational information only | 501.1 Step or edge of paved area, 501.2 Step or edge of paved area at lower level, 522 Canopy outline |

**Game rule:** in sprint, `passable(feature) ∈ {full-speed, cost-to-cross, FORBIDDEN}` is a **ternary** decision read
directly off line weight — and the FORBIDDEN branch is legally enforced (§2.6).

## 2.3 Scale, contour interval, format

| Property | Value | Source |
|---|---|---|
| Map scale | **1:4 000** (mandatory). **1:3 000** only as an approved enlargement, and recommended for youngest/oldest classes | ISSprOM §3.1; IOF Rules 15.2, 15.10 |
| Enlargement 1:4 000 → 1:3 000 | ×**133 %**, including course-planning symbols | ISSprOM §3.1, §4.7 |
| Contour interval | **2 m or 2.5 m**. 5 m only in special steep areas | ISSprOM §3.2 |
| Contour line width | **0.21 mm** (index 0.30 mm) — thicker than ISOM's 0.14, deliberately, so that "brownness" matches ISOM at the different scale | ISSprOM 101, 102, §3.2 |
| Magnetic north spacing | **30 mm = 120 m** on the ground | ISSprOM 601 |
| Symbol dimension tolerance | ±5 % max, "no deviations… are permitted" | ISSprOM §3.3 |
| Paper format | ≤ DIN A3 | ISSprOM §3.4 |
| Max running levels | **2**, with **one** mapped in detail | ISSprOM §2.3 |
| Colour spec | same document as ISOM: *IOF Map Specifications — Printing and Colour Definitions* | ISSprOM §3.5 |

## 2.4 Symbols that are DIFFERENT or NEW versus ISOM

### 2.4.1 Roads and paths — the biggest structural change

**ISSprOM has no 502, 503 or 504.** At 1:4 000 a road is wide enough to draw in plan, so **all hard-surfaced
traffic surfaces are drawn as `501 Paved area`, true to shape**, bounded by the hairline `501.1 Step or edge of
paved area` (0.10 mm).

| # | Name | Colour | Encodes |
|---|---|---|---|
| 501 | Paved area | **brown 30 %** (light vehicle/pedestrian traffic) or **brown 50 %** (heavy traffic) + black 0.1 border; min inside width 0.35 mm (1.4 m) | Brown *shade* now encodes traffic density, not runnability |
| 501.1 | Step or edge of paved area | black **0.10** | edge; crossable at full speed |
| 501.2 | Step or edge of paved area at lower level | black 0.10, with a 0.15 mm cartographic gap at both ends | only in two-level areas |
| 501.3 | Paved area with scattered trees | brown 30 % (50 %) with **ø 0.6 white holes at 0.75 CC, 45°**; min width 2.2 mm, min area 6.25 mm² (100 m²) | |
| 505 | Unpaved footpath or track | black 0.27/0.37 outline + **brown 30 %** infill; min inside width 0.35 mm | drawn as a narrow area |
| 506 | Small unpaved footpath or track | black dashed 0.27, dash 1.5 | 2 dashes (3.4 mm = 13.6 m) |
| 507 | Less distinct small path | black 0.21, double-dash 1.5/1.5 | 2 groups (7.9 mm = 31.6 m) |
| 508 | Narrow ride | black dashed 0.21, dash 4.5, gap 0.75 | 2 dashes (9.75 mm = 39 m) |
| 509.1 | Railway | black + white, 0.35 CC | 2 black dashes (4 mm = 16 m) |
| 509.2 | **Tramway** | black **0.08** | new in ISSprOM; only if it aids navigation |

### 2.4.2 Walls, fences, barriers — the passability pairs

| # | Name | Line spec (mm @1:4 000) | Min length | Legal status |
|---|---|---|---|---|
| 513.1 | **Passable wall** | **0.21**, dots ø0.6 @ 3.75 CC | 1.4 mm (5.6 m) | crossable (≤ 1.5 m high) |
| 513.2 | Passable retaining wall | **0.21**, half-dots ø0.6 @ 1.9 CC, offset 0.09 | 1.4 mm (5.6 m) | 0.6–1.5 m; below that use 501.1 |
| **515** | **Uncrossable wall** | **0.9 thick** (with 0.4 detail) | **1 mm (4 m)** | **FORBIDDEN (Rule 17.2)** |
| 516 | **Passable fence or railing** | **0.14** line, tags **0.75** long @ **3.75 CC**, 60° | 2.2 mm (8.8 m) | crossable |
| **518** | **Uncrossable fence or railing** | **0.14** line **+ 0.4 thick base**, tags 0.75 @ 3.75 CC, 60°, extra 0.9 | **3 mm (12 m)**; if shorter than 3 mm you must draw 515 instead | **FORBIDDEN (Rule 17.2)** |
| 519 | Crossing point (optional) | black, 1.0 (IM), 1.4 long, 0.25 | — | a gap you may pass through |
| **529** | Prominent uncrossable line feature | 0.14 + 0.4/0.9, ticks @ 3.75 CC, 45° | 3 mm (12 m) | **FORBIDDEN** |
| 528 | Prominent line feature | 0.14 + ticks 0.75 @ 3.75 CC, 45° | 2.2 mm (8.8 m) | passable |

> **ISSprOM has no 514 (ruined wall) and no 517 (ruined fence)** — a ruin is either crossable or it isn't.
> It also has **no 523 (Ruin)**.

### 2.4.3 Vegetation — including the sprint-only "uncrossable vegetation"

| # | Name | Colour | Runnability | Notes vs ISOM |
|---|---|---|---|---|
| 401 | Open land | yellow 100 % (75 %) | very good | min area **0.5 mm² (8 m²)** |
| 402 | Open land with scattered trees | yellow with ø0.6 white/green-60 % holes @ 0.75 CC, 45° | very good | min width 2.2 mm, area 6.25 mm² (100 m²) |
| 403 | Rough open land | yellow 50 % | normal | min area 1 mm² (16 m²) |
| 404 | Rough open land with scattered trees | yellow 50 % with ø0.7 holes @ 1.0 CC | normal | min width 2.5 mm |
| 405 | Forest | **white** | 100 % baseline | |
| 406 | Vegetation: slow running | **green 30 %** | **60–80 %** | ≥ 2 white stripes if directional |
| 407 | Vegetation: slow running, good visibility | green 100 %, lines 0.12 @ 0.84 CC | 60–80 % | **must not** be combined with 406 or 408 |
| 408 | Vegetation: walk | **green 60 %** | **20–60 %** | min area 0.5 mm² (8 m²) |
| 409 | Vegetation: walk, good visibility | green 100 %, lines 0.14 @ 0.42 CC | 20–60 % | must not be combined with 406/408 |
| 410 | Vegetation: fight | **green 100 %** | **< 20 %** | min area 0.3 mm² (5 m²), width 0.25 mm |
| **411** | **Uncrossable vegetation** | **dark green 100/0/80/30** | **impassable** | *"an area of vegetation (for example a hedge) that shall not be crossed or passed through since there may be a danger that private property or the vegetation itself is damaged."* min area 0.3 mm² (5 m²), width 0.4 mm. **FORBIDDEN (Rule 17.2).** |

### 2.4.4 Buildings, canopy, steps/stairs, multi-level

| # | Name | Colour / spec | Behaviour |
|---|---|---|---|
| **521** | **Building** | black **0.14 outline + black 50 % fill**; min width 0.5 mm; min area 0.25 mm² (4 m²); **minimum gap to any other uncrossable feature 0.40 mm**; boundaries between touching buildings are not drawn | **A building in sprint is absolutely out of bounds — Rule 17.2 lists ISSprOM 521 by name.** You may not enter or cross it. Areas fully inside a building are mapped as part of the building. |
| **522** | **Canopy** | black **0.1 outline + black 20 % fill**; min width 0.5 mm; min area 0.25 mm² (4 m²) | **Accessible and runnable roofed area** — you run *under* it. This is the key sprint feature that looks like a building but isn't. |
| 522.1 | **Pillar** | solid black, min 0.5 × 0.5 mm | new; pillars < 1 m × 1 m are not mapped. Control-description 5.11 "Building" was extended in 2024 to cover "a pillar supporting a roof". |
| **532** | **Stairway** | black, lines 0.1, min inside width 0.4 (IM), **min 3 graphical steps** | steps generalised; runnable |
| 512.1 | Bridge or tunnel entrance | black triangles 0.7 × 0.7 × 0.7, 0.15 mm cartographic gap; min 2 triangles standalone | **You may only pass UNDER this feature (Rule 17.2)** |
| 512.2 | Underpass or tunnel | black dashed 0.2/0.25, 0.2 gaps at both ends | min 2 dashes (0.7 mm = 2.8 m) |
| **512.3** | **Area runnable at lower level** | **white 45° stripes** overlaid on the upper-level area symbol | The two-level mechanic: the *upper* surface is drawn normally; white diagonal stripes mark where a *lower* running level also exists. Long combination table in ISSprOM 512.3 defines the substitute symbol used inside the striped zone (e.g. 403 → 401, 406 → 408, 709 → 100 % upper purple). |
| 533 | **Area with obstacles** | **black 50 %** dot screen (ø0.55 @ 0.75 CC, 45°); min area 65 m² | new in Rev 6. Bike racks, bollards, café furniture. *"The area cannot be crossed at full speed."* |
| **520** | **Area that shall not be entered** | **yellow 100 % + green 50 % = OLIVE**; **always** delineated by a boundary line ≥ 0.1 mm; min width 0.25 mm (1 m); min area 0.25 mm² (4 m²) | See §2.6. In ISSprOM this is much stricter than in ISOM: *"Paths and roads which are not allowed to run shall not be mapped."* |

### 2.4.5 Symbols dropped in sprint versus ISOM

`106` ruined earth wall · `114` very broken ground · `209` dense boulder field · `211`/`212` stony ground walk/fight
(sprint has only one `210 Stony ground`) · `215` trench · `304` crossable watercourse (only `305`) · `502`/`503`/`504`
roads & vehicle tracks · `514` ruined wall · `517` ruined fence · `523` ruin · `602` registration mark · `603` spot height.

## 2.5 ISSprOM minimum dimensions (§3.3)

| Rule | Value @1:4 000 (footprint) |
|---|---|
| Passage between uncrossable features | **0.40 mm** (1.6 m) |
| Gap between two line symbols of the same colour | 0.15 mm |
| Gap between line and area symbols of the same colour | 0.15 mm |
| **Opening of fences, hedges and walls** | **1.0 mm** (4 m) |
| Shortest dotted line | 2 dots |
| Shortest dashed line | 2 dashes |
| Smallest area enclosed by a dotted line | ø 1.5 mm with 5 dots |
| Smallest area of blue/green/yellow full colour | **0.5 mm²** (8 m²) |
| Smallest area of a black dot screen | 0.5 mm² |
| Smallest area of a blue/brown/green/yellow dot screen | 1.0 mm² (16 m²) |
| Min. width of a 100 % green area | 0.25 mm (1 m) |
| Min. width of a 100 % yellow area | 0.30 mm (1.2 m) |
| Min. width of a colour screen | 0.40 mm (1.6 m) |

## 2.6 The olive rule and the legal (DSQ) list — IOF Competition Rule 17.2

This is the part that is **not cartographic advice but law**. Rule 17.2 (Competition Rules 2025):

> *"Out-of-bounds or dangerous areas, forbidden routes, line features that must not be crossed, etc. must be marked
> on the map. Where they are not obvious to the competitor, they must also be marked on the ground. **Competitors
> must not enter, follow or cross areas, routes or features drawn with the following symbols**"*

**Forest (ISOM):**

| Symbol | Name |
|---|---|
| ISOM 520 | Area that shall not be entered (**olive**) |
| ISOM 708 | Out-of-bounds boundary |
| ISOM 709 | Out-of-bounds area |
| ISOM 711 | Out-of-bounds route (*crossing directly over is allowed; following it is not*) |

**Sprint (ISSprOM) — 13 symbols:**

| Symbol | Name | Note |
|---|---|---|
| ISSprOM 201 | Uncrossable cliff | |
| ISSprOM 301 | Uncrossable body of water | |
| ISSprOM 307 | Uncrossable marsh | |
| **ISSprOM 411** | **Uncrossable vegetation** | dark green — hedges, flowerbed shrubs |
| ISSprOM 512.1 | Bridge or tunnel entrance | *competitors may only pass **under** this feature* |
| **ISSprOM 515** | **Uncrossable wall** | |
| **ISSprOM 518** | **Uncrossable fence or railing** | |
| **ISSprOM 520** | **Area that shall not be entered** (**olive**) | |
| **ISSprOM 521** | **Building** | *every building is out of bounds* |
| ISSprOM 529 | Prominent uncrossable line feature | |
| ISSprOM 708 | Out-of-bounds boundary | |
| ISSprOM 709 | Out-of-bounds area | |
| ISSprOM 714 | Temporary construction or closed area | |

**Consequences for the game engine.**

1. Olive (`#B5A722`, CMYK 38/27/100/0) is a **hard collision volume**. Touching it = **disqualification**, not a
   time penalty. There is no "cost" to entering olive; it is a binary fail state.
2. The same applies to any of the 13 sprint symbols. Sprint is therefore a **route-choice-under-constraint** puzzle
   played on a graph whose edges are cut by uncrossable line features, not a cost-surface problem.
3. In the forest, by contrast, `201 Impassable cliff`, `301 Uncrossable water`, `307 Uncrossable marsh`, `515`, `518`
   and `410 fight` are **not forbidden** — they are merely mapped as being beyond the average elite orienteer.
   ISOM §2.4 states this explicitly: *"a feature that is mapped using a barrier symbol could turn out to be passable
   / crossable, but to what extent it is possible to pass / cross cannot be determined by inspecting the map."*
   Model these as a very high but finite traversal cost plus an injury/risk term. Only ISOM 520/708/709/711 are DSQ.
4. Rule 17.3: *"Compulsory routes, crossing points and passages must be marked clearly on the map and on the ground.
   Competitors must follow the **entire length** of any marked section of their course."*

---
---

# 3. IOF Control Descriptions

**Current version: "International Specification for Control Descriptions — 2024"** (IOF Rules Commission:
David Rosen chair, Barry McCrae, Felix Büchi; editor Barry Elkington; artwork based on the 1990 edition with
additional drawings by Matthew Cook 2004/2018).
Source PDF: https://baoc.org/wiki/images/d/da/IOF_Control_Descriptions_2024.pdf
Landing page: https://orienteering.sport/iof/rules/control-descriptions/

## 3.0 What changed from the 2018 version (verbatim list from the 2024 PDF)

1. Now covers **both ISOM and ISSprOM**.
2. Description sheet **should be printed in black**.
3. If the clarification symbol in column C is not sufficient to unambiguously define the placement of the control
   flag, **then the feature is not suitable for a control site**.
4. Use of **Copse** symbol extended to include a more runnable area of trees surrounded by thicker forest.
5. Use of **Building** symbol extended to include **a pillar supporting a roof**.
6. **New symbol** added for a **Railway or tramway** (5.24).
7. Use of **Top** and **Beneath** symbols extended to include the **Upper / Lower of two levels**.
8. **New symbol** added for a **map flip** (15.6).

If you need to be 2018-compatible, drop 5.24 and 15.6 and reinstate the old wording; the rest of the table is
unchanged in numbering.

## 3.1 Sheet format (implement this exactly)

| Property | Value |
|---|---|
| Boxes | **square, side between 5 mm and 7 mm** |
| Print colour | **black** |
| Column order | A B C D E F G H (left to right) |
| Rule line | a **thicker horizontal line after every third description**, and on **both sides of any special instruction** |
| Heading block | Event title; Classes (optional); **Course code · Course length in km to 0.1 km measured from the point at which timing starts · Height climb in m to the nearest 5 m** |
| Start line | first row; described **as if the start were a control feature**. Codes `S1`, `S2` … may be used in column B |
| Optional line above start | distance from the timed start to the start triangle (symbol 14.1), if they are not within a few metres |
| Last line | nature of the route from the last control to the finish (symbols 16.1 / 16.2 / 16.3) |
| Where it lives | *"must be fixed to or printed on the **front side** of the competition map"* (Rule 18.3). For interval starts, separate loose descriptions must be available at the pre-start / in the start lanes and **not before** (Rule 18.4). |

### Column meanings

| Col | Name | Content |
|---|---|---|
| **A** | Control number | Sequence order. For a Score competition, left blank or the control's point value. |
| **B** | Control code | **Must be a number greater than 30** (Rule 19.6: "Numbers less than 31 must not be used"). |
| **C** | Which of any similar feature | Only when more than one similar feature lies inside the circle; e.g. *south eastern*. |
| **D** | **The control feature** | The feature **as shown on the map, at the centre of the circle**. **Exactly one symbol** — never two. |
| **E** | Appearance | Further nature of the feature (*overgrown*, *ruined*), **or the second feature** for crossing / junction / between. |
| **F** | Dimensions / Combinations / Bend | Dimensions when the map symbol is symbolic rather than to scale; the two combination symbols; the bend symbol. |
| **G** | Location of the control flag | Position relative to the feature. **No symbol** is used when the flag is at (or as near as possible to) the **centre** of the feature — or the **centre of the foot** in the case of a cliff. |
| **H** | Other information | First aid, refreshments, manned control. |

---

## 3.2 SVG drawing model

The pictograms in the IOF PDF are embedded as **raster images**, so no official vector source can be extracted
from it. The descriptions below are geometric reconstructions accurate enough to redraw. Recommended conventions:

* **viewBox `0 0 100 100`**, one symbol per box, drawn inside the central ~**64 × 64** area (margin ≈ 18 units).
* **`stroke-width` ≈ 7–8** units, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"` unless the
  description says *filled*.
* Colour: pure black `#000000` on white.
* **Direction-bearing symbols** (0.1, 0.2, 12.1–12.7, 12.12, and the tree symbols) are drawn once and **rotated in
  45° steps** to encode the eight compass directions. N = 0°, NE = 45°, E = 90°, SE = 135°, S = 180°, SW = 225°,
  W = 270°, NW = 315°. Implement one base path + a `transform="rotate(θ 50 50)"`.
* Existing open-source vector implementations you can cross-check against: **Purple Pen** (course-setting software,
  draws every description symbol programmatically), OCAD's `Course_Design` symbol sets, and OpenOrienteering
  Mapper's `symbol sets/…/Course_Design_15000.omap`.

---

## 3.3 Column C — Which of any similar feature (5 symbols)

| Ref | Name | Geometry |
|---|---|---|
| **0.1** | Northern | A **straight vertical line with an arrowhead at the top**. Shaft from (50,82) to (50,22); open V arrowhead of ~20 units span at the tip. **Rotate by 45° steps** to give NE, E, SE, S, SW, W, NW. |
| **0.2** | South Eastern | The same arrow rotated 135° (pointing down-right). *(0.1 and 0.2 are one symbol, illustrated in two orientations.)* |
| **0.3** | Upper | **Two short horizontal bars stacked** (y ≈ 38 and y ≈ 62, each ~40 units wide, centred). A **filled dot** (r ≈ 6) sits on the **upper** bar's centre. |
| **0.4** | Lower | Mirror of 0.3 — the filled dot sits on the **lower** bar. |
| **0.5** | Middle | **Three short vertical bars** side by side (x ≈ 32, 50, 68; y from 25 to 75). A **filled dot** (r ≈ 6) sits on the **middle** bar's centre. |

---

## 3.4 Column D — The control feature (the full ~72-symbol table)

Column "ISOM/ISSprOM" is the cross-reference given in the spec; *"where a number is given it includes all symbols
beginning with that number (e.g. 509 indicates 509.1 & 509.2)"*.

### 3.4.1 Landforms (ISOM/ISSprOM §3.1) — 16 symbols

| Ref | Name | ISOM/ISSprOM | Meaning | **Geometry for SVG** |
|---|---|---|---|---|
| 1.1 | **Terrace** | 101,102,103 | A level area on a slope | Two strokes forming a **contour step in profile**: a short, slightly-curved **vertical stroke on the left** (the slope above), and to its right an open **"Ɔ"** — a stroke that starts upper-left, runs right, turns down, and returns left at the bottom, i.e. a broad rounded bulge **open to the left**. The bulge is the shelf. |
| 1.2 | **Spur** | 101,102,103 | A contour projection or "nose" | Same left vertical stroke, but the right shape is a **narrower, longer projection**: the stroke runs right, turns sharply down and returns left **past** the start, then drops — giving a nose pointing right with the contour wrapping it. |
| 1.3 | **Re-entrant** | 101,102,103 | Contour indentation, a valley — the opposite of a spur | A single **arch: an inverted-U (∩)** with vertical legs at (32,85)→(32,50) and (68,85)→(68,50), joined by a semicircular cap. |
| 1.4 | **Earth bank** | 104 | Abrupt change in ground level | A shallow **arc convex upward** spanning x 22→78, with **four short tags hanging down** from it, evenly spread, angled slightly (the classic "eyelash"). |
| 1.5 | **Quarry** | 104 | Gravel/sand/stone working | A large **horseshoe arc**, open at the bottom (∩ with splayed feet), with **four short tags pointing inward** toward the centre. |
| 1.6 | **Earth wall** | 105,106 | Narrow wall of earth projecting above the terrain | A **horizontal bar** crossed by **four short vertical ticks** (a stubby ladder / "▮╫▮"). |
| 1.7 | **Erosion gully** | 107 | Normally-dry gully | A large **inverted V (∧)** — two straight strokes meeting at an apex near (50,25), feet at (32,80) and (68,80). |
| 1.8 | **Small erosion gully** | 108 | Small dry gully | **Two parallel diagonal strokes** running lower-left → upper-right, with **four dots in a row between them**, on the same diagonal. |
| 1.9 | **Hill** | 101,102,103 | A high point | A plain **ellipse outline**, wider than tall (rx ≈ 32, ry ≈ 20, centre 50,50). |
| 1.10 | **Knoll** | 109,110 | A small obvious mound | A **filled black circle**, r ≈ 14. |
| 1.11 | **Saddle** | 101,102,103 | Low point between two higher points | **Two facing arcs**: `)` on the left and `(` on the right — i.e. two vertical arcs bulging **away** from each other, leaving a waist in the middle. |
| 1.12 | **Depression** | 101,102,103 | Ground rises on all sides | The **Hill ellipse plus a short horizontal slope-tick** entering from the left through the outline into the middle (`⊖` with the bar only on the left half). |
| 1.13 | **Small depression** | 111 | Small shallow natural hollow | A **U** — a semicircle open at the top, legs at (30,30) and (70,30), bowl bottom at y ≈ 78. |
| 1.14 | **Pit** | 112, 203 | Steep-sided pit or hole, usually man-made | A **V** — two straight strokes meeting at (50,80), tops at (28,28) and (72,28). *(With 8.6 Rocky = "rocky pit", ISOM 203.)* |
| 1.15 | **Broken ground** | 113,114 | Too small / too numerous to map individually | **Three small "u" arcs** (semicircles open upward), scattered — two on an upper row, one below and between them. |
| 1.16 | **Ant hill (termite mound)** | 115 | Ant/termite mound | An **eight-pointed asterisk** — four straight strokes through the centre at 0°, 45°, 90°, 135°. |

### 3.4.2 Rock and boulders (§3.2) — 10 symbols

| Ref | Name | ISOM/ISSprOM | **Geometry** |
|---|---|---|---|
| 2.1 | **Cliff, Crag** | 201, 202 | A **thick horizontal bar** with **three short thick tags hanging down** from it (a stubby comb, "**⌷⌷⌷**"). Passable or impassable — the description does not distinguish. |
| 2.2 | **Rock Pillar** | 206 | A **tall narrow solid black triangle**, apex up. |
| 2.3 | **Cave** | 203 | A stylised opening: a **long stroke from lower-left to upper-right crossed by a short "<" chevron** — reads as an arrow entering a mouth. |
| 2.4 | **Boulder** | 204, 205 | A **solid black equilateral triangle, apex up**, side ≈ 44. *(This is the canonical "boulder = filled triangle".)* |
| 2.5 | **Boulder field** | 208, 209 | **Four solid black triangles** in a 2 × 2 arrangement (upper-left, upper-right, lower-left, lower-right), each ~half the size of 2.4, with visible gaps. |
| 2.6 | **Boulder cluster** | 207 | **Two solid black triangles overlapping / touching**, side by side, forming a twin-peak silhouette. |
| 2.7 | **Stony ground** | 210, 211, 212 | A **regular grid of small filled dots**, ~5 columns × 5 rows, evenly spaced. |
| 2.8 | **Bare rock** | 214 | An **eight-pointed star of short strokes radiating from a gap at the centre** — like a sunburst with a small hollow core (distinct from 1.16, whose strokes pass through the centre). |
| 2.9 | **Narrow passage** | 201, 202 | Two mirrored bracket glyphs facing each other: **`]` on the left and `[` on the right**, each a vertical bar with short horizontal serifs turned inward — a gap between two cliffs. |
| 2.10 | **Trench** | 215 | A **squared U** — vertical stroke down, horizontal stroke across the bottom, vertical stroke up (like `⌴`), with the left leg drawn taller. |

### 3.4.3 Water and marsh (§3.3) — 11 symbols

| Ref | Name | ISOM/ISSprOM | **Geometry** |
|---|---|---|---|
| 3.1 | **Lake** | 301 | A **closed rounded outline (a lake shape)** with a **wave (S-curve / ~) inside it**. |
| 3.2 | **Pond** | 301, 302 | A **U (bowl)** with **a row of ~3 wave crests (∿∿∿) across its open top**. |
| 3.3 | **Waterhole** | 303 | A **V** with the same **row of wave crests across its top**. *(= "Pit" 1.14 + water.)* |
| 3.4 | **River, Stream, Watercourse** | 301, 304, 305 | A **long wavy line (a stretched sine, 3–4 crests)** running lower-left → upper-right. |
| 3.5 | **Minor water channel, Ditch** | 306 | The wavy line of 3.4 **drawn between two parallel diagonal boundary strokes** (i.e. a narrow channel containing a wiggle). |
| 3.6 | **Narrow marsh** | 309 | **A diagonal line of ~4 dots**, lower-left → upper-right. |
| 3.7 | **Marsh** | 307, 308, 310 | **Three or four stacked horizontal bars of decreasing width**, centred — a small pyramid of lines (widest at the bottom in the drawn form). |
| 3.8 | **Firm ground in marsh** | 307, 308, 310 | Same stacked horizontal bars, but **broken in the centre** to leave an island of white — a bar, then a short bar + short bar with a gap, then a bar. |
| 3.9 | **Well** | 311 | A **ring (circle outline)** with a **small wave (∿) below it**. |
| 3.10 | **Spring** | 312 | A **hook/curl at the top** (a small "Ɔ") continuing into a **wavy line flowing down-right**. |
| 3.11 | **Water tank, Water trough** | 311 | A **rectangle open at the top** (a squared U) with a **row of wave crests above its rim**. |

### 3.4.4 Vegetation (§3.4) — 10 symbols

| Ref | Name | ISOM/ISSprOM | **Geometry** |
|---|---|---|---|
| 4.1 | **Open land** | 213, 401, 403, 412, 413, 414 | A **plain diamond outline** — a square rotated 45°, vertices at (50,20)(80,50)(50,80)(20,50). *(+ 8.8 Sandy → open sandy ground, ISOM 213.)* |
| 4.2 | **Semi-open land** | 402, 404 | **The same diamond, drawn in dots** — ~12 evenly-spaced filled dots on the diamond's outline instead of a stroke. |
| 4.3 | **Forest corner** | 405,406,408,410 | A **thick outlined arrowhead / pentagon pointing down-left** — a broad chevron shape with a squared back (a "flag" pointing into open land). |
| 4.4 | **Clearing** | 401, 403 | **A circle drawn in dots** — ~12 evenly-spaced filled dots on a circle of r ≈ 28. |
| 4.5 | **Thicket** | 406,408,410,411,418 | A **dense diagonal lattice**: 4 strokes at +45° crossed by 4 strokes at −45°, clipped so the whole figure reads as a **filled diamond of X's**. |
| 4.6 | **Linear thicket** | 410, 411 | A **diagonal line (lower-left → upper-right) with three small open rings (unfilled circles) threaded on it**. Also used for a hedge. |
| 4.7 | **Vegetation boundary** | 415, 416 | A **dotted line with a bend** — ~7 dots forming a shallow chevron. |
| 4.8 | **Copse** | 405,406,408,410 | **Two small conifer glyphs side by side** (each a narrow triangular crown over a short trunk), touching. |
| 4.9 | **Prominent tree** | 417, 418 | A **single conifer glyph**: a tall narrow triangle outline with a **vertical trunk descending below it** and one horizontal branch bar. |
| 4.10 | **Prominent vegetation feature** (root stock, tree stump) | 419 | A **circle outline with a full X (saltire) inside it**, the X's arms reaching the circumference. |

### 3.4.5 Man-made features (§3.5) — 24 symbols

| Ref | Name | ISOM/ISSprOM | **Geometry** |
|---|---|---|---|
| 5.1 | **Road** | 502–503 | A **single thick solid diagonal line**, lower-left → upper-right, full width of the box. |
| 5.2 | **Track / Path** | 504–507 | The same diagonal, **dashed** — two long dashes with one gap. |
| 5.3 | **Ride** | 508; 401 or 403 /416 | A **diagonal band of dots**: two parallel diagonal rows of ~4 dots each. |
| 5.4 | **Bridge** | 512 | A **diagonal line crossed by two short parallel strokes** near its middle (the deck). |
| 5.5 | **Power line** | 510, 511 | A **diagonal line carrying two saltire crosses (✗ ✗)** along it. |
| 5.6 | **Pylon** | 510, 511, 524 | The power line with **one cross replaced by a ringed cross** — a circle with an X inside, on the line. |
| 5.7 | **Tunnel** | 512 | **Two parallel horizontal bars with a bow-tie/X shape between them** — the passage seen end-on, going under. |
| 5.8 | **Wall** | 513, 515 (514 with 8.11) | A **diagonal line with three small filled dots** strung along it. *(Contrast 4.6 Linear thicket, which uses open rings.)* |
| 5.9 | **Fence** | 516, 518 (517 with 8.11) | A **diagonal line with two short tags projecting upward at ~60°** — the ISOM fence symbol in miniature. |
| 5.10 | **Crossing point** | 519 | A **vertical bar crossed by two collinear horizontal bars that stop short of it**, leaving a gap where the vertical passes — "`⊣|⊢`". |
| 5.11 | **Building** | 521, 522.1 | A **solid filled black square**, side ≈ 40. *(Since 2024 also used for "a pillar supporting a roof".)* |
| 5.12 | **Paved area** | 501 | A **square outline filled with parallel diagonal hatching** (3–4 hatch lines at 45°). |
| 5.13 | **Ruin** | 523 | A **square drawn only at its four corners** — four short L-brackets, no continuous sides. |
| 5.14 | **Prominent man-made line feature** (pipeline, bobsleigh/skeleton track) | 528, 529 | A **diagonal arrow pointing up-right with two short cross-ticks on its shaft**. |
| 5.15 | **Tower / Pylon** | 524, 525 | A **T** — a horizontal bar over a central vertical stem. |
| 5.16 | **Shooting platform** | 525 | An **Γ** — a vertical stem with a horizontal arm at the top extending to the right. |
| 5.17 | **Boundary stone, Cairn** | 526 | A **circle outline with a filled dot at its centre** (a "target"). |
| 5.18 | **Fodder rack** | 527 | A **vertical up-arrow standing on a horizontal base bar** ("⊥" with an arrowhead at the top). |
| 5.19 | **Charcoal burning ground / Platform** | 530, 115 | A **circle outline containing a triangle** (apex up), the triangle inscribed. |
| 5.20 | **Monument or Statue** | 530, 531 | A **triangle outline with a horizontal crossbar low down** — reads like an "A". |
| 5.21 | **Canopy** | 522 | A **horizontal roof bar carried on two or three short vertical legs** ("ΠΠ"). |
| 5.22 | **Stairway** | 532 | A **staircase profile**: two or three ascending steps drawn as one continuous stroke rising to the right. |
| 5.23 | **Out of Bounds area** | 520 | A **rounded square outline containing a small rosette / flower** (typically a flower bed). |
| 5.24 | **Railway** *(new 2024)* | 509 | A **diagonal ladder**: two parallel diagonal rails with 4–5 short cross-ties (sleepers). Covers railway, tramway or other railed track. |

### 3.4.6 Prominent features / Special items — 2 symbols

| Ref | Name | ISOM/ISSprOM | **Geometry** | Note |
|---|---|---|---|---|
| 6.1 | Prominent feature / Special item | 115, 313, 419, 531 | A **large bold X (saltire)**, no circle. | Meaning **must** be supplied to competitors in the pre-race information. |
| 6.2 | Prominent feature / Special item | 530 | A **large plain circle outline** (thick stroke, no fill, nothing inside). | Same requirement. |

### 3.4.7 Country-specific features — 7.n

Reserved for national symbols. *"It is not generally recommended to introduce local symbols."* If used at an event
likely to attract an international entry, the meaning **must** be supplied in the pre-race details. Number them
`7.1`, `7.2`, …

---

## 3.5 Column E — Appearance (11 symbols)

| Ref | Name | **Geometry** | Example |
|---|---|---|---|
| 8.1 | **Low** | A **very shallow arc, convex upward** (a flat "⌒"). | Hill, low |
| 8.2 | **Shallow** | A **very shallow arc, concave upward** (a flat "⌣"). | Re-entrant, shallow |
| 8.3 | **Deep** | A **tall narrow U** — deep bowl with near-vertical sides. | Pit, deep |
| 8.4 | **Overgrown** | A **small square mesh**: 4 horizontal × 4 vertical lines crossing to form a grid. | Ruin, overgrown |
| 8.5 | **Open** | **Two rows of 3–4 loosely-spaced dots** (a sparse dot field). | Marsh, open |
| 8.6 | **Rocky, Stony** | **Three small solid black triangles** — two on top, one below and centred. | Knoll, rocky; with 1.14 Pit → **rocky pit (ISOM 203)** |
| 8.7 | **Marshy** | **Three equal-length horizontal bars stacked** ("≡"). | Re-entrant, marshy |
| 8.8 | **Sandy** | A **dense stipple of small dots** filling a rounded blob. | Depression, sandy; with 4.1 Open land → **sandy ground (ISOM 213)** |
| 8.9 | **Needle leaved** | A **conifer**: a narrow triangular crown with a vertical trunk through it and one horizontal branch bar. | Prominent tree, needle leaved |
| 8.10 | **Broad leaved** | A **deciduous canopy**: three rounded lobes (a clover / trefoil) over a short trunk. | Copse, broad leaved |
| 8.11 | **Ruined** | A **right-angled line whose free limb curves over and down** — a "falling-over" glyph. | Fence, ruined; Wall, ruined |

---

## 3.6 Column F — Dimensions / Combinations / Bend

### Dimensions (numeric, not pictograms)

| Ref | Name | Rendering |
|---|---|---|
| 9.1 | Height or Depth | A single number in metres, centred, e.g. `2.5` |
| 9.2 | Size | Two numbers with a lowercase x, e.g. `8 x 4` (horizontal dimensions in metres) |
| 9.3 | Height on slope | Two numbers separated by a **diagonal stroke**: the upper-left number is the height on the upper side, the lower-right the height on the lower side, e.g. `0.5 ╱ 3` |
| 9.4 | Heights of two features | Two numbers **stacked vertically** (upper number = first feature in column D, lower = second in column E); the control is **between** them, e.g. `2` over `3` |

### Combinations

| Ref | Name | **Geometry** | Rule |
|---|---|---|---|
| 10.1 | **Crossing** | A large **X (saltire)** filling the box. | The two features that cross **must** be in columns D and E. |
| 10.2 | **Junction** | A **Y** — a vertical stem from the bottom-centre rising to a fork at mid-height, two arms to the upper-left and upper-right. | Two features meet, or a linear feature meets the side/edge of an areal feature. Features go in D and E. |

Worked examples from the spec: *Path crossing* (D = path, E = path, F = crossing) · *Ride / Stream crossing* ·
*Road junction* · *Stream / Narrow marsh junction* · *Fence / Building junction*.

### Bend

| Ref | Name | **Geometry** |
|---|---|---|
| 11.1 | **Bend** | A **chevron `<`** — two straight strokes meeting at a vertex on the left, opening to the right. Used where a linear feature makes a smooth change of direction (path bend, river bend). |

---

## 3.7 Column G — Location of the control flag (14 symbols)

All direction-bearing symbols in this column are **rotated in 45° steps** to encode the compass direction.

| Ref | Name | **Geometry** | Semantics |
|---|---|---|---|
| 12.1 | **Side** (e.g. north east side) | A **circle outline with a small filled dot sitting on/just outside the circumference** at the named bearing. | Feature extends **above** the ground; the control is on one side and will not be visible from the opposite side. |
| 12.2 | **Edge** (e.g. south east edge) | A **circle outline with a short radial tick crossing the circumference** at the named bearing (a "Q" whose tail points SE). | (a) feature extends **down** from the surface and the flag is on the edge at ground level, or (b) feature covers a significant area and the flag is on its border. |
| 12.3 | **Part** (e.g. west part) | A **circle outline with a filled dot inside**, offset from centre toward the named bearing. | Neither centre nor edge. |
| 12.4 | **Corner (inside)** | A **chevron `>` with a filled dot on the concave (inner) side**, near the vertex. Rotate to point the corner. | Edge of a feature turns through **45°–135°**, or a linear feature turns a corner; the control is on the inside of the angle. |
| 12.5 | **Corner (outside)** | A **chevron `∨` with the filled dot on the convex (outer) side**, just beyond the vertex. | Same angle range, control on the outside. *Note: "building, east corner (inside)" does NOT mean inside the building — a building side is treated as a linear feature.* |
| 12.6 | **Tip** (e.g. south west tip) | A **narrow acute angle (< 45°) with a filled dot at the vertex**. | Edge turns through **less than 45°**. |
| 12.7 | **End** (e.g. north west end) | A **plain straight stroke** oriented along the named bearing, terminating in the box. | The point where a linear feature starts or ends. |
| 12.8 | **Upper Part** | **Two vertical bars** (left and right) with a **filled dot between them near the top**. | Feature spans ≥ 2 contours; flag near the top. |
| 12.9 | **Lower Part** | Same two bars, **dot near the bottom**. | Flag near the bottom. |
| 12.10 | **Top** | An **inverted U (∩) with a filled dot above it**. | Highest point of the feature when that is not the default. **Since 2024 also means "the Upper of two levels".** |
| 12.11 | **Foot (no direction)** | An **L** (vertical stroke down, horizontal stroke right) with a **filled dot in the inner angle at the bottom**. | Lower junction of the feature's slope with the surrounding ground. |
| 12.12 | **Foot (with direction)** | A **circle outline with a small L-corner mark outside it** at the named bearing. | For features large enough that the flag could be at more than one foot (e.g. Hill, north east foot). |
| 12.13 | **Beneath** | A **small roof bracket `⌐` with a filled dot underneath it**. | Control located underneath the feature (e.g. Pipeline, beneath). **Since 2024 also means "the Lower of two levels".** |
| 12.14 | **Between** | **Two short horizontal bars, one above and one below a filled dot** in the centre. | Control between two features — **both features must be given separately in columns D and E**. |

---

## 3.8 Column H — Other information (3 symbols)

| Ref | Name | **Geometry** |
|---|---|---|
| 13.1 | **First Aid post** | A **bold Greek cross (+)** with equal arms, thick strokes, filled. |
| 13.2 | **Refreshment point** | A **drinking cup**: a trapezoid outline, wider at the top than the bottom, with a slightly flared rim. |
| 13.3 | **Manned control** | A **stick figure of a standing/running person** — head circle, body, two legs, one arm. |

---

## 3.9 Special-instruction rows (the "wide" symbols spanning all columns)

These are drawn as a **wide rectangle spanning the whole width of the sheet**, containing a small glyph at the
left, a distance in metres in the middle, and a glyph at the right.

| Ref | Meaning | **Composition (left → right)** |
|---|---|---|
| **14.1** | Distance from the **timed start** to the **start triangle** | `— — —` dashed line · `150 m` · `— — →` arrow · **small triangle** |
| **15.1** | Follow taped route **N m away from control** | **circle** · `— — —` · `60 m` · `— — →` (open arrow, no terminal symbol) |
| **15.2** | Follow taped route **N m between controls** | **circle** · `— — —` · `300 m` · `— — →` · **circle** |
| **15.3** | Mandatory **crossing point(s)** | **circle with an X through it** (= not taped from the control) · the **crossing-point glyph** (two lines curving outward, `)(` lying on its side) · `— — →` · **circle** |
| **15.4** | Mandatory **passage through an out-of-bounds area** | **circle with X** · **two long parallel lines** (a corridor) · `— — →` · **circle** |
| **15.5** | Follow taped route **N m to a map exchange** | **circle** · `— — —` · `50 m` · `— — →` · **triangle** |
| **15.6** *(new 2024)* | **Map flip** (turn the map over) | a plain rectangle containing a **bold curved back-arrow** pointing left |
| **16.1** | `N m` from last control to Finish — **follow taped route** | **circle** · `— — —` · `400 m` · `— — →` · **double concentric circle (finish)** |
| **16.2** | `N m` from last control to Finish — **navigate to the finish funnel, then follow tapes** | **circle with a funnel `>` on its right** · `— — —` · `150 m` · `— — →` · **double circle** |
| **16.3** | `N m` from last control to Finish — **navigate to the finish, no tapes** | **circle with an X through it** · `380 m` · `— — →` · **double circle** |

**The encoding rule to implement:** a **plain leading circle + dashed line = taped**; a **leading circle with an X
= untaped / navigate**; the **terminal symbol identifies the destination**: nothing = "away from control",
circle = another control, triangle = start / map exchange, double circle = finish.

## 3.10 Trail-O variation (for completeness)

* **Column B** = **number of control flags** at the site (`A-C` = three flags to choose from, `A-D` = four).
* **Column H** = **direction of observation** (an arrow; e.g. pointing north means the competitor must stand on the
  path/track to the **south** of the circle).

---
---

# 4. Course overprint (ISOM §3.7, ISSprOM §4.7, IOF Rules §15–19 + Appendix 2)

## 4.0 The two governing sentences

* ISOM §3.7 / ISSprOM §4.7: *"The dimensions of the course planning symbols are specified in mm at the printed
  scale. For larger map scales the symbols shall be enlarged proportionally (**to 150 % for 1:10 000, to 300 % for
  1:5 000**; ISSprOM: **to 133 % for 1:3 000**). All course planning symbols shall be printed over the map content.
  **They shall not mask out map detail of at least black, brown and blue 100 %.**"*
* IOF Rule 15.1: *"Maps, **course markings and additional overprinting** must be drawn and printed according to the
  IOF ISOM or ISSprOM. Deviations need approval by the IOF Council."*

## 4.1 The overprint symbol table — ISOM 1:15 000 vs ISSprOM 1:4 000

**All measurements are mm. `(CC)` = centre-to-centre of the stroke, so the outer diameter is `CC + line width`.**

| # | Symbol | ISOM 2017-2 @1:15 000 | → @1:10 000 (×1.5) | ISSprOM 2019-2 @1:4 000 | → @1:3 000 (×1.333) | Purple layer |
|---|---|---|---|---|---|---|
| **701** | **Start** — equilateral triangle, **pointing at the first control**, centre = the point where orienteering begins | **side 6.0**, line **0.35** | side 9.0, line 0.525 | **side 7.0**, line **0.35** | side 9.33, line 0.467 | **lower** |
| **702** | **Map issue point** — a short thick bar across the marked route | bar **2.5 long × 0.6 thick** | 3.75 × 0.9 | bar **2.5 × 0.6** | 3.33 × 0.8 | **upper** |
| **703** | **Control point** — circle | **ø 5.0 (CC)**, line **0.35** → footprint **75 m** | ø 7.5, line 0.525 | **ø 6.0 (CC)**, line **0.35** → footprint **24 m** | ø 8.0, line 0.467 | **lower** |
| **704** | **Control number** — text | **Arial 4.0 mm**, non-bold, non-italic, **oriented to north** | 6.0 mm | **Arial 4.0 mm**; optional **white outline 0.1 or 0.15 mm** for building-dense maps | 5.33 mm | ISOM: **lower** (changed from upper, errata 07.04.2022) · ISSprOM: **upper** |
| **705** | **Course line** | line **0.35** | 0.525 | line **0.35** | 0.467 | **lower** |
| **706** | **Finish** — two concentric circles | **ø 4.0 and ø 6.0 (CC)**, line **0.35** | ø 6.0 / ø 9.0 | **ø 5.0 and ø 7.0 (CC)**, line **0.35** | ø 6.67 / ø 9.33 | **lower** |
| **707** | **Marked route** — dashed | dash **2.0**, gap **0.5**, line **0.35**; min 2 dashes (4.5 mm = 67.5 m) | dash 3.0, gap 0.75 | dash **2.0**, gap **0.5**, line **0.35** | dash 2.67, gap 0.67 | **upper** |
| **708** | **Out-of-bounds boundary** — solid thick line | width **0.7**; min length 1 mm (15 m) | 1.05 | width **1.0**; min length 1 mm | 1.33 | **lower** |
| **709** | **Out-of-bounds area** — 45° cross-hatch | hatch line **0.2**, spacing **1.2 (CC)**, 45°; min width 3 mm; min area 3 × 3 mm (45 × 45 m) | 0.3 / 1.8 | hatch **0.2**, spacing **1.2 (CC)**, 45°; min width 3 mm; min area 9 mm² (144 m²) | 0.267 / 1.6 | **upper** |
| **710** / 710.1 | **Crossing point** — two lines curving outward | ISOM 710: length **3.0**, inside gap **0.6 (IM)**, line 0.35 | 4.5 / 0.9 | ISSprOM 710.1: overall **4.5 (OM)**, bar 1.0 + 0.5, inside gap **1.0 (IM)** | ×1.333 | **lower** |
| 710.2 | **Crossing section** (ISSprOM only) — a linear object drawn to plan shape | — | — | line **0.35**, offset 1.5 | ×1.333 | **upper** |
| **711** | **Out-of-bounds route** — row of ✗ | cross size **3.0**, line **0.35**, spacing **4.0–6.0 (CC)**; min 2 symbols (6 mm = 90 m) | 4.5 / 0.525 / 6–9 | *(not in ISSprOM)* | — | **upper** |
| **712** | **First aid post** — Greek cross | **4.0 × 4.0**, arm width **1.33** | 6.0 × 6.0 | *(not in ISSprOM)* | — | **lower** |
| **713** | **Refreshment point** — cup | **3.5 (OM) wide × 3.5 (OM) tall**, base **2.1 (OM)**, line **0.4** | 5.25 | *(not in ISSprOM)* | — | **lower** |
| **714** | **Temporary construction / closed area** (ISSprOM only) | — | — | outline **0.1**, fill **purple 50 %**; min width 0.5 mm; min area 0.25 mm² (4 m²) | ×1.333 | **upper** |
| **715** | **Continuing point after map exchange / map flip** — a triangle **inscribed in a circle**, triangle points at the next control | **ø 6.0 (CC)**, line **0.35** | ø 9.0 | **ø 6.0 (CC)**, line **0.35** | ø 8.0 | **lower** |

*(ISOM 714 does not exist; ISSprOM 711/712/713 do not exist. Symbol 715 was added in Revision 6, January 2024, to both specs.)*

## 4.2 The gap rule (this is the single most visible overprint behaviour)

Three separate statements, all normative:

1. **703 Control point:** *"**Sections of the circle should be omitted to leave important detail showing.**"*
2. **705 Course line:** *"**Sections of lines should be omitted to leave important detail showing.** The line should
   be drawn via mandatory crossing points. **There should be gaps between the line and the control circle** in order
   to increase the readability of the underlying detail close to the control."*
3. **§3.7 blanket rule:** overprint *"shall not mask out map detail of at least black, brown and blue 100 %."*

**Implementation recipe:**

```
for each control circle C:
    render C as an arc set, cutting out any angular span where the circle
    crosses a black / brown-100% / blue-100% line feature or point symbol
for each course line L (start→c1, ci→ci+1, cn→finish):
    trim L at both ends so it stops short of the circle (a visible gap, ~1 mm at map scale)
    break L wherever it would obscure a control-relevant feature
    route L through any mandatory crossing point (710)
```

The gap between the line and the circle is not given a number in ISOM; in practice course-setting software
(Purple Pen, OCAD, Condes) defaults to leaving the line ending **on** the circle or with a ~0.5–1.0 mm gap.
**[estimate]** Use **1.0 mm at map scale** for a clean look.

The **control number (704)** is *"placed close to the control point circle in such a way that it does not obscure
important detail"* and is **oriented to north** — i.e. the number never rotates with the course; only its
*position* around the circle is chosen (typically at the 1–2 o'clock or 4–5 o'clock position, whichever is clearest).

## 4.3 Start triangle geometry (exact)

Equilateral triangle, **centroid** = the point where orienteering begins, **apex points at the first control**.

For ISOM at 1:15 000 with side `a = 6.0 mm`:
* height `h = a·√3/2 = 5.196 mm`
* circumradius (centroid → apex) `R = a/√3 = 3.464 mm`
* inradius (centroid → side midpoint) `r = a/(2√3) = 1.732 mm`
* stroke `0.35 mm`, so the outer extent is `R + 0.175 ≈ 3.64 mm` from centre
* ground footprint: side = 90 m at 1:15 000, 60 m at 1:10 000

For ISSprOM at 1:4 000 with `a = 7.0 mm`: `h = 6.062`, `R = 4.041`, `r = 2.021`; footprint side = 28 m.

**Rule 22.8:** *"The point where orienteering begins must be shown on the map with the start triangle and marked in
the terrain by a control flag but **no punching unit**."* So the start triangle is **not** a punch — it is a
map-and-flag rendezvous. If the timed start is elsewhere, the distance to the triangle goes on the description
sheet (symbol 14.1).

## 4.4 Finish, marked routes, crossing points

* **706 Finish** is **two concentric circles** (ISOM ø 4.0 + ø 6.0; ISSprOM ø 5.0 + ø 7.0). Appendix 2 §3.6:
  *"At least the last part of the route to the finish line should be a **compulsory marked route**."*
* **707 Marked route** is *"a part of the course. **It is mandatory to follow the marked route**"* — and Rule 17.3:
  *"Competitors must follow **the entire length** of any marked section of their course."*
* **710 Crossing point** is drawn as *"two lines curving outwards. **The lines shall reflect the length of the
  crossing**."* Used for: through/over a wall or fence, across a road or railway, through a tunnel, through an
  out-of-bounds area, over an uncrossable boundary. In sprint, 710.1 (point) and 710.2 (section) additionally
  **may be used to emphasise underpasses and tunnels that are in play**.
* **711 Out-of-bounds route**: *"Competitors are allowed to **cross directly over** a forbidden route, but it is
  forbidden to **go along** it."* Row of purple ✗ along the route.
* **709 Out-of-bounds area** bounding line semantics:
  * **solid line** → the boundary is **marked continuously** (tapes) in the terrain
  * **dashed line** → **intermittent** marking in the terrain
  * **no line** → **no** marking in the terrain

## 4.5 Control-flag and control-unit rules (Rules 19.x)

| Rule | Content |
|---|---|
| 19.2 | Control flag = **three squares of about 30 cm × 30 cm arranged in a triangular form**; each square divided **diagonally**, one half **white**, the other **orange (PMS 165)**. |
| 19.3 | The flag hangs at the feature indicated by the map and description; **must be visible when the competitor can see the described position**. |
| 19.4 | **Minimum control separation.** Scales 1:15 000 / 1:10 000 / 1:7 500: **≥ 30 m** between any two controls (including the start flag); **≥ 60 m** straight-line if the control features are **similar**. Sprint 1:4 000 / 1:3 000: minimum **running** distance **25 m**, minimum **straight-line** distance **15 m**, with no extra rule for similar features. |
| 19.5 | A control must be sited so that *"the presence of a person punching does not significantly help nearby competitors to find the control."* |
| 19.6 | Code number **> 30** (i.e. ≥ 31), **black on white**, **1.5–10 cm high**, line thickness **≥ 2 mm**; horizontally-displayed codes **underlined** if reversible (e.g. `161`). |
| 19.7 | *"a sufficient number of punching units in the immediate vicinity of each flag."* |
| 19.8 / 19.10 | Winning time ≥ **30 min** → refreshments at least every **25 minutes at the winner's pace**. Winning time ≥ **60 min** → WADA-compliant **sports drink** in addition to pure water (WOC/WCup/JWOC). |
| 3.5.3 (App. 2) | *"a control flag should be placed in such a manner that competitors **first see it only when they have reached the described control feature**. … **On no account should the control flag be hidden**: when competitors reach the control they should not have to search for the flag."* |
| 3.5.4 (App. 2) | Avoid the **'acute angle' effect** — incoming competitors being led into the control by outgoing ones. |

## 4.6 Course measurement and climb

| Rule | Content |
|---|---|
| 16.3 | *"The course lengths must be given as the **length of the straight line from the start via the controls to the finish**, deviating for, and only for, **physically impassable obstructions** (high fences, lakes, impassable cliffs etc.), **prohibited areas** and **marked routes**."* |
| 16.4 | *"The total climb must be given as the **climb in metres along the shortest sensible route**."* |
| App. 2 §3.11.6 | *"The total climb of a course should **normally not exceed 4 % of the length of the shortest sensible route**."* — **this is the only climb figure in the rules and it is not varied by format.** |
| 16.9 | Where the winning time is an interval, plan for the **middle** of the interval. |

**Consequence for the game:** the "official course length" is a *straight-line-through-controls* figure, not the
distance the athlete actually runs. Real running distance is typically **10–25 % longer** than the stated length
in forest and can be **30–60 % longer** in sprint. **[estimate — see §8.6]** Do not conflate the two.

---
---

# 5. SportIdent

Sources: SPORTident docs (https://docs.sportident.com/user-guide/classic-system,
https://docs.sportident.com/user-guide/air-plus-system, https://docs.sportident.com/user-guide/config-plus,
https://docs.sportident.com/products/cards/siac, https://docs.sportident.com/products/stations/bsf9) ·
SPORTident UK card-comparison sheet https://www.sportident.co.uk/information_sheets/sportident-cardcomparison.pdf ·
SPORTident Organiser Guide https://orienteering-shop.com/media/pdf/04/76/15/SPORTident_organiser-guide.pdf ·
SPORTident AIR+ information for organisers https://www.sportident.com/tibiapi/medialib/6627c0d60938460001504eb9/file/sportident_airplus_information_for_organisers.pdf ·
British Orienteering, *SportIdent advice for Event Advisers* (July 2025, authored by the Chair of the IOF Rules
Commission) https://www.britishorienteering.org.uk/doc/resource-library/planning-courses/sportident-advice-for-event-advisers ·
IOF Competition Rules 2025 §20 and Appendix 4.

## 5.1 SI-Card generations — capacity and behaviour

| | **SI-5** | **SI-6** | **SI-8** | **SI-9** | **SI-10** | **SI-11** | **SIAC** | **pCard** |
|---|---|---|---|---|---|---|---|---|
| Card-number range | 1–499 999 | 500 001–999 999 | 2 000 001–2 999 999 | 1 000 001–1 999 999 | 7 000 001–7 999 999 | 9 000 001–9 999 999 | 8 000 001–8 999 999 | 4 000 001–4 999 999 |
| **Control records** | **30 + 6 code-only** | **64** (192 if configured) | **30 (hard cap)** | **50** | **128** | **128** | **128** | **20 (hard cap)** |
| Total records incl. start/finish/check | 39 | 68 | 33 | 53 | 132 | 132 | 132 | 23 |
| **Contact punch dwell time** | **330 ms** | 130 ms | 115 ms | 115 ms | **60 ms** | 60 ms | 60 ms direct / **50 ms contactless** | 115 ms |
| Time format | **12-hour only** | 24 h + day-of-week + 4-week counter | 24 h + DoW | 24 h + DoW | 24 h + DoW | 24 h + DoW | 24 h + DoW, **4 ms resolution** | 24 h + DoW |
| Control-code range | **1–255** | 1–511 | 1–511 | 1–511 | 1–511 | 1–511 | 1–511 | 1–511 |
| Stores start time | yes | yes | yes | yes | yes | yes | yes | yes |
| Stores finish time | yes | yes | yes | yes | yes | yes | yes | yes |
| Stores **clear** time | **no** | yes | yes | yes | yes | yes | yes | yes |
| Stores **check** time | yes (overwritten in "Sprint" mode) | yes | **no** | **no** | yes | yes | yes | bonus data |
| Contactless (AIR+) | no | no | no | no | no | no | **yes** | no |
| Status | discontinued | discontinued | current | current | current | current | current | current |

**Behavioural quirks that matter for a simulator:**

* **SI-5** — only the first **30** punches get *code + time*; punches **31–36 store the code only** (you know the
  order, not the time); beyond 36 nothing is written. **12-hour clock**, no day counter → punch times are ambiguous
  across noon and useless for events longer than 12 h. Its **330 ms** dwell is ~3× the modern cards' and is the
  classic cause of the "punched too fast" disqualification.
* **SI-6** — 64 punches by default. **192 punches only if every station at the event, including the read-out
  station, has the "SI-Card6 with 192 punches" flag set** in Config+.
* **SI-8 (30) and pCard (20)** — hard caps, frequently too small for a dense urban sprint.
* **SI-10 / SI-11 / SIAC** — have a **reserve memory slot**: a second finish punch pushes the *first* finish time
  into the reserve and writes the second into the main slot. Same for start.
* **SI-11 and SIAC have an LED** and cannot punch again while the feedback is running. **Programme the CLEAR
  station with code 1** so the card suppresses feedback after clearing — otherwise the immediately-following CHECK
  punch silently fails, and with a SIAC **AIR+ is never activated**.
* **Read-out time** is only published for SIAC: **RFID < 4 s, SRR < 1 s**. Per-card read-out durations are not
  published. **[UNCERTAIN]**
* **Card storage time resolution is 1 second** for every passive card. Only the **SIAC** stores to **4 ms**.
  **Station internal resolution is 1/256 s ≈ 3.9 ms.** Station clock drift: SPORTident quotes **< ±20 s/month**;
  British Orienteering quotes **~1 s/day**.

## 5.2 SIAC — touch-free (AIR+) punching

### Active range — sources disagree; use the anisotropic model

| Station | SPORTident docs / Organiser Guide | IOF Rules Appendix 4 | British Orienteering (Jul 2025) |
|---|---|---|---|
| **BSF7 / BSF8 / BSF9 in AIR+** (normal foot-O control) | **~50 cm** (max approach 40 km/h) | **"~30 cm"** | **"about 30 cm"** |
| BS11-BS (blue, MTBO) | **180 cm** | — | "up to 120 cm" |
| BS11-BL (large) | **300 cm** | — | "up to 3 m" |
| BS11-LA (loop antenna) | up to **600 cm** (lanes to 6 m) | — | — |

The reconciliation is in the 2019 Organiser Guide (p. 81): the field is **anisotropic** — the SIAC records
*"at a range of **60 cm above** and **30 cm around** the station."*
**→ Model foot-O AIR+ as ~30 cm lateral / ~60 cm vertical.** (SportIdent separately warns that BS11 stations in
AIR+ mode can produce stray timestamps *"up to 5 metres"* away — hence the 25 m minimum control separation.)

### Re-punch, feedback, and the beacon caveat

* **Re-punch rule:** *"The SIAC records a second punch if it has been **outside of the beacon station's active
  field for at least 8 seconds** and then is moved back in."*
* **In beacon mode the STATION gives no feedback.** *"SI-Stations in beacon mode will NOT give a feedback signal
  when a SIAC registers a contactless punch."* The **card** beeps and flashes instead:
  *"The tip of the SIAC flashes when a punch has been recorded and the SIAC emits an audible beep. The flashing
  continues while the SIAC is in the field of the control."*
* **A contactless punch is written only to the card** — *"not recorded in the backup memory of the station."*
  → **There is no station-side evidence for a contactless punch.** This kills the usual "read the backup" appeal.

### Feedback timing (published values)

| Setting | Duration |
|---|---|
| **Default** | **≈ 3 s** |
| Long | ≈ 5 s |
| Short | **< 1 s** |
| SIAC "blink only" (no sound) | ≈ 4 s |
| Any station in **Timing Mode** | always short, regardless of setting |

British Orienteering quotes "2.5 s" in one place and "3 s" in another for the SIAC — both consistent with the ~3 s
default. **Millisecond-level beep/flash envelopes are not published anywhere.** **[UNCERTAIN]**
British Orienteering also states the **SI-11** *"flashes for about 7 seconds"* and cannot re-punch while flashing —
this conflicts with the ~3 s Config+ default and is probably an older firmware. **[UNCERTAIN]**

### Contact punch — the six-step sequence (what "single beep + single flash" actually means)

1. Competitor inserts the card.
2. Station **reads** the card (fast).
3. Station **writes** control code + time (the longest step — this is what the dwell time in §5.1 measures).
4. Station **re-reads to verify** the write.
5. Station **beeps and flashes**, and writes card number + time to its **backup memory**.
6. Card is withdrawn.

→ **One beep + one flash, given only after write-verify.** A punch with no feedback is a punch that did not happen.

### Silent-by-design cases (critical — these are *not* faults)

* **CHECK** beeps **only if the card is empty**.
* **START** gives **no feedback signal if the card is not empty**.
* **CLEAR** always beeps and blinks on completion.
* A **full card** produces **no feedback at all** — the station writes nothing but logs the attempt in its backup
  with error flag **`Err9`**. (A BSF7/8 will still wake from stand-by, so the runner sees a lit display and no beep —
  the classic "the box is broken" false alarm.)

### Battery

* SIAC expected life **~4 years** (basis: 50 controls × 50 events/year); SportIdent recommends **replacement after
  3 years**. **Direct contact punching always works even with a flat SIAC battery** (it degrades to an SI-Card 10).
* **There is no in-race low-battery warning.** The only check is the **SIAC Battery Test** station, pre-race:
  * **single normal beep + `OK` on the LCD** → battery fine
  * **several higher-frequency beeps** (British Orienteering: **5 beeps**) + **`WARN`** → below **2.72 V**; will
    survive this event unless heavy live-timing traffic
  * **no beep at all** + **`FAIL`** (BO: LCD `LOW`) → below **2.44 V**; contactless will not work
* Station uptime: BSF8 in AIR+ ≈ **1 500 h / ~120 events**; BSF7 ≈ double; BS11-BS ≈ 75 h; BS11-BL ≈ 90 h.
  Beacon-mode operating time is **not** reset by contactless punches — only by a direct punch (BSF7/8) or a magnet
  held ~4 s (BS11). Config+ default stay-active: **beacon 12 h**, classic **4 h**.

### Switching the SIAC on and off

| Action | How | Writes a record? |
|---|---|---|
| **ON** | punch the **CHECK** station (the recommended orienteering method, after CLEAR) | yes (check record) |
| **ON** | punch a **SIAC ON** station | **no**; works even if the card was not cleared |
| **ON** | punch a **SIAC Test** station | test only |
| **OFF** | **FINISH** punch (contact or contactless) — *"The SIAC automatically turns off after receiving BC FIN"* | yes |
| **OFF** | punch a **SIAC OFF** station | no |
| **OFF** | **auto-timeout** — *"The SIAC remains active for about **20 hours** if it is not switched off. **This timer is reset with each direct or proximity punch.**"* | — |

Active state is indicated by a **slowly blinking green LED in the card tip**.
*(British Orienteering also claims the SIAC is switched off at download; this is not confirmed in SportIdent's own
docs — **[UNCERTAIN]**.)*

## 5.3 Station types and the race sequence

**Classic modes (BSF7 / BSF8 / BSF9 / BSM7 / BSM8):**
`CLR` Clear (CZ *mazání*) · `CHK` Check (*kontrola mazání*) · `STA` Start · `CN` Control · `FIN` Finish.
**Read-out:** BSM8-D-USB — the SI-Master / main station; downloads cards and can remote-control field stations.
**AIR+ / beacon modes:** `BC STA`, `BC CN`, `BC FIN`.
**SIAC special modes:** `SIAC ON`, `SIAC OFF`, `SIAC Test`, `SIAC Battery Test`, `SIAC Radio Readout`.
**BS11 series** (BS11-BS / BS11-BL / BS11-LA): contactless **only** — `BC START`, `BC FINISH`, `BC CONTROL`.
**Instruction cards:** `SERVICE/OFF` (stand-by), `Clear Back-up memory`, `Time Master` (sync; "Extended" also
clears backup memory and sets stay-active time).

### The mandatory sequence

```
CLEAR  →  CHECK  →  START  →  CONTROL … CONTROL  →  FINISH  →  DOWNLOAD (read-out)
```

* **Why CLEAR exists.** Stations refuse to write into occupied slots. A card carrying old punches will (a) fail
  against the new course and (b) once full, produce **no feedback at all**. CLEAR empties every control slot.
* **Why CHECK exists.** It is the **verification gate**: the CHECK station gives feedback **only if the card is
  empty**, so it is the last chance to catch an uncleared card before the start — because the START station's
  failure mode is *silence*, which a runner under pressure will not notice. In AIR+, **CHECK is also what switches
  the SIAC on.** Both CLEAR and CHECK write timestamps into dedicated fields, so the pre-start procedure is
  auditable afterwards.
* British Orienteering recommends an extra **pre-start SIAC Test beacon** between CHECK and the start line:
  *"Experience shows that a small proportion always slip through without being turned on."*
* The **Start and Check stations' backup memory identifies who actually started** — essential for missing-runner
  searches.

**Station backup memory:** max **21 802 punches** / max **1 022 card data records** (BSF8/BSF9); oldest overwritten
when full.

## 5.4 Split times

* **The card stores absolute punch timestamps** (control code + time per record) — **not** splits.
* **Splits are computed by the results software** as differences between consecutive punch timestamps.
  This is why a control unit with a drifted clock corrupts two adjacent splits, not one.
* IOF **Rule 23.5**: *"In interval start races, times must be rounded **down** to whole seconds."* Mass/chasing
  starts may display tenths. **Rule 23.6**: timekeeping accuracy relative to competitors in the same class must be
  **0.5 s or better**.
* **Rule 24.15**: *"It is **forbidden to eliminate sections of the course on the basis of split times** unless the
  section has been specified in advance."*

## 5.5 Mispunch → not placed (IOF Competition Rules 2025 §20)

The IOF rules never say "DSQ" or "MP" — they say **"must not be placed"**. `MP` and `DSQ` are national/software
conventions; Rule 24.1 only requires that *a reason* be shown.

| Rule | Text (2025 edition) |
|---|---|
| **20.3** | *"Competitors are **responsible** for punching their control card at each control using the punching unit provided. If one unit is not working, or appears not to be working, a competitor must use the backup provided and **will not be placed if no punch is recorded**."* |
| **20.4** | *"The control card must clearly show that **all** controls have been visited."* |
| **20.5** | *"A competitor with a control punch **missing or unidentifiable must not be placed** unless it can be established with certainty that the punch missing or unidentifiable is **not the competitor's fault**. In this exceptional circumstance, other evidence may be used … such as evidence from control officials or cameras or read-out from the control unit. **In all other circumstances, such evidence is not acceptable** and the competitor must not be placed."* Then, for traditional (non-contactless) SportIdent, SFR and Learnjoy: *"If a competitor punches **too fast** and fails to receive the feedback signals, the card will not contain the punch and the competitor must not be placed, **even though the control unit may have recorded the competitor's card number as an error punch**."* Plus a **20 EUR backup-read fee**, refunded if the backup shows a complete (non-error) punch. |
| **20.6** | *"Competitors who **lose their control card, omit a control or visit controls in the wrong order** must not be placed."* ← **the single clause covering missing control, wrong control and wrong order** |
| **20.7** | Two contactless cards must be carried **on the same arm**; if the first read out has missing punches, both cards' punches are **merged**. |
| **20.8** | A **back-up punching method** must be provided. |
| **20.9** | *"When contactless punching is used, the **last control may have a punching unit with a longer range** than standard and this must be stated in the final bulletin."* |
| **24.1** | Those who fail to correctly complete the course are shown at the end of the results with no placing and **a reason (e.g. mispunched, retired, disqualified)**. |
| **App. 4** | Approved systems: Emit EPT · SPORTident · Emit touch-free (2013+) · **SPORTident Air+ (range ~30 cm)** · SFR Classic · Learnjoy. *"With respect to the original SPORTident system, a **backup needle punch must be present at each control**. … If, **and only if**, no feedback signal is received, the competitor must use the backup punch."* |

**The rare SI write bug** (David Rosen, Chair of the IOF Rules Commission): roughly **1 in 100 000 punches**, the
unit believes it wrote successfully, gives full feedback, and writes a **non-error** backup record, but the card
holds nothing. If the backup shows a **complete non-error punch**, the competitor **must be reinstated**; an *error*
punch means the disqualification stands. **This route does not exist for contactless punches** — no station record.

**Wrong-control detection in practice:** results software flags an **extra punch marked with an asterisk** around
the expected time — that is a visit to the wrong control.

### Game state machine

```
DSQ conditions (all → "not placed"):
  • any control code missing from the card
  • controls present but not in the prescribed order
  • control card lost
  • entering / following / crossing any Rule-17.2 symbol (§2.6)
  • not following a marked route for its entire length (17.3)
Recoverable:
  • unit dead + backup punch used correctly            → placed
  • non-error backup punch proves a card write failure  → reinstated (contact punching only)
```

## 5.6 Punching start vs start gate vs timed start

| Mode | Mechanics | Rules |
|---|---|---|
| **Interval (timed) start** | Start time comes from the start list. Requires the start clock, the results computer and every control unit to be synchronised to a common reference time. **A clock showing competition time must be displayed at the start.** Optional **pre-start** with a clock showing **call-up time**. | 22.1, 22.4, 22.5 |
| **Start gate** | The elite standard: *"A **time-trial, individual format** is used. **The competitor must have passed the start gate before having access to the map.**"* Start intervals: **Sprint 1 min, Middle 2 min, Long 3 min**. | App. 6 §1.4/2.4/3.4 |
| **Punching start** | The competitor punches a START unit and that timestamp becomes their start time. Only the control units need to be synchronised **to each other**, not to real time. *"A punching start is more flexible **but is not appropriate for top-level competitions**."* Beware: if a start time exists on the card, results software will generally use it, **overriding** the allocated time. | practice; SPORTident docs |
| **Mass / chasing start** | *"the placings are determined by the **order in which the competitors finish**"* — finish order across the line governs, not the clock; tenths of a second may be shown. **Finish line ≥ 1.5 m wide** for interval starts, **≥ 3 m** for mass/chasing starts. Course-combination allocation must be **kept secret until after the last competitor has started**. | 24.7, 23.5, 23.3, 12.12 |
| **Late starters** | Must be permitted to start; a new start time is recorded. Interval start: less than ½ interval late → start immediately; more than ½ interval late → the next available **half** start interval. **Late through own fault → timed from the original start time. Late through the organiser's fault → timed from the new start time.** | 22.9, 22.10 |

**AIR+ design traps:** putting the **START** in beacon mode is inadvisable — a SIAC drifting near the box records a
premature start. Putting the **FINISH** in beacon mode requires that no runner can pass near it mid-race, because
passing it **switches their SIAC off**. And because the card flashes for ~3 s and an elite runner covers ~25 m in
that time, **control separation and the finish run-in must both be ≥ 25 m** (this is the stated rationale behind
Rule 19.4 / Appendix 2 §3.5.5).

---
---

# 6. Navigation technique as game mechanics

Everything in this section is framed as: **(a)** what the athlete physically does, **(b)** the error it prevents or
causes, **(c)** the time cost/benefit, **(d)** when it is used. Where no source quantifies a cost, it is marked
**[UNCERTAIN]** rather than invented.

## 6.0 The master model — attention is the scarce resource

British Orienteering's performance model (Kris Jones,
[Analysis / Plan / Direct / Picture notes](https://www.britishorienteering.org.uk/images/uploaded/downloads/2Analysis%20Plan%20Direct%20Picture%20Further%20Notes%20by%20Kris%20Jones.pdf))
splits a finite attention budget three ways — **travel**, **map**, **terrain**:

> *"when the athlete is attending to either the map or the terrain they are attending less attention to travel and
> this will reduce speed."*

**This is the core game loop.** Model a scalar `attention ∈ [0,1]` split between `speed`, `map_reading` and
`terrain_matching`. Every technique below is a strategy for spending less attention on map+terrain for a given
level of positional certainty.

**The traffic-light speed model** (widely taught; see
[Orienteering ACT Lesson 12](https://act.orienteering.asn.au/resources/skills/advanced-skills/lesson-12-route-choice/)):

| Phase | Behaviour | Speed | Positional certainty |
|---|---|---|---|
| **Green** | Confident running on line features, minimal cross-checking | ~100 % | coarse (±200 m circle is fine) |
| **Orange** | Off line features; slow down, cross-check regularly | ~85–90 % | ±50–100 m |
| **Red** | Very slow or walking; stop to cross-check; precise compass + pacing | ~50–70 % | ±10–20 m |

And the governing design principle (ACT Lesson 12):
> **"More time is lost making navigational errors than from poor route choice."**

---

## 6.1 Compass — rough vs precise bearing

**The geometry.** `lateral_error_m = distance_m × tan(θ)`. For small angles, **1° ≈ 17.5 m per km**
(`tan(1°)×1000 = 17.46`; the aviation 1-in-60 rule gives `1000/57.3 = 17.45`).

| Bearing error | @100 m | @200 m | @500 m | @1000 m |
|---|---:|---:|---:|---:|
| 1° | 1.7 | 3.5 | 8.7 | **17.5** |
| 2° | 3.5 | 7.0 | 17.5 | 34.9 |
| 3° | 5.2 | 10.5 | 26.2 | 52.4 |
| 5° | 8.7 | 17.5 | 43.7 | 87.5 |
| 10° | 17.6 | 35.3 | 88.2 | **176.3** |
| 20° | 36.4 | 72.8 | 182.0 | 364.0 |

**Error budget** ([QOC "Five key skills"](https://www.qocweb.org/content/five-key-skills-orienteering)):
map-measurement error **1–2°** + unconscious execution veer **1–2°** = a **2–4° floor even when careful**.

| Mode | What the athlete does | Angular error | Speed | Used when |
|---|---|---|---|---|
| **Rough compass** (*hrubý azimut*) | Glance at the needle every few seconds at full speed and accept drift. On a **thumb compass** the housing is never rotated: place the thumb tip on your position, rotate **body + map** until the needle sits north, then sight along the map line. | **~10°**, up to 15° | 100 % | The bulk of a leg, aimed at a large collecting feature or handrail |
| **Precise compass** (*přesný azimut*) | Set the bearing, slow to a jog or walk, **sight an object 50–100 m ahead**, run to it, re-sight, repeat. | **2–3°** | ~50–70 % | From the attack point into the circle; in featureless terrain; night-O |
| Catastrophic outlier (documented) | — | 27° | — | panic / not looking at the needle at all |

*(Angular figures are practitioner self-reports from [Attackpoint](http://www.attackpoint.org/discussionthread.jsp/message_20714),
internally consistent with the tangent table; technique from
[Learn Orienteering — compass bearings](https://www.learnorienteering.com/AdCompBearings.html) and
[Desert Adventurer, rough vs fine](https://desertadventurer.com/rough-vs-fine-orienteering/).)*

**Time cost of precise vs rough: [UNCERTAIN]** — not published. The documented mitigation is structural instead
(QOC): *"break the long leg up into several shorter sections between identifiable features, even if it means
following a zig-zag course. **It often is faster.**"*

**Implementation:** apply a per-tick heading noise `N(0, σ)` with `σ_rough ≈ 10°`, `σ_precise ≈ 2.5°`, plus a
constant systematic bias per leg drawn from `N(0, 2°)` (the map-measurement error, which does **not** average out).

## 6.2 Thumbing and folding the map

**Does:** grip the map with the thumb immediately below the exact current position and advance the thumb as you
move; fold the map so only the relevant section is showing.
**Prevents:** the **parallel error** — it is named explicitly as the primary defence
([Orienteering ACT Lesson 3](https://act.orienteering.asn.au/resources/skills/advanced-skills/lesson-3-thumbing-the-map/)).
Also prevents re-scanning the whole map at every glance.
**Cost/benefit:** near-zero cost; reduces the attention needed per map glance, which frees attention for speed.
**Used:** always, from novice level upward.
**Model:** thumbing sets `position_uncertainty_growth_rate` low and makes each `map_glance` cheap; losing the thumb
(e.g. after a stumble, or on a map exchange) resets it.

## 6.3 Handrails (*vodicí linie*)

**Does:** follow a linear feature — track, road, fence, power line, watercourse, distinct ridge or vegetation
boundary — instead of navigating in open terrain.
**Prevents:** essentially all positional error while on it. This is the "green light" phase:
*"run confidently along linear features… with **minimal cross checking**."*
**Cost/benefit:** a handrail is usually **longer** than the straight line but **faster and safer**. The trade is
`extra_distance × path_speed_bonus` vs `straight_distance × terrain_penalty × error_risk`.
**Used:** whenever the detour is under roughly 20–30 % **[estimate]**.

Norwegian course-design difficulty ladder ([nfollo.no](https://www.nfollo.no/next/page/grunnleggende-om-orientering)) —
useful as a difficulty parameter for the course generator:

| Level | Control offset from the handrail | Length of "cut-through" off line features |
|---|---|---|
| **N2** (beginner) | 5–15 m | 100–150 m |
| **C** (intermediate) | 100–150 m | 200–300 m |
| **B** (advanced) | 100–250 m | longer / none |

## 6.4 Attack points (*odrazový bod*)

**Does:** pick a large, unmistakable feature **close to the control** and navigate to it in "green/orange" mode;
switch to precise navigation only for the final short section.
**Prevents:** long-range accumulation of bearing error being carried into the circle.
**Recommended distance: within ~100 m of the control** ([EMPO](https://empoclub.org/o-basics/navigation-tips-for-beginners/)).
**Advanced terrain chains attack points** (a coarse one, then a fine one).
**Diagnostic value** ([ACT Lesson 8](https://act.orienteering.asn.au/resources/skills/advanced-skills/lesson-8-attack-points/)):
> *"If there is **no obvious attack point**, it is a warning that extra care must be taken."*

**Model:** the attack point resets `position_uncertainty` to ~0 at a known point at distance `d` from the control;
final-approach error ≈ `d × tan(σ_precise)`. With `d = 100 m` and `σ = 2.5°` that is **4.4 m** — inside the flag's
visibility radius. With no attack point and `d = 600 m` at `σ = 10°`, it is **106 m** — a guaranteed search.

## 6.5 Catching / collecting features (*záchytný bod*, *záchytná linie*)

* **Collecting feature** — a prominent feature *en route* that you are unlikely to miss; ticking it off confirms
  progress.
* **Catching feature / backstop** — the same thing placed **beyond** the control, so that hitting it tells you that
  you have overshot. Norwegian coaching places these **200 m+ behind** controls.

**Prevents:** unbounded overshoot. Converts an open-ended search into a bounded one.
**Causes:** ACT warns they can *cause* parallel errors if you run at them blindly without checking which instance
you hit.
**Time benefit:** turns "keep going and hope" into "I know I have gone too far" — see §6.14, this is the difference
between a 1-minute and a 5-minute error.

## 6.6 Aiming off

**Does:** deliberately bias the bearing to one side of the target so that on hitting a linear feature you know
unambiguously which way to turn along it.
**Prevents:** the 50/50 guess at a linear feature.
**How much to aim off:** **no orienteering source specifies a number** — BAOC and Quantock both explicitly decline
to give one. **[UNCERTAIN]** Derive it: the offset must comfortably exceed your own drift, i.e. more than a
10°-equivalent for a running rough bearing. **Model: `offset = max(30 m, 1.5 × distance × tan(σ_rough))`.**
**Failure mode:** *"aiming off too little is worse than not aiming off at all"*
([BAOC](http://baoc.org/wiki/Training/BulletinTrainingTips/Aiming_Off)) — you land on the wrong side and turn the
wrong way, doubling the error.

## 6.7 Contouring

**Does:** move along a slope at constant height rather than up-and-over. In featureless terrain: sight a distinct
tree **at your own eye height**, run to it, repeat ([ACT Lesson 10](https://act.orienteering.asn.au/resources/skills/advanced-skills/lesson-10-improving-contour-navigation/)).
**Prevents:** the **height error** — a failure mode orthogonal to horizontal displacement, and the reason runners
"run back and forth over the right feature".
**Benefit:** avoids climb, which is expensive — see §8: **1 m of climb ≈ 6.2 m of flat running for men, 6.4 m for
women**. A 30 m climb avoided is worth ~190 m of flat distance.
**Heuristic taught:** ~**5 m of height per apartment floor**.

## 6.8 Simplification (*zjednodušení*)

**Does:** deliberately read only the large, unmistakable features and ignore minor detail until close to the circle.
Advanced form: navigate a **"virtual corridor"** — a *band* of features rather than a single handrail.
**Standard to hit** ([Better Orienteering, advanced](https://betterorienteering.org/advanced-techniques/)): at
advanced level you should know your location within a **200 m circle** at all times and know your intended position
**100–200 m ahead**.
**The canonical description** (Thierry Gueorgiou, via the Kris Jones notes): identifying *"the most visible and
distinct features in the terrain (and ignoring many small details), trusting his compass and keeping his head
high."*
**Benefit:** directly buys running speed by lowering the attention cost of map reading.
**Risk:** over-simplification loses the ability to relocate cheaply.

## 6.9 Map memory

**Does:** memorise a chunk of the leg so you can run several hundred metres without looking at the map. The advanced
target is *"a rolling Picture that is always being updated"*.
**When to plan ahead:** only when it is cheap — climbing, or running along a line feature — and only with a firmly
identified **Break Point** to return to. Otherwise *"planning ahead itself forces errors"* (Better Orienteering).
**Failure mode:** the **map-memory error** — navigating from a decayed internal picture. Crucially, this error is
*self-announcing*: the terrain **fails** to match, confidence drops immediately, and it is caught within ~100 m if
you stop at once. Contrast the parallel error (§6.12), where confidence stays high.

## 6.10 Pace counting (*krokování*)

Orienteering counts **one foot only** — a "pace" is a double pace (left-right).

| Source | Walking, paces/100 m | Running, paces/100 m |
|---|---|---|
| [DVOA](https://www.dvoa.org/learn/train/docs/pace-counting-summer-2009.pdf) | **57** | **38** |
| [Quantock](https://www.quantockorienteers.co.uk/info/training/intermediate/pace-counting) | 60–64 | 32 (jog on trail) |
| [BAOC](https://baoc.org/wiki/Training/Pace_Counting) | — | 45–60 (55 recommended starting value) |
| [WAOC](https://www.waoc.org.uk/about/orienteering-techniques/) | — | 40 (open forest) |
| Attackpoint practitioners | ~60–63 | ~45 |

> **Correction to a common prior:** "40–50 double paces per 100 m walking" is **too low**. Published walking figures
> cluster at **57–64**; **38–50 is the running band.** DVOA states the relationship explicitly: *"the walking pace
> per 100 metres will be about **50 % higher** than the running pace"* (57/38 = 1.50 exactly).

**Terrain variation:** trail 32 vs flat open forest 40 = a **1.25× penalty**.
**Slope thresholds** (the only quantified ones found, [Attackpoint](http://www.attackpoint.org/discussionthread.jsp/message_1514691)):
the **run → walk/climb transition is around +8 to +10 % uphill**; downhill the transition is **earlier, at −4 to −5 %**.
**Field hack:** in thick vegetation or on steep ground, substitute a **3-step** pace for the 2-step pace (BAOC).
**Useful range:** **200–300 m maximum, usually less** — error accumulates.
**Counter-view:** Orienteering ACT explicitly *discourages* pace counting as "unreliable and distracting", preferring
reference objects (cricket pitch 20 m, swimming pool 50 m, soccer field 100 m).

## 6.11 Map-to-terrain vs terrain-to-map

| Mode | Direction | Behaviour | Consequence |
|---|---|---|---|
| **Proactive — map → terrain** (*mapa do terénu*) | You pre-select the features you expect to meet, then look for them | The expert mode | Fast; you are ahead of yourself |
| **Reactive — terrain → map** (*terén do mapy*) | You see a feature and then hunt for it on the map | The novice mode | *"leaves them **one step behind** and unable to run with any speed"* ([WAOC](https://www.waoc.org.uk/about/orienteering-techniques/)) |

Reactive reading is a listed **cause of parallel errors** in detailed terrain: you find *a* feature that matches
rather than *the* feature you predicted.

**Model:** proactive mode = the game pre-commits a list of expected features; matching one advances a "confirmed
position" cheaply. Reactive mode = each observed feature triggers a search over nearby candidates, costing extra
`attention` and, in repetitive terrain, sometimes selecting the wrong candidate — which is exactly a parallel error.

## 6.12 The parallel error (*paralelní chyba*) — the important one

### Why it happens

The terrain supplies **near-identical instances** of a feature type — parallel re-entrants, parallel spurs, a series
of similar knolls, a row of similar buildings:

> *"any spur or gully can look very much like every other one, especially to the over-confident (or panicked!)
> mind"* — [Attackpoint](http://www.attackpoint.org/discussionthread.jsp/message_1369221)

**The directional asymmetry — encode this in the terrain generator:**

> *"Reentrants **branch** as you're going up them, so you can get diverted into the wrong one, but going **down**,
> they merge together."*

**Ascending re-entrants generates parallel errors; descending them is self-correcting.** Course setters exploit
this deliberately: *"Controls being approached from below will be placed in gullies that encourage parallel errors
and demand decisions at sequential gully junctions."*

**Triggers:** rough-compass drift (10° over 500 m = **88 m** — easily one feature over); losing the thumb position;
reactive map reading; approaching a repeating landform from below.

### What it feels like

The best first-person account is from Radan Kamenický (Czech federation), on Czech Radio:

> *"Člověk se přesvědčí, že skutečnost sedí s mapou. Tam je údolí, tady je údolí, tam jsou skály, tady jsou skály."*
> — "A person convinces himself that reality matches the map. There's a valley there, here's a valley, there are
> rocks, here are rocks."

He was confident enough to **give directions to another runner** before realising he was wrong.
([Český rozhlas Vysočina](https://vysocina.rozhlas.cz/orientacni-bezci-nesvindluji-a-pokud-pri-zavodech-zabloudi-jedna-se-o-paralelni-7117592))

### How far off you get, and how it resolves

Usually **one feature over** — but it *persists*, because every subsequent observation keeps confirming it:

> *"you go several hundred metres up the wrong reentrant before anything starts to really look wrong"* —
> [BAOC, Errors to Avoid](http://baoc.org/wiki/Training/BulletinTrainingTips/Errors_to_Avoid)
> *"You can end up hundreds of metres off course before you realise, and then maybe have to cross several deep
> gullies and high ridges to get back."*

Documented extreme: **~1 km** (Kamenický, French championships).

**It does not resolve through fine detail** — only through a contradiction at a **scale larger than the repeating
unit**: overall landform, altitude, a major line feature, or a counted index of features.
**Preventive:** count each re-entrant/spur as you cross it. **Structural fix:** *"locate yourself in the bottom
before you go up, pick a spur in front of you, and go up it."*

**Time loss: [UNCERTAIN]** — no source quantifies it specifically. BAOC frames the escalation generically:
continuing blindly turns *"1-minute errors into 5-minute errors."*

### Parallel error vs map-memory error — the diagnostic to implement

| | **Parallel error** | **Map-memory error** |
|---|---|---|
| Map reading | **Correct**, applied to the **wrong instance** | Decayed / wrong internal picture |
| Does the terrain match? | **Yes — it genuinely fits** | **No — it fails to match** |
| Confidence | **Stays HIGH** | **Drops immediately** |
| Distance run before detection | hundreds of metres, sometimes ~1 km | ~100 m if you stop at once |
| Cost | **expensive** | cheap |

That confidence asymmetry is precisely **why the parallel error is the expensive one**, and it is what the
simulator must model: a parallel error must *not* trigger the player's "something is wrong" signal.

**Suggested state machine:**

```
state: {position_true, position_believed, confidence}
on each observed feature F:
    candidates = features_matching(F, near position_believed, tolerance)
    if |candidates| > 1 and terrain_is_repetitive:
        pick candidate nearest to position_believed   # NOT nearest to position_true
        confidence stays HIGH                          # ← the parallel error
    position_believed = chosen candidate
resolution:
    only when a LARGE-SCALE observation (landform / altitude / major line feature)
    is inconsistent with position_believed
```

## 6.13 Relocation (*zorientovat se*) — the standard procedure

[Orienteering ACT Lesson 11](https://act.orienteering.asn.au/resources/skills/advanced-skills/lesson-11-relocation/):

1. **STOP immediately** the moment features stop matching.
2. **Orient the map**; look in all directions — **including behind you**.
3. **Think big.** Examine **large** features first: contours, which hillside you are on, slope direction, valley
   orientation.
4. Only once the big picture fits, **confirm with smaller detail**.
5. Mentally **retrace to the last point of total contact**.
6. If still unsure, **move to the nearest large feature** and relocate from there.

> **"10 seconds of careful thinking can save 10 minutes."**

[CLOK](https://clok.org.uk/new/new-to-orienteering/getting-lost-and-found-again/) adds an explicitly
hypothesis-driven step: form a hypothesis, test it against a **distinctive** landmark, and **resume from your
confirmed position, not from where you expected to be**.

## 6.14 Other error types

| Error | Mechanism | Detection & cost |
|---|---|---|
| **180° / compass reversal** | Map held upside down, or the meridian lines not aligned N–S → *"you end up travelling exactly in the opposite direction."* | Uniquely, the terrain gives **no partial confirmation**, so it is caught fast at the first planned feature check. Prevention: verify the exit direction on leaving **every** control. Cost **[UNCERTAIN]**. |
| **Control picking** (*had kontrol*) | Chiefly a *training format*: short legs with sharp direction changes, drilling exit direction and attack. *"If a leg is short and you succeed to leave the control in the right direction, 90 % of the work is done."* | The associated real failure is **misjudging height** — running back and forth over the right feature. Turns a 1-min error into a 5-min error. |
| **"Boom"** | Antonym of "spike": a leg with seriously deficient route, contact or close navigation. | **Chiefly North-American colloquial** — it appears in no major club glossary checked (British Orienteering, Quantock, MVOC, Chicago AOC). Do not present it as standard terminology. |
| **"Bailing out"** | **No orienteering-specific definition found in any glossary checked. [UNCERTAIN — do not assert one.]** The nearest documented equivalent is relocation step 6 (go to the nearest large feature). |
| **Overshooting** | Going past a control or attack point. Note that the **deliberate** case (running past to a backstop, then attacking backwards) is legitimate tactics. | Countered by catching features and pace counting. |
| **Hesitation** | A **continuous** loss mode, not a discrete mistake: *"keeping a lower speed due to not having the situation under control"* ([o-training.net](https://o-training.net/blog/2011/04/13/gps-analysis-for-orienteering-the-basics/)). | **Budget:** elites spend **5–15 s** deciding on very long complex legs; exceeding **~30 s** in indecision *"likely loses more time than committing to the initial choice"* ([Better Orienteering](https://betterorienteering.org/intermediate-techniques/)). |

## 6.15 Time loss per control — the calibration numbers

| Level | Typical loss when a control goes wrong | Source |
|---|---|---|
| **Elite / professional** | **10–20 s** | [Norwegian glossary, *bomme*](https://oordliste.vercel.app/) |
| **Elite — threshold for a "bad error"** | **1 minute** | [CLOK](https://clok.org.uk/new/new-to-orienteering/getting-lost-and-found-again/) |
| **Beginner with good damage control** | 3–4 min | CLOK |
| **Beginner, uncontrolled** | minutes to tens of minutes | Norwegian glossary |

**The single most useful calibration datum.** At
[WOC 2014 Long](https://news.worldofo.com/2014/07/10/woc-long-2014-men-the-big-analysis/), the **gold medallist
(Gueorgiou) still lost 17 s, 24 s, 31 s, 18 s and 13 s at five separate controls.** Silver (Hubmann) lost
38/31/24/38 s; bronze (Lundanes) 46/39/22/66 s.
→ **A WOC-winning run contains roughly five identifiable losses of 13–31 s each.** A "perfect" run does not exist.

At [WOC 2025 Middle](https://news.worldofo.com/2025/07/10/woc-2025-middle-maps-results-and-analysis/), losses among
the top 8 ran **30 s to 2 min**, with a men's winning margin of **34 s** and one place decided by **1 second**.
Club-elite scale is an order of magnitude larger — at
[Jukola 2015](https://news.worldofo.com/2015/06/15/jukola-2015-gps-analysis-of-decisions-and-mistakes-in-the-relay/)
individual legs lost **3–5 min**, one team ~**10 min** on leg 1.

**The one published statistical result** — Ackland, WOC 2005,
[arXiv physics/0508158](https://arxiv.org/pdf/physics/0508158):

* Operational definition of a mistake: a loss of **> 45 s** on a leg.
* **"All errors of more than two minutes are made by orienteers running alone."** (Only one such incident in the
  entire men's race.)
* **Pack effect: an 8 % speed boost for the athlete behind; a pair moves 4 % faster than a solo runner.** Over an
  80-minute race that is ≈ **3 minutes**, plus near-elimination of large navigational errors.
  → **This is a directly implementable multiplayer mechanic.**

**How to score time loss** (pick one):

* [WinSplits Pro](http://obasen.orientering.se/winsplits/help.aspx?topic=terms&lang=en): per-leg
  **performance index = (mean of the fastest 25 % of splits) / (this runner's split)**; the runner's "normal
  performance" = the **leg-length-weighted median** of their indices; a leg counts as an error only if it exceeds
  **both** an absolute-time and a percentage threshold.
* [NNM Analyzer](https://anders.nemonisimors.com/projects/orienteering/orienteering.html): simpler — flag a leg
  if its %-loss exceeds the athlete's median %-loss by **more than 25 percentage points**.

**"Clean run" has no published quantitative definition [UNCERTAIN].** Operationally, given that a WOC winner still
drops 5 × 13–31 s, treat **clean ≈ no single loss above ~45 s**, not zero loss.
> *"It is almost impossible to have a perfect run and… some relocation is a normal part of what orienteering is all
> about."* — [Better Orienteering](https://betterorienteering.org/analyze-my-errors/)

---
---

# 7. Race formats (IOF Competition Rules 2025 — §15, §16, Appendix 2, Appendix 6)

## 7.1 The normative summary table (Appendix 6, verbatim structure)

| | **Sprint** | **Middle** | **Long** | **Relay** | **Sprint Relay** | **Knock-Out Sprint** |
|---|---|---|---|---|---|---|
| **Controls** | Technically easy | Consistently technically difficult | A mixture of technical difficulties | A mixture of technical difficulties | Technically easy | Technically easy |
| **Route choice** | Difficult route choice, requiring high concentration | Small and medium scale route choice | Significant route choice including some **large-scale** route choices | Small and medium scale route choice | Difficult route choice, high concentration | Difficult route choice, high concentration |
| **Type of running** | Very high speed | High speed, but requiring competitors to **adjust their speed** for the complexity of the terrain | **Physically demanding**, requiring endurance and **pace judgement** | High speed, often in close proximity to other competitors who may or may not have the same controls | Very high speed | Very high speed |
| **Terrain** | Predominantly very runnable **park or urban** (streets/buildings). Some fast runnable forest may be included. **Spectators allowed along the course** | **Technically complex** terrain | **Physically tough** terrain allowing good route-choice possibilities | Some route-choice possibilities and reasonably complex terrain | as Sprint; spectators allowed along the course | as Sprint; spectators allowed along the course |
| **Map** | **1:4 000** | **1:10 000** | **1:15 000** | **1:10 000** | **1:4 000** | **1:4 000** |
| **Start interval** | **1 min** | **2 min** | **3 min** | Mass start | Mass start | 1 min (qualification), mass start (knock-out rounds) |
| **Timing** | 1 s | 1 s | 1 s | order across the line | order across the line | 1 s (qual.), order across the line (KO) |
| **Winning time (senior elite)** | **12–15 min** | **30–35 min** (qualification shorter) | **88–92 min** (qualification shorter) | **30–40 min/leg, 90–105 min total** | **12–15 min/leg, 55–60 min total** | **8–10 min** qual., **6–8 min** knock-out rounds |

## 7.2 Winning times — the exact tables

### Rule 16.10 — WOC / World Cup

| Race | Women | Men |
|---|---|---|
| **Long distance final** | **88–92** | **88–92** |
| **Middle distance qualification** | **25** | **25** |
| **Middle distance final** | **30–35** | **30–35** |
| **Sprint qualification** | **12–15** | **12–15** |
| **Sprint final** | **12–15** | **12–15** |
| **Sprint Relay, each leg** | **12–15** | **12–15** |
| **Sprint Relay, overall** | **55–60** | |
| **Relay, each leg** | **30–40** | **30–40** |
| **Relay, overall** | **90–105** | **90–105** |
| **Knock-Out Sprint qualification** | **8–10** | **8–10** |
| **Knock-Out Sprint mass-start races** | **6–8** | **6–8** |

**Rule 16.9:** *"Where the winning time is expressed as an interval, the course must be planned with the aim of
achieving a winning time at the **middle point** of the interval."*

**Long-distance qualification** is not listed in 16.10, but Appendix 6 §3.4 states: *"In WOC and World Cup the
winning times in qualification races must be **60 minutes**."* (Appendix 6 §2.4 gives Middle qualification as
**25 minutes**, consistent with 16.10.)

### Rule 16.11 — JWOC

Long **70** · Middle **20–25** · Sprint **12–15** · Relay **30–40** per leg / **90–105** total.

### Rule 16.13 — World Ranking Events (WRE)

Long **88–92** · Middle **30–35** · Sprint **12–15**.

### Rule 16.12 — WMOC (age classes; a useful ladder for a game's difficulty curve)

Winning times taper with age. Sample rows (minutes: qualification / Middle final / Long final):
W35/M35 **50 / 30–35 / 70** … M50 **45 / 25–30 / 55** … M55–M65 **40 / 25–30 / 50** … M70–M75 **35 / 25–30 / 50** …
M80–M85 **35 / 25–30 / 45** … M90 **30 / 25–30 / 40**. *All* WMOC Sprint races are **12–15 min**.

## 7.3 Course length, climb, control count

**The IOF rules do not specify course length in km, nor the number of controls, for any format.** Length is a
*derived* quantity — the planner works backwards from the mandated winning time. The only hard numbers are:

| Quantity | Rule | Value |
|---|---|---|
| **Maximum climb** | App. 2 §3.11.6 | *"The total climb of a course should **normally not exceed 4 % of the length of the shortest sensible route**."* **One global figure, not varied by format.** |
| **How length is measured** | 16.3 | Straight line start → controls → finish, deviating **only** for physically impassable obstructions, prohibited areas and marked routes |
| **How climb is measured** | 16.4 | Climb in metres **along the shortest sensible route** |
| **Control separation, forest scales** | 19.4 | ≥ **30 m** between any two controls incl. the start flag; ≥ **60 m** straight-line if the features are **similar** |
| **Control separation, sprint scales** | 19.4 | minimum **running** distance **25 m**; minimum **straight-line** distance **15 m**; no similar-feature rule |
| **Long-distance long legs** | App. 6 §3.2 | *"These longer legs may be from **1.5 to 3.5 km** depending on the terrain type. **Two or more** such long legs should form part of the course."* |
| **Refreshments** | 19.8 | winning time ≥ 30 min → refreshment at least every **25 min at the winner's pace** |

### Real elite course specifications (World Orienteering Championships)

These are **measured, not derived** — course specs from the official worldofo previews, winning times from the
official results. Use them as the calibration truth set for the course generator.

| Year | Venue | Format | Sex | Winner | Time | Length | Climb | Controls | min/km |
|---|---|---|---|---|---|---|---|---|---|
| 2021 | Doksy CZE | Long | M | Fosser | 1:35:55 | 13.6 km | **1050 m** | 29 | 7:03 |
| 2023 | Flims SUI | Long | M | Fosser | 1:33:06 | 14.0 km | 680 m | 35 | 6:39 |
| 2025 | Kuopio FIN | Long | M | Fosser | 1:37:50 | 16.0 km | 565 m | 27 | 6:07 |
| 2021 | Doksy | Long | W | Alexandersson | 1:17:11 | 9.5 km | 690 m | 21 | 8:07 |
| 2023 | Flims | Long | W | Aebersold | 1:21:43 | 11.0 km | 510 m | 23 | 7:26 |
| 2025 | Kuopio | Long | W | Aebersold | 1:34:51 | 13.3 km | 475 m | 23 | 7:08 |
| 2021 | Doksy | Middle | M | Kyburz | 39:31 | 5.4 km | 320 m | 24 | 7:19 |
| 2023 | Flims | Middle | M | Kyburz | 38:19 | 5.9 km | 220 m | 22 | 6:30 |
| 2025 | Kuopio | Middle | M | Breivik | 33:42 | 5.8 km | 255 m | 18 | 5:49 |
| 2021 | Doksy | Middle | W | Alexandersson | 38:12 | 4.5 km | 260 m | 20 | 8:29 |
| 2023 | Flims | Middle | W | Alexandersson | 37:26 | 4.8 km | 180 m | 19 | 7:48 |
| 2025 | Kuopio | Middle | W | Alexandersson | 33:17 | 5.0 km | 230 m | 16 | 6:39 |
| 2021 | Terezín CZE | Sprint | M | von Krusenstierna | 13:46 | 3.9 km | 40 m | 24 | 3:32 |
| 2024 | Edinburgh GBR | Sprint | M | Regborn | 15:58 | 4.3 km | 85 m | 22 | 3:43 |
| 2021 | Terezín | Sprint | W | Alexandersson | 14:03 | 3.5 km | 40 m | 20 | 4:01 |
| 2024 | Edinburgh | Sprint | W | Alexandersson | 16:14 | 3.8 km | 70 m | 18 | 4:16 |

Sources: worldofo "All You Need To Know" previews
([2021](http://news.worldofo.com/2021/06/30/woc-2021-all-you-need-to-know/) ·
[2023](http://news.worldofo.com/2023/07/10/woc-2023-all-you-need-to-know/) ·
[2024](http://news.worldofo.com/2024/07/11/woc-2024-all-you-need-to-know/) ·
[2025](http://news.worldofo.com/2025/07/07/woc-2025-all-you-need-to-know/)); results from the WOC results pages.

**Note the 4 % climb guideline is routinely exceeded at WOC Long** — Doksy 2021 was 1050 m over 13.6 km = **7.7 %**.
Appendix 2 says "should normally not exceed 4 %", not "must not".

**⚠ Women's Long winning times jumped in 2024 because of a rule change, not fitness.** Before 2024 the IOF Forest
Course Planning Guidelines specified *"70–80 minutes for women and 90–100 minutes for men"*; the 2024 rules
changelog records *"Winning times equalised for Men and Women"* — both are now **88–92 min**. Do not fit a single
curve across women's Long from 2019 to 2025.
([IOF Guidelines for Forest Course Planning, Jun 2020](https://onsw.asn.au/images/stories/technical/IOF_Guidelines_for_Forest_Course_Planning_-_Jun_2020.pdf))

### Design envelope for the course generator **[derived from the table above + §8]**

| Format | Winning time | **Men** length / climb / controls | mean leg | **Women** length / climb / controls |
|---|---|---|---|---|
| **Long** | 88–92 min | **13.5–16 km** / **475–1050 m** / **27–35** | 450–600 m | **9.5–13.5 km** / **475–700 m** / **21–24** |
| **Long qualification** | 60 min | 9–11 km / 300–500 m / 18–24 | 450–600 m | 7–9 km / 250–400 m / 16–22 |
| **Middle** | 30–35 min | **5.4–6.0 km** / **220–320 m** / **18–24** | 250–330 m | **4.5–5.0 km** / **180–260 m** / **16–20** |
| **Middle qualification** | 25 min | 4.2–4.8 km / 150–250 m / 15–20 | 250–330 m | 3.4–4.0 km / 130–200 m / 14–18 |
| **Sprint** | 12–15 min | **3.9–4.3 km** / **40–85 m** / **22–24** | 160–200 m | **3.5–3.8 km** / **40–70 m** / **18–20** |
| **Relay (per leg)** | 30–40 min | 5.5–7.5 km / 200–350 m / 18–26 | 280–380 m | 4.5–6.0 km / 170–280 m / 16–22 |
| **Sprint Relay (per leg)** | 12–15 min | 3.5–4.2 km / 30–80 m / 18–24 | 160–200 m | 3.2–3.8 km / 30–70 m / 17–22 |
| **KO Sprint qualification** | 8–10 min | 2.4–3.0 km / 20–50 m / 13–18 | 160–200 m | 2.2–2.7 km / 20–50 m / 13–18 |
| **KO Sprint rounds** | 6–8 min | 1.8–2.4 km / 15–40 m / 10–15 | 160–200 m | 1.6–2.1 km / 15–40 m / 10–15 |

**Straight-line pace the numbers encode** (min per km of *stated* course length, elite winners):

| Format | Men | Women |
|---|---|---|
| Long | **6:05 – 7:05** | **7:05 – 8:10** |
| Middle | **5:50 – 7:20** | **6:40 – 8:30** |
| Sprint | **3:30 – 3:45** | **4:00 – 4:20** |

Aggregate over WOC 2009–2019, top-30 (Nazário & Correia 2022,
[JPES 22(2) Art. 67](http://www.efsupit.ro/images/stories/februarie2022/Art%2067.pdf), 44 races):
men Middle **9.5 ± 0.7 km/h**, Long **9.3 ± 0.9 km/h**; women Middle **7.6 ± 0.6 km/h**, Long **7.5 ± 0.9 km/h**.
Winning-time coefficient of variation: Long **5.6 % (M) / 4.9 % (W)**, Middle **2.5 % / 2.7 %**.

## 7.4 Design philosophy — the rules' own words (Appendix 6)

### Sprint (§1.1)
> *"The Sprint profile is **high speed**. It tests the competitors' ability to **read and translate the map in
> complex environments**, and to plan and carry out route choices running at high speed. The course must be planned
> so that the element of speed is maintained throughout the race. The course may require climbing but **steepness
> forcing the competitors to walk should be avoided**. **Finding the controls should not be the challenge**; rather
> the ability to choose and complete the best route to them. For example, **the most obvious way out from a control
> should not necessarily be the most favourable one**. The course should be set to require the competitors' full
> concentration throughout the race."*

Course-planning: spectators are allowed along the course, **all controls must be manned**, guards may be needed at
critical passages, the start should be at the arena, and *"the course must be planned to avoid tempting competitors
to take shortcuts through private property and other out-of-bounds areas."*

### Middle (§2.1)
> *"The Middle distance profile is **technical**. It takes place in a non-urban (mostly forested) environment with
> an emphasis on **detailed navigation** and where **finding the controls constitutes a challenge**. It requires
> **constant concentration on map reading** with occasional shifts in running direction out from controls. The
> element of route choice is essential but should not be at the expense of technically demanding orienteering. The
> route in itself must involve demanding navigation. **The course must require speed-shifts** e.g. with legs
> through different types of vegetation."*

Map: *"The terrain must be mapped for 1:15 000 and then be **strictly enlarged** as specified by ISOM."*
Spectators **not** allowed along the course except at the arena passage.

### Long (§3.1)
> *"The Long distance profile is **physical endurance**. … aims at testing the competitors' ability to make
> **efficient route choices**, to read and interpret the map and **plan the race for endurance** during a long and
> physically demanding exercise. The format emphasises **route choices and navigation in rough, demanding terrain,
> preferably hilly**. **The control is the end-point of a long leg with demanding route choice, and is not
> necessarily in itself difficult to find.** The Long distance may in parts include elements characteristic of the
> Middle distance with the course suddenly breaking the pattern of route choice orienteering to introduce a section
> with more technically demanding legs."*

Plus (§3.2): long legs of **1.5–3.5 km**, **two or more** of them; **butterfly loops** to break up groups; and
*"the terrain itself should be used as a break-up method by putting the course through areas with limited
visibility."*

### Relay (§4.1)
> *"The Relay profile is **team competition**. … The format is built on a **technically demanding concept, more
> similar to the concept of the Middle than the Long distance**. Some elements characteristic of the Long distance,
> like longer, route-choice legs should occur, allowing competitors to pass each other **without making contact**.
> **Good Relay terrain has characteristics that make competitors lose eye contact with each other** (such as denser
> vegetation, many hills/depressions etc.). **Terrain with continuous good visibility is not suitable for the
> Relay.**"*

### Sprint Relay (§5.1)
> *"mixed-sex high-speed head-to-head competition … **four legs** and **the first and last legs must be run by
> women**."* Winning total **55–60 min**, each leg **12–15 min**, *"so the first and last legs (which are run by
> women) should be a little shorter than the second and third legs."*

### Knock-Out Sprint (§6.1)
> *"individual multiple-round high-speed competition with **head-to-head racing in all but the first round**. …
> parallel heats with an interval start to qualify for the knock-out section. In this there are one or more
> knock-out rounds with several parallel heats and mass starts where the leading competitors qualify for the next
> round. Finally, there is a single mass start race to determine the winner."*

## 7.5 Relay forking

### What the rules actually mandate

| Rule | Text |
|---|---|
| **16.6** | *"In relay competitions, the controls must be **combined differently** for the teams, but **all teams must run the same overall course**. If the terrain and the concept of the courses permit it, the lengths of the legs may be significantly different. However, the sum of the winning times of the legs must be kept as prescribed. **All teams must run the different length legs in the same sequence.**"* |
| **16.7** | Same principle for individual competitions — *"all competitors must run the same overall course"* — **except** Knock-Out Sprint "Course Choice" forking. |
| **App. 6 §4.2** | *"The mass start format requires a course planning technique separating competitors from each other (e.g. **forking**). **The best teams should be carefully allocated to different forking combinations.** For fairness reasons **the different variants of each forking should be equal in running time** (assuming competitors are in equal shape and making no mistakes) and **the very last part of the last leg must be the same for all competitors.**"* |
| **App. 2 §3.10** | *"Course planning for relays should incorporate a good and sufficient **forking/splitting system**."* |
| **12.14** | Course-combination allocation is supervised by the IOF Event Adviser and **kept secret until after the last competitor has started**. |
| **22.11 / 22.13 / 24.8** | Changeover **by touch**; the incoming runner may collect and hand over the outgoing runner's map as the touch. Mass starts for later legs need IOF Event Adviser approval; teams in such mass starts are placed **after** all teams that changed over normally, ranked by the sum of individual times. |

### Named forking schemes — a terminology warning

**"Farsta", "Motala" and "phi loop" appear nowhere in the IOF Competition Rules.** The rules use only *forking*,
*butterfly loops* (named once, in the **Long distance** section §3.2) and *course choice forking* (KO Sprint only).
The named schemes below are **community / national-federation / course-planning-software terminology**, and the
descriptions are the widely-used working definitions — **they are not IOF-normative and should be treated as
**[UNVERIFIED against a primary source]**:

* **Butterfly / cloverleaf loops** — a central control from which 2–3 loops radiate; each runner does all the loops
  but in a different order, returning to the centre between each. Total distance identical for everyone; runners
  who were together are split apart at the hub. Explicitly endorsed by the rules for the Long distance.
* **Phi loop (Φ-loop)** — the degenerate butterfly with a single loop plus a stem: runners either do the loop first
  or the stem first.
* **Farsta forking** — named after the Swedish club/relay; a block of the course is split into two or three
  variants (A/B/C) that visit different controls between the same entry and exit control. Every team runs every
  variant, but distributed across their legs, so a team's *set* of variants is the same.
* **Motala forking** — a butterfly variant in which a runner does two of three available loops, with the
  combination varying between legs.

**What is safe to implement:** the *constraint*, not the taxonomy —
`for each team: multiset(controls visited across all legs) is identical` ∧
`for each forking: all variants ≈ equal running time` ∧
`the final stretch of the last leg is common to all` ∧
`all teams run the different leg lengths in the same sequence`.

### Spectator control / arena passage

| Format | Rule |
|---|---|
| **Relay** | *"the competitors should, **on each leg, pass the Arena**, and if possible competitors should be **visible from the Arena while approaching the last control**."* An appropriate number of intermediate times, in-forest commentators and TV controls shown on screen. **Spectators not allowed along the course except at the arena passage (including controls at the arena).** |
| **Middle, Long** | Same restriction — spectators only at the arena passage. The start should be at the arena and the course *should preferably* pass the arena. |
| **Sprint, Sprint Relay, KO Sprint** | **Spectators ARE allowed along the course.** Sprint additionally requires **all controls to be manned**. |
| **Sprint Relay (§5.2)** | *"It should be possible to cover at least **70–80 %** of the course with TV cameras. The competition should be based on a **75 minute** live broadcasting and arena production concept; **15 minutes** should be allocated for broadcasting introductions, interviews and prize-giving. An arena passage should be used, if possible … **Two loops per leg** should be used if there is an arena passage with **one loop printed on each side of the map**. **Courses must be forked. GPS-tracking is required and contactless punching should be considered.**"* |
| **KO Sprint (§6.2)** | Same 70–80 % TV coverage figure; GPS-tracking required. |

## 7.6 Qualification races and knock-out structure

### General qualification

| Rule | Content |
|---|---|
| **16.5** | *"For qualification races, the courses for the parallel heats must be **as nearly as possible of the same length and standard**."* |
| **22.2** | *"the first start in the finals must be **at least 2.5 hours** after the last start in the qualification races"* (except KO Sprint). |
| **12.8** | Heats must be *"as far as possible equally strong"*; competitors from the same Federation must **not start at consecutive times** within a heat and are *"distributed **as equally as is mathematically possible** among the heats."* Start pattern is either **as many competitors as there are parallel heats start at each start time**, or competitors start at intervals in heat order (H1, H2, H3, H1, H2, H3…). |
| **12.10** (WOC Sprint & Middle finals) | *"only the competitors placed **number 15 and better in each qualification race heat** may participate."* Further places up to a **maximum of 60**: (a) the best-placed runner from Federations with nobody in the top 15 of any heat, ordered by heat placing (ties broken by least time behind their heat winner); (b) all tied runners from different countries for the last place qualify; (c) **an athlete must have been within 100 % of the heat winner's time** to be selected under (a) or (b). |
| **12.9** | Ties for a final place → **all** tied competitors qualify. |
| **12.11** | Final start order *"must be the **reverse** of the placings in the qualification race heats; **the best competitors start last**."* Ties decided by lot. Equal placings across parallel heats start in heat-number sequence, so **the winner of the highest-numbered heat starts last**. |
| **12.13** | Heat allocation drawn under IOF Event Adviser supervision. |

### Knock-Out Sprint (Rule 12.24) — four stages

| Stage | Structure | Advance |
|---|---|---|
| **Qualification** | **3 parallel heats**, interval start, **1 min interval with three competitors starting on each minute** | **top 12 in each heat** → 36 runners |
| **Quarter-finals** | **6 QFs × 6 runners**, mass start. Allocation either (a) runners **choose** their heat in the order 6th→1st, then 7th→36th by qualification ranking, or (b) a fixed serpentine table (QF1 = 1H3, 4H1, 5H2, 8H3, 9H1, 12H2; etc.). The option must be approved by the IOF Event Adviser and published in **Bulletin 4** | **top 3** in each QF → 18 |
| **Semi-finals** | **3 SFs × 6 runners**, mass start. QF1+QF2 → SF1; QF3+QF4 → SF2; QF5+QF6 → SF3 | **top 2** in each SF → 6 |
| **Final** | **6 runners, mass start**, first past the post | — |

Ties for any qualification place → ranked by **Sprint World Ranking as at 12:00 the day before the first race of
the event**; still tied → random draw. Fewer finishers than places → **the place is left vacant** in the next round.
**Fewer than 45 entered** → the number of qualification heats and knock-out stages may be reduced. Rule 22.3 allows
the normal 30-minute undisturbed warm-up to be **reduced** between the Semi-Final and Final.

---
---

# 8. Running speed model

## 8.1 Tobler's hiking function (the classic baseline — and why it is not enough)

**Tobler 1993**, *Three Presentations on Geographical Analysis and Modeling*, NCGIA Technical Report 93-1:

```
W = 6 · exp( −3.5 · | S + 0.05 | )          W in km/h,  S = dh/dx  (rise over run, dimensionless)
```

| Property | Value |
|---|---|
| **Maximum speed** | **6.000 km/h at S = −0.05** (2.86° downhill = `arctan 0.05`) |
| **Flat (S = 0)** | `6·e^(−0.175)` = **5.037 km/h = 1.399 m/s** |
| **Off-path multiplier (Tobler's own)** | **× 3/5 = 0.6** → 3.6 km/h maximum off-path |
| On horseback | × 5/4 |
| **m/s form** | `W = 1.6667 · exp(−3.5·|S+0.05|)`; off-path `W = 1.0 · exp(−3.5·|S+0.05|)` |
| Pace form | `p = 0.6 · exp(3.5·|S+0.05|)` s/m |

Sources: [Wikipedia (citing the primary report)](https://en.wikipedia.org/wiki/Tobler%27s_hiking_function);
implementation verified in the R [`movecost`](https://www.rdocumentation.org/packages/movecost/versions/0.4)
package (`6 * exp(-3.5 * abs(x + 0.05))`, off-path `* 0.6`).

> **Do not use Tobler as the gradient term for an orienteering simulator.** It is a **walking** function and its
> slope penalty is materially gentler than running's. At +10 % gradient Tobler gives **0.705** of flat speed;
> running metabolics give **0.603**. Tobler is included here because it is the reference everyone knows — the model
> in §8.5 replaces its gradient term.

### Other classical models, for completeness

| Model | Statement | Implied climb equivalence |
|---|---|---|
| **Naismith (1892)** | 1 h per 3 mi (5 km) forward + 1 h per 2000 ft (600 m) ascent | **1 m climb ≡ 7.92 m horizontal** |
| **Langmuir correction** | Base 4 km/h + 1 h per 450 m ascent (group pace). Descent: **−10 min per 300 m** for slopes 5–12°; **+10 min per 300 m** for slopes **> 12°** | — |
| **Aitken (1977)** | 5 km/h on paths/roads, **4 km/h off-path**, +1 h per 600 m ascent | — |
| **Scarf (2007)** *J Sports Sci* 25(6):719–726, [PubMed 17454539](https://pubmed.ncbi.nlm.nih.gov/17454539/) | Verbatim: *"it is recommended that **male runners and walkers use a 1:8 equivalence ratio and females a 1:10 ratio**."* Contrasts: treadmill data **1:3.3**, mountain road-relay **1:4.4**, cycling **1:8.2**. Derived from fell-running records. | 8 (M) / 10 (W) |
| **Irmischer & Clarke (2018)** *Cartography and GIS* 45(2):177–186 | On-path `(0.11 + exp(−(|S|·100 + 5)² / (2·30)²)) · 3.6` km/h; off-path `(0.11 + 0.67·exp(−(|S|·100 + 2)² / (2·30)²)) · 3.6` | — |

All of these are **walking** models. Scarf's 1:8 is the closest to useful because it is derived from *runners*, but
the orienteering-specific measurement in §8.4 (**EF = 6.3**) is better still.

## 8.2 Minetti et al. 2002 — the running metabolic cost curve (use this uphill)

Minetti, Moia, Roi, Susta & Ferretti, *"Energy cost of walking and running at extreme uphill and downhill slopes"*,
**J Appl Physiol 93:1039–1046 (2002)**, [PubMed 12183501](https://pubmed.ncbi.nlm.nih.gov/12183501/).
Verbatim from the Fig. 1 caption: *"5th-order polynomial regressions were performed, that yielded"*

```
Cw(i) = 280.5·i⁵ − 58.7·i⁴ − 76.8·i³ + 51.9·i² + 19.6·i + 2.5      (walking,  R² = 0.999)
Cr(i) = 155.4·i⁵ − 30.4·i⁴ − 43.3·i³ + 46.3·i² + 19.5·i + 3.6      (RUNNING,  R² = 0.999)
```

Units **J·kg⁻¹·m⁻¹**; `i` = gradient (positive uphill); **valid range −0.45 ≤ i ≤ +0.45**.
Fitted efficiencies: uphill 26 %, downhill 150 %.

Verified by direct evaluation of the polynomial (matches the paper's measured values):

| i | −0.45 | −0.30 | **−0.181** | −0.10 | **0** | +0.10 | +0.20 | +0.30 | +0.45 |
|---|---|---|---|---|---|---|---|---|---|
| **Cr(i)** | 4.03 | 2.13 | **1.781 (minimum)** | 2.05 | **3.600** | 6.00 | 8.99 | 12.6 | 19.43 |

Paper's measured comparators: 3.40 ± 0.24 level, 18.93 ± 1.74 at +0.45, 1.73 ± 0.36 at −0.20, 3.92 ± 0.81 at −0.45.

> **Trap:** naively scaling speed as `1/Cr` predicts **2.0× flat speed at −18 %**. That is physically false —
> downhill running is limited by **eccentric braking and foot placement**, not aerobic cost. The downhill branch
> must be replaced by an empirical curve.

## 8.3 The downhill fix — Strava's empirical Grade Adjusted Pace

Built from **~6 million runs by ~240 000 athletes** using heart-rate-normalised efficiency
([Strava Engineering](https://medium.com/strava-engineering/an-improved-gap-model-8b07ae8886c3)):

* **Minimum pace adjustment 0.88 at −9 %** → only about a **12 % speed gain** at the downhill optimum.
* Returns to **1.00 at −18 %**, then gets worse.
* Uphill: nearly identical to Minetti (~2 % rightward shift).
* Strava explicitly rejects the naive Minetti downhill: *"The old model predicted a minimum adjustment of 0.5 at
  −18 %, implying runners should be 100 % faster downhill."*

Independently corroborated **in orienteering**: EOC 2018 elite GPS data puts the speed optimum at **−3 % to −7 %**
([Wolff, Hachmeister & Schiewe, LBS 2019](https://lbs2019.lbsconference.org/wp-content/uploads/2019/11/3_5.pdf)).

## 8.4 Calibration anchors

| Finding | Value | Source |
|---|---|---|
| **ISOM reference speed** | *"If speed through **flat and open runnable forest is 4 min/km**…"* = **4.167 m/s** | ISOM 2017-2 §2.3 |
| **OCAD Route Analyzer base speed** | *"**200 sec/km for men and 230 sec/km for women** can be used for route time calculation on an international level."* → ratio **1.15** | [OCAD wiki](https://www.ocad.com/wiki/ocad/en/index.php?title=Route_Analyzer) |
| Consistency check | 200 s/km × 0.83 (ISOM: forest = 80–100 % of path) = 241 s/km ≈ **4:00/km** — the two specs agree | — |
| **Running economy, path vs heavy terrain** | Impaired by **41–52 %**; less in orienteers (41 %) than track runners (52 %). Path baseline 217 ± 12 (orienteers) / 212 ± 14 (track) ml·kg⁻¹·km⁻¹ | Jensen, Johansen & Kärkkäinen 1999, *J Sports Sci* 17(12):945–50, [PubMed 10622354](https://pubmed.ncbi.nlm.nih.gov/10622354/) |
| **Forest vs road O₂ cost** | **+26 %**; range **26–72 %** depending on surface and gradient | Creagh & Reilly 1997, *Sports Med* 24(6), [link](https://link.springer.com/article/10.2165/00007256-199724060-00005) |
| **World-class orienteers, max running velocity** | Horizontal **20.4 ± 0.6 km/h (M) / 17.3 ± 0.8 (W)**; uphill at 22 % **8.8 ± 0.7 / 7.2 ± 0.5 km/h** | Lauenstein, Wehrlin & Marti 2013, *JSCR* 27(11), [PubMed 23442282](https://pubmed.ncbi.nlm.nih.gov/23442282/) |
| **VO₂peak, world-class orienteers** | Uphill 69.2 ± 5.7 (M) / 59.1 ± 3.7 (W); horizontal 66.4 ± 3.5 / 55.7 ± 3.1 ml·kg⁻¹·min⁻¹ | Lauenstein 2013 |
| **★ Climb ↔ distance equivalence, MEASURED on orienteers** | **EF = 6.3 ± 0.7** (range 5.2–7.4). Applied to WOC as **6.2 (M) / 6.4 (W)**: `equiv_km = length + climb_km × EF` | Lauenstein 2013; applied by [Nazário & Correia 2022](http://www.efsupit.ro/images/stories/februarie2022/Art%2067.pdf) |

**Converting the O₂-cost ladder to a speed ladder** (at constant race intensity, speed ∝ 1/cost):
road 1.00 → forest 1/1.26 = **0.79** → heavy terrain 1/1.41 = **0.71** → worst case 1/1.72 = **0.58**.
This independently brackets ISOM's 80–100 % and 60–80 % bands.

### Men : women base-speed ratio = **1.15**, not 1.28

Three-way agreement:
1. OCAD's published 230/200 s/km = **1.15**
2. Solving for the ratio that makes the model reproduce **both** sexes' WOC times with the **same** detour factor
   gives **1.15** (residual 0.001)
3. The observed winner-vs-winner straight-line pace ratio across the six WOC forest races in §7.3 is **1.157**

> **Audit note.** The widely quoted **1.28** ratio (Nazário & Correia) is the **top-30 mean over 2009–2019**, when
> women raced 70–80 min against the men's 90–100 min. For **winner-level base speed use 1.15–1.17**, not 1.28.

## 8.5 The gradient factor — the recommended formula

```
                 Cr(0) / Cr(g)                    for  g ≥ 0            [Minetti 2002, running]
f_grad(g)  =     1 − 16.8·g·(g + 0.18)            for  −0.18 ≤ g < 0    [fitted to Strava GAP]
                 exp( −3.5·(|g| − 0.18) )         for  g < −0.18        [Tobler-shaped tail]

where Cr(i) = 155.4·i⁵ − 30.4·i⁴ − 43.3·i³ + 46.3·i² + 19.5·i + 3.6,  Cr(0) = 3.600
```

The middle branch is C⁰-continuous at both ends (`f(0) = 1.000`, `f(−0.18) = 1.000`) and peaks at
**1.136 at g = −0.09**, matching Strava's empirical minimum pace adjustment of 0.88.

| gradient | −0.40 | −0.30 | −0.20 | **−0.09** | −0.05 | **0** | +0.05 | +0.10 | +0.15 | +0.20 | +0.30 | +0.40 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **f_grad** | 0.463 | 0.657 | 0.932 | **1.136** | 1.109 | **1.000** | 0.768 | 0.603 | 0.485 | 0.400 | 0.286 | 0.214 |
| implied EF | — | — | — | — | — | — | **6.03** | **6.58** | **7.07** | **7.51** | 8.31 | 9.20 |

**★ The key validation.** The **implied** climb-equivalence factor over the realistic orienteering range (0–20 %)
is **6.0–7.5**, centred on Lauenstein's independently **measured EF = 6.3 ± 0.7 (range 5.2–7.4)** on Swiss
world-class orienteers. A model built from treadmill metabolics and Strava's 6-million-run dataset agrees with a
field measurement on elite orienteers to within noise. *(Compare Naismith's 7.92 and Scarf's 8 — both a little
steep, because they are fell-running/hiking records rather than orienteering.)*

**Cheap global approximation** (use this for course-length estimation, not per-step simulation):
`d_equiv = d + 6.2 × climb` (men) / `d + 6.4 × climb` (women), both in metres.

## 8.6 Terrain multipliers per ISOM symbol

Reference = **ISOM 405 white forest, flat = 1.00**. These reconcile ISOM's normative bands (§1.4) with the only
published per-symbol table, **Le & Eichler (2017)**,
[CEUR-WS Vol-2020 paper 5](https://ceur-ws.org/Vol-2020/paper5.pdf) — *"An open forest (ISOM-ID 405) is the
reference that will be set to a normalized, unitless speed value of 100."* Where the two conflict, **ISOM wins**
(e.g. Le & Eichler give open land 90, but ISOM 401 explicitly *"offers better runnability than typical open
forest"*).

| ISOM | Terrain | **Multiplier** | **Men m/s** | **min/km** | **Women m/s** | **min/km** | ISOM band |
|---|---|---:|---:|---|---:|---|---|
| 501 / 502 / 503 | Paved area, wide road, road | **1.30** | 5.42 | 3:04 | 4.71 | 3:32 | > 100 % |
| 504 / 505 | Vehicle track, footpath | **1.20** | 5.00 | 3:19 | 4.35 | 3:49 | > 100 % |
| 506 | Small footpath | **1.12** | 4.67 | 3:34 | 4.06 | 4:06 | > 100 % |
| 507 / 508 | Less distinct path / narrow ride | **1.05** | 4.38 | 3:48 | 3.80 | 4:22 | ~100 % |
| 401 / 402 | Open land (yellow) | **1.10** | 4.58 | 3:38 | 3.99 | 4:10 | > 100 % |
| 403 / 404 | Rough open land | **0.95** | 3.96 | 4:12 | 3.44 | 4:50 | 80–100 % |
| **405** | **Forest, white — REFERENCE** | **1.00** | **4.17** | **3:59** | **3.62** | **4:35** | 80–100 % |
| 406 / 407 | Vegetation: slow running (green 30 %) | **0.70** | 2.92 | 5:42 | 2.54 | 6:34 | 60–80 % |
| 408 / 409 | Vegetation: walk (green 60 %) | **0.40** | 1.67 | 9:59 | 1.45 | 11:29 | 20–60 % |
| 410 | Vegetation: fight (green 100 %) | **0.12** | 0.50 | 33:19 | 0.43 | 38:19 | < 20 % |

### Multiplicative overlays (screens laid on top of a base area symbol)

| ISOM | Overlay | Multiplier | Basis |
|---|---|---:|---|
| 210 | Stony ground, slow running | **0.75** | ISOM: 60–80 % |
| 211 | Stony ground, walk | **0.45** | ISOM: 20–60 % |
| 212 | Stony ground, fight | **0.15** | ISOM: < 20 % |
| 213 | Sandy ground | **0.75** | ISOM: "< 80 %" |
| 214 | Bare rock | **1.00** | ISOM: "runnable"; less-runnable bare rock is drawn 210–212 |
| 208 | Boulder field | **0.95** | ISOM: *"will generally not impact runnability"* |
| 209 | Dense boulder field | **0.45** | **[UNCERTAIN — inferred]** ISOM says only "runnability is affected" |
| 113 | Broken ground | **0.90** | **[UNCERTAIN]** ISOM: *"little impact on runnability"* |
| 114 | Very broken ground | **0.70** | **[UNCERTAIN]** ISOM: *"affects runnability"* |
| 308 | Marsh | **0.55** | **[UNCERTAIN — no ISOM figure exists]**; ISOM says marsh *"shall be combined with other symbols to show runnability"* |
| 310 | Indistinct marsh | **0.80** | **[UNCERTAIN]** |
| 412 | Cultivated land | **0.70** | **[UNCERTAIN]** — highly seasonal; ISOM says to avoid it for courses |
| 302 | Shallow body of water | **0.35** | **[UNCERTAIN]** — "< 0.5 m deep and runnable" |

### Impassable / forbidden

`201` Impassable cliff · `206` Gigantic boulder · `301` Uncrossable water · `307` Uncrossable marsh ·
`515` Impassable wall · `518` Impassable fence · `521` Building · `529` Prominent uncrossable line feature
→ **multiplier 0** (blocked edge in the routing graph).
`520` / `708` / `709` / `711` and, in sprint, the full Rule-17.2 list (§2.6) → **0, and entering = DSQ**.

### Combination rule — mandated by ISOM §2.3

> *"A combination of a green screen and stony ground means that the runnability will be **worse than for each of
> them in isolation**."*

```
M_terrain = M_base × Π(M_overlay_i) × (0.90 if count(overlays) ≥ 2 else 1.0)
```

### Why the EOC 2018 GPS "green" figures must NOT be used

[Wolff et al. 2019](https://lbs2019.lbsconference.org/wp-content/uploads/2019/11/3_5.pdf) analysed ~156 000 track
segments from four elite men's races at EOC 2018 (Ticino). Median speeds: wide road **4.28 m/s**, road 4.13,
small footpath 3.51, open land 3.92, **white forest 2.57**, vegetation-walk 2.42, **vegetation-fight 2.20 m/s**.

The authors flag the problem themselves: *"While indistinct marsh (310) shows unexpectedly good values, easy to run
forest (405) shows unexpectedly bad values."* Elites only *enter* green where it is thin, short or downhill —
massive self-selection bias. **The path : forest ratios (1.3–1.7×) are usable and corroborate the table above; the
green values are not.** ISOM's normative bands remain the defensible source for green.

**Also negative findings, so you don't waste time:**
* **Karttapullautin has no speed model.** Its `greenshades=0.2|0.35|0.5|0.7|1.3|2.6|4|…` are **LiDAR point-density
  thresholds**, not speeds; [Ryyppö's own guide](http://www.routegadget.net/karttapullautin/greenmapping.pdf)
  calibrates green by visually matching existing maps.
* **OCAD does not publish its per-symbol resistance values** — only the 200/230 s/km base speed.
* **Albert & Sárközy (2021)**, [Proc. ICA 4:4](https://ica-proc.copernicus.org/articles/4/4/2021/ica-proc-4-4-2021.pdf),
  give least-cost-path friction weights tuned against elite route choices — **do not use as physical speeds** (they
  compress "fight" to 0.4× forest where ISOM says < 0.2×, and roads to 3× forest). It is a route-*preference* model.
* **[RouteAI](https://github.com/Jekblade/RouteAI)** — a working open-source per-colour cost set for comparison:
  white 1.5, yellow 1.2, light green 2, green 3, dark green 4, olive 10, black (paths) 1.

## 8.7 The complete model

```
v(x)  =  v_base(sex)  ×  M_terrain(x)  ×  f_grad(g(x))

v_base(men)   = 4.1667 m/s   ( = 4:00 min/km, the ISOM §2.3 reference )
v_base(women) = 3.6232 m/s   ( = v_base(men) / 1.15  ≈  4:36 min/km )
```

Race-time estimate for a whole course:

```
T  =  D · ( L + EF · C ) / ( v_base · M̄ )  +  T_nav

L   = stated course length (m)              — the straight-line-through-controls figure, IOF Rule 16.3
C   = total climb (m)                       — IOF Rule 16.4
EF  = 6.2 (men) / 6.4 (women)               — Lauenstein 2013
M̄   = course-weighted mean terrain multiplier
D   = route detour factor (see below)
T_nav = navigational overhead: ~4 min Long, ~3 min Middle, ~1 min Sprint
```

### The route detour factor `D`

`D` converts the **stated** (straight-line) course length into the distance actually run. **No published value
exists** — this is the model's one free parameter. Derived here by inverting the model against the real WOC results
in §7.3 (`v_base` = 4:00/km men, ×1.15 women, `T_nav` = 4 min Long / 3 min Middle):

| | 2021 | 2023 | 2025 | mean |
|---|---|---|---|---|
| **D, Long (men)** | 1.14 | 1.22 | 1.20 | **1.19** |
| **D, Middle (men)** | 1.24 | 1.22 | 1.04 | **1.17** |
| **D, Long (women)** | — | — | 1.21 | ~1.20 |

**Recommended: `D ≈ 1.18` for forest, `D ≈ 1.05` for sprint.**

The sprint value is lower for a structural reason worth understanding: **IOF Rule 16.3 requires the stated length to
deviate around physically impassable obstructions and prohibited areas** — and a sprint map is dense with impassable
buildings and walls, so the stated length is already close to the shortest *runnable* route. A forest length is
close to a pure straight line. This is why sprint pace (3:30/km) looks so much faster than it "should".

Corroboration: route efficiency (`100 × straight / actual`) is classed "high" above 90 and "low" below 50, i.e.
elites typically run **1.1–1.3×** the straight line
([Route-Choice-Efficiency-Prediction repo](https://github.com/N77N77/Route-Choice-Efficiency-Prediction-in-Elite-Orienteering)).

**Expose `D` as a documented tunable. It is the one number in this model that is derived, not sourced.**

### Validation targets

* A mixed WOC-style forest course must come out at **9.3–9.5 km/h straight-line for elite men, 7.5–7.6 km/h for
  elite women** (Nazário & Correia, WOC 2009–2019, top-30).
* Elite Long ≈ **88–92 min** for 13.5–16 km with 475–1050 m climb (§7.3).
* Elite Middle ≈ **30–35 min** for 5.4–6.0 km with 220–320 m.
* Elite Sprint ≈ **12–15 min** for 3.5–4.3 km with 40–85 m.
* Absolute ceiling: no elite runs faster than **20.4 km/h (M) / 17.3 km/h (W)** flat out on a track — clamp there.

### Reference implementation

```python
V_BASE = {"M": 4.1667, "W": 3.6232}          # m/s, ISOM 4:00/km reference; W = M / 1.15
EF     = {"M": 6.2,    "W": 6.4}             # climb-equivalence factor, Lauenstein 2013
V_MAX  = {"M": 5.667,  "W": 4.806}           # m/s = 20.4 / 17.3 km/h, Lauenstein 2013

M_BASE = {405:1.00, 401:1.10, 402:1.10, 403:0.95, 404:0.95,
          406:0.70, 407:0.70, 408:0.40, 409:0.40, 410:0.12,
          501:1.30, 502:1.30, 503:1.30, 504:1.20, 505:1.20,
          506:1.12, 507:1.05, 508:1.05, 412:0.70, 302:0.35}
M_OVER = {210:0.75, 211:0.45, 212:0.15, 213:0.75, 214:1.00,
          208:0.95, 209:0.45, 113:0.90, 114:0.70, 308:0.55, 310:0.80}
BLOCKED = {201, 206, 301, 307, 515, 518, 521, 529, 520, 708, 709, 711}

def cr(i):                                    # Minetti 2002 running cost, J/kg/m
    return 155.4*i**5 - 30.4*i**4 - 43.3*i**3 + 46.3*i**2 + 19.5*i + 3.6

CR0 = 3.6

def f_grad(g):
    g = max(-0.45, min(0.45, g))              # Minetti validity range
    if g >= 0.0:      return CR0 / cr(g)
    if g >= -0.18:    return 1.0 - 16.8*g*(g + 0.18)
    return math.exp(-3.5*(abs(g) - 0.18))

def terrain_mult(base_sym, overlays):
    if base_sym in BLOCKED or any(o in BLOCKED for o in overlays):
        return 0.0
    m = M_BASE.get(base_sym, 1.0)
    for o in overlays:
        m *= M_OVER.get(o, 1.0)
    if len(overlays) >= 2:
        m *= 0.90                             # ISOM 2.3: worse than either in isolation
    return m

def speed(sex, base_sym, overlays, gradient, fatigue=1.0):
    v = V_BASE[sex] * terrain_mult(base_sym, overlays) * f_grad(gradient) * fatigue
    return min(v, V_MAX[sex])
```

## 8.8 Known gaps in the speed model (declare these to the auditor)

1. **`D` (actual/stated length ratio) is not published anywhere.** Derived by inversion against WOC results.
2. **Hébert-Losier et al. 2014** ([PubMed 24673160](https://pubmed.ncbi.nlm.nih.gov/24673160/)) has the absolute
   road/path/forest velocities for elite vs amateur orienteers, but it is paywalled — the highest-value missing
   datum. All that is public: elites retain ~3 % (2 km) / ~4 % (20 m) *more* of their road velocity in forest.
3. **Marsh (308/310), broken ground (113/114), boulder field (209) and cultivated land (412) have no ISOM
   percentage.** Those multipliers are inferred, not sourced.
4. **The green multipliers cannot be validated from GPS data** because of the self-selection bias documented above.
5. **Nazário & Correia's "running speed winner" row is internally inconsistent** (lower than their own top-30
   mean, which is impossible). Use their **top-30 means**, not the winner row.
6. **Fatigue is not modelled here at all.** An 88-minute Long is a paced effort; a 13-minute Sprint is near
   threshold. Add a `fatigue(t)` term if you need the last 20 minutes of a Long to slow down realistically.

---
---

# 9. Czech / Slovak / English terminology (i18n source of truth)

Sources (all fetched):
[ČSOS Pravidla orientačního běhu 2026](https://ok-bor.cz/jestedska/wp-content/uploads/2025/12/Pravidla-OB-2026.pdf) ·
[ČSOS Pravidla OB 2022](https://www.ceskyorientak.cz/wp-content/uploads/sites/2/2025/05/pravidla-ob-2022.pdf) ·
[ISOM 2017-2 — Czech translation (ČSOS)](https://www.ceskyorientak.cz/wp-content/uploads/2025/04/csos-isom2017-2i22cz.pdf) ·
[Mezinárodní popisy kontrol 2024 — Czech (ČSOS)](https://www.ceskyorientak.cz/wp-content/uploads/sites/2/2025/04/ob-mezinarodni-popisy-kontrol-2024.pdf) ·
[**ČSOS Orienťácký slovník / Orienteering dictionary v2.0**](https://metodika.ceskyorientak.cz/upload/2019/11/Orienteering-english-CSOS-dictionary.pdf) ·
[J. Procházka — Rozvoj mapové techniky (ČSOS metodika)](https://metodika.ceskyorientak.cz/upload/2020/05/Prochazka-Mapova-technika.pdf) ·
[ČSOS metodický portál — mapové klíče](https://metodika.orientacnisporty.cz/materialy/mapovani/mapove-klice) ·
[SZOŠ Pravidlá orientačného behu 2025](https://www.orienteering.sk/public/files/Dokumenty%20SZO%C5%A0/OB/Pravidla%202025%20%E2%80%93%20zmeny.pdf) ·
[ORIS](https://oris.orientacnisporty.cz/) ·
[MU FSpS — Orientační běh, výstroj](https://is.muni.cz/do/rect/el/estud/fsps/ps10/beh/web/pages/03-vystroj.html)

Gender is marked **m / f / n**; `pl.` = plural-only.

## 9.0 ⚠️ Six terms that are commonly got WRONG — fix these before shipping

| Naive/dictionary form | Verdict | What Czech orienteers actually say |
|---|---|---|
| *souběžná chyba* | ✗ **not used** | **paralelní chyba** (f) — the ČSOS coaching material lists "Paralelní chyby" verbatim. Short form **paralelka** (f). |
| *opěrný bod* | ✗ not established (military calque) | attack point = **odrazový bod (dohledávky)** (m), also *vytyčný bod*. Note **záchytný bod** is a *different* concept (catching feature). |
| *houština* | ✗ wrong register | **hustník** (m) — the official control-description word. |
| *úžlabina* / *rokle* | ✗ neither is official | re-entrant = **údolíčko** (n); gully = **rýha / erozní rýha** (f). *Úžlabina* and *rokle* are civilian hiking words. |
| *postup* = "leg" | ⚠ half-right | **postup** = the **route / route choice**. The **leg** is **úsek (trati)** (m): *"Část trati mezi jejími základními místy se nazývá 'úsek trati'."* |
| *mapový start / K-bod* | ⚠ colloquial | the rules term is **začátek orientace** (m). *Mapový start* is the everyday word; *K-bod* is dated. |

**Generation shift in format names.** The ČSOS dictionary maps `long = klasická`, `middle = krátká`,
`ultra long = dlouhá`. The **current rules** use **dlouhá trať** (long) and **střední trať** (middle). Older runners
say *klasika / krátká*; the federation says *dlouhá / střední*. **Support both as aliases.**

## 9.1 Race & competition

| Czech | Slovak (if different) | English | Note |
|---|---|---|---|
| orientační běh (m), *OB* | orientačný beh | orienteering | colloquially **orienťák** (m) |
| závod (m) | **preteky** (pl. only) | race, event | SK has no singular: *"na pretekoch"* |
| závodník (m) / závodnice (f) | pretekár / pretekárka | competitor | |
| kategorie (f) | kategória | class | H = muži, D = ženy (e.g. H21, D18) |
| dlouhá trať (f) | dlhá trať | long distance | older/colloquial **klasika** (f) |
| střední trať (f) | stredná trať | middle distance | older/colloquial **krátká trať** |
| sprint (m) | **šprint** | sprint | |
| štafeta (f) | štafeta | relay | |
| předávka (f) | odovzdávka | changeover | *prostor předávky* = changeover area |
| úsek štafety (m) | úsek štafety | relay leg | |
| kvalifikace (f) | kvalifikácia | qualification | |
| finále (n) | finále | final | |
| hromadný start (m) | hromadný štart | mass start | |
| intervalový start (m) | intervalový štart | interval start | |
| stíhačka (f) | — | chasing start | |
| vyřazovací sprint (m) | — | knock-out sprint | |
| startovní listina (f) | štartová listina | start list | colloquial **startovka** (f) |
| výsledková listina (f) | výsledková listina | results | colloquial **výsledky** (m pl.) |
| průběžné výsledky (m pl.) | priebežné výsledky | live/preliminary results | |
| diskvalifikace (f) | diskvalifikácia | disqualification | **DISK**; verb *diskvalifikovat* |
| oddíl (m) | — | club (section) | SK uses only *klub* |
| klub (m) | klub | club | |
| mistrovství (n) | **majstrovstvá** (pl.) | championship | *MČR* |
| žebříček (m) | **rebríček** | ranking list | |
| ranking (m) | ranking | ranking | loanword |
| oblastní žebříček (m) | oblastný rebríček | regional ranking | |
| Český pohár (m) | Slovenský pohár | Czech Cup | |
| rozpis (m) | **propozície** (pl.) | event bulletin | genuine false friend — do not translate literally |
| pokyny (m pl.) | pokyny | final instructions | published ≤ 48 h before |
| přihláška (f) | prihláška | entry | *startovné* (n) = entry fee |
| etapa (f) | etapa | stage | *etapový závod* = multi-day |
| shromaždiště (n) | zhromaždisko | arena, event centre | |
| pořadatel (m) | organizátor | organiser | |
| stavitel tratí (m) | staviteľ tratí | course setter | verb *stavět tratě* |
| ředitel závodu (m) | riaditeľ pretekov | event director | |
| hlavní rozhodčí (m) | hlavný rozhodca | main referee | |
| karanténa (f) | karanténa | quarantine | |
| soutěžní řád (m) | súťažný poriadok | competition regulations | |

## 9.2 Course & controls

| Czech | Slovak (if different) | English | Note |
|---|---|---|---|
| trať (f) | trať | course | soft-stem f. |
| **úsek (trati)** (m) | úsek trate | **leg** | the correct word for a leg |
| **postup** (m) | postup | **route, route choice** | *volba postupu* = route choice |
| kontrola (f) | **kontrolné stanovište** (KS) | control | SK officially abbreviates *KS* |
| lampion (m) | **lampión** | control flag | 30×30 cm, white/orange |
| kód kontroly (m) | kód KS | control code | ≥ 31 |
| popisy kontrol (m pl.) | popisy KS | control descriptions | colloquial **popisky**; holder = *popisník* (m) |
| razit / orazit | raziť | to punch | |
| ražení (n) | razenie | punching | rules word is *označování*, but *ražení* is universal |
| chybné ražení (n) | chybné razenie | mispunch (MP) | |
| kleště (f pl.) | — | pin punch | mechanical backup |
| čip (m) | čip | SI-card, e-card | *SIAC* as-is; EMIT card = **emitka** (f) |
| **krabička** (f) | — | SI control unit | slang but universal ("little box") |
| vyčítání (n) | vyčítanie | card read-out / download | *vyčíst čip* |
| mazání (n) | mazanie | clearing | + *kontrola mazání* = check |
| mezičas (m), usually **mezičasy** (pl.) | medzičas | split time | |
| start (m) | štart | start | |
| **začátek orientace** (m) | — | start point (map start) | rules term; colloquial *mapový start*, *K-bod*; marked by the triangle |
| cíl (m) | **cieľ** | finish | |
| cílová čára (f) | cieľová čiara | finish line | |
| doběh / cílový doběh (m) | dobeh | finish chute | |
| předstart (m) | predštart | pre-start | |
| **sběrka** (f) | zberná kontrola | last control | slang but universal; formal *sběrná kontrola*; traditionally code 100 |
| předsběrka (f) | — | pre-warning control | also *předkontrola* |
| divácká kontrola (f) | divácka kontrola | spectator control | |
| průběh arénou (m) | priebeh arénou | arena passage | also *divácký úsek* |
| občerstvovací stanice (f) | občerstvovacia stanica | refreshment point | slang **občerstvovačka** (f) |
| povinný úsek (m) | značený úsek | marked / compulsory route | also *fáborkovaný úsek*; ISOM 707 |
| povinný průchod (m) | povinný prechod | compulsory passage | |
| přeběh (m) | prebeh | crossing point | over a fence/wall |
| zakázaný prostor (m) | zakázaný priestor | out-of-bounds, embargo | ISOM 709 *nepřístupná oblast* |
| koridor (m) | koridor | corridor | also a training format |
| spojnice (f) | spojnica | course line | |
| kolečko (n) | koliesko | control circle | |
| trojúhelník (m) | trojuholník | start triangle | |
| rozdělovací metoda (f) | — | forking | slang **farstování** (n), from Swedish |
| volné pořadí (n) | voľné poradie | free order | |
| skorelauf (m) | skorelauf | score event | |
| roznášet / sbírat kontroly | roznášať / zbierať | to put out / collect controls | |

## 9.3 Map & terrain

### Colour categories and symbol groups (ISOM 2017-2 ch. 3, Czech edition)

| Czech | English | Colour |
|---|---|---|
| Terénní tvary (m pl.) | Landforms | **hnědá** (brown) |
| Skály a balvany | Rock and boulders | **černá + šedá** |
| Voda a bažiny | Water and marsh | **modrá** |
| Vegetace (f) | Vegetation | **zelená + žlutá** |
| Umělé objekty (m pl.) | Man-made features | **černá** |
| Technické značky (f pl.) | Technical symbols | černá + modrá |
| Značky pro dotisk (f pl.) | Course-planning / overprint symbols | **fialová** (purple) |

### Map generalities

| Czech | Slovak | English | Note |
|---|---|---|---|
| mapa (f) | mapa | map | |
| mapový klíč (m) | mapový kľúč | map specification / legend | |
| měřítko (n) | **mierka** | scale | |
| vrstevnice (f) | vrstevnica | contour | *základní / zdůrazněná / doplňková* = normal / index / form line |
| ekvidistance (f) | ekvidistancia | contour interval | rules: *interval vrstevnic (ekvidistance)* |
| výšková kóta (f) | výšková kóta | spot height | ISOM 603 |
| magnetický poledník (m) | magnetický poludník | magnetic north line | ISOM 601 |
| **průběžnost** (f) | priebežnosť | **runnability** | the ISOM term; colloquially **běhatelnost** (f) |
| terén (m) | terén | terrain | |
| porost (m) | porast | vegetation, undergrowth | |

### Landforms

| Czech | English | ISOM |
|---|---|---|
| kopec (m) / kupa (f) | hill | 101–103 |
| údolí (n) | valley | |
| **údolíčko** (n) | **re-entrant** | D 1.3 |
| **hřbítek** (m) | **spur** | D 1.2; colloquially **nos** (m); *hřbet* = larger ridge |
| sedlo (n) | saddle | D 1.11 |
| terasa (f) | terrace | D 1.1 |
| plošina (f) | plateau | |
| zemní sráz (m) | earth bank | 104 |
| zemní val (m) | earth wall | 105; *rozpadlý* 106 |
| **rýha / erozní rýha** (f) | **erosion gully** | 107; *malá rýha* 108 |
| příkop (m) | ditch, trench | 215 |
| **kupka** (f) | **knoll** | 109; *malá protáhlá kupka* 110 |
| **prohlubeň** (f) | **depression** | 111 (gen. *prohlubně*) |
| **jáma** (f) | **pit** | 112; *jáma s vodou* 303 |
| rozbitý povrch (m) | broken ground | 113; *velmi rozbitý* 114 |
| lom (m) | quarry | D 1.5 |
| svah (m) | slope | |

### Rock and boulders

| Czech | English | ISOM |
|---|---|---|
| **sráz** (m) / skalní sráz | cliff | 202; *nepřekonatelný sráz* 201; diminutive **srázek** very common |
| skála (f) | rock, crag | *holá skála* 214 |
| skalní stěna (f) | rock face | |
| **balvan** (m) | boulder | 204; *velký balvan* 205; *obrovský balvan / skalní věž* 206 |
| kámen (m) | boulder (everyday word) | |
| shluk balvanů (m) | boulder cluster | 207 |
| balvanové pole (n) | boulder field | 208; *husté* 209 |
| kamenitý povrch (m) | stony ground | 210–212 |
| jeskyně (f) | cave | 203 |

### Water and marsh

| Czech | Slovak | English | ISOM |
|---|---|---|---|
| bažina (f) | močiar / bažina | marsh | 308; *nepřekonatelná* 307; *úzká* 309; *nezřetelná* 310 |
| močál (m) | močiar | swamp, bog | generic |
| pevná půda v bažině (f) | — | firm ground in marsh | D 3.8 |
| potok (m) | potok | stream | 304/305 |
| řeka (f) | rieka | river | |
| rybník (m) | rybník | pond | |
| jezero (n) | **jazero** | lake | |
| pramen (m) | prameň | spring | 312 |
| studna (f) | studňa | well | 311 |
| vodní nádrž (f) | vodná nádrž | reservoir | |

### Vegetation

| Czech | Slovak | English | Note |
|---|---|---|---|
| les (m) | les | forest | 405 |
| otevřený prostor (m) | otvorený priestor | open land | D 4.1 |
| polootevřený prostor (m) | polootvorený priestor | semi-open land | D 4.2 |
| **světlina** (f) | svetlina | **clearing** | D 4.4 |
| **paseka** (f) | rúbanisko | **clearcut, felled area** | not an ISOM name but what orienteers say; usually slow, full of *klest* |
| mýtina (f) | mýtina | glade | literary synonym of *paseka*; orienteers rarely use it |
| **hustník** (m) | hustník | **thicket / fight** | D 4.5 |
| úzký hustník / živý plot (m) | živý plot | linear thicket / hedge | D 4.6 |
| hranice vegetace (f) | hranica vegetácie | vegetation boundary | D 4.7; ISOM 416; also *rozhraní porostů* |
| roh lesa (m) | roh lesa | forest corner | D 4.3 |
| skupina stromů (f) | skupina stromov | copse | D 4.8 |
| výrazný strom (m) | výrazný strom | prominent tree | 417/418 |
| vývrat (m) | vývrat | root stock | D 4.10; *pařez* (m) = stump |
| louka (f) | lúka | meadow | |
| pole (n) | pole | field | *obdělávaná půda* 412 |
| sad (m) | sad | orchard | 413 |

### Man-made features

| Czech | Slovak | English | ISOM |
|---|---|---|---|
| silnice (f) | cesta, asfaltka | road | 502/503 |
| cesta (f) | cesta | track | 504 *vozová cesta*, 505 *pěší cesta* |
| pěšina (f) | **chodník** | path | 506; *nezřetelná pěšina* 507 |
| **průsek** (m) | priesek | **forest ride, firebreak** | 508 |
| plot (m) | plot | fence | 516; *rozpadlý* 517; *nepřekonatelný* 518 |
| zeď (f) | **múr** | wall | 513–515 |
| ohrada (f) | ohrada | enclosure, paddock | non-ISOM |
| budova (f) | budova | building | 521 |
| zastřešení (n) | zastrešenie | canopy | 522 |
| zřícenina (f) | zrúcanina | ruin | 523 |
| most (m) | most | bridge | 512 |
| schodiště (n) | schodisko | stairway | 532 |
| průchod (m) | prechod | crossing point / passage | 519 |
| **posed** (m) | posed | hunting stand | 525 — a classic Czech control feature |
| **krmelec** (m) | kŕmidlo | fodder rack | 527 — ditto |
| mohyla (f) | mohyla | cairn | 526 |
| železnice (f) | železnica | railway | 509 |
| elektrické vedení (n) | elektrické vedenie | power line | 510/511 |
| zpevněná plocha (f) | spevnená plocha | paved area | 501 |

## 9.4 Technique

| Czech | Slovak | English | Note |
|---|---|---|---|
| **dohledávka** (f) | dohľadávka | **final approach / spiking the control** | The key Czech technique noun — the last 50–150 m into the circle. Verb *dohledat*. ČSOS coaching treats it as its own trainable phase. English has no clean single word. |
| **odrazový bod (dohledávky)** (m) | — | **attack point** | also *vytyčný bod* |
| **záchytný bod** (m) | záchytný bod | **catching feature / check point** | |
| orientační bod (m) | orientačný bod | navigational feature | |
| **vodicí linie** (f) | vodiaca línia | **handrail** | *vodicí* is the correct spelling (not *vodící*) |
| záchytná linie (f) | záchytná línia | catching feature (linear) / backstop | |
| azimut (m) | azimut | bearing | *hrubý azimut* = rough; *přesný azimut* = precise |
| **buzola** (f) | buzola | **compass** | the normal word; *kompas* sounds civilian/hiking |
| **palcovka** (f) | palcovka | thumb compass | vs **desková** (f) = baseplate compass |
| palcování (n) | palcovanie | thumbing | |
| krokování (n) | krokovanie | pace counting | also *měření krokem*; *odhad vzdálenosti* = distance estimation |
| čtení mapy (n) | čítanie mapy | map reading | |
| orientace mapy (f) | orientácia mapy | orienting the map | *zorientovat mapu* |
| zjednodušení (n) | zjednodušenie | simplification | |
| generalizace (f) | generalizácia | generalisation | |
| volba postupu (f) | voľba postupu | route choice | often shortened to **volba** |
| směr (m) | smer | direction | *směr odběhu* = direction out of a control |
| vzdálenost (f) | vzdialenosť | distance | |
| **paralelní chyba** (f) | paralelná chyba | **parallel error** | short form **paralelka** |
| chyba (f) | chyba | mistake | *udělat chybu* |
| **ztráta** (f) | strata | time loss | *ztrátová (kontrola)* = the leg where time was lost |
| ztratit kontakt | stratiť kontakt | to lose map contact | |
| zabloudit | zablúdiť | to get lost | |
| relokace (f) / zorientovat se | relokácia | relocation | *zorientovat se* is the everyday phrasing |
| plánování odzadu (n) | — | planning backwards | |
| paměťák (m) | — | memory-O | training format |
| had kontrol (m) | — | control picking | dense string of controls |

## 9.5 Physical & equipment

| Czech | Slovak | English | Note |
|---|---|---|---|
| běh (m) | beh | running | |
| tempo (n) | tempo | pace | |
| **převýšení** (n) | prevýšenie | **climb** | required in the bulletin |
| délka trati (f) | dĺžka trate | course length | |
| stoupání (n) | stúpanie | ascent | |
| klesání (n) | klesanie | descent | |
| kondice (f) | kondícia | fitness | |
| dres (m) | dres | jersey, o-top | |
| **elasťáky** (m pl.) | elasťáky | leggings, o-pants | *šusťáky* = nylon trousers |
| **návleky** (m pl.) | návleky | **gaiters** | |
| **prorážečky** (f pl.) | — | o-socks / shin guards | *chrániče holení* — for nettles and brambles |
| podkolenky (f pl.) | podkolienky | knee socks | |
| **hřebové boty** (f pl.) | — | o-shoes | *hřeby* = metal dobs; colloquial **hřebouny**; *tretry* = track spikes |
| **mapník** (m) | mapník | map case / map holder | |
| **popisník** (m) | popisník | description holder | wrist holder |
| **čelovka** (f) | čelovka | headlamp | for **noční OB / NOB** (night-O) |
| startovní číslo (n) | štartové číslo | bib number | |
| gumička (f) | gumička | rubber band | holds the map/card |
| lupa (f) | lupa | magnifier | common in veteran classes |
| rozklus (m) | rozklus | warm-up | *výklus* = cool-down |

## 9.6 Slang & interjections (for in-game copy)

| Czech | English | Register |
|---|---|---|
| **orienťák** (m) | orienteering; also "an orienteer" | universal informal |
| **kufrovat / kufr** (m) | to wander lost, to boom | **the classic**: *"Kufroval jsem tam pět minut."* A big mistake = *kufr*. |
| **zaběhl jsem to** | "I ran it clean / nailed it" | positive; also *čistý závod* |
| **šlo to** | "it went OK" | understated approval — very Czech |
| **bylo to blbě** | "that was bad" | |
| **díra** (f) | a blank, a total miss | *"Udělal jsem tam díru."* |
| **bomba / bombová trať** | brilliant course | |
| **na tušáka** | by guesswork, blind | attested in ČSOS coaching as a named error: *dohledávka "na tušáka"* |
| **hanba start** (m) | relay restart | lit. "shame start" — the mass restart for lapped relay teams |
| **bedna** (f) | the podium | *"Byl jsem na bedně."* |
| **paralelka** (f) | a parallel error | |
| **spíkr** (m) | announcer | also *hlasatel* |
| **klest** (m) | brash, logging slash | on a *paseka* |
| **kopřivy** (f pl.) | nettles | |
| **nos** (m) | spur, "nose" | informal for *hřbítek* |
| **DISK** | DSQ | |
| **MP** | mispunch | *chybné ražení* |

## 9.7 i18n implementation notes

* **Slovak `preteky` is plural-only.** Any pluralisation rule for "race" breaks: CZ `závod / závody`, SK
  `preteky / preteky`. Treat as an irregular special case.
* **Soft-stem feminines** need explicit declension data: *trať, zeď, prohlubeň, vrstevnice*
  (`prohlubeň` → gen. `prohlubně`).
* **`kontrola` is a false friend** — in ordinary Czech it also means "a check/inspection". Namespace the keys
  (`control.flag`, not a bare `kontrola`).
* Czech uses **H** (*muži*) and **D** (*ženy*) for class prefixes, not M/W — `H21E`, `D18`. Slovak uses **M/Ž**.
* The Slovak terrain rows above (*jazero, múr, chodník, rieka*) are standard-language equivalents and were verified
  less directly than the Slovak race-admin vocabulary — worth a spot-check by a Slovak reviewer. **[flagged]**
---
---

# Appendix A — Consolidated audit risks and open questions

Everything below is a place where a national-team orienteer or an IOF-qualified mapper could legitimately push
back. They are listed so they can be checked rather than discovered.

## A.1 Version currency

| Item | Version used here | Risk |
|---|---|---|
| ISOM | **2017-2, Revision 6, January 2024** | Mandatory from 1 Jan 2025. Current at time of writing. Revisions arrive roughly annually — re-check the errata table at the back of the PDF. |
| ISSprOM | **2019-2, Revision 6, January 2024** | Same. |
| Printing & Colour Definitions | **Revision 4, September 2024** (valid 1 Dec 2024) | **Brown changed in this revision** (0/56/100/18 → 25/75/100/0); brown 50 % and 30 % likewise. Anything older is wrong. |
| Control Descriptions | **2024** | Supersedes 2018. 2018 lacks symbols 5.24 (Railway) and 15.6 (Map flip), and lacks the ISSprOM cross-references. |
| IOF Competition Rules | **Foot Orienteering 2025** | Rule numbering shifted between 2024 and 2025 (competition **formats** moved from Appendix 2 to **Appendix 6**; Appendix 2 is now *Principles for course planning*). Third-party summaries quoting "Appendix 2 §1.1 Sprint profile" are using the 2024 numbering. |

## A.2 Things stated in this document that are NOT IOF-normative

| Claim | Status |
|---|---|
| All RGB / hex colour values | **[derived]** — the IOF publishes CMYK only. The sRGB column is a Euroscale-Coated-v2 conversion computed locally. |
| Colour render z-order as a canvas painting order | **[derived]** from the normative *colour order* table, which is a printing order. |
| Course-line ↔ circle gap of ~1.0 mm | **[estimate]** — ISOM mandates a gap but gives no number. |
| Pictogram geometry descriptions in §3 | **[reconstructed]** — the pictograms are raster images in the IOF PDF; no official vector source exists. Cross-check against Purple Pen / OCAD / OpenOrienteering `Course_Design` symbol sets. |
| Derived course-length envelope (§7.3) | **[derived]** — the IOF specifies **winning time only**, never length or control count. |
| Terrain multipliers for marsh, broken ground, dense boulder field, cultivated land, shallow water | **[UNCERTAIN]** — ISOM deliberately gives no percentage for these. |
| Detour factor `D` (§8.7) | **[derived]** by inverting the model against WOC results. The one genuinely free parameter. |
| Aim-off offset formula (§6.6) | **[derived]** — no orienteering source gives a number. |
| Farsta / Motala / phi-loop definitions (§7.5) | **[UNVERIFIED]** — these terms appear **nowhere** in the IOF rules. Only *forking*, *butterfly loops* and *course choice forking* are IOF terms. |
| "Boom" and "bailing out" as standard terminology (§6.14) | **[UNCERTAIN]** — not in any major club glossary checked. |
| SIAC feedback duration in milliseconds | **[UNCERTAIN]** — SportIdent publishes only ~3 s / 5 s / < 1 s categories. |
| SIAC AIR+ range | **Sources conflict** (30 vs 50 cm). Resolved via the Organiser Guide's anisotropic figure: **~30 cm lateral, ~60 cm vertical**. |
| SI-Card 11 flash duration | **Conflict**: British Orienteering says ~7 s, SportIdent Config+ says ~3 s default. Probably a firmware-era difference. |
| Slovak terrain vocabulary (§9.3) | Verified less directly than the Slovak race-admin vocabulary — worth a Slovak reviewer's spot-check. |

## A.3 Corrections to widely-held but wrong priors

These are the specific points most likely to be got wrong by someone working from memory:

1. **ISOM white forest is the 80–100 % band, not 100 %.** 100 % is the *reference* (flat open runnable forest);
   **paths and lawns are explicitly > 100 %**.
2. **ISOM 2017-2 has no symbol 411.** ISOM 2017 (1st edition) had *411 Vegetation, impassable*; it was deleted.
   **ISSprOM 2019-2 411 = Uncrossable vegetation.**
3. **ISOM control circle is ø 5.0 mm, not 6.0 mm** — ISOM 2017 *reduced* the overprint sizes from ISOM 2000.
   The start triangle is **6.0 mm** (ISOM) but **7.0 mm** (ISSprOM); the finish is 4/6 mm (ISOM) but 5/7 mm (ISSprOM).
4. **Green CMYK is 80/0/100/0, brown is 25/75/100/0.** OpenOrienteering Mapper's shipped ISOM 2017-2 file still
   carries the old 76/0/91/0 and 0/56/100/18. Do not copy colours from an OOM/OCAD file.
5. **The men : women elite base-speed ratio is 1.15–1.17, not 1.28.** The 1.28 figure predates the 2024
   equalisation of winning times.
6. **Walking pace count is 57–64 per 100 m, not 40–50.** 38–50 is the *running* band.
7. **Tobler is a walking function** — its gradient penalty is too gentle for runners (0.705 vs 0.603 at +10 %).
8. **In the forest, "impassable" is not "forbidden".** Only ISOM 520/708/709/711 are DSQ. In sprint, thirteen
   ISSprOM symbols are DSQ under Rule 17.2 — including **every building**.
9. **The IOF rules say "must not be placed", never "DSQ" or "MP".** Those are national/software conventions.
10. **The 4 % climb guideline is "should normally not exceed"** and is routinely exceeded at WOC Long
    (Doksy 2021: 7.7 %).
11. **Women's WOC Long times jumped in 2024 because of a rule change** (equalised to 88–92 min), not fitness.

## A.4 What could not be obtained

* **Hébert-Losier et al. 2014** absolute road/path/forest velocities (paywalled).
* Official vector sources for the control-description pictograms (raster-only in the IOF PDF).
* `orienteering.sport` blocks scraping (HTTP 403) — every IOF document here was obtained from a national-federation
  or club mirror. The mirrors were checked to be the correct revision by reading each PDF's own title page and
  errata table.
