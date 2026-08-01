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

---

## D-010 — Carbohydrate mouth rinse as the Middle-distance mechanic

**Decision.** The race belt carries a rinse option alongside gels. Rinsing costs
~1–2 s (versus 3–5 s to take and swallow a gel), never touches Glycogen, and
acts on **Focus** — modelled as a short, modest lift with a taper, not a spike.

**Why this is the right mechanic, not a gimmick.** Our three race formats land
almost exactly on the boundaries in the literature, which is a gift:

| Format | Duration | What the evidence says |
|---|---|---|
| Sprint | ~13–15 min | Below every threshold. Intake does nothing. |
| Middle | ~30–35 min | The mouth-rinse band. Ingestion is not yet metabolically useful. |
| Long | ~90 min | 30–60 g/h. Real fuelling, real gels. |

So each format gets a *genuinely different* nutrition problem for reasons that
are true, not balanced-for-fun. That is exactly the design test in the brief:
delete the branding and the mechanic still stands up.

**Why it acts on Focus specifically.** The mechanism is not metabolic. Carter
et al. (2004) infused glucose intravenously — blood glucose doubled, and
performance did not move; rinsing and spitting, with zero ingestion, did. fMRI
work (Chambers et al. 2009) puts the effect in reward and motor-control regions
— insula/frontal operculum, dorsolateral prefrontal cortex, striatum, anterior
cingulate. Mapping that to Glycogen would be simply wrong. Mapping it to Focus,
our navigation stat, is both mechanistically honest and the more interesting
game decision: do you spend two seconds of map contact to read the next control
better?

**Sizing it honestly.** Real effect is ~2–3% in one-hour time trials, with
meta-analytic SMDs of 0.15–0.25 — small, and null for intermittent/sprint
formats. The in-game effect is tuned to feel like a marginal gain a good athlete
would take, not a power-up. Overstating it would fail Judge O and Judge B at
once.

**Compliance note.** This mechanic must not be described to the player in
performance-claim language. See `docs/CLAIMS_TO_REVIEW.md` — the in-game copy
describes what the athlete *does*, not what the product *achieves*.

---

## D-011 — Pre-race failure is under-fuelling, not "rebound hypoglycaemia"

**Decision.** The BEFORE screen can send you to the start line with a genuine
deficit, but that deficit comes from **too little carbohydrate or too long a
fast** — never from a modelled sugar crash caused by eating too close to the
start.

**Why this overrides the brief's phrasing.** The brief says "wrong choice or
wrong timing = you start the race with a deficit," which naturally suggests
modelling reactive hypoglycaemia. The evidence does not support that:

- The entire "don't eat in the hour before" folk rule traces to one 1979 study
  (n=8) using fixed-intensity time-to-exhaustion — not a time trial — where the
  effect also vanished at higher intensity.
- The transient glucose dip is real and common (≈25–60% of athletes depending
  on timing), but it resolves within ~10 minutes of starting and is **not
  related to performance**. Moseley et al. (2003) states this directly.
- Jeukendrup & Killer (2010) conclude that advice to avoid carbohydrate in the
  hour before exercise is *unfounded*.

Modelling a punishing sugar crash would teach players something false. Judge O
would not catch it, but it would be wrong, and the brief's own compliance rule
("no dosages invented by you", neutral factual wording) points the same way.

**What we model instead, which is well supported:**
- 1–4 g/kg carbohydrate, 1–4 h before — the actual ACSM/AND/DC 2016 guidance.
  Note its stated scope is events **>60 min**, so it binds on Long, weakly on
  Middle, and essentially not at all on Sprint.
- A top-up in the final ~15 minutes is *favourable*, not risky: it produces the
  fewest dips of any timing, and a running study (Tokmakidis 2008, 1 g/kg at
  15 min) found a 12.8% longer time to exhaustion. So the BEFORE screen rewards
  a late top-up rather than punishing it — the opposite of the folk rule, and
  the more interesting decision.
