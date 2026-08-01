"""arena-tent -- 5 x 5 m white pop-up event marquee, open sided.

The roof is four hipped canvas panels, each a `M.param_surface` triangle
(eave corner -> eave corner -> apex) with a sag term that vanishes on all
three edges, so the fabric droops between the eave rails and the hip rafters
but stays welded to its neighbours along the hips.

The apex row of every panel collapses onto the single peak vertex; the
duplicate verts are removed by `M.merge_doubles` after the join, which turns
the degenerate top row of quads into proper triangles.

The eave valance is sampled on the same perimeter stations as the roof eave,
so the two weld into one continuous skirt.

Origin: centre of the footprint at ground level, +Z up.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mathutils import Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "arena-tent"

FRAME_HALF = 2.50       # leg centres -> 5.0 x 5.0 m footprint
CANVAS_HALF = 2.55      # canvas overhangs the frame slightly
EAVE_Z = 2.20
PEAK_Z = 3.40
VALANCE_H = 0.25

ROOF_NU = 10            # stations along one eave (VALANCE_NU = 4 * this)
ROOF_NV = 5             # eave -> apex
VALANCE_NU = 4 * ROOF_NU
VALANCE_NV = 2

ROOF_SAG = 0.115        # droop at the centre of a panel
EAVE_DROOP = 0.055      # dip of the eave line between corner legs
VALANCE_WAVES = 8       # scallops around the perimeter (40 stations -> 5/wave)
FRAME_SIDES = 6
LEG_R = 0.032        # 64 mm -- heavy-duty frame marquee leg
RAIL_R = 0.027
RAFTER_R = 0.023

CORNERS = [(-CANVAS_HALF, -CANVAS_HALF), (CANVAS_HALF, -CANVAS_HALF),
           (CANVAS_HALF, CANVAS_HALF), (-CANVAS_HALF, CANVAS_HALF)]


# ---------------------------------------------------------------------------
# local helpers
# ---------------------------------------------------------------------------

def shade_by_material(obj, thresholds, default=35.0):
    """Smooth shading with a per-material sharp-edge angle.

    `M.join` builds fresh edges, so per-part sharp flags do not survive it.
    Canvas needs a low limit (the hip creases are only ~35 deg and must stay
    crisp) while the 6-sided frame tubes need a limit above 60 deg or they
    read as hexagonal prisms.
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


