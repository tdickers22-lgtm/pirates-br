# dig_site — hero story scene for Booty Bay (fidelity pass).
# The double-cross at the dig: 3 cratered pits with spoil heaps, abandoned
# shovels + pick, an opened EMPTY grand chest (lid thrown back), a skeleton in
# the deepest pit with a tricorn hat over its face, a torn map pinned to a post
# by a dagger, the Black Fin pennant on a leaning stake, and a coin trail
# leading toward the surf. Focal: the empty chest. Scene faces -Y.
# Headless: Blender -b -P scripts/blender/build_scene_digsite.py
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
    "Dirt": ((0.62, 0.53, 0.38, 1.0), 0.95, 0.0),   # disturbed warm sand (pad rule)
    "Flag_Fin": ((0.09, 0.20, 0.23, 1.0), 0.9, 0.0),
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()
rng = random.Random(77)


# ── generic helpers ──────────────────────────────────────────
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


def ground_disc(coll, name, R, hfn, m_main, nr=74, ns=130):
    # hfn passed here must already include the rim feather (gfn below)
    bm = bmesh.new()
    center = bm.verts.new((0, 0, hfn(0, 0)))
    rings = []
    for i in range(1, nr + 1):
        r = R * i / nr
        ring = []
        for j in range(ns):
            a = 2 * math.pi * j / ns
            x, y = r * math.cos(a), r * math.sin(a)
            ring.append(bm.verts.new((x, y, hfn(x, y))))
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


# ── ground: 3 flat-bottomed crater pits with raised rims ─────
R = 5.0
PITS = [((1.75, 1.05), 1.28, 0.55),    # deepest — the skeleton pit
        ((-1.95, 0.95), 0.95, 0.40),
        ((-0.95, -2.25), 0.82, 0.34)]


def hfn(x, y):
    z = 0.06 + 0.04 * math.sin(x * 1.15 + 0.4) * math.sin(y * 0.95 + 1.2) \
        + 0.018 * math.sin(x * 3.0 - y * 2.4 + 2)
    for (px, py), pr, pd in PITS:
        d = math.hypot(x - px, y - py)
        z += -pd * math.exp(-((d / pr) ** 5) * 2.0)          # flat-bottomed pit
        z += pd * 0.40 * math.exp(-(((d - pr * 1.18) / (pr * 0.26)) ** 2))  # rim
    return z


# ── props ────────────────────────────────────────────────────
def spoil_heap(coll, tag, loc, s, seed):
    bm = bm_icosphere(1.0, 3)
    bmesh.ops.scale(bm, vec=Vector((s, s * rng.uniform(0.8, 1.15), s * 0.52)),
                    verts=bm.verts)
    bmesh.ops.transform(bm, matrix=M_of((loc[0], loc[1], loc[2]),
                                        (0, 0, rng.uniform(0, 6.3))), verts=bm.verts)
    o = obj_from_bmesh(tag, bm, coll, mat("Dirt"), smooth=True)
    displace_noise(o, strength=0.24, scale=0.8, seed=seed)
    displace_noise(o, strength=0.07, scale=0.35, seed=seed + 10)
    apply_modifiers(o)
    return o