- Glycaemic index is **not** modelled. A 19-study meta-analysis found no
  reliable performance benefit either way; adding a GI lever would be inventing
  a mechanic the evidence does not support.

---

## D-012 — Hydration and sodium calibrated to bite only where they really do

**Decision.** Hydration stays as one of the four stats, as the brief requires,
but it is tuned so it can only meaningfully bind on **Long distance in warm
conditions**. Salt is available and is a no-op outside that same envelope.

**Why.** The brief has hydration "deplete with heat/humidity; low = cramp risk,
forced pace drop." For our actual race durations that is largely unsupported,
and an orienteer would know it:

- A runner starting euhydrated loses roughly 0.7–3.5% body mass over 30–100
  min. Only the top of that range reaches the contested 2% threshold at all.
- Whether 2% even impairs performance in real-world short events is genuinely
  disputed — blinded studies contradict each other, and the individual spread
  across them runs from −1.5% to −19.2%.
- Competitive runners in half marathons voluntarily drink ~150 ml/h and finish
  ~2.4% down without incident.
- Goulet & Hoffman note the reverse risk: in ~1 h events, drinking *enough* to
  stay euhydrated can itself hurt.

On sodium, the guidance is unambiguous and points the same way: ACSM sets the
trigger at >2 h duration or >1.2 L/h sweat rate; NATA states that below one
hour nothing but water is required, and that no evidence shows athletes are
helped by sodium beyond their individual losses. The only performance-outcome
data — from ultramarathons, where the case would be strongest — is null.

**So:** Sprint and Middle are not hydration-limited, because in reality they are
not. Long in heat is. Salt capsules are present in the loadout and are honestly
marginal, which is itself the lesson. Making them a reliable power-up would be
both a gameplay lie and a compliance problem.

**Consequence for the loadout UI.** Items that are correctly a no-op for the
chosen race must not read as bad choices — they read as *unnecessary* ones, with
the reason stated. That distinction is the difference between the mechanic
teaching the real protocol and it teaching superstition.

---

## D-013 — SUPERSEDES D-010: no product may move Focus

**Decision.** `Focus` is driven by fatigue and terrain only. No Enervit product
raises it, directly or indirectly. The mouth-rinse-improves-Focus mechanic
described in **D-010 is withdrawn**.

**Why the earlier call was wrong.** D-010 was made on solid physiology — the
rinse effect is real, it is CNS rather than metabolic, and our Middle distance
sits squarely in the 30–75 min band where it applies. What it did not account
for is that a stat bar responding to a named product **is a health claim** under
Art. 2(2)(1) of Reg. 1924/2006, regardless of how well evidenced the underlying
science is. Evidence and authorisation are different tests, and only one of them
is the law.

The specifics are unambiguous:
- **No SKU in the range carries an authorised EU cognition claim.**
- **Caffeine has no authorised claim at all** — the Commission's draft was
  vetoed by Parliament in 2016 and never re-tabled. So a caffeinated gel raising
  a focus bar is a symbolic health claim with no authorisation route.

**Also removed: the indirect path.** `bloodSugar` no longer feeds
`navigationQuality`. Blood sugar is movable by product, so routing it into
navigation would rebuild the prohibited pathway one step removed — and an
inference the consumer draws is still a claim under Art. 3(a), even when every
individual step is true.

**What we lose is less than it looks.** Carter et al. (2004) infused glucose
intravenously through a one-hour time trial and measured no performance
benefit, so carbohydrate availability is not limiting at Sprint or Middle
duration in the first place. The mechanic we are giving up was the one the
physiology least supported for those formats.

**What replaces it** is already stronger, and it is a real measured effect
rather than a borrowed one: the **control-approach mechanic** (see
`src/sim/athlete.ts`). National-standard orienteers show a heart-rate rise at
controls of 5 ± 1 bpm; club-standard show 17 ± 4 bpm, and the authors attribute
the gap directly to failing to plan the next leg before arriving (Bird et al.,
BJSM 2003). Planning ahead is the measurable difference between a good
orienteer and an average one — it is free of any product, so it is free of any
claim, and it is a better mechanic besides.

