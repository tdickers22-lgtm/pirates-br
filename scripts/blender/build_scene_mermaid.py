# MERMAID SHRINE — Mermaid's Folly hero story scene: "the siren's toll".
# A shell-and-coral throne on a tidal rock slab; a weathered ship FIGUREHEAD
# (carved mermaid, salvaged from a wreck) propped upright on the throne like an
# idol. Ring of offerings: emissive candle clusters, coin piles, pearls in open
# shells. Two sailor skeletons oriented TOWARD the throne (one still reaching),
# a fiddle dropped on the sand. Idol faces Blender -Y. Origin at ground center.
# Headless: Blender -b -P scripts/blender/build_scene_mermaid.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get(
    "BR_RENDER_DIR",
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad/renders/s-monuments/round1")

EXTRA = {
    "Bone":        ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
    "Coral":       ((0.75, 0.35, 0.30, 1.0), 0.85, 0.0),
    "Shell_Pearl": ((0.85, 0.80, 0.72, 1.0), 0.55, 0.1),
    "Candle_Wax":  ((0.86, 0.80, 0.60, 1.0), 0.6, 0.0),
}
for _n, _v in EXTRA.items():
    PALETTE.setdefault(_n, _v)

rng = random.Random(7)


def T(x, y, z):
    return Matrix.Translation((x, y, z))


def RX(a):
    return Matrix.Rotation(a, 4, 'X')


def RY(a):
    return Matrix.Rotation(a, 4, 'Y')


def RZ(a):
    return Matrix.Rotation(a, 4, 'Z')


def xform(bm, m):
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def bm_bevel(bm, width=0.02):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=1, profile=0.72, affect='EDGES', clamp_overlap=True)
    return bm


def bm_torus(R, r, segs=12, ring=6):
    bm = bmesh.new()
    rings = []
    for i in range(segs):
        a = i / segs * math.tau
        c = Vector((math.cos(a) * R, math.sin(a) * R, 0))
        rv = []
        for j in range(ring):
            b = j / ring * math.tau
            rad = Vector((math.cos(a) * math.cos(b) * r,
                          math.sin(a) * math.cos(b) * r,
                          math.sin(b) * r))
            rv.append(bm.verts.new(c + rad))
        rings.append(rv)
    for i in range(segs):
        r1, r2 = rings[i], rings[(i + 1) % segs]
        for j in range(ring):
            bm.faces.new((r1[j], r1[(j + 1) % ring], r2[(j + 1) % ring], r2[j]))
    return bm


def seg_between(coll, name, p1, p2, r1, r2, material, segs=6, smooth=True):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, max(0.01, d.length), segs=segs)
    q = d.to_track_quat('Z', 'Y')
    xform(bm, Matrix.Translation((p1 + p2) / 2) @ q.to_matrix().to_4x4())
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


# ── skeleton (same chunky idiom as skull_totem) ──────────────
def skel_head(coll, name, pos, yaw, pitch, parts):
    R = T(*pos) @ RZ(yaw) @ RX(pitch)
    bm = bm_icosphere(0.115, 3)
    bmesh.ops.scale(bm, vec=Vector((0.88, 1.0, 1.02)), verts=bm.verts)
    xform(bm, R)
    parts.append(obj_from_bmesh(name, bm, coll, mat("Bone"), smooth=True))
    jaw = bm_bevel(bm_box(0.13, 0.11, 0.07), 0.02)
    xform(jaw, R @ T(0, -0.035, -0.10))
    parts.append(obj_from_bmesh(name + "_jaw", jaw, coll, mat("Bone")))
    for sx in (-1, 1):
        e = bm_icosphere(0.032, 1)
        xform(e, R @ T(sx * 0.044, -0.086, 0.018))
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", e, coll,
                                    mat("Rock_Sea"), smooth=True))


