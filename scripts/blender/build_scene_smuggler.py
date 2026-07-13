# smuggler_cache — hero story scene for Smuggler's Rest (fidelity pass).
# Interrupted contraband handoff in a grove: rowboat half-dragged with a keel
# furrow in the sand, crate stack under a draped tarp net, one crate pried open
# spilling bottles, rum kegs half-buried, knocked-over lantern, hand cart,
# crowbar. Focal: the pried crate. Scene faces -Y.
# Headless: Blender -b -P scripts/blender/build_scene_smuggler.py
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
    "Bottle_Green": ((0.10, 0.30, 0.16, 1.0), 0.35, 0.0),
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()
rng = random.Random(42)


# ── generic helpers ──────────────────────────────────────────
def M_of(loc=(0, 0, 0), rot=(0, 0, 0)):
    return Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4()


def box_at(coll, name, dims, loc, rot=(0, 0, 0), material=None, smooth=False):
    bm = bm_box(*dims)
    bmesh.ops.transform(bm, matrix=M_of(loc, rot), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def tube(coll, name, pts, r1, r2, material, segs=6, smooth=True):
    """Chain of cylinders along a point list, radius tapering r1 -> r2."""
    parts = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        if d.length < 1e-5:
            continue
        ta = i / max(1, n)
        tb = (i + 1) / max(1, n)
        bm = bm_cylinder(r1 + (r2 - r1) * ta, r1 + (r2 - r1) * tb,
                         d.length + 0.006, segs=segs)
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


def lathe(coll, name, profile, ns, material, loc=(0, 0, 0), rot=(0, 0, 0),
          smooth=True, cap_bottom=True, cap_top=True):
    """Surface of revolution. profile = [(radius, z), ...] bottom->top."""
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        ring = [bm.verts.new((r * math.cos(2 * math.pi * j / ns),
                              r * math.sin(2 * math.pi * j / ns), z))
                for j in range(ns)]
        rings.append(ring)
    for i in range(len(rings) - 1):
        for j in range(ns):
            bm.faces.new((rings[i][j], rings[i][(j + 1) % ns],
                          rings[i + 1][(j + 1) % ns], rings[i + 1][j]))
    if cap_bottom:
        bm.faces.new(tuple(reversed(rings[0])))
    if cap_top:
        bm.faces.new(tuple(rings[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.transform(bm, matrix=M_of(loc, rot), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def ground_disc(coll, name, R, hfn, m_main, nr=62, ns=116, rim_z=-0.05):
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


# ── scene-specific ground ────────────────────────────────────
R = 4.6
KEG_C = (2.35, -1.15)


def hfn(x, y):
    z = 0.055 + 0.045 * math.sin(x * 1.25 + 0.7) * math.sin(y * 1.05 + 0.3) \
        + 0.02 * math.sin(x * 3.1 - y * 2.3)
    # keel drag furrow: from beach edge (-Y) up to the boat
    if -4.4 < y < -0.35:
        x0 = 1.15 + 0.16 * math.sin(y * 1.1)
        d = abs(x - x0)
        fade = min(1.0, (y + 4.4) / 0.7) * min(1.0, (-0.35 - y) / 0.5 + 0.35)
        fade = max(0.0, min(1.0, fade))
        z += (-0.115 * math.exp(-(d / 0.30) ** 2)
              + 0.065 * math.exp(-((d - 0.46) / 0.18) ** 2)) * fade
    # mound the kegs are half-buried in
    dk = math.hypot(x - KEG_C[0], y - KEG_C[1])
    z += 0.24 * math.exp(-(dk / 0.85) ** 2)
    return z


# ── props ────────────────────────────────────────────────────
def crate(coll, tag, loc, yaw, s=0.72, tilt=(0, 0)):
    """Closed banded crate. Returns (parts, bevel_list)."""
    parts, bev = [], []
    h = s * 0.82
    Mc = M_of((loc[0], loc[1], loc[2]), (tilt[0], tilt[1], yaw))

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
    # lid planks with tiny gaps
    for i in range(3):
        bm = bm_box(s * 0.31, s + 0.05, 0.05)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            ((i - 1) * s * 0.345, 0, h + 0.02)), verts=bm.verts)
        bev.append(add(bm, mat("Wood_Mid")))
    return parts, bev


def open_crate(coll, tag, loc, yaw, s=0.72, tilt=(0.14, 0)):
    """Pried-open crate: 4 walls + floor, tipped; battens; visible interior."""
    parts, bev = [], []
    h = s * 0.8
    t = 0.05
    Mc = M_of(loc, (tilt[0], tilt[1], yaw))

    def add(bm, m, sm=False):
        bmesh.ops.transform(bm, matrix=Mc, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        return o

    bm = bm_box(s, s, t)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, t / 2)), verts=bm.verts)
    bev.append(add(bm, mat("Wood_Dark")))
    for sx in (-1, 1):
        bm = bm_box(t, s, h)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (sx * (s - t) / 2, 0, h / 2)), verts=bm.verts)
        bev.append(add(bm, mat("Wood_Mid")))
        bm = bm_box(s - 2 * t, t, h)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0, sx * (s - t) / 2, h / 2)), verts=bm.verts)
        bev.append(add(bm, mat("Wood_Mid")))
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bm_box(0.07, 0.07, h + 0.02)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (sx * s / 2, sy * s / 2, h / 2)), verts=bm.verts)
            bev.append(add(bm, mat("Wood_Dark")))
    return parts, bev


