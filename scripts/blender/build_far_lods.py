"""Far-distance LOD variants for the rebuilt nature GLBs (lane I.2).

The 2026-09-05 fidelity pass rebuilt fifteen nature assets at 1.2-4.8x their
old triangle counts. That detail is real geometry and it is what the player
sees up close; it is also what a wide vista pays for on every island in the
frustum, where a 5.6k-triangle palm covers a dozen pixels. InstanceLod thins
COUNTS with distance but never swapped GEOMETRY, so the low tier's dock vista
grew from 473k to 1,000k+ triangles and the balanced tier's from 1,191k to
1,926k.

This builds `<name>_far.glb` next to each source by decimating the SOURCE GLB
(not the Blender build scene: the exported file is the one true shape, with its
baked COLOR_0 AO, root transforms and material names). InstanceLod swaps a batch
to the far geometry once the island's edge is beyond a per-tier distance; the
near geometry is untouched, so nothing a player can walk up to changes.

Run headless, one process, never while a browser probe runs:
    /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_far_lods.py
BR_EXPORT_DIR redirects the output (defaults to public/assets/models).
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _helpers import EXPORT_DIR  # noqa: E402

SRC_DIR = os.path.join(HERE, '..', '..', 'public', 'assets', 'models')

# ratio = fraction of triangles kept. Plants go back to roughly their pre-pass
# counts; rocks and palms further, because their far silhouettes are simple.
FAR = {
    'bush': 0.25, 'bush_berry': 0.25, 'flower_bush': 0.25, 'fern_plant': 0.22,
    'flower_patch': 0.25, 'wildflowers': 0.35,
    'palm_a': 0.3, 'palm_b': 0.3, 'palm_c': 0.3,
    'boulder_a': 0.2, 'boulder_b': 0.2, 'boulder_c': 0.2,
    'searock_a': 0.2, 'searock_b': 0.2, 'searock_c': 0.2,
}


def tri_count(objs):
    total = 0
    for o in objs:
        if o.type != 'MESH':
            continue
        o.data.calc_loop_triangles()
        total += len(o.data.loop_triangles)
    return total


def wipe():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for datum in list(block):
            if datum.users == 0:
                block.remove(datum)


def build(name, ratio):
    wipe()
    src = os.path.abspath(os.path.join(SRC_DIR, f'{name}.glb'))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH']
    tris_before = tri_count(meshes)
    for obj in meshes:
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new('far', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    tris_after = tri_count(meshes)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in imported:
        obj.select_set(True)
    os.makedirs(EXPORT_DIR, exist_ok=True)
    path = os.path.join(EXPORT_DIR, f'{name}_far.glb')
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
    )
    print(f'FAR {name}: {tris_before} -> {tris_after} tris ({ratio:.2f}) -> {path}')


for asset, ratio in FAR.items():
    build(asset, ratio)
print('FAR LODS DONE')
