"""control-stand -- portable tripod that carries the control flag and SI unit.

Three galvanised steel legs splay out of a moulded hub at ~0.40 m and reach
the ground on rubber feet at a 0.42 m footprint radius.  A 25 mm mast rises
out of the same hub to 1.25 m, carrying a clamp-on bracket for the SI station
at 0.85 m and a short cranked arm at the top that the control flag hangs from.

Everything round is swept with `M.tube` / `M.revolve` and smooth shaded above
the facet angle of its own segment count, so no part reads as a raw cylinder:
6-8 sided tubes need >60 deg / >45 deg respectively before the side edges are
treated as smooth.

Origin: ground level, centre of the tripod footprint, +Z up.
Exports `flagHangZ` (top of the hang arm, where control-flag's hook sits) and
`siMountZ` (top face of the SI bracket plate) so the scene can place the other
two props without re-deriving the geometry.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "control-stand"

# --- mast -----------------------------------------------------------------
MAST_R = 0.0150          # 30 mm outside diameter -- field tube, not wire
MAST_Z0 = 0.320          # bottom, plugs the underside of the hub
MAST_Z1 = 1.2385         # top of the tube; the dome caps it off
MAST_TOP = 1.2555        # finished height

# --- hub / legs -----------------------------------------------------------
# Collars start and end on a ring of exactly MAST_R so they seal against the
# mast instead of tapering to a cone tip inside it -- the revolve and the tube
# share the same 8-gon phase, so the two silhouettes meet exactly.
HUB_Z0, HUB_Z1, HUB_R = 0.336, 0.472, 0.0320
FOOT_R = 0.420           # footprint radius
# Offset from the cardinal axes so no leg projects onto the mast (or onto
# another leg) in an axis-aligned view.
LEG_AZIMUTHS = (math.pi / 3.0, math.pi, math.pi * 5.0 / 3.0)

# --- mounts ---------------------------------------------------------------
SI_MOUNT_Z = 0.850       # top face of the bracket plate
ARM_R = 0.0090           # same stock as the mast, one size down
ARM_Z = 1.2210
# Out level, then a smooth arc down into a cradle and back up into a stop:
# the cradle is where a control-flag hook settles, the stop is what keeps it
# from sliding off.  Enough path points that the bend reads as a curve.
ARM_PATH = [(0.004, 0.0, ARM_Z),
            (0.055, 0.0, ARM_Z),
            (0.100, 0.0, ARM_Z - 0.0015),
            (0.134, 0.0, ARM_Z - 0.0070),
            (0.158, 0.0, ARM_Z - 0.0125),
            (0.176, 0.0, ARM_Z - 0.0100),
            (0.186, 0.0, ARM_Z + 0.0020)]
ARM_RADII = [ARM_R, ARM_R, 0.0089, 0.0087, 0.0084, 0.0078, 0.0068]
FLAG_HANG_X = 0.158
FLAG_HANG_Z = ARM_Z - 0.0125 + 0.0084   # top of the rod at the cradle

# Facet angles: a regular n-gon sweep has 360/n between neighbouring side
# faces, so the smoothing limit has to clear that but stay under the 90 deg
# of a cap or a shoulder.
SMOOTH_8 = 50.0
SMOOTH_6 = 66.0
SMOOTH_ROUND = 78.0      # domes and swept bends: everything but the end caps


def move(obj, offset):
    """Translate mesh data (revolve/tube build at the origin)."""
    ox, oy, oz = offset
    for v in obj.data.vertices:
        v.co.x += ox
        v.co.y += oy
        v.co.z += oz
    obj.data.update()
    return obj


def lathe(name, profile, material, segments=8, smooth=SMOOTH_8, offset=None,
          uv_scale=0.25):
    """Closed solid of revolution: profiles start and end on the axis."""
    obj = M.revolve("%s_%s" % (NAME, name), profile, segments=segments)
    if offset:
        move(obj, offset)
    M.shade_smooth(obj, smooth)
    uvtools.cylinder_project(obj, uv_scale)
    mat.assign_all(obj, material)
    return obj


def swept(name, points, radii, material, sides=8, caps=True, smooth=SMOOTH_8):
    obj = M.tube("%s_%s" % (NAME, name), points, radii, sides=sides, caps=caps)
    M.shade_smooth(obj, smooth)
    uvtools.cylinder_project(obj, 0.22)
    mat.assign_all(obj, material)
    return obj


def build_mast(steel):
    return swept("mast", [(0.0, 0.0, MAST_Z0), (0.0, 0.0, MAST_Z1)],
                 MAST_R, steel, sides=8, caps=True)


def build_mast_cap(steel):
    """Domed ferrule -- a flat octagonal cap would read as a cut-off pipe.

    Smoothed at SMOOTH_ROUND so the pole does not show as a faceted gem tip.
    """
    return lathe("cap", [(MAST_R, MAST_Z1),
                         (MAST_R * 0.985, MAST_Z1 + 0.0040),
                         (MAST_R * 0.860, MAST_Z1 + 0.0100),
                         (MAST_R * 0.520, MAST_Z1 + 0.0148),
                         (0.0, MAST_TOP)], steel, smooth=SMOOTH_ROUND)


def build_hub(plastic):
    """Moulded hub: barrel with a shoulder at the top where the legs pivot."""
    return lathe("hub", [(MAST_R, HUB_Z0),
                         (0.0255, HUB_Z0 + 0.008),
                         (HUB_R, HUB_Z0 + 0.024),
                         (HUB_R, HUB_Z1 - 0.020),
                         (0.0245, HUB_Z1 - 0.006),
                         (MAST_R, HUB_Z1)], plastic)


def build_leg(index, azimuth, steel):
    """Straight-ish leg with a slight outward bow, tapering towards the foot.

    Both ends are left open (`caps=False`): the top is swallowed by the hub
    and the bottom by the foot, so the caps would only cost triangles.
    """
    ca, sa = math.cos(azimuth), math.sin(azimuth)
    profile = [(0.012, 0.448), (0.157, 0.310), (0.292, 0.166), (FOOT_R, 0.014)]
    pts = [(r * ca, r * sa, z) for r, z in profile]
    return swept("leg%d" % index, pts, [0.0110, 0.0104, 0.0096, 0.0088],
                 steel, sides=8, caps=False)


def build_foot(index, azimuth, plastic):
    """Squat rubber foot: wide contact pad, rolled rim, socket over the leg."""
    return lathe("foot%d" % index,
                 [(0.0, 0.0), (0.0265, 0.0), (0.0290, 0.0055),
                  (0.0245, 0.0165), (0.0150, 0.0250), (0.0, 0.0290)], plastic,
                 offset=(FOOT_R * math.cos(azimuth), FOOT_R * math.sin(azimuth), 0.0))


def build_si_clamp(plastic):
    return lathe("siclamp", [(MAST_R, 0.7800), (0.0235, 0.7920),
                             (0.0235, 0.8380), (MAST_R, 0.8500)], plastic)


def build_si_plate(plastic):
    """Flat bracket the SI station bolts onto; top face at SI_MOUNT_Z.

    Built at the origin and translated in mesh space on purpose -- object-level
    placement would not survive the join (see `move`).
    """
    t = 0.011
    obj = M.rounded_box("%s_siplate" % NAME, size=(0.125, 0.070, t),
                        radius=0.0034, segments=1)
    move(obj, (-0.0700, 0.0, SI_MOUNT_Z - t * 0.5))
    M.shade_smooth(obj, 34.0)
    uvtools.cube_project(obj, 0.25)
    mat.assign_all(obj, plastic)
    return obj


def build_arm_collar(plastic):
    return lathe("armcollar", [(MAST_R, 1.1720), (0.0235, 1.1830),
                               (0.0235, 1.2250), (MAST_R, 1.2340)], plastic)


def build_arm(steel):
    """Cranked arm: runs out level, dips, then kicks up so the flag hook
    cannot slide off the end."""
    return swept("arm", ARM_PATH, ARM_RADII, steel, sides=8, caps=True,
                 smooth=SMOOTH_ROUND)


def main():
    args = cli.parse({"draco": False})
    cli.setup(args.seed, NAME)

    # Bright galvanised tube against dead-matte dark mouldings: the contrast is
    # what makes the hub, feet and brackets readable at game distance.
    steel = mat.principled("stand_steel", mat.STEEL, roughness=0.36,
                           metallic=1.0)
    plastic = mat.principled("stand_plastic", mat.PLASTIC_GREY, roughness=0.74,
                             metallic=0.0, specular=0.30)

    parts = [build_mast(steel), build_mast_cap(steel), build_hub(plastic)]
    for i, az in enumerate(LEG_AZIMUTHS):
        parts.append(build_leg(i, az, steel))
        parts.append(build_foot(i, az, plastic))
    parts.append(build_si_clamp(plastic))
    parts.append(build_si_plate(plastic))
    parts.append(build_arm_collar(plastic))
    parts.append(build_arm(steel))

    obj = M.join(parts, NAME)
    M.merge_doubles(obj, 1e-5)

    lods = lod.decimate_lods(obj, NAME, ratios=(1.0, 0.40, 0.12),
                             smooth_angle=SMOOTH_6)
    lod.report(lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, lods, extra={
        "flagHangZ": round(FLAG_HANG_Z, 4),
        "flagHangX": round(FLAG_HANG_X, 4),
        "siMountZ": round(SI_MOUNT_Z, 4),
        "height": round(MAST_TOP, 4),
        "footprintRadius": FOOT_R,
        "originNote": "ground level, centre of the tripod footprint, +Z up",
        "notes": ("hang control-flag so its hookTopZ meets flagHangZ at "
                  "x=flagHangX; sit si-unit's foot on siMountZ"),
    })


main()
