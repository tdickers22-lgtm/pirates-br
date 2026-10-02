# Camp + landmark set — fidelity pass.
#   tent_a    saggy wrinkled canvas A-tent, guy ropes to pegs, patched panel
#   bedroll   rolled blanket + wrinkled mat + rope ties
#   rock_arch natural weathered stone arch (icosphere masses + dual displace)
# Headless: Blender -b -P scripts/blender/build_camp.py
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


def rope_cat(coll, name, p1, p2, sag, r=0.016, segs=5):
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
        bm = bm_cylinder(r, r, d.length + 0.008, segs=5)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((pts[i] + pts[i + 1]) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, mat("Rope"), smooth=True))
    return parts


def peg(coll, name, x, y, tilt=0.25):
    bm = bm_cylinder(0.032, 0.014, 0.28, segs=5)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, 0.08)) @
                        Matrix.Rotation(tilt, 4, 'X'), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat("Wood_Dark"))


def finish(objs, width=0.015, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


def ship_and_export(coll, name, obj):
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR)
    for o in coll.objects:
        o.hide_render = True
    print(f"built {name}")


# ═════════════════════════════════════════════════════════════
# TENT_A — footprint ±1.12 x ±2.41, ridge ~1.95 (kept)
# ═════════════════════════════════════════════════════════════
def build_tent(name):
    coll = asset_collection(name)
    rng = random.Random(7)
    parts, bev = [], []

    ridge_h = 1.95
    half_w = 1.02
    length = 2.7

    # A-frame crossed pole pairs + ridge pole (tips poke through the canvas)
    for ey in (-length / 2, length / 2):
        for side in (-1, 1):
            bm = bm_cylinder(0.05, 0.032, 2.16, segs=6)
            tilt = math.atan2(half_w * 0.82, ridge_h)
            m = (Matrix.Translation((side * half_w * 0.41, ey, ridge_h * 0.5 + 0.06))
                 @ Matrix.Rotation(-side * tilt, 4, 'Y'))
            bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
            o = obj_from_bmesh(f"{name}_pole{ey}{side}", bm, coll, mat("Wood_Mid"), smooth=True)
            parts.append(o); bev.append(o)
    bm = bm_cylinder(0.045, 0.045, length + 0.55, segs=6)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, ridge_h)) @
                        Matrix.Rotation(math.pi / 2, 4, 'X'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_ridge", bm, coll, mat("Wood_Dark"), smooth=True)
    parts.append(o); bev.append(o)

    # Canvas: dense draped grid — catenary ridge sag, slope belly, hem flare,
    # and layered wrinkle noise so it reads as tired cloth.
    bm = bmesh.new()
    nx, ny = 16, 12
    grid = {}
    for iy in range(ny + 1):
        v = iy / ny
        y = (v - 0.5) * (length + 0.35)
        sag = math.sin(v * math.pi) * 0.12          # deeper ridge sag
        for ix in range(nx + 1):
            u = ix / nx
            t = abs(u - 0.5) * 2                     # 0 ridge -> 1 hem
            x = (u - 0.5) * 2 * half_w * (1 + 0.10 * t * t)
            z = (ridge_h - sag) * (1 - t) + 0.035 * t
            belly = math.sin(t * math.pi) * 0.055 * (0.6 + 0.4 * math.sin(v * math.pi))
            z -= belly                               # cloth bellies between poles
            z += (math.sin(u * 21 + v * 13) + math.sin(u * 9 - v * 17)) * 0.014 * t
            x += math.sin(v * 25 + u * 7) * 0.016 * t   # hem wander
            grid[(ix, iy)] = bm.verts.new((x, y, max(z, 0.02)))
    for iy in range(ny):
        for ix in range(nx):
            bm.faces.new((grid[(ix, iy)], grid[(ix + 1, iy)],
                          grid[(ix + 1, iy + 1)], grid[(ix, iy + 1)]))
    parts.append(obj_from_bmesh(f"{name}_canvas", bm, coll, mat("Canvas_Dirty"), smooth=True))

    # Patched panel + rope stitches around it
    bm = bmesh.new()
    pquad = ((0, 0), (0.34, 0.05), (0.3, 0.42), (-0.03, 0.38))
    pv = [bm.verts.new((0.55 + dx, -0.45 + dy, ridge_h * 0.52 + (0.55 + dx) * -0.62 + 0.045))
          for dx, dy in pquad]
    bm.faces.new(pv)
    parts.append(obj_from_bmesh(f"{name}_patch", bm, coll, mat("Canvas")))
    for si in range(5):
        a = si / 4
        ex = 0.55 + (pquad[0][0] * (1 - a) + pquad[1][0] * a)
        ey2 = -0.45 + (pquad[0][1] * (1 - a) + pquad[1][1] * a)
        bm = bm_box(0.015, 0.05, 0.06)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (ex, ey2 - 0.02, ridge_h * 0.52 + ex * -0.62 + 0.05)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_stitch{si}", bm, coll, mat("Rope")))
    # second small patch low on the other slope
    bm = bmesh.new()
    pv = [bm.verts.new((-0.72 + dx * 0.7, 0.6 + dy * 0.7,
                        ridge_h * 0.32 + (0.72 - dx * 0.7) * -0.0 + 0.72 * 0.62 - (0.72 - dx * 0.7) * 0.62 + 0.05))
          for dx, dy in pquad]
    try:
        bm.faces.new(pv)
        parts.append(obj_from_bmesh(f"{name}_patch2", bm, coll, mat("Canvas")))
    except ValueError:
        bm.free()

    # Closed back gable
    back_y = (length + 0.35) / 2
    bm = bmesh.new()
    apex = bm.verts.new((0, back_y, ridge_h - 0.08))
    bl = bm.verts.new((-half_w * 1.05, back_y, 0.04))
    br = bm.verts.new((half_w * 1.05, back_y, 0.04))
    mid = bm.verts.new((0.06, back_y + 0.03, ridge_h * 0.45))  # slight belly
    bm.faces.new((apex, bl, mid))
    bm.faces.new((mid, bl, br))
    bm.faces.new((apex, mid, br))
    parts.append(obj_from_bmesh(f"{name}_gable", bm, coll, mat("Canvas_Dirty"), smooth=True))

    # Rolled-back door flap: canvas roll lying along the front slope edge
    fa = Vector((0.10, -length / 2 - 0.14, ridge_h - 0.28))
    fb = Vector((half_w * 0.98, -length / 2 - 0.20, 0.10))
    fd = fb - fa
    bm = bm_cylinder(0.055, 0.075, fd.length, segs=7)
    quat = fd.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((fa + fb) / 2) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_flap", bm, coll, mat("Canvas_Dirty"), smooth=True))

    # Guy ropes: ridge ends + 4 hem corners, all staked
    for ey, sy in ((-length / 2 - 0.24, -1), (length / 2 + 0.24, 1)):
        parts += rope_cat(coll, f"{name}_rrope{sy}", (0, ey, ridge_h * 0.98),
                          (0, ey + sy * 0.55, 0.06), sag=0.05)
        parts.append(peg(coll, f"{name}_rpeg{sy}", 0, ey + sy * 0.55, tilt=sy * 0.3))
    for sx in (-1, 1):
        for sy in (-1, 1):
            hx = sx * half_w * 1.08
            hy = sy * (length * 0.36)
            parts += rope_cat(coll, f"{name}_srope{sx}{sy}", (hx, hy, 0.30),
                              (sx * 1.18, hy + sy * 0.12, 0.05), sag=0.03, segs=4)
            bm = bm_cylinder(0.032, 0.014, 0.28, segs=5)
            bmesh.ops.transform(bm, matrix=Matrix.Translation((sx * 1.18, hy + sy * 0.12, 0.08)) @
                                Matrix.Rotation(sx * 0.22, 4, 'Y'), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_speg{sx}{sy}", bm, coll, mat("Wood_Dark")))

    finish(bev, width=0.012)
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return obj


# ═════════════════════════════════════════════════════════════
# BEDROLL — footprint ±0.31 x ±0.67, h ~0.46 (kept), ≤400 tris
# ═════════════════════════════════════════════════════════════
def _smooth_by(o, keep):
    """Per-face shading after obj_from_bmesh: faces where keep(normal) is False go flat."""
    for poly in o.data.polygons:
        poly.use_smooth = bool(keep(poly.normal))


def bm_torus(R, r, nu=24, nv=6, sx=1.0, sz=1.0):
    """Closed torus in the XZ-plane-free form: ring in XY, tube radius r; (sx, sz) squash the ring."""
    bm = bmesh.new()
    rows = []
    for i in range(nu):
        a = 2 * math.pi * i / nu
        ca, sa = math.cos(a), math.sin(a)
        row = []
        for j in range(nv):
            b = 2 * math.pi * j / nv
            rr = R + r * math.cos(b)
            row.append(bm.verts.new((rr * ca * sx, rr * sa, r * math.sin(b) * sz)))
        rows.append(row)
    for i in range(nu):
        for j in range(nv):
            i2, j2 = (i + 1) % nu, (j + 1) % nv
            bm.faces.new((rows[i][j], rows[i2][j], rows[i2][j2], rows[i][j2]))
    return bm


def build_bedroll(name):
    """Bedroll v2 (b4.5c, assets-10): the blanket is REALLY rolled: a thick spiral band (2.4 turns)
    lofted along the roll axis, so both ends show the spiral and the outer flap steps on the
    surface; it bulges at the middle, cinches under two rope ties (knotted on top) and carries a
    wrinkle. The ground blanket is a solid with thickness, a hem lip and a folded-back corner.
    Smooth shared-vertex solids (verts/tris <= 1.3), ~4.5k tris, same footprint as v1."""
    coll = asset_collection(name)
    parts = []
    # ── rolled blanket: axis X, centre (y=CY, z=CZ) ─────────────────────────
    CY, CZ, L = -0.56, 0.212, 0.60
    R0, R1, TH, TURNS, NSP, RINGS = 0.05, 0.185, 0.026, 2.4, 60, 12
    TIES = (-0.16, 0.14)

    def squeeze(x):
        u = (x + L / 2) / L
        s = 1.0 + 0.035 * math.sin(math.pi * u)
        for tx in TIES:
            s -= 0.075 * math.exp(-((x - tx) / 0.035) ** 2)
        return s
    loop = []
    for i in range(NSP + 1):          # outer edge of the band, spiralling out
        t = i / NSP
        loop.append((R0 + (R1 - R0 - TH) * t + TH, t * TURNS * 2 * math.pi))
    for i in range(NSP, -1, -1):      # inner edge, back in
        t = i / NSP
        loop.append((R0 + (R1 - R0 - TH) * t, t * TURNS * 2 * math.pi))
    bm = bmesh.new()
    ring_vs = []
    for k in range(RINGS):
        x = -L / 2 + L * k / (RINGS - 1)
        s = squeeze(x)
        row = []
        for (r, a) in loop:
            w = 1.0 + 0.03 * math.sin(a * 3.0 + x * 17.0) * min(1.0, r / R1)
            rr = r * s * w
            row.append(bm.verts.new((x, CY + rr * math.cos(a + 0.4), CZ + 0.9 * rr * math.sin(a + 0.4))))
        ring_vs.append(row)
    n = len(loop)
    for k in range(RINGS - 1):
        for j in range(n):
            j2 = (j + 1) % n
            bm.faces.new((ring_vs[k][j], ring_vs[k][j2], ring_vs[k + 1][j2], ring_vs[k + 1][j]))
    for k in (0, RINGS - 1):          # end caps: the spiral band's cross-section strip
        row = ring_vs[k]
        for i in range(NSP):
            bm.faces.new((row[i], row[i + 1], row[n - 2 - i], row[n - 1 - i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bmesh(f"{name}_roll", bm, coll, mat("Keg_Red"), smooth=True)
    _smooth_by(o, lambda nv: abs(nv.x) < 0.85)
    parts.append(o)
    # ── rope ties cinched into the roll, a knot on top of each ──────────────
    for tx in TIES:
        rr = R1 * squeeze(tx) - 0.002   # cinched: the rope bites into the roll
        bm = bm_torus(rr, 0.012, nu=28, nv=6, sx=1.0, sz=1.0)
        bmesh.ops.scale(bm, vec=Vector((0.9, 1.0, 1.0)), verts=bm.verts)   # pre-rotation X becomes Z: squash like the roll
        bmesh.ops.transform(bm, matrix=Matrix.Translation((tx, CY, CZ)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'),
                            verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        parts.append(obj_from_bmesh(f"{name}_tie{tx:.2f}", bm, coll, mat("Rope"), smooth=True))
        bm = bm_icosphere(0.022, 1)
        bmesh.ops.scale(bm, vec=Vector((1.3, 1.0, 0.8)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((tx, CY - 0.02, CZ + 0.9 * rr + 0.008)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_knot{tx:.2f}", bm, coll, mat("Rope"), smooth=True))
        for e in (-1, 1):             # the two loose rope ends trailing off the knot
            bm = bm_cylinder(0.009, 0.007, 0.07, segs=6)
            bmesh.ops.transform(bm, matrix=Matrix.Translation((tx + e * 0.03, CY + 0.03, CZ + 0.9 * rr - 0.01)) @
                                Matrix.Rotation(e * 0.9, 4, 'Y') @ Matrix.Rotation(0.5, 4, 'X'), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_end{tx:.2f}{e}", bm, coll, mat("Rope"), smooth=True))
    # ── ground blanket: solid, wrinkled, hem lip, folded-back corner ────────
    nx, ny = 12, 20
    bm = bmesh.new()
    top, bot = {}, {}
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            u, v = ix / nx, iy / ny
            x = (u - 0.5) * 0.62
            y = (v - 0.5) * 1.12 + 0.09
            z = 0.032 + math.sin(v * 6.2 + u * 2) * 0.010 + math.cos(u * 9.1 - v * 3) * 0.008
            if ix in (0, nx) or iy in (0, ny):
                z -= 0.008             # hem lip rolls down at the edge
            if u > 0.6 and v > 0.8:   # folded-back corner at the foot
                z += (u - 0.6) * (v - 0.8) * 1.6
            top[(ix, iy)] = bm.verts.new((x, y, z))
            bot[(ix, iy)] = bm.verts.new((x, y, max(0.002, z - 0.024)))
    for iy in range(ny):
        for ix in range(nx):
            q = [(ix, iy), (ix + 1, iy), (ix + 1, iy + 1), (ix, iy + 1)]
            bm.faces.new([top[c] for c in q])
            bm.faces.new([bot[c] for c in reversed(q)])
    border = [(ix, 0) for ix in range(nx)] + [(nx, iy) for iy in range(ny)] + \
             [(ix, ny) for ix in range(nx, 0, -1)] + [(0, iy) for iy in range(ny, 0, -1)]
    for i, c in enumerate(border):
        d = border[(i + 1) % len(border)]
        bm.faces.new((top[c], bot[c], bot[d], top[d]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bmesh(f"{name}_mat", bm, coll, mat("Canvas_Dirty"), smooth=True)
    _smooth_by(o, lambda nv: abs(nv.z) > 0.4)
    parts.append(o)
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return obj


# ═════════════════════════════════════════════════════════════
# ROCK_ARCH — natural arch: icosphere masses + dual displace
# footprint ±3.8, height ~4.5 (was ±3.89, 4.35)
# ═════════════════════════════════════════════════════════════
def build_rock_arch(name):
    coll = asset_collection(name)
    rng = random.Random(11)
    parts = []
    span = 5.2
    # two leaning leg masses (faceted, dual displace)
    for side in (-1, 1):
        bm = bm_icosphere(1.0, 4)
        bmesh.ops.scale(bm, vec=Vector((1.12, 0.92, 2.15)), verts=bm.verts)
        lean = Matrix.Rotation(-side * 0.21, 4, 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((side * span / 2, side * 0.12, 1.85)) @
                            lean, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_leg{side}", bm, coll,
                           mat("Rock_Dark") if side < 0 else mat("Rock_Grey"))
        displace_noise(o, strength=0.32, scale=1.35, seed=11 + side)
        displace_noise(o, strength=0.09, scale=0.5, seed=31 + side)
        apply_modifiers(o)
        parts.append(o)
    # span mass bridging the tops (undercut belly)
    bm = bm_icosphere(1.0, 4)
    bmesh.ops.scale(bm, vec=Vector((2.45, 0.80, 0.95)), verts=bm.verts)
    for v in bm.verts:
        if v.co.z < 0:
            v.co.z *= 0.62                     # flatter belly = arch undercut
        v.co.z += 0.10 * math.cos(v.co.x * 1.1)  # gentle camber
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 3.50)) @
                        Matrix.Rotation(0.05, 4, 'X'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_span", bm, coll, mat("Rock_Grey"))
    displace_noise(o, strength=0.28, scale=1.5, seed=17)
    displace_noise(o, strength=0.08, scale=0.5, seed=37)
    apply_modifiers(o)
    parts.append(o)
    # base boulders + chips
    for side in (-1, 1):
        bm = bm_icosphere(0.9, 3)
        bmesh.ops.scale(bm, vec=Vector((1.35, 1.1, 0.62)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((side * (span / 2 + 0.45), 0.4 * side, 0.32)) @
                            Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_base{side}",
                           bm, coll, mat("Rock_Grey") if side < 0 else mat("Rock_Dark"))
        displace_noise(o, strength=0.16, scale=0.8, seed=21 + side)
        apply_modifiers(o)
        parts.append(o)
    for k in range(4):
        bm = bm_icosphere(rng.uniform(0.16, 0.3), 2)
        bmesh.ops.scale(bm, vec=Vector((1.3, 1.0, 0.6)), verts=bm.verts)
        side = -1 if k % 2 else 1
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (side * rng.uniform(1.4, 2.6), rng.uniform(-0.9, 0.9), 0.08)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_chip{k}", bm, coll,
                                    mat("Rock_Dark") if k % 2 else mat("Rock_Grey")))
    obj = join(parts, name)
    ship_and_export(coll, name, obj)
    return obj


_ONLY = {k.strip() for k in os.environ.get("PBR_ONLY", "").split(",") if k.strip()}
if not _ONLY or "tent_a" in _ONLY:
    build_tent("tent_a")
if not _ONLY or "bedroll" in _ONLY:
    build_bedroll("bedroll")
# rock_arch.glb moved to build_crag.py (b4.5b rock kit v2, carved from one mass); build_rock_arch()
# above is the retired v1 builder and is no longer called, so the GLB has one writer.
print("CAMP SET DONE")
