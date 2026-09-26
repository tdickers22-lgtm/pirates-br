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


# ── b3.4g (assets-06): the rest of the held kit ──────────────
# Same frames as the primitives in WeaponMeshFactory.makePocketPreviewMesh:
#   tool_spyglass : axis Z, EYEPIECE toward -Z (z -0.175), objective +Z (0.265);
#                   the viewmodel turns it rotation.y = PI so the eyepiece faces
#                   the camera. Named tubes: spyglass-eyepiece, spyglass-body
#                   (leather grip barrel), spyglass-tube-1, spyglass-tube-2
#                   (draw tubes, slide along +Z to extend).
#   tool_compass  : case axis Z, dial FACE toward -Z; compass-needle spins about
#                   the local Z axis through the origin (north = +Y); the glass
#                   is its own node + material (compass-glass).
#   tool_lantern  : Y up, base y -0.155, bail on top; lantern-glass and
#                   lantern-flame keep their own (emissive) materials.
#   tool_shovel   : axis Z, D-grip at -Z (-0.44), blade toward +Z (to 0.50).
#   tool_axe      : axis Z, head at z 0.19, blade DOWN (-Y) to y -0.17.
#   tool_food     : food-banana / food-coconut / food-mango / food-meat, each
#                   centred on the origin (a clone keeps one of them).
#   tool_keg      : Y up, body y -0.125..0.125, keg-fuse out of the top (+Y).
#   tool_chest    : body y -0.19..0.07, x 0.46, z 0.30; chest-lid dome above.
KIT = {
    'Brass':        ((0.62, 0.45, 0.17, 1.0), 0.32, 0.90),
    'Leather_Dark': ((0.20, 0.12, 0.06, 1.0), 0.86, 0.0),
    'Lens_Glass':   ((0.06, 0.10, 0.12, 1.0), 0.10, 0.3),
    'Compass_Face': ((0.86, 0.80, 0.64, 1.0), 0.70, 0.0),
    'Compass_Ink':  ((0.16, 0.12, 0.09, 1.0), 0.70, 0.0),
    'Needle_Red':   ((0.70, 0.12, 0.08, 1.0), 0.45, 0.2),
    'Needle_White': ((0.85, 0.84, 0.80, 1.0), 0.45, 0.2),
    'Glass_Compass': ((0.75, 0.88, 1.0, 1.0), 0.05, 0.0),
    'Lantern_Tin':  ((0.19, 0.17, 0.15, 1.0), 0.50, 0.75),
    'Glass_Lantern': ((1.0, 0.82, 0.48, 1.0), 0.15, 0.0),
    'Flame':        ((1.0, 0.80, 0.40, 1.0), 0.5, 0.0),
    'Ash_Handle':   ((0.56, 0.40, 0.24, 1.0), 0.80, 0.0),
    'Blade_Steel':  ((0.38, 0.39, 0.40, 1.0), 0.40, 0.90),
    'Banana_Skin':  ((0.86, 0.68, 0.16, 1.0), 0.50, 0.0),
    'Banana_Stem':  ((0.30, 0.26, 0.12, 1.0), 0.80, 0.0),
    'Coconut_Husk': ((0.33, 0.22, 0.12, 1.0), 0.92, 0.0),
    'Coconut_Eye':  ((0.12, 0.08, 0.05, 1.0), 0.90, 0.0),
    'Mango_Skin':   ((0.84, 0.42, 0.14, 1.0), 0.45, 0.0),
    'Mango_Leaf':   ((0.18, 0.40, 0.14, 1.0), 0.65, 0.0),
    'Meat_Seared':  ((0.42, 0.14, 0.08, 1.0), 0.70, 0.0),
    'Meat_Char':    ((0.16, 0.08, 0.05, 1.0), 0.90, 0.0),
    'Bone':         ((0.86, 0.80, 0.66, 1.0), 0.75, 0.0),
    'Keg_Oak':      ((0.36, 0.22, 0.10, 1.0), 0.88, 0.0),
    'Fuse_Cord':    ((0.12, 0.10, 0.08, 1.0), 0.95, 0.0),
    'Chest_Wood':   ((0.34, 0.19, 0.08, 1.0), 0.80, 0.0),
    'Chest_Brass':  ((0.70, 0.52, 0.20, 1.0), 0.35, 0.85),
}
for k, v in KIT.items():
    PALETTE.setdefault(k, v)


