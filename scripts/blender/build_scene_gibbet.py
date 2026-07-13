# Dead Man Shoals / Gallows Sands small prop — `gibbet_cage`
#   Rusted iron cage (curved ribs, hinged door ajar) hanging from a gallows-arm
#   post; skeleton occupant slumped inside, crow on top, small Black Fin rag
#   tied to the frame. 4-8k tris. Cage + rag face Blender -Y.
# Headless: Blender -b -P scripts/blender/build_scene_gibbet.py
# PBR_RENDER_DIR -> turntable renders; PBR_EXPORT_DIR -> scratch export override.
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
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)

EXTRA = {
    "Rust":     ((0.30, 0.14, 0.08, 1.0), 0.9, 0.3),
    "Bone":     ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
    "Flag_Fin": ((0.09, 0.20, 0.23, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()

rng = random.Random(929)


def chain_pts(coll, name, pts, r1, r2, material, segs=6, smooth=True):
    parts = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        t0, t1 = i / n, (i + 1) / n
        bm = bm_cylinder(r1 + (r2 - r1) * t0, r1 + (r2 - r1) * t1,
                         d.length + 0.008, segs=segs)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material, smooth=smooth))
    return parts


def bm_torus(R, r, segs=16, rings=6):
    bm = bmesh.new()
    grid = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(rings):
            b = 2 * math.pi * j / rings
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * ca, rr * sa, r * math.sin(b))))
        grid.append(ring)
    for i in range(segs):
        for j in range(rings):
            bm.faces.new((grid[i][j], grid[(i + 1) % segs][j],
                          grid[(i + 1) % segs][(j + 1) % rings],
                          grid[i][(j + 1) % rings]))
    return bm


def ball(coll, name, loc, r, material=None, sub=1, sx=1.0, sy=1.0, sz=1.0, smooth=True):
    bm = bm_icosphere(r, sub)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material or mat("Bone"), smooth=smooth)


# cage profile: (z, radius) — pot-bellied gibbet
CAGE_C = Vector((0, -0.80, 0))          # cage axis (x, y)
PROFILE = [(2.26, 0.15), (2.06, 0.34), (1.72, 0.43), (1.38, 0.44),
           (1.06, 0.38), (0.84, 0.25)]


def cage_pt(theta, z, r):
    return (CAGE_C.x + r * math.sin(theta), CAGE_C.y + r * math.cos(theta), z)


