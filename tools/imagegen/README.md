# tools/imagegen

Build-time image generation and PBR texture pipeline for **ORIENTAK: VYŠŠÍ BROD**.

**This runs only at build time.** The shipped game never calls an image API. It
loads static WebP files from `public/textures/` and `public/art/`, all of which
are committed. Nothing under `src/` may import anything from this directory.

---

## Layout

| File | Role |
|---|---|
| `manifest.json` | Source of truth. Every asset, its prompt, aspect, seed and per-material PBR tuning. |
| `generate.mjs` | Fetches missing images from Gemini, then derives outputs. Writes the lock. |
| `pbr.mjs` | Albedo → tileable albedo + normal + roughness + AO, at 1024/512/256. Also a library. |
| `ktx2.mjs` | GPU-compressed `.ktx2` emission (UASTC / ETC1S) alongside the WebP. |
| `validate.mjs` | Numeric tiling / baked-lighting validation. The build gate. |
| `inspect.mjs` | Dev-only contact sheets for eyeballing. No API calls. |
| `manifest.lock.json` | Provenance: prompt hash, seed, model, and a sha256 per output file. **Committed.** |
| `ktx2-report.json` | Per-file KTX2 size / format / mip-count record from the last run. **Committed.** |
| `.cache/` | Raw model output, one PNG per asset. **Gitignored.** Re-runs are free while it exists. |

```
npm run gen:images                                  # fetch what is missing, derive everything
npm run gen:images -- --only=moss,granite-boulder   # a subset
npm run gen:images -- --force                       # re-fetch (spends API calls)
npm run gen:pbr                                     # re-derive from .cache only, no API calls
npm run gen:ktx2                                    # GPU-compressed .ktx2 (~7 min, no API calls)
npm run gen:ktx2 -- --measure                       # + PSNR / angular error per file
npm run gen:ktx2 -- --report                        # re-print the summary, no re-encode
npm run gen:ktx2 -- --scan                          # rebuild the report from files on disk
npm run gen:validate                                # the gate
node tools/imagegen/validate.mjs --selftest         # prove derived maps wrap
node tools/imagegen/inspect.mjs                     # contact sheets into .cache/_inspect/
```

## API key

`GEMINI_API_KEY` lives in `.env.local` at the repo root, which is gitignored.
`generate.mjs` parses it itself, so no `--env-file` flag and no dotenv
dependency is needed. The key is never logged and never written into the lock.
Model and concurrency can be overridden with `GEMINI_MODEL` and `CONCURRENCY`
(default `gemini-2.5-flash-image`, 3).

---

## Content rules

These are hard constraints, not preferences. They are encoded in the two
`negativePrompt` blocks in `manifest.json` and must stay there.

- **Never** generate logos, brand marks, product packaging, jersey sponsors, bib
  numbers, real people's faces, or anything resembling Enervit / WCUP26 / ČSOS /
  SportIdent branding. If a prompt *could* plausibly produce a logo, the prompt
  is wrong — rewrite it, do not filter the output.
- **No text of any kind** in any generated image. Every negative prompt carries
  "no text, no lettering, no watermark, no logo, no signage".
- Textures are flat-lit and seamless. No baked shadows, highlights or vignette —
  `validate.mjs` measures this, see *Thresholds* below.
- Architecture is described generically ("a historic South Bohemian town"), never
  by naming a landmark, so the output cannot become a recognisable trademarked
  view.

---

## The PBR pass

Per texture, `pbr.mjs` does the following. Every neighbourhood operator in the
chain wraps; nothing in it breaks the tiling it just created.

### 1. Make it tileable

Offset the image 50% in both axes. That moves the photograph's real
discontinuity from the (now continuous) outer border into an interior cross at
the tile centre, where it can be worked on. The cross is then healed twice:

**a. Membrane / 1-D Poisson correction.** For each row, take the jump across the
seam, low-pass it along the seam, and spread the correction outwards. On a
circular 1-D domain the harmonic solution to a single jump is a constant-slope
ramp, so the correction is exactly linear in distance from the seam and reaches
zero at the outer border. Only the low-frequency part of the jump is spread —
spreading the high-frequency part would imprint streaks along the seam. This
removes the tonal step.