def skeleton(coll, name, loc, yaw, pose):
    world = T(*loc) @ RZ(yaw)
    P = {k: (world @ Vector(v)) for k, v in pose.items() if k != "head_pitch"}
    parts = []
    pel = bm_bevel(bm_box(0.26, 0.17, 0.13), 0.035)
    xform(pel, Matrix.Translation(P["pelvis"]) @ RZ(yaw))
    parts.append(obj_from_bmesh(name + "_pelvis", pel, coll, mat("Bone")))
    parts.append(seg_between(coll, name + "_spine", P["pelvis"], P["neck"],
                             0.05, 0.04, mat("Bone"), segs=8))
    sp, nk = Vector(P["pelvis"]), Vector(P["neck"])
    d = nk - sp
    q = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    for i, (f, rr) in enumerate(((0.42, 0.14), (0.56, 0.165), (0.70, 0.155),
                                 (0.82, 0.125))):
        rib = bm_torus(rr, 0.032, segs=12, ring=5)
        bmesh.ops.scale(rib, vec=Vector((1.0, 0.78, 0.5)), verts=rib.verts)
        xform(rib, Matrix.Translation(sp + d * f) @ q)
        parts.append(obj_from_bmesh(f"{name}_rib{i}", rib, coll,
                                    mat("Bone"), smooth=True))
    skel_head(coll, name + "_skull", P["head"], yaw,
              pose.get("head_pitch", 0.0), parts)
    limbs = [("shoulderL", "elbowL", 0.04, 0.033), ("elbowL", "handL", 0.033, 0.026),
             ("shoulderR", "elbowR", 0.04, 0.033), ("elbowR", "handR", 0.033, 0.026),
             ("hipL", "kneeL", 0.05, 0.04), ("kneeL", "footL", 0.04, 0.031),
             ("hipR", "kneeR", 0.05, 0.04), ("kneeR", "footR", 0.04, 0.031)]
    for a, b, r1, r2 in limbs:
        parts.append(seg_between(coll, f"{name}_{a}_{b}", P[a], P[b], r1, r2,
                                 mat("Bone")))
    for s in ("L", "R"):  # clavicles + hip struts so the frame reads connected
        parts.append(seg_between(coll, f"{name}_clav{s}", P["neck"],
                                 P["shoulder" + s], 0.028, 0.024, mat("Bone")))
        parts.append(seg_between(coll, f"{name}_hipb{s}", P["pelvis"],
                                 P["hip" + s], 0.034, 0.03, mat("Bone")))
    for j in ("shoulderL", "shoulderR", "elbowL", "elbowR",
              "hipL", "hipR", "kneeL", "kneeR"):
        jb = bm_icosphere(0.06 if "sho" in j or "hip" in j else 0.052, 2)
        xform(jb, Matrix.Translation(P[j]))
        parts.append(obj_from_bmesh(f"{name}_j_{j}", jb, coll,
                                    mat("Bone"), smooth=True))
    for h in ("handL", "handR", "footL", "footR"):
        hb = bm_bevel(bm_box(0.08, 0.11, 0.04), 0.012)
        xform(hb, Matrix.Translation(P[h]) @ RZ(yaw))
        parts.append(obj_from_bmesh(f"{name}_{h}", hb, coll, mat("Bone")))
    return parts


POSE_REACH = {  # prone crawl toward -Y, right arm stretched at the idol
    "pelvis": (0, 0, 0.13), "neck": (0, -0.46, 0.20), "head": (0, -0.64, 0.24),
    "head_pitch": 0.55,
    "shoulderL": (-0.20, -0.44, 0.18), "elbowL": (-0.30, -0.62, 0.08),
    "handL": (-0.26, -0.86, 0.04),
    "shoulderR": (0.20, -0.44, 0.18), "elbowR": (0.24, -0.74, 0.14),
    "handR": (0.16, -1.06, 0.10),
    "hipL": (-0.11, 0.02, 0.12), "kneeL": (-0.14, 0.36, 0.09),
    "footL": (-0.15, 0.72, 0.07),
    "hipR": (0.11, 0.02, 0.12), "kneeR": (0.20, 0.28, 0.18),
    "footR": (0.15, 0.60, 0.09),
}

