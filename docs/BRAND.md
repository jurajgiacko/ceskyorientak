# BRAND — OWCUP 26 × ČSOS × Enervit

How the three identities in this project are defined, and how they must co-exist
in the game UI.

**Rule of the document: no hex code appears here unless it was read out of an
official source file.** Every value below is traceable to the ČSOS brand manual
(manual.ceskyorientak.cz), an official logo SVG, or the Enervit guidelines PDF.
Nothing is sampled by eye or invented.

---

## 1. Provenance

| Identity | Authority | Local files |
|---|---|---|
| **OWCUP 26** | `manual.ceskyorientak.cz/loga-svet` + `/barvy-svet` + `/prvky-svet` — the "Světové eventy" (World Events) layer of the ČSOS system | `assets/brand/wcup26/` |
| **ČSOS / Český orienťák** | `manual.ceskyorientak.cz` (root identity) + `ceskyorientak.cz/identita/` | `assets/brand/csos/` |
| **GAPP Czech O-Tour 26** | same manual, `/czech-o-tour` | `assets/brand/cot26/` |
| **Enervit Sport** | *Enervit Sport Logo Guidelines 03.2022* (14 pp), Enervit S.p.A. | `assets/brand/enervit/` |
| **IOF** | logo as used on wcup.cz | `assets/brand/iof/` |

Design studio for the ČSOS/OWCUP system: **Gradual** (gradual.works).
Manual platform: visualbook.pro. ČSOS contact: csos@ceskyorientak.cz.

**Important structural insight:** OWCUP 26 is **not a standalone brand**. It is a
sub-layer of the Český orienťák identity, sharing its typeface and its orange,
and adding one connecting colour of its own. Treat it as a skin on ČSOS, not as
a separate system.

---

## 2. OWCUP 26 identity

### 2.1 The mark

The logotype is **`⊙WCUP 26`** — the letter **O is replaced by the *symbol of the
finish*** (the double circle of an orienteering finish), set in **GT Planar
Bold**, with the parts of the abbreviation differentiated by **slant**.

From `/prvky-svet` (ČSOS manual, CZ):
> *"Stejně jako je pro identitu Českého orienťáku určující symbol startu – tedy
> moment, kdy vše začíná – pracují mezinárodní a navazující akce (Czech O-Tour)
> se symbolem cíle, který představuje pomyslný vrchol a místo, ke kterému elitní
> orienťáci směřují. Symbol cíle se zároveň propisuje přímo do logotypu, kde
> nahrazuje písmeno O ze slova orienťák a stává se tak jeho přirozenou součástí."*

> **The base ČSOS identity uses the symbol of the START (triangle). The world
> events and Czech O-Tour use the symbol of the FINISH (double circle).**
> This is the single most important semantic rule in the system — do not mix them.

> *"Logotypy jsou vysázeny písmem GT Planar Bold, které svou výrazností odpovídá
> sportovnímu charakteru celé identity. Jednotlivé části zkratky jsou od sebe
> odlišeny nakloněním, které pomáhá strukturovat informace – ať už jde o
> geografické označení (např. world, europe), věkovou kategorii (youth, junior),
> nebo konkrétní ročník."*

### 2.2 Official logo files — CONFIRMED, vector

Downloaded from `manual.ceskyorientak.cz/content/24_loga-svet/`. All four are
**single-colour SVG, 100 % `#FE5900` fill** — which makes recolouring to cream,
white or black a legitimate, guideline-consistent operation.

| File | viewBox | Manual's name |
|---|---|---|
| `assets/brand/wcup26/owcup26-hor.svg` | 500.4 × 73.2 | WCUP 26 – Horizontální |
| `assets/brand/wcup26/owcup26-hor-text.svg` | 813.6 × 73.2 | WCUP 26 – Horizontální + text |
| `assets/brand/wcup26/owcup26-ver.svg` | 353.6 × 186 | WCUP 26 – Vertikální |
| `assets/brand/wcup26/owcup26-ver-text.svg` | 580.7 × 186 | WCUP 26 – Vertikální + text |

"+ text" = with the descriptor *Orienteering World Cup / CZECHIA*.

**Raster from the official media kit** (`assets/brand/wcup26/mediakit/`, 1170 px
wide PNG with alpha) — includes a variant the SVG set does not have: the lockup
**with the dates and place line "5–9 August / Vyšší Brod"**:

