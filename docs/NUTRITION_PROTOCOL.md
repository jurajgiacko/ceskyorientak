# Nutrition Protocol

The implementation spec for the Enervit before/during/after mechanic.

**Companion documents.** `CLAIMS_TO_REVIEW.md` governs what any of this may be
*called* in player-facing copy. `ENERVIT_SKU_MAP.json` is the machine-readable
product data; every number in the tables below traces back to it. The four
stats — `glycogen`, `hydration`, `bloodSugar`, `focus` — are defined in
`src/core/types.ts` as `AthleteStats`.

**Sourcing rule used throughout.** A figure is marked **[V]** when it was read
off a primary source: an Enervit packaging panel, an Enervit-published page, the
official event Bulletin 4, or a paper fetched directly. It is **[U]** when it is
derived, inferred, or came from a secondary source. No number here was invented.
Where a source is silent, the document says so rather than filling the gap.
§9 lists every open gap in one table.

---

## 0. The one thing that must not be got wrong

Almost every sports-nutrition protocol in circulation — including Enervit's own
event fuelling plans — is written for events lasting **three to seven hours**.
Orienteering races last **15 to 100 minutes**. Copying a gran fondo protocol
into this game would produce something simultaneously unrealistic, bad as
advice, and off-brand for a sport whose athletes are famous for carrying
nothing.

**Enervit's own published guidance agrees with us, and that is the single most
useful fact in this document.** From Enervit's running nutrition page **[V]**:

- **Under 60 minutes: carbohydrate intake is "typically unnecessary if glycogen
  properly loaded".**
- **"Short races: typically no mid-race drinking needed."**
- 60+ minutes: 30–60 g carbohydrate "around halfway point".
- 2+ hours: 30–60 g/h from the start.

And from the NUTRITION SYSTEM® event sheet **[V]**:

> "FOR RIDES LONGER THAN 2 HOURS, IT IS ADVISABLE TO HAVE A CARBOHYDRATE INTAKE
> OF APPROXIMATELY 60g FOR EVERY HOUR."

Note *longer than two hours*. No World Cup orienteering race at Vyšší Brod comes
close. The 60 g/h figure — the number everyone reaches for — is **out of scope
for every race in this game**, and a player chasing it should be making a
mistake, not optimising.

This is a feature. A game where the correct answer is sometimes "take nothing"
is more interesting, more truthful, and far more defensible to a regulator than
one where more product is always better. It also happens to be what Enervit
itself publishes.

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

Three further details from Bulletin 4 that the mechanic should use:

- **What is actually in the cups [V].** §11.14: *"Refreshment points within
  courses will offer water (transparent cups) and ENERVIT Isotonic Drink
  (branded cups) – sport drink prepared as hypotonic (15 grams of Enervit
  instant product per 500 ml of water)."* Note **15 g**, not the standard 30 g
  dose — deliberately half-strength. This changes both the in-game numbers and
  the claims position. See §3.3 and §8.
- **Heat [V].** *"The weather forecast is 30+°C for the first days in August"*,
  and above 30 °C *"additional water refreshment stations will be added to the
  courses"*. Heat is the one condition under which hydration and sodium stop
  being decorative, so it belongs in the game as a per-race modifier.
- **Coaching zone [V].** At Long and Relay only, near the spectators' control,
  coaches *"can hand out personal refreshments"*. This is the sanctioned route
  by which a player's own chosen product reaches them mid-race, and it maps
  cleanly onto a loadout slot.

**Design consequence.** The Sprint has no feed station and no realistic chance
to carry or consume anything. The Middle has exactly one, late. Only the Long
has a genuine in-race fuelling problem. Three formats, three different
mechanics — not one mechanic scaled.

---

## 2. BEFORE

Because in-race intake is near-zero for two of the three formats, **the BEFORE
phase carries most of the game's nutrition decision-making**. This is where the
design should invest.

### 2.1 Enervit's own numbers

All **[V]**, from Enervit's running nutrition page unless noted:

