# Krumlov v2 — rebuild the town from the ground up

**Status:** planned, not started. Krumlov is `soon: true` in the menu; the forest ships.

**Client's brief:** *"the town is completely bewitched — you run out and there's a wall
straight away, you can't get anywhere. The forest you've built superbly, we don't want to
wreck it. Don't make the town accessible in the menu for now, try to build it again from
scratch, and build in some little shops so it has feel — or another mechanic, so it looks
game-like but realistic, and so there's a feel to it. Then we'll test it, and only then
release the first version to the team."*

---

## 0. The venue decision, made rather than inherited

Krumlov has cost more than everything else in the project combined, and the World Cup has
no sprint — Krumlov is the separate GAPP Czech O-Tour Prologue. So the fair question was
whether to drop it and build a second forest instead: same pipeline, the one that
demonstrably works, a fraction of the risk.

Asked, and answered by the client: **keep the town.** *"It's the O-Tour Prologue, as a
supplementary thing — but the town is what's catchy for the player."*

That is the right call and it is worth writing down, because it is the reason to spend the
effort in §6 rather than a reason to regret it. A forest is where the sport is; a medieval
town is what makes someone who has never orienteered want to press start. The venue that
sells the game and the venue that is the game are different venues, and we need both.

It also means **v2 is judged on feel, not only on correctness.** A Krumlov that merely
works is a failed rebuild. §4 and §5 are not garnish on this plan; they are half of it.

---

## 1. Why v1 failed, stated precisely

Not a run of bad luck. In order, every one real, every one found by the client rather than
by a gate, and every fix exposing the next:

| # | Fault | Fixed in |
|---|---|---|
| 1 | Every bridge over the Vltava severed — `stampPaved` refused to paint over Impassable | D-024 |
| 2 | Low tier loaded a 4 m runnability raster; alleys are 2–3 m. 49% of the centre impassable | D-027 |
| 3 | 13.8 km of barrier drawn solid with no collider — only 9 of 701 ways carry a height tag | D-029 |
| 4 | Start sited in the river; bridge decks sag 4.6–5.2 m below their abutments in bare-earth DMR | D-031 |
| 5 | Drawn water never out of bounds — 5 300 m² of Vltava was runnable | D-031 |
| 6 | The barrier stamp re-closed the bridges that (1) had opened | D-033 |
| 7 | Leg 1→2 ran 717 m for a 59 m straight line — 12.3× | D-037 |
| 8 | **Never diagnosed:** run out of the start and hit a wall immediately | — |

**Fault 8 is deliberately not being investigated in v1**, and that needs saying out loud
because it cuts against this project's own rule of measuring before rebuilding. The reason
it is right here: the model it would be a fact about is being discarded, so the answer would
be an autopsy rather than a diagnosis. The client's reasoning exactly — *"that is why I'm
proposing we start again."*

**But one cheap thing must be checked before phase 1**, or v2 inherits it. Fault 8's cause
lies on one side of the discard line, and we do not know which:

- **Discarded side** — a barrier without a collider, a raster cell, a stamp order. Then it
  dies with the pipeline and nothing more is owed.
- **Kept side** — start siting, the spawn pose, the camera's initial facing, or the map's
  orientation against what the player sees. Then it survives the rebuild untouched and
  reappears in phase 5, and we will have spent the whole rebuild to reproduce it.

Cost to find out: load v1, stand at the start, look at what is in front of the athlete and
which of those two lists it belongs to. Not an hour of forensics — a single observation. Do
it, record the answer, then close v1.

### Answered: fault 8 is on the KEPT side, and it is mine

Measured at the shipped start of `krumlov-sprint-30814554`:

| | |
|---|---|
| Start class | **4 — ForestOpen.** Woodland, not street |
| 25 m around the start | 888 cells ForestOpen · 617 Road · 243 Green2 · 206 Impassable |
| Facing at spawn | 303°, and the bearing to control 1 is 303° — **correct** |
| First obstruction toward control 1 | **11 m**, a `town.blocks` barrier, class Impassable |
| Open sectors (≥15 m clear, 24 sampled) | 17 — **not enclosed**, a detour exists |

So: the athlete spawns facing the right way, standing in woodland on the edge of the
built-up area, with an uncrossable feature 11 m ahead. That is exactly *"you run out and
there's a wall straight away."*

Two things follow, and the second is the uncomfortable one.

**It is not an invisible-wall fault.** The obstruction is a `town.blocks` barrier — drawn
*and* solid, the two agreeing. It is a real wall you must run around. So fault 8 is **not**
fault 3's class and does not die with the raster pipeline: it is **start siting**, which is
kept code, and it is what §3 fixes by siting on the street graph.

**It is a regression I introduced.** The previous seed started on cobbles in Latrán — the
client's own acceptance test was *"it starts at the start and runs through the alleys."* I
re-picked the seed to kill the 12× leg (D-037), improved the detour factor from 2.18 to
1.14, and moved the start into the woods without noticing. The audit measures *legs* on the
network — 96% — and no check asserts that **the start itself is on it**. A gate that scores
the course as a whole let its most-looked-at single point walk off the street.

