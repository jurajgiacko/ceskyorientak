# Claims to Review

EU nutrition and health claims compliance for the Enervit mechanic.
Regulation **(EC) No 1924/2006**, Commission Regulation **(EU) No 432/2012** and
its amendments, and Regulation **(EU) No 1169/2011**.

**This document governs every word and every mechanic in the game that touches a
product.** `NUTRITION_PROTOCOL.md` says what is true; this says what may be
said. Where they conflict, this wins.

**Status: research complete, client sign-off NOT obtained.** Nothing here is
legal advice. The green list is a shortlist of wordings that appear usable; it
still needs the client's regulatory contact to confirm before it ships.

---

## 0. Why a browser game is caught by food law

This is not a borderline case, and it is worth being blunt about it because the
instinct is always "it's only a game".

**Article 1(2) [verbatim]** — the Regulation applies to claims

> "made in commercial communications, whether in the labelling, presentation or
> advertising of foods to be delivered as such to the final consumer."

**Article 2(2)(1), definition of "claim" [verbatim]** —

> "any message or representation, which is not mandatory under Community or
> national legislation, **including pictorial, graphic or symbolic
> representation, in any form**, which states, suggests or implies that a food
> has particular characteristics"

Four independent confirmations that this game is in scope:

1. **"In any form"** and **"pictorial, graphic or symbolic"**. A stat bar that
   refills when the avatar consumes a named Enervit product *is* a symbolic
   health claim. Our core mechanic is, legally, a claim.
2. **The Member States' flexibility guidance says so [verbatim]:** "The same
   principles should be respected whenever authorised claims are used in
   commercial communications whether in labelling, presentation or advertising
   and **in whatever medium including on websites**, radio and television."
3. **CJEU C-19/15 *Innova Vital* (14 July 2016)** held that commercial
   communication covers "a communication made in the form of advertising foods,
   designed to promote, **directly or indirectly**, those foods", and that the
   Regulation "does not include any details on the addressee". A branded game
   promoting Enervit indirectly is squarely in scope.
4. **Czech enforcement has already reached this fact pattern.** SZPI fined
   Selltime s.r.o. 30 000 Kč for **an article on the company's own website**,
   and fined AZ Corporation 10 000 Kč because **an e-shop tab was named**
   "COVID-19 – Tipy a rady" — the navigation label itself was the claim. Menu
   items, level names and screen titles in our game are claims.

**There is no sports-nutrition exemption.** Commission report **COM(2016) 402
final** on food intended for sportspeople concluded [verbatim]: *"there is no
necessity for specific provisions for food intended for sportspeople."* The old
PARNUTS sports category was not carried into Regulation (EU) No 609/2013.
Enervit gels get the same claims treatment as a yoghurt.

**Both Vitar Sport and whoever publishes the game are liable.** Czech law
separates the *zadavatel* (advertiser, § 8a(2) of zák. č. 40/1995 Sb.) from the
*šiřitel* (disseminator, § 8a(1)(r)); SZPI has prosecuted the same company in
both capacities simultaneously.

---

## 1. How to read this document

| Marker | Meaning |
|---|---|
| **[P-VERBATIM]** | Quoted word-for-word from an EU primary source that was retrieved and read |
| **[P-CONDENSED]** | From a primary source but summarised in retrieval — **re-check character-for-character before pasting** |
| **[DERIVED]** | Our own arithmetic against a verified pack panel — shown so it can be checked |
| **[UNVERIFIED]** | Could not reach a primary source |

**The single most important operational rule:** claim strings must be taken from
the **Czech and Slovak official Official Journal language versions**, never
translated from English. See §6.2. Everything below is in English because that
is the language of the source; **none of it is shippable CZ/SK copy yet**.

---

## 2. GREEN LIST — wordings we can use

Usable **verbatim**, subject to the stated conditions and to client sign-off.

### 2.1 Carbohydrate-electrolyte solutions — the two claims that matter most

Reg. (EU) 432/2012, Annex. EFSA Journal **2011;9(6):2211**. **[P-VERBATIM]**

> **"Carbohydrate-electrolyte solutions contribute to the maintenance of
> endurance performance during prolonged endurance exercise"**

> **"Carbohydrate-electrolyte solutions enhance the absorption of water during
> physical exercise"**

**Conditions of use — identical for both, verbatim:**

> "In order to bear the claim carbohydrate-electrolyte solutions should contain
> 80-350 kcal/L from carbohydrates, and at least 75 % of the energy should be
> derived from carbohydrates which induce a high glycaemic response, such as
> glucose, glucose polymers and sucrose. In addition, these beverages should
> contain between 20 mmol/L (460 mg/L) and 50 mmol/L (1,150 mg/L) of sodium, and
> have an osmolality between 200-330 mOsm/kg water."

**These two claims are unusual and valuable**, because the authorised "nutrient"
is the *food category itself*. For every other claim in this document you must
name the nutrient, not the product (§6.3). Here, a qualifying drink may bear the
claim as worded.

#### Which Enervit products actually qualify

The conditions are a **composition gate**. A gel, bar, chew or capsule can never
qualify — only a solution meeting all four parameters.

