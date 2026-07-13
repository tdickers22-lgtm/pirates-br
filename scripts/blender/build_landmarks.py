# Island landmark assets — fidelity pass.
#   watchtower       stone-base + timber-frame lookout, ladder, brazier ember
#   shipwreck        broken hull, exposed ribs, strakes, stub mast + torn sail
#   standing_stones  leaning rune monolith circle w/ gold inlay + moss
#   lantern_post     dock/camp lantern (kept, re-exported with AO)
# Origins at ground center (shipwreck: waterline center). Forward = -Y.
# Headless: Blender -b -P scripts/blender/build_landmarks.py
# Set PBR_RENDER_DIR to also write turntable renders.
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
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)  # scratch override for test rounds

clear_default_scene()


# ── local structural helpers ─────────────────────────────────
def sub_box(w, d, h, cuts=0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts,
                                  use_grid_fill=True)
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    return bm


def beam(coll, name, p1, p2, r1, r2, material, segs=7, smooth=True):
    """Tapered cylinder member between two points."""
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, d.length + 0.02, segs=segs)
    quat = d.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p1 + p2) / 2) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def box_beam(coll, name, p1, p2, w, d, material, roll=0.0):
    """Rectangular member between two points (w across, d deep)."""
    p1, p2 = Vector(p1), Vector(p2)
    dd = p2 - p1
    bm = bm_box(w, d, dd.length + 0.02)
    if roll:
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(roll, 4, 'Z'), verts=bm.verts)
    quat = dd.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p1 + p2) / 2) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material)


def rope_cat(coll, name, p1, p2, sag, r=0.022, segs=8):
    """Catenary-sagged rope as a chain of small cylinders."""
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


def finish(objs, width=0.02, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


def ship_and_export(coll, name, obj):
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR)
    # keep the scene clean for the next asset's render
    for o in coll.objects:
        o.hide_render = True
    print(f"built {name}")


