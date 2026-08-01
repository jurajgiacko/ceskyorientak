"""si-unit -- SportIdent-style control station, the box competitors punch.

A 145 x 65 x 40 mm moulded case: a yellow upper shell over a dark grey lower
shell, a 22 mm punch recess sunk into the top, a lit indicator beside it and a
mounting foot underneath that sits on control-stand's bracket plate.

Two things are worth calling out:

* The punch hole is real geometry, not a painted disc -- a lathed funnel is
  subtracted from the shell with a boolean, so the recess has a chamfered lip,
  a cylindrical bore and a floor, and holds up in silhouette.
* The yellow/grey seam is a bisect, not a face-height guess.  Bevelling a box
  leaves single faces spanning the whole side, so a predicate on face centres
  alone would flip entire corner patches to one colour; cutting a real edge
  loop at the parting line first gives a clean horizontal split.

Deliberately unbranded: no logo, no lettering, no decals anywhere.

Origin: bottom of the mounting foot, centred, +Z up.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bmesh  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "si-unit"

FOOT_H = 0.012
FOOT_SIZE = (0.054, 0.044, FOOT_H)

BODY_L, BODY_W, BODY_H = 0.145, 0.065, 0.040
BODY_Z0 = FOOT_H
BODY_Z1 = BODY_Z0 + BODY_H
SHELL_R = 0.0085         # corner radius of the moulding
SHELL_SEG = 3
SPLIT_Z = BODY_Z0 + 0.0175   # parting line, slightly below mid height

PUNCH_X = -0.0300
PUNCH_BORE = 0.0110      # 22 mm hole
PUNCH_MOUTH = 0.0128
PUNCH_DEPTH = 0.0105
PUNCH_SEGMENTS = 24

LED_X = 0.0155
LED_R = 0.0055

# Bevel steps are 22.5 deg and the bore facets 15 deg, so 34 deg rounds both
# the moulding and the bore, while the punch lip (55 deg), the chamfer/bore
# break (35 deg) and the bore floor stay crisp.  Pushing this any higher
# smears the chamfer into the bore and the recess reads as a soft dent.
SMOOTH = 34.0


def move(obj, offset):
    ox, oy, oz = offset
    for v in obj.data.vertices:
        v.co.x += ox
        v.co.y += oy
        v.co.z += oz
    obj.data.update()
    return obj


def boolean_difference(obj, cutter):
    """Subtract `cutter` via the modifier stack -- `bpy.ops` boolean needs a
    UI context that does not exist under --background."""
    M.add_mod(obj, "BOOLEAN", "punch", object=cutter, operation="DIFFERENCE",
              solver="EXACT")
    M.apply_mods(obj)
    M.remove(cutter)
    return obj


def bisect_z(obj, z):
    """Insert a horizontal edge loop so the shell colours can split on it."""
    bm = M.to_bmesh(obj)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6,
                           plane_co=(0.0, 0.0, z), plane_no=(0.0, 0.0, 1.0),
                           clear_inner=False, clear_outer=False)
    return M.write_bmesh(obj, bm)


def punch_cutter():
    """Funnel solid: wide mouth, short chamfer, straight bore, coned floor.

    Runs above the top face so the difference leaves a clean opening.
    """
    z = BODY_Z1
    profile = [(0.0, z + 0.008),
               (PUNCH_MOUTH, z + 0.008),
               (PUNCH_MOUTH, z + 0.0004),
               (PUNCH_BORE, z - 0.0022),
               (PUNCH_BORE, z - PUNCH_DEPTH),
               (0.0, z - PUNCH_DEPTH - 0.0016)]
    obj = M.revolve("%s_cutter" % NAME, profile, segments=PUNCH_SEGMENTS)
    return move(obj, (PUNCH_X, 0.0, 0.0))


def build_shell(yellow, grey):
    obj = M.rounded_box("%s_shell" % NAME, size=(BODY_L, BODY_W, BODY_H),
                        radius=SHELL_R, segments=SHELL_SEG)
    move(obj, (0.0, 0.0, BODY_Z0 + BODY_H * 0.5))

    boolean_difference(obj, punch_cutter())
    M.merge_doubles(obj, 1e-5)
    bisect_z(obj, SPLIT_Z)
    M.shade_smooth(obj, SMOOTH)
    uvtools.cube_project(obj, 0.15)

    mat.assign_all(obj, yellow)
    mat.assign_faces(obj, grey, lambda p, o: p.center.z < SPLIT_Z - 1e-5)
    # The recess interior reads as a dark cavity rather than yellow plastic.
    # The top face is excluded by the z test: it sits exactly on BODY_Z1.
    mat.assign_faces(obj, grey, lambda p, o: (
        p.center.z < BODY_Z1 - 0.001
        and math.hypot(p.center.x - PUNCH_X, p.center.y) < PUNCH_MOUTH))
    return obj


def build_led(led_mat):
    """Small lit indicator dome beside the punch hole, sunk slightly so the
    base ring does not show as a collar."""
    z = BODY_Z1 - 0.0006
    obj = M.revolve("%s_led" % NAME,
                    [(0.0, z), (LED_R, z), (LED_R * 0.90, z + 0.0024),
                     (0.0, z + 0.0050)], segments=10)
    move(obj, (LED_X, 0.0, 0.0))
    M.shade_smooth(obj, 72.0)
    uvtools.cylinder_project(obj, 0.1)
    mat.assign_all(obj, led_mat)
    return obj


def build_foot(grey):
    obj = M.rounded_box("%s_foot" % NAME, size=FOOT_SIZE, radius=0.0026,
                        segments=1)
    move(obj, (0.0, 0.0, FOOT_H * 0.5))
    M.shade_smooth(obj, 34.0)
    uvtools.cube_project(obj, 0.15)
    mat.assign_all(obj, grey)
    return obj


def main():
    args = cli.parse({"draco": False})
    cli.setup(args.seed, NAME)

    # Light on the clear coat: any more and the sun's white specular washes the
    # yellow out to cream and the grey shell stops reading as dark.
    yellow = mat.principled("si_shell_yellow", mat.PLASTIC_YELLOW,
                            roughness=0.38, specular=0.45, coat=0.06)
    grey = mat.principled("si_shell_grey", mat.PLASTIC_GREY, roughness=0.70,
                          specular=0.28)
    led = mat.principled("si_led", (0.80, 0.075, 0.050), roughness=0.16,
                         specular=0.6, coat=0.4,
                         emission=(1.0, 0.14, 0.06), emission_strength=1.5)

    parts = [build_shell(yellow, grey), build_led(led), build_foot(grey)]

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-5)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40, 0.12),
                             smooth_angle=SMOOTH)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "size": [BODY_L, BODY_W, BODY_H],
        "footHeight": FOOT_H,
        "punchHoleZ": round(BODY_Z1, 4),
        "punchHoleXY": [PUNCH_X, 0.0],
        "originNote": "bottom of the mounting foot, centred, +Z up",
        "notes": ("sit the foot on control-stand's siMountZ; unbranded by "
                  "design -- no logo, lettering or decals"),
    })


main()
