# Shared helpers for pirates-br Blender asset builds.
# Run inside Blender:  exec(open('.../scripts/blender/_helpers.py').read())
# Game scale: 1 Blender unit = 1 game unit (~1 m). Up axis: Blender +Z -> glTF +Y.
# Forward: game bow = three.js +Z  ==> author bows toward Blender -Y.
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

EXPORT_DIR = "/Users/tobiasdicker/ai-dev-system/projects/pirates-br/public/assets/models"


# ── Palette ──────────────────────────────────────────────────
# Stylized flat-color materials. Names are stable — the client tints by name
# (e.g. TeamTint). Keep roughness high, metals low except Metal/Gold.
PALETTE = {
    "Wood_Dark":   ((0.16, 0.10, 0.06, 1.0), 0.85, 0.0),
    "Wood_Mid":    ((0.30, 0.19, 0.10, 1.0), 0.82, 0.0),
    "Wood_Light":  ((0.52, 0.36, 0.20, 1.0), 0.80, 0.0),
    "Wood_Bleached": ((0.62, 0.52, 0.38, 1.0), 0.85, 0.0),
    "Trunk_Palm":  ((0.28, 0.18, 0.10, 1.0), 0.88, 0.0),
    "Leaf_Green":  ((0.13, 0.42, 0.15, 1.0), 0.75, 0.0),
    "Leaf_Green_Lt": ((0.24, 0.55, 0.18, 1.0), 0.75, 0.0),
    "Leaf_Dry":    ((0.55, 0.45, 0.20, 1.0), 0.80, 0.0),
    "Rock_Grey":   ((0.30, 0.28, 0.26, 1.0), 0.92, 0.0),
    "Rock_Dark":   ((0.22, 0.22, 0.24, 1.0), 0.90, 0.0),
    "Rock_Sea":    ((0.16, 0.17, 0.20, 1.0), 0.75, 0.0),
    "Sand":        ((0.83, 0.72, 0.50, 1.0), 0.95, 0.0),
    "Metal_Iron":  ((0.12, 0.12, 0.13, 1.0), 0.45, 0.9),
    "Metal_Band":  ((0.20, 0.19, 0.18, 1.0), 0.55, 0.8),
    "Gold":        ((0.85, 0.62, 0.13, 1.0), 0.35, 1.0),
    "Rope":        ((0.58, 0.48, 0.30, 1.0), 0.95, 0.0),
    "Canvas":      ((0.72, 0.66, 0.52, 1.0), 0.90, 0.0),
    "Canvas_Dirty": ((0.49, 0.43, 0.32, 1.0), 0.95, 0.0),
    "Keg_Red":     ((0.55, 0.12, 0.08, 1.0), 0.80, 0.0),
    "Paint_White": ((0.88, 0.86, 0.80, 1.0), 0.80, 0.0),
    "TeamTint":    ((0.80, 0.20, 0.20, 1.0), 0.75, 0.0),
    "Coconut":     ((0.30, 0.22, 0.10, 1.0), 0.85, 0.0),
    "Char_Black":  ((0.05, 0.04, 0.04, 1.0), 0.95, 0.0),
    "Lantern_Glass": ((0.95, 0.75, 0.35, 1.0), 0.20, 0.0),
}


def mat(name):
    """Get-or-create a palette material by name."""
    m = bpy.data.materials.get(name)
    if m is None:
        color, rough, metal = PALETTE[name]
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if name == "Lantern_Glass":
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = 3.0
    return m


# ── Scene / collection management ────────────────────────────
def asset_collection(name):
    """Fresh collection for one asset; deletes previous contents."""
    coll = bpy.data.collections.get(name)
    if coll:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    else:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


def link_only(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def new_obj(name, mesh, coll):
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    return obj


def obj_from_bmesh(name, bm, coll, material=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = new_obj(name, me, coll)
    if material:
        obj.data.materials.append(material)
    for p in obj.data.polygons:
        p.use_smooth = smooth
    return obj


def join(objs, name):
    """Join objects into one; keeps materials as slots."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def apply_modifiers(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


# ── Primitive builders (bmesh) ───────────────────────────────
def bm_cylinder(r1, r2, depth, segs=10, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segs,
                          radius1=r1, radius2=r2, depth=depth)
    return bm


def bm_box(w, d, h):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    return bm


def bm_icosphere(r, subdiv=2):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    return bm


def displace_noise(obj, strength=0.4, scale=1.4, seed=0):
    """Faceted stylized displacement using a Voronoi-ish cloud texture."""
    tex_name = f"noise_{seed}_{scale:.2f}"
    tex = bpy.data.textures.get(tex_name)
    if tex is None:
        tex = bpy.data.textures.new(tex_name, type='VORONOI')
        tex.noise_scale = scale
        tex.distance_metric = 'DISTANCE_SQUARED'
    md = obj.modifiers.new("Displace", 'DISPLACE')
    md.texture = tex
    md.strength = strength
    md.texture_coords = 'GLOBAL'


def decimate(obj, ratio=0.35):
    md = obj.modifiers.new("Decimate", 'DECIMATE')
    md.ratio = ratio


def bevel_obj(obj, width=0.02, segments=1, angle=math.radians(40)):
    md = obj.modifiers.new("Bevel", 'BEVEL')
    md.width = width
    md.segments = segments
    md.limit_method = 'ANGLE'
    md.angle_limit = angle


# ── Export ───────────────────────────────────────────────────
def export_collection(coll, filename):
    """Export a collection to GLB. Origin should be at world 0,0,0."""
    import os
    os.makedirs(EXPORT_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in coll.objects:
        obj.select_set(True)
    path = os.path.join(EXPORT_DIR, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    print(f"EXPORTED {path}")
    return path


def clear_default_scene():
    for name in ("Cube", "Light", "Camera"):
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)


print("helpers loaded")