def shovel(coll, tag, loc, rot):
    parts = []
    Msv = M_of(loc, rot)

    def T(p):
        return Msv @ Vector(p)

    parts += tube(coll, f"{tag}_shaft", [T((0, 0, 0)), T((0, 0, 1.25))],
                  0.024, 0.022, mat("Wood_Mid"), segs=6)
    bm = bm_box(0.17, 0.035, 0.28)
    bmesh.ops.transform(bm, matrix=Msv @ Matrix.Translation((0, 0, -0.13)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_blade", bm, coll, mat("Metal_Iron")))
    bm = bm_cylinder(0.022, 0.022, 0.16, segs=6)
    bmesh.ops.transform(bm, matrix=Msv @ M_of((0, 0, 1.27), (0, math.pi / 2, 0)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_grip", bm, coll, mat("Wood_Mid"), smooth=True))
    return parts


def pickaxe(coll, tag, loc, rot):
    parts = []
    Mp = M_of(loc, rot)

    def T(p):
        return Mp @ Vector(p)

    parts += tube(coll, f"{tag}_handle", [T((0, 0, 0)), T((0, 0, 0.95))],
                  0.028, 0.022, mat("Wood_Mid"), segs=6)
    arc = [(-0.42, 0, 0.86), (-0.22, 0, 0.95), (0, 0, 0.98),
           (0.22, 0, 0.95), (0.42, 0, 0.86)]
    parts += tube(coll, f"{tag}_head", [T(p) for p in arc], 0.014, 0.045,
                  mat("Metal_Iron"), segs=6)
    parts += tube(coll, f"{tag}_head2", [T(arc[2]), T(arc[0])], 0.045, 0.014,
                  mat("Metal_Iron"), segs=6)
    return parts


def grand_chest(coll, tag, loc, yaw):
    """Opened EMPTY grand chest, lid thrown right back. Bigger than the game
    chest prop. Origin at its ground center; front faces -Y (local)."""
    parts, bev = [], []
    Mc = M_of(loc, (0, 0, yaw))
    W, D, H = 1.42, 0.88, 0.66

    def add(bm, m, sm=False, bevel=True):
        bmesh.ops.transform(bm, matrix=Mc, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        if bevel:
            bev.append(o)
        return o

    bm = bm_box(W, D, H)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, H / 2)), verts=bm.verts)
    add(bm, mat("Wood_Dark"))
    # dark empty interior: top face sits below the rim (reads as a cavity)
    bm = bm_box(W - 0.13, D - 0.13, H - 0.20)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, (H - 0.20) / 2 + 0.08)),
                        verts=bm.verts)
    add(bm, mat("Wood_Dark"), bevel=False)
    # gold straps on the body
    for ux in (-0.40, 0.40):
        bm = bm_box(0.09, D + 0.05, H + 0.03)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((ux, 0, H / 2)), verts=bm.verts)
        add(bm, mat("Gold"))
    # lock plate front
    bm = bm_box(0.16, 0.04, 0.18)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -D / 2 - 0.01, H - 0.10)),
                        verts=bm.verts)
    add(bm, mat("Gold"))
    # corner caps
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bm_box(0.10, 0.10, 0.14)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (sx * (W / 2 - 0.02), sy * (D / 2 - 0.02), 0.07)), verts=bm.verts)
            add(bm, mat("Gold"))
    # curved lid thrown back past vertical (rests tilted behind the body)
    lid = bmesh.new()
    NL, NA = 2, 9
    rows = []
    for il in range(NL + 1):
        lx = (il / NL - 0.5) * W
        row = []
        for ia in range(NA):
            t = ia / (NA - 1)
            ly = -D * t
            lz = 0.30 * math.sin(math.pi * t)
            row.append(lid.verts.new((lx, ly, lz)))
        rows.append(row)
    for il in range(NL):
        for ia in range(NA - 1):
            lid.faces.new((rows[il][ia], rows[il + 1][ia],
                           rows[il + 1][ia + 1], rows[il][ia + 1]))
    for il, rev in ((0, False), (NL, True)):
        f = list(rows[il]) + []
        lid.faces.new(tuple(reversed(f)) if rev else tuple(f))
    lid.faces.new((rows[0][0], rows[0][NA - 1], rows[NL][NA - 1], rows[NL][0]))
    bmesh.ops.recalc_face_normals(lid, faces=lid.faces)
    # hinge at body back-top edge; thrown back past vertical
    Mlid = Mc @ Matrix.Translation((0, D / 2, H)) @ \
        Matrix.Rotation(math.radians(104), 4, 'X')
    bmesh.ops.transform(lid, matrix=Mlid, verts=lid.verts)
    o = obj_from_bmesh(f"{tag}_lid", lid, coll, mat("Wood_Dark"), smooth=True)
    parts.append(o); bev.append(o)
    # gold straps following the lid arc
    for ux in (-0.40, 0.40):
        arc = []
        for ia in range(NA):
            t = ia / (NA - 1)
            arc.append(Mlid @ Vector((ux, -D * t, 0.30 * math.sin(math.pi * t) + 0.02)))
        parts.extend(tube(coll, f"{tag}_lstrap{ux:.1f}", arc, 0.045, 0.045,
                          mat("Gold"), segs=4, smooth=False))
    # hasp dangling from the lid front edge
    hp = Mlid @ Vector((0, -D, 0.02))
    parts.extend(tube(coll, f"{tag}_hasp", [hp, hp + Vector((0, 0.02, -0.14))],
                      0.03, 0.03, mat("Gold"), segs=4, smooth=False))
    return parts, bev


