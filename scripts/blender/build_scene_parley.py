# PARLEY TABLE — Parley Point hero scene: the truce that held (so far).
# Great round table built from a ship's hatch/wheel (radial beveled planks,
# iron rim ring, wheel handles) on barrel legs; 6 mismatched captains' chairs
# (one knocked over backward); chart weighted by TWO CROSSED FLINTLOCK PISTOLS
# (the focal), goblets (one tipped) + spilled-wine stain; tall white parley
# flag on a mast; two rival crew flags planted at opposite ends (Black Fin
# pennant per brief + quartered red/black with crossed cutlasses); truce
# barrel bristling with surrendered cutlasses stuck point-down.
# Scene faces Blender -Y. Headless: Blender -b -P scripts/blender/build_scene_parley.py
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
    "Flag_White": ((0.85, 0.83, 0.78, 1.0), 0.9, 0.0),
    "Flag_Rival": ((0.45, 0.10, 0.10, 1.0), 0.9, 0.0),
    "Flag_Fin":   ((0.09, 0.20, 0.23, 1.0), 0.9, 0.0),
}
for _n, _v in EXTRA.items():
    PALETTE.setdefault(_n, _v)


def bm_bevel(bm, width=0.02, segments=1):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=segments, profile=0.72, affect='EDGES', clamp_overlap=True)
    return bm


