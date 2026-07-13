# rum_still — hero story scene for Rumrunner Key (fidelity pass).
# The still that blew: copper pot-still BURST open (torn petal metal, scorch),
# coiled copper worm pipe into a condenser barrel, scorch ring on the ground,
# intact barrel pyramid under a palm-thatch awning, bottle crates, and one
# skeleton blown into a sitting position against a barrel, tin cup in hand.
# Focal: the burst still. Scene faces -Y.
# Headless: Blender -b -P scripts/blender/build_scene_rumstill.py
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
    "Sand_Pad": ((0.68, 0.60, 0.44, 1.0), 0.95, 0.0),
    "Copper": ((0.55, 0.28, 0.15, 1.0), 0.45, 0.85),
    "Bottle_Green": ((0.10, 0.30, 0.16, 1.0), 0.35, 0.0),
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()
rng = random.Random(23)


# ── generic helpers (same idiom as other scene scripts) ──────
def M_of(loc=(0, 0, 0), rot=(0, 0, 0)):
    return Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4()


def tube(coll, name, pts, r1, r2, material, segs=6, smooth=True):
    parts = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        if d.length < 1e-5:
            continue
        ta, tb = i / max(1, n), (i + 1) / max(1, n)
        bm = bm_cylinder(r1 + (r2 - r1) * ta, r1 + (r2 - r1) * tb,
                         d.length + 0.006, segs=segs)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material, smooth=smooth))
    return parts


def lathe(coll, name, profile, ns, material, loc=(0, 0, 0), rot=(0, 0, 0),
          smooth=True, cap_bottom=True, cap_top=True):
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


# ── ground with scorch ring ──────────────────────────────────
R = 4.4
STILL = (0.0, -0.9)


def hfn(x, y):
    z = 0.05 + 0.04 * math.sin(x * 1.2 + 1.7) * math.sin(y * 1.0 - 0.4) \
        + 0.018 * math.sin(x * 3.3 + y * 2.1)
    d = math.hypot(x - STILL[0], y - STILL[1])
    z += 0.10 * math.exp(-(d / 1.0) ** 2)      # low blast mound under the still
    return z


def ground_disc(coll, name, R, hfn, m_main, m_scorch, nr=64, ns=120, rim_z=-0.05):
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
    obj = obj_from_bmesh(name, bm, coll, m_main, smooth=True)
    obj.data.materials.append(m_scorch)
    for p in obj.data.polygons:
        c = p.center
        d = math.hypot(c.x - STILL[0], c.y - STILL[1])
        edge = 1.32 + 0.24 * math.sin(math.atan2(c.y - STILL[1], c.x - STILL[0]) * 5)
        if d < edge:
            p.material_index = 1
    return obj


# ── props ────────────────────────────────────────────────────
def barrel(coll, tag, loc, rot, r=0.40, h=0.85, open_top=False):
    parts = []
    prof = [(r * 0.72, 0.0), (r * 0.93, h * 0.18), (r, h * 0.5),
            (r * 0.93, h * 0.82), (r * 0.72, h)]
    parts.append(lathe(coll, f"{tag}_body", prof, 16, mat("Wood_Mid"),
                       loc=loc, rot=rot, cap_top=not open_top))
    if open_top:
        # visible dark liquid surface inside
        parts.append(lathe(coll, f"{tag}_liq", [(r * 0.62, h * 0.8), (r * 0.62, h * 0.82)],
                           16, mat("Char_Black"), loc=loc, rot=rot))
    for bz in (h * 0.14, h * 0.5, h * 0.86):
        br = r * (0.93 + 0.07 * math.sin(math.pi * bz / h)) + 0.012
        bm = bm_cylinder(br, br, 0.05, segs=16, cap=False)
        bmesh.ops.transform(bm, matrix=M_of(loc, rot) @
                            Matrix.Translation((0, 0, bz)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_band{bz:.2f}", bm, coll,
                                    mat("Metal_Band"), smooth=True))
    return parts


def bottle(coll, tag, loc, rot=(0, 0, 0)):
    prof = [(0.042, 0.0), (0.047, 0.02), (0.047, 0.17), (0.03, 0.21),
            (0.015, 0.24), (0.015, 0.305)]
    return lathe(coll, tag, prof, 12, mat("Bottle_Green"), loc=loc, rot=rot)