| Product / preparation | kcal/l from CHO | ≥75% energy from high-GI CHO | Sodium | Osmolality | **Verdict** |
|---|---|---|---|---|---|
| **Isotonic Drink, standard 30 g/500 ml** | ~200 **[DERIVED]** ✅ | ~86% **[DERIVED]** ✅ | **480 mg/l [P-VERBATIM from pack]** ✅ | **270 mOsm/kg [P-VERBATIM from pack]** ✅ | ✅ **QUALIFIES** |
| **Isotonic Drink, event 15 g/500 ml** (Bulletin 4) | ~101 **[DERIVED]** ✅ | ~86% ✅ | ~240 mg/l **[DERIVED]** ❌ | ~135 mOsm/kg **[DERIVED]** ❌ | ❌ **FAILS** on sodium and osmolality |
| **Isocarb, 65 g/500 ml** | ~480 **[DERIVED]** ❌ | ✅ | 480 mg/l ✅ | not stated | ❌ **FAILS** — energy density above the 350 ceiling |
| All gels, bars, chews, jellies, Salt Caps | — | — | — | — | ❌ **Not solutions** |

**Three consequences the client needs to hear:**

1. **Isotonic Drink at the standard dose is the compliance backbone of the whole
   game.** It is the only SKU that can carry a genuine performance-related
   claim, and the claim is precisely about endurance performance and water
   absorption — exactly what the mechanic is about. Build the educational layer
   around this product.
2. **The margin on sodium is 4%.** 480 mg/l against a 460 mg/l floor. Any
   dilution, reformulation or measuring-spoon change breaks the claim. Flag this
   as a standing risk to the client, not a one-off check.
3. **The cup handed out at Martínkov does not qualify.** Bulletin 4 §11.14
   specifies 15 g per 500 ml — deliberately hypotonic, which is good practice
   for a hot race and fatal for the claim. **No in-game or on-site copy may
   attach these claims to the course refreshment.** If Vitar Sport is producing
   signage, cups or arena branding for the event, this needs catching now.

### 2.2 Carbohydrates and recovery of muscle function

Commission Regulation **(EU) 2015/7** of 6 January 2015 — *not* 2015/2314.
EFSA Journal **2013;11(10):3409**, EFSA-Q-2013-00234. **[P-VERBATIM]**

> **"Carbohydrates contribute to the recovery of normal muscle function
> (contraction) after highly intensive and/or long-lasting physical exercise
> leading to muscle fatigue and the depletion of glycogen stores in skeletal
> muscle"**

**Conditions of use, verbatim and complete:**

> "The claim may be used only for food which provides carbohydrates which are
> metabolised by humans (excluding polyols). Information shall be given to the
> consumer that the beneficial effect is obtained with the consumption of
> carbohydrates, from all sources, at a total intake of 4 g per kg body weight,
> at doses, within the first 4 hours and no later than 6 hours, following highly
> intensive and/or long-lasting physical exercise leading to muscle fatigue and
> the depletion of glycogen stores in skeletal muscle. The claim may be used
> only for foods intended for adults who have performed highly intensive and/or
> long-lasting physical exercise leading to muscle fatigue and the depletion of
> glycogen stores in skeletal muscle."

**Three mandatory accompanying elements — all three, every time:**

1. the **4 g per kg body weight** total intake **from all sources**;
2. the window: **within the first 4 hours and no later than 6 hours**;
3. the audience restriction: **adults** who performed such exercise.

This is reportedly the most commonly breached sports-nutrition claim in the EU,
and the breach is almost always dropping element 1 or 3 because they are
inconvenient. **Enervit already uses this claim** — the R2 Recovery Drink page
carries "Contributes to the recovery of muscle function". Note that Enervit's
own rendering drops "normal", drops the qualifying clause, and drops all three
conditions. Do not copy Enervit's version; use the authorised text.

**Applies to:** R2 Recovery Drink, Isocarb, all gels, bars, chews, jellies — any
Enervit food providing metabolisable carbohydrate. **Caveat for the game:** the
qualifying phrase "highly intensive and/or long-lasting physical exercise... and
the depletion of glycogen stores" is doing real work. A 15-minute Sprint does
not deplete glycogen stores. Using this claim against a Sprint result would be
misleading under Art. 3(a) even though the product qualifies.

⚠️ **Do not confuse with the carbohydrate/brain-function claim**, which requires
the food to be **LOW SUGARS** or **WITH NO ADDED SUGARS** and may not be used on
food that is 100% sugars **[P-CONDENSED]**. That rules out effectively every
Enervit during-race SKU. Do not reach for a "carbs help you think" line.

### 2.3 Vitamin claims available on Enervit SKUs

All Reg. (EU) 432/2012. Standard condition for every one **[P-VERBATIM]**:

> "The claim may be used only for food which is at least a source of [nutrient]
> as referred to in the claim SOURCE OF [NAME OF VITAMIN/S] AND/OR [NAME OF
> MINERAL/S] as listed in the Annex to Regulation (EC) No 1924/2006."

"Source of" thresholds, per Annex XIII Part A point 2 of Reg. 1169/2011
**[P-CONDENSED]**: **15%** of NRV per 100 g for non-beverages; **7.5%** of NRV
per 100 ml for beverages; **15%** of NRV per portion for single-portion packs.

**Claim wordings [P-VERBATIM]:**

