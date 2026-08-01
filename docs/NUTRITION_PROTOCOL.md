# Nutrition Protocol

The implementation spec for the Enervit before/during/after mechanic.

**Companion documents.** `CLAIMS_TO_REVIEW.md` governs what any of this may be
*called* in player-facing copy. `ENERVIT_SKU_MAP.json` is the machine-readable
product data; every number in the tables below traces back to it. The four
stats — `glycogen`, `hydration`, `bloodSugar`, `focus` — are defined in
`src/core/types.ts` as `AthleteStats`.

**Sourcing rule used throughout.** A figure is marked **[V]** when it was read
off a primary source: an Enervit packaging panel, an Enervit-published
document, the official event Bulletin 4, or a peer-reviewed paper fetched
directly. It is marked **[U]** when it is derived, inferred, or came from a
secondary source. No number in this document was invented. Where a source is
silent, the document says so rather than filling the gap.

---

## 0. The one thing that must not be got wrong

Almost every sports-nutrition protocol in circulation — including Enervit's own
published fuelling plans — is written for events lasting **three to seven
hours**. Orienteering races last **15 to 100 minutes**. Copying a gran fondo
protocol into this game would produce something that is simultaneously
unrealistic, bad advice, and off-brand for a sport whose athletes are famous
for carrying nothing.

Enervit's own NUTRITION SYSTEM® sheet states the condition explicitly **[V]**:

> "FOR RIDES LONGER THAN 2 HOURS, IT IS ADVISABLE TO HAVE A CARBOHYDRATE INTAKE
> OF APPROXIMATELY 60g FOR EVERY HOUR."

Note *longer than 2 hours*. Not one World Cup orienteering race at Vyšší Brod
reaches that threshold. The 60 g/h figure — the number everyone reaches for —
is therefore **out of scope for every race in this game**, and the design should
treat a player who tries to hit it as making a mistake, not as optimising.

This is a feature, not a limitation. A game in which the correct answer is
sometimes "take nothing" is far more interesting, far more truthful, and far
more defensible to a regulator than one in which more product is always better.

---

## 1. The actual races

From official **Bulletin 4** for the Orienteering World Cup, Vyšší Brod,
5–9 August 2026 — all **[V]**, all event-specific rather than generic.

| Race | Day | Winning time | Max time | Course (Men A / Women A) | Refreshments on course |
|---|---|---|---|---|---|
| Sprint Prologue (Český Krumlov) | Wed 5 Aug | 20–25 min | — | urban sprint | **none** |
| Qualification | Wed 5 Aug | 50 min | 120 min | M 7.9–8.0 km / 440–465 m | 2 (M at 47%, 91%; W at 56%, 89%) |
| **Long final** | Thu 6 Aug | **90 min** (A), 88 (B), 80 (C) | 180 min | M 15.2 km / 735 m / 30 c · W 12.9 km / 595 m / 30 c | **5** (M at 18, 34, 63, 78, 80% · W at 21, 41, 58, 75, 78%) |
| **Middle final** | Sat 8 Aug | **32 min** (A), 30 (B/C) | 75 min | M 5.4 km / 150 m / 22 c · W 4.5 km / 120 m / 18 c | **1** (M at 72%, W at 63%) |
| Relay | Sun 9 Aug | 90 min total, **30 min per leg** | 180 min | — | 1 at arena passage (M 75%, W 72%) |

Two further details from Bulletin 4 that the mechanic should use:

- **What is actually in the cups [V].** §11.14: *"Refreshment points within
  courses will offer water (transparent cups) and ENERVIT Isotonic Drink
  (branded cups) – sport drink prepared as hypotonic (15 grams of Enervit
  instant product per 500 ml of water)."* Note **15 g**, not the standard 30 g
  dose — this is deliberately half-strength. It changes both the in-game
  numbers and, importantly, the claims position. See §7.
- **Heat [V].** §on safety: *"The weather forecast is 30+°C for the first days
  in August"*, and if temperatures exceed 30 °C *"additional water refreshment
  stations will be added to the courses"*. Heat is the one condition under which
  the hydration and sodium stats stop being decorative, so it belongs in the
  game as a per-race modifier.
- **Coaching zone [V].** At Long and Relay only, near the spectators' control,
  coaches *"can hand out personal refreshments"*. This is the sanctioned route
  by which a player's own chosen product reaches them mid-race, and it maps
  cleanly onto a loadout slot.

