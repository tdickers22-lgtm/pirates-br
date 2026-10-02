# CLIFF KIT I (b4.6a; islands-02, PLAN 3.14 + section 6 row 16) on the shared rock core (_rock.py),
# the same HIGH sculpt (300-600k) -> welded LOD0 recipe as build_rocks.py / build_crag.py.
#
# A heightfield cannot draw a vertical face, an overhang or a recess, so the island lanes stamp
# these kit pieces onto coast arcs and landform scarps (placement is b4.6d, colliders b4.6c):
#
#   cliff_face_a     12 x 8 m COLUMNAR wall: a rank of hexagonal jointed columns capped at both
#                    ends, tallest at the middle, on a buried root slab, shed drums at the foot
#   cliff_face_b     12 x 8 m BEDDED wall: dipping sedimentary beds, each a row of shorter jointed
#                    slabs, the soft beds set back so the hard ones stand out as ledges
#   cliff_face_c     12 x 8 m BLOCKY wall split by a gully: two fractured masses, a recessed chute
#                    with a jammed chockstone, fallen blocks at the foot
#   cliff_overhang_a 6+ m lip over a 3+ m undercut (the "jaw" of Skull Cove), tall
#   cliff_overhang_b 6+ m lip over a 3+ m sea-cut notch (low, at the waterline)
#   rock_shelf_a     tidal platform of 5 jointed slabs + a lower seaward step, three tide pools
#   rock_shelf_b     two-step shelf of 6 jointed slabs with tide pools on both steps
#
# Everything big is a block() (planar caps on all sides, chamfered by fracture planes), not a
# stretched voronoi cell: a long cell keeps the sphere's elliptical outline (b4.6a2 art review).
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


BLOCK_C = 0.55  # unit-sphere cap distance: every block corner (0.95) sits INSIDE the sphere


