# wrecker_tower — hero story scene for The Crooked Atoll (fidelity pass).
# The false light: a CROOKED driftwood light-tower (deliberately wrong-angled
# lashed timbers, ladder, ragged platform) topped by a big EXTINGUISHED signal
# lantern (dark dead glass, NO emission). Salvaged cargo at the base: crates
# branded with the Black Fin motif (raised Bone-relief fin), coiled ropes, a
# spyglass on a tripod aimed at the reef (-Y), and ridged drag furrows in the
# sand running up from the water. Focal: the dead lantern. Scene faces -Y.
# Headless: Blender -b -P scripts/blender/build_scene_wrecker.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())

RENDER_DIR = os.environ.get("PBR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)

EXTRA = {
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
    # dead lantern glass: cold, dark, NO emission (the point of the scene)
    "Glass_Dead": ((0.09, 0.11, 0.13, 1.0), 0.35, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()
rng = random.Random(7)


# ── generic helpers ──────────────────────────────────────────
def M_of(loc=(0, 0, 0), rot=(0, 0, 0)):
    return Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4()


def tube(coll, name, pts, r1, r2, material, segs=7, smooth=True):
    """Chain of cylinders along a point list, radius tapering r1 -> r2."""
    parts = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        if d.length < 1e-5:
            continue
        ta, tb = i / max(1, n), (i + 1) / max(1, n)
        bm = bm_cylinder(r1 + (r2 - r1) * ta, r1 + (r2 - r1) * tb,
                         d.length + 0.008, segs=segs)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material, smooth=smooth))
    return parts


def rope_cat(coll, name, p1, p2, sag, r=0.016, segs=6):
    p1, p2 = Vector(p1), Vector(p2)
    pts = []
    for i in range(segs + 1):
        t = i / segs
        p = p1.lerp(p2, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    return tube(coll, name, pts, r, r, mat("Rope"), segs=5)


def lashing(coll, name, center, axis, r, n=3, rr=0.017):
    """n rope loops wrapped around a joint, perpendicular to axis."""
    parts = []
    c, ax = Vector(center), Vector(axis).normalized()
    t = ax.cross(Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))).normalized()
    b = ax.cross(t)
    for k in range(n):
        cc = c + ax * ((k - (n - 1) / 2) * rr * 2.4)
        pts = [cc + (t * math.cos(a) + b * math.sin(a)) * r
               for a in [2 * math.pi * j / 8 for j in range(9)]]
        parts += tube(coll, f"{name}_{k}", pts, rr, rr, mat("Rope"), segs=4)
    return parts