def build_gibbet(name="gibbet_cage"):
    coll = asset_collection(name)
    parts, bev = [], []

    # ── post + gallows arm ───────────────────────────────────
    TILT = Matrix.Rotation(math.radians(2.4), 4, 'X') @ Matrix.Rotation(math.radians(-1.5), 4, 'Y')
    bm = bm_cylinder(0.145, 0.105, 3.15, segs=12)
    for v in bm.verts:                       # hewn wobble
        v.co.x += 0.012 * math.sin(v.co.z * 3.1)
    bmesh.ops.transform(bm, matrix=TILT @ Matrix.Translation((0, 0, 3.15 / 2 - 0.06)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_post", bm, coll, mat("Wood_Dark"), smooth=True)
    parts.append(o); bev.append(o)
    # arm toward -Y
    bm = bm_box(0.13, 1.05, 0.15)
    bmesh.ops.transform(bm, matrix=TILT @ Matrix.Translation((0, -0.42, 2.94)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_arm", bm, coll, mat("Wood_Dark"))
    parts.append(o); bev.append(o)
    # diagonal brace
    bm = bm_box(0.09, 0.11, 0.78)
    bmesh.ops.transform(bm, matrix=TILT @ Matrix.Translation((0, -0.30, 2.63)) @
                        Matrix.Rotation(math.radians(-42), 4, 'X'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_bracearm", bm, coll, mat("Wood_Dark"))
    parts.append(o); bev.append(o)
    # rusted strap around the post top
    bm = bm_cylinder(0.155, 0.155, 0.09, segs=10, cap=False)
    bmesh.ops.transform(bm, matrix=TILT @ Matrix.Translation((0, 0, 2.86)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_strap", bm, coll, mat("Rust"), smooth=True))

    # ── hanging chain (rusted oval links) ────────────────────
    arm_end = TILT @ Vector((0, -0.80, 2.86))
    for li in range(5):
        z = arm_end.z - 0.055 - li * 0.105
        bm = bm_torus(0.052, 0.014, segs=10, rings=5)
        bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.45)), verts=bm.verts)
        rot = Matrix.Rotation(math.pi / 2, 4, 'X') @ Matrix.Rotation((li % 2) * math.pi / 2, 4, 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((arm_end.x, arm_end.y, z)) @ rot,
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_link{li}", bm, coll, mat("Rust"), smooth=True))

    # ── the cage ─────────────────────────────────────────────
    # hoops
    for hi, (z, r) in enumerate(PROFILE):
        bm = bm_torus(r, 0.020, segs=24, rings=7)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((CAGE_C.x, CAGE_C.y, z)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_hoop{hi}", bm, coll, mat("Rust"), smooth=True))
    # vertical ribs — leave a clear sector for the door (door centred on -Y,
    # the audience face; theta=180 faces -Y since cage_pt uses +cos on y)
    rib_thetas = [math.radians(t) for t in (0, 38, 76, 114, 262, 300, 322)]
    for ti, th in enumerate(rib_thetas):
        pts = [cage_pt(th, z, r) for z, r in PROFILE]
        parts += chain_pts(coll, f"{name}_rib{ti}", pts, 0.021, 0.017, mat("Rust"))
    # door: own curved sub-frame (3 ribs + 3 short arcs), hinged at theta=145°,
    # swung OPEN ~48 degrees outward
    hinge_th = math.radians(145)
    hinge_top = Vector(cage_pt(hinge_th, PROFILE[1][0], PROFILE[1][1]))
    hinge_bot = Vector(cage_pt(hinge_th, PROFILE[-1][0], PROFILE[-1][1]))
    hinge_axis = (hinge_top - hinge_bot).normalized()
    OPEN = Matrix.Translation(hinge_bot) @ Matrix.Rotation(math.radians(48), 4, hinge_axis) @ \
        Matrix.Translation(-hinge_bot)

    def door_xform(p):
        return OPEN @ Vector(p)
    door_prof = PROFILE[1:]
    for ti, th in enumerate((math.radians(172), math.radians(204), math.radians(232))):
        pts = [door_xform(cage_pt(th, z, r)) for z, r in door_prof]
        parts += chain_pts(coll, f"{name}_drib{ti}", pts, 0.020, 0.017, mat("Rust"))
    for ai, (z, r) in enumerate((door_prof[0], door_prof[2], door_prof[-1])):
        arc = [door_xform(cage_pt(math.radians(152 + t), z, r)) for t in (0, 22, 44, 66, 88)]
        parts += chain_pts(coll, f"{name}_darc{ai}", arc, 0.017, 0.017, mat("Rust"))
    # hinge pins + a hanging latch plate
    for hz in (hinge_top, hinge_bot):
        bm = bm_cylinder(0.03, 0.03, 0.07, segs=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(hz), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_pin{hz.z:.1f}", bm, coll, mat("Rust"), smooth=True))
    bm = bm_box(0.035, 0.012, 0.14)
    latch_p = Vector(cage_pt(math.radians(248), 1.45, 0.45))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(latch_p) @ Matrix.Rotation(0.4, 4, 'X'),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_latch", bm, coll, mat("Rust")))
    # top hook + bottom plate
    bm = bm_torus(0.055, 0.016, segs=12, rings=5)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((CAGE_C.x, CAGE_C.y, 2.33)) @
                        Matrix.Rotation(math.pi / 2, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_hook", bm, coll, mat("Rust"), smooth=True))
    bm = bm_cylinder(0.27, 0.25, 0.03, segs=14)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((CAGE_C.x, CAGE_C.y, 0.82)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_floor", bm, coll, mat("Rust"), smooth=True))

    # ── the occupant: slumped skeleton ───────────────────────
    cx, cy = CAGE_C.x, CAGE_C.y
    # pelvis on the floor plate
    parts.append(ball(coll, f"{name}_pelvis", (cx, cy + 0.02, 0.90), 0.085, sub=1,
                      sx=1.25, sy=0.9, sz=0.7))
    # curved slumped spine
    spine = [(cx, cy + 0.02, 0.92), (cx + 0.01, cy - 0.015, 1.05),
             (cx + 0.02, cy - 0.06, 1.17), (cx + 0.03, cy - 0.115, 1.26)]
    parts += chain_pts(coll, f"{name}_spine", spine, 0.028, 0.022, mat("Bone"))
    # skull: chin dropped to chest, face toward the open door
    SKM = (Matrix.Translation((cx + 0.03, cy - 0.175, 1.40)) @
           Matrix.Rotation(math.radians(20), 4, 'X') @ Matrix.Rotation(0.25, 4, 'Z'))
    bm = bm_icosphere(0.125, 2)
    bmesh.ops.scale(bm, vec=Vector((0.88, 1.0, 1.06)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=SKM, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_skull", bm, coll, mat("Bone"), smooth=True))
    for sx in (-1, 1):                          # dark eye sockets
        bm = bm_box(0.036, 0.02, 0.045)
        bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((sx * 0.038, -0.088, 0.005)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", bm, coll, mat("Char_Black")))
    bm = bm_box(0.075, 0.06, 0.03)               # dropped jaw
    bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((0, -0.075, -0.095)) @
                        Matrix.Rotation(0.3, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_jaw", bm, coll, mat("Bone")))
    # ribs: 5 arcs wrapping the chest, sagging with the slump
    for ri in range(5):
        z = 1.24 - ri * 0.065
        r = 0.15 - abs(ri - 1.6) * 0.014
        c = Vector((cx + 0.015, cy - 0.03 * (4 - ri) / 4, z))
        arc = []
        for t in range(6):
            th = -2.25 + t * 0.9                # from front-left around the back
            arc.append((c.x + r * math.sin(th) * 0.95, c.y + r * math.cos(th),
                        z - 0.05 * (1 - math.cos(th)) * 0.5))
        parts += chain_pts(coll, f"{name}_ribb{ri}", arc, 0.011, 0.011, mat("Bone"), segs=5)
    # arms: hanging, hands in the lap
    for sx in (-1, 1):
        sh = (cx + sx * 0.135, cy - 0.02, 1.235)
        el = (cx + sx * 0.185, cy - 0.05, 1.02)
        ha = (cx + sx * 0.06, cy - 0.16, 0.90)
        parts += chain_pts(coll, f"{name}_uarm{sx}", [sh, el], 0.018, 0.015, mat("Bone"))
        parts += chain_pts(coll, f"{name}_farm{sx}", [el, ha], 0.014, 0.011, mat("Bone"))
        parts.append(ball(coll, f"{name}_shj{sx}", sh, 0.028, sub=1))
        parts.append(ball(coll, f"{name}_elj{sx}", el, 0.024, sub=1))
        parts.append(ball(coll, f"{name}_hand{sx}", ha, 0.026, sub=1, sx=1.1, sy=1.3, sz=0.6))
    # legs: knees drawn up against the cage, feet on the floor plate
    for sx in (-1, 1):
        hip = (cx + sx * 0.075, cy + 0.015, 0.895)
        kn = (cx + sx * 0.125, cy - 0.20, 1.09)
        ft = (cx + sx * 0.095, cy - 0.155, 0.855)
        parts += chain_pts(coll, f"{name}_thigh{sx}", [hip, kn], 0.020, 0.016, mat("Bone"))
        parts += chain_pts(coll, f"{name}_shin{sx}", [kn, ft], 0.015, 0.012, mat("Bone"))
        parts.append(ball(coll, f"{name}_knj{sx}", kn, 0.028, sub=1))
        bm = bm_box(0.055, 0.13, 0.035)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((ft[0], ft[1] - 0.03, ft[2])) @
                            Matrix.Rotation(sx * 0.2, 4, 'Z'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_foot{sx}", bm, coll, mat("Bone")))

    # ── crow perched at the arm tip, silhouetted, eyeing the cage ──
    crow_base = TILT @ Vector((0, -0.90, 3.015))
    CM = Matrix.Translation(crow_base) @ Matrix.Rotation(math.radians(195), 4, 'Z')
    bm = bm_icosphere(0.10, 2)
    bmesh.ops.scale(bm, vec=Vector((0.72, 1.5, 0.95)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=CM @ Matrix.Translation((0, 0, 0.135)) @
                        Matrix.Rotation(0.2, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crowb", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_icosphere(0.058, 2)
    bmesh.ops.transform(bm, matrix=CM @ Matrix.Translation((0, 0.13, 0.235)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crowh", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_cylinder(0.02, 0.004, 0.085, segs=6)
    bmesh.ops.transform(bm, matrix=CM @ Matrix.Translation((0, 0.21, 0.22)) @
                        Matrix.Rotation(-math.pi / 2, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crowk", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_box(0.06, 0.19, 0.022)
    bmesh.ops.transform(bm, matrix=CM @ Matrix.Translation((0, -0.165, 0.165)) @
                        Matrix.Rotation(-0.42, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crowt", bm, coll, mat("Char_Black")))

    # ── small Black Fin rag tied to the shoulder hoop, hanging free ──
    # 0.55 x 0.38 dangling rag on the front-right rib line, fin appliqué
    # relief in Bone, 2 bite notches on the fly edge
    rag_th = math.radians(300)
    knot = Vector(cage_pt(rag_th, PROFILE[1][0], PROFILE[1][1]))
    bm = bm_cylinder(0.034, 0.034, 0.055, segs=7)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(knot) @ Matrix.Rotation(0.5, 4, 'X'),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_ragknot", bm, coll, mat("Rope"), smooth=True))
    bm = bmesh.new()
    nx, ny = 10, 7
    grid = {}
    # local +X = hoop tangent, local +Y = outward normal
    RM = Matrix.Translation(knot) @ Matrix.Rotation(-rag_th, 4, 'Z')
    out = 1.0
    for iy in range(ny + 1):
        v = iy / ny
        for ix in range(nx + 1):
            u = ix / nx
            x = (u - 0.5) * 0.55
            z = -v * 0.38 - abs(u - 0.5) * 0.09 * v      # corners droop
            y = out * (0.03 + 0.10 * v * (1 - 0.5 * v)   # billows outward
                       + 0.03 * math.sin(u * 8 + v * 5) * v)
            grid[(ix, iy)] = RM @ Vector((x, -y, z + 0.02))
    bverts = {k: bm.verts.new(p) for k, p in grid.items()}
    notches = {(2, ny - 1), (6, ny - 1)}
    for iy in range(ny):
        for ix in range(nx):
            if (ix, iy) in notches:
                continue
            bm.faces.new((bverts[(ix, iy)], bverts[(ix + 1, iy)],
                          bverts[(ix + 1, iy + 1)], bverts[(ix, iy + 1)]))
    parts.append(obj_from_bmesh(f"{name}_rag", bm, coll, mat("Flag_Fin"), smooth=True))
    # fin appliqué: raised relief prism in Bone, middle of the rag
    fin = [(0.0, 0.0), (0.16, 0.0), (0.115, 0.11), (0.04, 0.045)]
    bm = bmesh.new()
    vs = [bm.verts.new((x, 0, z)) for x, z in fin]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    up = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, -0.02, 0), verts=up)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.transform(bm, matrix=RM @ Matrix.Translation((-0.09, 0.10, -0.28)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_fin", bm, coll, mat("Bone")))

    for o in bev:
        bevel_obj(o, width=0.018, segments=2)
        apply_modifiers(o)
    obj = join(parts, name)
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")
    return obj


build_gibbet("gibbet_cage")
print("GIBBET DONE")
