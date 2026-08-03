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

---

## D-021 — Frame-time spikes on mobile: fixed the cause, not the gate

**Symptom.** `forest.mobile` held a healthy median (~8 ms against a 33.3 ms
budget) but spiked intermittently to a p95 of 33, 72, even 109 ms. A 100 ms
frame is a visible stutter, and the median was never going to reveal it — this
is exactly what the p95 budget exists to catch.

**Cause found.** The capability probe puts a mid-range phone on the `medium`
tier. That is the right *visual* answer and the wrong *generation-cost* answer:
it gave a 4×-throttled CPU nearly desktop-sized vegetation work, and chunk
generation cost scales with the square of the view radii.

**Fix.** Touch devices now take the tight radii regardless of tier —
`near 120→70 m`, `far 230→150 m`, `ground 22→15 m`, density `0.75→0.45`,
capacity `6000→2000`. Measured on the same build: median **8.5 → 2–6 ms**, and
the 109 ms spike gone, worst p95 **31.3 ms**.

Note this is deliberately *not* a tier change. Tier stays `medium` so the phone
keeps medium textures and shadows; only the amount of geometry generated per
frame drops. Visual quality and generation cost are different axes and had been
conflated.

**CORRECTION — the hypothesis in this section was wrong.** It claimed later
scenes inherit state from earlier ones. They do not: `budget.mjs` opens a new
tab per scene and closes it, which was verified by counting CDP page targets.
Measured directly, `sprint` run four times back-to-back with no other scene
degrades on its own (p95 10.4 → 25.4 ms), and `forest` with no menu at all
still spikes to 108 ms. **Position in the run matters; the predecessor does
not.** See D-022 for what it actually is. The paragraph below is left in place
rather than deleted, because a wrong diagnosis that reads plausibly is worth
keeping visible.

**What was still open, on the wrong hypothesis.** Running the full
gate — menu, then forest, then sprint, in one browser — still produces spikes
(133 ms) that the same scenes do not show when measured alone (31 ms). Later
scenes inherit something from earlier ones; the likely candidate is incomplete
teardown between scenes causing GC pauses.

That is worth chasing rather than masking, for two reasons: it is a real player
flow (race → menu → race), and a p95 gate that gets relaxed whenever it fires
stops being a gate. **The hard budgets stay as they are and the gate stays red
on this one metric until the leak is found.** A red gate telling the truth is
more useful than a green one that has been tuned into agreement.

---

## D-022 — The teardown leak was real; it was not what the gate was measuring

D-021 left one thing open: the full perf run spiked where a single scene did
not, and named incomplete teardown as the likely cause. Both halves of that turn
out to be answerable, and they have different answers.

### The leak is real, and it is fixed

Driven through the actual player flow — menu → forest race → quit → sprint race
→ quit, twice round — and reading the scene's own `renderer.info` **through**
the teardown (stash the live `info` object before quitting, read the same object
after):

| after teardown | before | after |
|---|---|---|
| `memory.geometries` | **101** | **0** |
| `memory.textures` | **15** | **6** |
| `programs` | 13–16 | 1–5 |
| `window.__world` | still the disposed scene | released |

The residual six textures are the shared bark and granite packs, which are a
process-wide cache and must survive — see `SHARED_TEXTURES` in `materials.ts`.
JS heap at the menu was already flat before this work (≈6–9 MB), so the leak was
GPU-side, which is exactly the class three.js will not collect for you.

What was actually leaking, in rough order of size:

1. **`loadAsset` output.** Uncached, so every scene load re-parsed four .glb
   files, and nothing ever disposed the result. `Vegetation.dispose()` disposed
   the `InstancedMesh`es, which frees instance matrices and nothing else.
2. **The detail texture pack.** `loadDetailTextures` overwrote a module-level
   `detail` on every call, stranding the previous pack. It is a real cache now.
3. **`window.__world` and `window.__perf`.** Strong references from `window` to
   the disposed scene, which kept the whole graph reachable.
4. **The sun's shadow map**, a 1536² depth target the light allocates lazily and
   nobody could see to release.
5. **Terrain material, undergrowth material, character and viewmodel materials
   and their maps** — all geometry-only teardown before.
6. **`window`/`document` input listeners** in both scenes' `attachInput`, which
   also meant a second race listened twice.

The renderer now also calls `forceContextLoss()` after `dispose()`, so the
driver gets its memory back at teardown rather than whenever the orphaned canvas
happens to be collected.

### The gate failure is *not* teardown, and D-021's hypothesis was wrong

`tools/perf/budget.mjs` opens a **new tab per scene and closes it** — verified
by listing CDP page targets around each step, which return to one. Nothing can
be inherited from an earlier scene because no earlier scene is still loaded.

Measured directly, with the same scene repeated in one browser:

- `sprint` ×4 back to back: p95 10.4 → 15.3 → 24.0 → 25.4 ms. Monotonic, with
  no other scene involved.
- `forest, forest.mobile` with **no menu at all**: p95 108 and 74 ms — i.e. the
  same failure D-021 attributed to running after the menu.

So position in the run matters and the *predecessor* does not. A fixed
CPU-work canary run between steps slowed from ~670 ms to ~1360 ms across a
single run, and `photoanalysisd`/`mediaanalysisd` plus the benchmark itself put
this machine at a load average above 100 for much of the investigation.

### What the spike is made of

Profiled under the gate's own conditions (`forest`, mobile viewport, 4× CPU
throttle), sampling at 200 µs:

```
3537 ms  42.1%  bufferSubData
 637 ms   7.6%  (program)
 448 ms   5.3%  (idle)
```

**`bufferSubData` is 42 % of all CPU time.** `Vegetation.rebucket` runs four
times a second and flushes every bucket with a bare `needsUpdate = true`, which
three reads as "re-send the whole attribute": the tree buckets are 2000
instances each and the undergrowth mesh is 34 000 (2.2 MB), against ring
occupancies typically in the tens. It is a synchronous upload the driver blocks
on, and the shape it produces — a healthy median with three or four ~200 ms
stalls a second, no JavaScript in them, no heap drop, so neither work nor GC —
is exactly the p95 this gate keeps failing on.

### The obvious fix was measured and rejected

Uploading only `[0, count)` via `addUpdateRange` removes `bufferSubData` from
the profile completely and triples the profiler's sample rate, so it does what
it says. It is still not shipped, because a partial update forbids buffer
orphaning: the driver can no longer discard the old contents and must
synchronise against in-flight draws. Paired, interleaved A/B in one browser:

| | median | p95 |
|---|---|---|
| sprint.desktop, full-buffer | 6.0 ms | 18.0 ms |
| sprint.desktop, update-range | 7.8 ms | 22.4 ms |

Worse in **five pairs out of five**. On forest.mobile under vsync it was the
better of the two (p95 66 ms and tightly clustered, against 33–99 ms), and
unthrottled the two runs contradicted each other outright. A change that is
better on one scene, worse on another and unresolvable on a third is not a fix,
and shipping it on the strength of the profile alone would be trading a measured
regression for an unmeasured improvement.

**The cost is in the buffer size, not in the upload call.** The fix that gets
both properties is to stop allocating 2000- and 34 000-instance buffers for
rings that hold tens — grow them to fit instead — which keeps the orphan-friendly
full-buffer upload and makes it small. That is the open item, and it wants a
machine that is not swinging by 3× between repeats of the same measurement.

`HARD_BUDGET` and `baseline.json` are untouched. The gate stays red.

### Where the gate actually stands

On a quiet machine (1-minute load average under 5) the **full run passes**, and
does so repeatably:

```
forest.desktop  median 0.40 ms · p95 12.00 ms
forest.mobile   median 1.50 ms · p95  4.00 ms      (budget 33.3 / 50)
sprint.desktop  median 0.90 ms · p95  5.70 ms      (budget 16.7 / 25)
sprint.mobile   median 6.60 ms · p95 16.90 ms
✓ perf budget OK
```

Run the identical build again immediately afterwards, with the box still warm
from the first run, and `forest.mobile` goes to a p95 of 77.5 ms. Same build,
same command, minutes apart.

So the honest reading is: **this gate is sound and the build meets it, but the
measurement needs a quiet machine and does not currently say so.** Anyone
running `npm run perf` on a laptop that is also indexing photos will get a red
gate and no indication why. That is the same failure mode as D-019 — a check
that cannot tell "could not measure" from "measured and bad" — and it is worth
fixing at the harness, by having `budget.mjs` sample its own CPU canary and
refuse to gate (rather than fail) when the host is too loaded to measure. Not
done here, because doing it as part of a leak fix would bury it.

---

## D-023 — The perf gate now checks whether it could measure at all

**Decision.** `tools/perf/budget.mjs` times a fixed CPU workload before and
after every scene. If it slows by more than 1.6×, the scene's numbers are
reported as **unmeasurable** and excluded, rather than being compared to a
budget.

**Why.** During the D-022 investigation a single gate run drove this machine's
load average from 6 to 117 — the benchmark loads the box it is measuring — and
the same build measured a p95 of 4.5 ms and 77.5 ms minutes apart. A gate in
that state is not reporting on the renderer.

