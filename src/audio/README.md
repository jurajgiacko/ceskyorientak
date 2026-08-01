# Audio

Everything you hear in this game is synthesised in code at runtime. There is
not one sample file in the project, and there is no audio library — only the
Web Audio API. That is a constraint from the brief, and it shapes every
decision below.

---

## Contents

1. [Architecture](#architecture)
2. [Synthesis recipes](#synthesis-recipes)
3. [Verification](#verification)
4. [Measured results](#measured-results)
5. [Budgets](#budgets)
6. [Known weaknesses](#known-weaknesses)

---

## Architecture

### Files

| File | What it owns |
|---|---|
| `engine.ts` | The `AudioContext` lifecycle and the graph topology |
| `synth.ts` | Every synthesis primitive: noise, IRs, Karplus-Strong, modal, envelopes, voice pool |
| `footsteps.ts` | Nine per-`GroundType` footfall recipes, gait, vegetation brush |
| `breathing.ts` | Breath tracking pace and `AthleteStats.glycogen` |
| `sportident.ts` | Punch feedback, contact and touch-free |
| `ambience.ts` | Wind, PA, crowd, cowbells, river, monastery bells, birds |
| `music.ts` | Generative drone and sparse plucked tones |
| `mixer.ts` | Map-reading duck and punch sidechain |
| `index.ts` | Public API + `AudioSystem`, the whole thing on one graph |

### Signal flow

```
voices ─┬─→ bus.input → bus.duck → bus.comp ────────────────┐
        └─→ bus.aux ──→ reverbSend → convA/convB → return ──┤
                                                            ▼
              preMaster → width (M/S) → tone (LPF) → master → mute
                                                                │
                                    softClip ← limiter ←────────┘
                                        │
                                        ▼
                                   destination
```

Five buses — `footsteps`, `breath`, `ambience`, `ui`, `music` — each with its
own trim, duck gain, compressor and reverb send. Three ownership rules keep the
graph honest:

- **`bus.input` belongs to `setBusGain`.** Settings sliders move it.
- **`bus.duck`, `tone`, `width` and `reverbReturn` belong to `mixer.ts`.**
  Nothing else touches them.
- **`mute` belongs to `AudioEngine`.**

Separating these matters. The classic bug in a system like this is a settings
slider and a ducking routine writing to the same `AudioParam`, after which the
mix never quite comes back up. Here that cannot happen structurally.

### `AudioGraph` vs `AudioEngine`

`AudioGraph` builds the topology on **any** `BaseAudioContext`. `AudioEngine`
is the browser lifecycle around it. The split exists so `tools/audio/render.mjs`
can build the identical graph inside an `OfflineAudioContext` and measure
exactly what the game produces — no mocks, no parallel implementation.

Every scheduling method in this system takes an explicit `now`. That is not
incidental: it is what lets the offline harness pump `update(now, dt)` at 60 Hz
across a 60-second window before rendering, and get the same timeline the game
would have produced live.

### iOS Safari

- The `AudioContext` is **not created** at `initAudio()`. It appears on the
  first `pointerdown` / `touchend` / `mousedown` / `keydown` anywhere on the
  page. Before that, every public function is a safe no-op.
- `unlock()` resumes the context **and** starts a one-sample silent buffer.
  `resume()` alone can resolve while the context stays effectively muted until
  a source has actually been started from inside a gesture handler.
- `webkitAudioContext` is used as a fallback constructor.
- **No `AudioWorklet` anywhere.** All sample-level DSP happens at init, in plain
  JS writing into `Float32Array`s. What runs in realtime is only native nodes.
  There is no worklet to fail to load, and no fallback path to maintain.
- `StereoPannerNode` is used, which requires Safari 14.1+ (2021). That is well
  below the WebGL2 floor this project already sets in `capabilities.ts`.

### Allocation policy

The per-frame update path allocates **nothing**. Phase accumulators are numbers,
voices are pooled, envelopes are `AudioParam` automation.

The one exception is forced by the specification: `AudioBufferSourceNode` is
single-use, so a one-shot must construct one. Everything downstream of it —
three biquads, two gains, a panner — is pooled and reused, and the pool steals
the oldest voice rather than growing. Pool sizes: footsteps 16, punch 6,
cowbell 8, crowd 6, bird 4, bell 3, music 6.

Event-rate allocation (bird calls create an oscillator, roughly once every
15 seconds) is accepted and marked as such in the code. Frame-rate allocation is
not.

---

## Synthesis recipes

### Noise (`synth.ts`)

Three beds, generated once at init, shared by everything:

- **White** — 2.5 s stereo, flat.
- **Pink** — 3.0 s stereo, Voss-McCartney with 16 rows plus a white top layer so
  the highest octave is not stepped.
- **Brown** — 2.0 s mono, leaky integration of white (`y = 0.996y + 0.04w`).

All three are DC-blocked, RMS-normalised to 0.28, and **wrap-crossfaded**: the
last 50 ms is equal-power blended into a copy of the head, so looping produces
no click. Each voice reads from a random offset at a per-layer playback rate, so
a shared buffer does not sound shared.

### Impulse responses

Procedural. Exponentially-decaying noise (−60 dB at `seconds`), with a one-pole
lowpass whose cutoff sweeps from `hfStart` to `hfEnd` across the tail — high
frequencies are absorbed first in every real space — plus an echo-density ramp
and a hand-placed set of discrete early reflections. Channels use independent
seeds and the reflections are skewed ~1.1 ms between them; that is the entire
source of the stereo width.

The density model is the interesting part. `p(t) = density · min(1, t/90ms)²`
gates the noise, and the surviving grains are scaled by `1/√p` to conserve
energy. Low density leaves audible discrete scatter, which is what a forest
actually is: a sparse field of trunks, not a diffuse room.

| Preset | s | predelay | hfStart→hfEnd | density | early refl. |
|---|---|---|---|---|---|
| `openForest` | 1.10 | 12 ms | 4200 → 850 Hz | 0.22 | 6 |
| `denseSpruce` | 0.55 | 5 ms | 2400 → 420 Hz | 0.50 | 3 |
| `stoneCourtyard` | 3.00 | 19 ms | 11000 → 3100 Hz | 0.85 | 7 |
| `openArena` | 1.50 | 28 ms | 6200 → 1300 Hz | 0.38 | 4 |

IRs are L2-normalised (not peak-normalised) and `ConvolverNode.normalize` is
switched **off**, so convolution gain is roughly constant regardless of IR
length. Otherwise the courtyard, being longest, would simply be loudest.

Two convolvers are kept alive and crossfaded, so changing environment does not
drop a reverb tail on the floor by reassigning `.buffer`.

### Karplus-Strong

Rendered offline into `Float32Array`s, not built as a live `DelayNode` feedback
loop. A Web Audio graph cycle carries a mandatory 128-sample latency, which puts
a hard ceiling of ~`sampleRate/128` on the achievable pitch and detunes
everything below it. Offline there is no such constraint and the tuning is
exact.

Excitation is lowpassed noise (brightness-controlled), DC-removed so the string
does not start with a thump; the loop is the standard two-tap average with a
mix controlled by `damping` and a per-sample `sustain` trim.

### Modal synthesis

Additive: a bank of exponentially-decaying sinusoids at inharmonic ratios,
each optionally beating against a slightly detuned twin, plus a short broadband
strike transient. Oscillators use the two-multiply recurrence rather than
`Math.sin` per sample.

Used for the punch beep, the cowbells and the monastery bells. The beating is
what stops additive synthesis sounding like an organ, and it is why real bells
shimmer.

### Footsteps

A footfall is up to four layers — **body** (low thud, the athlete's mass
arriving), **surface** (the band that identifies the material), **grains**
(micro-bursts a few ms apart, i.e. crunch), **tail** (marsh suck, water
droplets) — plus a **vegetation brush** layer driven by `Runnability`.

None of the nine is a pitch-shift of another. They differ in noise colour, band,
resonance Q, envelope shape, grain count, sweep direction and reverb send:

| Ground | Noise | Band | Resonance | Attack / decay | Send | Special |
|---|---|---|---|---|---|---|
| `needles` | pink | 2250–8700 | 5100 Hz, Q1.0, +4 dB | 5 / 115 ms | 0.06 | soft, no click |
| `leaf` | white | 540–5200 | 2000 Hz, Q2.2, +6 dB | 3 / 155 ms | 0.07 | 3 grains @ 19 ms |
| `grass` | pink | 430–3900 | 1350 Hz, Q1.4, +3 dB | 7 / 160 ms | 0.05 | long soft swish |
| `rock` | white | 520–10500 | 2750 Hz, **Q6**, +11 dB | 1.8 / 75 ms | 0.13 | 2 grains, rings |
| `marsh` | brown | 70–900 | 255 Hz, Q4, +10 dB | 6 / 200 ms | 0.03 | **wet suck** |
| `gravel` | white | 2000–15000 | 4600 Hz, Q1.2, +4 dB | 2 / 125 ms | 0.08 | 4 grains @ 23 ms |
| `cobble` | white | 1700–14000 | 3450 Hz, **Q8**, +14 dB | 1.2 / **45 ms** | **0.45** | courtyard send |
| `asphalt` | white | 620–4400 | 1550 Hz, Q3, +7 dB | 1.6 / 58 ms | 0.09 | flat slap |
| `water` | white | 180–2150 | 640 Hz, Q1.1, +3 dB | 4 / 280 ms | 0.16 | opening sweep + droplets |

Three of these deserve a note:

- **Marsh** is the only footstep with two distinct events in it. The impact is a
  brown-noise squelch with a *closing* lowpass sweep (ratio 0.45, settling into
  mud); then 55–85 ms later a separate voice with a slow 45 ms attack and a
  *rising* resonant filter — 190→~1100 Hz — as the foot pulls out and the cavity
  collapses behind it. A suck is a pull, not an impact, hence the slow attack.
- **Cobble** is 45 ms end to end with a Q8 resonance at 3.45 kHz and a 0.45
  reverb send. It is designed to be thrown at the Krumlov courtyard IR; dry, it
  sounds thin, which is correct.
- **Water** sweeps its lowpass *upward* by 2.6× — spray thrown up — then drops
  two or three modal droplets back over the following 300 ms.

Every strike randomises filter frequency (±10–16%), gain (±16–30%), pan
(alternating feet, ±0.10–0.26) and its read offset into the noise bed, so no two
footfalls share a waveform.

**Gait.** `stepsPerSecond(speed) = clamp(1.24 + 0.42·speed, 0.95, 3.3)`. Elite
orienteers hold 170–185 spm on runnable ground and cadence falls far less than
speed does in green — you shorten the stride, you do not slow the legs. So
4.2 m/s → 182 spm and 1.5 m/s (fight) → 116 spm. Falling glycogen adds a limp
(one foot ±2–5% off the beat), a heavier body layer (+28%) and probabilistic
dragged scuffs.

### Breathing

The most important sound in the game, and the one that has to make the wall land
before the HUD says anything. Two permanent noise chains (inhale from white,
exhale from pink) and one permanent oscillator; a breath is nothing but
scheduled automation. Zero allocation after `start()`.

Each chain: `source → highpass → turbulence bandpass → formant₁ → formant₂ →
highshelf → amp → panner`.

As glycogen falls, in the order you notice it:

| | mechanism |
|---|---|
| **rate** | `bpm = 15 + 24·effort + 26·fatigue + 8·effort·fatigue` |
| **depth** | `0.20 + 0.34·effort + 0.26·fatigue`, and the exhale grows faster than the inhale |
| **tilt** | high shelf at 3.6 kHz moves −2 → +7 dB: the mouth goes dry and the breath hisses |
| **raggedness** | the exhale breaks into 2–4 amplitude pulses. Amplitude only |
| **the catch** | the inhale hitches — 60% up, stall to 17%, then a snatched 106% |
| **the groan** | a sawtooth at 96–132 Hz through a 430 Hz lowpass, falling across the exhale |
| **the pause** | rest between breaths shrinks from 16% of the cycle to 0 |
| **irregularity** | cycle-length jitter grows from ±4% to ±15% |

Restraint is the hard part. Everything above, at full depth, on every breath, is
a cartoon. So: the groan is probabilistic (`p = (fatigue − 0.5)·1.15`, capped at
0.55) and never louder than −19 dB relative to the breath noise; the catch never
fires twice in a row; the raggedness is amplitude only, because pitched distress
reads as comedy almost immediately.

The lowpass on the groan is set at 430 Hz so only three or four harmonics
survive. Any more and it becomes a voice saying something, which is exactly what
it must not be.

### Punch

The most recognisable sound in orienteering, so it gets its own module.

- **Contact** — 2000 Hz fundamental with weak integer harmonics (−22, −26 dB) and
  one inharmonic partial at 4.72× for the case resonance. Slow modal decay
  (0.45 s) truncated at 88 ms by the renderer's 20 ms release ramp: flat, then
  gone. Preceded 16 ms earlier by a 12 ms plastic click — the stick entering the
  station.
- **Touch-free** — 2600 Hz, 56 ms, almost pure, no mechanical component at all,
  and a 0.30 reverb send rather than 0.10 because the emitter is on your wrist
  out in the open rather than under your hand.

Both are rendered once and replayed unchanged. Real electronics produce an
identical beep every time; only level and pan vary. Attack is 1.5 ms — any
softer and it reads as a game UI sound instead of timing hardware.

`firePunch()` returns the beep's timeline instant so the renderer can put the
control-flag flash on the same frame, and fires a 4 dB sidechain dip on ambience
and music so the beep lands in a hole.

**Naming.** No buffer, render file or public identifier in this system carries a
SPORTident trademark. The variants are `contact` and `touchfree`; the rendered
files are `punch-contact.wav` and `punch-touchfree.wav`. Only `sportident.ts`
itself, which is documentation as much as code, names the technology.

### Ambience

Seven layers, blended by `setEnvironment(forest | arena | town)` which crossfades
a level vector and the convolution space in one gesture.

- **Wind** — two bands, because wind in a spruce stand is two sounds: a brown
  body you feel in the low mids (45–620 Hz), and canopy hiss thirty metres above
  your head (1.4–11 kHz). Gust amplitude and brightness move together.
- **Distant PA** — pink noise band-limited to a horn's passband (420–2900 Hz)
  with one moving formant, gated into syllables of 70–190 ms at 4–7 Hz, grouped
  into phrases of 1.2–3.6 s. Unintelligible on purpose: the moment a player
  thinks they heard a name, the illusion does the opposite of its job.
- **Crowd** — pink noise, 380–3400 Hz, density on a random walk, with cheer
  swells (rise 0.5–1.2 s, hold 0.8–2.2 s, fall 1.8–3.6 s) carrying 6–20 scattered
  claps.
- **Cowbells** — six inharmonic partials (1, 1.51, 2.13, 2.87, 3.71, 5.42) at
  470/532/594 Hz with a hard strike transient. Shaken in clusters of 5–13 hits
  with asymmetric up/down-swing spacing (0.12–0.19 s vs 0.19–0.30 s), which is
  the difference between a hand and a sequencer.
- **The Vltava** — three bands with independent random walks: low body
  (60–420 Hz), mid churn (320–2600 Hz), spray (2.6–12 kHz). A shallow rocky river
  is not one hiss, and the balance shifts constantly.
- **Monastery bells** — eleven partials on the classic Western profile: hum at
  0.5, prime at 1.0, minor-third tierce at 1.19, quint at 1.5, nominal at 2.0,
  then 2.5, 2.67, 3.0, 4.0, 5.33, 6.8. Low partials ring 7.5 s, high ones 0.3 s.
  Two bells a minor third apart (G4 / B♭4), pealed with human unevenness.
- **Birds** — jay, buzzard, great spotted woodpecker, coal/crested tit, wood
  pigeon. Sparse: Poisson-scheduled, mean gap 16 s in forest. The set is chosen
  for a Czech **August** morning in a spruce stand, which is a quiet place — the
  songbirds have finished breeding and stopped singing, so what remains is
  contact calls, alarm calls and raptors. A thrush singing its heart out here in
  August would be as wrong as palm trees.

Note that the arena bleeds into the forest at 0.05–0.06. You hear Martínkov from
800 m out in the trees and it grows as you come back. Cutting it to zero would be
tidier and would sound wrong.

**Why it never loops.** Three mechanisms, in order of how much work they do:

1. **Drifting playback rates.** Every looping noise source has its
   `playbackRate` on a slow seeded random walk between ~0.82 and ~1.20. The
   buffer still loops, but its *period* is never the same twice, which destroys
   the autocorrelation peak a fixed loop produces. This is the one that actually
   passes the test.
2. **Random-walk modulation.** Gust strength, filter cutoffs, river band balance
   and crowd density move by `setTargetAtTime` toward new seeded targets every
   1.4–3.2 s. A random walk has no period at all, unlike a bank of LFOs, which
   is merely periodic with a long period.
3. **Poisson events.** Birds, cowbell shakes, cheers, PA phrases and bell peals
   are scheduled from exponentially-distributed gaps.

### Music

Sparse, tense, no pulse. Three deliberate choices:

- **No grid.** Events are Poisson-scheduled (mean gap 14 s at rest, 5 s at full
  tension), so the music can never accidentally lock to the player's cadence and
  turn a race into a rhythm game.
- **Modal, not tonal.** D Phrygian — D E♭ F G A B♭ C. The flat second is the
  whole character: it will not resolve and it cannot sound triumphant. Degree
  weights interpolate from calm (tonic and fifth carry it) to tense (the flat
  second and flat sixth take over), so the mode sours without a key change.
- **Plucked, not orchestral.** Karplus-Strong strings rendered at three base
  pitches (D3, A3, D4) and playback-rate shifted by at most a minor third —
  beyond that the decay stretches audibly and it stops being the same
  instrument. Dry and woody, like a cimbalom left to ring.

Under it: three saws 3–7 cents apart plus a sub triangle at D1, through a
lowpass at 150–260 Hz that opens as tension rises. The beating between the saws
is the only movement it has, and at those detunes the beat period is a few
seconds, which reads as breathing rather than as detune. A bowed-ish upper voice
(saw through a Q4.5 bandpass) swells and recedes on its own slow schedule.

Tension is derived in `index.ts` as `0.55·(1 − glycogen) + 0.45·(1 − focus)` —
the athlete emptying out, and the athlete losing the map. It moves density,
register and sourness. It barely moves volume. Getting louder is what a lesser
system would do.

### Mixer

The brief asks for "full mix ducking during map reading". The literal reading is
wrong and it is worth saying why: raising the map is not muting the world, it is
*narrowing attention*. So the duck is shaped, and it moves three things a level
change alone cannot:

| Bus | Duck |
|---|---|
| `ambience` | −15.0 dB — the forest recedes furthest |
| `music` | −12.0 dB |
| `footsteps` | −9.0 dB — still there, you are still running |
| `breath` | −4.5 dB — the shallowest by a wide margin |
| `ui` | 0 dB — a punch is never ducked |

plus the master lowpass sweeping 20 kHz → 1.7 kHz (dull and close) and the M/S
side gain collapsing 1.0 → 0.35 (the stereo image narrows to you). Timing is
exponential and asymmetric: ~300 ms down, ~550 ms up. Slower coming back is what
makes it read as a musical duck rather than a gate — gates are symmetric and you
hear them switch.

Breath staying up is the point of the whole gesture. When the player lifts the
map, what fills the space the forest left is their own breathing. On a Long
distance at glycogen 0.2 that is genuinely unpleasant, and it should be.

The punch sidechain composes with the map duck by **multiplication** rather than
by overwriting, so ducking while reading the map cannot strand a bus at the
wrong level.

---

## Verification

Two harnesses, and they check each other.

### `tools/audio/render.mjs` — offline

```sh
npm run audio:render
```

Bundles `src/audio/` with esbuild, builds the real `AudioGraph` inside an
`OfflineAudioContext` (`node-web-audio-api`, a devDependency for this script
only — nothing it provides reaches the bundle), renders 30 cases to
`tools/audio/renders/*.wav`, and measures each. The measurement DSP —
FFT, spectral centroid, envelope follower, decay time, autocorrelation, WAV
encoder — is written from scratch in `tools/audio/dsp.mjs` and shares no code
with the system under test.

### `tools/audio/preview.html` — browser

```sh
npm run dev   →   http://localhost:3000/tools/audio/preview.html
```

Buttons for every sound, sliders for glycogen / hydration / focus / speed / wind
/ runnability, per-bus faders, environment switching, map-duck toggle. Plus a
self-test button that re-runs the same measurements inside the real browser
implementation, which is the only place the answer finally counts.

### One tooling bug worth recording

`node-web-audio-api` 2.1.0 mis-implements `AudioParam.setTargetAtTime`: it
applies the exponential curve to *all* time, including backwards from
`startTime`, so the param explodes before the event happens.

```
gain.value = 1;  gain.setTargetAtTime(0.4, 4, 0.1);
→ v(3.9) = 1.375e17,  which is exactly (1 − 0.4)·e^((4 − 0.003)/0.1) + 0.4
```

This is a bug in the harness, not in `src/audio/`. Verified in Chrome, where the
same graph gives `v(3.9) = 1`, `v(4.5) = 0.404`, `v(9) = 0.9973` — correct.
`tools/audio/shim.mjs` replaces the method with a 24-segment piecewise-linear
approximation of the same exponential; it agrees with Chrome to within 0.7%.
Nothing in the shipped code changed.

---

## Measured results

Offline numbers are from `tools/audio/renders/report.json` at 48 kHz. Browser
numbers are from Chrome via `preview.html`. **All 30 offline cases pass
`peak < 0.99` and `|DC| < 0.001`.**

### Footsteps — spectral distinctness

Eight strikes per file, speed 3.6 m/s, glycogen 1.0.

| Ground | Centroid (offline) | Centroid (Chrome) | Ratio to previous | Strike length | Peak | DC |
|---|---:|---:|---:|---:|---:|---:|
| `marsh` | 460 Hz | 457 Hz | — | 420 ms | 0.598 | −2.1e−5 |
| `grass` | 2345 Hz | 2423 Hz | ×5.10 | 176 ms | 0.532 | −4.8e−5 |
| `water` | 2689 Hz | 2876 Hz | ×1.15 | 420 ms | 0.390 | −7.4e−5 |
| `asphalt` | 3241 Hz | 3440 Hz | ×1.21 | 99 ms | 0.389 | −4.7e−5 |
| `leaf` | 4119 Hz | 4338 Hz | ×1.27 | 420 ms | 0.474 | +4.8e−5 |
| `needles` | 5169 Hz | 5459 Hz | ×1.26 | 120 ms | 0.433 | −2.5e−5 |
| `rock` | 6044 Hz | 6442 Hz | ×1.17 | 420 ms | 0.570 | −1.6e−5 |
| `cobble` | 6858 Hz | 7669 Hz | ×1.14 | 251 ms | 0.736 | −3.1e−5 |
| `gravel` | 8036 Hz | 9201 Hz | ×1.17 | 420 ms | 0.657 | −1.0e−6 |

**Smallest gap between neighbours is 14%** (cobble / rock), and the full span is
17.5:1 from marsh to gravel. Chrome and the offline harness agree on ordering
exactly and on magnitude within ~10%.

Centroid is not the only discriminator, and for the closest pair it is not the
main one: `rock` is 75 ms with a Q6 ring and a 0.13 send; `cobble` is 45 ms with
a Q8 ring and a 0.45 send into a 3-second stone courtyard. They are not
confusable.

### Punch

| | Fundamental | −20 dB decay | −40 dB decay | Total (−50 dB) | Peak |
|---|---:|---:|---:|---:|---:|
| `contact` | **1999.9 Hz** | 80 ms | 89 ms | 374 ms* | 0.622 |
| `touchfree` | **2603.5 Hz** | 47 ms | 79 ms | 504 ms* | 0.566 |

Fundamentals land within 0.15% of their design targets (2000 / 2600 Hz).
\* Total includes the reverb tail; the beep itself is 88 / 56 ms.

### Breathing — glycogen 1.0 vs 0.2

Both at 3.4 m/s, 40 s renders.

| Glycogen | Breaths/min | Centroid | RMS | Envelope autocorrelation |
|---:|---:|---:|---:|---:|
| 1.00 | 33.3 | 2565 Hz | −24.4 dB | 0.901 |
| 0.60 | 45.3 | 2964 Hz | −20.4 dB | 0.754 |
| 0.20 | **58.1** | **3765 Hz** | **−19.2 dB** | **0.544** |

1.0 → 0.2 is **+74% rate, +47% centroid, +5.2 dB level**. Chrome agrees:
33.2 → 58.1 /min, 2699 → 4238 Hz, −27.4 → −22.9 dB.

The autocorrelation column is the one I care about most. It falls 0.901 → 0.544:
the breath does not merely get faster, it stops being *regular*. That is the
raggedness, the catch and the timing jitter showing up as a number.

### Reverb spaces

Dirac through the real convolver path.

| Space | RT−20 | RT−40 | Tail (−55 dB) | Centroid |
|---|---:|---:|---:|---:|
| `denseSpruce` | 56 ms | 205 ms | 411 ms | 6127 Hz |
| `openForest` | 110 ms | 435 ms | 806 ms | 6988 Hz |
| `openArena` | 162 ms | 633 ms | 1102 ms | 7450 Hz |
| `stoneCourtyard` | **320 ms** | **1216 ms** | **2246 ms** | **8279 Hz** |

The courtyard is **2.9× longer and 18% brighter** than the open forest, which is
the requirement, and `denseSpruce` is nearly anechoic at a fifth the length —
the absence of a tail is what sells a thicket.

### Ambience — loop detection

Normalised envelope autocorrelation over lags 1–30 s, on a 60 s forest render.

| Case | Peak correlation | At lag | Peak above 2 s |
|---|---:|---:|---:|
| `ambience/forest` (60 s) | **0.209** | 1.00 s | 0.160 |
| `ambience/arena` (30 s) | 0.365 | 1.00 s | 0.285 |
| `ambience/town` (45 s) | 0.365 | 8.79 s | 0.365 |
| **control: fixed 3 s loop** | **0.998** | **3.00 s** | 0.998 |

The control is the point. A genuinely looped 3.0 s pink-noise buffer through the
same detector reads 0.998 at exactly 3.00 s, with harmonics at 6, 9, 12 and 15 s.
The forest's strongest correlation is 0.209 and it sits at the *minimum* lag,
which is envelope smoothness, not periodicity. There is no loop to find.

### Music

60 s renders. Plucks isolated with a 900 Hz highpass, since the drone never
stops and would otherwise be counted.

| Tension | Gestures/min | Centroid | RMS | Peak |
|---|---:|---:|---:|---:|
| 0.05 | 32 | 353 Hz | −32.8 dB | 0.107 |
| 0.90 | **71** | 401 Hz | −31.2 dB | 0.143 |

Density **2.2×** with tension; level moves 1.6 dB. That ratio is the design.

### Full mixes

| Case | Peak | RMS | DC | Centroid |
|---|---:|---:|---:|---:|
| Arena, everything at once, punching, glycogen 0.2 | 0.895 | −17.9 dB | −7e−6 | 3302 Hz |
| Krumlov: cobbles, river, monastery, 4.8 m/s | 0.874 | −18.5 dB | −7e−6 | 4548 Hz |
| Forest wall: marsh, dark green, glycogen 0.12 | 0.623 | −19.6 dB | −1e−6 | 3480 Hz |

Chrome, same arena worst case: peak 0.715, RMS −20.9 dB, DC 1e−6.

### The map duck

| | RMS | Centroid | L/R correlation |
|---|---:|---:|---:|
| before | −22.97 dB | 2880 Hz | 0.102 |
| ducked | **−26.48 dB** | **1119 Hz** | **0.805** |
| after | −22.14 dB | 2781 Hz | 0.178 |

(Chrome; offline gives −24.03 → −28.17 dB and 2780 → 1117 Hz.)

Level −3.5 dB, centroid **−61%**, and L/R correlation 0.102 → 0.805 — the image
collapses most of the way to mono and opens again. The correlation column is the
one a level meter cannot see, and it is where most of the perceptual weight of
this gesture lives.

### Bells — inharmonic partial structure

Single strike, prime = 392 Hz (G4), dry.

| Measured | 196.3 | 392.6 | 467.4 | 589.2 | 786.6 | 980.8 | 1047.3 | 1176.9 Hz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Ratio to prime** | 0.501 | 1.002 | 1.192 | 1.503 | 2.007 | 2.502 | 2.672 | 3.002 |
| **Design** | 0.5 | 1.0 | 1.19 | 1.5 | 2.0 | 2.5 | 2.67 | 3.0 |
| **Name** | hum | prime | tierce | quint | nominal | deciem | undeciem | duodeciem |

Every partial lands within 0.3% of target. Ring decay 1072 ms (−20 dB) /
2168 ms (−40 dB); total 4.4 s.

---

## Budgets

| | |
|---|---|
| **Bundle** | **46.2 kB minified, 14.6 kB gzipped** |
| Audio buffers at 48 kHz | ~2.4 MB noise + ~2.3 MB IRs + ~1.9 MB struck/plucked ≈ 6.6 MB |
| Init cost | ~170 ms on desktop Chrome (noise 100 ms, IRs 60 ms, modal/KS 10 ms) |
| Live nodes at rest | ~230, of which ~150 are pooled voice biquads |
| Per-frame allocation | zero, except one `AudioBufferSourceNode` per one-shot |

The bundle **misses the brief's "well under 40 kB minified" by 6.2 kB**. Over the
wire it is 14.6 kB gzipped, which is the number that actually costs the player
anything, but the stated target is minified and I did not hit it. See below.

---

## Known weaknesses

Honest list, roughly in the order I would spend another pass on them.

1. **I have not heard any of this.** Every number here was measured, in both an
   offline renderer and a real browser, and the browser harness exists and works.
   But this environment has no audio output, so the mix has been *verified*, not
   *auditioned*. Some of these judgements — whether the marsh suck is convincing
   rather than comic, whether the breath at glycogen 0.2 crosses from unsettling
   into silly, whether the PA chatter reads as speech or as noise — cannot be
   settled by a spectral centroid. They need ears, and they should get a session
   with headphones before this ships.

2. **Bundle is 46.2 kB minified against a 40 kB target.** The two clean cuts are
   the bird library (~2.5 kB — five call types with per-species envelopes) and
   the river/town layer (~1.5 kB, only used at Krumlov and loadable lazily with
   the sprint venue). Doing both lands it around 42 kB. Getting under 40 would
   mean flattening the recipe tables into numeric arrays, which saves about a
   kilobyte and costs a great deal of readability; I did not think that trade was
   worth making without being asked.

3. **The map duck is −3.5 dB of level, which is shallower than it looks on
   paper.** The per-bus targets sum to more than that, but the master limiter
   gives some of it back — as input falls, gain reduction falls with it. The
   spectral and stereo movement carry the gesture, and I think that is the right
   character, but if it needs to feel deeper the fix is a post-limiter duck stage
   rather than deeper per-bus numbers.

4. **The music is very quiet** (−32 dB RMS against a −19 dB mix). That is
   deliberate restraint, and I would rather start there than start loud, but it
   is close to the edge of inaudible under the forest bed and the right level is
   an ears decision.

5. **`denseSpruce` is built but never selected.** `setEnvironment` maps forest →
   `openForest`. The intent is that the terrain layer switches it per-position
   when the athlete is inside ISOM 410 dark green, which would be a genuinely
   good cue — the world going dead around you as the vegetation closes. That hook
   does not exist yet; it needs a call from the physics layer.

6. **Wood pigeon and coal tit calls are the weakest synthesis in the set.** They
   are sine glides with a noise companion, and they are recognisable more by
   rhythm than by timbre. The jay and the woodpecker are much better because
   they are noise-based and their character *is* their noise. If bird realism
   matters, the tonal calls want a second formant and some spectral irregularity.

7. **The offline harness cannot measure `setTargetAtTime` natively** and depends
   on the shim described above. The shim agrees with Chrome to 0.7%, and the
   browser harness covers the same ground independently, so I am not worried —
   but it is a dependency on a workaround, and if `node-web-audio-api` fixes the
   bug the shim should be deleted rather than left in place.

8. **Not tested on real iOS Safari.** The unlock path follows the well-known
   requirements (no context before a gesture, resume plus a silent source inside
   the handler, `webkitAudioContext` fallback, no `AudioWorklet`) and the gesture
   and visibility paths were verified in Chrome — suspended → running →
   suspended → running. But an actual iPhone has not run this.
