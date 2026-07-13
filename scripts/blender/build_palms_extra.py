# Extra palm variants -> palm_tall.glb (very tall thin coconut palm, ~13.5u)
# and palm_ground.glb (low ground fan palm, bigger leaflet blades, <=2,500 tris).
# Same high-fidelity build as build_palms.py: lofted trunk with frond-scar
# diamond rings, fronds = arched midrib tube + modeled leaflet quads, hanging
# dead fronds (Leaf_Dry), coconut clusters. Origin: trunk base at (0,0,0);
# client wind-sway shader bends the crown by local height.
# Headless: Blender -b -P scripts/blender/build_palms_extra.py
# Optional env RENDER_DIR=/path -> turntable renders per palm.
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())


# ── Trunk ────────────────────────────────────────────────────
def trunk_path(height, lean, curve_pow, n):
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append(Vector((lean[0] * (t ** curve_pow),
                           lean[1] * (t ** curve_pow), height * t)))
    return pts


def build_trunk(name, coll, height, lean, seed, r0=0.30, r1=0.16,
                rings=15, segs=14, curve_pow=1.7):
    """Lofted tapered tube: base flare + segment bulges + frond-scar diamonds."""
    rng = random.Random(seed)
    pts = trunk_path(height, lean, curve_pow, rings)
    bm = bmesh.new()
    ring_verts = []
    n_dia = 6
    for i, p in enumerate(pts):
        t = i / rings
        base_r = r0 * (1 - t) + r1 * t
        if t < 0.12:
            base_r *= 1.0 + 0.55 * (1.0 - t / 0.12) ** 2
        base_r *= 1.0 + (0.07 if i % 2 == 0 else -0.03)
        jx = rng.uniform(-0.025, 0.025)
        jy = rng.uniform(-0.025, 0.025)
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            r = base_r
            if t > 0.22:
                phase = 0.5 if i % 2 == 0 else 0.0
                d = math.cos(2 * math.pi * (j / segs * n_dia + phase))
                r += base_r * 0.10 * max(0.0, d) ** 1.5
            ring.append(bm.verts.new((p.x + jx + r * math.cos(a),
                                      p.y + jy + r * math.sin(a), p.z)))
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    bm.faces.new(tuple(reversed(ring_verts[0])))
    bm.faces.new(tuple(ring_verts[-1]))
    obj = obj_from_bmesh(name, bm, coll, mat("Trunk_Palm"), smooth=True)
    tip_dir = (pts[-1] - pts[-2]).normalized()
    return obj, pts[-1], tip_dir


# ── Frond ────────────────────────────────────────────────────
def frond_arch(length, rise, sag, n):
    pts = []
    for i in range(n + 1):
        t = i / n
        z = rise * math.sin(min(t * 2.2, math.pi)) - sag * (t ** 2.2)
        pts.append(Vector((length * t, 0.0, z)))
    return pts


def build_frond(name, coll, origin, yaw, tilt, length, material, seed,
                pairs=14, blade=0.30, droopy=False):
    """Arched midrib tube + leaflet quads in a V, drooping toward the tips."""
    rng = random.Random(seed)
    n = 10
    sag = length * (0.95 if droopy else 0.55)
    rise = 0.0 if droopy else length * 0.10
    path = frond_arch(length, rise, sag, n)
    bm = bmesh.new()
    rib_rings = []
    for i, p in enumerate(path):
        t = i / n
        r = (0.030 - 0.024 * t) * max(1.0, length / 2.8)
        tang = (path[min(i + 1, n)] - path[max(i - 1, 0)]).normalized()
        side = tang.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(tang)
        ring = []
        for j in range(5):
            a = 2 * math.pi * j / 5
            ring.append(bm.verts.new(p + side * (r * math.cos(a)) + up * (r * math.sin(a))))
        rib_rings.append(ring)
    for i in range(n):
        a, b = rib_rings[i], rib_rings[i + 1]
        for j in range(5):
            bm.faces.new((a[j], a[(j + 1) % 5], b[(j + 1) % 5], b[j]))
    bm.faces.new(tuple(reversed(rib_rings[0])))
    bm.faces.new(tuple(rib_rings[-1]))

    def path_at(t):
        f = t * n
        i = min(int(f), n - 1)
        u = f - i
        p = path[i].lerp(path[i + 1], u)
        tang = (path[i + 1] - path[i]).normalized()
        return p, tang

    for k in range(pairs):
        t = 0.10 + 0.89 * k / max(1, pairs - 1)
        p, tang = path_at(t)
        side = tang.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(tang)
        prof = math.sin(math.pi * min(t * 1.05 + 0.08, 1.0)) ** 0.7
        llen = length * blade * max(0.30, prof) * rng.uniform(0.9, 1.1)
        va = (0.55 - 0.40 * t) * (0.4 if droopy else 1.0)
        drop = llen * ((0.55 if droopy else 0.22) + 0.55 * t)
        sweep = llen * 0.38
        w0 = llen * (0.30 if droopy else 0.24)
        for sgn in (-1.0, 1.0):
            d = (side * sgn * math.cos(va) + up * math.sin(va)).normalized()
            b0 = p - tang * w0 * 0.5
            b1 = p + tang * w0 * 0.5
            m0 = p + d * llen * 0.55 + tang * (sweep * 0.5 - w0 * 0.40) - up * drop * 0.30
            m1 = p + d * llen * 0.55 + tang * (sweep * 0.5 + w0 * 0.40) - up * drop * 0.30
            tp = p + d * llen + tang * sweep - up * drop
            v = [bm.verts.new(q) for q in (b0, b1, m0, m1, tp)]
            bm.faces.new((v[0], v[1], v[3], v[2]))
            bm.faces.new((v[2], v[3], v[4]))
    p, tang = path_at(1.0)
    side = tang.cross(Vector((0, 0, 1))).normalized()
    up = side.cross(tang)
    tl = length * blade * 0.5
    v = [bm.verts.new(q) for q in (
        p - side * tl * 0.10, p + side * tl * 0.10,
        p + tang * tl - up * tl * 0.7)]
    bm.faces.new((v[0], v[1], v[2]))

    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(origin) @ rot, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material)


