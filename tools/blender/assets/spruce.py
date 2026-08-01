"""spruce -- Norway spruce (Picea abies), the dominant Sumava tree.

Three variants in one .glb: v0 young (~6 m, foliage to the ground), v1 mature
(~28 m, clean lower trunk), v2 old (~32 m, sparse irregular crown with dead
bare lower branches).

The silhouette is what has to read at distance, so the construction follows the
botany rather than a generic "cone of blobs":

  * a single straight leader runs the full height and the crown tapers to a
    point -- no rounded top;
  * branches sit in WHORLS, one ring per simulated year, and each whorl is
    rotated by a golden angle against the previous one so the rings do not line
    up into visible columns;
  * every branch leaves the trunk sweeping up, then falls away: the tip z is
    ``L * (sin(rise) * s - droop * s**2.6)``.  ``rise`` grows and ``droop``
    shrinks towards the top of the crown, which is what produces the drooping
    lower / upswept upper habit that identifies Norway spruce.

Foliage is needle-spray cards cut from a 2x2 procedural atlas.  Cards at one
station on a branch are rolled about the branch axis (and splayed off it), so
no two are coplanar and the crown holds up as a volume from any yaw.  After the
LODs are assembled the card loops get custom split normals pointing out of the
trunk axis on a cone -- flat quads otherwise shade as a scatter of bright and
black rectangles instead of one lit mass.

LOD1 is REBUILT (fewer whorls, fewer + larger cards, 4-sided trunk), not
decimated; decimation would collapse the cards.  LOD2 is a crossed-quad
imposter whose texture is an orthographic render of that variant's own LOD0,
made in-process before export.

Units metres, Z-up, origin at the base of the trunk on the ground.  Every
variant is built on that origin so the runtime can instance any of them
anywhere without first subtracting a centroid.
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from lib import cli, exporter, lod, mat, mesh as M, scatter, tex  # noqa: E402

NAME = "spruce"
ATLAS_SIZE = 1024
ATLAS_CELLS = 2
IMPOSTER_PX = 512       # imposter render height in pixels


# ---------------------------------------------------------------------------
# local helpers
# ---------------------------------------------------------------------------

def join_keep_uv(objs, name):
    """Merge meshes preserving UV layers, materials and smooth flags.

    lib.mesh.join() rebuilds faces in a bmesh without copying loop data, so
    every merged face comes out with UV (0, 0).  For trunk-and-bark parts that
    is invisible; for a thousand atlas-mapped foliage cards it means they all
    sample the same transparent texel and the whole crown disappears.  Building
    the merged mesh from flat arrays is both correct and much faster than a
    per-object bmesh merge at these object counts.
    """
    objs = [o for o in objs if o is not None]
    if not objs:
        return None

    verts, faces, face_uv, face_mat, face_smooth = [], [], [], [], []
    mats, slot_of = [], {}
    for src in objs:
        me = src.data
        mw = src.matrix_world
        base = len(verts)
        for v in me.vertices:
            verts.append(tuple(mw @ v.co))
        remap = {}
        for i, m in enumerate(me.materials):
            if m is None:
                remap[i] = 0
                continue
            if m.name not in slot_of:
                slot_of[m.name] = len(mats)
                mats.append(m)
            remap[i] = slot_of[m.name]
        layer = me.uv_layers[0] if me.uv_layers else None
        loops = me.loops
        for poly in me.polygons:
            li = poly.loop_indices
            faces.append(tuple(loops[i].vertex_index + base for i in li))
            face_mat.append(remap.get(poly.material_index, 0))
            face_smooth.append(poly.use_smooth)
            face_uv.append([tuple(layer.data[i].uv) for i in li] if layer
                           else [(0.0, 0.0)] * len(li))

    obj = M.from_pydata(name, verts, faces)
    me = obj.data
    for m in mats:
        me.materials.append(m)
    lay = me.uv_layers.new(name="UVMap")
    for pi, poly in enumerate(me.polygons):
        if pi >= len(face_uv):
            break
        poly.material_index = face_mat[pi]
        poly.use_smooth = face_smooth[pi]
        uvs = face_uv[pi]
        for k, li in enumerate(poly.loop_indices):
            lay.data[li].uv = uvs[k] if k < len(uvs) else (0.0, 0.0)
    me.update()

    for src in objs:
        M.remove(src)
    return obj


def dense_spray(canvas, rng, cx, cy, w, h):
    """One atlas cell: several layered lib.tex.spruce_spray shoots.

    A single spruce_spray is a thin twig that leaves most of its cell empty, so
    cards cut from it read as sparse rectangles at distance.  Stacking a few --
    two full-size shoots for needle density plus four smaller offset ones, the
    back layers darkened -- fills the cell edge to edge, which is what makes the
    crown read as foliage instead of geometry.
    """
    layers = (
        (-0.25, 0.03, 1.00, 0.60, 0.34),
        (0.26, -0.05, 0.98, 0.58, 0.30),
        (-0.10, -0.27, 0.90, 0.50, 0.18),
        (0.11, 0.25, 0.92, 0.52, 0.13),
        (0.00, 0.00, 1.22, 0.97, 0.00),
        (0.03, -0.02, 1.16, 0.93, 0.06),
    )
    for i, (ox, oy, sw, sh, dark) in enumerate(layers):
        tex.spruce_spray(canvas, rng.sub("s%d" % i),
                         cx + ox * w * 0.5, cy + oy * h * 0.5,
                         w * sw, h * sh, dark=dark)
    return canvas


# ---------------------------------------------------------------------------
# variant specifications
# ---------------------------------------------------------------------------

VARIANTS = [
    dict(
        key="v0", label="young",
        height=6.1,
        base_r=0.072, tip_r=0.006, lean=0.008,
        crown_lo=0.030, crown_hi=0.965,   # crown extent as a fraction of height
        whorls=12, per_whorl=(5, 6),
        reach=1.30, reach_pow=0.72, reach_var=0.13,
        rise=(0.26, 0.66), droop=(0.34, 0.06),
        card_min=0.15, card_max=0.34,
        density=1.20, drop=0.0,
        dead=0,
    ),
    dict(
        key="v1", label="mature",
        height=27.6,
        base_r=0.295, tip_r=0.011, lean=0.013,
        crown_lo=0.255, crown_hi=0.980,   # ~7 m of clean bare trunk
        whorls=14, per_whorl=(5, 6),
        reach=3.55, reach_pow=0.80, reach_var=0.15,
        rise=(0.13, 0.62), droop=(0.60, 0.09),
        card_min=0.30, card_max=0.86,
        density=1.0, drop=0.0,
        dead=0,
    ),
    dict(
        key="v2", label="old",
        height=31.6,
        base_r=0.355, tip_r=0.013, lean=0.019,
        crown_lo=0.360, crown_hi=0.985,   # live crown starts ~11.4 m up
        whorls=12, per_whorl=(4, 6),
        reach=3.35, reach_pow=0.62, reach_var=0.34,   # irregular, ragged
        rise=(0.10, 0.55), droop=(0.66, 0.10),
        card_min=0.30, card_max=0.86,
        density=0.80, drop=0.16,          # 16 % of card stations left empty
        dead=8,                           # bare dead stubs low on the trunk
    ),
]

# geometry resolution per LOD level
QUALITY = [
    dict(trunk_sides=7, trunk_pts=12, branch_sides=3, branch_pts=5,
         whorl_frac=1.00, per_station=3, station_a=2.0, station_b=1.15,
         station_max=8, card_mul=1.0, apex_cards=7),
    dict(trunk_sides=4, trunk_pts=6, branch_sides=3, branch_pts=4,
         whorl_frac=0.58, per_station=2, station_a=1.0, station_b=0.55,
         station_max=4, card_mul=2.05, apex_cards=3),
]


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------
# trunk
# ---------------------------------------------------------------------------

def trunk_curve(rng, spec, n):
    """Path + radii for the main stem.

    Spruce stems are straight, so the lean is deliberately tiny -- just enough
    that the leader is not a perfect cylinder axis.  The taper is a power curve
    with a root flare in the bottom tenth.
    """
    h = spec["height"]
    lean_dir = rng.uniform(0.0, math.tau)
    lean = spec["lean"] * h
    phase = rng.uniform(0.0, math.tau)
    sway = h * 0.0035

    pts, radii = [], []
    for i in range(n):
        t = i / (n - 1.0)
        bend = lean * (t ** 1.9)
        wob = math.sin(t * 3.4 + phase) * sway * t
        x = math.cos(lean_dir) * bend + wob
        y = math.sin(lean_dir) * bend - wob * 0.55
        r = spec["tip_r"] + (spec["base_r"] - spec["tip_r"]) * ((1.0 - t) ** 1.4)
        if t < 0.10:
            r *= 1.0 + 0.60 * ((0.10 - t) / 0.10) ** 2.0
        pts.append((x, y, h * t))
        radii.append(r)
    return pts, radii


def trunk_at(pts, radii, z):
    """Stem centre and radius at height z (linear interpolation)."""
    for i in range(len(pts) - 1):
        z0, z1 = pts[i][2], pts[i + 1][2]
        if z1 >= z or i == len(pts) - 2:
            f = clamp((z - z0) / max(1e-6, z1 - z0), 0.0, 1.0)
            return (Vector((lerp(pts[i][0], pts[i + 1][0], f),
                            lerp(pts[i][1], pts[i + 1][1], f), z)),
                    lerp(radii[i], radii[i + 1], f))
    return Vector(pts[-1]), radii[-1]


# ---------------------------------------------------------------------------
# branches
# ---------------------------------------------------------------------------

def branch_fn(origin, azim, length, rise, droop, sway):
    """Analytic branch centreline, s in [0, 1].

    Horizontal reach is `length`; z first climbs at `rise` then is pulled under
    by `droop * s**2.6`, so the fall is concentrated in the outer third of the
    branch -- the hanging tip.
    """
    ox, oy, oz = origin
    dx, dy = math.cos(azim), math.sin(azim)

    def f(s):
        rad = length * s
        z = length * (math.sin(rise) * s - droop * (s ** 2.6))
        lat = math.sin(s * 2.5) * sway * length
        return Vector((ox + dx * rad - dy * lat,
                       oy + dy * rad + dx * lat,
                       oz + z))
    return f


def branch_tangent(f, s, h=0.02):
    a = f(clamp(s - h, 0.0, 1.0))
    b = f(clamp(s + h, 0.0, 1.0))
    d = b - a
    if d.length < 1e-7:
        d = Vector((1.0, 0.0, 0.0))
    return d.normalized()


def branch_tube(name, f, length, sides, pts, thick=1.0):
    path, radii = [], []
    r0 = (0.028 * length + 0.008) * thick
    for i in range(pts):
        s = (i / (pts - 1.0)) ** 0.85
        path.append(tuple(f(s)))
        radii.append(r0 * (1.0 - 0.86 * s) + 0.0022)
    return M.tube(name, path, radii, sides=sides, caps=False)


# ---------------------------------------------------------------------------
# foliage cards
# ---------------------------------------------------------------------------

def remap_card_uv(obj, rect, flip_u=False):
    """Squeeze the card's 0..1 UVs into one atlas cell."""
    x0, y0, x1, y1 = rect
    layer = obj.data.uv_layers[0]
    for d in layer.data:
        u, v = d.uv[0], d.uv[1]
        if flip_u:
            u = 1.0 - u
        d.uv = (x0 + u * (x1 - x0), y0 + v * (y1 - y0))
    return obj