def block(coll, name, seed, half, loc, rot=(0, 0, 0), planes=5, reach=(0.70, 0.90), sides=0,
          vplanes=0, vreach=(0.64, 0.84), top=0, top_reach=(0.42, 0.53), points=1600):
    """A jointed block, never a lens (b4.6a2): voronoi_cell's caps only cut top and bottom, so a long
    cell keeps the sphere's elliptical outline (the 'pancake' and 'disc' tells of b4.6a1). Here all
    six sides (or `sides` vertical planes: a hexagonal column) are planar caps at BLOCK_C, close enough
    to the centre that the sphere never shows, then fracture planes chamfer edges and corners:
    `planes` any direction, `vplanes` near-vertical (an irregular, wave-cut outline in plan), `top`
    steep-normal planes below the cap (a stepped, jagged crest). `half` is the real half extent."""
    rng = random.Random(seed)
    C = BLOCK_C
    cuts = []
    if sides:
        a0 = rng.uniform(0.0, math.tau)
        for k in range(sides):
            a = a0 + math.tau * k / sides + rng.uniform(-0.14, 0.14)
            cuts.append((Vector((math.cos(a), math.sin(a), 0.0)), C * rng.uniform(0.92, 1.04)))
    else:
        for ax in (0, 1):
            for s in (1.0, -1.0):
                n = Vector((rng.uniform(-0.07, 0.07), rng.uniform(-0.07, 0.07), rng.uniform(-0.03, 0.03)))
                n[ax] = s
                cuts.append((n.normalized(), C))
    for s in (1.0, -1.0):
        cuts.append((Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), s)).normalized(), C))
    for _ in range(planes):
        d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
        if d.length > 1e-6:
            cuts.append((d.normalized(), rng.uniform(*reach)))
    for _ in range(vplanes):
        a = rng.uniform(0.0, math.tau)
        cuts.append((Vector((math.cos(a), math.sin(a), rng.gauss(0, 0.15))).normalized(), rng.uniform(*vreach)))
    for _ in range(top):
        cuts.append((Vector((rng.gauss(0, 0.6), rng.gauss(0, 0.3), 1.0)).normalized(), rng.uniform(*top_reach)))
    sc = (half[0] / C, half[1] / C, half[2] / C)
    bm = bmesh.new()
    for p in _fib_sphere(points):
        t = 1.0
        for n, h in cuts:
            dn = n.dot(p)
            if dn > 1e-6:
                t = min(t, h / dn)
        q = p * t
        bm.verts.new((q.x * sc[0], q.y * sc[1], q.z * sc[2]))
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    drop = {v for v in list(res['geom_interior']) + list(res['geom_unused']) if isinstance(v, bmesh.types.BMVert)}
    if drop:
        bmesh.ops.delete(bm, geom=list(drop), context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return place(obj, loc, rot)


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


def back_wall(coll, tag, seed, half=(6.0, 1.0, 4.4), loc=(0, 0.5, 3.3)):
    """The hill-seated mass behind every face: a block (rectangular in elevation, flat back, jagged
    crest), not the egg-shaped ellipsoid of b4.6a1."""
    return block(coll, f'{tag}_back', seed, half, loc, planes=4, vplanes=2, top=3)


# ── cliff faces ──────────────────────────────────────────────────────────────────────────────
def form_face_a(coll, seed=6101):
    """Columnar: a rank of hexagonal jointed columns along X, BOTH ends capped (no spindle tips),
    tops stepping 5.6-8.2 m and slanted, on a buried root slab, shed drums at the foot."""
    rng = random.Random(seed)
    parts = [back_wall(coll, 'fa', seed, (6.0, 1.1, 3.9), (0, 0.45, 3.0)),
             block(coll, 'fa_root', seed + 1, (6.3, 1.6, 0.7), (0, -0.7, -0.55), planes=5, vplanes=3)]
    n = 11
    for k in range(n):
        x = -5.5 + 11.0 * k / (n - 1) + rng.uniform(-0.12, 0.12)
        top = 8.2 - 2.2 * abs(x) / 6.0 + rng.uniform(-0.9, 0.5)
        h = top + 1.2
        r = rng.uniform(0.46, 0.56)
        parts.append(block(coll, f'fa_c{k}', seed + 11 * k, (r, r, h * 0.5),
                           (x, -1.05 + rng.uniform(-0.30, 0.20), top - h * 0.5),
                           (rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(0, 60)),
                           sides=6, planes=2, reach=(0.64, 0.76), top=1, top_reach=(0.47, 0.54)))
    for k in range(4):  # shed drums: short capped hex pieces lying at the foot
        r = rng.uniform(0.40, 0.50)
        parts.append(block(coll, f'fa_d{k}', seed + 200 + k, (r, r, rng.uniform(0.35, 0.55)),
                           (rng.uniform(-5.0, 5.0), rng.uniform(-2.8, -2.1), 0.0),
                           (rng.uniform(60, 95), rng.uniform(-20, 20), rng.uniform(0, 180)),
                           sides=6, planes=2, reach=(0.62, 0.74)))
    parts += rubble(coll, 'fa', seed, 4, 5.0, (-2.9, -1.9))
    joints = tuple((((-5.0 + 1.0 * k), -1.0, 3.5), (0.97, 0.22, 0.0), 0.035, 0.12) for k in range(0, 11, 2))
    recipe = dict(macro=(0.06, 1.6), heights=((0, 2.0, 0.045), (1, 0.7, 0.020), (0, 0.27, 0.007)),
                  strata=dict(bed=0.9, amp=0.030, dip=(0.04, 0.02, 1.0)), joints=joints, chips=0.018)
    return parts, 1, recipe


def form_face_b(coll, seed=6211):
    """Bedded: each dipping bed is a row of 3-4 shorter capped slabs along X (vertical joints between
    them, fronts staggered), hard beds proud by ~0.5 m, soft beds set back."""
    rng = random.Random(seed)
    parts = [back_wall(coll, 'fb', seed)]
    z = -1.0
    k = 0
    while z < 7.8:
        t = rng.uniform(0.8, 1.5)
        hard = k % 2 == 0
        depth = 1.50 if hard else 1.0
        dip = rng.uniform(2.0, 4.5) * (1 if k % 3 else -1)
        n = rng.choice((3, 4, 4))
        lo, hi = -6.0 + rng.uniform(-0.2, 0.3), 6.0 - rng.uniform(-0.2, 0.3)
        cuts = sorted(lo + (hi - lo) * (j + 1) / n + rng.uniform(-0.5, 0.5) for j in range(n - 1))
        edges = [lo] + cuts + [hi]
        for j in range(n):
            x0, x1 = edges[j], edges[j + 1]
            xc = 0.5 * (x0 + x1)
            d = depth * rng.uniform(0.85, 1.1)
            parts.append(block(coll, f'fb_bed{k}_{j}', seed + 7 * k + 101 * j,
                               (0.5 * (x1 - x0) + 0.08, d, t * 0.5 * rng.uniform(0.9, 1.0)),
                               (xc, -0.9 - (0.35 if hard else 0.0) + rng.uniform(-0.15, 0.15) + (d - depth) * -0.5,
                                z + t * 0.5 + xc * math.tan(math.radians(dip)) + rng.uniform(-0.08, 0.08)),
                               (rng.uniform(-1.5, 1.5), -dip + rng.uniform(-1.2, 1.2), rng.uniform(-2.5, 2.5)),
                               planes=6, vplanes=2, reach=(0.66, 0.86)))
        z += t * 0.92
        k += 1
    parts += rubble(coll, 'fb', seed, 7, 5.2, (-3.0, -2.0), size=(0.25, 0.55))
    recipe = dict(macro=(0.07, 1.8), heights=((0, 2.4, 0.050), (1, 0.8, 0.022), (0, 0.30, 0.008)),
                  strata=dict(bed=0.45, amp=0.035, dip=(0.07, 0.02, 1.0)), chips=0.02,
                  joints=(((-2.4, -1.0, 3.5), (0.96, 0.28, 0.0), 0.04, 0.14), ((2.9, -1.0, 3.0), (0.95, -0.3, 0.0), 0.04, 0.12)))
    return parts, 2, recipe


def form_face_c(coll, seed=6337):
    """Blocky: two fractured masses of jointed blocks split by a recessed gully, a chockstone,
    fallen blocks."""
    rng = random.Random(seed)
    parts = [back_wall(coll, 'fc', seed)]
    for s, k in ((-1, 0), (1, 1)):
        for j in range(3):
            parts.append(block(coll, f'fc_m{k}{j}', seed + 10 * k + j, (1.35 + 0.2 * j, 1.3, 1.45 + 0.3 * j),
                               (s * (1.7 + 1.5 * j), -1.15 + rng.uniform(-0.3, 0.2), 1.6 + rng.uniform(0, 4.6 - 0.9 * j)),
                               (rng.uniform(-7, 7), rng.uniform(-7, 7), rng.uniform(-12, 12)),
                               planes=7, vplanes=2, reach=(0.66, 0.88)))
        parts.append(block(coll, f'fc_base{k}', seed + 40 + k, (2.6, 1.5, 1.3), (s * 3.2, -1.1, 0.4),
                           (0, 0, rng.uniform(-6, 6)), planes=5, vplanes=2))
    parts.append(block(coll, 'fc_gully', seed + 60, (0.8, 0.8, 3.7), (0.0, -0.15, 3.6), planes=4))
    parts.append(block(coll, 'fc_chock', seed + 61, (0.62, 0.58, 0.50), (0.05, -0.95, 5.3), (12, -8, 30),
                       planes=6, reach=(0.64, 0.84)))
    for k in range(3):
        sz = rng.uniform(0.45, 0.7)
        parts.append(block(coll, f'fc_f{k}', seed + 70 + k, (sz, sz * 0.8, sz * 0.7),
                           (rng.uniform(-4.6, 4.6), rng.uniform(-2.9, -2.3), sz * 0.3),
                           (rng.uniform(-20, 20), rng.uniform(-20, 20), rng.uniform(0, 90)), planes=6))
    parts += rubble(coll, 'fc', seed, 4, 5.0, (-3.0, -2.0), size=(0.30, 0.6))
    recipe = dict(macro=(0.10, 2.2), heights=((0, 2.6, 0.055), (1, 0.9, 0.024), (0, 0.33, 0.009)),
                  strata=dict(bed=1.1, amp=0.025, dip=(0.12, 0.05, 1.0)), chips=0.024,
                  joints=(((-0.9, -1.0, 4.0), (0.99, 0.1, 0.0), 0.05, 0.16), ((3.6, -1.0, 3.0), (0.93, 0.35, 0.0), 0.04, 0.12)))
    return parts, 2, recipe


# ── overhangs ────────────────────────────────────────────────────────────────────────────────
def form_overhang(coll, tag, seed, wall_h, lip_z, lip_t, notch_z, n_lip):
    """A back wall whose front sits ~1.1 m out, and a lip of `n_lip` jointed blocks, each bonded
    into the wall (back end buried at y +0.05) and reaching 4.4-4.9 m out with its own front, so the
    lip edge is a staggered, irregular line, not one ellipse. The soffit between is the undercut."""
    rng = random.Random(seed)
    parts = [block(coll, f'{tag}_wall', seed, (4.3, 0.6, wall_h * 0.5), (0, -0.5, wall_h * 0.5 - 1.1),
                   planes=4, vplanes=2, top=2),
             block(coll, f'{tag}_cap', seed + 2, (4.1, 1.2, 0.75), (0, -0.6, lip_z + lip_t * 0.45),
                   (rng.uniform(-2, 2), rng.uniform(-2, 2), 0), planes=5, vplanes=2, top=2)]
    lo, hi = -4.0, 4.0
    cuts = sorted(lo + (hi - lo) * (j + 1) / n_lip + rng.uniform(-0.35, 0.35) for j in range(n_lip - 1))
    edges = [lo] + cuts + [hi]
    for j in range(n_lip):
        x0, x1 = edges[j], edges[j + 1]
        front, back = -rng.uniform(4.45, 4.9), 0.05
        parts.append(block(coll, f'{tag}_lip{j}', seed + 1 + 13 * j,
                           (0.5 * (x1 - x0) + 0.08, 0.5 * (back - front), lip_t * 0.5 * rng.uniform(0.85, 1.0)),
                           (0.5 * (x0 + x1), 0.5 * (back + front), lip_z + rng.uniform(-0.22, 0.22)),
                           (rng.uniform(-3, 2), rng.uniform(-3, 3), rng.uniform(-3, 3)),
                           planes=4, vplanes=2, reach=(0.72, 0.90)))
    for k in range(3):  # buttress blocks on the wall foot (kept inside the undercut line)
        parts.append(block(coll, f'{tag}_ft{k}', seed + 5 + k, (0.9, 0.35, 0.8), (-2.8 + 2.8 * k, -0.85, 0.1),
                           (0, 0, rng.uniform(-8, 8)), planes=5))
    parts += rubble(coll, tag, seed, 4, 3.6, (-3.6, -2.4), size=(0.25, 0.5))
    recipe = dict(macro=(0.06, 1.8), heights=((0, 2.4, 0.050), (1, 0.8, 0.022), (0, 0.30, 0.008)),
                  strata=dict(bed=0.6, amp=0.030, dip=(0.05, 0.03, 1.0)), chips=0.02,
                  notch=dict(z=notch_z, width=0.7, depth=0.18))
    return parts, 2, recipe


def form_overhang_a(coll):
    return form_overhang(coll, 'oa', 6423, wall_h=8.8, lip_z=6.2, lip_t=2.2, notch_z=1.0, n_lip=4)


def form_overhang_b(coll):
    return form_overhang(coll, 'ob', 6547, wall_h=6.0, lip_z=3.9, lip_t=1.8, notch_z=0.4, n_lip=3)


# ── shelves with tide pools ──────────────────────────────────────────────────────────────────
def form_shelf(coll, tag, seed, cells, pools):
    """cells: ((x, y, half w, half d, top z), ...) jointed slab blocks, each rooted at z -0.9, with
    near-vertical fracture planes so the outline in plan is irregular and wave-cut, plus one lower
    seaward step; pools: ((x, y, rx, ry, depth), ...) carved, BEFORE the union remesh, into every
    slab of the host step (the highest slab holding the pool centre) that the pool can touch."""
    rng = random.Random(seed)
    slabs = []
    for k, (x, y, hw, hd, top) in enumerate(cells):
        t = top + 0.9
        slabs.append(block(coll, f'{tag}_s{k}', seed + 17 * k, (hw, hd, t * 0.5), (x, y, top - t * 0.5),
                           (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5), rng.uniform(-10, 10)),
                           planes=4, reach=(0.74, 0.90), vplanes=4, vreach=(0.56, 0.74)))
    for j, (px, py, rx, ry, dp) in enumerate(pools):
        host = max((c for c in cells if abs(px - c[0]) < c[2] and abs(py - c[1]) < c[3]), key=lambda c: c[4])
        a = rng.uniform(0.0, math.tau)  # a second, shallower lobe: a pool, not a drilled hole
        bowls = (((px, py, host[4] + dp * 0.35), (rx, ry, dp * 1.35)),
                 ((px + 0.55 * rx * math.cos(a), py + 0.55 * ry * math.sin(a), host[4] + dp * 0.25),
                  (0.62 * rx, 0.62 * ry, dp)))
        for k, (x, y, hw, hd, top) in enumerate(cells):
            if abs(px - x) < hw + 1.2 * rx and abs(py - y) < hd + 1.2 * ry and top >= host[4] - 0.15:
                for b, (bc, br) in enumerate(bowls):
                    carve(slabs[k], ellipsoid(coll, f'{tag}_p{k}{j}{b}', bc, br))
    parts = list(slabs)
    xs = [c[0] - c[2] for c in cells] + [c[0] + c[2] for c in cells]
    ys = [c[1] - c[3] for c in cells] + [c[1] + c[3] for c in cells]
    parts.append(block(coll, f'{tag}_base', seed + 30, (0.45 * (max(xs) - min(xs)), 0.45 * (max(ys) - min(ys)), 0.3),
                       (0.5 * (max(xs) + min(xs)), 0.5 * (max(ys) + min(ys)), -0.6), planes=5, vplanes=3))
    parts += rubble(coll, tag, seed, 5, 4.0, (-3.6, 3.6), size=(0.25, 0.45))
    recipe = dict(macro=(0.04, 1.4), heights=((0, 1.6, 0.030), (1, 0.6, 0.014), (0, 0.24, 0.006)),
                  strata=dict(bed=0.35, amp=0.020, dip=(0.03, 0.02, 1.0)), chips=0.012)
    return parts, 2, recipe


