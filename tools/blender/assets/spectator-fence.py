"""spectator-fence -- one galvanised crowd-barrier segment.

2.5 m long, 1.1 m high: two end posts, top and bottom rails, vertical infill
bars, two flat folding feet projecting to +Y, and the interlocking fittings
that let segments chain together -- hooks off the +X end, eyes on the -X end.

Tiling: origin at the -X end, segment runs along +X, repeat pitch exactly
2.5 m.  The hooks reach x = 2.505 and the eyes reach x = -0.036, so an
instance at x + 2.5 has its eyes sitting on this one's hooks with the usual
slop of the real fitting.

Triangle budget is 600, so every member that is buried in another member at
both ends is swept uncapped (`caps=False`), which halves it: a 2-point,
5-sided uncapped tube is 10 triangles instead of 20.

Origin: ground level at the -X end of the segment, +Z up.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "spectator-fence"

PITCH = 2.50            # instance spacing along X
HEIGHT = 1.10
POST_X0 = 0.042         # near end post axis
POST_X1 = 2.408         # far end post axis
POST_R = 0.021
RAIL_R = 0.021
BAR_R = 0.0095
TOP_RAIL_Z = HEIGHT - 0.021
BOT_RAIL_Z = 0.285
N_BARS = 10

FOOT_LEN = 0.50         # flat folding foot, projecting to +Y
FOOT_W = 0.055
FOOT_T = 0.014

HOOK_Z = (0.95, 0.42)   # heights of the interlocking fittings

POST_SIDES = 6
BAR_SIDES = 5


# ---------------------------------------------------------------------------
# local helpers
# ---------------------------------------------------------------------------

def shade_by_material(obj, thresholds, default=35.0):
    """Smooth shading with a per-material sharp-edge angle.

    `M.join` rebuilds edges, dropping the per-part sharp flags, so they are
    re-derived here.  The tubes need a limit above 72 deg (a 5-sided sweep has
    72 deg between neighbouring faces) or the bars read as pentagonal prisms;
    the flat feet need ~25 deg to keep their corners.
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


def box_at(name, size, location, radius=0.005, segments=1):
    """Bevelled box baked into world space -- `M.rounded_box`'s `location=`
    only writes `obj.location`, and `M.join` reads a `matrix_world` that
    Blender has not refreshed in a headless run, so the offset is lost."""
    obj = M.rounded_box(name, size=size, radius=radius, segments=segments)
    obj.location = (0.0, 0.0, 0.0)
    dx, dy, dz = location
    for v in obj.data.vertices:
        v.co.x += dx
        v.co.y += dy
        v.co.z += dz
    obj.data.update()
    return obj


def sweep(name, points, radius, sides, caps, material):
    obj = M.tube(name, points, radius, sides=sides, caps=caps)
    mat.assign_all(obj, material)
    return obj


# ---------------------------------------------------------------------------
# parts
# ---------------------------------------------------------------------------

def build_frame(steel, out):
    for k, x in enumerate((POST_X0, POST_X1)):
        out.append(sweep("%s_post%d" % (NAME, k),
                         [(x, 0.0, 0.0), (x, 0.0, HEIGHT)],
                         POST_R, POST_SIDES, True, steel))

    for k, z in enumerate((TOP_RAIL_Z, BOT_RAIL_Z)):
        out.append(sweep("%s_rail%d" % (NAME, k),
                         [(POST_X0, 0.0, z), (POST_X1, 0.0, z)],
                         RAIL_R, POST_SIDES, False, steel))

    step = (POST_X1 - POST_X0) / float(N_BARS + 1)
    for k in range(N_BARS):
        x = POST_X0 + step * (k + 1)
        out.append(sweep("%s_bar%d" % (NAME, k),
                         [(x, 0.0, BOT_RAIL_Z), (x, 0.0, TOP_RAIL_Z)],
                         BAR_R, BAR_SIDES, False, steel))


def build_feet(fitting, out):
    """Flat folding feet, both projecting to the same side (+Y)."""
    for k, x in enumerate((POST_X0, POST_X1)):
        foot = box_at("%s_foot%d" % (NAME, k),
                      (FOOT_W, FOOT_LEN, FOOT_T),
                      (x, FOOT_LEN * 0.5 - 0.07, FOOT_T * 0.5),
                      radius=0.005)
        mat.assign_all(foot, fitting)
        out.append(foot)


def build_fittings(steel, out):
    """Hooks off the +X end, eyes on the -X end -- how barriers chain up."""
    for k, z in enumerate(HOOK_Z):
        hook = [(POST_X1, 0.0, z),
                (PITCH - 0.045, 0.0, z),
                (PITCH - 0.004, 0.0, z - 0.014),
                (PITCH + 0.005, 0.0, z - 0.052),
                (PITCH - 0.020, 0.0, z - 0.083)]
        out.append(sweep("%s_hook%d" % (NAME, k), hook, 0.0105,
                         BAR_SIDES, True, steel))

        eye = [(POST_X0, 0.0, z + 0.062),
               (0.014, 0.0, z + 0.056),
               (-0.022, 0.0, z + 0.034),
               (-0.036, 0.0, z),
               (-0.022, 0.0, z - 0.034),
               (0.014, 0.0, z - 0.056),
               (POST_X0, 0.0, z - 0.062)]
        out.append(sweep("%s_eye%d" % (NAME, k), eye, 0.0092,
                         BAR_SIDES, False, steel))


def main():
    args = cli.parse({"draco": False})
    cli.setup(args.seed, NAME)

    steel = mat.principled("fence_steel", mat.STEEL, roughness=0.40,
                           metallic=1.0, specular=0.5)
    fitting = mat.principled("fence_foot", mat.STEEL_DARK, roughness=0.52,
                             metallic=1.0)

    parts = []
    build_frame(steel, parts)
    build_fittings(steel, parts)
    build_feet(fitting, parts)

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-5)
    # `M.join` does not carry loop data across, so every part except the
    # first arrives with collapsed UVs; re-project at 1 UV unit per metre.
    uvtools.cube_project(obj, 1.0)
    print("FENCE tris=%d" % M.tri_count(obj))

    thresholds = {"fence_steel": 76.0, "fence_foot": 26.0}
    shade_by_material(obj, thresholds)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40, 0.12),
                             smooth_angle=None)
    for o in lods:
        shade_by_material(o, thresholds)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "repeatPitchX": PITCH,
        "heightM": HEIGHT,
        "originNote": ("ground level at the -X end of the segment; "
                       "segment runs along +X, feet project to +Y"),
        # build.mjs only copies a whitelist of extras into manifest.json, and
        # repeatPitchX is not on it -- mirror it into `notes`, which is.
        "notes": ("repeatPitchX = %.2f m: instance at that spacing along +X "
                  "for a seamless run" % PITCH),
    })


main()
