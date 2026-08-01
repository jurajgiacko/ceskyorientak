"""Headless turntable preview renderer.

Imports an exported .glb back into a clean scene and renders it, so previews
validate the *shipped* file rather than the in-memory scene that produced it.

Layout is this tool's job, not the asset's: each variant (`<asset>_v<N>_LOD<L>`)
is re-centred on its own bounds and placed in its own column, so asset scripts
can — and should — keep every variant at the origin for clean instancing.

  single variant   -> 2x2 grid of four yaw angles
  N variants       -> N columns x 2 yaw angles

    Blender --background --python preview.py -- --glb <file> --out <png> [--lod 0]
"""

import argparse
import math
import os
import re
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import mesh as M  # noqa: E402


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--cell", type=int, default=560, help="pixels per grid cell")
    p.add_argument("--max-width", type=int, default=2000)
    p.add_argument("--lod", type=int, default=0)
    p.add_argument("--samples", type=int, default=48)
    p.add_argument("--engine", default="BLENDER_EEVEE_NEXT")
    p.add_argument("--bg", type=float, default=0.30)
    return p.parse_args(argv)


def world_bg(value):
    world = bpy.data.worlds.new("W")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (value, value * 1.04, value * 1.12, 1.0)
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def three_point():
    """Key / fill / rim -- enough separation to judge silhouette and bevels."""
    specs = [
        ("key", 4.2, (math.radians(52), 0.0, math.radians(38)), (1.0, 0.97, 0.92)),
        ("fill", 1.5, (math.radians(66), 0.0, math.radians(-115)), (0.80, 0.86, 1.0)),
        ("rim", 3.0, (math.radians(105), 0.0, math.radians(196)), (1.0, 0.99, 0.95)),
    ]
    for name, energy, rot, color in specs:
        data = bpy.data.lights.new(name, "SUN")
        data.energy = energy
        data.color = color
        try:
            data.angle = math.radians(12)
        except Exception:
            pass
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        obj.rotation_euler = rot


def world_bounds(objs):
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for o in objs:
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
    return lo, hi


def main():
    args = parse()
    M.reset_scene()
    for w in list(bpy.data.worlds):
        bpy.data.worlds.remove(w)

    bpy.ops.import_scene.gltf(filepath=args.glb)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("preview: no meshes in %s" % args.glb)

    suffix = "_LOD%d" % args.lod
    chosen = [o for o in meshes if o.name.split(".")[0].endswith(suffix)]
    if not chosen:
        lodded = [o for o in meshes if "_LOD" in o.name]
        chosen = [o for o in meshes if o not in lodded] or meshes
        suffix = ""

    for o in meshes:
        if o not in chosen:
            bpy.data.objects.remove(o, do_unlink=True)

    # group by variant: strip the _LOD<n> suffix (and any glTF .001 dedupe tail)
    groups = {}
    for o in chosen:
        base = o.name.split(".")[0]
        key = re.sub(r"_LOD\d+$", "", base)
        groups.setdefault(key, []).append(o)
    keys = sorted(groups)

    # Re-centre each variant on its own bounds (XY centred, base at z=0) so a
    # baked-in layout offset in the asset does not wreck the framing.
    protos = []
    span = 0.0
    for key in keys:
        objs = groups[key]
        lo, hi = world_bounds(objs)
        root = bpy.data.objects.new("proto_" + key, None)
        bpy.context.scene.collection.objects.link(root)
        for o in objs:
            o.parent = root
        # centre on all three axes: the grid cell is centred on the holder, so
        # putting the base at z=0 here would push tall assets out of frame
        root.location = (-(lo.x + hi.x) * 0.5, -(lo.y + hi.y) * 0.5,
                         -(lo.z + hi.z) * 0.5)
        protos.append((key, root, objs, hi - lo))
        span = max(span, (hi - lo).x, (hi - lo).y, (hi - lo).z)

    span = max(span, 1e-3)
    cell = span * 1.22

    if len(protos) == 1:
        angles = [0, 90, 180, 270]
        cols, rows = 2, 2
        slots = [(i % 2, i // 2, angles[i]) for i in range(4)]
    else:
        angles = [0, 90]
        cols, rows = len(protos), 2
        slots = [(c, r, angles[r]) for r in range(rows) for c in range(cols)]

    for (col, row, yaw) in slots:
        key, root, objs, _ = protos[col if len(protos) > 1 else 0]
        holder = bpy.data.objects.new("h_%s_%d_%d" % (key, col, row), None)
        bpy.context.scene.collection.objects.link(holder)

        sub = root.copy()
        bpy.context.scene.collection.objects.link(sub)
        sub.parent = holder
        for o in objs:
            c = o.copy()
            bpy.context.scene.collection.objects.link(c)
            c.parent = sub

        holder.rotation_euler = (0.0, 0.0, math.radians(yaw))
        holder.location = ((col - (cols - 1) * 0.5) * cell,
                           0.0,
                           ((rows - 1) * 0.5 - row) * cell)

    # the originals were only templates
    for _key, root, objs, _ in protos:
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.objects.remove(root, do_unlink=True)

    world_bg(args.bg)
    three_point()

    width = min(args.max_width, args.cell * cols)
    height = int(width * rows / float(cols))

    sc = bpy.context.scene
    sc.render.resolution_x = width
    sc.render.resolution_y = height
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.filepath = args.out
    try:
        sc.render.engine = args.engine
    except Exception:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = args.samples
        sc.cycles.device = "CPU"
    else:
        try:
            sc.eevee.taa_render_samples = args.samples
        except Exception:
            pass

    cam_d = bpy.data.cameras.new("cam")
    cam_d.type = "ORTHO"
    cam_d.ortho_scale = cols * cell
    cam = bpy.data.objects.new("cam", cam_d)
    bpy.context.scene.collection.objects.link(cam)
    sc.camera = cam

    direction = Vector((0.0, 1.0, -0.30)).normalized()
    cam.location = -direction * (span * 10.0 + 20.0)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print("PREVIEW OK %s  (%d variants, %dx%d)" % (args.out, len(protos), width, height))


main()