def open_crate(coll, tag, loc, yaw, s=0.62, tilt=(0, 0)):
    parts, bev = [], []
    h, t = s * 0.72, 0.045
    Mc = M_of(loc, (tilt[0], tilt[1], yaw))

    def add(bm, m):
        bmesh.ops.transform(bm, matrix=Mc, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m)
        parts.append(o)
        bev.append(o)
        return o

    bm = bm_box(s, s, t)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, t / 2)), verts=bm.verts)
    add(bm, mat("Wood_Mid"))
    for sx in (-1, 1):
        bm = bm_box(t, s, h)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (sx * (s - t) / 2, 0, h / 2)), verts=bm.verts)
        add(bm, mat("Wood_Mid"))
        bm = bm_box(s - 2 * t, t, h)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0, sx * (s - t) / 2, h / 2)), verts=bm.verts)
        add(bm, mat("Wood_Mid"))
    return parts, bev, Mc, h


def skeleton_sitting(coll, tag, loc, yaw):
    """Blown into sitting position, back against a barrel, cup in right hand.
    Local frame: faces -Y."""
    parts = []
    Ms = M_of(loc, (0, 0, yaw))
    bone = mat("Bone")

    def T(p):
        return Ms @ Vector(p)

    def tb(nm, pts, r1, r2):
        parts.extend(tube(coll, f"{tag}_{nm}", [T(p) for p in pts], r1, r2, bone, segs=5))

    def ball(nm, p, r=0.032):
        bm = bm_icosphere(r, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(T(p)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_{nm}", bm, coll, bone, smooth=True))

    # pelvis + spine (leaning back)
    bm = bm_icosphere(0.10, 2)
    bmesh.ops.scale(bm, vec=Vector((1.5, 1.0, 0.85)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(T((0, 0.02, 0.15))), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_pelvis", bm, coll, bone, smooth=True))
    spine = [(0, 0.03, 0.18), (0, 0.06, 0.36), (0, 0.085, 0.54), (0, 0.10, 0.67)]
    tb("spine", spine, 0.030, 0.022)
    # skull, tilted back and to one side; open jaw
    bm = bm_icosphere(0.11, 2)
    bmesh.ops.scale(bm, vec=Vector((0.95, 1.05, 0.92)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Ms @ M_of((0.02, 0.08, 0.80),
                                             (math.radians(-16), math.radians(10), 0)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_skull", bm, coll, bone, smooth=True))
    bm = bm_box(0.10, 0.085, 0.035)
    bmesh.ops.transform(bm, matrix=Ms @ M_of((0.02, 0.005, 0.705),
                                             (math.radians(14), 0, 0)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_jaw", bm, coll, bone))
    for sx in (-1, 1):
        bm = bm_icosphere(0.023, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            T((0.02 + sx * 0.042, -0.012, 0.815))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_eye{sx}", bm, coll,
                                    mat("Char_Black"), smooth=True))
    # ribs: 5 arcs wrapping from the back around the chest
    for k, (zk, rk) in enumerate(((0.61, 0.155), (0.55, 0.175), (0.49, 0.185),
                                  (0.43, 0.175), (0.375, 0.155))):
        pts = []
        for a in [(-1.85 + 3.7 * t / 6) for t in range(7)]:
            pts.append((rk * math.sin(a), 0.10 - rk * 0.78 * math.cos(a),
                        zk - 0.05 * math.cos(a)))
        tb(f"rib{k}", pts, 0.014, 0.014)
    # clavicle
    tb("clav", [(-0.16, 0.07, 0.645), (0.16, 0.07, 0.645)], 0.014, 0.014)
    # legs splayed toward -Y
    tb("thighL", [(-0.10, 0.0, 0.14), (-0.16, -0.40, 0.13)], 0.030, 0.024)
    tb("shinL", [(-0.16, -0.40, 0.13), (-0.22, -0.78, 0.045)], 0.022, 0.017)
    ball("kneeL", (-0.16, -0.40, 0.13), 0.036)
    tb("thighR", [(0.10, 0.0, 0.14), (0.15, -0.33, 0.24)], 0.030, 0.024)
    tb("shinR", [(0.15, -0.33, 0.24), (0.185, -0.64, 0.05)], 0.022, 0.017)
    ball("kneeR", (0.15, -0.33, 0.24), 0.036)
    for sx, hy, hz in ((-1, -0.86, 0.045), (1, -0.72, 0.05)):
        bm = bm_box(0.075, 0.19, 0.05)
        bmesh.ops.transform(bm, matrix=Ms @ M_of((sx * 0.22, hy, hz),
                                                 (0, 0, sx * 0.2)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_foot{sx}", bm, coll, bone))
    # arms: left hangs to the ground, right bent up holding the cup
    tb("uarmL", [(-0.17, 0.06, 0.63), (-0.25, -0.09, 0.36)], 0.024, 0.019)
    tb("farmL", [(-0.25, -0.09, 0.36), (-0.30, -0.28, 0.07)], 0.018, 0.014)
    ball("elbL", (-0.25, -0.09, 0.36))
    ball("handL", (-0.30, -0.30, 0.06), 0.038)
    tb("uarmR", [(0.17, 0.06, 0.63), (0.27, -0.07, 0.33)], 0.024, 0.019)
    tb("farmR", [(0.27, -0.07, 0.33), (0.17, -0.27, 0.43)], 0.018, 0.014)
    ball("elbR", (0.27, -0.07, 0.33))
    ball("handR", (0.17, -0.27, 0.43), 0.038)
    ball("shoL", (-0.17, 0.06, 0.63), 0.036)
    ball("shoR", (0.17, 0.06, 0.63), 0.036)
    # tin cup, still held
    cup = lathe(coll, f"{tag}_cup", [(0.052, 0.0), (0.046, 0.005), (0.046, 0.10),
                                     (0.055, 0.115)], 10,
                mat("Metal_Band"), loc=T((0.17, -0.29, 0.44)),
                rot=(math.radians(12), math.radians(-8), 0), cap_top=False)
    parts.append(cup)
    return parts


# ── build ────────────────────────────────────────────────────
def build(name):
    coll = asset_collection(name)
    parts, bev_all = [], []

    parts.append(ground_disc(coll, f"{name}_ground", R, hfn,
                             mat("Sand_Pad"), mat("Char_Black")))
    displace_noise(parts[0], strength=0.03, scale=0.5, seed=9)
    apply_modifiers(parts[0])

    sx, sy = STILL
    gz = hfn(sx, sy)

    # FOCAL: the burst pot still on its scorched firebox
    parts.append(lathe(coll, f"{name}_firebox",
                       [(0.72, 0.0), (0.76, 0.12), (0.68, 0.50), (0.56, 0.60)],
                       18, mat("Char_Black"), loc=(sx, sy, gz - 0.05)))
    # fire door frame (blown open — hangs ajar)
    bm = bm_box(0.30, 0.05, 0.26)
    bmesh.ops.transform(bm, matrix=M_of((sx - 0.18, sy - 0.60, gz + 0.13),
                                        (math.radians(10), math.radians(30),
                                         math.radians(-35))), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_firedoor", bm, coll, mat("Metal_Band"))
    parts.append(o); bev_all.append(o)
    pot_prof = [(0.36, 0.55), (0.62, 0.68), (0.74, 1.00), (0.71, 1.26),
                (0.56, 1.50), (0.41, 1.64), (0.35, 1.72)]
    parts.append(lathe(coll, f"{name}_pot", pot_prof, 24, mat("Copper"),
                       loc=(sx, sy, gz), cap_top=False))
    # rivet band around the pot equator
    bm = bm_cylinder(0.745, 0.745, 0.055, segs=24, cap=False)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((sx, sy, gz + 1.01)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_potband", bm, coll, mat("Metal_Band"), smooth=True))
    # burst: torn petals peeled up and outward — a jagged torn crown
    for i in range(12):
        a = 2 * math.pi * i / 12 + 0.3
        out = rng.uniform(math.radians(28), math.radians(85))
        twist = rng.uniform(-0.45, 0.45)
        # tapered petal: box narrowed toward the tip
        bm = bm_box(0.21, 0.022, 0.38 + rng.uniform(0, 0.16))
        for v in bm.verts:
            if v.co.z > 0:
                v.co.x *= rng.uniform(0.25, 0.5)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.18)), verts=bm.verts)
        Mp = (Matrix.Translation((sx + 0.35 * math.cos(a), sy + 0.35 * math.sin(a),
                                  gz + 1.70)) @
              Matrix.Rotation(a + math.pi / 2, 4, 'Z') @
              Matrix.Rotation(out, 4, 'X') @ Matrix.Rotation(twist, 4, 'Y'))
        bmesh.ops.transform(bm, matrix=Mp, verts=bm.verts)
        m = mat("Char_Black") if i % 3 == 0 else mat("Copper")
        o = obj_from_bmesh(f"{name}_petal{i}", bm, coll, m)
        parts.append(o); bev_all.append(o)
    # two big torn dome pieces blown onto the ground
    for i, (dx, dy, yw) in enumerate(((-1.9, -1.55, 0.8), (0.6, -2.5, 2.4))):
        px, py = sx + dx, sy + dy
        bm = bm_icosphere(0.42, 2)
        bmesh.ops.scale(bm, vec=Vector((1.0, 0.85, 0.38)), verts=bm.verts)
        # keep only an upper shell wedge
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.02 or
                                   v.co.x + v.co.y * 0.6 < -0.25], context='VERTS')
        bmesh.ops.transform(bm, matrix=M_of((px, py, hfn(px, py) + 0.05),
                                            (rng.uniform(-0.3, 0.3), 0.15, yw)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_dome{i}", bm, coll, mat("Copper"),
                                    smooth=True))
    # swan-neck pipe blown clean off, lying bent on the scorch ring
    neck = [(-0.85, -2.05, 0.10), (-1.05, -2.15, 0.28), (-1.20, -2.02, 0.30),
            (-1.35, -1.85, 0.16), (-1.42, -1.70, 0.06)]
    neck = [(px, py, pz + hfn(px, py)) for (px, py, pz) in neck]
    parts += tube(coll, f"{name}_neck", neck, 0.085, 0.055, mat("Copper"), segs=8)
    # torn copper shards scattered across the scorch ring
    for i in range(13):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.9, 2.0)
        px, py = sx + d * math.cos(a), sy + d * math.sin(a)
        bm = bm_box(rng.uniform(0.08, 0.2), 0.015, rng.uniform(0.08, 0.16))
        bmesh.ops.transform(bm, matrix=M_of((px, py, hfn(px, py) + 0.02),
                                            (rng.uniform(0, 1.2), rng.uniform(0, 1.2),
                                             rng.uniform(0, 6.3))), verts=bm.verts)
        m = mat("Char_Black") if i % 2 else mat("Copper")
        parts.append(obj_from_bmesh(f"{name}_shard{i}", bm, coll, m))

    # worm coil descending into the condenser barrel (pipe torn mid-span)
    wc = (-1.45, -0.55)
    wz = hfn(*wc)
    parts += barrel(coll, f"{name}_cond", (wc[0], wc[1], wz - 0.05), (0, 0, 0.4),
                    r=0.42, h=0.88, open_top=True)
    helix = []
    turns, nseg = 2.7, 44
    for i in range(nseg + 1):
        t = i / nseg
        a = t * turns * 2 * math.pi
        hr = 0.31 - 0.05 * t
        helix.append((wc[0] + hr * math.cos(a), wc[1] + hr * math.sin(a),
                      wz + 1.58 - t * 0.85))
    parts += tube(coll, f"{name}_worm", helix, 0.05, 0.05, mat("Copper"), segs=8)
    # sphere joints smooth the coil's segment kinks
    for i, hp in enumerate(helix[1:-1]):
        bm = bm_icosphere(0.05, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(hp), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_wj{i}", bm, coll, mat("Copper"),
                                    smooth=True))
    # coil support tripod poles
    for i in range(3):
        a = 2 * math.pi * i / 3 + 0.5
        px, py = wc[0] + 0.52 * math.cos(a), wc[1] + 0.52 * math.sin(a)
        pts = [(px, py, hfn(px, py) - 0.05), (wc[0] + 0.05 * math.cos(a),
                                              wc[1] + 0.05 * math.sin(a), wz + 1.72)]
        parts += tube(coll, f"{name}_tri{i}", pts, 0.035, 0.028, mat("Wood_Mid"), segs=6)
    # feed pipe: snapped — stub from coil top, bent; stub near pot, drooping
    top = Vector(helix[0])
    parts += tube(coll, f"{name}_feedA", [top + Vector((0, 0, 0.0)),
                                          top + Vector((0.28, 0.10, 0.10)),
                                          top + Vector((0.5, 0.16, 0.02))],
                  0.05, 0.045, mat("Copper"), segs=7)
    pot_sh = Vector((sx - 0.36, sy + 0.14, gz + 1.52))
    parts += tube(coll, f"{name}_feedB", [pot_sh, pot_sh + Vector((-0.28, 0.05, 0.10)),
                                          pot_sh + Vector((-0.5, 0.08, -0.08))],
                  0.05, 0.045, mat("Copper"), segs=7)

    # barrel pyramid under the palm-thatch awning
    bp = (2.15, 0.75)
    yawp = math.radians(24)
    ax = Vector((math.cos(yawp), math.sin(yawp), 0))
    ay = Vector((-math.sin(yawp), math.cos(yawp), 0))
    bh, br = 0.82, 0.36

    def bpos(u, v, z):
        p = Vector((bp[0], bp[1], 0)) + ax * u + ay * v
        return (p.x, p.y, z)

    lay = math.radians(90)
    gz0 = hfn(*bpos(0, 0, 0)[:2])
    row_u = ((-0.76, 0.0, 0.76), (-0.38, 0.38), (0.0,))
    for layer, us in enumerate(row_u):
        z = gz0 + br - 0.07 + layer * br * math.sqrt(3)
        for i, u in enumerate(us):
            parts += barrel(coll, f"{name}_pyr{layer}{i}", bpos(u, bh / 2, z),
                            (lay, 0, yawp + rng.uniform(-0.05, 0.05)), r=br, h=bh)
    # chocks pinning the bottom row
    for u in (-1.18, 1.18):
        bm = bm_box(0.14, 0.5, 0.12)
        bmesh.ops.transform(bm, matrix=M_of(bpos(u, 0.0, gz0 + 0.04), (0, 0, yawp)),
                            verts=bm.verts)
        o = obj_from_bmesh(f"{name}_chock{u:.1f}", bm, coll, mat("Wood_Mid"))
        parts.append(o); bev_all.append(o)
    # awning: 4 poles + palm thatch slats, blast-side pole leaning
    corners = [(-1.35, -1.05, 2.05, -0.22), (1.35, -1.05, 2.15, 0.0),
               (-1.35, 1.05, 2.45, 0.0), (1.35, 1.05, 2.5, 0.0)]
    tops = []
    for i, (u, v, ph, lean) in enumerate(corners):
        base = bpos(u, v, 0)
        top = bpos(u + lean * 1.2, v, hfn(*base[:2]) + ph)
        tops.append(Vector(top))
        parts += tube(coll, f"{name}_pole{i}", [(base[0], base[1],
                                                 hfn(*base[:2]) - 0.07), top],
                      0.055, 0.045, mat("Wood_Mid"), segs=7)
    # thatch: overlapping dry-frond slats spanning the two beams
    for bi in range(2):
        parts += tube(coll, f"{name}_beam{bi}", [tops[bi * 2], tops[bi * 2 + 1]],
                      0.045, 0.045, mat("Wood_Mid"), segs=6)
    # rafters between the beams (visible from below)
    for t in (0.2, 0.5, 0.8):
        a = tops[0].lerp(tops[1], t)
        b = tops[2].lerp(tops[3], t)
        parts += tube(coll, f"{name}_rafter{t}", [a, b], 0.035, 0.035,
                      mat("Wood_Mid"), segs=5)
    n_sl = 14
    for layer in range(2):
        for i in range(n_sl):
            t = (i + layer * 0.5) / (n_sl - 1)
            if t > 1.0:
                continue
            a = tops[0].lerp(tops[1], t)
            b = tops[2].lerp(tops[3], t)
            c = a.lerp(b, 0.5)
            d = b - a
            bm = bm_box(0.34, d.length + 0.55, 0.028)
            z_jit = rng.uniform(-0.02, 0.03) + layer * 0.045
            bmesh.ops.transform(bm, matrix=Matrix.Translation(c + Vector((0, 0, 0.06 + z_jit))) @
                                d.to_track_quat('Y', 'Z').to_matrix().to_4x4() @
                                Matrix.Rotation(rng.uniform(-0.06, 0.06), 4, 'Z'),
                                verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_thatch{layer}_{i}", bm, coll,
                                        mat("Leaf_Dry")))
    # blast-blown fronds scattered on the ground near the still
    for i in range(6):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(1.7, 2.9)
        px, py = sx + d * math.cos(a), sy + d * math.sin(a)
        if math.hypot(px, py) > R - 0.5:
            continue
        bm = bm_box(0.24, 0.85, 0.02)
        bmesh.ops.transform(bm, matrix=M_of((px, py, hfn(px, py) + 0.02),
                                            (rng.uniform(-0.08, 0.08), 0,
                                             rng.uniform(0, 6.3))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_frond{i}", bm, coll, mat("Leaf_Dry")))

    # sugar-cane bundle leaning by the condenser
    cane_b = (-2.75, 0.15)
    cz = hfn(*cane_b)
    for i in range(9):
        a = 2 * math.pi * i / 9
        bx = cane_b[0] + 0.10 * math.cos(a)
        by = cane_b[1] + 0.10 * math.sin(a)
        top = (cane_b[0] + 0.30 * math.cos(a), cane_b[1] + 0.30 * math.sin(a),
               cz + 1.35 + rng.uniform(-0.15, 0.1))
        parts += tube(coll, f"{name}_cane{i}", [(bx, by, cz - 0.04), top],
                      0.030, 0.022, mat("Leaf_Dry"), segs=5)
    bm = bm_cylinder(0.17, 0.17, 0.07, segs=10, cap=False)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((cane_b[0], cane_b[1], cz + 0.55)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_caneband", bm, coll, mat("Wood_Mid"), smooth=True))
    # a second bundle dropped flat beside it
    for i in range(7):
        a0 = rng.uniform(0, 2 * math.pi)
        bx = cane_b[0] + 0.55 + rng.uniform(-0.08, 0.08)
        by = cane_b[1] - 0.75 + rng.uniform(-0.10, 0.10)
        dx, dy = math.cos(a0) * 0.02, math.sin(a0) * 0.02
        p1 = (bx - 0.65 - dx, by - dy * 8, hfn(bx, by) + 0.035 + i * 0.008)
        p2 = (bx + 0.65 + dx, by + dy * 8, hfn(bx, by) + 0.035 + i * 0.008)
        parts += tube(coll, f"{name}_cane2_{i}", [p1, p2], 0.026, 0.022,
                      mat("Leaf_Dry"), segs=5)

    # bottle crates (one tipped, bottles spilled)
    cc = (-2.55, 1.25)
    for j, (dx, dy, yw, tilt) in enumerate(((0, 0, 0.3, (0, 0)),
                                            (0.72, 0.18, -0.25, (0, 0)))):
        px, py = cc[0] + dx, cc[1] + dy
        p, b, Mc, h = open_crate(coll, f"{name}_bcr{j}", (px, py, hfn(px, py) - 0.03),
                                 yw, tilt=tilt)
        parts += p
        bev_all += b
        for bi in range(4):
            bx = px + rng.uniform(-0.16, 0.16)
            by = py + rng.uniform(-0.16, 0.16)
            parts.append(bottle(coll, f"{name}_cb{j}{bi}",
                                (bx, by, hfn(px, py) + 0.02),
                                (rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), 0)))
    # spilled loose bottles
    for i in range(4):
        bx = cc[0] + 0.4 + rng.uniform(-0.2, 0.6)
        by = cc[1] - 0.75 + rng.uniform(-0.25, 0.25)
        parts.append(bottle(coll, f"{name}_lb{i}", (bx, by, hfn(bx, by) + 0.045),
                            (math.radians(91), 0, rng.uniform(0, 6.3))))

    # the unlucky taster: barrel + skeleton blown against it, cup in hand
    skb = (1.42, -2.30)
    parts += barrel(coll, f"{name}_skbar", (skb[0], skb[1] + 0.42,
                                            hfn(skb[0], skb[1] + 0.42) - 0.06),
                    (0, 0, 1.1), r=0.38, h=0.82)
    parts += skeleton_sitting(coll, f"{name}_skel", (skb[0], skb[1],
                                                     hfn(*skb) - 0.02),
                              math.radians(-8))

    finish(bev_all, width=0.012)
    ship(coll, name, parts)


build("rum_still")
print("RUM STILL SCENE DONE")
