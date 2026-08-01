# Blender asset pipeline

Headless, reproducible 3D asset generation for **ORIENTAK: VYŠŠÍ BROD**.

Every model in `public/models/` is produced by a Python script in `assets/`,
run by Blender in `--background` mode. There is no `.blend` file anywhere in
this repo and no GUI step in the build: **the source of truth is the code**.
Delete `public/models/` and `npm run gen:models` reconstructs it byte-for-byte.

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
_Run `node tools/blender/validate.mjs --markdown` to regenerate._
<!-- VALIDATION_TABLE_END -->

Preview sheets for every asset are in [`previews/`](previews/) — four yaw
angles each, rendered from the exported `.glb` (not from the in-memory build
scene), 3-point lit, EEVEE Next.

## Triangle budgets

Enforced by `validate.mjs`; exceeding one fails the build.

| Asset | LOD0 budget | Notes |
|---|---:|---|
| `control-flag` | 600 | instanced per control |
| `control-stand` | 800 | instanced per control |
| `si-unit` | 500 | instanced per control |
| `boulder-set` | 9000 | 6 variants, ~1500 each |
| `spruce` | 12000 | 3 variants, ~4000 each |
| `beech` | 11000 | 3 variants |
| `deadwood` | 3600 | 3 variants |
| `race-belt` | 900 | first-person prop, LOD0 only |
| `finish-gantry` | 2200 | one-off |
| `arena-tent` | 1400 | one-off |
| `spectator-fence` | 600 | tiles along +X |

Overall target: **under ~40k triangles across all LOD0s**, since these are
instanced heavily across the terrain.

## Interactive Blender (optional)

For exploratory work in the Blender GUI there is an optional MCP bridge — see
[`docs/BLENDER_MCP_SETUP.md`](../../docs/BLENDER_MCP_SETUP.md). It is **not**
part of this build. Anything worth keeping from a GUI session should be
rewritten as a script in `assets/`.
