# CLIFF KIT I (b4.6a; islands-02, PLAN 3.14 + section 6 row 16) on the shared rock core (_rock.py),
# the same HIGH sculpt (300-600k) -> welded LOD0 recipe as build_rocks.py / build_crag.py.
#
# A heightfield cannot draw a vertical face, an overhang or a recess, so the island lanes stamp
# these kit pieces onto coast arcs and landform scarps (placement is b4.6d, colliders b4.6c):
#
#   cliff_face_a     12 x 8 m COLUMNAR wall: a rank of prismatic jointed columns, tallest at the
#                    middle, on a buried root slab, shed drums at the foot
#   cliff_face_b     12 x 8 m BEDDED wall: dipping sedimentary beds, the soft beds set back so the
#                    hard ones stand out as ledges (the stair-stepped sea-cliff profile)
#   cliff_face_c     12 x 8 m BLOCKY wall split by a gully: two fractured masses, a recessed chute
#                    with a jammed chockstone, fallen blocks at the foot
#   cliff_overhang_a 6+ m lip over a 3+ m undercut (the "jaw" of Skull Cove), tall
#   cliff_overhang_b 6+ m lip over a 3+ m sea-cut notch (low, at the waterline)
#   rock_shelf_a     flat tidal platform with three tide-pool recesses
#   rock_shelf_b     two-step shelf with tide pools on both steps
#
# Every face/overhang has a FLAT BACK (Blender +Y = game -Z): the back of the HIGH sculpt is
# clamped onto one plane before decimation, so the piece seats against a hill with no daylight gap
# (test-cliff-kit grades the gap in b4.6c). The front faces Blender -Y = game +Z. Origin: ground
# line at z = 0 (game y = 0) under the front foot; every piece roots 0.8-1.2 m below it.
#
# ONE shared rock material family: Rock_Grey body, Rock_Dark soffits/undersides/base, Rock_Sea the
# wet tide-pool floors and the waterline band (the runtime triplanar 'rock' detail keys on Rock_*).
# LOD0 10.5-11k (D27 band floors, rocks-cliffs wire row); `<name>_lods.glb` (LOD1 <= 30%, LOD2,
# far <= 5%) comes from build_lods.py (BR_LODS_ONLY=<keys>) on the 'cliff-kit' tier of
# scripts/test-asset-tiers.mjs.
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_cliff_kit.py
# env: BR_EXPORT_DIR (output dir), CLIFF_ONLY=cliff_face_a,rock_shelf_b
import bpy
import json
import math
import os
import random
import time
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())
exec(open(os.path.join(HERE, "_detail.py")).read())
exec(open(os.path.join(HERE, "_nature.py")).read())
exec(open(os.path.join(HERE, "_rock.py")).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
ONLY = {s.strip() for s in os.environ.get('CLIFF_ONLY', '').split(',') if s.strip()}

# Blender-space (Z up) target AABBs. Faces: 12 m wide, 8 m above the ground line (+1.2 m root).
FACE_BOX = ((-6.0, -3.2, -1.2), (6.0, 0.0, 8.0))
BOXES = {
    'cliff_face_a': FACE_BOX, 'cliff_face_b': FACE_BOX, 'cliff_face_c': FACE_BOX,
    'cliff_overhang_a': ((-4.4, -4.6, -1.2), (4.4, 0.0, 7.6)),
    'cliff_overhang_b': ((-4.6, -4.4, -1.0), (4.6, 0.0, 5.0)),
    'rock_shelf_a': ((-5.0, -3.6, -0.9), (5.0, 3.6, 0.9)),
    'rock_shelf_b': ((-4.6, -3.4, -0.9), (4.6, 3.4, 1.7)),
}
BAND = (10000, 16000)  # PLAN 3.14 kit LOD0; faces 10-16k (section 6 row 16)
TARGET = 10800
LIP_MIN, UNDERCUT_MIN = 6.0, 3.0
POOL_MIN_DEPTH = 0.20


def fit_box(objs, box):
    """Per-axis linear fit into `box`; returns the map so authored points (pool centres) follow."""
    lo, hi = Vector(box[0]), Vector(box[1])
    vs = [v for o in objs for v in o.data.vertices]
    amin = Vector(tuple(min(v.co[a] for v in vs) for a in range(3)))
    amax = Vector(tuple(max(v.co[a] for v in vs) for a in range(3)))

    def f(p):
        return Vector(tuple(lo[a] + (p[a] - amin[a]) * (hi[a] - lo[a]) / max(1e-6, amax[a] - amin[a]) for a in range(3)))
    for v in vs:
        v.co = f(v.co)
    for o in objs:
        o.data.update()
    return f


def carve(obj, cutter):
    md = obj.modifiers.new('ck_carve', 'BOOLEAN')
    md.operation = 'DIFFERENCE'
    md.solver = 'EXACT'
    md.object = cutter
    _apply(obj, md)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def ellipsoid(coll, name, c, r):
    me = bpy.data.meshes.new(name)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=1.0)
    for v in bm.verts:
        v.co = Vector((c[0] + v.co.x * r[0], c[1] + v.co.y * r[1], c[2] + v.co.z * r[2]))
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


