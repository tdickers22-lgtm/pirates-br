"""Far-distance LOD variants for the rebuilt nature GLBs (lane I.2, fixed [rocks]).

The 2026-09-05 fidelity pass rebuilt fifteen nature assets at 1.2-4.8x their
old triangle counts. That detail is real geometry and it is what the player
sees up close; it is also what a wide vista pays for on every island in the
frustum, where a 5.6k-triangle palm covers a dozen pixels. InstanceLod thins
COUNTS with distance but never swapped GEOMETRY, so the low tier's dock vista
grew from 473k to 1,000k+ triangles and the balanced tier's from 1,191k to
1,926k.

This builds `<name>_far.glb` next to each source by decimating the SOURCE GLB
(not the Blender build scene: the exported file is the one true shape, with its
baked COLOR_0 AO, root transforms and material names).

WHY THE WELD (2026-09-09). The first version applied Collapse straight to the
imported export. The rocks are flat-shaded, so the exporter wrote SPLIT
vertices — every triangle owning its own three — and Collapse, which works by
merging the two ends of a SHARED edge, found no shared edge anywhere. What it
did instead was delete faces: boulder_a's far file kept 20% of the triangles
and 42% of the surface, with 76 boundary loops where the source has none, and
on the low tier (which drew the far mesh at every distance) the player looked
through the rocks. So now, per object: read which faces the source shaded
flat, drop the imported custom normals, weld positions at 1e-4 so the surface
is one connected sheet, THEN decimate, and let the exporter re-split normals
on the faces that were flat. The far file ships the same normal style as its
near sibling, which is what keeps the swap from popping.

THE BUILD VERIFIES ITSELF. After decimation the welded far surface is graded
against the welded source — boundary loops and total area — and the build
FAILS (exit 1, no silent "done") if a rock gained any boundary loop or any
asset kept under 92% of its surface. scripts/test-far-lod-integrity.mjs runs
the same census on the shipped files without Blender.

Run headless, one process, never while a browser probe runs:
    /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_far_lods.py
BR_EXPORT_DIR redirects the output (defaults to public/assets/models).
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from collections import Counter
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _helpers import EXPORT_DIR  # noqa: E402

SRC_DIR = os.path.join(HERE, '..', '..', 'public', 'assets', 'models')

WELD = 1e-4
MIN_AREA_KEEP = 0.92
# A closed part is never collapsed below this many triangles. A bush's 31-49
# twig and berry blobs are ~19 triangles each; at the asset's 0.30 they came
# out as 6-triangle lumps and the three bushes lost 11-18% of their surface
# in blobs alone. Twelve keeps a blob a blob; a trunk or a boulder skirt is
# hundreds of triangles and never reaches this floor.
MIN_CLOSED_TRIS = 12
ROCKS = {'boulder_a', 'boulder_b', 'boulder_c', 'searock_a', 'searock_b', 'searock_c'}

# (collapse ratio for CLOSED parts, treatment of OPEN sheets). The ratio is
# the fraction of triangles a closed part keeps, applied to the WELDED mesh;
# rocks are tuned to land at ~800-1200 triangles (their far silhouettes are
# simple, and a watertight 1k-triangle boulder is plenty at 45 m+). Leaf cards
# and fronds are open, CURVED sheets, and no face-count reduction keeps their
# surface: Collapse pulls a card's boundary inward with every step (30% of the
# triangles left 71% of the area, scoped globally or per part), and a planar
# dissolve flattens the curve to its chord and folds thin strips into lines
# (fern 42%). So an open sheet is replaced by ONE flat quad of the same
# surface area ('card') — see card_from_part. A rock has no open sheet.
FAR = {
    'bush': (0.30, 'card'), 'bush_berry': (0.30, 'card'), 'flower_bush': (0.30, 'card'), 'fern_plant': (0.28, 'card'),
    'flower_patch': (0.30, 'card'), 'wildflowers': (0.35, 'card'),
    'palm_a': (0.22, 'card'), 'palm_b': (0.22, 'card'), 'palm_c': (0.22, 'card'),
    'boulder_a': (0.22, None), 'boulder_b': (0.25, None), 'boulder_c': (0.30, None),
    'searock_a': (0.19, None), 'searock_b': (0.19, None), 'searock_c': (0.17, None),
}


def wipe():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for datum in list(block):
            if datum.users == 0:
                block.remove(datum)


def flat_face_flags(me):
    """Which faces the SOURCE shaded flat: every corner normal equals the face
    normal. Read off the imported custom normals before they are dropped."""
    corner = me.corner_normals
    flags = []
    for poly in me.polygons:
        n = poly.normal
        flat = True
        for li in poly.loop_indices:
            if corner[li].vector.dot(n) < 0.999:
                flat = False
                break
        flags.append(flat)
    return flags


def clear_custom_normals(obj):
    me = obj.data
    attr = me.attributes.get('custom_normal')
    if attr is not None:
        me.attributes.remove(attr)
        return
    if getattr(me, 'has_custom_normals', False):
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()


def weld(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
    bm.to_mesh(me)
    bm.free()
    me.update()


def surface_stats(me):
    """Triangles, area and boundary loops of a mesh — the same census the node
    gate runs on the shipped file, so a number printed here is comparable."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    tris = sum(max(0, len(f.verts) - 2) for f in bm.faces)
    area = sum(f.calc_area() for f in bm.faces)
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    boundary_edges = 0
    for e in bm.edges:
        if len(e.link_faces) != 1:
            continue
        boundary_edges += 1
        a, b = e.verts[0].index, e.verts[1].index
        parent.setdefault(a, a)
        parent.setdefault(b, b)
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    loops = len({find(v) for v in parent})
    bm.free()
    return {'tris': tris, 'area': area, 'loops': loops, 'edges': boundary_edges}