| When | What |
|---|---|
| 2–3 days out | **5–10 g carbohydrate per kg body weight per day** (loading) |
| Race morning | breakfast **2–4 g carbohydrate per kg body weight** |
| Race morning | **500 ml electrolyte drink with sodium** |
| −1 h | **20–30 g fast-digesting carbohydrate** |
| Caffeine | **3–6 mg/kg**, max **400 mg/day**; for short races, take before the start |

### 2.2 The Pre Sport timing problem

Enervit publishes **three mutually incompatible timings** for the same product
**[V]**:

| Source | Timing |
|---|---|
| enervit.com product page | *"Take 2 45 g gels 1-2 hours before physical exercise."* |
| NUTRITION SYSTEM® event sheet | **−60′ and −30′**, two pouches staggered |
| Enervit-supplied time-trial protocol | **15 minutes before start** |

These cannot all be right. The table below uses the **−90 to −60 min** window as
the most defensible overlap, but this is a genuine open question and should be
put to the client rather than silently resolved. The Czech-language guidance
adds a fourth position: *"1–2 hours before"*, and then **nothing sweet in the
final hour** — *"pít čistou vodu, případně s citronem"* — on the stated rationale
that high insulin *"zamezí využití tuku jako zdroje energie"*. That
rebound-hypoglycaemia rationale is asserted by Enervit as fact; **[U]** we could
not verify it, and current consensus may run against it. Do not repeat it
in-game either way until it is checked.

### 2.3 Protocol by format

| | Sprint (~15–25 min) | Middle (~32 min) | Long (~90 min) |
|---|---|---|---|
| **Meal, 3 h out** | 2–4 g/kg carbohydrate, low fibre **[V]** | same | same |
| **Pre Sport Jelly** | 1 pouch, −60 min *(optional)* | 2 pouches, −90 to −60 min | 2 pouches, −90 to −60 min |
| **Isotonic Drink** | 500 ml, −90 to −60 min **[V]** | 500 ml, −90 to −60 min | 500 ml, −90 to −60 min |
| **Salt Caps** | no | no | only if >30 °C |
| **Rationale** | glycogen is not limiting over 25 min; the job is arriving hydrated with liver glycogen topped off | as Sprint, but a full pre-load is clearly worth it | the only race where pre-race glycogen genuinely determines the result |

**Why Pre Sport rather than a gel.** Its carbohydrate is substantially
isomaltulose (16.2 g/100 g **[V]**), digested slowly; the Czech site positions it
as *"sacharidové želé (pevná konzistence) s nízkým glykemickým indexem"* **[V]**.
Model it with a flat, sustained blood-sugar curve. A glucose gel taken at the
same moment should produce a visible spike and a subsequent dip. That contrast
is the most teachable single moment available in the mechanic and it costs
nothing to implement.

---

## 3. DURING

### 3.1 The honest position, and the evidence for it

For a race of 15–35 minutes there is **no physiological case for carbohydrate
intake at all**, and we now have direct experimental evidence rather than
inference.

**Carter JM, Jeukendrup AE, Mann CH, Jones DA.** *"The effect of glucose infusion
on glucose kinetics during a 1-h time trial."* Med Sci Sports Exerc
2004;36(9):1543–1550. PMID 15354036 **[V]**. Six endurance cyclists; glucose
infused **intravenously at 1 g/min** versus saline placebo during a one-hour
time trial. Infusing glucose straight into the bloodstream — bypassing mouth and
gut entirely — **did not improve performance**. Endogenous carbohydrate stores
are simply not limiting over an hour.

The corollary, from Jeukendrup AE, *"A Step Towards Personalized Sports
Nutrition: Carbohydrate Intake During Exercise"*, Sports Med 2014 (PMC4008807)
**[V]** — where carbohydrate does help at around an hour:

> "a mouth rinse or small amounts of carbohydrate can result in a performance
> benefit"

i.e. the mechanism is oral/central, not metabolic.

