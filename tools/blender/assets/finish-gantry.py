"""finish-gantry -- event finish arch / gantry.

Two triangular-section truss uprights (F34-style: 290 mm side, 50 mm chords)
carrying a triangular top beam, apex up.  Everything structural is swept with
`M.tube`; the bracing members are 5-sided and *uncapped* because both ends are
buried inside a chord, which halves their cost -- that is what buys enough
triangles for a believable number of diagonals inside the 2200 tri budget.

The banner is a separate, single-sided fabric panel hung between the uprights
just under the beam.  Its material is named exactly `BRAND_BANNER` and its UV
island fills the whole 0..1 square, so brand artwork drops straight on.  The
panel's billow is applied purely along its own normal (+Y), so the planar
UV projection stays an exact, uniformly spaced rectangle.

Origin: ground level, mid-span.  +X along the arch, +Z up.  The banner reads
un-mirrored when viewed from -Y.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mathutils import Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "finish-gantry"

HALF_SPAN = 3.00        # upright axis to mid-span (6 m between uprights)
CLEAR_H = 4.50          # underside of the top beam
TRUSS = 0.29            # truss cross-section side length
CHORD_R = 0.025         # 50 mm chords
BRACE_R = 0.0115        # 23 mm bracing
CHORD_SIDES = 6
BRACE_SIDES = 5

FOOT_Z = 0.035          # top of the base plate = bottom of the chords
BEAM_HALF = 3.30        # top beam runs a little past the uprights
BEAM_RISE = TRUSS * math.sqrt(3.0) / 2.0   # 0.2511 -- apex above lower chords

BANNER_W = 5.60
BANNER_H = 1.10
BANNER_TOP = CLEAR_H - 0.05
BANNER_BOW = 0.055
BANNER_NU = 14
BANNER_NV = 3

UPRIGHT_BAYS = 8
BEAM_BAYS = 8


# ---------------------------------------------------------------------------
# local helpers (lib/ is owned by other agents -- nothing here touches it)
# ---------------------------------------------------------------------------

def shade_by_material(obj, thresholds, default=35.0):
    """Smooth shading with a per-material sharp-edge angle.

    `M.join` rebuilds edges from scratch, so the per-part sharp flags set
    before joining do not survive.  Re-deriving them afterwards is the only
    way to keep 5-sided tubes reading as round bars (needs a >72 deg limit)
    while flat fittings keep crisp 90 deg corners (needs ~25 deg).
    """
    names = [m.name if m is not None else "" for m in obj.data.materials]

    def limit_of(face):
        i = face.material_index
        return thresholds.get(names[i], default) if 0 <= i < len(names) else default

    bm = M.to_bmesh(obj)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        lim = min(limit_of(f) for f in e.link_faces)
        e.smooth = e.calc_face_angle(math.pi) <= math.radians(lim)
    return M.write_bmesh(obj, bm)


def faces_with_material(obj, mat_name):
    names = [m.name if m is not None else "" for m in obj.data.materials]
    try:
        idx = names.index(mat_name)
    except ValueError:
        return []
    return [i for i, p in enumerate(obj.data.polygons) if p.material_index == idx]


def box_at(name, size, location, radius=0.012, segments=1):
    """Bevelled box baked into world space.

    `M.rounded_box`'s `location=` only writes `obj.location`, and `M.join`
    reads `obj.matrix_world`, which Blender has not refreshed yet in a
    headless run -- so the offset silently vanishes.  Moving the vertices
    instead keeps the part where it was put.
    """
    obj = M.rounded_box(name, size=size, radius=radius, segments=segments)
    obj.location = (0.0, 0.0, 0.0)
    dx, dy, dz = location
    for v in obj.data.vertices:
        v.co.x += dx
        v.co.y += dy
        v.co.z += dz
    obj.data.update()
    return obj


def member(name, a, b, radius, sides, caps, material):
    obj = M.tube(name, [tuple(a), tuple(b)], radius, sides=sides, caps=caps)
    mat.assign_all(obj, material)
    return obj


def lerp3(a, b, t):
    return Vector(a).lerp(Vector(b), t)


def zigzag_bracing(prefix, chord_a, chord_b, bays, radius, material, out):
    """Alternating diagonals between two parallel chords.

    Each diagonal is its own straight 2-point tube rather than one continuous
    swept polyline: a swept zigzag pinches badly at every reversal, because
    the rotation-minimising frame at a node is perpendicular to the *average*
    tangent, which at a 130 deg reversal is nearly perpendicular to both legs.
    """
    a0, a1 = chord_a
    b0, b1 = chord_b
    for k in range(bays):
        t0 = k / float(bays)
        t1 = (k + 1) / float(bays)
        if k % 2 == 0:
            p, q = lerp3(a0, a1, t0), lerp3(b0, b1, t1)
        else:
            p, q = lerp3(b0, b1, t0), lerp3(a0, a1, t1)
        out.append(member("%s_d%d" % (prefix, k), p, q, radius,
                          BRACE_SIDES, False, material))


def ring_bracing(prefix, chords, fractions, radius, material, out):
    """Cross-section braces tying the three chords together at a station."""
    for n, t in enumerate(fractions):
        pts = [lerp3(c[0], c[1], t) for c in chords]
        for k in range(3):
            out.append(member("%s_r%d_%d" % (prefix, n, k), pts[k],
                              pts[(k + 1) % 3], radius, BRACE_SIDES, False,
                              material))


# ---------------------------------------------------------------------------
# structure
# ---------------------------------------------------------------------------

def upright_plan(sx):
    """Plan positions of the three chords of one upright.

    One vertex points outboard; the other two sit at y = +/-TRUSS/2 so they
    line up with the top beam's two lower chords.
    """
    r = TRUSS / math.sqrt(3.0)
    cx = sx * HALF_SPAN
    return [(cx + sx * r, 0.0),
            (cx - sx * r * 0.5, +TRUSS * 0.5),
            (cx - sx * r * 0.5, -TRUSS * 0.5)]


def build_upright(sx, steel, out):
    tag = "%s_up%s" % (NAME, "P" if sx > 0 else "N")
    plan = upright_plan(sx)
    chords = [((x, y, FOOT_Z), (x, y, CLEAR_H)) for x, y in plan]

    for k, (a, b) in enumerate(chords):
        out.append(member("%s_c%d" % (tag, k), a, b, CHORD_R, CHORD_SIDES,
                          True, steel))

    for k in range(3):
        zigzag_bracing("%s_f%d" % (tag, k), chords[k], chords[(k + 1) % 3],
                       UPRIGHT_BAYS, BRACE_R, steel, out)

    ring_bracing(tag, chords, (0.25, 0.5, 0.75, 0.995), BRACE_R, steel, out)


def build_beam(steel, out):
    """Triangular beam, apex up: two lower chords at y = +/-TRUSS/2 landing on
    the uprights, one upper chord on the centreline."""
    tag = "%s_beam" % NAME
    zl = CLEAR_H
    zu = CLEAR_H + BEAM_RISE
    chords = [((-BEAM_HALF, +TRUSS * 0.5, zl), (BEAM_HALF, +TRUSS * 0.5, zl)),
              ((-BEAM_HALF, -TRUSS * 0.5, zl), (BEAM_HALF, -TRUSS * 0.5, zl)),
              ((-BEAM_HALF, 0.0, zu), (BEAM_HALF, 0.0, zu))]

    for k, (a, b) in enumerate(chords):
        out.append(member("%s_c%d" % (tag, k), a, b, CHORD_R, CHORD_SIDES,
                          True, steel))

    for k in range(3):
        zigzag_bracing("%s_f%d" % (tag, k), chords[k], chords[(k + 1) % 3],
                       BEAM_BAYS, BRACE_R, steel, out)

    ring_bracing(tag, chords, (0.06, 0.35, 0.65, 0.94), BRACE_R, steel, out)


def build_base(sx, fitting, out):
    """Ballast/base plate plus two guy-line anchor lugs on the outboard face."""
    cx = sx * HALF_SPAN
    plate = box_at("%s_plate%d" % (NAME, sx), (0.62, 0.56, FOOT_Z),
                   (cx, 0.0, FOOT_Z * 0.5), radius=0.011)
    mat.assign_all(plate, fitting)
    out.append(plate)

    r = TRUSS / math.sqrt(3.0)
    x_out = cx + sx * r
    for n, z in enumerate((0.34, 3.95)):
        lug = M.tube("%s_lug%d_%d" % (NAME, sx, n),
                     [(x_out, 0.0, z), (x_out + sx * 0.105, 0.0, z)],
                     [0.036, 0.030], sides=BRACE_SIDES, caps=True)
        for v in lug.data.vertices:      # flatten into a plate-like tab
            v.co.y *= 0.30
        lug.data.update()
        mat.assign_all(lug, fitting)
        out.append(lug)


def build_corner(sx, fitting, out):
    """Corner connector block where the beam lands on the upright."""
    blk = box_at("%s_corner%d" % (NAME, sx), (0.44, 0.40, 0.17),
                 (sx * HALF_SPAN, 0.0, CLEAR_H), radius=0.018)
    mat.assign_all(blk, fitting)
    out.append(blk)


def build_banner(banner_mat):
    """Flat fabric panel, billowed purely along +/-Y.

    u runs from +X to -X so the surface normal comes out +Y; `set_face_uv_rect`
    then derives U from +X, which is what makes artwork read the right way
    round from the -Y side.  Because the displacement is normal-only and the
    x/z grid is uniform, the resulting UV island is an exact 0..1 rectangle.
    """
    x0 = BANNER_W * 0.5
    z0 = BANNER_TOP - BANNER_H

    def fn(u, v):
        x = x0 - u * BANNER_W
        z = z0 + v * BANNER_H
        span = math.sin(math.pi * u)
        slack = 0.32 + 0.68 * (1.0 - v)
        wrinkle = math.sin(u * 11.0 + 0.7) * math.cos(v * 3.1) * 0.10
        y = -span * slack * BANNER_BOW * (1.0 + wrinkle)
        return (x, y, z)

    obj = M.param_surface("%s_banner" % NAME, fn, BANNER_NU, BANNER_NV)
    mat.assign_all(obj, banner_mat)
    return obj


def main():
    args = cli.parse({"draco": True})
    cli.setup(args.seed, NAME)

    steel = mat.principled("gantry_steel", mat.STEEL, roughness=0.38,
                           metallic=1.0, specular=0.5)
    fitting = mat.principled("gantry_fitting", mat.STEEL_DARK, roughness=0.52,
                             metallic=1.0)
    banner_mat = mat.principled("BRAND_BANNER", (0.905, 0.910, 0.900),
                                roughness=0.82, specular=0.30, sheen=0.30)

    parts = []
    for sx in (-1, 1):
        build_upright(sx, steel, parts)
        build_base(sx, fitting, parts)
        build_corner(sx, fitting, parts)
    build_beam(steel, parts)
    parts.append(build_banner(banner_mat))

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-5)

    banner_faces = faces_with_material(obj, "BRAND_BANNER")
    uvtools.set_face_uv_rect(obj, banner_faces, rect=(0.0, 0.0, 1.0, 1.0))
    print("BANNER faces=%d  structure tris=%d" %
          (len(banner_faces), M.tri_count(obj)))

    thresholds = {"gantry_steel": 76.0, "gantry_fitting": 26.0,
                  "BRAND_BANNER": 60.0}
    shade_by_material(obj, thresholds)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40), smooth_angle=None)
    for o in lods:
        shade_by_material(o, thresholds)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "brandUV": "BRAND_BANNER material, UV island fills 0..1",
        "spanM": round(HALF_SPAN * 2.0, 3),
        "clearHeightM": CLEAR_H,
        "bannerSizeM": [BANNER_W, BANNER_H],
        "originNote": "ground level at mid-span, arch along +X, +Z up",
    })


main()