SHELF_POOLS = {
    'rock_shelf_a': ((-3.0, 0.9, 0.95, 0.75, 0.55), (0.7, 1.6, 0.80, 0.62, 0.55), (1.7, -1.8, 0.75, 0.58, 0.50)),
    'rock_shelf_b': ((-3.3, 0.9, 0.85, 0.70, 0.55), (-0.4, -1.3, 0.70, 0.55, 0.50), (2.6, 1.0, 0.80, 0.62, 0.55)),
}
SHELF_CELLS = {  # 5 platform slabs + a 2-slab lower seaward step / 4 lower + 2 upper-step slabs
    'rock_shelf_a': ((-3.0, 0.9, 2.1, 2.5, 0.55), (0.7, 1.5, 1.7, 2.0, 0.60), (3.5, 0.7, 1.5, 2.4, 0.52),
                     (-2.3, -1.9, 2.4, 1.4, 0.48), (1.7, -1.8, 2.1, 1.5, 0.50),
                     (-2.1, -3.4, 2.2, 0.9, 0.14), (2.3, -3.2, 1.9, 0.7, 0.22)),
    'rock_shelf_b': ((-3.3, 0.9, 1.6, 2.3, 0.45), (-3.1, -2.0, 1.7, 1.2, 0.38), (-0.4, -1.4, 1.5, 1.9, 0.47),
                     (-0.6, 1.9, 1.3, 1.4, 0.42), (2.6, 1.0, 2.0, 2.2, 1.30), (2.8, -2.1, 1.8, 1.2, 1.20)),
}


def form_shelf_a(coll):
    return form_shelf(coll, 'sa', 6661, SHELF_CELLS['rock_shelf_a'], SHELF_POOLS['rock_shelf_a'])


def form_shelf_b(coll):
    return form_shelf(coll, 'sb', 6779, SHELF_CELLS['rock_shelf_b'], SHELF_POOLS['rock_shelf_b'])


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


# ══ CLIFF KIT II (b4.6b; islands-02, islands-08, islands-14; PLAN section 6 row 17) ══════════════
#   sea_arch_a       SAIL-THROUGH sea arch: two jointed legs, a 4-block lintel. The channel is clear
#                    18 m wide (|x| <= 9) from the root to the galleon main truck + 1 m, and 20 m
#                    wide up to the course yard head + 1 m (src/shared/hull.ts getShipRigPlan; the
#                    GLB is graded by scripts/test-cliff-kit.mjs). z = 0 is the DESIGN WATERLINE:
#                    placement (b4.6d) must not sink it, legs root 4 m down for the seabed.
#   sea_arch_b       LAND BRIDGE: two piers and a flat jointed deck >= 2.5 m walkable at the crown.
#   basalt_columns_a volcanic biome: a hex-packed colonnade of capped columns + fallen drums.
#   scree_fan_a      talus cone for a cliff foot, sorted (the big blocks rolled furthest).
#   searock_d/e/f/g  sea-stack silhouettes that are NOT the tiered pagoda (islands-14): leaning
#                    stack, twin stack with a hole, broken stump + fallen top, low skerry cluster;
#                    vertical jointing (column courses + joints), not level ledges.
#   strata_slab_*, spire_*, reef_*  the kit forms that replace TerrainFeatures' BoxGeometry /
#                    ConeGeometry / DodecahedronGeometry primitives (islands-08; wiring is b4.6d).
GALLEON_TRUCK = 23.74   # galleon main truckY above the waterline (hull.ts getShipRigPlan, measured)
ARCH_HALF_SPAN = 9.0    # 18 m sail-through span
YARD_HALF, YARD_TOP = 10.0, 14.62  # course yard halfSpan 9 + 1 m, course head 13.62 + 1 m
BRIDGE_WALK_MIN = 2.5


def _jitter_rot(rng, a=2.0, b=2.0):
    return (rng.uniform(-a, a), rng.uniform(-a, a), rng.uniform(-b, b))


