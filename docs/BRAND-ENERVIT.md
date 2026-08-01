# BRAND — Enervit

Source of truth: **Enervit Sport — Logo Guidelines, 03.2022** (14 pp, Adobe Illustrator 26.3, authored by Massimo Caduto, Enervit Corporate Art Director).

Brand contact named in the guidelines for approvals and queries: **Massimo Caduto — Corporate Art Director, `m.caduto@enervit.com`**. The guidelines state explicitly that *"every communication material and non-specified situation must be previously approved by Enervit S.p.A."* — our 3D/web treatment is a non-specified situation, so it will need sign-off.

---

## 1. Which logo is this

⚠️ **Critical distinction from §2 of the guidelines.** There are two near-identical Enervit logos and they must never be swapped:

| | Logo | Distinguishing feature |
|---|---|---|
| **Sport brand & products logo** | Wordmark + shield/arrow on red rectangle, **no payoff line** | This is the one we use |
| **Company / Corporate logo** | Same wordmark **plus** the payoff `The Positive Nutrition Company` set inside the rectangle beneath | Corporate comms only — **not** for us |

> *"despite the similarity with Corporate name and logo … That Logo and the Corporate one below must never be confused or replaced one another."*

Everything supplied in the asset folder is the **Sport** logo (Italian: *senza payoff* = "without payoff"). Correct for this project.

The lock-up is indivisible. Per §3: the logo must always consist of the word "Enervit" **and** the shield with the inscribed arrow. *"it is therefore strictly forbidden to use individual parts of it. Example: It is never possible to use the shield individually."* — so no arrow-only favicon, no shield-only app icon.

---

## 2. Files available

### Copied into this repo — `assets/brand/enervit/`

Filenames normalised to lowercase-with-hyphens. All verified with `file`.

| File | Format (verified) | Dimensions | Use |
|---|---|---|---|
| `logo-enervit.eps` | PostScript DSC 3.1, **EPS Level 2**, Illustrator 26.3 | 364.81 × 88.63 pt | **Master vector.** CMYK. Print, and the source for any new export |
| `logo-enervit-senza-payoff.pdf` | PDF 1.7, 1 page, vector | 842.3 × 473.9 pt artboard | **Best vector for placement.** Opens in any design tool, renders correctly |
| `logo-enervit-senza-payoff.png` | PNG, 8-bit **RGBA** | 4001 × 2251 | **Best raster / best for web.** True transparency outside the rectangle |
| `logo-enervit-senza-payoff.jpg` | JPEG baseline, RGB | 4001 × 2251 | Flattened on white. Avoid unless a JPEG is required |
| `logo-enervit-senza-payoff.svg` | SVG 1.0 | 4001 × 2251 pt | ⚠️ **Black version, autotrace.** See §2.2 |
| `enervit-sport-logo-guidelines-03-2022.pdf` | PDF 1.6, 14 pp | 840 × 594 pt | The guidelines themselves, for reference |

**Original location:** `/Users/jurajgiacko/Projects/JG 2026/VitarSport2026/Context/brand/enervit-guidelines/`

### 2.1 Measured geometry (from the master PNG)

| Property | Value |
|---|---|
| Red rectangle | 3897 × 947 px within a 4001 × 2251 canvas |
| **Rectangle aspect** | **4.115 : 1** |
| Canvas | 16 : 9 — the artwork is centred with generous vertical padding |
| Alpha | Transparent outside the rectangle; the rectangle itself and the white letterforms are **fully opaque** |
| `®` symbol | Present, at the top-right of the `T` |

The 4.115 : 1 rectangle is the fixed proportion referred to throughout the guidelines. It matches the corner bug in the client's own reference video, measured at 4.05 : 1.

### 2.2 ⚠️ The SVG is not what you'd expect

