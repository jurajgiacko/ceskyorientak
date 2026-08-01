# Roadmap

The event is **5–9 August 2026**. Everything is ordered so a cut is always
possible: anything below the MVP line can be dropped without making the thing
above it incoherent.

## The MVP line

> **Sprint Krumlov + Long Martínkov + full nutrition system + local personal
> bests and ghosts = shippable.**

Nothing below that line blocks a release.

---

## Above the line — MVP

### M0 · Foundation ✅
- [x] Repo, TypeScript + Vite + three.js, strict tsconfig
- [x] Domain contracts (`src/core/types.ts`) — the interface every subsystem builds against
- [x] Geo transforms, local metric frame
- [x] `ScoreStore` interface + `LocalStore`
- [x] i18n CZ/EN/SK with missing-key detection
- [x] Capability probe and quality tiering
- [x] Deploy pipeline live and green

### M1 · Research (mandatory before mechanics)
- [x] `docs/RESEARCH-SPORT.md` — ISOM 2017-2, ISSprOM 2019-2, control descriptions, formats, speed model
- [x] `docs/RESEARCH-GEODATA.md` + `docs/DATA_LICENCES.md` — ČÚZK, OSM, verified endpoints
- [x] `docs/NUTRITION_PROTOCOL.md` + `docs/CLAIMS_TO_REVIEW.md` — real protocol, EU 1924/2006
- [x] `docs/RESEARCH-EVENT.md` + `docs/BRAND.md` — programme, terrain, identity
- [x] `docs/RESEARCH-VIDEO.md` — grade and look reference

### M2 · Terrain pipeline
- [x] `tools/terrain/` ingests ČÚZK DMR 5G → heightmap for both venues
- [x] Runnability classification from ortho + canopy height + OSM landuse
- [ ] Krumlov building/wall/step geometry from OSM
- [x] Compressed binary output in `public/data/`, no runtime geo API calls

### M3 · The map (navigation layer)
- [x] ISOM/ISSprOM vector renderer, correct colours and symbols
- [x] Control description pictograms as real SVG symbols, columns A–H
- [x] Course overprint: start triangle, circles with gaps, connecting lines, finish
- [x] Dead reckoning: believed vs true position, error accumulation, punch reset
- [ ] Compass, thumbing, route drawing

### M4 · The forest (execution layer)
- [ ] Terrain rendering with the derived heightmap
- [ ] Instanced spruce/beech with LODs and billboard imposters
- [ ] Boulder fields, undergrowth, marsh, forest floor
- [ ] Movement physics driven by `Runnability` and gradient
- [ ] Lighting, sky, volumetrics matched to real start times

### M5 · Krumlov (sprint)
- [ ] Old town geometry, walls that genuinely block, staircases, courtyards
- [ ] Recognisable skyline: castle, tower, cloak bridge, náměstí Svornosti, Latrán

### M6 · The Enervit system
- [ ] Four stats simulated: glycogen, hydration, blood sugar, focus
- [ ] BEFORE — pre-race preparation screen against start time and course profile
- [ ] DURING — race belt, real time cost per intake, feed zones on Long
- [ ] AFTER — recovery carrying into the next race day
- [ ] Post-race "what the pros actually do" card, claims-compliant

### M7 · Shell, UI, audio
- [ ] Menu → prerace → race → finish → results, all animated, no cuts
- [ ] HUD legible in sunlight on a phone; touch controls
- [ ] Results: splits, route replay, ghost comparison, share image
- [x] Self-authored audio: footfall by ground, breathing, SI beep, arena

### M8 · Verification
- [ ] Judge V (visual), O (orienteering), G (game feel), B (brand & compliance) all pass
- [ ] 60 fps desktop / ≥30 fps mid-range mobile, measured and captured
- [ ] Initial load ≤ 15 MB, time-to-first-play ≤ 8 s on 4G
- [ ] Perf budget test in CI
- [ ] README for the client marketing team, `ASSETS_NEEDED.md`, `CLAIMS_TO_REVIEW.md`

---

## Below the line — post-MVP

Ordered by value, cut from the top down if time runs out.

- **Daily Challenge** — deterministic date-seeded course. Cheap, high retention.
- **Middle distance** at Martínkov — reuses M2/M4 entirely.
- **Career week** — the full Tue–Sun World Cup progression with points table.
- **Weather** — rain and valley mist affecting visibility, runnability, hydration.
- **Relay** — forked legs, mass start, spectator control loop.
- **`FirebaseStore`** — anonymous auth, global/daily leaderboards, server-side
  split-plausibility validation, GDPR-correct optional email capture, discount
  code slot. Behind the existing interface, one env flag. **Do not start until
  LocalStore gameplay passes all four judges.**
- **Analytics** — consent-gated, behind an interface, no-op in MVP.
- **Qualification race**, opening ceremony cutscene, tutorial in model terrain.
- **Reusable skills** — `orienteering-map-render`, `cuzk-terrain-pipeline`,
  `blender-hardsurface-outdoor`, `nanobanana-texture-pipeline`.