| Nutrient | Authorised wording |
|---|---|
| Thiamine | "Thiamine contributes to normal energy-yielding metabolism" |
| Thiamine | "Thiamine contributes to normal functioning of the nervous system" |
| Niacin | "Niacin contributes to normal energy-yielding metabolism" |
| Niacin | "Niacin contributes to the reduction of tiredness and fatigue" |
| Vitamin B6 | "Vitamin B6 contributes to normal energy-yielding metabolism" |
| Vitamin B6 | "Vitamin B6 contributes to normal protein and glycogen metabolism" |
| Vitamin B6 | "Vitamin B6 contributes to the reduction of tiredness and fatigue" |
| Riboflavin | "Riboflavin contributes to normal energy-yielding metabolism" |
| Riboflavin | "Riboflavin contributes to the reduction of tiredness and fatigue" |
| Pantothenic acid | "Pantothenic acid contributes to normal energy-yielding metabolism" |
| Pantothenic acid | "Pantothenic acid contributes to the reduction of tiredness and fatigue" |
| Vitamin C | "Vitamin C contributes to normal energy-yielding metabolism" |
| Vitamin C | "Vitamin C contributes to the reduction of tiredness and fatigue" |
| Vitamin C | "Vitamin C contributes to the protection of cells from oxidative stress" |
| Vitamin E | "Vitamin E contributes to the protection of cells from oxidative stress" |
| Magnesium | "Magnesium contributes to a reduction of tiredness and fatigue" |
| Magnesium | "Magnesium contributes to electrolyte balance" |
| Magnesium | "Magnesium contributes to normal muscle function" |
| Magnesium | "Magnesium contributes to normal energy-yielding metabolism" |
| Protein | "Protein contributes to a growth in muscle mass" |
| Protein | "Protein contributes to the maintenance of muscle mass" |

⚠️ **Thiamine has NO tiredness-and-fatigue claim.** It has energy metabolism and
nervous system only. Since thiamine is the vitamin Enervit adds to almost
everything, this is an easy and likely mistake. The nutrients that **do** carry
a tiredness/fatigue claim are: magnesium, vitamin B6, niacin, vitamin C, iron,
riboflavin, vitamin B12, pantothenic acid, folate.

⚠️ **Note the exact article:** magnesium is "**a** reduction of tiredness and
fatigue"; the vitamins are "**the** reduction". Reproduce exactly.

#### Product eligibility — computed against verified pack panels

%NRV figures marked [V] are printed on the pack; **[DERIVED]** is our arithmetic.

| Product | Qualifies as "source of" | Therefore may carry |
|---|---|---|
| **Isotonic Drink** (30 g/500 ml) | vit C, thiamine, riboflavin, niacin, pantothenic acid, vit D — pack prints **38% NRV per 30 g dose** [V]; as a prepared beverage ~7.6% per 100 ml **[DERIVED]**, just clearing the 7.5% beverage floor | energy metabolism + **tiredness and fatigue** (via niacin, riboflavin, pantothenic acid, vit C) — **on top of** the two CES claims. The strongest claims position in the range. |
| **R2 Recovery Drink** (50 g single-portion sachet) | vit C 75%, vit E 84%, riboflavin 72%, B6 72%, niacin 63%, thiamine 46% [V] | energy metabolism, **tiredness and fatigue**, oxidative stress — plus the carbohydrates/recovery claim |
| **Salt Caps** (2-capsule dose) | vit C, niacin, pantothenic acid, thiamine, riboflavin, vit D — all **33% NRV** [V] | energy metabolism, **tiredness and fatigue**. **Not** a sodium claim — see §3 |
| **Carbo Bars** (45 g) | thiamine — pack prints **20% per pack** [V] | thiamine energy metabolism only |
| **Enervit Gel** (25 ml) | thiamine, niacin, B6 — ~15% per gel **[DERIVED]** from the 60%-per-100 ml panel | energy metabolism; **tiredness and fatigue** via niacin and B6 |
| **Carbo Gel C2:1** (60 ml) | thiamine ~15.5%, B6 15%, niacin 15% **[DERIVED]** | as Enervit Gel |
| **Carbo Jelly / Chews** | thiamine ~15.5% **[DERIVED]** | thiamine energy metabolism only |
| **Magic Cherry** (9 g sachet) | **vitamin E, 30% NRV per sachet** [V] | **oxidative stress only** — see §4.3 |
| **Magnesium** | ❓ dose unknown | **blocked** until the magnesium per sachet is confirmed |
| **100% Whey Protein** | ❓ no data | **blocked** |

Several of these clear the threshold by a hair — the gels compute to *exactly*
15%. Enervit has evidently formulated to the claim floor. **Any reformulation
silently removes the claim.** Treat every one of these as needing re-checking
against the current pack before launch.

**Enervit's own on-pack precedent [P-VERBATIM, Carbo Bar panel]:** *"è fonte di
tiamina che contribuisce al normale metabolismo energetico"* — "is a source of
thiamine which contributes to normal energy-yielding metabolism". This is
correctly constructed: it names the nutrient, states the "source of" status, and
uses the authorised wording. **Use it as the house pattern.**

### 2.4 Protein — and why R2 cannot carry it

Conditions from the Annex to Reg. 1924/2006 **[P-VERBATIM]**:
**SOURCE OF PROTEIN** = "at least 12 % of the energy value of the food is
provided by protein"; **HIGH PROTEIN** = "at least 20 %".