This is D-019 again, in a different costume. There the fault was that a *skip*
was indistinguishable from a *pass*; here it is that *could not measure* was
indistinguishable from *measured, and bad*. Both make the absence of a signal
look like a signal. The rule stands: **a check must always be able to say which
of the three it is — good, bad, or unknown.**

**Cost, stated honestly.** On a permanently busy machine every scene could
report unmeasurable and nothing would be gated. That is a real failure mode, but
it is a *loud* one — it prints per scene and says why — where the previous
behaviour was a confident red or green built on noise. If it starts happening
routinely, the fix is a quieter CI runner, not a looser tolerance.

---

## D-024 — One runnability raster, built offline, with the bridges in it

**The bug.** *"When I try to cross the map or run in the city, I'm stuck on some
little square and can't get out of it."*

**What it actually was.** `SprintScene.stampPaved` burnt the OSM network into
the runnability raster at scene load, over a guard list that refused to paint
`Impassable`. The guard was written for a good reason — a footpath crossing the
Vltava polygon must not turn the river into a road — and it also severed **every
bridge in the venue**. The Vltava is an unbroken impassable ribbon round the old
town, so the arena's connected component was the meander and nothing else.

Flood-filled from Náměstí Svornosti on a 0.5 m grid, using the runtime's own
collision and testing the *edges* between cells rather than only their centres:

| | before | after |
|---|---|---|
| open ground reachable from the arena | **29.8 %** | **95.1 %** |
| largest pocket the player can see and not reach | **54 ha** | 0.9 ha |
| uncrossable barrier length present in the raster the map draws | **9.4 %** | **100 %** |
| `reachableFraction` reported in-race | 0.36 | 0.97 |

The "little square" was the old town. The map drew bridges; the bridges did not
work.

**The second half was a D-002 violation.** D-002 is that the map, the physics
and the course generator read one `Runnability` raster, so the map cannot
promise something the world does not deliver. Three things were reconstructing
passability separately: the scene stamped the network and the footprints at
load, `FieldTerrain.bakedRaster` re-derived the colliders per cell for the map,
and the 619 walls, city walls and railings that stop the athlete under ISSprOM
515/518 were *nowhere in the raster at all* — they existed only as collision
volumes, so 90.6 % of uncrossable barrier length blocked the player without
being drawn. Those symbols exist precisely to prevent that.

**Decision.** `tools/terrain/townscape.mjs` stamps the raster once, offline:
network → bridge decks → enclosed-square fill → footprints → barriers, in that
order, and writes `runnability.bin` and `runnability-low.bin`. `townscape.json`
records `rasterStamped`. `SprintScene` no longer derives any of it; it checks
the flag and warns if the data predates the change.

Two details that carry the weight:

- **Only a way OSM tags `bridge` may cross impassable ground**, and at half its
  carriageway width floored at 1.4 m. The guard is kept; it is given the one
  exception it always needed. Tunnels are deliberately *not* carved: a
  `tunnel=building_passage` under a burgher house would open the raster where
  the footprint collider still blocks, which is the same disagreement in the
  other direction.
- **Barriers are stamped with no dilation** — cell centre inside the collider's
  own band, plus a supercover trace of the centreline so a 10 cm railing cannot
  slip between two cell centres and leave the drawn wall full of holes. No
  dilation because that lesson is already written down: growing footprints by a
  single cell once took this venue from 30 % connected to 1 %, since Krumlov's
  alleys are 2–3 m wide. Measured cost of the barrier stamp: 0.6 % of open
  ground, and no change to reachability.

**A freeze that was one wall's width away.** `Race.step` reads its speed target
from the runnability *under the athlete*, and that target is zero on impassable
ground — so an athlete standing inside a barrier has a speed target of zero for
the rest of the race and cannot move in any direction. `nearestReachable` was
answering from a 1 m mask, which can put a continuous point most of a metre from
the cell it approved. It now requires the exact point to be clear as well.

**Gates.** New: `tools/ci/check-passable.mjs` (`npm run check:passable`) walks
the whole venue with the runtime's collision and fails on a collapse in
reachability, on an implausibly large sealed pocket, or on barrier length
missing from the raster. `check-race.mjs` now runs **four** sprint seeds and
asserts that no start, control or finish sits inside a barrier.

**What is deliberately *not* zero.** 0.9 ha of the venue is still unreachable,
and correctly: the Baroque zámecká zahrada is a walled parterre, and a handful
of block interiors are reached only through arched passages OSM maps as
building passages. The athlete cannot get in, so they cannot be stuck there, and
the course generator will not site a control there.

---

## D-025 — The autopilot was passing on one lucky seed

Found while fixing D-024, and worth separating from it.

`check-race.mjs` required the blind autopilot to punch every control, and tested
**one** sprint seed. Run on the *pre-fix* data, the other seeds do not pass:
seed 7 finished 11/11, while seeds 3, 19 and 42 managed 2/9, 3/11 and 3/8. The
gate had been green on a single draw from a random course generator.

The gate's own comment already made the argument: the autopilot cannot read a
map, which is the entire game, and "requiring it to finish would gate the build
on the quality of a test robot". That is now true of what is enforced as well as
of what is written. On every seed the gate asserts the deterministic properties
a player depends on — every leg routable over the ground the runtime actually
lets them cross, nothing sited inside a barrier, no shader that failed to
compile — and prints how far the autopilot got without gating on it. It stays
enforced in the forest, where the autopilot does finish.

This is not the gate being relaxed to make a change pass. It is the gate being
widened from one seed to four, which is what exposed that the enforced criterion
was never being met in the first place.

---

## D-026 — Krumlov at eye level: the gable was never being built

The client: *"the city looks pretty good from above, but from first person it's
not much."* Correct, and the cause was not what the previous handover recorded.

**The gable ends were missing geometry, not wrong data.** `Buildings.buildWalls`
emits one quad per footprint edge and samples the roof height at the two
*corners* only. On a gabled roof the ridge crosses the gable-end edge at its
**midpoint**, not at a vertex — so the wall top ran flat from corner to corner
at eave height and the triangle under the ridge was never built. Every gabled
building in the town had an open triangular hole under its roof. With a
front-facing roof material the far slope behind that hole was culled, so what
stood on Náměstí Svornosti was a flat-topped slab with a black wedge on it,
which is exactly the report. From above the roofs cover the hole and the town
looks finished, which is why it survived. `RoofPlan.creases` now returns where
the roof profile bends across each edge and the edge is split there, so the
gable is built from the same height function that builds the roof.

**Roofs were being lit as asphalt.** The tile albedo map has a mean linear
luminance of **0.146** and it was being multiplied by a per-building terracotta
vertex colour of about the same darkness. The product is an albedo near 0.02 —
roughly asphalt — so every slope the 08:00 sun does not reach rendered black.
The map now modulates luminance and the vertex colour says what colour the tile
is, which is the argument the wall material already made and this one had not.
The plaster had the same class of error in the other direction: it divided by
0.42, an sRGB-ish guess for a texture whose true linear mean is **0.617**, so
the average façade was pinned at the clamp ceiling and the only thing the map
could still do was punch dark holes — the "grey damp on concrete" look.

**Gables to the street.** Measured on the finished data, **164 of the 347**
gabled footprints in the historic core carried a ridge running *along* the
street, because the minimum-area rectangle knows nothing about streets. A
Krumlov plot is narrow to the street and deep behind it, ridge running back,
gable to the street. The extractor now turns those ridges (155 of them) and,
where one OSM polygon covers several plots, builds a **comb** of that many
gables — 8.5 m per bay, which is the median frontage of the footprints that
already stood gable-on. The town measures its own plot width. The measured
ridge is kept, because it is the p94 of the LiDAR and it is the skyline; the
eave, which was always derived, moves to keep the pitch inside 39–52°.

Two things learnt from screenshots rather than from reasoning:

- **Combing is for burgher houses only.** Applied to churches, castle wings and
  towers it produced a row of 60° spikes across the castle terrace that read as
  shark teeth from Latrán. A monumental building is one designed mass with one
  long roof.
- **A roof faces up, and saying so is not defensive.** `triangulateShape`
  returns faces in the winding of the ring it is handed, and clipping a concave
  footprint can hand it a reversed one — so some roof planes were built inside
  out and, with a front-facing material, simply culled. The winding is now
  forced from the normal.

**The rest of the eye-level list.** A ground-floor register — arched shopfronts
and doors, one per bay — because a façade whose bottom three metres are blank
plaster reads as a boundary wall, and in a sprint the bottom three metres are
the whole frame. Gabled dormers on the roof slopes, placed off the roof's own
height function so they cannot float. A cornice at the eave and a mostly blind
gable field above it, both keyed off a new per-vertex `wallEave` attribute, so a
7 m burgher house gets one upper floor and a 14 m one gets three instead of both
getting the same infinite grid. Boulders and forest deadwood suppressed in the
town except on `Rock`, where the castle crag genuinely is bare. The castle
tower's polychrome painted with contrast rather than suggested with it, because
at 190 m the only thing that survives is contrast.