> **[U] — verification gap.** The mouth-rinse protocol specifics (typical 6–8%
> solution, ~5–10 s rinse, repeated every 10–15 min) were **not** retrieved, and
> the primary mouth-rinse literature (Carter 2004 MSSE 36(12):2107–11; Chambers
> 2009 J Physiol 587(8):1779–94) was **not** verified. Do not state a
> concentration or a rinse duration in-game until they are.

This is also simply what orienteers do: they carry nothing. Any design
rewarding a Sprint player for carrying three gels teaches the sport wrong, and
an orienteering audience will notice immediately.

### 3.2 C2:1 does not apply to these races

The C2:1 PRO range is marketed for **beyond 60 g/h and up to 90 g/h and more**
**[V]**, and the underlying science is real — but it is scoped. From
Jeukendrup's GSSI review SSE-108 **[V]**, verbatim: multiple transportable
carbohydrates are beneficial

> "during endurance sports where the duration of exercise is 2.5 h or more."

The flagship supporting trial — **Currell K, Jeukendrup AE**, *"Superior
endurance performance with ingestion of multiple transportable carbohydrates"*,
Med Sci Sports Exerc 2008;40(2):275–281, PMID 18202575 **[V]** — used a
**~3-hour protocol** (120 min at 55% Wmax then a ~1 h time trial) and found the
2:1 glucose–fructose drink 8% quicker than glucose alone. Excellent evidence;
none of it about a 32-minute race.

The mechanism, from SSE-108 **[V]**: glucose alone oxidises at ~0.8 g/min
(~48 g/h) because SGLT1 *"saturates when glucose intake is around 60 g/h"*;
fructose enters via GLUT5, sodium-independent, adding ~30 g/h.

**Implication.** For Sprint and Middle the defensible Enervit products are the
*before* and *after* ones — Pre Sport, and R2/After Sport — not the during-race
C2:1 range. Only the Long begins to justify in-race carbohydrate, and then at
Enervit's own 30–60 g/h band, not 90. **The game must not imply C2:1 or
90 g/h fuelling for Sprint or Middle.** It would be scientifically wrong and
inconsistent with Enervit's own running guidance — easy for a knowledgeable
orienteer to catch, and exactly the kind of overreach `CLAIMS_TO_REVIEW.md`
exists to prevent.

### 3.3 Protocol by format

| | Sprint (~15–25 min) | Middle (~32 min) | Long (~90 min) |
|---|---|---|---|
| **Carried** | nothing | nothing | 0–1 gel, at most |
| **Carbohydrate target** | **0 g** | **0 g** | **~30 g total** ("around halfway") **[V]** |
| **Fluid** | 0 ml | ~100–200 ml at the single station | ~300–500 ml across 5 stations |
| **Sodium** | 0 mg | 0 mg | 0 mg needed under 25 °C; situational above |
| **From the course** | nothing available | 1 station at 63–72% | 5 stations, first at 18–21% |
| **Player's own product** | — | — | coaching zone at spectators' control |

The Long figure is Enervit's own **[V]**: *60+ minutes — 30–60 g carbohydrate
"around halfway point"*. At 90 minutes the lower end of that band is right, and
the course conveniently puts refreshments at 63% and 78%.

**Enervit's own during-race dosing instructions [V]**, every one of them written
per hour for multi-hour events:

- Isotonic Drink: *"500 ML WITH 2 MEASURING SPOONS PER HOUR ALL ALONG THE
  COURSE"* (NUTRITION SYSTEM®)
- Liquid Gel: *"Take 1-2 Liquid Gels for every hour of physical activity."*
- Competition Bar: *"Take up to 2 bars every hour during intense physical
  exercise."*
- Salt Caps: *"Take 2 capsules with 500 ml of water for each hour of physical
  activity"* — max 6/day per enervit.com, **max 8/day per retailer listings;
  the two conflict [U]**.

At orienteering durations the correct in-game quantity is a **fraction** of each
stated dose, and the UI should present it that way.