This is **% of energy**, not % by weight — the usual trap.

**R2 Recovery Drink fails.** 4.4 g protein × 4 kcal = 17.6 kcal against 188 kcal
per dose = **9.4% [DERIVED]**, below the 12% floor. R2 therefore **cannot carry
any protein claim**, which is consistent with Enervit's own page using the
carbohydrate claim instead. Its declared "protein" is free amino acids anyway.

**100% Whey Protein** is the only SKU that could plausibly carry protein
claims — blocked pending data.

### 2.5 Creatine — available but out of scope

> **"Creatine increases physical performance in successive bursts of short-term,
> high intensity exercise"** — Reg. (EU) 432/2012, EFSA **2011;9(7):2303**.
> Conditions: daily intake of **3 g**; the consumer must be told so; foods
> targeting **adults performing high intensity exercise** only. **[P-VERBATIM]**

Not a race-day SKU and not in the game's loadout. Noted for completeness, and
because it is the *only* authorised claim in the entire register that uses the
word "performance" about a supplement — which makes it a magnet for misuse.

---

## 3. RED LIST — never use, in any medium

Each entry is prohibited outright. For most, **no authorisation is possible** —
this is not a "get approval first" list.

### 3.1 Anything about caffeine

**There is no authorised caffeine health claim in the EU. Zero.** Confirmed
against the consolidated text of Reg. (EU) 432/2012 (CELEX
02012R0432-20210517): the Annex contains **no entry for caffeine** at all
**[P-VERBATIM confirmation of absence]**.

The history matters, because it explains why this will not change soon:

- EFSA issued **positive** conclusions for caffeine on alertness, attention and
  concentration, endurance performance and capacity, and reduction in perceived
  exertion (EFSA Journal 2011;9(4):2053 and 2054) **[UNVERIFIED VERBATIM]**.
- The Commission drafted a regulation authorising *"caffeine helps to increase
  alertness"* and *"caffeine helps to improve concentration"*.
- **The European Parliament vetoed it** — resolution of 7 July 2016,
  **P8_TA(2016)0319**, procedure 2016/2708(RPS) **[P-VERBATIM]**. Grounds
  included that "68% of adolescents and 18% of children regularly consume energy
  drinks", that "in practice it is difficult to control that energy drinks
  bearing the proposed claims are not sold to children", and that the claims
  risked encouraging excess consumption contrary to **Art. 3(c)**.
- Commission Regulation **(EU) 2016/1411** separately **refused** an Art. 13(5)
  application for *"Caffeine helps to increase alertness"* at 40 mg per serving.
- The Commission never re-tabled.

**Therefore, prohibited — text, voice-over, tooltip, icon, animation or
mechanic:**

- ❌ any link between caffeine and alertness, concentration, focus, reaction
  time, endurance, "delaying fatigue", perceived exertion, "energy boost", fat
  burning or metabolism
- ❌ **a caffeinated gel raising the `focus` stat.** This is a symbolic health
  claim under Art. 2(2)(1) and it is the single highest-risk mechanic in the
  design. `carbo-gel-cola-caffeine` (100 mg) and `gel-raspberry-caffeine`
  (20 mg) must not move `focus`.
- ❌ any screen-sharpening, map-clarifying or fatigue-meter effect tied to a
  caffeinated product

**Permitted:** stating the caffeine content as a plain fact — "contains 100 mg
caffeine" — with no functional framing whatsoever.

⚠️ Some trade sources describe caffeine claims as "on hold" under the Art.
28(5)/(6) transitional regime. **Do not rely on this.** The non-botanical
Art. 13(1) caffeine claims were assessed and decided; transitional protection
has lapsed.

**Mandatory labelling, Reg. 1169/2011 Annex III point 4 [P-CONDENSED].**
Beverages over **150 mg/l** caffeine must bear *"High caffeine content. Not
recommended for children or pregnant or breast-feeding women"* in the same field
of vision as the name, with the content in mg/100 ml. Foods other than beverages
with added caffeine bear *"Contains caffeine. Not recommended for children or
pregnant women"*. **The Enervit Gel Raspberry artwork already carries this
warning** [P-VERBATIM from pack]. If the game depicts a caffeinated pack, the
depiction must not undercut the warning.

### 3.2 Sodium — there is no positive sodium claim

A trap, because sodium is Enervit's declared 2026 strategic focus and the whole
point of the Salt Caps and sodium-gel SKUs.

The claim *"Sodium is needed for the functioning of muscles"* was **expressly
non-authorised**, and the reasoning is unusually strong **[P-VERBATIM]**:

> "The use of this claim is considered misleading as it contradicts generally
> accepted scientific advice, European, national and international authorities
> informing the consumer to reduce intake of this substance and would therefore
> convey a conflicting and confusing message to consumers."

The only authorised sodium claim runs the opposite way — *"Reducing consumption
of sodium contributes to the maintenance of normal blood pressure"*.

**Prohibited:** ❌ "sodium replaces what you lose in sweat" · ❌ "sodium keeps
your muscles working" · ❌ "sodium prevents cramp" · ❌ any Salt Caps mechanic
whose benefit is attributed to *sodium*.

**Permitted:** stating sodium content factually; and relying on the
carbohydrate-electrolyte solution claims, which have a sodium *condition* rather
than a sodium *claim*. Salt Caps may carry the vitamin tiredness/fatigue claims
(§2.3) — attributed to the vitamins, never to the salt.