| File | Content | Colour |
|---|---|---|
| `owcup26-lockup-dates_orange.png` | ⊙WCUP 26 + descriptor + **5–9 August / Vyšší Brod** | `#FE5900` |
| `owcup26-lockup-dates_cream.png` | same | `#EDECE3` |
| `owcup26-lockup-descriptor_orange.png` | ⊙WCUP 26 + descriptor | `#FE5900` |
| `owcup26-lockup-descriptor_cream.png` | same | `#EDECE3` |
| `owcup26-horizontal-descriptor_orange.png` | single-line, descriptor set small at right | `#FE5900` |
| `owcup26-wordmark-horizontal_orange.png` | ⊙WCUP 26 only | `#FE5900` |

Also in the repo, from wcup.cz itself: `wcup26-logo.svg` and
`wcup26-logo-footer.svg` (the site header/footer marks, `fill="#EDECE3"`,
958 × 142) and `logo-velke.png` (1448 × 1448 circular badge).

### 2.3 Colour — official values

The `/barvy-svet` page defines the world-events palette with full HEX / RGB /
CMYK / Pantone. **These are the authoritative values.**

#### Connecting colour ("Propojující barvy")
> *"Jedním z propojujících prvků napříč světovými eventy a Czech O-Tour je
> výrazná sportovní žlutozelená… Je záměrně intenzivní a energická – svou
> svítivostí evokuje adrenalin, rychlost a nasazení elitních sportovců, zároveň
> přináší pocit otevřenosti a nadšení spojeného s mezinárodním přesahem."*

| Name | HEX | RGB | CMYK | Pantone C | Pantone U |
|---|---|---|---|---|---|
| **Akční žlutozelená** (action yellow-green) | **`#D0EC34`** | 208, 236, 52 | 20-0-100-0 | 381 C | 380 U |
| **OB béžová** (orienteering beige) | **`#EDECE3`** | 237, 236, 227 | 7-7-10-0 | 9224 C | 9184 U |

#### Sport colours ("Barvy pro sporty")
| Name | HEX | RGB | CMYK | Pantone C | Pantone U |
|---|---|---|---|---|---|
| **Orienťácká oranžová** (foot-O orange) | **`#FE5900`** | 254, 89, 0 | 0-70-100-0 | 1575 C | 1505 U |
| **MTBO zelená** | `#3B4F3C` | 59, 79, 60 | 70-40-80-30 | 574 C | 574 U |
| **LOB modrá AKCENT** | `#5597FF` | 85, 151, 255 | 60-40-0-0 | 2925 C | 292 U |

> `#FE5900` is confirmed three ways: the manual's colour table, the fill of all
> four official OWCUP 26 SVGs, and the ČSOS master palette image
> (`assets/brand/csos/paleta_barvy.png`). **This is the event orange. Use it.**

#### Neutrals (read from the manual's own stylesheet, used throughout the system)
`#272727` (near-black, in the ČSOS palette image) · `#161616` · `#525252` ·
`#3A2F2B` (dark brown, ČSOS palette) · `#FFFFFF`

#### Two colours seen in the wild but NOT in the official table — do not treat as canon
- **`#155055` (dark teal)** — the colour of the **GAPP Czech O-Tour 26** lockups
  in the official media kit, and present 3× in `wcup.cz`'s compiled stylesheet.
  It is an **O-Tour** colour, not an OWCUP 26 colour. Confirm with ČSOS before use.
- **`#FF630E`** — appears 31× in the compiled `wcup.cz` theme CSS. It is *not*
  `#FE5900`. Most likely a UI/hover tint introduced by the web build, not a brand
  value. **Do not use it as the brand orange.**

### 2.4 Typography — GT Planar

> *"Základním písmem je GT Planar od švýcarské písmolijny Grilli Type. Výrazný,
> energický charakter a netradiční konstrukce dává vizuálnímu stylu sportovní a
> dynamický výraz. Vhodně reprezentuje pohyb, přesnost i technický aspekt
> orientačních sportů."*

- **GT Planar**, Grilli Type (Swiss). **Commercial licence required — we do not
  own it.** See `ASSETS_NEEDED.md`.
- **The slant is the identity.** GT Planar slants **30° in both directions** —
  further than normal italics.
  > *"Písmo umožňuje náklon o 30° na obě strany – víc, než je běžné u jiných
  > písem. Tento náklon připomíná postoj běžce v plném nasazení, hledání kontroly
  > nebo běh do/ze svahu."*
  Styles present on wcup.cz: `GT Planar Regular`, `Bold`, `Italic 30 Regular`,
  `Italic 30 Bold`, `Italic 15 Bold`, `Retalic 15 Bold` (Retalic = reverse slant).