def skeleton_lying(coll, tag, loc, yaw):
    """Face-up in the pit, tricorn hat over its face. Local: head toward -Y."""
    parts = []
    Ms = M_of(loc, (0, 0, yaw))
    bone = mat("Bone")

    def T(p):
        return Ms @ Vector(p)

    def tb(nm, pts, r1, r2):
        parts.extend(tube(coll, f"{tag}_{nm}", [T(p) for p in pts], r1, r2,
                          bone, segs=5))

    def ball(nm, p, r=0.032):
        bm = bm_icosphere(r, 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(T(p)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_{nm}", bm, coll, bone, smooth=True))

    # skull face-up
    bm = bm_icosphere(0.11, 2)
    bmesh.ops.scale(bm, vec=Vector((0.95, 1.08, 0.9)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Ms @ M_of((0, -0.44, 0.10),
                                             (math.radians(-90), 0, 0)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_skull", bm, coll, bone, smooth=True))
    bm = bm_box(0.10, 0.05, 0.085)
    bmesh.ops.transform(bm, matrix=Ms @ Matrix.Translation((0, -0.335, 0.075)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_jaw", bm, coll, bone))
    # spine + pelvis
    tb("spine", [(0, -0.30, 0.065), (0, -0.05, 0.07), (0, 0.20, 0.065)], 0.028, 0.024)
    bm = bm_icosphere(0.10, 2)
    bmesh.ops.scale(bm, vec=Vector((1.5, 1.0, 0.6)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(T((0, 0.28, 0.07))), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_pelvis", bm, coll, bone, smooth=True))
    # ribs arcing over the chest
    for k, (yk, rk) in enumerate(((-0.24, 0.14), (-0.16, 0.165), (-0.08, 0.175),
                                  (0.0, 0.165), (0.075, 0.145))):
        pts = []
        for a in [(-1.5 + 3.0 * t / 6) for t in range(7)]:
            pts.append((rk * math.sin(a), yk, 0.045 + rk * 0.85 * math.cos(a)))
        tb(f"rib{k}", pts, 0.013, 0.013)
    # arms: right flung out, left across the chest
    tb("uarmR", [(0.16, -0.26, 0.07), (0.40, -0.34, 0.05)], 0.023, 0.018)
    tb("farmR", [(0.40, -0.34, 0.05), (0.60, -0.22, 0.045)], 0.017, 0.013)
    ball("elbR", (0.40, -0.34, 0.05))
    ball("handR", (0.62, -0.20, 0.045), 0.036)
    tb("uarmL", [(-0.16, -0.26, 0.07), (-0.31, -0.06, 0.07)], 0.023, 0.018)
    tb("farmL", [(-0.31, -0.06, 0.07), (-0.05, -0.02, 0.19)], 0.017, 0.013)
    ball("elbL", (-0.31, -0.06, 0.07))
    ball("handL", (-0.05, -0.02, 0.20), 0.036)
    ball("shoR", (0.16, -0.26, 0.075), 0.034)
    ball("shoL", (-0.16, -0.26, 0.075), 0.034)
    # legs, knees slightly bent
    tb("thighR", [(0.09, 0.33, 0.065), (0.14, 0.62, 0.10)], 0.028, 0.022)
    tb("shinR", [(0.14, 0.62, 0.10), (0.17, 0.92, 0.05)], 0.020, 0.016)
    ball("kneeR", (0.14, 0.62, 0.10), 0.035)
    tb("thighL", [(-0.09, 0.33, 0.065), (-0.12, 0.60, 0.085)], 0.028, 0.022)
    tb("shinL", [(-0.12, 0.60, 0.085), (-0.13, 0.90, 0.05)], 0.020, 0.016)
    ball("kneeL", (-0.12, 0.60, 0.085), 0.035)
    for sxx, hy in ((0.17, 0.99), (-0.13, 0.97)):
        bm = bm_box(0.07, 0.16, 0.05)
        bmesh.ops.transform(bm, matrix=Ms @ Matrix.Translation((sxx, hy, 0.05)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_foot{sxx:.2f}", bm, coll, bone))
    # tricorn hat resting over the face
    hat_loc = T((0, -0.45, 0.16))
    crown = lathe(coll, f"{tag}_crown", [(0.105, 0.0), (0.118, 0.05), (0.09, 0.10),
                                         (0.055, 0.135)], 14, mat("Wood_Dark"),
                  loc=hat_loc, rot=(0.06, 0.04, yaw), cap_bottom=False)
    parts.append(crown)
    brim = bmesh.new()
    NB = 24
    rin, rout = 0.10, 0.195
    ring_i, ring_o = [], []
    for j in range(NB):
        a = 2 * math.pi * j / NB
        lift = 0.075 * ((0.5 + 0.5 * math.cos(3 * (a - 0.5))) ** 2)
        ring_i.append(brim.verts.new((rin * math.cos(a), rin * math.sin(a), 0.005)))
        ring_o.append(brim.verts.new((rout * math.cos(a), rout * math.sin(a),
                                      0.005 + lift)))
    for j in range(NB):
        brim.faces.new((ring_i[j], ring_o[j], ring_o[(j + 1) % NB],
                        ring_i[(j + 1) % NB]))
    bmesh.ops.transform(brim, matrix=Matrix.Translation(hat_loc) @
                        Euler((0.06, 0.04, yaw)).to_matrix().to_4x4(), verts=brim.verts)
    parts.append(obj_from_bmesh(f"{tag}_brim", brim, coll, mat("Wood_Dark"), smooth=True))
    return parts


def black_fin_pennant(coll, tag, hoist_base, up_dir, fly_dir):
    """THE Black Fin motif: 1.5 x 0.9 m tattered pennant. Flag_Fin field,
    Bone shark-fin applique (2 cm relief), 3 triangular bite-notches in the
    fly edge, cloth sag."""
    parts = []
    hoist = Vector(hoist_base)
    up = Vector(up_dir).normalized()
    fly = Vector(fly_dir).normalized()
    FL, FH = 1.5, 0.9
    nrm = fly.cross(up).normalized()

    def fsurf(u, v):
        p = hoist + fly * u + up * v
        droop = 0.30 * (u / FL) ** 1.7 * (1.25 - 0.5 * v / FH)
        p = p - Vector((0, 0, droop))
        amp = 0.05 * (u / FL) * max(0.25, 1.0 - abs(u - 0.72) / 0.45)
        p = p + nrm * (amp * math.sin(u * 5.2 - v * 2.6) +
                       0.02 * (u / FL) * math.sin(v * 7 + u * 3))
        return p

    # bite notches: triangles cut into the fly edge at these v-centers
    notches = [(0.16, 0.09, 0.17), (0.46, 0.10, 0.20), (0.74, 0.08, 0.15)]

    def in_notch(u, v):
        for (vc, hh, dep) in notches:
            if abs(v - vc) < hh and u > FL - dep * (1 - abs(v - vc) / hh):
                return True
        return False

    bm = bmesh.new()
    NU, NV = 30, 18
    g = {}
    for iv in range(NV + 1):
        for iu in range(NU + 1):
            g[(iu, iv)] = bm.verts.new(fsurf(FL * iu / NU, FH * iv / NV))
    for iv in range(NV):
        for iu in range(NU):
            uc, vc = FL * (iu + 0.5) / NU, FH * (iv + 0.5) / NV
            if in_notch(uc, vc):
                continue
            bm.faces.new((g[(iu, iv)], g[(iu + 1, iv)],
                          g[(iu + 1, iv + 1)], g[(iu, iv + 1)]))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces],
                     context='VERTS')
    parts.append(obj_from_bmesh(f"{tag}_field", bm, coll, mat("Flag_Fin"), smooth=True))

    # shark-fin applique, raised 2 cm off the cloth
    u0, v0 = 0.68, 0.30
    du = 0.02
    tu = (fsurf(u0 + du, v0) - fsurf(u0 - du, v0)).normalized()
    tv = (fsurf(u0, v0 + du) - fsurf(u0, v0 - du)).normalized()
    fn = tu.cross(tv).normalized()
    base = fsurf(u0, v0)
    # stylized dorsal fin: long base, steep curved leading edge, swept tip
    outline = [(-0.30, 0.0), (0.28, 0.0), (0.20, 0.14), (0.05, 0.26),
               (-0.08, 0.40), (-0.20, 0.22)]
    for side, (o1, o2) in enumerate(((0.008, 0.028), (-0.028, -0.008))):
        fin = bmesh.new()
        lo = [fin.verts.new(base + tu * a + tv * b + fn * o1) for (a, b) in outline]
        hi = [fin.verts.new(base + tu * a + tv * b + fn * o2) for (a, b) in outline]
        fin.faces.new(tuple(reversed(lo)))
        fin.faces.new(tuple(hi))
        for i in range(len(outline)):
            j = (i + 1) % len(outline)
            fin.faces.new((lo[i], lo[j], hi[j], hi[i]))
        bmesh.ops.recalc_face_normals(fin, faces=fin.faces)
        parts.append(obj_from_bmesh(f"{tag}_fin{side}", fin, coll, mat("Bone")))
    # rope lashings at hoist corners
    for vv in (0.04, FH - 0.04):
        p = fsurf(0.0, vv)
        parts += tube(coll, f"{tag}_lash{vv:.2f}",
                      [p - fly * 0.06 - nrm * 0.05, p, p - fly * 0.06 + nrm * 0.05],
                      0.012, 0.012, mat("Wood_Mid"), segs=4)
    return parts


# ── build ────────────────────────────────────────────────────
def build(name):
    coll = asset_collection(name)
    parts, bev_all = [], []

    ground = ground_disc(coll, f"{name}_ground", R, hfn, mat("Dirt"))
    displace_noise(ground, strength=0.035, scale=0.5, seed=3)
    apply_modifiers(ground)
    parts.append(ground)

    # spoil heaps flanking each pit (thrown outward, away from center clutter)
    heap_dirs = [(0.85, 0.75), (-0.8, 0.7), (-0.75, -0.75)]
    for i, (((px, py), pr, pd), (hx, hy)) in enumerate(zip(PITS, heap_dirs)):
        d = Vector((hx, hy, 0)).normalized()
        hp = Vector((px, py, 0)) + d * (pr * 1.75)
        parts.append(spoil_heap(coll, f"{name}_heap{i}",
                                (hp.x, hp.y, hfn(hp.x, hp.y) - 0.10),
                                pr * 0.62, seed=20 + i))
        # a second smaller throw of spoil
        hp2 = Vector((px, py, 0)) + Vector((d.y, -d.x, 0)) * (pr * 1.6)
        parts.append(spoil_heap(coll, f"{name}_heap{i}b",
                                (hp2.x, hp2.y, hfn(hp2.x, hp2.y) - 0.08),
                                pr * 0.38, seed=40 + i))

    # FOCAL: the opened empty grand chest, front toward -Y, beside pit 1
    ch = (0.55, -1.15)
    p, b = grand_chest(coll, f"{name}_chest", (ch[0], ch[1], hfn(*ch) - 0.03),
                       math.radians(-8))
    parts += p
    bev_all += b

    # skeleton in the deepest pit, hat over its face
    (px, py), pr, pd = PITS[0]
    floor_z = hfn(px, py)
    parts += skeleton_lying(coll, f"{name}_skel", (px - 0.1, py - 0.05, floor_z + 0.02),
                            math.radians(205))

    # abandoned tools
    parts += shovel(coll, f"{name}_shv0",
                    (PITS[1][0][0] - 0.55, PITS[1][0][1] + 1.35,
                     hfn(PITS[1][0][0] - 0.55, PITS[1][0][1] + 1.35) + 0.32),
                    (math.radians(-38), math.radians(8), 0.4))   # stuck in heap
    parts += shovel(coll, f"{name}_shv1", (2.9, -0.4, hfn(2.9, -0.4) + 0.05),
                    (math.radians(96), 0, math.radians(65)))     # dropped flat
    parts += pickaxe(coll, f"{name}_pick", (-1.65, -1.5, hfn(-1.65, -1.5) + 0.06),
                     (math.radians(94), math.radians(6), math.radians(-30)))

    # torn map pinned to a post by a dagger
    post = (-2.45, -1.15)
    pz = hfn(*post)
    parts += tube(coll, f"{name}_post", [(post[0], post[1], pz - 0.08),
                                         (post[0] + 0.06, post[1], pz + 1.45)],
                  0.065, 0.05, mat("Wood_Dark"), segs=7)
    # map: wrinkled sheet on the -Y face of the post, bottom edge torn
    bm = bmesh.new()
    NX, NZ = 12, 14
    MW, MH = 0.56, 0.68
    g = {}
    for iz in range(NZ + 1):
        for ix in range(NX + 1):
            u, v = ix / NX, iz / NZ
            x = post[0] + (u - 0.5) * MW + 0.015 * math.sin(v * 9 + u * 4)
            zpt = pz + 0.62 + v * MH
            y = post[1] - 0.075 - 0.035 * math.sin(u * math.pi) \
                - 0.02 * math.sin(v * 8 + u * 5)
            g[(ix, iz)] = bm.verts.new((x, y, zpt))
    for iz in range(NZ):
        for ix in range(NX):
            u = (ix + 0.5) / NX
            v = (iz + 0.5) / NZ
            if v < 0.18 and math.sin(u * 19.0) > 0.15:   # torn lower edge
                continue
            bm.faces.new((g[(ix, iz)], g[(ix + 1, iz)],
                          g[(ix + 1, iz + 1)], g[(ix, iz + 1)]))
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces],
                     context='VERTS')
    parts.append(obj_from_bmesh(f"{name}_map", bm, coll, mat("Canvas"), smooth=True))
    # the dagger through the map top
    dag = Vector((post[0] + 0.02, post[1] - 0.10, pz + 0.62 + MH - 0.06))
    ddir = Vector((0.1, 1.0, 0.35)).normalized()
    parts += tube(coll, f"{name}_dblade", [dag - ddir * 0.16, dag + ddir * 0.10],
                  0.030, 0.008, mat("Metal_Iron"), segs=4)
    bm = bm_box(0.14, 0.025, 0.035)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(dag - ddir * 0.17) @
                        ddir.to_track_quat('Y', 'Z').to_matrix().to_4x4(),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_dguard", bm, coll, mat("Metal_Iron")))
    parts += tube(coll, f"{name}_dgrip", [dag - ddir * 0.18, dag - ddir * 0.30],
                  0.022, 0.018, mat("Wood_Dark"), segs=5)
    bmp = bm_icosphere(0.026, 1)
    bmesh.ops.transform(bmp, matrix=Matrix.Translation(dag - ddir * 0.31), verts=bmp.verts)
    parts.append(obj_from_bmesh(f"{name}_dpom", bmp, coll, mat("Metal_Iron"), smooth=True))

    # Black Fin pennant on a leaning stake
    st = (2.62, -0.35)
    stz = hfn(*st)
    lean = Vector((-0.42, -0.30, 1.0)).normalized()
    stake_top = Vector((st[0], st[1], stz)) + lean * 2.45
    parts += tube(coll, f"{name}_stake", [(st[0], st[1], stz - 0.10), tuple(stake_top)],
                  0.055, 0.038, mat("Wood_Dark"), segs=7)
    hoist_base = Vector((st[0], st[1], stz)) + lean * 1.35
    up_flag = (stake_top - hoist_base).normalized()
    fly_dir = up_flag.cross(Vector((0, -1, 0))).normalized()
    if fly_dir.x < 0:
        fly_dir = -fly_dir       # fly outward, clear of the chest silhouette
    parts += black_fin_pennant(coll, f"{name}_pennant", hoist_base, up_flag, fly_dir)

    # coin trail: cluster at the chest thinning toward the -Y edge (the surf)
    trail_pts = []
    for i in range(9):     # spill cluster by the chest
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.15, 0.75)
        trail_pts.append((ch[0] + d * math.cos(a), ch[1] - 0.35 + d * math.sin(a) * 0.7))
    for i in range(15):    # the trail proper
        t = i / 14
        tx = ch[0] + (1.15 - ch[0]) * t + 0.35 * math.sin(t * 5) + rng.uniform(-0.12, 0.12)
        ty = ch[1] - 0.5 + (-4.7 - ch[1] + 0.5) * t + rng.uniform(-0.1, 0.1)
        if math.hypot(tx, ty) > R - 0.25:
            continue
        trail_pts.append((tx, ty))
    for i, (cx, cy) in enumerate(trail_pts):
        bm = bm_cylinder(0.038, 0.038, 0.009, segs=8)
        bmesh.ops.transform(bm, matrix=M_of((cx, cy, hfn(cx, cy) + 0.008),
                                            (rng.uniform(-0.15, 0.15),
                                             rng.uniform(-0.15, 0.15),
                                             rng.uniform(0, 6.3))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_coin{i}", bm, coll, mat("Gold")))

    # a shovel abandoned in the deepest pit beside the skeleton
    parts += shovel(coll, f"{name}_shv2",
                    (PITS[0][0][0] + 0.55, PITS[0][0][1] + 0.35,
                     hfn(PITS[0][0][0] + 0.55, PITS[0][0][1] + 0.35) + 0.06),
                    (math.radians(95), math.radians(4), math.radians(140)))

    # dirt clods scattered around the rims and heaps
    for i in range(34):
        (ppx, ppy), pr, _pd = PITS[i % 3]
        a = rng.uniform(0, 2 * math.pi)
        d = pr * rng.uniform(1.15, 1.9)
        cx, cy = ppx + d * math.cos(a), ppy + d * math.sin(a)
        if math.hypot(cx, cy) > R - 0.4:
            continue
        bm = bm_icosphere(rng.uniform(0.045, 0.11), 1)
        bmesh.ops.scale(bm, vec=Vector((1.2, 1.0, 0.7)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=M_of((cx, cy, hfn(cx, cy) + 0.02),
                                            (0, 0, rng.uniform(0, 6.3))), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_clod{i}", bm, coll, mat("Dirt"),
                                    smooth=True))

    finish(bev_all, width=0.013)
    ship(coll, name, parts)


build("dig_site")
print("DIG SITE SCENE DONE")
