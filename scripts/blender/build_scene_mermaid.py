# MERMAID SHRINE — Mermaid's Folly hero story scene: "the siren's toll".
#
# A shell-and-coral ALTAR on a strata-cut tidal rock slab; a salvaged ship
# FIGUREHEAD (carved mermaid, 2.35 m, verdigris-sheathed crown / fins / scales)
# raised on the altar like an idol, arms open seaward. Ring of offerings:
# emissive candle clusters, coin piles, pearls in open shells. Two sailor
# skeletons oriented TOWARD the idol (one still reaching), a fiddle dropped on
# the sand.
#
# 2026-07 fidelity pass 2 (audit: "reads as a grey lobed blob with red sticks,
# no readable figurehead from a natural approach angle"):
#   * the slab is now STRATA-CUT (stacked chisel-faceted plates with undercut
#     waists + wet skirt) instead of a displaced icosphere blob;
#   * the idol is bigger, carved (chisel facets), given a real face, a
#     verdigris crown + fin webs + tail scale plates, and is raised on a
#     plinth so it silhouettes from the beach approach (-Y);
#   * agx_palette + tint_pass: saturated coral, damp tide band on the rock,
#     pearl iridescence, verdigris mottle.
# Idol faces Blender -Y. Origin at ground center.
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
exec(open(os.path.join(HERE, "_detail.py")).read())
exec(open(os.path.join(HERE, "_story_props.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

rng = random.Random(7)


# ── skeleton (same chunky idiom as skull_totem) ──────────────
def skel_head(coll, name, pos, yaw, pitch, parts):
    R = T(*pos) @ RZ(yaw) @ RX(pitch)
    bm = bm_icosphere(0.115, 3)
    bmesh.ops.scale(bm, vec=Vector((0.88, 1.0, 1.02)), verts=bm.verts)
    xform(bm, R)
    parts.append(obj_from_bmesh(name, bm, coll, mat("Bone"), smooth=True))
    jaw = bm_bevel(bm_box(0.13, 0.11, 0.07), 0.02, 1)
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
    pel = bm_bevel(bm_box(0.26, 0.17, 0.13), 0.035, 1)
    xform(pel, Matrix.Translation(P["pelvis"]) @ RZ(yaw))
    parts.append(obj_from_bmesh(name + "_pelvis", pel, coll, mat("Bone")))
    parts.append(seg_between(coll, name + "_spine", P["pelvis"], P["neck"],
                             0.05, 0.04, mat("Bone"), segs=8))
    sp, nk = Vector(P["pelvis"]), Vector(P["neck"])
    d = nk - sp
    q = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    for i, (f, rr) in enumerate(((0.42, 0.14), (0.56, 0.165), (0.70, 0.155),
                                 (0.82, 0.125))):
        rib = bm_torus(rr, 0.032, segs=12, rings=5)
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
    for s in ("L", "R"):
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
        hb = bm_bevel(bm_box(0.08, 0.11, 0.04), 0.012, 1)
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
    """Scallop fan of overlapping wedge ribs + a scalloped lip, hinge at the
    local origin, fan +Z, flat faces ±Y."""
    for i in range(ribs):
        a = (i / (ribs - 1) - 0.5) * spread
        bm = bm_cylinder(r * 0.055, r * 0.17, r, segs=7)
        bmesh.ops.scale(bm, vec=Vector((1.0, thick, 1.0)), verts=bm.verts)
        xform(bm, m @ RY(a) @ T(0, 0, r * 0.48))
        parts.append(obj_from_bmesh(f"{name}_r{i}", bm, coll, material))
        # scalloped tip lobe
        lobe = bm_icosphere(r * 0.115, 2)
        bmesh.ops.scale(lobe, vec=Vector((1.0, thick * 1.2, 0.7)),
                        verts=lobe.verts)
        xform(lobe, m @ RY(a) @ T(0, 0, r * 0.96))
        parts.append(obj_from_bmesh(f"{name}_l{i}", lobe, coll, material,
                                    smooth=True))
    hinge = bm_icosphere(r * 0.14, 2)
    bmesh.ops.scale(hinge, vec=Vector((1.0, thick * 1.4, 0.8)), verts=hinge.verts)
    xform(hinge, m)
    parts.append(obj_from_bmesh(name + "_h", hinge, coll, material, smooth=True))


def coral_branch(coll, name, base, h, r, seed, parts, lean=0.35, material=None):
    rg = random.Random(seed)
    material = material or mat("Coral")
    p = Vector(base)
    d = Vector((rg.uniform(-lean, lean), rg.uniform(-lean, lean), 1)).normalized()
    rr = r
    for i in range(3):
        ln = h * rg.uniform(0.28, 0.40)
        p2 = p + d * ln
        parts.append(seg_between(coll, f"{name}_s{i}", p, p2, rr, rr * 0.72,
                                 material, segs=7))
        if i >= 1:
            bd = (d + Vector((rg.uniform(-0.9, 0.9), rg.uniform(-0.9, 0.9),
                              0.5))).normalized()
            parts.append(seg_between(coll, f"{name}_b{i}", p, p + bd * ln * 0.7,
                                     rr * 0.6, rr * 0.3, material, segs=6))
            tip = bm_icosphere(rr * 0.42, 1)
            xform(tip, Matrix.Translation(p + bd * ln * 0.7))
            parts.append(obj_from_bmesh(f"{name}_bt{i}", tip, coll, material,
                                        smooth=True))
        p, rr = p2, rr * 0.72
        d = (d + Vector((rg.uniform(-0.5, 0.5), rg.uniform(-0.5, 0.5),
                         0.25))).normalized()
    tip = bm_icosphere(rr * 0.6, 1)
    xform(tip, Matrix.Translation(p))
    parts.append(obj_from_bmesh(f"{name}_tip", tip, coll, material, smooth=True))


def candle_cluster(coll, name, loc, n, parts):
    for i in range(n):
        a = i * math.tau / max(1, n) + rng.uniform(0, 1)
        rr = 0 if i == 0 else rng.uniform(0.09, 0.18)
        h = rng.uniform(0.08, 0.24)
        c = bm_cylinder(rng.uniform(0.028, 0.045), 0.026, h, segs=8)
        for v in c.verts:                      # melted wax runs
            if v.co.z > 0:
                v.co.x *= 1.0 + 0.12 * math.sin(math.atan2(v.co.y, v.co.x) * 5)
        xform(c, T(loc[0] + math.cos(a) * rr, loc[1] + math.sin(a) * rr,
                   loc[2] + h / 2))
        parts.append(obj_from_bmesh(f"{name}_{i}", c, coll, mat("Candle_Wax"),
                                    smooth=True))
        pool = bm_cylinder(0.055, 0.035, 0.015, segs=8)
        xform(pool, T(loc[0] + math.cos(a) * rr, loc[1] + math.sin(a) * rr,
                      loc[2] + 0.008))
        parts.append(obj_from_bmesh(f"{name}_p{i}", pool, coll,
                                    mat("Shell_Pearl"), smooth=True))


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
    """Salvaged carved mermaid figurehead, ~2.3 m tall in local Z.
    Wood_Bleached carving with VERDIGRIS copper sheathing (crown, fin webs,
    tail scale plates) — the accent that makes her read at 20 m.
    Local frame: faces -Y, keel scroll at origin, rises +Z."""
    W = mat("Wood_Bleached")
    VD = mat("Verdigris")
    # the upper body rides the top of the S-curved tail, which now finishes
    # off-axis — one shared offset keeps torso/arms/head stacked on the spine
    TORSO_X = T(-0.08, 0, 0)

    def carved(bm, r, seed, n=9, skip=((0, -1, 0),)):
        carve_facets(bm, r, count=n, depth=(0.84, 0.97), seed=seed,
                     softness=0.02, skip_dirs=skip)
        return bm

    # keel scroll — the salvage stub she was cut from
    curl = [(0, 0.26, 0.10), (0, 0.12, 0.06), (0, -0.02, 0.16), (0, 0.02, 0.36)]
    radii = [0.15, 0.17, 0.18, 0.17]
    for i in range(len(curl) - 1):
        parts.append(seg_between(coll, f"{name}_scroll{i}",
                                 G @ Vector(curl[i]), G @ Vector(curl[i + 1]),
                                 radii[i], radii[i + 1], W, segs=10))
    cap = bm_cylinder(0.16, 0.11, 0.18, segs=10)
    xform(cap, G @ T(0, 0.28, 0.10) @ RX(math.radians(80)))
    parts.append(obj_from_bmesh(name + "_scap", cap, coll, W, smooth=True))
    # tail: a full S-curve of carved, elliptical sections — mass, not a stick.
    # ROUND 2: the first pass still read as a bowling pin at 2 m, so the whole
    # body is ~40% heavier and the S swings much wider in X (a straight
    # vertical column is what made it read as a totem post).
    tail = [(0.12, 0.14, 0.28), (0.20, 0.00, 0.58), (0.10, -0.16, 0.88),
            (-0.10, -0.20, 1.14), (-0.08, -0.10, 1.36)]
    tr = [0.40, 0.375, 0.335, 0.285, 0.235]
    for i in range(len(tail) - 1):
        a, b = G @ Vector(tail[i]), G @ Vector(tail[i + 1])
        d = b - a
        bm = bm_cylinder(tr[i], tr[i + 1], d.length * 1.12, segs=12)
        bmesh.ops.scale(bm, vec=Vector((1.0, 0.74, 1.0)), verts=bm.verts)
        carve_facets(bm, tr[i], count=6, depth=(0.90, 0.99), seed=60 + i,
                     softness=0.03, skip_dirs=((0, -1, 0),))
        q = d.to_track_quat('Z', 'Y')
        xform(bm, Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4())
        parts.append(obj_from_bmesh(f"{name}_tail{i}", bm, coll, W,
                                    smooth=False))
    # hip / fluke root mass so the tail reads as a body, not a pole
    hips = bm_icosphere(0.36, 3)
    bmesh.ops.scale(hips, vec=Vector((1.05, 0.82, 0.92)), verts=hips.verts)
    carve_facets(hips, 0.36, count=8, depth=(0.86, 0.98), seed=63,
                 softness=0.03)
    xform(hips, G @ T(0.13, 0.04, 0.40))
    parts.append(obj_from_bmesh(name + "_hips", hips, coll, W, smooth=False))
    # verdigris scale plates banded up the tail, following the S.
    # ROUND 3: the plates must stand PROUD of the local tail radius or they
    # vanish inside the (now much heavier) body — that is what happened last
    # pass. Radius is sampled from the tail taper + a fixed 0.055 lap.
    def tail_r(t):
        return 0.40 - 0.175 * t

    for i in range(7):
        t = i / 6
        z = 0.38 + t * 0.92
        # sample the tail spine so the plates ride the curve instead of
        # floating off it where the S swings
        sx_ = 0.14 + 0.10 * math.sin(t * 3.1) - 0.30 * t * t
        sy_ = 0.11 - 0.30 * t
        rr = tail_r(t) + 0.055
        pl = bm_cylinder(rr, rr * 0.93, 0.075, segs=16)
        for v in pl.verts:                     # scalloped lower lip
            if v.co.z < 0:
                v.co.z -= 0.055 * abs(math.sin(math.atan2(v.co.y, v.co.x) * 7))
        bmesh.ops.scale(pl, vec=Vector((1.0, 0.80, 1.0)), verts=pl.verts)
        xform(pl, G @ T(sx_, sy_, z) @ RY(math.radians(-9 + 16 * t)) @
              RX(math.radians(-6)))
        parts.append(obj_from_bmesh(f"{name}_scale{i}", pl, coll, VD,
                                    smooth=True))
    # HIP FINS: the read that says "mermaid" and not "carved post" from any
    # angle — two swept verdigris webs flaring off the hips on ribs.
    for sx in (-1, 1):
        webv = bmesh.new()
        prof = [(0.0, 0.0), (0.30, 0.13), (0.52, 0.34), (0.58, 0.62),
                (0.40, 0.58), (0.22, 0.38), (0.06, 0.16)]
        vs = [webv.verts.new((px, 0.0, pz)) for px, pz in prof]
        webv.faces.new(vs)
        for v in webv.verts:                    # ruffle the web
            v.co.y = 0.05 * math.sin(v.co.x * 7.0) * (v.co.x / 0.58)
        xform(webv, G @ T(sx * 0.30, 0.08, 0.52) @ RZ(sx * math.radians(38)) @
              RY(sx * math.radians(26)))
        o = obj_from_bmesh(f"{name}_hipfin{sx}", webv, coll, VD, smooth=False)
        sm = o.modifiers.new("Sol", 'SOLIDIFY')
        sm.thickness = 0.028
        apply_modifiers(o)
        parts.append(o)
        for ri in range(3):                     # fin ribs
            aa = math.radians(24 + ri * 26)
            rib = bm_cylinder(0.020, 0.008, 0.52, segs=5)
            xform(rib, G @ T(sx * 0.30, 0.08, 0.52) @ RZ(sx * math.radians(38)) @
                  RY(sx * math.radians(26)) @ RY(sx * -aa) @ T(0, 0, 0.26))
            parts.append(obj_from_bmesh(f"{name}_hiprib{sx}{ri}", rib, coll, W,
                                        smooth=True))
    # fluke fins sweeping back off the scroll (verdigris webbing on a rib)
    for sx in (-1, 1):
        fl = bm_cylinder(0.26, 0.012, 0.34, segs=7)
        bmesh.ops.scale(fl, vec=Vector((1.0, 0.22, 1.0)), verts=fl.verts)
        xform(fl, G @ T(sx * 0.17, 0.32, 0.18) @ RY(sx * math.radians(55)) @
              RX(math.radians(-30)))
        parts.append(obj_from_bmesh(f"{name}_fluke{sx}", fl, coll, VD))
        rib = bm_cylinder(0.03, 0.012, 0.36, segs=6)
        xform(rib, G @ T(sx * 0.17, 0.32, 0.18) @ RY(sx * math.radians(55)) @
              RX(math.radians(-30)))
        parts.append(obj_from_bmesh(f"{name}_flukerib{sx}", rib, coll, W,
                                    smooth=True))
    # torso — carved, waisted. ROUND 2: heavier section + a real shoulder yoke;
    # a 0.135-radius torso on a 2.3 m figure is what read as a stick.
    torso = bm_cylinder(0.195, 0.235, 0.46, segs=14)
    for v in torso.verts:
        v.co.x *= 1.0 - 0.18 * math.cos(v.co.z * 6.0)   # waist
        v.co.y *= 0.86
    carved(torso, 0.23, 41, n=7)
    xform(torso, G @ TORSO_X @ T(0, -0.06, 1.56) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh(name + "_torso", torso, coll, W, smooth=False))
    chest = bm_icosphere(0.245, 3)
    bmesh.ops.scale(chest, vec=Vector((1.22, 0.80, 0.86)), verts=chest.verts)
    carved(chest, 0.245, 42, n=8)
    xform(chest, G @ TORSO_X @ T(0, -0.09, 1.80))
    parts.append(obj_from_bmesh(name + "_chest", chest, coll, W, smooth=False))
    # collarbone / neck block so the head doesn't balloon off the chest
    neck = bm_cylinder(0.105, 0.085, 0.13, segs=10)
    xform(neck, G @ TORSO_X @ T(0, -0.10, 1.955))
    parts.append(obj_from_bmesh(name + "_neck", neck, coll, W, smooth=True))
    # arms: one raised in the siren's call, one offered forward — asymmetry is
    # what stops a figurehead reading as a totem pole from the beach approach
    ARM = {-1: ((-0.26, -0.08, 1.90), (-0.52, -0.24, 2.16), (-0.46, -0.36, 2.48)),
           1: ((0.26, -0.10, 1.86), (0.52, -0.38, 1.90), (0.40, -0.66, 1.78))}
    for sx in (-1, 1):
        sh = TORSO_X @ Vector(ARM[sx][0])
        el = TORSO_X @ Vector(ARM[sx][1])
        hd = TORSO_X @ Vector(ARM[sx][2])
        parts.append(seg_between(coll, f"{name}_uarm{sx}", G @ sh, G @ el,
                                 0.078, 0.062, W, segs=8))
        parts.append(seg_between(coll, f"{name}_farm{sx}", G @ el, G @ hd,
                                 0.062, 0.042, W, segs=8))
        # shoulder ball — hides the socket seam and widens the silhouette
        sb = bm_icosphere(0.085, 2)
        xform(sb, Matrix.Translation(G @ sh))
        parts.append(obj_from_bmesh(f"{name}_shldr{sx}", sb, coll, W,
                                    smooth=True))
        hb = bm_icosphere(0.068, 2)
        bmesh.ops.scale(hb, vec=Vector((1.0, 1.3, 0.6)), verts=hb.verts)
        xform(hb, Matrix.Translation(G @ hd))
        parts.append(obj_from_bmesh(f"{name}_hand{sx}", hb, coll, W,
                                    smooth=True))
        # verdigris arm band
        band = bm_torus(0.075, 0.018, segs=10, rings=5)
        xform(band, Matrix.Translation(G @ (sh.lerp(el, 0.55))) @
              RX(math.radians(70)) @ RZ(sx * 0.5))
        parts.append(obj_from_bmesh(f"{name}_band{sx}", band, coll, VD,
                                    smooth=True))
    # head — carved, with brow / nose / eye recesses so a face reads at 5 m
    HG = G @ TORSO_X
    head = bm_icosphere(0.158, 3)
    bmesh.ops.scale(head, vec=Vector((0.92, 0.96, 1.10)), verts=head.verts)
    carve_facets(head, 0.158, count=6, depth=(0.90, 0.98), seed=43,
                 softness=0.01, skip_dirs=((0, -1, 0), (0, -0.5, 0.6)))
    xform(head, HG @ T(0, -0.11, 2.09))
    parts.append(obj_from_bmesh(name + "_head", head, coll, W, smooth=False))
    for sx in (-1, 1):                          # eye sockets
        e = bm_icosphere(0.040, 2)
        bmesh.ops.scale(e, vec=Vector((1.0, 0.55, 0.75)), verts=e.verts)
        xform(e, HG @ T(sx * 0.058, -0.242, 2.115))
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", e, coll,
                                    mat("Wood_Mid"), smooth=True))
    brow = bm_box(0.175, 0.055, 0.034)
    xform(brow, HG @ T(0, -0.235, 2.150) @ RX(math.radians(8)))
    parts.append(obj_from_bmesh(name + "_brow", brow, coll, W))
    nose = bm_cylinder(0.026, 0.010, 0.085, segs=6)
    xform(nose, HG @ T(0, -0.250, 2.085) @ RX(math.radians(92)))
    parts.append(obj_from_bmesh(name + "_nose", nose, coll, W, smooth=True))
    # verdigris crown — the silhouette read
    crown = bm_cylinder(0.145, 0.132, 0.055, segs=12)
    xform(crown, HG @ T(0, -0.10, 2.215))
    parts.append(obj_from_bmesh(name + "_crown", crown, coll, VD, smooth=True))
    for i in range(7):
        a = -1.4 + i * (2.8 / 6)
        h = 0.145 if i % 2 == 0 else 0.095
        sp = bm_cylinder(0.024, 0.005, h, segs=5)
        xform(sp, HG @ T(0, -0.10, 2.245) @ RZ(a) @ T(0, -0.130, h / 2) @
              RX(math.radians(-16)))
        parts.append(obj_from_bmesh(f"{name}_cspike{i}", sp, coll, VD,
                                    smooth=True))
    # hair mass streaming back (breaks the head silhouette)
    hair = bm_icosphere(0.19, 3)
    bmesh.ops.scale(hair, vec=Vector((0.92, 1.45, 1.0)), verts=hair.verts)
    carve_facets(hair, 0.19, count=10, depth=(0.86, 0.99), seed=44,
                 softness=0.02)
    xform(hair, HG @ T(0, 0.07, 2.12) @ RX(math.radians(22)))
    parts.append(obj_from_bmesh(name + "_hair", hair, coll, mat("Wood_Mid"),
                                smooth=False))
    for i, (ox, oz, ln, tilt) in enumerate(((-0.13, 1.96, 0.70, 150),
                                            (0.13, 1.92, 0.62, 162),
                                            (0.0, 2.02, 0.78, 156))):
        hs = bm_cylinder(0.090, 0.026, ln, segs=7)
        xform(hs, HG @ T(ox, 0.18, oz) @ RX(math.radians(tilt)))
        parts.append(obj_from_bmesh(f"{name}_hair{i}", hs, coll, mat("Wood_Mid"),
                                    smooth=True))
    # weathered mounting stump at the back (salvage evidence)
    stump = bm_bevel(bm_box(0.22, 0.14, 0.42), 0.025, 2)
    xform(stump, G @ T(0, 0.26, 0.50) @ RX(math.radians(8)))
    parts.append(obj_from_bmesh(name + "_mount", stump, coll, mat("Wood_Mid")))
    for zz in (0.34, 0.62):
        parts += iron_strap(coll, f"{name}_mstrap{zz:.2f}",
                            G @ T(0, 0.26, zz) @ RX(math.pi / 2), 0.26, 0.30,
                            0.028, bolts=2, material=mat("Rust"))


def fiddle(coll, name, loc, yaw, parts):
    m = T(*loc) @ RZ(yaw)
    for i, (dy, s) in enumerate(((0.0, 1.0), (-0.16, 0.8))):
        b = bm_icosphere(0.11 * s, 2)
        bmesh.ops.scale(b, vec=Vector((0.85, 1.15, 0.30)), verts=b.verts)
        xform(b, m @ T(0, dy, 0.035))
        parts.append(obj_from_bmesh(f"{name}_body{i}", b, coll,
                                    mat("Wood_Mid"), smooth=True))
    neck = bm_bevel(bm_box(0.035, 0.34, 0.02), 0.006, 1)
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


def strata_rock(coll, name, cx, cy, rx, ry, plates, parts, seed=0, z0=0.0,
                material=None, waist=0.86):
    """Tidal rock: stacked chisel-faceted plates with undercut waists — reads
    as bedded sea stone instead of a lobed blob."""
    rg = random.Random(seed)
    material = material or mat("Rock_Sea")
    z = z0
    for i in range(plates):
        t = i / max(1, plates - 1)
        h = rg.uniform(0.16, 0.28)
        sx = rx * (waist ** i) * rg.uniform(0.94, 1.06)
        sy = ry * (waist ** i) * rg.uniform(0.94, 1.06)
        bm = bm_icosphere(1.0, 3)
        for v in bm.verts:                     # flatten into a plate
            v.co.z = max(-1.0, min(1.0, v.co.z * 2.2))
        carve_facets(bm, 1.0, count=9, depth=(0.80, 0.97), seed=seed * 13 + i,
                     softness=0.05)
        bmesh.ops.scale(bm, vec=Vector((sx, sy, h)), verts=bm.verts)
        xform(bm, T(cx + rg.uniform(-0.10, 0.10), cy + rg.uniform(-0.10, 0.10),
                    z + h * 0.55) @ RZ(rg.uniform(0, math.tau)))
        parts.append(obj_from_bmesh(f"{name}_p{i}", bm, coll, material,
                                    smooth=False))
        z += h * (1.05 + 0.25 * t)
    return z


def build():
    clear_default_scene()
    agx_palette({
        "Candle_Wax": ((0.62, 0.55, 0.36, 1.0), 0.6, 0.0),
    })
    emissive("Candle_Wax", (1.0, 0.72, 0.30, 1.0), 2.4)
    name = "mermaid_shrine"
    coll = asset_collection(name)
    parts = []

    # ── tidal rock slab: strata plates + flanking sea rocks ──
    top = strata_rock(coll, "slab", 0.0, 0.75, 2.15, 1.85, 4, parts, seed=3,
                      z0=-0.04, waist=0.88)
    for ri, (rx, ry, rs, plates) in enumerate((
            (-1.95, -0.60, 1.05, 3), (2.00, -0.30, 0.85, 3),
            (0.55, 2.50, 0.95, 2), (-2.45, 1.35, 0.70, 2))):
        strata_rock(coll, f"rock{ri}", rx, ry, rs * 1.05, rs * 0.92, plates,
                    parts, seed=11 + ri, z0=-0.05, waist=0.84)
    # wet skirt: darker damp plate ring at the waterline
    for i in range(10):
        a = i * math.tau / 10 + 0.3
        sk = bm_icosphere(1.0, 2)
        for v in sk.verts:
            v.co.z = max(-1.0, min(1.0, v.co.z * 2.6))
        bmesh.ops.scale(sk, vec=Vector((rng.uniform(0.45, 0.8),
                                        rng.uniform(0.35, 0.6), 0.09)),
                        verts=sk.verts)
        xform(sk, T(math.cos(a) * 2.15, 0.75 + math.sin(a) * 1.85, 0.02) @
              RZ(rng.uniform(0, 3)))
        parts.append(obj_from_bmesh(f"skirt{i}", sk, coll, mat("Rock_Sea"),
                                    smooth=False))
    # barnacle patches: pearl studs low on the slab's flanks
    for i in range(16):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.035, 0.075)
        bp = bm_icosphere(r, 2)
        bmesh.ops.scale(bp, vec=Vector((1, 1, 0.7)), verts=bp.verts)
        xform(bp, T(math.cos(a) * 1.95, 0.75 + math.sin(a) * 1.7,
                    rng.uniform(0.06, 0.34)))
        parts.append(obj_from_bmesh(f"barn{i}", bp, coll, mat("Shell_Pearl"),
                                    smooth=True))

    # ── the altar: arc of great ridged fan shells + coral, seat slab ──
    seat_z = 0.84
    n_back = 5
    for i in range(n_back):
        t = i / (n_back - 1) - 0.5
        a = t * 1.35
        r = 1.15 - abs(t) * 0.40
        m = (T(math.sin(a) * 0.74, 1.18 + math.cos(a) * 0.22 - 0.22,
               seat_z - 0.30) @
             RZ(-a * 0.75) @ RX(math.radians(-14 - abs(t) * 14)))
        fan_shell(coll, f"backshell{i}", r, m, mat("Shell_Pearl"), parts,
                  ribs=8 if abs(t) < 0.3 else 6)
    # altar block the idol stands on (raises her above the throne back)
    alt = bm_bevel(bm_box(0.86, 0.82, 0.34), 0.05, 2)
    xform(alt, T(0, 0.82, seat_z - 0.02))
    parts.append(obj_from_bmesh("altar", alt, coll, mat("Rock_Sea")))
    for i in range(3):                          # carved offering ledge lines
        ln = bm_box(0.62 - i * 0.12, 0.03, 0.03)
        xform(ln, T(0, 0.82 - 0.41, seat_z + 0.05 - i * 0.09))
        parts.append(obj_from_bmesh(f"altarline{i}", ln, coll,
                                    mat("Shell_Pearl")))
    seat = bm_cylinder(0.60, 0.68, 0.20, segs=14)
    xform(seat, T(0, 0.85, seat_z - 0.16))
    parts.append(obj_from_bmesh("seat", seat, coll, mat("Shell_Pearl"),
                                smooth=True))
    for sx in (-1, 1):
        m = (T(sx * 0.74, 0.55, seat_z - 0.16) @ RZ(sx * 1.1) @
             RX(math.radians(-30)))
        fan_shell(coll, f"arm{sx}", 0.52, m, mat("Shell_Pearl"), parts, ribs=5)
    coral_branch(coll, "coralL", (-1.05, 0.95, 0.42), 1.05, 0.17, 11, parts)
    coral_branch(coll, "coralR", (1.05, 1.05, 0.42), 1.20, 0.175, 12, parts)
    coral_branch(coll, "coralR2", (0.72, 0.40, 0.55), 0.65, 0.13, 13, parts,
                 material=mat("Coral_Pink"))
    coral_branch(coll, "coralF", (-0.62, 0.20, 0.50), 0.60, 0.13, 14, parts,
                 material=mat("Coral_Pink"))
    coral_branch(coll, "coralB", (0.15, 1.65, 0.45), 0.90, 0.15, 15, parts)
    coral_branch(coll, "coralS", (-1.80, -0.55, 0.28), 0.55, 0.12, 16, parts,
                 material=mat("Coral_Pink"))
    # brain-coral domes + a plate coral fan (mass to carry the red)
    for i, (bx, by, bz, br, bmat) in enumerate((
            (-1.32, 0.30, 0.42, 0.34, "Coral"),
            (1.28, 0.42, 0.44, 0.28, "Coral_Pink"),
            (0.28, 1.82, 0.46, 0.24, "Coral"))):
        dm = bm_icosphere(br, 3)
        bmesh.ops.scale(dm, vec=Vector((1.15, 1.0, 0.72)), verts=dm.verts)
        for v in dm.verts:                      # brain-coral grooving
            v.co *= 1.0 + 0.07 * math.sin(v.co.x * 22) * math.sin(v.co.y * 19)
        xform(dm, T(bx, by, bz) @ RZ(rng.uniform(0, 3)))
        parts.append(obj_from_bmesh(f"brain{i}", dm, coll, mat(bmat),
                                    smooth=True))
    for i, (px, py, pz, pr, ang) in enumerate((
            (-1.62, 0.05, 0.62, 0.44, 0.6), (1.55, 0.72, 0.60, 0.38, -0.7))):
        fanm = bm_cylinder(pr, pr * 0.75, 0.05, segs=12)
        for v in fanm.verts:                    # ruffled plate rim
            v.co.z += 0.06 * math.sin(math.atan2(v.co.y, v.co.x) * 5) * \
                (math.hypot(v.co.x, v.co.y) / pr)
        xform(fanm, T(px, py, pz) @ RZ(ang) @ RX(math.radians(66)))
        parts.append(obj_from_bmesh(f"plate{i}", fanm, coll, mat("Coral"),
                                    smooth=True))

    # ── the idol: salvaged figurehead raised on the altar ──
    G = T(0, 0.74, seat_z + 0.14) @ RZ(math.radians(21)) @ RX(math.radians(-11))
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
    pearl_shell(coll, "pearlE", (-2.05, -1.72, 0.02), 1.8, parts)

    # ── THE TRIBUTE ROWBOAT (backlog: was unshipped) ──
    # Somebody rowed out here with an offering and never rowed back. Beached
    # across the seaward approach, listing, bilge heaped with shells and coin.
    # Same builder as the standalone rowboat.glb so the two can never diverge.
    rowboat(coll, "tribute",
            T(-0.35, -2.85, 0.03) @ RZ(math.radians(74)) @
            RX(math.radians(-6)) @ RY(math.radians(9)),
            parts, rng=random.Random(57))

    # ── the toll: two sailors who never left ──
    r_loc = (1.35, -3.05, 0.0)
    skeleton(coll, "reacher", r_loc, face_yaw(r_loc, (0, 0.8)), POSE_REACH)
    k_loc = (-2.25, -2.05, 0.0)
    skeleton(coll, "bowed", k_loc, face_yaw(k_loc, (0, 0.8)), POSE_KNEEL_BOWED)
    fiddle(coll, "fiddle", (2.0, -3.1, 0.0), 1.1, parts)

    SPEC = tint_spec(moss=0.30)
    SPEC['Rock_Sea'] = dict(
        tone=0.16, hue=((1.16, 1.16, 1.10), (0.72, 0.80, 0.94)), scale=1.1,
        mottle=0.13, mscale=0.30,
        patch=dict(col=(0.55, 0.95, 0.45), amt=0.55, scale=0.70, thresh=0.60,
                   width=0.14, up=0.75),
        low=dict(z=0.42, amt=0.50, col=(0.40, 0.52, 0.52)))
    SPEC['Shell_Pearl'] = dict(
        tone=0.14, hue=((1.20, 1.08, 0.94), (0.82, 0.92, 1.10)), scale=0.35,
        mottle=0.10, mscale=0.12,
        low=dict(z=0.50, amt=0.36, col=(0.55, 0.66, 0.72)))
    SPEC['Verdigris'] = dict(
        tone=0.12, hue=((1.24, 1.10, 0.92), (0.76, 0.98, 1.02)), scale=0.30,
        mottle=0.16, mscale=0.10,
        patch=dict(col=(1.30, 0.85, 0.55), amt=0.45, scale=0.25, thresh=0.66,
                   width=0.12, up=0.3))
    ship_asset(coll, name, spec=SPEC, ao=dict(samples=22, floor=0.42),
               render_dir=RENDER_DIR, views=4, elev=13)
    print(f"built {name}")


build()
print("MERMAID DONE")