**b. Variance-preserving mirrored cross-blend.** In a narrow band (~12 px at
1024), each pixel is blended with its mirror image about the seam, with weight
exactly 0.5 *at* the seam so the two straddling pixels become identical and C0
continuity is guaranteed rather than approached.

A plain blend of two independent texture samples scales local standard deviation
by `sqrt((1-t)² + t²)` — 0.707 at the seam. That is what makes a crude alpha
fade visible: a soft low-contrast stripe down the middle of the tile. Measured on
`granite-boulder`, column standard deviation dropped from 36 to **21.7** at the
seam. So the deviation from the (also blended) local mean is divided back out by
that factor, which restored it to **30.7** and removed the stripe. The correction
is symmetric in the two samples, so continuity survives it exactly.

### 2. De-shade

Divide by a heavily wrap-blurred luminance field (homomorphic filtering). Two
jobs at once: the model bakes broad illumination into every generation no matter
what the prompt says, and the membrane solve leaves a constant-slope ramp by
construction. Both are purely low-frequency, so one operation removes both.

It runs **after** the tiling pass — the blur wraps, so the correction field is
itself tileable and the seam fix is preserved. It is a fixed point, and one pass
leaves about 25% of a strong vignette behind (measured 0.23 → 0.084 → 0.049 on
`forest-floor-needles`), so it iterates twice by default.

### 3. Height

Linear luminance, high-passed against a blur at 1/8 of the tile width so broad
albedo variation does not become geometry — otherwise a dark lichen patch turns
into a crater — while per-cobble scale structure survives. Then softened by
`heightBlur`.

### 4. Normal

Wrap-aware Sobel on the height, normalised, encoded to tangent space with
**OpenGL green-up** convention (image +Y is down, texture V is up, so
`n.y = +gy`). This is what three.js expects.

### 5. Roughness

Local standard deviation of luminance over a ~4 px window (`blur(L²) - blur(L)²`),
normalised between its 5th and 95th percentiles, then remapped into the
material's `roughRange`. Rock is rougher than wet leaf because the manifest says
so, not because the maths guesses.

### 6. AO

Multi-scale cavity: `blur_σ(h) - h` summed over σ = 3, 9, 24, 56 px with
weights 0.34 / 0.29 / 0.22 / 0.15. Normalised against the 98th percentile of the
occlusion field rather than a fixed gain — the raw cavity depth depends on how
contrasty a given albedo happened to be, and without this `aoStrength` would mean
something different for every texture.

### 7. Output

`public/textures/<id>/{albedo,normal,roughness,ao}.webp` at 1024, plus `@512`
and `@256` for the low tier. Down-scales are exact 2× and 4× box filters
computed in-process, which are wrap-safe by construction — a resampler with a
wide kernel would bleed across the edge and undo the tiling. Normal mips are
re-normalised after averaging, or they go flat.

**Normals are encoded near-lossless.** A tangent-space normal map is a vector
field, not a picture. Measured on `moss/normal` at 1024 — max per-channel error
versus the uncompressed map, and the rank of the wrap boundary among all 1023
possible cut columns, where ~0.5 means "indistinguishable from any other cut":

| encoding | size | max err | boundary rank |
|---|---|---|---|
| lossless | 1354 KB | 0 | 0.54 |
| **nearLossless q60** | **706 KB** | **2** | **0.49** |
| nearLossless q40 | 534 KB | 4 | 0.08 |
| lossy q96 | 346 KB | 25 | 0.96 |
| lossy q100 | 451 KB | 23 | 0.96 |

Lossy fails at *any* quality — it quantises x/y into flat facets and puts a
measurable discontinuity at the border. `nearLossless q60` halves the file for a
2/255 worst case, under one degree of angular error.

---

## GPU-compressed textures (KTX2 / Basis)