POSE_KNEEL_BOWED = {  # kneeling, head bowed, hands sunk to the sand
    "pelvis": (0, 0, 0.36), "neck": (0, -0.08, 0.82), "head": (0, -0.16, 0.92),
    "head_pitch": 0.75,
    "shoulderL": (-0.20, -0.05, 0.78), "elbowL": (-0.26, -0.24, 0.50),
    "handL": (-0.22, -0.38, 0.06),
    "shoulderR": (0.20, -0.05, 0.78), "elbowR": (0.26, -0.24, 0.50),
    "handR": (0.22, -0.38, 0.06),
    "hipL": (-0.11, 0.0, 0.32), "kneeL": (-0.13, -0.06, 0.07),
    "footL": (-0.13, 0.40, 0.05),
    "hipR": (0.11, 0.0, 0.32), "kneeR": (0.13, -0.06, 0.07),
    "footR": (0.13, 0.40, 0.05),
}


def face_yaw(from_xy, to_xy):
    d = Vector((to_xy[0] - from_xy[0], to_xy[1] - from_xy[1], 0)).normalized()
    return math.atan2(d.x, -d.y)


# ── shrine pieces ────────────────────────────────────────────
def fan_shell(coll, name, r, m, material, parts, ribs=7, spread=1.5, thick=0.30):
    """Scallop fan of overlapping wedge ribs; hinge at local origin, fan +Z,
    flat faces +-Y. Ridged silhouette like a real fan shell."""
    for i in range(ribs):
        a = (i / (ribs - 1) - 0.5) * spread
        bm = bm_cylinder(r * 0.055, r * 0.16, r, segs=7)
        bmesh.ops.scale(bm, vec=Vector((1.0, thick, 1.0)), verts=bm.verts)
        xform(bm, m @ RY(a) @ T(0, 0, r * 0.48))
        parts.append(obj_from_bmesh(f"{name}_r{i}", bm, coll, material))
    hinge = bm_icosphere(r * 0.12, 1)
    xform(hinge, m)
    parts.append(obj_from_bmesh(name + "_h", hinge, coll, material,
                                smooth=True))


def coral_branch(coll, name, base, h, r, seed, parts, lean=0.35):
    rg = random.Random(seed)
    p = Vector(base)
    d = Vector((rg.uniform(-lean, lean), rg.uniform(-lean, lean), 1)).normalized()
    rr = r
    for i in range(3):
        ln = h * rg.uniform(0.28, 0.40)
        p2 = p + d * ln
        parts.append(seg_between(coll, f"{name}_s{i}", p, p2, rr, rr * 0.72,
                                 mat("Coral"), segs=7))
        if i >= 1:  # side branch
            bd = (d + Vector((rg.uniform(-0.9, 0.9), rg.uniform(-0.9, 0.9),
                              0.5))).normalized()
            parts.append(seg_between(coll, f"{name}_b{i}", p, p + bd * ln * 0.7,
                                     rr * 0.6, rr * 0.3, mat("Coral"), segs=6))
            tip = bm_icosphere(rr * 0.42, 1)
            xform(tip, Matrix.Translation(p + bd * ln * 0.7))
            parts.append(obj_from_bmesh(f"{name}_bt{i}", tip, coll,
                                        mat("Coral"), smooth=True))
        p, rr = p2, rr * 0.72
        d = (d + Vector((rg.uniform(-0.5, 0.5), rg.uniform(-0.5, 0.5),
                         0.25))).normalized()
    tip = bm_icosphere(rr * 0.6, 1)
    xform(tip, Matrix.Translation(p))
    parts.append(obj_from_bmesh(f"{name}_tip", tip, coll, mat("Coral"),
                                smooth=True))


