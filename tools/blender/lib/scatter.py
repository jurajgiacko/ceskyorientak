"""Procedural scatter and per-instance variation.

Used for boulder fields, branch placement, needle sprays and foliage clusters.
All functions take a DRNG so results are reproducible.
"""

import math

from mathutils import Euler, Matrix, Vector

from . import mesh as M


def disc_points(rng, count, radius, min_dist=0.0, tries=32):
    """Dart-thrown points in a disc with a minimum separation.

    Cheaper than true Poisson disc sampling and good enough for the counts we
    use (tens, not thousands).
    """
    pts = []
    for _ in range(count):
        for _t in range(tries):
            x, y = rng.in_disc(radius)
            if min_dist <= 0 or all((x - px) ** 2 + (y - py) ** 2 >= min_dist ** 2
                                    for px, py in pts):
                pts.append((x, y))
                break
    return pts


def ring_points(count, radius, phase=0.0, jitter_rng=None, jitter=0.0):
    """Evenly spaced points on a circle, optionally jittered in angle."""
    out = []
    for i in range(count):
        a = phase + 2.0 * math.pi * i / max(1, count)
        if jitter_rng is not None and jitter:
            a += jitter_rng.uniform(-jitter, jitter)
        out.append((math.cos(a) * radius, math.sin(a) * radius, a))
    return out


def golden_ring(count, phase=0.0):
    """Golden-angle sequence -- avoids the visible rows a fixed step gives."""
    ga = math.pi * (3.0 - math.sqrt(5.0))
    return [phase + ga * i for i in range(count)]


def surface_samples(obj, rng, count):
    """Area-weighted random points on a mesh surface -> [(pos, normal)]."""
    me = obj.data
    me.calc_loop_triangles()
    tris = me.loop_triangles
    if not tris:
        return []
    areas = [t.area for t in tris]
    total = sum(areas) or 1.0
    cum = []
    acc = 0.0
    for a in areas:
        acc += a / total
        cum.append(acc)

    out = []
    for _ in range(count):
        r = rng.uniform(0.0, 1.0)
        lo, hi = 0, len(cum) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if cum[mid] < r:
                lo = mid + 1
            else:
                hi = mid
        t = tris[lo]
        u = rng.uniform(0.0, 1.0)
        v = rng.uniform(0.0, 1.0)
        if u + v > 1.0:
            u, v = 1.0 - u, 1.0 - v
        a, b, c = (me.vertices[i].co for i in t.vertices)
        pos = a + (b - a) * u + (c - a) * v
        out.append((pos.copy(), t.normal.copy()))
    return out


def vary_matrix(rng, scale=(1.0, 1.0), rot_z=(0.0, math.tau), tilt=0.0,
                offset=0.0, non_uniform=0.0):
    """A random-but-reproducible placement matrix for an instance."""
    s = rng.uniform(*scale)
    sx = s * (1.0 + rng.uniform(-non_uniform, non_uniform))
    sy = s * (1.0 + rng.uniform(-non_uniform, non_uniform))
    sz = s * (1.0 + rng.uniform(-non_uniform, non_uniform))
    eul = Euler((rng.uniform(-tilt, tilt), rng.uniform(-tilt, tilt),
                 rng.uniform(*rot_z)), "XYZ")
    loc = Vector(rng.offset3(offset)) if offset else Vector((0, 0, 0))
    return (Matrix.Translation(loc) @ eul.to_matrix().to_4x4()
            @ Matrix.Diagonal((sx, sy, sz)).to_4x4())


def instance(obj, name, matrix):
    """Copy `obj`, apply `matrix` into its mesh data, return the new object."""
    new = obj.copy()
    new.data = obj.data.copy()
    new.name = name
    new.data.name = name + "_mesh"
    M.link(new)
    new.data.transform(matrix)
    new.data.update()
    return new


def frame_from_normal(normal, up=Vector((0, 0, 1))):
    """Orthonormal basis with Z along `normal` -- for aligning cards to a
    branch or a surface."""
    z = Vector(normal).normalized()
    ref = up if abs(z.dot(up)) < 0.95 else Vector((1, 0, 0))
    x = ref.cross(z)
    if x.length < 1e-9:
        x = Vector((1, 0, 0))
    x.normalize()
    y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed().to_4x4()


def card(name, width, height, matrix=None, pivot_bottom=True, double=False):
    """A single textured quad (needle spray / leaf cluster billboard)."""
    hw = width * 0.5
    z0 = 0.0 if pivot_bottom else -height * 0.5
    z1 = z0 + height
    verts = [(-hw, 0, z0), (hw, 0, z0), (hw, 0, z1), (-hw, 0, z1)]
    faces = [(0, 1, 2, 3)]
    uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
    if double:
        verts += [(-hw, 0, z0), (hw, 0, z0), (hw, 0, z1), (-hw, 0, z1)]
        faces.append((7, 6, 5, 4))
        uvs += [(0, 0), (1, 0), (1, 1), (0, 1)]

    obj = M.from_pydata(name, verts, faces)
    me = obj.data
    layer = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        layer.data[loop.index].uv = uvs[loop.vertex_index]
    if matrix is not None:
        obj.data.transform(matrix)
        obj.data.update()
    return obj
