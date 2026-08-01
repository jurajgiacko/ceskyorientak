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
MAST_R = 0.0125          # 25 mm outside diameter
MAST_Z0 = 0.355          # bottom, buried in the hub
MAST_Z1 = 1.2405         # top of the tube; the dome caps it off
MAST_TOP = 1.2555        # finished height

# --- hub / legs -----------------------------------------------------------
HUB_Z0, HUB_Z1, HUB_R = 0.345, 0.455, 0.0265
FOOT_R = 0.420           # footprint radius
LEG_AZIMUTHS = (math.pi / 2.0, math.pi * 7.0 / 6.0, math.pi * 11.0 / 6.0)

# --- mounts ---------------------------------------------------------------
SI_MOUNT_Z = 0.850       # top face of the bracket plate
ARM_R = 0.0062
ARM_PATH = [(0.008, 0.0, 1.2190),
            (0.070, 0.0, 1.2200),
            (0.140, 0.0, 1.2170),
            (0.186, 0.0, 1.2110),
            (0.199, 0.0, 1.2265)]
FLAG_HANG_Z = 1.2170 + ARM_R   # top of the rod where the flag hook rests

# Facet angles: a regular n-gon sweep has 360/n between neighbouring side
# faces, so the smoothing limit has to clear that but stay under the 90 deg
# of a cap or a shoulder.
SMOOTH_8 = 50.0
SMOOTH_6 = 66.0


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
    return swept("mast",
                 [(0.0, 0.0, MAST_Z0), (0.0, 0.0, 0.62), (0.0, 0.0, 0.85),
                  (0.0, 0.0, 1.06), (0.0, 0.0, MAST_Z1)],
                 MAST_R, steel, sides=8, caps=True)


def build_mast_cap(steel):
    """Domed ferrule -- a flat octagonal cap would read as a cut-off pipe."""
    return lathe("cap", [(MAST_R, MAST_Z1),
                         (MAST_R * 0.94, MAST_Z1 + 0.0065),
                         (MAST_R * 0.64, MAST_Z1 + 0.0120),
                         (0.0, MAST_TOP)], steel)


def build_hub(plastic):
    """Moulded hub the legs and mast all disappear into."""
    return lathe("hub", [(0.0, HUB_Z0),
                         (HUB_R - 0.009, HUB_Z0),
                         (HUB_R, HUB_Z0 + 0.010),
                         (HUB_R, HUB_Z1 - 0.012),
                         (HUB_R - 0.009, HUB_Z1),
                         (0.0, HUB_Z1 + 0.004)], plastic)


def build_leg(index, azimuth, steel):
    """Straight-ish leg with a slight outward bow, tapering towards the foot.

    Both ends are left open (`caps=False`): the top is swallowed by the hub
    and the bottom by the foot, so the caps would only cost triangles.
    """
    ca, sa = math.cos(azimuth), math.sin(azimuth)
    profile = [(0.010, 0.437), (0.153, 0.303), (0.289, 0.162), (FOOT_R, 0.010)]
    pts = [(r * ca, r * sa, z) for r, z in profile]
    return swept("leg%d" % index, pts, [0.0098, 0.0091, 0.0082, 0.0072],
                 steel, sides=8, caps=False)


def build_foot(index, azimuth, plastic):
    """Squat rubber foot: wide contact pad, rolled rim, socket over the leg."""
    return lathe("foot%d" % index,
                 [(0.0, 0.0), (0.0165, 0.0), (0.0195, 0.0042),
                  (0.0165, 0.0165), (0.0, 0.0210)], plastic,
                 offset=(FOOT_R * math.cos(azimuth), FOOT_R * math.sin(azimuth), 0.0))


def build_si_clamp(plastic):
    return lathe("siclamp", [(0.0, 0.7920), (0.0175, 0.7975),
                             (0.0175, 0.8425), (0.0, 0.8480)], plastic)


def build_si_plate(plastic):
    """Flat bracket the SI station bolts onto; top face at SI_MOUNT_Z."""
    t = 0.007
    obj = M.rounded_box("%s_siplate" % NAME, size=(0.083, 0.055, t),
                        radius=0.0022, segments=1,
                        location=(-0.0535, 0.0, SI_MOUNT_Z - t * 0.5))
    M.apply_transform(obj, location=True)
    M.shade_smooth(obj, 34.0)
    uvtools.cube_project(obj, 0.25)
    mat.assign_all(obj, plastic)
    return obj


def build_arm_collar(plastic):
    return lathe("armcollar", [(0.0, 1.1880), (0.0175, 1.1940),
                               (0.0175, 1.2340), (0.0, 1.2400)], plastic)


def build_arm(steel):
    """Cranked arm: runs out level, dips, then kicks up so the flag hook
    cannot slide off the end."""
    return swept("arm", ARM_PATH,
                 [ARM_R, ARM_R, ARM_R, ARM_R * 0.95, ARM_R * 0.80],
                 steel, sides=8, caps=True)


def main():
    args = cli.parse({"draco": False})
    cli.setup(args.seed, NAME)

    steel = mat.principled("stand_steel", mat.STEEL, roughness=0.40,
                           metallic=1.0)
    plastic = mat.principled("stand_plastic", mat.STEEL_DARK, roughness=0.55,
                             specular=0.42)

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
        "flagHangX": round(ARM_PATH[2][0], 4),
        "siMountZ": round(SI_MOUNT_Z, 4),
        "height": round(MAST_TOP, 4),
        "footprintRadius": FOOT_R,
        "originNote": "ground level, centre of the tripod footprint, +Z up",
        "notes": ("hang control-flag so its hookTopZ meets flagHangZ at "
                  "x=flagHangX; sit si-unit's foot on siMountZ"),
    })


main()