`logo-enervit-senza-payoff.svg` is **not** the official vector. It is a **bitmap autotrace** (single `<path>`, `fill="#000000"`, `pt` units equal to the PNG's pixel dimensions — the signature of a potrace-style conversion of the raster).

It renders as a **black rectangle with the letterforms knocked out as transparent holes** — i.e. the letters are not painted white, they are absent.

Consequences:

- ✅ Usable as-is as the **black (K100) version** from §8 of the guidelines, **over white or light backgrounds only**.
- ❌ **Not** a drop-in white-on-red asset.
- ❌ Recolouring `fill` to `#E40521` does **not** produce the correct logo — the letters would show whatever is behind, and over a dark background they would go dark. The guidelines require the letters to be **white**. Doing this would be an unauthorised alteration.
- ❌ Curve fidelity is trace-quality, not original Bézier.

**For web, use the PNG or the PDF.** If a genuine SVG is needed, it should be exported from `logo-enervit.eps` in Illustrator — or, better, requested from Enervit.

---

## 3. Colour

### Official — guidelines §5

| | Value |
|---|---|
| **HEX** | **`#E40521`** |
| **RGB** | R 228 · G 5 · B 33 |
| **CMYK** | **C 0 · M 100 · Y 90 · K 0** |
| Pantone | **485** — *explicitly "Not recommended. To be chosen only when Pantone is the only available option."* |

Measured in the supplied artwork: **`#E40421`** (PNG) / `#E40321` (JPEG). A 1-unit rounding difference from spec — the artwork is correct. **Use `#E40521`.**

The EPS confirms the build: `%%DocumentProcessColors: Magenta Yellow` — the red is composed from process M and Y only, exactly C0 M100 Y90 K0. No spot colour is embedded.

### Logo colours

- Wordmark and shield/arrow: **white**, always.
- Background rectangle: **`#E40521`**, always (or black — see below).

### Black version — guidelines §8

*"Only in cases where it is strictly necessary, although not recommended, to print black and white materials the red must be converted in black."*

**K 100 / Pantone Black.** Same lock-up, same proportions, white letterforms on a black rectangle. The supplied SVG is effectively this version (with the caveat in §2.2).

### ⚠️ The reference video does not match the spec

The client's own promo video renders the brand red as **`#FF0000`** (pure, gamut-clipped), not `#E40521`. See `docs/RESEARCH-VIDEO.md` §2.1. This is almost certainly an authoring artefact. **Build to `#E40521`.**

The video also introduces an **acid yellow `#E2EC00`** as a typographic accent. This colour appears **nowhere in the Enervit logo guidelines**. Treat it as an unapproved campaign colour and confirm before using.

---

## 4. Clear space and minimum size

⚠️ **Neither is numerically specified in this document.**

This is a 14-page logo guideline, not a full brand manual. It has no exclusion-zone diagram with X-height units, and no minimum reproduction size in mm or px. §7 ("The red rectangle") shows proportion tick-marks against the lock-up, but these define the **internal** relationship between logotype, payoff and rectangle — they are not a clear-space rule.

What the guidelines *do* mandate:

- The logotype, payoff and red rectangle have **fixed proportions that must always be maintained**.
- The red rectangle is itself the container — the logo is never presented without it.

**Practical recommendation** (our convention, not Enervit's — flag it if it goes to Enervit for approval): use the height of the shield/arrow ellipse as the clear-space unit, keeping a minimum of **0.5 × rectangle height** free on all four sides. For minimum size, keep the rectangle **≥ 24 px tall** on screen (≈ 99 px wide at 4.115 : 1) so the `®` and the arrow counter stay legible; below that the mark mushes.

**If clear space or minimum size matters for a deliverable, ask Enervit** — do not infer it.

---

## 5. Permitted backgrounds and placement

From §9 (Proportions and use on different Backgrounds) and §11 (Dos and Don'ts):

### ✅ Allowed

- The red rectangle lock-up on a **plain red field** (the rectangle bleeds into the background).
- The red rectangle lock-up on **black**.
- The red rectangle lock-up on **white**.
- The red rectangle lock-up **over photography** — the guidelines' own YES example places it over a busy sports photo.
- The red rectangle lock-up on **grey** or **dark green** (shown in the §8 examples).
- The **black** rectangle version on white/light grey — B&W print only.

The governing principle: *"In the event it must be shown against a background of a colour other than red, the logo will strictly be used with the colours and proportions of the logotype and red rectangle, as described in section 7."* — i.e. **the red rectangle always travels with the logo.** There is no "logo only" free-standing variant.

### ❌ Forbidden

| Don't | Source |
|---|---|
| Use the **shield/arrow on its own** | §3 — "never possible to use the shield individually" |
| Use the **wordmark without the rectangle** | §9, §11 |
| Add a **white border/keyline** around the rectangle | §11 — explicit NO |
| Use **any colour other than the official red** for the rectangle (blue and light-blue shown as NO) | §11 |
| Set the **logo in red** (red letterforms instead of white) on another background | §9 — explicit NO |
| **Distort** / stretch / alter the proportions | §9 — explicit NO |
| Let the logo **break the edge** of the frame or hang half-off the layout | §11 — explicit NO |
| **Confuse it with the Corporate logo** | §2 |
| Alter the logo *"in any other way"* | §1 |

---

## 6. Typography — guidelines §4

Two faces are named:

| Font | Role |
|---|---|
| **Trade Gothic Lt Std** | Primary. The workhorse for all main communication |
| **Digital Serial Bold Oblique** | Secondary / display |

The guidelines show only alphabet specimens — no size scale, no weight assignments, no hierarchy rules.

The client's reference video uses a **condensed grotesque in all caps, in two weights** for its lower thirds, consistent with the **Trade Gothic Bold Condensed / Condensed** cuts of the Trade Gothic family. Payoff lines are set in the same family, heavily letterspaced (~0.35–0.45 em). See `docs/RESEARCH-VIDEO.md` §2.2 for measurements.

⚠️ **Licensing not verified.** Trade Gothic Lt Std is a Linotype/Monotype family; Digital Serial is a SoftMaker face. Neither is free, and neither is on Google Fonts. **We need to confirm whether the project holds web-font licences** before shipping either in a browser build. If not, a licensed condensed-grotesque substitute will be needed (Roboto Condensed and Archivo Narrow are the usual open fallbacks, though neither is a close match to Trade Gothic).

---

## 7. Sanctioned use cases — guidelines §10

Listed applications: magazine and newspaper advertising · packaging · banners and event arches · event booths · branded sportswear · below-the-line materials · P.O.P. materials (floorstands, flyers, trade folders, consumer leaflets).

Web, app and 3D/interactive are **not listed** — reinforcing that our use is a "non-specified situation" requiring Enervit approval per §1.

---

## 8. Gaps — assets we do NOT have

Recorded here rather than invented. **No logo has been generated or recreated.**

| Missing | Impact |
|---|---|
| **True white / mono-white version** for dark UI | Blocking for a dark-themed interface. The guidelines do not sanction a white-only logo anyway — the rule is that the red rectangle always travels with it, so the red lock-up over dark is the compliant answer. If a knockout-white version is genuinely needed, **request it from Enervit** |
| **Genuine SVG** of the red lock-up | The supplied SVG is a black autotrace (§2.2). Export from the EPS, or request from Enervit |
| **Corporate (with-payoff) logo** in any format | Not needed for this project — and per §2 we must not use it |
| **Enervit Sport sub-brand / product-line logos** (C2:1, Pure Pro, The Protein Deal) | Not in the guidelines folder. Product *packshots* exist (§9) but no line logos |
| **Numeric clear-space and minimum-size rules** | Not in this document (§4). Ask Enervit if a deliverable depends on them |
| **Font files / web-font licences** | Not present anywhere in the brand folders (§6) |
| **Colour rules beyond the red** | No secondary palette, no tints, no accessible-contrast guidance. The video's `#E2EC00` is unaccounted for |

---

## 9. Wider asset inventory

### `…/Context/brand/enervit-guidelines/` — 6 files

The guidelines PDF plus the five logo files listed in §2. **This is the only place logo artwork exists.**

### `…/Context/brand-assets/enervit-brand/` — 260 files

⚠️ Despite the name, this folder contains **no logo artwork whatsoever** — the only non-image file is a duplicate of the same guidelines PDF (byte-identical size, 452 783 bytes). It is entirely **product photography**: packshots, foil/sachet renders (many with transparent backgrounds), ingredient-panel scans, and lifestyle shooting.

Organised by product line:

| Line | Contents |
|---|---|
| **SPORT** (22 sub-folders) | Energy Bars (Performance / Power Time / Power Crunchy / Competition), Protein Bar, Isotonic Gel, Liquid Gel, Gel (Cola, Raspberry), Sport Drink, Isotonic Drink, Instant Sport Drink, Recovery Drink, Maltodextrin, Carbo Tablets, Magic Cherry, Magnesium, Salt Caps, Vitamins, Presport, Instant BCAA, 100% Whey Protein, After Sport |
| **C2_1** (13 sub-folders) | Carbo Gel (Cola, Mango, Lime, Lemon Sodium, Orange), Carbo Bar (Brownie, Peanut, No Flavour), Carbo Jelly, Carbo Chews, Isocarb, Isocarb Sachets |
| **PURE PRO** | Packshots (Isolate Whey Protein Grass Fed, Electrolytes Boost, Pre/Post Workout Boost, Protein bars) + a 17-file `SHOOTING` lifestyle set |
| **THEPROTEINDEAL** | 5 flavour packshots |

Typical per-product set: a main hero JPG, a transparent-background PNG of the pack (`… traspa.png`), a box render, and an ingredients-panel JPG.

**Relevant to us:** the three products featured in the reference video have artwork here —
- `SPORT/PRESPORT/` → the Pre Sport jelly sachet (video 14–16 s)
- `C2_1/CARBO GEL MANGO/` → `Enervit Carbo Gel foil Mango 2024 traspa.png` (video 27–30 s)
- `SPORT/RECOVERY DRINK/` → the R2 Recovery tub (video 42–44 s)

These have not been copied into this repo — pull them only if the build actually needs product renders.

---

## 10. Quick reference

```
Brand red      #E40521    rgb(228, 5, 33)    C0 M100 Y90 K0    (Pantone 485, discouraged)
Logo colour    #FFFFFF    always white letterforms
Mono version   K100 / Pantone Black rectangle, white letterforms — B&W print only
Rectangle      4.115 : 1  fixed, never distorted
Lock-up        wordmark + shield/arrow + rectangle — indivisible
Fonts          Trade Gothic Lt Std · Digital Serial Bold Oblique   (licences unverified)
Approvals      Massimo Caduto — m.caduto@enervit.com
```

Web asset of choice: **`assets/brand/enervit/logo-enervit-senza-payoff.png`** (RGBA, 4001 × 2251).
Vector of choice: **`assets/brand/enervit/logo-enervit-senza-payoff.pdf`** — *not* the SVG.