**And one that had nothing to do with roofs.** `loadSurface` sets a texture
repeat of `1/physicalSize` because everything using it authors UVs in world
metres; the landmarks are lathes and cylinders with unit UVs, so the Marian
column's plinth was showing a *third* of a 3 m granite tile stretched over 3 m
of stone. At the foot of the arena, in the middle of the frame every sprint
starts on, it was a boulder with a column on it.

**Cost.** Building triangles 31.8 k → 70.1 k over 1738 buildings. Measured on a
quiet-enough machine: `sprint.desktop` median 4.40 ms, p95 13.30 ms against a
16.7 / 25 ms budget.

**What still does not look like Krumlov**, honestly: the windows are a regular
grid with a per-building phase and nothing else — no shutters, no varied bay
rhythm, no oriel; the plaster palette is measured but narrow, so a street reads
creamier than the real one; the roofscape has no chimneys, and Krumlov's has
hundreds; and the tower's painted shaft is only visible from a few places in the
town, so its polychrome is doing less work than the effort suggests.

---

## D-027 — A quality tier is a rendering budget, never a rules budget

The client, on a phone: *"in the city we're again in some small circle,
levitating a bit, and can't continue."* Every gate was green.

`TerrainField.load` gave the `low` tier a **4 m** runnability raster
(`runnability-low.bin`) alongside its 4 m heightmap, on the argument written
into the comment there: *"physics and visuals must agree about where a path is;
sampling a 1 m class raster against a 4 m mesh would put the runner on tarmac
that is not drawn anywhere."*

That argument is wrong twice.

**Cosmetically**, it does not describe what happens. The ground splat is a
per-vertex attribute, so a 4 m terrain mesh samples the class raster every 4 m
whatever its resolution. A finer raster changes nothing about what is drawn.

**Substantively**, the class raster is not a texture. D-002/D-024 make it the
single source of passability for the map, the course generator *and* the
collider. Downsampling it does not blur a picture; it changes the rules of the
race. Český Krumlov's alleys are 2–3 m wide, so at 4 m the town seals:

| Measured on Krumlov | 1 m raster | 4 m raster |
|---|---|---|
| Town centre cells `Impassable` | — | **49 %** |
| Reachable from Náměstí Svornosti | **97.2 %** | **0.15 %** |
| Controls the generator could site (menu seeds) | 10–18 | **1** |
| Course length | 2.7–4.3 km | 0.4–0.6 km |
| Ground the athlete could walk on from the start | > 2 ha | **3 040 m², 95 m across** |

That last row is the client's sentence, in square metres. A 3 000 m² pocket
around one square, with a 500 m one-control "sprint" set inside it.

`pickTier` returns `low` for any Mali-G5x/G3x, Adreno 6xx or PowerVR device and
for any touch device reporting ≤ 4 GB — which is a large share of the phones the
brief is actually written for, and none of the machines this is developed on.

**The fix**: only the heightmap follows the tier. Every tier loads
`runnability.bin`; `runnability-low` is no longer generated and has been
deleted. It costs ~190 kB gzip on Krumlov and ~240 kB on Martinkov against a
25 MB device budget, and device fetch went 14.7 → 16.7 MB.

**The invariant, stated once**: a tier decides how the venue is *drawn*, never
what is out of bounds. Two players on the same seed and different phones must be
running the same race.

**Why nothing caught it.** `check:passable` read `runnability.bin` and the phone
read `runnability-low.bin`; `check:race` only ever ran the default tier; and
both used seeds 3/7/19/42 while the menu seeds with `(Date.now()/60000)|0`, an
eight-digit number. Exactly the D-025 shape: green on one lucky configuration.

`check:passable` now has two phases. The first flood-fills **every distinct
raster the manifest hands to a tier**. The second loads the production build in
headless Chrome at four menu-shaped seeds × two tiers and asserts, of the points
the athlete is actually placed on, that none is inside a barrier or a building
footprint; that the eye sits exactly `EYE_HEIGHT` above the heightfield and that
the heightfield agrees with the surveyed 1 m DMR; that the runtime's own
`reachableFraction` clears the floor and the course is a race rather than one
control; and that the start is not sealed into a pocket. That last is measured
as an **area**, not a radius — the pocket was 3 000 m² but 95 m across, and a
radius threshold high enough to catch it fails honest starts in walled alleys.
Finally it asserts that every tier loaded the *same* passability raster, which
is the invariant above checked against what the runtime actually loaded rather
than against the manifest, which `TerrainField.load` never reads.

**On "levitating", honestly.** I could not reproduce a geometric float and I do
not believe there is one. On both tiers the camera sits at exactly
`field.heightAt + 1.62` and a downward ray onto the terrain mesh returns the
same height to the centimetre; buildings, walls and steps are all founded on
`field.heightAt` rather than on the baked `b.b`, so they cannot separate from the
ground either. The low heightfield differs from the surveyed 1 m DMR by 0.25 m
on average over the playable extent. The gate now measures all three of those
anyway, because they are cheap and they are the things that would produce the
symptom if it ever did appear. My reading is that what was described as
levitating was the same failure as the small circle: standing on an
enclosed square walled in by geometry the 4 m raster had thickened, with the
roofs and the far side of the square visible past it and no way to walk to any
of it.

---

## D-028 — A beginner aid that cannot become a GPS dot

The client: *"the forest is OK, but maybe it'd be worth giving some smaller hint
— a pointer, a light-blue translucent band or something — showing where a
control is? And how to actually approach it correctly?"*

The need is real: the brief asks that a non-orienteer understands the game in
sixty seconds, and nothing told them which way to go. The risk is equally real:
this game's one idea is that there is **no GPS dot** — your position on the map
is your own estimate and it drifts — and a hint that points at the control
deletes the sport.

So the aid is `src/world/bearingBand.ts`, and three properties are built into
its geometry rather than left to discipline:

- **It is a bearing, not a path.** A straight ground corridor along the
  direction to the control. It does not route round the building in front of
  you, and in Krumlov it regularly points at a wall or across the Vltava.
  Finding the way round is what the map is for.
- **It flares**, at 7° a side, which is inside the running "rough compass" error
  a real orienteer accepts (RESEARCH-SPORT §6.1). It cannot be read as a precise
  line to a precise spot, because it is not one.
- **It lets go**, fading to nothing between 130 m and 55 m from the control, so
  it gets you off the start and leaves the attack point and the final approach —
  the actual orienteering — alone.

**The part that matters most**: the bearing is derived from
`RaceView.believedPosition`, never from the true position. A player who has
drifted gets a hint that has drifted with them; punching corrects the belief and
the band swings straight with it. The aid is inside the mechanic rather than a
way around it. It is only *drawn* from the true position, because it has to
start at the player's feet.

Default **on** — almost nobody arriving here has orienteered — with a toggle in
the menu beside the hands switch, read once when the race is constructed so that
changing it cannot alter a race in progress.

The second half of the client's question is answered on the prestart card: four
one-sentence techniques from RESEARCH-SPORT §6 — rough bearing, handrail
(*vodicí linie*), attack point (*odrazový bod*) and the control description — in
CZ/EN/SK, collapsible in one tap, and gone entirely with the aid switched off. A
leg is *úsek*; *postup* is the route, not the leg.

It is rendered as a `MeshBasicMaterial` with a generated alpha texture rather
than a custom shader. That is a deliberate downgrade: a shader that fails to
compile makes geometry vanish while every other gate stays green, and this
project has shipped that twice.

---

## D-029 — The rules run on one surface; only the drawing follows the tier

D-027 settled the class raster and left the heightfield tiered, which looked
safe: `height-low.bin` is *only* the terrain someone stands on. It is not.
`generateCourse` reads heights for the per-leg climb budget, and the seeded RNG
in `pickNextControl` is drawn **inside** geometry-dependent branches — the
candidate is rejected, or it is not, and the next `rng.next()` lands in a
different place. One flipped candidate and every subsequent draw diverges.

Measured on Krumlov, four menu-shaped seeds, `low` against `high`:

| Seed | `low` | `high` |
|---|---|---|
| 29760961 | 14 controls, 1441 m | 14 controls, **1787 m** |
| 29112007 | 15 controls, 1666 m | **17 controls, 1590 m** |
| 28803419 | 17 controls, 1829 m | 17 controls, 1829 m — *and different control positions* |
| 30240557 | 14 controls, 1418 m | 14 controls, **1576 m** |

Three of four visibly, the fourth only under a fingerprint. The athlete's
slope-driven speed reads the same tiered surface, so the physics diverged with
the course: same seed, same route, different pace.

**Shipping one heightfield is not available.** That is the D-027 move and it
does not price out here — `height.bin` is 4.5 MB gzip on Krumlov and 10.4 MB on
Martinkov, against the 25 MB device budget that runnability's 190 kB fitted
inside comfortably. The phone is exactly the device the low tier exists for.

