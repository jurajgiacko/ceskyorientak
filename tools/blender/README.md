# Blender asset pipeline

Headless, reproducible 3D asset generation for **ORIENTAK: VYŠŠÍ BROD**.

Every model in `public/models/` is produced by a Python script in `assets/`,
run by Blender in `--background` mode. There is no `.blend` file anywhere in
this repo and no GUI step in the build: **the source of truth is the code**.
Delete `public/models/` and `npm run gen:models` reconstructs every asset
**byte for byte** for a given seed — same triangle counts, same vertex data,
same materials, same bytes on disk. Draco included: the encoder spent a while
under suspicion for this and is in fact deterministic (see "Things that bit
us"). A rebuild that leaves `git status` dirty means something really changed.

Worth re-checking whenever the pipeline is touched — two forced rebuilds have
to agree:

```sh
node tools/blender/build.mjs --force && md5 -q public/models/*.glb > /tmp/a
node tools/blender/build.mjs --force && md5 -q public/models/*.glb > /tmp/b
diff /tmp/a /tmp/b && echo reproducible
```

## Verified Blender binary

```
/Applications/Blender.app/Contents/MacOS/Blender
```

Blender **4.5.12 LTS** (arm64, macOS). Installed from the official
`https://download.blender.org/release/Blender4.5/blender-4.5.12-macos-arm64.dmg`.

Headless scripting is verified with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --version
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python-expr "import bpy;print('BPY OK', bpy.app.version_string)"
```

Override the binary anywhere in the pipeline with `$BLENDER`.

## Running it

```sh
npm run gen:models                                # build everything that is stale
node tools/blender/build.mjs --force              # rebuild everything
node tools/blender/build.mjs --only spruce,beech  # build a subset
node tools/blender/build.mjs --previews           # build, then render preview sheets
node tools/blender/build.mjs --jobs 6 --seed 123  # parallelism / different seed

node tools/blender/validate.mjs                   # parse + check every .glb
node tools/blender/validate.mjs --markdown        # the results table below
```

Render one preview by hand:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python tools/blender/preview.py -- \
  --glb public/models/spruce.glb --out tools/blender/previews/spruce.png --lod 0
```

## How it works

```
tools/blender/
├── build.mjs        Node driver: runs each asset script in its own Blender
│                    process, in parallel, skipping up-to-date outputs, and
│                    writes public/models/manifest.json
├── validate.mjs     Parses every .glb with @gltf-transform and enforces budgets
├── preview.py       Imports a .glb and renders a 4-angle turntable sheet
├── assets/<name>.py One script per asset -> public/models/<name>.glb
├── lib/             Shared helpers (see below)
├── previews/        Rendered verification sheets (committed)
└── .cache/          Build state + generated textures (gitignored)
```

**build.mjs** launches `Blender --background --factory-startup --python
assets/<name>.py -- --out public/models --seed N`. Blender processes share
nothing, so they parallelise safely; the driver defaults to
`min(4, cpus-1)` jobs.

Each asset script prints one `ASSETMETA {json}` line per exported file. The
driver scrapes those lines — metadata is never written to a side file, so a
crashed run cannot leave stale numbers behind.

**Incremental builds** hash the asset script + every file in `lib/` + the
Blender version string + the seed. If the hash matches the recorded one *and*
the outputs still exist, the asset is skipped. mtimes are deliberately not used
(a fresh checkout would rebuild the world).

**Determinism.** Nothing calls `random` directly. Every random draw goes
through `lib/rng.py`'s `DRNG`, which derives its stream from
`sha256(seed ‖ path)`. `rng.sub("branch3")` gives an independent stream, so
adding a draw in one part of an asset does not shift the numbers seen
anywhere else — diffs stay local. `mathutils.noise` is pinned via
`seed_blender_noise()`. Same seed ⇒ identical geometry.

### Why `bmesh`, not `bpy.ops`

Almost all of `lib/` is written against `bmesh` and the data API rather than
operators. Operators need a UI context that does not exist under
`--background`, and the ones that do work there are order- and
selection-sensitive. `M.shade_smooth()`, for instance, marks sharp edges by
computing face angles by hand rather than calling
`bpy.ops.object.shade_smooth_by_angle` — same result, no context, and
deterministic. The exceptions are the glTF exporter/importer and the render
operator, which are genuinely file/render operators and behave headlessly.

## Library

| Module | Contents |
|---|---|
| `lib/rng.py` | `DRNG` — seeded, hierarchical, reproducible RNG; `seed_blender_noise()` |
| `lib/mesh.py` | Scene reset, `from_pydata`, modifiers (`subsurf`, `solidify`, `decimate`, `weld`), `bevel`, `triangulate`, `shade_smooth`, `join`, `tri_count`, primitives (`cube`, `icosphere`, `cylinder`, `plane`), sweeps (`tube`, `revolve`, `param_surface`, `rounded_box`), deformers (`displace`, `noise_displace`, `taper_z`, `bend_z`, `cut_plane`) |
| `lib/mat.py` | `principled()`, `image_material()` (alpha-cutout foliage), face assignment helpers, shared colour palette |
| `lib/scatter.py` | `disc_points`, `ring_points`, `golden_ring`, `surface_samples`, `vary_matrix`, `instance`, `frame_from_normal`, `card` |
| `lib/lod.py` | `decimate_lods()`, `assemble_lods()`, `crossed_billboard()` imposters, `report()` |
| `lib/uvtools.py` | `cube_project`, `cylinder_project`, `sphere_project`, `smart_uv` (operator with box-projection fallback), `set_face_uv_rect` (used for the branded banner island) |
| `lib/tex.py` | Hand-rolled PNG writer, `Canvas` (capsule/leaf SDF compositing), `spruce_spray`, `beech_cluster`, `build_atlas`, `atlas_uv_rect` |
| `lib/exporter.py` | `export_glb()` (Draco optional), `emit_meta()` |
| `lib/cli.py` | Arg parsing after `--`, scene setup, output/cache paths |

Foliage textures are drawn into a numpy buffer and written as PNG by hand
(zlib + CRC32) rather than through Blender's image saving, which would run the
pixels through colour management. What is drawn is exactly what lands in the
`.glb`.

### Sweeps

`M.tube()` uses rotation-minimising frames (double reflection), so a swept
profile does not twist through bends — this is what keeps branches, tripod
legs and truss members clean.

## Conventions

- **Units are metres, Z-up.** glTF export converts to Y-up for three.js.
- **Origin** sits at the ground-contact point (base of trunk, bottom of foot).
  Assets that differ say so in the manifest's `originNote`.
- **One `.glb` per asset**, containing every LOD and every variant.
- **Node naming** is what the runtime keys off:
  - single variant → `<asset>_LOD0`, `<asset>_LOD1`, `<asset>_LOD2`
  - multiple variants → `<asset>_v0_LOD0`, `<asset>_v0_LOD1`, … `<asset>_v1_LOD0`, …
- **LOD ratios** are `1.0 / 0.40 / 0.12` of LOD0 triangles by default. Trees are
  the exception: their LOD1 is *rebuilt* with fewer, larger foliage cards
  (decimation destroys cards), and their LOD2 is a crossed-quad billboard
  imposter textured from an orthographic render of LOD0.
- **Vertex colour is a legitimate channel** and `spruce` uses it: crown
  occlusion is baked into `COLOR_0`, which glTF multiplies into base colour and
  three.js honours for free. Two things it needs. The Blender-side multiply must
  use the 4.x `ShaderNodeMix` (data_type RGBA) — the legacy `MixRGB` makes the
  exporter drop `baseColorFactor` to white, silently. And `export_glb` should be
  passed `vertex_color="NAME"`, so the attribute is exported because the asset
  says so rather than because the shader graph happens to read it.
- **Draco** is enabled per asset in `build.mjs`'s `DRACO` set — on for the dense
  natural assets, off for small props where the container overhead exceeds the
  saving.
- **No branding anywhere in the geometry.** `finish-gantry` carries a
  `BRAND_BANNER` material whose UV island fills 0..1 so brand art can be
  texture-mapped on later without touching the mesh.

## Manifest

`public/models/manifest.json` is the runtime's index:

```json
{
  "generator": "blender-asset-pipeline (Blender 4.5.12 LTS)",
  "seed": 20260805,
  "totalLod0Tris": 0,
  "assets": [
    { "name": "...", "file": "...glb", "bytes": 0, "tris": 0,
      "lods": [{ "node": "..._LOD0", "tris": 0 }] }
  ]
}
```

`tris` is the LOD0 cost of one full instance, summed across variants for
multi-variant assets.

## Verification results

Numbers below come from `node tools/blender/validate.mjs --markdown`, which
parses the actual shipped `.glb` files with `@gltf-transform/core` (Draco
decoded via `draco3dgltf`) — they are not self-reported by the build.

<!-- VALIDATION_TABLE_START -->
_Generated 2026-08-01 by `node tools/blender/validate.mjs --write-readme`._

| Asset | LOD0 tris | All LODs | Meshes | Materials | Textures | Size | Draco | Status |
|---|---:|---:|---:|---:|---:|---:|:-:|---|
| `arena-tent` | 912 | 1276 (LOD0:912 LOD1:364) | 2 | 2 | 0 | 52.9 KB | no | OK |
| `beech` | 10840 | 13922 (LOD0:10840 LOD1:3070 LOD2:12) | 9 | 3 | 3 | 471.9 KB | yes | OK |
| `boulder-set` | 8520 | 12780 (LOD0:8520 LOD1:3408 LOD2:852) | 18 | 4 | 0 | 141.8 KB | yes | OK |
| `control-flag` | 464 | 703 (LOD0:464 LOD1:184 LOD2:55) | 3 | 4 | 0 | 38.4 KB | no | OK |
| `control-stand` | 756 | 1146 (LOD0:756 LOD1:302 LOD2:88) | 3 | 2 | 0 | 43.8 KB | no | OK |
| `deadwood` | 3038 | 4582 (LOD0:3038 LOD1:1212 LOD2:332) | 9 | 4 | 0 | 83.1 KB | yes | OK |
| `finish-gantry` | 1728 | 2404 (LOD0:1728 LOD1:676) | 2 | 3 | 0 | 36.4 KB | yes | OK |
| `orienteer` | 12736 | 12736 (LOD0:12736) | 1 | 10 | 0 | 580.0 KB | no | OK |
| `race-belt` | 880 | 880 (LOD0:880) | 1 | 3 | 0 | 38.3 KB | no | OK |
| `si-unit` | 450 | 684 (LOD0:450 LOD1:180 LOD2:54) | 3 | 3 | 0 | 39.6 KB | no | OK |
| `spectator-fence` | 480 | 721 (LOD0:480 LOD1:191 LOD2:50) | 3 | 2 | 0 | 48.2 KB | no | OK |
| `spruce` | 18904 | 26178 (LOD0:18904 LOD1:7258 LOD2:16) | 12 | 7 | 6 | 987.4 KB | yes | OK |

**Total: 12 assets, 59708 LOD0 triangles, 2561.9 KB on disk.**
<!-- VALIDATION_TABLE_END -->

Preview sheets for every asset are in [`previews/`](previews/), rendered from
the exported `.glb` — not from the in-memory build scene, so they verify the
shipped file. Single-variant assets get four yaw angles in a 2x2 grid;
multi-variant assets get one column per variant at two yaw angles, each variant
re-centred on its own bounds by the preview tool.

## Triangle budgets

Enforced by `validate.mjs`; exceeding one fails the build.

| Asset | LOD0 budget | Notes |
|---|---:|---|
| `control-flag` | 600 | instanced per control |
| `control-stand` | 800 | instanced per control |
| `si-unit` | 500 | instanced per control |
| `boulder-set` | 9000 | 6 variants, ~1500 each |
| `spruce` | 20000 | 4 variants, ~4700 each |
| `beech` | 11000 | 3 variants |
| `deadwood` | 3600 | 3 variants |
| `race-belt` | 1000 | first-person prop, LOD0 only |
| `finish-gantry` | 2200 | one-off |
| `arena-tent` | 1400 | one-off |
| `spectator-fence` | 600 | tiles along +X |

The per-asset numbers deliberately sum to more than the global cap so one asset
can borrow another's slack. The **global ceiling of 60,000 LOD0 triangles** is
what is actually enforced (`TOTAL_LOD0_BUDGET` in `validate.mjs`), because these
are instanced heavily across the terrain and the sum is what the frame pays for.
Library size is a VRAM cost, not a frame cost — per-frame is governed by
`tools/perf/`, which measures instance count × the LOD actually drawn.

## Runtime notes

- **Bark PBR is bound at runtime, not embedded.** Trunk materials are named
  `spruce_bark` / `beech_bark` and carry a small (256 px) albedo so the `.glb`
  looks right standalone. The full sets in `public/textures/bark-*/`
  (albedo/normal/roughness/ao) should be bound by material name on load —
  embedding them per asset would have added megabytes to every tree, whereas
  bound at runtime one texture set serves every trunk in the forest. Trunk UVs
  are cylinder-projected and tile along the trunk axis (spruce: 0.7 m per
  vertical tile against two round the circumference, which is roughly square on
  the visible part of the bole), so they are ready for it.

  **This binding now happens.** `conditionAssetMaterial` in
  `src/world/materials.ts` takes `spruce_bark` by name and swaps in the full
  `detail.barkTrunk` set — albedo, normal and roughness, all at repeat 1.0 to
  match the cylinder projection. The embedded 256 px albedo is therefore only
  what makes the `.glb` look right opened standalone; nothing renders it in
  game, so it is free to shrink further if the payload ever needs it.

  Two things to know before touching that path:

  - **The trunk pack must stay at repeat 1.0.** `detail.bark` is at 1.6 for
    cube-projected surfaces (deadwood, branches) and is the wrong pack for a
    bole. At 1.6 the grain both stretches and slides the normal-map fissures
    off the albedo's.
  - **Swapping the albedo has to reapply `bake_bark_png`'s gain.** The embedded
    map is the shared one times (0.84, 0.84, 0.85); the full-resolution file is
    not. `BARK_BAKE_GAIN` in `materials.ts` puts it back, so the bole's value is
    unchanged and only its sharpness improves.

  `beech_bark` is deliberately left on its embedded albedo with no relief:
  `bark-beech` ships a normal/roughness set that would suit it, but binding it
  costs another ~1 MB of texture for a minority tree in a Šumava spruce stand.
  Spruce fissures are *not* an acceptable substitute there.
- **`spectator-fence` tiles at `repeatPitchX = 2.5 m`** along +X (in the
  manifest). Consecutive instances overlap only where the hook and eye interlock.
- **`finish-gantry`'s banner is single-sided**, so brand art reads un-mirrored
  from −Y and mirrored from +Y.
## Things that bit us (kept here so they don't again)

- **`join()` silently dropped UVs and sharp edges.** `bmesh.faces.new()`
  allocates fresh loops, which do not inherit loop data layers, and fresh edges
  default to smooth. Every mesh except the first collapsed to UV (0,0) — for an
  alpha-cutout atlas material that means the object samples one transparent
  texel and *vanishes*, which looked exactly like a renderer bug and cost real
  time to diagnose. Both are now copied explicitly in `join()`.
- **`apply_transform()` read a stale `matrix_world`.** `matrix_world` is derived
  lazily, so an object whose `.location` had just been set still reported
  identity. Since `join()` calls `apply_transform()` on every part, positioned
  parts silently snapped to the origin. Fixed with a `view_layer.update()`.
- **The preview rig was two stops hot.** Blender 4.x tone-maps through AgX, so
  blown highlights come back *desaturated* — every asset rendered as pale pastel
  regardless of its real base colour, and authors started darkening materials to
  compensate for the instrument. Total irradiance is now ~3.8. If assets ever
  look uniformly washed out again, check the rig before touching the materials.
- **Base colours are linear.** `mat.py`'s palette constants are linear values,
  not sRGB: `GRANITE_MID` at 0.235 linear is ≈0.52 sRGB. Judge them in a render,
  not by reading the number.
- **The glTF importer lays keyframes out at `time × scene fps`.** Verifying a
  30 fps clip in a 24 fps scene silently resamples it: frame 10 of a 20-frame
  cycle landed at 62% of the cycle instead of 50%, and an hour went into
  "why is the right arm below the frame" before the answer turned out to be
  the *harness*, not the asset. Any preview script that imports a skinned
  `.glb` must set `render.fps` **before** importing. (The harness this was
  found on, `preview-viewmodel.py`, went with the hands in D-036. The rule did
  not.)
- **Blender can crash under heavy parallelism.** Four concurrent instances
  segfaulted once during glTF export; the same asset built fine alone. `--jobs 2`
  is the safe setting on an 8-core machine.
- **`ShaderNodeMixRGB` breaks `baseColorFactor`.** Multiplying a Color Attribute
  into Base Color through the legacy MixRGB node makes the glTF exporter give up
  on finding the factor and write `[1,1,1,1]`. On a textured material you never
  notice; on an untextured one the surface turns *white*. The spruce deadwood
  stubs shipped as a ring of white spikes under every crown for one build.
  The 4.x `ShaderNodeMix` with `data_type="RGBA"` exports correctly.
- **A rendered PNG carries a timestamp, and it lands in the `.glb`.** Blender
  stamps `Date` (wall clock) and `RenderTime` into tEXt chunks of every PNG it
  writes itself. `spruce`'s four LOD2 imposters come out of
  `bpy.ops.render.render(write_still=True)` and are embedded verbatim, so
  `spruce.glb` was different bytes on *every* rebuild — at identical file size,
  identical triangle count and, as it turned out, bit-identical pixels: every
  IDAT chunk matched and only the two stamps differed. Draco was blamed for a
  long time, and `spruce` being both the largest mesh and the only asset
  embedding a raw render made that story fit. It was never Draco; the encoder
  is deterministic. `tex.strip_png_metadata()` copies through only the chunks
  that are the image (positive keep-list, so a chunk a future Blender starts
  writing is dropped rather than silently re-breaking this) and is called at
  the two places a Blender-written PNG enters the pipeline: after the imposter
  render, and inside `ensure_png()`. `beech` was accidentally immune the whole
  time because it re-packs its imposter cells through `tex.write_png()`.
- **An angle-based cylinder projection leaves a smeared seam facet.** `atan2`
  wraps, so the one column of quads spanning the wrap gets U running 1.99 → 0.0
  and samples the entire texture backwards into one twelfth of the trunk. Not
  visible in a turntable; very visible running past a 28 m bole. `close_uv_seam`
  in `assets/spruce.py` is the fix, and any future trunk wants it.

## Known limitations

- Material patches (lichen on boulders, bark-vs-bare-wood on deadwood) are
  assigned **per polygon**, so at very close range their edges follow the
  triangulation. At the tri counts these assets ship at that is only visible
  much closer than gameplay distance; fixing it properly needs a texture or
  vertex-colour mask rather than material slots.
- `deadwood`'s exposed bare wood currently reads slightly too bleached against
  its bark.
- `spruce`'s embedded bark albedo is 256 px, which is soft inside about 2 m.
  See the runtime note above: the fix is binding the shipped 1k `bark-spruce`
  set by material name, not growing the `.glb` (the map alone would be ~600 kB
  in every copy of the tree).
- `assets/_orienteer.py` is a **parked** full-body third-person athlete —
  rigged, 20 bones, four clips, 12,736 LOD0 triangles. It builds and exports
  clean; it is excluded from the build only because `discover()` skips
  `_`-prefixed scripts, and it is excluded because the library cannot afford
  12.7 k triangles under the then-60 k ceiling. Rename it to re-enable, and
  re-check the total. (Stale as written: the ceiling is 80 k, the athlete
  builds as `orienteer`, and it is in the table above.)
- `spruce` LOD1 reads a shade lighter than LOD0 — larger cards mean less
  card-on-card occlusion for the same vertex colours. It is close enough that
  the 36 m swap is not obvious, but it is not exact.

## Interactive Blender (optional)

For exploratory work in the Blender GUI there is an optional MCP bridge — see
[`docs/BLENDER_MCP_SETUP.md`](../../docs/BLENDER_MCP_SETUP.md). It is **not**
part of this build. Anything worth keeping from a GUI session should be
rewritten as a script in `assets/`.