That is the same failure shape as every other one here: the measure was right about what it
measured and silent about what it did not. **Phase 3 must assert the start and finish are on
the graph**, not merely that the legs are — and until v2 exists, v1's own audit should carry
that assertion too, since the client is not being shown the town in the meantime.

**The common cause is representation, not detail.** Three sources disagree about where a
wall is:

- **OSM** — building outlines, barrier ways, street centrelines. Vector, accurate, incomplete
  (heights and barrier types mostly absent).
- **ZABAGED** — the runnability raster. Different outlines, different water.
- **DMR 5G** — bare-earth heights. Knows nothing about bridges, so a deck is a riverbed.

v1 reconciles them by **stamping one onto another**, in an order no single place owns.
Each stamp is individually defensible; the composition is not, and the composition is what
the player runs into. Fault 6 is the proof: two stamps, each correct, that undo each other.

**The forest comes out of the same pipeline and has none of this** — 2 111 legs measured
across 140 candidate courses, not one over 1.55×. The difference is not care, it is kind:

> A forest is a **cost surface**. Being slightly wrong makes running slightly slower.
> A town is a set of **hard edges**. Being slightly wrong makes a wall.

So v2 is a rebuild of the model, not a re-tune of its constants.

---

## 2. The one architectural decision

**One authoritative vector model of the town. Collision, map and course generation are all
derived from it. Nothing is stamped onto anything.**

This is D-002's principle — the one that has held all project long, where `Runnability`
carries both the ISOM symbol and the speed multiplier so map and physics cannot drift —
applied to the town's geometry instead of its classes.

```
                 ┌───────────────────────┐
   OSM vector ──▶│                       │──▶ colliders (polygon + segment, broadphase grid)
   ZABAGED    ──▶│   TownModel (vector)  │──▶ ISSprOM map render
   DMR/DMP    ──▶│  built offline, once  │──▶ street graph (routing, course setting)
                 │                       │──▶ 3D geometry (façades, walls, furniture)
                 └───────────────────────┘
```

Rules that fall out of it:

1. **Collision is vector, not raster.** No resolution to get wrong on a phone (kills 2).
   A 2 m alley is 2 m at every tier because it is two lines, not a sampled grid.
2. **Anything drawn that blocks, and anything that blocks, is the same object.** One list.
   Drawn-but-not-solid and solid-but-not-drawn both become unrepresentable (kills 3).
3. **Bridges are first-class.** A crossing is a deck polygon with a height, not an exception
   carved out of a water test (kills 1, 5, 6).
4. **Passable space is derived, then asserted connected, before any course exists.** Not
   flood-filled afterwards to see what broke.

**What this decision does *not* buy, separated out honestly**, because an earlier draft of
this plan credited one idea with three ideas' work:

- **Fault 7** (the 12× leg) is a *course-setting* fault. The **street graph** in §3 fixes it.
  The vector model is what makes the graph trustworthy, but it does not set courses.
- **Fault 4** (decks 4.6–5.2 m below their abutments) is a *missing data* problem. Bare-earth
  DMR does not know a bridge exists and a vector model does not conjure deck heights. They
  have to come from somewhere — DMP 1G's surface model, OSM `layer`/`bridge` tags, or the
  chord-between-abutments derivation v1 already uses, which was itself sound. Rule 3 makes
  the deck a real object rather than an exception; it does not tell us how high it is.
- **Fault 8** is unknown (§1) and may lie entirely outside all of this.

So the vector model is the foundation, not the fix. Three separate pieces of work.

## 3. The street graph, and why it ends fault 7 and 8

A sprint is run on a network. Build it explicitly — nodes at junctions and gateways, edges
along runnable ways, with the barrier crossings that are legal.

Then, by construction rather than by gate:

- **Controls are sited on the graph**, so a control cannot be behind a wall or in a garden.
- **Legs are routed on the graph** at generation time, so detour ratio is known *while
  setting the course* instead of audited after. v1's generator samples the straight line and
  literally cannot see a river (D-037).
- **The start's first 50 m are checked for an opening.** Fault 8 — run out, hit a wall — is
  a start sited against geometry with no run-out. Trivial on a graph, invisible on a raster.

Krumlov is ~1 200 m square with maybe 400 junctions. This is a small graph.

## 4. Feel — the shops, and what they are actually for

The client asked for shops. They are not decoration, and this is the part where the sport
and the look want the same thing:

**In a real sprint, control sites are man-made features** — the corner of an arcade, the
foot of a stairway, a statue, a gateway, a bench. ISSprOM has symbols for them and IOF
column D describes them. v1 sites controls on "urban score" abstractions, which is why the
descriptions read thin and why nothing in the 3D world marks the spot.

So: **model the furniture, and the furniture becomes the control sites.** One list of real
objects serves the look, the map symbol, the control description, and the thing you
actually see when you arrive.