def cell(coll, name, seed, scale, loc, rot=(0, 0, 0), **kw):
    return place(voronoi_cell(name, coll, seed, scale=scale, **kw), loc, rot)


def rubble(coll, tag, seed, n, x_span, y_rng, size=(0.30, 0.60)):
    rng = random.Random(seed)
    out = []
    for k in range(n):
        s = rng.uniform(*size)
        out.append(cell(coll, f'{tag}_rb{k}', seed + 50 + k, (s, s * 0.85, s * 0.7),
                        (rng.uniform(-x_span, x_span), rng.uniform(*y_rng), -0.15 + s * 0.2),
                        (rng.uniform(-30, 30), rng.uniform(-30, 30), rng.uniform(0, 180)),
                        planes=8, reach=(0.62, 0.92), points=600, caps=(0.88,)))
    return out


# ── cliff faces ──────────────────────────────────────────────────────────────────────────────
def form_face_a(coll, seed=6101):
    """Columnar: a rank of prismatic columns along X, tops stepping 5.6-8.2 m, cross-jointed."""
    rng = random.Random(seed)
    parts = [cell(coll, 'fa_back', seed, (6.3, 1.3, 4.9), (0, 0.35, 3.4), planes=10, reach=(0.8, 0.97), caps=(0.95,)),
             cell(coll, 'fa_root', seed + 1, (6.6, 2.0, 0.9), (0, -0.6, -0.6), planes=10, reach=(0.7, 0.95))]
    n = 11
    for k in range(n):
        x = -5.5 + 11.0 * k / (n - 1) + rng.uniform(-0.15, 0.15)
        top = 8.2 - 2.2 * abs(x) / 6.0 + rng.uniform(-0.9, 0.5)
        h = top + 1.2
        r = rng.uniform(0.55, 0.72)
        parts.append(cell(coll, f'fa_c{k}', seed + 11 * k, (r, r * 0.95, h * 0.5),
                          (x, -1.05 + rng.uniform(-0.35, 0.25), top - h * 0.5),
                          (rng.uniform(-4, 4), rng.uniform(-4, 4), rng.uniform(0, 60)),
                          planes=7, reach=(0.80, 0.96), caps=(rng.uniform(0.86, 0.97),)))
    parts += rubble(coll, 'fa', seed, 6, 5.0, (-2.9, -1.9))
    joints = tuple((((-5.0 + 1.0 * k), -1.0, 3.5), (0.97, 0.22, 0.0), 0.035, 0.12) for k in range(0, 11, 2))
    recipe = dict(macro=(0.06, 1.6), heights=((0, 2.0, 0.045), (1, 0.7, 0.020), (0, 0.27, 0.007)),
                  strata=dict(bed=0.9, amp=0.030, dip=(0.04, 0.02, 1.0)), joints=joints, chips=0.018)
    return parts, 1, recipe