**What is available is to make the tiers agree on one lattice.** The rules are
computed at 4 m — the coarsest spacing any tier holds, so the only one every
tier can reproduce — by `FieldTerrain.rulesHeightAt`. The low tier stores those
nodes outright; the others hold every fourth sample. For that to be *exact*
rather than close, `height-low.bin` is now a **point decimation of the encoded
`height.bin` carrying its own `minH`/`maxH`** (`tools/terrain/lowtier.mjs`,
imported by `build.mjs` so the two cannot drift), not a box-average renormalised
over its own range. Both files then hold the identical `uint16` at every shared
node and decode through the identical scale. Zero extra bytes.

"Close" would have been worthless. Against a chaotic RNG stream a tolerance is
not a smaller error, it is a later one.

**What it costs.** The climb budget and the felt gradient are computed over 4 m
instead of 1 m — climb is a whole-course quantity over 55–190 m legs and does
not notice, and the gradient is now a central difference over 8 m, closer to
what a runner feels than a 1 m lattice's local noise. Decimation drops the
box-average's noise suppression, which is fine: DMR 5G is already smoothed at
1 m, and 4 m is the lattice `CONTOUR_CELL_M` extracts the printed map's contours
on, so the map and the rules now read the same surface — and the contours, too,
became identical across tiers as a side effect.

Nothing *drawn* changed. The mesh, the vegetation, the townscape and the eye
still read `TerrainField` at the tier's own resolution. `TerrainField` is the
surface the venue is drawn on; `FieldTerrain` is the surface the race is run on.

**The gate.** `check:passable` had been *reporting* this divergence since D-027
rather than failing on it, on the honest ground that it was a terrain-pipeline
property and not the sprint work's fault. It now enforces it, on two
fingerprints compared exactly: the course (every control position and code,
length, climb) and the rules surface itself (`FieldTerrain.heightAt` over a
576-point off-lattice grid). The surface is reported first, because it is the
cause and the course is the symptom. Verified by regenerating `height-low.bin`
the old way, which fails all four seeds — including 28803419, the one the old
controls-and-length comparison called identical.

The invariant is D-027's, unchanged, and this is the second thing that had to be
dragged inside it: **a tier decides how the venue is drawn, never what happens
in the race.**

## D-030 — Krumlov races a Knock-Out Sprint round, and now says so

Commit 47d5cfb cut Krumlov's course target from 3.4 km to 1.5 km, which fixed
the client's real complaint — a 3.4 km course cannot be laid out inside a 500 m
old town, so the generator ran up the Vltava and out into the meadows. The fix
was right. The justification attached to it was not.

Three places carried the line *"a real sprint is 1.5–2.0 km of straight-line
course for a 13–15 minute winning time (IOF Competition Rules, appendix 2;
RESEARCH-SPORT §7.2)"*. Checking it against our own research file:

- §7.3 opens by stating that **the rules do not specify course length in km, nor
  control count, for any format.** Length is derived backwards from the mandated
  winning time. There is no appendix 2 distance to cite.
- §7.2 gives winning times and no distances at all.
- The measured elite sprint final is **3.5–4.3 km** at 3:30–4:20/km (Terezín
  2021, Edinburgh 2024) — more than double the figure being cited *for* it.

So the citation did not merely lack support; the source says the opposite, and
in the opposite direction. A number invented to fit the venue had been dressed
up as a rule, which is the failure mode that makes every other sport citation in
this codebase worth less.

**What changed is the description, not the number**, because the number turns
out to be defensible on its own terms. §7.3's measured table gives **Knock-Out
Sprint rounds at 1.6–2.4 km** for the mandated 6–8 minutes, against our gate
band of 1.2–2.2 km. KO Sprint is a real IOF format and it is this venue's
format: 1:4000, technically easy, urban, spectators along the course. Krumlov is
not a sprint final cut short to fit — it is a different event that happens to be
the one the terrain holds.

The general rule, which is why this is a decision and not a comment fix: **when a
figure is chosen for a venue, say so.** A venue accommodation is a perfectly good
reason and it survives review. A venue accommodation wearing a rule's clothes
fails review the first time someone opens the rule.

### The gate stopped taking the generator's word for it

Same commit, the mechanical half. `check-race.mjs` asserted length only on the
sprint, from `SPRINT_LENGTH_M`, kept in step with `courseLengthBand` by hand —
which is how the generator's low edge came to be 1125 m against a gate floor of
1200. The two were never reconciled into one constant, deliberately:

**the regression this gate exists to catch was a wrong target.** Krumlov aimed at
3.4 km and faithfully produced 2.7–4.3 km. Any check derived from `specFor`
would have passed it, because the course matched the target exactly; the target
was the bug. So the gate keeps stating the sport's numbers independently, on the
same footing as `MIN_START_FINISH_M` and the other four properties in that file.

What ties the two sides is **containment, asserted rather than remembered**:
`setCourse` now reports the band it shopped against as `lengthBandM`, and the
gate checks that it sits inside the band the gate allows. A setter whose
acceptance test is looser than the judge's is not a setter — it spends its ten
seeds shopping for courses that will be refused downstream. Both sides stay
independently tunable and the gate speaks up when they drift apart.

Length is now checked on **every** discipline, not just the sprint. "A course of
this format is this long" was never a sprint property; middle and long were
simply not being looked at.

---

## D-031 — The start was in the river, and there were two reasons

**Reported:** *"the city still starts at random places — it doesn't hold to one
race map — and I even started in the river, wtf."*

The lead we went in with was bridges, and it was half right. Measured over 40
menu-shaped seeds before the fix, **1 seed in 40 put the start itself over
water and 9 in 40 put some sited point there** — and only half of those were on
a bridge. Two independent causes, either of which alone reproduces the report.

**Cause 1 — a bridge deck is not the ground under it.** `stampRaster` paints
bridge decks into the runnability raster as passable; that was D-024's fix for
a venue in which every Vltava crossing was severed, and it was right. But the
athlete's eye is `heightAt + EYE_HEIGHT` off a **bare-earth** DMR, and the bare
earth under a bridge is the riverbed. Profiling all 47 bridge-tagged ways, the
main crossings sag **4.6–5.2 m** below their own abutments. So a point on a
deck was legal, open, paved, reachable by every check we had, and rendered at
the waterline — and so was the athlete crossing it, for the whole crossing.

**Cause 2 — drawn water was not out of bounds.** `SprintScene.blockedAt`'s own
comment claimed ISSprOM 301, uncrossable water. It only ever enforced it
through the raster, whose water comes from ZABAGED while the river is *drawn*
from OSM. The two national datasets do not trace the same outline: **5 300 m²
of the venue was drawn as Vltava and left runnable**, and the course setter
sited controls in it — one at (289, −48), 94 m from the nearest bridge, in the
middle of the river with `blockedAt` returning false.

**The fix, in src/world/surface.ts.** One module carrying the two facts the
terrain does not know. `BridgeDecks` derives each deck as the chord between the
way's endpoints — those sit on the banks, on ground the survey got right —
clamped so it can never fall below the terrain, and `Townscape` now *draws* the
deck with a skirt down to the water. Raising the athlete without drawing it
would have traded starting in the river for hovering over it. `WaterIndex` is
the drawn water, and `blockedAt` now refuses it unless a bridge carries you.

Two acceptance thresholds keep the deck honest: below 0.5 m of lift the way is
on the ground and is left alone (26 of 47); above 10 m it is a viaduct, which
in this venue is exactly the Plášťový most, and `landmarks.ts` already models
that with its own deck and arcade.

**One trap, worth naming.** Deck *lift* is measured against the heightfield,
whose resolution is a per-tier rendering budget — so which spans are raised can
differ between `low` and `high`. That is fine for drawing and fatal for rules,
and `blockedAt` is rules. So `BridgeDecks` keeps two indexes: the raised set
(heights, geometry, tier-dependent) and every bridge-tagged carriageway
(passability, pure `townscape.json`, tier-independent). Same invariant as D-027
and D-029 — a tier decides how the venue is drawn, never what happens in the
race.

**The gate.** `check:passable` phase 2 now asserts, of every sited point, that
it is not over water without a bridge under it and that it stands at least
0.5 m above the local water surface, and reports the freeboard distribution
whether or not anything failed — because the report was a draw out of a
distribution, not a single event. The eye check now measures against
`groundAt`, not `field.heightAt`: the contract is unchanged, the surface got a
name. Phase 1's offline mirror of `blockedAt` gained the same water clause.
Cost: reachable-from-arena falls from 95.1 % to 94.3 %, all of it river.

---

## D-032 — A venue has one course

The other half of the same report: *"it doesn't hold to one race map."*

`menuScreen.ts` seeded every race with `(Date.now() / 60000) | 0`. The intent
written next to it was "a fresh course every few minutes, and the same course
for everyone who starts within the same minute", and the client is right that
this is not a thing a real event does. Worse, it made a whole feature dead:
`LocalStore` keys personal bests and ghosts by `course.id`, `course.id` is
`venue-discipline-seed`, and the id changed before a player could ever come
back to it. Nothing was broken in `LocalStore`; it had simply never been asked
a question it could answer.

