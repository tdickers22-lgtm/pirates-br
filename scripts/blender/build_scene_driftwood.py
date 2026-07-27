# driftwood_log — beach scatter prop (instanced, <=1500 tris).
# Bleached twisted driftwood snag: bent trunk half-sunk in the sand, exposed
# root ball at one end, one upswept bird-perch branch. Distinct elongated
# silhouette vs boulders. Origin at ground center. 1u = 1m.
# Headless: Blender -b -P scripts/blender/build_scene_driftwood.py
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

clear_default_scene()


def catmull(pts, samples):
    P = [pts[0]] + [Vector(p) for p in pts] + [pts[-1]]
    P = [Vector(p) for p in P]
    n = len(pts) - 1
    out = []
    for i in range(samples + 1):
        t = (i / samples) * n
        seg = min(int(t), n - 1)
        u = t - seg
        p0, p1, p2, p3 = P[seg], P[seg + 1], P[seg + 2], P[seg + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u +
                          (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
                          (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return out


def parallel_frames(pts):
    n = len(pts)
    tans = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tans.append((b - a).normalized())
    t0 = tans[0]
    up = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = (up - t0 * up.dot(t0)).normalized()
    frames = []
    for i in range(n):
        if i > 0:
            axis = tans[i - 1].cross(tans[i])
            if axis.length > 1e-8:
                ang = tans[i - 1].angle(tans[i])
                nrm = (Matrix.Rotation(ang, 3, axis.normalized()) @ nrm).normalized()
        binrm = tans[i].cross(nrm).normalized()
        frames.append((tans[i].copy(), nrm.copy(), binrm.copy()))
    return frames


def loft_tube(coll, name, pts, radii, material, segs=8, smooth=True, lobe=0.0):
    """Tube with optional lobed (grooved) cross-section for wood grain feel."""
    frames = parallel_frames(pts)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        _, nrm, binrm = frames[i]
        ring = []
        for s in range(segs):
            a = 2 * math.pi * s / segs
            r = radii[i] * (1.0 + lobe * math.sin(a * 3 + i * 0.55))
            ring.append(bm.verts.new(p + (nrm * math.cos(a) + binrm * math.sin(a)) * r))
        rings.append(ring)
    for i in range(len(pts) - 1):
        for s in range(segs):
            bm.faces.new((rings[i][s], rings[i][(s + 1) % segs],
                          rings[i + 1][(s + 1) % segs], rings[i + 1][s]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def build_driftwood(name="driftwood_log"):
    coll = asset_collection(name)
    rng = random.Random(3)
    wb, wm = mat("Wood_Bleached"), mat("Wood_Mid")
    parts = []

    # trunk: bent + twisting, half-sunk (dips below z=0 midway)
    t_ctrl = [Vector((-0.05, -2.5, 0.26)),
              Vector((0.40, -1.5, 0.10)),
              Vector((0.10, -0.5, -0.05)),
              Vector((-0.35, 0.5, 0.12)),
              Vector((-0.15, 1.4, 0.35)),
              Vector((0.10, 2.0, 0.55))]
    tpts = catmull(t_ctrl, 13)
    radii = [0.125 + 0.215 * (i / 13) ** 1.3 for i in range(14)]  # thick at root end
    # segs 8 + lobe 0.20 collapsed into flat facets under the client's forced
    # flatShading — the "untextured flat boxes" the bone-island audit flagged.
    # More segments and a gentler lobe give the snag a round, twisted read.
    trunk = loft_tube(coll, f"{name}_trunk", tpts, radii, wb, segs=11, lobe=0.13)
    displace_noise(trunk, strength=0.08, scale=0.5, seed=2)
    apply_modifiers(trunk)
    parts.append(trunk)

    # bird-perch branch: upswept from mid-trunk, small kink
    b_ctrl = [Vector((0.12, -0.8, 0.12)),
              Vector((0.38, -0.95, 0.80)),
              Vector((0.30, -0.75, 1.35)),
              Vector((0.48, -0.90, 1.60))]
    bpts = catmull(b_ctrl, 8)
    bradii = [0.115 * (1 - 0.62 * i / 8) + 0.015 for i in range(9)]
    br = loft_tube(coll, f"{name}_branch", bpts, bradii, wb, segs=9)
    parts.append(br)
    # broken stub branch (darker heartwood)
    s_ctrl = [Vector((-0.2, 0.6, 0.15)), Vector((-0.55, 0.85, 0.42))]
    st = loft_tube(coll, f"{name}_stub", catmull(s_ctrl, 3),
                   [0.07, 0.055, 0.04, 0.012], wm, segs=8)
    parts.append(st)

    # root ball: radiating snapped roots at the +Y (thick) end
    root_c = Vector((0.10, 2.05, 0.58))
    for i in range(7):
        a = i * (2 * math.pi / 7) + 0.4
        d = Vector((math.cos(a), 0.45 + 0.2 * math.sin(a * 2), math.sin(a) * 1.05))
        d = d.normalized()
        ln = rng.uniform(0.7, 1.15)
        rpts = catmull([root_c + d * 0.1, root_c + d * (ln * 0.6) + Vector((0, 0.1, 0)),
                        root_c + d * ln], 4)
        o = loft_tube(coll, f"{name}_root{i}", rpts,
                      [0.13 * (1 - 0.62 * j / 4) + 0.018 for j in range(5)],
                      wb if i % 3 else wm, segs=8)
        parts.append(o)
    # root knot
    bm = bm_icosphere(0.38, subdiv=2)
    bmesh.ops.scale(bm, vec=Vector((1.15, 0.9, 1.1)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(root_c), verts=bm.verts)
    kn = obj_from_bmesh(f"{name}_knot", bm, coll, wb, smooth=True)
    displace_noise(kn, strength=0.07, scale=0.4, seed=6)
    apply_modifiers(kn)
    parts.append(kn)

    # snapped-off splinters at the thin end + a curled bark strip — the bible
    # asks for a bleached SNAG, and a snag is defined by its broken ends
    rng2 = random.Random(11)
    tip = tpts[0]
    for i in range(4):
        a = 2 * math.pi * i / 4 + 0.6
        d = Vector((math.cos(a) * 0.10, -rng2.uniform(0.35, 0.62), math.sin(a) * 0.10))
        sp = loft_tube(coll, f"{name}_spl{i}",
                       catmull([tip + Vector((0, 0.05, 0)), tip + d * 0.6, tip + d], 3),
                       [0.055, 0.038, 0.022, 0.006], wb, segs=6)
        parts.append(sp)
    bark = loft_tube(coll, f"{name}_bark",
                     catmull([Vector((-0.34, -1.15, 0.20)), Vector((-0.50, -0.62, 0.34)),
                              Vector((-0.40, -0.05, 0.22))], 5),
                     [0.075, 0.062, 0.05, 0.04, 0.03, 0.02], wm, segs=6)
    parts.append(bark)

    obj = join(parts, name)
    bake_ao(coll, samples=16)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")


build_driftwood()