**The general principle**, worth stating once: where compliance and honesty
appeared to conflict here, they turned out not to. Every prohibited mechanic we
found was also the mechanic the evidence supported least. That is not luck —
the claims regime exists to stop exactly the inferences that thin evidence
invites.

---

## D-014 — Over-fuelling makes you slower

**Decision.** Carrying and consuming more than the race needs costs time:
mass on the belt, and gut distress past what the gut can absorb for the elapsed
duration. `overfuellingPenalty()` in `src/sim/athlete.ts`.

**Why.** Art. 3(c) prohibits a mechanic that rewards consumption without limit,
so *something* had to cap it. But a cap alone would have been a compliance
patch. Making over-fuelling actively worse is the more useful design, because it
is true: 60 g/h in a 32-minute race is not caution, it is dead weight and a
sour stomach. Enervit's own running guidance says carbohydrate is typically
unnecessary under 60 minutes, and conditions the 60 g/h figure on efforts over
two hours.

This is what makes the BEFORE screen a real decision rather than a shopping
list. A player who loads the belt "to be safe" should finish behind one who
read the course profile — and when they do, they have learned the actual
protocol.

Distress is capped so that being wrong costs time rather than ending the race.

---

## D-015 — Build the forest on permitted training terrain, not the embargoed courses

**Status: CONFIRMED BY CLIENT.** Raised with Juraj with the reasoning below and
the alternative (ship the real Martínkov courses now, with organiser sign-off).
Decision: Lachovice. `MARTINKOV_AOI` stays implemented for a post-event switch.

**Decision.** The forest venue is generated from **Lachovice**, one of four
areas the organisers themselves designated as permitted training terrain.
`MARTINKOV_AOI` — the real competition area — is implemented and ready, and is
a one-line switch plus a pipeline re-run once the embargo lapses after
9 August 2026.

**The distinction that matters.** The embargo is a 213-vertex KML covering
~51.4 km² around the abandoned village of Martínkov. It restricts **physical
access by competitors**. It places no restriction whatsoever on ČÚZK open data,
which is CC BY 4.0 including the *sui generis* database right. So there is no
licensing problem here, and this decision is not a legal one.

It is a judgement about what the embargo is *for*. An embargo keeps competitors
out of the terrain so that nobody arrives with an unfair familiarity with the
re-entrants, the boulder fields and the marsh edges. A navigable, photoreal
model of that same ground, built from 2 m LiDAR and published before the races,
delivers exactly the familiarity the embargo denies — more conveniently than
walking it would. Legal and appropriate are different tests, and the client is a
Main Partner with their name in Bulletin 4 alongside two government ministers.

**Why this costs us nothing.** Lachovice is not a fallback:

- Same landscape — granite, spruce, Vltava-valley relief — about 3 km from the
  competition area, from the same DMR 5G source at the same 2 m resolution.
- It is where athletes are *permitted to train*, so building there is aligned
  with the embargo's intent rather than merely tolerated by its letter.
- No player outside the sport can tell. Everyone inside it will understand
  immediately why we did it, which is worth more than the alternative.

**Timing note.** The races are 5–9 August 2026. If the game ships after the
final race, switching to the true competition terrain becomes both safe and a
genuinely good post-event story — *"now run the actual World Cup courses."*
That is a better launch beat than shipping the courses early would have been.

---

## D-016 — Corrections to the brief's premises from the geodata research

Recorded so they are not quietly absorbed:

**1. The World Cup has no sprint.** It is four forest races at Martínkov
(Qualification, Long, Middle, Relay). Český Krumlov hosts the separate **GAPP
Czech O-Tour Prologue**. We still build Krumlov — it is the better showcase and
a genuinely different discipline — but we describe it accurately rather than
calling it a World Cup sprint.