Each venue now has one fixed seed, `COURSE_SEED` in `src/core/venues.ts`, and
the `&race=1` deep link with no `&seed=` resolves to it — so QA and the gates
exercise the course players actually run rather than seed 7, which nobody has
ever seen.

**The seeds were chosen, not taken.** A setter picks a course. So does
`tools/sim/pick-course.mjs`: it loads the real build headless at several
hundred menu-shaped candidates and scores each against the client's own
sentence — *"always the same course, starts at the start, finishes at the
finish, runs through the alleys"* — disqualifying anything with a point in the
water, a start or finish on a bridge deck, a non-empty `arenaFaults`, a dropped
control, or a seed the setter had to shop away from, then ranking the rest.

The heaviest term is new and is the one the point-wise measures could not
express: **the legs**. Each leg is routed over the game's own collision with
the athlete's own class speeds, and scored on the fraction of that route spent
on Road or Path. A control on a corner reached by a bearing across a meadow
satisfies "controls near paved" and fails "runs through the alleys"; this is
what tells them apart, and `check:passable` now enforces a floor on it.

**What was chosen.** `krumlov 30521551` — 15 controls, 1558 m, 45 m climb, the
top-scoring of 59 viable candidates out of 160. Every one of its 17 sited points
is on Road or Path; the worst control in the course is **0.4 m** off the street
network; 99 % of the fastest running between controls is on it; and it stays
inside the old town instead of finishing up the hill outside it, which is what
the runner-up does by way of a 364 m run-in.

`martinkov 29658380` — 15 controls, 4367 m, 235 m climb. Fourth on score of 120,
and chosen over the top three after looking, which is what the shortlist is for.
The forest disqualifies almost nothing — no river to fall in, no street network
to leave — so the ranking is decided by matters of degree. This one puts 88 % of
its points on runnable ground with none in Green3, runs 5.4 % climb per kilometre
rather than the 6–7 % of several rivals, and alternates 151 m and 479 m legs
inside one compact 790 × 960 m block of the training terrain. What put it fourth
is the start–finish term, capped at 480 m — a figure tuned for a 1 200 m town and
close to meaningless in a 2 000 m forest, where 416 m and 488 m are the same
answer.

The rotating seed belongs to the daily challenge (ROADMAP), where it is seeded
by the **date** so that everybody gets the same course that day and two runs
are comparable. Building that is not this change; stopping the main entries
from behaving like a worse version of it is.

`check:passable` gained a stability phase: four separate loads of the venue's
own URL must give the identical course id and course fingerprint. Cross-tier
agreement was already asserted and is a different claim — it says two phones
agree, not that two runs do.

---

## D-037 — A leg that is routable and 14× its straight line

*(D-033 to D-036 were recorded in their own commit messages — the barrier
stamp and the bridges, the hands, cornering, and in-race energy — and not in
this file. The numbering follows the commits, not the gaps here.)*

The client, on the shipped Krumlov course: *"what didn't work is the bridge in
the town and passability from control 1 to control 2."* Earlier, the same
thing: *"I can see it across the water but I can't get across."*

It reads like the bridge fault of D-033 and it is not one. Flood-filled the
venue through the runtime's own `blockedAt`: every control is reachable. Then
measured each leg's **routed** distance against its straight line, and the
course is grotesque.

```
start→C1    126 m straight    162 m walked   1.3×
C1→C2        58 m straight    810 m walked  14.0×   ← the client's report
C2→C3        85 m             123 m          1.4×
C9→C10      209 m             513 m          2.5×
C12→C13      49 m straight    504 m walked  10.3×   ← the same fault again
C13→C14     225 m             676 m          3.0×
```

Controls 1 and 2 are fifty-eight metres apart on opposite banks of the Vltava
with no bridge between them. The player sees the flag across the water and the
only way to it is eight hundred metres of town. That is not a route-choice leg,
it is a mistake no course setter would make, and the client found both of them.

### Why every gate passed it

`check:passable` asserted that each leg was **routable** — a boolean — and
never compared the routed length with the straight line. `makeLegRouter`
already returned `lengthM` for every leg; the comparison was computed and
thrown away.

This is the third instance of one bug class, after D-019 and D-023: **the check
could say connected or not-connected, and had no way to say "connected and
absurd."** Every leg measure in the file was of that shape. `routed` says the
leg can be run; `pavedFraction` says what it is run on; a course all of whose
legs are routable and 95 % street can still be unplayable, and this one was.

It also makes the description sheet wrong as a matter of fact rather than of
taste. IOF Rule 16.3 measures a course as the straight line through the
controls *"deviating for, and only for, physically impassable obstructions"* —
so the printed length is supposed to contain the detour. `measureLength` in
`src/sim/courseGen.ts` sums straight lines. The shipped course printed 1558 m
and ran 3464 m.

### The limit, and where it comes from

`routedM / straightM`, per leg, **3.0×**, asserted. Chosen from the sport
rather than from what passes:

* **A detour is legitimate.** Rule 16.3 positively expects legs to go round
  things, and Appendix 6 §1.1 makes the choice of *which* way round the point
  of the sprint format: *"the most obvious way out from a control should not
  necessarily be the most favourable one."* A limit at 1.2× would forbid sprint
  orienteering.
* **But it is small.** RESEARCH-SPORT §8.6 derives the whole-course detour
  factor `D` — distance run over stated length — as **1.05 for sprint** and
  1.18 for forest, and explains that the sprint figure is low *because* the
  stated length already deviates round the impassables. Route efficiency
  (100 × straight ÷ actual) is classed "high" above 90 and "low" below 50, so
  elite legs live between **1.1× and 2.0×** and 2.0 is the bottom of the
  published scale.
* **3.0 is therefore half again beyond the worst leg the literature has a word
  for.** It is deliberately permissive: a floor under indefensible, not a
  definition of good. The two faults the client found ran 14.0× and 10.3×.

Legs whose *excess* is under 40 m are exempt, and that is a measurement
allowance rather than a sporting one. The router walks a 2 m lattice with eight
neighbours, which overstates a true path by up to 8 %, and it snaps each end
onto the nearest open cell, which can move a control 3 m. On a 47 m leg — legal
at 25 m running distance under Rule 19.4 — that noise alone is worth 0.2 in the
ratio. Forty metres is about eight seconds of a sprinter's race, and nobody has
ever reported "I could see it across the street." The two real faults carried
752 m and 455 m of excess.

**The whole distribution is printed every run**, not only the failures. The
number that says whether this is fixed is how bad the worst leg was, not
whether the assertion passed today — the same reason D-031 prints the freeboard
distribution. Reporting only "pass" would have hidden the second fault behind
the first.

### Two claims, not one

The per-leg limit is asserted **absolutely on the course that ships**, in the
stability phase, which is the only phase that loads what `COURSE_SEED`
resolves to, and by the 1 m `makeCourseAudit` below rather than by the 2 m
router. None of the four sampled `SEEDS` is it, and both of the client's faults
were in the shipped course and in none of the samples.