def form_face_b(coll, seed=6211):
    """Bedded: dipping slabs, hard beds proud by ~0.5 m, soft beds set back."""
    rng = random.Random(seed)
    parts = [cell(coll, 'fb_back', seed, (6.3, 1.2, 4.9), (0, 0.40, 3.4), planes=10, reach=(0.8, 0.97), caps=(0.95,))]
    z = -1.0
    k = 0
    while z < 7.8:
        t = rng.uniform(0.8, 1.6)
        hard = k % 2 == 0
        depth = 1.55 if hard else 1.05
        parts.append(cell(coll, f'fb_bed{k}', seed + 7 * k, (6.2 - 0.12 * k, depth, t * 0.5),
                          (rng.uniform(-0.3, 0.3), -0.9 - (0.35 if hard else 0.0), z + t * 0.5),
                          (rng.uniform(2, 5), rng.uniform(-2, 2), rng.uniform(-3, 3)),
                          planes=12, reach=(0.78, 0.97), caps=(0.90,)))
        z += t * 0.92
        k += 1
    parts += rubble(coll, 'fb', seed, 7, 5.2, (-3.0, -2.0), size=(0.25, 0.55))
    recipe = dict(macro=(0.07, 1.8), heights=((0, 2.4, 0.050), (1, 0.8, 0.022), (0, 0.30, 0.008)),
                  strata=dict(bed=0.45, amp=0.035, dip=(0.07, 0.02, 1.0)), chips=0.02,
                  joints=(((-2.4, -1.0, 3.5), (0.96, 0.28, 0.0), 0.04, 0.14), ((2.9, -1.0, 3.0), (0.95, -0.3, 0.0), 0.04, 0.12)))
    return parts, 2, recipe


def form_face_c(coll, seed=6337):
    """Blocky: two fractured masses split by a recessed gully, a chockstone, fallen blocks."""
    rng = random.Random(seed)
    parts = [cell(coll, 'fc_back', seed, (6.3, 1.2, 4.9), (0, 0.40, 3.4), planes=10, reach=(0.8, 0.97), caps=(0.95,))]
    for s, k in ((-1, 0), (1, 1)):
        for j in range(3):
            parts.append(cell(coll, f'fc_m{k}{j}', seed + 10 * k + j, (1.55 + 0.2 * j, 1.5, 1.7 + 0.3 * j),
                              (s * (1.7 + 1.5 * j), -1.15 + rng.uniform(-0.3, 0.2), 1.6 + rng.uniform(0, 4.6 - 0.9 * j)),
                              (rng.uniform(-8, 8), rng.uniform(-8, 8), rng.uniform(0, 90)),
                              planes=11, reach=(0.66, 0.95)))
        parts.append(cell(coll, f'fc_base{k}', seed + 40 + k, (2.7, 1.6, 1.4), (s * 3.2, -1.1, 0.4),
                          planes=10, reach=(0.7, 0.95)))
    parts.append(cell(coll, 'fc_gully', seed + 60, (0.9, 0.9, 4.0), (0.0, -0.2, 3.6), planes=8, reach=(0.8, 0.96)))
    parts.append(cell(coll, 'fc_chock', seed + 61, (0.75, 0.70, 0.60), (0.05, -0.95, 5.3), (12, -8, 30),
                      planes=9, reach=(0.62, 0.92)))
    parts += rubble(coll, 'fc', seed, 6, 5.0, (-3.0, -2.0), size=(0.35, 0.75))
    recipe = dict(macro=(0.10, 2.2), heights=((0, 2.6, 0.055), (1, 0.9, 0.024), (0, 0.33, 0.009)),
                  strata=dict(bed=1.1, amp=0.025, dip=(0.12, 0.05, 1.0)), chips=0.024,
                  joints=(((-0.9, -1.0, 4.0), (0.99, 0.1, 0.0), 0.05, 0.16), ((3.6, -1.0, 3.0), (0.93, 0.35, 0.0), 0.04, 0.12)))
    return parts, 2, recipe


