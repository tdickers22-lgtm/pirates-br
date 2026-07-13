# WIDOW MEMORIAL — Widow's Watch hero story scene: "the kept flame".
# A ruined stone cottage (one gable + chimney standing, collapsed charred roof
# beams, doorway intact) with a chair inside facing the sea and a spyglass on
# the window sill. Beside it a stone cairn topped by a carved cloaked-woman
# figure (2.2 m) gazing seaward, holding a raised lantern with warm emissive
# glass (reads from the sea at night); engraved plinth, bench, dead rose brush.
# The figure faces Blender -Y (seaward). Origin at ground center.
# Headless: Blender -b -P scripts/blender/build_scene_widow.py
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
    "Stone_Fort":  ((0.46, 0.44, 0.41, 1.0), 0.93, 0.0),
    "Stone_Dark":  ((0.29, 0.28, 0.27, 1.0), 0.9, 0.0),
}
for _n, _v in EXTRA.items():
    PALETTE.setdefault(_n, _v)

rng = random.Random(19)


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


def bm_bevel(bm, width=0.02, segments=1):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=segments, profile=0.72, affect='EDGES',
                    clamp_overlap=True)
    return bm


def seg_between(coll, name, p1, p2, r1, r2, material, segs=6, smooth=True):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, max(0.01, d.length), segs=segs)
    q = d.to_track_quat('Z', 'Y')
    xform(bm, Matrix.Translation((p1 + p2) / 2) @ q.to_matrix().to_4x4())
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def stone_block(coll, name, w, d, h, m, material):
    bm = bm_bevel(bm_box(w * rng.uniform(0.92, 1.08), d, h * rng.uniform(0.92, 1.05)),
                  min(w, h) * 0.16, segments=2)
    xform(bm, m @ RZ(rng.uniform(-0.03, 0.03)) @ RX(rng.uniform(-0.02, 0.02)))
    return obj_from_bmesh(name, bm, coll, material)


# ── masonry wall builder ─────────────────────────────────────
def stone_wall(coll, tag, p0, p1, hfun, parts, door=None, window=None,
               block_w=0.48, block_h=0.26, thick=0.34):
    """Wall of jittered stone courses from p0 to p1 (xy). hfun(t)->height.
    door=(t0,t1,htop) leaves a full-height gap below htop with lintel.
    window=(t0,t1,z0,z1) leaves a hole; sill handled by caller."""
    p0, p1 = Vector((p0[0], p0[1], 0)), Vector((p1[0], p1[1], 0))
    d = p1 - p0
    L = d.length
    dn = d / L
    yaw = math.atan2(dn.y, dn.x)
    n_courses = int(3.6 / block_h) + 4
    idx = 0
    for c in range(n_courses):
        z = c * block_h + block_h / 2
        off = (c % 2) * block_w / 2
        x = off
        while x < L:
            bw = min(block_w * rng.uniform(0.7, 1.15), L - x)
            t = (x + bw / 2) / L
            hmax = hfun(t)
            if z - block_h / 2 >= hmax:
                x += bw + 0.012
                continue
            # openings
            if door and door[0] < t < door[1] and z < door[2]:
                x += bw + 0.012
                continue
            if window and window[0] < t < window[1] and window[2] < z < window[3]:
                x += bw + 0.012
                continue
            bh = min(block_h, hmax - (z - block_h / 2)) * 0.94
            pos = p0 + dn * (x + bw / 2)
            m = T(pos.x, pos.y, z - block_h / 2 + bh / 2) @ RZ(yaw)
            parts.append(stone_block(coll, f"{tag}_b{idx}", bw * 0.96, thick, bh, m,
                                     mat("Stone_Fort" if rng.random() < 0.8
                                         else "Stone_Dark")))
            idx += 1
            x += bw + 0.012


