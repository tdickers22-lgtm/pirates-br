# Builds 3 stylized palm tree variants -> palm_a.glb, palm_b.glb, palm_c.glb
# Origin: base of trunk at (0,0,0). Height ~5-9 game units.
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

H = HELPERS  # injected dict of helper module globals


def trunk_path(height, lean, curve_pow, n):
    """Sampled points of a curved trunk centerline; lean is XY offset at top."""
    pts = []
    for i in range(n + 1):
        t = i / n
        offx = lean[0] * (t ** curve_pow)
        offy = lean[1] * (t ** curve_pow)
        pts.append(Vector((offx, offy, height * t)))
    return pts


def build_trunk(name, coll, height, lean, seed, r0=0.34, r1=0.18, rings=9, segs=9):
    rng = random.Random(seed)
    pts = trunk_path(height, lean, 1.7, rings)
    bm = bmesh.new()
    ring_verts = []
    for i, p in enumerate(pts):
        t = i / rings
        base_r = r0 * (1 - t) + r1 * t
        # ring bulges give the segmented palm-trunk read
        r = base_r * (1.0 + (0.10 if i % 2 == 0 else -0.02))
        jx = rng.uniform(-0.03, 0.03)
        jy = rng.uniform(-0.03, 0.03)
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            ring.append(bm.verts.new((p.x + jx + r * math.cos(a),
                                      p.y + jy + r * math.sin(a), p.z)))
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    # caps
    bm.faces.new(tuple(reversed(ring_verts[0])))
    bm.faces.new(tuple(ring_verts[-1]))
    return H["obj_from_bmesh"](name, bm, coll, H["mat"]("Trunk_Palm")), pts[-1]


def build_frond(name, coll, origin, yaw, tilt, length, material, seed):
    """One arched frond: spine with V-folded jagged blade halves."""
    rng = random.Random(seed)
    stations = 7
    bm = bmesh.new()
    left, right, spine = [], [], []
    for i in range(stations + 1):
        t = i / stations
        # spine: rises slightly then droops
        out = length * t
        z = 0.35 * math.sin(min(t * 2.2, math.pi)) - (length * 0.55) * (t ** 2.2)
        s = Vector((out, 0, z))
        # width profile: widest at 35%, jagged alternation
        w = 0.55 * length * 0.22 * math.sin(min(t * 2.0 + 0.25, math.pi))
        w *= 1.0 if i % 2 == 0 else 0.62
        w = max(w, 0.02)
        fold = 0.35 * w  # V dihedral drop
        spine.append(s)
        left.append(Vector((s.x, -w, s.z - fold)))
        right.append(Vector((s.x, w, s.z - fold)))
    vs = [bm.verts.new(p) for p in spine]
    vl = [bm.verts.new(p) for p in left]
    vr = [bm.verts.new(p) for p in right]
    for i in range(stations):
        bm.faces.new((vs[i], vl[i], vl[i + 1], vs[i + 1]))
        bm.faces.new((vs[i + 1], vr[i + 1], vr[i], vs[i]))
    # orient: tilt (pitch down from horizontal), then yaw around Z
    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(origin) @ rot, verts=bm.verts)
    return H["obj_from_bmesh"](name, bm, coll, material)


def build_palm(index, name, height, lean, fronds, seed):
    coll = H["asset_collection"](name)
    trunk, top = build_trunk(f"{name}_trunk", coll, height, lean, seed)
    parts = [trunk]
    rng = random.Random(seed + 77)
    golden = math.pi * (3 - math.sqrt(5))
    for k in range(fronds):
        yaw = k * golden + rng.uniform(-0.15, 0.15)
        # alternate upright/droopy tiers
        tier = k % 3
        tilt = (0.30, 0.62, 0.95)[tier] + rng.uniform(-0.08, 0.08)
        length = height * (0.42, 0.40, 0.34)[tier] * rng.uniform(0.9, 1.1)
        m = H["mat"]("Leaf_Green" if k % 2 == 0 else "Leaf_Green_Lt")
        if k == fronds - 1:
            m, tilt = H["mat"]("Leaf_Dry"), 1.35
        parts.append(build_frond(f"{name}_frond{k}", coll,
                                 top + Vector((0, 0, 0.06)), yaw, tilt,
                                 length, m, seed * 31 + k))
    # coconuts
    for k in range(3):
        a = k * 2.1 + seed
        bm = H["bm_icosphere"](0.20, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            top + Vector((0.26 * math.cos(a), 0.26 * math.sin(a), -0.28))),
            verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_coco{k}", bm, coll,
                                         H["mat"]("Coconut")))
    palm = H["join"](parts, name)
    return coll, palm


SPECS = [
    ("palm_a", 8.5, (1.6, 0.4), 9, 11),
    ("palm_b", 6.5, (2.3, -0.8), 8, 23),
    ("palm_c", 5.0, (0.7, 0.9), 10, 37),
]

for i, (name, height, lean, fronds, seed) in enumerate(SPECS):
    coll, palm = build_palm(i, name, height, lean, fronds, seed)
    palm.location = (i * 6 - 6, 0, 0)  # spread out for viewport inspection
    print(f"built {name}")

print("PALMS DONE")
