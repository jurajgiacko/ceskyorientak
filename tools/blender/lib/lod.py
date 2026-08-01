"""LOD generation.

Convention used across the pipeline: every exported asset contains objects
named ``<asset>_LOD0``, ``<asset>_LOD1``, ``<asset>_LOD2`` at the glTF root.
The runtime picks one per instance (e.g. into a THREE.LOD).  build.mjs reads
the same suffix to fill in the manifest.
"""

import bpy

from . import mesh as M


def _dup(obj, name):
    new = obj.copy()
    new.data = obj.data.copy()
    new.name = name
    new.data.name = name + "_mesh"
    M.link(new)
    return new


def decimate_lods(obj, name, ratios=(1.0, 0.4, 0.12), smooth_angle=None):
    """LOD0 = obj (triangulated); lower levels are collapse-decimated copies.

    Ratios are relative to the LOD0 triangle count, so the numbers in the
    manifest line up with the budget in the README.
    """
    M.triangulate(obj)
    out = []
    for level, ratio in enumerate(ratios):
        lname = "%s_LOD%d" % (name, level)
        if level == 0:
            o = obj
            o.name = lname
            o.data.name = lname + "_mesh"
        else:
            o = _dup(obj, lname)
            M.decimate(o, ratio)
            M.triangulate(o)
            if smooth_angle is not None:
                M.shade_smooth(o, smooth_angle)
        out.append(o)
    return out


def assemble_lods(name, objects):
    """Rename an explicit per-level list (used when a lower LOD is rebuilt
    from scratch rather than decimated -- trees, mainly)."""
    out = []
    for level, o in enumerate(objects):
        if o is None:
            continue
        lname = "%s_LOD%d" % (name, level)
        o.name = lname
        o.data.name = lname + "_mesh"
        M.triangulate(o)
        out.append(o)
    return out


def crossed_billboard(name, material, width, height, z_offset=0.0, planes=2,
                      v_bottom=0.0):
    """Crossed-quad imposter: `planes` vertical quads rotated evenly about Z.

    Two planes = 4 triangles, the cheapest silhouette that still reads as a
    tree from any horizontal angle.
    """
    import math

    hw = width * 0.5
    verts = []
    faces = []
    uvs = []
    for p in range(planes):
        a = math.pi * p / planes
        dx, dy = math.cos(a) * hw, math.sin(a) * hw
        base = len(verts)
        verts += [
            (-dx, -dy, z_offset),
            (dx, dy, z_offset),
            (dx, dy, z_offset + height),
            (-dx, -dy, z_offset + height),
        ]
        uvs += [(0.0, v_bottom), (1.0, v_bottom), (1.0, 1.0), (0.0, 1.0)]
        faces.append((base, base + 1, base + 2, base + 3))

    obj = M.from_pydata(name, verts, faces)
    me = obj.data
    layer = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        layer.data[loop.index].uv = uvs[loop.vertex_index]
    if material is not None:
        obj.data.materials.append(material)
    M.shade_flat(obj)
    return obj


def total_tris(objs):
    return sum(M.tri_count(o) for o in objs)


def report(objs):
    """Print the per-LOD counts that build.mjs scrapes into the manifest."""
    lines = []
    for o in objs:
        lines.append("%s=%d" % (o.name, M.tri_count(o)))
    print("LODREPORT " + " ".join(lines))
    return lines
