"""orienteer-hands -- first-person viewmodel: forearms, hands, map, compass.

What the player actually looks at for the whole race.  An elite orienteer runs
with the map in hand the entire way, thumb pinned to the current position and a
thumb compass sitting on the map face; the right hand stays free for punching.
That is exactly what this models -- and nothing else.  No torso, no bib (you
cannot see your own bib), no legs.

## Camera space -- the thing most likely to go wrong

Origin is the **eye**, not the ground.  The contract is stated in glTF axes,
because that is what the runtime sees:

    +X = camera right      +Y = up      -Z = forward (the view direction)

`export_yup` maps Blender (x, y, z) -> glTF (x, z, -y).  So **Blender +Y is
forward**, Blender +Z is up, Blender +X is right -- the same convention
`race-belt` documents.  Rather than carry that conversion in the head, every
landmark below is written through `V(right, up, fwd)`, which takes camera-space
numbers and returns the Blender vector.  Read the tables in camera space; the
exporter puts them where the runtime expects.

## Framing drives the layout, not anatomy

At a 46 deg vertical FOV the visible half-height at depth `d` is `0.4245 * d`
and the half-width is `0.679 * d`.  At the hands' depth (~0.43 m) the whole
frame is 0.365 m tall.  A real hand carried at chest height sits 0.37 m below
the eye -- which is *below the bottom of the frustum at every depth an arm can
reach*, so an anatomically placed viewmodel is simply not on screen.  Every
first-person game cheats the arms up and in; so does this one.  The hands sit
0.17 m below the eye and the forearms leave the frame through its bottom edge
at around 0.35 m depth, which is why only the wrists and hands are ever seen.

Consequences that are checked, not assumed:

  * upper-arm stubs start behind the eye at glTF z = +0.065..+0.072, inside
    the +0.12 limit, and are never in frame;
  * nothing sits closer to the eye than 0.35 m, so nothing crosses the
    0.15 m near plane;
  * depth is the one number a runtime translation hook cannot fix, because
    depth is what sets apparent size -- so the hands/map sit at 0.43-0.50 m
    and stay there.

## The map face is a runtime contract

The front of the map is a **flat** grid of quads with its own material named
exactly `map_face`, UVs filling 0..1, no rotation and no mirroring.  Stated in
the form that can actually be checked in the shipped file (and is, by the
verification script): **UV (0,0) is the map's top-left corner seen from the
front, (1,0) its top-right, (0,1) its bottom-left** -- i.e. +U runs along glTF
+X and +V runs *down* the map, which is glTF's own top-left texture origin.
A canvas drawn the normal way round therefore lands upright.  `src/world/` binds the live ISOM canvas from
`src/map/renderer.ts` onto that material as a CanvasTexture, so the player is
reading the real map, not a prop.  Same arrangement as `finish-gantry`'s
`BRAND_BANNER` island, with two differences: the UVs are written directly from
the grid parameters rather than derived from world positions (a derived island
can come out mirrored, and mirrored here means the map reads backwards in
game), and the panel is kept dead flat -- a bowed panel would distort the
canvas.  The back and the edge rim carry a separate `map_back` material so
binding the canvas does not also paint the reverse.

The embedded albedo is a pale ISOM paper yellow-white placeholder; it exists so
the .glb looks right opened standalone and is expected to be replaced.

## Rig

9 bones (8 deforming), authored in the same camera frame:
`root`, `upperarm.L/R`, `forearm.L/R`, `hand.L/R`, `thumb.L` (carries the
compass), `wrist.R` (carries the SI stick).  The map is rigid to `hand.L`.
Weights are computed in Python -- point-to-segment distance, inverse distance
to the 5th power, top 4, normalised, restricted to a per-part candidate list.
`ARMATURE_AUTO` needs a UI context and is not reliable headless.

Clips at 30 fps, all authored as closed cycles (frame N is evaluated at t=1.0
from the same periodic functions as t=0.0, so the loop is exact):

    idle 4.00 s  arms low, map at waist, breathing
    jog  0.867 s moderate drive, map at lower chest, angled towards the camera
    run  0.667 s faster and more compact, map held closer in
    read 2.00 s  map hand up and in, map face square to the camera and filling
                 ~45% of frame height; right arm drops; a small settle only
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

from lib import cli, exporter, mat, mesh as M  # noqa: E402

NAME = "orienteer-hands"
TAU = math.pi * 2.0
FPS = 30

SIDES_ARM = 26
SIDES_HAND = 18
SIDES_FINGER = 12
STEP_ARM = 0.019
SMOOTH = 44.0

# A folded race map.  0.20 x 0.155 rather than the 0.21 x 0.17 a real one
# folds to: at the read pose's 0.47 m the larger panel covered 51% of frame
# height and ran off the bottom edge, against a 35-50% target.
MAP_W, MAP_H = 0.200, 0.155
MAP_TILT = 42.0          # degrees from "square to the camera", bind pose


def V(right, up, fwd):
    """Camera-space -> Blender.  +X right, +Z up, +Y forward (= glTF -Z)."""
    return Vector((right, fwd, up))


# --- map frame (bind pose) --------------------------------------------------
# The map is placed first and everything on the left arm is derived from it.
# That order matters: the map is what has to land in a particular part of the
# frame, and an earlier version that placed the wrist first and hung the map
# off it put the palm straight through the map face, because a palm swept
# along the forearm crosses a plane raked 42 deg to it.
#
# Bind pose *is* the carry pose: map in the lower left, raked ~42 deg away so
# it reads as a map without being readable.  The `read` clip squares it up
# almost entirely at the wrist, the only joint with a short enough lever to do
# that without also flinging it off the top of the screen.
_th = math.radians(MAP_TILT)
MAP_U = Vector((1.0, 0.0, 0.0))                     # map U axis: camera right
MAP_V = V(0.0, math.cos(_th), math.sin(_th))        # map V axis: up, raked back
MAP_N = MAP_U.cross(MAP_V)                          # front-face normal
MAP_C = V(-0.150, -0.135, 0.480)

# --- landmarks, all camera-space -------------------------------------------
# The left hand grips the map from behind, running *up its back* along MAP_V,
# so it is placed in map space.  The right wrist is placed straight into the
# frame.  Both arms then step back at real human lengths: hand 0.185 m,
# forearm 0.27-0.28 m, upper-arm stub 0.235 m.
_GRIP_WRIST = MAP_C - MAP_V * 0.115 - MAP_N * 0.032 - MAP_U * 0.012
WRIST = {"R": V(0.200, -0.155, 0.430), "L": _GRIP_WRIST}
_FOREARM_DIR = {"R": V(-0.160, 0.220, 0.962).normalized(),
                "L": V(0.140, 0.300, 0.940).normalized()}
_UPPER_DIR = {"R": V(-0.120, 0.160, 0.980).normalized(),
              "L": V(0.110, 0.260, 0.960).normalized()}
ELBOW = {s: WRIST[s] - _FOREARM_DIR[s] * (0.270 if s == "R" else 0.282)
         for s in ("R", "L")}
SHOULDER = {s: ELBOW[s] - _UPPER_DIR[s] * 0.235 for s in ("R", "L")}

# The left *hand* does not continue the forearm -- it breaks at the wrist by
# ~31 deg so the palm lies flat on the back of the map.
_HAND_DIR = {"R": _FOREARM_DIR["R"], "L": MAP_V}


def hand_dir(side):
    return _HAND_DIR[side]


HAND_TIP = {s: WRIST[s] + hand_dir(s) * 0.185 for s in ("R", "L")}
PALM_C = {s: WRIST[s] + hand_dir(s) * 0.052 for s in ("R", "L")}

# The thumb is laid across the map face -- the sport's signature gesture -- so
# it is placed in the map's own frame too, wrapping the bottom-left edge and
# running up onto the face.  The compass rides on top of it.  Both stay in the
# lower-left quadrant: everything they cover is map the player cannot read,
# and the runtime is about to bind a live canvas to that face.
THUMB_BASE = MAP_C - MAP_U * 0.076 - MAP_V * 0.086 - MAP_N * 0.004
THUMB_TIP = MAP_C - MAP_U * 0.030 - MAP_V * 0.026 + MAP_N * 0.013
COMPASS_C = MAP_C - MAP_U * 0.022 - MAP_V * 0.017 + MAP_N * 0.021


# ---------------------------------------------------------------------------
# sweeps (same generic loft the parked full-body asset uses)
# ---------------------------------------------------------------------------

def refine(sections, max_step):
    """Interpolate sections so no gap exceeds `max_step` -- joints need loops
    through the bend, which is what actually controls how a skin deforms."""
    out = []
    for i in range(len(sections) - 1):
        a, b = sections[i], sections[i + 1]
        n = max(1, int(math.ceil((b[0] - a[0]).length / max_step)))
        for k in range(n):
            t = k / float(n)
            out.append((a[0].lerp(b[0], t),
                        a[1] + (b[1] - a[1]) * t,
                        a[2] + (b[2] - a[2]) * t,
                        a[3] + (b[3] - a[3]) * t))
    out.append(sections[-1])
    return out


def _unit(a, e):
    """Superellipse: e=2 is a circle, e>2 squares off towards a slab."""
    ca, sa = math.cos(a), math.sin(a)
    p = 2.0 / e
    return (math.copysign(abs(ca) ** p, ca), math.copysign(abs(sa) ** p, sa))


def frame_from(direction, thin_axis):
    """Orthonormal (normal, binormal) for a sweep, with `normal` as close to
    `thin_axis` as the direction allows.

    Rotation-minimising frames pick their own starting normal, which is fine
    for a limb but not for a palm: which way a flat hand faces is the whole
    read, and for the left hand it has to be the map's plane.
    """
    d = Vector(direction).normalized()
    n = Vector(thin_axis) - d * Vector(thin_axis).dot(d)
    if n.length < 1e-6:
        n = d.cross(Vector((0, 0, 1)))
    n.normalize()
    return n, d.cross(n).normalized()


def loft(name, sections, sides, cap_start=True, cap_end=True, axes=None):
    """Sweep a superelliptical profile along a polyline.

    Frames come from `M._rmf_frames` (rotation-minimising, the same machinery
    `M.tube` uses) so the profile does not spin through a bend; reached
    directly because this needs per-section elliptical radii and a variable
    exponent.  Profile axis 1 is the frame normal, axis 2 the binormal.
    `axes` overrides both with a fixed pair -- used where the *orientation* of
    a flat section is meaningful (palms, the thumb on the map).
    """
    pts = [s[0] for s in sections]
    if axes is None:
        _tan, nrm, bnm = M._rmf_frames(pts)
    else:
        nrm = [axes[0]] * len(pts)
        bnm = [axes[1]] * len(pts)
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


def path_sections(joints, table):
    """(s, rn, rb, e) rows with s in [0,1] of arc length along `joints`."""
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
                return a.lerp(b, max(0.0, min(1.0, (d - cum[i]) / (lens[i] or 1.0))))
        return joints[-1]

    return [(at(s), rn, rb, e) for s, rn, rb, e in table]


# Upper-arm stub -> elbow -> wrist.  The bulge at 0.62 is the forearm belly and
# the pinch at 1.0 the wrist; without both the arm reads as a pipe.
ARM = [
    (0.000, 0.050, 0.050, 2.1),
    (0.090, 0.049, 0.049, 2.1),
    (0.240, 0.045, 0.046, 2.1),
    (0.400, 0.040, 0.042, 2.1),
    (0.480, 0.038, 0.040, 2.2),
    (0.540, 0.040, 0.043, 2.2),
    (0.620, 0.042, 0.045, 2.2),
    (0.720, 0.040, 0.043, 2.2),
    (0.840, 0.034, 0.036, 2.2),
    (0.930, 0.029, 0.030, 2.2),
    (1.000, 0.027, 0.028, 2.2),
]

# Palm: a slab, thin across the frame normal and wide across the binormal.
PALM = [
    (0.00, 0.022, 0.030, 2.4),
    (0.22, 0.023, 0.041, 2.8),
    (0.50, 0.023, 0.044, 2.8),
    (0.78, 0.021, 0.042, 2.7),
    (1.00, 0.018, 0.037, 2.6),
]


# ---------------------------------------------------------------------------
# parts
# ---------------------------------------------------------------------------

def build_arm(side, m):
    joints = [SHOULDER[side], ELBOW[side], WRIST[side]]
    obj = loft("oh_arm" + side, refine(path_sections(joints, ARM), STEP_ARM),
               SIDES_ARM)
    mat.assign_all(obj, m["skin"])
    return obj


def digit(name, points, radii, material):
    """A finger or thumb with a rounded tip.

    The tip section is not decoration: `loft`'s end cap is a flat fan, so a
    digit that simply stops shows a disc of skin at the fingertip, and four of
    those in a fist read as a bundle of cut tubes.
    """
    pts = list(points)
    tip = pts[-1] + (pts[-1] - pts[-2]).normalized() * (radii[-1] * 0.75)
    sections = [(p, r, r, 2.3) for p, r in zip(pts, radii)]
    sections.append((tip, radii[-1] * 0.42, radii[-1] * 0.42, 2.3))
    obj = loft(name, sections, SIDES_FINGER)
    mat.assign_all(obj, material)
    return obj


def hand_frame(side):
    """(forward, thin, across) unit axes of the palm.

    `thin` is the palm's normal -- the direction it is flat in.  The left palm
    is flattened into the map's own plane so it can lie against the back of
    the map; the right palm is flattened left-to-right, which is how a relaxed
    running hand actually sits.
    """
    d = hand_dir(side)
    thin = MAP_N if side == "L" else Vector((1.0, 0.0, 0.0))
    n, b = frame_from(d, thin)
    return d, n, b


def build_hand(side, m, rng):
    """Palm slab + four curled finger stubs + a thumb.

    Deliberately not articulated: individually posed fingers at viewmodel
    distance cost hundreds of triangles and a rig each, and read no better
    than a mitten with the knuckle line broken into four.
    """
    d, thin, across = hand_frame(side)
    w = WRIST[side]
    parts = []
    palm = loft("oh_palm" + side,
                refine(path_sections([w + d * 0.004, w + d * 0.100], PALM),
                       0.014),
                SIDES_HAND, axes=(thin, across))
    mat.assign_all(palm, m["skin"])
    parts.append(palm)

    for k in range(4):
        t = (k - 1.5) / 1.5                       # -1 .. +1 across the knuckles
        length = rng.uniform(0.052, 0.058) * (1.0 - 0.22 * abs(t) ** 1.6)
        r = 0.0100 - 0.0011 * abs(t)
        if side == "L":
            # Left fingertips crest the map's bottom edge from behind.  Only
            # about a centimetre shows: four whole fingers standing up the
            # face read as sausages, but four tips over the edge is what makes
            # it a *grip* rather than a hand parked behind a rectangle.
            u = MAP_U * (-0.050 + k * 0.028)
            p0 = MAP_C + u - MAP_V * (MAP_H * 0.5 + 0.026) - MAP_N * 0.014
            p1 = (MAP_C + u + MAP_U * 0.004
                  - MAP_V * (MAP_H * 0.5 + 0.006) + MAP_N * 0.001)
            p2 = (MAP_C + u + MAP_U * 0.008
                  - MAP_V * (MAP_H * 0.5 - 0.007) + MAP_N * 0.010)
            r *= 0.92
        else:
            # Right hand is a loose running fist: forward off the knuckles,
            # then back in towards the palm.
            base_c = w + d * 0.098
            p0 = base_c + across * (t * 0.019) - thin * 0.004
            p1 = p0 + d * (length * 0.52) - thin * (length * 0.42)
            p2 = p1 - d * (length * 0.10) - thin * (length * 0.60)
        parts.append(digit("oh_fing%s%d" % (side, k), [p0, p1, p2],
                           [r, r * 0.94, r * 0.74], m["skin"]))

    if side == "L":
        # Placed in the map's frame, not the hand's: the thumb wraps the
        # bottom-left edge and lies flat on the face.  If it is not visibly
        # *on* the map, the pose is not the sport's gesture.
        b1 = THUMB_BASE.lerp(THUMB_TIP, 0.48)
        thumb = digit("oh_thumbL", [THUMB_BASE, b1, THUMB_TIP],
                      [0.0135, 0.0125, 0.0102], m["skin"])
    else:
        t0 = w + d * 0.030 - across * 0.022 - thin * 0.006
        t1 = t0 + d * 0.036 - across * 0.014 - thin * 0.024
        t2 = t1 + d * 0.020 - across * 0.004 - thin * 0.026
        thumb = digit("oh_thumbR", [t0, t1, t2],
                      [0.0145, 0.0125, 0.0098], m["skin"])
    parts.append(thumb)
    return parts


def band(name, centre, axis, radius, tube_r, material, nu=16, nv=6, squash=1.0):
    """A strap round a limb: torus swept about `axis`."""
    d = Vector(axis).normalized()
    a1 = d.cross(Vector((0, 0, 1)))
    if a1.length < 1e-6:
        a1 = d.cross(Vector((1, 0, 0)))
    a1.normalize()
    a2 = d.cross(a1).normalized()

    def fn(u, v):
        au, av = TAU * u, TAU * v
        n = a1 * math.cos(au) + a2 * math.sin(au)
        c = centre + n * radius
        return tuple(c + n * (math.cos(av) * tube_r)
                     + d * (math.sin(av) * tube_r * squash))

    obj = M.param_surface(name, fn, nu, nv, close_u=True, close_v=True)
    M.recalc_normals(obj)
    mat.assign_all(obj, material)
    return obj


def build_map(m):
    """Folded race map: a dead-flat `map_face` grid, a bowed back, and a rim.

    The front is built and UV'd from the grid parameters directly -- u across,
    v up, both 0..1 -- so the runtime canvas cannot land mirrored or rotated.
    """
    nu, nv = 4, 4
    thick = 0.0024
    front = []
    back = []
    uvs = []
    for i in range(nu + 1):
        u = i / float(nu)
        for j in range(nv + 1):
            v = j / float(nv)
            p = (MAP_C + MAP_U * ((u - 0.5) * MAP_W)
                 + MAP_V * ((v - 0.5) * MAP_H))
            front.append(p)
            # only the back is allowed any relief: a folded map is never truly
            # flat, but the face has to stay planar for the canvas binding
            fold = 0.0016 * max(0.0, 1.0 - abs(u - 0.5) * 7.0)
            back.append(p - MAP_N * (thick + fold))
            uvs.append((u, v))

    verts = [tuple(p) for p in front] + [tuple(p) for p in back]
    n = (nu + 1) * (nv + 1)
    faces = []
    face_uv = []

    def fid(i, j):
        return i * (nv + 1) + j

    for i in range(nu):
        for j in range(nv):
            a, b = fid(i, j), fid(i + 1, j)
            c, d = fid(i + 1, j + 1), fid(i, j + 1)
            faces.append((a, b, c, d))
            face_uv.append([uvs[a], uvs[b], uvs[c], uvs[d]])
    n_front = len(faces)
    for i in range(nu):
        for j in range(nv):
            a, b = fid(i, j) + n, fid(i + 1, j) + n
            c, d = fid(i + 1, j + 1) + n, fid(i, j + 1) + n
            faces.append((d, c, b, a))
            face_uv.append([(0, 0)] * 4)
    # rim
    ring = ([fid(i, 0) for i in range(nu + 1)]
            + [fid(nu, j) for j in range(1, nv + 1)]
            + [fid(i, nv) for i in range(nu - 1, -1, -1)]
            + [fid(0, j) for j in range(nv - 1, -1, -1)])
    for k in range(len(ring)):
        a = ring[k]
        b = ring[(k + 1) % len(ring)]
        faces.append((a, b, b + n, a + n))
        face_uv.append([(0, 0)] * 4)

    obj = M.from_pydata("oh_map", verts, faces)
    M.recalc_normals(obj)
    layer = obj.data.uv_layers.new(name="UVMap")
    for poly in obj.data.polygons:
        for k, li in enumerate(poly.loop_indices):
            layer.data[li].uv = face_uv[poly.index][k % 4]

    mat.assign_all(obj, m["map_back"])
    mat.assign_face_indices(obj, m["map_face"], range(n_front))
    # the front must stay perfectly flat, so it must also stay flat-shaded
    return obj


def build_compass(m):
    """Thumb compass: clear baseplate lying on the map, capsule, needle, strap.

    The needle is two flat wedges rather than a modelled magnet -- at this size
    the red half is the entire read.
    """
    parts = []
    u, v, n = MAP_U, MAP_V, MAP_N
    base_t = 0.0035
    hw, hh = 0.026, 0.019
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    verts = []
    for du, dv in corners:
        verts.append(tuple(COMPASS_C + u * du + v * dv))
    for du, dv in corners:
        verts.append(tuple(COMPASS_C + u * du + v * dv - n * base_t))
    faces = [(0, 1, 2, 3), (7, 6, 5, 4),
             (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    plate = M.from_pydata("oh_cbase", verts, faces)
    M.recalc_normals(plate)
    mat.assign_all(plate, m["compass"])
    parts.append(plate)

    # rotating capsule
    cap_c = COMPASS_C + n * 0.0018
    capsule = loft("oh_ccap",
                   [(cap_c, 0.0148, 0.0148, 2.0),
                    (cap_c + n * 0.0042, 0.0148, 0.0148, 2.0),
                    (cap_c + n * 0.0060, 0.0128, 0.0128, 2.0)], 18)
    mat.assign_all(capsule, m["compass"])
    parts.append(capsule)

    # needle: two wedges on the capsule face
    face = cap_c + n * 0.0064
    for key, sign in (("needle_n", 1.0), ("needle_s", -1.0)):
        tip = face + v * (sign * 0.0118)
        l = face + u * 0.0026 - v * (sign * 0.0012)
        r = face - u * 0.0026 - v * (sign * 0.0012)
        c = face - v * (sign * 0.0018)
        nd = M.from_pydata("oh_" + key,
                           [tuple(tip), tuple(l), tuple(c), tuple(r)],
                           [(0, 1, 2, 3)] if sign > 0 else [(3, 2, 1, 0)])
        M.recalc_normals(nd)
        mat.assign_all(nd, m[key])
        parts.append(nd)

    # strap over the thumb
    d = (THUMB_TIP - THUMB_BASE).normalized()
    parts.append(band("oh_cstrap", THUMB_BASE.lerp(THUMB_TIP, 0.60), d,
                      0.0146, 0.0030, m["strap"], nu=14, nv=6))
    return parts


def build_si(m):
    """SI stick / control card strapped to the right wrist."""
    d, thin, across = hand_frame("R")
    centre = WRIST["R"] - d * 0.016
    # sit it on the outside of the wrist, where a real one is worn and where
    # the camera can actually see it
    seat = centre - across * 0.030 + thin * 0.008
    body = loft("oh_si",
                [(seat - d * 0.030, 0.007, 0.009, 2.6),
                 (seat - d * 0.015, 0.010, 0.013, 3.0),
                 (seat + d * 0.017, 0.010, 0.013, 3.0),
                 (seat + d * 0.031, 0.007, 0.009, 2.6)], 12)
    mat.assign_all(body, m["si"])
    return [body, band("oh_sistrap", centre, d, 0.0345, 0.0046, m["strap"],
                       nu=16, nv=6)]


# ---------------------------------------------------------------------------
# rig
# ---------------------------------------------------------------------------

def bone_table():
    rows = [("root", V(0, 0, 0), V(0, 0.12, 0), None, False)]
    for side in ("R", "L"):
        rows += [
            ("upperarm." + side, SHOULDER[side], ELBOW[side], "root", True),
            ("forearm." + side, ELBOW[side], WRIST[side],
             "upperarm." + side, True),
            ("hand." + side, WRIST[side], HAND_TIP[side],
             "forearm." + side, True),
        ]
    rows.append(("wrist.R", WRIST["R"], WRIST["R"] + hand_dir("R") * 0.055,
                 "forearm.R", True))
    rows.append(("thumb.L", THUMB_BASE, THUMB_TIP, "hand.L", True))
    return rows


def seg_distance(p, a, b):
    ab = b - a
    d2 = ab.dot(ab)
    t = 0.0 if d2 < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / d2))
    return (p - (a + ab * t)).length


def compute_weights(co, candidates, segs, power=5.0, eps=0.018, keep=4):
    """Inverse-distance skinning against a hand-picked candidate list.

    Restricting the candidates per part is what makes this safe: the left
    thumb sits within a centimetre of the map and the compass, and without the
    restriction the map would pick up thumb weight and shear every time the
    wrist moved.
    """
    scored = []
    for name in candidates:
        a, b = segs[name]
        scored.append((1.0 / ((seg_distance(co, a, b) + eps) ** power), name))
    scored.sort(reverse=True)
    scored = scored[:keep]
    total = sum(w for w, _ in scored) or 1.0
    return [(name, w / total) for w, name in scored if w / total > 1e-4]


def part_candidates(part):
    for side in ("R", "L"):
        if part == "arm." + side:
            return ["upperarm." + side, "forearm." + side, "hand." + side]
        if part == "hand." + side:
            return ["forearm." + side, "hand." + side]
    if part == "thumb.L":
        return ["hand.L", "thumb.L"]
    if part == "map":
        return ["hand.L"]          # rigid: the map must not deform at all
    if part == "compass":
        return ["thumb.L"]
    if part == "si":
        return ["wrist.R"]
    return ["root"]


def build_armature(rows):
    data = bpy.data.armatures.new(NAME + "_rig")
    arm = bpy.data.objects.new(NAME + "_rig", data)
    M.link(arm)
    bpy.context.view_layer.objects.active = arm
    # object.mode_set is one of the few operators that works in --background;
    # edit_bones only exist inside EDIT mode.
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


# ---------------------------------------------------------------------------
# animation
# ---------------------------------------------------------------------------

def bone_rot(pb, rx, ry, rz):
    """Rotation given in armature (= camera) axes, converted to bone-local.

    In this frame +X rotation raises the hands, +Z swings them inwards and +Y
    rolls the wrist -- which is what makes the pose tables below checkable by
    a human rather than a pile of quaternions.
    """
    R = pb.bone.matrix_local.to_quaternion()
    Q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)),
              "XYZ").to_quaternion()
    return R.inverted() @ Q @ R


def bone_loc(pb, offset):
    return pb.bone.matrix_local.to_3x3().inverted() @ Vector(offset)


def gait(t, p):
    """One periodic viewmodel pose.  pose(1) == pose(0) exactly.

    Sign convention in this (camera-axis) frame: +rx raises a limb, and +rz
    swings a forward-pointing limb towards -X.  So "inwards" is +rz on the
    right arm and -rz on the left.
    """
    a = TAU * t
    swing = math.sin(a)
    pose = {}
    for side, ph in (("R", 0.0), ("L", math.pi)):
        s = 1.0 if side == "R" else -1.0
        sw = math.sin(a + ph)
        pose["upperarm." + side] = (p["ua_c"] + p["ua_a"] * sw,
                                    0.0, s * p["ua_in"])
        pose["forearm." + side] = (p["fa_c"] + p["fa_a"] * sw, 0.0,
                                   s * p["fa_in"])
        pose["hand." + side] = (p["hand_c"] + p["hand_a"] * sw, 0.0, 0.0)
    # the map hand is doing a job, not swinging freely: half the amplitude and
    # held further in, so the map stays in frame through the whole cycle
    swl = math.sin(a + math.pi)
    pose["upperarm.L"] = (p["mapL_ua"] + p["ua_a"] * 0.40 * swl,
                          0.0, -p["mapL_in"])
    pose["forearm.L"] = (p["mapL_fa"] + p["fa_a"] * 0.40 * swl,
                         0.0, -p["mapL_fin"])
    pose["hand.L"] = (p["mapL_hand"] + 2.0 * swl, 0.0, 0.0)
    root = (p["sway"] * swing, 0.0,
            p["rise"] + p["bob"] * math.cos(2.0 * TAU * (t - 0.40)))
    return pose, root


def idle_pose(t, phase):
    a = TAU * t
    breathe = math.sin(TAU * 3.0 * t + phase)
    drift = math.sin(a + phase * 0.5)
    # "Low and relaxed" has to stay inside the frustum: 7 deg of droop at the
    # shoulder is 60 mm at the wrist and drops the hands straight out of frame.
    pose = {}
    for side in ("R", "L"):
        s = 1.0 if side == "R" else -1.0
        pose["upperarm." + side] = (0.5 + 1.4 * breathe, 0.0, s * 3.0)
        pose["forearm." + side] = (0.0 + 1.2 * drift, 0.0, s * 2.0)
        pose["hand." + side] = (-3.0 + 1.0 * breathe, 0.0, 0.0)
    pose["upperarm.L"] = (0.0 + 1.2 * breathe, 0.0, -2.0)
    pose["forearm.L"] = (-1.0 + 1.0 * drift, 0.0, -2.0)
    pose["hand.L"] = (-1.0 + 1.4 * breathe, 0.0, 0.0)
    root = (0.004 * drift, 0.0, -0.004 + 0.003 * breathe)
    return pose, root


def read_pose(t):
    """Map up, in, and square to the camera; right arm drops out of the way.

    Nearly all of the 32 deg that squares the map up is taken at the *wrist*.
    That is not a stylistic choice: the shoulder's lever arm to the map is
    ~0.57 m, so 32 deg there would lift the map 0.30 m and fling it off the
    top of the frame, whereas the same 32 deg at the wrist (lever ~0.10 m)
    lifts it 0.05 m -- which is exactly the rise the pose wants.
    """
    # zero at both ends, so the clip is loop-safe even though it is meant to
    # be cross-faded into rather than looped
    settle = math.sin(TAU * t) * (1.0 - t) * (1.0 - t)
    pose = {
        "upperarm.L": (6.5 + 0.8 * settle, 0.0, -14.0),
        "forearm.L": (0.0 + 1.0 * settle, 0.0, -2.0),
        "hand.L": (31.0 + 1.6 * settle, 0.0, 0.0),
        "thumb.L": (0.0, 0.0, 1.5 * settle),
        "upperarm.R": (-22.0 + 1.0 * settle, 0.0, 7.0),
        "forearm.R": (-14.0, 0.0, 4.0),
        "hand.R": (-6.0, 0.0, 0.0),
    }
    root = (0.0, 0.0, -0.002 + 0.002 * settle)
    return pose, root


JOG = dict(ua_c=3.0, ua_a=12.0, ua_in=4.0, fa_c=4.0, fa_a=13.0, fa_in=3.0,
           hand_c=-2.0, hand_a=5.0, mapL_ua=1.5, mapL_fa=2.5, mapL_hand=1.0,
           mapL_in=2.5, mapL_fin=3.0, sway=0.008, rise=-0.002, bob=0.011)

RUN = dict(ua_c=4.0, ua_a=19.0, ua_in=5.5, fa_c=7.0, fa_a=20.0, fa_in=4.5,
           hand_c=-1.0, hand_a=8.0, mapL_ua=4.0, mapL_fa=5.0, mapL_hand=2.0,
           mapL_in=4.0, mapL_fin=4.5, sway=0.011, rise=0.004, bob=0.017)


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
    """One action per NLA track.  Verified empirically against the alternative:
    ACTIONS mode also emits four animations but reorders them, and the runtime
    looks clips up by name, so the deterministic ordering is worth having."""
    arm.animation_data.action = None
    for act in actions:
        tr = arm.animation_data.nla_tracks.new()
        tr.name = act.name
        tr.strips.new(act.name, 0, act).name = act.name
    return arm


# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": False})
    rng = cli.setup(args.seed, NAME)
    bpy.context.scene.render.fps = FPS

    m = {
        # Base colours are linear, not sRGB (see README).
        "skin": mat.principled("orienteer_skin", (0.470, 0.268, 0.185),
                               roughness=0.62, specular=0.35),
        # Runtime contract: `map_face` is replaced by the live ISOM canvas.
        "map_face": mat.principled("map_face", (0.760, 0.745, 0.640),
                                   roughness=0.86, specular=0.16),
        "map_back": mat.principled("map_back", (0.560, 0.545, 0.470),
                                   roughness=0.90, specular=0.14),
        "compass": mat.principled("orienteer_compass", (0.520, 0.560, 0.580),
                                  roughness=0.18, specular=0.60, coat=0.4),
        "needle_n": mat.principled("orienteer_needle_n", (0.640, 0.040, 0.030),
                                   roughness=0.35, specular=0.45),
        "needle_s": mat.principled("orienteer_needle_s", (0.820, 0.820, 0.805),
                                   roughness=0.35, specular=0.45),
        "strap": mat.principled("orienteer_strap", (0.030, 0.032, 0.040),
                                roughness=0.88, specular=0.26),
        "si": mat.principled("orienteer_si", (0.760, 0.520, 0.040),
                             roughness=0.42, specular=0.45),
    }

    parts = []
    for side in ("R", "L"):
        parts.append(("arm." + side, build_arm(side, m)))
        for o in build_hand(side, m, rng.sub("hand" + side)):
            key = "thumb.L" if o.name == "oh_thumbL" else "hand." + side
            parts.append((key, o))
    parts.append(("map", build_map(m)))
    for o in build_compass(m):
        parts.append(("compass", o))
    for o in build_si(m):
        parts.append(("si", o))

    # Record each part's vertices before the join so weighting can be keyed to
    # the part it came from.  join() appends source vertices after the
    # target's, in order -- asserted below rather than assumed, because silent
    # index drift here shows up as a map welded to a forearm, much later.
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
    # The map face has to stay dead flat *and* flat-shaded: a smoothed normal
    # across a canvas-textured panel makes the map look domed under any light.
    face_idx = mat.add(body, m["map_face"])
    for poly in body.data.polygons:
        if poly.material_index == face_idx:
            poly.use_smooth = False
    body.data.name = NAME + "_LOD0_mesh"

    verts = body.data.vertices
    if len(verts) != cursor:
        raise SystemExit("%s: join changed the vertex count (%d != %d)"
                         % (NAME, len(verts), cursor))
    for key, lo, hi, cos in ranges:
        for k in range(0, hi - lo, 5):
            if (verts[lo + k].co - cos[k]).length > 1e-6:
                raise SystemExit("%s: join reordered vertices in %s"
                                 % (NAME, key))

    rows = bone_table()
    arm = build_armature(rows)
    segs = {name: (head, tail) for name, head, tail, _p, _d in rows}
    groups = {name: body.vertex_groups.new(name=name)
              for name, _h, _t, _p, deform in rows if deform}

    for key, lo, hi, _cos in ranges:
        cands = [c for c in part_candidates(key) if c in groups]
        for i in range(lo, hi):
            for bname, w in compute_weights(verts[i].co, cands, segs):
                groups[bname].add([i], w, "REPLACE")

    body.parent = arm
    body.parent_type = "OBJECT"
    body.modifiers.new("Armature", "ARMATURE").object = arm

    arm.animation_data_create()
    phase = rng.sub("idle").uniform(0.0, TAU)
    clips = [
        bake_action(arm, "idle", 120, 4, lambda t: idle_pose(t, phase)),
        bake_action(arm, "jog", 26, 1, lambda t: gait(t, JOG)),
        bake_action(arm, "run", 20, 1, lambda t: gait(t, RUN)),
        bake_action(arm, "read", 60, 3, read_pose),
    ]
    push_nla(arm, clips)

    bpy.context.view_layer.update()
    print("LODREPORT %s=%d" % (body.name, M.tri_count(body)))

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb([arm, body], path, draco=False,
                        apply_modifiers=False, animations=True,
                        animation_mode="NLA_TRACKS", skins=True)
    exporter.emit_meta(NAME, path, [body], extra={
        "originNote": "origin at the eye/camera, viewmodel space",
        "forwardAxis": "-Z (glTF)",
        "clips": ["idle", "jog", "run", "read"],
        "clipSeconds": {"idle": 120 / float(FPS), "jog": 26 / float(FPS),
                        "run": 20 / float(FPS), "read": 60 / float(FPS)},
        "bones": len(rows),
        "deformBones": len(groups),
        "fps": FPS,
        "mapMaterial": "map_face",
        "mapUV": ("UV(0,0) = map top-left seen from the front; +U -> +X, "
                  "+V -> down. glTF top-left texture origin, no flip needed"),
        "mapQuadSizeM": [MAP_W, MAP_H],
        "notes": ("first-person viewmodel; bind pose is the carry pose. "
                  "Bind the ISOM canvas to the map_face material by name; "
                  "map_back covers the reverse and the edge rim. Verify "
                  "framing with tools/blender/preview-viewmodel.py, not the "
                  "turntable"),
    })


main()