def hull_mesh(coll, name, pts):
    """Convex hull of a point set as a mesh object (scree cone, b4.6b2)."""
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    drop = {v for v in list(res['geom_interior']) + list(res['geom_unused']) if isinstance(v, bmesh.types.BMVert)}
    if drop:
        bmesh.ops.delete(bm, geom=list(drop), context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


def taper(obj, k, z0, z1, cx, cy):
    """Narrow a column toward its head (factor 1 - k at z1) about the axis (cx, cy)."""
    for v in obj.data.vertices:
        f = 1.0 - k * min(1.0, max(0.0, (v.co.z - z0) / (z1 - z0)))
        v.co.x = cx + (v.co.x - cx) * f
        v.co.y = cy + (v.co.y - cy) * f
    obj.data.update()


def shear(obj, lean, z0=0.0):
    """Lean by shearing (dx/dz, dy/dz): joints stay vertical-ish, no rotated course steps."""
    for v in obj.data.vertices:
        v.co.x += lean[0] * (v.co.z - z0)
        v.co.y += lean[1] * (v.co.z - z0)
    obj.data.update()


ARCH_A, ARCH_Z0, ARCH_B = 11.9, 9.5, 18.5  # superellipse intrados (n = 4): z(9 m) = 26.26, crown 28.0


def _intrados(n=4.0, steps=600):
    out = []
    for i in range(steps + 1):
        phi = math.pi * i / steps
        c, s_ = math.cos(phi), math.sin(phi)
        out.append((ARCH_A * math.copysign(abs(c) ** (2.0 / n), c), ARCH_Z0 + ARCH_B * abs(s_) ** (2.0 / n)))
    return out


def form_sea_arch_a(coll, seed=7101):
    """b4.6b2: a rock arch, not a doorway. Legs are a few tall joint-bounded masses (foot, shaft,
    buttress, front flake) instead of equal courses; the opening is a superellipse intrados lined by
    voussoir blocks whose inner faces are TANGENT to the curve (a flat chord of a concave-down curve
    lies above it, so no block dips into the channel), each recessed 0.15-0.7 m at random: an
    irregular, stepped soffit. Spandrels and a crown mass sit outside the intrados."""
    rng = random.Random(seed)
    parts = []
    for si, side in enumerate((-1.0, 1.0)):
        inner = ARCH_A + 0.45 + rng.uniform(0.0, 0.35)
        parts.append(block(coll, f'aa_f{si}', seed + 31 * si, (5.2, 5.0, 6.0),
                           (side * (inner + 5.2), rng.uniform(-0.6, 0.6), 1.6), (rng.uniform(-2, 2), 0, rng.uniform(-7, 7)),
                           planes=5, vplanes=4, vreach=(0.58, 0.78)))
        parts.append(block(coll, f'aa_u{si}', seed + 37 * si + 3, (4.3, 4.4, 6.0),
                           (side * (inner + 0.3 + 4.3), rng.uniform(-0.5, 0.5), 12.6), (rng.uniform(-2, 2), side * -2.0, rng.uniform(-5, 5)),
                           planes=4, vplanes=3, vreach=(0.60, 0.80)))
        parts.append(block(coll, f'aa_b{si}', seed + 41 * si + 5, (2.2, 3.4, 7.5),
                           (side * (inner + 10.0), rng.uniform(-1.0, 1.0), 2.5), (rng.uniform(-3, 3), side * 6.0, rng.uniform(-8, 8)),
                           planes=4, vplanes=3))
        parts.append(block(coll, f'aa_k{si}', seed + 43 * si + 7, (1.6, 1.2, 7.0),
                           (side * (inner + 4.0 + rng.uniform(-0.8, 0.8)), -5.0, 4.0 + rng.uniform(-1, 1)),
                           (rng.uniform(-3, 3), side * 3.0, rng.uniform(-10, 10)), planes=4, vplanes=2))
        parts.append(block(coll, f'aa_s{si}', seed + 47 * si + 9, (3.6, 3.8, 5.6),
                           (side * (ARCH_A + 0.6 + 3.6), rng.uniform(-0.4, 0.4), 23.0), (0, side * -4.0, rng.uniform(-4, 4)),
                           planes=4, vplanes=2))
        parts.append(block(coll, f'aa_h{si}', seed + 53 * si + 11, (5.0, 3.7, 3.0),
                           (side * 9.0, rng.uniform(-0.3, 0.3), 31.8), (0, side * 14.0, rng.uniform(-3, 3)), planes=4, vplanes=2))
    curve = [p for p in _intrados() if p[1] >= 16.5]
    acc = [0.0]
    for (x0, z0), (x1, z1) in zip(curve, curve[1:]):
        acc.append(acc[-1] + math.hypot(x1 - x0, z1 - z0))
    L, nv = acc[-1], 11
    for k in range(nv):
        s_ = min(L, max(0.0, (k + 0.5) / nv * L + rng.uniform(-0.12, 0.12) * L / nv))
        i = min(len(curve) - 2, next(j for j, a in enumerate(acc) if a >= s_))
        (x0, z0), (x1, z1) = curve[i], curve[i + 1]
        dl = math.hypot(x1 - x0, z1 - z0)
        tx, tz = (x1 - x0) / dl, (z1 - z0) / dl
        nx, nz = tz, -tx  # outward (into the rock)
        recess = rng.uniform(0.15, 0.70)
        hr = rng.uniform(2.0, 2.6)
        ht = 0.5 * L / nv + rng.uniform(0.45, 0.75)
        c = (x0 + nx * (hr + recess), rng.uniform(-0.3, 0.3), z0 + nz * (hr + recess))
        parts.append(block(coll, f'aa_v{k}', seed + 200 + k, (ht, rng.uniform(3.4, 3.9), hr), c,
                           (rng.uniform(-1.0, 1.0), math.degrees(math.atan2(nx, nz)), rng.uniform(-2, 2)),
                           planes=4, reach=(0.72, 0.90)))
    edges = [-14.0, -4.5 + rng.uniform(-0.6, 0.6), 4.5 + rng.uniform(-0.6, 0.6), 14.0]
    for j in range(3):
        x0, x1 = edges[j], edges[j + 1]
        top = 34.0 + rng.uniform(-0.8, 0.6)
        parts.append(block(coll, f'aa_m{j}', seed + 120 + j, (0.5 * (x1 - x0) + 0.4, rng.uniform(3.4, 3.8), 0.5 * (top - 30.0)),
                           (0.5 * (x0 + x1), rng.uniform(-0.3, 0.3), 0.5 * (top + 30.0)), (rng.uniform(-1, 1), 0, rng.uniform(-3, 3)),
                           planes=4, vplanes=2, top=2, top_reach=(0.44, 0.53)))
    for k in range(3):
        parts.append(block(coll, f'aa_c{k}', seed + 140 + k, (rng.uniform(2.0, 3.2), rng.uniform(2.0, 2.8), 0.9),
                           (rng.uniform(-12, 12), rng.uniform(-1, 1), 34.2), _jitter_rot(rng, 4, 20), planes=5, top=2))
    for k in range(8):  # awash boulders at the leg feet, never in the channel
        side = -1.0 if k % 2 else 1.0
        s = rng.uniform(0.7, 1.4)
        parts.append(cell(coll, f'aa_rb{k}', seed + 160 + k, (s, s * 0.85, s * 0.7),
                          (side * rng.uniform(13.5, 19.5), rng.uniform(-6.0, 6.0), rng.uniform(-0.6, 0.2)),
                          _jitter_rot(rng, 25, 180), planes=8, reach=(0.62, 0.92), points=600, caps=(0.88,)))
    joints = tuple(((sx * (13.5 + 2.6 * k), -5.2, 10.0), (0.96, 0.28 * sx, 0.0), 0.06, 0.24)
                   for sx in (-1, 1) for k in range(3))
    recipe = dict(macro=(0.14, 3.2), heights=((0, 3.0, 0.07), (1, 1.0, 0.028), (0, 0.36, 0.009)),
                  strata=dict(bed=2.8, amp=0.06, dip=(0.22, 0.08, 1.0)), joints=joints,
                  notch=dict(z=0.4, width=1.2, depth=0.40), chips=0.035)
    return parts, 2, recipe


def form_sea_arch_b(coll, seed=7203):
    """Land bridge: piers 12 m apart, deck 4 m deep with a FLAT top (no crest planes) at z ~9."""
    rng = random.Random(seed)
    parts = []
    for si, side in enumerate((-1.0, 1.0)):
        for k, (z0, h, hx, hy) in enumerate(((-1.4, 3.6, 3.0, 3.4), (2.0, 3.6, 2.6, 3.0), (5.4, 3.0, 2.4, 2.8))):
            parts.append(block(coll, f'ab_l{si}{k}', seed + 31 * si + 7 * k, (hx, hy, h * 0.5 + 0.15),
                               (side * (6.2 + hx + rng.uniform(0, 0.3)), rng.uniform(-0.3, 0.3), z0 + h * 0.5),
                               (0, rng.uniform(-1, 1), rng.uniform(-5, 5)), planes=4, vplanes=3))
    edges = [-11.2, -3.8 + rng.uniform(-0.3, 0.3), 3.8 + rng.uniform(-0.3, 0.3), 11.2]
    for j in range(3):
        x0, x1 = edges[j], edges[j + 1]
        parts.append(block(coll, f'ab_d{j}', seed + 70 + j, (0.5 * (x1 - x0) + 0.3, 2.05, 1.25),
                           (0.5 * (x0 + x1), rng.uniform(-0.08, 0.08), 7.85 + rng.uniform(-0.05, 0.05)),
                           (rng.uniform(-0.6, 0.6), rng.uniform(-0.8, 0.8), rng.uniform(-1.5, 1.5)),
                           planes=2, reach=(0.84, 0.94), vplanes=2, vreach=(0.80, 0.90)))
    parts.append(block(coll, 'ab_keel', seed + 80, (6.6, 1.5, 0.8), (0, 0, 6.5), planes=4))
    for k in range(6):
        side = -1.0 if k % 2 else 1.0
        s = rng.uniform(0.4, 0.8)
        parts.append(cell(coll, f'ab_rb{k}', seed + 90 + k, (s, s * 0.85, s * 0.7),
                          (side * rng.uniform(7.5, 11.0), rng.uniform(-4.0, 4.0), rng.uniform(-0.3, 0.1)),
                          _jitter_rot(rng, 25, 180), planes=8, reach=(0.62, 0.92), points=600, caps=(0.88,)))
    recipe = dict(macro=(0.05, 2.4), heights=((0, 2.4, 0.045), (1, 0.8, 0.020), (0, 0.30, 0.007)),
                  strata=dict(bed=0.9, amp=0.035, dip=(0.04, 0.02, 1.0)), chips=0.02)
    return parts, 2, recipe


def form_basalt(coll, seed=7307):
    rng = random.Random(seed)
    parts = [block(coll, 'bc_root', seed, (3.6, 3.2, 0.6), (0, 0, -0.5), planes=5, vplanes=3)]
    r0 = 0.62
    k = 0
    for q in range(-3, 4):
        for rr in range(-3, 4):
            x = r0 * 1.73 * (q + rr * 0.5)
            y = r0 * 1.5 * rr
            d = math.hypot(x, y)
            if d > 3.2 or rng.random() < 0.08:
                continue
            top = 6.8 - 1.45 * d + rng.uniform(-0.6, 0.4)
            if top < 0.6:
                continue
            h = top + 1.0
            r = r0 * rng.uniform(0.93, 1.0)
            parts.append(block(coll, f'bc_c{k}', seed + 11 * k, (r, r, h * 0.5), (x, y, top - h * 0.5),
                               (rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(0, 60)), sides=6, planes=1,
                               reach=(0.66, 0.76), top=1, top_reach=(0.48, 0.54)))
            k += 1
    for j in range(4):
        r = r0 * rng.uniform(0.85, 1.0)
        a = rng.uniform(0, math.tau)
        parts.append(block(coll, f'bc_f{j}', seed + 300 + j, (r, r, rng.uniform(0.5, 1.1)),
                           (math.cos(a) * rng.uniform(3.6, 4.6), math.sin(a) * rng.uniform(3.6, 4.6), 0.1),
                           (rng.uniform(70, 95), 0, rng.uniform(0, 180)), sides=6, planes=1, reach=(0.62, 0.74)))
    recipe = dict(macro=(0.03, 1.4), heights=((0, 1.6, 0.030), (1, 0.6, 0.014), (0, 0.24, 0.006)),
                  strata=dict(bed=0.55, amp=0.020, dip=(0.0, 0.0, 1.0)), chips=0.015)
    return parts, 1, recipe


def form_scree(coll, seed=7411):
    """b4.6b2: a talus cone, not a plinth: a smooth inclined half-cone (apex against the cliff at
    y = 3.4, z = 2.8) under ~44 clasts sorted by size downslope plus run-out boulders past the toe."""
    rng = random.Random(seed)
    AY, AZ, RX, RY = 3.4, 2.8, 4.6, 6.8
    pts = [(0.0, AY, AZ), (0.0, AY, -0.7), (-0.5, AY, AZ - 0.15), (0.5, AY, AZ - 0.15)]
    for i in range(33):
        a = math.pi + math.pi * i / 32
        pts.append((RX * math.cos(a), AY + RY * math.sin(a), -0.1))
        pts.append((RX * 1.05 * math.cos(a), AY + RY * 1.05 * math.sin(a), -0.7))
    parts = [hull_mesh(coll, 'sf_cone', pts)]
    for k in range(44):
        t = rng.random() ** 0.75
        a = math.pi + rng.uniform(0.07, 0.93) * math.pi
        s = (0.12 + 0.48 * t ** 1.4) * rng.uniform(0.7, 1.15)
        z = AZ * (1.0 - t) - 0.1 * t + s * 0.2
        parts.append(cell(coll, f'sf_r{k}', seed + 10 + k, (s, s * 0.8, s * 0.6),
                          (RX * t * math.cos(a), AY + RY * t * math.sin(a), z), _jitter_rot(rng, 30, 180),
                          planes=8, reach=(0.6, 0.9), points=500, caps=(0.86,)))
    for j in range(4):
        t = rng.uniform(1.0, 1.18)
        a = math.pi + rng.uniform(0.15, 0.85) * math.pi
        s = rng.uniform(0.6, 0.95)
        parts.append(cell(coll, f'sf_o{j}', seed + 80 + j, (s, s * 0.8, s * 0.6),
                          (RX * t * math.cos(a), AY + RY * t * math.sin(a), s * 0.25 - 0.1), _jitter_rot(rng, 30, 180),
                          planes=8, reach=(0.6, 0.9), points=500, caps=(0.86,)))
    recipe = dict(macro=(0.02, 1.0), heights=((0, 1.4, 0.022), (1, 0.5, 0.010), (0, 0.2, 0.004)), chips=0.012)
    return parts, 1, recipe


def _stack(coll, tag, seed, courses, sides=7, lean=(0.0, 0.0)):
    """courses: (z0, h, r) column courses, offset along `lean` (dx/dz, dy/dz): vertical jointing."""
    rng = random.Random(seed)
    out = []
    for k, (z0, h, r) in enumerate(courses):
        zc = z0 + h * 0.5
        out.append(block(coll, f'{tag}_k{k}', seed + 13 * k, (r * rng.uniform(0.95, 1.08), r * rng.uniform(0.88, 1.0), h * 0.5 + 0.25),
                         (lean[0] * zc + rng.uniform(-0.2, 0.2), lean[1] * zc + rng.uniform(-0.2, 0.2), zc),
                         (math.degrees(math.atan(lean[1])) * -1, math.degrees(math.atan(lean[0])), rng.uniform(0, 60)),
                         sides=sides, planes=3, reach=(0.66, 0.84), top=(2 if k == len(courses) - 1 else 0)))
    return out


def _awash(coll, tag, seed, n, rad, size=(0.5, 1.1), centre=(0.0, 0.0)):
    rng = random.Random(seed)
    out = []
    for k in range(n):
        a = rng.uniform(0, math.tau)
        d = rng.uniform(*rad)
        s = rng.uniform(*size)
        out.append(cell(coll, f'{tag}_aw{k}', seed + 40 + k, (s, s * 0.85, s * 0.65),
                        (centre[0] + math.cos(a) * d, centre[1] + math.sin(a) * d, rng.uniform(-0.6, 0.1)),
                        _jitter_rot(rng, 25, 180), planes=8, reach=(0.62, 0.92), points=600, caps=(0.88,)))
    return out


SEA_RECIPE = dict(macro=(0.10, 2.4), heights=((0, 2.4, 0.055), (1, 0.8, 0.024), (0, 0.30, 0.008)),
                  strata=dict(bed=1.6, amp=0.025, dip=(0.10, 0.04, 1.0)), notch=dict(z=0.3, width=0.9, depth=0.30),
                  chips=0.03)


def _vjoints(r, h, n, seed):
    rng = random.Random(seed)
    return tuple(((math.cos(a) * r, math.sin(a) * r, h * 0.5), (-math.sin(a), math.cos(a), 0.0), 0.05, 0.22)
                 for a in (rng.uniform(0, math.tau) for _ in range(n)))


def form_searock_d(coll, seed=7501):
    """Leaning stack: five column courses offset 0.3 m per metre, irregular vertical joints."""
    parts = _stack(coll, 'sd', seed, ((-1.6, 4.6, 3.4), (2.6, 4.2, 3.0), (6.3, 4.0, 2.6), (9.8, 3.6, 2.2), (12.9, 2.8, 1.7)),
                   lean=(0.30, 0.06))
    parts += _awash(coll, 'sd', seed, 6, (3.6, 5.8))
    return parts, 2, dict(SEA_RECIPE, joints=_vjoints(2.6, 12.0, 6, seed))


def form_searock_e(coll, seed=7607):
    """Twin stack with a hole: two stacks bridged by a lintel; the hole is clear |x| < 1.2, z 0.8-5."""
    parts = _stack(coll, 'se0', seed, ((-1.6, 4.4, 2.5), (2.4, 4.4, 2.2), (6.4, 4.2, 2.0), (10.2, 3.4, 1.6)), lean=(-0.03, 0.0))
    for o in parts:
        for v in o.data.vertices:
            v.co.x -= 4.3
    p2 = _stack(coll, 'se1', seed + 500, ((-1.6, 4.0, 2.2), (2.0, 4.0, 2.0), (5.6, 3.6, 1.8)), lean=(0.04, 0.02))
    for o in p2:
        for v in o.data.vertices:
            v.co.x += 4.2
    parts += p2
    parts.append(block(coll, 'se_lintel', seed + 900, (3.6, 1.7, 1.3), (0.0, 0.1, 7.3), (0, 4, 0), planes=4, vplanes=2))
    parts += _awash(coll, 'se', seed, 6, (5.6, 7.6))
    return parts, 2, dict(SEA_RECIPE, joints=_vjoints(2.2, 10.0, 6, seed))


def form_searock_f(coll, seed=7709):
    """Broken stump (b4.6b2): three irregular joint-bounded masses (no polygonal drum, no radial
    joints), a tall shard on one side and a lower shoulder, both with snapped crests; parallel joint
    set + one cross joint; the fallen top lies beside it."""
    rng = random.Random(seed)
    parts = [block(coll, 'sf0', seed, (3.9, 3.3, 2.0), (0, 0, 0.4), (0, 0, 17), planes=6, vplanes=5, vreach=(0.56, 0.76)),
             block(coll, 'sf1', seed + 1, (2.0, 2.4, 2.9), (-1.6, 0.6, 3.0), (6, -9, 30), planes=4, vplanes=3,
                   top=5, top_reach=(0.30, 0.48)),
             block(coll, 'sf2', seed + 3, (2.4, 2.2, 1.6), (1.7, -0.5, 2.4), (-8, 12, -20), planes=5, vplanes=2,
                   top=4, top_reach=(0.32, 0.50)),
             block(coll, 'sf_top', seed + 2, (2.0, 1.8, 3.4), (6.4, 1.2, 0.4), (0, 72, rng.uniform(10, 30)),
                   planes=5, vplanes=3, top=2)]
    parts += _awash(coll, 'sfx', seed, 5, (4.6, 6.4))
    joints = (((-2.3, 0.0, 2.5), (0.97, 0.24, 0.0), 0.05, 0.20), ((0.35, 0.0, 2.5), (0.90, -0.42, 0.0), 0.05, 0.16),
              ((0.4, 1.3, 2.5), (-0.25, 0.97, 0.0), 0.05, 0.14))  # irregular, non-radial, unequal spacing
    return parts, 2, dict(SEA_RECIPE, joints=joints)


def form_searock_g(coll, seed=7811):
    """Low skerry cluster: seven rocks (tops 0.4-1.9 m) on a drowned ledge."""
    rng = random.Random(seed)
    parts = [block(coll, 'sg_base', seed, (6.8, 4.4, 0.45), (0, 0, -0.85), planes=4, vplanes=4, vreach=(0.58, 0.76))]
    spots = ((-4.6, 1.2, 1.9, 1.7), (-1.6, -1.4, 1.4, 1.4), (1.6, 1.6, 1.1, 1.6), (4.4, -0.6, 1.6, 1.2),
             (-2.2, 2.8, 0.6, 1.0), (2.6, -2.8, 0.5, 0.9), (5.8, 2.4, 0.4, 0.8))
    for k, (x, y, top, r) in enumerate(spots):
        h = top + 1.1
        parts.append(block(coll, f'sg_r{k}', seed + 17 * k, (r * rng.uniform(1.0, 1.5), r, h * 0.5), (x, y, top - h * 0.5),
                           (rng.uniform(-8, 8), rng.uniform(-14, 14), rng.uniform(0, 180)), planes=5, vplanes=3, top=1))
    return parts, 2, dict(SEA_RECIPE, macro=(0.06, 1.8))


def form_strata(seed, beds, dip):
    """b4.6b2: beds share one strong dip (rotation about X) and stack along the bed normal, each
    offset in x and up-dip so the ledges step sideways: a tilted outcrop, not a stepped plinth."""
    def f(coll):
        rng = random.Random(seed)
        d = math.radians(dip)
        nrm = Vector((0.0, -math.sin(d), math.cos(d)))
        updip = Vector((0.0, math.cos(d), math.sin(d)))
        parts = []
        z = 0.0
        hw0, hd0 = beds[0][0], beds[0][1]
        for k, (hw, hd, t) in enumerate(beds):
            # cuesta: beds keep most of their width, their down-dip ends line up into one dip slope and
            # the up-dip (scarp) ends step back bed by bed; alternate x offsets break the pyramid.
            hw_k, hd_k = max(hw, hw0 * (1.0 - 0.08 * k)), max(hd, hd0 * (1.0 - 0.16 * k))
            sx = (0.35 * k if k % 2 else -0.3 * k) + rng.uniform(-0.15, 0.15)
            c = (Vector((0.0, 0.0, -0.7)) + nrm * (z + t * 0.5) + Vector((sx, 0.0, 0.0))
                 + updip * (hd_k - hd0 + rng.uniform(-0.12, 0.12)))
            parts.append(block(coll, f'st{seed}_{k}', seed + 11 * k, (hw_k, hd_k, t * 0.5 + 0.04), tuple(c),
                               (dip + rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-6, 6)), planes=4, vplanes=3,
                               vreach=(0.58, 0.78)))
            z += t
        recipe = dict(macro=(0.03, 1.2), heights=((0, 1.4, 0.025), (1, 0.5, 0.011), (0, 0.22, 0.005)),
                      strata=dict(bed=0.22, amp=0.014, dip=(0.03, -math.sin(d), math.cos(d))), chips=0.012)
        return parts, 1, recipe
    return f