def build():
    clear_default_scene()
    name = "widow_memorial"
    coll = asset_collection(name)
    parts = []

    # ════ RUINED COTTAGE (center offset -X, door/sea side = -Y) ════
    CX, CY = -1.7, 0.55            # cottage center
    hw, hd = 2.2, 1.75             # half width (x), half depth (y)
    WALL_H = 2.6
    c0 = (CX - hw, CY - hd)        # front-left corner
    c1 = (CX + hw, CY - hd)        # front-right (gable side = +X)
    c2 = (CX + hw, CY + hd)
    c3 = (CX - hw, CY + hd)

    # front wall (-Y, faces sea): doorway intact w/ lintel, window with sill
    def h_front(t):
        if t < 0.30:
            return 1.15 + t * 1.2          # broken, rising toward door
        return WALL_H - (0.25 if t < 0.55 else 0.0) * 0
    stone_wall(coll, "wfront", c0, c1, h_front, parts,
               door=(0.38, 0.62, 2.28), window=(0.72, 0.90, 1.05, 1.75))
    # door lintel
    lin = bm_bevel(bm_box(1.35, 0.38, 0.24), 0.03)
    xform(lin, T(CX, CY - hd, 2.42))
    parts.append(obj_from_bmesh("lintel", lin, coll, mat("Stone_Dark")))
    # window sill board + spyglass
    sill = bm_bevel(bm_box(0.95, 0.46, 0.07), 0.015)
    xform(sill, T(CX + hw * 0.62, CY - hd, 1.03))
    parts.append(obj_from_bmesh("sill", sill, coll, mat("Wood_Bleached")))
    for r1, r2, ln, dz in ((0.045, 0.038, 0.30, 0.0), (0.036, 0.033, 0.22, 0.0)):
        pass
    sg1 = bm_cylinder(0.042, 0.042, 0.30, segs=10)
    xform(sg1, T(CX + hw * 0.62 - 0.10, CY - hd - 0.02, 1.115) @
          RY(math.radians(90)) @ RZ(0.25))
    parts.append(obj_from_bmesh("spyglass1", sg1, coll, mat("Metal_Iron"),
                                smooth=True))
    sg2 = bm_cylinder(0.033, 0.030, 0.24, segs=10)
    xform(sg2, T(CX + hw * 0.62 + 0.15, CY - hd - 0.045, 1.115) @
          RY(math.radians(90)) @ RZ(0.25))
    parts.append(obj_from_bmesh("spyglass2", sg2, coll, mat("Metal_Iron"),
                                smooth=True))
    # window lintel
    wlin = bm_bevel(bm_box(0.95, 0.38, 0.18), 0.025)
    xform(wlin, T(CX + hw * 0.62, CY - hd, 1.86))
    parts.append(obj_from_bmesh("wlintel", wlin, coll, mat("Stone_Dark")))

    # gable wall (+X side): full height rising to a peak
    def h_gable(t):
        return WALL_H + (1.15 * (1 - abs(t - 0.5) * 2))
    stone_wall(coll, "wgable", c1, c2, h_gable, parts)
    # chimney on the gable ridge (seated into the wall top)
    for i in range(9):
        m = T(CX + hw, CY + hd * 0.45, 2.95 + i * 0.29)
        parts.append(stone_block(coll, f"chim{i}", 0.62, 0.55, 0.28, m,
                                 mat("Stone_Fort" if i % 3 else "Stone_Dark")))
    cap = bm_bevel(bm_box(0.78, 0.70, 0.12), 0.03)
    xform(cap, T(CX + hw, CY + hd * 0.45, 5.53))
    parts.append(obj_from_bmesh("chimcap", cap, coll, mat("Stone_Dark")))

    # back wall: broken low
    stone_wall(coll, "wback", c2, c3,
               lambda t: 0.85 + 0.75 * math.sin(t * 9.7) ** 2 * 0.5, parts)
    # left wall (-X): broken mid, sloping down from front
    stone_wall(coll, "wleft", c3, c0,
               lambda t: 0.7 + 1.1 * t * (0.5 + 0.5 * math.sin(t * 7)), parts)

    # collapsed charred roof beams
    beam_data = [
        # (x0,y0,z0) -> (x1,y1,z1), r
        ((CX + hw - 0.45, CY - hd + 0.5, 3.15), (CX - 0.9, CY - 0.3, 0.35), 0.075),
        ((CX + hw - 0.45, CY + hd * 0.4, 3.2), (CX - 0.4, CY + 0.9, 0.4), 0.08),
        ((CX - 0.2, CY - hd + 0.4, 2.3), (CX - 1.6, CY + 0.8, 0.25), 0.07),
        ((CX + 0.6, CY + hd - 0.5, 0.42), (CX - 1.2, CY - hd + 0.7, 0.2), 0.075),
    ]
    for i, (a, b, r) in enumerate(beam_data):
        o = seg_between(coll, f"beam{i}", a, b, r, r * 0.85, mat("Char_Black"),
                        segs=7, smooth=False)
        displace_noise(o, strength=0.03, scale=0.35, seed=300 + i)
        apply_modifiers(o)
        parts.append(o)
    # one cracked beam: two segments at a kink
    k = (CX + 0.2, CY + 0.1, 0.9)
    o = seg_between(coll, "beam_k1", (CX + hw - 0.2, CY - 0.4, 2.9), k,
                    0.08, 0.07, mat("Char_Black"), segs=7, smooth=False)
    parts.append(o)
    o = seg_between(coll, "beam_k2", k, (CX - 1.3, CY + 0.4, 0.15),
                    0.07, 0.06, mat("Char_Black"), segs=7, smooth=False)
    parts.append(o)
    # fallen wall stones scattered around the broken walls
    for i in range(14):
        side = rng.random()
        if side < 0.4:      # off the back wall
            fx, fy = CX + rng.uniform(-hw, hw), CY + hd + rng.uniform(0.3, 1.0)
        elif side < 0.7:    # off the left wall
            fx, fy = CX - hw - rng.uniform(0.3, 0.9), CY + rng.uniform(-hd, hd)
        else:               # inside the shell
            fx, fy = CX + rng.uniform(-1.2, 1.2), CY + rng.uniform(-0.8, 1.0)
        m = T(fx, fy, 0.10) @ RZ(rng.uniform(0, 3)) @ RX(rng.uniform(-0.4, 0.4))
        parts.append(stone_block(coll, f"fall{i}", 0.42, 0.3, 0.22, m,
                                 mat("Stone_Fort" if rng.random() < 0.7
                                     else "Stone_Dark")))
    # charred debris chunks on the floor
    for i in range(6):
        db = bm_bevel(bm_box(rng.uniform(0.18, 0.4), rng.uniform(0.12, 0.25),
                             rng.uniform(0.08, 0.16)), 0.02)
        xform(db, T(CX + rng.uniform(-1.4, 1.4), CY + rng.uniform(-1.0, 1.2),
                    0.06) @ RZ(rng.uniform(0, 3)))
        parts.append(obj_from_bmesh(f"debris{i}", db, coll, mat("Char_Black")))

    # the chair — inside, facing the sea through the doorway
    chx, chy = CX + 0.15, CY + 0.35
    W = mat("Wood_Bleached")
    seat = bm_bevel(bm_box(0.42, 0.4, 0.05), 0.012)
    xform(seat, T(chx, chy, 0.45) @ RZ(0.08))
    parts.append(obj_from_bmesh("chair_seat", seat, coll, W))
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        leg = bm_box(0.045, 0.045, 0.45)
        xform(leg, T(chx + sx * 0.17, chy + sy * 0.16, 0.225) @ RZ(0.08))
        parts.append(obj_from_bmesh(f"chair_leg{i}", leg, coll, mat("Wood_Dark")))
    back = bm_bevel(bm_box(0.42, 0.05, 0.55), 0.012)
    xform(back, T(chx, chy + 0.19, 0.75) @ RZ(0.08) @ RX(math.radians(-6)))
    parts.append(obj_from_bmesh("chair_back", back, coll, W))
    for i in range(2):
        sl = bm_box(0.42, 0.04, 0.05)
        xform(sl, T(chx, chy + 0.17, 0.56 + i * 0.14) @ RZ(0.08))
        parts.append(obj_from_bmesh(f"chair_slat{i}", sl, coll, mat("Wood_Dark")))

    # ════ THE MEMORIAL (offset +X toward the cliff, faces -Y seaward) ════
    MX, MY = 2.3, -0.9

    # cairn of heaped stones
    for i in range(22):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.1, 0.85)
        sr = rng.uniform(0.16, 0.34) * (1.15 - rr / 1.4)
        st = bm_icosphere(sr, 3)
        bmesh.ops.scale(st, vec=Vector((rng.uniform(0.85, 1.3),
                                        rng.uniform(0.85, 1.3),
                                        rng.uniform(0.55, 0.8))), verts=st.verts)
        xform(st, T(MX + math.cos(a) * rr, MY + math.sin(a) * rr,
                    max(0.0, (0.75 - rr) * rng.uniform(0.2, 0.55))) @
              RZ(rng.uniform(0, math.tau)))
        o = obj_from_bmesh(f"mcairn{i}", st, coll,
                           mat("Stone_Fort" if rng.random() < 0.7 else "Stone_Dark"),
                           smooth=True)
        displace_noise(o, strength=sr * 0.4, scale=sr * 1.5, seed=400 + i)
        apply_modifiers(o)
        parts.append(o)

    # engraved plinth on the cairn
    pl = bm_bevel(bm_box(0.85, 0.85, 0.42), 0.045)
    xform(pl, T(MX, MY, 0.62))
    parts.append(obj_from_bmesh("plinth", pl, coll, mat("Stone_Fort")))
    plaque = bm_bevel(bm_box(0.6, 0.05, 0.28), 0.012)
    xform(plaque, T(MX, MY - 0.43, 0.62))
    parts.append(obj_from_bmesh("plaque", plaque, coll, mat("Stone_Dark")))
    for i in range(3):  # engraving lines
        ln = bm_box(0.44 - i * 0.09, 0.02, 0.025)
        xform(ln, T(MX + (i % 2) * 0.03, MY - 0.465, 0.70 - i * 0.08))
        parts.append(obj_from_bmesh(f"engrave{i}", ln, coll, mat("Stone_Fort")))

    # ── the cloaked figure (2.2 m), gazing seaward (-Y) ──
    FZ = 0.83                       # stands on the plinth
    G = T(MX, MY, FZ)
    # cloak: tapered cone w/ vertical folds, slight seaward lean
    bm = bm_cylinder(0.44, 0.15, 1.62, segs=20)
    for v in bm.verts:
        ang = math.atan2(v.co.y, v.co.x)
        f = 1.0 + 0.09 * math.sin(ang * 6 + 0.6) + 0.04 * math.sin(ang * 11)
        v.co.x *= f
        v.co.y *= f
        # hem flare
        if v.co.z < -0.6:
            v.co.x *= 1.12
            v.co.y *= 1.12
    xform(bm, G @ T(0, 0, 0.81) @ RX(math.radians(-4)))
    cloak = obj_from_bmesh("cloak", bm, coll, mat("Rock_Grey"), smooth=True)
    parts.append(cloak)
    # shoulders
    sh = bm_icosphere(0.26, 3)
    bmesh.ops.scale(sh, vec=Vector((1.15, 0.85, 0.75)), verts=sh.verts)
    xform(sh, G @ T(0, 0.02, 1.58))
    parts.append(obj_from_bmesh("shoulders", sh, coll, mat("Rock_Grey"),
                                smooth=True))
    # hood + shadowed face cavity
    hood = bm_icosphere(0.17, 3)
    bmesh.ops.scale(hood, vec=Vector((1.0, 1.12, 1.18)), verts=hood.verts)
    xform(hood, G @ T(0, 0.02, 1.86) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh("hood", hood, coll, mat("Rock_Grey"),
                                smooth=True))
    fc = bm_icosphere(0.105, 2)
    bmesh.ops.scale(fc, vec=Vector((0.85, 0.6, 1.0)), verts=fc.verts)
    xform(fc, G @ T(0, -0.09, 1.84) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh("face_shadow", fc, coll, mat("Stone_Dark"),
                                smooth=True))
    # raised right arm holding the lantern high, seaward
    shp = G @ Vector((0.24, -0.02, 1.56))
    elp = G @ Vector((0.38, -0.22, 1.78))
    hnp = G @ Vector((0.30, -0.38, 2.06))
    parts.append(seg_between(coll, "arm_u", shp, elp, 0.085, 0.07,
                             mat("Rock_Grey"), segs=9))
    parts.append(seg_between(coll, "arm_f", elp, hnp, 0.07, 0.055,
                             mat("Rock_Grey"), segs=9))
    hb = bm_icosphere(0.06, 2)
    xform(hb, Matrix.Translation(hnp))
    parts.append(obj_from_bmesh("hand", hb, coll, mat("Rock_Grey"), smooth=True))
    # left arm folded against the cloak
    parts.append(seg_between(coll, "arm_l", G @ Vector((-0.24, -0.02, 1.54)),
                             G @ Vector((-0.12, -0.26, 1.22)), 0.08, 0.06,
                             mat("Rock_Grey"), segs=9))

    # ── the lantern (focal): warm emissive glass, strength 3 ──
    LP = hnp + Vector((0, -0.02, 0.10))   # lantern hangs just above the hand
    lb = bm_cylinder(0.085, 0.10, 0.035, segs=10)
    xform(lb, Matrix.Translation(LP + Vector((0, 0, -0.12))))
    parts.append(obj_from_bmesh("lant_base", lb, coll, mat("Metal_Iron"),
                                smooth=True))
    glass = bm_cylinder(0.068, 0.055, 0.17, segs=12)
    xform(glass, Matrix.Translation(LP + Vector((0, 0, -0.02))))
    parts.append(obj_from_bmesh("lant_glass", glass, coll, mat("Lantern_Glass"),
                                smooth=True))
    for i in range(4):
        a = i * math.tau / 4 + 0.4
        post = bm_box(0.016, 0.016, 0.19)
        xform(post, Matrix.Translation(LP + Vector((math.cos(a) * 0.075,
                                                    math.sin(a) * 0.075, -0.02))))
        parts.append(obj_from_bmesh(f"lant_post{i}", post, coll,
                                    mat("Metal_Iron")))
    top = bm_cylinder(0.105, 0.025, 0.075, segs=10)
    xform(top, Matrix.Translation(LP + Vector((0, 0, 0.10))))
    parts.append(obj_from_bmesh("lant_top", top, coll, mat("Metal_Iron"),
                                smooth=True))
    ring = bm_cylinder(0.035, 0.035, 0.02, segs=8, cap=False)
    xform(ring, Matrix.Translation(LP + Vector((0, 0, 0.16))) @
          RX(math.radians(90)))
    parts.append(obj_from_bmesh("lant_ring", ring, coll, mat("Metal_Iron"),
                                smooth=True))

    # ── bench facing the sea ──
    BX, BY = 4.1, 0.3
    bseat = bm_bevel(bm_box(1.5, 0.42, 0.09), 0.02)
    xform(bseat, T(BX, BY, 0.46) @ RZ(-0.18))
    parts.append(obj_from_bmesh("bench_seat", bseat, coll, mat("Wood_Bleached")))
    for sx in (-1, 1):
        blk = stone_block(coll, f"bench_leg{sx}", 0.34, 0.4, 0.42,
                          T(BX + sx * 0.55, BY + sx * -0.10, 0.21) @ RZ(-0.18),
                          mat("Stone_Dark"))
        parts.append(blk)

    # ── dead rose brush (dry twigs) beside the cairn ──
    RBX, RBY = 1.15, -1.9
    for i in range(16):
        a = rng.uniform(0, math.tau)
        tilt = rng.uniform(0.25, 0.95)
        ln = rng.uniform(0.3, 0.62)
        p1 = Vector((RBX + rng.uniform(-0.1, 0.1), RBY + rng.uniform(-0.1, 0.1),
                     0.0))
        d = Vector((math.cos(a) * math.sin(tilt), math.sin(a) * math.sin(tilt),
                    math.cos(tilt)))
        p2 = p1 + d * ln
        parts.append(seg_between(coll, f"twig{i}", p1, p2, 0.014, 0.006,
                                 mat("Wood_Dark"), segs=5))
        if i % 3 == 0:  # forked tip
            d2 = (d + Vector((rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6),
                              0.2))).normalized()
            parts.append(seg_between(coll, f"twigf{i}", p2, p2 + d2 * ln * 0.45,
                                     0.007, 0.004, mat("Wood_Dark"), segs=5))

    all_objs = [o for o in coll.objects if o.type == 'MESH']
    join(all_objs, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")


build()
print("WIDOW DONE")
