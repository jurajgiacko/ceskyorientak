"""boulder-set -- six Sumava (Bohemian Forest) granite boulders.

The defining local form is *Wollsackverwitterung* (wool-sack weathering):
granite splits along three roughly orthogonal joint sets, then chemical
weathering eats the exposed edges and corners much faster than the flat faces.
What is left is a stack of rounded, sack-like blocks that are still recognisably
cuboidal -- soft bulging faces, fat rounded edges, and one or two conspicuously
flat cleavage planes where a joint opened recently.

Build recipe per boulder:

  cube -> heavy edge bevel -> Catmull-Clark subsurf
        The bevel is a support loop.  Without it a subdivided cube converges on
        a sphere; with it the flat faces survive and only the edges round off,
        which *is* the wool-sack form.
  -> broad noise (lumpiness) -> subsurf again -> medium + fine noise (relief)
  -> 1..3 `cut_plane` calls along jittered box axes (the joint planes)
  -> yaw + a few degrees of settle tilt -> flat base cut -> bedded below z=0

Materials: three granite tones so the set does not read as one rock repeated,
a lighter "fresh" tone on the cleavage faces, and lichen on upward-facing
polygons with a noise-perturbed boundary so it never reads as a contour line.

Origin: world origin is the middle of the row; each variant sits on its own
patch of ground with its base slightly below z=0 so it looks bedded in.
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
SPACING = 5.0            # metres between boulder centres along X
TARGET_LOD0 = 1420       # tris per variant -> 8520 total, budget is 9000
RATIOS = (1.0, 0.40, 0.10)
SMOOTH_ANGLE = 40.0

# Per-variant recipe.  `size` is the X extent in metres, `prop` the Y/Z ratios
# against it, `bevel` how much of the short half-axis the support bevel eats
# (small = angular, large = rounded).  `cuts` are joint planes: (axis, how far
# out along that axis to cut as a fraction of the extent, how hard to flatten).
SPECS = [
    dict(  # v0 -- classic medium wool-sack block, one clean side joint
        size=2.60, prop=(0.82, 0.62), bevel=0.30, tone="mid", yaw=17.0,
        broad=(0.100, 2.2, 2), med=(0.038, 5.6, 3), fine=(0.013, 17.0, 2),
        cuts=[((1, 0, 0), 0.78, 1.00), ((0, 0, 1), 0.90, 0.70)],
    ),
    dict(  # v1 -- small, very rounded sack, barely jointed
        size=1.20, prop=(0.95, 0.88), bevel=0.46, tone="light", yaw=-38.0,
        broad=(0.125, 2.6, 2), med=(0.045, 6.4, 3), fine=(0.016, 20.0, 2),
        cuts=[((0, -1, 0), 0.84, 0.80)],
    ),
    dict(  # v2 -- big angular slab-ish block, three joints, still blocky
        size=3.60, prop=(0.55, 0.70), bevel=0.20, tone="dark", yaw=63.0,
        broad=(0.075, 1.9, 2), med=(0.030, 5.0, 3), fine=(0.011, 15.0, 3),
        cuts=[((1, 0, 0), 0.72, 1.00), ((0, 1, 0), 0.80, 1.00),
              ((0, 0, 1), 0.86, 0.95)],
    ),
    dict(  # v3 -- upright cube-ish block, tall, single joint face
        size=2.00, prop=(0.88, 1.10), bevel=0.38, tone="mid", yaw=-9.0,
        broad=(0.110, 2.4, 3), med=(0.040, 6.0, 3), fine=(0.014, 18.0, 2),
        cuts=[((0, 1, 0), 0.76, 1.00)],
    ),
    dict(  # v4 -- long low sheet, flat top, reads as a bench
        size=4.00, prop=(0.72, 0.42), bevel=0.28, tone="light", yaw=41.0,
        broad=(0.085, 2.0, 2), med=(0.032, 5.2, 3), fine=(0.012, 16.0, 2),
        cuts=[((0, 0, 1), 0.80, 1.00), ((-1, 0, 0), 0.78, 0.90)],
    ),
    dict(  # v5 -- knobbly mid-size boulder, two joints, coarse relief
        size=1.65, prop=(0.90, 0.78), bevel=0.34, tone="dark", yaw=-71.0,
        broad=(0.135, 2.8, 3), med=(0.048, 7.0, 3), fine=(0.017, 22.0, 2),
        cuts=[((1, 0, 0), 0.82, 0.80), ((0, -1, 0), 0.86, 1.00)],
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


def translate_verts(obj, dx, dy, dz):
    return transform_verts(obj, Matrix.Translation((dx, dy, dz)))


def bed(obj, sink):
    """Drop the object so its lowest vertex sits `sink` metres below z=0.

    Returns the Z offset applied, so callers can keep bookkeeping in step.
    """
    mn, _mx = M.bounds(obj)
    dz = -sink - mn.z
    translate_verts(obj, 0.0, 0.0, dz)
    return dz


def extent_along(obj, normal):
    """Signed distance from the origin to the furthest vertex along `normal`."""
    n = Vector(normal).normalized()
    return max(v.co.dot(n) for v in obj.data.vertices)


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
    n = Vector(vec).normalized() + Vector(rng.offset3(amount))
    if n.length < 1e-6:
        n = Vector(vec).normalized()
    return n.normalized()


# ---------------------------------------------------------------------------
# material predicates
# ---------------------------------------------------------------------------

def lichen_predicate(rng, feature, base=0.55, wobble=0.30):
    """Upward-facing polys, with a noise-broken boundary.

    A hard `normal.z > k` test draws a perfectly smooth contour around the
    boulder, which is exactly what real lichen does not do.  Perturbing the
    threshold with low-frequency noise gives ragged, patchy edges and the odd
    isolated patch running down a shoulder.
    """
    off = Vector(rng.offset3(120.0))
    k = 1.0 / max(1e-3, feature)

    def pred(poly, _obj):
        nz = poly.normal.z
        if nz <= 0.05:
            return False
        t = bnoise.noise((poly.center + off) * k)
        return nz > (base + t * wobble)

    return pred


def cleavage_predicate(planes, tol):
    """Polys lying on (and facing along) one of the recorded joint planes."""
    def pred(poly, _obj):
        c = poly.center
        n = poly.normal
        for p, pn in planes:
            if n.dot(pn) > 0.90 and abs((c - p).dot(pn)) < tol:
                return True
        return False

    return pred


# ---------------------------------------------------------------------------
# boulder construction
# ---------------------------------------------------------------------------

def build_boulder(index, spec, rng):
    size = spec["size"]
    sx = size
    sy = size * spec["prop"][0]
    sz = size * spec["prop"][1]

    obj = M.cube("%s_v%d_base" % (NAME, index), size=1.0)
    scale_verts(obj, sx, sy, sz)

    # Support bevel: this is what keeps the block a block once subdivided.
    short = min(sx, sy, sz) * 0.5
    M.bevel(obj, spec["bevel"] * short, segments=1, angle_deg=20.0)

    # Round it off, then break the faces with broad lumpiness before the last
    # subdivision -- subdividing after the broad pass keeps the lumps soft and
    # sack-like instead of crinkly.
    M.subsurf(obj, levels=2)
    amp, scl, oct_ = spec["broad"]
    M.noise_displace(obj, amp * size, scale=scl / size, octaves=oct_,
                     offset=rng.offset3(60.0), hardness=0.55)

    M.subsurf(obj, levels=1)
    amp, scl, oct_ = spec["med"]
    M.noise_displace(obj, amp * size, scale=scl / size, octaves=oct_,
                     offset=rng.offset3(60.0), hardness=0.50)
    amp, scl, oct_ = spec["fine"]
    M.noise_displace(obj, amp * size, scale=scl / size, octaves=oct_,
                     offset=rng.offset3(60.0), hardness=0.45)

    # Joint planes.  Axes are the box axes with a little jitter, because the
    # three granite joint sets really are close to orthogonal.
    planes = []
    for j, (axis, frac, flat) in enumerate(spec["cuts"]):
        n = jittered(axis, rng.sub("cut%d" % j), 0.22)
        d = extent_along(obj, n) * frac
        p = n * d
        M.cut_plane(obj, p, n, flatten=flat)
        if flat > 0.85:
            planes.append((p.copy(), n.copy()))

    # Orientation: yaw so the joint sets are not all aligned down the row, plus
    # a couple of degrees of settle so nothing looks placed by hand.
    rot = (Matrix.Rotation(math.radians(spec["yaw"]), 4, "Z")
           @ Matrix.Rotation(math.radians(rng.uniform(-6.0, 6.0)), 4, "X")
           @ Matrix.Rotation(math.radians(rng.uniform(-6.0, 6.0)), 4, "Y"))
    transform_verts(obj, rot)

    # Flat base + bedding.  The bottom is never seen, so trimming it is free
    # triangles back, and it stops the boulder reading as a floating pebble.
    mn, mx = M.bounds(obj)
    height = mx.z - mn.z
    M.cut_plane(obj, (0.0, 0.0, mn.z + height * 0.12), (0, 0, -1), flatten=1.0)
    dz = bed(obj, sink=height * 0.07)

    # Carry the recorded joint planes through the same rigid motion, so the
    # cleavage material lands on the faces the cuts actually produced.
    rot3 = rot.to_3x3()
    shift = Vector((0.0, 0.0, dz))
    planes = [((rot3 @ p) + shift, (rot3 @ pn).normalized()) for p, pn in planes]

    M.merge_doubles(obj, 1e-4)
    decimate_to(obj, TARGET_LOD0)
    M.shade_smooth(obj, SMOOTH_ANGLE)
    uvtools.cube_project(obj, 0.6)
    return obj, planes, size


def main():
    args = cli.parse({"draco": True})
    rng = cli.setup(args.seed, NAME)

    tones = {
        "light": mat.principled("granite_light", mat.GRANITE_LIGHT,
                                roughness=0.85, metallic=0.0, specular=0.32),
        "mid": mat.principled("granite_mid", mat.GRANITE_MID,
                              roughness=0.86, metallic=0.0, specular=0.32),
        "dark": mat.principled("granite_dark", mat.GRANITE_DARK,
                               roughness=0.88, metallic=0.0, specular=0.30),
    }
    # Freshly opened joint faces have not weathered grey-brown yet.
    fresh = mat.principled("granite_fresh", (0.400, 0.388, 0.362),
                           roughness=0.80, metallic=0.0, specular=0.36)
    lichen = mat.principled("granite_lichen", mat.LICHEN, roughness=0.93,
                            metallic=0.0, specular=0.18)

    all_lods = []
    counts = []
    x0 = -SPACING * (VARIANTS - 1) * 0.5

    for i, spec in enumerate(SPECS):
        sub = rng.sub("v%d" % i)
        obj, planes, size = build_boulder(i, spec, sub)

        mat.assign_all(obj, tones[spec["tone"]])
        if planes:
            mat.assign_faces(obj, fresh,
                             cleavage_predicate(planes, size * 0.035))
        mat.assign_faces(obj, lichen,
                         lichen_predicate(sub.sub("lichen"), size * 0.55,
                                          base=0.52, wobble=0.34))

        translate_verts(obj, x0 + i * SPACING, 0.0, 0.0)

        lods = lod.decimate_lods(obj, "%s_v%d" % (NAME, i), ratios=RATIOS,
                                 smooth_angle=SMOOTH_ANGLE)
        lod.report(lods)
        counts.append([M.tri_count(o) for o in lods])
        all_lods.extend(lods)

    totals = [sum(c[k] for c in counts) for k in range(len(RATIOS))]
    print("BOULDERSET totals LOD0=%d LOD1=%d LOD2=%d" % tuple(totals))

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(all_lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, all_lods, extra={
        "variants": VARIANTS,
        "spacingM": SPACING,
        "sizesM": [round(s["size"], 2) for s in SPECS],
        "originNote": "row centred on world origin, +X spacing; base bedded just below z=0",
        "notes": "wool-sack weathered granite; lichen on upward faces",
    })


main()
