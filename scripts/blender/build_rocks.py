# ROCK KIT v2 I (b4.5a; assets-08, assets-09; PLAN 3.12 + section 6 row 12): 3 island boulders and
# 3 sea stacks on the shared rock core (_rock.py).
#
#   boulders a/b/c  LOD0 8-15k tris. Voronoi fracture cells unioned into one welded mass:
#                   a = rounded water-worn dome on a bury skirt, b = tilted angular slab with a
#                   leaning shard and a joint fissure, c = split stack (two lobes cleft by a deep
#                   joint, capstone on top).
#   searocks a/b/c  LOD0 15-25k tris. Layered sedimentary stacks: dipping bedding slabs (jointed
#                   Voronoi outlines, soft beds set back into ledges), companion stacks, a rubble
#                   skirt, vertical joint fissures and a wave-cut notch at the waterline; wet band,
#                   weathered body and a sun-bleached crown.
#
# Every rock is a 300-600k HIGH sculpt (voxel remesh + multi-octave displacement from PolyHaven CC0
# rock height maps, _rock.sculpt) collapse-decimated into its band as ONE welded surface with
# face-area weighted normals (verts/tris ~0.5, was 3.00 split-vertex facets), fitted into the legacy
# game-space AABB (_nature.NATURE_BOUNDS: colliders, propBaseLift, test-asset-bounds), AO + moss +
# low wet band baked into COLOR_0, material names kept in the 'rock' detail family (the runtime
# triplanar rock grain and the one-draw instancing collapse still apply).
# `<name>_far.glb` is a ~2.5% decimation of the same welded LOD0, re-seated on its lowest point;
# `<name>_lods.glb` (LOD1/LOD2/far nodes) comes from build_lods.py (BR_LODS_ONLY=<names>).
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_rocks.py
# env: BR_EXPORT_DIR (output dir), ROCKS_ONLY=boulder_a,searock_b, ROCKS_RENDER_DIR=<dir> (turntables)
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
RENDER_DIR = os.environ.get("ROCKS_RENDER_DIR", "")
ONLY = {s.strip() for s in os.environ.get('ROCKS_ONLY', '').split(',') if s.strip()}

