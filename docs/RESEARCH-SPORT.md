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

