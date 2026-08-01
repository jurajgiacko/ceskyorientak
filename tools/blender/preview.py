"""Headless turntable preview renderer.

Imports an exported .glb back into a clean scene and renders four yaw angles
side by side, so previews validate the *shipped* file rather than the
in-memory scene that produced it.

    Blender --background --python preview.py -- --glb <file> --out <png>
"""

import argparse
import math
import os
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
    p.add_argument("--size", type=int, default=1100)
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
        ("key", "SUN", 4.2, (math.radians(52), 0.0, math.radians(38)), (1.0, 0.97, 0.92)),
        ("fill", "SUN", 1.5, (math.radians(66), 0.0, math.radians(-115)), (0.80, 0.86, 1.0)),
        ("rim", "SUN", 3.0, (math.radians(105), 0.0, math.radians(196)), (1.0, 0.99, 0.95)),
    ]
    for name, kind, energy, rot, color in specs:
        data = bpy.data.lights.new(name, kind)
        data.energy = energy
        data.color = color
        try:
            data.angle = math.radians(12)
        except Exception:
            pass
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        obj.rotation_euler = rot


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
        lod_any = [o for o in meshes if "_LOD" in o.name]
        chosen = [o for o in meshes if o not in lod_any] or meshes

    for o in meshes:
        if o not in chosen:
            bpy.data.objects.remove(o, do_unlink=True)

    # world-space bounds of everything we kept
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in chosen:
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
    center = (lo + hi) * 0.5
    size = max((hi - lo).x, (hi - lo).y, (hi - lo).z, 1e-3)

    # one parent empty per yaw angle, arranged 2x2 on screen
    cell = size * 1.30
    root = bpy.data.objects.new("root", None)
    bpy.context.scene.collection.objects.link(root)
    for o in chosen:
        o.parent = root
    root.location = -center

    holder = bpy.data.objects.new("holder", None)
    bpy.context.scene.collection.objects.link(holder)
    root.parent = holder

    grid = [(-0.5, 0.5), (0.5, 0.5), (-0.5, -0.5), (0.5, -0.5)]
    copies = []
    for i, (gx, gz) in enumerate(grid):
        if i == 0:
            dup = holder
        else:
            dup = holder.copy()
            bpy.context.scene.collection.objects.link(dup)
            sub = root.copy()
            bpy.context.scene.collection.objects.link(sub)
            sub.parent = dup
            for o in chosen:
                c = o.copy()
                bpy.context.scene.collection.objects.link(c)
                c.parent = sub
        dup.rotation_euler = (0.0, 0.0, math.radians(90 * i))
        dup.location = (gx * cell * 1.06, 0.0, gz * cell * 1.06)
        copies.append(dup)

    world_bg(args.bg)
    three_point()

    sc = bpy.context.scene
    sc.render.resolution_x = args.size
    sc.render.resolution_y = args.size
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
    cam_d.ortho_scale = cell * 2.16
    cam = bpy.data.objects.new("cam", cam_d)
    bpy.context.scene.collection.objects.link(cam)
    sc.camera = cam

    direction = Vector((0.0, 1.0, -0.30)).normalized()
    cam.location = -direction * (size * 8.0 + 6.0)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print("PREVIEW OK %s" % args.out)


main()