def placedM(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return bm


def placed(bm, loc=(0, 0, 0), rz=0.0, ry=0.0, rx=0.0):
    M = (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(rz, 4, 'Z')
         @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X'))
    return placedM(bm, M)


def bm_prism(pts2d, thick):
    """Flat prism from a 2D outline in local XY, extruded +Z by thick."""
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, 0)) for x, y in pts2d]
    f = bm.faces.new(verts)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, vec=(0, 0, thick),
                        verts=[v for v in r['geom'] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def cloth_flag(L, H, nx=30, ny=17, droop=0.22, amp=0.10, freq=2.0,
               notches=None, notch_depth=0.22, phase=0.0):
    """Cloth grid: local x = 0..L (fly), y = -H/2..H/2 (becomes height),
    z = flutter. Optional triangular bite-notches at the fly edge."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=1.0)
    for v in bm.verts:
        v.co.x = (v.co.x + 1.0) * 0.5 * L
        v.co.y *= H * 0.5
    if notches:
        kill = []
        for f in bm.faces:
            c = f.calc_center_median()
            t = c.x / L
            for (nc, nh) in notches:
                edge_t = 1.0 - (notch_depth / L) * max(0.0, 1.0 - abs(c.y - nc) / nh)
                if t > edge_t:
                    kill.append(f)
                    break
        bmesh.ops.delete(bm, geom=kill, context='FACES')
    for v in bm.verts:
        t = v.co.x / L
        v.co.z = amp * math.sin(t * freq * math.pi + v.co.y * 2.0 + phase) * t
        v.co.y -= droop * t * t
    return bm


def flag_matrix(attach, fly_dir_xy):
    """Local x->fly (horizontal), y->world Z, z->horizontal normal."""
    f = Vector((fly_dir_xy[0], fly_dir_xy[1], 0.0)).normalized()
    n = Vector((-f.y, f.x, 0.0))
    return Matrix(((f.x, 0.0, n.x, attach[0]),
                   (f.y, 0.0, n.y, attach[1]),
                   (0.0, 1.0, 0.0, attach[2]),
                   (0.0, 0.0, 0.0, 1.0)))


def make_flag_obj(coll, name, bm, M, material, thick=0.03):
    placedM(bm, M)
    o = obj_from_bmesh(name, bm, coll, material, smooth=True)
    s = o.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = thick
    apply_modifiers(o)
    return o


def barrel(coll, name, loc, r=0.33, h=0.9, tilt=0.0, yaw=0.0, wood="Wood_Dark"):
    parts = []
    M = (Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
         @ Matrix.Rotation(tilt, 4, 'X'))
    lo = bm_cylinder(r * 0.86, r, h * 0.5, segs=14)
    placedM(lo, M @ Matrix.Translation((0, 0, h * 0.25)))
    parts.append(obj_from_bmesh(name + "_lo", lo, coll, mat(wood)))
    hi = bm_cylinder(r, r * 0.86, h * 0.5, segs=14)
    placedM(hi, M @ Matrix.Translation((0, 0, h * 0.75)))
    parts.append(obj_from_bmesh(name + "_hi", hi, coll, mat(wood)))
    for bz, br in ((h * 0.12, r * 0.90), (h * 0.5, r * 1.03), (h * 0.88, r * 0.90)):
        band = bm_cylinder(br + 0.012, br + 0.012, 0.05, segs=14)
        placedM(band, M @ Matrix.Translation((0, 0, bz)))
        parts.append(obj_from_bmesh(name + f"_b{bz:.1f}", band, coll,
                                    mat("Metal_Iron"), smooth=True))
    return parts


def cutlass(coll, name, M, blade_len=0.58):
    """Cutlass built point at local -Z, grip at +Z (for sticking point-down)."""
    parts = []
    bm = bmesh.new()
    w0, w1, th = 0.072, 0.022, 0.013
    v = [bm.verts.new(p) for p in (
        (-w0 / 2, -th / 2, 0), (w0 / 2, -th / 2, 0), (w0 / 2, th / 2, 0), (-w0 / 2, th / 2, 0),
        (-w1 / 2, -th / 2, -blade_len), (w1 / 2 + 0.02, -th / 2, -blade_len),
        (w1 / 2 + 0.02, th / 2, -blade_len), (-w1 / 2, th / 2, -blade_len))]
    for idx in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2),
                (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([v[i] for i in idx])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    placedM(bm, M)
    parts.append(obj_from_bmesh(name + "_blade", bm, coll, mat("Metal_Iron")))
    g = bm_box(0.19, 0.04, 0.032)
    bm_bevel(g, 0.008)
    placedM(g, M @ Matrix.Translation((0, 0, 0.016)))
    parts.append(obj_from_bmesh(name + "_guard", g, coll, mat("Metal_Iron")))
    grip = bm_cylinder(0.021, 0.017, 0.14, segs=9)
    placedM(grip, M @ Matrix.Translation((0.018, 0, 0.10)) @ Matrix.Rotation(0.18, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_grip", grip, coll, mat("Wood_Dark"), smooth=True))
    pom = bm_icosphere(0.028, 2)
    placedM(pom, M @ Matrix.Translation((0.034, 0, 0.175)))
    parts.append(obj_from_bmesh(name + "_pom", pom, coll, mat("Metal_Iron"), smooth=True))
    # knuckle bow: 3 short cylinders arcing from guard to pommel
    for k in range(3):
        t = (k + 0.5) / 3
        a = math.pi * (0.15 + 0.7 * t)
        px = -0.065 * math.cos(a) + 0.02
        pz = 0.02 + 0.115 * math.sin(a) * 0.65 + t * 0.04
        seg = bm_cylinder(0.006, 0.006, 0.06, segs=6)
        placedM(seg, M @ Matrix.Translation((px, 0, pz)) @ Matrix.Rotation(a, 4, 'Y'))
        parts.append(obj_from_bmesh(name + f"_bow{k}", seg, coll,
                                    mat("Metal_Iron"), smooth=True))
    return parts


def pistol(coll, name, M):
    """Flintlock lying flat: local +X = muzzle direction, z up ~0.03 tall."""
    parts = []
    b = bm_cylinder(0.021, 0.018, 0.34, segs=10)
    placedM(b, M @ Matrix.Translation((0.10, 0, 0.028)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_barrel", b, coll, mat("Metal_Iron"), smooth=True))
    muz = bm_cylinder(0.027, 0.024, 0.03, segs=10)
    placedM(muz, M @ Matrix.Translation((0.26, 0, 0.028)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_muz", muz, coll, mat("Metal_Iron"), smooth=True))
    stock = bm_box(0.26, 0.045, 0.045)
    bm_bevel(stock, 0.012)
    placedM(stock, M @ Matrix.Translation((-0.02, 0, 0.024)))
    parts.append(obj_from_bmesh(name + "_stock", stock, coll, mat("Wood_Dark")))
    grip = bm_box(0.16, 0.042, 0.05)
    bm_bevel(grip, 0.014)
    placedM(grip, M @ Matrix.Translation((-0.19, 0, 0.032)) @ Matrix.Rotation(-0.5, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_grip", grip, coll, mat("Wood_Dark")))
    butt = bm_icosphere(0.032, 1)
    placedM(butt, M @ Matrix.Translation((-0.255, 0, 0.065)))
    parts.append(obj_from_bmesh(name + "_butt", butt, coll, mat("Metal_Iron"), smooth=True))
    hammer = bm_box(0.03, 0.016, 0.05)
    bm_bevel(hammer, 0.005)
    placedM(hammer, M @ Matrix.Translation((-0.045, 0.0, 0.065)) @ Matrix.Rotation(0.5, 4, 'Y'))
    parts.append(obj_from_bmesh(name + "_ham", hammer, coll, mat("Metal_Iron")))
    return parts


def chair(coll, name, loc, yaw, style, rng, knocked=False):
    """Mismatched captain's chair. Local: seat centered origin, back at +Y,
    sits facing -Y. Placed with yaw so -Y local aims at the table."""
    parts_bm = []  # (bm, matname, smooth)
    seat_h = {"tall": 0.46, "stool": 0.42, "arm": 0.45, "plain": 0.44,
              "keg": 0.0}[style]
    if style == "keg":
        M = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
        return barrel(coll, name, loc, r=0.26, h=0.52,
                      yaw=yaw, tilt=math.radians(rng.uniform(1, 3)), wood="Wood_Mid")
    sw, sd = 0.46, 0.44
    # legs (splayed)
    for sx in (-1, 1):
        for sy in (-1, 1):
            leg = bm_cylinder(0.038, 0.030, seat_h, segs=9)
            placed(leg, (sx * (sw / 2 - 0.04), sy * (sd / 2 - 0.04), seat_h / 2),
                   rx=-sy * 0.06, ry=sx * 0.06)
            parts_bm.append((leg, "Wood_Mid", True))
    # stretchers
    for sy in (-1, 1):
        st = bm_box(sw - 0.06, 0.03, 0.03)
        placed(st, (0, sy * (sd / 2 - 0.05), seat_h * 0.4))
        parts_bm.append((st, "Wood_Dark", False))
    seat = bm_box(sw, sd, 0.05)
    bm_bevel(seat, 0.015)
    placed(seat, (0, 0, seat_h + 0.025))
    parts_bm.append((seat, "Wood_Mid", False))
    if style != "stool":
        back_h = {"tall": 0.82, "arm": 0.55, "plain": 0.62}[style]
        for sx in (-1, 1):
            stile = bm_cylinder(0.037, 0.028, back_h, segs=9)
            placed(stile, (sx * (sw / 2 - 0.05), sd / 2 - 0.04, seat_h + back_h / 2),
                   rx=-0.12)
            parts_bm.append((stile, "Wood_Dark", True))
            if style == "tall":
                fin = bm_icosphere(0.035, 1)
                placed(fin, (sx * (sw / 2 - 0.05), sd / 2 - 0.04 - back_h * 0.12,
                             seat_h + back_h + 0.02))
                parts_bm.append((fin, "Wood_Dark", True))
        nslat = 3 if style == "tall" else 2
        for k in range(nslat):
            z = seat_h + back_h * (0.35 + 0.28 * k)
            slat = bm_box(sw - 0.07, 0.034, 0.09)
            bm_bevel(slat, 0.008)
            placed(slat, (0, sd / 2 - 0.04 - 0.12 * (z - seat_h), z))
            parts_bm.append((slat, "Wood_Mid", False))
    if style == "arm":
        for sx in (-1, 1):
            rail = bm_box(0.03, sd - 0.06, 0.03)
            placed(rail, (sx * (sw / 2 - 0.02), 0, seat_h + 0.22))
            parts_bm.append((rail, "Wood_Dark", False))
            post = bm_cylinder(0.018, 0.015, 0.21, segs=6)
            placed(post, (sx * (sw / 2 - 0.02), -(sd / 2 - 0.08), seat_h + 0.11))
            parts_bm.append((post, "Wood_Dark", True))
    M = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
    if knocked:
        # tipped over backward: rotate about the rear-leg floor line
        pivot = Vector((0, sd / 2 - 0.02, 0))
        M = M @ (Matrix.Translation(pivot)
                 @ Matrix.Rotation(math.radians(-96), 4, 'X')
                 @ Matrix.Translation(-pivot))
    out = []
    for i, (bm, mn, sm) in enumerate(parts_bm):
        placedM(bm, M)
        out.append(obj_from_bmesh(f"{name}_p{i}", bm, coll, mat(mn), smooth=sm))
    return out


def goblet(coll, name, loc, tipped=False, rng=None):
    parts = []
    M = Matrix.Translation(Vector(loc))
    if tipped:
        M = (M @ Matrix.Rotation(rng.uniform(0, math.tau), 4, 'Z')
             @ Matrix.Translation((0, 0, 0.05)) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
             @ Matrix.Translation((0, 0, -0.05)))
    base = bm_cylinder(0.042, 0.03, 0.015, segs=10)
    placedM(base, M @ Matrix.Translation((0, 0, 0.008)))
    parts.append(obj_from_bmesh(name + "_base", base, coll, mat("Metal_Iron"), smooth=True))
    stem = bm_cylinder(0.011, 0.011, 0.05, segs=8)
    placedM(stem, M @ Matrix.Translation((0, 0, 0.04)))
    parts.append(obj_from_bmesh(name + "_stem", stem, coll, mat("Metal_Iron"), smooth=True))
    cup = bm_cylinder(0.034, 0.05, 0.085, segs=12)
    placedM(cup, M @ Matrix.Translation((0, 0, 0.105)))
    parts.append(obj_from_bmesh(name + "_cup", cup, coll, mat("Metal_Iron"), smooth=True))
    return parts


def build_parley(name="parley_table"):
    clear_default_scene()
    coll = asset_collection(name)
    rng = random.Random(11)
    parts = []
    TOP = 0.92          # table top surface height
    R = 1.55            # table radius

    # ── weathered plank deck the parley is held on (old quarterdeck) ──
    DR = 4.05
    drng = random.Random(3)
    py = -DR + 0.17
    di = 0
    while py < DR - 0.05:
        pw = drng.uniform(0.30, 0.38)
        half = math.sqrt(max(0.05, DR * DR - py * py))
        # split some planks into two boards with a gap
        splits = [(-half, half)] if drng.random() < 0.6 else \
            [(-half, drng.uniform(-0.6, 0.2)), (drng.uniform(0.4, 1.0), half)]
        for si, (x0, x1) in enumerate(splits):
            if x1 - x0 < 0.5:
                continue
            L = (x1 - x0) * drng.uniform(0.94, 1.0)
            bm = bm_box(L, pw * 0.94, 0.09)
            # chip one end
            for v in bm.verts:
                if v.co.x > L * 0.47 and v.co.z > 0 and drng.random() < 0.5:
                    v.co.x -= drng.uniform(0.02, 0.10)
            bm_bevel(bm, 0.016, segments=2)
            placed(bm, ((x0 + x1) * 0.5, py + pw * 0.5,
                        0.015 + drng.uniform(-0.012, 0.012)),
                   rz=drng.uniform(-0.008, 0.008))
            mname = "Wood_Dark" if di % 4 == 1 else "Wood_Mid"
            parts.append(obj_from_bmesh(f"{name}_deck{di}_{si}", bm, coll, mat(mname)))
        py += pw
        di += 1

    # ── the great hatch/wheel table top: radial beveled planks ──
    NPL = 12
    for i in range(NPL):
        a0 = math.tau * i / NPL + 0.012
        a1 = math.tau * (i + 1) / NPL - 0.012
        bm = bmesh.new()
        rows = []
        arcs = 9
        r_in, r_out = 0.22, R
        for k in range(arcs + 1):
            a = a0 + (a1 - a0) * k / arcs
            rows.append((bm.verts.new((math.cos(a) * r_in, math.sin(a) * r_in, 0)),
                         bm.verts.new((math.cos(a) * r_out, math.sin(a) * r_out, 0))))
        faces = []
        for k in range(arcs):
            faces.append(bm.faces.new((rows[k][0], rows[k][1],
                                       rows[k + 1][1], rows[k + 1][0])))
        r = bmesh.ops.extrude_face_region(bm, geom=faces)
        bmesh.ops.translate(bm, vec=(0, 0, 0.07),
                            verts=[v for v in r['geom'] if isinstance(v, bmesh.types.BMVert)])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm_bevel(bm, 0.014, segments=2)
        zj = rng.uniform(-0.006, 0.006)
        placed(bm, (0, 0, TOP - 0.07 + zj))
        mname = "Wood_Dark" if i % 4 == 0 else "Wood_Mid"
        parts.append(obj_from_bmesh(f"{name}_plank{i}", bm, coll, mat(mname)))
    # centre hub (hatch ring)
    hub = bm_cylinder(0.26, 0.26, 0.10, segs=14)
    placed(hub, (0, 0, TOP - 0.03))
    parts.append(obj_from_bmesh(name + "_hub", hub, coll, mat("Wood_Dark"), smooth=True))
    hubcap = bm_cylinder(0.10, 0.085, 0.06, segs=10)
    placed(hubcap, (0, 0, TOP + 0.05))
    parts.append(obj_from_bmesh(name + "_hubcap", hubcap, coll, mat("Metal_Iron"), smooth=True))
    # iron rim ring around the edge
    rim = bm_cylinder(R + 0.035, R + 0.035, 0.075, segs=28, cap=False)
    placed(rim, (0, 0, TOP - 0.038))
    o = obj_from_bmesh(name + "_rim", rim, coll, mat("Metal_Iron"), smooth=True)
    s = o.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = 0.02
    apply_modifiers(o)
    parts.append(o)
    # wheel handles poking out of the rim (it WAS a ship's wheel)
    for i in range(8):
        a = math.tau * i / 8 + 0.19
        h = bm_cylinder(0.035, 0.024, 0.26, segs=8)
        placed(h, (math.cos(a) * (R + 0.16), math.sin(a) * (R + 0.16), TOP - 0.0),
               rz=a, ry=math.pi / 2)
        parts.append(obj_from_bmesh(f"{name}_hnd{i}", h, coll, mat("Wood_Dark"), smooth=True))
    # under-spokes from hub to rim
    for i in range(6):
        a = math.tau * i / 6 + 0.30
        sp = bm_box(R - 0.2, 0.09, 0.06)
        placed(sp, (math.cos(a) * R * 0.55, math.sin(a) * R * 0.55, TOP - 0.11), rz=a)
        parts.append(obj_from_bmesh(f"{name}_spk{i}", sp, coll, mat("Wood_Mid")))

    # ── barrel legs ──
    for i, a in enumerate((math.radians(90), math.radians(210), math.radians(330))):
        parts += barrel(coll, f"{name}_leg{i}",
                        (math.cos(a) * 0.85, math.sin(a) * 0.85, -0.04),
                        r=0.31, h=0.88, yaw=rng.uniform(0, math.tau),
                        tilt=math.radians(rng.uniform(0.5, 2.0)))

    # ── chart + crossed pistols (FOCAL) + goblets + wine stain ──
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=8, y_segments=6, size=1.0)
    for v in bm.verts:
        v.co.x *= 0.52
        v.co.y *= 0.38
        cr = max(abs(v.co.x) / 0.52, abs(v.co.y) / 0.38)
        v.co.z = 0.05 * max(0.0, cr - 0.72) ** 2 / 0.08  # corner curl
    placed(bm, (0.02, -0.28, TOP + 0.012), rz=0.28)
    chart = obj_from_bmesh(name + "_chart", bm, coll, mat("Bone"), smooth=True)
    s = chart.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = 0.012
    apply_modifiers(chart)
    parts.append(chart)
    # the two crossed flintlocks, one atop the other
    parts += pistol(coll, name + "_pistolA",
                    Matrix.Translation((0.0, -0.30, TOP + 0.02))
                    @ Matrix.Rotation(math.radians(35), 4, 'Z'))
    parts += pistol(coll, name + "_pistolB",
                    Matrix.Translation((0.0, -0.30, TOP + 0.062))
                    @ Matrix.Rotation(math.radians(-38), 4, 'Z'))
    parts += goblet(coll, name + "_gobA", (0.62, 0.30, TOP))
    parts += goblet(coll, name + "_gobB", (-0.66, 0.42, TOP))
    parts += goblet(coll, name + "_gobC", (-0.52, 0.02, TOP), tipped=True, rng=rng)
    parts += goblet(coll, name + "_gobD", (0.86, -0.42, TOP))
    parts += goblet(coll, name + "_gobE", (0.30, 0.78, TOP))
    # tankards + plate + dagger pinning the chart corner
    for ti, (tx, ty) in enumerate(((-0.20, 0.66), (0.95, 0.05), (-1.02, -0.32))):
        tk = bm_cylinder(0.055, 0.048, 0.13, segs=12)
        placed(tk, (tx, ty, TOP + 0.065))
        parts.append(obj_from_bmesh(f"{name}_tank{ti}", tk, coll,
                                    mat("Wood_Dark"), smooth=True))
        for hz in (0.035, 0.10):
            hb = bm_cylinder(0.058, 0.058, 0.018, segs=12, cap=False)
            placed(hb, (tx, ty, TOP + hz))
            o = obj_from_bmesh(f"{name}_tb{ti}{hz:.2f}", hb, coll,
                               mat("Metal_Iron"), smooth=True)
            s = o.modifiers.new("Solid", 'SOLIDIFY')
            s.thickness = 0.008
            apply_modifiers(o)
            parts.append(o)
        hd = bm_cylinder(0.035, 0.035, 0.016, segs=10, cap=False)
        placed(hd, (tx + 0.072, ty, TOP + 0.07), ry=math.pi / 2)
        o = obj_from_bmesh(f"{name}_th{ti}", hd, coll, mat("Metal_Iron"), smooth=True)
        s = o.modifiers.new("Solid", 'SOLIDIFY')
        s.thickness = 0.010
        apply_modifiers(o)
        parts.append(o)
    plate = bm_cylinder(0.13, 0.10, 0.018, segs=16)
    placed(plate, (0.55, 0.72, TOP + 0.009))
    parts.append(obj_from_bmesh(name + "_plate", plate, coll,
                                mat("Metal_Iron"), smooth=True))
    # dagger stabbed through the chart corner
    Md = (Matrix.Translation((0.44, -0.58, TOP + 0.01))
          @ Matrix.Rotation(0.9, 4, 'Z') @ Matrix.Rotation(math.radians(-8), 4, 'Y'))
    dbl = bm_cylinder(0.014, 0.002, 0.16, segs=6)
    placedM(dbl, Md @ Matrix.Translation((0, 0, -0.02)))
    parts.append(obj_from_bmesh(name + "_dagb", dbl, coll, mat("Metal_Iron")))
    dgd = bm_box(0.09, 0.02, 0.018)
    bm_bevel(dgd, 0.005)
    placedM(dgd, Md @ Matrix.Translation((0, 0, 0.065)))
    parts.append(obj_from_bmesh(name + "_dagg", dgd, coll, mat("Metal_Iron")))
    dgr = bm_cylinder(0.016, 0.013, 0.09, segs=8)
    placedM(dgr, Md @ Matrix.Translation((0, 0, 0.115)))
    parts.append(obj_from_bmesh(name + "_dagr", dgr, coll, mat("Wood_Dark"), smooth=True))
    # spilled-wine stain (dark decal disc by the tipped goblet)
    stain = bm_cylinder(0.125, 0.125, 0.006, segs=14)
    for v in stain.verts:
        a = math.atan2(v.co.y, v.co.x)
        rr = 1.0 + 0.22 * math.sin(a * 3 + 0.7)
        v.co.x *= rr * 1.25
        v.co.y *= rr
    placed(stain, (-0.72, -0.10, TOP + 0.006))
    parts.append(obj_from_bmesh(name + "_stain", stain, coll, mat("Flag_Rival"), smooth=True))

    # ── tall white parley flag on a mast (behind the table, +Y) ──
    mast = bm_cylinder(0.075, 0.05, 5.4, segs=10)
    placed(mast, (0, 2.55, 2.7), rx=math.radians(2.5))
    parts.append(obj_from_bmesh(name + "_mast", mast, coll, mat("Wood_Dark"), smooth=True))
    truck = bm_icosphere(0.075, 1)
    placed(truck, (0, 2.44, 5.42))
    parts.append(obj_from_bmesh(name + "_truck", truck, coll, mat("Wood_Dark"), smooth=True))
    # neat stake tripod bracing the mast foot + iron collar
    for k in range(4):
        a = k * math.tau / 4 + 0.42
        p0 = Vector((math.cos(a) * 0.62, 2.55 + math.sin(a) * 0.62, -0.03))
        p1 = Vector((math.cos(a) * 0.09, 2.55 + math.sin(a) * 0.09, 1.05))
        d = p1 - p0
        br = bm_cylinder(0.045, 0.032, d.length, segs=8)
        placedM(br, Matrix.Translation((p0 + p1) * 0.5)
                @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4())
        parts.append(obj_from_bmesh(f"{name}_brace{k}", br, coll,
                                    mat("Wood_Mid"), smooth=True))
    collar = bm_cylinder(0.10, 0.10, 0.14, segs=12, cap=False)
    placed(collar, (0, 2.55, 1.05))
    o = obj_from_bmesh(name + "_collar", collar, coll, mat("Metal_Iron"), smooth=True)
    s = o.modifiers.new("Solid", 'SOLIDIFY')
    s.thickness = 0.018
    apply_modifiers(o)
    parts.append(o)
    wf = cloth_flag(1.7, 1.05, droop=0.30, amp=0.09, freq=1.8,
                    notches=[(0.30, 0.10), (-0.22, 0.09)], notch_depth=0.16)
    parts.append(make_flag_obj(coll, name + "_whiteflag", wf,
                               flag_matrix((0.04, 2.50, 4.7), (1.0, 0.35)),
                               mat("Flag_White")))

    # ── two rival crew flags planted at opposite ends ──
    # A: the Black Fin (exact brief spec)
    fp = bm_cylinder(0.045, 0.03, 3.3, segs=8)
    placed(fp, (2.95, 0.30, 1.6), ry=math.radians(7))
    parts.append(obj_from_bmesh(name + "_finpole", fp, coll, mat("Wood_Mid"), smooth=True))
    fin_f = cloth_flag(1.5, 0.9, droop=0.20, amp=0.035, freq=1.6,
                       notches=[(0.30, 0.09), (0.02, 0.10), (-0.28, 0.08)],
                       notch_depth=0.22, phase=0.8)
    Mfin = flag_matrix((3.10, 0.32, 2.95), (0.94, 0.34))
    parts.append(make_flag_obj(coll, name + "_finflag", fin_f, Mfin, mat("Flag_Fin")))
    # appliqué shark fin, raised 2cm relief, Bone
    finpts = [(0.0, 0.0), (0.52, 0.0), (0.47, 0.12), (0.30, 0.20),
              (0.12, 0.33), (0.02, 0.42), (-0.03, 0.14)]
    finbm = bm_prism([(x * 1.15, y * 1.15) for x, y in finpts], 0.02)
    placedM(finbm, Mfin @ Matrix.Translation((0.36, -0.33, 0.05)))
    parts.append(obj_from_bmesh(name + "_finappl", finbm, coll, mat("Bone")))
    finbm2 = bm_prism([(x * 1.15, y * 1.15) for x, y in finpts], 0.02)
    placedM(finbm2, Mfin @ Matrix.Translation((0.36, -0.33, -0.07)))
    parts.append(obj_from_bmesh(name + "_finappl2", finbm2, coll, mat("Bone")))
    # B: quartered red/black with crossed cutlasses (Bone relief)
    rp = bm_cylinder(0.045, 0.03, 3.3, segs=8)
    placed(rp, (-2.95, -0.20, 1.6), ry=math.radians(-6))
    parts.append(obj_from_bmesh(name + "_rivpole", rp, coll, mat("Wood_Mid"), smooth=True))
    Mriv = flag_matrix((-3.08, -0.22, 2.9), (-0.94, 0.30))
    for qi, (x0, y0, mn) in enumerate((
            (0.0, 0.0, "Flag_Rival"), (0.7, 0.0, "Char_Black"),
            (0.0, -0.45, "Char_Black"), (0.7, -0.45, "Flag_Rival"))):
        q = cloth_flag(0.7, 0.45, nx=13, ny=9, droop=0.0, amp=0.0, freq=1.0)
        # shared sag so quarters stay stitched: apply after offset
        for v in q.verts:
            gx = v.co.x + x0
            gy = v.co.y + y0 + 0.225
            t = gx / 1.4
            v.co.z = 0.05 * math.sin(t * 1.7 * math.pi + gy * 2.0 + 0.3) * t
            v.co.y -= 0.16 * t * t
        placedM(q, Mriv @ Matrix.Translation((x0, y0 + 0.225, 0)))
        oq = obj_from_bmesh(f"{name}_rq{qi}", q, coll, mat(mn), smooth=True)
        sq = oq.modifiers.new("Solid", 'SOLIDIFY')
        sq.thickness = 0.03
        apply_modifiers(oq)
        parts.append(oq)
    # crossed cutlass silhouettes (Bone relief prisms)
    for sgn in (-1, 1):
        cx = bm_prism([(-0.34, -0.028), (0.30, -0.028), (0.40, 0.0),
                       (0.30, 0.028), (-0.34, 0.028)], 0.018)
        placedM(cx, Mriv @ Matrix.Translation((0.7, 0.20 - 0.225, 0.05))
                @ Matrix.Rotation(sgn * math.radians(32), 4, 'Z'))
        parts.append(obj_from_bmesh(f"{name}_rx{sgn}", cx, coll, mat("Bone")))

    # ── truce barrel bristling with surrendered cutlasses ──
    tb_loc = (-2.15, -2.15, -0.03)
    parts += barrel(coll, name + "_truce", tb_loc, r=0.36, h=0.95,
                    yaw=0.6, tilt=math.radians(1.5), wood="Wood_Mid")
    crng = random.Random(23)
    for i in range(7):
        a = math.tau * i / 7 + crng.uniform(-0.22, 0.22)
        rr = crng.uniform(0.05, 0.26)
        tilt_ax = crng.uniform(0, math.tau)
        M = (Matrix.Translation((tb_loc[0] + math.cos(a) * rr,
                                 tb_loc[1] + math.sin(a) * rr, 0.95 + 0.38))
             @ Matrix.Rotation(tilt_ax, 4, 'Z')
             @ Matrix.Rotation(math.radians(crng.uniform(8, 24)), 4, 'X'))
        parts += cutlass(coll, f"{name}_cut{i}", M, blade_len=crng.uniform(0.52, 0.70))
    # two spare rum kegs leaning by the truce barrel
    parts += barrel(coll, name + "_kegA", (-2.9, -1.5, -0.04), r=0.24, h=0.6,
                    yaw=1.1, tilt=math.radians(4), wood="Wood_Dark")
    parts += barrel(coll, name + "_kegB", (-2.55, -2.75, -0.02), r=0.22, h=0.55,
                    yaw=2.4, tilt=math.radians(78), wood="Wood_Mid")

    # ── mismatched captains' chairs around the table ──
    styles = ["tall", "arm", "plain", "stool", "plain", "keg"]
    angles = [20, 80, 140, 200, 285, 340]
    for i, (st, adeg) in enumerate(zip(styles, angles)):
        a = math.radians(adeg)
        d = 2.42 + rng.uniform(-0.10, 0.14)
        loc = (math.cos(a) * d, math.sin(a) * d, -0.03)
        yaw = a - math.pi / 2 + rng.uniform(-0.12, 0.12)  # local -Y faces table
        parts += chair(coll, f"{name}_ch{i}", loc, yaw, st, rng,
                       knocked=(i == 4))

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


build_parley()
print("PARLEY DONE")