def prism(coll, name, poly, thick, material, xform):
    """Extruded flat polygon (poly = [(x, z), ...] CCW) along +Y by thick."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, 0, z)) for (x, z) in poly]
    hi = [bm.verts.new((x, thick, z)) for (x, z) in poly]
    bm.faces.new(tuple(reversed(lo)))
    bm.faces.new(tuple(hi))
    n = len(poly)
    for i in range(n):
        bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.transform(bm, matrix=xform, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material)


def ground_disc(coll, name, R, hfn, m_main, nr=66, ns=112, rim_z=-0.05):
    bm = bmesh.new()
    center = bm.verts.new((0, 0, hfn(0, 0)))
    rings = []
    for i in range(1, nr + 1):
        r = R * i / nr
        ring = []
        for j in range(ns):
            a = 2 * math.pi * j / ns
            x, y = r * math.cos(a), r * math.sin(a)
            z = hfn(x, y)
            f = min(1.0, max(0.0, (r / R - 0.70) / 0.30))
            f = f * f * (3 - 2 * f)
            ring.append(bm.verts.new((x, y, z * (1 - f) + rim_z * f)))
        rings.append(ring)
    for j in range(ns):
        bm.faces.new((center, rings[0][j], rings[0][(j + 1) % ns]))
    for i in range(nr - 1):
        for j in range(ns):
            bm.faces.new((rings[i][j], rings[i + 1][j],
                          rings[i + 1][(j + 1) % ns], rings[i][(j + 1) % ns]))
    return obj_from_bmesh(name, bm, coll, m_main, smooth=True)


def finish(objs, width=0.014, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


def ship(coll, name, parts):
    obj = join(parts, name)
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")
    return obj


# ── ground: beach with ridged drag furrows from the water (-Y) ─
R = 5.4
CARGO_C = (2.05, 1.05)          # salvage stack center
FURROWS = ((1.35, 0.35), (2.05, 0.0), (2.75, -0.4))   # (x0, phase)


def hfn(x, y):
    z = 0.05 + 0.04 * math.sin(x * 1.15 + 0.6) * math.sin(y * 0.95 + 0.4) \
        + 0.018 * math.sin(x * 3.0 - y * 2.1 + 1.0)
    # ridged drag furrows: water edge (-Y) up to the cargo stack
    for (x0, ph) in FURROWS:
        if -5.4 < y < 1.35:
            xc = x0 + 0.16 * math.sin(y * 0.9 + ph)
            d = abs(x - xc)
            fade = min(1.0, (y + 5.4) / 0.8) * max(0.0, min(1.0, (1.35 - y) / 0.9))
            ripple = 0.68 + 0.32 * math.sin(y * 7.5 + ph * 3)
            z += (-0.17 * math.exp(-(d / 0.26) ** 2) * ripple
                  + 0.11 * math.exp(-((d - 0.44) / 0.17) ** 2)) * fade
    # low mound under the cargo
    dk = math.hypot(x - CARGO_C[0], y - CARGO_C[1])
    z += 0.14 * math.exp(-(dk / 1.15) ** 2)
    return z


# ── props ────────────────────────────────────────────────────
FIN_POLY = [(-0.16, 0.0), (0.16, 0.0), (0.05, 0.10), (-0.03, 0.24)]


def crate(coll, tag, loc, yaw, s=0.72, tilt=(0, 0), fin=False):
    """Closed banded crate; fin=True adds the raised Black Fin relief (-Y face)."""
    parts, bev = [], []
    h = s * 0.82
    Mc = M_of(loc, (tilt[0], tilt[1], yaw))

    def add(bm, m, sm=False):
        bmesh.ops.transform(bm, matrix=Mc, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        return o

    bm = bm_box(s, s, h)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, h / 2)), verts=bm.verts)
    bev.append(add(bm, mat("Wood_Mid")))
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bm_box(0.075, 0.075, h + 0.03)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (sx * s / 2, sy * s / 2, h / 2)), verts=bm.verts)
            bev.append(add(bm, mat("Wood_Dark")))
    for i in range(3):
        bm = bm_box(s * 0.31, s + 0.05, 0.05)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            ((i - 1) * s * 0.345, 0, h + 0.02)), verts=bm.verts)
        bev.append(add(bm, mat("Wood_Mid")))
    if fin:
        # raised 2cm relief, Bone, centered on the -Y side board
        sc = s / 0.72
        poly = [(px * sc, pz * sc) for (px, pz) in FIN_POLY]
        o = prism(coll, f"{tag}_fin", poly, 0.025, mat("Bone"),
                  Mc @ M_of((0, -s / 2 - 0.02, h * 0.28)))
        parts.append(o)
    return parts, bev


def rope_coil(coll, tag, cx, cy, base_z, loops=3, r0=0.22):
    parts = []
    for k in range(loops):
        zc = base_z + 0.035 + k * 0.033
        rr = r0 - k * 0.022
        pts = [(cx + rr * math.cos(a), cy + rr * math.sin(a), zc)
               for a in [2 * math.pi * t / 10 + k * 0.7 for t in range(11)]]
        parts += tube(coll, f"{tag}_{k}", pts, 0.019, 0.019, mat("Rope"), segs=5)
    return parts


def dead_lantern(coll, tag, loc, yaw):
    """BIG extinguished signal lantern. Iron frame, dead dark glass, NO emission."""
    parts, bev = [], []
    Ml = M_of(loc, (math.radians(3), math.radians(-2), yaw))   # hangs slightly askew

    def add(bm, m, sm=False):
        bmesh.ops.transform(bm, matrix=Ml, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        return o

    # base plate + oil pan
    bm = bm_cylinder(0.26, 0.28, 0.06, segs=12)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.03)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    bm = bm_cylinder(0.12, 0.14, 0.07, segs=10)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.095)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    # corner posts
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        bm = bm_box(0.045, 0.045, 0.52)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.21 * math.cos(a), 0.21 * math.sin(a), 0.32)), verts=bm.verts)
        bev.append(add(bm, mat("Metal_Iron")))
    # dead glass panes
    for i in range(4):
        a = i * math.pi / 2
        bm = bm_box(0.30, 0.02, 0.46)
        bmesh.ops.transform(bm, matrix=M_of(
            (0.195 * math.sin(a), 0.195 * math.cos(a), 0.32), (0, 0, a)), verts=bm.verts)
        add(bm, mat("Glass_Dead"))
    # mid glazing bars
    for i in range(4):
        a = i * math.pi / 2
        bm = bm_box(0.32, 0.028, 0.03)
        bmesh.ops.transform(bm, matrix=M_of(
            (0.205 * math.sin(a), 0.205 * math.cos(a), 0.32), (0, 0, a)), verts=bm.verts)
        add(bm, mat("Metal_Iron"))
    # cap + chimney
    bm = bm_cylinder(0.30, 0.08, 0.17, segs=12)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.645)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    bm = bm_cylinder(0.055, 0.07, 0.08, segs=8)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.75)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    # hanging hoop
    pts = [(0.09 * math.cos(a), 0, 0.80 + 0.09 * math.sin(a))
           for a in [math.pi * t / 6 for t in range(7)]]
    for i in range(6):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        bm = bm_cylinder(0.016, 0.016, (b - a).length + 0.005, segs=6)
        q = (b - a).to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Ml @ Matrix.Translation((a + b) / 2) @
                            q.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_h{i}", bm, coll, mat("Metal_Iron"), smooth=True))
    finish(bev, width=0.008)
    return parts


def spyglass_tripod(coll, tag, loc, yaw, pitch):
    """Spyglass on a wooden tripod, aimed at the reef (-Y)."""
    parts = []
    head = Vector((loc[0], loc[1], loc[2] + 1.12))
    for i in range(3):
        a = yaw + math.pi / 2 + i * 2 * math.pi / 3
        foot = Vector((loc[0] + 0.62 * math.cos(a), loc[1] + 0.62 * math.sin(a),
                       hfn(loc[0] + 0.62 * math.cos(a), loc[1] + 0.62 * math.sin(a)) - 0.03))
        parts += tube(coll, f"{tag}_leg{i}", [head, foot], 0.032, 0.026,
                      mat("Wood_Dark"), segs=6)
    parts += lashing(coll, f"{tag}_lash", head, (0, 0, 1), 0.075, n=2)
    # scope: two-step tube pointing toward -Y, pitched slightly down
    Ms = M_of(head, (0, 0, yaw)) @ M_of((0, 0, 0), (math.radians(90 + pitch), 0, 0))
    for (r1, r2, z0, ln, m) in ((0.052, 0.048, 0.0, 0.34, "Metal_Iron"),
                                (0.046, 0.040, 0.30, 0.22, "Wood_Dark"),
                                (0.036, 0.030, 0.50, 0.16, "Metal_Iron")):
        bm = bm_cylinder(r1, r2, ln, segs=10)
        bmesh.ops.transform(bm, matrix=Ms @ Matrix.Translation((0, 0, -(z0 + ln / 2 - 0.18))),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_t{z0}", bm, coll, mat(m), smooth=True))
    return parts


# ── the crooked tower ────────────────────────────────────────
def tower(coll, tag):
    parts, bev = [], []
    C = Vector((-0.85, 0.75, 0))          # base center
    T = Vector((-0.05, 0.05, 5.45))        # platform center — the LEAN
    base_r, top_r = 1.65, 0.82
    leg_mats = ("Wood_Mid", "Wood_Bleached", "Wood_Dark", "Wood_Mid")
    base_pts, top_pts = [], []
    for i in range(4):
        ab = math.radians(45 + i * 90 + rng.uniform(-7, 7))
        at = math.radians(45 + i * 90 + 22)        # crooked twist at the top
        bp = Vector((C.x + base_r * math.cos(ab), C.y + base_r * math.sin(ab), 0))
        tp = Vector((T.x + top_r * math.cos(at), T.y + top_r * math.sin(at), T.z))
        base_pts.append(bp)
        top_pts.append(tp)
        gz = hfn(bp.x, bp.y)
        legpts = [Vector((bp.x, bp.y, gz - 0.22))]
        for tt in (0.3, 0.55, 0.8):
            legpts.append(bp.lerp(tp, tt) + Vector((rng.uniform(-0.14, 0.14),
                                                    rng.uniform(-0.14, 0.14), 0)))
        legpts.append(tp)
        parts += tube(coll, f"{tag}_leg{i}", legpts, 0.15, 0.095,
                      mat(leg_mats[i]), segs=11)
        parts += lashing(coll, f"{tag}_leglash{i}", legpts[2], tp - bp, 0.16, n=3)
    # cross braces: deliberately wrong-angled, no two faces matching
    braces = ((0, 1, 0.5, 4.6), (1, 2, 0.9, 3.9), (2, 3, 0.3, 4.9), (3, 0, 1.1, 3.6),
              (0, 1, 3.2, 1.2), (2, 3, 3.4, 0.8))
    for bi, (i, j, za, zb) in enumerate(braces):
        pa = base_pts[i].lerp(top_pts[i], za / 5.45)
        pb = base_pts[j].lerp(top_pts[j], zb / 5.45)
        parts += tube(coll, f"{tag}_brace{bi}", [pa, pa.lerp(pb, 0.5), pb], 0.062, 0.055,
                      mat("Wood_Dark" if bi % 2 else "Wood_Mid"), segs=7)
        parts += lashing(coll, f"{tag}_brl{bi}a", pa, pb - pa, 0.115, n=3)
        parts += lashing(coll, f"{tag}_brl{bi}b", pb, pb - pa, 0.105, n=3)
    # mid landing stub (half-way rest, also crooked)
    for k in range(2):
        pa = base_pts[0].lerp(top_pts[0], (2.6 + k * 0.05) / 5.45)
        pb = base_pts[1].lerp(top_pts[1], (2.55 - k * 0.05) / 5.45)
        parts += tube(coll, f"{tag}_rung_mid{k}", [pa.lerp(pb, 0.1 + 0.35 * k),
                                                   pa.lerp(pb, 0.55 + 0.35 * k)],
                      0.05, 0.05, mat("Wood_Dark"), segs=5)
    # ── platform: uneven planks with gaps, one snapped and hanging ──
    yawp = math.radians(12)
    Mp = M_of(T, (math.radians(2.5), math.radians(-3.5), yawp))
    for j in (-1, 1):
        bm = bm_cylinder(0.07, 0.07, 2.25, segs=7)
        bmesh.ops.transform(bm, matrix=Mp @ M_of((0, j * 0.72, -0.10),
                                                 (0, math.pi / 2, 0)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_joist{j}", bm, coll, mat("Wood_Dark"), smooth=True))
    nplank = 8
    for i in range(nplank):
        x = (i - (nplank - 1) / 2) * 0.265
        if i == 5:      # snapped plank: short stub + hanging half
            bm = bm_box(0.235, 0.9, 0.05)
            bmesh.ops.transform(bm, matrix=Mp @ M_of((x, 0.55, 0),
                                                     (0, 0, rng.uniform(-0.04, 0.04))),
                                verts=bm.verts)
            o = obj_from_bmesh(f"{tag}_plank{i}a", bm, coll, mat("Wood_Mid"))
            parts.append(o); bev.append(o)
            bm = bm_box(0.235, 1.05, 0.05)
            bmesh.ops.transform(bm, matrix=Mp @ M_of((x + 0.03, -0.75, -0.42),
                                                     (math.radians(58), 0, 0.1)),
                                verts=bm.verts)
            o = obj_from_bmesh(f"{tag}_plank{i}b", bm, coll, mat("Wood_Mid"))
            parts.append(o); bev.append(o)
            continue
        ln = 2.05 + rng.uniform(-0.15, 0.2)
        bm = bm_box(0.235, ln, 0.05)
        bmesh.ops.transform(bm, matrix=Mp @ M_of(
            (x, rng.uniform(-0.12, 0.12), rng.uniform(-0.012, 0.012)),
            (rng.uniform(-0.02, 0.02), 0, rng.uniform(-0.05, 0.05))), verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_plank{i}", bm, coll,
                           mat("Wood_Mid" if i % 3 else "Wood_Bleached"))
        parts.append(o); bev.append(o)
    # railing on two sides only; one rail snapped to a stub
    for (side, broken) in ((1, False), (-1, True)):
        px = side * 1.02
        for j, py in enumerate((-0.85, 0.0, 0.85)):
            if broken and j == 2:
                continue
            bm = bm_cylinder(0.042, 0.036, 0.95, segs=6)
            bmesh.ops.transform(bm, matrix=Mp @ M_of((px, py, 0.48),
                                                     (rng.uniform(-0.06, 0.06),
                                                      rng.uniform(-0.06, 0.06), 0)),
                                verts=bm.verts)
            parts.append(obj_from_bmesh(f"{tag}_rpost{side}{j}", bm, coll,
                                        mat("Wood_Dark"), smooth=True))
        a = Mp @ Vector((px, -0.95, 0.92))
        b = Mp @ Vector((px, 0.30 if broken else 0.95, 0.88 if broken else 0.94))
        parts += tube(coll, f"{tag}_rail{side}", [a, b], 0.038, 0.034,
                      mat("Wood_Bleached"), segs=6)
        if broken:      # dangling rail piece
            c = Mp @ Vector((px, 0.42, 0.80))
            d = Mp @ Vector((px + 0.1, 0.95, 0.18))
            parts += tube(coll, f"{tag}_railsnap", [c, d], 0.034, 0.030,
                          mat("Wood_Bleached"), segs=6)
    # ── lantern mast + arm over the platform ──
    mast_b = Mp @ Vector((0.88, 0.78, 0))
    mast_t = Mp @ Vector((0.98, 0.62, 1.75))
    parts += tube(coll, f"{tag}_mast", [mast_b, mast_t], 0.085, 0.06,
                  mat("Wood_Dark"), segs=8)
    arm_e = mast_t + Vector((-0.35, -0.95, -0.06))
    parts += tube(coll, f"{tag}_arm", [mast_t + Vector((0, 0, -0.12)), arm_e],
                  0.055, 0.045, mat("Wood_Dark"), segs=7)
    knee_a = mast_t + Vector((-0.02, -0.03, -0.75))
    knee_b = mast_t.lerp(arm_e, 0.55) + Vector((0, 0, -0.02))
    parts += tube(coll, f"{tag}_knee", [knee_a, knee_b], 0.04, 0.035,
                  mat("Wood_Mid"), segs=6)
    parts += lashing(coll, f"{tag}_mastlash", mast_t + Vector((0, 0, -0.12)),
                     (0, 0, 1), 0.10, n=3)
    parts += lashing(coll, f"{tag}_kneelash", knee_b, arm_e - mast_t, 0.085, n=2)
    # chain links down to the lantern hoop
    for li in range(3):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=0.05,
                              radius2=0.05, depth=0.02)
        # torus-ish link from scaled open cylinder: use two half tubes instead
        bm.free()
        z = arm_e.z - 0.06 - li * 0.095
        pts = [(arm_e.x + 0.048 * math.cos(a), arm_e.y, z + 0.048 * math.sin(a))
               for a in [2 * math.pi * t / 8 for t in range(9)]]
        if li % 2:
            pts = [(arm_e.x, arm_e.y + (p[0] - arm_e.x), p[2]) for p in pts]
        parts += tube(coll, f"{tag}_link{li}", pts, 0.014, 0.014,
                      mat("Metal_Iron"), segs=5)
    # THE DEAD LANTERN (focal) — hangs below the arm end
    parts += dead_lantern(coll, f"{tag}_lamp",
                          (arm_e.x, arm_e.y, arm_e.z - 0.33 - 0.82), yawp)
    # ── ladder up the -Y face, slightly askew ──
    lb0 = Vector((C.x - 0.42, C.y - 1.55, 0))
    lt0 = Mp @ Vector((-0.30, -1.02, -0.05))
    lb1 = Vector((C.x + 0.38, C.y - 1.48, 0))
    lt1 = Mp @ Vector((0.42, -1.00, -0.09))
    parts += tube(coll, f"{tag}_lrailL",
                  [(lb0.x, lb0.y, hfn(lb0.x, lb0.y) - 0.06), lt0 + (lt0 - lb0) * 0.045],
                  0.055, 0.045, mat("Wood_Bleached"), segs=6)
    parts += tube(coll, f"{tag}_lrailR",
                  [(lb1.x, lb1.y, hfn(lb1.x, lb1.y) - 0.06), lt1 + (lt1 - lb1) * 0.045],
                  0.055, 0.045, mat("Wood_Mid"), segs=6)
    for i in range(10):
        t = 0.06 + i * 0.098
        a = lb0.lerp(lt0, t)
        b = lb1.lerp(lt1, t + rng.uniform(-0.008, 0.008))
        ext = (b - a).normalized() * 0.09
        parts += tube(coll, f"{tag}_rung{i}", [a - ext, b + ext], 0.032, 0.032,
                      mat("Wood_Dark" if i % 2 else "Wood_Mid"), segs=5)
        if i in (2, 6, 9):
            parts += lashing(coll, f"{tag}_runglash{i}", a, b - a, 0.062, n=2, rr=0.014)
    finish(bev, width=0.012)
    return parts


# ── build ────────────────────────────────────────────────────
def build(name):
    coll = asset_collection(name)
    parts = []
    bev_all = []

    parts.append(ground_disc(coll, f"{name}_ground", R, hfn, mat("Sand")))
    displace_noise(parts[0], strength=0.03, scale=0.5, seed=11)
    apply_modifiers(parts[0])

    parts += tower(coll, f"{name}_tw")

    # salvaged cargo stack at the base — at the head of the drag furrows
    stack = [((CARGO_C[0] - 0.42, CARGO_C[1] + 0.30), math.radians(9), 0.76, 0.0, True),
             ((CARGO_C[0] + 0.44, CARGO_C[1] + 0.18), math.radians(-14), 0.70, 0.0, False),
             ((CARGO_C[0] + 0.05, CARGO_C[1] - 0.62), math.radians(28), 0.66, 0.0, True),
             ((CARGO_C[0] - 0.02, CARGO_C[1] + 0.22), math.radians(-21), 0.62, 1.0, True)]
    for i, ((cx, cy), yw, s, level, fin) in enumerate(stack):
        cz = hfn(cx, cy) - 0.05 + level * 0.625
        p, b = crate(coll, f"{name}_ck{i}", (cx, cy, cz), yw, s=s,
                     tilt=(rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04)), fin=fin)
        parts += p
        bev_all += b

    # one crate still mid-drag, halfway up a furrow
    fx = FURROWS[2][0] + 0.16 * math.sin(-2.1 * 0.9 + FURROWS[2][1])
    p, b = crate(coll, f"{name}_ckdrag", (fx, -2.1, hfn(fx, -2.1) - 0.06),
                 math.radians(64), s=0.68, tilt=(math.radians(6), math.radians(-4)),
                 fin=True)
    parts += p
    bev_all += b
    # its drag rope trailing up toward the stack
    parts += rope_cat(coll, f"{name}_dragrope", (fx - 0.1, -1.75, hfn(fx - 0.1, -1.75) + 0.32),
                      (CARGO_C[0] + 0.2, CARGO_C[1] - 0.9, hfn(CARGO_C[0] + 0.2, CARGO_C[1] - 0.9) + 0.05),
                      sag=0.16, segs=7)

    # rope coils by the tower base and by the cargo
    parts += rope_coil(coll, f"{name}_coil0", -2.35, -0.55, hfn(-2.35, -0.55))
    parts += rope_coil(coll, f"{name}_coil1", 3.05, 0.35, hfn(3.05, 0.35), loops=2, r0=0.18)

    # spyglass tripod aimed at the reef (-Y), stage right of the ladder
    parts += spyglass_tripod(coll, f"{name}_spy", (-2.55, -2.05, hfn(-2.55, -2.05) - 0.02),
                             math.radians(6), -8)

    # a couple of salvaged barrels tipped by the stack
    def barrel(tag, loc, rot):
        prof = [(0.20, 0.0), (0.26, 0.10), (0.29, 0.30), (0.26, 0.50), (0.20, 0.60)]
        bm = bmesh.new()
        rings = []
        ns = 12
        for (r, z) in prof:
            ring = [bm.verts.new((r * math.cos(2 * math.pi * j / ns),
                                  r * math.sin(2 * math.pi * j / ns), z))
                    for j in range(ns)]
            rings.append(ring)
        for i in range(len(rings) - 1):
            for j in range(ns):
                bm.faces.new((rings[i][j], rings[i][(j + 1) % ns],
                              rings[i + 1][(j + 1) % ns], rings[i + 1][j]))
        bm.faces.new(tuple(reversed(rings[0])))
        bm.faces.new(tuple(rings[-1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.transform(bm, matrix=M_of(loc, rot), verts=bm.verts)
        ps = [obj_from_bmesh(f"{tag}_body", bm, coll, mat("Wood_Mid"), smooth=True)]
        for bz in (0.10, 0.50):
            bmb = bm_cylinder(0.278, 0.278, 0.05, segs=12, cap=False)
            bmesh.ops.transform(bmb, matrix=M_of(loc, rot) @
                                Matrix.Translation((0, 0, bz)), verts=bmb.verts)
            ps.append(obj_from_bmesh(f"{tag}_band{bz}", bmb, coll,
                                     mat("Metal_Iron"), smooth=True))
        return ps

    parts += barrel(f"{name}_bar0", (3.15, 1.55, hfn(3.15, 1.55) + 0.27),
                    (math.radians(94), 0, math.radians(35)))
    parts += barrel(f"{name}_bar1", (2.85, 2.25, hfn(2.85, 2.25) - 0.04),
                    (math.radians(-7), math.radians(5), 1.2))

    # splintered wreck planking half-buried at the waterline end of the furrows
    for i in range(7):
        fx0, ph = FURROWS[i % 3]
        wy = -3.3 - (i % 4) * 0.42 + rng.uniform(-0.2, 0.2)
        wx = fx0 + 0.16 * math.sin(wy * 0.9 + ph) + rng.uniform(-0.55, 0.55)
        ln = rng.uniform(0.7, 1.5)
        bm = bm_box(0.20, ln, 0.045)
        # splintered end: taper one end to a point
        for v in bm.verts:
            if v.co.y > ln * 0.33:
                v.co.x *= 0.25
        bmesh.ops.transform(bm, matrix=M_of(
            (wx, wy, hfn(wx, wy) + rng.uniform(-0.015, 0.02)),
            (rng.uniform(-0.06, 0.06), rng.uniform(-0.1, 0.1),
             rng.uniform(0, math.pi))), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_wreckp{i}", bm, coll,
                           mat("Wood_Bleached" if i % 2 else "Wood_Dark"))
        parts.append(o); bev_all.append(o)

    # guy ropes from the tower platform down to driftwood stakes (lashed rig)
    for (gx, gy, ax, ay, az) in ((-3.6, 2.3, -1.02, 0.85, 5.35),
                                 (2.2, 3.3, 0.75, 1.0, 5.3)):
        gz = hfn(gx, gy)
        parts += rope_cat(coll, f"{name}_guy{gx:.0f}", (ax, ay, az),
                          (gx, gy, gz + 0.18), sag=0.35, segs=8)
        bm = bm_cylinder(0.045, 0.02, 0.42, segs=6)
        bmesh.ops.transform(bm, matrix=M_of((gx, gy, gz + 0.1),
                                            (rng.uniform(0.15, 0.3), 0,
                                             rng.uniform(0, 6))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_stake{gx:.0f}", bm, coll, mat("Wood_Dark")))

    finish(bev_all, width=0.014)
    ship(coll, name, parts)


build("wrecker_tower")
print("WRECKER SCENE DONE")