- **Usage rule:** strong slants **only in headlines, titles and large text**.
  Body copy stays **Regular, upright** —
  > *"V běžném textu je písmo použito v základní podobě (Regular) a drží si
  > střídmý výraz, aby nepůsobilo rušivě."*
- **Official fallback chain (from the manual):**
  **GT Planar → Space Grotesk (Google Fonts) → system sans (Arial on PC,
  Helvetica on Mac).** The system fallback is explicitly a last resort:
  > *"Vybírá se takové, které je záměrně bez výrazu – raději zůstat neutrální,
  > než vizuální identitu narušit."*

**→ Space Grotesk is a sanctioned, free substitute. Build on it.**

### 2.5 Graphic system (`/prvky-svet`)

**The finish symbol as compositional device**
- A **double circle** used large in the background as the main compositional element.
- **Three weights, three jobs:** *medium* = the load-bearing background element;
  *heaviest* = **reserved exclusively for the logo**, matched to the type weight
  for legibility at small sizes; *thinnest* = inherited from the base ČSOS
  identity, used sparingly, typically in the corners of a format.
- Behaviour by background: on light grounds or photos it may be **solid or
  gradient**; on gradient grounds it takes on their character; **on dark grounds
  it reduces to a line drawing** to hold contrast.
- Scale is flexible — full format width, or 2× / 3× the width for dynamic crops.
  It must respect content and never obstruct it.

**North–south lines ("Severojižní čáry")**
- The magnetic north lines of an orienteering map, reinterpreted as a **regular
  vertical grid** that organises all content.
- An **invisible regular grid** spans the full width; **visible lines sit between
  its columns**, and are normally **omitted at the outer edges**.
- Density varies by format; lines may be deliberately **broken or omitted to
  emphasise important information**. Photographs may touch the lines.

---

## 3. ČSOS / Český orienťák identity

- **Mark:** the **symbol of the START** — a triangle, "the moment when everything
  begins". Wordmark **"Český orienťák"** / **"Czech Orienteering"** (EN).
- **Files:** `assets/brand/csos/CO_logo-HOR.svg` (horizontal),
  `logo_tmave.svg` (dark version), `footer-logo.svg`,
  `mediakit/czech-orienteering-horizontal_orange.png`,
  `mediakit/czech-orienteering-stacked_orange.png`,
  `co_logo-ver_v1778434808-300x230.png` (vertical, as used on wcup.cz).
- **Mascot:** *Lampioňáček* — `CO-maskot_Vitez-Bezi.svg`, `maskot.png`. Aimed at
  young participants. **Not appropriate for an elite-event game UI.**