def keg(coll, tag, loc, rot):
    parts = []
    prof = [(0.235, 0.0), (0.272, 0.14), (0.29, 0.35), (0.272, 0.56), (0.235, 0.70)]
    parts.append(lathe(coll, f"{tag}_body", prof, 16, mat("Keg_Red"),
                       loc=loc, rot=rot))
    for bz, br in ((0.10, 0.268), (0.35, 0.295), (0.60, 0.268)):
        bm = bm_cylinder(br + 0.012, br + 0.012, 0.045, segs=16, cap=False)
        bmesh.ops.transform(bm, matrix=M_of(loc, rot) @
                            Matrix.Translation((0, 0, bz)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_band{bz}", bm, coll,
                                    mat("Metal_Iron"), smooth=True))
    return parts


def bottle(coll, tag, loc, rot=(0, 0, 0)):
    prof = [(0.042, 0.0), (0.047, 0.02), (0.047, 0.17), (0.03, 0.21),
            (0.015, 0.24), (0.015, 0.305)]
    return lathe(coll, tag, prof, 10, mat("Bottle_Green"), loc=loc, rot=rot)


def lantern(coll, tag, loc, rot):
    """Unlit iron lantern (dark green glass panes, no emissive)."""
    parts, bev = [], []
    Ml = M_of(loc, rot)

    def add(bm, m, sm=False):
        bmesh.ops.transform(bm, matrix=Ml, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        return o

    bm = bm_cylinder(0.115, 0.125, 0.035, segs=10)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.018)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        bm = bm_box(0.022, 0.022, 0.24)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.095 * math.cos(a), 0.095 * math.sin(a), 0.15)), verts=bm.verts)
        bev.append(add(bm, mat("Metal_Iron")))
    for i in range(4):
        a = i * math.pi / 2
        bm = bm_box(0.135, 0.012, 0.20)
        bmesh.ops.transform(bm, matrix=M_of((0.088 * math.sin(a), 0.088 * math.cos(a), 0.15),
                                            (0, 0, a)), verts=bm.verts)
        add(bm, mat("Bottle_Green"))
    bm = bm_cylinder(0.135, 0.045, 0.09, segs=10)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.315)), verts=bm.verts)
    add(bm, mat("Metal_Iron"), True)
    # handle hoop
    pts = [(0.075 * math.cos(a), 0, 0.36 + 0.075 * math.sin(a))
           for a in [math.pi * t / 6 for t in range(7)]]
    for i in range(6):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        bm = bm_cylinder(0.011, 0.011, (b - a).length + 0.004, segs=5)
        q = (b - a).to_track_quat('Z', 'Y')
        bm2 = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=Ml @ bm2, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_h{i}", bm, coll, mat("Metal_Iron"), smooth=True))
    finish(bev, width=0.006)
    return parts


