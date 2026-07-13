# CROW ROOST — Crow's Perch hero scene: the dead lookout.
# Rickety crow's-nest platform on a tall lashed pole-tripod (~9m) with a ladder
# up the front leg; a skeleton slumped against the (broken) front rail with a
# spyglass STILL RAISED toward the horizon (-Y); tally marks carved into the
# ladder post; a great dead snag tree beside it with stylized crows perched,
# one crow mid-hop on the skeleton's shoulder. Focal: the raised spyglass.
# Faces Blender -Y. Headless: Blender -b -P scripts/blender/build_scene_crowroost.py
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
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad/renders/s-structures/round1")

EXTRA = {
    "Bone":       ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
    "Crow_Black": ((0.05, 0.05, 0.06, 1.0), 0.85, 0.0),
}
for _n, _v in EXTRA.items():
    PALETTE.setdefault(_n, _v)


def bm_bevel(bm, width=0.02):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=1, profile=0.72, affect='EDGES', clamp_overlap=True)
    return bm


def placedM(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return bm


def placed(bm, loc=(0, 0, 0), rz=0.0, ry=0.0, rx=0.0):
    M = (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(rz, 4, 'Z')
         @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X'))
    return placedM(bm, M)


def tube(coll, name, p0, p1, r0, r1, mname, segs=10, smooth=True):
    """Tapered cylinder between two world points."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bm_cylinder(r0, r1, d.length, segs=segs)
    M = (Matrix.Translation((p0 + p1) * 0.5)
         @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4())
    placedM(bm, M)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)


def wobbly_pole(coll, name, p0, p1, r0, r1, mname, segs=14, kinks=4, jitter=0.05,
                seed=0):
    """Organic pole: chained tapered tubes with slight kinks + surface chatter."""
    p0, p1 = Vector(p0), Vector(p1)
    rng = random.Random(seed)
    axis = (p1 - p0).normalized()
    ax = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    t1 = axis.cross(ax).normalized()
    t2 = axis.cross(t1)
    pts, rads = [], []
    for k in range(kinks + 1):
        t = k / kinks
        off = Vector((0, 0, 0)) if k in (0, kinks) else \
            t1 * rng.uniform(-jitter, jitter) + t2 * rng.uniform(-jitter, jitter)
        pts.append(p0.lerp(p1, t) + off)
        rads.append(r0 + (r1 - r0) * t)
    out = []
    for k in range(kinks):
        o = tube(coll, f"{name}_{k}", pts[k], pts[k + 1], rads[k],
                 rads[k + 1], mname, segs=segs)
        out.append(o)
        if 0 < k:  # blend the joint with a knuckle sphere
            js = bm_icosphere(rads[k] * 1.06, 3)
            placed(js, pts[k])
            out.append(obj_from_bmesh(f"{name}_j{k}", js, coll, mat(mname),
                                      smooth=True))
    return out, pts


def rope_wrap(coll, name, loc, r, h, turns=3, rx=0.0, ry=0.0):
    parts = []
    for k in range(turns):
        bm = bm_cylinder(r, r, h / turns * 0.9, segs=10, cap=False)
        placed(bm, (loc[0], loc[1], loc[2] + (k - (turns - 1) / 2) * h / turns),
               rx=rx, ry=ry)
        o = obj_from_bmesh(f"{name}_{k}", bm, coll, mat("Rope"), smooth=True)
        s = o.modifiers.new("Solid", 'SOLIDIFY')
        s.thickness = 0.028
        apply_modifiers(o)
        parts.append(o)
    return parts


def crow(coll, name, loc, yaw, wings_up=False, s=1.0):
    """Stylized sharp crow silhouette, facing local -Y."""
    parts = []
    M = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
    body = bm_icosphere(0.085 * s, 3)
    bmesh.ops.scale(body, vec=Vector((0.9, 1.6, 0.95)), verts=body.verts)
    placedM(body, M @ Matrix.Translation((0, 0, 0.10 * s)))
    parts.append(obj_from_bmesh(name + "_body", body, coll, mat("Crow_Black"), smooth=True))
    head = bm_icosphere(0.052 * s, 3)
    placedM(head, M @ Matrix.Translation((0, -0.115 * s, 0.175 * s)))
    parts.append(obj_from_bmesh(name + "_head", head, coll, mat("Crow_Black"), smooth=True))
    beak = bm_cylinder(0.016 * s, 0.001, 0.075 * s, segs=6)
    placedM(beak, M @ Matrix.Translation((0, -0.165 * s, 0.170 * s))
            @ Matrix.Rotation(math.radians(96), 4, 'X'))
    parts.append(obj_from_bmesh(name + "_beak", beak, coll, mat("Crow_Black"), smooth=True))
    tail = bm_box(0.05 * s, 0.16 * s, 0.014 * s)
    for v in tail.verts:
        if v.co.y > 0:
            v.co.x *= 1.7
    placedM(tail, M @ Matrix.Translation((0, 0.16 * s, 0.115 * s))
            @ Matrix.Rotation(math.radians(-18), 4, 'X'))
    parts.append(obj_from_bmesh(name + "_tail", tail, coll, mat("Crow_Black")))
    for sx in (-1, 1):
        wing = bm_box(0.02 * s, 0.17 * s, 0.09 * s)
        for v in wing.verts:
            if v.co.z < 0:
                v.co.y *= 0.55
        if wings_up:
            Mw = (M @ Matrix.Translation((sx * 0.075 * s, 0.01, 0.16 * s))
                  @ Matrix.Rotation(sx * math.radians(-62), 4, 'Y'))
        else:
            Mw = (M @ Matrix.Translation((sx * 0.082 * s, 0.02, 0.115 * s))
                  @ Matrix.Rotation(sx * math.radians(-8), 4, 'Y'))
        placedM(wing, Mw)
        parts.append(obj_from_bmesh(f"{name}_w{sx}", wing, coll, mat("Crow_Black")))
    for sx in (-1, 1):
        leg = bm_cylinder(0.006 * s, 0.005 * s, 0.055 * s, segs=5)
        placedM(leg, M @ Matrix.Translation((sx * 0.03 * s, -0.02 * s, 0.028 * s)))
        parts.append(obj_from_bmesh(f"{name}_l{sx}", leg, coll, mat("Crow_Black"), smooth=True))
    return parts


def skeleton_lookout(coll, name, zp):
    """Slumped seated skeleton at platform height zp, facing -Y, right arm
    raising a spyglass toward the horizon."""
    parts = []
    B = "Bone"
    pelvis = bm_icosphere(0.095, 3)
    bmesh.ops.scale(pelvis, vec=Vector((1.2, 0.9, 0.75)), verts=pelvis.verts)
    placed(pelvis, (0.02, -0.52, zp + 0.10))
    parts.append(obj_from_bmesh(name + "_pelvis", pelvis, coll, mat(B), smooth=True))
    # spine curving forward (slump)
    spine_pts = [(0.02, -0.54, zp + 0.16), (0.03, -0.58, zp + 0.28),
                 (0.04, -0.64, zp + 0.40), (0.05, -0.70, zp + 0.50)]
    for i in range(len(spine_pts) - 1):
        parts.append(tube(coll, f"{name}_sp{i}", spine_pts[i], spine_pts[i + 1],
                          0.028, 0.024, B, segs=7))
    # ribcage: 5 flattened tori around the spine
    for i in range(5):
        t = i / 4.0
        mr = 0.145 - 0.045 * t
        z = zp + 0.26 + 0.062 * i
        bpy.ops.mesh.primitive_torus_add(major_radius=mr, minor_radius=0.016,
                                         major_segments=20, minor_segments=8,
                                         location=(0.03, -0.585 - 0.028 * i, z),
                                         rotation=(math.radians(78), 0, 0))
        rib = bpy.context.active_object
        rib.name = f"{name}_rib{i}"
        rib.scale = (1.0, 0.82, 1.0)
        link_only(rib, coll)
        rib.data.materials.append(mat(B))
        for p in rib.data.polygons:
            p.use_smooth = True
        parts.append(rib)
    # shoulders
    parts.append(tube(coll, name + "_clav", (-0.16, -0.68, zp + 0.52),
                      (0.20, -0.68, zp + 0.52), 0.02, 0.02, B, segs=7))
    # skull, tilted back against the raised arm, looking out -Y
    skull = bm_icosphere(0.105, 3)
    bmesh.ops.scale(skull, vec=Vector((0.92, 1.05, 1.0)), verts=skull.verts)
    placed(skull, (0.06, -0.72, zp + 0.65), rx=math.radians(-12))
    parts.append(obj_from_bmesh(name + "_skull", skull, coll, mat(B), smooth=True))
    for sx in (-1, 1):
        eye = bm_icosphere(0.028, 1)
        placed(eye, (0.06 + sx * 0.042, -0.795, zp + 0.66))
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", eye, coll,
                                    mat("Char_Black"), smooth=True))
    jaw = bm_box(0.11, 0.09, 0.045)
    bm_bevel(jaw, 0.014)
    placed(jaw, (0.06, -0.75, zp + 0.565), rx=math.radians(14))
    parts.append(obj_from_bmesh(name + "_jaw", jaw, coll, mat(B)))
    # RIGHT arm raised with the spyglass (the focal line)
    sh_r = (0.20, -0.68, zp + 0.52)
    el_r = (0.30, -0.84, zp + 0.62)
    ha_r = (0.16, -0.92, zp + 0.70)
    parts.append(tube(coll, name + "_uarmR", sh_r, el_r, 0.024, 0.02, B, segs=7))
    parts.append(tube(coll, name + "_farmR", el_r, ha_r, 0.019, 0.016, B, segs=7))
    for j, p in ((0, sh_r), (1, el_r)):
        js = bm_icosphere(0.030, 1)
        placed(js, p)
        parts.append(obj_from_bmesh(f"{name}_jR{j}", js, coll, mat(B), smooth=True))
    hand = bm_icosphere(0.034, 1)
    placed(hand, ha_r)
    parts.append(obj_from_bmesh(name + "_handR", hand, coll, mat(B), smooth=True))
    # spyglass: raised, aimed out over the rail toward -Y, tilted up slightly
    Msg = (Matrix.Translation((0.12, -0.94, zp + 0.71))
           @ Matrix.Rotation(math.radians(80), 4, 'X'))  # +Z -> mostly -Y, up-tilt
    g1 = bm_cylinder(0.033, 0.030, 0.24, segs=10)
    placedM(g1, Msg @ Matrix.Translation((0, 0, 0.12)))
    parts.append(obj_from_bmesh(name + "_glass1", g1, coll, mat("Wood_Dark"), smooth=True))
    g2 = bm_cylinder(0.024, 0.021, 0.20, segs=10)
    placedM(g2, Msg @ Matrix.Translation((0, 0, 0.33)))
    parts.append(obj_from_bmesh(name + "_glass2", g2, coll, mat("Metal_Iron"), smooth=True))
    for bz in (0.015, 0.235, 0.42):
        band = bm_cylinder(0.036 if bz < 0.05 else 0.027,
                           0.036 if bz < 0.05 else 0.027, 0.025, segs=10)
        placedM(band, Msg @ Matrix.Translation((0, 0, bz)))
        parts.append(obj_from_bmesh(f"{name}_gb{bz:.2f}", band, coll,
                                    mat("Metal_Iron"), smooth=True))
    # LEFT arm dropped in lap
    sh_l = (-0.16, -0.68, zp + 0.52)
    el_l = (-0.24, -0.55, zp + 0.30)
    ha_l = (-0.10, -0.42, zp + 0.14)
    parts.append(tube(coll, name + "_uarmL", sh_l, el_l, 0.024, 0.02, B, segs=7))
    parts.append(tube(coll, name + "_farmL", el_l, ha_l, 0.019, 0.016, B, segs=7))
    for j, p in ((0, sh_l), (1, el_l), (2, ha_l)):
        js = bm_icosphere(0.028, 1)
        placed(js, p)
        parts.append(obj_from_bmesh(f"{name}_jL{j}", js, coll, mat(B), smooth=True))
    # legs sprawled flat on the platform
    hip_r, hip_l = (0.12, -0.50, zp + 0.10), (-0.09, -0.50, zp + 0.10)
    kn_r, kn_l = (0.30, -0.22, zp + 0.16), (-0.28, -0.26, zp + 0.10)
    ft_r, ft_l = (0.22, 0.06, zp + 0.06), (-0.16, 0.04, zp + 0.06)
    for tag, hip, kn, ft in (("R", hip_r, kn_r, ft_r), ("L", hip_l, kn_l, ft_l)):
        parts.append(tube(coll, f"{name}_th{tag}", hip, kn, 0.030, 0.024, B, segs=7))
        parts.append(tube(coll, f"{name}_sh{tag}", kn, ft, 0.023, 0.018, B, segs=7))
        js = bm_icosphere(0.032, 1)
        placed(js, kn)
        parts.append(obj_from_bmesh(f"{name}_kn{tag}", js, coll, mat(B), smooth=True))
        foot = bm_box(0.07, 0.16, 0.045)
        bm_bevel(foot, 0.012)
        placed(foot, (ft[0], ft[1] - 0.05, ft[2]))
        parts.append(obj_from_bmesh(f"{name}_ft{tag}", foot, coll, mat(B)))
    return parts


def build_crowroost(name="crow_roost"):
    clear_default_scene()
    coll = asset_collection(name)
    rng = random.Random(17)
    parts = []
    APEX = Vector((0.0, 0.0, 8.7))
    ZP = 7.05           # platform floor height
    FOOT_R = 2.35

    # ── the lashed pole tripod (front leg carries the ladder + tallies) ──
    foot_angs = [math.radians(270), math.radians(30), math.radians(150)]
    feet = []
    for i, a in enumerate(foot_angs):
        f = Vector((math.cos(a) * FOOT_R, math.sin(a) * FOOT_R, -0.15))
        feet.append(f)
        top = APEX + Vector((math.cos(a) * 0.14, math.sin(a) * 0.14, 0.25))
        pmat = ("Wood_Mid", "Wood_Bleached", "Wood_Mid")[i]
        polesegs, _ = wobbly_pole(coll, f"{name}_pole{i}", f, top, 0.125, 0.08,
                                  pmat, segs=16, kinks=5,
                                  jitter=0.04, seed=60 + i)
        parts += polesegs
    # cross braces between legs (rickety: one slipped)
    for i in range(3):
        j = (i + 1) % 3
        z0, z1 = 2.6, 3.1
        p0 = feet[i].lerp(Vector((APEX.x, APEX.y, APEX.z)), z0 / APEX.z)
        p1 = feet[j].lerp(Vector((APEX.x, APEX.y, APEX.z)), z1 / APEX.z)
        if i == 2:  # slipped brace hangs low at one end
            p1 = p1 + Vector((0, 0, -1.1))
        parts.append(tube(coll, f"{name}_brace{i}", p0, p1, 0.05, 0.045,
                          "Wood_Dark", segs=8))
    # apex lashing wraps
    parts += rope_wrap(coll, name + "_lash", (0, 0, 8.55), 0.24, 0.45, turns=4,
                       rx=0.12)
    for i in range(3):
        p0 = feet[i].lerp(Vector(APEX), 2.85 / APEX.z)
        parts += rope_wrap(coll, f"{name}_blash{i}",
                           (p0.x, p0.y, p0.z), 0.09, 0.16, turns=2,
                           rx=0.5, ry=0.4)

    # ── crow's-nest platform: radial planks + baluster rail (broken at -Y) ──
    NP = 16
    PR = 1.18
    for i in range(NP):
        a0 = math.tau * i / NP + 0.015
        a1 = math.tau * (i + 1) / NP - 0.015
        bm = bmesh.new()
        rows = []
        for k in range(3):
            a = a0 + (a1 - a0) * k / 2
            rows.append((bm.verts.new((math.cos(a) * 0.12, math.sin(a) * 0.12, 0)),
                         bm.verts.new((math.cos(a) * PR, math.sin(a) * PR, 0))))
        fs = [bm.faces.new((rows[k][0], rows[k][1], rows[k + 1][1], rows[k + 1][0]))
              for k in range(2)]
        r = bmesh.ops.extrude_face_region(bm, geom=fs)
        bmesh.ops.translate(bm, vec=(0, 0, 0.06),
                            verts=[v for v in r['geom'] if isinstance(v, bmesh.types.BMVert)])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.012, offset_type='OFFSET',
                        segments=2, profile=0.72, affect='EDGES', clamp_overlap=True)
        placed(bm, (0, 0, ZP - 0.06 + rng.uniform(-0.012, 0.012)))
        mname = "Wood_Dark" if i % 5 == 0 else ("Wood_Mid" if i % 2 else "Wood_Bleached")
        parts.append(obj_from_bmesh(f"{name}_deck{i}", bm, coll, mat(mname)))
    # support bearers under the deck
    for i in range(3):
        a = foot_angs[i]
        br = bm_box(0.10, 2.1, 0.09)
        bm_bevel(br, 0.015)
        placed(br, (0, 0, ZP - 0.11), rz=a + math.pi / 2)
        parts.append(obj_from_bmesh(f"{name}_bear{i}", br, coll, mat("Wood_Dark")))
    # rail: balusters + top rail ring, BROKEN across the front (-Y) arc
    NB = 14
    RH = 0.92
    gap_c, gap_h = math.radians(270), math.radians(34)
    for i in range(NB):
        a = math.tau * i / NB + 0.11
        d = math.atan2(math.sin(a - gap_c), math.cos(a - gap_c))
        if abs(d) < gap_h:
            continue
        lean = rng.uniform(-0.06, 0.06)
        b = tube(coll, f"{name}_bal{i}",
                 (math.cos(a) * (PR - 0.07), math.sin(a) * (PR - 0.07), ZP),
                 (math.cos(a) * (PR - 0.07) + lean, math.sin(a) * (PR - 0.07) + lean,
                  ZP + RH), 0.035, 0.028, "Wood_Bleached", segs=7)
        parts.append(b)
    # top rail: arc segments skipping the broken front
    NR = 16
    for i in range(NR):
        a0 = math.tau * i / NR
        a1 = math.tau * (i + 1) / NR
        am = (a0 + a1) / 2
        d = math.atan2(math.sin(am - gap_c), math.cos(am - gap_c))
        if abs(d) < gap_h:
            continue
        p0 = (math.cos(a0) * (PR - 0.07), math.sin(a0) * (PR - 0.07), ZP + RH)
        p1 = (math.cos(a1) * (PR - 0.07), math.sin(a1) * (PR - 0.07), ZP + RH)
        parts.append(tube(coll, f"{name}_rail{i}", p0, p1, 0.038, 0.038,
                          "Wood_Mid", segs=7))
    # the snapped rail ends droop into the gap; one baluster dangles
    for sgn, aa in ((-1, gap_c + gap_h), (1, gap_c - gap_h)):
        p0 = (math.cos(aa) * (PR - 0.07), math.sin(aa) * (PR - 0.07), ZP + RH)
        aend = aa - sgn * 0.28
        p1 = (math.cos(aend) * (PR + 0.12), math.sin(aend) * (PR + 0.12), ZP + RH - 0.5)
        parts.append(tube(coll, f"{name}_snap{sgn}", p0, p1, 0.036, 0.028,
                          "Wood_Mid", segs=7))
    parts.append(tube(coll, name + "_dangle",
                      (0.42, -PR - 0.05, ZP + 0.30), (0.52, -PR - 0.12, ZP - 0.62),
                      0.03, 0.026, "Wood_Bleached", segs=6))
    # frayed rope hanging off the platform edge
    rp = [Vector((-0.9, -0.62, ZP + 0.02))]
    for k in range(6):
        rp.append(rp[-1] + Vector((rng.uniform(-0.07, 0.07),
                                   rng.uniform(-0.10, 0.02), -0.42)))
    for k in range(6):
        parts.append(tube(coll, f"{name}_rope{k}", rp[k], rp[k + 1],
                          0.022, 0.022, "Rope", segs=6))

    # ── ladder lashed up the front (-Y) leg + carved tally marks ──
    lpole = feet[0]
    lptop = Vector((0, -0.55, ZP + 0.45))       # pole point near platform height
    laxis = (lptop - lpole).normalized()
    lout = Vector((0, -1, 0)) - laxis * (Vector((0, -1, 0)).dot(laxis))
    lout.normalize()                            # perpendicular offset, outward -Y
    lb0 = lpole + lout * 0.27
    lb1 = lptop + lout * 0.27
    for side in (-1, 1):
        off = Vector((side * 0.23, 0, 0))
        parts.append(tube(coll, f"{name}_str{side}", lb0 + off, lb1 + off,
                          0.040, 0.034, "Wood_Mid", segs=8))
    nr = 17
    for k in range(nr):
        t = (k + 0.7) / (nr + 0.9)
        c = lb0.lerp(lb1, t)
        miss = (k == 11)
        if miss:
            # broken rung: two stubs
            for side in (-1, 1):
                parts.append(tube(coll, f"{name}_rung{k}_{side}",
                                  (c.x + side * 0.23, c.y, c.z),
                                  (c.x + side * 0.08, c.y - 0.03, c.z - 0.10),
                                  0.024, 0.018, "Wood_Dark", segs=6))
            continue
        rot = rng.uniform(-0.05, 0.05)
        parts.append(tube(coll, f"{name}_rung{k}",
                          (c.x - 0.23, c.y, c.z + rot),
                          (c.x + 0.23, c.y, c.z - rot), 0.027, 0.027,
                          "Wood_Mid" if k % 3 else "Wood_Dark", segs=6))
        # lashing ties to the leg every few rungs
        if k % 4 == 1:
            tie = lpole.lerp(lptop, t)
            parts += rope_wrap(coll, f"{name}_ltie{k}", (tie.x, tie.y, tie.z),
                               0.15, 0.10, turns=1, rx=math.atan2(1.8, 8.0))
    # tally marks carved into the front pole, eye height groups
    trng = random.Random(77)
    for g in range(6):
        gz = 1.15 + g * 0.26
        n = 5 if g < 5 else 3
        for k in range(n):
            gpos = lpole.lerp(Vector(APEX), gz / APEX.z)
            diag = (k == 4)
            tm = bm_box(0.016, 0.06, 0.12 if not diag else 0.17)
            ang = trng.uniform(-0.08, 0.08) + (0.55 if diag else 0.0)
            placed(tm, (gpos.x - 0.078 + (k % 5) * (0.036 if not diag else 0.0),
                        gpos.y - 0.125, gpos.z),
                   ry=ang)
            parts.append(obj_from_bmesh(f"{name}_tal{g}_{k}", tm, coll, mat("Char_Black")))

    # ── the dead lookout ──
    parts += skeleton_lookout(coll, name + "_skel", ZP)
    # crow mid-hop on his LEFT shoulder, wings flared
    parts += crow(coll, name + "_crowS", (-0.20, -0.66, ZP + 0.55),
                  math.radians(250), wings_up=True, s=0.9)

    # ── the great dead snag tree, crow-laden ──
    SB = Vector((3.3, 1.2, -0.2))
    tpts = [SB, SB + Vector((0.15, 0.1, 2.4)), SB + Vector((-0.15, 0.35, 4.6)),
            SB + Vector((0.25, 0.2, 6.4))]
    trad = [0.42, 0.30, 0.20, 0.09]
    for i in range(3):
        segs_t, _ = wobbly_pole(coll, f"{name}_trunk{i}", tpts[i], tpts[i + 1],
                                trad[i], trad[i + 1], "Wood_Bleached",
                                segs=18, kinks=3, jitter=0.03, seed=80 + i)
        parts += segs_t
    # jagged broken top
    topspike = bm_cylinder(0.09, 0.005, 0.7, segs=8)
    placed(topspike, (tpts[3].x, tpts[3].y, tpts[3].z + 0.3), ry=0.15)
    parts.append(obj_from_bmesh(name + "_spike", topspike, coll,
                                mat("Wood_Bleached"), smooth=True))
    # root flare
    for k in range(4):
        a = k * math.tau / 4 + 0.5
        parts.append(tube(coll, f"{name}_root{k}",
                          (SB.x + math.cos(a) * 0.75, SB.y + math.sin(a) * 0.75, -0.28),
                          (SB.x + math.cos(a) * 0.1, SB.y + math.sin(a) * 0.1, 0.55),
                          0.10, 0.16, "Wood_Dark", segs=8))
    # branches (bare, angular) — remember tips for crow perches
    brng = random.Random(19)
    perches = []
    branch_spec = [(1.9, 205, 38, 1.6), (2.9, 320, 30, 2.0), (3.8, 80, 24, 1.7),
                   (4.6, 250, 20, 1.5), (5.3, 140, 26, 1.3), (5.9, 10, 32, 1.1),
                   (6.2, 300, 40, 0.8)]
    for bi, (bz, adeg, updeg, blen) in enumerate(branch_spec):
        t = bz / 6.4
        base = Vector((SB.x + 0.05, SB.y + 0.2 * t, SB.z + bz + 0.2))
        a = math.radians(adeg)
        up = math.radians(updeg)
        d = Vector((math.cos(a) * math.cos(up), math.sin(a) * math.cos(up), math.sin(up)))
        mid = base + d * blen * 0.6
        tip = mid + (d + Vector((0, 0, 0.35))).normalized() * blen * 0.45
        parts.append(tube(coll, f"{name}_br{bi}a", base, mid, 0.09, 0.055,
                          "Wood_Bleached", segs=9))
        parts.append(tube(coll, f"{name}_br{bi}b", mid, tip, 0.055, 0.012,
                          "Wood_Bleached", segs=8))
        perches.append((mid + (tip - mid) * 0.35, a))
        # twigs
        for twi in range(2):
            twd = Vector((math.cos(a + 1.2 - twi * 2.1),
                          math.sin(a + 1.2 - twi * 2.1), 0.9)).normalized()
            src = mid if twi == 0 else base + (mid - base) * 0.5
            parts.append(tube(coll, f"{name}_tw{bi}_{twi}", src,
                              src + twd * (0.5 - 0.15 * twi), 0.028, 0.006,
                              "Wood_Bleached", segs=6))
    # abandoned crow nest wedged where branch 2 meets the trunk
    nb = perches[1][0] + Vector((-0.35, 0.05, -0.02))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.20, minor_radius=0.065,
                                     major_segments=18, minor_segments=8,
                                     location=(nb.x, nb.y, nb.z + 0.03),
                                     rotation=(0.12, 0.1, 0))
    nest = bpy.context.active_object
    nest.name = name + "_nest"
    link_only(nest, coll)
    nest.data.materials.append(mat("Wood_Dark"))
    displace_noise(nest, strength=0.05, scale=0.25, seed=99)
    apply_modifiers(nest)
    parts.append(nest)
    nrng = random.Random(5)
    for si in range(7):
        aa = nrng.uniform(0, math.tau)
        p0 = nb + Vector((math.cos(aa) * 0.24, math.sin(aa) * 0.24, 0.05))
        p1 = nb + Vector((math.cos(aa) * -0.15, math.sin(aa) * -0.15,
                          0.02 + nrng.uniform(0, 0.05)))
        parts.append(tube(coll, f"{name}_nstick{si}", p0, p1, 0.012, 0.008,
                          "Wood_Mid", segs=5))

    # ── the crows: 6 on the snag, 1 on the rail, 1 mid-hop (above) ──
    for ci, (p, a) in enumerate(perches[:6]):
        yaw = a + brng.uniform(-0.7, 0.7) + math.pi  # mostly facing outward
        parts += crow(coll, f"{name}_crow{ci}", (p.x, p.y, p.z + 0.045), yaw,
                      wings_up=(ci == 4), s=brng.uniform(0.85, 1.1))
    ra = math.radians(210)
    parts += crow(coll, name + "_crowR",
                  (math.cos(ra) * (PR - 0.07), math.sin(ra) * (PR - 0.07), ZP + RH + 0.03),
                  math.radians(255), s=1.0)

    # guano streaks on branches, rail and deck edge (the crows STAYED)
    grng = random.Random(33)
    for gi, (p, a) in enumerate(perches[:5]):
        gd = bm_cylinder(0.055, 0.055, 0.012, segs=9)
        for v in gd.verts:
            v.co.x *= grng.uniform(0.7, 1.5)
        placed(gd, (p.x + grng.uniform(-0.04, 0.04), p.y, p.z + 0.005),
               rz=grng.uniform(0, math.tau))
        parts.append(obj_from_bmesh(f"{name}_guano{gi}", gd, coll, mat("Bone")))
    for gi in range(4):
        aa = grng.uniform(0, math.tau)
        gd = bm_cylinder(0.05, 0.05, 0.012, segs=9)
        for v in gd.verts:
            v.co.y *= grng.uniform(0.7, 1.6)
        placed(gd, (math.cos(aa) * (PR - 0.25), math.sin(aa) * (PR - 0.25),
                    ZP + 0.008), rz=aa)
        parts.append(obj_from_bmesh(f"{name}_guanoD{gi}", gd, coll, mat("Bone")))
    # rope coil left on the deck
    for ci in range(3):
        bpy.ops.mesh.primitive_torus_add(major_radius=0.13 - ci * 0.008,
                                         minor_radius=0.022,
                                         major_segments=18, minor_segments=8,
                                         location=(0.72, 0.55, ZP + 0.03 + ci * 0.036),
                                         rotation=(0, 0, ci * 0.8))
        coil = bpy.context.active_object
        coil.name = f"{name}_coil{ci}"
        link_only(coil, coll)
        coil.data.materials.append(mat("Rope"))
        for pl in coil.data.polygons:
            pl.use_smooth = True
        parts.append(coil)

    # ── ground clutter: fallen plank + old bucket ──
    # fallen bleached branches at the snag's foot
    frng = random.Random(41)
    for fi in range(3):
        aa = frng.uniform(0, math.tau)
        p0 = (SB.x + math.cos(aa) * 0.7, SB.y + math.sin(aa) * 0.7, 0.06)
        p1 = (p0[0] + math.cos(aa) * frng.uniform(0.9, 1.5),
              p0[1] + math.sin(aa) * frng.uniform(0.9, 1.4), 0.03)
        parts.append(tube(coll, f"{name}_fbr{fi}", p0, p1, 0.055, 0.015,
                          "Wood_Bleached", segs=8))
    fp = bm_box(0.24, 1.7, 0.05)
    bm_bevel(fp, 0.012)
    placed(fp, (-1.6, -1.0, 0.03), rz=0.7)
    parts.append(obj_from_bmesh(name + "_fplank", fp, coll, mat("Wood_Bleached")))
    bk = bm_cylinder(0.16, 0.13, 0.26, segs=12, cap=True)
    placed(bk, (1.2, -1.7, 0.10), rx=1.35, rz=0.5)
    parts.append(obj_from_bmesh(name + "_bucket", bk, coll, mat("Wood_Dark")))
    bkb = bm_cylinder(0.165, 0.165, 0.03, segs=12, cap=False)
    o = obj_from_bmesh(name + "_bkband", bkb, coll, mat("Metal_Iron"), smooth=True)
    o.location = (1.2, -1.7, 0.10)
    o.rotation_euler = (1.35, 0, 0.5)
    s = o.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = 0.012
    apply_modifiers(o)
    parts.append(o)

    # ── finalize ──
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    join(parts, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR)
    print(f"built {name}")


build_crowroost()
print("CROWROOST DONE")
