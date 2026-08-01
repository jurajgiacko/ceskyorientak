"""UV helpers.

Hand-rolled projections rather than `bpy.ops.uv.smart_project`, because the
operator needs an edit-mode UI context that does not exist under
`--background`.  `smart_uv()` still tries the operator first (it gives nicer
packing when it works) and falls back to box projection.

Most assets in this project use tiling detail materials rather than unique
atlases, so a good box/cylinder projection is the right default anyway.
"""

import math

import bpy
from mathutils import Vector

from . import mesh as M

_AXES = (
    (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),   # +X
    (Vector((-1, 0, 0)), Vector((0, -1, 0)), Vector((0, 0, 1))),  # -X
    (Vector((0, 1, 0)), Vector((-1, 0, 0)), Vector((0, 0, 1))),  # +Y
    (Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))),  # -Y
    (Vector((0, 0, 1)), Vector((1, 0, 0)), Vector((0, 1, 0))),   # +Z
    (Vector((0, 0, -1)), Vector((-1, 0, 0)), Vector((0, 1, 0))),  # -Z
)


def ensure_layer(obj, name="UVMap"):
    me = obj.data
    layer = me.uv_layers.get(name)
    if layer is None:
        layer = me.uv_layers.new(name=name)
    me.uv_layers.active = layer
    return layer


def cube_project(obj, scale=1.0, name="UVMap"):
    """Per-face projection onto the dominant world axis.  Seamless for tiling
    detail (granite, bark, canvas) and completely deterministic."""
    me = obj.data
    layer = ensure_layer(obj, name)
    s = 1.0 / (scale or 1.0)
    for poly in me.polygons:
        n = poly.normal
        best = max(range(6), key=lambda i: n.dot(_AXES[i][0]))
        _, uax, vax = _AXES[best]
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            layer.data[li].uv = (co.dot(uax) * s, co.dot(vax) * s)
    return obj


def cylinder_project(obj, scale=1.0, axis="Z", name="UVMap", u_repeat=1.0):
    """Angle -> U, height -> V.  For trunks, poles, tubes."""
    me = obj.data
    layer = ensure_layer(obj, name)
    mn, mx = M.bounds(obj)
    if axis == "Z":
        lo = mn.z
    elif axis == "Y":
        lo = mn.y
    else:
        lo = mn.x
    inv_scale = 1.0 / (scale or 1.0)

    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if axis == "Z":
                a, h = math.atan2(co.y, co.x), co.z
            elif axis == "Y":
                a, h = math.atan2(co.z, co.x), co.y
            else:
                a, h = math.atan2(co.z, co.y), co.x
            u = (a / (2.0 * math.pi) + 0.5) * u_repeat
            # V is world height above the base divided by `scale`, i.e. the
            # texture tiles every `scale` metres along the axis.
            layer.data[li].uv = (u, (h - lo) * inv_scale)
    return obj


def sphere_project(obj, name="UVMap"):
    me = obj.data
    layer = ensure_layer(obj, name)
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            v = co.normalized() if co.length > 1e-9 else Vector((0, 0, 1))
            u = math.atan2(v.y, v.x) / (2.0 * math.pi) + 0.5
            layer.data[li].uv = (u, math.asin(max(-1.0, min(1.0, v.z))) / math.pi + 0.5)
    return obj


def smart_uv(obj, angle_deg=66.0, margin=0.02, fallback_scale=1.0):
    """Try the real unwrapper; fall back to box projection if the operator is
    unavailable in this context.  Returns the method actually used."""
    ensure_layer(obj)
    try:
        M.set_active(obj)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg),
                                 island_margin=margin)
        bpy.ops.object.mode_set(mode="OBJECT")
        return "smart_project"
    except Exception as exc:  # pragma: no cover - context dependent
        try:
            if bpy.context.object and bpy.context.object.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        print("UV: smart_project unavailable (%s); using cube_project" % exc)
        cube_project(obj, fallback_scale)
        return "cube_project"


def set_face_uv_rect(obj, face_indices, rect=(0.0, 0.0, 1.0, 1.0), name="UVMap",
                     flip_v=False):
    """Map the given faces onto a UV rectangle, planar along their own normal.

    This is how the branded surfaces are prepared: the faces get a clean,
    axis-aligned island filling 0..1 so brand artwork can be dropped straight
    on later without touching the mesh.
    """
    me = obj.data
    layer = ensure_layer(obj, name)
    faces = [me.polygons[i] for i in face_indices if 0 <= i < len(me.polygons)]
    if not faces:
        return obj

    n = Vector((0, 0, 0))
    for f in faces:
        n += f.normal
    if n.length < 1e-9:
        n = Vector((0, 1, 0))
    n.normalize()
    up = Vector((0, 0, 1))
    if abs(n.dot(up)) > 0.95:
        up = Vector((0, 1, 0))
    uax = n.cross(up).normalized()
    vax = uax.cross(n).normalized()

    pts = []
    for f in faces:
        for li in f.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            pts.append((co.dot(uax), co.dot(vax)))
    umin = min(p[0] for p in pts)
    umax = max(p[0] for p in pts)
    vmin = min(p[1] for p in pts)
    vmax = max(p[1] for p in pts)
    du = (umax - umin) or 1.0
    dv = (vmax - vmin) or 1.0

    x0, y0, x1, y1 = rect
    for f in faces:
        for li in f.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u = (co.dot(uax) - umin) / du
            v = (co.dot(vax) - vmin) / dv
            if flip_v:
                v = 1.0 - v
            layer.data[li].uv = (x0 + u * (x1 - x0), y0 + v * (y1 - y0))
    return obj