# ── overhangs ────────────────────────────────────────────────────────────────────────────────
def form_overhang(coll, tag, seed, wall_h, lip_z, lip_t, notch_z):
    """A back wall whose front sits ~1.2 m out, and a capped lip slab reaching ~4.4 m out: the
    soffit between is the undercut. Proportions are set so fit_box barely rescales."""
    rng = random.Random(seed)
    parts = [cell(coll, f'{tag}_wall', seed, (4.3, 0.75, wall_h * 0.5), (0, -0.55, wall_h * 0.5 - 1.1),
                  planes=10, reach=(0.82, 0.97), caps=(0.95,)),
             cell(coll, f'{tag}_lip', seed + 1, (3.9, 2.25, lip_t * 0.5), (rng.uniform(-0.1, 0.1), -2.25, lip_z),
                  (rng.uniform(-3, -1), rng.uniform(-2, 2), rng.uniform(-3, 3)), planes=11, reach=(0.86, 0.98),
                  caps=(0.93,), up_bias=1.0),
             cell(coll, f'{tag}_cap', seed + 2, (4.2, 1.3, 0.8), (0, -0.7, lip_z + lip_t * 0.45), planes=10,
                  reach=(0.75, 0.95))]
    for k in range(3):  # buttress lumps on the wall foot (kept inside the undercut line)
        parts.append(cell(coll, f'{tag}_ft{k}', seed + 5 + k, (1.0, 0.55, 0.9), (-2.8 + 2.8 * k, -0.95, 0.1),
                          planes=9, reach=(0.62, 0.93)))
    parts += rubble(coll, tag, seed, 4, 3.6, (-3.6, -2.4), size=(0.25, 0.5))
    recipe = dict(macro=(0.06, 1.8), heights=((0, 2.4, 0.050), (1, 0.8, 0.022), (0, 0.30, 0.008)),
                  strata=dict(bed=0.6, amp=0.030, dip=(0.05, 0.03, 1.0)), chips=0.02,
                  notch=dict(z=notch_z, width=0.7, depth=0.18))
    return parts, 2, recipe


def form_overhang_a(coll):
    return form_overhang(coll, 'oa', 6421, wall_h=8.8, lip_z=6.2, lip_t=2.2, notch_z=1.0)


def form_overhang_b(coll):
    return form_overhang(coll, 'ob', 6547, wall_h=6.0, lip_z=3.9, lip_t=1.8, notch_z=0.4)


# ── shelves with tide pools ──────────────────────────────────────────────────────────────────
def form_shelf(coll, tag, seed, steps, pools):
    """steps: ((x, y, half w, half d, top z), ...) capped slabs; pools: ((x, y, rx, ry, depth), ...)
    carved into the slab whose footprint holds them, BEFORE the union remesh."""
    rng = random.Random(seed)
    parts = []
    for k, (x, y, hw, hd, top) in enumerate(steps):
        t = top + 0.9
        s = cell(coll, f'{tag}_s{k}', seed + k, (hw, hd, t * 0.5), (x, y, top - t * 0.5),
                 (rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(0, 20)),
                 planes=12, reach=(0.80, 0.97), caps=(0.97,), up_bias=1.5)
        for j, (px, py, rx, ry, dp) in enumerate(pools):
            if abs(px - x) < hw * 0.75 and abs(py - y) < hd * 0.75 and (k == len(steps) - 1 or
                                                                      all(abs(px - sx) > shw for sx, _, shw, _, _ in steps[k + 1:])):
                carve(s, ellipsoid(coll, f'{tag}_p{k}{j}', (px, py, top + dp * 0.35), (rx, ry, dp * 1.35)))
        parts.append(s)
    parts.append(cell(coll, f'{tag}_base', seed + 30, (steps[0][2] * 1.05, steps[0][3] * 1.05, 0.5),
                      (0, 0, -0.55), planes=10, reach=(0.72, 0.95)))
    parts += rubble(coll, tag, seed, 5, 4.0, (-3.6, 3.6), size=(0.25, 0.45))
    recipe = dict(macro=(0.04, 1.4), heights=((0, 1.6, 0.030), (1, 0.6, 0.014), (0, 0.24, 0.006)),
                  strata=dict(bed=0.35, amp=0.020, dip=(0.03, 0.02, 1.0)), chips=0.012)
    return parts, 2, recipe


SHELF_POOLS = {
    'rock_shelf_a': ((-2.4, -0.6, 1.10, 0.80, 0.60), (0.7, 0.9, 0.85, 0.65, 0.55), (2.3, -0.9, 0.75, 0.60, 0.50)),
    'rock_shelf_b': ((-2.4, -0.4, 0.95, 0.75, 0.55), (-0.4, -1.3, 0.70, 0.55, 0.50), (2.4, 0.4, 0.80, 0.60, 0.55)),
}
SHELF_STEPS = {
    'rock_shelf_a': ((0.0, 0.0, 5.1, 3.6, 0.55),),
    'rock_shelf_b': ((-0.9, 0.0, 3.9, 3.4, 0.45), (2.4, 0.3, 2.2, 2.6, 1.30)),
}


