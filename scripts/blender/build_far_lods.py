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

THE BASE IS RE-SNAPPED (2026-09-23, b1.1a). An equal-area card is scaled about
its centre, so a curved sheet whose flat extent is smaller than its surface
(a drooping petal, a bent stem blade) comes out LARGER than the sheet and can
reach below the ground the asset stands on: wildflowers_far's base sat at
-0.135 m against its near sibling's 0.0, i.e. the far flowers poked through
the terrain and test-asset-bounds went red. After decimation every far vertex
below the SOURCE's lowest point is lifted onto it (world space, so a node
transform cannot hide it), and verify() fails the build if a far base still
sits under its source base.

Run headless, one process, never while a browser probe runs:
    /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_far_lods.py
BR_EXPORT_DIR redirects the output (defaults to public/assets/models).
BR_FAR_ONLY=wildflowers,bush builds only the named assets (a lane that owns one
far file ships one far file).
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
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR') or EXPORT_DIR  # the docstring's promise; _helpers hard-codes it

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

# THE STORY PROXIES (2026-09-23, b1.1g). The fifteen lazy story tableaux are
# 25-48k triangles each (gibbet_cage 5.6k) and stood behind a flat brown BOX
# until their LOD0 arrived, which on a phone was never "near": every one was
# fetched within 20 s of the horn and held for the whole match. Each now ships
# a 2-4k `<name>_far.glb` proxy that rides the world set and stands until the
# island edge is close enough to want the hero (PropScatterer). Same weld and
# base snap as the nature set and the same integrity bar (area >= 92%, no new
# boundary loop), plus a triangle BAND solved per scene (up to six builds).
#
# The first story build ran the nature recipe (one collapse ratio for every
# part, a closed-part floor of 4, open sheets to single cards) and failed: at
# ~10% Collapse shrinks every thin closed part (area kept 77-95%), a 4-tri
# floor turns a 12-tri plank into a tetrahedron, and single-sided cards on
# sheets that touched other sheets at a vertex split one welded loop into
# several (+1..+3 loops on crow_roost, mermaid_shrine, skull_totem). So the
# story path (build_story_once) is its own recipe:
#   - the triangle budget is shared between loose parts by AREA (a 2 m hull
#     plank gets its share, a coin gets its floor), solved by bisection;
#   - a closed part never goes under 12 triangles (a box stays a box), and a
#     Collapse that opens a closed part is retried at twice the ratio; the
#     one exception is a thin SLAB (a plank, thinnest extent < 1/4 of its
#     width) whose area share cannot buy 12: it becomes a closed double card
#     of its own outline (4 triangles, half its area per side), which at
#     600 m+ is what a plank is, where a tetrahedron is not;
#   - each reduced part is scaled about its centre back to its own source
#     area (capped at 1.3x linear): Collapse shrinks convex shapes inward, the
#     rescale is what a quadric decimator does not do for you;
#   - an open sheet (sail, cloth, net, fin) is reduced (card when tiny) and
#     then CLOSED by a reversed back copy at the same positions: zero-
#     thickness, no boundary once welded, and visible from both sides, which
#     a single-sided sheet is not. The back copy is not counted as surface:
#     verify() grades the VISIBLE area (each sheet once), so the node gate's
#     figure (which counts both sides) is always the looser of the two;
#   - parts too small to afford their floor are dropped smallest-first, never
#     more than 4% of the scene's surface in total (a coin at 600 m+ is well
#     under a pixel).
STORY = [
    'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
    'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp',
    'kraken_wreck', 'dig_site', 'gallows', 'parley_table',
    'mine_head', 'widow_memorial', 'gibbet_cage',
]
STORY_TRIS = (2000, 4000)
STORY_TARGET = 3000
STORY_COMPACT_TARGET = 3600
STORY_MIN_CLOSED_TRIS = 12
STORY_MAX_DROP = 0.04
STORY_RESCALE_CAP = 1.3
# The story set is built only when asked for (BR_FAR_STORY=1, or named in
# BR_FAR_ONLY): a default nature rebuild must not depend on it.
STORY_FAR = {_n: (None, 'card') for _n in STORY}


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


