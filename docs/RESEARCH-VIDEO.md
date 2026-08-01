# RESEARCH — Reference Video Analysis

Visual-identity north star for the Český Orienťák project.

**Source file:** `/Users/jurajgiacko/Downloads/2026-07-30 EN Video Svetovy Pohar (1920x1080) - 01 - vp 2.mp4`
**Frames:** `research/raw/videoframes/f_001.jpg … f_060.jpg` (1 fps, colour-accurate)
**Selects:** `research/raw/videoframes/selected/` (8 frames)

---

## 0. Technical probe

| Property | Value |
|---|---|
| Container | MP4 (`mp42`), MainConcept muxer |
| Duration | **60.00 s** exactly |
| Video | H.264 **Main** profile, `avc1`, 1920×1080, progressive |
| Frame rate | **25 fps** (CFR, 1500 frames) |
| Pixel format | `yuv420p`, **bt709**, **limited/TV range** |
| Video bitrate | 9 735 kb/s (total 10 077 kb/s) |
| Audio | AAC-LC, 48 kHz, **stereo**, 317 kb/s |
| Created | 2026-07-31 |

### ⚠️ Colour-pipeline warning (important)

The file is tagged `bt709 / limited range`. A naive `ffmpeg -i in.mp4 out.jpg` **mis-decodes it** — it applies bt601 coefficients and skips the range expansion, producing desaturated, washed-out frames (the brand red decodes as `#e90002` instead of pure red).

Always extract with an explicit conversion:

```bash
ffmpeg -i input.mp4 \
  -vf "fps=1,colorspace=all=bt709:iall=bt709:irange=tv:range=pc,format=rgb24" \
  -q:v 2 out_%03d.jpg
```

Verified: raw YUV of the flat red patch is `Y=63 U=102 V=240`, which is textbook bt709-limited **pure red**. All colour values in this document were sampled after correct conversion. The frames in `research/raw/videoframes/` have been re-extracted correctly.

### Audio

Continuous instrumental music bed, no voice-over, no on-camera dialogue.

| Metric | Value |
|---|---|
| Integrated loudness | **−27.2 LUFS** |
| Loudness range (LRA) | 9.7 LU |
| True peak | −13.8 dBFS |

Notably quiet — roughly 13 LU below the −14 LUFS web-delivery norm, so this is an **unmastered / pre-final mix**. Silence detection shows the structure: a stinger at `0.0–0.47 s`, a deliberate **music break at `2.79–4.73 s`** (lands exactly on the cut from the logo card to the aerial), a short break at `55.2–55.6 s` (just before the end card), and a fade to silence from `57.99 s` to the end.

---

## 1. Shot list

Scene-cut detection (`select='gt(scene,0.30)'`) plus per-second red-coverage analysis gives this structure. Red-coverage % is the fraction of frame occupied by brand red — it cleanly separates footage from graphic cards.