**Design consequence.** The Sprint has no feed station and no realistic
opportunity to carry or consume anything. The Middle has exactly one, late.
Only the Long has a genuine in-race fuelling problem. The three formats
therefore need three genuinely different mechanics, not one mechanic scaled.

---

## 2. BEFORE

### 2.1 What the evidence supports

Verified directly from Jeukendrup AE, *"A Step Towards Personalized Sports
Nutrition: Carbohydrate Intake During Exercise"*, Sports Med 2014;44(Suppl
1):S25–S33 (PMC4008807) **[V]**:

> "A single carbohydrate source can be oxidized at rates up to approximately
> 60 g/h and this is the recommendation for exercise that is more prolonged
> (2–3 h)."

and for events around an hour:

> "a mouth rinse or small amounts of carbohydrate can result in a performance
> benefit"

The ~90 g/h figure applies only to ultra-endurance and requires multiple
transportable carbohydrates — the C2:1 rationale — and is irrelevant here.

> **[U] — verification gap.** The standard pre-event guidance of *1–4 g
> carbohydrate per kg body weight, 1–4 hours before* comes from the ACSM /
> Academy of Nutrition and Dietetics / Dietitians of Canada joint position
> stand *Nutrition and Athletic Performance* (Med Sci Sports Exerc 2016;48(3)).
> That document was **not** retrieved directly in this research pass. The
> g/kg-based numbers in §2.2 are therefore marked [U] and must be confirmed
> against the position stand before any of them appears in player-facing
> educational text.

### 2.2 Protocol by format

Timings follow Enervit's own published instructions where they exist.

| | Sprint (~15–25 min) | Middle (~32 min) | Long (~90 min) |
|---|---|---|---|
| **Meal, 3 h out** | normal meal, low fibre | normal meal, low fibre | normal meal, low fibre **[U]** |
| **Pre Sport Jelly** | 1 pouch, −60 min *(optional)* | 2 pouches, −90 to −60 min | 2 pouches, −90 to −60 min |
| **Isotonic Drink** | 500 ml, −90 to −60 min | 500 ml, −90 to −60 min | 500 ml, −90 to −60 min |
| **Salt Caps** | no | no | only if >30 °C |
| **Rationale** | glycogen is not limiting over 25 min; the job is topping off liver glycogen and arriving hydrated | as Sprint, but a full pre-load is now clearly worth it | this is the race where pre-race glycogen actually determines the result |

**Enervit's own instructions, verbatim [V]:**
- Pre Sport: *"Take 2 45 g gels 1-2 hours before physical exercise."*
  (enervit.com product page)
- NUTRITION SYSTEM® sheet places Pre Sport at **−60′ and −30′** — two pouches,
  staggered.

The two Enervit sources disagree slightly on timing (1–2 h before, versus −60′
and −30′). The table above uses the −90 to −60 min window as the overlap. Flag
this to the client rather than silently picking one.

**Why Pre Sport rather than a gel.** Its carbohydrate is substantially
isomaltulose (16.2 g/100 g **[V]**), which is digested slowly. Model it with a
flat, sustained blood-sugar curve. A glucose gel taken at the same moment
should produce a visible spike and a subsequent dip. That contrast is the most
teachable single moment available in the mechanic and it costs nothing to
implement.

---

## 3. DURING

### 3.1 The honest position

For a race of 15–35 minutes there is **no physiological case for carbohydrate
intake at all**. Muscle glycogen is nowhere near limiting, and nothing ingested
at the start of a 32-minute race is meaningfully oxidised before the finish.
The only intervention with support at this duration is a **carbohydrate mouth
rinse**, which acts through oral receptors rather than metabolism — Jeukendrup
2014 above **[V]**.

> **[U] — verification gap.** The mouth-rinse protocol specifics (typical 6–8%
> solution, ~5–10 s rinse, repeated every 10–15 min) and the primary
> mouth-rinse literature (Carter, Jeukendrup; Chambers, Gant) were **not**
> retrieved directly. Do not state a concentration or a rinse duration in-game
> until they are.

This is also simply what orienteers do. They carry nothing. Any design that
rewards a Sprint player for carrying three gels is teaching the sport wrong,
and an orienteering audience will notice immediately.

### 3.2 Protocol by format

