# FLOOD-LOOP TOOLS (b2.3h, assets-06): the bucket, the plank bundle and the
# claw hammer the player holds for minutes per match while the ship fills.
# They were three.js primitive unions (a 6-sided cylinder + box hammer, an open
# cylinder bucket, a single 24x40 cm box plank). Each is now an authored GLB on
# the hero chain (bake_ao -> tint_pass -> hero_atlas v1; PBR comes in b3.4f).
#
# FRAME (game space; the GLB lands in the SAME frame as the primitive fallback
# in WeaponMeshFactory/MiscMeshFactory so nothing jumps when the file arrives):
#   * tool_bucket : body centred on the origin, bottom y -0.10, RIM UP (+Y) at
#                   y +0.10, rim radius 0.11, bail arcing over the top.
#   * tool_planks : bundle centred on the origin, 0.24 wide (x), 0.40 long (z).
#   * tool_hammer : origin = the GRIP on the haft, haft up +Y, HEAD at +Y
#                   (y 0.16), striking face toward -Z, claw toward +Z.
#
# NODE NAMES ARE AN API: `bucket-water` (the water disc the client shows only
# when the bucket is full), `hammer-head`, `hammer-haft`. Every node also ships
# a decimated `<node>_lod1` (third person, 1.5-3k tris per tool) and
# `<node>_lod2` (~500); the client splits them by suffix.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_tools.py
import os
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_atlas.py')).read())

if os.environ.get('TOOLS_OUT'):
    EXPORT_DIR = os.environ['TOOLS_OUT']  # noqa: F811
ATLAS_SIZE = int(os.environ.get('TOOLS_ATLAS', '512'))

EXTRA = {
    'Oak_Stave':   ((0.36, 0.22, 0.11, 1.0), 0.84, 0.0),
    'Oak_Inner':   ((0.22, 0.13, 0.06, 1.0), 0.92, 0.0),
    'Iron_Hoop':   ((0.15, 0.15, 0.16, 1.0), 0.55, 0.80),
    'Rope_Hemp':   ((0.55, 0.44, 0.28, 1.0), 0.95, 0.0),
    'Pine_Plank':  ((0.54, 0.38, 0.21, 1.0), 0.90, 0.0),
    'Pine_End':    ((0.62, 0.47, 0.30, 1.0), 0.92, 0.0),
    'Hickory':     ((0.47, 0.31, 0.17, 1.0), 0.78, 0.0),
    'Forged_Iron': ((0.20, 0.21, 0.23, 1.0), 0.45, 0.85),
    'Face_Steel':  ((0.46, 0.48, 0.50, 1.0), 0.30, 0.90),
    'Water_Tool':  ((0.16, 0.40, 0.47, 1.0), 0.08, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()
rng = random.Random(20260925)


def put(coll, name, bm, mname, smooth=True):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)


def cylg(coll, name, r1, r2, length, center, axis='y', mname='Forged_Iron', segs=16, cap=True, smooth=True):
    bm = bm_cylinder(r1, r2, length, segs=segs, cap=cap)
    M = Matrix.Translation(G(*center)) @ game_axis_rot(axis)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return put(coll, name, bm, mname, smooth)


def boxg(coll, name, w, h, d, center, mname, cuts=0, bevel=0.0, tilt=None):
    bm = bm_box(w, d, h)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=cuts, use_grid_fill=True)
    M = Matrix.Translation(G(*center)) @ (tilt or Matrix.Identity(4))
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    o = put(coll, name, bm, mname, smooth=False)
    if bevel:
        bevel_obj(o, width=bevel, segments=2)
        apply_modifiers(o)
    return o


def ring_pts(coll, name, pts_game, r, mname, segs=8):
    return chain_pts(coll, name, [G(*p) for p in pts_game], r, r, mat(mname), segs=segs)