- **Master palette** (`assets/brand/csos/paleta_barvy.png`, sampled from the
  official image and cross-checked against the manual's CSS):
  `#FE5900` · `#EDECE3` · `#B7D3FF` · `#3B4F3C` · `#3A2F2B` · `#272727`
  (also documented: `#ABD3A3`, `#A66047`, `#5597FF`, `#525252`)
- **Type:** GT Planar — the same as OWCUP 26.
- **Supporting elements:** north–south orientation lines, control/finish symbols,
  the lantern (lampion) icon as a directional device, sport pictograms in
  circular control badges.
- **Colour semantics:** colours are **assigned per sport** so disciplines are
  distinguishable at a glance —
  > *"Tyto barvy jsme přiřadili jednotlivým sportům, které tak půjdou na první
  > pohled komunikačně odlišit."*
  Foot orienteering = **orange `#FE5900`**. That is our sport.
- **Further variants:** *"Loga v dalších variantách můžeme poskytnout na
  vyžádání"* — additional logo variants available on request from ČSOS.

---

## 4. Enervit Sport identity

Source: `assets/brand/enervit/enervit-sport-logo-guidelines-03-2022.pdf`
(Enervit Sport Logo Guidelines, 03.2022, 14 pp).

### 4.1 Files we hold
| File | Notes |
|---|---|
| `logo-enervit-senza-payoff.svg` | **Vector, no payoff — the primary file to use.** Single `#000000` path group; the red/white treatment comes from the guideline, not from fills in this file |
| `logo-enervit-senza-payoff.pdf` | vector |
| `logo-enervit.eps` | vector, full logo |
| `logo-enervit-senza-payoff.png` | raster w/ alpha |
| `logo-enervit-senza-payoff.jpg` | raster |

Note: wcup.cz itself uses the **senza-payoff (no payoff) lockup** —
`Logo-Enervit_senza-payoff-1-300x169.jpg` — so our files match the event's usage.

### 4.2 The rules that constrain us

| § | Rule |
|---|---|
| 5 | The logo must **always** consist of the word "Enervit" **and** the shield with the inscribed arrow. *"it is therefore strictly forbidden to use individual parts of it. Example: It is never possible to use the shield individually."* |
| 4 | The **Sport** brand logo and the **Corporate** logo are different marks and *"must never be confused or replaced one another."* We use the **Sport** logo. |
| 7 | **Red: `#E40521`** — C0 M100 Y90 K0 · R228 G5 B33 · Pantone 485 (Pantone described as *"Not recommended. To be chosen only when Pantone is the only available option."*) |
| 7 / 9 / 13 | **The logo is white on a red rectangle.** The logotype, payoff and red rectangle have **fixed proportions that must always be maintained.** |
| 11 | On a non-red background, the logo is still used **with the colours and proportions of the logotype and red rectangle** — i.e. the red rectangle travels with it. Recolouring or distorting the logo is shown as a "NO!". |
| 10 | Black-only version: **only where strictly necessary** for B&W print — red converts to **K100 / Pantone Black**. Not recommended otherwise. |
| 13 | **No white border. No colours other than the official Enervit red.** |
| 6 | Brand fonts: **Trade Gothic LT Std**, **Digital Serial Bold Oblique** |
| 8 | Optional supporting line: **"BEFORE, DURING, AFTER SPORTS"** |
| 3 | *"Every communication materials and non-specified situations must be previously approved by Enervit S.p.A."* Contact: **Massimo Caduto, Corporate Art Director — m.caduto@enervit.com** |

### 4.3 The conflict, stated plainly

**`#E40521` (Enervit red) and `#FE5900` (event orange) are adjacent hues at
similar value.** Side by side at small sizes they vibrate and read as a mistake.
Worse, the Enervit logo arrives as an **immovable red rectangle** — we cannot
knock it back, tint it, or outline it.

**Therefore: the Enervit red rectangle and the event orange must never share an
edge or sit on the same surface.** The resolution is in §5.3.

---

## 5. Recommendation for the game's UI design language

### 5.1 Core principle

The event's own story is **"return to the forest"** — a dark, granite,
spruce-covered plateau at 700–1,000 m, scattered with boulder fields, marshes and
the ruins of vanished villages. The identity answers it with one hot orange, one
electric yellow-green, and a warm beige.

**So: build a dark-ground UI.** It matches the terrain, it is correct for a HUD,
and — critically — a dark neutral field is the only surface on which `#FE5900`
and `#E40521` can both appear without fighting, provided they are separated.

### 5.2 Palette

| Role | Hex | Source |
|---|---|---|
| **Surface / base** | `#161616` | ČSOS manual neutral |
| Surface raised | `#272727` | ČSOS palette image |
| Surface sunken / hairlines | `#525252` | ČSOS manual neutral |
| **Primary — brand, headings, the mark** | **`#FE5900`** | Orienťácká oranžová (Pantone 1575 C) |
| **Accent — live/active state, timing, "you are here"** | **`#D0EC34`** | Akční žlutozelená (Pantone 381 C) |
| **Foreground / body text** | **`#EDECE3`** | OB béžová (Pantone 9224 C) |
| Secondary text | `#EDECE3` @ 65 % | derived |
| **Terrain / map-surface accent** | `#3B4F3C` | MTBO zelená — reads as forest |
| Information / links / cool accent | `#5597FF` | LOB modrá akcent |
| Earth / historical layer (ruins, walls) | `#3A2F2B` | ČSOS palette image |

**How primary and accent divide the work — a real rule, not decoration:**
- **`#FE5900` = identity.** The logo, section headings, the brand furniture.
  It is the event *speaking*.
- **`#D0EC34` = state.** Anything live, running, selected, or urgent: the running
  clock, the leader, the active control, the current leg. It is the event
  *happening*. The manual's own words justify this — the colour is *"záměrně
  intenzivní a energická… evokuje adrenalin, rychlost a nasazení"*.

Never use the two at equal weight in the same component; the accent should be
scarce enough that it always means something.

### 5.3 Type pairing

| Level | Face | Treatment |
|---|---|---|
| Display / event titling | **GT Planar Bold**, slanted (Italic 30) — **if licensed** | Slant is the signature. Titles only. |
| Display fallback | **Space Grotesk Bold** with a **CSS `skewX(-15deg)`** applied to short headline runs | The manual sanctions Space Grotesk; the skew approximates GT Planar's slant honestly, without faking the typeface |
| UI / body | **Space Grotesk Regular / Medium**, upright | Per the manual: body copy stays upright and restrained |
| Numerals — clocks, splits, distances | **Space Grotesk**, `font-variant-numeric: tabular-nums` | Non-negotiable for a timing HUD |
| Last resort | Arial (PC) / Helvetica (Mac) | The manual's stated final fallback |

Do **not** substitute a random condensed sans for GT Planar. The manual's whole
point about fallbacks is *"raději zůstat neutrální, než vizuální identitu
narušit"* — better neutral than wrong.

### 5.4 Graphic language

- **North–south lines as the layout grid.** Vertical rules between columns,
  omitted at the outer edges, breakable to highlight a value. This is the single
  cheapest, most authentic way to make the UI read as *this* event's.
- **The finish double-circle as the background element** — large, off-centre,
  and **on our dark ground it must be a line drawing, not a solid** (explicit
  rule in `/prvky-svet`). The heaviest weight stays reserved for the logo.
- **Never draw the start triangle** in OWCUP-branded UI. That is the base ČSOS
  mark and means something different.

### 5.5 Partner-logo placement — the rule

**A partner strip is a separate surface, not an overlay.**

1. **Dedicated band.** All partner logos live in a discrete band with its own
   background — **`#EDECE3` (OB béžová)** — pinned to the bottom of the screen or
   the end of a results panel. Never floating over gameplay, terrain, or the map.
2. **Why beige and not dark:** it lets **Enervit's mandatory red rectangle sit on
   a neutral light ground**, exactly as its guidelines assume, and it puts a
   physical band of beige between `#E40521` and any `#FE5900` on the dark surface.
   The conflict in §4.3 is solved by separation, not by tinting.
3. **Enervit's red rectangle is never modified** — not knocked out, not
   monochromed, not bordered, not rescaled non-proportionally, never reduced to
   the shield alone.
4. **Never place Enervit red directly adjacent to `#FE5900`.** Minimum **one
   clear-space unit** of beige between the Enervit lockup and any orange element.
5. **Tier order follows the event's own hierarchy** (see
   `RESEARCH-EVENT.md` §8): **Main Partners first** — Lucifer Lights, GAPP,
   **Enervit**, O-run — then Main Institutional, Institutional, Partners.
   Enervit is top-tier and the sole nutrition brand; size it accordingly.