def place_card(out, rng, name, pos, direction, height, width, roll):
    """One needle-spray quad whose local +Z runs along `direction`.

    `roll` spins the quad about that axis, which is the whole reason the crown
    reads as a volume: three cards at one station share an axis but not a
    plane.
    """
    frame = scatter.frame_from_normal(direction)
    mtx = (Matrix.Translation(pos) @ frame @ Matrix.Rotation(roll, 4, "Z"))
    c = scatter.card(name, width, height, matrix=mtx, pivot_bottom=True)
    cell = rng.randint(0, ATLAS_CELLS * ATLAS_CELLS - 1)
    remap_card_uv(c, tex.atlas_uv_rect(cell, cells=ATLAS_CELLS),
                  flip_u=rng.chance(0.5))
    out.append(c)
    return c


def dress_branch(out, rng, f, length, spec, q, tag):
    """Scatter card stations along one branch."""
    n_st = int(clamp(round(q["station_a"] + q["station_b"] * length),
                     1, q["station_max"]))
    span = 0.90
    step = span / n_st
    hc = clamp(1.55 * step * length * q["card_mul"],
               spec["card_min"] * q["card_mul"], spec["card_max"] * q["card_mul"])

    per = q["per_station"]
    for i in range(n_st):
        s = 0.10 + step * (i + rng.uniform(0.15, 0.85))
        if spec["drop"] > 0.0 and rng.chance(spec["drop"]):
            continue
        base = f(clamp(s, 0.0, 1.0))
        tan = branch_tangent(f, clamp(s, 0.02, 0.98))
        scale = (1.0 - 0.30 * s) * rng.uniform(0.82, 1.18)
        for k in range(per):
            # splay the shoot off the branch axis, then roll the quad about it
            splay = (k - (per - 1) * 0.5) * (1.05 / max(1, per - 1)) \
                + rng.uniform(-0.22, 0.22)
            d = Matrix.Rotation(splay, 4, "Z") @ tan
            d = d + Vector((0.0, 0.0, rng.uniform(-0.42, 0.10)))
            if d.length < 1e-6:
                d = tan.copy()
            d.normalize()
            roll = (k / float(per)) * math.pi + rng.uniform(-0.35, 0.35)
            off = Vector(rng.offset3(hc * 0.16))
            place_card(out, rng, "%s_c%d_%d" % (tag, i, k), base + off, d,
                       hc * scale, hc * 0.88 * scale, roll)


