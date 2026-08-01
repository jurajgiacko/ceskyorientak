"""orienteer -- rigged, animated elite orienteering athlete.

The only skinned asset in the library.  Everything else here is scenery; this
is the thing the player looks at, so it is built for *silhouette and kit
readability* rather than facial detail.  A low-poly attempt at a face is worse
than no face at all, so the head carries a jaw, a nose wedge, a cropped hair
mass and a single dark brow/eye band -- and nothing else.

Kit, all of it load-bearing for "this is an orienteer" rather than "this is a
runner":

  * sleeveless singlet with a low armhole (bare shoulders read as a vest)
  * short tights, hem at mid-thigh
  * **long socks / gaiters** covering the whole shin -- undergrowth protection
    and the single most characteristic silhouette cue of the sport
  * trail shoes with a heel counter and a contrasting outsole
  * a race bib on the chest: a flat panel, its own material, no branding
  * an SI stick / control card strapped to the right wrist
  * a folded map carried in the left hand, held across the chest

Construction is one generic sweep -- `loft()` -- driven by tables of
(point, radius_n, radius_b, superellipse_exponent).  Rotation-minimising frames
come from `M._rmf_frames`, so limbs bend without the profile twisting, and the
superellipse exponent is what turns the same routine from a round arm into a
flat-soled shoe.  Material bands are assigned per polygon by world position
(sock top, tights hem, armhole, sole), which is why the profile tables carry
deliberate radius *steps* at those heights: the step both makes the garment
read as a garment and gives `shade_smooth` a crease to break the shading on.

Rig: 20 bones (19 deforming), authored head/tail-first through edit_bones.
Skinning is computed in Python -- point-to-bone-segment distance, inverse
distance to the 5th power, top 4 influences, normalised -- restricted per body
part to a hand-written candidate list, so an arm can never pick up torso
weight no matter where it sits in the bind pose.  Automatic weights are not
used: `parent_set(type='ARMATURE_AUTO')` needs a real UI context and is not
reliable headless.

Bind pose is deliberately *not* a T-pose: right arm relaxed at the side, left
elbow at ~85 deg with the map held across the sternum.  That is the pose the
preview sheet renders and the pose every clip stays near, so the skin never
has to travel far from its bind.

Clips (30 fps, all authored as closed cycles -- frame N is evaluated at t=1.0
from the same periodic pose functions as t=0.0, so they loop exactly):

  idle  4.00 s  standing, weight shifting, breathing, map lowered to the waist
  jog   0.867 s easy running cycle
  run   0.667 s fast cycle: more knee lift, more arm drive, more forward lean
  map   3.00 s  slowed to a shuffle, map hand up in front of the face, head down

Origin: between the feet at ground level -- the soles touch z=0.
Forward:  +Y in Blender, which `export_yup` turns into **-Z in glTF/three.js**
          (three.js's own forward).  Same convention as `race-belt`.
Height:   1.78 m to the crown.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
from mathutils import Euler, Matrix, Quaternion, Vector  # noqa: E402

from lib import cli, exporter, mat, mesh as M, uvtools  # noqa: E402

NAME = "orienteer"
TAU = math.pi * 2.0
HEIGHT = 1.780
FPS = 30

# Sweep resolution.  Sides drive the round-ness of a limb; STEP is the maximum
# spacing between two consecutive sections along a sweep, and is what actually
# controls how well a joint deforms -- a knee needs loops through the bend, not
# more sides round the calf.
SIDES_TORSO = 30
SIDES_HEAD = 28
SIDES_NECK = 18
SIDES_ARM = 20
SIDES_LEG = 24
SIDES_FOOT = 18
SIDES_HAND = 14
STEP_BODY = 0.026
STEP_LIMB = 0.028
SMOOTH = 46.0

# --- skeleton landmarks ----------------------------------------------------
# Every one of these is also a vertex of the geometry tables below; the bones
# are placed on the mesh rather than the mesh fitted to the bones.
HIP_Z = 0.940
KNEE = Vector((0.100, 0.020, 0.505))
ANKLE = Vector((0.100, -0.006, 0.088))
TOE = Vector((0.100, 0.150, 0.030))
HIP = Vector((0.088, 0.010, HIP_Z))

SHOULDER = Vector((0.170, 0.000, 1.428))
ELBOW = Vector((0.196, 0.030, 1.132))
# Right arm hangs: forearm continues the upper arm with a few degrees of flex.
WRIST_R = Vector((0.207, 0.090, 0.880))
HAND_R = Vector((0.211, 0.126, 0.789))
# Left forearm is flexed ~85 deg and adducted ~55 deg so the hand -- and the
# map in it -- sits in front of the sternum.  Derived once, written out.
WRIST_L = Vector((-0.0026, 0.1968, 1.1354))
HAND_L = Vector((0.0726, 0.2600, 1.1368))

FOREARM_DIR_L = (HAND_L - WRIST_L).normalized()
FOREARM_DIR_R = (HAND_R - WRIST_R).normalized()


def mirror(v):
    """Same landmark on the left (-X) side."""
    return Vector((-v.x, v.y, v.z))


# ---------------------------------------------------------------------------
# generic sweep
# ---------------------------------------------------------------------------

def refine(sections, max_step):
    """Insert linearly interpolated sections so no gap exceeds `max_step`.

    Sections are (Vector point, rn, rb, exponent).  Deliberate radius *steps*
    in the tables (sock top, tights hem) are 1-2 mm apart along the path and
    so are never subdivided -- the step survives refinement, which is the
    whole point of doing it this way rather than resampling a spline.
    """
    out = []
    for i in range(len(sections) - 1):
        a, b = sections[i], sections[i + 1]
        d = (b[0] - a[0]).length
        n = max(1, int(math.ceil(d / max_step)))
        for k in range(n):
            t = k / float(n)
            out.append((
                a[0].lerp(b[0], t),
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t,
                a[3] + (b[3] - a[3]) * t,
            ))
    out.append(sections[-1])
    return out


def _unit(a, e):
    """Superellipse point: e=2 is a circle, e>2 squares off towards a slab."""
    ca, sa = math.cos(a), math.sin(a)
    p = 2.0 / e
    return (math.copysign(abs(ca) ** p, ca), math.copysign(abs(sa) ** p, sa))


def loft(name, sections, sides, cap_start=True, cap_end=True):
    """Sweep a superelliptical profile along a polyline.

    `M._rmf_frames` gives rotation-minimising frames, so the profile does not
    spin through a bend -- the same machinery `M.tube` uses, reached directly
    because this needs per-section elliptical radii and a variable exponent.
    The profile's first axis is the frame normal, the second the binormal:
    for a vertical path that is (X, Y); for a path running along +Y it is
    (Z, X), which is why the shoe table reads (height, width).
    """
    pts = [s[0] for s in sections]
    _tan, nrm, bnm = M._rmf_frames(pts)
    verts = []
    faces = []
    for i, (p, rn, rb, e) in enumerate(sections):
        for j in range(sides):
            u, v = _unit(TAU * j / sides, e)
            verts.append(tuple(p + nrm[i] * (u * rn) + bnm[i] * (v * rb)))
    for i in range(len(sections) - 1):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            c = (i + 1) * sides + (j + 1) % sides
            d = (i + 1) * sides + j
            faces.append((a, b, c, d))
    if cap_start:
        base = len(verts)
        verts.append(tuple(pts[0]))
        for j in range(sides):
            faces.append((base, (j + 1) % sides, j))
    if cap_end:
        top = len(verts)
        verts.append(tuple(pts[-1]))
        last = (len(sections) - 1) * sides
        for j in range(sides):
            faces.append((top, last + j, last + (j + 1) % sides))
    obj = M.from_pydata(name, verts, faces)
    M.recalc_normals(obj)
    return obj


def zsections(table, cx=0.0, cy=0.0):
    """(z, rn, rb, e) rows -> sections on a vertical path at (cx, cy)."""
    return [(Vector((cx, cy, z)), rn, rb, e) for z, rn, rb, e in table]


def path_sections(joints, table):
    """(s, rn, rb, e) rows, s in [0,1] of arc length along `joints`."""
    segs = [(joints[i], joints[i + 1]) for i in range(len(joints) - 1)]
    lens = [(b - a).length for a, b in segs]
    total = sum(lens) or 1.0
    cum = [0.0]
    for l in lens:
        cum.append(cum[-1] + l)

    def at(s):
        d = s * total
        for i, (a, b) in enumerate(segs):
            if d <= cum[i + 1] or i == len(segs) - 1:
                t = (d - cum[i]) / (lens[i] or 1.0)
                return a.lerp(b, max(0.0, min(1.0, t)))
        return joints[-1]

    return [(at(s), rn, rb, e) for s, rn, rb, e in table]


# ---------------------------------------------------------------------------
# geometry tables
# ---------------------------------------------------------------------------

# (z, half-width X, half-depth Y, exponent).  Steps at 1.028/1.036 are the
# tights waistband edge; the shoulders taper to a near-pole so the neck sits
# in a socket rather than on a flat disc.
TORSO = [
    (0.836, 0.062, 0.056, 2.2),
    (0.858, 0.104, 0.086, 2.3),
    (0.900, 0.125, 0.098, 2.3),
    (0.945, 0.129, 0.100, 2.3),
    (0.990, 0.123, 0.096, 2.3),
    (1.028, 0.116, 0.090, 2.3),
    (1.036, 0.111, 0.086, 2.4),
    (1.080, 0.107, 0.084, 2.4),
    (1.130, 0.112, 0.086, 2.4),
    (1.185, 0.122, 0.091, 2.4),
    (1.240, 0.134, 0.096, 2.4),
    (1.295, 0.145, 0.100, 2.4),
    (1.345, 0.151, 0.101, 2.4),
    (1.390, 0.150, 0.098, 2.4),
    (1.425, 0.141, 0.091, 2.5),
    (1.455, 0.117, 0.080, 2.6),
    (1.480, 0.085, 0.066, 2.6),
    (1.502, 0.046, 0.043, 2.4),
]

NECK = [
    (1.398, 0.052, 0.054, 2.2),
    (1.440, 0.049, 0.051, 2.2),
    (1.500, 0.046, 0.048, 2.2),
    (1.556, 0.045, 0.047, 2.2),
]

# Head: cy pushes the mass back so the face stays flat and the occiput bulges.
HEAD = [
    (1.545, 0.043, 0.048, 2.3, 0.004),
    (1.566, 0.058, 0.068, 2.3, -0.002),
    (1.590, 0.070, 0.082, 2.2, -0.006),
    (1.615, 0.078, 0.090, 2.2, -0.008),
    (1.642, 0.084, 0.095, 2.2, -0.010),
    (1.668, 0.087, 0.097, 2.2, -0.012),
    (1.694, 0.088, 0.096, 2.2, -0.014),
    (1.720, 0.086, 0.092, 2.2, -0.014),
    (1.744, 0.078, 0.083, 2.2, -0.013),
    (1.764, 0.062, 0.066, 2.2, -0.010),
    (1.776, 0.034, 0.037, 2.2, -0.008),
]

# Leg, hip to inside the shoe.  0.760/0.752 is the tights hem, 0.442/0.434 the
# sock top -- both authored as a two-row radius step.
TIGHTS_HEM = 0.756
SOCK_TOP = 0.438
LEG = [
    (0.995, 0.075, 0.078, 2.2, 0.084, 0.006),
    (0.945, 0.086, 0.089, 2.2, 0.088, 0.010),
    (0.880, 0.085, 0.088, 2.2, 0.091, 0.014),
    (0.820, 0.080, 0.083, 2.2, 0.094, 0.018),
    (0.760, 0.075, 0.078, 2.2, 0.096, 0.020),
    (0.752, 0.069, 0.072, 2.2, 0.096, 0.020),
    (0.700, 0.066, 0.069, 2.2, 0.097, 0.021),
    (0.620, 0.060, 0.063, 2.2, 0.099, 0.021),
    (0.560, 0.055, 0.058, 2.2, 0.100, 0.021),
    (0.505, 0.052, 0.056, 2.3, 0.100, 0.020),
    (0.470, 0.052, 0.057, 2.3, 0.100, 0.014),
    (0.442, 0.054, 0.060, 2.3, 0.100, 0.008),
    (0.434, 0.059, 0.065, 2.3, 0.100, 0.007),
    (0.390, 0.061, 0.067, 2.3, 0.100, 0.003),
    (0.330, 0.056, 0.062, 2.3, 0.100, -0.001),
    (0.270, 0.048, 0.053, 2.3, 0.100, -0.004),
    (0.210, 0.041, 0.045, 2.3, 0.100, -0.006),
    (0.150, 0.036, 0.039, 2.3, 0.100, -0.007),
    (0.105, 0.033, 0.036, 2.3, 0.100, -0.007),
    (0.072, 0.031, 0.034, 2.3, 0.100, -0.007),
]

# Shoe swept along +Y: profile axes are (height Z, width X).
SHOE = [
    (-0.072, 0.052, 0.046, 0.028, 2.8),
    (-0.058, 0.050, 0.048, 0.037, 3.0),
    (-0.020, 0.045, 0.043, 0.044, 3.2),
    (0.015, 0.041, 0.039, 0.047, 3.2),
    (0.055, 0.037, 0.035, 0.048, 3.4),
    (0.095, 0.033, 0.031, 0.046, 3.4),
    (0.135, 0.030, 0.027, 0.041, 3.4),
    (0.168, 0.028, 0.023, 0.031, 3.2),
    (0.184, 0.028, 0.016, 0.017, 2.8),
]
SHOE_COLLAR = [
    (0.026, 0.045, 0.053, 2.8),
    (0.058, 0.043, 0.051, 2.8),
    (0.084, 0.040, 0.047, 2.8),
    (0.101, 0.036, 0.043, 2.8),
]

# Arm, shoulder -> elbow -> wrist, as fractions of arc length.
ARM = [
    (0.000, 0.052, 0.052, 2.1),
    (0.045, 0.056, 0.056, 2.1),
    (0.120, 0.053, 0.053, 2.1),
    (0.250, 0.047, 0.047, 2.1),
    (0.380, 0.041, 0.042, 2.1),
    (0.480, 0.037, 0.039, 2.2),
    (0.535, 0.036, 0.038, 2.2),
    (0.640, 0.039, 0.041, 2.2),
    (0.740, 0.040, 0.042, 2.2),
    (0.850, 0.035, 0.037, 2.2),
    (0.940, 0.030, 0.031, 2.2),
    (1.000, 0.027, 0.028, 2.2),
]

# Mitten: thin across the frame normal, wide across the binormal.
HAND = [
    (0.00, 0.021, 0.029, 2.3),
    (0.28, 0.021, 0.040, 2.6),
    (0.56, 0.020, 0.041, 2.6),
    (0.82, 0.017, 0.036, 2.5),
    (1.00, 0.010, 0.019, 2.3),
]


# ---------------------------------------------------------------------------
# parts
# ---------------------------------------------------------------------------

def build_torso(m):
    obj = loft("of_torso", refine(zsections(TORSO), STEP_BODY), SIDES_TORSO)
    mat.assign_all(obj, m["tights"])
    mat.assign_faces(obj, m["singlet"], lambda p, o: p.center.z >= 1.030)
    # Sleeveless: the armhole is cut low, so above the sternum the flanks are
    # skin.  Without this the singlet reads as a T-shirt with tiny sleeves.
    mat.assign_faces(obj, m["skin"], lambda p, o: (
        p.center.z >= 1.432
        or (p.center.z >= 1.318 and abs(p.center.x) >= 0.093)))
    return obj


def build_neck(m):
    obj = loft("of_neck", refine(zsections(NECK, cy=-0.006), STEP_BODY),
               SIDES_NECK)
    mat.assign_all(obj, m["skin"])
    return obj


def build_head(m, rng):
    tilt = rng.uniform(-0.004, 0.004)   # a head is never perfectly centred
    sections = [(Vector((tilt * (z - 1.545) * 4.0, cy, z)), rn, rb, e)
                for z, rn, rb, e, cy in HEAD]
    obj = loft("of_head", refine(sections, 0.022), SIDES_HEAD)
    mat.assign_all(obj, m["skin"])
    # Cropped hair: crown, occiput and a sideburn line.  Kept as a material
    # band rather than a shell -- a 3 mm hair shell costs 700 triangles and
    # reads identically at any distance the player ever sees this from.
    mat.assign_faces(obj, m["hair"], lambda p, o: (
        p.center.z >= 1.706
        or (p.center.z >= 1.630 and p.center.y <= -0.024)
        or (p.center.z >= 1.660 and abs(p.center.x) >= 0.074)))
    # The only face feature: a dark band where brow and eye socket sit.  Read
    # as shadow, not as eyes -- two painted-on eyeballs at this resolution are
    # what makes a stylised head uncanny.
    mat.assign_faces(obj, m["hair"], lambda p, o: (
        1.650 <= p.center.z <= 1.680 and p.center.y >= 0.052
        and 0.016 <= abs(p.center.x) <= 0.068))
    return obj


def build_nose(m):
    pts = [Vector((0.0, 0.058, 1.680)), Vector((0.0, 0.086, 1.660)),
           Vector((0.0, 0.080, 1.641))]
    sections = [(pts[0], 0.013, 0.011, 2.2),
                (pts[1], 0.011, 0.010, 2.2),
                (pts[2], 0.014, 0.011, 2.2)]
    obj = loft("of_nose", sections, 10)
    mat.assign_all(obj, m["skin"])
    return obj


def build_leg(side, m):
    sx = 1.0 if side == "R" else -1.0
    sections = [(Vector((sx * cx, cy, z)), rn, rb, e)
                for z, rn, rb, e, cx, cy in LEG]
    obj = loft("of_leg" + side, refine(sections, STEP_LIMB), SIDES_LEG)
    mat.assign_all(obj, m["skin"])
    mat.assign_faces(obj, m["tights"], lambda p, o: p.center.z >= TIGHTS_HEM)
    mat.assign_faces(obj, m["sock"], lambda p, o: p.center.z <= SOCK_TOP)
    return obj


def build_shoe(side, m):
    sx = 1.0 if side == "R" else -1.0
    body = loft("of_shoe" + side,
                refine([(Vector((sx * 0.100, y, z)), rn, rb, e)
                        for y, z, rn, rb, e in SHOE], 0.024),
                SIDES_FOOT)
    collar = loft("of_shoec" + side,
                  refine(zsections(SHOE_COLLAR, cx=sx * 0.100, cy=-0.020),
                         0.022),
                  16)
    for o in (body, collar):
        mat.assign_all(o, m["shoe"])
        mat.assign_faces(o, m["sole"], lambda p, obj: p.center.z <= 0.015)
    return [body, collar]


def arm_joints(side):
    s = SHOULDER if side == "R" else mirror(SHOULDER)
    e = ELBOW if side == "R" else mirror(ELBOW)
    w = WRIST_R if side == "R" else WRIST_L
    return [s, e, w]


def build_arm(side, m):
    obj = loft("of_arm" + side,
               refine(path_sections(arm_joints(side), ARM), STEP_LIMB),
               SIDES_ARM)
    mat.assign_all(obj, m["skin"])
    return obj


def build_hand(side, m):
    w = WRIST_R if side == "R" else WRIST_L
    d = FOREARM_DIR_R if side == "R" else FOREARM_DIR_L
    joints = [w + d * 0.004, w + d * 0.104]
    obj = loft("of_hand" + side, refine(path_sections(joints, HAND), 0.016),
               SIDES_HAND)
    mat.assign_all(obj, m["skin"])
    # thumb: a stub on the frame-normal side, enough to read as a grip
    up = Vector((0, 0, 1))
    across = d.cross(up)
    if across.length < 1e-6:
        across = Vector((1, 0, 0))
    across.normalize()
    sx = 1.0 if side == "R" else -1.0
    base = w + d * 0.030 - across * (sx * 0.016)
    tip = w + d * 0.070 - across * (sx * 0.026)
    thumb = loft("of_thumb" + side,
                 [(base, 0.014, 0.014, 2.1),
                  (base.lerp(tip, 0.5), 0.012, 0.012, 2.1),
                  (tip, 0.008, 0.008, 2.1)], 8)
    mat.assign_all(thumb, m["skin"])
    return [obj, thumb]


def torso_radius(z):
    """(half-width, half-depth) of the torso at height z -- used to sit the
    race bib on the chest surface instead of guessing at it."""
    rows = TORSO
    if z <= rows[0][0]:
        return rows[0][1], rows[0][2]
    for i in range(len(rows) - 1):
        z0, rn0, rb0, _ = rows[i]
        z1, rn1, rb1, _ = rows[i + 1]
        if z0 <= z <= z1:
            t = (z - z0) / ((z1 - z0) or 1.0)
            return rn0 + (rn1 - rn0) * t, rb0 + (rb1 - rb0) * t
    return rows[-1][1], rows[-1][2]


def build_bib(m):
    """Flat race-number panel on the chest.  Its own material, a clean planar
    UV island filling 0..1, and no geometry that spells anything -- number art
    is a runtime texture decision, not a mesh decision."""
    z0, z1 = 1.212, 1.372
    hx = 0.079
    nu, nv = 9, 8
    verts = []
    faces = []
    for i in range(nu + 1):
        u = i / float(nu)
        x = (u - 0.5) * 2.0 * hx
        for j in range(nv + 1):
            v = j / float(nv)
            z = z0 + (z1 - z0) * v
            rn, rb = torso_radius(z)
            k = max(0.0, 1.0 - (x / rn) ** 2)
            verts.append((x, rb * math.sqrt(k) + 0.0035, z))
    for i in range(nu):
        for j in range(nv):
            a = i * (nv + 1) + j
            faces.append((a, a + nv + 1, a + nv + 2, a + 1))
    obj = M.from_pydata("of_bib", verts, faces)
    M.recalc_normals(obj)
    mat.assign_all(obj, m["bib"])
    uvtools.set_face_uv_rect(obj, range(len(obj.data.polygons)))
    return obj


def build_si(m):
    """SI stick / control card on the right wrist: moulded body plus strap."""
    d = FOREARM_DIR_R
    up = Vector((0, 0, 1))
    across = d.cross(up).normalized()
    centre = WRIST_R - d * 0.010
    out = across * 0.030 + Vector((0.0, -0.010, 0.0))
    body = loft("of_si",
                [(centre + out - d * 0.028, 0.007, 0.009, 2.6),
                 (centre + out - d * 0.014, 0.010, 0.013, 3.0),
                 (centre + out + d * 0.016, 0.010, 0.013, 3.0),
                 (centre + out + d * 0.030, 0.007, 0.009, 2.6)], 10)
    mat.assign_all(body, m["si"])

    a1 = across
    a2 = d.cross(a1).normalized()

    def strap(u, v):
        au, av = TAU * u, TAU * v
        n = a1 * math.cos(au) + a2 * math.sin(au)
        c = centre + n * 0.034
        return tuple(c + n * (math.cos(av) * 0.0045)
                     + d * (math.sin(av) * 0.0075))

    band = M.param_surface("of_sistrap", strap, 14, 6,
                           close_u=True, close_v=True)
    M.recalc_normals(band)
    mat.assign_all(band, m["tights"])
    return [body, band]


def build_map(m, rng):
    """Folded map carried in the left hand, tilted up towards the face.

    Built as a bowed grid with a centre crease and then solidified: a folded
    map is never flat, and the crease is what stops it reading as a floating
    white rectangle.
    """
    d = FOREARM_DIR_L
    a1 = d
    a2 = (Vector((-d.y, d.x, 0.0)).normalized() * math.cos(math.radians(34.0))
          + Vector((0, 0, 1)) * math.sin(math.radians(34.0)))
    a2.normalize()
    n = a1.cross(a2).normalized()
    centre = WRIST_L + d * 0.062 + Vector((0.0, 0.0, 0.014)) + n * 0.012
    w, h = 0.196, 0.152
    tilt = rng.uniform(-0.02, 0.02)
    nu, nv = 10, 8
    verts = []
    faces = []
    for i in range(nu + 1):
        u = i / float(nu) - 0.5
        for j in range(nv + 1):
            v = j / float(nv) - 0.5
            # gentle cylindrical bow plus a sharper crease down the middle
            bow = 0.010 * (0.25 - u * u) * 4.0
            crease = 0.006 * max(0.0, 1.0 - abs(u) * 6.0)
            verts.append(tuple(centre + a1 * (u * w) + a2 * (v * h * (1.0 + tilt))
                               + n * (bow + crease)))
    for i in range(nu):
        for j in range(nv):
            a = i * (nv + 1) + j
            faces.append((a, a + 1, a + nv + 2, a + nv + 1))
    obj = M.from_pydata("of_map", verts, faces)
    M.recalc_normals(obj)
    M.solidify(obj, 0.0022, offset=0.0)
    mat.assign_all(obj, m["map"])
    return obj


# ---------------------------------------------------------------------------
# rig
# ---------------------------------------------------------------------------

def bone_table():
    """(name, head, tail, parent, deform).  20 bones, 19 of them deforming."""
    rows = [
        ("root", Vector((0, 0, 0.0)), Vector((0, 0, 0.16)), None, False),
        ("hips", Vector((0, 0, HIP_Z)), Vector((0, 0, 1.050)), "root", True),
        ("spine", Vector((0, 0, 1.050)), Vector((0, 0, 1.240)), "hips", True),
        ("chest", Vector((0, 0, 1.240)), Vector((0, 0, 1.430)), "spine", True),
        ("neck", Vector((0, 0, 1.430)), Vector((0, 0, 1.545)), "chest", True),
        ("head", Vector((0, 0, 1.545)), Vector((0, 0, 1.700)), "neck", True),
    ]
    for side in ("R", "L"):
        sx = 1.0 if side == "R" else -1.0
        sh = SHOULDER if side == "R" else mirror(SHOULDER)
        el = ELBOW if side == "R" else mirror(ELBOW)
        wr = WRIST_R if side == "R" else WRIST_L
        hd = HAND_R if side == "R" else HAND_L
        rows += [
            ("clavicle." + side, Vector((sx * 0.030, 0.0, 1.396)),
             Vector((sx * 0.150, 0.0, 1.424)), "chest", True),
            ("upperarm." + side, sh, el, "clavicle." + side, True),
            ("forearm." + side, el, wr, "upperarm." + side, True),
            ("hand." + side, wr, hd, "forearm." + side, True),
            ("thigh." + side, Vector((sx * HIP.x, HIP.y, HIP.z)),
             Vector((sx * KNEE.x, KNEE.y, KNEE.z)), "hips", True),
            ("shin." + side, Vector((sx * KNEE.x, KNEE.y, KNEE.z)),
             Vector((sx * ANKLE.x, ANKLE.y, ANKLE.z)), "thigh." + side, True),
            ("foot." + side, Vector((sx * ANKLE.x, ANKLE.y, ANKLE.z)),
             Vector((sx * TOE.x, TOE.y, TOE.z)), "shin." + side, True),
        ]
    return rows


# Segments used for weighting only.  The pelvis bone stops at the hip joint,
# but the *surface* it should own runs down to the crotch; without the
# override the buttock verts get captured by the spine and the hips shear.
WEIGHT_SEG = {
    "hips": (Vector((0, 0, 0.862)), Vector((0, 0, 1.052))),
    "head": (Vector((0, 0, 1.575)), Vector((0, 0, 1.745))),
}


def build_armature(rows):
    data = bpy.data.armatures.new(NAME + "_rig")
    arm = bpy.data.objects.new(NAME + "_rig", data)
    M.link(arm)
    bpy.context.view_layer.objects.active = arm
    # object.mode_set is one of the few operators that genuinely works in
    # --background; edit_bones only exist inside EDIT mode.
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for name, head, tail, parent, deform in rows:
        b = eb.new(name)
        b.head = head
        b.tail = tail
        b.roll = 0.0
        b.use_deform = deform
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return arm


def seg_distance(p, a, b):
    ab = b - a
    d2 = ab.dot(ab)
    t = 0.0 if d2 < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / d2))
    return (p - (a + ab * t)).length


def compute_weights(co, candidates, segs, power=5.0, eps=0.022, keep=4):
    """Inverse-distance skinning against a hand-picked candidate bone list.

    Restricting the candidates per body part is what makes this safe: an arm
    vertex cannot pick up chest weight however close the bind pose puts it,
    which matters here because the bind pose folds the left arm across the
    sternum.  Power 5 keeps the mid-limb effectively rigid while still giving
    a real blend band at each joint, where two segments are equidistant.
    """
    scored = []
    for name in candidates:
        a, b = segs[name]
        w = 1.0 / ((seg_distance(co, a, b) + eps) ** power)
        scored.append((w, name))
    scored.sort(reverse=True)
    scored = scored[:keep]
    total = sum(w for w, _ in scored) or 1.0
    return [(name, w / total) for w, name in scored if w / total > 1e-4]


def part_candidates(part):
    """Which bones each part is allowed to be influenced by."""
    spine = ["hips", "spine", "chest", "neck"]
    if part == "torso":
        return spine + ["clavicle.R", "clavicle.L"]
    if part == "neck":
        return ["chest", "neck", "head"]
    if part in ("head", "nose"):
        return ["neck", "head"]
    if part == "bib":
        return ["spine", "chest"]
    for side in ("R", "L"):
        if part == "arm." + side:
            return ["chest", "clavicle." + side, "upperarm." + side,
                    "forearm." + side, "hand." + side]
        if part == "hand." + side:
            return ["forearm." + side, "hand." + side]
        if part == "leg." + side:
            return ["hips", "thigh." + side, "shin." + side, "foot." + side]
        if part == "shoe." + side:
            return ["shin." + side, "foot." + side]
        if part == "prop." + side:
            return ["hand." + side]
    return spine


# ---------------------------------------------------------------------------
# animation
# ---------------------------------------------------------------------------

def bone_rot(pb, rx, ry, rz):
    """Rotation given in *armature* axes (X right, Y forward, Z up), converted
    into the bone's local space.  Authoring poses in bone-local quaternions is
    unreadable; this keeps the pose tables in terms a human can check."""
    R = pb.bone.matrix_local.to_quaternion()
    Q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)),
              "XYZ").to_quaternion()
    return R.inverted() @ Q @ R


def bone_loc(pb, offset):
    return pb.bone.matrix_local.to_3x3().inverted() @ Vector(offset)


def gait(t, p):
    """One periodic running pose.  `t` in [0,1); pose(1) == pose(0) exactly,
    which is what makes the exported clip loop without a hitch."""
    tp = TAU * t
    pose = {}
    for side, ph in (("R", 0.0), ("L", math.pi)):
        s = 1.0 if side == "R" else -1.0
        a = tp + ph
        thigh = p["thigh_c"] + p["thigh_a"] * math.sin(a + p["phi"])
        flex = (p["knee_c"] - p["knee_a"] * math.cos(a)
                - p["knee_a2"] * math.cos(2.0 * a))
        ankle = p["ankle_c"] + p["ankle_a"] * math.sin(a + p["ankle_phi"])
        pose["thigh." + side] = (thigh, -s * p["splay"], 0.0)
        pose["shin." + side] = (-max(2.0, flex), 0.0, 0.0)
        pose["foot." + side] = (ankle, 0.0, 0.0)

        swing = math.sin(a + p["phi"])
        pose["upperarm." + side] = (p["arm_c"] - p["arm_a"] * swing,
                                    -s * p["arm_out"], 0.0)
        elbow = p["elbow_c"] + p["elbow_a"] * swing
        if side == "L":
            # the map hand never straightens -- he is carrying something
            elbow = max(elbow, p["map_elbow"])
        pose["forearm." + side] = (elbow, 0.0, 0.0)
    pose["hips"] = (0.0, p["hip_roll"] * math.sin(tp + 1.2),
                    p["hip_yaw"] * math.sin(tp + p["phi"]))
    pose["spine"] = (-p["lean"] * 0.35, 0.0, -p["hip_yaw"] * 0.6 * math.sin(tp + p["phi"]))
    pose["chest"] = (-p["lean"] * 0.65, 0.0, -p["hip_yaw"] * 0.9 * math.sin(tp + p["phi"]))
    pose["neck"] = (p["lean"] * 0.45, 0.0, 0.0)
    pose["head"] = (p["lean"] * 0.35, 0.0, 0.0)
    pose["upperarm.L"] = (pose["upperarm.L"][0] * 0.7 + p["map_arm"],
                          pose["upperarm.L"][1], 0.0)
    root = (p["sway"] * math.sin(tp),
            0.0,
            p["rise"] + p["bob"] * math.cos(2.0 * TAU * (t - 0.40)))
    return pose, root


def idle_pose(t, rng_phase):
    tp = TAU * t
    breathe = math.sin(TAU * 3.0 * t)
    shift = math.sin(tp + rng_phase)
    pose = {
        "hips": (1.0, 1.6 * shift, 2.6 * shift),
        "spine": (-1.5, -0.6 * shift, -1.4 * shift),
        "chest": (-2.4 + 1.1 * breathe, 0.0, -1.0 * shift),
        "neck": (1.2 - 0.5 * breathe, 0.0, 0.0),
        "head": (0.5, 0.0, 3.2 * math.sin(tp + 1.1)),
    }
    for side in ("R", "L"):
        s = 1.0 if side == "R" else -1.0
        pose["thigh." + side] = (2.0 + 2.6 * shift * s, -s * 2.5, 0.0)
        pose["shin." + side] = (-(7.0 + 3.0 * shift * s), 0.0, 0.0)
        pose["foot." + side] = (-2.0, 0.0, 0.0)
        pose["upperarm." + side] = (1.5 * shift, -s * 5.0, 0.0)
    # right arm hangs; left keeps the map, lowered to the waist
    pose["forearm.R"] = (14.0 + 3.0 * shift, 0.0, 0.0)
    pose["upperarm.L"] = (-4.0 + 1.5 * shift, 5.0, 0.0)
    pose["forearm.L"] = (-26.0 + 3.0 * shift, 0.0, 0.0)
    root = (0.013 * shift, 0.0, -0.006 + 0.004 * breathe)
    return pose, root


def map_pose(t):
    """Slowed to a shuffle with the map up in front of the face."""
    tp = TAU * t
    shuffle = math.sin(TAU * 2.0 * t)
    pose = {
        "hips": (-1.0, 1.2 * shuffle, 2.0 * shuffle),
        "spine": (-4.0, 0.0, -1.2 * shuffle),
        "chest": (-7.0 + 0.8 * math.sin(TAU * 4.0 * t), 0.0, -1.8 * shuffle),
        "neck": (-9.0, 0.0, 0.0),
        "head": (-13.0, 0.0, 2.0 * math.sin(tp + 0.6)),
    }
    for side in ("R", "L"):
        s = 1.0 if side == "R" else -1.0
        pose["thigh." + side] = (6.0 + 9.0 * shuffle * s, -s * 2.0, 0.0)
        pose["shin." + side] = (-(12.0 + 10.0 * max(0.0, shuffle * s)), 0.0, 0.0)
        pose["foot." + side] = (-3.0 + 5.0 * shuffle * s, 0.0, 0.0)
    pose["upperarm.R"] = (16.0 + 3.0 * shuffle, -7.0, 0.0)
    pose["forearm.R"] = (48.0, 0.0, 0.0)
    pose["upperarm.L"] = (26.0 + 2.0 * math.sin(tp), 6.0, 0.0)
    pose["forearm.L"] = (16.0 + 2.0 * math.sin(tp + 0.4), 0.0, 0.0)
    pose["hand.L"] = (-8.0, 0.0, 0.0)
    root = (0.005 * math.sin(tp), 0.0,
            -0.012 + 0.006 * math.cos(2.0 * TAU * (t - 0.4)))
    return pose, root


JOG = dict(thigh_c=6.0, thigh_a=25.0, phi=-3.330, knee_c=44.0, knee_a=36.0,
           knee_a2=6.0, ankle_c=-5.0, ankle_a=12.0, ankle_phi=0.6, splay=2.0,
           arm_c=3.0, arm_a=21.0, arm_out=7.0, elbow_c=62.0, elbow_a=12.0,
           map_elbow=52.0, map_arm=6.0, hip_roll=3.0, hip_yaw=4.5, lean=7.0,
           sway=0.008, rise=-0.012, bob=0.020)

RUN = dict(thigh_c=9.0, thigh_a=37.0, phi=-3.330, knee_c=62.0, knee_a=48.0,
           knee_a2=12.0, ankle_c=-7.0, ankle_a=17.0, ankle_phi=0.6, splay=2.5,
           arm_c=4.0, arm_a=33.0, arm_out=8.0, elbow_c=82.0, elbow_a=15.0,
           map_elbow=68.0, map_arm=9.0, hip_roll=4.0, hip_yaw=7.0, lean=13.0,
           sway=0.011, rise=-0.018, bob=0.031)


def bake_action(arm, name, frames, step, fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    keys = list(range(0, frames, step))
    if keys[-1] != frames:
        keys.append(frames)
    for f in keys:
        pose, root = fn(f / float(frames))
        for pb in arm.pose.bones:
            rx, ry, rz = pose.get(pb.name, (0.0, 0.0, 0.0))
            pb.rotation_quaternion = bone_rot(pb, rx, ry, rz)
            pb.keyframe_insert("rotation_quaternion", frame=f)
        rb = arm.pose.bones["root"]
        rb.location = bone_loc(rb, root)
        rb.keyframe_insert("location", frame=f)
    for fc in act.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    return act


def push_nla(arm, actions):
    """One action per NLA track.  Empirically the arrangement that makes the
    glTF exporter emit exactly four animations with exactly these names --
    ACTIONS mode also works but reorders them, and the runtime looks clips up
    by name, so the deterministic ordering is worth having."""
    arm.animation_data.action = None
    for act in actions:
        tr = arm.animation_data.nla_tracks.new()
        tr.name = act.name
        strip = tr.strips.new(act.name, 0, act)
        strip.name = act.name
    return arm


# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": False})
    rng = cli.setup(args.seed, NAME)
    bpy.context.scene.render.fps = FPS

    m = {
        # Linear base colours (see README: the palette is linear, not sRGB).
        "skin": mat.principled("orienteer_skin", (0.470, 0.268, 0.185),
                               roughness=0.62, specular=0.35),
        "hair": mat.principled("orienteer_hair", (0.038, 0.026, 0.018),
                               roughness=0.70, specular=0.30),
        "singlet": mat.principled("orienteer_singlet", (0.028, 0.086, 0.300),
                                  roughness=0.86, specular=0.28, sheen=0.25),
        "bib": mat.principled("orienteer_bib", (0.840, 0.835, 0.790),
                              roughness=0.92, specular=0.20),
        "tights": mat.principled("orienteer_tights", (0.028, 0.030, 0.038),
                                 roughness=0.88, specular=0.26, sheen=0.20),
        "sock": mat.principled("orienteer_sock", (0.600, 0.602, 0.575),
                               roughness=0.94, specular=0.18, sheen=0.35),
        "shoe": mat.principled("orienteer_shoe", (0.070, 0.085, 0.100),
                               roughness=0.66, specular=0.32),
        "sole": mat.principled("orienteer_shoe_sole", (0.620, 0.240, 0.030),
                               roughness=0.72, specular=0.30),
        "si": mat.principled("orienteer_si", (0.760, 0.520, 0.040),
                             roughness=0.42, specular=0.45),
        "map": mat.principled("orienteer_map", (0.700, 0.680, 0.545),
                              roughness=0.80, specular=0.24),
    }

    parts = []          # (part-key, object)
    parts.append(("torso", build_torso(m)))
    parts.append(("neck", build_neck(m)))
    parts.append(("head", build_head(m, rng.sub("head"))))
    parts.append(("nose", build_nose(m)))
    parts.append(("bib", build_bib(m)))
    for side in ("R", "L"):
        parts.append(("leg." + side, build_leg(side, m)))
        for o in build_shoe(side, m):
            parts.append(("shoe." + side, o))
        parts.append(("arm." + side, build_arm(side, m)))
        for o in build_hand(side, m):
            parts.append(("hand." + side, o))
    for o in build_si(m):
        parts.append(("prop.R", o))
    parts.append(("prop.L", build_map(m, rng.sub("map"))))

    # Record every part's vertices *before* the join, so the weighting can be
    # keyed to the part it came from.  join() appends source vertices after
    # the target's in order, which the assertion below actually verifies
    # rather than assumes -- silent index drift here would show up as an arm
    # welded to a shin, hundreds of frames later.
    ranges = []
    cursor = 0
    for key, obj in parts:
        n = len(obj.data.vertices)
        ranges.append((key, cursor, cursor + n,
                       [v.co.copy() for v in obj.data.vertices]))
        cursor += n

    body = M.join([o for _k, o in parts], NAME + "_LOD0")
    M.triangulate(body)
    M.shade_smooth(body, SMOOTH)
    body.data.name = NAME + "_LOD0_mesh"

    verts = body.data.vertices
    if len(verts) != cursor:
        raise SystemExit("orienteer: join changed the vertex count (%d != %d)"
                         % (len(verts), cursor))
    for key, lo, hi, cos in ranges:
        for k in range(0, hi - lo, 7):     # spot-check, not a full compare
            if (verts[lo + k].co - cos[k]).length > 1e-6:
                raise SystemExit("orienteer: join reordered vertices in %s" % key)

    # --- rig ---------------------------------------------------------------
    rows = bone_table()
    arm = build_armature(rows)
    segs = {}
    for name, head, tail, _p, _d in rows:
        segs[name] = WEIGHT_SEG.get(name, (head, tail))

    groups = {}
    for name, _h, _t, _p, deform in rows:
        if deform:
            groups[name] = body.vertex_groups.new(name=name)

    for key, lo, hi, _cos in ranges:
        cands = [c for c in part_candidates(key) if c in groups]
        for i in range(lo, hi):
            for bname, w in compute_weights(verts[i].co, cands, segs):
                groups[bname].add([i], w, "REPLACE")

    body.parent = arm
    body.parent_type = "OBJECT"
    amod = body.modifiers.new("Armature", "ARMATURE")
    amod.object = arm
    amod.use_vertex_groups = True

    # --- clips -------------------------------------------------------------
    arm.animation_data_create()
    phase = rng.sub("idle").uniform(0.0, TAU)
    clips = [
        bake_action(arm, "idle", 120, 4, lambda t: idle_pose(t, phase)),
        bake_action(arm, "jog", 26, 1, lambda t: gait(t, JOG)),
        bake_action(arm, "run", 20, 1, lambda t: gait(t, RUN)),
        bake_action(arm, "map", 90, 3, map_pose),
    ]
    push_nla(arm, clips)

    bpy.context.view_layer.update()
    tris = M.tri_count(body)
    print("LODREPORT %s=%d" % (body.name, tris))

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb([arm, body], path, draco=False,
                        apply_modifiers=False, animations=True,
                        animation_mode="NLA_TRACKS", skins=True)
    exporter.emit_meta(NAME, path, [body], extra={
        "originNote": ("between the feet at ground level -- soles touch z=0, "
                       "standing upright"),
        "forwardAxis": ("+Y in Blender = -Z in glTF/three.js (three.js "
                        "forward); +X in Blender is the character's right"),
        "heightM": HEIGHT,
        "clips": ["idle", "jog", "run", "map"],
        "clipSeconds": {"idle": 120 / float(FPS), "jog": 26 / float(FPS),
                        "run": 20 / float(FPS), "map": 90 / float(FPS)},
        "bones": len(rows),
        "deformBones": len(groups),
        "fps": FPS,
        "rootBone": "root",
        "notes": ("skinned, 4 looping clips; every clip's last frame equals "
                  "its first. Bind pose carries the map in the left hand; "
                  "clip 'map' raises it to reading height"),
    })


main()