def form_spire(seed, cols, lean):
    """b4.6b2: a bundle of tall single columns (dx, dy, r, h), each full height, tapered and sheared
    (no stacked courses, no level steps: the islands-14 pagoda tell), heads at different heights with
    snapped crests; vertical joints only (no bedding grooves)."""
    def f(coll):
        rng = random.Random(seed)
        parts = []
        for k, (dx, dy, r, h) in enumerate(cols):
            z0 = -0.8 - rng.uniform(0.0, 0.3)
            o = block(coll, f'sp{seed}_{k}', seed + 13 * k, (r * rng.uniform(0.95, 1.1), r * rng.uniform(0.80, 0.95), h * 0.5),
                      (dx, dy, z0 + h * 0.5), (0, 0, rng.uniform(0, 180)), planes=2, reach=(0.70, 0.86),
                      vplanes=4, vreach=(0.60, 0.80), top=3, top_reach=(0.40, 0.52))
            taper(o, rng.uniform(0.36, 0.48), z0, z0 + h, dx, dy)
            shear(o, (lean[0] + rng.uniform(-0.03, 0.03), lean[1] + rng.uniform(-0.03, 0.03)))
            parts.append(o)
        r0, h0 = cols[0][2], cols[0][3]
        joints = _vjoints(r0 * 0.8, h0 * 0.5, 4, seed) + tuple(
            ((0.5 * dx, 0.5 * dy, h0 * 0.4), (dx, dy, 0.0), 0.06, 0.24) for dx, dy, _, _ in cols[1:])
        recipe = dict(macro=(0.05, 1.6), heights=((0, 1.8, 0.035), (1, 0.6, 0.016), (0, 0.25, 0.006)),
                      joints=joints, chips=0.02)
        return parts, 1, recipe
    return f