def dress_apex(out, rng, pts, spec, q, top_z):
    """A tuft on the leader so the tree ends in a point, not a bare spike."""
    n = q["apex_cards"]
    hc = clamp(spec["card_min"] * 1.15 * q["card_mul"], 0.10, 1.2)
    for i in range(n):
        t = i / float(max(1, n))
        z = top_z - hc * (0.35 + 1.25 * t)
        c, _r = trunk_at(pts, [0.0] * len(pts), max(0.0, z))
        a = scatter.golden_ring(n, phase=0.7)[i]
        d = Vector((math.cos(a) * 0.42, math.sin(a) * 0.42, 1.0)).normalized()
        place_card(out, rng, "%s_apex%d" % (spec["key"], i), c, d,
                   hc * (0.7 + 0.7 * t), hc * 0.72 * (0.7 + 0.7 * t),
                   rng.uniform(0.0, math.pi))


# ---------------------------------------------------------------------------
# whole tree
# ---------------------------------------------------------------------------

def build_tree(spec, rng, level, bark, deadwood, foliage):
    q = QUALITY[level]
    h = spec["height"]

    pts, radii = trunk_curve(rng.sub("trunk"), spec, q["trunk_pts"])
    trunk = M.tube("%s_stem" % spec["key"], pts, radii,
                   sides=q["trunk_sides"], caps=False)
    M.shade_smooth(trunk, 46.0)

    wood, cards = [], []
    z_lo = h * spec["crown_lo"]
    z_hi = h * spec["crown_hi"]
    nw = max(3, int(round(spec["whorls"] * q["whorl_frac"])))

    ga = math.pi * (3.0 - math.sqrt(5.0))
    for w in range(nw):
        wr = rng.sub("w%d" % w)
        tw = w / (nw - 1.0)
        z = lerp(z_lo, z_hi, tw)
        centre, r_stem = trunk_at(pts, radii, z)

        # conical crown: reach falls off towards the leader, with the very
        # lowest whorl pulled in slightly (self-shading kills the bottom ring)
        prof = (1.0 - tw) ** spec["reach_pow"]
        prof *= 0.80 + 0.20 * math.sin(min(1.0, tw * 3.2) * math.pi * 0.5)
        reach = spec["reach"] * prof
        if reach < 0.06:
            continue

        rise = lerp(spec["rise"][0], spec["rise"][1], tw)
        droop = lerp(spec["droop"][0], spec["droop"][1], tw)
        nb = wr.randint(*spec["per_whorl"])
        phase = ga * w + wr.uniform(-0.25, 0.25)

        for b in range(nb):
            br = wr.sub("b%d" % b)
            azim = phase + math.tau * b / nb + br.uniform(-0.34, 0.34)
            length = reach * br.vary(1.0, spec["reach_var"])
            origin = (centre.x + math.cos(azim) * r_stem * 0.85,
                      centre.y + math.sin(azim) * r_stem * 0.85,
                      z + br.uniform(-0.02, 0.02) * h * 0.05)
            f = branch_fn(origin, azim, length,
                          br.vary(rise, 0.25), br.vary(droop, 0.22),
                          br.uniform(-0.09, 0.09))
            wood.append(branch_tube("%s_w%db%d" % (spec["key"], w, b), f,
                                    length, q["branch_sides"], q["branch_pts"]))
            if br.chance(spec["density"]):
                dress_branch(cards, br.sub("f"), f, length, spec, q,
                             "%s_w%db%d" % (spec["key"], w, b))

    dress_apex(cards, rng.sub("apex"), pts, spec, q, h)

    # dead bare lower branches -- old Sumava spruce keep them for decades
    dead = []
    if spec["dead"] and level == 0:
        dr = rng.sub("dead")
        for i in range(spec["dead"]):
            t = i / float(max(1, spec["dead"] - 1))
            z = lerp(h * 0.085, h * (spec["crown_lo"] - 0.02), t)
            centre, r_stem = trunk_at(pts, radii, z)
            azim = ga * (i * 3 + 1) + dr.uniform(-0.4, 0.4)
            length = dr.uniform(0.55, 1.9) * (0.5 + 0.9 * t)
            f = branch_fn((centre.x + math.cos(azim) * r_stem * 0.85,
                           centre.y + math.sin(azim) * r_stem * 0.85, z),
                          azim, length, dr.uniform(0.02, 0.16),
                          dr.uniform(0.55, 0.95), dr.uniform(-0.12, 0.12))
            dead.append(branch_tube("%s_dead%d" % (spec["key"], i), f, length,
                                    4, 5, thick=0.85))

    mat.assign_all(trunk, bark)
    parts = [trunk]
    if wood:
        w_obj = join_keep_uv(wood, "%s_branches" % spec["key"])
        M.shade_smooth(w_obj, 60.0)
        mat.assign_all(w_obj, bark)
        parts.append(w_obj)
    if dead:
        d_obj = join_keep_uv(dead, "%s_deadwood" % spec["key"])
        M.shade_smooth(d_obj, 60.0)
        mat.assign_all(d_obj, deadwood)
        parts.append(d_obj)
    if cards:
        c_obj = join_keep_uv(cards, "%s_foliage" % spec["key"])
        mat.assign_all(c_obj, foliage)
        parts.append(c_obj)

    return join_keep_uv(parts, "%s_%s_L%d" % (NAME, spec["key"], level))