# ── bucket: 16 coopered staves, two iron hoops, rope bail ─────
def build_bucket():
    coll = asset_collection('tool_bucket')
    body, water = [], []
    y0, y1 = -0.10, 0.10
    r0, r1 = 0.084, 0.110          # outer radius at bottom / rim
    th = 0.012                     # stave thickness
    n, gap = 16, math.radians(0.9)
    around, up = 4, 10
    for i in range(n):
        a0 = i * 2 * math.pi / n + gap * 0.5
        a1 = (i + 1) * 2 * math.pi / n - gap * 0.5
        jitter = rng.uniform(-0.004, 0.004)   # hand-cut staves do not match
        bm = bmesh.new()
        grid = []
        for k in range(up + 1):
            t = k / up
            y = y0 + (y1 - y0) * t + (jitter if k == up else 0.0)
            belly = 0.004 * math.sin(math.pi * t)
            ro = r0 + (r1 - r0) * t + belly
            row_o, row_i = [], []
            for j in range(around + 1):
                a = a0 + (a1 - a0) * j / around
                row_o.append(bm.verts.new(G(ro * math.cos(a), y, ro * math.sin(a))))
                row_i.append(bm.verts.new(G((ro - th) * math.cos(a), y, (ro - th) * math.sin(a))))
            grid.append((row_o, row_i))
        for k in range(up):
            (o0, i0), (o1, i1) = grid[k], grid[k + 1]
            for j in range(around):
                bm.faces.new((o0[j], o0[j + 1], o1[j + 1], o1[j]))
                bm.faces.new((i0[j + 1], i0[j], i1[j], i1[j + 1]))
            for side in (0, around):  # stave edges (the joint the gap shows)
                bm.faces.new((o0[side], o1[side], i1[side], i0[side]))
        for k in (0, up):             # end grain top and bottom
            o, ii = grid[k]
            for j in range(around):
                bm.faces.new((o[j], o[j + 1], ii[j + 1], ii[j]))
        body.append(put(coll, f'stave_{i:02d}', bm, 'Oak_Stave', smooth=False))
    # croze-set bottom and the dark inner floor
    body.append(cylg(coll, 'bottom', r0 - th + 0.001, r0 - th + 0.001, 0.016, (0, y0 + 0.018, 0), 'y', 'Oak_Inner', segs=32))
    # iron hoops hugging the staves (radius follows the taper)
    for y in (-0.072, 0.074):
        t = (y - y0) / (y1 - y0)
        R = r0 + (r1 - r0) * t + 0.004 * math.sin(math.pi * t) + 0.003
        bm = bm_torus(R, 0.0045, segs=40, rings=6)
        bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.9)), verts=bm.verts)  # a flat band, not a wire
        bmesh.ops.transform(bm, matrix=Matrix.Translation(G(0, y, 0)), verts=bm.verts)
        body.append(put(coll, f'hoop_{y:+.2f}', bm, 'Iron_Hoop'))
        for a in (0.4, 2.6, 4.4):  # rivets
            bm = bm_icosphere(0.0035, subdiv=1)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(G((R + 0.004) * math.cos(a), y, (R + 0.004) * math.sin(a))), verts=bm.verts)
            body.append(put(coll, f'rivet_{y:+.2f}_{a}', bm, 'Iron_Hoop'))
    # two raised ear staves carry the bail
    for s in (-1, 1):
        body.append(boxg(coll, f'ear_{s}', 0.014, 0.05, 0.03, (s * (r1 - 0.004), y1 + 0.012, 0), 'Oak_Stave', cuts=1, bevel=0.003))
    # rope bail: a sagging hemp arc from ear to ear, knotted at each end
    pts = []
    for k in range(15):
        t = k / 14
        x = -(r1 + 0.004) + 2 * (r1 + 0.004) * t
        pts.append((x, y1 + 0.03 + 0.085 * math.sin(math.pi * t), 0.0))
    body.extend(ring_pts(coll, 'bail', pts, 0.0065, 'Rope_Hemp', segs=8))
    for s in (-1, 1):
        bm = bm_icosphere(0.011, subdiv=2)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(G(s * (r1 + 0.012), y1 + 0.03, 0)), verts=bm.verts)
        body.append(put(coll, f'knot_{s}', bm, 'Rope_Hemp'))
    # the water disc, its own node and its own material (never baked)
    wy = 0.045
    rw = (r0 + (r1 - r0) * (wy - y0) / (y1 - y0)) - th - 0.001
    bm = bm_cylinder(rw, rw, 0.006, segs=32)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(G(0, wy, 0)), verts=bm.verts)
    water.append(put(coll, 'bucket-water', bm, 'Water_Tool'))
    return coll, {'bucket-body': body}, ('bucket-water',), dict(roughness=0.8, metallic=0.0)


