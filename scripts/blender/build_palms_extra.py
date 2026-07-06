# Extra palm variants: a VERY TALL THIN coconut palm and a short GROUND palm
# (low fan/shrub palm). Same stylized build as build_palms.py, self-contained.
# Origin: base of trunk at (0,0,0). Client applies a wind-sway shader.
# Headless: Blender -b -P scripts/blender/build_palms_extra.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())


def trunk_path(height, lean, curve_pow, n):
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append(Vector((lean[0] * (t ** curve_pow), lean[1] * (t ** curve_pow), height * t)))
    return pts


def build_trunk(name, coll, height, lean, seed, r0, r1, rings=10, segs=8):
    rng = random.Random(seed)
    pts = trunk_path(height, lean, 1.7, rings)
    bm = bmesh.new()
    ring_verts = []
    for i, p in enumerate(pts):
        t = i / rings
        base_r = r0 * (1 - t) + r1 * t
        r = base_r * (1.0 + (0.1 if i % 2 == 0 else -0.02))
        jx, jy = rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02)
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            ring.append(bm.verts.new((p.x + jx + r * math.cos(a), p.y + jy + r * math.sin(a), p.z)))
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    bm.faces.new(tuple(reversed(ring_verts[0])))
    bm.faces.new(tuple(ring_verts[-1]))
    return obj_from_bmesh(name, bm, coll, mat("Trunk_Palm")), pts[-1]


def build_frond(name, coll, origin, yaw, tilt, length, material):
    stations = 7
    bm = bmesh.new()
    left, right, spine = [], [], []
    for i in range(stations + 1):
        t = i / stations
        out = length * t
        z = 0.35 * math.sin(min(t * 2.2, math.pi)) - (length * 0.55) * (t ** 2.2)
        s = Vector((out, 0, z))
        w = max(0.55 * length * 0.22 * math.sin(min(t * 2.0 + 0.25, math.pi)) * (1.0 if i % 2 == 0 else 0.62), 0.02)
        fold = 0.35 * w
        spine.append(s)
        left.append(Vector((s.x, -w, s.z - fold)))
        right.append(Vector((s.x, w, s.z - fold)))
    vs = [bm.verts.new(p) for p in spine]
    vl = [bm.verts.new(p) for p in left]
    vr = [bm.verts.new(p) for p in right]
    for i in range(stations):
        bm.faces.new((vs[i], vl[i], vl[i + 1], vs[i + 1]))
        bm.faces.new((vs[i + 1], vr[i + 1], vr[i], vs[i]))
    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(origin) @ rot, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material)


def build_palm(name, height, lean, fronds, seed, r0, r1, tilts, frond_len, cocos=3):
    coll = asset_collection(name)
    trunk, top = build_trunk(f"{name}_trunk", coll, height, lean, seed, r0, r1)
    parts = [trunk]
    rng = random.Random(seed + 77)
    golden = math.pi * (3 - math.sqrt(5))
    for k in range(fronds):
        yaw = k * golden + rng.uniform(-0.15, 0.15)
        tier = k % 3
        tilt = tilts[tier] + rng.uniform(-0.08, 0.08)
        length = height * frond_len[tier] * rng.uniform(0.9, 1.1)
        m = mat("Leaf_Green" if k % 2 == 0 else "Leaf_Green_Lt")
        if k == fronds - 1:
            m, tilt = mat("Leaf_Dry"), tilts[2] + 0.4
        parts.append(build_frond(f"{name}_frond{k}", coll, top + Vector((0, 0, 0.06)), yaw, tilt, length, m))
    for k in range(cocos):
        a = k * 2.1 + seed
        bm = bm_icosphere(0.2, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(top + Vector((0.26 * math.cos(a), 0.26 * math.sin(a), -0.28))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_coco{k}", bm, coll, mat("Coconut")))
    join(parts, name)
    export_collection(coll, f"{name}.glb")
    print(f"built {name}")


clear_default_scene()
# Very tall thin coconut palm — upright, whippy, sparse crown.
build_palm("palm_tall", 13.5, (1.1, -0.5), 8, 71, r0=0.24, r1=0.1,
           tilts=(0.24, 0.5, 0.86), frond_len=(0.34, 0.32, 0.26), cocos=3)
# Short ground palm — low fat stump with big fronds fanning to the ground.
build_palm("palm_ground", 2.2, (0.35, 0.2), 9, 88, r0=0.34, r1=0.26,
           tilts=(0.7, 1.05, 1.35), frond_len=(0.95, 0.85, 0.7), cocos=0)

print("PALMS EXTRA DONE")