6. **Clear space** (no published figure exists for the OWCUP 26 mark, so this is
   our working standard, to be ratified by ČSOS): **clear space on all sides =
   the diameter of the finish double-circle in the logotype**; **minimum width
   120 px** for `owcup26-hor.svg`, **90 px** for `owcup26-ver.svg`. Below that,
   use the wordmark-only variant.
7. **In-world branding is separate from UI branding.** The Enervit-branded
   refreshment cups at controls (`B4` §11.14 — Enervit Isotonic in branded cups,
   water in transparent cups) are a *terrain* detail and can be modelled in the
   world; they do not license putting the logo in the HUD.

### 5.6 Logo variant selection

| Context | File |
|---|---|
| Dark HUD, horizontal space | `owcup26-hor.svg` **recoloured to `#EDECE3`** (legitimate — the source is a single-fill vector, and the site's own header mark is `#EDECE3`) |
| Dark HUD, tight/stacked | `owcup26-ver.svg` recoloured to `#EDECE3` |
| Light/beige surfaces, print | `owcup26-hor.svg` / `owcup26-ver.svg` as supplied, `#FE5900` |
| Splash / title screen | `owcup26-lockup-dates_cream.png` — carries "5–9 August / Vyšší Brod" |
| Favicon / app icon | `logo-velke.png` (1448 × 1448) |

---

## 6. Open questions for ČSOS

Listed in full, with owners, in `ASSETS_NEEDED.md`. The three that block design
decisions rather than just polish:

1. **Is `#155055` an OWCUP 26 colour or an O-Tour-only colour?**
2. **Does a written OWCUP 26 clear-space / minimum-size spec exist**, or do we
   ratify ours?
3. **Is there a GT Planar licence we can use**, or do we commit to Space Grotesk?