# ═════════════════════════════════════════════════════════════
# WATCHTOWER — stone base courses + leaning timber lookout frame
# footprint r ~3.6 (was 3.83), height ~11.4 (was 11.1)
# ═════════════════════════════════════════════════════════════
def build_watchtower(name="watchtower"):
    coll = asset_collection(name)
    rng = random.Random(42)
    stone, dark = mat("Rock_Grey"), mat("Rock_Dark")
    wd, wb = mat("Wood_Dark"), mat("Wood_Bleached")
    parts, bev, bev_fine = [], [], []
    LEAN = 0.32                      # timber frame lean (+X) for silhouette
    BASE_H = 3.4

    # ── stone base drum ──
    bm = bm_cylinder(2.02, 1.70, BASE_H, segs=16)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, BASE_H / 2)), verts=bm.verts)
    drum = obj_from_bmesh(f"{name}_drum", bm, coll, stone)
    displace_noise(drum, strength=0.10, scale=0.9, seed=42)
    apply_modifiers(drum)
    parts.append(drum)

    # ── block courses (greebles) ──
    for ci, cz in enumerate((0.34, 1.02, 1.72, 2.40, 3.02)):
        t = cz / BASE_H
        ring_r = 2.02 + (1.70 - 2.02) * t - 0.02
        n = 13
        for k in range(n):
            if rng.random() < 0.28:
                continue
            a = 2 * math.pi * (k + (ci % 2) * 0.5) / n
            bm = bm_box(0.74 * rng.uniform(0.85, 1.1), 0.40,
                        0.56 * rng.uniform(0.85, 1.05))
            rot = Matrix.Rotation(a + math.pi / 2, 4, 'Z')
            pos = Vector((ring_r * math.cos(a), ring_r * math.sin(a),
                          cz + rng.uniform(-0.03, 0.03)))
            bmesh.ops.transform(bm, matrix=Matrix.Translation(pos) @ rot, verts=bm.verts)
            o = obj_from_bmesh(f"{name}_blk{ci}_{k}", bm, coll,
                               dark if (k + ci) % 3 == 0 else stone)
            parts.append(o)
            bev.append(o)
    # cap ring on the base top
    for k in range(12):
        a = 2 * math.pi * k / 12
        bm = bm_box(0.85, 0.5, 0.3)
        rot = Matrix.Rotation(a + math.pi / 2, 4, 'Z')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (1.68 * math.cos(a), 1.68 * math.sin(a), BASE_H + 0.05)) @ rot, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_cap{k}", bm, coll, dark if k % 4 == 0 else stone)
        parts.append(o)
        bev.append(o)

    # ── doorway (front, -Y) ──
    bm = bm_box(1.3, 0.7, 2.3)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -1.78, 1.15)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_door", bm, coll, mat("Char_Black")))
    o = box_beam(coll, f"{name}_lintel", (-0.95, -1.9, 2.42), (0.95, -1.9, 2.42), 0.5, 0.42, dark)
    parts.append(o); bev.append(o)
    for sx in (-1, 1):  # jamb stones
        bm = bm_box(0.42, 0.5, 2.3)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((sx * 0.85, -1.86, 1.15)), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_jamb{sx}", bm, coll, stone)
        parts.append(o); bev.append(o)

    # ── window + weathered shutters (front-left of base) ──
    wa = math.radians(238)
    wx, wy = 1.86 * math.cos(wa), 1.86 * math.sin(wa)
    wrot = Matrix.Rotation(wa + math.pi / 2, 4, 'Z')
    bm = bm_box(0.5, 0.3, 0.68)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((wx, wy, 2.35)) @ wrot, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_win", bm, coll, mat("Char_Black")))
    for si, sx in enumerate((-1, 1)):
        bm = bm_box(0.27, 0.05, 0.64)
        askew = Matrix.Rotation(-0.28 if si == 0 else 0.0, 4, 'Y')
        off = Vector((sx * 0.40, -0.08, -0.14 if si == 0 else 0))
        bmesh.ops.transform(bm, matrix=Matrix.Translation((wx, wy, 2.35)) @ wrot @
                            Matrix.Translation(off) @ askew, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_shut{si}", bm, coll, wb)
        parts.append(o); bev_fine.append(o)

    # ── timber frame ──
    z1, z2 = 3.1, 7.95
    def post_at(sx, sy, z):
        t = (z - z1) / (z2 - z1)
        b = 1.15 + (0.95 - 1.15) * t
        return Vector((sx * b + LEAN * t, sy * b, z))
    corners = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    for i, (sx, sy) in enumerate(corners):
        o = beam(coll, f"{name}_post{i}", post_at(sx, sy, z1), post_at(sx, sy, z2 + 0.15),
                 0.14, 0.11, wd if i % 2 else wb, segs=8)
        parts.append(o); bev_fine.append(o)
    # ring beams
    for zz in (5.5, 7.85):
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            o = box_beam(coll, f"{name}_ring{zz:.0f}_{i}", post_at(*a, zz), post_at(*b, zz),
                         0.16, 0.20, wd)
            parts.append(o); bev_fine.append(o)
    # cross braces (X pattern), one snapped for wear
    lv = [(3.45, 5.4), (5.7, 7.8)]
    for li, (za, zb) in enumerate(lv):
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            for d, (p, q) in enumerate(((a, b), (b, a))):
                if li == 0 and i == 0 and d == 0:
                    # SNAPPED brace: stub from the lower joint + fallen half
                    pa, pb = post_at(*p, za), post_at(*q, zb)
                    stub_end = pa.lerp(pb, 0.42)
                    o = beam(coll, f"{name}_snap_stub", pa, stub_end, 0.07, 0.02, wb, segs=6)
                    parts.append(o)
                    o = beam(coll, f"{name}_snap_fall", (2.35, 1.15, 0.06),
                             (1.35, 0.72, 2.9), 0.065, 0.025, wb, segs=6)
                    parts.append(o)
                    continue
                o = beam(coll, f"{name}_brace{li}{i}{d}", post_at(*p, za), post_at(*q, zb),
                         0.07, 0.07, wb if (i + d) % 2 else wd, segs=6)
                parts.append(o)

    # ── ladder (front face) ──
    lb, lt = Vector((0.62, -1.92, 0.04)), Vector((0.95, -1.32, 8.25))
    ldir = (lt - lb).normalized()
    side = Vector((1, 0, 0)) * 0.27
    for s in (-1, 1):
        o = beam(coll, f"{name}_lrail{s}", lb + side * s, lt + side * s, 0.05, 0.045, wd, segs=6)
        parts.append(o)
    nr = 13
    for i in range(1, nr + 1):
        p = lb.lerp(lt, i / (nr + 1))
        bm = bm_cylinder(0.034, 0.034, 0.62, segs=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p) @
                            Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_rung{i}", bm, coll, wb, smooth=True))

    # ── plank platform + rail ──
    deck_z = 8.02
    ny = 9
    for i in range(ny):
        y = -1.6 + 3.2 * i / (ny - 1)
        ln = 3.4 if i != 3 else 2.1          # one short plank = gap hole
        bm = bm_box(ln, 0.335, 0.09)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (LEAN + (0.6 if i == 3 else 0) + rng.uniform(-0.04, 0.04), y,
             deck_z + rng.uniform(-0.012, 0.012))), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_deck{i}", bm, coll, wb if i % 2 else wd)
        parts.append(o); bev_fine.append(o)
    # rim joists
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        pa = Vector((a[0] * 1.68 + LEAN, a[1] * 1.68, deck_z - 0.12))
        pb = Vector((b[0] * 1.68 + LEAN, b[1] * 1.68, deck_z - 0.12))
        o = box_beam(coll, f"{name}_rim{i}", pa, pb, 0.14, 0.22, wd)
        parts.append(o); bev_fine.append(o)
    # rail posts + rails (rail on +X side broken)
    rp = {}
    for i, (sx, sy) in enumerate(corners):
        p = Vector((sx * 1.62 + LEAN, sy * 1.62, deck_z + 0.05))
        rp[i] = p
        o = box_beam(coll, f"{name}_rpost{i}", p, p + Vector((0, 0, 0.95)), 0.09, 0.09, wd)
        parts.append(o); bev_fine.append(o)
    for i in range(4):
        a, b = rp[i] + Vector((0, 0, 0.92)), rp[(i + 1) % 4] + Vector((0, 0, 0.92))
        if i == 3:  # broken side: two sagging stubs
            o = beam(coll, f"{name}_railb0", a, a.lerp(b, 0.3) - Vector((0, 0, 0.35)),
                     0.045, 0.02, wb, segs=5)
            parts.append(o)
            o = beam(coll, f"{name}_railb1", b, b.lerp(a, 0.22) - Vector((0, 0, 0.28)),
                     0.045, 0.02, wb, segs=5)
            parts.append(o)
            continue
        o = box_beam(coll, f"{name}_rail{i}", a, b, 0.07, 0.1, wb)
        parts.append(o); bev_fine.append(o)
        mid = box_beam(coll, f"{name}_railm{i}", a - Vector((0, 0, 0.45)),
                       b - Vector((0, 0, 0.45)), 0.05, 0.07, wd)
        parts.append(mid)

    # ── roof canopy ──
    for i, (sx, sy) in enumerate(corners):
        p = Vector((sx * 0.88 + LEAN, sy * 0.88, deck_z + 0.05))
        q = Vector((sx * 0.74 + LEAN + 0.08, sy * 0.74, 10.15))
        o = beam(coll, f"{name}_roofpost{i}", p, q, 0.075, 0.06, wd, segs=6)
        parts.append(o)
    bm = bm_cylinder(1.85, 0.05, 1.45, segs=4)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((LEAN + 0.08, 0, 10.72)) @
                        Matrix.Rotation(math.pi / 4, 4, 'Z'), verts=bm.verts)
    roof = obj_from_bmesh(f"{name}_roof", bm, coll, wd)
    parts.append(roof); bev_fine.append(roof)
    # snapped old flag post leaning off one corner
    o = beam(coll, f"{name}_flagsnag", (-1.35 + LEAN, -1.5, deck_z),
             (-1.95 + LEAN, -1.85, 10.4), 0.055, 0.02, wd, segs=6)
    parts.append(o)

    # ── brazier with ember (on the platform) ──
    bz = Vector((LEAN - 0.55, 0.55, deck_z + 0.05))
    for i in range(3):
        a = 2 * math.pi * i / 3 + 0.4
        o = beam(coll, f"{name}_bleg{i}", bz + Vector((0.26 * math.cos(a), 0.26 * math.sin(a), 0)),
                 bz + Vector((0, 0, 0.42)), 0.03, 0.025, mat("Char_Black"), segs=5)
        parts.append(o)
    bm = bm_cylinder(0.34, 0.22, 0.28, segs=10)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(bz + Vector((0, 0, 0.52))), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_bowl", bm, coll, mat("Char_Black"), smooth=True)
    parts.append(o); bev_fine.append(o)
    for i in range(3):  # coals
        bm = bm_icosphere(0.09, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            bz + Vector((rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), 0.66))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_coal{i}", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_icosphere(0.20, 2)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(bz + Vector((0, 0, 0.72))), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_ember", bm, coll, mat("Lantern_Glass"), smooth=True))

    # ── rubble skirt (collapsed corner, +X biased) ──
    for k in range(9):
        a = rng.uniform(-1.1, 1.1)
        d = rng.uniform(2.2, 3.45)
        bm = bm_icosphere(rng.uniform(0.28, 0.62), 2)
        bmesh.ops.scale(bm, vec=Vector((1.35, 1.0, 0.55)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (d * math.cos(a), d * math.sin(a), 0.12)) @
            Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_rub{k}", bm, coll, stone if k % 2 else dark, smooth=True)
        displace_noise(o, strength=0.10, scale=0.6, seed=50 + k)
        apply_modifiers(o)
        parts.append(o)

    finish(bev, width=0.035)
    finish(bev_fine, width=0.018)
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return coll, obj


# ═════════════════════════════════════════════════════════════
# SHIPWRECK — broken hull, exposed ribs toward -Y, strakes, sail
# footprint ~11.6 x 5.4, height ~4.7 (was 11.3 x 4.4, h 4.07)
# ═════════════════════════════════════════════════════════════
def build_shipwreck(name="shipwreck"):
    coll = asset_collection(name)
    rng = random.Random(7)
    wb, wd, wm = mat("Wood_Bleached"), mat("Wood_Dark"), mat("Wood_Mid")
    parts, bev = [], []
    L, W, Hh = 11.0, 4.2, 3.0

    def taper(x):
        return 1.0 - 0.55 * (abs(x) / (L / 2)) ** 1.6

    def hull_pt(x, ang, side):
        """Point on the hull surface: ang 0 = keel, pi/2 = sheer."""
        tp = taper(x)
        y = side * (W / 2) * tp * math.sin(ang)
        z = 0.42 + Hh * tp * (1 - math.cos(ang))
        return Vector((x, y, z))

    # ── keel with rocker + keelson ──
    kx = [-5.5 + 11.0 * i / 5 for i in range(6)]
    for i in range(5):
        p1 = Vector((kx[i], 0, 0.26 + 0.5 * (abs(kx[i]) / 5.5) ** 2))
        p2 = Vector((kx[i + 1], 0, 0.26 + 0.5 * (abs(kx[i + 1]) / 5.5) ** 2))
        o = box_beam(coll, f"{name}_keel{i}", p1, p2, 0.34, 0.5, wd)
        parts.append(o); bev.append(o)
    # stem post + bowsprit (bow = -X)
    o = box_beam(coll, f"{name}_stem", (-5.5, 0, 0.4), (-6.0, 0, 2.7), 0.3, 0.4, wd)
    parts.append(o); bev.append(o)
    o = beam(coll, f"{name}_bowsprit", (-5.7, 0, 2.5), (-6.42, 0, 3.55), 0.11, 0.05, wd, segs=7)
    parts.append(o)
    # transom (stern = +X): vertical slats
    for i in range(5):
        y = -0.9 + 1.8 * i / 4
        bm = bm_box(0.4, 0.09, 1.9 - 0.5 * abs(y))
        bmesh.ops.transform(bm, matrix=Matrix.Translation((5.35, y, 1.55)) @
                            Matrix.Rotation(-0.18, 4, 'Y'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_trans{i}", bm, coll, wd if i % 2 else wm)
        parts.append(o); bev.append(o)

    # ── ribs (curved frames from box segments; unbroken ones curl inward) ──
    nribs = 10
    nseg = 9
    for i in range(nribs):
        x = -4.8 + 9.9 * i / (nribs - 1)
        for side in (-1, 1):
            # exposed side (-Y, faces the player): bow-half ribs snapped short
            broken = (side == -1 and x < 0.6 and rng.random() < 0.8) or rng.random() < 0.12
            top_ang = (math.radians(rng.uniform(32, 80)) if broken
                       else math.radians(rng.uniform(96, 105)))
            n = max(2, int(nseg * top_ang / (math.pi / 2) + 0.5))
            for s in range(n):
                a1 = top_ang * s / n
                a2 = top_ang * (s + 1) / n
                p1, p2 = hull_pt(x, a1, side), hull_pt(x, a2, side)
                o = box_beam(coll, f"{name}_rib{i}{'p' if side < 0 else 's'}{s}",
                             p1, p2, 0.13, 0.22, wb if (i + s) % 4 else wm)
                parts.append(o); bev.append(o)
            if broken:
                tip = hull_pt(x, top_ang, side)
                d = (hull_pt(x, top_ang + 0.2, side) - tip)
                o = beam(coll, f"{name}_ribsp{i}{side}", tip, tip + d.normalized() * 0.38,
                         0.055, 0.008, wb, segs=5)
                parts.append(o)

    # ── hull strakes (planking) ──
    def strakes(side, angs, x_lo_fn):
        for si, ang in enumerate(angs):
            x_lo = x_lo_fn(si, ang)
            x_hi = 5.3
            nsp = max(2, int((x_hi - x_lo) / 1.7))
            for sp in range(nsp):
                xa = x_lo + (x_hi - x_lo) * sp / nsp
                xb = x_lo + (x_hi - x_lo) * (sp + 1) / nsp
                pa, pb = hull_pt(xa, ang, side), hull_pt(xb, ang, side)
                out = Vector((0, side * math.sin(ang), -math.cos(ang))).normalized()
                pa += out * 0.14
                pb += out * 0.14
                roll = math.atan2(math.cos(ang) * side, math.sin(ang)) * 0.9
                o = box_beam(coll, f"{name}_st{'p' if side < 0 else 's'}{si}_{sp}",
                             pa, pb, 0.09, 0.46 if si < 3 else 0.38,
                             wb if si % 2 else wd, roll=roll)
                parts.append(o); bev.append(o)
            # splintered broken end at the bow-most tip
            tip = hull_pt(x_lo, ang, side) + Vector((0, side * math.sin(ang), -math.cos(ang))) * 0.14
            o = beam(coll, f"{name}_stsp{'p' if side < 0 else 's'}{si}",
                     tip, tip + Vector((-0.42, side * 0.06, 0.1)), 0.05, 0.006, wb, segs=5)
            parts.append(o)
    angs = [0.14 + i * 0.19 for i in range(7)]
    # +Y side: mostly intact, upper strakes broken back further
    strakes(1, angs, lambda si, a: -4.9 + si * 0.95 + rng.uniform(0, 0.5))
    # -Y (exposed) side: bilge planked full length, above only stern half
    strakes(-1, angs[:5], lambda si, a: (-4.6 + rng.uniform(0, 0.4)) if si < 2
            else 0.4 + si * 0.7 + rng.uniform(0, 0.6))

    # ── stern deck ──
    for i in range(3):
        x = 2.0 + i * 1.5
        tp = taper(x)
        o = box_beam(coll, f"{name}_dbeam{i}", (x, -(W / 2) * tp * 0.92, 2.30),
                     (x, (W / 2) * tp * 0.92, 2.30), 0.14, 0.18, wd)
        parts.append(o); bev.append(o)
    for i in range(6):
        y = -1.25 + 2.5 * i / 5
        if i == 2:
            continue  # missing plank
        ln = 3.2 * (1 - abs(y) * 0.12)
        bm = bm_box(ln, 0.36, 0.07)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (3.4 + rng.uniform(-0.2, 0.2), y, 2.44 + rng.uniform(-0.015, 0.015))), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_deck{i}", bm, coll, wm if i % 2 else wb)
        parts.append(o); bev.append(o)

    # ── stub mast + yard + torn sail ──
    mbase, mtop = Vector((2.8, 0.15, 2.2)), Vector((2.25, 0.85, 4.30))
    o = beam(coll, f"{name}_mast", mbase, mtop, 0.20, 0.10, wd, segs=10)
    parts.append(o)
    o = beam(coll, f"{name}_mastsp", mtop, mtop + Vector((-0.10, 0.15, 0.24)),
             0.08, 0.008, wd, segs=5)  # splintered mast tip
    parts.append(o)
    ya, yb = Vector((1.05, -1.55, 4.0)), Vector((3.9, 1.35, 3.45))
    o = beam(coll, f"{name}_yard", ya, yb, 0.09, 0.07, wd, segs=7)
    parts.append(o)
    # sail: subdivided cloth hanging from the yard, ragged hem + wave
    bm = bmesh.new()
    nu, nv = 12, 8
    drop = 1.9
    hem = [0.55 + 0.45 * abs(math.sin(u * 2.3 + 1)) for u in range(nu + 1)]
    hem[3], hem[4] = 0.30, 0.38   # bite notch
    hem[9] = 0.34                 # second notch
    grid = {}
    for iu in range(nu + 1):
        u = iu / nu
        pu = ya.lerp(yb, 0.08 + 0.84 * u)
        for iv in range(nv + 1):
            v = iv / nv
            bulge = math.sin(v * math.pi) * (0.28 + 0.1 * math.sin(u * math.pi * 2))
            wave = 0.06 * math.sin(u * 9 + v * 5) * v
            p = pu + Vector((bulge * 0.4 + wave, -bulge, -v * drop))
            grid[(iu, iv)] = bm.verts.new(p)
    for iu in range(nu):
        for iv in range(nv):
            v_edge = (iv + 1) / nv
            if v_edge > min(hem[iu], hem[iu + 1]):
                continue
            bm.faces.new((grid[(iu, iv)], grid[(iu + 1, iv)],
                          grid[(iu + 1, iv + 1)], grid[(iu, iv + 1)]))
    sail = obj_from_bmesh(f"{name}_sail", bm, coll, mat("Canvas_Dirty"), smooth=True)
    sol = sail.modifiers.new("Solid", 'SOLIDIFY')
    sol.thickness = 0.02
    apply_modifiers(sail)
    parts.append(sail)

    # ── ropes ──
    parts += rope_cat(coll, f"{name}_rope0", (-6.42, 0, 3.5), (-5.4, 0, 0.6), 0.18)
    parts += rope_cat(coll, f"{name}_rope1", yb, (4.7, 1.0, 2.5), 0.22)
    parts += rope_cat(coll, f"{name}_rope2", mtop, (1.4, -1.75, 2.4), 0.35)

    # ── scattered cargo triad (clustered against the exposed side, seated) ──
    # z pre-compensates the final list rotation so cargo seats ~4cm into sand.
    # barrel (tipped, leaning on the crate)
    bpos = Vector((3.15, -2.35, 0.62))
    brot = Matrix.Rotation(math.pi / 2 - 0.18, 4, 'X') @ Matrix.Rotation(0.65, 4, 'Z')
    bm = bm_cylinder(0.36, 0.36, 0.78, segs=12)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(bpos) @ brot, verts=bm.verts)
    o = obj_from_bmesh(f"{name}_barrel", bm, coll, wm, smooth=True)
    parts.append(o); bev.append(o)
    for bz in (-0.26, 0.26):
        bm = bm_cylinder(0.385, 0.385, 0.07, segs=12)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(bpos) @ brot @
                            Matrix.Translation((0, 0, bz)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_hoop{bz:.1f}", bm, coll,
                                    mat("Metal_Band"), smooth=True))
    # crate (rotated off-axis, touching the barrel)
    cpos = Vector((2.45, -2.40, 0.58))
    crot = Matrix.Rotation(0.35, 4, 'Z') @ Matrix.Rotation(0.06, 4, 'X')
    bm = bm_box(0.62, 0.62, 0.62)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(cpos) @ crot, verts=bm.verts)
    o = obj_from_bmesh(f"{name}_crate", bm, coll, wm)
    parts.append(o); bev.append(o)
    for e in range(4):
        a = e * math.pi / 2 + math.pi / 4
        bm = bm_box(0.07, 0.07, 0.66)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(cpos) @ crot @
                            Matrix.Translation((0.31 * math.cos(a) * 1.414 * 0.5,
                                                0.31 * math.sin(a) * 1.414 * 0.5, 0)) @
                            Matrix.Rotation(a, 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_cedge{e}", bm, coll, wd)
        parts.append(o)
    # small keg leaning against the crate
    bm = bm_cylinder(0.22, 0.25, 0.42, segs=10)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((2.95, -1.90, 0.42)) @
                        Matrix.Rotation(0.22, 4, 'Y'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_keg", bm, coll, wd, smooth=True)
    parts.append(o); bev.append(o)

    finish(bev, width=0.022)
    obj = join(parts, name)
    # settle with a list toward the exposed side
    obj.rotation_euler = (0.12, 0.0, 0.0)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(rotation=True)
    ship_and_export(coll, name, obj)
    return coll, obj


# ═════════════════════════════════════════════════════════════
# STANDING STONES — leaning rune monoliths, gold inlay, moss
# footprint r ~3.55 (was 3.5), height ~3.35 (was 3.08)
# ═════════════════════════════════════════════════════════════
def build_standing_stones(name="standing_stones"):
    coll = asset_collection(name)
    rng = random.Random(13)
    parts, bev = [], []

    def stone_bm(w, d, h, taper, srng):
        bm = sub_box(w, d, h, cuts=3)
        for v in bm.verts:
            tz = v.co.z / h + 0.5
            if taper > 0 and tz > 0.35:
                f = 1.0 - taper * (tz - 0.35) / 0.65
                v.co.x *= f
                v.co.y *= f
            jx = (srng.random() - 0.5) * 0.10
            jy = (srng.random() - 0.5) * 0.10
            jz = (srng.random() - 0.5) * 0.07
            # keep the front (-Y) rune face planar-ish: jitter inward only
            if v.co.y < -0.4 * d * (1.0 - (taper * (tz - 0.35) / 0.65 if taper > 0 and tz > 0.35 else 0)):
                jy = abs(jy) * 0.5
            v.co += Vector((jx, jy, jz))
        return bm

    def face_y(d, h, z_local, taper):
        tz = z_local / h + 0.5
        f = 1.0 - (taper * (tz - 0.35) / 0.65 if taper > 0 and tz > 0.35 else 0.0)
        return -(d / 2) * f

    specs = [
        # w, d, h, taper
        (1.00, 0.62, 3.35, 0.42),
        (1.30, 0.72, 2.25, 0.10),
        (0.85, 0.52, 2.95, 0.35),
        (1.10, 0.66, 2.60, 0.20),
        (0.92, 0.55, 3.10, 0.48),
        (1.22, 0.62, 2.05, 0.05),
    ]
    n = len(specs)
    for k, (w, d, h, taper) in enumerate(specs):
        srng = random.Random(100 + k)
        a = 2 * math.pi * k / n
        M = (Matrix.Translation((2.9 * math.cos(a), 2.9 * math.sin(a), h / 2 - 0.08)) @
             Matrix.Rotation(a + math.pi / 2 + srng.uniform(-0.25, 0.25), 4, 'Z') @
             Matrix.Rotation(srng.uniform(-0.16, 0.16), 4, 'X') @
             Matrix.Rotation(srng.uniform(-0.14, 0.14), 4, 'Y'))
        bm = stone_bm(w, d, h, taper, srng)
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_m{k}", bm, coll,
                           mat("Rock_Grey") if k % 3 == 2 else mat("Rock_Dark"))
        parts.append(o); bev.append(o)
        # rune glyphs on the front face: groove (dark) + gold inlay bars
        ng = srng.randint(3, 5)
        for g in range(ng):
            gz = h * (-0.20 + 0.54 * g / max(1, ng - 1))
            tzg = gz / h + 0.5
            fw = 1.0 - (taper * (tzg - 0.35) / 0.65 if taper > 0 and tzg > 0.35 else 0.0)
            gx = srng.uniform(-w * 0.22, w * 0.22) * fw
            fy = face_y(d, h, gz, taper)
            nbars = srng.randint(2, 3)
            for b in range(nbars):
                rot = srng.choice((0.0, 0.55, -0.55, 1.2))
                glen = srng.uniform(0.16, 0.34) * (fw if abs(rot) > 0.9 else 1.0)
                ry = Matrix.Rotation(rot, 4, 'Y')
                gold = srng.random() < 0.55
                # groove backing
                bm = bm_box(0.10, 0.035, glen + 0.06)
                bmesh.ops.transform(bm, matrix=M @ Matrix.Translation(
                    (gx + b * 0.09 - 0.09, fy - 0.012, gz)) @ ry, verts=bm.verts)
                parts.append(obj_from_bmesh(f"{name}_gr{k}_{g}_{b}", bm, coll,
                                            mat("Char_Black")))
                if gold:
                    bm = bm_box(0.045, 0.05, glen)
                    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation(
                        (gx + b * 0.09 - 0.09, fy - 0.022, gz)) @ ry, verts=bm.verts)
                    parts.append(obj_from_bmesh(f"{name}_au{k}_{g}_{b}", bm, coll,
                                                mat("Gold")))
        # moss patches: one hugging the crown, one at the shaded base
        f_top = 1.0 - taper
        for mi in range(2):
            bm = bm_icosphere(srng.uniform(0.13, 0.22), 1)
            bmesh.ops.scale(bm, vec=Vector((1.5, 1.1, 0.30)), verts=bm.verts)
            if mi == 0:
                lp = Vector((srng.uniform(-0.25, 0.25) * w * f_top, 0, h / 2 - 0.02))
            else:
                lp = Vector((srng.uniform(-0.3, 0.3) * w, d * 0.30, -h / 2 + 0.10))
            bmesh.ops.transform(bm, matrix=M @ Matrix.Translation(lp), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_moss{k}_{mi}", bm, coll,
                                        mat("Leaf_Green"), smooth=True))

    # fallen slab, rune face up
    srng = random.Random(200)
    w, d, h = 0.95, 0.55, 2.9
    M = (Matrix.Translation((0.55, 0.35, d / 2 + 0.02)) @
         Matrix.Rotation(0.5, 4, 'Z') @ Matrix.Rotation(-math.pi / 2, 4, 'X'))
    bm = stone_bm(w, d, h, 0.25, srng)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    o = obj_from_bmesh(f"{name}_fallen", bm, coll, mat("Rock_Dark"))
    parts.append(o); bev.append(o)
    for g in range(4):
        gz = h * (-0.3 + 0.6 * g / 3)
        fy = face_y(d, h, gz, 0.25)
        glen = srng.uniform(0.18, 0.3)
        bm = bm_box(0.10, 0.035, glen + 0.06)
        bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((srng.uniform(-0.2, 0.2), fy - 0.012, gz)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_fgr{g}", bm, coll, mat("Char_Black")))
        if g % 2 == 0:
            bm = bm_box(0.045, 0.05, glen)
            bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((srng.uniform(-0.2, 0.2), fy - 0.022, gz)),
                                verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_fau{g}", bm, coll, mat("Gold")))
    # moss hugging the fallen slab's top face
    bm = bm_icosphere(0.22, 1)
    bmesh.ops.scale(bm, vec=Vector((1.6, 1.1, 0.28)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.31, 0.79, d + 0.02)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_fmoss", bm, coll, mat("Leaf_Green"), smooth=True))

    # gold hoard tease at the center: low coin mound + loose coins
    bm = bm_icosphere(0.17, 1)
    bmesh.ops.scale(bm, vec=Vector((1.35, 1.25, 0.42)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.6, 0.05)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_gold", bm, coll, mat("Gold"), smooth=True))
    for c in range(6):
        bm = bm_cylinder(0.05, 0.05, 0.018, segs=8)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (rng.uniform(-0.45, 0.45), -0.6 + rng.uniform(-0.4, 0.4), 0.012)) @
            Matrix.Rotation(rng.uniform(-0.35, 0.35), 4, 'X'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_coin{c}", bm, coll, mat("Gold"), smooth=True))

    finish(bev, width=0.03)
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return coll, obj


# ═════════════════════════════════════════════════════════════
# LANTERN POST — kept design, beveled + AO re-export
# ═════════════════════════════════════════════════════════════
def build_lantern_post(name="lantern_post"):
    coll = asset_collection(name)
    parts, bev = [], []
    bm = bm_cylinder(0.09, 0.07, 2.3, segs=8)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 1.15)) @
                        Matrix.Rotation(0.05, 4, 'X'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_post", bm, coll, mat("Wood_Dark"), smooth=True)
    parts.append(o); bev.append(o)
    bm = bm_box(0.7, 0.08, 0.08)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.3, 0, 2.25)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_arm", bm, coll, mat("Wood_Dark"))
    parts.append(o); bev.append(o)
    # small angled knee brace under the arm
    o = box_beam(coll, f"{name}_knee", (0.06, 0, 1.95), (0.42, 0, 2.2), 0.05, 0.05, mat("Wood_Dark"))
    parts.append(o); bev.append(o)
    bm = bm_box(0.22, 0.22, 0.3)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.62, 0, 2.0)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_cage", bm, coll, mat("Metal_Iron"))
    parts.append(o); bev.append(o)
    bm = bm_box(0.15, 0.15, 0.2)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.62, 0, 2.0)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_glass", bm, coll, mat("Lantern_Glass")))
    bm = bm_cylinder(0.05, 0.09, 0.09, segs=8)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.62, 0, 2.2)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_cap", bm, coll, mat("Metal_Iron"), smooth=True))
    finish(bev, width=0.012)
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return coll, obj


build_watchtower()
build_shipwreck()
build_standing_stones()
build_lantern_post()
print("LANDMARKS DONE")
