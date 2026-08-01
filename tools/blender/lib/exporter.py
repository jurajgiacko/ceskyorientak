"""glTF-Binary export.

One .glb per asset, containing every LOD as a root-level node named
``<asset>_LOD<n>``.  Textures are embedded in the binary chunk, so a .glb is
a single self-contained file for the web build.
"""

import json
import os

import bpy

from . import mesh as M


def export_glb(objects, path, draco=True, draco_level=6, position_bits=14,
               normal_bits=10, texcoord_bits=12, apply_modifiers=True,
               extras=True, vertex_color=None, vertex_color_name=None,
               color_bits=10):
    """Export exactly `objects` (and nothing else) to `path`.

    Draco is worth it for the high-poly natural assets and actively harmful
    for the tiny props (header overhead exceeds the savings), so callers pass
    the flag per asset.

    `vertex_color` maps to the exporter's own enum -- MATERIAL (default: only
    what the shader graph actually reads), ACTIVE, NAME or NONE. Assets that
    bake occlusion into a colour attribute should pass NAME plus the layer
    name: relying on MATERIAL means a refactor of the node graph can silently
    drop COLOR_0 and the model just gets flatter, with nothing to fail on.
    """
    objects = [o for o in objects if o is not None]
    os.makedirs(os.path.dirname(path), exist_ok=True)

    vl = bpy.context.view_layer
    # Required, not defensive. `join()` removes the source objects, and until
    # the depsgraph catches up `view_layer.objects` still holds pointers to the
    # freed ones — iterating it segfaults Blender inside ViewLayer_objects_next.
    # Individual asset scripts were each working around this locally, which
    # meant the next script written without the workaround would crash; the
    # guard belongs here instead.
    vl.update()
    for o in vl.objects:
        o.select_set(False)
    for o in objects:
        o.hide_set(False)
        o.hide_viewport = False
        o.hide_render = False
        o.select_set(True)
    if objects:
        vl.objects.active = objects[0]

    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=apply_modifiers,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_extras=extras,
        export_draco_mesh_compression_enable=bool(draco),
    )
    if draco:
        kwargs.update(
            export_draco_mesh_compression_level=draco_level,
            export_draco_position_quantization=position_bits,
            export_draco_normal_quantization=normal_bits,
            export_draco_texcoord_quantization=texcoord_bits,
            export_draco_color_quantization=color_bits,
        )
    if vertex_color is not None:
        kwargs["export_vertex_color"] = vertex_color
    if vertex_color_name is not None:
        kwargs["export_vertex_color_name"] = vertex_color_name

    bpy.ops.export_scene.gltf(**kwargs)
    return path


def emit_meta(name, path, lod_objects, extra=None):
    """Print a machine-readable line for build.mjs to scrape.

    Kept as stdout rather than a side file so a failed run cannot leave stale
    metadata behind.
    """
    lods = []
    for o in lod_objects:
        lods.append({"node": o.name, "tris": M.tri_count(o)})
    # "tris" is the LOD0 cost of one full instance of the asset -- summed over
    # every variant, since a multi-variant asset ships them in one file.
    lod0 = sum(l["tris"] for l in lods if l["node"].endswith("_LOD0"))
    meta = {
        "name": name,
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
        "tris": lod0 if lod0 else (lods[0]["tris"] if lods else 0),
        "trisAllLods": sum(l["tris"] for l in lods),
        "lods": lods,
    }
    if extra:
        meta.update(extra)
    print("ASSETMETA " + json.dumps(meta, separators=(",", ":")))
    return meta