| | Sprint (~15–25 min) | Middle (~32 min) | Long (~90 min) |
|---|---|---|---|
| **Carried** | nothing | nothing | 0–1 gel, at most |
| **Carbohydrate target** | **0 g** | **0 g** | **~20–40 g total** (≈15–30 g/h) **[U]** |
| **Fluid** | 0 ml | ~100–200 ml at the single station | ~300–500 ml across 5 stations |
| **Sodium** | 0 mg | 0 mg | 0 mg needed under 25 °C; situational above |
| **From the course** | nothing available | 1 station at 63–72% | 5 stations, first at 18–21% |
| **Player's own product** | — | — | coaching zone at spectators' control |

The ~15–30 g/h figure for the Long sits below Enervit's 60 g/h because 60 g/h
is explicitly conditioned on rides *longer than two hours* **[V]**, and above
zero because a 90-minute race at World Cup intensity does draw down liver
glycogen. It is marked **[U]** because the specific 1–2 h band it comes from
belongs to the ACSM position stand that was not retrieved. **Confirm before
shipping this number in any educational overlay.**

**Enervit's own during-race dosing instructions [V]:**
- Isotonic Drink: *"500 ML WITH 2 MEASURING SPOONS PER HOUR ALL ALONG THE
  COURSE"* (NUTRITION SYSTEM®) — i.e. 30 g powder per 500 ml per hour.
- Liquid Gel: *"Take 1-2 Liquid Gels for every hour of physical activity."*
- Competition Bar: *"Take up to 2 bars every hour during intense physical
  exercise."*
- Salt Caps: *"Take 2 capsules with 500 ml of water for each hour of physical
  activity (up to a maximum of 6 capsules a day)."*

Each of these is a per-hour instruction written for multi-hour events. At
orienteering durations the correct in-game quantity is a **fraction** of the
stated dose, and the UI should present it that way.

### 3.3 What is in the cup at Vyšší Brod

Bulletin 4 specifies 15 g of Enervit instant product per 500 ml **[V]** —
half the standard 30 g dose. Working from the verified Isotonic Drink panel:

| | Standard dose (30 g/500 ml) | **Event dose (15 g/500 ml)** |
|---|---|---|
| Carbohydrate | 25 g **[V]** | ~12.6 g **[U]**, derived |
| Sodium | 240 mg **[V]** | ~120 mg **[U]**, derived |
| Energy density | ~202 kcal/l **[U]**, derived | ~101 kcal/l **[U]**, derived |

The halved preparation is the right call for a hot August race — it empties
from the stomach faster and the athletes are not there for the calories. But it
has a claims consequence that the client needs to know about, set out in §7.

---

## 4. AFTER

### 4.1 Single race

**Enervit's own instruction [V]:** R2 Recovery Drink *"within 30 minutes after
intense and prolonged sports activity"*; the NUTRITION SYSTEM® sheet marks the
AFTER slot as **WITHIN 30′**.

| Window | Action | Product |
|---|---|---|
| 0–30 min | carbohydrate + fluid + amino acids | R2 Recovery Drink, 50 g in 350 ml → 41 g carb, 4.4 g "protein", 68 mg sodium **[V]** |
| 0–60 min | rehydrate beyond thirst | water or Isotonic Drink |
| 1–3 h | real meal, carbohydrate-led | — |

> **[U] — verification gap.** The quantitative recovery targets — post-exercise
> carbohydrate in g/kg/h, protein in g/kg per feeding, and the current evidence
> on how wide the so-called anabolic window actually is — come from the ACSM
> position stand and the protein-timing literature, **neither of which was
> retrieved directly**. The 30-minute figure above is Enervit's own
> instruction, not an independent finding, and should be presented as such.

**An important honesty note on R2.** Its declared 4.4 g of "protein" is free
amino acids (leucine 4.9%, isoleucine 2.4%, valine 2.4%, glutamine 2% **[V]**),
not intact protein, and 4.4 g is a small dose by any recovery standard. If the
design wants a genuine carbohydrate-plus-protein recovery story it should pair
R2 with a real protein SKU rather than overstate R2 alone. Enervit's own page
carries *"Contributes to the recovery of muscle function"*, which is the
authorised **carbohydrate** claim — not a protein claim. That distinction is
load-bearing; see `CLAIMS_TO_REVIEW.md`.

### 4.2 Multi-day — this is career mode

The real competition week is the career-mode structure, and it is unusually
well shaped for a game:

| Day | Race | Recovery pressure |
|---|---|---|
| Wed 5 Aug | Qualification (50 min) + Sprint Prologue | moderate — two efforts in one day |
| Thu 6 Aug | **Long, 90 min** | **highest single drain of the week** |
| Fri 7 Aug | Free day | the one real repair window |
| Sat 8 Aug | Middle, 32 min | short but maximal |
| Sun 9 Aug | Relay, 30 min | tightest turnaround — 1 day after Middle |