def has_boundary(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    open_edge = any(len(e.link_faces) == 1 for e in bm.edges)
    bm.free()
    return open_edge


def apply_modifier(part, mod):
    bpy.ops.object.select_all(action='DESELECT')
    part.select_set(True)
    bpy.context.view_layer.objects.active = part
    bpy.ops.object.modifier_apply(modifier=mod.name)


def card_from_part(part):
    """Replace an open sheet with ONE flat quad of the same surface area.

    Best-fit plane by PCA of the part's vertices, the rectangle spanned by the
    two in-plane principal extents, scaled about its centre so its area equals
    the sheet's; winding follows the sheet's mean normal; material index and
    smooth flag by majority; every colour layer (the baked COLOR_0 AO) is the
    sheet's mean. Two triangles where a card had 16-26 and a frond 10, and at
    45 m+ a leaf is a coloured pixel or two either way.
    """
    me = part.data
    bm = bmesh.new()
    bm.from_mesh(me)
    faces = list(bm.faces)
    verts = list(bm.verts)
    if len(faces) < 1 or len(verts) < 3:
        bm.free()
        return
    area = sum(f.calc_area() for f in faces)
    if area <= 1e-9:
        bm.free()
        return
    avg = {}
    for coll in (bm.loops.layers.color, bm.loops.layers.float_color):
        for _name, layer in coll.items():
            tot = Vector((0.0, 0.0, 0.0, 0.0))
            n = 0
            for f in faces:
                for lp in f.loops:
                    tot += Vector(lp[layer])
                    n += 1
            avg[('loop', layer)] = tot / max(1, n)
    for coll in (bm.verts.layers.color, bm.verts.layers.float_color):
        for _name, layer in coll.items():
            tot = Vector((0.0, 0.0, 0.0, 0.0))
            for v in verts:
                tot += Vector(v[layer])
            avg[('vert', layer)] = tot / max(1, len(verts))
    mat = Counter(f.material_index for f in faces).most_common(1)[0][0]
    smooth = sum(1 for f in faces if f.smooth) * 2 >= len(faces)
    nmean = Vector((0.0, 0.0, 0.0))
    for f in faces:
        nmean += f.normal * f.calc_area()
    pts = np.array([v.co[:] for v in verts])
    centroid = pts.mean(axis=0)
    rel = pts - centroid
    _u, _s, vt = np.linalg.svd(rel, full_matrices=False)
    a1 = Vector(vt[0].tolist())
    a2 = Vector(vt[1].tolist())
    p = rel @ vt[0]
    q = rel @ vt[1]
    w = float(p.max() - p.min())
    h = float(q.max() - q.min())
    if w < 1e-6 or h < 1e-6:
        bm.free()
        return
    scale = math.sqrt(area / (w * h))
    centre = Vector(centroid.tolist()) + a1 * float((p.max() + p.min()) / 2) + a2 * float((q.max() + q.min()) / 2)
    hw = w / 2 * scale
    hh = h / 2 * scale
    corners = [centre - a1 * hw - a2 * hh, centre + a1 * hw - a2 * hh, centre + a1 * hw + a2 * hh, centre - a1 * hw + a2 * hh]
    bmesh.ops.delete(bm, geom=verts, context='VERTS')
    vs = [bm.verts.new(co) for co in corners]
    f = bm.faces.new(vs)
    f.normal_update()
    if f.normal.dot(nmean) < 0:
        bmesh.ops.reverse_faces(bm, faces=[f])
    f.material_index = mat
    f.smooth = smooth
    for (kind, layer), val in avg.items():
        if kind == 'loop':
            for lp in f.loops:
                lp[layer] = val
        else:
            for v in vs:
                v[layer] = val
    bmesh.ops.triangulate(bm, faces=[f])
    bm.to_mesh(me)
    bm.free()
    me.update()


def decimate_per_part(obj, ratio, sheets):
    """Reduce each LOOSE PART on its own: Collapse for closed parts, a flat
    equal-area card for open sheets (when `sheets == 'card'`).

    A bush is 30-50 closed branch pieces plus 56-170 separate leaf cards of
    16-26 triangles that hold ~72% of its surface. Collapse ranks every edge
    collapse by quadric error and a 0.03 m² card's edges are all cheap, so a
    global pass ate whole cards first; a per-part pass at the same ratio kept
    the cards but pulled every boundary inward, and the area came out the
    same 71%; a limited dissolve flattened curved sheets to their chords and
    folded thin strips into lines. None of them can keep a curved sheet's
    area with fewer faces — so the sheet becomes a card of that area.
    """
    existing = set(bpy.data.objects)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    parts = [obj] + [o for o in bpy.data.objects if o not in existing and o.type == 'MESH']
    for part in parts:
        if sheets == 'card' and has_boundary(part.data):
            card_from_part(part)
        else:
            tris = len(part.data.polygons)
            mod = part.modifiers.new('far', 'DECIMATE')
            mod.decimate_type = 'COLLAPSE'
            mod.ratio = max(ratio, min(1.0, MIN_CLOSED_TRIS / max(1, tris)))
            mod.use_collapse_triangulate = True
            apply_modifier(part, mod)
    bpy.ops.object.select_all(action='DESELECT')
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if len(parts) > 1:
        bpy.ops.object.join()
    return obj


def build(name, ratio, sheets):
    wipe()
    src = os.path.abspath(os.path.join(SRC_DIR, f'{name}.glb'))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH']
    src_stats = {'tris': 0, 'area': 0.0, 'loops': 0}
    far_stats = {'tris': 0, 'area': 0.0, 'loops': 0}
    flat_faces = 0
    faces_total = 0
    for obj in meshes:
        me = obj.data
        flags = flat_face_flags(me)
        flat_faces += sum(flags)
        faces_total += len(flags)
        clear_custom_normals(obj)
        # Smooth/flat per FACE, carried through the decimate as a face flag, so
        # the exporter re-splits exactly the faces the source split.
        me.polygons.foreach_set('use_smooth', [not f for f in flags])
        weld(me)
        s = surface_stats(me)
        for k in src_stats:
            src_stats[k] += s[k]
        decimate_per_part(obj, ratio, sheets)
        f = surface_stats(obj.data)
        for k in far_stats:
            far_stats[k] += f[k]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in imported:
        obj.select_set(True)
    os.makedirs(EXPORT_DIR, exist_ok=True)
    path = os.path.join(EXPORT_DIR, f'{name}_far.glb')
    kwargs = dict(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    for extra in ({'export_vertex_color': 'ACTIVE', 'export_all_vertex_colors': False}, {'export_vertex_color': 'ACTIVE'}, {}):
        try:
            bpy.ops.export_scene.gltf(**kwargs, **extra)
            break
        except TypeError:
            continue
    else:
        raise RuntimeError(f'gltf export failed for {name}')
    return {
        'name': name, 'ratio': ratio, 'sheets': sheets, 'path': path,
        'flat_share': flat_faces / max(1, faces_total),
        'src': src_stats, 'far': far_stats,
    }


def verify(rows):
    """FAIL the build on the two things a picture would show: a rock with an
    open edge, or a far surface that lost more than 8% of its area."""
    print('')
    print(f"{'asset':>14} {'ratio':>5} {'sheet':>5} {'flat':>5} {'src tris':>8} {'far tris':>8} {'keep':>5} {'src loops':>9} {'far loops':>9} {'src area':>9} {'far area':>9} {'area%':>6}  verdict")
    failed = []
    for r in rows:
        s, f = r['src'], r['far']
        keep = f['tris'] / max(1, s['tris'])
        area_keep = f['area'] / max(1e-9, s['area'])
        problems = []
        if r['name'] in ROCKS and f['loops'] > 0:
            problems.append(f"rock gained {f['loops']} boundary loop(s)")
        if r['name'] not in ROCKS and f['loops'] > s['loops']:
            problems.append(f"{f['loops']} loops vs source {s['loops']}")
        if area_keep < MIN_AREA_KEEP:
            problems.append(f'area {area_keep:.0%} < {MIN_AREA_KEEP:.0%}')
        if keep > 0.4:
            problems.append(f'keeps {keep:.0%} of the triangles (> 40%)')
        verdict = 'ok' if not problems else 'FAIL: ' + '; '.join(problems)
        if problems:
            failed.append(r['name'])
        sheets = '-' if r['sheets'] is None else r['sheets']
        print(f"{r['name']:>14} {r['ratio']:>5.2f} {sheets:>5} {r['flat_share']:>5.0%} {s['tris']:>8} {f['tris']:>8} {keep:>5.0%} {s['loops']:>9} {f['loops']:>9} {s['area']:>9.2f} {f['area']:>9.2f} {area_keep:>6.0%}  {verdict}")
    return failed


rows = [build(asset, ratio, sheets) for asset, (ratio, sheets) in FAR.items()]
failed = verify(rows)
if failed:
    print(f"FAR LODS FAILED: {', '.join(failed)}")
    sys.exit(1)
print('FAR LODS DONE')