def form_reef(seed, hw, hd, top, pockets):
    """b4.6b2: low, ragged, multi-lobed awash rock: five lobes of differing height along a bent
    spine, ragged in plan, with real pockets (0.3-0.4 m deep bowls carved where lobes meet the
    pocket) and a few loose stones."""
    def f(coll):
        rng = random.Random(seed)
        n = 5
        bend = rng.uniform(-0.5, 0.5)
        lobes = []
        for k in range(n):
            u = -1.0 + 2.0 * (k + 0.5) / n
            x = u * hw * 0.82 + rng.uniform(-0.2, 0.2) * hw / n
            y = hd * (bend * (u * u - 0.4) + rng.uniform(-0.25, 0.25))
            t = top * rng.uniform(0.45, 1.3)
            hx, hy = hw / n * rng.uniform(1.2, 1.7), hd * rng.uniform(0.45, 0.8)
            o = block(coll, f'rf{seed}_{k}', seed + 7 * k, (hx, hy, (t + 0.8) * 0.5), (x, y, (t - 0.8) * 0.5),
                      (rng.uniform(-6, 6), rng.uniform(-6, 6), rng.uniform(-35, 35)), planes=6, reach=(0.60, 0.86),
                      vplanes=5, vreach=(0.50, 0.72), top=3, top_reach=(0.42, 0.53))
            lobes.append((o, x, y, t, hx, hy))
        for j, li in enumerate(rng.sample(range(n), min(pockets, n))):
            _, x, y, t, hx, hy = lobes[li]
            c = (x + rng.uniform(-0.4, 0.4) * hx, y + rng.uniform(-0.3, 0.3) * hy, t + 0.12)
            r = (rng.uniform(0.35, 0.6), rng.uniform(0.30, 0.5), 0.5)
            for o2, *_ in lobes:
                vs = [v.co for v in o2.data.vertices]
                if (min(v.x for v in vs) < c[0] + r[0] and max(v.x for v in vs) > c[0] - r[0]
                        and min(v.y for v in vs) < c[1] + r[1] and max(v.y for v in vs) > c[1] - r[1]
                        and max(v.z for v in vs) > c[2] - r[2]):
                    carve(o2, ellipsoid(coll, f'rf{seed}_p{j}_{o2.name}', c, r))
        parts = [o for o, *_ in lobes] + [cell(coll, f'rf{seed}_n{k}', seed + 20 + k, (s, s * 0.8, s * 0.6),
                                               (rng.uniform(-hw, hw) * 1.05, rng.uniform(-hd, hd) * 1.1, top * 0.4),
                                               _jitter_rot(rng, 20, 180), planes=7, reach=(0.6, 0.9), points=400, caps=(0.86,))
                                          for k, s in enumerate(rng.uniform(0.18, 0.32) for _ in range(4))]
        recipe = dict(macro=(0.03, 0.9), heights=((0, 1.0, 0.020), (1, 0.4, 0.010), (0, 0.18, 0.004)), chips=0.02)
        return parts, 1, recipe
    return f


