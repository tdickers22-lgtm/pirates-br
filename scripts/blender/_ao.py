# Fidelity-pass helpers: baked vertex AO, vertex-color GLB export, GLB verify,
# turntable renders. Load AFTER _helpers.py:
#   exec(open(os.path.join(os.path.dirname(__file__), '_ao.py')).read())
# Vertex AO multiplies the flat palette colors in three.js (GLTFLoader sets
# material.vertexColors when COLOR_0 is present). Keep floors high — the game
# has fought shadow-crush before; AO here is seasoning, not gravy.
# IMPORTANT: COLOR_0 must be all-or-nothing per GLB (AssetLibrary.mergedGeometry
# merges parts; mixed attribute sets break the merge). bake_ao() covers every
# mesh in the collection, so just call it once right before export.
import bpy
import math
import random as _rnd
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def _collection_bvh(coll, depsgraph):
    verts, polys = [], []
    base = 0
    for obj in coll.objects:
        if obj.type != 'MESH':
            continue
        ev = obj.evaluated_get(depsgraph)
        me = ev.to_mesh()
        mw = ev.matrix_world
        for v in me.vertices:
            verts.append(mw @ v.co)
        for p in me.polygons:
            polys.append(tuple(base + i for i in p.vertices))
        base += len(me.vertices)
        ev.to_mesh_clear()
    if not polys:
        return None
    return BVHTree.FromPolygons(verts, polys)


def bake_ao(coll, samples=20, max_dist=6.0, floor=0.55, height_gradient=0.10, seed=7):
    """Bake hemisphere-visibility AO (x optional base-darkening gradient) into a
    POINT-domain color attribute 'Col' on every mesh in the collection.
    floor: darkest multiplier (keep >=0.5). height_gradient: extra darkening at
    the asset's base fading out by half-height (0 disables)."""
    deps = bpy.context.evaluated_depsgraph_get()
    bvh = _collection_bvh(coll, deps)
    rng = _rnd.Random(seed)
    # Precompute cosine-weighted hemisphere dirs in tangent space
    dirs = []
    for _ in range(samples):
        u1, u2 = rng.random(), rng.random()
        r = math.sqrt(u1)
        phi = 2 * math.pi * u2
        dirs.append((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1 - u1))))
    zs = [c.z for o in coll.objects if o.type == 'MESH'
          for c in (o.matrix_world @ Vector(b) for b in o.bound_box)]
    zmin, zmax = (min(zs), max(zs)) if zs else (0.0, 1.0)
    hspan = max(0.001, (zmax - zmin) * 0.5)
    for obj in coll.objects:
        if obj.type != 'MESH':
            continue
        me = obj.data
        attr = me.color_attributes.get('Col')
        if attr is None:
            attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
        me.color_attributes.active_color = attr
        mw = obj.matrix_world
        nw = mw.inverted_safe().transposed().to_3x3()
        for i, v in enumerate(me.vertices):
            wco = mw @ v.co
            n = (nw @ v.normal).normalized()
            # tangent frame
            a = Vector((0, 0, 1)) if abs(n.z) < 0.92 else Vector((1, 0, 0))
            t = n.cross(a).normalized()
            b = n.cross(t)
            hits = 0
            if bvh is not None:
                origin = wco + n * 0.025
                for d in dirs:
                    wd = (t * d[0] + b * d[1] + n * d[2]).normalized()
                    if bvh.ray_cast(origin, wd, max_dist)[0] is not None:
                        hits += 1
            vis = 1.0 - hits / max(1, samples)
            ao = floor + (1.0 - floor) * vis
            if height_gradient > 0:
                hn = min(1.0, max(0.0, (wco.z - zmin) / hspan))
                ao *= (1.0 - height_gradient) + height_gradient * hn
            ao = min(1.0, max(floor * 0.85, ao))
            attr.data[i].color = (ao, ao, ao, 1.0)
    print(f"AO baked: {coll.name} ({samples} samples, floor {floor})")