def _pt(axis, c, s, h, center):
    p = (c, h, s) if axis == 'y' else (c, s, h) if axis == 'z' else (h, c, s)
    return G(p[0] + center[0], p[1] + center[1], p[2] + center[2])


def lathe(coll, name, prof, segs, mname, axis='y', center=(0, 0, 0), caps=(True, True), rfn=None, sx=1.0, smooth=True):
    """Surface of revolution along a GAME axis: prof = [(h, r)], rfn(a, h, r) -> r."""
    bm = bmesh.new()
    rows = []
    for h, r in prof:
        row = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            rr = rfn(a, h, r) if rfn else r
            row.append(bm.verts.new(_pt(axis, rr * math.cos(a) * sx, rr * math.sin(a), h, center)))
        rows.append(row)
    for ra, rb in zip(rows[:-1], rows[1:]):
        for k in range(segs):
            bm.faces.new((ra[k], ra[(k + 1) % segs], rb[(k + 1) % segs], rb[k]))
    if caps[0]:
        bm.faces.new(list(reversed(rows[0])))
    if caps[1]:
        bm.faces.new(rows[-1])
    return put(coll, name, bm, mname, smooth)


def sweep(coll, name, pts, radius, sides, mname, rfn=None, caps=True, closed=False, smooth=True):
    """Tube along game-space pts (parallel-transport frame). radius(t) or float; rfn(t, a) scales it."""
    P = [Vector(p) for p in pts]
    n = len(P)
    T = [(P[(i + 1) % n if closed else min(i + 1, n - 1)] - P[(i - 1) % n if closed else max(i - 1, 0)]).normalized() for i in range(n)]
    ref = Vector((0, 1, 0)) if abs(T[0].y) < 0.9 else Vector((1, 0, 0))
    N = (ref - T[0] * ref.dot(T[0])).normalized()
    bm = bmesh.new()
    rows = []
    for i in range(n):
        N = (N - T[i] * N.dot(T[i])).normalized()
        B = T[i].cross(N)
        t = i / (n - 1)
        r0 = radius(t) if callable(radius) else radius
        row = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            r = r0 * (rfn(t, a) if rfn else 1.0)
            q = P[i] + (N * math.cos(a) + B * math.sin(a)) * r
            row.append(bm.verts.new(G(q.x, q.y, q.z)))
        rows.append(row)
    pairs = list(zip(rows[:-1], rows[1:])) + ([(rows[-1], rows[0])] if closed else [])
    for ra, rb in pairs:
        for k in range(sides):
            bm.faces.new((ra[k], ra[(k + 1) % sides], rb[(k + 1) % sides], rb[k]))
    if caps and not closed:
        bm.faces.new(list(reversed(rows[0])))
        bm.faces.new(rows[-1])
    return put(coll, name, bm, mname, smooth)


def plate(coll, name, fn, nu, nv, mname, smooth=False):
    """Closed shell: fn(u, v) -> (centre, half-thickness vector), both game space."""
    bm = bmesh.new()
    top = [[None] * (nv + 1) for _ in range(nu + 1)]
    bot = [[None] * (nv + 1) for _ in range(nu + 1)]
    for i in range(nu + 1):
        for j in range(nv + 1):
            c, d = fn(i / nu, j / nv)
            top[i][j] = bm.verts.new(G(c[0] + d[0], c[1] + d[1], c[2] + d[2]))
            bot[i][j] = bm.verts.new(G(c[0] - d[0], c[1] - d[1], c[2] - d[2]))
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]))
            bm.faces.new((bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]))
    border = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
    for a, b in zip(border, border[1:] + border[:1]):
        bm.faces.new((top[a[0]][a[1]], bot[a[0]][a[1]], bot[b[0]][b[1]], top[b[0]][b[1]]))
    return put(coll, name, bm, mname, smooth)