# name: (form, LOD0 target, band, HIGH target, sea piece (wet waterline), moss)
KIT2_ROWS = (  # tuples, so provenance-scan finds each output name as a writer literal
    ('sea_arch_a', form_sea_arch_a, 25000, (20000, 30000), 480000, True, 0.30),
    ('sea_arch_b', form_sea_arch_b, 22000, (20000, 30000), 380000, False, 0.40),
    ('basalt_columns_a', form_basalt, 6500, (4000, 8000), 300000, False, 0.20),
    ('scree_fan_a', form_scree, 5200, (4000, 8000), 220000, False, 0.25),
    ('searock_d', form_searock_d, 7000, (4000, 8000), 350000, True, 0.30),
    ('searock_e', form_searock_e, 7400, (4000, 8000), 380000, True, 0.30),
    ('searock_f', form_searock_f, 6200, (4000, 8000), 300000, True, 0.30),
    ('searock_g', form_searock_g, 5600, (4000, 8000), 260000, True, 0.25),
    ('strata_slab_a', form_strata(7901, ((2.6, 1.8, 0.45), (2.2, 1.6, 0.40), (1.7, 1.2, 0.38), (1.1, 0.8, 0.32)), 28), 2400, (1500, 3000), 150000, False, 0.40),
    ('strata_slab_b', form_strata(7911, ((3.0, 1.4, 0.36), (2.6, 1.2, 0.34), (2.0, 1.0, 0.30)), 35), 2200, (1500, 3000), 150000, False, 0.40),
    ('strata_slab_c', form_strata(7921, ((2.0, 2.0, 0.55), (1.8, 1.6, 0.50), (1.4, 1.3, 0.44), (1.0, 0.9, 0.40), (0.6, 0.6, 0.30)), 24), 2600, (1500, 3000), 150000, False, 0.40),
    ('spire_a', form_spire(8001, ((0.0, 0.0, 1.35, 7.4), (1.15, 0.4, 0.85, 5.2), (-0.9, 0.75, 0.6, 2.8)), (0.05, 0.02)), 4400, (3000, 6000), 220000, False, 0.35),
    ('spire_b', form_spire(8011, ((0.0, 0.0, 1.7, 10.6), (-1.4, 0.5, 1.05, 7.6), (0.9, -1.1, 0.8, 4.4), (1.3, 0.9, 0.55, 2.4)), (-0.08, 0.04)), 5000, (3000, 6000), 260000, False, 0.35),
    ('spire_c', form_spire(8021, ((0.0, 0.0, 2.0, 12.8), (1.7, 0.6, 1.3, 9.6), (-1.2, -1.3, 1.0, 6.4), (-1.6, 1.0, 0.7, 3.0)), (0.12, -0.03)), 5400, (3000, 6000), 300000, False, 0.35),
    ('reef_a', form_reef(8101, 2.0, 1.4, 0.35, 3), 1600, (1000, 2000), 100000, True, 0.10),
    ('reef_b', form_reef(8111, 2.6, 1.2, 0.25, 4), 1700, (1000, 2000), 100000, True, 0.10),
    ('reef_c', form_reef(8121, 1.5, 1.5, 0.55, 3), 1500, (1000, 2000), 100000, True, 0.10),
)
KIT2 = {r[0]: r[1:] for r in KIT2_ROWS}