# ---------------------------------------------------------------------------
# shading fix-up
# ---------------------------------------------------------------------------

def cone_normals(obj, foliage_name, blend=0.82, up=0.50):
    """Point card normals out of the trunk axis along the crown cone.

    A quad's own normal makes half the crown face away from every light, which
    at distance looks like flat rectangles pasted on the tree.  Replacing the
    card loop normals with a cone field makes the whole crown shade as one
    rounded mass.  Non-card loops keep the smooth vertex normal.
    """
    me = obj.data
    slot = None
    for i, m in enumerate(me.materials):
        if m is not None and m.name == foliage_name:
            slot = i
            break
    if slot is None:
        return obj

    for poly in me.polygons:
        poly.use_smooth = True

    verts = me.vertices
    loops = me.loops
    out = [Vector((0.0, 0.0, 1.0))] * len(loops)
    for poly in me.polygons:
        if poly.material_index == slot:
            pn = poly.normal.copy()
            for li in poly.loop_indices:
                co = verts[loops[li].vertex_index].co
                d = Vector((co.x, co.y, 0.0))
                d = d.normalized() if d.length > 1e-5 else Vector((0.0, 0.0, 1.0))
                n = (d * (1.0 - up) + Vector((0.0, 0.0, up))).normalized()
                n = n * blend + pn * (1.0 - blend)
                out[li] = n.normalized() if n.length > 1e-6 else pn
        else:
            for li in poly.loop_indices:
                vn = verts[loops[li].vertex_index].normal.copy()
                out[li] = vn if vn.length > 1e-6 else poly.normal.copy()
    try:
        me.normals_split_custom_set([tuple(n) for n in out])
        me.update()
    except Exception as exc:            # pragma: no cover - version drift
        print("spruce: custom normals unavailable (%r)" % (exc,))
    return obj