def blob(coll, name, r, scale, mname, subdiv=3, noise=0.0, seed=0, center=(0, 0, 0), fn=None):
    """Icosphere in game space, scaled, optionally vnoise-displaced or fn(Vector)->Vector."""
    bm = bm_icosphere(1.0, subdiv=subdiv)
    for v in bm.verts:
        g = Vector((v.co.x, v.co.z, -v.co.y))  # blender -> game
        g = Vector((g.x * r * scale[0], g.y * r * scale[1], g.z * r * scale[2]))
        if noise:
            g *= 1.0 + noise * (vnoise(g * 40.0, 1.0, seed) - 0.5)
        if fn:
            g = fn(g)
        v.co = G(g.x + center[0], g.y + center[1], g.z + center[2])
    return put(coll, name, bm, mname)


def ring(coll, name, center, axis, R, r, mname, segs=48, sides=8, arc=2 * math.pi, a0=0.0):
    pts = []
    closed = arc >= 2 * math.pi - 1e-6
    n = segs if closed else segs + 1
    for k in range(n):
        a = a0 + arc * k / segs
        c, s = R * math.cos(a), R * math.sin(a)
        p = (c, 0, s) if axis == 'y' else (c, s, 0) if axis == 'z' else (0, c, s)
        pts.append((p[0] + center[0], p[1] + center[1], p[2] + center[2]))
    return sweep(coll, name, pts, r, sides, mname, closed=closed)


def build_spyglass():
    coll = asset_collection('tool_spyglass')
    S = 64
    eye = [lathe(coll, 'eye_tube', [(-0.176, 0.021), (-0.175, 0.026), (-0.171, 0.031), (-0.160, 0.032), (-0.150, 0.029), (-0.105, 0.029),
                                    (-0.100, 0.032), (-0.092, 0.033), (-0.085, 0.032), (-0.080, 0.031), (-0.070, 0.031)], S, 'Brass', axis='z'),
           lathe(coll, 'eye_lens', [(-0.1768, 0.019), (-0.1762, 0.021)], S, 'Lens_Glass', axis='z')]
    grip = lathe(coll, 'grip', [(-0.076, 0.0355), (-0.074, 0.037), (0.028, 0.037), (0.030, 0.0355)], S, 'Leather_Dark', axis='z',
                 rfn=lambda a, h, r: r + (0.0006 * math.sin(h * 900) if -0.07 < h < 0.025 else 0.0))
    body = [grip]
    for z0, z1 in ((-0.082, -0.068), (0.022, 0.036)):
        body.append(lathe(coll, f'collar_{z0:+.3f}', [(z0, 0.036), (z0 + 0.002, 0.0395), (z1 - 0.002, 0.0395), (z1, 0.036)], S, 'Brass', axis='z'))
    t1 = [lathe(coll, 'tube1', [(0.030, 0.0305), (0.132, 0.0305), (0.135, 0.0335), (0.145, 0.0335), (0.148, 0.031)], S, 'Brass', axis='z')]
    t2 = [lathe(coll, 'tube2', [(0.146, 0.0275), (0.236, 0.0275), (0.240, 0.030), (0.246, 0.0325), (0.262, 0.0325), (0.265, 0.030)], S, 'Brass', axis='z'),
          lathe(coll, 'obj_lens', [(0.2648, 0.0265), (0.2652, 0.0265)], S, 'Lens_Glass', axis='z')]
    for k, z in enumerate((0.05, 0.09)):
        t1.append(ring(coll, f'bead_{k}', (0, 0, z), 'z', 0.0305, 0.0012, 'Brass', segs=S, sides=6))
    return coll, {'spyglass-eyepiece': eye, 'spyglass-body': body, 'spyglass-tube-1': t1, 'spyglass-tube-2': t2}, (), dict(roughness=0.4, metallic=0.6)


