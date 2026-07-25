# MINE HEAD — Old Maw Caldera hero scene: the mountain kept it.
# Timber mine PORTAL frame set into a carved rock-face chunk (works against any
# slope; the opening goes dark 2m in), beams charred at the top, iron-banded
# ore cart on a short wooden rail stub, crates of glossy obsidian chunks,
# dropped pick + unlit lantern, cracked hanging warning sign, collapsed support
# pile, small empty offering cage (door open) — volcano superstition.
# Focal: the dark portal mouth. Portal faces Blender -Y.
# Headless: Blender -b -P scripts/blender/build_scene_minehead.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

EXTRA = {
    "Obsidian": ((0.05, 0.05, 0.07, 1.0), 0.25, 0.15),
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


def charred_beam(coll, name, w, d, h, M, char_frac=0.4, rng=None,
                 wood="Wood_Dark"):
    """Timber beam charred at the TOP: lower part wood, upper part char,
    upper end slightly eroded. Local: beam along +Z, base at z=0."""
    parts = []
    hw = h * (1.0 - char_frac)
    bm = bm_box(w, d, hw)
    bm_bevel(bm, min(w, d) * 0.14)
    placedM(bm, M @ Matrix.Translation((0, 0, hw * 0.5)))
    parts.append(obj_from_bmesh(name + "_wood", bm, coll, mat(wood)))
    hc = h * char_frac
    bm = bm_box(w * 0.94, d * 0.94, hc)
    # erode / crumble the charred top
    r = rng or random
    for v in bm.verts:
        if v.co.z > 0:
            v.co.x *= r.uniform(0.7, 0.95)
            v.co.y *= r.uniform(0.7, 0.95)
            v.co.z += r.uniform(-hc * 0.12, 0.0)
    bm_bevel(bm, min(w, d) * 0.10)
    placedM(bm, M @ Matrix.Translation((0, 0, hw + hc * 0.5)))
    parts.append(obj_from_bmesh(name + "_char", bm, coll, mat("Char_Black")))
    return parts


def obsidian_chunk(coll, name, loc, r, seed, yaw=0.0):
    bm = bm_icosphere(r, 3)
    rr = random.Random(seed)
    for v in bm.verts:
        v.co *= rr.uniform(0.7, 1.25)
        v.co.z *= rr.uniform(0.75, 1.0)
    placed(bm, loc, rz=yaw)
    return obj_from_bmesh(name, bm, coll, mat("Obsidian"))  # flat = faceted glass


def crate(coll, name, loc, w, d, h, yaw, open_top=True, rng=None):
    parts = []
    M = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
    t = 0.035
    walls = [((0, -d / 2 + t / 2, h / 2), (w, t, h)),
             ((0, d / 2 - t / 2, h / 2), (w, t, h)),
             ((-w / 2 + t / 2, 0, h / 2), (t, d - 2 * t, h)),
             ((w / 2 - t / 2, 0, h / 2), (t, d - 2 * t, h)),
             ((0, 0, t / 2), (w - 2 * t, d - 2 * t, t))]
    for i, (p, s) in enumerate(walls):
        bm = bm_box(*s)
        bm_bevel(bm, 0.012)
        placedM(bm, M @ Matrix.Translation(p))
        parts.append(obj_from_bmesh(f"{name}_w{i}", bm, coll, mat("Wood_Mid")))
    # corner posts + rim
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bm_box(0.05, 0.05, h + 0.02)
            bm_bevel(bm, 0.012)
            placedM(bm, M @ Matrix.Translation((sx * (w / 2 - 0.02),
                                                sy * (d / 2 - 0.02), h / 2)))
            parts.append(obj_from_bmesh(f"{name}_c{sx}{sy}", bm, coll, mat("Wood_Dark")))
    return parts


def lantern(coll, name, loc, tipped=True):
    """Dropped, UNLIT lantern — dark glass (Obsidian), no emissive."""
    parts = []
    M = Matrix.Translation(Vector(loc))
    if tipped:
        M = (M @ Matrix.Rotation(0.7, 4, 'Z') @ Matrix.Translation((0, 0, 0.10))
             @ Matrix.Rotation(math.radians(84), 4, 'X')
             @ Matrix.Translation((0, 0, -0.10)))
    base = bm_cylinder(0.075, 0.085, 0.03, segs=10)
    placedM(base, M @ Matrix.Translation((0, 0, 0.015)))
    parts.append(obj_from_bmesh(name + "_base", base, coll, mat("Metal_Iron"), smooth=True))
    glass = bm_cylinder(0.062, 0.052, 0.13, segs=10)
    placedM(glass, M @ Matrix.Translation((0, 0, 0.10)))
    parts.append(obj_from_bmesh(name + "_glass", glass, coll, mat("Obsidian"), smooth=True))
    for k in range(4):
        a = k * math.tau / 4
        bar = bm_cylinder(0.008, 0.008, 0.13, segs=6)
        placedM(bar, M @ Matrix.Translation((math.cos(a) * 0.068,
                                             math.sin(a) * 0.068, 0.10)))
        parts.append(obj_from_bmesh(f"{name}_bar{k}", bar, coll,
                                    mat("Metal_Iron"), smooth=True))
    cap = bm_cylinder(0.085, 0.02, 0.06, segs=10)
    placedM(cap, M @ Matrix.Translation((0, 0, 0.195)))
    parts.append(obj_from_bmesh(name + "_cap", cap, coll, mat("Metal_Iron"), smooth=True))
    ring = bm_cylinder(0.035, 0.035, 0.014, segs=8, cap=False)
    placedM(ring, M @ Matrix.Translation((0, 0, 0.25)) @ Matrix.Rotation(1.2, 4, 'X'))
    o = obj_from_bmesh(name + "_ring", ring, coll, mat("Metal_Iron"), smooth=True)
    s = o.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = 0.01
    apply_modifiers(o)
    parts.append(o)
    return parts


def build_minehead(name="mine_head"):
    clear_default_scene()
    coll = asset_collection(name)
    rng = random.Random(9)
    parts = []
    FY = -1.7          # portal front plane y

    # ── carved rock mass the portal backs onto (craggy outcrop, not a ball) ──
    rock = obj_from_bmesh(name + "_rock", bm_icosphere(3.3, 6), coll, mat("Rock_Dark"))
    rock.scale = (1.55, 1.05, 1.15)
    rock.location = (0.25, 2.75, 0.9)
    displace_noise(rock, strength=1.05, scale=2.6, seed=4)
    displace_noise(rock, strength=0.30, scale=0.75, seed=12)
    decimate(rock, 0.35)
    apply_modifiers(rock)
    parts.append(rock)
    # crown + flank crags piled onto the mass (silhouette interest)
    crag_spec = ((-2.4, 1.4, 0.7, 1.5), (2.6, 1.5, 0.6, 1.7), (0.9, 2.2, 3.6, 1.9),
                 (-1.5, 2.8, 3.2, 1.6), (2.0, 3.4, 2.6, 1.4))
    for i, (bx, by, bz, bs) in enumerate(crag_spec):
        b = obj_from_bmesh(f"{name}_crag{i}", bm_icosphere(bs, 4), coll, mat("Rock_Dark"))
        b.scale = (1.25, 1.0, 0.85)
        b.rotation_euler = (0.2 * i, 0.15 * i, 0.9 * i)
        b.location = (bx, by, bz)
        displace_noise(b, strength=0.5, scale=1.3, seed=20 + i)
        displace_noise(b, strength=0.14, scale=0.5, seed=35 + i)
        decimate(b, 0.6)
        apply_modifiers(b)
        parts.append(b)
    # scree stones around the base
    srng = random.Random(71)
    for i in range(10):
        a = srng.uniform(math.pi * 0.9, math.tau * 1.05)
        d = srng.uniform(2.6, 4.6)
        s = srng.uniform(0.16, 0.45)
        st = obj_from_bmesh(f"{name}_scree{i}", bm_icosphere(s, 3), coll, mat("Rock_Dark"))
        st.scale = (1.25, 1.0, 0.62)
        st.rotation_euler = (0, 0, srng.uniform(0, math.tau))
        st.location = (0.25 + math.cos(a) * d, 1.2 + math.sin(a) * d, s * 0.12)
        displace_noise(st, strength=s * 0.35, scale=0.45, seed=90 + i)
        apply_modifiers(st)
        parts.append(st)

    # ── the dark portal throat (Char_Black, goes 2.5m deep) ──
    throat = bm_box(2.5, 3.0, 2.9)
    placed(throat, (0, FY + 1.62, 1.42))
    parts.append(obj_from_bmesh(name + "_throat", throat, coll, mat("Char_Black")))

    # ── timber portal frame: heavy posts + sagging lintel, charred tops ──
    for i, sx in enumerate((-1, 1)):
        M = (Matrix.Translation((sx * 1.45, FY, 0))
             @ Matrix.Rotation(sx * math.radians(-4), 4, 'Y'))
        parts += charred_beam(coll, f"{name}_post{i}", 0.38, 0.38, 2.9, M,
                              char_frac=0.30, rng=rng)
        # angled outer brace
        Mb = (Matrix.Translation((sx * 2.35, FY + 0.05, 0))
              @ Matrix.Rotation(sx * math.radians(-26), 4, 'Y'))
        parts += charred_beam(coll, f"{name}_brace{i}", 0.24, 0.26, 2.4, Mb,
                              char_frac=0.22, rng=rng)
    # lintel — charred along its top, slightly sagging
    lintel = bm_box(3.9, 0.45, 0.42)
    bm_bevel(lintel, 0.05)
    for v in lintel.verts:
        v.co.z -= 0.10 * (1 - (v.co.x / 1.95) ** 2)  # sag
    placed(lintel, (0, FY, 2.95), rz=math.radians(1.5))
    parts.append(obj_from_bmesh(name + "_lintel", lintel, coll, mat("Wood_Dark")))
    lchar = bm_box(3.7, 0.40, 0.16)
    for v in lchar.verts:
        if v.co.z > 0:
            v.co.z += rng.uniform(-0.05, 0.02)
            v.co.y *= rng.uniform(0.75, 1.0)
        v.co.z -= 0.10 * (1 - (v.co.x / 1.85) ** 2)
    placed(lchar, (0, FY, 3.22), rz=math.radians(1.5))
    parts.append(obj_from_bmesh(name + "_lchar", lchar, coll, mat("Char_Black")))
    # second, deeper frame set (reads as timber sets marching inward)
    for i, sx in enumerate((-1, 1)):
        M = Matrix.Translation((sx * 1.3, FY + 1.0, 0))
        parts += charred_beam(coll, f"{name}_post2_{i}", 0.3, 0.3, 2.75, M,
                              char_frac=0.35, rng=rng)
    l2 = bm_box(3.1, 0.34, 0.34)
    bm_bevel(l2, 0.04)
    placed(l2, (0, FY + 1.0, 2.78), rz=math.radians(-1.2))
    parts.append(obj_from_bmesh(name + "_lintel2", l2, coll, mat("Wood_Dark")))

    # ── rail stub: iron rails on wooden sleepers, running out -Y ──
    RL = 4.6
    gauge = 0.72
    for i in range(6):
        y = FY - 0.5 - i * (RL - 0.6) / 5
        sl = bm_box(1.35, 0.26, 0.14)
        bm_bevel(sl, 0.02)
        # sleepers under the cart stay true; only the far end is allowed to go
        # askew, so the track the cart rides on reads as an intact run
        under_cart = i <= 2
        yaw = 0.0 if under_cart else (rng.uniform(-0.05, 0.05) if i < 5 else 0.28)
        jx = 0.0 if under_cart else rng.uniform(-0.03, 0.03)
        # sleeper TOP must meet the rail bottom (0.13) or the rails float
        placed(sl, (jx, y, 0.06), rz=yaw)
        parts.append(obj_from_bmesh(f"{name}_slp{i}", sl, coll, mat("Wood_Mid")))
    for sx in (-1, 1):
        L = RL if sx < 0 else RL - 0.9  # one rail shorter — broken stub
        rl = bm_box(0.09, L, 0.12)
        bm_bevel(rl, 0.02)
        placed(rl, (sx * gauge / 2, FY - 0.35 - L / 2, 0.19))
        parts.append(obj_from_bmesh(f"{name}_rail{sx}", rl, coll, mat("Metal_Iron")))
    # bent rail end piece dropping off
    bent = bm_box(0.075, 0.7, 0.09)
    placed(bent, (gauge / 2 + 0.06, FY - 0.35 - (RL - 0.9) - 0.3, 0.10),
           rz=0.25, rx=math.radians(-14))
    parts.append(obj_from_bmesh(name + "_railbent", bent, coll, mat("Metal_Iron")))

    # ── ore cart ON the rails, heaped with obsidian ──
    # AUDIT FIX (backlog "mine cart off rails"): the cart used to carry a
    # cx=0.02 offset and a 0.05 rad yaw. Over the 0.42 m wheelbase that yaw
    # walks each wheel ~21 mm sideways — half the wheel tread hangs off a
    # 90 mm railhead, which is exactly the "wheels beside the rails" read.
    # The cart is now EXACTLY on the rail axis: zero yaw, zero lateral offset,
    # tread biting 15 mm into the railhead, plus proper inner flanges so the
    # contact is unambiguous at any camera angle.
    cx, cy = 0.0, FY - 1.9
    cyaw = 0.0
    Mc = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(cyaw, 4, 'Z')
    RAIL_TOP = 0.25
    W_R = 0.19
    wz = RAIL_TOP + W_R - 0.015        # tread seated into the railhead
    for sx in (-1, 1):
        for sy in (-1, 1):
            WM_ = Mc @ Matrix.Translation((sx * gauge / 2, sy * 0.42, wz)) \
                @ Matrix.Rotation(math.pi / 2, 4, 'Y')
            wh = bm_cylinder(W_R, W_R, 0.085, segs=16)
            placedM(wh, WM_)
            parts.append(obj_from_bmesh(f"{name}_whl{sx}{sy}", wh, coll,
                                        mat("Metal_Iron"), smooth=True))
            # INNER FLANGE: the lip that keeps a mine wheel on the rail. Sits
            # inboard of the railhead, so the wheel visibly grips the track.
            fl = bm_cylinder(W_R + 0.038, W_R + 0.038, 0.022, segs=16)
            placedM(fl, Mc @ Matrix.Translation(
                (sx * (gauge / 2 - 0.054), sy * 0.42, wz)) @
                Matrix.Rotation(math.pi / 2, 4, 'Y'))
            parts.append(obj_from_bmesh(f"{name}_flg{sx}{sy}", fl, coll,
                                        mat("Metal_Iron"), smooth=True))
            hubb = bm_cylinder(0.045, 0.045, 0.11, segs=8)
            placedM(hubb, WM_)
            parts.append(obj_from_bmesh(f"{name}_hub{sx}{sy}", hubb, coll,
                                        mat("Metal_Iron"), smooth=True))
    for sy in (-1, 1):
        ax = bm_cylinder(0.04, 0.04, gauge + 0.06, segs=8)
        placedM(ax, Mc @ Matrix.Translation((0, sy * 0.42, wz))
                @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
        parts.append(obj_from_bmesh(f"{name}_axl{sy}", ax, coll,
                                    mat("Metal_Iron"), smooth=True))
    # tub: plank walls, flared top
    tub_z0 = wz + 0.12
    tw, tl, th_ = 1.05, 1.55, 0.72
    for wi, (off, sz, rot) in enumerate((
            ((0, -tl / 2 + 0.03, 0), (tw, 0.06, th_), 0.13),
            ((0, tl / 2 - 0.03, 0), (tw, 0.06, th_), -0.13),
            ((-tw / 2 + 0.03, 0, 0), (0.06, tl, th_), -0.13),
            ((tw / 2 - 0.03, 0, 0), (0.06, tl, th_), 0.13))):
        bm = bm_box(*sz)
        bm_bevel(bm, 0.018)
        ax = 'X' if wi < 2 else 'Y'
        placedM(bm, Mc @ Matrix.Translation((off[0], off[1], tub_z0 + th_ / 2))
                @ Matrix.Rotation(rot, 4, ax))
        parts.append(obj_from_bmesh(f"{name}_tub{wi}", bm, coll, mat("Wood_Dark")))
    fl = bm_box(tw - 0.05, tl - 0.05, 0.05)
    placedM(fl, Mc @ Matrix.Translation((0, 0, tub_z0 + 0.02)))
    parts.append(obj_from_bmesh(name + "_tubfloor", fl, coll, mat("Wood_Dark")))
    # iron banding: two rectangular hoops
    for k, bz in enumerate((tub_z0 + 0.12, tub_z0 + th_ - 0.06)):
        spread = 1.0 + 0.20 * (bz - tub_z0) / th_
        for off, sz, ax in (((0, -(tl / 2) * spread * 0.98, 0), (tw * spread + 0.04, 0.05, 0.07), 'X'),
                            ((0, (tl / 2) * spread * 0.98, 0), (tw * spread + 0.04, 0.05, 0.07), 'X'),
                            ((-(tw / 2) * spread * 0.98, 0, 0), (0.05, tl * spread * 0.97, 0.07), 'Y'),
                            (((tw / 2) * spread * 0.98, 0, 0), (0.05, tl * spread * 0.97, 0.07), 'Y')):
            bm = bm_box(*sz)
            placedM(bm, Mc @ Matrix.Translation((off[0] * 0.92, off[1] * 0.92, bz)))
            parts.append(obj_from_bmesh(
                f"{name}_cb{k}_{off[0]:.2f}_{off[1]:.2f}", bm, coll, mat("Metal_Iron")))
    # push handle
    hb = bm_cylinder(0.025, 0.025, 1.0, segs=8)
    placedM(hb, Mc @ Matrix.Translation((0, tl / 2 + 0.10, tub_z0 + th_ - 0.05))
            @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_hndl", hb, coll, mat("Metal_Iron"), smooth=True))
    # heaped ore
    hr = random.Random(31)
    for k in range(11):
        a = hr.uniform(0, math.tau)
        d = hr.uniform(0, 0.38)
        parts.append(obsidian_chunk(coll, f"{name}_ore{k}",
                                    (cx + math.cos(a) * d * 0.8, cy + math.sin(a) * d,
                                     tub_z0 + th_ - 0.12 + hr.uniform(0, 0.18)),
                                    hr.uniform(0.11, 0.21), 300 + k,
                                    hr.uniform(0, math.tau)))

    # ── crates of obsidian beside the rails ──
    parts += crate(coll, name + "_crA", (-1.75, FY - 2.3, 0.0), 0.85, 0.85, 0.55, 0.3)
    parts += crate(coll, name + "_crB", (-1.55, FY - 1.35, 0.0), 0.7, 0.7, 0.48, -0.2)
    crng = random.Random(41)
    for k in range(6):
        a = crng.uniform(0, math.tau)
        d = crng.uniform(0, 0.24)
        parts.append(obsidian_chunk(coll, f"{name}_cro{k}",
                                    (-1.75 + math.cos(a) * d, FY - 2.3 + math.sin(a) * d,
                                     0.52 + crng.uniform(0, 0.1)),
                                    crng.uniform(0.09, 0.17), 400 + k))
    for k in range(4):
        a = crng.uniform(0, math.tau)
        d = crng.uniform(0, 0.18)
        parts.append(obsidian_chunk(coll, f"{name}_crp{k}",
                                    (-1.55 + math.cos(a) * d, FY - 1.35 + math.sin(a) * d,
                                     0.46 + crng.uniform(0, 0.08)),
                                    crng.uniform(0.08, 0.14), 450 + k))
    # spilled chunks on the ground
    for k in range(5):
        parts.append(obsidian_chunk(coll, f"{name}_spl{k}",
                                    (crng.uniform(-2.4, -0.9), FY - crng.uniform(0.6, 3.0),
                                     0.06), crng.uniform(0.07, 0.13), 500 + k))

    # ── dropped pick + unlit lantern ──
    Mp = (Matrix.Translation((1.15, FY - 2.5, 0.05))
          @ Matrix.Rotation(2.4, 4, 'Z') @ Matrix.Rotation(math.radians(88), 4, 'X'))
    ph = bm_cylinder(0.030, 0.022, 0.95, segs=8)
    placedM(ph, Mp @ Matrix.Translation((0, 0, 0.42)))
    parts.append(obj_from_bmesh(name + "_pickh", ph, coll, mat("Wood_Mid"), smooth=True))
    for sgn in (-1, 1):
        pk = bm_cylinder(0.05, 0.012, 0.42, segs=8)
        placedM(pk, Mp @ Matrix.Translation((sgn * 0.21, 0, 0.88))
                @ Matrix.Rotation(sgn * math.radians(78), 4, 'Y'))
        parts.append(obj_from_bmesh(f"{name}_pick{sgn}", pk, coll,
                                    mat("Metal_Iron"), smooth=True))
    parts += lantern(coll, name + "_lant", (1.5, FY - 1.7, 0.0), tipped=True)

    # ── cracked hanging warning sign (one rope snapped) ──
    sp = bm_cylinder(0.06, 0.045, 2.1, segs=8)
    placed(sp, (2.35, FY - 0.9, 1.05), rx=math.radians(-3))
    parts.append(obj_from_bmesh(name + "_signpost", sp, coll, mat("Wood_Bleached"), smooth=True))
    arm = bm_box(0.9, 0.08, 0.08)
    bm_bevel(arm, 0.015)
    placed(arm, (2.15, FY - 0.95, 2.02), rz=math.radians(8))
    parts.append(obj_from_bmesh(name + "_signarm", arm, coll, mat("Wood_Bleached")))
    # intact rope + snapped rope stub
    rope1 = bm_cylinder(0.016, 0.016, 0.30, segs=6)
    placed(rope1, (1.86, FY - 1.0, 1.86))
    parts.append(obj_from_bmesh(name + "_rope1", rope1, coll, mat("Rope"), smooth=True))
    rope2 = bm_cylinder(0.016, 0.016, 0.12, segs=6)
    placed(rope2, (2.42, FY - 0.92, 1.95), rx=0.5)
    parts.append(obj_from_bmesh(name + "_rope2", rope2, coll, mat("Rope"), smooth=True))
    # sign board: two cracked halves, hanging tilted from the one good rope
    Ms = (Matrix.Translation((1.98, FY - 1.02, 1.48))
          @ Matrix.Rotation(math.radians(-24), 4, 'Y') @ Matrix.Rotation(0.1, 4, 'X'))
    for i, (dx, dz, ry) in enumerate(((-0.16, 0.02, 0.06), (0.17, -0.05, -0.10))):
        half = bm_box(0.32, 0.035, 0.46)
        # jagged crack edge
        for v in half.verts:
            if (i == 0 and v.co.x > 0) or (i == 1 and v.co.x < 0):
                v.co.x += 0.03 * math.sin(v.co.z * 22)
        bm_bevel(half, 0.008)
        placedM(half, Ms @ Matrix.Translation((dx, 0, dz)) @ Matrix.Rotation(ry, 4, 'Y'))
        parts.append(obj_from_bmesh(f"{name}_sign{i}", half, coll, mat("Wood_Bleached")))
    # charred X warning mark across the sign
    for sgn in (-1, 1):
        stroke = bm_box(0.42, 0.02, 0.07)
        placedM(stroke, Ms @ Matrix.Translation((0, -0.025, 0))
                @ Matrix.Rotation(sgn * 0.6, 4, 'Y'))
        parts.append(obj_from_bmesh(f"{name}_mark{sgn}", stroke, coll, mat("Char_Black")))

    # ── collapsed support pile ──
    prng = random.Random(55)
    for k in range(6):
        L = prng.uniform(1.4, 2.3)
        M = (Matrix.Translation((prng.uniform(1.6, 2.7), FY - prng.uniform(1.6, 3.2),
                                 0.10 + k * 0.09))
             @ Matrix.Rotation(prng.uniform(0, math.tau), 4, 'Z')
             @ Matrix.Rotation(prng.uniform(-0.15, 0.15), 4, 'Y')
             @ Matrix.Rotation(math.pi / 2, 4, 'X'))  # lying down, along local Z
        parts += charred_beam(coll, f"{name}_fall{k}", 0.17, 0.18, L, M,
                              char_frac=prng.uniform(0.15, 0.5), rng=prng)

    # ── small offering cage on a post (empty, door open) ──
    ox, oy = -2.7, FY - 0.6
    post = bm_cylinder(0.05, 0.04, 1.25, segs=8)
    placed(post, (ox, oy, 0.62), ry=math.radians(3))
    parts.append(obj_from_bmesh(name + "_offpost", post, coll, mat("Wood_Dark"), smooth=True))
    for zz in (1.28, 1.66):
        ring = bm_cylinder(0.17, 0.17, 0.025, segs=10, cap=(zz == 1.28))
        placed(ring, (ox, oy, zz))
        parts.append(obj_from_bmesh(f"{name}_offr{zz:.2f}", ring, coll,
                                    mat("Metal_Iron"), smooth=True))
    for k in range(6):
        a = k * math.tau / 6 + 0.3
        if k in (2, 3):
            continue  # door gap
        bar = bm_cylinder(0.010, 0.010, 0.38, segs=6)
        placed(bar, (ox + math.cos(a) * 0.16, oy + math.sin(a) * 0.16, 1.47))
        parts.append(obj_from_bmesh(f"{name}_offb{k}", bar, coll,
                                    mat("Metal_Iron"), smooth=True))
    # open door: 2 bars on a swung frame
    da = 0.3 + 2 * math.tau / 6 + 1.5  # swung open
    for k in range(2):
        a = da + k * 0.35
        bar = bm_cylinder(0.010, 0.010, 0.38, segs=6)
        placed(bar, (ox + math.cos(a) * 0.30, oy + math.sin(a) * 0.30, 1.44),
               ry=0.15)
        parts.append(obj_from_bmesh(f"{name}_offd{k}", bar, coll,
                                    mat("Metal_Iron"), smooth=True))
    cap = bm_cylinder(0.19, 0.02, 0.12, segs=10)
    placed(cap, (ox, oy, 1.73))
    parts.append(obj_from_bmesh(name + "_offcap", cap, coll, mat("Metal_Iron"), smooth=True))

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
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR)
    print(f"built {name}")


build_minehead()
print("MINEHEAD DONE")
