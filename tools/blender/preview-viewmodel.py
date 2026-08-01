"""Render a first-person viewmodel .glb from the *actual game camera*.

`preview.py`'s turntable is the wrong instrument for a viewmodel: a viewmodel
is only ever seen from one place, and whether it works is entirely a question
of what that one camera sees.  So this puts a camera at the origin -- which for
a viewmodel asset *is* the eye -- with the game's 46 deg vertical FOV and a
0.15 m near plane, looking down glTF -Z, and renders one frame per clip.

It also prints, per clip, the deformed bounding box in glTF axes and the
screen-space projection of each hand bone, so "the hand is off the bottom of
the frame" is a number rather than a squint.

    Blender --background --factory-startup --python preview-viewmodel.py -- \\
        <glb> <outdir> [clip:frame ...]

Defaults to idle:0 jog:13 run:10 read:30 (mid-cycle for the two gait clips).
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, OUTDIR = argv[0], argv[1]
SHOTS = argv[2:] or ["idle:0", "jog:13", "run:10", "read:30"]

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for w in list(bpy.data.worlds):
    bpy.data.worlds.remove(w)

# fps must be set BEFORE import: the importer lays keyframes out at
# time*fps, so a 24 fps scene silently resamples the whole clip.
bpy.context.scene.render.fps = 30
bpy.ops.import_scene.gltf(filepath=GLB)

meshes = [o for o in bpy.context.scene.objects
          if o.type == "MESH" and "LOD" in o.name]
arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
print("MESHES", [o.name for o in meshes])
print("ARMATURES", [o.name for o in arms])
print("ACTIONS", [a.name for a in bpy.data.actions])

lo = Vector((1e9,) * 3)
hi = Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        p = o.matrix_world @ Vector(c)
        lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
        hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
print("BLENDER BBOX min=%s max=%s" % (tuple(round(v, 3) for v in lo),
                                      tuple(round(v, 3) for v in hi)))

# world
world = bpy.data.worlds.new("W")
bpy.context.scene.world = world
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputWorld")
bg = nt.nodes.new("ShaderNodeBackground")
bg.inputs["Color"].default_value = (0.10, 0.16, 0.10, 1.0)
bg.inputs["Strength"].default_value = 1.0
nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

for name, energy, rot, col in [
    ("key", 2.4, (math.radians(58), 0.0, math.radians(200)), (1.0, 0.97, 0.92)),
    ("fill", 0.9, (math.radians(70), 0.0, math.radians(60)), (0.80, 0.86, 1.0)),
    ("rim", 0.9, (math.radians(120), 0.0, math.radians(10)), (1.0, 0.99, 0.95)),
]:
    d = bpy.data.lights.new(name, "SUN")
    d.energy = energy
    d.color = col
    d.angle = math.radians(28)
    ob = bpy.data.objects.new(name, d)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = rot

cd = bpy.data.cameras.new("cam")
cd.sensor_fit = "VERTICAL"
cd.angle_y = math.radians(46.0)
cd.clip_start = 0.15
cam = bpy.data.objects.new("cam", cd)
bpy.context.scene.collection.objects.link(cam)
cam.location = (0.0, 0.0, 0.0)
cam.rotation_euler = (math.radians(90.0), 0.0, 0.0)   # look along Blender +Y

sc = bpy.context.scene
sc.camera = cam
sc.render.resolution_x = 1280
sc.render.resolution_y = 800
sc.render.image_settings.file_format = "PNG"
sc.render.engine = "BLENDER_EEVEE_NEXT"
try:
    sc.eevee.taa_render_samples = 48
except Exception:
    pass
sc.view_settings.view_transform = "AgX"

os.makedirs(OUTDIR, exist_ok=True)


def find_action(clip):
    exact = [a for a in bpy.data.actions if a.name == clip]
    if exact:
        return exact[0]
    part = [a for a in bpy.data.actions if clip in a.name]
    return part[0] if part else None


for shot in SHOTS:
    clip, _, fr = shot.partition(":")
    frame = int(fr or 0)
    act = find_action(clip)
    for a in arms:
        if a.animation_data is None:
            a.animation_data_create()
        for tr in list(a.animation_data.nla_tracks):
            tr.mute = True
        a.animation_data.action = act
    sc.frame_set(frame)
    bpy.context.view_layer.update()

    # deformed bbox for this pose, reported in glTF axes (x, y=up, z=back)
    dg = bpy.context.evaluated_depsgraph_get()
    glo = [1e9] * 3
    ghi = [-1e9] * 3
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        for v in me.vertices:
            p = ev.matrix_world @ v.co
            g = (p.x, p.z, -p.y)
            for i in range(3):
                glo[i] = min(glo[i], g[i])
                ghi[i] = max(ghi[i], g[i])
        ev.to_mesh_clear()
    for a in arms:
        ae = a.evaluated_get(dg)
        for bn in ("hand.R", "hand.L", "forearm.R", "forearm.L", "thumb.L"):
            pb = ae.pose.bones.get(bn)
            if pb is None:
                continue
            p = ae.matrix_world @ pb.head
            gx, gy, gz = p.x, p.z, -p.y
            if gz >= -1e-4:
                print("   PROJ %-10s BEHIND CAMERA z=%.3f" % (bn, gz))
                continue
            nx = (gx / -gz) / 0.679
            ny = (gy / -gz) / 0.4245
            print("   PROJ %-10s gltf=[%6.3f %6.3f %6.3f] px=(%5d,%5d)%s"
                  % (bn, gx, gy, gz, 640 * (1 + nx), 400 * (1 - ny),
                     "" if abs(nx) <= 1 and abs(ny) <= 1 else "  OFFSCREEN"))
    print("GLTFBBOX %s min=[%s] max=[%s]"
          % (clip, ", ".join("%.3f" % v for v in glo),
             ", ".join("%.3f" % v for v in ghi)))

    sc.render.filepath = os.path.join(OUTDIR, "vm_%s.png" % clip)
    bpy.ops.render.render(write_still=True)
    print("SHOT %s frame=%d action=%s -> %s"
          % (clip, frame, act.name if act else "NONE", sc.render.filepath))