Krumlov-specific, in rough order of value per unit of work:

- **Ground-floor shopfronts** — doorway, window, sign board, awning, A-board on the street.
  The single biggest change to how an alley reads at eye level.
- **Arcades and passages** — Krumlov's are its signature, and an arcade you can run through
  is genuine route choice. Needs (3) to be honest about what is passable underneath.
- **Sgraffito façades** — the castle and Latrán. Procedural, and unmistakably this town.
- **Street furniture** — lamps, bollards, benches, planters, café tables, fountains, steps.
- **The river working** — rafts, weirs, the mill. Seen from every bridge.
- **Roofscape** — the red-tile sea is the postcard view and it is what a spectator sees.

**Hard rule, from the brief and unchanged:** brand assets are never AI-generated; shop
signage must be invented, not real trademarks, unless supplied.

## 5. Mechanics that suit a town rather than a forest

The forest's game is reading terrain. The town's is different and mostly unexploited:

- **Route choice as the whole point.** Left or right around a block is a real decision with
  a real time cost. It needs the graph (§3) to be measurable, and it deserves to be shown
  afterwards: *your route vs the optimum vs the ghost*.
- **The map is everything.** At 1:4 000 with 2 m alleys, mis-reading one passage costs
  20 seconds. The existing drift-and-punch model is already right for this.
- **Corners cost speed** — shipped, and it is a town mechanic: it is what makes the long way
  round sometimes faster.
- **Spectators and the run-in.** A sprint is the spectator format. Crowd, commentary, the
  finish chute — the one place in orienteering where atmosphere is part of the sport.
- **Uncrossable is a rule, not a wall.** IOF 17.2: crossing a marked-uncrossable feature is
  disqualification, not physics. A town that *lets* you and then DSQs you is more honest,
  more legible, and removes the "invisible wall" feeling entirely.

That last one may be the single biggest fix to how v1 *feels*, independently of the geometry.

## 6. Phases, each shippable and each verified before the next

**Phase 0 — two hours, and it can cancel the plan.**

- **Answer fault 8's which-side question** (§1). One observation.
- **Spike vector collision on a phone.** This plan asserts vector collision beats raster
  because there is no resolution to get wrong. That is a *correctness* claim and it is
  sound. The *performance* claim is untested and goes the other way: a raster lookup is one
  array index, while a point against thousands of wall segments needs a broadphase that has
  to earn its keep at 30 fps on a mid-range Android — the device the brief is written for,
  and the device on which v1's raster bug was invisible from this desk.
  **Kill criterion:** if a broadphase grid over Krumlov's full segment set cannot answer
  `blockedAt` in well under the frame budget on the low tier, the architecture in §2 is
  wrong and this plan needs rewriting around a hybrid — vector for the map and the graph, a
  fine raster *derived from it* for per-frame collision. Derived, so it still cannot
  disagree; that is the part of §2 that matters, and it survives either outcome.

Do phase 0 before writing any of phase 1. It is the cheapest hour in the plan and the only
one that can save the rest.

1. **TownModel + colliders.** Vector, one source. Assert: drawn ≡ solid, everywhere.
2. **Passable space + connectivity.** One component, asserted before any course exists.
   Tier-independent by construction.
3. **Street graph + course setting on it.** Detour ratio and start run-out known at
   generation time.
4. **Dress the town** — shopfronts, arcades, furniture — with furniture doubling as control
   sites and column-D descriptions.
5. **Play it.** Not a gate — a person running the course, several times, on a phone.

**Do not re-enable the menu entry until phase 5 passes.** That is the client's sequencing and
it is the correct one: every Krumlov fault so far reached him because something shipped on a
green gate that had never been played.

**Who plays it in phase 5:** both, in order. I run the whole course on the low tier first
and report where it stops being fun as well as where it stops working — every fault so far
reached the client because I stopped at "the gate is green". Only then does it go to him,
and only then to the team. He is the last check, not the first.

**Sizing, so this is a decision and not a slope.** Phases 1–3 are the real build and are
comparable in scope to everything Krumlov has cost so far, done once and properly instead of
seven times in patches. Phase 4 is open-ended by nature — shopfronts and arcades can absorb
any amount of time — so it should be **timeboxed and shipped at whatever depth it reaches**,
starting with ground-floor shopfronts, which buy the most feel per hour at eye level. Phase 5
is short but must not be compressed; it is the step whose absence caused this rebuild.

## 7. Keep from v1

Working and worth carrying over unchanged: the ISSprOM renderer and the normative colours
(`src/map/isom.ts`), control markers and flags, the course audit and per-leg detour table
(D-037), the dead-reckoning navigation model, `check-passable`'s offline-vs-runtime
agreement assertion, the energy and nutrition model, and the seed-picking harness.

The thing to *discard* without sentiment is the raster-stamping pipeline in
`tools/terrain/townscape.mjs` and the `blockedAt` composition in `src/world/sprintScene.ts`.