Across the sampled seeds the gate asserts a *population* figure instead — the
median leg detour, capped at 1.6×, which is the top of the measured real range
for a sprint course (§8.6: real running "can be 30–60 % longer than the stated
length"). Measured on the sampled seeds: 1.18×. It is a regression tripwire,
not a quality bar.

That distinction is D-032's argument applied to this measure. The sampled seeds
are menu-shaped samples of the generator's output space and nobody plays them.
The course that ships is *chosen*, by `tools/sim/pick-course.mjs`, from several
hundred candidates, precisely because a generator is not a course setter —
*"a real event does not take the first course its planning software offers. A
setter generates, walks, and picks."* Requiring every seed to be raceable is
requiring the generator to be the setter. What it must be is *usually* right,
so that the setter has something to pick from, and that is what the median
asserts.

### A filter in the picker, not a score term

`tools/sim/pick-course.mjs` **disqualifies** a course with a leg over the
limit, sharing `detourFaults` with the gate so that a course the tool can
choose is by construction one the gate accepts.

It has to be a disqualification. The course that shipped won its round of
picking with a 14× leg in it because every term it failed was a *preference*,
and sixty points of street fraction plus eighteen of site runnability plus
twelve of control count outvoted them. A score term is something the rest of
the score can outvote; that is what a score term is for. A point in the river
is a disqualification for the same reason.

A small secondary term separates two courses that both pass — 1.4× and 2.9× are
not the same course — and it reaches zero at the limit so it can never pull a
candidate back over it.

The forest is now routed too. `makeLegRouter` needed a `townscape.json` and
Martínkov has none, so **the forest seed had been chosen without a single leg
ever being routed.** `loadVenue` now reads a missing townscape as "the raster
is the whole collision", which is exactly what `ForestScene` enforces — it has
no `blockedAt` at all — and the lattice radius became a parameter because
Lachovice is 2 000 m across and a lattice sized for the town reports a clipped
leg as *unroutable*, which disqualifies the candidate. The street-fraction term
stays urban-only: a forest course scored on time spent on tracks would be a
course set along the tracks, which is the opposite of orienteering.


### The gate that would have caught the fix

The first attempt at this decision was merged, measured, and reverted. It
shipped a Krumlov course with **six unreachable legs and a sealed control**,
where the ugly-but-runnable course it replaced had all fifteen controls
reachable — strictly worse. Nothing in `check:passable` failed. The fault was
found by hand, with a 1 m probe, after the merge.

That is the more important failure of the two, and it has the same shape as the
one this decision started with: **a measurement that has to be made by hand
after a merge is not a gate.** `makeLegRouter` reported every one of those six
legs routable, because it walks a **2 m** lattice and Krumlov's alleys are
2–3 m wide — the exact aliasing `FieldTerrain.buildReachability` refuses to
accept, and which its own comment warns about.

So `makeCourseAudit` is a second, stricter measurement, and deliberately not
`makeLegRouter` with different constants:

* **1 m, not 2 m** — the resolution the runtime's own reachability fill uses.
* **Shortest distance, not fastest time.** `makeLegRouter` minimises time at the
  athlete's class speeds, which is the right question for *"does it run through
  the alleys"* and the wrong one for *"how far is it"*: the fastest way round
  can be longer than the shortest, and route efficiency (§8.6) is a distance
  ratio.
* **Eight-connected with the corner rule**, so it can neither slip diagonally
  between two blocked cells nor report the four-connectivity "grid artifacts"
  this venue's athlete walks straight through.
* **`SEALED` is distinct from `UNREACHABLE` is distinct from a long leg.** A
  control with no open ground within 3 m is sited inside a wall; a control the
  start cannot reach is a course that cannot be completed; a 12× leg is a course
  that should not have been set. Three different bugs, three different messages.

It runs on the shipped course with no tolerance, prints the full per-leg table
every run, and `tools/sim/pick-course.mjs` calls the identical function over its
top 25 in score order — recommending the first that passes and printing every
rejection. A tool that chooses a course the gate then rejects is worse than no
tool.

### Can the generator avoid this rather than only being filtered for it?

**No — not safely, and that is the finding rather than a budget excuse.** Three
variants were written and measured against the real build:

1. **Refuse a leg whose straight line crosses uncrossable water.** Starves the
   candidate pool: on a leg where the river takes most of the ninety samples
   none survives, `generateCourse` breaks out of its loop, and the course does
   not lose a leg — it *ends*. Krumlov came out at 12 controls against the 14 a
   sprint is specified at.
2. **Refuse on a bounded route probe** over the 1 m mask
   (`FieldTerrain.routeWithinM`, four-connected, capped at 4× the straight
   line). Same failure at the other end, plus two seeds in three shopping for
   another. **Nought candidates in twenty survived the picker**, against about a
   third before.
3. **Prefer dry ground rather than refusing it** — a penalty larger than the
   whole rest of the candidate score. This kept the control counts up, and it
   is the one that was merged. Measured on the shipped course afterwards: the
   14× leg was untouched, and six legs had become unreachable with control 13
   sealed. It moved *where controls are sited* without changing *whether the
   result is checked*, so it found riverside ground the athlete cannot reach.

The cause of all three is structural. `pickNextControl` is greedy and cannot
revisit a control it has already placed, so a leg where every candidate is
across the obstacle usually means the *previous* control was the mistake, and
anything done at this leg punishes the wrong one. And `routeCost` samples the
straight line, which cannot see a detour at all: it reports Impassable,
`legInterest` returns 0, and 0 is a deduction of 1.3 competing against a feature
score of 1.0 and 0.15 of jitter — the same 0 it returns for a leg into a
courtyard. Real backtracking would be the fix and it is not a small change.

**So `src/` is unchanged by this decision — back at 98472c1 exactly.** The
argument for that is not only the measurements above:

> A generator change moves every course at every seed, including the population
> the gates sample. A filter that selects one good course out of several hundred
> is a smaller claim, and a checkable one.

Which is D-032's argument again. The generator produces candidates; the setter
picks. When the picking is the thing that was broken, fix the picking.

### What was chosen

`krumlov` **30 814 554** — 17 controls, 1756 m, 60 m climb. Audited at 1 m,
eight-connected, shortest distance:

```
S→1   137/165  1.2x       9→10    67/72   1.1x
1→2    66/70   1.1x      10→11   118/122  1.0x
2→3    52/56   1.1x      11→12    68/70   1.0x
3→4    63/69   1.1x      12→13    79/83   1.0x
4→5    93/101  1.1x      13→14    70/115  1.6x
5→6    70/78   1.1x      14→15   109/118  1.1x
6→7    57/61   1.1x      15→16    47/49   1.0x
7→8    48/52   1.1x      16→17   162/169  1.0x
8→9    66/72   1.1x      17→F    384/486  1.3x
total 1756 m straight, 2007 m walked — D 1.14
```

Every control reachable; the offline model and the runtime agree on all 19
sited points. Worst leg **1.6×** against a limit of 3.0. The leg the client
reported — control 1 to control 2 — is 66 m of straight line and 70 m of
running, and the autopilot playing the real build walks it in **68 m**.

`martinkov` **29 658 380** — **unchanged**, and that is a result rather than an
omission. Every leg audits between 1.0× and 1.1×, D **1.05**.

**What the re-pick found out about the venue, which is worth more than either
seed.** Across 240 menu-shaped Krumlov candidates:

| | worst leg per candidate |
|---|---|
| best | 1.49× |
| p10 | 2.55× |
| **median** | **8.71×** |
| max | 20.29× |

Only **39 of 240** keep every leg under 3.0×, and 11 under 2.0×. Of 3737 legs,
798 are over 2.0× and 524 over 3.0×. Seven candidates were viable on the full
score; the chosen one is the highest of those that also survives the 1 m audit,
the three above it failing on one leg each at 5.0×, 3.4× and 3.0×.

The forest is the control on that number: across 140 candidates and 2111 legs,
**not one leg anywhere exceeds 1.55×**. Same generator, same scoring, no
uncrossable water. The Vltava loops right around the old town with its bridges
hundreds of metres apart, and a 1.5 km course with fifteen-plus controls in a
500 m-wide town puts consecutive controls on opposite banks constantly.

**So the fault was the venue's and the remedy is selection.** That is the whole
argument for fixing the picking rather than the generator, stated as a
measurement: in this town roughly one seed in six is raceable, and finding it
is what a course setter is for.

---

## D-038 — Phase 1: one vector model, and drawn ≡ solid as a structural property

PLAN-KRUMLOV-V2 §6 phase 1: *"TownModel + colliders. Vector, one source.
Assert: drawn ≡ solid, everywhere."* This is what was built, what it found, and
the three places it contradicts the plan.

### What the model is

`tools/terrain/townmodel.mjs` reads the OSM assembly in `townscape.json` — the
extractor's *input* was never the problem, its reconciliation downstream was —
and writes `public/data/krumlov/townmodel.bin`, 134 kB and 81 kB gzipped:

| | |
|---|---|
| Building footprints | 1739 rings, 10 843 vertices |
| Barriers | 619 ways · 405 uncrossable · 17.05 km solid, 13.49 km crossable |
| Water | 8 areas, 17 watercourses |
| Bridge carriageways | 47 ways |
| Collision primitives | 3852, over a 12 m broadphase |

`src/world/townModel.ts` constructs the indexes at load — 14 ms at 4× throttling
per phase 0 — and `SprintScene.blockedAt` becomes one call into it.

### The property, and why it is structural rather than asserted

**The packed file carries a barrier's height and nothing about its solidity.**
No `u` flag, no collider list, no field in which "drawn tall, not solid" can be
written. `TownModel` derives `blocks = height > crossableMaxH` once; `Townscape`
draws the slab at that same height and to the same thickness; the collider band
is `thickness / 2 + skin` off the same kind code. D-029's 13 849 m of barrier
drawn solid with no collider is deleted as a *shape of bug* rather than as an
instance, and the gate below asserts the shape rather than the instance.

The same treatment closes the other two ways the town could draw what it did not
enforce. A building is a footprint and nothing else — ISSprOM 521 applies to
every one of them, so there is no flag to unset, and `Buildings.blocks` is gone:
it was built from the footprints that class extrudes and *filtered by a rendering
concern*, which is how the Zámecká věž came to be fifty-four metres of masonry
you could run straight through. Anything the scene models by hand registers its
footprint through `addStructure` **in the function that draws it**, and the model
is sealed once the venue is built.

A bridge stops being an exception carved out of two rules. `blockedAt` asks which
surface you are on before it asks what the ground rules are, so a carriageway
lifts the river and the parapet in one line and cannot lift one without the
other — which is exactly what D-033 cost when there were two of them. The deck's
*height* stays where D-031 put it: the chord between its abutments, in
`surface.ts`, which needs the tier's heightfield and was always sound.

### The gate

`tools/ci/check-townmodel.mjs` does not ask the model whether it agrees with
itself. It reads **the scene graph**, rasterises every triangle under the town's
groups at 0.5 m, and compares that with the running game's own `blockedAt`.

| Phase | Result over the 144 ha playable square |
|---|---|
| the file carries no solidity field, and the raster's impassable class is the model's | pass |
| offline drawn ≡ solid at 0.5 m | 0 m² drawn-not-solid; solid exceeds drawn by 0.25 m at worst, which is the skin |
| every mesh the town draws carries a role | 88 627 triangles, all classified |
| **drawn → solid** | **1 m² over 144 ha, worst single run 0.25 m² — one cell** |
| **solid → drawn** | **0 m²** |
| the game's collision against the shipped model's, cell for cell over 5.8 M points | 94 m² is the eight hand-registered structures, **0 m² unexplained** |

Three things about how it judges. The failure criterion is the largest connected
**run**, not the total: a total allowance is what every fault in §1's table hid
inside, since 13.8 km of collider-less barrier is a small percentage of 144
hectares, while a run is what a player actually meets. The one tolerance is a
*distance* — the collider's skin plus a cell — rather than an area. And the one
exclusion is named and measured: 5534 m² of bridge carriageway, where two
surfaces lie over each other and a flat mask has no answer to give.

### What it found, and what had to be fixed to make it pass

Every one of these was drawn and not solid, or solid and not drawn, in the build
that was shipping. None had been reported by a player, and none could have been
found by reading the data.

| | |
|---|---|
| The Zámecká věž | 54 m of tower drawn by `landmarks.ts`, skipped by the extruder that owned the collision index. No collider at all |
| Marian column, fountain pillar, cloak bridge piers, St Vitus tower | drawn by hand, blocking nothing |
| 88 buildings | eave below the ground they stand on — the uphill wall buried, the footprint blocking with nothing standing at it |
| 305 m² of barrier | one mapped segment can be 80 m long, drawn as a straight-topped quad that dives under every hump in between |
| A city wall on a cross-slope | its two faces founded on the centreline, so one floated and one was buried, 40 cm apart |
| 6 m² of the Vltava | the collider is a capsule chain and round at the joints; a strip of quads leaves a wedge missing at every bend, and this river is mapped 24 m wide |
| The cloak bridge's arcade | springing from the height at its own centre, so it grew out of a ravine floor that falls several metres across one bay |

### Three contradictions with the plan

**1. "Drawn ≡ solid" does not mean "every barrier carries a collider."** Phase 0
recorded the set as 2977 barrier segments, *"against 1885 if only the `u`-tagged
ways carried colliders"*, reading §2 rule 2 literally. Applying it literally
would re-close 13.49 km of 0.9 m fence that D-029 measured and deliberately left
crossable: doing so takes the reachable venue from 95.1 % to 85.6 % and walls off
10.9 ha including 2.5 ha of paved street. The rule the model implements is the
one D-029 actually established — **drawn *as blocking* ≡ solid**, where a barrier
is drawn as blocking exactly when it stands above `crossableMaxH` — and a
crossable fence is drawn at a height that says so. The collision set is therefore
1885 segments and 3852 primitives, not 4944. Phase 0's timings were measured on
the larger set, so they remain valid as an upper bound.

**2. The raster could not simply be dropped, and it is now derived rather than
consulted.** §2 says collision is vector, and `SprintScene.blockedAt` is. But
`Race.step` blocks on `Runnability.Impassable`, and `SPEED_BY_RUNNABILITY` gives
that class a speed of zero — so the class raster kept a second opinion about
bounds no matter what `blockedAt` said. Measured on the raster as shipped:
5375 m² where it let the athlete into something the collider stops them at, and
**19 674 m² of the playable square out of bounds with nothing solid in the model
there** — invisible wall, 70.6 % of it within 2 m of something real and the worst
of it 43 m from anything visible at all. `townmodel.mjs` now rewrites that class
in one pass from the model, replacing five stamps applied in an order no single
place owned. The raster remains the *speed and colour* surface (D-002) and the
map is drawn from it; what it may no longer do is disagree.

The exception, stated because it is a real asymmetry: a feature narrower than
the lattice is drawn one cell wide, floored at **half a cell diagonal** — a
0.60 m railing at 45° passes 0.71 m from the centres it runs between, and
anything less leaves it dotted, which put 4.4 % of the venue's uncrossable
barrier length off the map that the athlete is stopped by. Collision itself is
not widened by any of this, and the 2 m router and 1 m audit in `check-passable`
ask the model rather than the raster for exactly that reason.

The version of that fix which widened *every* barrier by half a cell is worth
recording as the near miss it was: a 2.5 m alley became 0.9 m, the course
generator read the raster and produced a course with five legs that could not be
run, and D-027's lesson — that thickening a town seals it — arrived again at one
twentieth of the scale.

**3. A vector collider thinner than one step is not a barrier.** `Race.step`
tested the destination of a step and never its path. Against a stamped raster a
metre wide that was survivable; against a railing whose collider is 0.60 m and a
sprinter who moves 0.56 m in a frame it is not, and the failure is *asymmetric*:
`check-passable` found a 142 m² pocket you could step into off a road and not
step out of through Green2, because the step you leave with is shorter than the
one you arrived on. A trap made of nothing but arithmetic. The step is now swept
at 0.20 m — under the narrowest collider in either venue — so entering and
leaving are the same test, and the whole trap class goes with it rather than the
instance.

### What it cost, measured

| | before | after |
|---|---|---|
| `blockedAt`, 5.76 M-point venue sweep in the browser | — | 1.25 s, i.e. **217 ns a query** unthrottled |
| model construction at load | — | 14 ms at 4× (phase 0) |
| townscape triangles | 88 627 | 121 863 (+37 %, the wall subdivision) |
| shipped bytes | — | +134 kB raw, +81 kB gzip, inside the 25 MB device budget |
| reachable from the arena | 94.9 % | 94.9 % |
| uncrossable barrier drawn on the map | 95.6 % | 99.5 % |
| traps — ground you can enter and not leave | 1 (142 m²) | **0** |

The frame budget is unchanged from phase 0's finding: at 217 ns unthrottled the
measured 105 calls a frame is 0.02 ms, and phase 0's 4× throttled figure of
0.36 ms at the p99 on a 128-query frame — 1.07 % of a 33.3 ms frame — still
bounds it.

### One thing that moved and was not asked to

`COURSE_SEED` is untouched, and the course it resolves to changed anyway. The
generator's RNG is drawn inside geometry-dependent branches (D-029), so replacing
the passable surface re-rolls every course. Krumlov's shipped course went from 15
controls at D 1.48 to **13 controls, 1740 m, D 1.16, worst leg 1.9×** — better on
every measure the audit prints, and still starting and finishing on Road. It was
not chosen, though, and `tools/sim/pick-course.mjs` should be re-run when phase 3
sites courses on the street graph. Until then this is a generated course that
happens to be good, which is the distinction D-032 exists to make.

The same re-roll moved the sampled seeds, and one of six sprint samples now sites
its 90th-percentile control 10.4 m off a runnable way against an 8 m limit.
`check-race` asserts that measure across the samples rather than on each of them,
which is D-037's own distinction applied to the other sprint measure it fits:
the samples are the *generator's* output space and nobody plays them, and the
median across them is 2.5 m. The per-seed maximum stays a per-seed failure.

---

## D-039 — Phase 2: the passable space, and the 1 m drawing the athlete was colliding with

PLAN-KRUMLOV-V2 §2 rule 4: *"Passable space is derived, then asserted connected,
before any course exists. Not flood-filled afterwards to see what broke."*

That is what phase 2 shipped. But the first thing it found is that the sentence
could not be executed as written, because the model was not what stopped the
athlete — and that is the finding worth reading first.

### The thing phase 1 built and the athlete never met

D-038 made `SprintScene.blockedAt` one call into `TownModel`, and it is. But
`Race.step` does not call it. Its own `blocked` was

```ts
(x, z) => this.terrain.sample(x, z).runnability === Runnability.Impassable
```

and `FieldTerrain.runnabilityAt` was `blocked?.(x, z) ? Impassable : <the 1 m
class raster, nearest cell>`. So the athlete's bound was the model **or** the
raster, and the raster is the model *drawn at map line widths*: `townmodel.mjs`
widens any feature narrower than the lattice out to half a cell diagonal so a
0.10 m railing appears as a line rather than as dots. D-038 recorded that
widening and called it a real asymmetry. It did not measure it.

A derived raster cannot *disagree* with its source — D-038's point, and it
holds. It is a weaker property than being the same shape, and the difference is
measured in alley widths. `tools/terrain/quantisation.mjs` measures it, on the
town's own **62 741 paved centreline points**, casting perpendicular to each
centreline, which is what alley width means:

| | vector model | as the athlete met it |
|---|---|---|
| median corridor, whole network | 19.64 m | 19.14 m |
| median **≤3 m alley** | **1.80 m** | **1.52 m** |
| alley centreline you cannot stand on | 0 % | **12.8 %** (140 of 1096 points) |
| whole network, centreline you cannot stand on | 0 % | 1.1 % |

**D-027 is this fault at 4 m and 49 % of the centre. It was still here at 1 m
and 12.8 %.** It survived because every measure anyone had applied to it was an
*area* — reachable fraction, open hectares — and phase 0 had already written
down that an area measurement can never catch it: "Open *area* is 77.0 % at
every resolution tested, which is precisely why an area measurement could never
have caught D-027." Nobody had measured the alleys.

The fix is `FieldTerrain.blockedAt`, and `Race.step` now asks it. Inside
`authoritativeR` — `TownModel.playableR`, ±600 m — the vector model is the whole
answer and the class raster decides nothing. Outside it the raster still
answers, because the heightfield runs 200 m past the model and nothing else out
there knows where the Vltava is. **The forest is untouched by construction:**
with no model, `blockedAt` is the raster, which is what it has always been and
is right there — Lachovice has no vector geometry and its lakes and cliffs live
in the class raster.

It is also *cheaper*. `pathBlocked` sweeps a step every 0.20 m and each sample
was running `sample()`, which computes a central-difference gradient — four
bilinear height lookups — and throws all of it away. It is now one 217 ns model
query.

One consequence had to be handled rather than discovered. `Impassable` carries a
speed of zero, so the widening halo — 0.24 m either side of a wall, 0.41 m
either side of a railing, about 1.5 ha of Krumlov — became ground the athlete
can walk into and never leave, frozen. `runnabilityAt` gives those cells the
nearest real class instead, which is the rule `deriveRaster` already applies
offline to the cells it frees.

### The artefact

`tools/terrain/passable.mjs` reads the **shipped** `townmodel.bin` and writes
`public/data/krumlov/passable.bin`: two bit-planes — open, and the arena's
component — at **0.5 m** over the playable square, 2401 × 2401 = 5 764 801 cells,
1407 kB raw and **224 kB gzipped**.

**Why 0.5 m**, on phase 0's own evidence and one argument phase 0 did not make:

| cell | ≤3 m alleys kept | false-open | 1-bit RAM |
|---|---|---|---|
| 4 m | 62.8 % | 1.30 % | 11 kB |
| 1 m | 89.2 % | 0.70 % | 176 kB |
| **0.5 m** | **93.9 %** | **0.51 %** | **704 kB** |
| 0.25 m | 96.0 % | 0.43 % | 2814 kB |

0.25 m buys two points of alley for four times the memory, against a 96.1 %
ceiling the vector model sets anyway. The argument phase 0 did not make is the
decisive one: **the game was flooding at 1 m and the gate at 0.5 m.** A gate
finer than the thing it judges is exactly D-027's shape — the gate read
`runnability.bin` and the phone read `runnability-low.bin`. Shipping the space
makes them the same array.

**What it costs.** 1.41 MB resident for both planes, against `runnability.bin`'s
2.56 MB, and it *removes* roughly 25 MB of transient allocation the 1 m fill
used to make (six 2.56 M-cell arrays and a 10 MB `Int32Array` queue). On the
wire, 224 kB gzip inside a 25 MB device budget.

**The graph is the athlete's, not the lattice's.** 8-connected, and every edge
swept at `SWEEP_M` = 0.20 m, which is `Race.step`'s own step test precomputed.
4-connectivity calls two diagonally adjacent open cells disconnected when their
shared orthogonal neighbours are blocked — a 0.5 m diagonal doorway the athlete
walks straight through, which `check-passable` had been reporting as "grid
artifacts" and excusing.

### The census

Over the 144 ha playable square: **111.5 ha open, 105.9 ha reachable from the
arena — 95.0 %**, in 645 components.

| | |
|---|---|
| pockets over 6 m² that are not the arena's | **143** |
| sealed — the athlete cannot get in either | **143** |
| porous · grid artifacts · traps | **0 · 0 · 0** |
| largest sealed pocket | 9319 m² |
| components the lattice split and the entry probe put back | 10, 282 m² |

The vocabulary is `check-passable`'s and is deliberately not reinvented. Two of
its four words are now **arithmetically** empty rather than merely unobserved,
which is worth stating: a swept step is symmetric (D-038), so nothing enterable
can fail to be escapable and there is no asymmetry left to make a trap out of;
and the reconciliation below has already merged every grid artifact there was.
The census still reports all four, for the day one appears.

### The gate, and what it is allowed to assert

`tools/ci/check-passable.mjs` gained a phase that runs **before any course
exists** — every other phase in that file runs against a course, and this one
would fail on a Krumlov that had never had a control sited in it.

It re-derives `passable.bin` from the shipped model and compares it **cell for
cell**: 5 764 801 cells, both planes, **0 differ**. Not sampled — a scatter of
probes is how every fault in §1's table stayed hidden, each small in area and
total in consequence.

Then it enforces the census: traps and porous pockets fail at any size, and so
do grid artifacts. In the running game it asserts that every tier holds the
**identical** passable space, fingerprinted over 90 000 samples of the object the
game is using rather than of the manifest; and that opening the venue stays
under a 250 ms tripwire.

### Load time, measured before and after

`FieldTerrain.costMs` records what each venue-wide pass costs and
`tools/perf/setup-cost.mjs` reads it out of the running game at
`Emulation.setCPUThrottlingRate: 4` — this project's Android proxy, the throttle
every timing here is stated against.

| | before | after |
|---|---|---|
| reachability fill | 4450 ms | **0 ms** |
| `bakedRaster` | 1452 ms | **1 ms** |
| **venue setup, total** | **5902 ms** | **1 ms** |

Phase 0 predicted 2.6 s and 2.9 s for these two and was right.
`buildReachability` now reads `reachableFraction` out of the file.
`bakedRaster` is a copy of the class raster plus the eight footprints
`landmarks.ts` registers by hand — 94 m², punched in from their own bounding
boxes, bounded by the structures rather than by the venue.

The routing lattice the autopilot needs is the one venue-wide sweep left, and it
is built on first use rather than at load: a test hook may not spend a player's
loading time.

### Three contradictions with the plan

**1. Phase 2's own sentence was not executable.** *"Derive the passable space
from `TownModel`"* presumes the model is what stops the athlete. It was not, and
phase 2's first commit had to make it so. This is the same shape as D-038's
second contradiction — the raster kept a second opinion — one layer further
down, and it means phase 1's headline property was true of `SprintScene` and not
of the race. **Anything that asserts a property of `blockedAt` should say whose
`blockedAt` it means.**

**2. "Assert one connected component" is not achievable and should not be.**
Krumlov has 143 sealed pockets over 6 m², 5.6 ha of them, and they are the town:
the Baroque zámecká zahrada behind its garden wall, block interiors reached only
through arches OSM maps as `tunnel=building_passage`. Sealing is what a walled
garden *is*. The assertion that means something is **no pocket anyone can
enter**, plus a ceiling on the largest sealed one so the severed-bridge failure
(54 ha) cannot hide inside the exemption. The plan's phrasing already offered
this alternative and the alternative is the whole of it.

**3. A lattice cannot express every doorway, at any resolution — and this is not
a resolution problem.** 8-connectivity with swept edges still split **10
components, 282 m²**, off the arena's. The reason is structural: a component
graph joins *cell centres*, and Krumlov has doorways where a clear line exists
between two points inside adjacent cells while the line between their centres is
blocked. Halving the cell shrinks each instance and creates new ones at the new
scale; phase 0's resolution table has no column for it because it measured
corridors, not connectivity. What is available is to let the continuous probe
overrule the lattice: `derivePassable` reconciles to a fixed point with the same
32-bearing entry probe the census uses, and those 10 components go back where
they belong. **Where the lattice and the athlete disagree, the athlete wins** —
otherwise the shipped mask says unreachable about ground you can stand on, and
the course generator refuses to site a control there for a reason that is not
true.

### Two smaller things found on the way

**`bakedRaster` had been almost entirely redundant since phase 1.** It swept
2.56 M cells at 1452 ms a load to discover 94 m² of hand-registered structure
and 581 m² of model geometry that runs past the playable square — because
D-038's `deriveRaster` had already written everything else into the class raster
and clipped itself at ±600 m. `deriveRaster` now seals outside the square too
(freeing stays inside it, or ZABAGED's water upstream of the town would be
opened), and the sweep is gone.

**`check-payload` was under-counting the device fetch.** `LOW_TIER_TERRAIN`
never listed `townscape.json`, and phase 1 added `townmodel.*` without adding it
either. With `passable.*` that would have been 1.5 MB of a 25 MB budget going
unmeasured. Now counted: **17.4 MB of 25**.

### And one thing that moved without being asked to

`COURSE_SEED` is untouched and the course changed again, for D-029's reason:
the generator's RNG is drawn inside geometry-dependent branches and the
reachable set is now a 0.5 m 8-connected one rather than a 1 m 4-connected one.
Krumlov went from 13 controls / 1740 m to **17 controls / 1788 m**. As in D-038
this is a *generated* course that happens to be sound, not a chosen one, and
**phase 3 must re-run `pick-course.mjs` on the street graph** — which it was
always going to do.