### 3.3 BCAA and amino acids — all rejected

Every BCAA claim assessed was non-authorised, all on EFSA Journal
**2010;8(10):1790** **[P-VERBATIM]** — muscle repair and recovery, muscle
growth, faster recovery from fatigue, reduced muscle breakdown, protein
synthesis, cognitive function after exercise, reduced perceived exertion. One,
on immune function, was rejected because it was "not a beneficial physiological
effect as required by the Regulation".

**Directly relevant to R2 Recovery Drink**, which is 9.7% BCAA plus glutamine.
❌ Never attribute any R2 benefit to BCAA, leucine or glutamine. Also rejected:
L-glutamine, L-arginine, whey protein satiety, sodium phosphate endurance.

### 3.4 Tart cherry, polyphenols, anthocyanins

No authorised EU health claim exists for tart cherry extract, polyphenols or
anthocyanins. **Magic Cherry's actives are therefore entirely unclaimable.** See
§4.3 for what remains possible.

### 3.5 Phrasings prohibited regardless of product

| Phrasing | Why |
|---|---|
| "boosts performance", "boosts energy" | "boosts" is a prohibited intensifier — flexibility Principle 1 |
| "increases endurance", "improves endurance" | no authorised endurance claim except the CES wording; "maintenance of" ≠ "increase" |
| "prevents cramp", "stops cramp" | not authorised; borders on medicinal — Reg. 1169/2011 Art. 7(3) |
| "speeds recovery", "recover faster" | authorised wording is "contributes to the recovery of"; "faster" is a comparative not substantiated |
| "optimises", "maximises", "stimulates", "promotes", "strengthens", "enhances"* | expressly listed as **NOT ACCEPTABLE** in the flexibility guidance **[P-VERBATIM]** |
| "detox", "cleanses", "immune-boosting" | not authorised; medicinal territory |
| "prevents/treats/cures" anything | Reg. 1169/2011 Art. 7(3); Czech § 5d(2) — SZPI's most-fined offence |
| any reference to rate or amount of weight loss | **Art. 12(b)** |
| any doctor, nutritionist, physiotherapist or "science team" recommending a product | **Art. 12(c)** — prohibited outright, no authorisation possible |
| "you'll bonk without it", or any penalty for *not* consuming | **Art. 12(a)** — see §5 |

*"enhances" is permitted **only** inside the authorised CES water-absorption
wording, where it is the legislator's own word.

### 3.6 Mechanics that are prohibited claims

| Mechanic | Provision | Verdict |
|---|---|---|
| Caffeine product raises `focus` | Art. 10(1); no authorised caffeine claim | **PROHIBITED** |
| Failing to fuel → avatar bonks, loses, or is penalised | **Art. 12(a)** — "claims which suggest that health could be affected by not consuming the food" | **PROHIBITED — no authorisation possible** |
| More product consumed = better score, without limit | **Art. 3(c)** — encouraging excess consumption | **PROHIBITED** |
| Any stat bar responding to a named product | Art. 2(2)(1) | **Permitted only where the effect maps exactly to an authorised claim and its conditions** |
| Athlete avatar attributing a benefit to a product | Art. 2(2)(1), Art. 10(1) | **PROHIBITED** — see §7 |

**§5 sets out how to build the mechanic so that items 2 and 3 are designed out.**

---

## 4. AMBER LIST — needs client regulatory sign-off

Copy we would plausibly want, why it is a problem, and a neutral alternative
that is safe to ship today.

### 4.1 Copy lines