def build_compass():
    coll = asset_collection('tool_compass')
    S = 72
    case = [lathe(coll, 'case', [(0.019, 0.058), (0.019, 0.068), (0.017, 0.075), (0.012, 0.079), (0.006, 0.080), (-0.012, 0.080), (-0.016, 0.079),
                                 (-0.019, 0.076), (-0.019, 0.069), (-0.016, 0.068), (-0.010, 0.067), (-0.008, 0.066)], S, 'Brass', axis='z'),
            lathe(coll, 'dial', [(-0.0078, 0.0655), (-0.0086, 0.0655)], S, 'Compass_Face', axis='z')]
    for k in range(16):  # compass rose: 16 ink points, cardinal ones long
        a = k * math.pi / 8
        L = 0.056 if k % 4 == 0 else 0.040 if k % 2 == 0 else 0.028
        w = 0.0065 if k % 4 == 0 else 0.004
        ca, sa = math.cos(a), math.sin(a)

        def fn(u, v, ca=ca, sa=sa, L=L, w=w):
            t = v * L
            ww = w * (1 - v) * (u * 2 - 1)
            return (ca * t - sa * ww, sa * t + ca * ww, -0.0090), (0, 0, 0.0003)
        case.append(plate(coll, f'rose_{k}', fn, 1, 3, 'Compass_Ink'))
    case.append(ring(coll, 'chapter', (0, 0, -0.0090), 'z', 0.060, 0.0009, 'Compass_Ink', segs=S, sides=4))
    case.append(lathe(coll, 'stem', [(0.078, 0.006), (0.080, 0.0075), (0.090, 0.0065), (0.092, 0.005)], 24, 'Brass', axis='y'))
    case.append(ring(coll, 'bow', (0, 0.106, 0), 'z', 0.014, 0.0032, 'Brass', segs=32, sides=10))
    needle = []
    for s, mname in ((1, 'Needle_Red'), (-1, 'Needle_White')):
        def fn(u, v, s=s):
            y = s * 0.050 * v
            w = 0.0055 * (1 - v) ** 1.2 * (u * 2 - 1)
            return (w, y, -0.0125), (0, 0, 0.0007 * (1 - 0.6 * v))
        needle.append(plate(coll, f'needle_{s}', fn, 2, 10, mname))
    needle.append(lathe(coll, 'pivot', [(-0.0105, 0.0035), (-0.0145, 0.0035), (-0.0150, 0.002)], 16, 'Brass', axis='z'))
    lathe(coll, 'compass-glass', [(-0.0170, 0.0675), (-0.0160, 0.0675)], 48, 'Glass_Compass', axis='z')
    return coll, {'compass-body': case, 'compass-needle': needle}, ('compass-glass',), dict(roughness=0.4, metallic=0.55)


def build_lantern():
    coll = asset_collection('tool_lantern')
    S = 48
    body = [lathe(coll, 'base', [(-0.155, 0.098), (-0.155, 0.122), (-0.151, 0.128), (-0.144, 0.130), (-0.134, 0.128), (-0.126, 0.114),
                                 (-0.114, 0.109), (-0.106, 0.104), (-0.100, 0.100), (-0.100, 0.090)], S, 'Lantern_Tin'),
            lathe(coll, 'cap', [(0.086, 0.090), (0.086, 0.106), (0.094, 0.110), (0.108, 0.100), (0.128, 0.080), (0.146, 0.056), (0.152, 0.050),
                                (0.160, 0.046), (0.168, 0.040), (0.178, 0.026), (0.186, 0.012)], S, 'Lantern_Tin'),
            lathe(coll, 'finial', [(0.184, 0.014), (0.192, 0.012), (0.198, 0.008)], 24, 'Lantern_Tin')]
    for k in range(6):
        a = k * math.pi / 3 + math.pi / 6
        x, z = 0.101 * math.cos(a), 0.101 * math.sin(a)
        body.append(sweep(coll, f'bar_{k}', [(x, -0.100 + 0.19 * i / 8, z) for i in range(9)], 0.0055, 8, 'Lantern_Tin'))
    for k, y in enumerate((-0.098, -0.005, 0.084)):
        body.append(ring(coll, f'band_{k}', (0, y, 0), 'y', 0.100, 0.004, 'Lantern_Tin', segs=S, sides=6))
    for s in (-1, 1):  # vent louvres on the cap
        body.append(ring(coll, f'vent_{s}', (0, 0.14, 0), 'y', 0.064, 0.0028, 'Lantern_Tin', segs=S, sides=6))
    body.append(ring(coll, 'bail', (0, 0.196, 0), 'z', 0.052, 0.0045, 'Lantern_Tin', segs=24, sides=8, arc=math.pi, a0=0.0))
    body.append(lathe(coll, 'burner', [(-0.100, 0.030), (-0.080, 0.028), (-0.070, 0.016), (-0.060, 0.008)], 24, 'Brass'))
    lathe(coll, 'lantern-glass', [(-0.099, 0.092), (-0.05, 0.097), (0.0, 0.099), (0.05, 0.097), (0.085, 0.092)], 32, 'Glass_Lantern', caps=(False, False))
    lathe(coll, 'lantern-flame', [(-0.060, 0.004), (-0.050, 0.016), (-0.030, 0.020), (-0.005, 0.015), (0.020, 0.006), (0.030, 0.001)], 16, 'Flame')
    return coll, {'lantern-body': body}, ('lantern-glass', 'lantern-flame'), dict(roughness=0.5, metallic=0.6)