def rowboat(coll, tag, loc, yaw, roll):
    parts, bev = [], []
    Mb = M_of(loc, (0, roll, yaw))
    L, beam = 3.25, 1.16
    NU, NK = 19, 11

    def w_of(u):
        return beam / 2 * min(1.0, (u / 0.42) ** 0.65) * \
            (1 - 0.30 * max(0.0, (u - 0.85) / 0.15))

    def gun_of(u):
        return 0.46 + 0.10 * (abs(u - 0.42) / 0.58) ** 1.6

    def dep_of(u):
        return 0.40 * min(1.0, (u / 0.30) ** 0.8) * \
            (1 - 0.5 * max(0.0, (u - 0.85) / 0.15))

    bm = bmesh.new()
    grid = []
    for iu in range(NU + 1):
        u = iu / NU
        y = L / 2 - u * L      # bow at +Y (dragged inland)
        w, g, dep = max(0.015, w_of(u)), gun_of(u), dep_of(u)
        row = []
        for k in range(NK):
            t = k / (NK - 1)
            phi = (t - 0.5) * math.pi
            row.append(bm.verts.new((w * math.sin(phi), y, g - dep * math.cos(phi))))
        grid.append(row)
    for iu in range(NU):
        for k in range(NK - 1):
            bm.faces.new((grid[iu][k], grid[iu + 1][k],
                          grid[iu + 1][k + 1], grid[iu][k + 1]))
    bm.faces.new(tuple(grid[NU]))      # transom
    bmesh.ops.transform(bm, matrix=Mb, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_hull", bm, coll, mat("Wood_Mid"), smooth=True))
    # gunwale rails
    for side in (0, NK - 1):
        pts = []
        for iu in range(NU + 1):
            u = iu / NU
            w, g = max(0.015, w_of(u)), gun_of(u)
            phi = (side / (NK - 1) - 0.5) * math.pi
            pts.append(Mb @ Vector((w * math.sin(phi) * 1.02, L / 2 - u * L, g + 0.015)))
        parts += tube(coll, f"{tag}_rail{side}", pts, 0.035, 0.035,
                      mat("Wood_Dark"), segs=6)
    # lapstrake plank seams along each flank
    for sgn in (-1, 1):
        for pk in (0.22, 0.38):
            pts = []
            for iu in range(0, NU + 1, 2):
                u = iu / NU
                w, g, dep = max(0.015, w_of(u)), gun_of(u), dep_of(u)
                phi = sgn * (0.5 - pk) * math.pi
                pts.append(Mb @ Vector((w * math.sin(phi) * 1.01, L / 2 - u * L,
                                        g - dep * math.cos(phi) + 0.01)))
            parts += tube(coll, f"{tag}_seam{sgn}{pk}", pts, 0.018, 0.018,
                          mat("Wood_Dark"), segs=4)
    # keel strip
    pts = [Mb @ Vector((0, L / 2 - (iu / 8) * L, gun_of(iu / 8) - dep_of(iu / 8) - 0.02))
           for iu in range(9)]
    parts += tube(coll, f"{tag}_keel", pts, 0.045, 0.045, mat("Wood_Dark"), segs=5)
    # thwarts
    for u in (0.38, 0.66):
        w = w_of(u)
        bm = bm_box(w * 1.9, 0.26, 0.05)
        bmesh.ops.transform(bm, matrix=Mb @ Matrix.Translation(
            (0, L / 2 - u * L, gun_of(u) - 0.12)), verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_thwart{u}", bm, coll, mat("Wood_Mid"))
        parts.append(o); bev.append(o)
    # oar shipped inside
    op1 = Mb @ Vector((-0.18, 1.05, 0.30))
    op2 = Mb @ Vector((0.22, -1.15, 0.26))
    parts += tube(coll, f"{tag}_oar", [op1, op1.lerp(op2, 0.5), op2],
                  0.03, 0.03, mat("Wood_Dark"), segs=6)
    bm = bm_box(0.14, 0.5, 0.03)
    d = op2 - op1
    bmesh.ops.transform(bm, matrix=Matrix.Translation(op2 + d.normalized() * 0.22) @
                        d.to_track_quat('Y', 'Z').to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_blade", bm, coll, mat("Wood_Dark")))
    # painter rope trailing into the furrow
    bowp = Mb @ Vector((0, L / 2 - 0.05, 0.5))
    parts += rope_cat(coll, f"{tag}_painter", bowp,
                      (bowp.x - 0.25, bowp.y - 1.7, hfn(bowp.x - 0.25, bowp.y - 1.7) + 0.03),
                      sag=0.35, segs=7)
    finish(bev, width=0.012)
    return parts


def hand_cart(coll, tag, loc, yaw, pitch):
    parts, bev = [], []
    Mc = M_of(loc, (pitch, 0, yaw))

    def add(bm, m, sm=False, bevel=True):
        bmesh.ops.transform(bm, matrix=Mc, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        if bevel:
            bev.append(o)
        return o

    # bed of 4 planks + 2 side rails
    for i in range(4):
        bm = bm_box(0.20, 1.35, 0.035)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            ((i - 1.5) * 0.215, 0, 0.42)), verts=bm.verts)
        add(bm, mat("Wood_Mid"))
    for sx in (-1, 1):
        bm = bm_box(0.06, 1.42, 0.16)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (sx * 0.46, 0, 0.50)), verts=bm.verts)
        add(bm, mat("Wood_Dark"))
        # handles
        bm = bm_cylinder(0.028, 0.024, 0.75, segs=6)
        bmesh.ops.transform(bm, matrix=M_of((sx * 0.40, -0.98, 0.40),
                                            (math.radians(78), 0, 0)), verts=bm.verts)
        add(bm, mat("Wood_Dark"), True, bevel=False)
        # legs at the handle end
        bm = bm_cylinder(0.03, 0.03, 0.40, segs=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((sx * 0.40, 0.55, 0.20)),
                            verts=bm.verts)
        add(bm, mat("Wood_Dark"), True, bevel=False)
    # axle + wheels
    bm = bm_cylinder(0.035, 0.035, 1.15, segs=7)
    bmesh.ops.transform(bm, matrix=M_of((0, -0.30, 0.36), (0, math.pi / 2, 0)),
                        verts=bm.verts)
    add(bm, mat("Metal_Iron"), True, bevel=False)
    for sx in (-1, 1):
        bm = bm_cylinder(0.36, 0.36, 0.06, segs=14)
        bmesh.ops.transform(bm, matrix=M_of((sx * 0.56, -0.30, 0.36),
                                            (0, math.pi / 2, 0)), verts=bm.verts)
        o = add(bm, mat("Wood_Mid"), False)
        bm = bm_cylinder(0.375, 0.375, 0.05, segs=14, cap=False)
        bmesh.ops.transform(bm, matrix=M_of((sx * 0.56, -0.30, 0.36),
                                            (0, math.pi / 2, 0)), verts=bm.verts)
        add(bm, mat("Metal_Iron"), True, bevel=False)
        bm = bm_cylinder(0.07, 0.07, 0.10, segs=8)
        bmesh.ops.transform(bm, matrix=M_of((sx * 0.60, -0.30, 0.36),
                                            (0, math.pi / 2, 0)), verts=bm.verts)
        add(bm, mat("Wood_Dark"), True, bevel=False)
    finish(bev, width=0.010)
    return parts


