# whale_skeleton — Dead Man Shoals hero story scene.
# 20-24m bleached whale skeleton half-sunk in a sand base: tilted stylized
# baleen skull, graduated vertebra spine arcing up, ribcage arch you can walk
# through (>=2.6m clearance), tail trailing off, sand drifted against bones.
# Origin at ground center. Skull faces -Y (audience). 1u = 1m.
# Headless: Blender -b -P scripts/blender/build_scene_whale.py
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


# ── local helpers (same idiom as other scene scripts) ────────
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


def loft_tube(coll, name, pts, radii, material, segs=10, smooth=True, squash=1.0):
    """Skinned tube; squash flattens the local-normal axis (oval bones)."""
    frames = parallel_frames(pts)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        _, nrm, binrm = frames[i]
        ring = []
        for s in range(segs):
            a = 2 * math.pi * s / segs
            ring.append(bm.verts.new(p + nrm * (math.cos(a) * radii[i] * squash) +
                                     binrm * (math.sin(a) * radii[i])))
        rings.append(ring)
    for i in range(len(pts) - 1):
        for s in range(segs):
            bm.faces.new((rings[i][s], rings[i][(s + 1) % segs],
                          rings[i + 1][(s + 1) % segs], rings[i + 1][s]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def finish(objs, width=0.02, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


# ═════════════════════════════════════════════════════════════
# WHALE SKELETON
# ═════════════════════════════════════════════════════════════
def build_whale_skeleton(name="whale_skeleton"):
    coll = asset_collection(name)
    rng = random.Random(11)
    bone, sand = mat("Bone"), mat("Sand")
    dark = mat("Char_Black")
    parts, bev = [], []

    # ── sand base: soft elliptical pad w/ drifts ─────────────
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=64, y_segments=34, size=1.0)
    SX, SY = 5.6, 12.4
    for v in bm.verts:
        u, w = v.co.x, v.co.y     # -1..1
        # square -> ellipse mapping (no rectangular carpet corners)
        eu = u * math.sqrt(max(0.0, 1 - 0.5 * w * w))
        ew = w * math.sqrt(max(0.0, 1 - 0.5 * u * u))
        rr = min(1.0, (eu * eu + ew * ew) ** 0.5)
        h = 0.40 * max(0.0, (1 - rr * rr)) ** 1.3
        h += 0.18 * math.exp(-((eu * 5.6) ** 2) / 2.2) * max(0.0, 1 - abs(ew))
        v.co = Vector((eu * SX, ew * SY - 0.6, h - 0.10 - 0.3 * rr ** 6))
    base = obj_from_bmesh(f"{name}_sand", bm, coll, sand, smooth=True)
    displace_noise(base, strength=0.10, scale=2.2, seed=4)
    apply_modifiers(base)
    parts.append(base)

    # ── spine: skull at -Y, arch over the ribcage, tail off +Y ──
    spine_ctrl = [Vector((0.0, -3.2, 0.85)),
                  Vector((0.15, -1.2, 2.15)),
                  Vector((0.25, 1.2, 3.35)),
                  Vector((0.05, 3.6, 3.62)),
                  Vector((-0.15, 6.0, 3.05)),
                  Vector((-0.30, 8.2, 1.95)),
                  Vector((-0.10, 10.2, 0.95)),
                  Vector((0.20, 12.0, 0.42)),
                  Vector((0.10, 13.6, 0.16))]
    NV = 30
    spts = catmull(spine_ctrl, NV)
    sframes = parallel_frames(spts)

    def vert_r(i):
        t = i / NV
        if t < 0.12:
            return 0.40
        if t < 0.62:
            return 0.40 - 0.10 * (t - 0.12) / 0.5
        return max(0.08, 0.30 - 0.26 * (t - 0.62) / 0.38)

    # vertebrae: centrum disc + neural spine + transverse processes
    for i in range(0, NV + 1):
        p = spts[i]
        tan, nrm, binrm = sframes[i]
        r = vert_r(i)
        t = i / NV
        # centrum
        bm = bm_cylinder(r, r * 0.94, r * 1.05, segs=20)
        q = tan.to_track_quat('Z', 'Y')
        rot = q.to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p) @ rot, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_vc{i}", bm, coll, bone, smooth=True)
        parts.append(o)
        # neural spine (points up-aft)
        hs = r * (1.7 if 0.1 < t < 0.6 else 1.25)
        if hs > 0.12:
            up = Vector((0, 0, 1))
            d = (up - tan * up.dot(tan)).normalized()
            d = (d + tan * 0.35).normalized()
            bm = bm_cylinder(r * 0.26, r * 0.10, hs, segs=6)
            q2 = d.to_track_quat('Z', 'Y')
            bmesh.ops.transform(bm, matrix=Matrix.Translation(p + d * (hs * 0.5 + r * 0.7)) @
                                q2.to_matrix().to_4x4(), verts=bm.verts)
            o = obj_from_bmesh(f"{name}_vs{i}", bm, coll, bone, smooth=True)
            parts.append(o)
        # transverse processes in the rib zone
        if 0.10 < t < 0.58:
            for side in (-1, 1):
                lat = Vector((side, 0, 0))
                d = (lat - tan * lat.dot(tan)).normalized()
                ls = r * 1.5
                bm = bm_cylinder(r * 0.20, r * 0.09, ls, segs=6)
                q2 = d.to_track_quat('Z', 'Y')
                bmesh.ops.transform(bm, matrix=Matrix.Translation(p + d * (ls * 0.5 + r * 0.55)) @
                                    q2.to_matrix().to_4x4(), verts=bm.verts)
                o = obj_from_bmesh(f"{name}_vt{i}{side}", bm, coll, bone, smooth=True)
                parts.append(o)

    # ── ribs: 11 pairs hanging from the arch, tips sunk in sand ──
    nrib = 11
    for k in range(nrib):
        t = 0.12 + 0.46 * k / (nrib - 1)
        i = int(t * NV)
        p = spts[i]
        big = math.sin(math.pi * (k + 1.5) / (nrib + 2))   # mid ribs biggest
        halfw = 2.3 + 1.25 * big
        for side in (-1, 1):
            drop = p.z
            aft = 0.55 + 0.3 * big
            c0 = p + Vector((side * 0.35, 0.05, -0.10))
            c1 = p + Vector((side * halfw * 1.02, aft * 0.5, -drop * 0.34))
            c2 = p + Vector((side * halfw * 1.16, aft, -drop * 0.72))
            c3 = p + Vector((side * halfw * 0.72, aft * 1.3, -drop - 0.35))
            rpts = catmull([c0, c1, c2, c3], 20)
            rr = 0.16 + 0.05 * big
            radii = [rr * (1 - 0.45 * (j / 20)) for j in range(21)]
            # one snapped rib on the audience side
            if k == 3 and side == -1:
                rpts = rpts[:12]
                radii = radii[:12]
                radii[-1] = 0.03
            o = loft_tube(coll, f"{name}_rib{k}{'p' if side < 0 else 's'}",
                          rpts, radii, bone, segs=14, squash=0.7)
            parts.append(o)
        # fallen rib chunk on the sand for k==3
        if k == 3:
            fp = Vector((-2.9, p.y + 0.4, 0.14))
            rpts = catmull([fp, fp + Vector((-0.8, 0.5, 0.14)),
                            fp + Vector((-1.5, 0.7, 0.05))], 8)
            o = loft_tube(coll, f"{name}_ribfall", rpts,
                          [0.12 * (1 - 0.4 * j / 8) for j in range(9)], bone, segs=8,
                          squash=0.75)
            parts.append(o)

    # ── skull: cranium + long baleen rostrum + mandibles, tilted ──
    M_SK = (Matrix.Translation((0.1, -3.4, 0.0)) @
            Matrix.Rotation(math.radians(-13), 4, 'Y') @
            Matrix.Rotation(math.radians(4), 4, 'X'))

    def sk(p):
        return M_SK @ Vector(p)

    # cranium block
    bm = bm_icosphere(1.0, subdiv=3)
    bmesh.ops.scale(bm, vec=Vector((1.65, 1.7, 1.05)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=M_SK @ Matrix.Translation((0, -0.4, 1.1)), verts=bm.verts)
    cr = obj_from_bmesh(f"{name}_cranium", bm, coll, bone, smooth=True)
    displace_noise(cr, strength=0.11, scale=1.0, seed=6)
    apply_modifiers(cr)
    parts.append(cr)
    # rostrum: tapering flattened snout dipping into the sand
    ros_ctrl = [sk((0, -1.2, 1.30)), sk((0.05, -2.6, 1.02)),
                sk((0.1, -4.2, 0.58)), sk((0.12, -5.5, 0.22))]
    rpts = catmull(ros_ctrl, 14)
    radii = [1.12 * (1 - 0.80 * (j / 14) ** 1.1) + 0.06 for j in range(15)]
    ros = loft_tube(coll, f"{name}_rostrum", rpts, radii, bone, segs=14, squash=0.42)
    displace_noise(ros, strength=0.05, scale=0.8, seed=8)
    apply_modifiers(ros)
    parts.append(ros)
    # crest ridge along the rostrum top
    cr_ctrl = [sk((0, -1.0, 1.62)), sk((0.05, -2.6, 1.28)),
               sk((0.1, -4.3, 0.72)), sk((0.12, -5.3, 0.30))]
    cpts = catmull(cr_ctrl, 10)
    o = loft_tube(coll, f"{name}_crest", cpts,
                  [0.16 * (1 - 0.6 * j / 10) + 0.03 for j in range(11)], bone,
                  segs=7, squash=1.6)
    parts.append(o)
    # zygomatic cheek arches sweeping from the cranium toward the jaw hinge
    for side in (-1, 1):
        z_ctrl = [sk((side * 1.35, -0.05, 1.15)),
                  sk((side * 1.85, -1.1, 0.75)),
                  sk((side * 1.45, -2.1, 0.45))]
        zpts = catmull(z_ctrl, 8)
        o = loft_tube(coll, f"{name}_zyg{side}", zpts,
                      [0.14 * (1 - 0.4 * j / 8) for j in range(9)], bone, segs=7)
        parts.append(o)
    # mandibles: two bowed jaw bones splayed open on the sand
    for side in (-1, 1):
        j_ctrl = [sk((side * 1.15, -0.6, 0.75)),
                  sk((side * 2.05, -2.4, 0.42)),
                  sk((side * 1.35, -4.7, 0.22)),
                  sk((side * 0.40, -6.1, 0.14))]
        jpts = catmull(j_ctrl, 16)
        radii = [0.20 * (1 - 0.55 * j / 16) for j in range(17)]
        o = loft_tube(coll, f"{name}_jaw{side}", jpts, radii, bone, segs=9, squash=0.8)
        parts.append(o)
    # eye sockets: dark insets on the cranium sides
    for side in (-1, 1):
        p = sk((side * 1.28, -0.15, 1.0))
        d = (M_SK.to_3x3() @ Vector((side, 0.15, 0.1))).normalized()
        bm = bm_cylinder(0.21, 0.16, 0.10, segs=10)
        q = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p) @ q.to_matrix().to_4x4(),
                            verts=bm.verts)
        o = obj_from_bmesh(f"{name}_eye{side}", bm, coll, dark, smooth=True)
        parts.append(o)

    # ── shoulder blades half-buried + chevrons under tail ──
    for side in (-1, 1):
        bm = bm_icosphere(0.7, subdiv=2)
        bmesh.ops.scale(bm, vec=Vector((0.25, 1.0, 0.8)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((side * 2.3, -1.1, 0.12)) @
                            Matrix.Rotation(side * 0.5, 4, 'Y'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_scap{side}", bm, coll, bone, smooth=True)
        parts.append(o)
    for side in (-1, 1):
        hb = Vector((side * 2.75, -0.7, 0.10))
        o = loft_tube(coll, f"{name}_hum{side}",
                      catmull([hb, hb + Vector((side * 0.7, -0.5, 0.04)),
                               hb + Vector((side * 1.1, -1.0, 0.02))], 6),
                      [0.14 - 0.05 * j / 6 for j in range(7)], bone, segs=7)
        parts.append(o)
        fb = hb + Vector((side * 1.15, -1.05, 0.0))
        for fi in range(4):
            ang = -0.5 + fi * 0.33
            d = Vector((side * math.cos(ang), -abs(math.sin(ang)) - 0.35, 0)).normalized()
            ln = 1.15 - 0.18 * abs(fi - 1.4)
            o = loft_tube(coll, f"{name}_fing{side}{fi}",
                          catmull([fb, fb + d * ln * 0.55 + Vector((0, 0, 0.05)),
                                   fb + d * ln], 6),
                          [0.075 - 0.04 * j / 6 for j in range(7)], bone, segs=6)
            parts.append(o)
    for k in range(5):
        t = 0.66 + 0.28 * k / 4
        i = min(NV, int(t * NV))
        p = spts[i]
        r = vert_r(i)
        bm = bm_cylinder(r * 0.22, r * 0.10, r * 1.6, segs=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p + Vector((0, 0.05, -r * 1.35))) @
                            Matrix.Rotation(math.radians(160), 4, 'X'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_chev{k}", bm, coll, bone, smooth=True)
        parts.append(o)

    # ── sand drifts against bones ──
    drifts = [(-1.9, 0.6, 0.9), (2.1, 1.8, 1.1), (-2.4, 4.3, 1.0),
              (2.5, 5.1, 0.8), (0.6, -5.6, 1.3), (-0.9, 9.8, 0.9)]
    for di, (dx, dy, ds) in enumerate(drifts):
        bm = bm_icosphere(ds, subdiv=3 if ds >= 1.0 else 2)
        bmesh.ops.scale(bm, vec=Vector((1.35, 1.7, 0.34)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((dx, dy, 0.02)) @
                            Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_drift{di}", bm, coll, sand, smooth=True)
        displace_noise(o, strength=0.08, scale=1.1, seed=20 + di)
        apply_modifiers(o)
        parts.append(o)

    for ci in range(18):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(1.6, 4.6)
        cp = Vector((math.cos(a) * r * 0.8, rng.uniform(-5.5, 10.5), 0.12))
        bm = bm_icosphere(rng.uniform(0.10, 0.22), subdiv=1)
        bmesh.ops.scale(bm, vec=Vector((1.0, rng.uniform(1.6, 2.6), 0.55)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(cp) @
                            Matrix.Rotation(rng.uniform(0, 3.1), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_chip{ci}", bm, coll, bone, smooth=True)
        parts.append(o)

    obj = join(parts, name)
    bake_ao(coll, floor=0.5, height_gradient=0.18)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=5)
    print(f"built {name}")


build_whale_skeleton()
