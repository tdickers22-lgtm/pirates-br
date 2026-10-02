# ROCK KIT v2 II (b4.5b; assets-08, PLAN 3.12 + section 6 row 13): crag.glb and rock_arch.glb on the
# shared rock core (_rock.py), the same HIGH sculpt -> welded LOD0 recipe as build_rocks.py.
#
#   crag       cliff band LOD0 10-16k. COLUMNAR / JOINTED bedrock pushed out of a hillside: a
#              ridge of tall prismatic Voronoi columns (few, near-vertical fracture planes and a
#              tilted flat cap each, so they read as basalt-like columns, not rounded blades),
#              tallest in the middle-back, cross-jointed by horizontal bedding grooves and split by
#              vertical joint fissures, on a buried root + shed rubble skirt so it seats into a slope
#              without daylight under the downhill edge. Was 1,340 tris of noise-displaced boxes.
#   rock_arch  arch band LOD0 20-30k. CARVED FROM ONE MASS: one big Voronoi block with a broad
#              elliptic tunnel cut through it by a boolean (water-worn arch, not "a sausage on two
#              blobs"), a fallen block at one foot and a cap shard, then voxel-unioned, smoothed
#              (water-worn edges), bedded and jointed. Was 4,800 tris / 14,400 split verts.
#
# Both are fitted per axis into the legacy game-space AABB (the HEAD GLBs measured 2026-10-02), so
# colliders, propBaseLift and the test-asset-bounds base pins (crag -1.55, rock_arch -0.286) hold.
# Underside / buried faces take Rock_Dark, the body Rock_Grey (the runtime triplanar 'rock' detail
# family keys on the Rock_* names). `<name>_lods.glb` (LOD1/LOD2/far) comes from build_lods.py
# (BR_LODS_ONLY=crag,rock_arch); no `_far.glb` is written here.
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_crag.py
# env: BR_EXPORT_DIR (output dir), CRAG_ONLY=crag|rock_arch
import bpy
import json
import math
import os
import random
import sys
import time
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())
exec(open(os.path.join(HERE, "_detail.py")).read())
exec(open(os.path.join(HERE, "_nature.py")).read())
exec(open(os.path.join(HERE, "_rock.py")).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
ONLY = {s.strip() for s in os.environ.get('CRAG_ONLY', '').split(',') if s.strip()}

# Blender-space (Z up) AABBs of the HEAD crag.glb / rock_arch.glb (game footprint + base pins).
BOXES = {
    'crag': ((-1.518, -0.733, -1.55), (1.600, 1.269, 3.400)),
    'rock_arch': ((-4.032, -1.603, -0.286), (4.023, 1.593, 4.479)),
}
BANDS = {'crag': (10000, 16000), 'rock_arch': (20000, 30000)}
TARGET = {'crag': 13000, 'rock_arch': 25000}


def fit_box(objs, box):
    lo, hi = Vector(box[0]), Vector(box[1])
    vs = [v for o in objs for v in o.data.vertices]
    amin = Vector(tuple(min(v.co[a] for v in vs) for a in range(3)))
    amax = Vector(tuple(max(v.co[a] for v in vs) for a in range(3)))
    for v in vs:
        for a in range(3):
            v.co[a] = lo[a] + (v.co[a] - amin[a]) * (hi[a] - lo[a]) / max(1e-6, amax[a] - amin[a])
    for o in objs:
        o.data.update()


def carve(obj, cutter):
    """Boolean difference (exact solver), cutter removed."""
    md = obj.modifiers.new('rk_carve', 'BOOLEAN')
    md.operation = 'DIFFERENCE'
    md.solver = 'EXACT'
    md.object = cutter
    _apply(obj, md)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def tunnel(coll, name, cx, cz, rx, rz, depth, segs=96):
    """An elliptic prism along Blender Y (the arch opening), slightly wavy so the soffit is not a
    perfect lathe."""
    import bmesh
    bm = bmesh.new()
    rng = random.Random(len(name))
    ring = []
    for i in range(segs):
        a = i / segs * math.tau
        w = 1.0 + 0.05 * math.sin(3 * a + 0.7) + 0.03 * math.sin(7 * a + rng.uniform(0, 3))
        ring.append((cx + math.cos(a) * rx * w, cz + math.sin(a) * rz * w))
    front = [bm.verts.new((x, -depth, z)) for x, z in ring]
    back = [bm.verts.new((x, depth, z)) for x, z in ring]
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bm.faces.new(list(reversed(front)))
    bm.faces.new(back)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


# ── crag: columnar / jointed bedrock ─────────────────────────────────────────────────────────
def form_crag(coll, seed=8171):
    rng = random.Random(seed)
    parts = []
    # (x, y, radius, top z, tilt x deg, tilt y deg): a ridge along +X, tallest middle-back.
    cols = [(-1.10, 0.20, 0.42, 1.55, -4, -11), (-0.62, -0.12, 0.40, 2.30, 3, -7),
            (-0.30, 0.42, 0.44, 2.75, -2, -4), (0.12, 0.05, 0.48, 3.40, 2, 3),
            (0.52, 0.48, 0.40, 2.95, -3, 6), (0.70, -0.22, 0.38, 2.05, 4, 9),
            (1.12, 0.25, 0.40, 1.70, -2, 14), (-0.05, -0.40, 0.34, 1.20, 6, 2)]
    for k, (x, y, r, top, tx, ty) in enumerate(cols):
        h = top + 1.30  # every column roots below the ground line
        c = voronoi_cell(f'cr_c{k}', coll, seed + 11 * k, scale=(r, r * 0.92, h * 0.5), planes=7,
                         reach=(0.80, 0.96), caps=(rng.uniform(0.86, 0.97),))
        parts.append(place(c, (x, y, top - h * 0.5), (tx, ty, rng.uniform(0, 60))))
    root = voronoi_cell('cr_root', coll, seed + 301, scale=(1.75, 1.05, 0.85), planes=10, reach=(0.62, 0.92))
    parts.append(place(root, (0.02, 0.22, -0.85), (0, 0, 8)))
    for k in range(6):  # shed column drums + rubble at the foot
        a = rng.uniform(0, math.tau)
        d = rng.uniform(1.05, 1.45)
        s = rng.uniform(0.22, 0.40)
        rb = voronoi_cell(f'cr_rb{k}', coll, seed + 500 + k, scale=(s, s * 0.85, s * 0.7), planes=8,
                          reach=(0.62, 0.92), points=600, caps=(0.88,))
        parts.append(place(rb, (math.cos(a) * d, 0.25 + math.sin(a) * d * 0.55, -0.20 + s * 0.2),
                           (rng.uniform(-35, 35), rng.uniform(-35, 35), rng.uniform(0, 180))))
    joints = (((-0.45, 0.15, 1.0), (0.94, 0.30, 0.0), 0.030, 0.10),
              ((0.32, 0.25, 1.4), (0.88, -0.45, 0.05), 0.030, 0.12),
              ((0.90, 0.05, 0.8), (0.97, 0.20, 0.0), 0.025, 0.08))
    recipe = dict(macro=(0.035, 1.1), heights=((0, 1.8, 0.035), (1, 0.6, 0.016), (0, 0.24, 0.006)),
                  strata=dict(bed=0.42, amp=0.022, dip=(0.06, 0.03, 1.0)), joints=joints, chips=0.016)
    return parts, 1, recipe


# ── rock_arch: carved from one mass ──────────────────────────────────────────────────────────
def form_arch(coll, seed=9241):
    rng = random.Random(seed)
    mass = voronoi_cell('ra_mass', coll, seed, scale=(4.15, 1.55, 2.55), planes=14, reach=(0.74, 0.96),
                        up_bias=1.5, caps=(0.93,))
    place(mass, (0.0, 0.0, 2.05), (0, 3, 2))
    carve(mass, tunnel(coll, 'ra_tunnel', 0.15, -0.35, 2.45, 3.05, 3.0))
    foot = voronoi_cell('ra_foot', coll, seed + 7, scale=(0.95, 0.85, 0.55), planes=9, reach=(0.6, 0.92))
    place(foot, (-3.35, 0.65, 0.05), (14, -9, 33))
    cap = voronoi_cell('ra_cap', coll, seed + 13, scale=(1.35, 0.95, 0.40), planes=9, reach=(0.62, 0.93),
                       up_bias=2.0)
    place(cap, (0.95, -0.15, 4.05), (4, -7, 18))
    parts = [mass, foot, cap]
    # The mass is a clipped sphere, so outside the tunnel its underside rises toward the ends: two
    # piers (outside the cut, unioned by the remesh) carry the arch down onto the ground line.
    for s, k in ((-1, 0), (1, 1)):
        pier = voronoi_cell(f'ra_pier{k}', coll, seed + 20 + k, scale=(0.95, 1.30, 1.55), planes=10,
                            reach=(0.66, 0.95), caps=(0.92,))
        parts.append(place(pier, (s * 3.30, 0.05 * s, 1.05), (0, 4 * s, 10 * s)))
    for k in range(4):  # rubble at both feet
        side = -1 if k % 2 else 1
        s = rng.uniform(0.30, 0.50)
        rb = voronoi_cell(f'ra_rb{k}', coll, seed + 40 + k, scale=(s, s * 0.8, s * 0.6), planes=8,
                          reach=(0.6, 0.92), points=600)
        parts.append(place(rb, (side * rng.uniform(2.9, 3.7), rng.uniform(-1.1, 1.1), -0.05),
                           (rng.uniform(-25, 25), rng.uniform(-25, 25), rng.uniform(0, 180))))
    joints = (((-1.6, 0.0, 3.0), (0.97, 0.0, 0.25), 0.05, 0.16),
              ((2.2, 0.1, 2.0), (0.90, 0.30, -0.1), 0.045, 0.14))
    recipe = dict(macro=(0.11, 2.4), heights=((0, 2.6, 0.060), (1, 0.9, 0.028), (0, 0.33, 0.010)),
                  strata=dict(bed=0.55, amp=0.040, dip=(0.10, 0.04, 1.0)), joints=joints, chips=0.02)
    return parts, 3, recipe


def build(name, form):
    t0 = time.time()
    coll = asset_collection(name)
    scratch = asset_collection(name + '_hi')
    parts, smooth_iters, recipe = form(scratch)
    high, voxel = fracture_cluster(parts, name + '_hi', smooth_iters=smooth_iters)
    maxd = sculpt(high, sum(map(ord, name)), **recipe)
    hi_tris = tri_count(high)
    low = lod0(high, name, coll, TARGET[name])
    bpy.data.objects.remove(high, do_unlink=True)
    fit_box([low], BOXES[name])
    z_dark = BOXES[name][0][2] + 0.55 if name == 'crag' else -10.0
    zone_materials(low, [('Rock_Dark', lambda z, nz: nz < -0.40 or z < z_dark),
                         ('Rock_Grey', lambda z, nz: True)])
    rock_finish(coll, name, moss=0.36, low_band=0.65, strata_freq=4.5 if name == 'crag' else 3.2)
    path = export_collection_vc(coll, name + '.glb')
    info = verify_glb(path)
    lo, hi = BANDS[name]
    rep = dict(high_tris=hi_tris, voxel=round(voxel, 4), max_disp=round(maxd, 3), lod0_tris=info['tris'],
               materials=info['materials'], bbox=[info.get('bbox_min'), info.get('bbox_max')],
               secs=round(time.time() - t0, 1))
    print(f'CRAG {name} ' + json.dumps(rep, default=str), flush=True)
    assert 300000 <= hi_tris <= 600000, (name, 'high sculpt', hi_tris)
    assert lo <= info['tris'] <= hi, (name, info['tris'], BANDS[name])
    assert info['color0'], name
    for o in coll.objects:
        o.hide_render = True
    return rep


clear_default_scene()
agx_palette()
REPORT = {}
for name, form in (('crag', form_crag), ('rock_arch', form_arch)):
    if ONLY and name not in ONLY:
        continue
    REPORT[name] = build(name, form)
print('CRAG REPORT ' + json.dumps(REPORT, default=str))
print("CRAG DONE")