def form_shelf_a(coll):
    return form_shelf(coll, 'sa', 6661, SHELF_STEPS['rock_shelf_a'], SHELF_POOLS['rock_shelf_a'])


def form_shelf_b(coll):
    return form_shelf(coll, 'sb', 6779, SHELF_STEPS['rock_shelf_b'], SHELF_POOLS['rock_shelf_b'])


FORMS = (('cliff_face_a', form_face_a), ('cliff_face_b', form_face_b), ('cliff_face_c', form_face_c),
         ('cliff_overhang_a', form_overhang_a), ('cliff_overhang_b', form_overhang_b),
         ('rock_shelf_a', form_shelf_a), ('rock_shelf_b', form_shelf_b))


# ── flat back, measurements, finish ──────────────────────────────────────────────────────────
def flatten_back(high, frac):
    """Clamp everything behind the plane y = ymax - frac * depth onto it: one planar back."""
    ys = [v.co.y for v in high.data.vertices]
    yb = max(ys) - frac * (max(ys) - min(ys))
    n = 0
    for v in high.data.vertices:
        if v.co.y > yb:
            v.co.y = yb
            n += 1
    high.data.update()
    return n


def co_list(obj):
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def back_flatness(obj, box):
    """Share of the back plane's footprint covered by faces lying on it (a hill-seated back)."""
    yb = box[1][1]
    area_back = sum(p.area for p in obj.data.polygons if p.normal.y > 0.98 and abs(p.center.y - yb) < 0.02)
    full = (box[1][0] - box[0][0]) * (box[1][2] - box[0][2])
    return area_back / full


def overhang_measure(obj):
    """undercut = wall front (mid-height, centre band) minus the lip front; lip = the X span of the
    part of the roof that hangs >= 2 m out over the wall (rubble at the foot is below z 2.5)."""
    vs = co_list(obj)
    wall = min(v.y for v in vs if 0.4 < v.z < 2.6 and abs(v.x) < 2.2)
    lip_vs = [v for v in vs if v.z > 2.5 and v.y < wall - 2.0]
    lip_front = min(v.y for v in vs if v.z > 2.5)
    xs = [v.x for v in lip_vs]
    soffit = min(v.z for v in lip_vs) if lip_vs else 0.0
    return dict(undercut=round(wall - lip_front, 2), lip=round(max(xs) - min(xs), 2) if xs else 0.0,
                soffit_z=round(soffit, 2), wall_front_y=round(wall, 2))