### 3.4 What is actually in the cup at Vyšší Brod

Bulletin 4 specifies 15 g of Enervit instant product per 500 ml **[V]** — half
the standard dose. Working from the verified Isotonic Drink panel:

| | Standard dose (30 g/500 ml) | **Event dose (15 g/500 ml)** |
|---|---|---|
| Carbohydrate | 25 g **[V]** | ~12.6 g **[U]**, derived |
| Sodium | 240 mg **[V]** | ~120 mg **[U]**, derived |
| Energy density | ~202 kcal/l **[U]**, derived | ~101 kcal/l **[U]**, derived |

Halving it is the right call for a hot August race — faster gastric emptying,
and the athletes are not there for the calories. But it has a claims
consequence set out in §8.

---

## 4. AFTER

### 4.1 Single race

**Enervit's own instruction [V]:** R2 Recovery Drink *"within 30 minutes after
intense and prolonged sports activity"*; the NUTRITION SYSTEM® sheet marks the
AFTER slot **WITHIN 30′**. The Czech guidance adds: After Sport Drink within
30–60 min, then *"do 60 minut po skončení tréninku by mělo následovat lehké
převážně sacharidové jídlo"* **[V]**.

| Window | Action | Product |
|---|---|---|
| 0–30 min | carbohydrate + fluid + amino acids | R2 Recovery Drink, 50 g in 350 ml → 41 g carb, 4.4 g "protein", 68 mg sodium **[V]** |
| 0–60 min | rehydrate beyond thirst | water or Isotonic Drink |
| 1–3 h | real meal, carbohydrate-led | — |

> **[U] — verification gap.** The quantitative recovery targets — post-exercise
> carbohydrate in g/kg/h, protein in g/kg per feeding, and the current evidence
> on how wide the "anabolic window" actually is — come from the ACSM/AND/DC 2016
> position stand and the protein-timing literature, **neither retrieved**. The
> 30-minute figure above is Enervit's own instruction, not an independent
> finding, and should be presented as such.

**An honesty note on R2.** Its declared 4.4 g of "protein" is free amino acids
(leucine 4.9%, isoleucine 2.4%, valine 2.4%, glutamine 2% **[V]**), not intact
protein, and 4.4 g is small by any recovery standard — a carbohydrate-to-protein
ratio near 10:1. If the design wants a genuine carb+protein recovery story it
should pair R2 with a real protein SKU rather than overstate R2 alone. Enervit's
own page carries *"Contributes to the recovery of muscle function"*, which is the
authorised **carbohydrate** claim, not a protein claim. That distinction is
load-bearing; see `CLAIMS_TO_REVIEW.md`.

### 4.2 Multi-day — this is career mode

The real competition week is the career-mode structure, and it is unusually well
shaped for a game:

| Day | Race | Recovery pressure |
|---|---|---|
| Wed 5 Aug | Qualification (50 min) + Sprint Prologue | moderate — two efforts in one day |
| Thu 6 Aug | **Long, 90 min** | **highest single drain of the week** |
| Fri 7 Aug | Free day | the one real repair window |
| Sat 8 Aug | Middle, 32 min | short but maximal |
| Sun 9 Aug | Relay, 30 min | tightest turnaround — one day after Middle |

`CareerProgress.carryOver` (already in `src/core/types.ts`) is set by the
recovery phase. Thursday's Long punishes a player who skipped Wednesday's
recovery; the Friday free day is where a well-fuelled player visibly recovers
and a careless one does not.

> **[U] — verification gap, and a live contradiction.** Glycogen resynthesis
> across *consecutive competition days* was **not** retrieved from the
> literature. The only figure available is an Enervit CZ marketing claim: that a
> normal diet does **not** restore glycogen within 48 h, and low-carbohydrate
> diets take 3–4+ days. If true that would have large consequences for this
> mechanic — which is exactly why it must be verified before being built on.
> Until then, present carry-over as a **game mechanic**, not as physiology, and
> attach no hour or percentage figure we cannot source.

---