# ── plank bundle: three rough-sawn planks and two rope ties ──
def build_planks():
    coll = asset_collection('tool_planks')
    parts = []
    th = 0.018
    for i in range(3):
        y = -0.02 + i * (th + 0.001)
        dz = rng.uniform(-0.018, 0.018)
        dx = rng.uniform(-0.006, 0.006)
        L = 0.40 + rng.uniform(-0.02, 0.01)
        bm = bm_box(0.235, L, th)
        bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=7, use_grid_fill=True)
        for v in bm.verts:  # saw kerf ripple on the faces, a little cup across the width
            v.co.z += 0.0012 * math.sin(v.co.y * 90 + i) + 0.002 * (v.co.x / 0.12) ** 2
            v.co.x += rng.uniform(-0.0007, 0.0007)
        tilt = Matrix.Rotation(rng.uniform(-0.03, 0.03), 4, 'Z')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(G(dx, y, dz)) @ tilt, verts=bm.verts)
        parts.append(put(coll, f'plank_{i}', bm, 'Pine_Plank', smooth=False))
        for s in (-1, 1):  # paler sawn end grain
            parts.append(boxg(coll, f'end_{i}_{s}', 0.232, th * 0.96, 0.003, (dx, y, dz + s * (L * 0.5 + 0.001)), 'Pine_End', cuts=2))
    top = -0.02 + 2 * (th + 0.001) + th * 0.5
    bot = -0.02 - th * 0.5
    for z in (-0.12, 0.12):  # hemp tie cinched around the stack
        pts = [(-0.124, bot - 0.004, z), (-0.126, top + 0.004, z), (0.126, top + 0.004, z), (0.124, bot - 0.004, z), (-0.124, bot - 0.004, z)]
        dense = []
        for a, b in zip(pts[:-1], pts[1:]):
            for k in range(4):
                t = k / 4
                dense.append(tuple(a[c] + (b[c] - a[c]) * t for c in range(3)))
        dense.append(pts[-1])
        parts.extend(ring_pts(coll, f'tie_{z:+.2f}', dense, 0.005, 'Rope_Hemp', segs=8))
        bm = bm_icosphere(0.009, subdiv=2)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(G(0.02, top + 0.009, z)), verts=bm.verts)
        parts.append(put(coll, f'tieknot_{z:+.2f}', bm, 'Rope_Hemp'))
    return coll, {'planks-body': parts}, (), dict(roughness=0.88, metallic=0.0)