def candle_cluster(coll, name, loc, n, parts):
    for i in range(n):
        a = i * math.tau / max(1, n) + rng.uniform(0, 1)
        rr = 0 if i == 0 else rng.uniform(0.09, 0.18)
        h = rng.uniform(0.06, 0.20)
        c = bm_cylinder(rng.uniform(0.028, 0.045), 0.026, h, segs=8)
        xform(c, T(loc[0] + math.cos(a) * rr, loc[1] + math.sin(a) * rr,
                   loc[2] + h / 2))
        parts.append(obj_from_bmesh(f"{name}_{i}", c, coll, mat("Candle_Wax"),
                                    smooth=True))


def coin_pile(coll, name, loc, n, parts):
    heap = bm_icosphere(0.18, 3)
    bmesh.ops.scale(heap, vec=Vector((1.15, 1.05, 0.42)), verts=heap.verts)
    xform(heap, T(loc[0], loc[1], loc[2] + 0.04))
    parts.append(obj_from_bmesh(name + "_heap", heap, coll, mat("Gold"),
                                smooth=True))
    for i in range(n):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.12, 0.30)
        c = bm_cylinder(0.036, 0.036, 0.008, segs=7)
        xform(c, T(loc[0] + math.cos(a) * rr, loc[1] + math.sin(a) * rr,
                   loc[2] + 0.012) @ RX(rng.uniform(-0.4, 0.4)) @
              RY(rng.uniform(-0.4, 0.4)))
        parts.append(obj_from_bmesh(f"{name}_c{i}", c, coll, mat("Gold")))


def pearl_shell(coll, name, loc, yaw, parts):
    m = T(*loc) @ RZ(yaw)
    fan_shell(coll, name + "_lo", 0.17, m @ RX(math.radians(96)),
              mat("Shell_Pearl"), parts, ribs=5, thick=0.22)
    fan_shell(coll, name + "_up", 0.17, m @ RX(math.radians(30)),
              mat("Shell_Pearl"), parts, ribs=5, thick=0.22)
    p = bm_icosphere(0.055, 2)
    xform(p, m @ T(0, -0.11, 0.055))
    parts.append(obj_from_bmesh(name + "_pearl", p, coll, mat("Shell_Pearl"),
                                smooth=True))