def card_from_part(part, area_scale=1.0):
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
    scale = math.sqrt(area * area_scale / (w * h))
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


def decimate_per_part(obj, ratio, sheets, floor=MIN_CLOSED_TRIS):
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
            mod.ratio = max(ratio, min(1.0, floor / max(1, tris)))
            mod.use_collapse_triangulate = True
            apply_modifier(part, mod)
    bpy.ops.object.select_all(action='DESELECT')
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if len(parts) > 1:
        bpy.ops.object.join()
    return obj


def world_min_z(objs):
    zmin = math.inf
    for obj in objs:
        m = obj.matrix_world
        for v in obj.data.vertices:
            z = (m @ v.co).z
            if z < zmin:
                zmin = z
    return zmin


def snap_base(obj, zmin):
    """Lift every vertex under the source's lowest point onto it (world
    space). Returns how many moved. See THE BASE IS RE-SNAPPED above."""
    m = obj.matrix_world
    inv = m.inverted()
    moved = 0
    for v in obj.data.vertices:
        w = m @ v.co
        if w.z < zmin - 1e-6:
            w.z = zmin
            v.co = inv @ w
            moved += 1
    if moved:
        obj.data.update()
    return moved


def tetra_from_part(part):
    """Replace a small closed part with a closed 4-triangle tetrahedron on
    four alternating corners of its oriented (PCA) bounding box: a cube
    becomes the inscribed regular tetrahedron (58% of its area before the
    rescale), a beam a full-length wedge. Material, smooth flag and colour
    layers by the same majority/mean rule as card_from_part, flat shaded;
    outward winding by the centroid test."""
    me = part.data
    bm = bmesh.new()
    bm.from_mesh(me)
    faces = list(bm.faces)
    verts = list(bm.verts)
    if len(faces) < 4 or len(verts) < 4:
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
    pts = np.array([v.co[:] for v in verts])
    centroid = pts.mean(axis=0)
    rel = pts - centroid
    _u, _s, vt = np.linalg.svd(rel, full_matrices=False)
    proj = rel @ vt.T
    lo, hi = proj.min(axis=0), proj.max(axis=0)
    if float(np.min(hi - lo)) < 1e-6:
        bm.free()
        return
    mid = (lo + hi) / 2
    half = (hi - lo) / 2
    corners = []
    for sx, sy, sz in ((-1, -1, -1), (1, 1, -1), (1, -1, 1), (-1, 1, 1)):
        local = mid + half * np.array([sx, sy, sz])
        corners.append(Vector((centroid + local @ vt).tolist()))
    centre = sum(corners, Vector((0.0, 0.0, 0.0))) / 4
    bmesh.ops.delete(bm, geom=verts, context='VERTS')
    vs = [bm.verts.new(co) for co in corners]
    new_faces = []
    for a, b, c in ((0, 1, 2), (0, 3, 1), (0, 2, 3), (1, 3, 2)):
        f = bm.faces.new((vs[a], vs[b], vs[c]))
        f.normal_update()
        fc = (vs[a].co + vs[b].co + vs[c].co) / 3
        if f.normal.dot(fc - centre) < 0:
            bmesh.ops.reverse_faces(bm, faces=[f])
        f.material_index = mat
        f.smooth = False  # four facets, never a smooth-shaded blob
        new_faces.append(f)
    for f in new_faces:
        for (kind, layer), val in avg.items():
            if kind == 'loop':
                for lp in f.loops:
                    lp[layer] = val
    for (kind, layer), val in avg.items():
        if kind == 'vert':
            for v in vs:
                v[layer] = val
    bm.to_mesh(me)
    bm.free()
    me.update()