def build_shovel():
    coll = asset_collection('tool_shovel')
    parts = [sweep(coll, 'handle', [(0, 0.002 * math.sin(i * 0.3), -0.40 + 0.63 * i / 36) for i in range(37)],
                   lambda t: 0.019 + 0.005 * t, 16, 'Ash_Handle', rfn=lambda t, a: 1 + 0.03 * math.sin(7 * a + t * 20))]
    parts.append(sweep(coll, 'grip_bar', [(-0.058 + 0.116 * i / 12, 0, -0.448) for i in range(13)], 0.014, 14, 'Ash_Handle'))
    for s in (-1, 1):
        parts.append(sweep(coll, f'grip_cheek_{s}', [(s * 0.058 * math.sin(math.pi / 2 * i / 10), 0, -0.448 + 0.052 * (1 - math.cos(math.pi / 2 * i / 10)) + 0.0 * i) for i in range(11)],
                           0.011, 10, 'Ash_Handle'))
    parts.append(lathe(coll, 'socket', [(0.180, 0.0235), (0.186, 0.026), (0.230, 0.029), (0.250, 0.033), (0.258, 0.036)], 32, 'Forged_Iron', axis='z'))
    for k, z in enumerate((0.19, 0.215)):
        parts.append(ring(coll, f'rivet_ring_{k}', (0, 0, z), 'z', 0.027, 0.0018, 'Forged_Iron', segs=32, sides=6))

    def blade(u, v):
        x = (u * 2 - 1)
        w = 0.092 * (1 - 0.55 * max(0.0, (v - 0.55) / 0.45) ** 1.6)
        z = 0.255 + 0.245 * v - 0.02 * (x ** 2) * max(0.0, v - 0.7) / 0.3
        y = 0.013 * x * x - 0.006 + 0.004 * (1 - abs(x)) * (1 - v)
        return (x * w, y, z), (0, 0.0022 + 0.0022 * (1 - v), 0)
    parts.append(plate(coll, 'blade', blade, 18, 24, 'Blade_Steel'))
    parts.append(sweep(coll, 'tread', [(-0.090 + 0.18 * i / 20, 0.013 * ((-1 + 2 * i / 20) ** 2) - 0.004, 0.257) for i in range(21)], 0.0045, 8, 'Blade_Steel'))
    return coll, {'shovel-body': parts}, (), dict(roughness=0.6, metallic=0.4)