def figurehead(coll, name, G, parts):
    """Carved mermaid figurehead ~1.9m, weathered Wood_Bleached.
    Local frame: faces -Y, base scroll at origin, rises +Z."""
    W = mat("Wood_Bleached")
    # scroll base — curled keel stub the figure grows out of
    curl = [(0, 0.22, 0.10), (0, 0.10, 0.06), (0, -0.02, 0.14), (0, 0.02, 0.30)]
    radii = [0.13, 0.15, 0.16, 0.15]
    for i in range(len(curl) - 1):
        parts.append(seg_between(coll, f"{name}_scroll{i}",
                                 G @ Vector(curl[i]), G @ Vector(curl[i + 1]),
                                 radii[i], radii[i + 1], W, segs=10))
    cap = bm_cylinder(0.14, 0.10, 0.16, segs=10)
    xform(cap, G @ T(0, 0.24, 0.10) @ RX(math.radians(80)))
    parts.append(obj_from_bmesh(name + "_scap", cap, coll, W, smooth=True))
    # tail: curves up and forward from the scroll into the torso
    tail = [(0, 0.02, 0.30), (0.02, -0.06, 0.62), (-0.01, -0.10, 0.92),
            (0, -0.06, 1.16)]
    tr = [0.15, 0.13, 0.12, 0.115]
    for i in range(len(tail) - 1):
        parts.append(seg_between(coll, f"{name}_tail{i}",
                                 G @ Vector(tail[i]), G @ Vector(tail[i + 1]),
                                 tr[i], tr[i + 1], W, segs=10))
    # fluke fins sweeping back off the scroll
    for sx in (-1, 1):
        fl = bm_cylinder(0.22, 0.01, 0.30, segs=7)
        bmesh.ops.scale(fl, vec=Vector((1.0, 0.28, 1.0)), verts=fl.verts)
        xform(fl, G @ T(sx * 0.16, 0.30, 0.16) @ RY(sx * math.radians(55)) @
              RX(math.radians(-30)))
        parts.append(obj_from_bmesh(f"{name}_fluke{sx}", fl, coll, W))
    # torso
    torso = bm_cylinder(0.115, 0.135, 0.42, segs=12)
    xform(torso, G @ T(0, -0.05, 1.36) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh(name + "_torso", torso, coll, W, smooth=True))
    chest = bm_icosphere(0.15, 2)
    bmesh.ops.scale(chest, vec=Vector((1.0, 0.8, 0.9)), verts=chest.verts)
    xform(chest, G @ T(0, -0.08, 1.58))
    parts.append(obj_from_bmesh(name + "_chest", chest, coll, W, smooth=True))
    # arms raised seaward (forward -Y and up) — the siren's call
    for sx in (-1, 1):
        sh = Vector((sx * 0.16, -0.08, 1.66))
        el = Vector((sx * 0.30, -0.26, 1.80))
        hd = Vector((sx * 0.20, -0.42, 2.02))
        parts.append(seg_between(coll, f"{name}_uarm{sx}", G @ sh, G @ el,
                                 0.045, 0.038, W, segs=8))
        parts.append(seg_between(coll, f"{name}_farm{sx}", G @ el, G @ hd,
                                 0.038, 0.028, W, segs=8))
        hb = bm_icosphere(0.045, 1)
        xform(hb, Matrix.Translation(G @ hd))
        parts.append(obj_from_bmesh(f"{name}_hand{sx}", hb, coll, W,
                                    smooth=True))
    # head + flowing hair mass swept back
    head = bm_icosphere(0.105, 2)
    bmesh.ops.scale(head, vec=Vector((0.9, 0.95, 1.05)), verts=head.verts)
    xform(head, G @ T(0, -0.10, 1.86))
    parts.append(obj_from_bmesh(name + "_head", head, coll, W, smooth=True))
    hair = bm_icosphere(0.125, 3)
    bmesh.ops.scale(hair, vec=Vector((0.85, 1.35, 0.95)), verts=hair.verts)
    xform(hair, G @ T(0, 0.055, 1.92) @ RX(math.radians(24)))
    o = obj_from_bmesh(name + "_hair", hair, coll, mat("Wood_Mid"), smooth=True)
    displace_noise(o, strength=0.05, scale=0.25, seed=31)
    apply_modifiers(o)
    parts.append(o)
    hair2 = bm_cylinder(0.09, 0.03, 0.55, segs=8)
    xform(hair2, G @ T(0, 0.14, 1.62) @ RX(math.radians(158)))
    parts.append(obj_from_bmesh(name + "_hair2", hair2, coll, mat("Wood_Mid"),
                                smooth=True))
    # weathered mounting stump at the back (salvage evidence)
    stump = bm_bevel(bm_box(0.20, 0.13, 0.38), 0.02)
    xform(stump, G @ T(0, 0.24, 0.42) @ RX(math.radians(8)))
    o = obj_from_bmesh(name + "_mount", stump, coll, mat("Wood_Mid"))
    displace_noise(o, strength=0.02, scale=0.3, seed=32)
    apply_modifiers(o)
    parts.append(o)