## 5. SKU → phase → timing → contents → stat

Per single serving. Full provenance for every row is in `ENERVIT_SKU_MAP.json`
under `sourceNote`.

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
   concerns oxidative stress and is *not* a recovery claim. Giving it a recovery
   boost would be an implied health claim with nothing behind it. It is
   commercially popular in CZ/SK, so expect pressure — escalate rather than
   absorb it.
2. **Magnesium** is blocked on its per-sachet dose. Magnesium carries several
   authorised claims but all are conditional on supplying ≥15% NRV (56.25 mg)
   per serving, and we do not know whether it does. Note also that CZ lists
   *two* distinct SKUs (`Magnesium Sport` and `Magnesio Potassio Sport`).
3. **100% Whey Protein** is blocked on all nutrition data. It is the only SKU
   that could legitimately carry the authorised protein claims, so it is worth
   obtaining.

---

## 6. Stat model notes

- **glycogen** — the slow tank. Set pre-race by BEFORE and by `carryOver`;
  depleted by distance, climb and terrain roughness. Empty ⇒ the hard speed cap
  already specified in `types.ts`.
- **hydration** — driven by fluid volume, ambient temperature and duration.
  Nearly irrelevant on a cool Sprint; genuinely decisive on a 30 °C Long.
  Concentrated gels taken without water should *cost* hydration — that is real,
  and it teaches the right lesson.
- **bloodSugar** — fast and spiky. Its job is to make the spike-and-crash of a
  badly timed glucose gel legible against the flat curve of Pre Sport's
  isomaltulose. **But see the warning below about which races it may drive.**
- **focus** — degrades navigation only, never raw speed, per `types.ts`. The most
  orienteering-specific stat and the best reason the game exists.

### 6.1 The blood-sugar → navigation link needs rescoping

This is the most consequential research finding for the design.

The intended mechanic — blood glucose falling during a race and causing
navigational errors — **is not physiologically defensible for Sprint (~15–25
min) or Middle (~32 min)**, and is weak even at 60 minutes. Carter et al. 2004
**[V]** showed that infusing glucose intravenously during a one-hour time trial
does not improve performance, because carbohydrate availability is not limiting
at that duration. In a fed athlete over these durations, blood glucose is well
defended: it does not fall, and may rise.

**Recommended rescoping:**

| Format | Honest model |
|---|---|
| Sprint, Middle | **"You race the state you arrived in."** No within-race blood-sugar drain. Pre-race state — glycogen loaded or not, fed or fasted, hydrated, caffeine on board — sets `focus` at the start line and it decays only with accumulated fatigue and terrain difficulty. |
| Long (~90 min) | A genuine within-race depletion curve becomes defensible, and the five feed stations become a real decision. |
| Career week | Residual glycogen debt across days is the strongest and most defensible channel of all. |

This is a better game as well as better science: it makes the BEFORE phase
consequential for every format instead of a formality, and it reserves the
dramatic in-race collapse for the one race where it is real.

> **[U] — verification gap.** No orienteering-specific nutrition or cognition
> literature was retrieved, and no study linking glycaemic state to
> decision-making under navigational load was verified. Even in the rescoped
> form, the focus↔bloodSugar coupling remains a **game design conceit**.
> Cosmetically that is fine; presenting it in-game as physiological fact is not
> yet earned.

---

## 7. Two contradictions inside Enervit's own material

Both need putting to the client. Neither is ours to resolve.

1. **The Czech distributor's educational content contradicts Enervit global.**
   The Czech recovery article publishes **102 g carbohydrate (60 g glucose +
   42 g fructose) for one hour of intensive training, and 126 g (72 + 54) as a
   maximum threshold** **[V]**. These figures are (a) far above Enervit's own
   English-site guidance of 30–60 g/h under 2–2.5 h, (b) above the 90 g/h
   ceiling the C2:1 range is marketed on, and (c) **not in a 2:1 ratio** —
   60:42 is 1.43:1 and 72:54 is 1.33:1, so they contradict the C2:1 proposition
   itself. Since the game is being built with the distributor, raise it.
