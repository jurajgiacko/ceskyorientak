# ASSETS NEEDED

Brand assets we could **not** obtain from public sources, what each blocks, who
can supply it, and the placeholder in use meanwhile.

**Status as of 2026-08-01.** For what we *did* get, see `docs/BRAND.md` §2–4 and
the inventory at the bottom of this file.

## Who to ask

| Contact | Role | Reach |
|---|---|---|
| **Dan Dvořáček** | Media manager, OWC 2026 | media@wcup.cz · +420 607 860 698 |
| **Jana Semrádová** | VIP & Partners, ČSOS | jana.semradova@ceskyorientak.cz · +420 731 816 188 |
| **ČSOS** (brand owner) | Czech Orienteering Federation | csos@ceskyorientak.cz |
| **Gradual** | Studio that designed the ČSOS / OWCUP identity | gradual.works |
| **Massimo Caduto** | Corporate Art Director, Enervit S.p.A. | m.caduto@enervit.com |
| **IOF Office** | International Orienteering Federation | via orienteering.sport |

---

## P1 — blocking

### 1. GT Planar licence (or a written waiver)
- **What:** A licence for **GT Planar** (Grilli Type) covering **embedding in a
  distributed application** — desktop + web/app embedding, not just web fonts.
  Styles needed: Regular, Bold, Italic 30 Bold, Retalic 15 Bold.
- **Why:** GT Planar *is* the identity — the 30° slant is the brand's signature
  gesture (`docs/BRAND.md` §2.4). Without it the UI cannot look like the event.
- **Why we can't get it:** commercial retail typeface. Only two `.otf` files are
  exposed on the manual site (`gt-planar-regular.otf`,
  `gt-planar-italic-30-bold.otf`) and those are **served for the manual's own
  rendering — downloading them for our build would be licence infringement.**
  We have deliberately not done so.
- **Ask:** ČSOS / Gradual — does the federation's licence extend to official
  event software, or must VITAR Sport buy its own?
- **Placeholder:** **Space Grotesk** (SIL Open Font License) with a
  `transform: skewX(-15deg)` on short display runs. This is the manual's own
  sanctioned fallback, so it is defensible, not a hack.

### 2. Written OWCUP 26 logo-usage spec
- **What:** clear space, minimum size, approved colourways, and the list of
  prohibited treatments for the `⊙WCUP 26` mark.
- **Why:** we need a defensible rule before the logo appears in a HUD at
  small sizes and over moving terrain.
- **Why we can't get it:** `manual.ceskyorientak.cz/loga-svet` publishes the four
  SVGs and their names, but **no usage rules page** — unlike the colour section,
  which is fully specified. It may exist in an unpublished PDF.
- **Ask:** ČSOS / Gradual — is there a logo manual PDF beyond the web manual?
- **Placeholder:** our proposed standard in `docs/BRAND.md` §5.5(6) — clear space
  = diameter of the finish circle in the logotype; min width 120 px horizontal /
  90 px vertical. **Flagged as unratified.**

### 3. Ruling on `#155055` (dark teal)
- **What:** confirmation of whether this teal belongs to OWCUP 26, to GAPP Czech
  O-Tour only, or to neither.
- **Why:** it appears in the compiled `wcup.cz` stylesheet **and** as the colour
  of the O-Tour lockups in the official media kit, but it is **absent from the
  documented `/barvy-svet` palette table**. We will not put an undocumented
  colour into the product.
- **Ask:** ČSOS / Gradual.
- **Placeholder:** excluded from the UI palette entirely. `#3B4F3C` (MTBO zelená,
  fully documented) covers the dark-green/teal role instead.

---

## P2 — needed before launch

### 4. OWCUP 26 mono white / mono black logo masters
- **What:** official one-colour SVGs — pure white, pure black.
- **Why:** dark HUD, light print, and any single-colour reproduction.
- **Status:** *partially solved.* All four official SVGs are **single-fill
  `#FE5900`**, so a recolour is mechanically clean and arguably within the spirit
  of the identity — and wcup.cz's own header mark ships as `#EDECE3`. But we do
  not have an *approved* mono master.
- **Ask:** ČSOS — approve recolouring, or supply mono files.
- **Placeholder:** `owcup26-hor.svg` / `owcup26-ver.svg` recoloured to `#EDECE3`.

### 5. OWCUP 26 "lockup with dates" in vector
- **What:** vector of the lockup carrying **"5–9 August / Vyšší Brod"**.
- **Why:** wanted for the title/splash screen, where it will be rendered large.
- **What we have:** only **raster, 1170 px wide PNG** from the media kit
  (`owcup26-lockup-dates_orange.png` / `_cream.png`). The SVG set on the manual
  has no dated variant.