def build_crown_core(name, coll, top, tip_dir, r=0.30):
    bm = bm_icosphere(r, 1)
    bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.35)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(top + tip_dir * 0.10),
                        verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat("Trunk_Palm"), smooth=True)


def build_coconuts(name, coll, top, seed, count):
    rng = random.Random(seed)
    parts = []
    for k in range(count):
        a = k * (2 * math.pi / max(1, count)) + rng.uniform(-0.3, 0.3)
        r = 0.21 + rng.uniform(0.0, 0.05)
        bm = bm_icosphere(r, 1)
        bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.15)), verts=bm.verts)
        pos = top + Vector((0.46 * math.cos(a), 0.46 * math.sin(a),
                            -0.56 - rng.uniform(0.0, 0.12)))
        bmesh.ops.transform(bm, matrix=Matrix.Translation(pos), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}{k}", bm, coll, mat("Coconut"),
                                    smooth=True))
    return parts


# ── Assembly ─────────────────────────────────────────────────
def build_palm(name, height, lean, fronds, dead, seed, r0, r1,
               frond_scale, cocos, pairs, tilts=(0.34, 0.66, 0.98),
               blade=0.30, spears=2, core_r=0.30, rings=15, segs=14):
    coll = asset_collection(name)
    trunk, top, tip_dir = build_trunk(f"{name}_trunk", coll, height, lean,
                                      seed, r0=r0, r1=r1, rings=rings, segs=segs)
    parts = [trunk, build_crown_core(f"{name}_core", coll, top, tip_dir, core_r)]
    rng = random.Random(seed + 77)
    golden = math.pi * (3 - math.sqrt(5))
    for k in range(fronds):
        yaw = k * golden + rng.uniform(-0.18, 0.18)
        tier = k % 3
        tilt = tilts[tier] + rng.uniform(-0.10, 0.10)
        length = height * frond_scale * (1.0, 0.94, 0.82)[tier] * rng.uniform(0.9, 1.08)
        m = mat("Leaf_Green" if k % 2 == 0 else "Leaf_Green_Lt")
        parts.append(build_frond(f"{name}_frond{k}", coll,
                                 top + tip_dir * 0.10, yaw, tilt, length,
                                 m, seed * 31 + k, pairs=pairs, blade=blade))
    for k in range(spears):
        parts.append(build_frond(f"{name}_spear{k}", coll,
                                 top + tip_dir * 0.14,
                                 rng.uniform(0, 2 * math.pi),
                                 0.10 + 0.12 * k,
                                 height * frond_scale * 0.55,
                                 mat("Leaf_Green_Lt"), seed * 17 + k,
                                 pairs=10, blade=blade))
    for k in range(dead):
        yaw = rng.uniform(0, 2 * math.pi)
        tilt = rng.uniform(1.55, 1.85)
        length = height * frond_scale * rng.uniform(0.55, 0.7)
        parts.append(build_frond(f"{name}_dead{k}", coll,
                                 top + Vector((0, 0, -0.05)), yaw, tilt, length,
                                 mat("Leaf_Dry"), seed * 53 + k,
                                 pairs=11, blade=blade, droopy=True))
    if cocos:
        parts += build_coconuts(f"{name}_coco", coll, top + tip_dir * 0.06,
                                seed + 5, cocos)
    palm = join(parts, name)
    return coll, palm


RENDER_DIR = os.environ.get("RENDER_DIR", "")
clear_default_scene()

BUILDS = [
    # Very tall thin coconut palm — upright, whippy, sparse crown, ~13.5u.
    dict(name="palm_tall", height=13.5, lean=(1.1, -0.5), fronds=10, dead=2,
         seed=71, r0=0.22, r1=0.10, frond_scale=0.32, cocos=4, pairs=14,
         tilts=(0.26, 0.55, 0.90), rings=17, segs=12, core_r=0.26),
    # Short ground fan palm — low stump, big fanned fronds with wide blades.
    dict(name="palm_ground", height=1.4, lean=(0.18, 0.10), fronds=9, dead=2,
         seed=88, r0=0.28, r1=0.20, frond_scale=0.66, cocos=0, pairs=9,
         tilts=(-0.85, -0.35, 0.30), blade=0.54, spears=2, rings=7, segs=12,
         core_r=0.22),
]

for spec in BUILDS:
    coll, palm = build_palm(**spec)
    bake_ao(coll, floor=0.6)
    path = export_collection_vc(coll, f"{spec['name']}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, spec['name'], RENDER_DIR)
    for o in coll.objects:
        o.hide_render = True
    print(f"built {spec['name']}")

print("PALMS EXTRA DONE")