`ktx2.mjs` emits a `.ktx2` next to every `.webp`. Encoder is the official
Binomial `basisu` 1.16.3, installed from npm as `@gpu-tex-enc/basis` (Apache-2.0,
prebuilt binaries for macOS/Linux/Windows on x64 and arm64).

### Why, when the WebP files are already small

WebP is a *transfer* format. It decodes to uncompressed RGBA8 in GPU memory, so
a 1024 map costs 4 MB of VRAM regardless of how small the file was. KTX2/Basis
stays compressed on the GPU and ships its mip chain pre-built.

### Format per map type

| map | mode | why |
|---|---|---|
| `normal` | **UASTC** → BC7 / ASTC 4x4 | 1 B/px, high precision |
| `albedo` | ETC1S → BC1 / ETC1 | 0.5 B/px, loss acceptable on colour |
| `roughness`, `ao` | ETC1S → BC1 / ETC1 | 0.5 B/px, low-frequency scalar data |

UASTC for normals is not a preference. Mean angular error of the decoded normal
against the source, measured at 1024:

| texture | UASTC (BC7) | ETC1S (BC1) |
|---|---|---|
| plaster-renaissance | **0.48°** | 1.13° |
| moss | **1.72°** | 4.87° |
| cobble-krumlov | **2.53°** | 7.73° |

7.7° of mean angular error would visibly wreck specular response on the cobbles.

Settings were swept, not guessed (1024, PSNR against the transcoded result):

| albedo, ETC1S | size | moss | plaster | cobble |
|---|---|---|---|---|
| q128 c1 | 157–177 KB | 24.2 dB | 31.2 dB | 24.9 dB |
| q200 c2 | 215–247 KB | 25.5 | 33.1 | 26.4 |
| **q255 c2** | **243–276 KB** | **26.0** | **33.6** | **27.0** |
| max_endpoints/selectors c4 | 227–249 KB | 25.8 | 33.2 | 26.8 |

`max_endpoints`/`max_selectors` at comp_level 4 is no better than `q255 c2` and
much slower. For normals, `-uastc_level 3 -uastc_rdo_l 0.5` beat
`-uastc_level 2 -uastc_rdo_l 0.6` on all three textures for about 1% more bytes.

### Tiling survives

basisu generates mipmaps with **wrapping** addressing by default; `-mip_clamp`
is opt-in. Never pass it — clamped mip filtering pulls the opposite edge in and
would undo the seam work at every mip level. `-mip_renorm` is set for normals so
the chain does not drift off the unit sphere and go flat at distance.

KTX2 encodes from the raw maps out of `pbr.mjs`, never from the WebP files, so a
`.ktx2` is never a lossy re-encode of a lossy encode.

### Measured result

```
map (mode)           files  WebP MB  KTX2 MB   ratio  mips
albedo (etc1s)          48    12.07     6.37   1.90x  11/10/9
normal (uastc)          48    17.57    23.35   0.75x  11/10/9
roughness (etc1s)       48     1.39     3.65   0.38x  11/10/9
ao (etc1s)              48     7.92     4.82   1.64x  11/10/9
TOTAL                  192    38.95    38.20   1.02x

per-tier budget (a device downloads exactly one of these rows, 16 materials):
  1024px  download 27.38 -> 27.50 MB   VRAM 341.33 -> 53.33 MB  (6.4x less)
   512px  download  9.18 ->  8.44 MB   VRAM  85.33 -> 13.33 MB  (6.4x less)
   256px  download  2.39 ->  2.25 MB   VRAM  21.33 ->  3.33 MB  (6.4x less)
```

**Read the per-tier rows, not the total.** The 39 MB figure is the whole build
artefact across all three capability tiers; no device fetches more than one.
`public/textures/` on disk is ~92 MB because it now holds both encodings — 39 MB
of WebP plus 38 MB of KTX2 plus container overhead. That is a build artefact, not
a payload. Once the loader settles on KTX2 for every tier the WebP set can be
dropped, or kept only as the no-compressed-texture-support fallback.