| Time | Type | Content |
|---|---|---|
| `0.0–0.4` | **Graphic** | Opening: red/white oblique bars sweeping across frame (42 % red) |
| `0.4–2.8` | **Logo card** | Full-bleed red. `ENERVIT` wordmark centred, payoff **`VÝŽIVA PRO SPORTOVCE`** letterspaced beneath (93 % red) |
| `2.8–3.5` | Cut | Music drops out on this cut |
| `3.5–6.0` | Footage | **Aerial / drone**, high wide over forested rolling hills; event arena (tents, flags, crowd) in a clearing mid-frame. Corner logo bug appears from `4 s` on |
| `6.0–8.4` | Footage | Start area — blue `OWC 2023` / `Česká Lípa` start banners, athlete at start gate, foreground foliage bokeh |
| `8.4–9.9` | Footage | Female athlete in start box, headband, holding map board |
| `8.0–11.0` | **Lower third** | `ITALSKÁ ENERGIE / PRO ŠUMAVSKÉ KOPCE` types on over the start footage |
| `9.9–11.0` | Footage | Close-up: hands / watch / map board at start |
| `11.0–13.4` | Footage | Control flag close-up (orange-white), then aerial-down on boulders with a control flag; yellow wildflowers |
| `13.4–14.0` | **Transition** | Oblique red slab wipes L→R across frame |
| `14.0–15.9` | **Product card** | `PRE SPORT` jelly sachet on red; white circle icon; `PRE` in acid yellow, `SPORT` in white |
| `15.9–16.3` | **Transition** | Oblique red slab wipes out |
| `16.3–19.5` | Footage | Runners in **beech forest**, mid-shot, telephoto compression, brown leaf-litter floor |
| `19.0–22.0` | **Lower third** | `KDYŽ DOJDE PALIVO, / MAPA ZTRÁCÍ SMYSL.` |
| `19.5–22.0` | Footage | Runner on stony forest track (low angle, feet); runner on slope |
| `22.0–26.6` | Footage | **Pack of 4–5 runners descending a steep slope**, control flag mid-frame, roots and rock steps |
| `26.6–27.3` | Footage | Female athlete climbing a mossy gully, reading map |
| `27.3–30.5` | **Product card** | `CARBO GEL C2:1` sachet on red; white flame icon; `CARBO` yellow, `GEL` white |
| `30.5–33.0` | Footage | Runner in gully; athlete on **mossy sandstone boulder** reading map (hero shot) |
| `33.0–35.5` | Footage | Map-in-hand close-up + control punch; dark spruce stand, runners crossing slope |
| `35.5–39.4` | **Lower third** | `JEDNA CHYBA V ÚNAVĚ / STOJÍ VŠECHNO.` over slope-running footage |
| `39.4–42.0` | Footage | Runner descending rocky ravine; **control flag + SI punch close-up**; runner crossing open meadow |
| `42.0–44.3` | **Product card** | `R2 RECOVERY DRINK` tub on red; white clock icon; `RECOVERY` yellow, `DRINK` white |
| `44.3–46.2` | **Transition** | Oblique red wipe out into arena footage |
| `46.2–47.6` | Footage | Runner into the **finish arena**, sponsor boards (`renta`, `EKSJÖHUS`, `KWAK`) |
| `47.6–50.4` | Footage | Finish chute — national flag bunting, crowd behind barriers in rain gear |
| `46.0–50.0` | **Lower third** | `KDYŽ MÁŠ CHUŤ / V CÍLI BĚŽET DÁL.` |
| `50.4–52.3` | Footage | Athletes greeting at finish, `ČESKÁ MINCOVNA` arch, Sweden bib 128 |
| `52.3–55.6` | Footage | **Podium ceremony** — `OWC 2023 ORIENTEERING WORLD CUP`, `Liberecký kraj`, `CZECH MINT` backdrop; three medallists with bouquets |
| `55.6–60.0` | **End card** | Full-bleed red. `ENERVIT` wordmark + payoff **`SE POSTARÁ O TVÉ TĚLO / TY DRŽ AZIMUT`**. Held ~4.4 s, audio fades out over the last 2 s |

### ⚠️ Location discrepancy — flag to the client

The on-screen headline reads **`PRO ŠUMAVSKÉ KOPCE`** ("for the Šumava hills"), but the footage is demonstrably **not** Šumava / Vyšší Brod. Readable on-screen evidence:

- Start banners: `OWC 2023 · ORIENTEERING WORLD CUP · Česká Lípa`
- Podium backdrop: `OWC 2023 ORIENTEERING WORLD CUP · 2–6 August · Round 2` + **`Liberecký kraj`** + `Czech Mint / Česká mincovna` + Czech Orienteering Federation mark

So this is the **2023 Orienteering World Cup Round 2 in the Liberec region (Českolipsko)** — sandstone terrain, not the granite/spruce of Šumava. The two are visually different biomes. If the 3D forest is meant to represent **Vyšší Brod / Šumava**, this video is a *grade and mood* reference, **not** a *terrain-species* reference. Worth confirming with the client which one governs.

---

## 2. Visual identity

### 2.1 Colour

Sampled from lossless, colour-corrected frames (modal pixel values over full 1920×1080 frames).