def build_axe():
    coll = asset_collection('tool_axe')
    haft = [sweep(coll, 'haft', [(0, -0.012 * math.sin(math.pi * i / 36) + 0.006 * math.sin(2 * math.pi * i / 36), -0.300 + 0.53 * i / 36) for i in range(37)],
                  lambda t: 0.020 - 0.004 * math.sin(math.pi * t) + (0.004 if t < 0.06 else 0.0), 14, 'Hickory',
                  rfn=lambda t, a: 1 + 0.2 * math.cos(2 * a))]
    haft.append(lathe(coll, 'knob', [(-0.312, 0.012), (-0.306, 0.022), (-0.298, 0.024), (-0.290, 0.021)], 20, 'Hickory', axis='z', sx=0.85))
    head = [lathe(coll, 'eye', [(0.163, 0.024), (0.167, 0.029), (0.213, 0.029), (0.217, 0.024)], 32, 'Forged_Iron', axis='z', sx=0.8)]

    def bit(u, v):
        wz = 0.050 + 0.075 * v ** 1.3
        z = 0.188 + (u - 0.5) * wz + 0.018 * v * v
        y = -0.018 - 0.150 * v - 0.012 * math.sin(math.pi * u) * v ** 2
        return (0, y, z), (0.017 * (1 - v) ** 1.4 + 0.0009, 0, 0)
    head.append(plate(coll, 'bit', bit, 16, 22, 'Forged_Iron'))
    head.append(sweep(coll, 'edge', [(0, -0.018 - 0.150 - 0.012 * math.sin(math.pi * u / 20), 0.188 + (u / 20 - 0.5) * 0.125 + 0.018) for u in range(21)], 0.0011, 6, 'Face_Steel'))
    head.append(boxg(coll, 'poll', 0.040, 0.022, 0.044, (0, 0.034, 0.19), 'Forged_Iron', cuts=2, bevel=0.004))
    head.append(boxg(coll, 'wedge', 0.004, 0.02, 0.026, (0, 0.0, 0.222), 'Hickory', bevel=0.001))
    return coll, {'axe-head': head, 'axe-haft': haft}, (), dict(roughness=0.6, metallic=0.4)


def build_food():
    coll = asset_collection('tool_food')
    pent = math.cos(math.pi / 5)
    ban = []
    # a 132 deg arc lying flat in XZ, on the middle of the primitive's torus arc
    # (TorusGeometry arc 1.12 PI turned rotation.x = rotation.z = PI/2)
    pts = [(-0.095 * math.sin(a), 0.0, 0.095 * math.cos(a)) for a in (0.56 * math.pi - 1.15 + 2.3 * i / 40 for i in range(41))]
    ban.append(sweep(coll, 'banana', pts, lambda t: 0.004 + 0.024 * math.sin(math.pi * min(1.0, t * 1.05)) ** 0.6, 20, 'Banana_Skin',
                     rfn=lambda t, a: 0.55 + 0.45 * pent / math.cos(((a + math.pi / 5) % (2 * math.pi / 5)) - math.pi / 5)))
    tx, tz = pts[-1][0] - pts[-2][0], pts[-1][2] - pts[-2][2]
    tl = math.hypot(tx, tz)
    ban.append(sweep(coll, 'banana_stem', [(pts[-1][0] + 0.0045 * i * tx / tl, 0.0, pts[-1][2] + 0.0045 * i * tz / tl) for i in range(6)], 0.006, 10, 'Banana_Stem'))
    ban.append(blob(coll, 'banana_tip', 0.0055, (1, 1, 1), 'Banana_Stem', subdiv=2, center=pts[0]))
    coco = [blob(coll, 'husk', 0.1, (1.0, 1.08, 1.0), 'Coconut_Husk', subdiv=4, noise=0.05, seed=3)]
    for k in range(3):
        a = k * 2 * math.pi / 3
        coco.append(blob(coll, f'eye_{k}', 0.011, (1, 0.5, 1), 'Coconut_Eye', subdiv=1, center=(0.022 * math.cos(a), 0.106, 0.022 * math.sin(a))))
    mango = [lathe(coll, 'mango', [(-0.085 + 0.17 * i / 16, 0.001 + 0.078 * math.sin(math.pi * i / 16) ** 0.8) for i in range(17)], 32, 'Mango_Skin',
                   rfn=lambda a, h, r: r * (1 + 0.12 * math.cos(a) + 0.05 * math.cos(2 * a)), sx=0.85)]
    mango.append(sweep(coll, 'mango_stem', [(0.004 * i, 0.083 + 0.005 * i, 0) for i in range(6)], 0.0035, 8, 'Banana_Stem'))

    def leaf(u, v):
        w = 0.018 * math.sin(math.pi * v) * (u * 2 - 1)
        return (0.02 + 0.07 * v, 0.106 - 0.02 * v * v + 0.006 * (u * 2 - 1) ** 2, w), (0, 0.0006, 0)
    mango.append(plate(coll, 'mango_leaf', leaf, 4, 12, 'Mango_Leaf'))
    meat = [blob(coll, 'cut', 0.11, (1.25, 0.70, 0.90), 'Meat_Seared', subdiv=4, noise=0.06, seed=7, center=(-0.03, 0, 0))]
    for k, x in enumerate((-0.07, -0.02, 0.03)):
        meat.append(blob(coll, f'sear_{k}', 0.07, (0.12, 0.08, 1.0), 'Meat_Char', subdiv=2, center=(x, 0.070, 0),
                         fn=lambda g: Vector((g.x + 0.3 * g.z * 0.2, g.y - 0.25 * g.z * g.z / 0.07, g.z))))
    meat.append(sweep(coll, 'bone', [(0.06 + 0.12 * i / 12, 0.004 * math.sin(i), 0) for i in range(13)], lambda t: 0.017 + 0.004 * t, 12, 'Bone'))
    for s in (-1, 1):
        meat.append(blob(coll, f'knuckle_{s}', 0.016, (1, 1, 1), 'Bone', subdiv=2, center=(0.19, 0.0, s * 0.012)))
    return coll, {'food-banana': ban, 'food-coconut': coco, 'food-mango': mango, 'food-meat': meat}, (), dict(roughness=0.7, metallic=0.0)