def build(name, ratio, sheets):
    if ratio is not None:
        return build_once(name, ratio, sheets, MIN_CLOSED_TRIS)
    # Story proxy: solve the triangle budget for the band (see STORY).
    lo, hi = STORY_TRIS
    budget = STORY_TARGET
    row = None
    last = None
    for _attempt in range(6):
        row = build_story_once(name, budget)
        far_t = row['far']['tris']
        if far_t == last:
            break  # the floors, not the budget, set the count: another pass changes nothing
        last = far_t
        target = min(STORY_TARGET, 0.37 * row['src']['tris'])  # gibbet_cage is 5.6k: its band is 2000-2240
        if row['compact']:
            # A compact scene spends its spare band on boxes: every triangle
            # over the target turns a tetrahedron back into a brick (a wall
            # of tetrahedra lets the sky through where a wall of boxes does not).
            target = min(STORY_COMPACT_TARGET, 0.37 * row['src']['tris'])
        print(f"  story {name}: budget {budget} -> {far_t} tris, visible area {row['far']['area'] / max(1e-9, row['src']['area']):.1%}, loops {row['src']['loops']} -> {row['far']['loops']}, dropped {row['dropped']} part(s) {row['dropped_share']:.1%}")
        if lo <= far_t <= hi and far_t <= 0.4 * row['src']['tris'] and (not row['compact'] or far_t >= 0.9 * target):
            break
        budget = max(400, int(budget * target / max(1, far_t)))
    return row


def world_co(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]


def world_tris(obj):
    me = obj.data
    me.calc_loop_triangles()
    idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get('vertices', idx)
    return idx.reshape(-1, 3)


def world_area(obj):
    co = world_co(obj)
    t = world_tris(obj)
    if len(t) == 0:
        return 0.0
    a, b, c = co[t[:, 0]], co[t[:, 1]], co[t[:, 2]]
    return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


def census(objs):
    """The node gate's census, in Blender: world positions welded by rounding
    to WELD over the WHOLE file, then triangles, area, and boundary loops
    (edges with one face, chained through shared vertices)."""
    q = 1.0 / WELD
    keymap = {}
    tris = 0
    area = 0.0
    edge_count = Counter()
    for obj in objs:
        co = world_co(obj)
        t = world_tris(obj)
        keys = np.round(co * q).astype(np.int64)
        ids = [keymap.setdefault(tuple(k), len(keymap)) for k in keys.tolist()]
        if len(t):
            a, b, c = co[t[:, 0]], co[t[:, 1]], co[t[:, 2]]
            area += float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())
        for tri in t.tolist():
            x, y, z = ids[tri[0]], ids[tri[1]], ids[tri[2]]
            tris += 1
            if x == y or y == z or x == z:
                continue
            for u, v in ((x, y), (y, z), (z, x)):
                edge_count[(u, v) if u < v else (v, u)] += 1
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    for (u, v), n in edge_count.items():
        if n != 1:
            continue
        parent.setdefault(u, u)
        parent.setdefault(v, v)
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    loops = len({find(v) for v in parent})
    return {'tris': tris, 'area': area, 'loops': loops}


def rescale_to_area(part, area_src):
    """Scale a reduced part about its bounding-box centre back to its source
    area (capped): Collapse pulls convex surfaces inward."""
    a = world_area(part)
    if a <= 1e-12 or a >= area_src:
        return
    s = min(STORY_RESCALE_CAP, math.sqrt(area_src / a))
    me = part.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    c = (co.min(axis=0) + co.max(axis=0)) / 2
    co = c + (co - c) * s
    me.vertices.foreach_set('co', co.ravel())
    me.update()


def is_slab(part):
    """A closed part whose thinnest principal extent is under a quarter of
    its middle one: a plank, a board, a lid."""
    co = world_co(part)
    if len(co) < 4:
        return False
    rel = co - co.mean(axis=0)
    _u, _s, vt = np.linalg.svd(rel, full_matrices=False)
    ext = [float(np.ptp(rel @ vt[k])) for k in range(3)]
    return ext[2] < 0.25 * ext[1]


