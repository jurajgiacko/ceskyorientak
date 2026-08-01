"""race-belt -- orienteering / trail-running race belt (first-person prop).

An elastic waist band with a side-release buckle at the front and a set of
elastic gel loops distributed round the back and sides.

  * band       ~0.82 m circumference, built as an ELLIPSE 0.30 x 0.22 m
                 (a waist is wider than it is deep), 30 mm wide, 3 mm thick.
  * buckle     two moulded plastic halves meeting at the centre front (+Y).
  * gel loops  four arched elastic straps, each attached to the band at both
                 ends, with just enough clearance for a gel sachet.
  * tab        a small race-number toggle hanging off the left front.

The band is a swept loop: `M.param_surface` with close_u AND close_v, so u
runs round the ellipse and v runs round a flattened hexagonal cross-section.
Both the ellipse radius and the cross-section are modulated along u, which is
what keeps it from reading as a mathematically perfect torus.

Origin: the centre of the loop, band lying in the XY plane, +Y forward (which
`export_yup` turns into glTF -Z, i.e. the direction the character faces), so
the node can be parented straight to a waist bone.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "race-belt"
TAU = math.pi * 2.0

RX = 0.150              # ellipse semi-axis, side to side
RY = 0.110              # ellipse semi-axis, front to back
BAND_W = 0.030          # webbing width (vertical)
BAND_T = 0.0030         # webbing thickness (radial)
NU = 30                 # samples round the loop
SMOOTH = 36.0

_W = BAND_W * 0.5
_T = BAND_T * 0.5

# Flattened hexagonal cross-section, (radial, vertical), traversed CCW.  A
# plain rectangle would read as a ribbon of zero thickness at grazing angles;
# the chamfers give the edge a highlight.
BAND_XSEC = [
    (_T, -_W * 0.76),
    (_T, _W * 0.76),
    (0.0, _W),
    (-_T, _W * 0.76),
    (-_T, -_W * 0.76),
    (0.0, -_W),
]

LOOP_T = 0.0009         # gel-loop strap half-thickness
LOOP_W = 0.0080         # gel-loop strap half-width
LOOP_XSEC = [
    (LOOP_T, -LOOP_W),
    (LOOP_T, LOOP_W),
    (-LOOP_T, LOOP_W),
    (-LOOP_T, -LOOP_W),
]


# ---------------------------------------------------------------------------
# local helpers
# ---------------------------------------------------------------------------

def placed_box(name, size, radius, segments, location):
    """`M.rounded_box` with the offset baked into the mesh.

    Its `location=` argument sets an *object* transform, and `M.join` reads
    `matrix_world` without forcing a depsgraph update, so in `--background`
    the matrix is still stale identity and the offset is silently discarded.
    Baking the translation into the vertices sidesteps that entirely.
    """
    obj = M.rounded_box(name, size=size, radius=radius, segments=segments)
    obj.data.transform(Matrix.Translation(Vector(location)))
    obj.data.update()
    return obj


def xsec(table, v):
    """Pick a cross-section entry from a v in [0, 1)."""
    return table[int(round(v * len(table))) % len(table)]


def slack(a):
    """Elastic never sits as a perfect ellipse -- a couple of slow harmonics."""
    return 1.0 + 0.021 * math.sin(a * 3.0 + 0.7) + 0.012 * math.sin(a * 5.0 + 2.4)


def ellipse(u):
    """Band centreline point and outward unit normal at parameter u."""
    a = u * TAU
    ca, sa = math.cos(a), math.sin(a)
    s = slack(a)
    p = Vector((RX * ca * s, RY * sa * s, 0.0035 * math.sin(a * 2.0 + 1.9)))
    n = Vector((RY * ca, RX * sa, 0.0))
    if n.length < 1e-9:
        n = Vector((1.0, 0.0, 0.0))
    return p, n.normalized()


def band_surface(u, lift):
    """A point `lift` metres radially outside the band centreline."""
    p, n = ellipse(u)
    return p + n * lift, n


def build_band(material):
    def fn(u, v):
        a = u * TAU
        p, n = ellipse(u)
        dn, dz = xsec(BAND_XSEC, v)
        # webbing is not extruded stock: it stretches thin and wide in places
        thick = 1.0 + 0.20 * math.sin(a * 7.0 + 1.1)
        width = 1.0 + 0.055 * math.sin(a * 4.0 + 0.3)
        return tuple(p + n * (dn * thick) + Vector((0.0, 0.0, dz * width)))

    obj = M.param_surface("belt_band", fn, NU, len(BAND_XSEC),
                          close_u=True, close_v=True)
    M.recalc_normals(obj)
    mat.assign_all(obj, material)
    return obj


def build_gel_loop(name, u0, du, height, material):
    """A thin elastic strap arching off the band, anchored at both ends.

    Both ends sit on the band's own centreline, so the strap is swallowed
    whole by the 3 mm webbing -- the open ends of the sweep are hidden and no
    cap geometry is needed, without the strap punching out of the inner face
    where it would rub against the wearer.
    """
    def fn(s, v):
        u = u0 + (s - 0.5) * du
        p, n = ellipse(u)
        lift = math.sin(math.pi * s) * height
        dn, dz = xsec(LOOP_XSEC, v)
        base = p + n * lift
        return tuple(base + n * dn + Vector((0.0, 0.0, dz)))

    obj = M.param_surface(name, fn, 6, len(LOOP_XSEC),
                          close_u=False, close_v=True)
    M.recalc_normals(obj)
    mat.assign_all(obj, material)
    return obj


def build_buckle(material):
    """Side-release clip: female housing + male half + tongue + prong tips.

    Sits at the centre front straddling the band, which it grips and hides.
    """
    # sit the clip on the band where the band actually is: the slack harmonics
    # move the front of the ellipse by a couple of millimetres, and a buckle
    # floating clear of its own webbing is the first thing the eye catches
    front, nrm = ellipse(0.25)
    y = front.y + nrm.y * 0.0030
    parts = []

    housing = placed_box("belt_buckle_f", size=(0.048, 0.0130, 0.037),
                         radius=0.0052, segments=2,
                         location=(0.026, y, 0.0))
    parts.append(housing)

    male = placed_box("belt_buckle_m", size=(0.038, 0.0118, 0.034),
                      radius=0.0048, segments=1,
                      location=(-0.029, y, 0.0))
    parts.append(male)

    # the tongue bridging the two halves -- deliberately narrower and shorter
    # than either, so the parting line between them reads as a seam
    tongue = placed_box("belt_buckle_t", size=(0.020, 0.0078, 0.023),
                        radius=0.0026, segments=1,
                        location=(-0.004, y, 0.0))
    parts.append(tongue)
    # the two release prongs poking out of the housing's flanks
    for k, sign in enumerate((1.0, -1.0)):
        prong = placed_box("belt_buckle_p%d" % k,
                           size=(0.016, 0.0070, 0.0064),
                           radius=0.0020,  segments=1,
                           location=(0.021, y, sign * 0.0194))
        parts.append(prong)

    obj = M.join(parts, "belt_buckle")
    mat.assign_all(obj, material)
    return obj


def build_number_tab(material):
    """Small race-number toggle hanging off the band at the left front."""
    p, n = band_surface(0.335, BAND_T * 0.5)
    tab = placed_box("belt_tab", size=(0.016, 0.0035, 0.026),
                     radius=0.0016, segments=1,
                     location=p + n * 0.0018 + Vector((0.0, 0.0, -0.020)))
    mat.assign_all(tab, material)
    return tab


# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": False})
    rng = cli.setup(args.seed, NAME)

    fabric = mat.principled("belt_fabric", (0.040, 0.043, 0.050),
                            roughness=0.92, specular=0.24, sheen=0.30)
    accent = mat.principled("belt_accent", (0.860, 0.300, 0.040),
                            roughness=0.74, specular=0.32, sheen=0.20)
    plastic = mat.principled("belt_plastic", (0.045, 0.047, 0.053),
                             roughness=0.36, specular=0.50)

    parts = [build_band(fabric), build_buckle(plastic)]

    # gel loops: back and both flanks, clear of the buckle at u=0.25
    loops = rng.sub("loops")
    for k, u0 in enumerate((0.465, 0.625, 0.785, 0.945)):
        parts.append(build_gel_loop(
            "belt_gel%d" % k, loops.jitter(u0, 0.010), du=0.058,
            height=loops.uniform(0.021, 0.026), material=accent))

    parts.append(build_number_tab(accent))

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 2e-5)
    uvtools.cube_project(obj, 0.12)
    M.shade_smooth(obj, SMOOTH)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0,), smooth_angle=SMOOTH)
    lod.report(lods)

    # M.join unlinks the source objects; without an explicit update the
    # exporter's walk over view_layer.objects can iterate freed pointers.
    bpy.context.view_layer.update()

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "originNote": ("centre of the waist loop, band in the XY plane, +Y "
                       "forward -- parent straight to a waist bone"),
        "notes": ("elliptical elastic band 0.30 x 0.22 m (~0.82 m round), "
                  "30 x 3 mm webbing, side-release buckle at the front, "
                  "4 elastic gel loops, race-number tab"),
    })


main()
