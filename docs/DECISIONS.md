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