def channel_centre(low, zmax):
    """Arches: shift x so the channel (z 0..zmax, under the span) is centred on x = 0."""
    vs = [v.co for v in low.data.vertices if 0.0 < v.co.z < zmax]
    left = max(v.x for v in vs if v.x < 0)
    right = min(v.x for v in vs if v.x > 0)
    dx = -0.5 * (left + right)
    for v in low.data.vertices:
        v.co.x += dx
    low.data.update()
    return round(right - left, 2)


def arch_measure(low):
    vs = co_list(low)
    clear = min((v.z for v in vs if abs(v.x) < ARCH_HALF_SPAN), default=1e9)
    yard = min((v.z for v in vs if abs(v.x) < YARD_HALF), default=1e9)
    return dict(clearance=round(clear, 2), yard_clear=round(yard, 2))


def bridge_walk(obj):
    me = obj.data
    crown = [obj.matrix_world @ p.center for p in me.polygons if abs(p.center.x) < 2.0]
    top = max(c.z for c in crown)
    up = [obj.matrix_world @ p.center for p in me.polygons
          if abs(p.center.x) < 2.0 and p.normal.z > 0.80 and p.center.z > top - 1.0]
    under = min((v.co.z for v in me.vertices if abs(v.co.x) < 4.0 and v.co.z > 1.0), default=0.0)
    return dict(walk_w=round(max(c.y for c in up) - min(c.y for c in up), 2) if up else 0.0,
                deck_top=round(top, 2), underside=round(under, 2))


def build2(name, spec):
    form, target, band, high_t, sea, moss = spec
    t0 = time.time()
    coll = asset_collection(name)
    scratch = asset_collection(name + '_hi')
    parts, smooth_iters, recipe = form(scratch)
    high, voxel = fracture_cluster(parts, name + '_hi', high_tris=high_t, smooth_iters=smooth_iters)
    maxd = sculpt(high, sum(map(ord, name)), **recipe)
    hi_tris = tri_count(high)
    low = lod0(high, name, coll, target)
    bpy.data.objects.remove(high, do_unlink=True)
    rep = dict(high_tris=hi_tris, voxel=round(voxel, 4), max_disp=round(maxd, 3))
    if name.startswith('sea_arch'):
        rep['channel_w'] = channel_centre(low, 15.0 if name == 'sea_arch_a' else 4.0)
    if name == 'sea_arch_a':
        rep.update(arch_measure(low))
    if name == 'searock_e':
        rep['hole_clear'] = not any(abs(v.z - 2.9) < 2.0 and abs(v.x) < 1.0 for v in co_list(low))
    if name.startswith('reef'):  # b4.6b2: mixed tops, wet Rock_Sea + dry Rock_Grey patches
        zone3(low, [('Rock_Dark', lambda c, n: n.z < -0.35),
                    ('Rock_Grey', lambda c, n: n.z > 0.5 and c.z > 0.08
                     and math.sin(1.7 * c.x + 0.6) + math.sin(2.1 * c.y + 1.9 + 0.8 * c.x) > 0.2),
                    ('Rock_Sea', lambda c, n: True)])
    elif sea:
        zone3(low, [('Rock_Sea', lambda c, n: c.z < 0.55), ('Rock_Dark', lambda c, n: n.z < -0.35),
                    ('Rock_Grey', lambda c, n: True)])
    else:
        zone3(low, [('Rock_Dark', lambda c, n: n.z < -0.35 or c.z < 0.15), ('Rock_Grey', lambda c, n: True)])
    obj = finish(coll, name, moss=moss)
    if name == 'sea_arch_b':
        rep.update(bridge_walk(obj))
    path = export_collection_vc(coll, name + '.glb')
    info = verify_glb(path)
    rep.update(lod0_tris=info['tris'], materials=info['materials'], bbox=[info.get('bbox_min'), info.get('bbox_max')],
               secs=round(time.time() - t0, 1))
    print(f'CLIFF {name} ' + json.dumps(rep, default=str), flush=True)
    assert 0.6 * high_t <= hi_tris <= 1.4 * high_t, (name, 'high sculpt', hi_tris, high_t)
    assert band[0] <= info['tris'] <= band[1], (name, info['tris'], band)
    assert info['color0'], name
    if name == 'sea_arch_a':
        assert rep['clearance'] >= GALLEON_TRUCK + 1.0 and rep['yard_clear'] >= YARD_TOP, (name, rep)
    if name == 'sea_arch_b':
        assert rep['walk_w'] >= BRIDGE_WALK_MIN, (name, rep)
    if name == 'searock_e':
        assert rep['hole_clear'], (name, 'twin stack lost its hole')
    for o in coll.objects:
        o.hide_render = True
    return rep


clear_default_scene()
agx_palette()
REPORT = {}
KIT_SET = os.environ.get('CLIFF_SET', 'all')  # 1 = kit I, 2 = kit II (b4.6b), all
if KIT_SET in ('1', 'all'):
    for name, form in FORMS:
        if ONLY and name not in ONLY:
            continue
        REPORT[name] = build(name, form)
if KIT_SET in ('2', 'all'):
    for name, spec in KIT2.items():
        if ONLY and name not in ONLY:
            continue
        REPORT[name] = build2(name, spec)
print('CLIFF REPORT ' + json.dumps(REPORT, default=str))
print("CLIFF DONE")
