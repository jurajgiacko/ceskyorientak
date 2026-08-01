"""control-flag -- IOF orienteering control kite.

IOF spec: a 30 x 30 x 30 cm three-sided prism.  Each of the three faces is
divided by a diagonal running from the lower-left to the upper-right corner,
white in the upper-left half and orange in the lower-right half.

The white/orange boundary is baked into the topology rather than a texture:
the panel grid is triangulated with a forced TR_BL diagonal, so the cells on
the main diagonal split exactly along it and the material boundary is
geometrically crisp at any resolution.

Origin: centre of the fabric's bottom opening, +Z up.  The hook's top sits at
`hookTopZ` (reported in the glTF extras) for attaching to control-stand.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mathutils import Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "control-flag"
SIDE = 0.30          # triangle side length (m)
HEIGHT = 0.30        # fabric height (m)
GRID = 6             # cells per panel edge -> 2*GRID^2 tris per panel
BILLOW = 0.014       # fabric bulge at panel centre (m)


def triangle_corners(radius, phase=math.pi / 2.0):
    """Equilateral triangle corners, counter-clockwise seen from +Z."""
    return [Vector((radius * math.cos(phase + i * 2.0 * math.pi / 3.0),
                    radius * math.sin(phase + i * 2.0 * math.pi / 3.0),
                    0.0)) for i in range(3)]


def build_panel(index, corners, rng, white, orange):
    """One face of the prism, split white(top-left)/orange(bottom-right)."""
    a = corners[index]
    b = corners[(index + 1) % 3]
    # outward normal of this face (corners are CCW from above, so the face
    # normal points away from the axis)
    midpoint = (a + b) * 0.5
    outward = Vector((midpoint.x, midpoint.y, 0.0)).normalized()

    def fn(u, v):
        p = a.lerp(b, u) + Vector((0.0, 0.0, HEIGHT * v))
        # bulge: zero at the vertical corner seams, largest mid-panel, and
        # bigger low down where the fabric hangs free
        span = math.sin(math.pi * u)
        vertical = 0.35 + 0.65 * (1.0 - v)
        bulge = span * vertical * BILLOW
        # free bottom hem flares out slightly
        hem = (1.0 - v) ** 3 * 0.006
        # faint wrinkles so the panel is not a perfect ruled surface
        wrinkle = math.sin(u * 9.4 + index * 2.1) * math.cos(v * 6.1) * 0.0016
        p = p + outward * (bulge + hem + wrinkle)
        p.z += math.sin(u * math.pi) * (1.0 - v) * -0.004
        return tuple(p)

    obj = M.param_surface("%s_panel%d" % (NAME, index), fn, GRID, GRID,
                          diagonal="TR_BL")

    # u=0 is the left-hand corner seen from outside, v=0 the bottom hem, so
    # white is every triangle above the u=v diagonal.
    white_faces, orange_faces = [], []
    for i in range(GRID):
        for j in range(GRID):
            f0 = (i * GRID + j) * 2      # (a, b, c) -> lower-right of the cell
            f1 = f0 + 1                  # (a, c, d) -> upper-left of the cell
            (orange_faces if i >= j else white_faces).append(f0)
            (white_faces if j >= i else orange_faces).append(f1)

    mat.assign_all(obj, white)
    mat.assign_face_indices(obj, orange, orange_faces)
    M.shade_smooth(obj, 45.0)
    return obj


def rounded_triangle_outline(radius, corner_r, per_corner=3, phase=math.pi / 2.0):
    """Triangle outline with rounded corners -- the top plate's silhouette."""
    pts = []
    centres = triangle_corners(radius - corner_r * 1.7, phase)
    for k, c in enumerate(centres):
        base = phase + k * 2.0 * math.pi / 3.0
        for s in range(per_corner):
            a = base - math.pi / 3.0 + (s / (per_corner - 1.0)) * (2.0 * math.pi / 3.0)
            pts.append(Vector((c.x + corner_r * math.cos(a),
                               c.y + corner_r * math.sin(a), 0.0)))
    return pts


def build_top_plate(z0, thickness, radius, material):
    outline = rounded_triangle_outline(radius, corner_r=0.022, per_corner=3)
    n = len(outline)
    verts = [(p.x, p.y, z0 + thickness) for p in outline]
    verts += [(p.x, p.y, z0) for p in outline]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    obj = M.from_pydata("%s_plate" % NAME, verts, faces)
    M.recalc_normals(obj)
    M.bevel(obj, 0.0018, segments=1, angle_deg=25.0)
    uvtools.cube_project(obj, 0.25)
    M.shade_smooth(obj, 34.0)
    mat.assign_all(obj, material)
    return obj


def build_hook(z0, material):
    """Small J-hook: straight stem out of the plate, then a hooked arc."""
    stem_h = 0.026
    r = 0.019
    path = [(0.0, 0.0, z0 - 0.004),
            (0.0, 0.0, z0 + stem_h * 0.5),
            (0.0, 0.0, z0 + stem_h)]
    radii = [0.0026, 0.0026, 0.0025]

    zc = z0 + stem_h
    steps = 9
    for s in range(1, steps + 1):
        a = math.pi - (s / float(steps)) * (math.pi + math.radians(34))
        path.append((r + r * math.cos(a), 0.0, zc + r * math.sin(a)))
        radii.append(0.0025 - 0.0011 * (s / float(steps)))

    obj = M.tube("%s_hook" % NAME, path, radii, sides=6, caps=True)
    M.shade_smooth(obj, 50.0)
    uvtools.cylinder_project(obj, 0.2)
    mat.assign_all(obj, material)
    return obj


def main():
    args = cli.parse({"draco": False})
    rng = cli.setup(args.seed, NAME)

    fabric_white = mat.principled("flag_white", mat.IOF_WHITE, roughness=0.86,
                                  specular=0.28, sheen=0.35)
    fabric_orange = mat.principled("flag_orange", mat.IOF_ORANGE, roughness=0.86,
                                   specular=0.28, sheen=0.35)
    plastic = mat.principled("flag_plate", (0.055, 0.057, 0.062), roughness=0.55)
    steel = mat.principled("flag_hook", mat.STEEL, roughness=0.34, metallic=1.0)

    radius = SIDE / math.sqrt(3.0)
    corners = triangle_corners(radius)

    parts = [build_panel(i, corners, rng.sub("panel%d" % i), fabric_white,
                         fabric_orange) for i in range(3)]
    parts.append(build_top_plate(HEIGHT, 0.009, radius * 1.05, plastic))
    hook_z = HEIGHT + 0.009
    parts.append(build_hook(hook_z, steel))

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-5)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40, 0.12),
                             smooth_angle=45.0)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "hookTopZ": round(hook_z + 0.026 + 0.019, 4),
        "originNote": "centre of fabric bottom opening, +Z up",
    })


main()