**2. NDVI does not work for runnability.** Tested against a real CIR near-infrared
band, not assumed: NDVI is *anti*-correlated with canopy height here (mature
spruce 0.20, open meadow 0.33). Vegetation classification is driven by the
**canopy height model (DMP 1G − DMR 5G) plus canopy roughness** instead. The
two ČÚZK exports share an identical grid for identical parameters, so they
subtract with no resampling.

**3. Do not transform S-JTSK ourselves.** An independent Krovák implementation
was measured against ČÚZK's own output: easting agrees to ~1 m, but the standard
three-parameter datum shift carries a systematic **−9.3 m northing bias** — four
to five pixels at 2 m resolution. We pass `bboxSR=4326` and let ČÚZK reproject.

**4. Google elevation data is prohibited, not merely awkward.** Their terms name
our use case verbatim — building terrain models from Elevation API values. Nor is
a dev-time cross-check safe, since no caching is permitted. We use none of it.

**5. Source split by venue, which the licence analysis also wants.** OSM coverage
is wildly asymmetric — 5973 elements in the sprint AOI against 133 in the forest.
So ZABAGED is primary for the forest and OSM for the sprint. Convenient, because
merging our own or ZABAGED data into an OSM feature type would trigger ODbL
share-alike; keeping them separate by venue avoids the question entirely.

---

## D-017 — S-JTSK grid north is not true north, and it matters

**Finding.** At this site, S-JTSK (EPSG:5514, Krovák) grid north is rotated
**7.95°** from true north. ČÚZK's ImageServer only emits axis-aligned rasters in
the requested `imageSR`, so every raster arrives rotated against the world frame
`src/core/geo.ts` defines.

**Why it had to be fixed rather than tolerated.** Over our 1.2 km half-extent
that rotation displaces a corner by **166 m**. The 3D world and the 2D map would
have been consistently wrong about where everything is, relative to a compass
bearing — and the symptom would have been "the map feels slightly off", which is
close to undiagnosable in a game whose entire subject is navigation.

**How.** The world→5514 transform is fitted from three small `exportImage`
probes — using ČÚZK's own reprojection, never a client-side Krovák
implementation (D-016.3) — and the rasters are resampled into the world frame.
DMR and DMP share identical blending weights so the canopy height model stays an
exact per-cell difference rather than a difference of two independently
resampled surfaces. Verified by registering the output hillshade against the
orthophoto pixel-for-pixel.

---

## D-018 — Pick the venue origin from the data, not the map

**Correction.** `LACHOVICE_AOI.origin` was originally (14.2536, 48.6229). That
point sits on a **street in Loučovice**, in the Vltava valley — not in the
training terrain at all. The 3D scene had been quietly compensating by hunting
for its own spawn point.

**Fix.** The new origin (14.25564, 48.62695) was chosen by scoring every
400 m-radius window of the *built runnability raster* for forest classes against
roads and out-of-bounds, and taking the best. It scores **98.7% forest, 0% road
or out-of-bounds**, against roughly half that for the original point.

**The general lesson**, which is why this is written down: the first origin was
picked by reading a place name off a map. Once the terrain pipeline exists, the
pipeline's own output is a better source of truth about the terrain than any
map is — and it is cheap to ask it.

---

## D-019 — A skipped check is not a passed check

**Incident.** A shader-compile regression shipped to production. The shared
canopy-light GLSL was injected repeatedly into the same shader, so
`varying vec3 vGroundWorld;` was declared up to seventeen times and the vertex
shader failed to compile. **Boulders and deadwood did not render at all.**

Throughout, `tsc` was clean, `npm run build` succeeded, and all three CI gates
were green. The perf gate reported `skip (window.__perf not exposed)` — and a
skip was being counted as a pass.

**Two things made it invisible:**

1. **A failed shader makes an object vanish, not misdraw.** There is no error
   state to see. An emptier forest reads as an art regression, or as nothing at
   all, so the usual "does it look wrong?" check does not fire.
