# Boneyard scatter props (instanced, cheap) — exported separately:
#   bone_pile     <=900 tris: bleached ribcage arcs + skull + scattered long
#                 bones half-sunk in a low sand mound
#   grave_marker  <=600 tris: leaning weathered cross AND headstone slab,
#                 both variants joined as one asset, chipped, rope lashing
# Headless: Blender -b -P scripts/blender/build_scene_boneyard.py
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
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()


def chain_pts(coll, name, pts, r1, r2, material, segs=5, smooth=True):
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


def ship(coll, name):
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR)
    for o in coll.objects:
        o.hide_render = True
    print(f"built {name}")


# ═════════════════════════════════════════════════════════════
# BONE_PILE — <=900 tris
# ═════════════════════════════════════════════════════════════
def build_bone_pile(name="bone_pile"):
    coll = asset_collection(name)
    rng = random.Random(66)
    parts = []

    # low sand mound
    bm = bm_icosphere(1.0, 3)
    bmesh.ops.scale(bm, vec=Vector((0.60, 0.48, 0.115)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Rotation(0.4, 4, 'Z'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_mound", bm, coll, mat("Sand"), smooth=True)
    displace_noise(o, strength=0.05, scale=0.4, seed=5)
    apply_modifiers(o)
    parts.append(o)

    # skull, tilted, half-sunk, staring off-axis
    SKM = (Matrix.Translation((0.34, -0.24, 0.10)) @
           Matrix.Rotation(-0.9, 4, 'Z') @ Matrix.Rotation(0.42, 4, 'X') @
           Matrix.Rotation(0.15, 4, 'Y'))
    bm = bm_icosphere(0.135, 2)
    bmesh.ops.scale(bm, vec=Vector((0.9, 1.02, 1.05)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=SKM, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_skull", bm, coll, mat("Bone"), smooth=True))
    for sx in (-1, 1):
        bm = bm_box(0.048, 0.026, 0.058)
        bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((sx * 0.05, -0.112, 0.012)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", bm, coll, mat("Char_Black")))
    bm = bm_box(0.095, 0.07, 0.036)
    bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((0, -0.082, -0.115)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_jaw", bm, coll, mat("Bone")))

    # ribcage: 4 parallel half-buried crescents — buried at one end, curling
    # over to a free tip, like a wreck's frames breaking the sand
    for ri in range(4):
        cx = -0.32 + ri * 0.165
        r = 0.34 - abs(ri - 1.4) * 0.045
        yaw = 0.25 + rng.uniform(-0.04, 0.04)
        lean = 0.28 + ri * 0.06                # each rib leans a bit more
        arc = []
        for t in range(5):
            th = -0.15 + t * 0.525             # buried -> up -> curled tip
            py = r * math.cos(th)
            pz = r * math.sin(th) - 0.04
            # lean the rib plane over (rotate about Y in its local frame)
            px = cx + pz * math.sin(lean) * 0.6 + 0.015 * math.sin(th * 3)
            pzz = pz * math.cos(lean)
            c, s = math.cos(yaw), math.sin(yaw)
            arc.append((px * c - py * s, px * s + py * c, pzz))
        parts += chain_pts(coll, f"{name}_rib{ri}", arc, 0.028, 0.018, mat("Bone"))

    # scattered long bones: shaft + flared ends (two tapered cones butt-joined)
    for bi, (bx, by, byaw, bl) in enumerate(((-0.45, 0.35, 1.1, 0.34),
                                             (0.42, 0.28, -0.5, 0.30),
                                             (0.05, 0.52, 2.3, 0.26))):
        M = (Matrix.Translation((bx, by, 0.035)) @ Matrix.Rotation(byaw, 4, 'Z') @
             Matrix.Rotation(math.pi / 2 + rng.uniform(-0.1, 0.1), 4, 'X'))
        for half in (-1, 1):
            bm = bm_cylinder(0.032, 0.020, bl / 2, segs=5)
            bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0, half * bl / 4)) @
                                Matrix.Rotation((half + 1) * math.pi / 2, 4, 'X'), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_bone{bi}{half}", bm, coll,
                                        mat("Bone"), smooth=True))

    obj = join(parts, name)
    ship(coll, name)
    return obj


# ═════════════════════════════════════════════════════════════
# GRAVE_MARKER — <=600 tris (cross + headstone, one asset)
# ═════════════════════════════════════════════════════════════
def build_grave_marker(name="grave_marker"):
    coll = asset_collection(name)
    rng = random.Random(31)
    parts, bev = [], []

    # ── leaning cross ────────────────────────────────────────
    XM = (Matrix.Translation((-0.30, 0.05, 0)) @ Matrix.Rotation(0.3, 4, 'Z') @
          Matrix.Rotation(math.radians(-11), 4, 'Y') @ Matrix.Rotation(math.radians(4), 4, 'X'))
    bm = bm_box(0.11, 0.075, 1.08)
    for v in bm.verts:                          # chipped, weather-split top
        if v.co.z > 0.5:
            v.co.z -= 0.05 * (v.co.x / 0.055 + 1) * 0.5
            v.co.x *= 0.86
    bmesh.ops.transform(bm, matrix=XM @ Matrix.Translation((0, 0, 0.51)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_xpost", bm, coll, mat("Wood_Bleached"))
    parts.append(o); bev.append(o)
    bm = bm_box(0.62, 0.07, 0.10)
    for v in bm.verts:                          # one arm shorter + chipped
        if v.co.x > 0.25:
            v.co.x -= 0.07
            v.co.z *= 0.7
    bmesh.ops.transform(bm, matrix=XM @ Matrix.Translation((0.02, 0, 0.78)) @
                        Matrix.Rotation(math.radians(-4), 4, 'Z') @
                        Matrix.Rotation(math.radians(3), 4, 'Y'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_xarm", bm, coll, mat("Wood_Bleached"))
    parts.append(o); bev.append(o)
    # rope lashing at the joint: two crossed wraps
    for wi, rot in enumerate((Matrix.Rotation(math.radians(45), 4, 'X'),
                              Matrix.Rotation(math.radians(-45), 4, 'X'))):
        bm = bm_cylinder(0.068, 0.068, 0.042, segs=8, cap=False)
        bmesh.ops.transform(bm, matrix=XM @ Matrix.Translation((0.02, 0, 0.78)) @ rot @
                            Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_lash{wi}", bm, coll, mat("Rope"), smooth=True))

    # ── leaning headstone slab (distinct silhouette) ─────────
    # arched top with a chipped shoulder notch (concave outline)
    outline = [(-0.24, 0.0), (-0.25, 0.42), (-0.19, 0.58), (-0.07, 0.66),
               (0.04, 0.655), (0.08, 0.52), (0.13, 0.50),   # chip notch
               (0.17, 0.56), (0.23, 0.44), (0.24, 0.0)]
    HM = (Matrix.Translation((0.32, -0.04, 0)) @ Matrix.Rotation(-0.35, 4, 'Z') @
          Matrix.Rotation(math.radians(9), 4, 'X') @ Matrix.Rotation(math.radians(-3), 4, 'Y'))
    bm = bmesh.new()
    vs = [bm.verts.new((x, 0, z)) for x, z in outline]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    up = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0.11, 0), verts=up)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.transform(bm, matrix=HM @ Matrix.Translation((0, -0.055, -0.03)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_slab", bm, coll, mat("Rock_Grey"))
    parts.append(o); bev.append(o)
    # carved line hint: shallow dark inset bar
    bm = bm_box(0.30, 0.015, 0.035)
    bmesh.ops.transform(bm, matrix=HM @ Matrix.Translation((-0.01, -0.058, 0.40)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_carve", bm, coll, mat("Rock_Dark")))

    # rubble at the bases (seats both into the ground)
    for pi, (px, py, pr) in enumerate(((-0.38, -0.14, 0.09), (0.24, 0.16, 0.11),
                                       (0.44, -0.18, 0.07))):
        bm = bm_icosphere(pr, 1)
        bmesh.ops.scale(bm, vec=Vector((1.3, 1.0, 0.55)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((px, py, pr * 0.3)) @
                            Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_rub{pi}", bm, coll,
                                    mat("Rock_Grey") if pi % 2 else mat("Rock_Dark"),
                                    smooth=True))

    for o in bev:
        bevel_obj(o, width=0.012, segments=1)
        apply_modifiers(o)
    obj = join(parts, name)
    ship(coll, name)
    return obj


build_bone_pile("bone_pile")
build_grave_marker("grave_marker")
print("BONEYARD SET DONE")