- **Ask:** Dan Dvořáček (media@wcup.cz) — the media kit is his.
- **Placeholder:** the 1170 px PNG, capped at ~900 px display width.

### 6. Colour tokens export (`.ase` / `.json` / `.css`)
- **What:** the machine-readable palette exports the manual advertises on
  `/barvy-svet`: RGB `.ase`, CMYK `.ase`, **Figma Design Tokens `.json`**, CSS
  variables `.css`, SCSS `.scss`, **Tailwind config `.js`**, PDF, and "Všechny
  formáty `.zip`".
- **Why:** eliminates transcription risk and gives us the official token *names*.
- **Why we can't get it:** the download buttons are gated behind a
  visualbook.pro login. **We transcribed the values from the rendered page
  instead — they are correct, but unnamed.**
- **Ask:** ČSOS — a visualbook.pro guest login, or just the zip.
- **Placeholder:** hand-transcribed values in `docs/BRAND.md` §2.3, with
  HEX/RGB/CMYK/Pantone all captured.

### 7. IOF logo — vector + usage rules
- **What:** IOF logo in SVG/EPS, plus the IOF brand/usage guidelines and the
  rules governing the **"IOF World Cup"** event mark.
- **Why:** the IOF logo appears in the auspices block on wcup.cz; if we show
  sanctioning marks we must show them correctly.
- **Why we can't get it:** **orienteering.sport returned HTTP 403** to our
  requests, so no IOF-hosted assets or brand pages could be retrieved. We could
  not locate a public IOF media/brand-resources page.
- **Ask:** IOF Office, or Dan Dvořáček (the organiser holds an approved copy).
- **Placeholder:** `assets/brand/iof/iof_logo_full.png` — **400 × 182 raster
  scraped from wcup.cz**. Adequate for a partner strip, **not** for large or
  vector use. **No usage rules obtained — treat as unlicensed until confirmed.**

### 8. Enervit Sport logo — written approval for our specific usage
- **What:** sign-off from Enervit S.p.A. on the game's partner-strip treatment.
- **Why:** guidelines §3 is explicit — *"Every communication materials and
  non-specified situations must be previously approved by Enervit S.p.A."*
  A game HUD is unquestionably a "non-specified situation".
- **Ask:** **Massimo Caduto, m.caduto@enervit.com** — via VITAR Sport.
- **Placeholder:** we implement strictly to the letter of the 03.2022 guidelines
  (white on the red rectangle, fixed proportions, never the shield alone) and
  hold the layout for approval. Files themselves are complete and vector —
  **no asset gap here, only an approvals gap.**

### 9. Enervit brand fonts
- **What:** **Trade Gothic LT Std** and **Digital Serial Bold Oblique** (§6 of the
  guidelines).
- **Why:** only needed if we ever set type *as Enervit* (e.g. a branded
  refreshment-station panel). Not needed for the logo itself, which is outlined.
- **Ask:** Enervit, via VITAR Sport.
- **Placeholder:** none required — no Enervit-voiced typography is planned.
  Logged for completeness.

---

## P3 — nice to have

### 10. Arena Martínkov site plan — ✅ RESOLVED
- **Obtained:** extracted from Bulletin 4 p. 56 →
  **`research/arena/arena-martinkov-site-plan_b4-p56.jpg`** (2048 × 1133).
  Shows all nine zones: arena entrance, event office/first aid, **finish**, team
  zone, media/VIP, WC/washing/water, caterings, sport shops, **fan zone**, over
  the actual orienteering map base. Also extracted:
  `b4_p13_access-map.jpg` (one-way approach/departure routing).
  Documented in `RESEARCH-EVENT.md` §4.1.
- **Residual gap (low priority):** the plan does **not** mark the **spectator
  control / arena passage** route, nor commentary and TV camera positions.
  If we need those, ask **Matěj Burda (Technical Director)** via info@wcup.cz.

### 11. Competition maps (post-event)
- **What:** the four World Cup maps + Český Krumlov sprint map as OCAD/PDF.
- **Why:** ground truth for terrain, and the real course geometry.
- **Why we can't get it:** under **strict embargo** (`B4` §7) until each race is
  run. Available after 9 August 2026.
- **Ask:** Dan Dvořáček after the event; mappers Zdeněk Sokolář, Jan Drbal,
  Ondřej Prášil, Daniel Lebar; sprint map Martin Klein.
- **Placeholder:** published specs (scales, contour interval, ISOM 2017-2 rev. 6)
  in `RESEARCH-EVENT.md` §3, plus the 1998 *Martínkov 2* / *Mnichovice* maps
  referenced in Eventor.

### 12. Terrain and venue photography, licensed
- **What:** high-res stills of the race forest, Arena Martínkov, Vyšší Brod
  square, the Cistercian monastery and Monastery Gardens, Český Krumlov old town.