The mechanic writes itself: `CareerProgress.carryOver` (already in
`src/core/types.ts`) is set by the recovery phase, and Thursday's Long is the
day that punishes a player who skipped Wednesday's recovery. The Friday free
day should be the moment a well-fuelled player visibly recovers and a careless
one does not.

> **[U] — verification gap.** Glycogen resynthesis rates across *consecutive
> competition days* were **not** retrieved from the literature. The carry-over
> curve is currently a design choice, not an evidence-based model. Either get
> the literature or present the carry-over in-game as a game mechanic rather
> than as a physiological claim. Do not label it with a number of hours or a
> percentage that we cannot source.

---

## 5. SKU → phase → timing → contents → stat

Numbers per single serving. **[V]/[U]** as defined above; full provenance for
every row is in `ENERVIT_SKU_MAP.json` under `sourceNote`.

| SKU | Phase | Timing | Carb g | Na mg | Caff mg | Primary stat | Secondary |
|---|---|---|---|---|---|---|---|
| Pre Sport Jelly | before | −90 to −60 min | 25.6 **[U]** | 108 **[U]** | 0 | glycogen | bloodSugar, flat curve |
| Isotonic Drink | before/during | −60 min; then per station | 25 **[V]** | 240 **[V]** | 0 | **hydration** | glycogen |
| Isocarb | during | Long only, pre-mixed bottle | 60 **[V]** | 240 **[V]** | 0 | glycogen | hydration (reduced) |
| Enervit Gel | during | Long, one only | 20 **[V]** | 10 **[V]** | 0 / 20 **[V]** | bloodSugar | hydration (negative) |
| Carbo Gel C2:1 | during | Long, one only | 40 **[V]** | — | 0 / 100 **[V]** | bloodSugar | glycogen, focus |
| Liquid Gel | during | Long | 30 **[V]** | — | — | glycogen | bloodSugar |
| Isotonic Gel | during | Long | 20 **[U]** | — | — | bloodSugar | hydration (neutral) |
| Carbo Jelly | during | Long | 30 **[V]** | 52 **[V]** | 0 | bloodSugar | — |
| Carbo Chews | during | Long, divisible | 30 **[V]** | 0 **[V]** | 0 | bloodSugar | glycogen |
| Carbo Bar Peanut | during | Long, early | 33 **[V]** | 204 **[V]** | 0 | glycogen | hydration (negative) |
| Carbo Bar Brownie | during | Long, early | 33.3 **[V]** | 7.2 **[V]** | 0 | glycogen | hydration (negative) |
| Competition Bar | during | Long, early | 20 **[U]** | — | 0 | glycogen | hydration (negative) |
| Salt Caps | during | only if >30 °C | 0 **[V]** | 300 **[U]** | 0 | **hydration** | — |
| R2 Recovery Drink | after | within 30 min | 41 **[V]** | 68 **[V]** | 0 | **glycogen carry-over** | hydration |
| 100% Whey Protein | after | with/after R2 | — | — | 0 | *(blocked — no data)* | — |
| Magic Cherry | after | evening | — | — | 0 | **none — see below** | — |
| Magnesium | after | evening | — | — | 0 | *(blocked — no dose)* | — |

**Three rows need decisions before implementation, not after:**

1. **Magic Cherry** is deliberately given no stat effect. Its actives are tart
   cherry polyphenols and anthocyanins, which have **no authorised EU health
   claim**, and its only claimable nutrient is vitamin E, whose authorised claim
   is about oxidative stress and is *not* a recovery claim. Giving it a
   recovery boost in-game would be an implied health claim with nothing behind
   it. It is commercially popular in CZ/SK, so expect pressure — escalate
   rather than absorb it.
2. **Magnesium** is blocked on its per-sachet dose. Magnesium has several
   authorised claims but all are conditional on supplying ≥15% NRV
   (56.25 mg) per serving, and we do not know whether it does.
3. **100% Whey Protein** is blocked on all nutrition data. It is the only SKU
   that could legitimately carry the authorised protein claims, so it is worth
   obtaining.

---

## 6. Stat model notes

- **glycogen** — the slow tank. Set pre-race by BEFORE and by
  `carryOver`; depleted by distance, climb and terrain roughness. Empty ⇒ the
  hard speed cap already specified in `types.ts`.