def fiddle(coll, name, loc, yaw, parts):
    m = T(*loc) @ RZ(yaw)
    for dy, s in ((0.0, 1.0), (-0.16, 0.8)):
        b = bm_icosphere(0.11 * s, 2)
        bmesh.ops.scale(b, vec=Vector((0.85, 1.15, 0.30)), verts=b.verts)
        xform(b, m @ T(0, dy, 0.035))
        parts.append(obj_from_bmesh(f"{name}_body{dy}", b, coll,
                                    mat("Wood_Mid"), smooth=True))
    neck = bm_bevel(bm_box(0.035, 0.34, 0.02), 0.006)
    xform(neck, m @ T(0, -0.36, 0.05))
    parts.append(obj_from_bmesh(name + "_neck", neck, coll, mat("Wood_Mid")))
    scroll = bm_icosphere(0.03, 1)
    xform(scroll, m @ T(0, -0.53, 0.05))
    parts.append(obj_from_bmesh(name + "_scroll", scroll, coll,
                                mat("Wood_Mid"), smooth=True))
    bow = bm_cylinder(0.008, 0.008, 0.5, segs=5)
    xform(bow, m @ T(0.22, -0.1, 0.02) @ RX(math.radians(88)) @ RZ(0.4))
    parts.append(obj_from_bmesh(name + "_bow", bow, coll, mat("Wood_Mid"),
                                smooth=True))


