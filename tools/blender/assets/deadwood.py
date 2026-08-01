"""deadwood -- Sumava forest-floor deadwood, three variants in one .glb.

The Bohemian Forest has square kilometres of bark-beetle-killed spruce, so
deadwood is the signature ground clutter of the terrain.  Three variants:

  v0  fallen log   -- a long tapered trunk lying and part-sunk in the duff,
                      splintered at both ends, bark peeled off in patches.
  v1  stump        -- a snapped-off trunk with a jagged crown of splinters
                      and a lobed root flare at the base.
  v2  root plate   -- the windthrow disc: an uprooted spruce's root pan
                      standing on edge with the snapped trunk laid back.

Every variant is built *at the origin*: XY-centred on its own footprint,
sitting on the ground at z=0, with the buried undersides deliberately
dipping below it.  Nothing carries a layout offset, so a variant node can be
instanced straight onto a terrain sample without any centroid correction.

Nothing here uses a raw primitive silhouette: every part is swept or lathed,
then lobe-shaped, then noise-displaced, then smooth-shaded with a sharp-edge
angle that keeps the splinters crisp.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
from mathutils import noise as bnoise  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, uvtools  # noqa: E402

NAME = "deadwood"
TAU = math.pi * 2.0
SMOOTH = 40.0           # sharp-edge angle: smooth bark, crisp splinters


# ---------------------------------------------------------------------------
# local helpers (deliberately not in lib/ -- other agents own that directory)
# ---------------------------------------------------------------------------

def fbm(p, octaves=3, gain=0.5, lacunarity=2.03):
    """Fractal value noise in [-1, 1]-ish.  `p` is a Vector."""
    total = 0.0
    amp = 1.0
    freq = 1.0
    norm = 0.0
    for _ in range(octaves):
        total += bnoise.noise(p * freq) * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / (norm or 1.0)


def adiff(a, b):
    """Signed shortest angular difference a-b, in (-pi, pi]."""
    d = (a - b) % TAU
    return d - TAU if d > math.pi else d


def bumps(angle, spec):
    """Sum of wrapped gaussian lobes: [(centre, height, width), ...]."""
    total = 0.0
    for centre, height, width in spec:
        d = adiff(angle, centre)
        total += height * math.exp(-(d * d) / (2.0 * width * width))
    return total


def patch_predicate(scale, threshold, offset=(0.0, 0.0, 0.0), octaves=3,
                    aniso=(1.0, 1.0, 1.0), gain=0.5):
    """Ragged material boundary: True where fbm(face centre) clears threshold.

    Used instead of a clean split so the bark/bare-wood edge wanders across
    the surface the way a peeling strip actually does.  `aniso` squashes the
    noise lattice per axis: squashing along the trunk axis turns the blobs
    into the long vertical strips that spruce bark actually sloughs off in.
    """
    off = Vector(offset)
    ax = Vector(aniso)

    def pred(poly, _obj):
        c = poly.center + off
        return fbm(Vector((c.x * ax.x, c.y * ax.y, c.z * ax.z)) * scale,
                   octaves, gain) > threshold

    return pred


def centre_xy(obj):
    """Move the mesh so its footprint is centred on the origin in XY.

    Z is left alone: the ground plane is the asset's contract, not its
    bounding box.
    """
    mn, mx = M.bounds(obj)
    obj.data.transform(Matrix.Translation(((mn.x + mx.x) * -0.5,
                                           (mn.y + mx.y) * -0.5, 0.0)))
    obj.data.update()
    return obj


def splinter_tube_end(obj, sides, rings, rng, at_start, depth, pinch=0.10):
    """Turn a capped `M.tube` end into a broken, splintered fracture.

    The rim vertices are shifted along the local axis by an uneven,
    neighbour-correlated amount -- some proud, some recessed -- so the cap fan
    becomes a ring of tapering spikes around a torn hollow.  That is what a
    snapped trunk looks like, as opposed to the flat disc a saw leaves.  The
    cap centre only moves a little: a break is roughly a plane with splinters
    on it, not a funnel.
    """
    vs = obj.data.vertices
    rim = 0 if at_start else rings - 1
    inner = 1 if at_start else rings - 2

    def ring_centre(r):
        c = Vector((0.0, 0.0, 0.0))
        for j in range(sides):
            c += vs[r * sides + j].co
        return c / sides

    c_rim = ring_centre(rim)
    axis = (c_rim - ring_centre(inner))
    if axis.length < 1e-6:
        return obj
    axis.normalize()

    raw = [rng.uniform(0.0, 1.0) ** 1.7 - 0.30 for _ in range(sides)]
    smooth = [(2.0 * raw[j] + raw[(j - 1) % sides] + raw[(j + 1) % sides]) / 4.0
              for j in range(sides)]

    for j in range(sides):
        vi = rim * sides + j
        co = vs[vi].co.copy()
        radial = co - c_rim
        co = co + axis * (smooth[j] * depth) - radial * pinch
        vs[vi].co = co
        ii = inner * sides + j
        vs[ii].co = vs[ii].co + axis * (max(0.0, smooth[j]) * depth * 0.26)

    cap = rings * sides + (0 if at_start else 1)
    if cap < len(vs):
        vs[cap].co = vs[cap].co - axis * (depth * 0.12)
    obj.data.update()
    return obj


def polyline_frame(pts, t):
    """Interpolate a polyline: returns (position, tangent) at 0<=t<=1."""
    idx = max(0.0, min(1.0, t)) * (len(pts) - 1)
    i = min(int(idx), len(pts) - 2)
    f = idx - i
    a, b = Vector(pts[i]), Vector(pts[i + 1])
    tan = (b - a)
    if tan.length < 1e-9:
        tan = Vector((1.0, 0.0, 0.0))
    return a.lerp(b, f), tan.normalized()


def radial_basis(tangent):
    """Two unit vectors spanning the plane perpendicular to `tangent`."""
    up = Vector((0.0, 0.0, 1.0))
    if abs(tangent.dot(up)) > 0.95:
        up = Vector((0.0, 1.0, 0.0))
    side = tangent.cross(up)
    if side.length < 1e-9:
        side = Vector((0.0, 1.0, 0.0))
    side.normalize()
    return side, side.cross(tangent).normalized()


def broken_branch(name, base, direction, length, r0, r1, rng, sides=6,
                  droop=0.25, steps=4):
    """A short snapped-off branch stub with a splintered tip."""
    direction = Vector(direction).normalized()
    side, _ = radial_basis(direction)
    pts, radii = [], []
    for i in range(steps):
        t = i / (steps - 1.0)
        p = Vector(base) + direction * (length * t)
        p.z -= droop * length * t * t
        p += side * (rng.uniform(-0.012, 0.012) * length * t)
        pts.append(tuple(p))
        radii.append(r0 * (1.0 - t) + r1 * t)
    obj = M.tube(name, pts, radii, sides=sides, caps=True)
    splinter_tube_end(obj, sides, steps, rng.sub("tip"), False,
                      depth=length * 0.16, pinch=0.22)
    M.noise_displace(obj, r0 * 0.28, scale=13.0,
                     offset=rng.offset3(9.0), octaves=3)
    return obj


# ---------------------------------------------------------------------------
# v0 -- fallen log
# ---------------------------------------------------------------------------

def build_fallen_log(rng, mats):
    length = 6.9
    rings = 22
    sides = 12

    pts, radii = [], []
    for i in range(rings):
        t = i / (rings - 1.0)
        x = -0.5 * length + t * length
        # a long shallow banana in plan, plus a kink where it hit the ground
        y = (0.30 * math.sin(t * math.pi * 1.02)
             + 0.085 * math.sin(t * 5.4 + 1.3)
             - 0.20 * t)
        # snapped at both ends, so neither end tapers to a point
        r = ((0.320 * (1.0 - t) + 0.175 * t)
             * (1.0 + 0.075 * math.sin(t * 4.1 + 0.5)
                + 0.045 * math.sin(t * 12.3 + 2.2)))
        # part-buried: the centreline drops below one radius in stretches
        sink = (0.075 + 0.060 * math.sin(t * 3.3 + 0.7)
                + 0.030 * math.sin(t * 7.4 + 2.0))
        pts.append((x, y, r - sink))
        radii.append(r)

    log = M.tube("dw_log", pts, radii, sides=sides, caps=True)
    splinter_tube_end(log, sides, rings, rng.sub("butt"), True,
                      depth=0.55, pinch=0.02)
    splinter_tube_end(log, sides, rings, rng.sub("top"), False,
                      depth=0.46, pinch=0.05)

    # bark relief: one coarse pass for the trunk's own irregularity, one at
    # roughly the vertex spacing so the ridges actually resolve
    M.noise_displace(log, 0.046, scale=1.8, offset=rng.offset3(5.0), octaves=3)
    M.noise_displace(log, 0.026, scale=4.6, offset=rng.offset3(5.0), octaves=3)
    # flatten what is buried in the duff
    M.cut_plane(log, (0.0, 0.0, -0.11), (0.0, 0.0, -1.0))

    parts = [log]
    stubs = rng.sub("stubs")
    taken = []
    for k in range(5):
        for _try in range(12):
            t = stubs.uniform(0.10, 0.92)
            if all(abs(t - o) > 0.11 for o in taken):
                taken.append(t)
                break
        p, tan = polyline_frame(pts, t)
        side, up = radial_basis(tan)
        a = stubs.uniform(-1.15, 1.15)          # keep stubs out of the ground
        direction = (side * math.sin(a) + up * math.cos(a) * 0.92
                     + tan * stubs.uniform(-0.35, 0.35))
        r_here = radii[min(int(t * (rings - 1)), rings - 1)]
        parts.append(broken_branch(
            "dw_log_stub%d" % k, p, direction,
            length=stubs.uniform(0.48, 0.88),
            r0=r_here * stubs.uniform(0.24, 0.34),
            r1=r_here * 0.09, rng=stubs.sub("s%d" % k),
            sides=6, droop=stubs.uniform(0.1, 0.4)))

    obj = M.join(parts, "deadwood_v0")
    M.merge_doubles(obj, 8e-4)

    # Bark clings in a few LARGE zones over pale weathered wood -- the noise
    # wavelength is deliberately longer than the face size (metres, not
    # centimetres), because a boundary that turns over every couple of faces
    # reads as camouflage rather than as bark, and per-face assignment cannot
    # resolve anything finer than a face anyway.
    mat.assign_all(obj, mats["wood"])
    mat.assign_faces(obj, mats["bark"],
                     patch_predicate(1.30, -0.04, offset=(3.1, 8.4, 1.7),
                                     aniso=(0.25, 0.96, 0.96), octaves=2,
                                     gain=0.30))
    uvtools.cube_project(obj, 0.6)
    M.shade_smooth(obj, SMOOTH)
    return obj


# ---------------------------------------------------------------------------
# v1 -- snapped stump
# ---------------------------------------------------------------------------

def build_stump(rng, mats):
    height = 1.05
    segments = 20
    profile = [
        (0.000, -0.150),
        (0.340, -0.120),
        (0.320, -0.020),
        (0.286, 0.055),
        (0.264, 0.125),
        (0.251, 0.230),
        (0.244, 0.400),
        (0.239, 0.620),
        (0.234, 0.850),
        (0.229, height),
        (0.158, height - 0.058),   # the broken crown is hollow / crater-like
        (0.074, height - 0.145),
        (0.000, height - 0.190),
    ]
    stump = M.revolve("dw_stump", profile, segments=segments, cap=False)

    # narrow, tall lobes -> discrete buttress roots rather than a smooth skirt
    flare = rng.sub("flare")
    lobes = [(flare.uniform(0.0, TAU), flare.uniform(0.055, 0.185),
              flare.uniform(0.15, 0.34)) for _ in range(6)]
    crown = rng.sub("crown")
    spikes = [(crown.uniform(0.0, TAU), crown.uniform(0.14, 0.52),
               crown.uniform(0.09, 0.30)) for _ in range(7)]
    tilt_a = crown.uniform(0.0, TAU)

    def shape(co, _n, _i):
        p = co.copy()
        r = math.hypot(p.x, p.y)
        ang = math.atan2(p.y, p.x)

        # root flare -- radial buttress lobes, dying out fast by z ~ 0.28
        fall = max(0.0, 1.0 - max(0.0, p.z) / 0.22) ** 2.6
        if r > 1e-5 and fall > 0.0:
            grow = bumps(ang, lobes) * fall
            p.x += (p.x / r) * grow
            p.y += (p.y / r) * grow

        # splintered crown -- weight by height AND radius so the crater floor
        # and the centre stay put while the rim tears upward
        zw = max(0.0, (p.z - 0.68) / (height - 0.68))
        rw = max(0.0, min(1.0, (r - 0.045) / 0.13))
        w = (zw ** 1.6) * rw
        if w > 0.0:
            dz = (bumps(ang, spikes) - 0.075
                  + 0.16 * math.cos(ang - tilt_a))   # slanted break plane
            p.z += dz * w
            if r > 1e-5:
                shrink = -0.030 * w
                p.x += (p.x / r) * shrink
                p.y += (p.y / r) * shrink
        return p

    M.displace(stump, shape)
    M.noise_displace(stump, 0.022, scale=2.7, offset=rng.offset3(4.0), octaves=3)
    M.noise_displace(stump, 0.011, scale=12.5, offset=rng.offset3(4.0), octaves=3)
    M.bend_z(stump, lambda t: (0.045 * t * t, -0.030 * t * t))

    parts = [stump]

    # a handful of free-standing splinter shards on the rim, to break the
    # silhouette in a way a lathe never can
    shards = rng.sub("shards")
    for k in range(7):
        a = shards.uniform(0.0, TAU)
        r = shards.uniform(0.16, 0.23)
        base = Vector((math.cos(a) * r, math.sin(a) * r,
                       height - shards.uniform(0.24, 0.06)))
        up = Vector((math.cos(a) * shards.uniform(-0.30, 0.38),
                     math.sin(a) * shards.uniform(-0.30, 0.38),
                     1.0)).normalized()
        h = shards.uniform(0.14, 0.36)
        pts = [tuple(base),
               tuple(base + up * (h * 0.55)
                     + Vector((shards.uniform(-0.025, 0.025),
                               shards.uniform(-0.025, 0.025), 0.0))),
               tuple(base + up * h)]
        radii = [shards.uniform(0.036, 0.058), 0.028, 0.013]
        shard = M.tube("dw_stump_shard%d" % k, pts, radii, sides=4, caps=True)
        M.noise_displace(shard, 0.010, scale=7.0, offset=shards.offset3(8.0))
        parts.append(shard)

    # surface roots crawling out of the flare
    roots = rng.sub("roots")
    for k in range(5):
        a = roots.uniform(0.0, TAU)
        d = Vector((math.cos(a), math.sin(a), 0.0))
        base = d * 0.28 + Vector((0.0, 0.0, roots.uniform(0.02, 0.16)))
        pts, radii = [], []
        n = 4
        ln = roots.uniform(0.50, 1.00)
        for i in range(n):
            t = i / (n - 1.0)
            p = base + d * (ln * t)
            p.z -= (base.z + 0.075) * (t ** 0.7)
            p += Vector((-d.y, d.x, 0.0)) * (roots.uniform(-0.14, 0.14) * t)
            pts.append(tuple(p))
            radii.append(0.085 * (1.0 - t) + 0.022 * t)
        r_obj = M.tube("dw_stump_root%d" % k, pts, radii, sides=6, caps=True)
        splinter_tube_end(r_obj, 6, n, roots.sub("r%d" % k), False, 0.08, 0.25)
        M.noise_displace(r_obj, 0.014, scale=4.5, offset=roots.offset3(6.0))
        parts.append(r_obj)

    obj = M.join(parts, "deadwood_v1")
    M.merge_doubles(obj, 6e-4)
    M.cut_plane(obj, (0.0, 0.0, -0.09), (0.0, 0.0, -1.0))

    mat.assign_all(obj, mats["bark"])
    mat.assign_faces(obj, mats["wood"],
                     patch_predicate(1.30, -0.02, offset=(1.4, 2.9, 6.2),
                                     aniso=(1.10, 1.10, 0.28), octaves=2,
                                     gain=0.30))
    uvtools.cube_project(obj, 0.5)
    M.shade_smooth(obj, SMOOTH)
    return obj


# ---------------------------------------------------------------------------
# v2 -- windthrow root plate
# ---------------------------------------------------------------------------

def build_root_plate(rng, mats):
    radius = 1.30
    half = 0.200

    profile = [
        (0.00 * radius, -half),
        (0.52 * radius, -half * 0.90),
        (0.86 * radius, -half * 0.52),
        (1.00 * radius, 0.0),
        (0.86 * radius, half * 0.52),
        (0.52 * radius, half * 0.90),
        (0.00 * radius, half),
    ]
    disc = M.revolve("dw_plate", profile, segments=10, cap=False)
    M.subsurf(disc, levels=1)
    # a windthrow pan is wider than it is tall once it is stood on edge
    disc.data.transform(Matrix.Diagonal((1.16, 0.86, 1.0, 1.0)))
    disc.data.update()

    # break the circle: strong radial lobes + heavy matted-root displacement
    edge = rng.sub("edge")
    lobes = [(edge.uniform(0.0, TAU), edge.uniform(-0.48, 0.40),
              edge.uniform(0.16, 0.55)) for _ in range(11)]

    # Thickness is what separates a root pan from a pancake: the real thing is
    # 20-50 cm of matted soil and root, and wildly uneven across its face.
    tseed = Vector(rng.sub("thick").offset3(11.0))

    def face_z(x, y, side, out=0.0):
        """Approximate the pan's own surface height at (x, y).

        Everything stuck to the face -- roots, clods -- has to follow the same
        thickness field the disc was displaced by, or it ends up swallowed
        wherever the pan happens to be thick.
        """
        u = min(1.0, math.hypot(x / 1.16, y / 0.86) / radius)
        taper = (1.0 - u * u) ** 0.6
        thick = 1.0 + 0.95 * fbm(Vector((x, y, 0.0)) * 1.05 + tseed, 2)
        return side * (half * taper * thick * 0.94 + out)

    def outline(co, _n, _i):
        p = co.copy()
        r = math.hypot(p.x, p.y)
        p.z *= 1.0 + 0.95 * fbm(Vector((p.x, p.y, 0.0)) * 1.05 + tseed, 2)
        if r < 1e-5:
            return p
        ang = math.atan2(p.y, p.x)
        grow = bumps(ang, lobes) * (r / radius) ** 1.3
        p.x += (p.x / r) * grow
        p.y += (p.y / r) * grow
        return p

    M.displace(disc, outline)
    # amplitudes are deliberately large relative to the face size: this is a
    # torn mat of soil and root, and a subsurfed lathe left alone reads as a
    # river pebble
    M.noise_displace(disc, 0.190, scale=1.15, offset=rng.offset3(3.0), octaves=3)
    M.noise_displace(disc, 0.085, scale=2.45, offset=rng.offset3(3.0), octaves=3)

    parts = [disc]

    # Broken roots radiating out of the rim, still in the disc's own plane.
    # Disc-local +Y ends up pointing skyward once the pan is tipped, so the
    # angles are biased to that half -- the rest of the root ball is in the
    # hole it tore out of.
    roots = rng.sub("roots")
    for k in range(10):
        a = roots.uniform(-0.22 * math.pi, 1.22 * math.pi)
        d = Vector((math.cos(a) * 1.16, math.sin(a) * 0.86, 0.0)).normalized()
        lat = Vector((-d.y, d.x, 0.0))
        p0 = Vector((math.cos(a) * radius * 1.16, math.sin(a) * radius * 0.86,
                     0.0)) * roots.uniform(0.74, 0.95)
        base = p0 + Vector((0.0, 0.0, roots.uniform(-0.06, 0.06)))
        ln = roots.uniform(0.25, 1.35) ** 1.15
        n = 4
        pts, radii = [], []
        curl = roots.uniform(-0.42, 0.42)
        thick = roots.uniform(0.032, 0.085)
        for i in range(n):
            t = i / (n - 1.0)
            p = base + d * (ln * t) + lat * (curl * ln * t * t)
            p.z += roots.uniform(-0.10, 0.10) * t
            pts.append(tuple(p))
            radii.append(thick * (1.0 - t) + 0.011 * t)
        r_obj = M.tube("dw_plate_root%d" % k, pts, radii, sides=5, caps=True)
        splinter_tube_end(r_obj, 5, n, roots.sub("r%d" % k), False, 0.07, 0.25)
        M.noise_displace(r_obj, 0.011, scale=4.5, offset=roots.offset3(7.0))
        parts.append(r_obj)

        # roots fork; a fan of straight uniform spikes is the giveaway of a
        # procedural asset, so the thicker ones branch once
        if thick > 0.055:
            bp = Vector(pts[1])
            bd = (d * 0.75 + lat * roots.choice((-1.0, 1.0)) * 0.9).normalized()
            bl = ln * roots.uniform(0.40, 0.70)
            bpts, bradii = [], []
            for i in range(3):
                t = i * 0.5
                bpts.append(tuple(bp + bd * (bl * t)
                                  + Vector((0.0, 0.0,
                                            roots.uniform(-0.06, 0.06) * t))))
                bradii.append(thick * 0.55 * (1.0 - t) + 0.010 * t)
            fork = M.tube("dw_plate_fork%d" % k, bpts, bradii, sides=5,
                          caps=True)
            splinter_tube_end(fork, 5, 3, roots.sub("f%d" % k), False,
                              0.05, 0.25)
            parts.append(fork)

    # roots bursting out of the *face* of the pan -- this is what stops the
    # silhouette reading as a spiky disc from the front
    face = rng.sub("face")
    for k in range(3):
        a = face.uniform(-0.15 * math.pi, 1.15 * math.pi)
        rr = face.uniform(0.20, 0.90) * radius
        side = 1.0 if face.chance(0.5) else -1.0
        bx, by = math.cos(a) * rr * 1.16, math.sin(a) * rr * 0.86
        base = Vector((bx, by, face_z(bx, by, side, -0.03)))
        d = Vector((math.cos(a) * 0.55, math.sin(a) * 0.55, side * 1.0))
        d.normalize()
        n = 4
        ln = face.uniform(0.30, 0.75)
        lat = Vector((-d.y, d.x, 0.0)).normalized()
        pts, radii = [], []
        for i in range(n):
            t = i / (n - 1.0)
            p = base + d * (ln * t) + lat * (face.uniform(-0.3, 0.3) * ln * t * t)
            pts.append(tuple(p))
            radii.append(face.uniform(0.030, 0.055) * (1.0 - t) + 0.011 * t)
        f_obj = M.tube("dw_plate_face%d" % k, pts, radii, sides=5, caps=True)
        splinter_tube_end(f_obj, 5, n, face.sub("f%d" % k), False, 0.06, 0.25)
        parts.append(f_obj)

    # Roots lying ACROSS the face of the pan.  Without them the disc reads as
    # a smooth membrane with spikes round the rim -- a sea urchin.  These are
    # what turn it into a mat.
    web = rng.sub("web")
    for k in range(5):
        a0 = web.uniform(0.0, TAU)
        a1 = a0 + web.uniform(1.1, 2.7) * web.choice((-1.0, 1.0))
        side = 1.0 if web.chance(0.5) else -1.0
        r0 = web.uniform(0.22, 0.96) * radius
        r1 = web.uniform(0.22, 0.96) * radius
        x0, y0 = math.cos(a0) * r0 * 1.16, math.sin(a0) * r0 * 0.86
        x1, y1 = math.cos(a1) * r1 * 1.16, math.sin(a1) * r1 * 0.86
        p0 = Vector((x0, y0, face_z(x0, y0, side, 0.02)))
        p1 = Vector((x1, y1, face_z(x1, y1, side, 0.02)))
        thick = web.uniform(0.022, 0.044)
        pts, radii = [], []
        for i in range(3):
            t = i * 0.5
            bow = math.sin(math.pi * t)
            q = p0.lerp(p1, t) + Vector((web.uniform(-0.10, 0.10) * bow,
                                         0.0, 0.0))
            q.y += web.uniform(-0.10, 0.10) * bow
            q.z = face_z(q.x, q.y, side, 0.02 + 0.055 * bow)
            pts.append(tuple(q))
            radii.append(thick * (1.0 - 0.30 * bow))
        parts.append(M.tube("dw_plate_web%d" % k, pts, radii, sides=4,
                            caps=True))

    # clods of soil and the odd stone still gripped by the root mat
    clods = rng.sub("clods")
    for k in range(4):
        a = clods.uniform(-0.10 * math.pi, 1.10 * math.pi)
        rr = clods.uniform(0.20, 0.88) * radius
        side = 1.0 if clods.chance(0.5) else -1.0
        cx, cy = math.cos(a) * rr * 1.16, math.sin(a) * rr * 0.86
        clod = M.icosphere(
            "dw_plate_clod%d" % k, radius=clods.uniform(0.085, 0.165),
            subdivisions=1,
            location=(cx, cy, face_z(cx, cy, side, -0.02)))
        M.noise_displace(clod, 0.040, scale=5.5, offset=clods.offset3(4.0))
        parts.append(clod)

    plate = M.join(parts, "dw_plate_asm")

    # soil / stone clinging to the pan, before the plate is tipped upright
    mat.assign_all(plate, mats["soil"])
    mat.assign_faces(plate, mats["wood"],
                     patch_predicate(1.15, 0.14, offset=(5.5, 1.2, 3.3),
                                     octaves=1))
    mat.assign_faces(plate, mats["stone"],
                     patch_predicate(2.6, 0.42, offset=(0.7, 4.4, 9.1),
                                     octaves=1))

    # tip the pan onto its edge (a windthrow plate leans back over its hole)
    tip = (Matrix.Rotation(math.radians(9.0), 4, "Z")
           @ Matrix.Rotation(math.radians(79.0), 4, "X"))
    plate.data.transform(tip)
    plate.data.update()
    mn, _mx = M.bounds(plate)
    plate.data.transform(Matrix.Translation((0.0, -0.10, -mn.z - 0.06)))
    plate.data.update()

    # the snapped trunk, laid back along the ground away from the pan
    trunk = rng.sub("trunk")
    n = 7
    pts, radii = [], []
    for i in range(n):
        t = i / (n - 1.0)
        p = Vector((0.10 * math.sin(t * 2.6), 0.30 + t * 2.55,
                    1.05 * (1.0 - t) ** 1.7 + 0.20))
        pts.append(tuple(p))
        radii.append(0.235 * (1.0 - t) + 0.165 * t)
    stem = M.tube("dw_plate_trunk", pts, radii, sides=8, caps=True)
    splinter_tube_end(stem, 8, n, trunk.sub("end"), False, 0.30, 0.12)
    M.noise_displace(stem, 0.024, scale=2.0, offset=trunk.offset3(2.0), octaves=3)
    M.noise_displace(stem, 0.012, scale=4.4, offset=trunk.offset3(2.0))
    mat.assign_all(stem, mats["bark"])
    mat.assign_faces(stem, mats["wood"],
                     patch_predicate(1.25, 0.02, offset=(8.8, 0.4, 2.6),
                                     aniso=(0.6, 0.30, 0.6), octaves=1))

    obj = M.join([plate, stem], "deadwood_v2")
    M.merge_doubles(obj, 8e-4)
    M.cut_plane(obj, (0.0, 0.0, -0.10), (0.0, 0.0, -1.0))
    uvtools.cube_project(obj, 0.5)
    M.shade_smooth(obj, SMOOTH)
    return obj


# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": True})
    rng = cli.setup(args.seed, NAME)

    # The whole asset lives or dies on the VALUE contrast between the two wood
    # surfaces: near-black bark against pale silver-grey weathered timber is
    # what makes a dead spruce readable at 30 m.  mat.WOOD_DEAD is a warm tan,
    # which reads as driftwood rather than standing deadwood, so the bare wood
    # gets a desaturated, much lighter grey of its own.
    mats = {
        "bark": mat.principled("dw_bark", mat.BARK_SPRUCE, roughness=0.94,
                               specular=0.18),
        "wood": mat.principled("dw_wood", (0.228, 0.222, 0.206),
                               roughness=0.84, specular=0.26),
        "soil": mat.principled("dw_soil", (0.058, 0.045, 0.032),
                               roughness=0.98, specular=0.12),
        "stone": mat.principled("dw_stone",
                                tuple(c * 0.85 for c in mat.GRANITE_MID),
                                roughness=0.74, specular=0.38),
    }

    builders = (build_fallen_log, build_stump, build_root_plate)
    all_lods = []
    for i, build in enumerate(builders):
        obj = build(rng.sub("v%d" % i), mats)
        centre_xy(obj)
        lods = lod.decimate_lods(obj, "%s_v%d" % (NAME, i),
                                 ratios=(1.0, 0.40, 0.12), smooth_angle=SMOOTH)
        lod.report(lods)
        all_lods.extend(lods)

    # M.join unlinks its source objects; without an explicit update the
    # exporter's walk over view_layer.objects can iterate freed pointers.
    bpy.context.view_layer.update()

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(all_lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, all_lods, extra={
        "variants": ["v0_fallen_log", "v1_stump", "v2_root_plate"],
        "originNote": ("every variant is XY-centred on the origin and sits on "
                       "the ground at z=0 (buried undersides dip below); no "
                       "layout offset is baked in"),
        "notes": "Sumava bark-beetle deadwood: fallen log, snapped stump, windthrow root plate",
    })


main()