def build_keg():
    coll = asset_collection('tool_keg')
    n_st = 18

    def staves(a, h, r):
        f = (a * n_st / (2 * math.pi)) % 1.0
        return r - (0.0016 if f < 0.06 or f > 0.94 else 0.0)
    prof = [(-0.113, 0.100), (-0.113, 0.106), (-0.125, 0.106)] + [(-0.125 + 0.25 * i / 14, 0.113 + 0.017 * math.cos(math.pi * (-0.125 + 0.25 * i / 14) / 0.25)) for i in range(15)] + [(0.125, 0.106), (0.113, 0.106), (0.113, 0.100)]
    body = [lathe(coll, 'staves', prof, 90, 'Keg_Oak', rfn=staves)]
    for k, y in enumerate((-0.108, -0.085, 0.085, 0.108)):
        r = 0.113 + 0.017 * math.cos(math.pi * y / 0.25)
        body.append(lathe(coll, f'hoop_{k}', [(y - 0.008, r - 0.001), (y - 0.008, r + 0.0032), (y + 0.008, r + 0.0032), (y + 0.008, r - 0.001)], 64, 'Forged_Iron', caps=(False, False)))
    body.append(lathe(coll, 'bung', [(0.113, 0.016), (0.119, 0.016), (0.121, 0.013)], 20, 'Keg_Oak', center=(0.045, 0, 0.015)))
    fuse = [sweep(coll, 'fuse', [(0.045 + 0.033 * (i / 12) ** 1.5, 0.118 + 0.145 * i / 12, 0.015 + 0.005 * math.sin(i * 0.7)) for i in range(13)], 0.0055, 8, 'Fuse_Cord')]
    return coll, {'keg-body': body, 'keg-fuse': fuse}, (), dict(roughness=0.85, metallic=0.1)