def export_collection_vc(coll, filename):
    """export_collection + force COLOR_0 export (flat materials don't reference
    vertex color nodes, so the default 'MATERIAL' mode would skip them)."""
    import os
    os.makedirs(EXPORT_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in coll.objects:
        obj.select_set(True)
    path = os.path.join(EXPORT_DIR, filename)
    kwargs = dict(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_animations=False,
        export_skins=False, export_morph=False,
    )
    for extra in (
        {'export_vertex_color': 'ACTIVE', 'export_active_vertex_color_when_no_material': True},
        {'export_vertex_color': 'ACTIVE'},
        {},
    ):
        try:
            bpy.ops.export_scene.gltf(**kwargs, **extra)
            print(f"EXPORTED {path} (vc opts: {list(extra) or 'defaults'})")
            return path
        except TypeError:
            continue
    raise RuntimeError('gltf export failed for all vertex-color kwarg variants')


def verify_glb(path):
    """Parse GLB header JSON (no import): tris, materials, COLOR_0 presence, bbox.
    Returns dict and prints a VERIFY line — check it after every export."""
    import json
    import struct
    with open(path, 'rb') as f:
        magic, _ver, _len = struct.unpack('<III', f.read(12))
        assert magic == 0x46546C67, 'not a GLB'
        clen, ctype = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(clen))
    acc = gltf.get('accessors', [])
    tris = 0
    has_color = False
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            if 'COLOR_0' in prim.get('attributes', {}):
                has_color = True
            if 'indices' in prim:
                tris += acc[prim['indices']]['count'] // 3
            else:
                tris += acc[prim['attributes']['POSITION']]['count'] // 3
    mats = [m.get('name', '?') for m in gltf.get('materials', [])]
    mins = [a['min'] for a in acc if a.get('min') and len(a['min']) == 3]
    maxs = [a['max'] for a in acc if a.get('max') and len(a['max']) == 3]
    bb_min = [min(v[i] for v in mins) for i in range(3)] if mins else None
    bb_max = [max(v[i] for v in maxs) for i in range(3)] if maxs else None
    info = {'tris': tris, 'materials': mats, 'color0': has_color,
            'bbox_min': bb_min, 'bbox_max': bb_max}
    print(f"VERIFY {path.split('/')[-1]}: {tris} tris, COLOR_0={has_color}, "
          f"{len(mats)} mats {mats}, bbox {bb_min}..{bb_max}")
    return info


def render_turntable(coll, name, out_dir, views=3, elev_deg=18, res=(720, 540)):
    """Render N orbit views of the collection with a sun+sky rig. Read the PNGs
    after every build round — never claim an asset looks good unseen."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.image_settings.file_format = 'PNG'
    world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.55, 0.65, 0.75, 1.0)
        bg.inputs[1].default_value = 1.0
    # bbox fit
    pts = [o.matrix_world @ Vector(b) for o in coll.objects if o.type == 'MESH'
           for b in o.bound_box]
    if not pts:
        print('render_turntable: empty collection')
        return []
    ctr = sum(pts, Vector()) / len(pts)
    rad = max((p - ctr).length for p in pts)
    dist = rad * 2.6 + 0.5
    sun = bpy.data.objects.get('_tt_sun')
    if sun is None:
        sd = bpy.data.lights.new('_tt_sun', 'SUN')
        sd.energy = 3.5
        sun = bpy.data.objects.new('_tt_sun', sd)
        scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    cam = bpy.data.objects.get('_tt_cam')
    if cam is None:
        cd = bpy.data.cameras.new('_tt_cam')
        cam = bpy.data.objects.new('_tt_cam', cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    paths = []
    for i in range(views):
        ang = i * (2 * math.pi / views) + 0.5
        el = math.radians(elev_deg)
        cam.location = ctr + Vector((math.cos(ang) * math.cos(el),
                                     math.sin(ang) * math.cos(el),
                                     math.sin(el))) * dist
        look = ctr - cam.location
        cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler()
        p = os.path.join(out_dir, f"{name}_v{i}.png")
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        paths.append(p)
        print(f"RENDERED {p}")
    return paths


print("ao helpers loaded")
