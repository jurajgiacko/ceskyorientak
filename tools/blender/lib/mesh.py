"""Mesh construction and editing helpers.

Everything here is bmesh / data-API based rather than `bpy.ops`, because
operators depend on a UI context that does not exist in `--background`.
The only exception is the small set of modifiers we deliberately want
(Subsurf, Decimate, Solidify), which are applied through the depsgraph.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils import noise as bnoise

TAU = math.pi * 2.0
EPS = 1e-9


# ---------------------------------------------------------------------------
# scene
# ---------------------------------------------------------------------------

def reset_scene():
    """Empty the file: objects, meshes, materials, images."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                 bpy.data.curves, bpy.data.node_groups):
        for item in list(coll):
            try:
                coll.remove(item, do_unlink=True)
            except Exception:
                pass


def link(obj):
    if obj.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(obj)
    return obj


def set_active(obj):
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(False)
    obj.select_set(True)
    vl.objects.active = obj
    return obj


def new_object(name, mesh=None):
    me = mesh if mesh is not None else bpy.data.meshes.new(name + "_mesh")
    obj = bpy.data.objects.new(name, me)
    return link(obj)


def from_pydata(name, verts, faces, edges=None):
    me = bpy.data.meshes.new(name + "_mesh")
    me.from_pydata([tuple(v) for v in verts], edges or [], [list(f) for f in faces])
    me.update()
    me.validate(verbose=False)
    return new_object(name, me)


def from_bmesh(name, bm):
    me = bpy.data.meshes.new(name + "_mesh")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return new_object(name, me)


def to_bmesh(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    return bm


def write_bmesh(obj, bm, free=True):
    bm.to_mesh(obj.data)
    if free:
        bm.free()
    obj.data.update()
    return obj


def remove(obj):
    try:
        bpy.data.objects.remove(obj, do_unlink=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# modifiers
# ---------------------------------------------------------------------------

def add_mod(obj, mtype, name=None, **kw):
    m = obj.modifiers.new(name or mtype.lower(), mtype)
    for k, v in kw.items():
        try:
            setattr(m, k, v)
        except Exception:
            pass
    return m


def apply_mods(obj):
    """Bake every modifier into the mesh via the depsgraph (headless safe)."""
    if not obj.modifiers:
        return obj
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    new_me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True,
                                             depsgraph=dg)
    old = obj.data
    obj.data = new_me
    obj.modifiers.clear()
    try:
        bpy.data.meshes.remove(old)
    except Exception:
        pass
    obj.data.update()
    return obj


def apply_transform(obj, location=False, rotation=True, scale=True):
    """Bake object transform into vertices (bevel/solidify need real scale)."""
    mw = obj.matrix_world
    loc, rot, scl = mw.decompose()
    basis = Matrix.Identity(4)
    if location:
        basis = Matrix.Translation(loc) @ basis
    if rotation:
        basis = basis @ rot.to_matrix().to_4x4()
    if scale:
        basis = basis @ Matrix.Diagonal(scl).to_4x4()
    obj.data.transform(basis)
    rest = Matrix.Identity(4)
    if not location:
        rest = Matrix.Translation(loc)
    if not rotation:
        rest = rest @ rot.to_matrix().to_4x4()
    if not scale:
        rest = rest @ Matrix.Diagonal(scl).to_4x4()
    obj.matrix_world = rest
    obj.data.update()
    return obj


def subsurf(obj, levels=2, simple=False, apply=True):
    add_mod(obj, "SUBSURF", "subsurf", levels=levels, render_levels=levels,
            subdivision_type="SIMPLE" if simple else "CATMULL_CLARK",
            use_limit_surface=False)
    return apply_mods(obj) if apply else obj


def solidify(obj, thickness, offset=-1.0, rim=True, apply=True):
    add_mod(obj, "SOLIDIFY", "solidify", thickness=thickness, offset=offset,
            use_rim=rim, use_rim_only=False)
    return apply_mods(obj) if apply else obj


def decimate(obj, ratio, apply=True):
    add_mod(obj, "DECIMATE", "decimate", decimate_type="COLLAPSE",
            ratio=max(0.0005, min(1.0, ratio)), use_collapse_triangulate=True)
    return apply_mods(obj) if apply else obj


def weld(obj, distance=1e-4, apply=True):
    add_mod(obj, "WELD", "weld", merge_threshold=distance)
    return apply_mods(obj) if apply else obj


# ---------------------------------------------------------------------------
# bmesh edits
# ---------------------------------------------------------------------------

def bevel(obj, width, segments=2, angle_deg=30.0, clamp=True, profile=0.5):
    """Bevel every edge sharper than angle_deg.  Applied immediately."""
    bm = to_bmesh(obj)
    limit = math.radians(angle_deg)
    edges = [e for e in bm.edges
             if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > limit]
    if edges:
        try:
            bmesh.ops.bevel(bm, geom=edges, offset=width, segments=segments,
                            profile=profile, affect="EDGES",
                            offset_type="OFFSET", clamp_overlap=clamp,
                            miter_outer="ARC")
        except TypeError:
            bmesh.ops.bevel(bm, geom=edges, offset=width, segments=segments,
                            profile=profile, affect="EDGES")
    return write_bmesh(obj, bm)


def triangulate(obj):
    bm = to_bmesh(obj)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY",
                          ngon_method="BEAUTY")
    return write_bmesh(obj, bm)