**The win is VRAM, not download — 6.4x at every tier.** On download KTX2 is a
wash overall: albedo is 1.9x smaller and AO 1.6x, but UASTC normals are 1.3x
*larger* than near-lossless WebP (8 bpp is fixed-rate) and ETC1S roughness is
2.6x larger, because a smooth grayscale map is exactly what WebP is best at and
exactly what a fixed-rate block codec is worst at. The KTX2 files also carry a
mip chain the WebP files do not, which is a third of their size.

The mobile budget is met by the 256 tier: **2.25 MB download, 3.3 MB VRAM** for
all sixteen materials.

### Visible artifacts

Checked source against transcoded output at 1:1 and at 3x nearest-neighbour on
the worst cases (`moss`, `granite-boulder` albedo; `cobble-krumlov` normal):

- No block artifacts, banding or colour shift are visible at any zoom.
- ETC1S loses some of the finest chroma detail. Most visible on `moss`, where
  the fine yellow-green speckle softens slightly. Visible only at 3x on a
  side-by-side; not visible at 1:1.
- UASTC normals are essentially indistinguishable from source.

The low albedo PSNR (26 dB on moss and cobble) reads worse than it looks: BC1's
error on noise-like content is itself noise-like, so PSNR is a poor predictor of
perceptual quality here. Trust the side-by-side over the number, and regenerate
it with `--measure` plus a crop comparison if a texture ever looks wrong.

### Not adopted

- **RG-swizzled normals** (store x and y, reconstruct z in the shader) are the
  usual way to shrink normal maps. Measured here it saved nothing —
  1196 vs 1202 KB on cobble, and *larger* on moss and plaster — because the
  UASTC block is fixed-rate and zstd was already exploiting the flat blue
  channel. Not worth the shader change.
- **Packing AO into R and roughness into G of one texture** (ORM style) would
  halve the scalar-map count and take roughly 8.5 MB off the total. It is the
  obvious next win, but it changes what the loader binds, so it belongs with the
  material code rather than here.

---

## Validation

`validate.mjs` runs three real measurements. No eyeballing.

**A. Seam energy.** Mean absolute difference across the wrap boundary versus the
distribution of MADs between every interior adjacent line pair:

```
ratio = MAD(boundary) / mean(MAD(interior))
z     = (MAD(boundary) - mean) / stddev
```

A texture that tiles has `ratio ≈ 1.0` — the wrap is statistically
indistinguishable from any other place you could have cut the image.

**B. Repetition banding.** Circular autocorrelation of mean-subtracted luminance
via FFT (`ACF = IFFT(|FFT(x)|²)`), per row and per column, averaged.

- `acf` — peak over lags `[N/8, N/2]`, i.e. periods of 2–8 repeats per tile.
  **This is the gated number.** Structure at that scale is what makes the eye
  lock onto the tile grid across a terrain patch.
- `acfAll` — strongest *local maximum* over lags `[8, N/2]`, informational. This
  is the material's own rhythm (roof-tile courses, masonry beds, bark ribs) and
  is not a defect. A local maximum is used rather than a plain max because the
  plain max over short lags is just the short-range correlation decay every
  photograph has, which carries no information.

**C. Baked illumination.** Least-squares fit of a linear ramp `a·x + b·y + c` and
of a radial `r²` vignette term to the luminance field, reported as peak-to-peak
swing relative to mean luminance. Textures must be flat-lit, so both must be
near zero.

### Thresholds

| check | limit | why this number |
|---|---|---|
| `seamRatio` | ≤ 1.25 | calibrated, see below |
| `seamZ` | ≤ 2.5 | calibrated, see below |
| `rank` | reported, not gated | non-parametric cross-check, see below |
| `acfPeak` | ≤ 0.30 | above this the tile period is visible across a terrain patch |
| `illumRamp` | ≤ 0.06 | 6% brightness swing across the tile |
| `illumVignette` | ≤ 0.05 | 5% centre-to-corner falloff |