| Role | HEX | RGB | Notes |
|---|---|---|---|
| **Brand red (as used in video)** | `#FF0000` | 255, 0, 0 | 74–93 % of every graphic card. Pure, clipped red |
| **White** | `#FFFFFF` | 255, 255, 255 | Logo, all typography, icons, line work |
| **Acid yellow accent** | `#E2EC00` | 226, 236, 0 | Product-name first word only. Consistent across all three cards |

> **⚠️ The video's red is NOT the Enervit brand red.**
> Guidelines specify `#E40521` (R228 G5 B33 / C0 M100 Y90 K0). The video uses **`#FF0000`** — a fully saturated, gamut-clipped red, noticeably brighter and more orange-leaning.
>
> This is almost certainly an authoring artefact (designed in an sRGB comp with "pure red", or a saturation/legalise pass that clipped the channel), not an intentional brand decision. It is also technically illegal for broadcast.
>
> **Recommendation for our build: use the official `#E40521`.** It is the value in the guidelines and in the supplied logo artwork (measured `#E40421` in the master PNG). Matching the video's `#FF0000` would propagate the error. See `docs/BRAND-ENERVIT.md`.

The acid yellow `#E2EC00` is **not** in the Enervit logo guidelines — it is a campaign accent introduced by whoever cut this video. Flag it before adopting it as a system colour.

### 2.2 Typography

| Element | Style |
|---|---|
| **Logo wordmark** | Enervit proprietary — heavy oblique rounded-terminal grotesque with the arrow-in-ellipse mark. Never re-set; always use supplied artwork |
| **Payoff (`VÝŽIVA PRO SPORTOVCE`, `SE POSTARÁ O TVÉ TĚLO / TY DRŽ AZIMUT`)** | All caps, **heavily letterspaced** (~0.35–0.45 em), medium weight, white, centred under the wordmark. Upright, not italic |
| **Lower thirds** | All caps **condensed grotesque**, two weights stacked. Consistent with the guidelines' **Trade Gothic** (Bold Condensed / Condensed). Flat horizontal terminals, high x-height, tight tracking, upright. Full Czech diacritics present (`Í Š Ě Ů Ž`) |
| **Product-name cards** | Same condensed caps, two-tone: first word acid yellow, second word white, stacked and left-aligned |

Measured on the `JEDNA CHYBA V ÚNAVĚ / STOJÍ VŠECHNO.` lower third (frame `f_037`):

- **Line 1** (heavier): cap band 555–626 px, median stroke width **22 px** → stroke/cap ≈ 0.31 (Bold/Black)
- **Line 2** (lighter): cap band 681–793 px, median stroke width **17 px** → visibly lighter (Regular/Medium)
- Line 1 → line 2 baseline delta ≈ **167 px** (≈ 1.5× cap height)
- Left margin ≈ **245–251 px** (12.8–13.1 % of frame width)

The two-weight stack is the signature: **statement line bold, resolution line light.** Copy is always a two-part sentence broken across the weight change.

### 2.3 Logo lock-ups and placement

**Corner bug** (present on every footage shot, absent on graphic cards). Measured identically across frames at 5 s, 19 s, 37 s and 50 s — it never moves or animates:

| Property | Value |
|---|---|
| Position | x = **224 px**, y = **126 px** (top-left) |
| Size | **340 × 84 px** |
| Aspect ratio | **4.05 : 1** (matches the guidelines' red-rectangle proportion of ≈ 4.11 : 1) |
| Margin | 11.7 % of frame width, 11.7 % of frame height |
| Form | The full white-on-red rectangle lock-up, *senza payoff*. Correct per guidelines — the red rectangle is never dropped |

**Opening / closing cards:** wordmark centred horizontally, sitting slightly above vertical centre, with the letterspaced payoff beneath. Roughly 65 % of frame width. Full-bleed red field — the rectangle is the whole frame, which is the guideline-sanctioned treatment.

### 2.4 Graphic system

- **Oblique red slab wipe.** The one transition device. A red parallelogram sweeps horizontally across frame; its leading edge is slanted **10° off vertical** (80° from horizontal), leaning right at the top — deliberately matching the italic slant of the ENERVIT wordmark. Band width ≈ 630 px. Duration ≈ 0.5 s. Measured on the `13.6 s` wipe.
- **Thin white line motif.** A fine white curve/route-line is drawn over several footage shots (visible at 19–20 s, 25–26 s, 33–34 s, 39–40 s). It reads as a hand-drawn **orienteering route line** connecting controls — the most directly reusable idea in the whole piece for our project, and it is already part of the client's own visual language.
- **White outline arrow pair (`↗↗`)** in the top-right of the product cards; matches the arrow inside the logo mark.
- **White outline icons** on product cards, circle-contained: flag (Pre Sport), flame (Carbo Gel), clock (Recovery). Thin stroke, geometric.
- **Thin white outline line-art** in the lower-left of product cards (large, cropped, decorative — reads as an abstracted numeral/arrow).
- **No cross-dissolves anywhere.** Every footage-to-footage change is a hard cut. Only the red slab wipes are non-cuts.

---

## 3. Terrain and landscape — reference for the 3D forest

This is the section that most directly drives the Three.js renderer. All observations are from `selected/17s-…`, `selected/23s-…`, `selected/31s-…`, `selected/40s-…` and the aerial at `selected/05s-…`.

### 3.1 Light quality — flat, not dappled

**The light is completely flat and diffuse.** This is the single most important observation. Conditions are **overcast and actively wet** (rain gear on the crowd, saturated dark soil, wet-looking foliage).

- **No hard shadows anywhere.** No shadow terminators on trunks, no cast shadows on the forest floor.
- **No dappled light, no god rays, no sun shafts.** Do not model them — it would immediately read as the wrong day.
- Sky visible through canopy gaps is a blown, desaturated near-white (`#EEE5ED`-ish in the aerial), not blue.
- Illumination is essentially **top-down hemispherical**. Contrast comes from *canopy occlusion depth*, not from direct light.

### 3.2 Colour grade of the terrain

Global statistics over all 47 footage frames (excluding graphic cards), HSV:

| Metric | p05 | p25 | median | p75 | p95 |
|---|---|---|---|---|---|
| **Value** (brightness) | 0.09 | 0.19 | **0.29** | 0.47 | 0.92 |
| **Saturation** | 0.05 | 0.23 | **0.39** | 0.52 | 0.79 |
| **Hue** (S > 0.15) | 5° | 31° | **57°** | 83° | 231° |

Mean V = 0.359, mean S = 0.392.

**The critical finding: median hue is 57°, and the p25–p75 hue band is 31°–83°.** That is **olive / khaki / yellow-green**, not green. True green (120°) is essentially absent from the frame. The p95 at 231° is only the occasional blue jersey. This forest is brown-yellow-olive, and any renderer that reaches for saturated `#2E8B57` foliage green will look nothing like it.

Median value of 0.29 means the image sits in the **lower third of the range** — this is a dark, low-key picture.

Dominant palettes by shot group:

| Shot group | Dominant colours |
|---|---|
| Aerial arena (04–05 s) | `#2E371F` `#30381F` `#25311A` (canopy, H 79–91° S 43–46 % V 19–21 %) · `#544F34` `#655C43` (fields) · `#EEE5ED` (blown sky) |
| Beech forest run (16–19 s) | `#50442A` `#3A3822` `#2D2C1E` `#302E1F` — H 40–57°, S 33–47 %, V 17–31 % |
| Steep slope pack (22–25 s) | `#2B2A1F` `#161814` `#5D513B` `#3C3A29` — H 38–90°, S 16–37 %, V 9–37 % (darkest group) |
| Mossy gully (26–31 s) | `#28271E` `#484525` `#60532D` `#3F3621` — H 41–64°, S 25–53 %, V 15–37 % |
| Dark spruce (33–35 s) | `#28281E` `#544D37` `#383828` `#493C2F` — H 30–60°, S 23–35 %, V 15–33 % |
| Boulder / control (39–41 s) | `#46362A` `#535F36` `#78794E` `#7C7F54` — H 25–77°, S 33–43 %, V 23–49 % (lightest forest group) |
| Open meadow (41–42 s) | `#353924` `#876C3F` `#725930` `#A4865E` — dry golden grass, H 34–77°, S 35–57 %, V 14–64 % |

### 3.3 Ground cover

- **Beech leaf litter dominates.** Deep, continuous, wet, **red-brown to chocolate** (`#46362A`, `#3F3621`, H 21–30°). It is the single largest surface in most shots. Not a green ground plane.
- **Bare compacted earth** on the tracks and slopes — darker, wet, near-black in the shaded gullies (`#161814`).
- **Moss** on rock and root, in the ravines — this is where the only genuinely green pixels live, and even they are `#535F36` / `#484525`, i.e. desaturated yellow-green at H 64–77°.
- **Low herb layer** patchy, not continuous — bilberry/ivy-like clumps, ferns in the wetter gullies, plus yellow wildflowers on the aerial-down boulder shot at ~12 s.
- **Dry golden grass** in the one open meadow shot (41 s) — much lighter and warmer than the forest, `#A4865E` / `#876C3F`.

### 3.4 Canopy and understory density

- Canopy is **mid-density and semi-open** — mature **beech-dominant mixed stand** with spruce pockets. Sky is visible through gaps but the ground is never in direct sun.
- **The understory is sparse.** This is a runnable, "white forest" (in orienteering-map terms) — clear sightlines of 30–50 m at ground level. The visual density comes from **trunk count**, not from brush. Do not fill the understory with dense shrubs; it would break the character.
- Trunks are **slender to medium**, tall, straight, largely **branch-free for the lower 4–6 m**, with a thin scatter of saplings and low dead branches. Trunk bark is grey-brown, often with a **green algal/mossy cast on one side**.
- **Sandstone boulders** — rounded, light grey-buff, with thick **moss caps and moss skirts**. They sit as isolated blocks and short rock steps in the ravines, not as continuous scree. Characteristic of the Českolipsko sandstone, and a strong silhouette element.

### 3.5 Mist and atmosphere

**Yes — there is visible atmospheric depth.** Backgrounds in the deeper forest shots go **milky and desaturated** rather than simply dark: contrast falls off and hue drifts toward neutral with distance. This is wet-air aerial perspective at short range (tens of metres), not a dramatic ground fog — there is no visible fog *layer*, no drifting bank.

Model this as **short-range exponential fog tinted to the desaturated canopy colour**, not white fog. A white fog will look like haze on a sunny day; the reference is a grey-olive veil.

---

## 4. Orienteering content inventory

Everything present that we can mine for authenticity:

| Element | Where | Detail |
|---|---|---|
| **Control flags** | 11 s, 12 s, 22–25 s, 30 s, 39–41 s | Standard orange-white three-panel prism. Hung on a light stand/branch, roughly waist-to-chest height. Orange reads `#E85D2A`-ish against the olive forest — the highest-chroma object in the whole scene, and it *pops* |
| **SI punching** | ~33 s, ~40 s | Athlete reaching to the control unit on the stand beside the flag; hand-to-box contact clearly visible |
| **Map handling** | 8–10 s, 26 s, 31 s, 32 s, 33 s | Folded map held in one hand, thumb-gripped, held low and forward; **map board with clip at the start**; athletes read on the move while climbing |
| **Compass** | 33 s | Thumb compass visible on map hand |
| **Bibs** | throughout | White paper bib, large black numerals (`58`, `128`, `264`), sponsor strip along the top (`T`, `ŠKODA`) |
| **Kit** | throughout | National O-suits — Norway (white/red), Sweden (blue/yellow), Switzerland (red/white cross). Long tights or leggings, gaiters, low-profile O-shoes, headbands |
| **Start** | 6–11 s | Blue `OWC 2023 / Česká Lípa` start banners, sponsor wall, start gate, map-board rack |
| **Arena** | 45–52 s | Finish chute with barrier tape and hoarding, **national-flag bunting strung overhead**, inflatable `ČESKÁ MINCOVNA` finish arch, sponsor boards, crowd in rain jackets and umbrellas, tented event village |
| **Podium** | 52–55 s | Backdrop with `OWC 2023`, `Liberecký kraj`, `Czech Mint`, `KWAK`, `ORUN`, Czech Orienteering Federation. Medallists with wrapped bouquets |
| **Terrain type** | throughout | Steep-sided ravines, rock steps, boulder fields — technically demanding, physically steep. Runners are visibly **climbing on hands** in places |

The **route-line overlay** (§2.4) is the strongest single crossover between the client's identity and orienteering — reuse it.

---

## 5. Grade / mood and Three.js guidance

### 5.1 The look, characterised

Low-key, low-saturation, **warm-shadow** documentary grade. Specifically:

- **Contrast:** medium-low overall but with **crushed shadows**. p01 value = 0.05, p05 = 0.09 — the toe is pulled down hard. Highlights are not rolled off so much as simply absent, except the blown sky (p99 = 1.00, which is only sky and bibs).
- **Saturation:** restrained (median S = 0.39) *except* for the brand red, the acid yellow, and the control-flag orange, which are left fully saturated. This is the whole trick: **a desaturated world with three high-chroma objects in it.**
- **LUT character:** a **green-to-olive shift in the midtones** and a **warm/brown lift in the shadows**. Greens are pulled toward yellow (hue centred 57° rather than 120°) and desaturated; browns are kept warm and relatively rich. Highlights stay neutral-to-cool (the sky is neutral white, faintly magenta at `#EEE5ED`). It is a mild bleach-and-warm, not a teal-and-orange.

### 5.2 Concrete renderer settings

Starting point for the Three.js build:

```js
renderer.outputColorSpace   = THREE.SRGBColorSpace;
renderer.toneMapping        = THREE.AgXToneMapping;   // AgX: desaturates highlights, keeps the toe soft
renderer.toneMappingExposure = 0.85;                   // slightly under — median target V ≈ 0.29
```

- **Tone mapping — use AgX**, not ACESFilmic. ACES adds a saturated, contrasty, "cinematic" S-curve with a warm highlight bias; this reference is the opposite — flat, desaturated, low-key. AgX's gentle desaturating shoulder is much closer. If AgX is unavailable, `NeutralToneMapping` is the second choice. Avoid `ACESFilmicToneMapping`.
- **Exposure ≈ 0.85.** Target a median frame value around **0.29** and a p05 around **0.09**. Render a test frame and run the same HSV percentile check used above.

**Lighting**

```js
// Overcast: hemisphere dominant, no directional key
const hemi = new THREE.HemisphereLight(0xEDEAE4, 0x3A3224, 2.2); // sky warm-neutral, ground warm brown
// Very weak, very soft fill from above — NOT a sun. No shadow casting, or heavily blurred if used.
const fill = new THREE.DirectionalLight(0xF0EDE6, 0.25);
fill.position.set(0.2, 1.0, 0.15);   // near-vertical
```

- **Hemisphere light does the work.** Ground colour must be the warm brown of leaf litter (`#3A3224`), not green — the bounce colour is what sells the litter floor.
- **Kill or heavily soften shadow maps.** No crisp contact shadows. Lean on **AO** (SSAO/GTAO, or baked) for the ground-contact and canopy-depth darkening — that is where all the reference's contrast actually comes from.
- **No sun object, no light shafts, no volumetric god rays.**

**Fog**

```js
scene.fog = new THREE.FogExp2(0x6E6A55, 0.018);  // desaturated grey-olive, short range
```

Tune density so contrast has visibly fallen off by ~40–60 m. Match the fog colour to the mid-distance canopy, **not** to white.

**Palette targets**

| Surface | Target HEX | Notes |
|---|---|---|
| Leaf litter / ground | `#46362A` → `#3F3621` | Dominant surface. Warm red-brown, H ≈ 25° |
| Bare wet earth / track | `#2B2A1F` → `#161814` | Gullies, deepest shadow |
| Moss (rock & root) | `#535F36` / `#484525` | The *only* green — still only H 64–77°, S ≈ 43 % |
| Canopy foliage | `#2E371F` / `#30381F` | H 79–91°, S 43–46 %, **V only 19–21 %** |
| Foliage highlight | `#78794E` / `#7C7F54` | Backlit leaves at canopy gaps |
| Trunk bark | `#4C4235` / `#3A2E26` | Grey-brown, with green algal cast on one flank |
| Sandstone boulder | `#85744E` / `#817A69` | Light buff, always with moss cap |
| Dry meadow grass | `#876C3F` / `#A4865E` | Open areas only |
| Blown sky through canopy | `#EEE5ED` | Near-white, faintly magenta, never blue |

**Grade pass (post)**

If a LUT or colour grade is applied in post:
1. Rotate midtone greens toward yellow — target hue **55–60°**, not 100–120°.
2. Desaturate midtones to **S ≈ 0.35–0.45**; leave chroma alone above ~0.75 saturation so the brand red, the acid yellow and the flag orange stay hot.
3. Lift shadows slightly **warm** (brown), then crush the toe so p05 lands near 0.09.
4. Keep highlights neutral. Do not add a warm or teal highlight bias.

**Brand-object treatment**

The control flag orange and the Enervit red must be **excluded from the desaturation pass**. In the reference they are the only saturated things on screen, and that contrast is the entire visual thesis: *a muted world, and the brand is the colour in it.*

### 5.3 UI / overlay rules derived from the video

- Corner logo bug: white-on-red rectangle, **11.7 % inset** from top-left, ≈ 17.7 % of frame width, aspect **4.05 : 1**, static.
- Typography: condensed grotesque caps (Trade Gothic Condensed family), **two-weight stack**, left-aligned, ~13 % left margin.
- Accent: acid yellow `#E2EC00` for the first word of a two-word label. *(Non-guideline — confirm before adopting.)*
- Transitions: oblique red slab, **10° off vertical**, leaning right. No dissolves.
- Route line: thin white curve over terrain. Reuse this.

---

## 6. Selected reference frames

`research/raw/videoframes/selected/`

| File | Why |
|---|---|
| `05s-aerial-arena-forest-landscape.jpg` | Macro landscape context — canopy from above, arena clearing, blown sky, hill silhouettes |
| `13s-red-diagonal-wipe-transition.jpg` | The transition device — oblique red slab at 10° over forest |
| `17s-beech-forest-canopy-flat-light.jpg` | **Primary 3D reference.** Trunk density, sightline depth, leaf-litter floor, totally flat light |
| `23s-steep-slope-pack-control-flag.jpg` | Slope, rock steps, understory sparsity, control flag in situ, runners for scale |
| `31s-mossy-sandstone-boulder-leaf-litter.jpg` | **Primary 3D reference.** Moss-capped sandstone, litter texture, mid-distance milky falloff, map handling |
| `36s-lower-third-typography-two-weights.jpg` | The two-weight condensed-caps lower third |
| `40s-control-flag-si-punch-closeup.jpg` | Control flag + SI unit + punching action at close range |
| `57s-endcard-logo-lockup-czech-payoff.jpg` | Full logo lock-up with letterspaced Czech payoff on full-bleed red |

---

## 7. Open questions for the client

1. **Location.** Footage is OWC 2023 Česká Lípa (Liberecký kraj), but the copy says Šumava. Which terrain should the 3D forest represent? Sandstone/beech (as shot) or Šumava granite/spruce?
2. **Brand red.** The video renders it as `#FF0000`; the guidelines and the supplied artwork say `#E40521`. We will build to `#E40521` unless told otherwise.
3. **Acid yellow `#E2EC00`.** Not in the Enervit logo guidelines. Is it an approved campaign colour, and may we use it?
4. **Fonts.** Guidelines name Trade Gothic Lt Std and Digital Serial Bold Oblique. Do we have licences, and is the lower-third face in this video actually Trade Gothic Bold Condensed?