- **hydration** — driven by fluid volume, ambient temperature and race
  duration. Should be nearly irrelevant on a cool Sprint and genuinely decisive
  on a 30 °C Long. Concentrated gels taken without water should *cost*
  hydration; that is real, and it teaches the right lesson.
- **bloodSugar** — fast, spiky, and the only stat that responds within a Sprint.
  Its job in the design is to make the spike-and-crash of a badly timed glucose
  gel legible against the flat curve of Pre Sport's isomaltulose.
- **focus** — degrades navigation only, never raw speed, per `types.ts`. This
  is the most orienteering-specific stat and the best reason the game exists.

> **[U] — verification gap, and the most consequential one.** The intended link
> from **blood glucose to navigational error** — the mechanic that makes this an
> *orienteering* game rather than a running game — was **not** substantiated in
> this research pass. No orienteering-specific nutrition or cognition
> literature was retrieved, and no study linking glycaemic state to
> decision-making under navigational load was verified. Treat the focus↔blood
> sugar coupling as a **game design conceit** and do not present it in-game as
> a physiological fact until it is sourced. Cosmetically it is fine; as an
> educational claim it is not yet earned.

---

## 7. Compliance flags arising from this protocol

Full treatment in `CLAIMS_TO_REVIEW.md`. Three findings originate here and are
significant enough to state twice.

1. **Isotonic Drink at the standard 30 g/500 ml dose appears to be the only SKU
   in the range that meets the EU conditions for carbohydrate-electrolyte
   solution claims.** Its verified panel gives 480 mg/l sodium, 270 mOsm/kg
   osmolality, ~202 kcal/l, ~99% of energy from carbohydrate. That combination
   is what those claims require. It makes this SKU the compliance backbone of
   the entire game — it is the one product we can attach authorised wording to
   verbatim.
2. **The event's own half-strength preparation probably breaks that.** At 15 g
   per 500 ml the sodium falls to ~240 mg/l and the osmolality roughly halves.
   On the thresholds as understood, that is below the authorised range on both
   counts **[U — thresholds pending confirmation]**. So the claim may travel
   with the tub but *not* with the cup handed out at Martínkov. If any in-game
   or on-site copy attaches a claim to the course refreshment, that is a
   problem worth catching now.
3. **Isocarb cannot carry those claims** at any preparation: 60 g carbohydrate
   in 500 ml is ~488 kcal/l, well above the ceiling. It is an excellent
   product; it is simply not a carbohydrate-electrolyte solution in the
   regulatory sense.

---

## 8. Consolidated verification gaps

Everything this document could not verify, in one place, so it can be closed
out deliberately.

| # | Gap | Blocks | How to close |
|---|---|---|---|
| 1 | ACSM/AND/DC 2016 position stand not retrieved | pre-race g/kg, the 1–2 h carb band, recovery g/kg/h, protein g/kg | fetch the position stand directly |
| 2 | Mouth-rinse protocol specifics unverified | any in-game mouth-rinse mechanic or copy | fetch Carter/Jeukendrup and Chambers/Gant |
| 3 | Multi-day glycogen resynthesis unverified | the career-mode carry-over curve | literature, or present carry-over as game mechanic only |
| 4 | No orienteering-specific cognition literature | the focus↔bloodSugar coupling as *fact* | literature search; until then it is a conceit |
| 5 | Sodium requirement for <90 min in temperate conditions unverified | how strongly to gate Salt Caps | literature; current design treats it as heat-only |
| 6 | Czech product names not yet obtained | `nameCz` throughout the SKU map, and all CZ UI copy | enervit.cz / Vitar Sport shop |
| 7 | Exact EU claim thresholds pending | §7 conclusions 1 and 2 | `CLAIMS_TO_REVIEW.md` |
| 8 | Competition Bar per-bar figures internally inconsistent at source | that SKU's carb number | confirm bar weight against the physical pack |
| 9 | Isotonic Gel, Magnesium, 100% Whey, Pre Sport Cola: no panel data | those SKUs' stats | pack panels via the client |
| 10 | Caffeine content of Gel Cola and Pre Sport Cola unknown | their focus contribution | pack panels via the client |

**Client-side route to close most of these.** The internal record shows Vitar
Sport already has an established process for exactly this: nutrition content is
validated with Enervit before publication, and Enervit provides a nutrition
specialist (Simone Bisello/Buscello, "Equipe Enervit") for precisely this
purpose. Gaps 8–10 are a single email to that contact. Gap 6 is a Vitar Sport
internal lookup. Route them there rather than guessing.