# ── claw hammer: forged head, octagonal hickory haft, wedge ──
def build_hammer():
    coll = asset_collection('tool_hammer')
    haft, head = [], []
    # octagonal haft, swelling at the grip, necking under the head
    prof = [(-0.165, 0.019), (-0.15, 0.021), (-0.09, 0.020), (-0.02, 0.017), (0.06, 0.014), (0.12, 0.013), (0.14, 0.0135), (0.185, 0.0135)]
    bm = bmesh.new()
    dense = []
    for (ya, ra), (yb, rb) in zip(prof[:-1], prof[1:]):
        for k in range(6):
            t = k / 6
            dense.append((ya + (yb - ya) * t, ra + (rb - ra) * t + 0.0004 * math.sin(k * 1.7)))
    dense.append(prof[-1])
    rows = []
    for y, r in dense:
        rows.append([bm.verts.new(G(r * math.cos(a) * 0.82, y, r * math.sin(a))) for a in (k * math.pi / 4 + math.pi / 8 for k in range(8))])
    for a, b in zip(rows[:-1], rows[1:]):
        for k in range(8):
            bm.faces.new((a[k], a[(k + 1) % 8], b[(k + 1) % 8], b[k]))
    bm.faces.new(list(reversed(rows[0])))
    bm.faces.new(rows[-1])
    haft.append(put(coll, 'haft', bm, 'Hickory', smooth=False))
    hy = 0.16
    # eye block (forged, bevelled) around the haft top
    head.append(boxg(coll, 'eye', 0.034, 0.05, 0.04, (0, hy, 0.0), 'Forged_Iron', cuts=3, bevel=0.005))
    # wedge driven into the haft end, flush with the eye top
    head.append(boxg(coll, 'wedge', 0.004, 0.006, 0.026, (0, hy + 0.027, 0), 'Hickory', bevel=0.001))
    # neck + round striking face toward -Z
    head.append(cylg(coll, 'neck', 0.013, 0.016, 0.03, (0, hy, -0.034), 'z', 'Forged_Iron', segs=40))
    head.append(cylg(coll, 'poll', 0.0185, 0.0185, 0.022, (0, hy, -0.059), 'z', 'Forged_Iron', segs=48))
    bm = bm_cylinder(0.0185, 0.016, 0.004, segs=48)  # chamfered face
    bmesh.ops.transform(bm, matrix=Matrix.Translation(G(0, hy, -0.072)) @ game_axis_rot('z'), verts=bm.verts)
    head.append(put(coll, 'face', bm, 'Face_Steel'))
    # split claw curving down toward the haft (+Z)
    for s in (-1, 1):
        pts = []
        for k in range(17):
            t = k / 16
            pts.append((s * (0.0045 + 0.002 * t), hy + 0.008 - 0.052 * t * t, 0.018 + 0.07 * math.sin(t * math.pi * 0.42)))
        head.extend(chain_pts(coll, f'claw_{s}', [G(*p) for p in pts], 0.0085, 0.0028, mat('Forged_Iron'), segs=20))
    return coll, {'hammer-head': head, 'hammer-haft': haft}, (), dict(roughness=0.55, metallic=0.35)


LOD_TARGET = {'tool_bucket': (2400, 520), 'tool_planks': (1600, 480), 'tool_hammer': (1800, 480)}


def _tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def add_lods(coll, name):
    """<node>_lod1 / <node>_lod2: weld, then collapse-decimate a copy (the weld
    matters: decimating unwelded primitives deletes faces, the rocks lesson)."""
    src = [o for o in coll.objects if o.type == 'MESH' and not o.name.endswith(('_lod1', '_lod2'))]
    total = sum(_tris(o) for o in src)
    for li, target in enumerate(LOD_TARGET[name], start=1):
        ratio = min(1.0, target / max(1, total))
        for o in src:
            c = o.copy()
            c.data = o.data.copy()
            c.name = f'{o.name}_lod{li}'
            coll.objects.link(c)
            bm = bmesh.new()
            bm.from_mesh(c.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
            bm.to_mesh(c.data)
            bm.free()
            if o.name == 'bucket-water':
                continue  # a disc is already minimal
            decimate(c, max(0.08, ratio))
            apply_modifiers(c)


SPEC = tint_spec(moss=0.0, damp=False)
SPEC['*'] = dict(tone=0.10, mottle=0.08, mscale=0.45)

for builder in (build_bucket, build_planks, build_hammer):
    coll, groups, keep, look = builder()
    name = coll.name
    bake_ao(coll, samples=18, max_dist=0.4, floor=0.5, height_gradient=0.0)
    tint_pass(coll, SPEC, seed=13, verbose=False)
    hero_atlas(coll, name, size=ATLAS_SIZE, keep=keep, **look)
    for gname, parts in groups.items():
        flat = []
        for p in parts:
            flat.extend(p if isinstance(p, list) else [p])
        flat = [o for o in flat if o.name in bpy.data.objects]
        if len(flat) > 1:
            join(flat, gname)
        else:
            flat[0].name = gname
    add_lods(coll, name)
    for o in coll.objects:
        print(f'TRIS {name} {o.name} {_tris(o)}')
    path = export_collection_vc(coll, f'{name}.glb')
    verify_glb(path)
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)

print('TOOLS DONE')
