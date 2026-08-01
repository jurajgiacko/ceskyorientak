"""boulder-set -- six Sumava (Bohemian Forest) granite boulders.

The defining local form is *Wollsackverwitterung* (wool-sack weathering):
granite splits along three roughly orthogonal joint sets, then chemical
weathering attacks the exposed edges and corners far faster than the flat
faces.  The block ends up rounded until its faces bulge convexly and its edges
are broad and soft -- a stuffed sack that is still recognisably cuboidal in
proportion -- usually with one or two conspicuously flat facets where a joint
actually parted, and a network of shallow grooves where the next ones are
opening.

Build recipe per boulder:

  cube -> heavy edge bevel -> Catmull-Clark subsurf
        The bevel is a support loop.  Without it a subdivided cube converges on
        a sphere; with it the proportions survive while the edges round off.
        Bevel width is the rounded-vs-angular dial: four of the six are wide
        (sack-like), two are narrow with a two-segment loop (angular blocks,
        which is equally real on fresher outcrops).
  -> broad billow noise: |noise| biased positive, so the faces push *outward*
     in a few large lobes rather than rippling.  Wavelength is comparable to
     the boulder itself -- that is what makes it read as a sack.
  -> subsurf again, so those lobes stay soft rather than creased
  -> a shallow carved groove network + a fine plain pass for surface relief
  -> one or two `cut_plane` calls along jittered box axes (the parted joints);
     more than that and the silhouette goes back to being a cube
  -> a whisper of noise back on top so the joint facets are not dead flat
  -> yaw + a few degrees of settle tilt -> flat base cut -> bedded below z=0

Everything is tuned against the ~1470-triangle LOD0 budget: noise wavelengths
shorter than roughly a fifth of the boulder cannot survive the collapse
decimator, so the passes stop there rather than spending amplitude on detail
that would be thrown away.

Every variant is built at the origin -- XY centred, base at z=0 with the very
bottom dipping under so it reads as bedded in rather than set down.  Nothing is
laid out in the file: baking a layout offset into the vertices would force the
runtime to subtract a per-variant centroid before it could instance them.

Materials: the three granite tones from the palette, dealt out so the set does
not read as one rock repeated, plus a desaturated sage lichen sitting close to
the rock in value.  Lichen is placed by a predicate that requires *both* an
upward-facing normal and a multi-octave noise sample above a threshold, so it
breaks into patches with ragged edges that run down the shoulders in places,
instead of the clean contour band a bare `normal.z > k` test produces.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mathutils import Matrix, Vector  # noqa: E402
from mathutils import noise as bnoise  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "boulder-set"
VARIANTS = 6
TARGET_LOD0 = 1470       # tris per variant -> 8820 total, budget is 9000
RATIOS = (1.0, 0.40, 0.10)

# Crustose lichen on granite is a low-saturation sage that reads as a stain
# rather than paint: barely greener than the rock and a little *darker* than
# it, never a bright contrasting patch.  Half way from the palette lichen to
# the dark granite, then knocked down again -- at the exposure the preview rig
# uses, anything at the palette's own value blows out to custard.
LICHEN_SAGE = tuple(0.72 * (0.5 * a + 0.5 * b)
                    for a, b in zip(mat.LICHEN, mat.GRANITE_DARK))

# Per-variant recipe.
#   size    X extent in metres; prop gives Y and Z as ratios of it
#   bevel   support-bevel width as a fraction of the short half-axis
#           (wide + 1 segment = rounded sack, narrow + 2 segments = angular)
#   broad   (amplitude/size, lobes across the boulder, octaves)  the bulge
#   groove  (depth/size, cycles across the boulder)              joint network
#   fine    (amplitude/size, cycles across the boulder, octaves) surface relief
#   cuts    parted joints: (box axis, how far out as a fraction of the extent,
#           how hard to flatten -- 1.0 is a clean parted face)
SPECS = [
    dict(  # v0 -- classic medium wool-sack block, one clean side joint
        size=2.60, prop=(0.84, 0.66), bevel=0.44, bseg=1, tone="mid",
        yaw=17.0, smooth=38.0,
        broad=(0.155, 1.5, 2), groove=(0.036, 2.2), fine=(0.028, 5.0, 2),
        cuts=[((1, 0, 0), 0.78, 1.00)],
    ),
    dict(  # v1 -- small, very rounded sack, barely jointed
        size=1.20, prop=(0.94, 0.84), bevel=0.60, bseg=1, tone="light",
        yaw=-38.0, smooth=42.0,
        broad=(0.180, 1.8, 2), groove=(0.038, 2.6), fine=(0.032, 6.2, 2),
        cuts=[((0, -1, 0), 0.88, 0.55)],
    ),
    dict(  # v2 -- big angular block, two parted joints, fresher outcrop
        size=3.60, prop=(0.60, 0.74), bevel=0.24, bseg=2, tone="dark",
        yaw=63.0, smooth=33.0,
        broad=(0.110, 1.4, 2), groove=(0.028, 2.0), fine=(0.022, 4.6, 3),
        cuts=[((1, 0, 0), 0.74, 1.00), ((0, 0, 1), 0.90, 0.75)],
    ),
    dict(  # v3 -- upright sack, tall proportions, single joint facet
        size=2.00, prop=(0.88, 1.10), bevel=0.50, bseg=1, tone="dark",
        yaw=-9.0, smooth=40.0,
        broad=(0.170, 1.7, 3), groove=(0.040, 2.4), fine=(0.030, 5.6, 2),
        cuts=[((0, 1, 0), 0.78, 0.90)],
    ),
    dict(  # v4 -- long low sheet, reads as a bench, one parted end
        size=4.00, prop=(0.76, 0.44), bevel=0.30, bseg=2, tone="mid",
        yaw=41.0, smooth=35.0,
        broad=(0.165, 1.7, 2), groove=(0.045, 1.9), fine=(0.029, 4.2, 2),
        cuts=[((0, 0, 1), 0.90, 0.55), ((-1, 0, 0), 0.78, 1.00)],
    ),
    dict(  # v5 -- knobbly mid-size sack, coarse relief, no clean facet
        size=1.65, prop=(0.90, 0.82), bevel=0.54, bseg=1, tone="dark",
        yaw=-71.0, smooth=41.0,
        broad=(0.190, 2.0, 3), groove=(0.044, 2.9), fine=(0.034, 6.8, 2),
        cuts=[((1, 0, 0), 0.84, 0.65)],
    ),
]


# ---------------------------------------------------------------------------
# local mesh helpers (kept here rather than in lib/ -- see repo rules)
# ---------------------------------------------------------------------------

def scale_verts(obj, sx, sy, sz):
    for v in obj.data.vertices:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    obj.data.update()
    return obj


def transform_verts(obj, matrix):
    obj.data.transform(matrix)
    obj.data.update()
    return obj


def recentre(obj, sink):
    """XY-centre on the object's own bounds and drop the base `sink` below z=0.

    Instancing wants every variant sitting on the origin, so this is the last
    thing the builder does -- no layout offset ever reaches the vertex data.
    """
    mn, mx = M.bounds(obj)
    transform_verts(obj, Matrix.Translation((
        -(mn.x + mx.x) * 0.5, -(mn.y + mx.y) * 0.5, -sink - mn.z)))
    return obj


def extent_along(obj, normal):
    """Distance from the origin to the furthest vertex along `normal`."""
    n = Vector(normal).normalized()
    return max(v.co.dot(n) for v in obj.data.vertices)


def relief(obj, amplitude, freq, octaves=2, offset=(0, 0, 0), mode="plain",
           hardness=0.5, width=3.0):
    """Layered noise displacement along the vertex normal, three flavours.

    `lib.mesh.noise_displace` only offers the plain signed sum, which is a
    symmetric swell -- fine for lumpiness, wrong for the two features that make
    granite read as granite:

      billow  |noise| folded positive and biased outward, so the surface pushes
              *out* into a few fat lobes with pinched seams between them.  That
              asymmetry is the whole difference between a bumpy sphere and a
              stuffed sack.
      groove  a one-sided ridge mask, zero almost everywhere and rising only
              near the noise zero-crossing, i.e. along a connected network of
              thin lines.  Fed a negative amplitude it *carves* that network
              in, which is what a joint set looks like before the block parts.
    """
    off = Vector(offset)

    def fn(co, nrm, _i):
        p = (co + off) * freq
        total = 0.0
        amp = 1.0
        f = 1.0
        norm = 0.0
        for _ in range(octaves):
            s = bnoise.noise(p * f)
            if mode == "billow":
                s = abs(s) * 2.4 - 0.45
            elif mode == "groove":
                s = max(0.0, 1.0 - abs(s) * width)
            total += s * amp
            norm += amp
            amp *= hardness
            f *= 2.0
        return co + nrm * ((total / (norm or 1.0)) * amplitude)

    return M.displace(obj, fn)


def decimate_to(obj, target):
    """Collapse-decimate down to (just under) `target` triangles."""
    cur = M.tri_count(obj)
    if cur <= target:
        return obj
    M.decimate(obj, target / float(cur))
    for _ in range(3):
        cur = M.tri_count(obj)
        if cur <= target:
            break
        M.decimate(obj, (target / float(cur)) * 0.985)
    return obj


def jittered(vec, rng, amount):
    """A box axis nudged off true -- granite joint sets are near-orthogonal,
    not machined."""
    n = Vector(vec).normalized() + Vector(rng.offset3(amount))
    if n.length < 1e-6:
        n = Vector(vec).normalized()
    return n.normalized()


def lichen_predicate(rng, feature):
    """Upward-facing *and* inside a noise patch -- both conditions required.

    The orientation term only biases the threshold rather than gating the
    result outright, so a colony that starts on top is free to spill a little
    way down a shoulder, and a well-lit flank can stay bare.  Three octaves
    give the patch edges the frayed, lobed outline crustose lichen actually
    has; a single `normal.z > k` test would draw a level contour instead.
    """
    off = Vector(rng.offset3(140.0))
    k = 1.0 / max(1e-3, feature)

    def pred(poly, _obj):
        nz = poly.normal.z
        if nz < 0.40:
            return False
        p = (poly.center + off) * k
        n = (bnoise.noise(p)
             + bnoise.noise(p * 2.0) * 0.5
             + bnoise.noise(p * 4.0) * 0.25) / 1.75
        return n > (0.32 - (nz - 0.40) * 0.50)

    return pred


# ---------------------------------------------------------------------------
# boulder construction
# ---------------------------------------------------------------------------

def build_boulder(index, spec, rng):
    size = spec["size"]
    sx, sy, sz = size, size * spec["prop"][0], size * spec["prop"][1]

    obj = M.cube("%s_v%d_base" % (NAME, index), size=1.0)
    scale_verts(obj, sx, sy, sz)

    # Support bevel: this is what keeps the proportions once subdivided.
    short = min(sx, sy, sz) * 0.5
    M.bevel(obj, spec["bevel"] * short, segments=spec["bseg"], angle_deg=20.0)

    M.subsurf(obj, levels=2)
    amp, k, oct_ = spec["broad"]
    relief(obj, amp * size, k / size, octaves=oct_, mode="billow",
           offset=rng.offset3(60.0), hardness=0.55)

    # Subdividing after the broad pass keeps the lobes soft and sack-like; the
    # sharper passes go on afterwards so they are not smoothed away.
    M.subsurf(obj, levels=1)
    depth, k = spec["groove"]
    relief(obj, -depth * size, k / size, octaves=1, mode="groove",
           offset=rng.offset3(60.0), width=3.0)
    amp, k, oct_ = spec["fine"]
    relief(obj, amp * size, k / size, octaves=oct_, mode="plain",
           offset=rng.offset3(60.0), hardness=0.5)

    # Parted joints -- one or two only, or the silhouette goes back to a cube.
    for j, (axis, frac, flat) in enumerate(spec["cuts"]):
        n = jittered(axis, rng.sub("cut%d" % j), 0.22)
        M.cut_plane(obj, n * (extent_along(obj, n) * frac), n, flatten=flat)

    # A real joint face is planar but not machined, so put a little relief back.
    relief(obj, 0.010 * size, 5.0 / size, octaves=2, mode="plain",
           offset=rng.offset3(60.0), hardness=0.5)

    # A couple of degrees of settle, so nothing looks placed by hand.
    transform_verts(obj, Matrix.Rotation(math.radians(spec["yaw"]), 4, "Z")
                    @ Matrix.Rotation(math.radians(rng.uniform(-6.0, 6.0)), 4, "X")
                    @ Matrix.Rotation(math.radians(rng.uniform(-6.0, 6.0)), 4, "Y"))

    # Flat base + bedding.  The underside is never seen, so trimming it buys
    # triangles back, and it stops the boulder reading as a floating pebble.
    mn, mx = M.bounds(obj)
    height = mx.z - mn.z
    M.cut_plane(obj, (0.0, 0.0, mn.z + height * 0.16), (0, 0, -1), flatten=1.0)

    M.merge_doubles(obj, 1e-4)
    recentre(obj, sink=height * 0.10)
    return obj


def main():
    args = cli.parse({"draco": True})
    rng = cli.setup(args.seed, NAME)

    # Palette base colours, untouched.  Specular is pulled well under the
    # physical 0.5 and roughness pushed up: a weathered granite face is a dry,
    # crumbly diffuse surface, and the broad sheen a default Principled puts on
    # it is most of what was making the set read as pale.
    tones = {
        "light": mat.principled("granite_light", mat.GRANITE_LIGHT,
                                roughness=0.92, metallic=0.0, specular=0.18),
        "mid": mat.principled("granite_mid", mat.GRANITE_MID,
                              roughness=0.92, metallic=0.0, specular=0.18),
        "dark": mat.principled("granite_dark", mat.GRANITE_DARK,
                               roughness=0.94, metallic=0.0, specular=0.16),
    }
    lichen = mat.principled("granite_lichen", LICHEN_SAGE, roughness=0.96,
                            metallic=0.0, specular=0.10)

    all_lods = []
    counts = []

    for i, spec in enumerate(SPECS):
        sub = rng.sub("v%d" % i)
        obj = build_boulder(i, spec, sub)

        # Materials go on before decimation: at full density the lichen edge is
        # resolved properly, and the decimator then frays it further -- which is
        # exactly the wrong-looking-right result we want.
        mat.assign_all(obj, tones[spec["tone"]])
        mat.assign_faces(obj, lichen,
                         lichen_predicate(sub.sub("lichen"), spec["size"] * 0.42))

        decimate_to(obj, TARGET_LOD0)
        M.shade_smooth(obj, spec["smooth"])
        uvtools.cube_project(obj, 0.6)

        lods = lod.decimate_lods(obj, "%s_v%d" % (NAME, i), ratios=RATIOS,
                                 smooth_angle=spec["smooth"])
        lod.report(lods)
        counts.append([M.tri_count(o) for o in lods])
        all_lods.extend(lods)

    totals = [sum(c[k] for c in counts) for k in range(len(RATIOS))]
    print("BOULDERSET totals LOD0=%d LOD1=%d LOD2=%d" % tuple(totals))

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(all_lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, all_lods, extra={
        "variants": VARIANTS,
        "sizesM": [round(s["size"], 2) for s in SPECS],
        "originNote": "every variant XY-centred on the origin, base at z=0 "
                      "(bottom dips slightly under); no layout offset baked in",
        "notes": "wool-sack weathered Sumava granite, 3 palette tones + sage lichen",
    })


main()