def box_at(name, size, location, radius=0.006, segments=1):
    """Bevelled box baked into world space -- `M.rounded_box`'s `location=`
    only sets `obj.location`, which `M.join` reads through a `matrix_world`
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


def member(name, a, b, radius, caps, material):
    obj = M.tube(name, [tuple(a), tuple(b)], radius, sides=FRAME_SIDES, caps=caps)
    mat.assign_all(obj, material)
    return obj


def perimeter(t):
    """Point and outward normal on the canvas footprint rectangle, t in [0,1)."""
    s = (t % 1.0) * 4.0
    k = int(s) % 4
    f = s - int(s)
    p0 = Vector(CORNERS[k])
    p1 = Vector(CORNERS[(k + 1) % 4])
    p = p0.lerp(p1, f)
    edge = (p1 - p0).normalized()
    out = Vector((edge.y, -edge.x))          # corners are CCW -> outward
    return p, out, f


def eave_point(t):
    """Canvas eave line: dips between the corner legs like a tensioned hem.

    Roof panels and the valance both sample this, at matching stations
    (ROOF_NU per edge, VALANCE_NU = 4 * ROOF_NU), so the two weld into one
    surface in `M.merge_doubles`.
    """
    p, out, f = perimeter(t)
    z = EAVE_Z - math.sin(math.pi * f) * EAVE_DROOP
    return Vector((p.x, p.y, z)), out


# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------

def build_roof_panel(k, canvas):
    a = Vector((CORNERS[k][0], CORNERS[k][1], EAVE_Z))
    b = Vector((CORNERS[(k + 1) % 4][0], CORNERS[(k + 1) % 4][1], EAVE_Z))
    apex = Vector((0.0, 0.0, PEAK_Z))

    normal = (b - a).cross(apex - a).normalized()
    if normal.z < 0.0:
        normal = -normal

    def fn(u, v):
        eave, _ = eave_point((k + u) * 0.25)
        p = eave.lerp(apex, v)
        # Sag vanishes on all three panel edges: u=0 and u=1 are the hip
        # rafters, v=0 the eave rail, v=1 the peak.  Neighbouring panels
        # therefore still meet exactly along the hips.
        span = math.sin(math.pi * u) ** 1.15
        rise = math.sin(math.pi * v) * (1.0 - 0.30 * v)
        droop = span * rise * ROOF_SAG
        ripple = math.sin(u * 7.3 + k * 1.7) * math.cos(v * 3.9) * 0.12
        return tuple(p - normal * (droop * (1.0 + ripple)))

    obj = M.param_surface("%s_roof%d" % (NAME, k), fn, ROOF_NU, ROOF_NV)
    mat.assign_all(obj, canvas)
    return obj


def build_valance(canvas):
    """Eave flap.  Top row sits exactly on the roof's eave stations so the two
    weld together; the free hem waves and flares outward a little."""

    def fn(u, v):
        p, out = eave_point(u)
        _, _, f = perimeter(u)
        wave = math.sin(u * 2.0 * math.pi * VALANCE_WAVES)
        # The outward normal flips discontinuously at a corner, so the flare
        # has to fade out there or the two edges' skirts meet in a flap.
        corner = math.sin(math.pi * f) ** 0.5
        flare = out * (v * v * corner * (0.026 + 0.020 * wave))
        z = p.z - v * VALANCE_H + v * v * wave * 0.034
        return (p.x + flare.x, p.y + flare.y, z)

    obj = M.param_surface("%s_valance" % NAME, fn, VALANCE_NU, VALANCE_NV,
                          close_u=True)
    mat.assign_all(obj, canvas)
    return obj


# ---------------------------------------------------------------------------
# frame
# ---------------------------------------------------------------------------

def build_frame(steel, out):
    legs = [(sx * FRAME_HALF, sy * FRAME_HALF)
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

    for k, (x, y) in enumerate(legs):
        out.append(member("%s_leg%d" % (NAME, k), (x, y, 0.012),
                          (x, y, EAVE_Z), LEG_R, True, steel))
        foot = box_at("%s_foot%d" % (NAME, k), (0.19, 0.19, 0.022),
                      (x, y, 0.011), radius=0.005)
        mat.assign_all(foot, steel)
        out.append(foot)

    for k in range(4):
        x0, y0 = legs[k]
        x1, y1 = legs[(k + 1) % 4]
        out.append(member("%s_rail%d" % (NAME, k), (x0, y0, EAVE_Z),
                          (x1, y1, EAVE_Z), RAIL_R, False, steel))
        out.append(member("%s_rafter%d" % (NAME, k), (x0, y0, EAVE_Z),
                          (0.0, 0.0, PEAK_Z - 0.05), RAFTER_R, False, steel))

    out.append(member("%s_crown" % NAME, (0.0, 0.0, PEAK_Z - 0.15),
                      (0.0, 0.0, PEAK_Z - 0.035), 0.030, True, steel))


def main():
    args = cli.parse({"draco": False})
    cli.setup(args.seed, NAME)

    canvas = mat.principled("tent_canvas", (0.905, 0.910, 0.900),
                            roughness=0.74, specular=0.34, sheen=0.45)
    steel = mat.principled("tent_frame", mat.STEEL, roughness=0.42,
                           metallic=1.0)

    parts = [build_roof_panel(k, canvas) for k in range(4)]
    parts.append(build_valance(canvas))
    build_frame(steel, parts)

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-4)
    # `M.join` does not carry loop data across, so every part except the
    # first arrives with collapsed UVs; re-project at 1 UV unit per metre.
    uvtools.cube_project(obj, 1.0)
    print("TENT tris=%d" % M.tri_count(obj))

    # 44 deg keeps the ~65 deg roof/valance crease sharp but smooths the
    # ~35 deg hips, so the canopy reads as tensioned fabric, not folded card.
    thresholds = {"tent_canvas": 44.0, "tent_frame": 70.0}
    shade_by_material(obj, thresholds)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40), smooth_angle=None)
    for o in lods:
        shade_by_material(o, thresholds)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "footprintM": [FRAME_HALF * 2.0, FRAME_HALF * 2.0],
        "eaveZ": EAVE_Z,
        "peakZ": PEAK_Z,
        "originNote": "centre of the 5x5 m footprint at ground level, +Z up",
        "notes": "open sided; canvas overhangs the frame by 50 mm",
    })


main()