# ---------------------------------------------------------------------------
# imposter
# ---------------------------------------------------------------------------

def render_imposter(obj, path, size=IMPOSTER_PX):
    """Orthographic render of `obj` alone on transparent film.

    Returns (width, height, z_bottom) so the crossed billboard can be built to
    frame exactly what was rendered -- the quad UVs run 0..1 over that box.
    """
    scene = bpy.context.scene
    mn, mx = M.bounds(obj)
    half_w = max(abs(mn.x), abs(mx.x), abs(mn.y), abs(mx.y), 1e-3) * 1.02
    z_bot = min(0.0, mn.z)
    z_top = mx.z + max(0.02, mx.z * 0.004)
    height = max(z_top - z_bot, 1e-3)
    res_y = int(size)
    res_x = max(8, int(round(res_y * (half_w * 2.0) / height / 4.0)) * 4)
    width = height * (res_x / float(res_y))

    hidden = [(o, o.hide_render) for o in bpy.data.objects]
    for o, _ in hidden:
        o.hide_render = (o is not obj)

    cam_data = bpy.data.cameras.new("_imposter_cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = height
    cam_data.clip_start = 1.0
    cam_data.clip_end = 4000.0
    cam = bpy.data.objects.new("_imposter_cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0.0, -(height * 6.0 + 40.0), z_bot + height * 0.5)
    cam.rotation_euler = (math.pi * 0.5, 0.0, 0.0)

    lights = []
    for lname, energy, rot, colour in (
        ("_imp_key", 3.1, (math.radians(58), 0.0, math.radians(34)), (1.0, 0.98, 0.93)),
        ("_imp_fill", 1.9, (math.radians(72), 0.0, math.radians(-128)), (0.82, 0.88, 1.0)),
        ("_imp_back", 1.6, (math.radians(108), 0.0, math.radians(196)), (1.0, 0.99, 0.94)),
    ):
        ld = bpy.data.lights.new(lname, "SUN")
        ld.energy = energy
        ld.color = colour
        try:
            ld.angle = math.radians(20)
        except Exception:
            pass
        lo = bpy.data.objects.new(lname, ld)
        scene.collection.objects.link(lo)
        lo.rotation_euler = rot
        lights.append(lo)

    world = bpy.data.worlds.new("_imposter_world")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    wout = nt.nodes.new("ShaderNodeOutputWorld")
    wbg = nt.nodes.new("ShaderNodeBackground")
    wbg.inputs["Color"].default_value = (0.46, 0.50, 0.56, 1.0)
    wbg.inputs["Strength"].default_value = 1.0
    nt.links.new(wbg.outputs["Background"], wout.inputs["Surface"])

    r = scene.render
    saved = dict(
        engine=r.engine, rx=r.resolution_x, ry=r.resolution_y,
        pct=r.resolution_percentage, film=r.film_transparent,
        fmt=r.image_settings.file_format, mode=r.image_settings.color_mode,
        fp=r.filepath, cam=scene.camera, world=scene.world,
        vt=scene.view_settings.view_transform, look=scene.view_settings.look,
    )
    try:
        r.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    r.resolution_x = res_x
    r.resolution_y = res_y
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    r.filepath = os.path.abspath(path)
    scene.camera = cam
    scene.world = world
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except Exception:
        pass
    try:
        scene.eevee.taa_render_samples = 32
    except Exception:
        pass

    bpy.ops.render.render(write_still=True)

    # restore
    r.engine = saved["engine"]
    r.resolution_x = saved["rx"]
    r.resolution_y = saved["ry"]
    r.resolution_percentage = saved["pct"]
    r.film_transparent = saved["film"]
    r.image_settings.file_format = saved["fmt"]
    r.image_settings.color_mode = saved["mode"]
    r.filepath = saved["fp"]
    scene.camera = saved["cam"]
    scene.world = saved["world"]
    try:
        scene.view_settings.view_transform = saved["vt"]
        scene.view_settings.look = saved["look"]
    except Exception:
        pass

    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data, do_unlink=True)
    for lo in lights:
        ld = lo.data
        bpy.data.objects.remove(lo, do_unlink=True)
        bpy.data.lights.remove(ld, do_unlink=True)
    bpy.data.worlds.remove(world, do_unlink=True)
    for o, state in hidden:
        try:
            o.hide_render = state
        except ReferenceError:
            pass

    return width, height, z_bot


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    args = cli.parse({"draco": True})
    rng = cli.setup(args.seed, NAME)

    atlas_path = tex.build_atlas(cli.cache_path(args, "spruce_needles.png"),
                                 rng.sub("atlas"), dense_spray,
                                 size=ATLAS_SIZE, cells=ATLAS_CELLS)
    needles = tex.load_image(atlas_path, "spruce_needles")
    foliage = mat.image_material("spruce_needles", needles, alpha_mode="CLIP",
                                 backface_culling=False, roughness=0.85)
    bark = mat.principled("spruce_bark", mat.BARK_SPRUCE, roughness=0.90,
                          specular=0.22)
    deadwood = mat.principled("spruce_deadwood", mat.WOOD_DEAD, roughness=0.95,
                              specular=0.15)

    all_lods = []
    summary = []
    for spec in VARIANTS:
        vr = rng.sub(spec["key"])
        levels = [build_tree(spec, vr.sub("L%d" % lv), lv, bark, deadwood,
                             foliage) for lv in (0, 1)]

        imp_png = cli.cache_path(args, "spruce_imposter_%s.png" % spec["key"])
        width, height, z_bot = render_imposter(levels[0], imp_png)
        imp_img = tex.load_image(imp_png, "spruce_imposter_%s" % spec["key"])
        imp_mat = mat.image_material("spruce_imposter_%s" % spec["key"], imp_img,
                                     alpha_mode="CLIP", backface_culling=False,
                                     roughness=0.92)
        billboard = lod.crossed_billboard("%s_%s_L2" % (NAME, spec["key"]),
                                          imp_mat, width, height,
                                          z_offset=z_bot, planes=2)

        group = lod.assemble_lods("%s_%s" % (NAME, spec["key"]),
                                  [levels[0], levels[1], billboard])
        for o in group[:2]:
            cone_normals(o, foliage.name)
        lod.report(group)
        summary.append({"variant": spec["key"], "label": spec["label"],
                        "heightM": round(spec["height"], 2),
                        "tris": [M.tri_count(o) for o in group]})
        all_lods.extend(group)

    path = cli.out_path(args, NAME + ".glb")
    exporter.export_glb(all_lods, path, draco=args.draco)
    exporter.emit_meta(NAME, path, all_lods, extra={
        "variants": len(VARIANTS),
        "originNote": "base of trunk on the ground, +Z up; every variant is "
                      "centred on its own origin (no baked offsets)",
        "notes": "v0 young / v1 mature / v2 old-with-dead-branches; "
                 "LOD1 rebuilt not decimated, LOD2 crossed-quad imposter "
                 "baked from each variant's own LOD0",
        "variantDetail": summary,
    })


main()
