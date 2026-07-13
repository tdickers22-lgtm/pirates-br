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
def build_bedroll(name):
    coll = asset_collection(name)
    parts, bev = [], []
    # rolled blanket at the head, lying across the mat (axis along X)
    lay = Matrix.Rotation(math.pi / 2, 4, 'Y') @ Matrix.Rotation(0.05, 4, 'X')
    bm = bm_cylinder(0.185, 0.185, 0.58, segs=12)
    bmesh.ops.scale(bm, vec=Vector((0.9, 1.0, 1.0)), verts=bm.verts)  # squash future-z
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.56, 0.205)) @ lay, verts=bm.verts)
    o = obj_from_bmesh(f"{name}_roll", bm, coll, mat("Keg_Red"), smooth=True)
    parts.append(o); bev.append(o)
    # inner roll spiral hint: inset end discs
    for sx in (-1, 1):
        bm = bm_cylinder(0.125, 0.125, 0.015, segs=10)
        bmesh.ops.scale(bm, vec=Vector((0.9, 1.0, 1.0)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.56, 0.205)) @ lay @
                            Matrix.Translation((0, 0, sx * 0.285)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_end{sx}", bm, coll, mat("Canvas_Dirty"), smooth=True))
    # rope ties cinched around the roll
    for tx in (-0.16, 0.14):
        bm = bm_cylinder(0.20, 0.20, 0.032, segs=10, cap=False)
        bmesh.ops.scale(bm, vec=Vector((0.9, 1.0, 1.0)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.56, 0.205)) @ lay @
                            Matrix.Translation((0, 0, tx)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_tie{tx:.2f}", bm, coll, mat("Rope"), smooth=True))
    # ground mat: wrinkled blanket with a folded-back corner
    bm = bmesh.new()
    nx, ny = 6, 9
    grid = {}
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            u, v = ix / nx, iy / ny
            x = (u - 0.5) * 0.62
            y = (v - 0.5) * 1.12 + 0.09
            z = 0.045 + math.sin(v * 6.2 + u * 2) * 0.014 + math.cos(u * 9.1 - v * 3) * 0.012
            # folded-back corner at the foot
            if u > 0.6 and v > 0.8:
                z += (u - 0.6) * (v - 0.8) * 1.6
            grid[(ix, iy)] = bm.verts.new((x, y, max(z, 0.02)))
    for iy in range(ny):
        for ix in range(nx):
            bm.faces.new((grid[(ix, iy)], grid[(ix + 1, iy)],
                          grid[(ix + 1, iy + 1)], grid[(ix, iy + 1)]))
    parts.append(obj_from_bmesh(f"{name}_mat", bm, coll, mat("Canvas_Dirty"), smooth=True))
    finish(bev, width=0.01)
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


build_tent("tent_a")
build_bedroll("bedroll")
build_rock_arch("rock_arch")
print("CAMP SET DONE")