# ── scene build ──────────────────────────────────────────────
def build():
    clear_default_scene()
    name = "mermaid_shrine"
    coll = asset_collection(name)
    parts = []

    # candle wax needs its emission set up (strength 2, warm)
    cw = mat("Candle_Wax")
    b = cw.node_tree.nodes.get("Principled BSDF")
    b.inputs["Emission Color"].default_value = (0.95, 0.70, 0.32, 1.0)
    b.inputs["Emission Strength"].default_value = 2.0

    # ── tidal rock slab (two overlapping masses, heavy displace) ──
    slab = bm_icosphere(1.0, 5)
    bmesh.ops.scale(slab, vec=Vector((2.3, 2.0, 0.72)), verts=slab.verts)
    xform(slab, T(0, 0.6, 0.10))
    o = obj_from_bmesh("slab", slab, coll, mat("Rock_Sea"), smooth=True)
    displace_noise(o, strength=0.32, scale=1.5, seed=3)
    displace_noise(o, strength=0.08, scale=0.5, seed=4)
    apply_modifiers(o)
    parts.append(o)
    for ri, (rx, ry, rs, rz) in enumerate((
            (-1.9, -0.7, 1.15, 0.8), (1.95, -0.35, 0.85, 2.1),
            (0.6, 2.55, 1.0, 0.3), (-2.5, 1.3, 0.7, 1.4))):
        rock2 = bm_icosphere(1.0, 5 if ri < 2 else 4)
        bmesh.ops.scale(rock2, vec=Vector((rs * 1.15, rs * 0.95, rs * 0.55)),
                        verts=rock2.verts)
        xform(rock2, T(rx, ry, 0.06) @ RZ(rz))
        o = obj_from_bmesh(f"rock2_{ri}", rock2, coll, mat("Rock_Sea"),
                           smooth=True)
        displace_noise(o, strength=0.20 * rs, scale=0.9 * rs, seed=5 + ri)
        apply_modifiers(o)
        parts.append(o)
    # barnacle patches: pearl studs low on the slab's flanks
    for i in range(12):
        a = rng.uniform(0, math.tau)
        bp = bm_icosphere(rng.uniform(0.04, 0.075), 2)
        xform(bp, T(math.cos(a) * 1.95, 0.6 + math.sin(a) * 1.65,
                    rng.uniform(0.06, 0.26)))
        parts.append(obj_from_bmesh(f"barn{i}", bp, coll, mat("Shell_Pearl"),
                                    smooth=True))

    # ── the throne: arc of great ridged fan shells + coral, seat slab ──
    seat_z = 0.80
    n_back = 5
    for i in range(n_back):
        t = i / (n_back - 1) - 0.5
        a = t * 1.35
        r = 1.05 - abs(t) * 0.38
        m = (T(math.sin(a) * 0.72, 1.15 + math.cos(a) * 0.22 - 0.22,
               seat_z - 0.28) @
             RZ(-a * 0.75) @ RX(math.radians(-14 - abs(t) * 14)))
        fan_shell(coll, f"backshell{i}", r, m, mat("Shell_Pearl"), parts,
                  ribs=8 if abs(t) < 0.3 else 6)
    seat = bm_cylinder(0.58, 0.66, 0.20, segs=14)
    xform(seat, T(0, 0.85, seat_z - 0.08))
    parts.append(obj_from_bmesh("seat", seat, coll, mat("Shell_Pearl"),
                                smooth=True))
    # armrest shells
    for sx in (-1, 1):
        m = (T(sx * 0.72, 0.55, seat_z - 0.14) @ RZ(sx * 1.1) @
             RX(math.radians(-30)))
        fan_shell(coll, f"arm{sx}", 0.5, m, mat("Shell_Pearl"), parts, ribs=5)
    # coral colonies flanking + gripping the throne
    coral_branch(coll, "coralL", (-1.0, 0.95, 0.35), 1.0, 0.10, 11, parts)
    coral_branch(coll, "coralR", (1.0, 1.05, 0.35), 1.15, 0.105, 12, parts)
    coral_branch(coll, "coralR2", (0.7, 0.4, 0.5), 0.65, 0.07, 13, parts)
    coral_branch(coll, "coralF", (-0.6, 0.2, 0.45), 0.6, 0.07, 14, parts)
    coral_branch(coll, "coralB", (0.15, 1.6, 0.4), 0.9, 0.09, 15, parts)
    coral_branch(coll, "coralS", (-1.75, -0.55, 0.25), 0.55, 0.06, 16, parts)

    # ── the idol: weathered figurehead propped on the throne ──
    # leans back against the shell fan slightly (propped, not grown)
    G = T(0, 0.72, seat_z - 0.10) @ RX(math.radians(-7))
    figurehead(coll, "idol", G, parts)

    # ── offering ring on the sand ──
    candle_cluster(coll, "candA", (-1.55, -1.55, 0.0), 5, parts)
    candle_cluster(coll, "candB", (1.45, -1.75, 0.0), 4, parts)
    candle_cluster(coll, "candC", (0.15, -2.35, 0.0), 6, parts)
    candle_cluster(coll, "candD", (2.05, -0.35, 0.0), 3, parts)
    coin_pile(coll, "coinsA", (-0.7, -1.95, 0.0), 10, parts)
    coin_pile(coll, "coinsB", (1.85, -1.05, 0.0), 8, parts)
    coin_pile(coll, "coinsC", (0.55, -1.6, 0.0), 7, parts)
    pearl_shell(coll, "pearlA", (0.85, -2.15, 0.02), 2.6, parts)
    pearl_shell(coll, "pearlB", (-1.9, -0.95, 0.02), 0.9, parts)
    pearl_shell(coll, "pearlC", (-0.35, -1.7, 0.02), 4.2, parts)
    pearl_shell(coll, "pearlD", (1.75, -2.0, 0.02), 5.4, parts)
    pearl_shell(coll, "pearlE", (-1.15, -2.3, 0.02), 1.8, parts)

    # ── the toll: two sailors who never left ──
    r_loc = (1.35, -3.05, 0.0)
    skeleton(coll, "reacher", r_loc, face_yaw(r_loc, (0, 0.8)), POSE_REACH)
    k_loc = (-1.6, -2.75, 0.0)
    skeleton(coll, "bowed", k_loc, face_yaw(k_loc, (0, 0.8)), POSE_KNEEL_BOWED)
    fiddle(coll, "fiddle", (2.0, -3.1, 0.0), 1.1, parts)

    all_objs = [o for o in coll.objects if o.type == 'MESH']
    join(all_objs, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")


build()
print("MERMAID DONE")
