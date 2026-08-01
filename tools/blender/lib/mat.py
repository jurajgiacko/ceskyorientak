"""Principled BSDF material construction, glTF-export friendly.

Only the Principled BSDF inputs that the glTF exporter understands are used
(Base Color, Metallic, Roughness, IOR, Alpha, Emission Color/Strength, Normal),
so what you see in Blender is what lands in the .glb.
"""

import bpy

# Blender 4.x renamed several Principled sockets.  Look inputs up by a list of
# candidate names so the lib survives minor version drift.
_ALIASES = {
    "base_color": ("Base Color",),
    "metallic": ("Metallic",),
    "roughness": ("Roughness",),
    "ior": ("IOR",),
    "alpha": ("Alpha",),
    "emission_color": ("Emission Color", "Emission"),
    "emission_strength": ("Emission Strength",),
    "specular": ("Specular IOR Level", "Specular"),
    "coat": ("Coat Weight", "Clearcoat"),
    "coat_roughness": ("Coat Roughness", "Clearcoat Roughness"),
    "sheen": ("Sheen Weight", "Sheen"),
}


def _sock(bsdf, key):
    for name in _ALIASES[key]:
        s = bsdf.inputs.get(name)
        if s is not None:
            return s
    return None


def _set(bsdf, key, value):
    s = _sock(bsdf, key)
    if s is not None and value is not None:
        s.default_value = value


def _rgba(c):
    if c is None:
        return None
    return tuple(c) if len(c) == 4 else (c[0], c[1], c[2], 1.0)


def principled(name, base_color=(0.8, 0.8, 0.8), roughness=0.7, metallic=0.0,
               ior=1.45, alpha=1.0, alpha_mode="OPAQUE", emission=None,
               emission_strength=0.0, specular=0.5, coat=0.0, sheen=0.0,
               backface_culling=False, reuse=True):
    """Create (or fetch) a Principled material.

    alpha_mode: OPAQUE | CLIP | HASHED | BLEND -- drives the glTF alphaMode.
    """
    if reuse and name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    bsdf.name = "BSDF"
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    _set(bsdf, "base_color", _rgba(base_color))
    _set(bsdf, "roughness", roughness)
    _set(bsdf, "metallic", metallic)
    _set(bsdf, "ior", ior)
    _set(bsdf, "alpha", alpha)
    _set(bsdf, "specular", specular)
    _set(bsdf, "coat", coat)
    _set(bsdf, "sheen", sheen)
    if emission is not None:
        _set(bsdf, "emission_color", _rgba(emission))
        _set(bsdf, "emission_strength", emission_strength)

    try:
        mat.blend_method = alpha_mode
    except Exception:
        pass
    if alpha_mode in ("CLIP", "HASHED"):
        try:
            mat.alpha_threshold = 0.5
        except Exception:
            pass
    mat.use_backface_culling = bool(backface_culling)
    return mat


def image_material(name, image, alpha_mode="CLIP", roughness=0.85,
                   metallic=0.0, use_alpha=True, backface_culling=False,
                   emission_boost=0.0):
    """Material driven by a bpy image (base colour + alpha).

    Used for foliage cards and billboard imposters, where the silhouette
    lives entirely in the texture's alpha channel.
    """
    if name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (500, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (150, 0)
    bsdf.name = "BSDF"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.location = (-250, 0)
    tex.image = image
    tex.interpolation = "Linear"
    tex.extension = "CLIP"
    tex.name = "BASE_TEX"

    nt.links.new(tex.outputs["Color"], _sock(bsdf, "base_color"))
    if use_alpha:
        nt.links.new(tex.outputs["Alpha"], _sock(bsdf, "alpha"))
    _set(bsdf, "roughness", roughness)
    _set(bsdf, "metallic", metallic)
    _set(bsdf, "specular", 0.2)
    if emission_boost > 0:
        nt.links.new(tex.outputs["Color"], _sock(bsdf, "emission_color"))
        _set(bsdf, "emission_strength", emission_boost)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    try:
        mat.blend_method = alpha_mode
        mat.alpha_threshold = 0.5
    except Exception:
        pass
    mat.use_backface_culling = bool(backface_culling)
    return mat


# ---------------------------------------------------------------------------
# assignment helpers
# ---------------------------------------------------------------------------

def add(obj, mat):
    """Append material to obj, return its slot index (idempotent)."""
    for i, slot in enumerate(obj.data.materials):
        if slot is mat:
            return i
    obj.data.materials.append(mat)
    return len(obj.data.materials) - 1


def assign_all(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.material_index = 0
    return 0


def assign_faces(obj, mat, predicate):
    """Assign `mat` to every polygon for which predicate(poly, obj) is True."""
    idx = add(obj, mat)
    n = 0
    for poly in obj.data.polygons:
        if predicate(poly, obj):
            poly.material_index = idx
            n += 1
    return n


def assign_face_indices(obj, mat, indices):
    idx = add(obj, mat)
    polys = obj.data.polygons
    for i in indices:
        if 0 <= i < len(polys):
            polys[i].material_index = idx
    return idx


# ---------------------------------------------------------------------------
# shared palette -- one place for the project's recurring surfaces
# ---------------------------------------------------------------------------

# IOF control-flag orange.  The spec calls for PMS 165 / "orange"; this is the
# usual print value converted to linear-ish sRGB for Principled base colour.
IOF_ORANGE = (0.900, 0.235, 0.020)
IOF_WHITE = (0.900, 0.900, 0.880)

GRANITE_LIGHT = (0.330, 0.320, 0.300)
GRANITE_MID = (0.235, 0.230, 0.220)
GRANITE_DARK = (0.140, 0.138, 0.132)
LICHEN = (0.300, 0.330, 0.190)

BARK_SPRUCE = (0.115, 0.082, 0.060)
BARK_BEECH = (0.300, 0.290, 0.268)
WOOD_DEAD = (0.190, 0.160, 0.125)
WOOD_FRESH = (0.420, 0.330, 0.225)

STEEL = (0.560, 0.570, 0.580)
STEEL_DARK = (0.230, 0.235, 0.245)
PLASTIC_YELLOW = (0.880, 0.700, 0.080)
PLASTIC_GREY = (0.180, 0.185, 0.195)
CANVAS_WHITE = (0.880, 0.885, 0.880)