EXTRA = {
    "Rock_Stack": ((0.29, 0.27, 0.23, 1.0), 0.94, 0.0),  # weathered body
    "Rock_Wet":   ((0.16, 0.17, 0.18, 1.0), 0.78, 0.0),  # dark wet base
    "Rock_Pale":  ((0.45, 0.42, 0.35, 1.0), 0.95, 0.0),  # sun-bleached / guano crown
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

BANDS = {'boulder': (8000, 15000), 'searock': (15000, 25000)}
TARGET = {'boulder': 11500, 'searock': 20000}
FAR_RATIO = 0.025


# ── boulder forms (authored near final size; fit_bounds does the last few percent) ──────────
def form_boulder_a(coll, seed):
    main = place(voronoi_cell('ba_m', coll, seed, scale=(1.05, 0.95, 0.82), planes=13, reach=(0.66, 0.93)),
                 (0, 0, 0.62), (0, 0, 17))
    skirt = place(voronoi_cell('ba_s', coll, seed + 5, scale=(0.92, 0.80, 0.36), planes=8, reach=(0.62, 0.92)),
                  (0.35, -0.25, 0.06), (4, -3, 40))
    recipe = dict(macro=(0.06, 1.3), heights=((0, 2.4, 0.060), (1, 0.8, 0.030), (0, 0.3, 0.010)),
                  strata=dict(bed=0.34, amp=0.016, dip=(0.12, 0.05, 1.0)), chips=0.022)
    return [main, skirt], 3, recipe


def form_boulder_b(coll, seed):
    main = place(voronoi_cell('bb_m', coll, seed, scale=(1.45, 0.82, 0.50), planes=10, reach=(0.58, 0.90),
                              up_bias=2.5), (0, 0, 0.62), (9, -16, 24))
    shard = place(voronoi_cell('bb_sh', coll, seed + 9, scale=(0.40, 0.62, 0.50), planes=9, reach=(0.55, 0.88)),
                  (0.95, 0.45, 0.42), (-18, 30, -40))
    skirt = place(voronoi_cell('bb_s', coll, seed + 4, scale=(1.04, 0.84, 0.28), planes=8, reach=(0.6, 0.9)),
                  (-0.45, -0.2, 0.0), (0, 0, 12))
    recipe = dict(macro=(0.06, 1.6), heights=((1, 2.0, 0.065), (0, 0.7, 0.032), (1, 0.28, 0.011)),
                  strata=dict(bed=0.26, amp=0.020, dip=(0.16, -0.28, 1.0)),
                  joints=(((0.3, 0.1, 0.6), (0.85, 0.5, 0.15), 0.035, 0.09),), chips=0.03)
    return [main, shard, skirt], 1, recipe


def form_boulder_c(coll, seed):
    lobe_l = place(voronoi_cell('bc_l', coll, seed, scale=(0.50, 0.62, 0.60), planes=11, reach=(0.66, 0.95)),
                   (-0.33, 0.02, 0.52), (0, -8, 6))
    lobe_r = place(voronoi_cell('bc_r', coll, seed + 3, scale=(0.48, 0.56, 0.60), planes=11, reach=(0.66, 0.95)),
                   (0.34, -0.04, 0.50), (0, 10, -7))
    cap = place(voronoi_cell('bc_t', coll, seed + 7, scale=(0.44, 0.40, 0.30), planes=10, reach=(0.62, 0.92),
                             up_bias=2.0), (-0.05, 0.05, 1.12), (6, -5, 30))
    recipe = dict(macro=(0.05, 0.9), heights=((0, 1.6, 0.045), (1, 0.6, 0.022), (0, 0.25, 0.008)),
                  strata=dict(bed=0.22, amp=0.010, dip=(0.0, 0.1, 1.0)),
                  # the split: a deep cleft on the lobes' meeting plane
                  joints=(((0.0, 0.0, 0.5), (1.0, 0.0, 0.08), 0.045, 0.16),), chips=0.024)
    return [lobe_l, lobe_r, cap], 1, recipe


# ── sea stacks ───────────────────────────────────────────────────────────────────────────────
def form_searock(coll, seed, height, base_r, companions, squat):
    rng = random.Random(seed)
    parts = sedimentary_stack('sr_main', coll, seed, height, base_r,
                              taper=0.42 if squat else 0.58, crown=0.58 if squat else 0.30,
                              lean=0.06 if squat else 0.11, dip_deg=rng.uniform(6, 13))
    for k in range(companions):
        ang = rng.uniform(0, math.tau)
        d = base_r * rng.uniform(0.95, 1.45)
        sub = sedimentary_stack(f'sr_c{k}', coll, seed + 200 + k, height * rng.uniform(0.24, 0.52),
                                base_r * rng.uniform(0.38, 0.58), taper=0.6, crown=0.26, lean=0.14,
                                dip_deg=rng.uniform(5, 15))
        for s in sub:
            s.data.transform(Matrix.Translation((math.cos(ang) * d, math.sin(ang) * d, 0)))
        parts += sub
    for k in range(7 + companions):  # wet rubble skirt at the waterline
        ang = rng.uniform(0, math.tau)
        d = base_r * rng.uniform(0.8, 1.55)
        r = base_r * rng.uniform(0.16, 0.32)
        parts.append(place(voronoi_cell(f'sr_rb{k}', coll, seed + 400 + k, scale=(r, r * 0.8, r * 0.55),
                                        planes=8, reach=(0.6, 0.92), points=500),
                           (math.cos(ang) * d, math.sin(ang) * d, rng.uniform(-0.9, -0.1)),
                           (rng.uniform(-20, 20), rng.uniform(-20, 20), rng.uniform(0, 360))))
    joints = []
    for k in range(3):
        a = rng.uniform(0, math.pi)
        joints.append(((rng.uniform(-0.3, 0.3) * base_r, rng.uniform(-0.3, 0.3) * base_r, 0.0),
                       (math.cos(a), math.sin(a), rng.uniform(-0.1, 0.1)), 0.10, 0.22 + 0.04 * k))
    recipe = dict(macro=(0.30, 4.2), heights=((0, 3.4, 0.10), (1, 1.15, 0.040), (0, 0.42, 0.013)),
                  strata=dict(bed=0.55, amp=0.05, dip=(0.10, 0.06, 1.0)), joints=tuple(joints),
                  notch=dict(z=0.55, width=0.55 if squat else 0.62, depth=0.42 if squat else 0.55),
                  chips=0.02)
    return parts, 1, recipe


def build(name, kind, form):
    t0 = time.time()
    coll = asset_collection(name)
    scratch = asset_collection(name + '_hi')
    parts, smooth_iters, recipe = form(scratch)
    high, voxel = fracture_cluster(parts, name + '_hi', smooth_iters=smooth_iters)
    seed = sum(map(ord, name))
    maxd = sculpt(high, seed, **recipe)
    fit_bounds([high], name)
    hi_tris = tri_count(high)
    low = lod0(high, name, coll, TARGET[kind])
    fit_bounds([low], name)
    far_coll = asset_collection(name + '_far')
    far = decimated_copy(low, name + '_far', far_coll, FAR_RATIO)
    bpy.data.objects.remove(high, do_unlink=True)
    is_sea = kind == 'searock'
    zmin = min(v.co.z for v in low.data.vertices)
    zmax = max(v.co.z for v in low.data.vertices)
    if is_sea:
        zones = [('Rock_Wet', lambda z, nz: z < 0.55),
                 ('Rock_Pale', lambda z, nz, top=zmax: z > zmin + (top - zmin) * 0.80 and nz > 0.35),
                 ('Rock_Stack', lambda z, nz: True)]
    else:
        zones = [('Rock_Grey', lambda z, nz: True)]
    for c, o in ((coll, low), (far_coll, far)):
        zone_materials(o, zones)
        rock_finish(c, o.name, moss=0.30 if is_sea else 0.42,
                    low_band=0.65, strata_freq=3.7 if is_sea else 9.0)
    path = export_collection_vc(coll, name + '.glb')
    fpath = export_collection_vc(far_coll, name + '_far.glb')
    info, finfo = verify_glb(path), verify_glb(fpath)
    lo, hi = BANDS[kind]
    rep = dict(high_tris=hi_tris, voxel=round(voxel, 4), max_disp=round(maxd, 3), lod0_tris=info['tris'],
               far_tris=finfo['tris'], materials=info['materials'], secs=round(time.time() - t0, 1))
    print(f'ROCK {name} ' + json.dumps(rep, default=str), flush=True)
    assert 300000 <= hi_tris <= 600000, (name, 'high sculpt', hi_tris)
    assert lo <= info['tris'] <= hi, (name, info['tris'], BANDS[kind])
    assert info['color0'], name
    for c in (coll, far_coll):
        for o in c.objects:
            o.hide_render = True
    return rep


clear_default_scene()
BUILDS = [
    ('boulder_a', 'boulder', lambda c: form_boulder_a(c, 101)),
    ('boulder_b', 'boulder', lambda c: form_boulder_b(c, 202)),
    ('boulder_c', 'boulder', lambda c: form_boulder_c(c, 303)),
    ('searock_a', 'searock', lambda c: form_searock(c, 404, 10.0, 3.4, 3, False)),
    ('searock_b', 'searock', lambda c: form_searock(c, 505, 14.0, 4.2, 3, False)),
    ('searock_c', 'searock', lambda c: form_searock(c, 606, 6.0, 2.6, 4, True)),
]
REPORT = {}
for name, kind, form in BUILDS:
    if ONLY and name not in ONLY:
        continue
    REPORT[name] = build(name, kind, form)
print('ROCKS REPORT ' + json.dumps(REPORT, default=str))
if RENDER_DIR:
    for c in bpy.data.collections:
        for o in c.objects:
            o.hide_render = not (c.name in REPORT)
    render_nature(tuple(n for n in ('boulder_b', 'searock_a') if n in REPORT), RENDER_DIR)
print("ROCKS DONE")