def recalc_normals(obj, inside=False):
    bm = to_bmesh(obj)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if inside:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    return write_bmesh(obj, bm)


def merge_doubles(obj, distance=1e-4):
    bm = to_bmesh(obj)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=distance)
    return write_bmesh(obj, bm)


def shade_smooth(obj, angle_deg=32.0):
    """Smooth shading with an explicit sharp-edge angle.

    Done by hand rather than via `shade_smooth_by_angle` so it works with no
    UI context.  Sharp edges are what the glTF exporter turns into split
    normals, so this is what controls how the asset reads in the browser.
    """
    limit = math.radians(angle_deg)
    bm = to_bmesh(obj)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(math.pi) <= limit
        else:
            e.smooth = False
    return write_bmesh(obj, bm)


def shade_flat(obj):
    bm = to_bmesh(obj)
    for f in bm.faces:
        f.smooth = False
    return write_bmesh(obj, bm)


def join(objs, name=None):
    """Join meshes into the first object, preserving per-face materials."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    if len(objs) == 1:
        if name:
            objs[0].name = name
        return objs[0]

    target = objs[0]
    apply_transform(target, location=True)
    bm = to_bmesh(target)

    # material slot remap: build the union slot list on the target
    mat_index = {}
    for i, m in enumerate(target.data.materials):
        if m is not None:
            mat_index[m.name] = i

    tmp_layer = bm.faces.layers.int.get("_mi") or bm.faces.layers.int.new("_mi")
    for f in bm.faces:
        f[tmp_layer] = f.material_index

    for src in objs[1:]:
        apply_transform(src, location=True)
        sbm = to_bmesh(src)
        remap = {}
        for i, m in enumerate(src.data.materials):
            if m is None:
                remap[i] = 0
                continue
            if m.name not in mat_index:
                target.data.materials.append(m)
                mat_index[m.name] = len(target.data.materials) - 1
            remap[i] = mat_index[m.name]

        vmap = {}
        for v in sbm.verts:
            vmap[v] = bm.verts.new(v.co)
        bm.verts.index_update()
        for f in sbm.faces:
            try:
                nf = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.smooth = f.smooth
            nf[tmp_layer] = remap.get(f.material_index, 0)
        sbm.free()
        remove(src)

    for f in bm.faces:
        f.material_index = f[tmp_layer]
    bm.faces.layers.int.remove(tmp_layer)

    write_bmesh(target, bm)
    if name:
        target.name = name
        target.data.name = name + "_mesh"
    return target


def tri_count(obj):
    me = obj.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def bounds(obj):
    """(min, max) in local space."""
    cos = [v.co for v in obj.data.vertices]
    if not cos:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    mn = Vector((min(c.x for c in cos), min(c.y for c in cos), min(c.z for c in cos)))
    mx = Vector((max(c.x for c in cos), max(c.y for c in cos), max(c.z for c in cos)))
    return mn, mx


# ---------------------------------------------------------------------------
# primitives (bmesh.ops based -- no operator context needed)
# ---------------------------------------------------------------------------

def _ico(bm, subdivisions, radius, matrix):
    try:
        return bmesh.ops.create_icosphere(bm, subdivisions=subdivisions,
                                          radius=radius, matrix=matrix)
    except TypeError:  # Blender < 3.0 naming
        return bmesh.ops.create_icosphere(bm, subdivisions=subdivisions,
                                          diameter=radius, matrix=matrix)


def icosphere(name, radius=1.0, subdivisions=2, location=(0, 0, 0)):
    bm = bmesh.new()
    _ico(bm, subdivisions, radius, Matrix.Translation(location))
    return from_bmesh(name, bm)


def cube(name, size=1.0, location=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=size, matrix=Matrix.Translation(location))
    return from_bmesh(name, bm)


def cylinder(name, radius=0.5, depth=1.0, segments=16, caps=True,
             radius_top=None, location=(0, 0, 0)):
    r_top = radius if radius_top is None else radius_top
    bm = bmesh.new()
    kw = dict(cap_ends=caps, cap_tris=False, segments=segments, depth=depth,
              matrix=Matrix.Translation(location))
    try:
        bmesh.ops.create_cone(bm, radius1=radius, radius2=r_top, **kw)
    except TypeError:
        bmesh.ops.create_cone(bm, diameter1=radius, diameter2=r_top, **kw)
    return from_bmesh(name, bm)


def plane(name, size_x=1.0, size_y=1.0, location=(0, 0, 0), axis="XY"):
    hx, hy = size_x * 0.5, size_y * 0.5
    if axis == "XY":
        v = [(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)]
    elif axis == "XZ":
        v = [(-hx, 0, -hy), (hx, 0, -hy), (hx, 0, hy), (-hx, 0, hy)]
    else:  # YZ
        v = [(0, -hx, -hy), (0, hx, -hy), (0, hx, hy), (0, -hx, hy)]
    v = [(a + location[0], b + location[1], c + location[2]) for a, b, c in v]
    obj = from_pydata(name, v, [(0, 1, 2, 3)])
    set_uv_from_quad(obj)
    return obj


# ---------------------------------------------------------------------------
# parametric surfaces & sweeps -- the workhorses
# ---------------------------------------------------------------------------

def param_surface(name, fn, nu, nv, close_u=False, close_v=False,
                  diagonal=None, uv=True):
    """Grid surface from fn(u, v) -> (x, y, z), u/v in [0, 1].

    diagonal: None -> quads; 'TR_BL' or 'TL_BR' -> triangles with a consistent
    diagonal direction.  A forced diagonal lets a material boundary follow the
    grid exactly (used for the IOF flag's white/orange split).
    """
    cu = nu if close_u else nu + 1
    cv = nv if close_v else nv + 1
    verts = []
    uvs = []
    for i in range(cu):
        u = i / float(nu)
        for j in range(cv):
            v = j / float(nv)
            verts.append(fn(u, v))
            uvs.append((u, v))

    def vid(i, j):
        return (i % cu) * cv + (j % cv)

    faces = []
    for i in range(nu):
        for j in range(nv):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            if diagonal == "TR_BL":
                faces.append((a, b, c))
                faces.append((a, c, d))
            elif diagonal == "TL_BR":
                faces.append((a, b, d))
                faces.append((b, c, d))
            else:
                faces.append((a, b, c, d))

    obj = from_pydata(name, verts, faces)
    if uv:
        me = obj.data
        layer = me.uv_layers.new(name="UVMap")
        for loop in me.loops:
            layer.data[loop.index].uv = uvs[loop.vertex_index]
    return obj


def _rmf_frames(pts):
    """Rotation-minimising frames (double reflection) -- sweeps without twist."""
    n = len(pts)
    tangents = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        if t.length < EPS:
            t = Vector((0, 0, 1))
        tangents.append(t.normalized())

    t0 = tangents[0]
    seed = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    r = (seed - t0 * seed.dot(t0))
    if r.length < EPS:
        r = Vector((1, 0, 0))
    r.normalize()

    normals = [r]
    for i in range(n - 1):
        v1 = pts[i + 1] - pts[i]
        c1 = v1.dot(v1)
        if c1 < EPS:
            normals.append(normals[-1])
            continue
        rl = normals[-1] - v1 * (2.0 / c1) * v1.dot(normals[-1])
        tl = tangents[i] - v1 * (2.0 / c1) * v1.dot(tangents[i])
        v2 = tangents[i + 1] - tl
        c2 = v2.dot(v2)
        rn = rl if c2 < EPS else rl - v2 * (2.0 / c2) * v2.dot(rl)
        rn = rn - tangents[i + 1] * rn.dot(tangents[i + 1])
        if rn.length < EPS:
            rn = normals[-1]
        normals.append(rn.normalized())

    binormals = [tangents[i].cross(normals[i]).normalized() for i in range(n)]
    return tangents, normals, binormals


def tube(name, points, radii, sides=8, caps=True, twist=0.0, uv=True,
         uv_scale=(1.0, 1.0)):
    """Sweep a circular profile along a polyline.

    points: iterable of 3-tuples.  radii: scalar or per-point iterable.
    Uses rotation-minimising frames, so bends do not introduce twisting.
    """
    pts = [Vector(p) for p in points]
    if len(pts) < 2:
        raise ValueError("tube needs >= 2 points")
    if isinstance(radii, (int, float)):
        radii = [float(radii)] * len(pts)
    radii = list(radii)

    _, nrm, bnm = _rmf_frames(pts)

    verts = []
    uvs = []
    # arc length for V coordinate
    arc = [0.0]
    for i in range(1, len(pts)):
        arc.append(arc[-1] + (pts[i] - pts[i - 1]).length)
    total = arc[-1] or 1.0

    for i, p in enumerate(pts):
        for j in range(sides):
            a = TAU * j / sides + twist * (i / float(len(pts) - 1))
            off = nrm[i] * (math.cos(a) * radii[i]) + bnm[i] * (math.sin(a) * radii[i])
            verts.append(tuple(p + off))
            uvs.append((j / float(sides) * uv_scale[0],
                        arc[i] / total * uv_scale[1]))

    faces = []
    for i in range(len(pts) - 1):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            c = (i + 1) * sides + (j + 1) % sides
            d = (i + 1) * sides + j
            faces.append((a, b, c, d))

    if caps:
        base = len(verts)
        verts.append(tuple(pts[0]))
        uvs.append((0.5, 0.0))
        top = len(verts)
        verts.append(tuple(pts[-1]))
        uvs.append((0.5, 1.0))
        last = (len(pts) - 1) * sides
        for j in range(sides):
            faces.append((base, (j + 1) % sides, j))
            faces.append((top, last + j, last + (j + 1) % sides))

    obj = from_pydata(name, verts, faces)
    if uv:
        me = obj.data
        layer = me.uv_layers.new(name="UVMap")
        for loop in me.loops:
            layer.data[loop.index].uv = uvs[loop.vertex_index]
    recalc_normals(obj)
    return obj


def revolve(name, profile, segments=16, axis="Z", arc=TAU, cap=False):
    """Lathe a 2D profile [(radius, height), ...] around an axis.

    Radius 0 collapses to a pole vertex, so domes/cones come out watertight.
    """
    prof = [(float(r), float(h)) for r, h in profile]
    closed = abs(arc - TAU) < 1e-6
    nseg = segments if closed else segments + 1

    verts = []
    uvs = []
    index = []  # index[i][j] -> vertex id  (i profile point, j segment)
    for i, (r, h) in enumerate(prof):
        row = []
        if r < EPS:
            vid = len(verts)
            verts.append((0.0, 0.0, h) if axis == "Z" else (h, 0.0, 0.0))
            uvs.append((0.5, i / float(len(prof) - 1)))
            row = [vid] * nseg
        else:
            for j in range(nseg):
                a = arc * j / float(segments)
                x, y = r * math.cos(a), r * math.sin(a)
                if axis == "Z":
                    verts.append((x, y, h))
                else:
                    verts.append((h, x, y))
                uvs.append((j / float(segments), i / float(len(prof) - 1)))
                row.append(len(verts) - 1)
        index.append(row)

    faces = []
    jmax = segments if closed else segments
    for i in range(len(prof) - 1):
        for j in range(jmax):
            j2 = (j + 1) % nseg if closed else j + 1
            a, b = index[i][j], index[i][j2]
            c, d = index[i + 1][j2], index[i + 1][j]
            quad = [a, b, c, d]
            uniq = []
            for v in quad:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                faces.append(tuple(uniq))

    if cap and prof[0][0] > EPS:
        faces.append(tuple(reversed(index[0][:jmax if closed else nseg])))
    if cap and prof[-1][0] > EPS:
        faces.append(tuple(index[-1][:jmax if closed else nseg]))

    obj = from_pydata(name, verts, faces)
    me = obj.data
    layer = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        layer.data[loop.index].uv = uvs[loop.vertex_index]
    recalc_normals(obj)
    return obj


def rounded_box(name, size=(1, 1, 1), radius=0.05, segments=2, location=(0, 0, 0)):
    """Box with bevelled edges -- the base for most manufactured props."""
    sx, sy, sz = size
    hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
    verts = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
             (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    obj = from_pydata(name, verts, faces)
    r = min(radius, min(hx, hy, hz) * 0.98)
    if r > 0:
        bevel(obj, r, segments=segments, angle_deg=20.0)
    obj.location = location
    return obj


# ---------------------------------------------------------------------------
# deformation
# ---------------------------------------------------------------------------

def displace(obj, fn):
    """fn(co: Vector, normal: Vector, index: int) -> Vector (new position)."""
    me = obj.data
    normals = [v.normal.copy() for v in me.vertices]
    for i, v in enumerate(me.vertices):
        v.co = fn(v.co.copy(), normals[i], i)
    me.update()
    return obj


def noise_displace(obj, amplitude, scale=1.0, octaves=3, offset=(0, 0, 0),
                   along_normal=True, hardness=0.5):
    """Layered value-noise displacement -- weathering, bark, ground scatter."""
    off = Vector(offset)

    def fn(co, nrm, _i):
        p = (co + off) * scale
        n = 0.0
        amp = 1.0
        freq = 1.0
        norm = 0.0
        for _ in range(octaves):
            n += bnoise.noise(p * freq) * amp
            norm += amp
            amp *= hardness
            freq *= 2.0
        n /= (norm or 1.0)
        if along_normal:
            return co + nrm * (n * amplitude)
        return co + Vector((n, n, n)) * amplitude

    return displace(obj, fn)


def taper_z(obj, fn):
    """Scale X/Y by fn(z_normalised) -- trunks, poles, tent shapes."""
    mn, mx = bounds(obj)
    h = (mx.z - mn.z) or 1.0
    for v in obj.data.vertices:
        t = (v.co.z - mn.z) / h
        s = fn(t)
        v.co.x *= s
        v.co.y *= s
    obj.data.update()
    return obj


def bend_z(obj, fn):
    """Offset X/Y by fn(z_normalised) -> (dx, dy).  Lean and sway."""
    mn, mx = bounds(obj)
    h = (mx.z - mn.z) or 1.0
    for v in obj.data.vertices:
        t = (v.co.z - mn.z) / h
        dx, dy = fn(t)
        v.co.x += dx
        v.co.y += dy
    obj.data.update()
    return obj


def cut_plane(obj, point, normal, flatten=1.0):
    """Push verts on the positive side of a plane back onto it.

    Cheap way to fake a conchoidal fracture face on a boulder without
    changing topology.
    """
    p = Vector(point)
    n = Vector(normal).normalized()
    for v in obj.data.vertices:
        d = (v.co - p).dot(n)
        if d > 0.0:
            v.co -= n * (d * flatten)
    obj.data.update()
    return obj


def set_uv_from_quad(obj):
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    layer = me.uv_layers[0]
    corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
    for poly in me.polygons:
        for k, li in enumerate(poly.loop_indices):
            layer.data[li].uv = corners[k % 4]
    return obj
