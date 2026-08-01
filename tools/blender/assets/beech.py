"""beech -- European beech (Fagus sylvatica), three variants x three LODs.

The whole point of this asset is that it must not read as a conifer.  Beech
silhouette rules, in order of how much they matter at 100 m:

  1. The crown is a broad, rounded DOME -- as wide as the tree is tall, or
     wider.  Foliage lives in a shell on the outside of that dome; the inside
     is comparatively bare.
  2. A single stout bole divides fairly low into 3-5 big ascending limbs that
     arch over outward.  That arch is what turns a "lollipop" into a beech.
  3. The bark is smooth and pale silver-grey, not the dark fissured red-brown
     of spruce.

Construction: a recursive tube-branching routine grows the woody skeleton
inside an ellipsoidal crown envelope, and every terminal tip gets a clump of
alpha-mapped leaf cards.  A further third of the cards is sprinkled directly
onto the envelope shell so the dome outline stays clean where branch tips
happen to fall short.

Card orientation is the subtle part.  Cards whose normals all point straight
out from the crown centre make the crown vanish at its own silhouette (you see
them edge-on there), and cards that are all coplanar make it read as cardboard.
So each normal is `normalize(outward * BIAS + random_unit)`: outward enough
that the crown shades like one big volume, random enough that there is always
foliage catching light at the rim.

Origin: base of the trunk, on the ground, +Z up.  All three variants sit on
the origin -- no baked-in X spacing, so the runtime can instance any of them
straight onto a terrain sample.  preview.py lays the variants out itself.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, scatter, tex  # noqa: E402

NAME = "beech"
TAU = math.pi * 2.0

ATLAS_CELLS = 2
IMPOSTER_CELL = 512          # px per variant in the imposter atlas
IMPOSTER_ATLAS = 1024        # 2x2 cells, one spare

# LOD0 triangle budget is 11000 for the whole file; keep a margin so a tweak
# to one variant cannot silently fail validate.mjs.
BUDGET_LOD0 = (1400, 4300, 4400)
BUDGET_LOD1 = (700, 1200, 1250)

# How much of a leaf card's normal comes from "straight out of the crown".
# 0 = fully random (flat, muddy shading), 1 = fully radial (crown disappears
# at its own silhouette).
NORMAL_BIAS = 0.5

VARIANTS = [
    {   # young sapling: slender, still taller than wide, narrow crown
        "key": "v0",
        "height": 7.2,
        "clear": 2.0,          # bole height before the first limbs
        "base_r": 0.075,
        "lean": 0.045,
        "limbs": 3,
        "depth": 1,
        "crown_c": (0.0, 0.0, 4.7),
        "crown_r": (1.85, 1.65, 2.55),
        "card": 0.46,
        "card_lod1": 0.92,
        "shell_frac": 0.34,
    },
    {   # mature: clean bole then the classic wide dome
        "key": "v1",
        "height": 30.0,
        "clear": 8.2,
        "base_r": 0.58,
        "lean": 0.030,
        "limbs": 4,
        "depth": 2,
        "crown_c": (0.0, 0.0, 19.0),
        "crown_r": (12.0, 11.2, 11.1),
        "card": 2.30,
        "card_lod1": 4.5,
        "shell_frac": 0.36,
    },
    {   # old: massive bole, heavy low limbs, lopsided crown
        "key": "v2",
        "height": 34.5,
        "clear": 5.0,
        "base_r": 1.02,
        "lean": 0.055,
        "limbs": 5,
        "depth": 2,
        "crown_c": (1.5, -0.9, 20.4),
        "crown_r": (15.4, 13.6, 14.2),
        "card": 2.70,
        "card_lod1": 5.2,
        "shell_frac": 0.40,
    },
]

# Per-generation growth rules.  level 0 = primary limb off the bole.
#
# `arch_out` / `arch_down` are the whole silhouette.  A primary limb has to
# ASCEND first and only lean outward near its end -- crank arch_down up on
# level 0 and the tree instantly becomes an umbrella, which is what a beech is
# not.  The droop is inherited downward: outer twigs are the parts that hang.
GROWTH = {
    "sides":     (6, 5, 4, 4),
    "pts":       (6, 4, 3, 3),
    "sides_l1":  (4, 4, 4, 4),
    "pts_l1":    (3, 2, 2, 2),
    "forks":     ((2, 3), (2, 3), (2, 2), (2, 2)),
    "arch_out":  (0.55, 0.78, 0.90, 0.85),
    "arch_down": (0.02, 0.26, 0.62, 0.70),
    "fork_ang":  ((0.30, 0.58), (0.36, 0.70), (0.42, 0.80), (0.42, 0.8)),
    "up_bias":   (0.34, 0.20, 0.05, 0.0),
    "len_frac":  (0.64, 0.62, 0.58, 0.55),
    "wander":    0.09,
}


# ---------------------------------------------------------------------------
# local helpers (lib/ is owned by other agents -- nothing here touches it)
# ---------------------------------------------------------------------------

def card_basis(normal, roll=0.0):
    """Basis whose +Y is the card's face normal and +Z its height axis.

    `scatter.card` builds its quad in the local XZ plane, so mapping local Y
    onto the wanted normal is what actually orients a leaf spray.  `roll`
    spins the spray inside its own plane.
    """
    n = Vector(normal)
    if n.length < 1e-9:
        n = Vector((0.0, 1.0, 0.0))
    n.normalize()
    ref = Vector((0.0, 0.0, 1.0))
    if abs(n.dot(ref)) > 0.94:
        ref = Vector((1.0, 0.0, 0.0))
    x = ref.cross(n).normalized()
    z = n.cross(x).normalized()
    if roll:
        ca, sa = math.cos(roll), math.sin(roll)
        x, z = (x * ca + z * sa).normalized(), (z * ca - x * sa).normalized()
    return Matrix((x, n, z)).transposed().to_4x4()


def merge(name, sources):
    """Merge (object, material) pairs into one multi-material mesh.

    `lib.mesh.join` rebuilds the incoming faces with `bmesh.faces.new`, which
    allocates fresh loops and therefore drops every loop data layer -- UVs
    included.  For untextured props that is invisible; here it would collapse
    all 1600 leaf cards onto UV (0, 0), an empty corner of the atlas, and the
    foliage would vanish.  So the merge is done by hand, carrying per-loop UVs
    across explicitly.  (Reported upstream; lib/ is not mine to edit.)
    """
    verts, faces, loop_uvs, face_mat = [], [], [], []
    mats = []
    for obj, material in sources:
        if obj is None:
            continue
        if material not in mats:
            mats.append(material)
        mi = mats.index(material)
        me = obj.data
        layer = me.uv_layers[0] if me.uv_layers else None
        base = len(verts)
        for v in me.vertices:
            verts.append(tuple(v.co))
        for poly in me.polygons:
            f = []
            for li in poly.loop_indices:
                f.append(base + me.loops[li].vertex_index)
                loop_uvs.append(tuple(layer.data[li].uv) if layer else (0.0, 0.0))
            faces.append(tuple(f))
            face_mat.append(mi)

    obj = M.from_pydata(name, verts, faces)
    me = obj.data
    if len(me.polygons) != len(faces):
        raise RuntimeError("merge lost faces: %d -> %d" % (len(faces),
                                                           len(me.polygons)))
    for m in mats:
        me.materials.append(m)
    for i, poly in enumerate(me.polygons):
        poly.material_index = face_mat[i]
    layer = me.uv_layers.new(name="UVMap")
    for i in range(len(me.loops)):
        layer.data[i].uv = loop_uvs[i]
    for src, _m in sources:
        if src is not None:
            M.remove(src)
    return obj


def build_cards(name, specs):
    """One mesh holding every leaf card: 4 verts / 1 quad / 2 tris each.

    Built in a single `from_pydata` rather than N objects joined afterwards --
    the joins dominate the runtime once there are a thousand cards, and doing
    it here means the atlas UV rect can be written straight into the loop.
    """
    verts, faces, uvs = [], [], []
    for mtx, w, h, rect, flip in specs:
        hw, hh = w * 0.5, h * 0.5
        base = len(verts)
        for lv in ((-hw, 0.0, -hh), (hw, 0.0, -hh), (hw, 0.0, hh), (-hw, 0.0, hh)):
            verts.append(tuple(mtx @ Vector(lv)))
        x0, y0, x1, y1 = rect
        if flip:
            x0, x1 = x1, x0
        uvs += [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        faces.append((base, base + 1, base + 2, base + 3))

    obj = M.from_pydata(name, verts, faces)
    me = obj.data
    layer = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        layer.data[loop.index].uv = uvs[loop.vertex_index]
    M.shade_flat(obj)
    return obj


def envelope(cfg):
    c = Vector(cfg["crown_c"])
    r = Vector(cfg["crown_r"])
    return c, r


def env_value(p, c, r):
    """<1 inside the crown ellipsoid, 1 on its surface, >1 outside."""
    d = Vector(p) - c
    return math.sqrt((d.x / r.x) ** 2 + (d.y / r.y) ** 2 + (d.z / r.z) ** 2)


def perp_axis(d, roll):
    ref = Vector((0.0, 0.0, 1.0)) if abs(d.z) < 0.9 else Vector((1.0, 0.0, 0.0))
    x = ref.cross(d).normalized()
    y = d.cross(x).normalized()
    return (x * math.cos(roll) + y * math.sin(roll)).normalized()


# ---------------------------------------------------------------------------
# woody skeleton
# ---------------------------------------------------------------------------

def trunk_curve(cfg, rng, n=7):
    """Bole from the ground to the first fork: gentle lean, root flare."""
    h = cfg["clear"]
    lean = cfg["lean"]
    a0 = rng.uniform(0.0, TAU)
    pts, radii = [], []
    for i in range(n):
        t = i / (n - 1.0)
        x = math.cos(a0) * lean * h * (t ** 1.6) + math.sin(t * 2.4 + a0) * 0.020 * h
        y = math.sin(a0) * lean * h * (t ** 1.6) + math.cos(t * 1.8 + a0) * 0.020 * h
        # root flare dies away over the first ~15% of the bole
        flare = 1.0 + 0.62 * math.exp(-t * 9.0)
        r = cfg["base_r"] * flare * (1.0 - 0.50 * t)
        pts.append(Vector((x, y, t * h)))
        radii.append(r)
    return pts, radii


def sample_curve(pts, radii, t):
    """Position + radius at parameter t along a polyline (t in [0, 1])."""
    if t <= 0.0:
        return pts[0].copy(), radii[0]
    if t >= 1.0:
        return pts[-1].copy(), radii[-1]
    f = t * (len(pts) - 1)
    i = int(f)
    a = f - i
    return pts[i].lerp(pts[i + 1], a), radii[i] * (1.0 - a) + radii[i + 1] * a


def grow(tubes, tips, start, direction, length, radius, level, cfg, rng,
         quality, name):
    """Recursive limb.  Each generation arches further over and thins."""
    depth = cfg["depth"] if quality == 0 else max(0, cfg["depth"] - 1)
    sides = (GROWTH["sides"] if quality == 0 else GROWTH["sides_l1"])[min(level, 3)]
    npts = (GROWTH["pts"] if quality == 0 else GROWTH["pts_l1"])[min(level, 3)]
    arch_out = GROWTH["arch_out"][min(level, 3)]
    arch_down = GROWTH["arch_down"][min(level, 3)]

    c, r = envelope(cfg)
    d = Vector(direction).normalized()
    p = Vector(start)
    pts, radii = [p.copy()], [radius]
    step = 1.0 / (npts - 1.0)

    for i in range(1, npts):
        t = i * step
        horiz = Vector((d.x, d.y, 0.0))
        if horiz.length < 1e-6:
            a = rng.uniform(0.0, TAU)
            horiz = Vector((math.cos(a), math.sin(a), 0.0))
        horiz.normalize()
        pull = horiz * arch_out - Vector((0.0, 0.0, arch_down))
        d = (d + pull * step).normalized()
        d = (d + Vector(rng.offset3(GROWTH["wander"]))).normalized()
        p = p + d * (length * step)
        pts.append(p.copy())
        # taper hard: a beech limb loses most of its girth over its own length
        radii.append(max(0.008, radius * (1.0 - 0.72 * t)))

    tubes.append(M.tube("%s_br%d_%d" % (name, level, len(tubes)), pts, radii,
                        sides=sides, caps=(level == 0 and quality == 0)))

    if level >= depth:
        tips.append((p.copy(), d.copy(), radius))
        return

    lo, hi = GROWTH["fork_ang"][min(level, 3)]
    up = GROWTH["up_bias"][min(level, 3)]
    lf = GROWTH["len_frac"][min(level, 3)]
    nfork = rng.randint(*GROWTH["forks"][min(level, 3)])
    roll0 = rng.uniform(0.0, TAU)

    for k in range(nfork):
        roll = roll0 + TAU * k / nfork + rng.uniform(-0.4, 0.4)
        axis = perp_axis(d, roll)
        ang = rng.uniform(lo, hi)
        cd = (Matrix.Rotation(ang, 4, axis) @ d).normalized()
        cd = (cd + Vector((0.0, 0.0, up))).normalized()
        clen = length * lf * rng.uniform(0.82, 1.18)
        # keep the crown inside its envelope: shorten anything that would
        # punch through the dome
        ev = env_value(p + cd * clen, c, r)
        if ev > 1.0:
            clen *= max(0.28, 1.0 / (ev * 1.06))
        crad = radius * rng.uniform(0.52, 0.70)
        grow(tubes, tips, p, cd, clen, crad, level + 1, cfg,
             rng.sub("f%d_%d" % (level, k)), quality, name)


def build_skeleton(cfg, rng, quality, name):
    """Bole + every limb generation.  Returns (objects, terminal tips)."""
    tpts, tradii = trunk_curve(cfg, rng.sub("trunk"),
                               n=7 if quality == 0 else 4)
    tubes = [M.tube("%s_bole" % name, tpts, tradii,
                    sides=8 if quality == 0 else 5, caps=True)]
    tips = []

    c, r = envelope(cfg)
    nlimb = cfg["limbs"] if quality == 0 else max(3, cfg["limbs"] - 1)
    phases = scatter.golden_ring(nlimb, phase=rng.uniform(0.0, TAU))
    lrng = rng.sub("limbs")

    for k, az in enumerate(phases):
        # primaries leave the top fifth of the bole, lowest one first
        t = 0.80 + 0.20 * (k / max(1.0, nlimb - 1.0)) + lrng.uniform(-0.03, 0.03)
        base, brad = sample_curve(tpts, tradii, min(1.0, t))
        tilt = lrng.uniform(math.radians(30.0), math.radians(52.0))
        d = Vector((math.cos(az) * math.sin(tilt), math.sin(az) * math.sin(tilt),
                    math.cos(tilt)))
        # aim roughly at the far shell of the dome so limbs actually fill it
        target = c + Vector((math.cos(az) * r.x, math.sin(az) * r.y,
                             r.z * lrng.uniform(-0.05, 0.35)))
        reach = (target - base).length
        length = reach * lrng.uniform(0.52, 0.68)
        grow(tubes, tips, base, d, length, brad * lrng.uniform(0.55, 0.70),
             0, cfg, lrng.sub("l%d" % k), quality, name)

    return tubes, tips


# ---------------------------------------------------------------------------
# foliage
# ---------------------------------------------------------------------------

def foliage_specs(cfg, tips, rng, n_cards, card_w, quality):
    """Placement matrices for every leaf card of one variant/LOD."""
    c, r = envelope(cfg)
    specs = []
    if n_cards <= 0 or not tips:
        return specs

    shell_n = int(n_cards * cfg["shell_frac"])
    tip_n = n_cards - shell_n
    aspect = 0.82

    def emit(pos, rng_l):
        outward = pos - c
        outward = Vector((outward.x / r.x, outward.y / r.y, outward.z / r.z))
        if outward.length < 1e-6:
            outward = Vector((0.0, 0.0, 1.0))
        outward.normalize()
        n = (outward * NORMAL_BIAS + Vector(rng_l.unit3())).normalized()
        roll = rng_l.uniform(-1.15, 1.15)
        mtx = Matrix.Translation(pos) @ card_basis(n, roll)
        w = card_w * rng_l.uniform(0.80, 1.24)
        h = w * aspect * rng_l.uniform(0.86, 1.18)
        cell = rng_l.randint(0, ATLAS_CELLS * ATLAS_CELLS - 1)
        specs.append((mtx, w, h, tex.atlas_uv_rect(cell, cells=ATLAS_CELLS),
                      rng_l.chance(0.5)))

    # -- clumps hanging off the terminal twigs -----------------------------
    trng = rng.sub("tips")
    per = max(1, int(round(tip_n / float(len(tips)))))
    spread = card_w * (1.35 if quality == 0 else 1.05)
    for ti, (tp, td, _rad) in enumerate(tips):
        sub = trng.sub("t%d" % ti)
        for _ in range(per):
            if len(specs) >= tip_n:
                break
            off = Vector(sub.unit3()) * (spread * (sub.uniform(0.0, 1.0) ** 0.55))
            pos = tp + td * (card_w * sub.uniform(0.0, 0.9)) + off
            # a clump may not float outside the dome
            ev = env_value(pos, c, r)
            if ev > 1.06:
                pos = c + (pos - c) * (1.03 / ev)
            emit(pos, sub)

    # -- shell fill: keeps the dome outline honest -------------------------
    srng = rng.sub("shell")
    guard = 0
    while len(specs) < n_cards and guard < max(64, n_cards * 60):
        guard += 1
        u = Vector(srng.unit3())
        # squash the bottom of the sphere: a beech crown is domed, and the
        # underside carries far fewer leaves than the top and flanks
        if u.z < -0.30:
            u.z = -0.30 + (u.z + 0.30) * 0.35
            u.normalize()
        rad = srng.uniform(0.74, 1.02)
        pos = c + Vector((u.x * r.x, u.y * r.y, u.z * r.z)) * rad
        if pos.z < cfg["clear"] * 0.55:
            continue
        emit(pos, srng)

    return specs[:n_cards]


# ---------------------------------------------------------------------------
# variant assembly
# ---------------------------------------------------------------------------

def build_variant(cfg, rng, quality, bark, foliage_mat, budget):
    """quality 0 -> LOD0, 1 -> LOD1 (rebuilt, never decimated)."""
    key = "%s_%s_q%d" % (NAME, cfg["key"], quality)
    tubes, tips = build_skeleton(cfg, rng.sub("wood%d" % quality), quality, key)
    wood = merge(key + "_wood", [(t, bark) for t in tubes])
    wood_tris = M.tri_count(wood)

    n_cards = max(0, (budget - wood_tris) // 2)
    card_w = cfg["card"] if quality == 0 else cfg["card_lod1"]
    specs = foliage_specs(cfg, tips, rng.sub("fol%d" % quality), n_cards,
                          card_w, quality)
    leaves = build_cards(key + "_leaves", specs)

    obj = merge(key, [(wood, bark), (leaves, foliage_mat)])
    # Isolated card quads have only boundary edges, so they stay flat; the
    # tube walls are the only thing this actually smooths.
    M.shade_smooth(obj, 46.0)
    print("  %s q%d: wood=%d leaves=%d total=%d (budget %d)"
          % (cfg["key"], quality, wood_tris, len(specs), M.tri_count(obj),
             budget))
    return obj


# ---------------------------------------------------------------------------
# imposter: render LOD0 orthographically, then pack into a 2x2 atlas
# ---------------------------------------------------------------------------

def setup_render_env():
    world = bpy.data.worlds.new("beech_imp_world")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.56, 0.62, 0.72, 1.0)
    bg.inputs["Strength"].default_value = 1.05
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    temps = []
    for lname, energy, rot, col in (
        ("imp_key", 2.6, (math.radians(56.0), 0.0, math.radians(26.0)),
         (1.0, 0.97, 0.91)),
        ("imp_fill", 1.1, (math.radians(74.0), 0.0, math.radians(-124.0)),
         (0.80, 0.87, 1.0)),
    ):
        data = bpy.data.lights.new(lname, "SUN")
        data.energy = energy
        data.color = col
        try:
            data.angle = math.radians(24.0)
        except Exception:
            pass
        o = bpy.data.objects.new(lname, data)
        bpy.context.scene.collection.objects.link(o)
        o.rotation_euler = rot
        temps.append(o)

    cam_d = bpy.data.cameras.new("imp_cam")
    cam_d.type = "ORTHO"
    cam = bpy.data.objects.new("imp_cam", cam_d)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    temps.append(cam)
    return cam, temps


def render_imposter(cam, obj, others, path, engine="BLENDER_EEVEE_NEXT",
                    samples=96):
    """Front ortho render of one LOD0 with a transparent film.

    Returns (frame_size, z_bottom) describing the square the camera framed, so
    the billboard quad can be built to exactly the same footprint.
    """
    for o in others:
        o.hide_render = (o is not obj)

    mn, mx = M.bounds(obj)
    span_x, span_z = mx.x - mn.x, mx.z - mn.z
    frame = max(span_x, span_z, 0.5) * 1.035
    cx = (mn.x + mx.x) * 0.5
    cz = (mn.z + mx.z) * 0.5
    centre = Vector((cx, (mn.y + mx.y) * 0.5, cz)) + obj.location

    direction = Vector((0.0, 1.0, 0.0))
    cam.data.ortho_scale = frame
    cam.location = centre - direction * (frame * 3.0 + 60.0)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    sc = bpy.context.scene
    sc.render.resolution_x = IMPOSTER_CELL
    sc.render.resolution_y = IMPOSTER_CELL
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.filepath = path
    try:
        sc.render.engine = engine
    except Exception:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = samples
        sc.cycles.device = "CPU"
    else:
        try:
            sc.eevee.taa_render_samples = samples
        except Exception:
            pass

    bpy.ops.render.render(write_still=True)
    for o in others:
        o.hide_render = False
    return frame, cz - frame * 0.5


def read_rgba(path):
    """Raw (un-managed) RGBA of a PNG as a bottom-up float array."""
    img = bpy.data.images.load(path)
    try:
        img.colorspace_settings.name = "Non-Color"
    except Exception:
        pass
    img.alpha_mode = "CHANNEL_PACKED"
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    arr = buf.reshape(h, w, 4).copy()
    bpy.data.images.remove(img)
    return arr


def pack_imposter_atlas(cell_paths, out_path):
    atlas = np.zeros((IMPOSTER_ATLAS, IMPOSTER_ATLAS, 4), np.float32)
    n = IMPOSTER_ATLAS // IMPOSTER_CELL
    for i, p in enumerate(cell_paths):
        arr = read_rgba(p)
        if arr.shape[0] != IMPOSTER_CELL or arr.shape[1] != IMPOSTER_CELL:
            raise RuntimeError("imposter cell %s is %s" % (p, arr.shape))
        ix, iy = i % n, (i // n) % n
        atlas[iy * IMPOSTER_CELL:(iy + 1) * IMPOSTER_CELL,
              ix * IMPOSTER_CELL:(ix + 1) * IMPOSTER_CELL] = arr
    u8 = (np.clip(atlas, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    return tex.write_png(out_path, u8)


def remap_uv_rect(obj, rect):
    """Squeeze a 0..1 UV layout into an atlas cell."""
    x0, y0, x1, y1 = rect
    layer = obj.data.uv_layers[0]
    for d in layer.data:
        u, v = d.uv
        d.uv = (x0 + u * (x1 - x0), y0 + v * (y1 - y0))
    return obj


# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": True})
    rng = cli.setup(args.seed, NAME)

    atlas_path = tex.build_atlas(cli.cache_path(args, "beech_leaves.png"),
                                 rng.sub("atlas"), tex.beech_cluster,
                                 size=1024, cells=ATLAS_CELLS)
    leaf_img = tex.load_image(atlas_path, name="beech_leaves")
    foliage_mat = mat.image_material("beech_leaves", leaf_img, alpha_mode="CLIP",
                                     backface_culling=False, roughness=0.80)
    bark = mat.principled("beech_bark", mat.BARK_BEECH, roughness=0.70,
                          specular=0.32)
    # EEVEE Next drives alpha off surface_render_method, not blend_method, so
    # the imposter render below would come out as opaque grey rectangles
    # without this.  glTF export still reads blend_method (set by mat.py).
    for m in (foliage_mat, bark):
        try:
            m.surface_render_method = "DITHERED"
        except Exception:
            pass

    lod0s, lod1s = [], []
    for i, cfg in enumerate(VARIANTS):
        vrng = rng.sub(cfg["key"])
        lod0s.append(build_variant(cfg, vrng, 0, bark, foliage_mat,
                                   BUDGET_LOD0[i]))
        lod1s.append(build_variant(cfg, vrng, 1, bark, foliage_mat,
                                   BUDGET_LOD1[i]))

    # -- imposters -----------------------------------------------------
    cam, temps = setup_render_env()
    everything = lod0s + lod1s
    frames = []
    cells = []
    for i, obj in enumerate(lod0s):
        p = cli.cache_path(args, "beech_imposter_%d.png" % i)
        frames.append(render_imposter(cam, obj, everything, p))
        cells.append(p)
    imposter_path = pack_imposter_atlas(cells,
                                        cli.cache_path(args, "beech_imposter.png"))
    for o in temps:
        M.remove(o)
    bpy.context.scene.camera = None

    imp_img = tex.load_image(imposter_path, name="beech_imposter")
    imp_mat = mat.image_material("beech_imposter", imp_img, alpha_mode="CLIP",
                                 backface_culling=False, roughness=0.88)

    lod2s = []
    for i, cfg in enumerate(VARIANTS):
        frame, z0 = frames[i]
        bb = lod.crossed_billboard("%s_%s_imp" % (NAME, cfg["key"]), imp_mat,
                                   width=frame, height=frame, z_offset=z0,
                                   planes=2)
        remap_uv_rect(bb, tex.atlas_uv_rect(i, cells=IMPOSTER_ATLAS // IMPOSTER_CELL,
                                            inset=0.0))
        lod2s.append(bb)

    all_lods = []
    for i, cfg in enumerate(VARIANTS):
        all_lods += lod.assemble_lods("%s_%s" % (NAME, cfg["key"]),
                                      [lod0s[i], lod1s[i], lod2s[i]])
    lod.report(all_lods)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(all_lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, all_lods, extra={
        "variants": len(VARIANTS),
        "variantNames": [v["key"] for v in VARIANTS],
        "originNote": "base of trunk on the ground, centred in XY, +Z up",
        "notes": "LOD2 is a rendered crossed-quad imposter (2 planes, "
                 "shared 2x2 atlas)",
    })


main()
