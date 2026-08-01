# Decisions

Every non-obvious call, with the reasoning. Newest last.

---

## D-001 — Local tangent plane instead of a projection library

**Decision.** Runtime uses an equirectangular local frame anchored per venue
(`src/core/geo.ts`). No proj4 in the bundle. All S-JTSK / EPSG:5514 (Krovák)
work happens once, offline, in `tools/terrain/`.

**Why.** Both venues are ~4 km across. Across that span the tangent-plane
approximation errs by well under 1 cm — two orders of magnitude below the
~0.2 m vertical accuracy of the DMR 5G source. Shipping proj4 would cost
~40 kB gzip and CPU in a hot path (the map renderer transforms thousands of
vertices per frame) to buy accuracy we cannot perceive.

**Cost.** A third venue far from these two needs its own anchor. That is one
line of config.

---

## D-002 — Runnability encoded as a speed multiplier in the enum

**Decision.** `Runnability` (`src/core/types.ts`) is an enum whose members map
directly to ISOM vegetation symbols, and the speed table is keyed off it.

**Why.** The brief's hard requirement is that "vegetation slows you the way the
green shades promise." The failure mode is drift: the map renderer draws medium
green while the physics applies light-green speed. One shared enum, one table,
makes that class of bug impossible rather than merely unlikely. An orienteer
would spot the drift instantly, so it is worth structural prevention.

---

## D-003 — Headless Blender CLI, not Blender MCP, as the asset pipeline

**Decision.** 3D assets are authored by committed Python scripts run through
`blender --background --python` and driven by `tools/blender/build.mjs`.
`blender-mcp` is configured for interactive use but is not the pipeline.

**Why.** Three reasons, in order of weight:
1. **Reproducibility.** An asset that exists as a committed `.py` rebuilds
   identically on any machine and in CI. An asset produced by GUI actions
   through MCP exists only as its output `.glb` — the recipe is lost.
2. **No GUI dependency.** `blender-mcp` requires Blender running with its addon
   enabled and a socket server started from the 3D viewport sidebar. That is a
   manual step before every session, and it cannot happen in CI.
3. **Availability.** Blender was not installed on this machine, and MCP servers
   only register at session start — so MCP could not have been used in the
   session where the assets were needed regardless.

**Cost.** Scripted modelling is slower to iterate than direct manipulation. We
mitigate with headless turntable preview renders that are inspected each build.
`docs/BLENDER_MCP_SETUP.md` covers enabling MCP for interactive sculpting when
that is the better tool.

---

## D-004 — Quality tier decided at boot, not left to the user

**Decision.** `src/core/capabilities.ts` probes the device and sets a
`low | medium | high` tier before anything heavy loads. Settings can override,
but the default is automatic.

**Why.** The brief requires one build to hold 60 fps on a 2021 laptop iGPU and
≥30 fps on a mid-range Android phone. The target player is a spectator standing
in Arena Martínkov on a phone who has 60 seconds of patience — they will not
find a graphics menu, and if the first frame stutters they leave. Device memory
turned out to be a better phone signal than `hardwareConcurrency`, which
over-reports on big.LITTLE designs.

---

## D-005 — `ScoreStore` interface defined before any storage code

**Decision.** `src/core/types.ts` declares `ScoreStore`; `LocalStore` is the
only implementation in the MVP, and nothing outside `src/store/` touches
`localStorage`.

**Why.** The brief wants Firebase as a post-MVP flag flip. That only stays true
if no caller ever depends on storage being synchronous or local — hence every
method returns a Promise even though `LocalStore` resolves immediately.

**Note.** `LocalStore.submitRun` degrades deliberately on quota exhaustion: it
drops ghost route data from older runs and retries, because a recorded time
without a ghost is still worth keeping and a storage error must never take down
a race that was just completed.

---

## D-006 — Provisional palette, tokenised

**Decision.** `src/styles/base.css` defines all colour as custom properties, with
values marked provisional pending confirmed brand research.

**Why.** Brand assets are being gathered in parallel with scaffolding. Tokenising
up front means the confirmed WCUP26 / Enervit values land as a single-file edit
rather than a hunt through components. The IOF overprint purple and control-flag
orange are already correct in character — they are the colours of the sport
itself, not of any sponsor.

---

## D-007 — The reference video is brand reference, not terrain reference

**Decision.** `2026-07-30 EN Video Svetovy Pohar` drives our **grade, identity and
motion language**. It does **not** drive our terrain look.

**Why.** Frame analysis (see `docs/RESEARCH-VIDEO.md`) established that the
footage is from **OWC 2023, Česká Lípa** — on-screen banners read `OWC 2023 ·
Česká Lípa` and `Liberecký kraj / Round 2`. That is Liberec-region sandstone
and beech: brown leaf litter, smooth grey-green trunks, mossy sandstone blocks.
Vyšší Brod is Šumava **granite and spruce** — needle floor, boulder fields,
darker canopy. Copying the video's biome would produce a forest an orienteer
would immediately place in the wrong part of the country.

The video's headline nonetheless reads `PRO ŠUMAVSKÉ KOPCE` over that footage.
That inconsistency is the client's, and is flagged for them rather than
resolved by us — see `ASSETS_NEEDED.md`.

**What we do take from it:** the grade (AgX tone mapping, exposure ~0.85,
grey-olive `FogExp2` rather than white, AO carrying the contrast), the identity
(the 10°-oblique red slab transition matching the wordmark's italic, two-weight
condensed caps for lower thirds), and the thin white route-line motif — the
client's visual language already contains an orienteering device we can reuse.

---

## D-008 — Sunny hero light, overcast as a weather state

**Decision.** The default and marketing-facing look is the brief's
specification: 10:00 sun angles, hard shadows, volumetric god rays through
spruce canopy. The video's flat overcast look ships as one of the weather
states.

**Why.** These initially read as contradictory: the brief asks for god rays,
the client's own film is completely diffuse with no hard shadow anywhere. They
reconcile cleanly because the brief already requires weather (dry / light rain /
mist in the valley). Overcast is not a compromise between them — it is a
distinct, authentic condition that Czech August genuinely delivers, and it is
the condition the client filmed in.

Building both also earns its keep in gameplay: flat light removes shadow as a
navigation cue, which is a real and legible difficulty modifier.

---

## D-009 — The supplied Enervit SVG cannot be recoloured

**Decision.** Use the PNG for web and the PDF for vector. Treat
`logo-enervit-senza-payoff.svg` as the K100 black version for light
backgrounds only, and never restyle it.

**Why.** The supplied SVG is a bitmap autotrace, not the official vector: five
paths under a single `fill="#000000"`, whose first path is the full outer
rectangle. The letterforms are **knockouts**, not glyphs. Setting the fill to
Enervit red would therefore not produce a red logo — it would produce a red
rectangle whose letters show whatever sits behind them, which the brand
guidelines explicitly forbid. This is the kind of change that looks correct in
a diff and is wrong on screen, so it is recorded here rather than left to be
rediscovered.

Official red is **`#E40521`** (C0 M100 Y90 K0). Note the video's red is
`#FF0000` — gamut-clipped and broadcast-illegal; we build to the spec value.

A white/mono version for dark UI does not exist in the supplied set and has
**not** been invented. It is listed in `ASSETS_NEEDED.md`.