2. **Pre Sport timing** — three different published timings, §2.2.

---

## 8. Compliance flags arising from this protocol

Full treatment in `CLAIMS_TO_REVIEW.md`. Three findings originate here.

1. **Isotonic Drink at the standard 30 g/500 ml dose appears to be the only SKU
   in the range meeting the EU conditions for carbohydrate-electrolyte solution
   claims.** Its verified panel gives 480 mg/l sodium, 270 mOsm/kg osmolality,
   ~202 kcal/l, ~99% of energy from carbohydrate. That makes it the compliance
   backbone of the whole game — the one product we can attach authorised
   wording to verbatim.
2. **The event's half-strength preparation probably breaks that.** At 15 g per
   500 ml, sodium falls to ~240 mg/l and osmolality roughly halves — below the
   authorised range on both counts **[U — thresholds confirmed in
   `CLAIMS_TO_REVIEW.md`]**. The claim may travel with the tub but *not* with
   the cup handed out at Martínkov. If any in-game or on-site copy attaches a
   claim to the course refreshment, catch it now.
3. **Isocarb cannot carry those claims** at any preparation: 60 g carbohydrate
   in 500 ml is ~488 kcal/l, well above the ceiling. Excellent product; simply
   not a carbohydrate-electrolyte solution in the regulatory sense.

---

## 9. Consolidated verification gaps

| # | Gap | Blocks | How to close |
|---|---|---|---|
| 1 | ACSM/AND/DC 2016 position stand not retrieved | pre-race g/kg cross-check, recovery g/kg/h, protein g/kg | fetch the position stand directly |
| 2 | Mouth-rinse protocol specifics unverified | any in-game mouth-rinse mechanic or copy | fetch Carter 2004 MSSE 36(12), Chambers 2009 J Physiol 587(8), GSSI SSE-118 |
| 3 | Multi-day glycogen resynthesis unverified; Enervit CZ's "not within 48 h" claim unchecked | the career-mode carry-over curve | literature; until then carry-over is a game mechanic only |
| 4 | No orienteering-specific cognition literature | focus↔bloodSugar as *fact* | literature search; rescoped model in §6.1 holds meanwhile |
| 5 | Sodium requirement for <90 min in temperate conditions unverified | how strongly to gate Salt Caps | literature; current design treats it as heat-only |
| 6 | Rebound-hypoglycaemia rationale asserted by Enervit CZ, unverified | the "nothing sweet in the last hour" rule | literature |
| 7 | Competition Bar per-bar figures internally inconsistent at source | that SKU's carb number | confirm bar weight against the physical pack |
| 8 | Isotonic Gel, Magnesium, 100% Whey, Pre Sport Cola: no panel data | those SKUs' stats | pack panels via the client |
| 9 | Caffeine content of Gel Cola and Pre Sport Cola unknown | their focus contribution | pack panels via the client |
| 10 | Salt Caps max daily dose: 6/day (enervit.com) vs 8/day (retailers) | the safety cap in career mode | client |
| 11 | CZ naming: Competition Bar vs Power Sport Competition; four overlapping recovery names; no CZ listing for Carbo Bar peanut / no-flavour | `nameCz`, CZ UI copy | distributor lookup |

**Route to close most of these.** The internal record shows Vitar Sport already
has a process for exactly this: nutrition content is validated with Enervit
before publication, and Enervit provides a nutrition specialist (Simone
Bisello/Buscello, "Equipe Enervit") for the purpose. Gaps 7–11 are a single
email to that contact. Gaps 1–6 need a literature pass with a fresh web-search
budget.

**One commercial note worth surfacing.** Enervit CZ already sponsors an
orienteer — **Miloš Nykodým**, listed as *"Mistr ČR v orientačním běhu"* on
enervit.cz. For a game about orienteering built with the Enervit CZ/SK
distributor, that is an obvious and cheap authenticity asset.
