# WIDOW MEMORIAL — Widow's Watch hero story scene: "the kept flame".
#
# 2026-07 fidelity pass 2 (audit: "reads as uniform white lego bricks,
# monochrome"). What changed:
#   * masonry is now hand-dressed rough_block_bm stone (corner jitter, dressed
#     outer face, knocked corners) over a DARK MORTAR CORE slab, so the joints
#     read as recessed shadow instead of toy-brick seams;
#   * AgX-compensated palette (agx_palette) + tint_pass: per-block tonal
#     variance, warm/cool stone hues, moss on up-faces, damp band at the base;
#   * added silhouette: a wrought LANTERN POST (her nightly light, verdigris +
#     emissive glass), wind-worn plank shutter + storm-fence boards, fallen
#     roof slates, a chisel-faceted carved widow instead of a smooth cone.
# Layout is unchanged so the footprint/bbox stays inside 10% of the shipped
# GLB (9.71 x 5.71 x 5.64 in glTF x,y-up,z).
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
exec(open(os.path.join(HERE, "_detail.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

rng = random.Random(19)


def stone_block(coll, name, w, d, h, m, material, jitter=0.07):
    bm = rough_block_bm(w * rng.uniform(0.92, 1.08), d,
                        h * rng.uniform(0.9, 1.06), rng, jitter=jitter)
    xform(bm, m @ RZ(rng.uniform(-0.04, 0.04)) @ RX(rng.uniform(-0.03, 0.03)))
    return obj_from_bmesh(name, bm, coll, material)


def stone_wall(coll, tag, p0, p1, hfun, parts, door=None, window=None,
               block_w=0.46, block_h=0.25, thick=0.34, mortar=True):
    """Wall of jittered stone courses from p0 to p1 (xy). hfun(t)->height.
    A dark mortar core slab sits just inside the block skin so every joint
    reads as a shadow line rather than a gap."""
    p0, p1 = Vector((p0[0], p0[1], 0)), Vector((p1[0], p1[1], 0))
    d = p1 - p0
    L = d.length
    dn = d / L
    yaw = math.atan2(dn.y, dn.x)
    if mortar:
        nseg = 7
        for i in range(nseg):
            t0, t1 = i / nseg, (i + 1) / nseg
            tm = (t0 + t1) / 2
            hh = hfun(tm) - 0.06
            if door and door[0] - 0.04 < tm < door[1] + 0.04:
                hh = 0.0
            if window and window[0] - 0.03 < tm < window[1] + 0.03:
                hh = min(hh, window[2])
            if hh <= 0.08:
                continue
            core = bm_box(L / nseg * 1.02, thick * 0.62, hh)
            pos = p0 + dn * (L * tm)
            xform(core, T(pos.x, pos.y, hh / 2) @ RZ(yaw))
            parts.append(obj_from_bmesh(f"{tag}_core{i}", core, coll,
                                        mat("Stone_Dark")))
    n_courses = int(4.2 / block_h) + 4
    idx = 0
    for c in range(n_courses):
        z = c * block_h + block_h / 2
        off = (c % 2) * block_w / 2
        x = off
        while x < L:
            bw = min(block_w * rng.uniform(0.65, 1.2), L - x)
            t = (x + bw / 2) / L
            hmax = hfun(t)
            if z - block_h / 2 >= hmax:
                x += bw + 0.016
                continue
            if door and door[0] < t < door[1] and z < door[2]:
                x += bw + 0.016
                continue
            if window and window[0] < t < window[1] and window[2] < z < window[3]:
                x += bw + 0.016
                continue
            bh = min(block_h, hmax - (z - block_h / 2)) * 0.92
            pos = p0 + dn * (x + bw / 2)
            prot = rng.uniform(-0.02, 0.035)   # blocks sit proud / recessed
            m = (T(pos.x - math.sin(yaw) * prot, pos.y + math.cos(yaw) * prot,
                   z - block_h / 2 + bh / 2) @ RZ(yaw))
            parts.append(stone_block(coll, f"{tag}_b{idx}", bw * 0.95, thick, bh,
                                     m, mat("Stone_Fort" if rng.random() < 0.72
                                            else "Stone_Dark")))
            idx += 1
            x += bw + 0.016


def lantern_head(coll, name, LP, parts, lit=True, scale=1.0):
    """Wrought lantern: verdigris frame, 4 corner posts, warm glass, hang ring."""
    s = scale
    LP = Vector(LP)
    lb = bm_cylinder(0.085 * s, 0.10 * s, 0.035 * s, segs=10)
    xform(lb, Matrix.Translation(LP + Vector((0, 0, -0.12 * s))))
    parts.append(obj_from_bmesh(name + "_base", lb, coll, mat("Verdigris"),
                                smooth=True))
    glass = bm_cylinder(0.068 * s, 0.055 * s, 0.17 * s, segs=12)
    xform(glass, Matrix.Translation(LP + Vector((0, 0, -0.02 * s))))
    parts.append(obj_from_bmesh(name + "_glass", glass, coll,
                                mat("Lantern_Glass" if lit else "Glass_Dead"),
                                smooth=True))
    for i in range(4):
        a = i * math.tau / 4 + 0.4
        post = bm_box(0.016 * s, 0.016 * s, 0.19 * s)
        xform(post, Matrix.Translation(LP + Vector((math.cos(a) * 0.075 * s,
                                                    math.sin(a) * 0.075 * s,
                                                    -0.02 * s))))
        parts.append(obj_from_bmesh(f"{name}_post{i}", post, coll,
                                    mat("Verdigris")))
    top = bm_cylinder(0.105 * s, 0.025 * s, 0.075 * s, segs=10)
    xform(top, Matrix.Translation(LP + Vector((0, 0, 0.10 * s))))
    parts.append(obj_from_bmesh(name + "_top", top, coll, mat("Verdigris"),
                                smooth=True))
    ring = bm_torus(0.035 * s, 0.011 * s, segs=10, rings=5)
    xform(ring, Matrix.Translation(LP + Vector((0, 0, 0.16 * s))) @
          RX(math.radians(90)))
    parts.append(obj_from_bmesh(name + "_ring", ring, coll, mat("Verdigris"),
                                smooth=True))


def build():
    clear_default_scene()
    agx_palette({
        "Slate":      ((0.105, 0.108, 0.125, 1.0), 0.88, 0.0),
        "Glass_Dead": ((0.140, 0.150, 0.150, 1.0), 0.35, 0.0),
        # AUDIT: "uniform white lego bricks, MONOCHROME". The ruin now reads as
        # stone, but the widow was carved from the same Stone_Fort as the walls
        # she stands in front of, so she had no figure/ground separation. She
        # gets her own darker, warmer, sea-weathered stone.
        "Stone_Statue": ((0.176, 0.152, 0.126, 1.0), 0.90, 0.0),
    })
    emissive("Lantern_Glass", (1.0, 0.72, 0.30, 1.0), 4.0)
    name = "widow_memorial"
    coll = asset_collection(name)
    parts = []

    # ════ RUINED COTTAGE (center offset -X, door/sea side = -Y) ════
    CX, CY = -1.7, 0.55
    hw, hd = 2.2, 1.75
    WALL_H = 2.6
    c0 = (CX - hw, CY - hd)
    c1 = (CX + hw, CY - hd)
    c2 = (CX + hw, CY + hd)
    c3 = (CX - hw, CY + hd)

    def h_front(t):
        if t < 0.30:
            return 1.15 + t * 1.2
        return WALL_H
    stone_wall(coll, "wfront", c0, c1, h_front, parts,
               door=(0.38, 0.62, 2.28), window=(0.72, 0.90, 1.05, 1.75))
    lin = bm_bevel(bm_box(1.35, 0.38, 0.24), 0.035, 2)
    xform(lin, T(CX, CY - hd, 2.42) @ RZ(0.015))
    parts.append(obj_from_bmesh("lintel", lin, coll, mat("Stone_Dark")))
    thr = bm_bevel(bm_box(1.25, 0.5, 0.10), 0.02, 2)
    xform(thr, T(CX, CY - hd - 0.06, 0.05))
    parts.append(obj_from_bmesh("threshold", thr, coll, mat("Stone_Fort")))
    sill = bm_bevel(bm_box(0.95, 0.46, 0.07), 0.015, 2)
    xform(sill, T(CX + hw * 0.62, CY - hd, 1.03))
    parts.append(obj_from_bmesh("sill", sill, coll, mat("Wood_Bleached")))
    sg1 = bm_cylinder(0.042, 0.042, 0.30, segs=10)
    xform(sg1, T(CX + hw * 0.62 - 0.10, CY - hd - 0.02, 1.115) @
          RY(math.radians(90)) @ RZ(0.25))
    parts.append(obj_from_bmesh("spyglass1", sg1, coll, mat("Metal_Band"),
                                smooth=True))
    sg2 = bm_cylinder(0.033, 0.030, 0.24, segs=10)
    xform(sg2, T(CX + hw * 0.62 + 0.15, CY - hd - 0.045, 1.115) @
          RY(math.radians(90)) @ RZ(0.25))
    parts.append(obj_from_bmesh("spyglass2", sg2, coll, mat("Verdigris"),
                                smooth=True))
    wlin = bm_bevel(bm_box(0.95, 0.38, 0.18), 0.025, 2)
    xform(wlin, T(CX + hw * 0.62, CY - hd, 1.86))
    parts.append(obj_from_bmesh("wlintel", wlin, coll, mat("Stone_Dark")))
    # wind-worn boards nailed across the window (one already gone)
    for i, (dz, ang, w) in enumerate(((0.18, 0.06, 0.98), (0.52, -0.09, 0.92),
                                      (0.98, 0.14, 0.62))):
        bm = bm_box(w, 0.055, 0.16)
        for v in bm.verts:                     # wind-worn: cupped + nicked
            f = v.co.x / (w / 2)
            v.co.y += 0.012 * (f * f - 0.4)
            v.co.z *= 1.0 - 0.10 * abs(f)
        bm_bevel(bm, 0.010, 1)
        xform(bm, T(CX + hw * 0.62 + (0.14 if i == 2 else 0.0),
                    CY - hd - 0.22, 1.10 + dz) @ RY(ang))
        parts.append(obj_from_bmesh(f"shutter{i}", bm, coll,
                                    mat("Wood_Bleached")))
        for sxn in (-1, 1):
            nb = bm_icosphere(0.017, 1)
            xform(nb, T(CX + hw * 0.62 + sxn * w * 0.42, CY - hd - 0.26,
                        1.10 + dz))
            parts.append(obj_from_bmesh(f"nail{i}{sxn}", nb, coll, mat("Rust"),
                                        smooth=True))

    def h_gable(t):
        return WALL_H + (1.15 * (1 - abs(t - 0.5) * 2))
    stone_wall(coll, "wgable", c1, c2, h_gable, parts)
    # chimney stack: paired blocks per course (alternating bond) + corbel flare
    for i in range(9):
        wfac = 1.18 if i in (0, 1) else 1.0          # corbelled base
        for sxc in (-1, 1):
            m = (T(CX + hw + i * 0.012 + sxc * 0.155 * wfac,
                   CY + hd * 0.45 + (0.07 if i % 2 else -0.07) * sxc,
                   2.95 + i * 0.29) @ RZ(rng.uniform(-0.05, 0.05)))
            parts.append(stone_block(coll, f"chim{i}{sxc}", 0.34 * wfac,
                                     0.56 * wfac, 0.27, m,
                                     mat("Stone_Fort" if (i + sxc) % 3
                                         else "Stone_Dark")))
    chcore = bm_box(0.34, 0.46, 2.62)
    xform(chcore, T(CX + hw + 0.05, CY + hd * 0.45, 4.10))
    parts.append(obj_from_bmesh("chimcore", chcore, coll, mat("Stone_Dark")))
    cap = bm_bevel(bm_box(0.80, 0.72, 0.13), 0.03, 2)
    xform(cap, T(CX + hw + 0.11, CY + hd * 0.45, 5.50) @ RY(math.radians(-3)))
    parts.append(obj_from_bmesh("chimcap", cap, coll, mat("Stone_Dark")))
    flue = bm_box(0.30, 0.28, 0.14)
    xform(flue, T(CX + hw + 0.10, CY + hd * 0.45, 5.47))
    parts.append(obj_from_bmesh("flue", flue, coll, mat("Char_Black")))

    stone_wall(coll, "wback", c2, c3,
               lambda t: 0.85 + 0.75 * math.sin(t * 9.7) ** 2 * 0.5, parts)
    stone_wall(coll, "wleft", c3, c0,
               lambda t: 0.7 + 1.1 * t * (0.5 + 0.5 * math.sin(t * 7)), parts)

    # collapsed charred roof beams
    beam_data = [
        ((CX + hw - 0.45, CY - hd + 0.5, 3.15), (CX - 0.9, CY - 0.3, 0.35), 0.075),
        ((CX + hw - 0.45, CY + hd * 0.4, 3.2), (CX - 0.4, CY + 0.9, 0.4), 0.08),
        ((CX - 0.2, CY - hd + 0.4, 2.3), (CX - 1.6, CY + 0.8, 0.25), 0.07),
        ((CX + 0.6, CY + hd - 0.5, 0.42), (CX - 1.2, CY - hd + 0.7, 0.2), 0.075),
    ]
    def burnt_beam(tag, a, b, r):
        """Sawn timber, charred on the fire-facing half — not a black straw."""
        a, b = Vector(a), Vector(b)
        parts.append(timber_between(coll, tag, a, b, r * 2.1, r * 1.9,
                                    mat("Wood_Dark"), bevel=r * 0.3,
                                    roll=rng.uniform(0, 1.0)))
        m = a.lerp(b, rng.uniform(0.35, 0.62))
        parts.append(timber_between(coll, tag + "_ch", a.lerp(m, 0.15), m,
                                    r * 2.2, r * 2.0, mat("Char_Black"),
                                    bevel=r * 0.3))
        # cracked/split end nub
        parts.append(timber_between(coll, tag + "_nub", b, b.lerp(a, 0.12),
                                    r * 1.2, r * 1.5, mat("Char_Black"),
                                    bevel=r * 0.2))

    for i, (a, b, r) in enumerate(beam_data):
        burnt_beam(f"beam{i}", a, b, r)
    k = (CX + 0.2, CY + 0.1, 0.9)
    burnt_beam("beam_k1", (CX + hw - 0.2, CY - 0.4, 2.9), k, 0.08)
    burnt_beam("beam_k2", k, (CX - 1.3, CY + 0.4, 0.15), 0.07)
    # surviving rafter stubs off the gable (silhouette teeth)
    for i in range(4):
        y = CY - hd + 0.55 + i * 0.85
        burnt_beam(f"rafter{i}", (CX + hw - 0.15, y, 3.30 - i * 0.06),
                   (CX + hw - 1.35, y + 0.10, 2.45 - i * 0.05), 0.062)
    # fallen roof slates
    for i in range(14):
        sx_ = CX + rng.uniform(-hw - 0.7, hw + 0.3)
        sy_ = CY + rng.uniform(-hd - 0.5, hd + 0.7)
        sl = bm_bevel(bm_box(rng.uniform(0.24, 0.4), rng.uniform(0.2, 0.32),
                             0.035), 0.008, 1)
        xform(sl, T(sx_, sy_, 0.03 + rng.uniform(0, 0.06)) @
              RZ(rng.uniform(0, 3)) @ RX(rng.uniform(-0.5, 0.5)) @
              RY(rng.uniform(-0.3, 0.3)))
        parts.append(obj_from_bmesh(f"slate{i}", sl, coll, mat("Slate")))
    # fallen wall stones
    for i in range(14):
        side = rng.random()
        if side < 0.4:
            fx, fy = CX + rng.uniform(-hw, hw), CY + hd + rng.uniform(0.3, 1.0)
        elif side < 0.7:
            fx, fy = CX - hw - rng.uniform(0.3, 0.9), CY + rng.uniform(-hd, hd)
        else:
            fx, fy = CX + rng.uniform(-1.2, 1.2), CY + rng.uniform(-0.8, 1.0)
        m = T(fx, fy, 0.10) @ RZ(rng.uniform(0, 3)) @ RX(rng.uniform(-0.4, 0.4))
        parts.append(stone_block(coll, f"fall{i}", 0.42, 0.3, 0.22, m,
                                 mat("Stone_Fort" if rng.random() < 0.7
                                     else "Stone_Dark"), jitter=0.12))
    for i in range(6):
        db = bm_bevel(bm_box(rng.uniform(0.18, 0.4), rng.uniform(0.12, 0.25),
                             rng.uniform(0.08, 0.16)), 0.02, 1)
        xform(db, T(CX + rng.uniform(-1.4, 1.4), CY + rng.uniform(-1.0, 1.2),
                    0.06) @ RZ(rng.uniform(0, 3)))
        parts.append(obj_from_bmesh(f"debris{i}", db, coll, mat("Char_Black")))

    # the chair — inside, facing the sea through the doorway
    chx, chy = CX + 0.15, CY + 0.35
    W = mat("Wood_Bleached")
    seat = bm_bevel(bm_box(0.42, 0.4, 0.05), 0.012, 2)
    xform(seat, T(chx, chy, 0.45) @ RZ(0.08))
    parts.append(obj_from_bmesh("chair_seat", seat, coll, W))
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        leg = bm_bevel(bm_box(0.045, 0.045, 0.45), 0.008, 1)
        xform(leg, T(chx + sx * 0.17, chy + sy * 0.16, 0.225) @ RZ(0.08))
        parts.append(obj_from_bmesh(f"chair_leg{i}", leg, coll, mat("Wood_Dark")))
    back = bm_bevel(bm_box(0.42, 0.05, 0.55), 0.012, 2)
    xform(back, T(chx, chy + 0.19, 0.75) @ RZ(0.08) @ RX(math.radians(-6)))
    parts.append(obj_from_bmesh("chair_back", back, coll, W))
    for i in range(2):
        sl = bm_box(0.42, 0.04, 0.05)
        xform(sl, T(chx, chy + 0.17, 0.56 + i * 0.14) @ RZ(0.08))
        parts.append(obj_from_bmesh(f"chair_slat{i}", sl, coll, mat("Wood_Dark")))

    # ════ THE MEMORIAL (offset +X toward the cliff, faces -Y seaward) ════
    MX, MY = 2.3, -0.9

    for i in range(22):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.1, 0.85)
        sr = rng.uniform(0.16, 0.34) * (1.15 - rr / 1.4)
        st = bm_icosphere(sr, 3)
        bmesh.ops.scale(st, vec=Vector((rng.uniform(0.85, 1.3),
                                        rng.uniform(0.85, 1.3),
                                        rng.uniform(0.55, 0.8))), verts=st.verts)
        carve_facets(st, sr, count=7, depth=(0.72, 0.94), seed=400 + i,
                     softness=0.01)
        xform(st, T(MX + math.cos(a) * rr, MY + math.sin(a) * rr,
                    max(0.0, (0.75 - rr) * rng.uniform(0.2, 0.55))) @
              RZ(rng.uniform(0, math.tau)))
        parts.append(obj_from_bmesh(f"mcairn{i}", st, coll,
                                    mat("Stone_Fort" if rng.random() < 0.65
                                        else "Stone_Dark"), smooth=False))

    pl = bm_bevel(bm_box(0.85, 0.85, 0.42), 0.05, 2)
    xform(pl, T(MX, MY, 0.62))
    parts.append(obj_from_bmesh("plinth", pl, coll, mat("Stone_Fort")))
    plaque = bm_bevel(bm_box(0.6, 0.05, 0.28), 0.012, 2)
    xform(plaque, T(MX, MY - 0.43, 0.62))
    parts.append(obj_from_bmesh("plaque", plaque, coll, mat("Stone_Dark")))
    for i in range(3):
        ln = bm_box(0.44 - i * 0.09, 0.02, 0.025)
        xform(ln, T(MX + (i % 2) * 0.03, MY - 0.465, 0.70 - i * 0.08))
        parts.append(obj_from_bmesh(f"engrave{i}", ln, coll, mat("Stone_Fort")))

    # ── the cloaked figure (2.2 m), CARVED (chisel facets), gazing seaward ──
    FZ = 0.83
    G = T(MX, MY, FZ)
    ST = mat("Stone_Statue")
    bm = bm_cylinder(0.44, 0.15, 1.62, segs=20)
    for v in bm.verts:
        ang = math.atan2(v.co.y, v.co.x)
        f = 1.0 + 0.11 * math.sin(ang * 6 + 0.6) + 0.05 * math.sin(ang * 11)
        v.co.x *= f
        v.co.y *= f
        if v.co.z < -0.6:
            v.co.x *= 1.14
            v.co.y *= 1.14
    for d, off in (((-0.9, -0.35, 0.1), 0.34), ((0.85, -0.45, 0.05), 0.33),
                   ((0.2, 0.95, 0.0), 0.36), ((-0.3, 0.9, 0.1), 0.35)):
        chisel(bm, d, off, softness=0.06)      # chiselled robe planes
    xform(bm, G @ T(0, 0, 0.81) @ RX(math.radians(-4)))
    parts.append(obj_from_bmesh("cloak", bm, coll, ST, smooth=False))
    # wind-caught cloak wing: breaks the cone silhouette from every angle
    wing = bmesh.new()
    prof = [(0.02, 1.42), (0.16, 1.30), (0.34, 1.02), (0.52, 0.68),
            (0.60, 0.28), (0.50, 0.02), (0.24, 0.00), (0.06, 0.30)]
    vs = [wing.verts.new((x, 0.0, z)) for x, z in prof]
    wing.faces.new(vs)
    for v in wing.verts:                      # billow away from the sea wind
        v.co.y = -0.10 - 0.34 * (v.co.x / 0.6) ** 1.5 + 0.06 * math.sin(v.co.z * 6)
    xform(wing, G @ T(-0.30, 0.06, 0.02) @ RZ(math.radians(24)))
    o = obj_from_bmesh("cloak_wing", wing, coll, ST, smooth=False)
    sm = o.modifiers.new("Sol", 'SOLIDIFY')
    sm.thickness = 0.055
    sm.offset = 0
    apply_modifiers(o)
    bevel_obj(o, width=0.014, segments=2)
    apply_modifiers(o)
    parts.append(o)
    sh = bm_icosphere(0.26, 3)
    bmesh.ops.scale(sh, vec=Vector((1.15, 0.85, 0.75)), verts=sh.verts)
    carve_facets(sh, 0.26, count=9, depth=(0.80, 0.95), seed=77, softness=0.02,
                 skip_dirs=((0, -1, 0),))
    xform(sh, G @ T(0, 0.02, 1.58))
    parts.append(obj_from_bmesh("shoulders", sh, coll, ST, smooth=False))
    hood = bm_icosphere(0.175, 3)
    bmesh.ops.scale(hood, vec=Vector((1.0, 1.12, 1.18)), verts=hood.verts)
    carve_facets(hood, 0.175, count=8, depth=(0.84, 0.97), seed=78,
                 softness=0.015, skip_dirs=((0, -1, 0),))
    xform(hood, G @ T(0, 0.02, 1.86) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh("hood", hood, coll, ST, smooth=False))
    brim = bm_torus(0.155, 0.032, segs=14, rings=6)
    xform(brim, G @ T(0, 0.0, 1.80) @ RX(math.radians(16)))
    parts.append(obj_from_bmesh("hood_brim", brim, coll, ST, smooth=True))
    fc = bm_icosphere(0.105, 2)
    bmesh.ops.scale(fc, vec=Vector((0.85, 0.6, 1.0)), verts=fc.verts)
    xform(fc, G @ T(0, -0.09, 1.84) @ RX(math.radians(-8)))
    parts.append(obj_from_bmesh("face_shadow", fc, coll, mat("Stone_Dark"),
                                smooth=True))
    shp = G @ Vector((0.24, -0.02, 1.56))
    elp = G @ Vector((0.38, -0.22, 1.78))
    hnp = G @ Vector((0.30, -0.38, 2.06))
    parts.append(seg_between(coll, "arm_u", shp, elp, 0.085, 0.07, ST, segs=9))
    parts.append(seg_between(coll, "arm_f", elp, hnp, 0.07, 0.055, ST, segs=9))
    hb = bm_icosphere(0.06, 2)
    xform(hb, Matrix.Translation(hnp))
    parts.append(obj_from_bmesh("hand", hb, coll, ST, smooth=True))
    parts.append(seg_between(coll, "arm_l", G @ Vector((-0.24, -0.02, 1.54)),
                             G @ Vector((-0.12, -0.26, 1.22)), 0.08, 0.06, ST,
                             segs=9))
    lantern_head(coll, "lant", hnp + Vector((0, -0.02, 0.10)), parts, lit=True)

    # ── HER LANTERN POST: the cliff light, seaward of the cottage ──
    PX, PY = -3.85, -1.35
    postm = T(PX, PY, 0) @ RZ(0.22) @ RY(math.radians(2.5))
    base = bm_bevel(bm_box(0.46, 0.46, 0.20), 0.035, 2)
    xform(base, postm @ T(0, 0, 0.09))
    parts.append(obj_from_bmesh("lp_base", base, coll, mat("Stone_Fort")))
    shaft = bm_cylinder(0.075, 0.055, 2.05, segs=10)
    xform(shaft, postm @ T(0, 0, 1.15))
    parts.append(obj_from_bmesh("lp_shaft", shaft, coll, mat("Verdigris"),
                                smooth=True))
    for zi, (zz, rr) in enumerate(((0.32, 0.10), (1.05, 0.09))):
        col_ = bm_torus(rr, 0.022, segs=10, rings=5)
        xform(col_, postm @ T(0, 0, zz))
        parts.append(obj_from_bmesh(f"lp_collar{zi}", col_, coll,
                                    mat("Verdigris"), smooth=True))
    bp = [(0, 0, 2.05), (0, -0.22, 2.18), (0, -0.40, 2.30), (0, -0.46, 2.42)]
    for i in range(3):
        parts.append(seg_between(coll, f"lp_br{i}",
                                 postm @ Vector(bp[i]), postm @ Vector(bp[i + 1]),
                                 0.032, 0.026, mat("Verdigris"), segs=7))
    for i, (a, b) in enumerate((((0, -0.06, 1.92), (0, -0.30, 2.20)),
                                ((0, -0.30, 2.20), (0, -0.34, 2.02)))):
        parts.append(seg_between(coll, f"lp_curl{i}", postm @ Vector(a),
                                 postm @ Vector(b), 0.020, 0.016,
                                 mat("Verdigris"), segs=6))
    lantern_head(coll, "lp_lant", postm @ Vector((0, -0.46, 2.28)), parts,
                 lit=True, scale=1.25)
    can = bm_cylinder(0.105, 0.09, 0.22, segs=10)
    xform(can, T(PX + 0.42, PY + 0.18, 0.11) @ RZ(0.5))
    parts.append(obj_from_bmesh("oilcan", can, coll, mat("Metal_Band"),
                                smooth=True))
    spout = bm_cylinder(0.026, 0.014, 0.20, segs=7)
    xform(spout, T(PX + 0.42, PY + 0.06, 0.22) @ RX(math.radians(-58)))
    parts.append(obj_from_bmesh("oilspout", spout, coll, mat("Metal_Band"),
                                smooth=True))

    # ── storm fence: wind-worn boards leaning seaward ──
    for i in range(6):
        fx = -2.95 + i * 0.62
        h = rng.uniform(0.85, 1.25)
        if i == 3:
            h *= 0.45                       # one board snapped short
        bm = bm_box(0.20, 0.05, h)
        for v in bm.verts:                  # cupped, nicked, tapered board
            f = v.co.z / (h / 2)
            v.co.y += 0.014 * (f * f - 0.4)
            v.co.x *= 1.0 - 0.08 * abs(f)
        bm_bevel(bm, 0.008, 1)
        xform(bm, T(fx, -1.95 + rng.uniform(-0.05, 0.05), h / 2) @
              RZ(rng.uniform(-0.1, 0.1)) @
              RX(math.radians(rng.uniform(4, 13))))
        parts.append(obj_from_bmesh(f"fence{i}", bm, coll, mat("Wood_Bleached")))
    rl = bm_box(3.85, 0.06, 0.09)
    for v in rl.verts:
        v.co.z += 0.03 * math.sin(v.co.x * 1.6)
    bm_bevel(rl, 0.012, 1)
    xform(rl, T(-1.75, -2.02, 0.86) @ RZ(0.02) @ RX(math.radians(2)))
    parts.append(obj_from_bmesh("fence_rail", rl, coll, mat("Wood_Bleached")))

    # ── bench facing the sea ──
    BX, BY = 4.1, 0.3
    bseat = bm_bevel(bm_box(1.5, 0.42, 0.09), 0.02, 2)
    xform(bseat, T(BX, BY, 0.46) @ RZ(-0.18))
    parts.append(obj_from_bmesh("bench_seat", bseat, coll, mat("Wood_Bleached")))
    bslat = bm_bevel(bm_box(1.42, 0.16, 0.06), 0.015, 2)
    xform(bslat, T(BX - 0.02, BY + 0.24, 0.44) @ RZ(-0.18))
    parts.append(obj_from_bmesh("bench_slat", bslat, coll, mat("Wood_Bleached")))
    for sx in (-1, 1):
        parts.append(stone_block(coll, f"bench_leg{sx}", 0.34, 0.4, 0.42,
                                 T(BX + sx * 0.55, BY + sx * -0.10, 0.21) @
                                 RZ(-0.18), mat("Stone_Dark")))

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
        if i % 3 == 0:
            d2 = (d + Vector((rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6),
                              0.2))).normalized()
            parts.append(seg_between(coll, f"twigf{i}", p2, p2 + d2 * ln * 0.45,
                                     0.007, 0.004, mat("Wood_Dark"), segs=5))
    for i in range(5):
        hp = bm_icosphere(0.028, 1)
        xform(hp, T(RBX + rng.uniform(-0.25, 0.25), RBY + rng.uniform(-0.25, 0.25),
                    rng.uniform(0.25, 0.55)))
        parts.append(obj_from_bmesh(f"hip{i}", hp, coll, mat("Rust"),
                                    smooth=True))

    SPEC = tint_spec(moss=0.55)
    SPEC['Stone_Fort'] = dict(
        SPEC['Stone_Fort'], tone=0.26,
        hue=((1.34, 1.10, 0.80), (0.76, 0.84, 0.96)), scale=1.3,
        mottle=0.15, mscale=0.26,
        patch=dict(col=(0.34, 0.80, 0.24), amt=0.80, scale=0.80, thresh=0.56,
                   width=0.16, up=0.45),
        low=dict(z=0.42, amt=0.38, col=(0.42, 0.48, 0.36)))
    SPEC['Stone_Dark'] = dict(
        SPEC['Stone_Dark'], tone=0.22,
        hue=((1.22, 1.10, 0.92), (0.80, 0.84, 0.92)), scale=1.1)
    SPEC['Slate'] = dict(tone=0.16, mottle=0.12, mscale=0.18,
                         hue=((1.20, 1.14, 1.02), (0.80, 0.84, 0.94)), scale=0.6)
    # the statue takes salt-bleach on the seaward face and lichen in the folds,
    # on a tighter noise scale than the wall so she never blends into it
    SPEC['Stone_Statue'] = dict(
        tone=0.10,
        hue=((1.26, 1.16, 1.00), (0.74, 0.78, 0.88)), scale=0.55,
        mottle=0.14, mscale=0.20,
        patch=dict(col=(0.88, 0.94, 0.72), amt=0.45, scale=0.42, thresh=0.60,
                   width=0.14, up=0.55),
        low=dict(z=0.55, amt=0.40, col=(0.46, 0.52, 0.44)))
    ship_asset(coll, name, spec=SPEC, ao=dict(samples=24, floor=0.40),
               render_dir=RENDER_DIR, views=4)
    print(f"built {name}")


build()
print("WIDOW DONE")