# ── build ────────────────────────────────────────────────────
def build(name):
    coll = asset_collection(name)
    parts = []
    bev_all = []

    parts.append(ground_disc(coll, f"{name}_ground", R, hfn, mat("Sand")))
    displace_noise(parts[0], strength=0.035, scale=0.55, seed=5)
    apply_modifiers(parts[0])

    # rowboat at the end of its drag furrow
    parts += rowboat(coll, f"{name}_boat", (1.18, 0.65, hfn(1.18, 0.65) - 0.13),
                     math.radians(10), math.radians(7))

    # crate stack (5 crates) under tarp net
    stack = [((-2.00, 0.35), math.radians(6), 0.74, 0.0),
             ((-1.16, 0.28), math.radians(-8), 0.72, 0.0),
             ((-1.62, 1.10), math.radians(14), 0.70, 0.0),
             ((-1.78, 0.62), math.radians(-16), 0.66, 1.0),
             ((-1.10, 0.78), math.radians(23), 0.62, 1.0)]
    crate_tops = []
    for i, ((cx, cy), yw, s, level) in enumerate(stack):
        cz = hfn(cx, cy) - 0.04 + level * 0.60
        p, b = crate(coll, f"{name}_ck{i}", (cx, cy, cz), yw, s=s,
                     tilt=(rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03)))
        parts += p
        bev_all += b
        crate_tops.append((cx, cy, cz + s * 0.82 + 0.05, s / 2))

    def tarp_z(x, y):
        z = 0.035
        for (cx, cy, top, half) in crate_tops:
            dx = max(0.0, abs(x - cx) - half)
            dy = max(0.0, abs(y - cy) - half)
            z = max(z, top + 0.018 - 5.5 * (dx * dx + dy * dy))
        z += (0.030 * math.sin(7 * x + 3 * y) + 0.024 * math.sin(11 * y - 5 * x + 1)) \
            * min(1.0, z / 0.5 + 0.25)
        return max(z, 0.030)

    bm = bmesh.new()
    NX, NY = 34, 30
    X0, X1, Y0, Y1 = -2.95, -0.35, -0.55, 1.95
    g = {}
    for iy in range(NY + 1):
        for ix in range(NX + 1):
            x = X0 + (X1 - X0) * ix / NX
            y = Y0 + (Y1 - Y0) * iy / NY
            g[(ix, iy)] = bm.verts.new((x, y, tarp_z(x, y)))
    for iy in range(NY):
        for ix in range(NX):
            bm.faces.new((g[(ix, iy)], g[(ix + 1, iy)],
                          g[(ix + 1, iy + 1)], g[(ix, iy + 1)]))
    parts.append(obj_from_bmesh(f"{name}_tarp", bm, coll, mat("Canvas_Dirty"), smooth=True))

    # rope net draped over the tarp
    for i in range(8):
        x = X0 + 0.20 + (X1 - X0 - 0.40) * i / 7
        pts = [(x, Y0 + 0.18 + (Y1 - Y0 - 0.36) * j / 10,
                tarp_z(x, Y0 + 0.18 + (Y1 - Y0 - 0.36) * j / 10) + 0.026)
               for j in range(11)]
        parts += tube(coll, f"{name}_netx{i}", pts, 0.019, 0.019, mat("Rope"), segs=5)
    for j in range(8):
        y = Y0 + 0.18 + (Y1 - Y0 - 0.36) * j / 7
        pts = [(X0 + 0.20 + (X1 - X0 - 0.40) * i / 10, y,
                tarp_z(X0 + 0.20 + (X1 - X0 - 0.40) * i / 10, y) + 0.026)
               for i in range(11)]
        parts += tube(coll, f"{name}_nety{j}", pts, 0.019, 0.019, mat("Rope"), segs=5)
    # tie-down ropes from tarp corners to pegs
    for (cx, cy, px, py) in ((X0 + 0.2, Y0 + 0.2, X0 - 0.55, Y0 - 0.45),
                             (X1 - 0.2, Y1 - 0.2, X1 + 0.55, Y1 + 0.45),
                             (X0 + 0.2, Y1 - 0.2, X0 - 0.55, Y1 + 0.45)):
        parts += rope_cat(coll, f"{name}_tie{px:.1f}{py:.1f}",
                          (cx, cy, tarp_z(cx, cy)),
                          (px, py, hfn(px, py) + 0.04), sag=0.06, segs=5)
        bm = bm_cylinder(0.032, 0.014, 0.28, segs=5)
        bmesh.ops.transform(bm, matrix=M_of((px, py, hfn(px, py) + 0.06),
                                            (0.3, 0, 0)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_peg{px:.1f}", bm, coll, mat("Wood_Dark")))

    # 6th crate half-out from under the tarp edge, leaning
    p, b = crate(coll, f"{name}_ck5", (-0.42, 1.62, hfn(-0.42, 1.62) - 0.05),
                 math.radians(31), s=0.68, tilt=(math.radians(-6), math.radians(4)))
    parts += p
    bev_all += b

    # FOCAL: pried-open crate spilling bottles (front center, toward -Y)
    pc = (-0.25, -2.30)
    pcz = hfn(*pc) - 0.03
    p, b = open_crate(coll, f"{name}_pried", (pc[0], pc[1], pcz),
                      math.radians(-20), s=0.74, tilt=(math.radians(9), 0))
    parts += p
    bev_all += b
    # lid thrown on the ground beside it
    bm = bm_box(0.74, 0.78, 0.05)
    bmesh.ops.transform(bm, matrix=M_of((-1.05, -2.72, hfn(-1.05, -2.72) + 0.03),
                                        (math.radians(4), math.radians(-7),
                                         math.radians(38))), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_lid", bm, coll, mat("Wood_Mid"))
    parts.append(o); bev_all.append(o)
    # bottles: two standing inside, five spilled toward -Y, one intact pair
    parts.append(bottle(coll, f"{name}_bt0", (pc[0] - 0.12, pc[1] + 0.10, pcz + 0.10),
                        (math.radians(9), 0, 0)))
    parts.append(bottle(coll, f"{name}_bt1", (pc[0] + 0.14, pc[1] - 0.02, pcz + 0.10),
                        (math.radians(9), math.radians(6), 0)))
    for i in range(7):
        bx = pc[0] + rng.uniform(-0.4, 0.5)
        by = pc[1] - 0.5 - i * 0.13 + rng.uniform(-0.12, 0.12)
        parts.append(bottle(coll, f"{name}_bs{i}",
                            (bx, by, hfn(bx, by) + 0.045),
                            (math.radians(92), 0, rng.uniform(0, 6.28))))
    # crowbar leaning on the pried crate rim
    cb1 = Vector((pc[0] + 0.42, pc[1] - 0.18, pcz + 0.60))
    cb2 = Vector((pc[0] + 0.78, pc[1] - 0.62, hfn(pc[0] + 0.78, pc[1] - 0.62) + 0.02))
    parts += tube(coll, f"{name}_crow", [cb1, cb1.lerp(cb2, 0.5), cb2],
                  0.022, 0.022, mat("Metal_Iron"), segs=6)
    bm = bm_box(0.05, 0.10, 0.03)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(cb1 + Vector((0, 0.02, 0.03))) @
                        Euler((0.5, 0, 0.3)).to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crowtip", bm, coll, mat("Metal_Iron")))

    # knocked-over lantern near the pried crate
    parts += lantern(coll, f"{name}_lant", (0.42, -2.85, hfn(0.42, -2.85) + 0.10),
                     (math.radians(96), math.radians(8), math.radians(40)))

    # rum kegs half-buried in the mound
    kz = hfn(*KEG_C)
    parts += keg(coll, f"{name}_keg0", (KEG_C[0] - 0.42, KEG_C[1] + 0.16, kz - 0.15),
                 (math.radians(-14), math.radians(8), 0.4))
    parts += keg(coll, f"{name}_keg1", (KEG_C[0] + 0.38, KEG_C[1] - 0.18, kz - 0.18),
                 (math.radians(10), math.radians(-18), 1.9))
    parts += keg(coll, f"{name}_keg2", (KEG_C[0] + 0.10, KEG_C[1] + 0.62, kz - 0.26),
                 (math.radians(72), 0, 0.9))

    # hand cart tipped onto its handles
    parts += hand_cart(coll, f"{name}_cart", (-2.45, -1.95, hfn(-2.45, -1.95) - 0.02),
                       math.radians(64), math.radians(6))

    # rope coil dropped near the cart
    cx, cy = -1.35, -1.35
    for k in range(3):
        zc = hfn(cx, cy) + 0.035 + k * 0.032
        rr = 0.20 - k * 0.02
        pts = [(cx + rr * math.cos(a), cy + rr * math.sin(a), zc)
               for a in [2 * math.pi * t / 10 + k for t in range(11)]]
        parts += tube(coll, f"{name}_coil{k}", pts, 0.018, 0.018, mat("Rope"), segs=5)

    finish(bev_all, width=0.014)
    ship(coll, name, parts)


build("smuggler_cache")
print("SMUGGLER SCENE DONE")
