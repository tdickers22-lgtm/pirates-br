# kraken_wreck — Kraken Tooth hero story scene (SHOWSTOPPER).
# A ship's bow section carried ashore, CRUSHED inside a giant coiled kraken
# tentacle. Suckered underside, harpoons + trailing rope, sucker-scar ring on
# an adjacent rock slab, dangling anchor, snapped bowsprit.
# Origin at waterline/ground center. Scene faces -Y. 1u = 1m.
# Headless: Blender -b -P scripts/blender/build_scene_kraken.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())

RENDER_DIR = os.environ.get("PBR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)

EXTRA = {
    "Kraken_Flesh":  ((0.28, 0.10, 0.13, 1.0), 0.85, 0.0),
    "Kraken_Sucker": ((0.50, 0.42, 0.36, 1.0), 0.80, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()


# ── local helpers ────────────────────────────────────────────
def beam(coll, name, p1, p2, r1, r2, material, segs=7, smooth=True):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, d.length + 0.02, segs=segs)
    quat = d.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p1 + p2) / 2) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def box_beam(coll, name, p1, p2, w, d, material, roll=0.0):
    p1, p2 = Vector(p1), Vector(p2)
    dd = p2 - p1
    bm = bm_box(w, d, dd.length + 0.02)
    if roll:
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(roll, 4, 'Z'), verts=bm.verts)
    quat = dd.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p1 + p2) / 2) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material)


def rope_cat(coll, name, p1, p2, sag, r=0.024, segs=9):
    p1, p2 = Vector(p1), Vector(p2)
    pts = []
    for i in range(segs + 1):
        t = i / segs
        p = p1.lerp(p2, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    parts = []
    for i in range(segs):
        d = pts[i + 1] - pts[i]
        bm = bm_cylinder(r, r, d.length + 0.012, segs=5)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((pts[i] + pts[i + 1]) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, mat("Rope"), smooth=True))
    return parts