def close_sheet(part):
    """Give an open sheet a reversed back copy at the same positions: once
    welded every boundary edge has two faces, so the sheet closes (zero
    thickness) and draws from both sides. Colours, UVs and materials ride the
    duplicate; the copy owns its own vertices, so smooth normals never
    average front against back."""
    me = part.data
    bm = bmesh.new()
    bm.from_mesh(me)
    faces = list(bm.faces)
    dup = bmesh.ops.duplicate(bm, geom=list(bm.verts) + list(bm.edges) + faces)
    back = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMFace)]
    bmesh.ops.reverse_faces(bm, faces=back)
    bm.to_mesh(me)
    bm.free()
    me.update()


def collapse(part, ratio):
    mod = part.modifiers.new('far', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    apply_modifier(part, mod)


def tri_count(me):
    return sum(max(0, len(p.vertices) - 2) for p in me.polygons)


def build_story_once(name, budget):
    wipe()
    src = os.path.abspath(os.path.join(SRC_DIR, f'{name}.glb'))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH']
    src_base = world_min_z(meshes)
    flat_faces = 0
    faces_total = 0
    groups = []
    for obj in meshes:
        me = obj.data
        flags = flat_face_flags(me)
        flat_faces += sum(flags)
        faces_total += len(flags)
        clear_custom_normals(obj)
        me.polygons.foreach_set('use_smooth', [not f for f in flags])
        weld(me)
    src_stats = census(meshes)
    for obj in meshes:
        existing = set(bpy.data.objects)
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='LOOSE')
        bpy.ops.object.mode_set(mode='OBJECT')
        groups.append((obj, [obj] + [o for o in bpy.data.objects if o not in existing and o.type == 'MESH']))
    info = []
    for _obj, parts in groups:
        for part in parts:
            t = tri_count(part.data)
            opened = has_boundary(part.data)
            slab = not opened and is_slab(part)
            full = t * (2 if opened else 1)
            floor = min(full, 4 if (opened or slab) else STORY_MIN_CLOSED_TRIS)
            info.append({'part': part, 'open': opened, 'slab': slab, 'tris': t, 'area': world_area(part), 'full': full, 'floor': floor, 'drop': False})
    total_area = sum(i['area'] for i in info)

    def drop_smallest():
        # Drop the smallest parts while the floors alone would eat the budget.
        for i in info:
            i['drop'] = False
        dropped = 0.0
        for i in sorted(info, key=lambda x: x['area']):
            if sum(j['floor'] for j in info if not j['drop']) <= 0.6 * budget:
                break
            if dropped + i['area'] > STORY_MAX_DROP * total_area:
                break
            i['drop'] = True
            dropped += i['area']
        return dropped

    dropped_area = drop_smallest()
    # FLOOR-BOUND scenes (kraken_wreck: 459 closed parts, widow_memorial: 356
    # twelve-triangle stones): the 12-tri box floor alone is over the band
    # even after the 4% drop. There, and only there, a compact closed part
    # whose share cannot buy a box becomes a closed 4-tri TETRAHEDRON on four
    # alternating corners of its own oriented bounding box (the solid a
    # stone or a beam is at 600 m+; a stick keeps its full length and
    # diagonal), rescaled to its area like every other part. Scenes that fit
    # the band never enter this path, so their proxies are unchanged.
    compact = sum(j['floor'] for j in info if not j['drop']) > STORY_TRIS[1]
    if compact:
        for i in info:
            if not i['open'] and not i['slab']:
                i['floor'] = min(i['full'], 4)
        dropped_area = drop_smallest()
        # Bricks before detail: the biggest compact parts buy their box back
        # (floor 12) while the floors stay under 3/4 of the budget, so a
        # wall keeps its bricks and the statue, not the wall, gives way.
        room = 0.75 * budget - sum(j['floor'] for j in info if not j['drop'])
        for i in sorted(info, key=lambda x: -x['area']):
            if i['drop'] or i['open'] or i['slab'] or i['full'] < STORY_MIN_CLOSED_TRIS or i['floor'] >= STORY_MIN_CLOSED_TRIS:
                continue
            if room < STORY_MIN_CLOSED_TRIS - i['floor']:
                break
            room -= STORY_MIN_CLOSED_TRIS - i['floor']
            i['floor'] = STORY_MIN_CLOSED_TRIS
    kept = [i for i in info if not i['drop']]

    def cost(k):
        return sum(min(i['full'], max(i['floor'], k * i['area'])) for i in kept)

    lo_k, hi_k = 0.0, 1.0
    while cost(hi_k) < budget and hi_k < 1e9:
        hi_k *= 2
    for _ in range(50):
        mid = (lo_k + hi_k) / 2
        if cost(mid) < budget:
            lo_k = mid
        else:
            hi_k = mid
    visible = 0.0
    for i in info:
        part = i['part']
        if i['drop']:
            bm = bmesh.new()
            bm.from_mesh(part.data)
            bmesh.ops.delete(bm, geom=list(bm.verts), context='VERTS')
            bm.to_mesh(part.data)
            bm.free()
            continue
        b = min(i['full'], max(i['floor'], lo_k * i['area']))
        target = b / 2 if i['open'] else b
        if i['open'] and (target <= 4 or i['tris'] <= 8) and i['tris'] > 2:
            card_from_part(part)
        elif i['slab'] and b < STORY_MIN_CLOSED_TRIS:
            # A thin closed plank that cannot afford a box: a closed double
            # card, each side half the plank's area (both sides are surface
            # here, as both faces of the plank were), never a tetrahedron.
            card_from_part(part, 0.5)
            rescale_to_area(part, i['area'] / 2)
            visible += 2 * world_area(part)
            close_sheet(part)
            continue
        elif compact and not i['open'] and b < STORY_MIN_CLOSED_TRIS and i['tris'] > 4:
            tetra_from_part(part)
            i['tetra'] = True
        elif target < i['tris']:
            ratio = target / i['tris']
            if i['open']:
                collapse(part, ratio)
            else:
                orig = part.data.copy()
                for _try in range(4):
                    collapse(part, ratio)
                    if not has_boundary(part.data):
                        break
                    part.data = orig.copy()
                    ratio = min(1.0, ratio * 2)
                    if ratio >= 1.0:
                        break
        rescale_to_area(part, i['area'])
        visible += world_area(part)
        if i['open']:
            close_sheet(part)
        i['alloc'] = b
        i['got'] = tri_count(part.data)
    if os.environ.get('BR_STORY_DIAG'):
        k = [i for i in info if 'got' in i]
        print(f"  diag {name}: parts {len(info)} kept {len(k)} floors {sum(i['floor'] for i in k)} alloc {sum(i['alloc'] for i in k):.0f} got {sum(i['got'] for i in k)}"
              f" | open {sum(1 for i in k if i['open'])} slab {sum(1 for i in k if i['slab'])} at-floor {sum(1 for i in k if i['alloc'] <= i['floor'])}"
              f" | compact {compact} tetra {sum(1 for i in k if i.get('tetra'))}")
        for i in sorted(k, key=lambda x: x['alloc'] - x['got'])[:4]:
            print(f"    over: tris {i['tris']} alloc {i['alloc']:.0f} got {i['got']} open {i['open']} slab {i['slab']} area {i['area']:.3f}")
    for obj, parts in groups:
        bpy.ops.object.select_all(action='DESELECT')
        for part in parts:
            part.select_set(True)
        bpy.context.view_layer.objects.active = obj
        if len(parts) > 1:
            bpy.ops.object.join()
    snapped = sum(snap_base(obj, src_base) for obj in meshes)
    gate = census(meshes)
    far_stats = {'tris': gate['tris'], 'area': visible, 'loops': gate['loops']}
    bpy.ops.object.select_all(action='DESELECT')
    for obj in imported:
        obj.select_set(True)
    path = export_selected(name)
    return {
        'name': name, 'ratio': None, 'sheets': 'closed', 'path': path,
        'flat_share': flat_faces / max(1, faces_total),
        'src': src_stats, 'far': far_stats, 'gate_area': gate['area'],
        'compact': compact,
        'dropped': sum(1 for i in info if i['drop']), 'dropped_share': dropped_area / max(1e-9, total_area),
        'src_base': src_base, 'far_base': world_min_z(meshes), 'snapped': snapped,
    }