def pool_measure(obj, pools, fmap):
    vs = co_list(obj)
    out = []
    for (px, py, rx, ry, _dp) in pools:
        c = fmap(Vector((px, py, 0.0)))
        sx = fmap(Vector((px + rx, py, 0))).x - c.x
        sy = fmap(Vector((px, py + ry, 0))).y - c.y
        inner = [v.z for v in vs if v.z > -0.3 and ((v.x - c.x) / sx) ** 2 + ((v.y - c.y) / sy) ** 2 < 0.25]
        rim = sorted(v.z for v in vs if v.z > -0.3 and 1.3 < ((v.x - c.x) / sx) ** 2 + ((v.y - c.y) / sy) ** 2 < 2.2)
        floor_z = min(inner) if inner else 0.0
        rim_z = rim[len(rim) // 2] if rim else 0.0
        out.append(dict(c=[round(c.x, 2), round(c.y, 2)], r=[round(sx, 2), round(sy, 2)],
                        depth=round(rim_z - floor_z, 2), floor=round(floor_z, 2)))
    return out


def zone3(low, zones):
    """zone_materials with the full centroid and normal (tide pools need x/y): assign, then split
    the object by material (tint_pass wants one material per object)."""
    me = low.data
    me.materials.clear()
    for mname, _ in zones:
        me.materials.append(mat(mname))
    for p in me.polygons:
        p.material_index = next(i for i, (_, pred) in enumerate(zones) if pred(p.center, p.normal))
    used = sorted({p.material_index for p in me.polygons})
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    if len(used) > 1:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
    for o in [o for o in low.users_collection[0].objects if o.type == 'MESH']:
        idx = {p.material_index for p in o.data.polygons}
        m = o.data.materials[idx.pop()]
        for p in o.data.polygons:
            p.material_index = 0
        o.data.materials.clear()
        o.data.materials.append(m)


def finish(coll, name, moss):
    bake_ao(coll, samples=24, floor=0.66, max_dist=3.5, height_gradient=0.06)
    spec = tint_spec(moss=moss)
    for stone in ('Rock_Grey', 'Rock_Dark', 'Rock_Sea'):
        spec[stone] = dict(spec['Rock_Grey'], tone=0.12, streak=dict(axis='z', freq=3.4, amt=0.12),
                           low=dict(z=0.65, amt=0.30, col=(0.59, 0.65, 0.56)))
    tint_pass(coll, spec, seed=23)
    objs = [o for o in coll.objects if o.type == 'MESH']
    return _join(objs, name) if len(objs) > 1 else objs[0]


def build(name, form):
    t0 = time.time()
    coll = asset_collection(name)
    scratch = asset_collection(name + '_hi')
    parts, smooth_iters, recipe = form(scratch)
    high, voxel = fracture_cluster(parts, name + '_hi', smooth_iters=smooth_iters)
    maxd = sculpt(high, sum(map(ord, name)), **recipe)
    shelf = name.startswith('rock_shelf')
    flat_n = 0 if shelf else flatten_back(high, 0.22)
    hi_tris = tri_count(high)
    low = lod0(high, name, coll, TARGET)
    bpy.data.objects.remove(high, do_unlink=True)
    box = BOXES[name]
    fmap = fit_box([low], box)
    rep = dict(high_tris=hi_tris, voxel=round(voxel, 4), max_disp=round(maxd, 3), back_verts=flat_n)
    pools = SHELF_POOLS.get(name)
    if pools:
        rep['pools'] = pool_measure(low, pools, fmap)
        pc = [(Vector(p['c']), p['r']) for p in rep['pools']]

        def in_pool(c, n):
            return c.z < 0.12 or any(((c.x - q.x) / r[0]) ** 2 + ((c.y - q.y) / r[1]) ** 2 < 1.1 for q, r in pc)
        zone3(low, [('Rock_Sea', in_pool), ('Rock_Dark', lambda c, n: n.z < -0.40 or c.z < -0.3),
                    ('Rock_Grey', lambda c, n: True)])
    else:
        if name.startswith('cliff_overhang'):
            rep['overhang'] = overhang_measure(low)
        zone3(low, [('Rock_Dark', lambda c, n: n.z < -0.35 or c.z < 0.35), ('Rock_Grey', lambda c, n: True)])
        rep['back_cover'] = None
    obj = finish(coll, name, moss=0.30 if shelf else 0.38)
    if not shelf:
        rep['back_cover'] = round(back_flatness(obj, box), 3)
    path = export_collection_vc(coll, name + '.glb')
    info = verify_glb(path)
    rep.update(lod0_tris=info['tris'], materials=info['materials'], bbox=[info.get('bbox_min'), info.get('bbox_max')],
               secs=round(time.time() - t0, 1))
    print(f'CLIFF {name} ' + json.dumps(rep, default=str), flush=True)
    assert 300000 <= hi_tris <= 600000, (name, 'high sculpt', hi_tris)
    assert BAND[0] <= info['tris'] <= BAND[1], (name, info['tris'], BAND)
    assert info['color0'], name
    if 'overhang' in rep:
        assert rep['overhang']['undercut'] >= UNDERCUT_MIN and rep['overhang']['lip'] >= LIP_MIN, (name, rep['overhang'])
    if pools:
        assert all(p['depth'] >= POOL_MIN_DEPTH for p in rep['pools']), (name, rep['pools'])
    if not shelf:
        assert rep['back_cover'] >= 0.45, (name, 'flat back', rep['back_cover'])
    for o in coll.objects:
        o.hide_render = True
    return rep


clear_default_scene()
agx_palette()
REPORT = {}
for name, form in FORMS:
    if ONLY and name not in ONLY:
        continue
    REPORT[name] = build(name, form)
print('CLIFF REPORT ' + json.dumps(REPORT, default=str))
print("CLIFF DONE")