The seam thresholds are calibrated against a control, not guessed. Measuring the
raw generated PNGs — whose wrap boundary is a genuine photographic cut — against
the shipped tiles gave:

| population | seam ratio | z |
|---|---|---|
| raw, untreated | 1.18 … 2.29 | 2.8 … 16.6 |
| shipped tiles | 0.92 … 1.11 | −1.3 … 1.5 |

1.25 / 2.5 sits in the gap. It flags 11 of the 12 control axes and clears all 16
shipped textures. To re-run that calibration after changing the pipeline,
compare `.cache/<id>.png` against `public/textures/<id>/albedo.webp`.

### Scope of the gate

The gate is **the albedo**. That is the map the tiling pass operates on, and the
only one where "baked lighting" is a meaningful concept — a brightness ramp in a
roughness map just means one side of the material is genuinely rougher.

`normal`, `roughness` and `ao` are derived from the tiled albedo using
exclusively wrap-around operators, so they inherit its tiling *by construction*.
`--selftest` proves this mechanically instead of asserting it: a pipeline built
only from wrapping operators is equivariant under a circular shift, so

```
maps(roll(albedo, d)) == roll(maps(albedo), d)
```

must hold to the last bit. It currently holds exactly (max difference 0). If
anyone later swaps in a clamped blur or a non-wrapping Sobel, that test fails
immediately. Running `--map=` anything other than albedo is therefore diagnostic
and never fails the build.

### Per-asset overrides

Some materials are genuinely periodic. `roof-tile-bohemian` peaks at the tile
course spacing (~152 px at 1024, ~38 px at 256) — that rhythm is the roof, not a
tiling defect. Rather than loosen the global threshold, add a `validate` block to
that asset in `manifest.json` and explain it in its `notes`:

```json
"validate": { "acfPeak": 0.45 },
"notes": "Genuinely periodic material: the ACF peaks at the tile-course spacing …"
```

Overridden rows are marked `*` in the table, so an exception is always visible
rather than silently folded into the thresholds.

**`rank` is the statistic to trust when `ratio` and `z` disagree.** It is the
fraction of all possible cut positions that are *better* than the wrap boundary,
so 1.000 means the boundary is the single worst place you could have cut the
image — the signature of an unhealed seam — and ~0.5 means it is an ordinary
place to cut. It is immune to the heavy-tailed MAD distributions that strongly
structured materials produce. `roof-tile-bohemian` at 256 reads `ratio` 1.43,
which looks alarming, but `z` 0.9 and `rank` 0.86, which do not; the row-MAD
spread is 2.0 to 30.7 because rows through the tile crowns are nothing like rows
through the troughs. There is no seam there, confirmed visually.

**`acf` rises as resolution falls, for any structured material.** Decimation
averages away the uncorrelated high-frequency component that sits in the
autocorrelation's denominator, leaving the regular structure a larger share of
the total. `roof-tile-bohemian` measures 0.44 / 0.54 / 0.64 at 1024 / 512 / 256
— the same roof, not a worse tile. Set an override above the *lowest* tier you
ship, and validate all three (`--size=512`, `--size=256`).

---

## Adding a texture

1. Add an entry to `assets` in `manifest.json`:

```json
{
  "id": "fern-understory",
  "kind": "texture",
  "category": "ground",
  "aspect": "1:1",
  "seed": 10307,
  "tileable": true,
  "pbr": true,
  "prompt": "…seen straight down from above, filling the entire frame. …",
  "material": {
    "heightStrength": 1.0,
    "roughRange": [0.6, 0.9],
    "aoStrength": 0.9,
    "heightBlur": 0.7
  },
  "notes": "What this is for, and anything surprising about it."
}
```

   `styleAnchor.texture` and `negativePrompt.texture` are appended automatically —
   do not repeat them in the prompt. Write the prompt as *what the surface is*,
   at a stated physical scale, with "filling the entire frame" and an explicit
   list of what must not appear (`no boulder outline, no edges, no ground around
   it`). The model drifts toward composing a photograph unless told not to.