| # | Wanted line | Problem | Neutral alternative |
|---|---|---|---|
| 1 | "Fuel your best race" (splash/title) | General non-specific benefit → **Art. 10(3)** requires a specific authorised claim in **immediate visual proximity on the same screen** | Keep the line, and place the CES endurance claim in the same panel — not behind a link. See §6.4 |
| 2 | "Recover faster between race days" | "faster" is an unsubstantiated comparative | "Carbohydrates contribute to the recovery of normal muscle function..." with all three conditions |
| 3 | "Stay sharp on the map" next to any product | Implies a cognition benefit; no product in the range has an authorised cognition claim | Decouple entirely — make navigation quality a function of fatigue and terrain, not of a product |
| 4 | "Helps reduce tiredness and fatigue" (Enervit's own Salt Caps page wording) | Does **not name the nutrient** — breaches flexibility Principle 3. Enervit uses it; that does not make it safe for us | "Vitamin C and niacin contribute to the reduction of tiredness and fatigue" |
| 5 | "Contributes to the recovery of muscle function" (Enervit's own R2 wording) | Drops "normal", drops the qualifying clause, drops all three mandatory conditions | Use the full authorised text from §2.2 |
| 6 | "2:1 glucose:fructose lets you absorb more carbohydrate per hour" | An absorption/physiology claim with no authorisation | State composition only: "provides 30 g of carbohydrate in a 2:1 glucose:fructose ratio" — Enervit's own on-pack pattern |
| 7 | "Isotonic" used loosely of gels or of the event drink | "Isotonic" implies the osmolality condition; the event 15 g/500 ml preparation is explicitly **hypotonic** | Use the product's registered name only; never as a functional descriptor |
| 8 | "Enervit Isotonic Drink contributes to the maintenance of endurance performance" | Product-name substitution — normally breaches Principle 3 | **Actually permitted here**, uniquely, because the authorised category *is* "carbohydrate-electrolyte solutions" and this product qualifies. Still get it signed off |
| 9 | Product names "R2 **Recovery** Drink", "**Pre** Sport", "**Power** Time" displayed in UI | Brand names functioning as general non-specific claims — flexibility Principle 6 → triggers **Art. 10(3)** | Unavoidable, since these are the product names. Ensure a specific authorised claim accompanies them wherever they are prominent |
| 10 | "What Tadej Pogačar takes on a mountain stage" | Athlete testimonial implying benefit — §7 | "Enervit is the official nutrition partner of UAE Team Emirates" — sponsorship fact, no benefit implied |

### 4.2 The Czech distributor's existing copy

`NUTRITION_PROTOCOL.md` §7 records that the Czech Enervit recovery article
publishes **102–126 g carbohydrate per hour**, contradicting Enervit global's
30–60 g/h, exceeding the 90 g/h the C2:1 range is marketed on, and not even
being in a 2:1 ratio. Separately the Czech pre-race article asserts the
rebound-hypoglycaemia rationale as fact.

**This is the client's own published content.** We should not replicate it, and
we should tell them about it — under Art. 3(a) misleading claims and Reg.
1169/2011 Art. 7, published nutrition advice that contradicts the brand's own
position is a live exposure. Raise it; do not silently work around it.

### 4.3 Magic Cherry — the hardest single case

Commercially important in CZ/SK (first pallets sold out in days) and therefore
guaranteed to attract pressure for a visible in-game effect.

- Its actives — tart cherry polyphenols and anthocyanins — have **no authorised
  claim** (§3.4).
- Its only claimable nutrient is **vitamin E at 30% NRV per 9 g sachet**, which
  does clear "source of". So it **may** carry *"Vitamin E contributes to the
  protection of cells from oxidative stress"* **[P-VERBATIM]**.
- That is **not a recovery claim, not a muscle claim, and not a soreness
  claim.** Presenting the oxidative-stress claim next to a recovery mechanic
  would let the consumer infer a recovery benefit — misleading under Art. 3(a)
  even though each element is individually true.

**Recommendation: give Magic Cherry no stat effect** (as set in
`ENERVIT_SKU_MAP.json`). If it must appear, make it cosmetic or flavour-fatigue
relief. **Escalate rather than absorb the pressure.**

---

## 5. Designing the mechanic so it is compliant by construction

Three provisions shape the core loop. Handling them at design time is far
cheaper than at copy-review time.

**Art. 12(a) — no penalty for not consuming.** A mechanic where skipping a gel
causes a bonk is prohibited outright. **The fix is already true to the sport:**
per `NUTRITION_PROTOCOL.md`, the correct intake for Sprint and Middle is *zero*.
Frame depletion as a consequence of **effort, terrain and heat**, and framing
product as one of several ways to manage it — alongside pacing, route choice and
starting well-fuelled. The athlete's state should degrade because they are
racing hard, never because they declined a product.

**Art. 3(c) — no reward for excess.** Never let more product monotonically
improve outcomes. Model the real ceiling: gut tolerance, carrying weight, and
the fact that 60 g/h in a 32-minute race is useless. **A player who over-fuels
should do worse.** This is both compliant and correct.

**Art. 2(2)(1) — stat changes are claims.** Every stat effect must map to an
authorised claim or be defensibly non-health. Current status:

| Stat | Mapping | Status |
|---|---|---|
| `hydration` ← Isotonic Drink | CES water-absorption claim | ✅ authorised, product qualifies |
| `glycogen` ← R2 after a race | carbohydrates/recovery claim (Reg. 2015/7) | ✅ authorised, conditions must be shown |
| `glycogen` ← carbohydrate during Long | CES endurance claim, Isotonic Drink only | ✅ for that SKU; other SKUs need care |
| `bloodSugar` | no authorised blood-glucose claim exists | ⚠️ present as a **game variable**, never as a health effect |
| `focus` ← caffeine | **none — prohibited** | ❌ must be removed |
| `focus` ← anything else | no authorised cognition claim on any SKU | ⚠️ drive from fatigue/terrain only |

**Net design instruction:** `focus` must not be driven by any product. Per
`NUTRITION_PROTOCOL.md` §6.1 the science points the same way — Carter et al.
2004 showed carbohydrate availability is not limiting at one hour. The
compliant design and the honest design are the same design.

---

## 6. Rules of use

### 6.1 On-pack versus in-game

There is **no difference in the substantive standard**. Art. 1(2) covers
labelling, presentation *and advertising*; the flexibility guidance extends it to
"whatever medium including on websites"; C-19/15 covers indirect promotion.

The differences are procedural, and they cut **against** us:

| | On-pack | In-game |
|---|---|---|
| Claim wording standard | identical | identical |
| Art. 10(2) mandatory info | on the label | must be **on the screen** bearing the claim |
| Art. 10(3) accompaniment | on the pack | must be in **immediate visual proximity**, same screen |
| Who is liable | manufacturer / advertiser | **Vitar Sport *and* the game's publisher**, separately |

**Art. 10(2) [P-VERBATIM]** — wherever a health claim appears and there is no
labelling, the presentation or advertising must include: (a) a statement on the
importance of a varied and balanced diet and a healthy lifestyle; (b) the
quantity and pattern of consumption required to obtain the effect; (c) where
appropriate, a statement for persons who should avoid the food; (d) a warning
for products likely to present a health risk if consumed to excess.

**In practice: every screen bearing a health claim needs a compliance block.**
Design for this now — it is a layout constraint, not a footer.

**"Educational content" is not a defence.** The game is published by/for the
distributor and promotes its branded products, so it is a commercial
communication. SZPI has already fined a company **30 000 Kč for an article on
its own website** framed as information.

### 6.2 CZ/SK language — a hard blocker

Flexibility Principle 2 **[P-VERBATIM]**: the word "normal" "should be retained
in adapted wording, it should not be replaced by another term or removed.
However, 'normal' does not appear in all linguistic versions of the
Regulation..."

**Every claim string must come from the Czech and Slovak Official Journal
versions of Reg. 432/2012 and 2015/7 — not translated from the English in this
document.** The Czech text uses *"normální"*; deleting it to make copy punchier
is a breach. Given `src/i18n/` already carries cs/en/sk, claim strings should be
a **separate, locked namespace** that translators may not touch.

**This document contains no shippable CZ or SK copy.** Obtaining the official
CZ/SK strings is the top open action.

### 6.3 Claims belong to the nutrient, not the product

Flexibility Principle 3 **[P-VERBATIM]**: "health claims should only be made for
the nutrient, substance, food or food category for which they have been
authorised **and not for the product that contains them**."

- ✅ "Vitamin B6 contributes to the reduction of tiredness and fatigue"
- ✅ "Enervit R2 contains vitamin B6, which contributes to the reduction of
  tiredness and fatigue"
- ❌ "Enervit R2 contributes to the reduction of tiredness and fatigue"
- ❌ "Enervit R2 contributes to the reduction of tiredness and fatigue. R2
  contains vitamin B6" — expressly not acceptable, "since there is no clear link
  made between X and the claimed effect"

**The one exception** is carbohydrate-electrolyte solutions, where the
authorised category *is* the food (§2.1).

**Bundling rule [P-VERBATIM]:** several nutrients may share one claim sentence
only if **every** named nutrient carries **every** named effect. "Mix of
vitamins (B6, B12, C) which contribute to the reduction of tiredness and
fatigue" is acceptable; a mix where only some nutrients carry the effect is not.

### 6.4 Art. 10(3) and screen layout — CJEU C-524/18

*Dr. Willmar Schwabe*, 30 January 2020 **[P-CONDENSED]**. The accompanying
requirement has "both a substantive and a visual dimension" (para 40); the
visual dimension requires "spatial proximity or immediate vicinity" (para 47);
an asterisk may *exceptionally* suffice only where it makes the match "clear and
perfectly comprehensible" (para 48).

**Consequence:** a title screen reading "FUEL YOUR BEST" or a level called
"RECOVER" must carry the specific authorised claim **on the same screen, in
immediate visual proximity**. A legal page, a footer, an info button, a tooltip
behind a hover, or a claim on a later screen **will not satisfy Art. 10(3)** — a
hyperlink is weaker than the asterisk the Court already found insufficient.

This is exactly the breach SZPI fined **120 000 Kč** (Naturprodukt CZ, leaflet,
decision 23 April 2021) — non-specific health claims where "it was not stated to
which constituent the health claim related", unaccompanied by a specific claim.

### 6.5 Do not mine EFSA opinions for wording

Flexibility Principle 7 **[P-VERBATIM]**: doing so "could increase the risk of
changing the meaning of the claim", and adapted wording "should not include
reference to symptoms of deficiency".

**Directly relevant:** do not build copy from EFSA's caffeine
endurance/perceived-exertion language (§3.1) or from the physiology in the CES
opinion. The authorised sentence is the whole permission.

---

## 7. "What the pros do" framing

*Reasoned analysis on the verified provisions above; no EU guidance specific to
athlete endorsement of foods was located.*

**Short answer: it makes the picture worse, not better.**

1. **Art. 12(c) does not bite on athletes** — it prohibits reference to
   recommendations of individual **doctors or health professionals**. A cyclist
   is not one. **But** a team doctor, physiotherapist, sports nutritionist or
   "Enervit Science Team" character *is*, and that makes the claim **prohibited
   outright with no route to authorisation**. Athlete plus lab-coat is the
   dangerous combination — and note Enervit HQ offers exactly such a figure
   (their nutrition specialist) for content support.
2. **A testimonial is still a claim.** Art. 2(2)(1) covers "any message or
   representation... in any form". Attribution does not launder it. *"I take a
   gel every 30 minutes so I don't fade"* is an unauthorised endurance/fatigue
   claim whoever says it.
3. **Describing a real protocol is not a safe harbour.** Depicting an athlete's
   actual 90 g/h fuelling in a promotional game implies a product–performance
   relationship. Per C-19/15, promoting "directly or indirectly" suffices.
   **Factual accuracy is not a defence** — Art. 10(1) prohibits unauthorised
   health claims even when true.
4. **The overall impression is what is judged.** Art. 3(a) and Reg. 1169/2011
   Art. 7(1) and 7(4) apply to imagery and mechanics, not just text. A compliant
   claim string beside a non-compliant animation is still an infringement.

**Safe:** "Enervit is the official nutrition partner of UAE Team Emirates" ·
"Team X uses Enervit" · composition, flavour and format facts · dosing and
timing as *use instructions* (but note that stating "4 g/kg within 4–6 h" puts
you inside the carbohydrate claim's conditions, so the whole claim's conditions
then apply).

**Not safe:** athlete quotes about energy, focus, recovery, cramp or "hitting
the wall" · any narrative where consumption visibly causes a better outcome ·
comparative framing like "pros choose X over Y", which additionally engages
Arts. 8 and 9 on comparative claims.

**A note on the one athlete who is genuinely useful.** Enervit CZ already
sponsors orienteer **Miloš Nykodým**. Naming him as a sponsored athlete is a
sponsorship fact and is safe. Having him say the products help him navigate is
not.

---

## 8. Czech and Slovak enforcement

**Czech architecture**, evidenced by SZPI's own decisions:

- **Zák. č. 40/1995 Sb., o regulaci reklamy** — **§ 5d(1)** food advertising
  compliance with Reg. 1924/2006 including Art. 10(3); **§ 5d(2)** prohibits
  attributing disease prevention/treatment/cure. Offences: **§ 8a(1)(r)** for the
  *šiřitel*, **§ 8a(2)(i)** and **(j)** for the *zadavatel*. **SZPI supervises
  food advertising.**
- **Zák. č. 110/1997 Sb., o potravinách** — **§ 17(2)(a)(b)(c)** for
  labelling/claims offences.

**Observed penalties:** Naturprodukt CZ **120 000 Kč** (Art. 10(3) in a printed
leaflet, plus medicinal claims); Selltime/Vilgain **30 000 Kč** (article on own
website); AZ Corporation **10 000 Kč** (e-shop tab name); Allnature **350 000
Kč** (highest supplement fine in five years). SZPI also imposes corrective
measures with deadlines as short as **two days**.

⚠️ **[UNVERIFIED]** The verbatim text and fine ceilings of § 5d, § 7 and § 8a(5)
of zák. č. 40/1995 Sb., and § 17 of zák. č. 110/1997 Sb., could not be retrieved
(zakonyprolidi.cz returned 403). Obtain before finalising.

⚠️ **[UNVERIFIED] Slovakia was not researched at all.** Expected framework: zák.
č. 152/1995 Z.z. o potravinách and zák. č. 147/2001 Z.z. o reklame, enforced by
ŠVPS SR and the regional RÚVZ. **This needs separate verification before any SK
release.**

⚠️ **[UNVERIFIED]** The Czech self-regulatory **Rada pro reklamu** Code of
Advertising Practice has a food and food-supplement chapter restricting
testimonial and health advertising. Not legally binding, but frequently cited by
SZPI and by competitors. Worth a check given §7.

---

## 9. Open actions before any copy ships

| # | Action | Blocks | Owner |
|---|---|---|---|
| 1 | Obtain **official CZ and SK OJ wording** of every green-list claim | all shippable copy | client / EUR-Lex |
| 2 | Client regulatory sign-off on the green list | all product copy | Vitar Sport → Enervit (Equipe Enervit) |
| 3 | Confirm Isotonic Drink's current sodium and osmolality against the **live** pack | the entire §2.1 position — margin is 4% | client |
| 4 | Decide the event-refreshment position: the 15 g/500 ml cup does **not** qualify | in-game and on-site arena copy | client |
| 5 | Remove caffeine → `focus` from the design | §3.1, §5 | us |
| 6 | Confirm magnesium dose per sachet | all magnesium claims | client |
| 7 | Obtain 100% Whey Protein nutrition, and protein as % of energy | all protein claims | client |
| 8 | Decide Magic Cherry's in-game treatment | §4.3 | client, escalated |
| 9 | Retrieve verbatim § 5d / § 8a(5) of zák. 40/1995 Sb. and § 17 of zák. 110/1997 Sb. | CZ risk sizing | legal |
| 10 | Research the Slovak framework | any SK release | legal |
| 11 | Check Rada pro reklamu code | §7 framing | legal |
| 12 | Raise the CZ 102–126 g/h article with the distributor | client's own exposure | us → client |
| 13 | Re-query the **live** EU Register per claim | the official register PDF is stamped 14/02/2013 and predates 2015/7 and 2017/672 | us |
| 14 | Lock claim strings into a separate i18n namespace translators cannot edit | §6.2 | us |

---

## 10. Corrections to assumptions in the original brief

Recorded so they are not reintroduced:

1. **Vitamin C and iron *do* have authorised claims** — 14 and 7 respectively,
   including tiredness and fatigue for both, and "Iron contributes to normal
   oxygen transport in the body". The brief implied they might not.
2. **The carbohydrates/muscle-recovery claim is Regulation (EU) 2015/7**, not
   2015/2314 (that one is chicory inulin).
3. **Only BCAA and amino acids are wholesale rejected** among the substances
   asked about.
4. **Thiamine has no tiredness-and-fatigue claim** — energy metabolism and
   nervous system only. Important, since thiamine is in nearly every Enervit SKU.
5. **Magnesium's "source of" threshold for a *beverage* is 7.5% NRV per 100 ml,
   not 15%** — commercially significant for the isotonic range.