def catmull(pts, samples):
    """Catmull-Rom through pts, returns samples+1 Vectors."""
    P = [pts[0]] + [Vector(p) for p in pts] + [pts[-1]]
    P = [Vector(p) for p in P]
    n = len(pts) - 1
    out = []
    for i in range(samples + 1):
        t = (i / samples) * n
        seg = min(int(t), n - 1)
        u = t - seg
        p0, p1, p2, p3 = P[seg], P[seg + 1], P[seg + 2], P[seg + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u +
                          (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
                          (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return out


def parallel_frames(pts):
    """Parallel-transport frames along polyline. Returns [(tan, nrm, binrm)]."""
    n = len(pts)
    tans = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tans.append((b - a).normalized())
    t0 = tans[0]
    up = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = (up - t0 * up.dot(t0)).normalized()
    frames = []
    for i in range(n):
        if i > 0:
            axis = tans[i - 1].cross(tans[i])
            if axis.length > 1e-8:
                ang = tans[i - 1].angle(tans[i])
                nrm = (Matrix.Rotation(ang, 3, axis.normalized()) @ nrm).normalized()
        binrm = tans[i].cross(nrm).normalized()
        frames.append((tans[i].copy(), nrm.copy(), binrm.copy()))
    return frames


def loft_tube(coll, name, pts, radii, material, segs=16, smooth=True):
    """Skinned tube along pts with per-station radii."""
    frames = parallel_frames(pts)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        _, nrm, binrm = frames[i]
        ring = []
        for s in range(segs):
            a = 2 * math.pi * s / segs
            ring.append(bm.verts.new(p + (nrm * math.cos(a) + binrm * math.sin(a)) * radii[i]))
        rings.append(ring)
    for i in range(len(pts) - 1):
        for s in range(segs):
            bm.faces.new((rings[i][s], rings[i][(s + 1) % segs],
                          rings[i + 1][(s + 1) % segs], rings[i + 1][s]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth), frames


def finish(objs, width=0.02, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


# ═════════════════════════════════════════════════════════════
# KRAKEN WRECK
# ═════════════════════════════════════════════════════════════
def build_kraken_wreck(name="kraken_wreck"):
    coll = asset_collection(name)
    rng = random.Random(42)
    wb, wd, wm = mat("Wood_Bleached"), mat("Wood_Dark"), mat("Wood_Mid")
    kf, ks = mat("Kraken_Flesh"), mat("Kraken_Sucker")
    # local retint: the slab reads as concrete — volcanic rock for this scene
    rock = mat("Rock_Grey")
    rock.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
        (0.42, 0.38, 0.34, 1.0)
    parts, bev = [], []

    # ── hull placement frame ─────────────────────────────────
    # Hull local: x lateral, y longitudinal (bow -Y), z up. Lifted + listing.
    HULL_ROLL = math.radians(16)      # list to +X
    HULL_PITCH = math.radians(-4)     # bow slightly down
    HULL_POS = Vector((-0.6, 0.0, 0.55))
    M_HULL = (Matrix.Translation(HULL_POS) @
              Matrix.Rotation(HULL_PITCH, 4, 'X') @
              Matrix.Rotation(HULL_ROLL, 4, 'Y'))

    def hw(p):
        return M_HULL @ Vector(p)

    L, W, Hh = 7.6, 4.0, 2.5
    Y_BOW, Y_BRK = -4.2, 3.4  # bow tip / stern break (local y)

    def taper(y):
        u = max(0.0, min(1.0, (y - Y_BRK) / (Y_BOW - Y_BRK)))
        return 1.0 - 0.60 * u ** 1.8

    def hull_pt(y, ang, side):
        """local hull surface point: ang 0 = keel, pi/2 = sheer."""
        tp = taper(y)
        x = side * (W / 2) * tp * math.sin(ang)
        z = 0.30 + Hh * tp * (1 - math.cos(ang))
        return Vector((x, y, z))

    # keel + stem + snapped bowsprit
    ky = [Y_BOW + 0.4 + (Y_BRK - Y_BOW - 0.4) * i / 5 for i in range(6)]
    for i in range(5):
        p1 = Vector((0, ky[i], 0.18 + 0.35 * ((ky[i] - Y_BRK) / (Y_BOW - Y_BRK)) ** 2))
        p2 = Vector((0, ky[i + 1], 0.18 + 0.35 * ((ky[i + 1] - Y_BRK) / (Y_BOW - Y_BRK)) ** 2))
        o = box_beam(coll, f"{name}_keel{i}", hw(p1), hw(p2), 0.38, 0.52, wd)
        parts.append(o); bev.append(o)
    o = box_beam(coll, f"{name}_stem", hw((0, Y_BOW + 0.3, 0.3)), hw((0, Y_BOW - 0.45, 2.65)),
                 0.28, 0.4, wd)
    parts.append(o); bev.append(o)
    # bowsprit: snapped — a stub + a splintered hanging piece
    o = beam(coll, f"{name}_bsp_stub", hw((0, Y_BOW - 0.35, 2.5)),
             hw((0, Y_BOW - 1.35, 3.1)), 0.11, 0.07, wd, segs=8)
    parts.append(o)
    o = beam(coll, f"{name}_bsp_splint", hw((0, Y_BOW - 1.3, 3.05)),
             hw((0, Y_BOW - 1.55, 3.35)), 0.05, 0.006, wb, segs=5)
    parts.append(o)
    o = beam(coll, f"{name}_bsp_fallen", hw((0.5, Y_BOW - 1.5, -0.42)),
             hw((0.2, Y_BOW - 3.6, -0.30)), 0.08, 0.04, wd, segs=7)
    parts.append(o)

    # ── ribs — crushed in the coil band (local y in [-1.8, 2.4]) ──
    nribs = 12
    nseg = 8
    for i in range(nribs):
        y = Y_BOW + 0.7 + (Y_BRK - Y_BOW - 0.9) * i / (nribs - 1)
        in_coil = -0.7 < y < 2.9
        for side in (-1, 1):
            broken = (in_coil and rng.random() < 0.35) or rng.random() < 0.08
            top = rng.uniform(0.55, 0.8) if broken else 1.0
            n = max(2, int(nseg * top + 0.5))
            for s in range(n):
                a1 = (s / nseg) * (math.pi / 2)
                a2 = ((s + 1) / nseg) * (math.pi / 2)
                p1, p2 = hull_pt(y, a1, side), hull_pt(y, a2, side)
                o = box_beam(coll, f"{name}_rib{i}{'p' if side < 0 else 's'}{s}",
                             hw(p1), hw(p2), 0.14, 0.26, wb if (i + s) % 4 else wm)
                parts.append(o); bev.append(o)
            if broken:
                tip = hull_pt(y, (n / nseg) * (math.pi / 2), side)
                d = (hull_pt(y, min(1.0, (n + 1) / nseg) * (math.pi / 2), side) - tip)
                o = beam(coll, f"{name}_ribsp{i}{side}", hw(tip),
                         hw(tip + d.normalized() * 0.4), 0.05, 0.007, wb, segs=5)
                parts.append(o)

    # ── strakes — gaps + splinters in the coil crush band ──
    def strakes(side, angs):
        for si, ang in enumerate(angs):
            spans = [(Y_BOW + 0.55 + si * 0.28, -0.85), (2.55, Y_BRK - rng.uniform(0.0, 0.5))]
            if si >= 5 and side == 1:
                spans = [spans[0]]  # top strakes ripped off starboard aft
            for (ya, yb) in spans:
                if yb - ya < 0.4:
                    continue
                nsp = max(1, int((yb - ya) / 2.2))
                for sp in range(nsp):
                    q1 = ya + (yb - ya) * sp / nsp
                    q2 = ya + (yb - ya) * (sp + 1) / nsp
                    pa, pb = hull_pt(q1, ang, side), hull_pt(q2, ang, side)
                    out = Vector((side * math.sin(ang), 0, -math.cos(ang))).normalized()
                    pa += out * 0.13
                    pb += out * 0.13
                    roll = math.atan2(math.cos(ang) * side, math.sin(ang)) * 0.9
                    o = box_beam(coll, f"{name}_st{'p' if side < 0 else 's'}{si}_{sp}_{q1:.1f}",
                                 hw(pa), hw(pb), 0.085, 0.46, wb if si % 2 else wd, roll=roll)
                    parts.append(o); bev.append(o)
                # splintered ends at the crush-band edge of each span
                for qq, dd in ((yb, 1) if yb < Y_BRK - 0.6 else (None, 0),
                               (ya, -1) if ya > Y_BOW + 1.0 else (None, 0)):
                    if qq is None:
                        continue
                    tip = hull_pt(qq, ang, side) + Vector((side * math.sin(ang), 0, -math.cos(ang))) * 0.13
                    o = beam(coll, f"{name}_stsp{side}{si}_{qq:.1f}", hw(tip),
                             hw(tip + Vector((side * 0.12, dd * 0.45, rng.uniform(0.05, 0.25)))),
                             0.05, 0.006, wb, segs=5)
                    parts.append(o)
    angs = [0.13 + i * 0.168 for i in range(8)]
    strakes(-1, angs)
    strakes(1, angs)

    # foredeck planks (bow triangle) + cross beams
    for i in range(7):
        y = Y_BOW + 0.9 + i * 0.42
        tp = taper(y) * (W / 2) * 0.82
        o = box_beam(coll, f"{name}_deckb{i}", hw((-tp, y, 2.06)), hw((tp, y, 2.06)),
                     0.34, 0.07, wm if i % 2 else wb)
        parts.append(o); bev.append(o)
    # rail caps along the intact bow sheer
    for side in (-1, 1):
        yy = Y_BOW + 0.55
        while yy < -1.0:
            y2 = min(-0.95, yy + 1.1)
            pa = hull_pt(yy, math.pi / 2, side) + Vector((0, 0, 0.10))
            pb = hull_pt(y2, math.pi / 2, side) + Vector((0, 0, 0.10))
            o = box_beam(coll, f"{name}_rail{side}{yy:.1f}", hw(pa), hw(pb), 0.20, 0.10,
                         wd if side < 0 else wm)
            parts.append(o); bev.append(o)
            yy = y2 + 0.04
    # crushed focal: splinter bursts where the first wrap bites the sheer
    for i in range(8):
        side = -1 if i % 2 else 1
        yl = rng.uniform(-0.6, 0.9)
        base = hw((side * taper(yl) * (W / 2) * rng.uniform(0.9, 1.05), yl,
                   rng.uniform(1.9, 2.35)))
        d = Vector((side * rng.uniform(0.3, 0.7), rng.uniform(-0.3, 0.3),
                    rng.uniform(0.15, 0.45)))
        o = beam(coll, f"{name}_burst{i}", base, base + d, 0.06, 0.008, wb, segs=5)
        parts.append(o)
    # bent deck planks popped upward at the crush line
    for i in range(4):
        yl = rng.uniform(-0.9, -0.2)
        tp = taper(yl) * (W / 2) * 0.6
        x0 = rng.uniform(-tp, tp * 0.2)
        o = box_beam(coll, f"{name}_pop{i}", hw((x0, yl, 2.1)),
                     hw((x0 + rng.uniform(0.5, 1.1), yl + rng.uniform(0.6, 1.1),
                         2.55 + rng.uniform(0.1, 0.5))), 0.3, 0.06, wm if i % 2 else wb)
        parts.append(o); bev.append(o)

    # ── dangling anchor at the bow ──
    ap = hw((-1.15, Y_BOW + 0.6, 1.9))          # cathead point
    ab = Vector((ap.x - 0.25, ap.y - 0.35, 0.42))  # anchor hang point
    parts += rope_cat(coll, f"{name}_arope", ap, ab + Vector((0, 0, 0.55)), 0.12, r=0.03, segs=7)
    mi = mat("Metal_Iron")
    o = beam(coll, f"{name}_ashank", ab + Vector((0, 0, 0.55)), ab - Vector((0, 0, 0.55)),
             0.055, 0.05, mi, segs=8)
    parts.append(o)
    # stock (wood crossbar) near top
    o = box_beam(coll, f"{name}_astock", ab + Vector((-0.42, 0.1, 0.38)),
                 ab + Vector((0.42, -0.1, 0.38)), 0.09, 0.09, wd)
    parts.append(o); bev.append(o)
    # arms + flukes
    for sx in (-1, 1):
        arm_pts = catmull([ab - Vector((0, 0, 0.55)),
                           ab + Vector((sx * 0.3, 0.05, -0.42)),
                           ab + Vector((sx * 0.52, 0.1, -0.05))], 6)
        for j in range(6):
            o = beam(coll, f"{name}_aarm{sx}{j}", arm_pts[j], arm_pts[j + 1],
                     0.045, 0.04, mi, segs=6)
            parts.append(o)
        bm = bm_box(0.16, 0.03, 0.26)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(ab + Vector((sx * 0.54, 0.1, 0.05))) @
                            Matrix.Rotation(sx * 0.5, 4, 'Y'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_afluke{sx}", bm, coll, mi)
        parts.append(o); bev.append(o)

    # ═════ TENTACLE — tapering coil crushing the hull ═════
    # Helix around the hull long axis (local Y), buried under the sand at the
    # bottom of each wrap. Approach from +X/+Y shallows; tip curls up in air
    # past the bow on the -Y (audience) side.
    axis_c = HULL_POS + Vector((0, 0, 1.15))
    ctrl = [Vector((6.6, 5.4, -0.7)),
            Vector((5.4, 4.4, -0.05)),
            Vector((4.4, 3.9, 0.15)),   # undulation knuckle
            Vector((3.5, 3.4, 0.55))]
    n_coil = 16
    for k in range(n_coil):
        t = k / (n_coil - 1)
        phi = -0.30 + t * (2 * math.pi * 1.34)
        yy = 2.85 - 3.7 * t
        R = 2.38 - 0.58 * t
        ctrl.append(Vector((axis_c.x + R * math.cos(phi), yy,
                            axis_c.z + R * math.sin(phi))))
    # exit over the top, sweep down the port bow, tip curls before the bowsprit
    ctrl += [Vector((0.6, -2.7, 2.9)),
             Vector((1.3, -4.6, 2.2)),
             Vector((0.7, -6.2, 2.1)),
             Vector((-0.8, -6.9, 2.5)),
             Vector((-1.8, -6.2, 2.7)),
             Vector((-1.4, -5.4, 2.5)),
             Vector((-0.8, -5.6, 2.3))]
    NS = 165
    tpts = catmull(ctrl, NS)
    # flatten the buried parts of the loops into the sand
    for p in tpts:
        if p.z < -0.45:
            p.z = -0.45 - (abs(p.z + 0.45) * 0.12)
    radii = []
    for i in range(NS + 1):
        t = i / NS
        r = 0.92 * (1 - t) ** 0.9 + 0.05
        radii.append(r)
    tent, frames = loft_tube(coll, f"{name}_tent", tpts, radii, kf, segs=26)
    displace_noise(tent, strength=0.15, scale=1.5, seed=5)
    displace_noise(tent, strength=0.06, scale=0.55, seed=11)
    apply_modifiers(tent)
    parts.append(tent)

    # ── suckers: two graduated rows along the belly line ──
    # belly = toward hull axis inside the coil, blended to down-front elsewhere
    arclen = [0.0]
    for i in range(1, NS + 1):
        arclen.append(arclen[-1] + (tpts[i] - tpts[i - 1]).length)
    total = arclen[-1]

    def belly_dir(i):
        t = i / NS
        p = tpts[i]
        tan = frames[i][0]
        tgt = Vector((axis_c.x, max(-1.0, min(2.8, p.y)), axis_c.z))
        dA = (tgt - p)
        dA = dA.normalized() if dA.length > 1e-5 else Vector((0, 0, -1))
        dB = Vector((0.15, -0.5, -0.85)).normalized()
        if t < 0.16:
            w = 0.0
        elif t < 0.26:
            w = (t - 0.16) / 0.10
        elif t < 0.72:
            w = 1.0
        elif t < 0.86:
            w = 1.0 - (t - 0.72) / 0.14
        else:
            w = 0.0
        d = dA * w + dB * (1 - w)
        d = d - tan * d.dot(tan)
        return d.normalized() if d.length > 1e-5 else frames[i][1]

    s_step = 0.36
    s_next = arclen[int(NS * 0.10)]
    si = 0
    idx = 0
    while idx <= NS:
        if arclen[idx] >= s_next:
            t = idx / NS
            rloc = radii[idx]
            bd = belly_dir(idx)
            tan = frames[idx][0]
            for row in (-1, 1):
                rq = Matrix.Rotation(row * 0.68 + rng.uniform(-0.07, 0.07), 3, tan)
                d = (rq @ bd).normalized()
                sr = max(0.055, min(0.28, rloc * 0.40))
                p = tpts[idx] + d * (rloc * 0.86)
                h = sr * 0.6
                q = d.to_track_quat('Z', 'Y')
                bm = bm_cylinder(sr, sr * 0.70, h, segs=10)
                bmesh.ops.transform(bm, matrix=Matrix.Translation(p + d * (h * 0.45)) @
                                    q.to_matrix().to_4x4(), verts=bm.verts)
                parts.append(obj_from_bmesh(f"{name}_suck{si}{row}", bm, coll, ks, smooth=True))
                bm = bm_cylinder(sr * 0.42, sr * 0.40, h * 0.5, segs=10)
                bmesh.ops.transform(bm, matrix=Matrix.Translation(p + d * (h * 0.62)) @
                                    q.to_matrix().to_4x4(), verts=bm.verts)
                parts.append(obj_from_bmesh(f"{name}_sucki{si}{row}", bm, coll, kf, smooth=True))
            si += 1
            s_next += s_step * (0.55 + 0.9 * (1 - t))  # tighter spacing toward tip
        idx += 1
    print(f"suckers placed: {si * 2}")

    # ── harpoons stuck in the tentacle + trailing rope ──
    # Five, and thick enough to read from the beach: at the authored scale the
    # 3.5 cm shafts vanished into the coil and the whole "they fought back"
    # beat with them (bible §9).
    harps = [(int(NS * 0.30), Vector((0.9, -0.5, 0.8)), Vector((4.6, -2.4, 0.0))),
             (int(NS * 0.44), Vector((0.35, -0.9, 0.55)), Vector((3.1, -4.3, 0.0))),
             (int(NS * 0.55), Vector((-0.85, -0.5, 0.7)), Vector((-4.4, -2.6, 0.0))),
             (int(NS * 0.71), Vector((-0.5, -0.75, 0.9)), Vector((-2.6, -4.6, 0.0))),
             (int(NS * 0.88), Vector((0.25, -0.7, 0.85)), Vector((2.2, -5.6, 0.0)))]
    for hi, (idx, hdir, ground) in enumerate(harps):
        hdir = hdir.normalized()
        tip = tpts[idx] + hdir * (radii[idx] * 0.35)      # buried head
        butt = tpts[idx] + hdir * (radii[idx] * 0.35 + 1.9)
        o = beam(coll, f"{name}_hshaft{hi}", butt, tip + hdir * 0.28, 0.055, 0.065, wd, segs=7)
        parts.append(o)
        o = beam(coll, f"{name}_hhead{hi}", tip + hdir * 0.34, tip, 0.082, 0.010,
                 mat("Metal_Iron"), segs=6)
        parts.append(o)
        for bs in (-1, 1):  # barbs
            bp = tip + hdir * 0.26
            perp = hdir.cross(Vector((0, 0, 1)))
            perp = perp.normalized() if perp.length > 1e-4 else Vector((1, 0, 0))
            o = beam(coll, f"{name}_hbarb{hi}{bs}", bp, bp + (hdir * 0.19 + perp * bs * 0.14),
                     0.034, 0.005, mat("Metal_Iron"), segs=5)
            parts.append(o)
        parts += rope_cat(coll, f"{name}_hrope{hi}", butt, Vector((ground.x, ground.y, 0.03)),
                          rng.uniform(0.5, 0.9), r=0.038, segs=10)

    # ── volcanic rock outcrop with sucker-SCAR ring ──
    # irregular low outcrop: tilted 8-14deg, ~40% buried, noisy edges
    bm = bm_box(2.7, 2.2, 1.1)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=6, use_grid_fill=True)
    SLAB_C = Vector((4.5, -3.0, 0.11))
    M_SLAB = (Matrix.Translation(SLAB_C) @
              Matrix.Rotation(math.radians(11), 4, 'X') @
              Matrix.Rotation(math.radians(-9), 4, 'Y') @
              Matrix.Rotation(0.35, 4, 'Z'))
    bmesh.ops.transform(bm, matrix=M_SLAB, verts=bm.verts)
    slab = obj_from_bmesh(f"{name}_slab", bm, coll, mat("Rock_Grey"))
    displace_noise(slab, strength=0.36, scale=1.05, seed=3)
    displace_noise(slab, strength=0.11, scale=0.42, seed=9)
    apply_modifiers(slab)
    parts.append(slab)
    # two shoulder boulders so the outcrop reads as natural rock, not a block
    for bi, (off, br) in enumerate((((1.55, 0.9, -0.32), 0.72),
                                    ((-1.35, -1.05, -0.38), 0.58))):
        bm = bm_icosphere(br, subdiv=2)
        bmesh.ops.scale(bm, vec=Vector((1.35, 1.1, 0.75)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(SLAB_C + Vector(off)),
                            verts=bm.verts)
        o = obj_from_bmesh(f"{name}_slabrk{bi}", bm, coll, mat("Rock_Grey"))
        displace_noise(o, strength=0.22, scale=0.9, seed=13 + bi)
        apply_modifiers(o)
        parts.append(o)
    # scar ring — sucker weals sunk as darker insets into the tilted top face
    scar_n = (M_SLAB.to_3x3() @ Vector((0, 0, 1))).normalized()
    scar_c = SLAB_C + scar_n * 0.52
    su = scar_n.cross(Vector((0, 1, 0))).normalized()
    sv = scar_n.cross(su)
    for j in range(12):
        a = 2 * math.pi * j / 12
        rr = 0.15 - 0.02 * (j % 3)
        p = scar_c + (su * math.cos(a) + sv * math.sin(a)) * 0.72
        q = scar_n.to_track_quat('Z', 'Y')
        bm = bm_cylinder(rr, rr * 0.68, 0.12, segs=8)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p + scar_n * 0.02) @
                            q.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_scar{j}", bm, coll, ks, smooth=True))
    # a second, half-overlapping weal ring — one ring reads as decoration, two
    # read as "something enormous dragged across this rock"
    scar_c2 = SLAB_C + scar_n * 0.50 + su * 0.95 - sv * 0.55
    for j in range(9):
        a = 2 * math.pi * j / 9 + 0.4
        rr = 0.115 - 0.015 * (j % 3)
        p = scar_c2 + (su * math.cos(a) + sv * math.sin(a)) * 0.46
        q = scar_n.to_track_quat('Z', 'Y')
        bm = bm_cylinder(rr, rr * 0.68, 0.10, segs=8)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p + scar_n * 0.02) @
                            q.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_scarb{j}", bm, coll, ks, smooth=True))

    # ── spilled cargo barrels near the stern break ──
    def barrel(tag, pos, rot_euler, crushed=False):
        objs = []
        nst = 12
        for st in range(nst):
            a = 2 * math.pi * st / nst
            r = 0.34
            bm = bm_box(0.19, 0.045, 0.86)
            sq = 0.45 if crushed else 1.0
            M = (Matrix.Translation(pos) @
                 Matrix.Rotation(rot_euler[2], 4, 'Z') @
                 Matrix.Rotation(rot_euler[1], 4, 'Y') @
                 Matrix.Rotation(rot_euler[0], 4, 'X') @
                 Matrix.Diagonal(Vector((1, sq, 1))).to_4x4() @
                 Matrix.Translation((math.cos(a) * r, math.sin(a) * r, 0)) @
                 Matrix.Rotation(a + math.pi / 2, 4, 'Z'))
            bm2 = bm
            bmesh.ops.transform(bm2, matrix=M, verts=bm2.verts)
            o = obj_from_bmesh(f"{name}_{tag}s{st}", bm2, coll, wm if st % 3 else wd)
            objs.append(o); bev.append(o)
        for bz in (-0.28, 0.30):
            bm = bm_cylinder(0.375, 0.375, 0.06, segs=14, cap=False)
            sq = 0.45 if crushed else 1.0
            M = (Matrix.Translation(pos) @
                 Matrix.Rotation(rot_euler[2], 4, 'Z') @
                 Matrix.Rotation(rot_euler[1], 4, 'Y') @
                 Matrix.Rotation(rot_euler[0], 4, 'X') @
                 Matrix.Diagonal(Vector((1, sq, 1))).to_4x4() @
                 Matrix.Translation((0, 0, bz)))
            bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
            o = obj_from_bmesh(f"{name}_{tag}b{bz:.1f}", bm, coll, mat("Metal_Iron"),
                               smooth=True)
            objs.append(o)
        return objs
    parts += barrel("bar0", Vector((2.6, 3.9, 0.36)), (math.radians(88), 0.2, 0.7))
    parts += barrel("bar1", Vector((1.2, 5.0, 0.22)), (math.radians(92), 0.1, -0.9),
                    crushed=True)

    # bow bitts (mooring posts) on the foredeck
    for bx in (-0.55, 0.55):
        o = box_beam(coll, f"{name}_bitt{bx}", hw((bx, Y_BOW + 1.6, 2.0)),
                     hw((bx, Y_BOW + 1.6, 2.75)), 0.16, 0.16, wd)
        parts.append(o); bev.append(o)
    o = box_beam(coll, f"{name}_bittx", hw((-0.75, Y_BOW + 1.6, 2.6)),
                 hw((0.75, Y_BOW + 1.6, 2.6)), 0.14, 0.14, wm)
    parts.append(o); bev.append(o)

    # ── ground debris planks ──
    # splintered PLANKING, not sticks: broad hull boards torn off the crush line
    for i in range(14):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(2.2, 4.6)
        p = Vector((math.cos(a) * r * 0.8, -abs(math.sin(a)) * r - 0.9,
                    -0.02 + rng.uniform(0.0, 0.16)))
        d = Vector((math.cos(a + 1.2), math.sin(a + 1.2), 0.03)) * rng.uniform(1.1, 2.2)
        o = box_beam(coll, f"{name}_deb{i}", p, p + d,
                     rng.uniform(0.34, 0.52), rng.uniform(0.10, 0.16),
                     wb if i % 2 else wm)
        parts.append(o); bev.append(o)

    finish(bev, width=0.018)
    obj = join(parts, name)

    # ── SHOWSTOPPER scale ────────────────────────────────────
    # Authored at a 7.6 m hull, which on the beach read as "a 10 m pink coil
    # with stick debris" — nothing like the island-defining landmark the story
    # bible asks for (§9 Kraken Tooth). Scaled about the scene origin so the
    # tentacle, hull section, harpoons, sucker rows and scar rings all grow
    # together and keep their relative proportions.
    SCENE_SCALE = 1.8
    obj.scale = (SCENE_SCALE, SCENE_SCALE, SCENE_SCALE)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=5)
    print(f"built {name}")


build_kraken_wreck()