2. `node tools/imagegen/generate.mjs --only=fern-understory`
3. `node tools/imagegen/inspect.mjs --only=fern-understory` and **look at it**.
   `.tile2x2.png` shows seams immediately; `.maps.png` shows the four maps.
4. `node tools/imagegen/validate.mjs --only=fern-understory`
5. Iterating the *prompt* costs an API call (`--force`). Iterating `material`
   costs nothing — `npm run gen:pbr` re-derives from `.cache/`.
6. Commit `manifest.json`, `manifest.lock.json` and `public/textures/<id>/`.

### Material tuning

| field | effect |
|---|---|
| `heightStrength` | normal map intensity. 0.6 smooth plaster … 1.6 cobbles. |
| `roughRange` | `[low, high]` roughness after remap. Wet leaf ~0.42, moss ~0.98. |
| `aoStrength` | how dark the deepest 2% of cavities get. 0.5 flat … 1.0 deep joints. |
| `heightBlur` | softens height before the Sobel. Raise it if the normal map looks noisy. |
| `deshadeDiv` | de-shade blur radius as 1/N of width. Lower N = gentler. |
| `deshadePasses` | raise to 3 if a stubborn vignette survives. |
| `mirrorBand` | seam blend width as a fraction of width. Widen for structured materials. |
| `membrane` | fraction of the half-width the Poisson correction spreads over. 1.0 is harmonic. |

## Adding art

Same, with `"kind": "art"`, `"pbr": false`, `"tileable": false` and an aspect of
`16:9` (backdrops, loading) or `1:1` (badges). Output goes to
`public/art/<category>/<id>.webp` plus an `@half` variant.

Assets with `"mask": "circle"` get a feathered circular alpha channel. Badges use
it: the model returns art on whatever corner background it feels like — black,
white, green — which reads as an inconsistent set once six of them sit in a row
in the UI. Masking to the circle the art is already composed for removes the
corners entirely.

---

## The lock file

`manifest.lock.json` is committed and records, per asset: `promptHash`, `seed`,
`model`, `aspect`, the cached source's size and sha256, and every output file's
path, size and sha256. It never contains the API key.

It answers "did this file change, and why" — a differing `promptHash` means
someone edited the prompt, a differing output `sha256` with the same `promptHash`
means the PBR pass changed. Re-running with everything cached produces a
byte-identical lock apart from `updatedAt`, so it does not churn.

`.cache/` is gitignored, so a fresh clone has no raw PNGs. The committed WebP
files are the deliverable; the lock tells you what produced them. Regenerating
from scratch will *not* reproduce the same bytes — the model is not
deterministic and the endpoint takes no seed parameter. `seed` is recorded for
provenance and bookkeeping, not reproducibility. Treat the committed outputs as
the source of truth and only `--force` deliberately.

## Known limitations

- **Height comes from albedo luminance.** It is a heuristic, not a
  measurement. The 1/8-width high-pass stops broad colour variation becoming
  geometry, but a very dark feature that is genuinely flush with the surface
  will still read as slightly recessed.
- **Roughness comes from local contrast.** Also a heuristic. On
  `forest-floor-needles` the twigs read as rougher than the needle mat because
  they have higher local contrast, which is backwards physically. Acceptable at
  the scale these are viewed.
- **ETC1S albedo is genuinely lossy** at 26 dB PSNR on high-frequency textures.
  It survives visual inspection at 3x, but a hero close-up material (the cobbles
  underfoot on a sprint leg) may warrant a per-asset `ktx2` override to UASTC.
  The override mechanism exists; nothing uses it yet.
- **Roughness and AO ship as separate single-channel textures.** Packing them
  into one RG texture is the biggest remaining size win (~8.5 MB) and halves the
  scalar bindings, but it is a loader change.
- The seam heal superimposes two independent samples in a ~12 px band. On
  noise-like materials this is invisible; on strongly structured ones it is a
  faint ghost. A min-error boundary cut (image-quilting style) would avoid it and
  is the natural upgrade if a texture ever needs it.
