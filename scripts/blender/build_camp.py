# Camp + landmark set: tent_a (sagging-canvas pirate tent), bedroll,
# rock_arch (natural weathered stone arch). Replaces the procedural
# box-and-plane "huts" and minecraft arches that shipped before.
# Headless: Blender -b -P scripts/blender/build_camp.py
import bpy
import bmesh
import math
import random
import os

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())


def build_tent(name):
    coll = asset_collection(name)
    rng = random.Random(7)
    parts = []

    ridge_h = 1.95   # taller + narrower → steep slopes read as a TENT, not a flat sheet
    half_w = 1.02
    length = 2.7

    # A-frame pole pairs (crossed) at both ends + ridge pole
    for ey in (-length / 2, length / 2):
        for side in (-1, 1):
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, segments=6,
                                  radius1=0.05, radius2=0.035, depth=2.05)
            tilt = math.atan2(half_w * 0.82, ridge_h)
            m = (Matrix.Translation((side * half_w * 0.41, ey, ridge_h * 0.5 + 0.02))
                 @ Matrix.Rotation(-side * tilt, 4, 'Y'))
            bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_pole{ey}{side}", bm, coll, mat("Wood_Mid")))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.045, radius2=0.045, depth=length + 0.5)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, ridge_h)) @ Matrix.Rotation(math.pi / 2, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_ridge", bm, coll, mat("Wood_Dark")))

    # Canvas: draped grid with catenary sag along the ridge and a gentle
    # outward flare at the hem — reads as cloth, not plywood.
    bm = bmesh.new()
    nx, ny = 8, 6
    grid = {}
    for iy in range(ny + 1):
        v = iy / ny
        y = (v - 0.5) * (length + 0.35)
        sag = math.sin(v * math.pi) * 0.085
        for ix in range(nx + 1):
            u = ix / nx  # 0..1 across, 0.5 = ridge
            t = abs(u - 0.5) * 2  # 0 ridge → 1 hem
            x = (u - 0.5) * 2 * half_w * (1 + 0.10 * t * t)
            z = (ridge_h - sag) * (1 - t) + 0.035 * t  # straight slope ridge→ground
            z += math.sin(u * math.pi * 3 + v * 2.1) * 0.018 * t  # cloth waviness
            grid[(ix, iy)] = bm.verts.new((x, y, z))
    for iy in range(ny):
        for ix in range(nx):
            bm.faces.new((grid[(ix, iy)], grid[(ix + 1, iy)], grid[(ix + 1, iy + 1)], grid[(ix, iy + 1)]))
    parts.append(obj_from_bmesh(f"{name}_canvas", bm, coll, mat("Canvas_Dirty"), smooth=True))

    # Patch square on one slope
    bm = bmesh.new()
    p = [bm.verts.new((0.55 + dx, -0.45 + dy, ridge_h * 0.52 + (0.55 + dx) * -0.6 + 0.02))
         for dx, dy in ((0, 0), (0.34, 0.05), (0.3, 0.42), (-0.03, 0.38))]
    bm.faces.new(p)
    parts.append(obj_from_bmesh(f"{name}_patch", bm, coll, mat("Canvas")))

    # Closed back gable — a triangular canvas wall so the tent reads as an
    # enclosed shelter with depth (the front stays open as the entrance).
    back_y = (length + 0.35) / 2
    for sgn in (1,):  # back only
        bm = bmesh.new()
        apex = bm.verts.new((0, sgn * back_y, ridge_h - 0.06))
        bl = bm.verts.new((-half_w * 1.05, sgn * back_y, 0.05))
        br = bm.verts.new((half_w * 1.05, sgn * back_y, 0.05))
        bm.faces.new((apex, bl, br) if sgn > 0 else (apex, br, bl))
        parts.append(obj_from_bmesh(f"{name}_gable{sgn}", bm, coll, mat("Canvas_Dirty")))

    # Guy ropes + stakes from the ridge ends
    for ey, sy in ((-length / 2 - 0.24, -1), (length / 2 + 0.24, 1)):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.016, radius2=0.016, depth=1.0)
        rot = Matrix.Rotation(sy * 1.05, 4, 'X')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, ey + sy * 0.38, ridge_h * 0.55)) @ rot, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_rope{sy}", bm, coll, mat("Rope")))
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.03, radius2=0.015, depth=0.3)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, ey + sy * 0.78, 0.1)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_stake{sy}", bm, coll, mat("Wood_Dark")))

    obj = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return obj


def build_bedroll(name):
    coll = asset_collection(name)
    parts = []
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.16, radius2=0.16, depth=0.62)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -0.62, 0.15)) @ Matrix.Rotation(math.pi / 2, 4, 'Z'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_roll", bm, coll, mat("Keg_Red")))
    bm = bmesh.new()
    ret = bmesh.ops.create_grid(bm, x_segments=4, y_segments=6, size=0.5)
    for v in bm.verts:
        v.co.x *= 0.62
        v.co.y *= 1.15
        v.co.z = 0.05 + math.sin(v.co.y * 2.4) * 0.012 + math.cos(v.co.x * 5.1) * 0.012
    parts.append(obj_from_bmesh(f"{name}_mat", bm, coll, mat("Canvas_Dirty"), smooth=True))
    obj = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return obj


def build_rock_arch(name):
    coll = asset_collection(name)
    rng = random.Random(11)
    parts = []
    span = 5.6
    height = 4.6
    segs = 11
    for i in range(segs):
        t = i / (segs - 1)
        ang = math.pi * t
        x = -math.cos(ang) * span / 2
        z = math.sin(ang) * height * (0.92 + 0.08 * math.sin(t * 7 + 1))
        thick = 0.85 * (1.25 - 0.5 * math.sin(ang))  # chunky feet, slimmer crown
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        sx = thick * (0.9 + rng.random() * 0.3)
        sy = thick * (1.05 + rng.random() * 0.4)
        sz = height / segs * 2.1
        rot = Matrix.Rotation(-(ang - math.pi / 2) * 0.9, 4, 'Y')
        skew = Matrix.Rotation((rng.random() - 0.5) * 0.16, 4, 'X')
        mtx = Matrix.Translation((x, (rng.random() - 0.5) * 0.14, max(z, sz * 0.3))) @ rot @ skew @ Matrix.Diagonal((sx, sy, sz, 1))
        bmesh.ops.transform(bm, matrix=mtx, verts=bm.verts)
        material = mat("Rock_Grey") if i % 3 else mat("Rock_Dark")
        parts.append(obj_from_bmesh(f"{name}_seg{i}", bm, coll, material))
    # base boulders
    for side in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.95)
        for v in bm.verts:
            v.co.x *= 1.2 + rng.random() * 0.2
            v.co.z *= 0.72
        bmesh.ops.transform(bm, matrix=Matrix.Translation((side * span / 2, 0.35 * side, 0.4)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_base{side}", bm, coll, mat("Rock_Grey")))
    obj = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return obj


build_tent("tent_a")
build_bedroll("bedroll")
build_rock_arch("rock_arch")
print("CAMP SET DONE")