2. **The gate could not tell "not built yet" from "built and broken".** Both
   present as an absent `window.__perf`, so the honest early-development state
   and a hard failure were indistinguishable.

**Fixes.**

- `tools/perf/budget.mjs` now separates the two: if a `<canvas>` exists, a
  renderer was constructed, and a constructed renderer that never publishes a
  frame monitor is a **failure**, not a skip. Only "no canvas *and* no monitor"
  is a legitimate skip.
- `src/main.ts` captures shader and WebGL `console.error` output into
  `window.__renderErrors`, so the gate reports *what* broke rather than only
  that something did.
- The GLSL injection is guarded on the **shader source itself**, not on a flag.
  A `userData` marker stops one material being patched twice, but glTF
  materials are cloned per variant and per LOD, and a clone copies
  `onBeforeCompile` with its handler chain attached — so the chain can still
  run twice over one source. Checking the source cannot be defeated by how the
  material got there.

**The general rule**, which is why this is written down rather than just fixed:
**any check that can silently not-run must report the difference between
"nothing to check" and "could not check".** Otherwise the absence of a signal
reads as a good signal, which is worse than having no gate at all — a missing
gate is at least known to be missing.

**Also worth remembering:** two alarming readings during this investigation were
measurement artefacts, not faults. `drawCalls: 0` was a background-tab
`requestAnimationFrame` throttle, and `window.__perf` appearing undefined was
the browser tool evaluating in an isolated world. Both would have sent a fix in
the wrong direction. Confirm the instrument before trusting the reading.

---

## D-020 — The claims boundary is now a build flag, defaulting to off

**Decision.** In-race products move stats, caffeine included, and the HUD shows
it. The constrained behaviour described by D-013 and `CLAIMS_TO_REVIEW.md` is
retained in full and is reached by building with `VITE_CLAIMS_SAFE=1`.

**Who decided.** The client — Vitar Sport, the Enervit CZ/SK distributor —
lifted the restriction explicitly, on the basis that this build is for a private
audience. It is his product and his exposure. This entry records the decision;
it does not re-argue it.

**What each build is.**

| | default build | `VITE_CLAIMS_SAFE=1` |
|---|---|---|
| Carbohydrate → `glycogen`, `bloodSugar` | applied, named in the UI | applied, not attributed |
| Isotonic drink → `hydration` | applied, named in the UI | applied, not attributed |
| Caffeine → `focus` | applied | **not applied** |
| Take confirmation | composition, time cost, stats that moved | composition and time cost |
| Focus row in the HUD | shown | absent |

Caffeine is suppressed rather than hidden in the constrained build. D-013's
whole content is that no product touches `focus`; a mechanic that still decided
the race while invisible would leave that build a different game wearing the
same UI.

**Where it lives.** `src/core/compliance.ts` reads the flag. `src/nutrition/
intake.ts` is the only place in the codebase that moves a stat in response to a
product, and the only place that consults the flag for physiology.
`src/race/hud.ts` consults it for what to draw. The dose–response model itself
(`caffeineFocus()` in `src/sim/athlete.ts`) is unconditional, so both builds
share one physiology.

**Two properties that are not flag-governed**, because they are game design
before they are compliance:

1. **Nothing is framed as a penalty for not consuming.** Depletion is caused by
   pace, terrain, climb and heat, which are the only inputs `depleteStats()`
   takes. The belt dock hides itself when empty and never prompts.
2. **More is not monotonically better.** Intake is applied toward a ceiling so a
   second identical item is nearly worthless; carbohydrate is counted against
   `overfuellingPenalty()`; and `caffeineFocus()` turns over past ~3.5 mg/kg, so
   a third caffeinated gel leaves the athlete navigating worse than the second
   one did. A loadout with no wrong answer is not a decision.

**Standing risk to flag, not to solve here.** The repository is public and the
Vercel deployment is live. "Private audience" is a property of who is told the
URL, not of the artefact. If this build is to sit alongside the World Cup, the
flag is the switch — but someone has to throw it, and that is a release
decision rather than a code one.