- **Status:** three official Zenfolio galleries exist and are linked from
  wcup.cz/media/ — **media-kit—venue**, **race-area—promo-shots**, and the logos
  gallery we already harvested. Bulletin 4 §7.1 states embargoed-area photos are
  published **specifically for marketing use**.
- **Why not yet downloaded:** photography wasn't in scope for this pass, and
  Zenfolio serves time-signed URLs that need a browser session.
- **Ask:** Dan Dvořáček for a licence statement covering game use.
- **Placeholder:** none in repo yet.

### 13. ČSOS full logo pack
- **What:** the complete Český orienťák logo set — the manual's `/loga` page
  lists "Základní loga / Loga sportů / Loga podznaček" with per-logo downloads.
- **Status:** we hold the horizontal, dark and footer SVGs plus the mascot —
  enough for a partner strip. The full pack sits behind the same visualbook.pro
  gate as item 6. The identity page notes: *"Loga v dalších variantách můžeme
  poskytnout na vyžádání."*
- **Ask:** csos@ceskyorientak.cz.
- **Placeholder:** `assets/brand/csos/CO_logo-HOR.svg` (vector, sufficient).

### 14. GAPP Czech O-Tour 26 logo in vector
- **What:** vector of the `GAPP CZECH ⊙-TOUR 26` lockup.
- **Why:** only if the game covers the public races.
- **What we have:** four official media-kit **PNGs** (1170 px, teal + cream,
  horizontal + stacked) in `assets/brand/cot26/`. The manual has a
  `/czech-o-tour` section that likely holds SVGs.
- **Ask:** ČSOS.
- **Placeholder:** the PNGs.

---

## What we DID obtain — inventory

All files verified with `file(1)`; **no HTML error pages, no placeholders, no
generated or recreated artwork.**

### `assets/brand/wcup26/` — CONFIRMED OFFICIAL
- **`owcup26-hor.svg`, `owcup26-hor-text.svg`, `owcup26-ver.svg`,
  `owcup26-ver-text.svg`** — the four official lockups from
  `manual.ceskyorientak.cz`, vector, single-fill `#FE5900`. **This is the
  primary win of the exercise.**
- `wcup26-logo.svg`, `wcup26-logo-footer.svg` — site header/footer marks,
  `fill="#EDECE3"`
- `logo-velke.png` (1448 × 1448), `logo-velke-300x300.png`, favicon 270 × 270
- `mediakit/` — 6 official media-kit PNGs at 1170 px incl. the dated lockup,
  plus `_contact_sheet.jpg` for quick visual reference

### `assets/brand/csos/`
- `CO_logo-HOR.svg`, `logo_tmave.svg`, `footer-logo.svg` — vector
- `CO-maskot_Vitez-Bezi.svg`, `maskot.png` — mascot *Lampioňáček*
- `paleta_barvy.png` (2272 × 801) — the official palette artwork
- `identita1-2 / 6 / 8 / 9.png` — identity system boards
- `mediakit/` — 2 official "Czech Orienteering" PNGs
- `co_logo-ver_*.png`, `cot-logo-ver_*.png` — as used on wcup.cz

### `assets/brand/cot26/` — 4 official GAPP Czech O-Tour 26 PNGs (teal + cream)

### `assets/brand/enervit/` — complete, vector, with guidelines
`logo-enervit-senza-payoff.svg` · `.pdf` · `.png` · `.jpg` · `logo-enervit.eps` ·
`enervit-sport-logo-guidelines-03-2022.pdf`

### `assets/brand/iof/` — raster only (see item 7)

### `research/raw/` — all four bulletins as PDF + extracted text
`bulletin1-2.pdf` (20 pp) · `bulletin3.pdf` (30 pp) · `bulletin4.pdf` (64 pp),
plus every wcup.cz page (CZ + EN), the ČSOS brand-manual pages, and
`wcup_app.css` (the compiled theme stylesheet).

### Colour — fully specified, no gaps
HEX **+ RGB + CMYK + Pantone C/U** captured for all five system colours from the
official `/barvy-svet` table. **No hex code anywhere in this project was sampled
by eye or invented.**

---

## Next actions (no client contact needed)

1. ~~Extract Bulletin 4 pages 55–56~~ — **done**, item 10 closed.
2. **Pull the two Zenfolio photo galleries** (item 12) using the same browser
   technique that worked for the logo gallery.
3. **Send one consolidated email to Dan Dvořáček** covering items 2, 3, 5, 7 and
   12 — he is the media owner and can route the brand questions to Gradual.
4. **VITAR Sport initiates the Enervit approval (item 8)** with Massimo Caduto
   once a partner-strip mockup exists.