def build_once(name, ratio, sheets, floor):
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
    src_base = world_min_z(meshes)
    snapped = 0
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
        decimate_per_part(obj, ratio, sheets, floor)
        snapped += snap_base(obj, src_base)
        f = surface_stats(obj.data)
        for k in far_stats:
            far_stats[k] += f[k]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in imported:
        obj.select_set(True)
    path = export_selected(name)
    return {
        'name': name, 'ratio': ratio, 'sheets': sheets, 'path': path,
        'flat_share': flat_faces / max(1, faces_total),
        'src': src_stats, 'far': far_stats,
        'src_base': src_base, 'far_base': world_min_z(meshes), 'snapped': snapped,
    }


def export_selected(name):
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
    return path


def verify(rows):
    """FAIL the build on the two things a picture would show: a rock with an
    open edge, or a far surface that lost more than 8% of its area."""
    print('')
    print(f"{'asset':>14} {'ratio':>5} {'sheet':>5} {'flat':>5} {'src tris':>8} {'far tris':>8} {'keep':>5} {'src loops':>9} {'far loops':>9} {'src area':>9} {'far area':>9} {'area%':>6} {'base':>7} {'snap':>5}  verdict")
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
        if r['name'] in STORY and not (STORY_TRIS[0] <= f['tris'] <= STORY_TRIS[1]):
            problems.append(f"story proxy {f['tris']} tris outside {STORY_TRIS[0]}-{STORY_TRIS[1]}")
        if r['far_base'] < r['src_base'] - 1e-4:
            problems.append(f"far base {r['far_base']:.3f} under source base {r['src_base']:.3f}")
        verdict = 'ok' if not problems else 'FAIL: ' + '; '.join(problems)
        if problems:
            failed.append(r['name'])
        sheets = '-' if r['sheets'] is None else r['sheets']
        print(f"{r['name']:>14} {r['ratio'] if r['ratio'] is not None else 0:>5.3f} {sheets:>5} {r['flat_share']:>5.0%} {s['tris']:>8} {f['tris']:>8} {keep:>5.0%} {s['loops']:>9} {f['loops']:>9} {s['area']:>9.2f} {f['area']:>9.2f} {area_keep:>6.0%} {r['far_base']:>7.3f} {r['snapped']:>5}  {verdict}")
    return failed


ONLY = {n.strip() for n in os.environ.get('BR_FAR_ONLY', '').split(',') if n.strip()}
WANT_STORY = os.environ.get('BR_FAR_STORY') == '1' or bool(ONLY & set(STORY_FAR))
if WANT_STORY:
    FAR.update(STORY_FAR)
unknown = ONLY - set(FAR) - set(STORY_FAR)
if unknown:
    print(f"BR_FAR_ONLY names no far asset: {', '.join(sorted(unknown))}")
    sys.exit(1)
rows = [build(asset, ratio, sheets) for asset, (ratio, sheets) in FAR.items() if not ONLY or asset in ONLY]
failed = verify(rows)
if failed:
    print(f"FAR LODS FAILED: {', '.join(failed)}")
    sys.exit(1)
print('FAR LODS DONE')