def build_chest():
    coll = asset_collection('tool_chest')
    body = []
    for k in range(3):  # three planks a side, front and back, plus ends and floor
        y = -0.19 + 0.0005 + k * 0.0866 + 0.0433
        for z in (-0.143, 0.143):
            body.append(boxg(coll, f'plank_{k}_{z:+.2f}', 0.44, 0.084, 0.014, (0, y, z), 'Chest_Wood', cuts=1, bevel=0.002))
    for x in (-0.223, 0.223):
        body.append(boxg(coll, f'end_{x:+.2f}', 0.014, 0.258, 0.272, (x, -0.06, 0), 'Chest_Wood', cuts=1, bevel=0.002))
    body.append(boxg(coll, 'floor', 0.44, 0.012, 0.272, (0, -0.184, 0), 'Chest_Wood'))
    for x in (-0.19, 0.19):
        for z in (-0.151, 0.151):
            body.append(boxg(coll, f'strap_{x:+.2f}_{z:+.2f}', 0.03, 0.26, 0.004, (x, -0.06, z), 'Chest_Brass', bevel=0.001))
    for x in (-0.228, 0.228):
        for y in (-0.185, 0.065):
            for z in (-0.148, 0.148):
                body.append(boxg(coll, f'corner_{x:+.2f}{y:+.2f}{z:+.2f}', 0.022, 0.022, 0.022, (x, y, z), 'Chest_Brass', bevel=0.004))
        body.append(ring(coll, f'handle_{x:+.2f}', (x + (0.012 if x > 0 else -0.012), -0.02, 0), 'x', 0.045, 0.005, 'Forged_Iron', segs=16, sides=8, arc=math.pi, a0=math.pi))
    body.append(boxg(coll, 'lock', 0.07, 0.08, 0.012, (0, 0.03, -0.156), 'Chest_Brass', cuts=2, bevel=0.004))
    body.append(boxg(coll, 'keyhole', 0.008, 0.02, 0.004, (0, 0.022, -0.163), 'Forged_Iron'))
    lid = []
    R, cy = 0.15, 0.10

    def dome(u, v):
        x = -0.228 + 0.456 * u
        a = math.pi * v
        n = (0, math.sin(a), math.cos(a))
        c = (x, cy + R * 0.8 * math.sin(a) - 0.0, R * math.cos(a))
        return c, tuple(0.007 * q for q in n)
    lid.append(plate(coll, 'dome', dome, 14, 22, 'Chest_Wood'))
    for x in (-0.228, 0.228):
        def cap(u, v, x=x):
            r = 0.001 + (R - 0.004) * u
            a = math.pi * v
            return (x - (0.004 if x > 0 else -0.004), cy + r * 0.8 * math.sin(a), r * math.cos(a)), (0.004, 0, 0)
        lid.append(plate(coll, f'lidcap_{x:+.2f}', cap, 3, 14, 'Chest_Wood'))
    for k, x in enumerate((-0.19, 0.0, 0.19)):
        pts = [(x, cy + (R + 0.008) * 0.8 * math.sin(math.pi * i / 24), (R + 0.008) * math.cos(math.pi * i / 24)) for i in range(25)]
        lid.append(sweep(coll, f'band_{k}', pts, 0.0055, 6, 'Chest_Brass', rfn=lambda t, a: 1 + 0.9 * abs(math.cos(a))))
    lid.append(boxg(coll, 'lid_rim', 0.46, 0.03, 0.305, (0, 0.085, 0), 'Chest_Wood', bevel=0.004))
    lid.append(boxg(coll, 'hasp', 0.03, 0.06, 0.006, (0, 0.08, -0.158), 'Chest_Brass', bevel=0.002))
    return coll, {'chest-body': body, 'chest-lid': lid}, (), dict(roughness=0.65, metallic=0.3)


LOD_TARGET = {'tool_bucket': (2400, 520), 'tool_planks': (1600, 480), 'tool_hammer': (1800, 480),
              'tool_spyglass': (2200, 520), 'tool_compass': (2200, 520), 'tool_lantern': (2200, 520),
              'tool_shovel': (2000, 480), 'tool_axe': (2000, 480), 'tool_food': (2400, 600),
              'tool_keg': (2200, 520), 'tool_chest': (2400, 560)}


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

BUILDERS = [build_bucket, build_planks, build_hammer, build_spyglass, build_compass, build_lantern,
            build_shovel, build_axe, build_food, build_keg, build_chest]
ONLY = [x for x in os.environ.get('TOOLS_ONLY', '').split(',') if x]
for builder in BUILDERS:
    if ONLY and builder.__name__[len('build_'):] not in ONLY:
        continue
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
