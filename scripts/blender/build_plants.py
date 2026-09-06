# Island vegetation set: leafy bush, berry bush, flowering shrub, a proper
# 3D fern, a flourishing flower bed, and tall wildflowers. Individual folded
# leaves, branched stems and tapered pinnae replace the old foliage blobs.
# Close-range instanced asset budget: 3,000 triangles, six material slots.
# Material names are a client API (sway/tint by name) — do not rename.
# Headless: Blender -b -P scripts/blender/build_plants.py
# Optional: PLANTS_RENDER_DIR=<dir> to write turntable renders per asset.
import bpy
import bmesh
import math
import random
import zlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_nature.py')).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)

RENDER_DIR = os.environ.get('PLANTS_RENDER_DIR', '')
clear_default_scene()

# Extra foliage/accent materials (added to the shared palette namespace).
EXTRA = {
    "Leaf_A": ((0.09, 0.28, 0.105, 1.0), 0.82, 0.0),
    "Leaf_B": ((0.16, 0.39, 0.13, 1.0), 0.8, 0.0),
    "Leaf_C": ((0.23, 0.33, 0.10, 1.0), 0.84, 0.0),
    "Berry_Red": ((0.48, 0.07, 0.09, 1.0), 0.75, 0.0),
    "Berry_Blue": ((0.20, 0.24, 0.52, 1.0), 0.45, 0.0),
    "Flower_Pink": ((0.76, 0.27, 0.43, 1.0), 0.8, 0.0),
    "Flower_Yellow": ((0.87, 0.64, 0.18, 1.0), 0.8, 0.0),
    "Flower_White": ((0.86, 0.83, 0.73, 1.0), 0.8, 0.0),
    "Stem": ((0.34, 0.24, 0.13, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)


def seed_of(name):
    """Deterministic per-asset seed (str hash is salted per process)."""
    return zlib.crc32(name.encode()) & 0xffff


def finish(coll, name):
    finish_nature(coll, name, budget=3000)


# ── shared geometry helpers ─────────────────────────────────
def bm_blade(length, width, rise, droop, yaw, pitch, base):
    """Twelve triangles define a curved leaf with a raised midvein, cupped
    margins and a pointed tip. Real leaf gaps work without alpha textures."""
    bm = bmesh.new()
    root = bm.verts.new((0, 0, 0))
    rings = []
    for t in (0.22, 0.50, 0.77):
        w = width * math.sin(math.pi * t) * 0.5
        z = rise * math.sin(math.pi * t * 0.72) - droop * t * t
        # Offset the margin slightly so leaves have an organic asymmetry.
        rings.append([bm.verts.new((-w, length * t, z - width * 0.12)),
                      bm.verts.new((0, length * t, z + width * 0.08)),
                      bm.verts.new((w * 0.91, length * t + length * 0.025, z - width * 0.12))])
    tip = bm.verts.new((width * 0.045, length, rise * 0.77 - droop))
    bm.faces.new((root, rings[0][1], rings[0][0]))
    bm.faces.new((root, rings[0][2], rings[0][1]))
    for a, b in zip(rings, rings[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0]))
        bm.faces.new((a[1], a[2], b[2], b[1]))
    bm.faces.new((rings[-1][0], rings[-1][1], tip))
    bm.faces.new((rings[-1][1], rings[-1][2], tip))
    m = Matrix.Translation(base) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(pitch, 4, 'X')
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def bm_bent_stem(base, height, lean_dir, lean_amt, segs_n=3, r1=0.02, r2=0.008, sides=3):
    """Multi-segment stem that curves progressively toward lean_dir (no straight
    cones). Returns (bmesh, top_point, top_tilt). Open bottom, capped top."""
    bm = bmesh.new()
    pos = Vector(base)
    ring_data = []
    for s in range(segs_n + 1):
        t = s / segs_n
        ring_data.append((pos.copy(), r1 + (r2 - r1) * t))
        ang = lean_amt * (t + 1.0 / segs_n) if s < segs_n else lean_amt
        d = Vector((math.sin(ang) * math.cos(lean_dir),
                    math.sin(ang) * math.sin(lean_dir),
                    math.cos(ang)))
        pos = pos + d * (height / segs_n)
    rings = []
    for c, r in ring_data:
        ring = [bm.verts.new((c.x + math.cos(k / sides * math.tau) * r,
                              c.y + math.sin(k / sides * math.tau) * r, c.z))
                for k in range(sides)]
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    bm.faces.new(tuple(reversed(rings[-1])))
    return bm, ring_data[-1][0], lean_amt


def bm_flower_head(petal_r, rng, cup=0.42):
    """Cupped 5-petal flower head with rounded shoulders (4 tris per petal),
    local +Z up, centered at origin."""
    bm = bmesh.new()
    for p in range(5):
        a = p * math.tau / 5 + rng.random() * 0.18
        v0 = bm.verts.new((0, 0, 0.004))
        outline = [v0]
        for offset, reach, lift in ((-0.44, 0.48, 0.10), (-0.25, 0.89, cup * 0.75),
                                    (0, 1, cup), (0.25, 0.89, cup * 0.75), (0.44, 0.48, 0.10)):
            outline.append(bm.verts.new((math.cos(a + offset) * petal_r * reach,
                                         math.sin(a + offset) * petal_r * reach, petal_r * lift)))
        bm.faces.new(outline)
    return bm


def flower_at(coll, name, i, pos, normal_tilt_x, yaw, petal_mat, rng, petal_r=0.085):
    """Flower head + yellow center oriented by (yaw, tilt). Returns parts."""
    parts = []
    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(normal_tilt_x, 4, 'X')
    hbm = bm_flower_head(petal_r, rng)
    bmesh.ops.transform(hbm, matrix=Matrix.Translation(pos) @ rot, verts=hbm.verts)
    parts.append(obj_from_bmesh(f"{name}_petal{i}", hbm, coll, mat(petal_mat), smooth=True))
    cbm = bmesh.new()
    bmesh.ops.create_icosphere(cbm, subdivisions=1, radius=petal_r * 0.24)
    up = rot @ Vector((0, 0, 1, 0))
    bmesh.ops.transform(cbm, matrix=Matrix.Translation(pos + up.to_3d() * petal_r * 0.10),
                        verts=cbm.verts)
    parts.append(obj_from_bmesh(f"{name}_center{i}", cbm, coll,
                                mat("Flower_Yellow"), smooth=True))
    return parts


# ── bushes ──────────────────────────────────────────────────
def leaf_clump(coll, name, radius, leaf_mats, rng, blobs, jitter=0.46):
    """Woody shoots carry opposite leaf pairs, exposing airy gaps and twig
    forks. Returned tips attach berries/flowers to actual branch endings."""
    parts = []
    blob_data = []
    shoots = blobs + 3
    for i in range(shoots):
        ang = i * 2.39996 + rng.uniform(-0.30, 0.30)
        reach = radius * rng.uniform(0.45, 0.84)
        height = radius * (1.42 if i == 0 else rng.uniform(0.72, 1.24))
        base = Vector((math.cos(ang) * 0.04, math.sin(ang) * 0.04, 0.05))
        pts = [base + Vector((math.cos(ang) * reach * t,
                             math.sin(ang) * reach * t, height * (t - t*t*0.17)))
               for t in (0, 0.33, 0.66, 1)]
        parts += chain_pts(coll, f'{name}_shoot{i}', pts, 0.018, 0.005,
                           mat('Stem'), segs=5, balls=False)
        for k in range(7):
            t = 0.21 + k * 0.115 + rng.uniform(-0.018, 0.018)
            p = base + Vector((math.cos(ang) * reach * t,
                               math.sin(ang) * reach * t, height * (t - t*t*0.17)))
            for side in (-1, 1):
                leaf_yaw = ang - math.pi / 2 + side * (0.85 + t * 0.35)
                length = rng.uniform(0.14, 0.23) * (1.16 - 0.40 * t)
                bm = bm_blade(length, length * rng.uniform(0.43, 0.65),
                              length * 0.24, length * 0.23, leaf_yaw,
                              rng.uniform(-0.16, 0.38), p)
                parts.append(obj_from_bmesh(f'{name}_leaf{i}_{k}_{side}', bm, coll,
                                            mat(leaf_mats[(i + k) % len(leaf_mats)]), smooth=True))
        blob_data.append((pts[-1], 0.045))
    return parts, blob_data


def canopy_point(blob_data, rng, embed=0.90):
    """Random point on the upper surface of a random canopy blob.
    Returns (position, outward direction)."""
    off, br = blob_data[int(rng.random() * len(blob_data))]
    ang = rng.random() * math.tau
    el = 0.15 + rng.random() * 0.75  # upper hemisphere bias
    d = Vector((math.cos(ang) * math.cos(el * math.pi / 2),
                math.sin(ang) * math.cos(el * math.pi / 2),
                math.sin(el * math.pi / 2))).normalized()
    p = off + Vector((d.x, d.y, d.z * 0.78)) * (br * embed)
    return p, d


def build_bush(name, berry=None, flower=None):
    coll = asset_collection(name)
    rng = random.Random(seed_of(name))
    radius = 0.7
    blobs = 7 if (berry is None and flower is None) else 5
    parts, blob_data = leaf_clump(coll, name, radius,
                                  ["Leaf_A", "Leaf_B", "Leaf_C"], rng, blobs)

    # short woody base, leaning slightly off-axis
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.055, radius2=0.028, depth=0.24)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.075))
                        @ Matrix.Rotation(0.10, 4, 'Y'), verts=bm.verts)
    base = obj_from_bmesh(f"{name}_base", bm, coll, mat("Stem"))
    bevel_obj(base, width=0.012)
    apply_modifiers(base)
    parts.append(base)

    if berry:
        # berry clusters seated on the canopy surface (icosahedron = 20 tris)
        clusters = 8 + int(rng.random() * 2)
        for c in range(clusters):
            cpos, d = canopy_point(blob_data, rng, embed=0.96)
            tan = d.cross(Vector((0, 0, 1)))
            if tan.length < 0.1:
                tan = Vector((1, 0, 0))
            tan.normalize()
            for b in range(2 + int(rng.random() * 2)):
                jit = (tan * (rng.random() - 0.5) + d.cross(tan) * (rng.random() - 0.5)) * 0.12
                bm = bmesh.new()
                bmesh.ops.create_icosphere(bm, subdivisions=1,
                                           radius=0.052 + rng.random() * 0.022)
                bmesh.ops.transform(bm, matrix=Matrix.Translation(cpos + jit + d * 0.035),
                                    verts=bm.verts)
                parts.append(obj_from_bmesh(f"{name}_berry{c}_{b}", bm, coll,
                                            mat(berry), smooth=True))
    elif flower:
        # cupped blooms seated on and facing out of the canopy
        count = 11 + int(rng.random() * 3)
        for i in range(count):
            pos, d = canopy_point(blob_data, rng, embed=0.97)
            yaw = math.atan2(d.y, d.x) - math.pi / 2
            tilt = -math.acos(max(-1.0, min(1.0, d.z)))
            parts.extend(flower_at(coll, name, i, pos, tilt, yaw,
                                   flower, rng, petal_r=0.085 + rng.random() * 0.02))

    finish(coll, name)


# ── fern ────────────────────────────────────────────────────
def build_fern(name):
    """Arching fronds with tapered, folded pinnae and raised rachis veins."""
    coll = asset_collection(name)
    rng = random.Random(seed_of(name))
    parts = []
    fronds = 13
    for i in range(fronds):
        yaw = (i / fronds) * math.tau + rng.random() * 0.35
        inner = (i % 4 == 0)  # every fourth frond stands taller in the middle
        length = (0.90 if inner else 0.70) + rng.random() * 0.12
        e0 = math.radians((85 if inner else 80) + rng.random() * 4)
        droop = math.radians((50 if inner else 58) + rng.random() * 8)
        segs_n = 8
        seg = length / segs_n
        # sample the rachis curve
        pts = [Vector((0, 0.03, 0.02))]
        for s in range(segs_n):
            ang = e0 - droop * (s / (segs_n - 1))
            pts.append(pts[-1] + Vector((0, math.cos(ang), math.sin(ang))) * seg)
        rot = Matrix.Rotation(yaw, 4, 'Z')
        # rachis: tapered flat strip along the curve (2 tris/segment)
        rbm = bmesh.new()
        rings = []
        for s, p in enumerate(pts):
            w = 0.020 * (1 - s / segs_n) + 0.004
            rings.append((rbm.verts.new((p.x - w, p.y, p.z)),
                          rbm.verts.new((p.x + w, p.y, p.z))))
        for a, b in zip(rings, rings[1:]):
            rbm.faces.new((a[0], a[1], b[1], b[0]))
        bmesh.ops.transform(rbm, matrix=rot, verts=rbm.verts)
        parts.append(obj_from_bmesh(f"{name}_rachis{i}", rbm, coll, mat("Leaf_C")))
        # pinnae: paired curved blades at 8 stations, shrinking toward the tip,
        # swept forward and drooping gently so the frond reads as one leaf
        pbm = bmesh.new()
        stations = 12
        for k in range(stations):
            t = (k + 1) / (stations + 1)
            fs = t * segs_n
            s0 = min(int(fs), segs_n - 1)
            p = pts[s0].lerp(pts[s0 + 1], fs - s0)
            ang = e0 - droop * min(1.0, s0 / (segs_n - 1))
            plen = 0.24 * (1 - t) + 0.06
            for side in (-1, 1):
                # Six triangles per pinna: pointed tip, ridged midrib,
                # broad inner shoulder and narrow outer shoulder.
                coords = [(0, 0, 0), (side * plen * 0.35, -0.028, -plen * 0.04),
                          (side * plen * 0.40, 0, 0.012),
                          (side * plen * 0.35, 0.028, -plen * 0.04),
                          (side * plen * 0.75, -0.013, -plen * 0.12),
                          (side * plen * 0.78, 0, -plen * 0.065),
                          (side * plen * 0.75, 0.013, -plen * 0.12),
                          (side * plen, 0, -plen * 0.22)]
                v = [pbm.verts.new(q) for q in coords]
                for inds in ((0, 1, 2), (0, 2, 3), (1, 4, 5, 2),
                             (2, 5, 6, 3), (4, 7, 5), (5, 7, 6)):
                    face = tuple(v[q] for q in inds)
                    pbm.faces.new(face if side > 0 else tuple(reversed(face)))
                bmesh.ops.transform(
                    pbm, verts=v,
                    matrix=Matrix.Translation(p)
                    @ Matrix.Rotation(math.radians(38) * side * (0.5 + t * 0.8), 4, 'Z')
                    @ Matrix.Rotation(-(math.pi / 2 - ang) * 0.55, 4, 'X'))
        bmesh.ops.transform(pbm, matrix=rot, verts=pbm.verts)
        parts.append(obj_from_bmesh(f"{name}_pin{i}", pbm, coll,
                                    mat("Leaf_A" if i % 2 else "Leaf_B"), smooth=True))
    # root crown
    cbm = bmesh.new()
    bmesh.ops.create_icosphere(cbm, subdivisions=1, radius=0.11)
    for v in cbm.verts:
        v.co.z *= 0.55
    bmesh.ops.transform(cbm, matrix=Matrix.Translation((0, 0, 0.02)), verts=cbm.verts)
    parts.append(obj_from_bmesh(f"{name}_crown", cbm, coll, mat("Stem")))
    finish(coll, name)


# ── flower patch ────────────────────────────────────────────
def build_flower_patch(name):
    """Dense flourishing bed: crinkled low mound carpeted with cupped blooms on
    short bent stems, grass blades poking through."""
    coll = asset_collection(name)
    rng = random.Random(seed_of(name))
    parts = []
    radius = 0.74
    # Leaf rosettes form an open ground carpet; no solid green mound.
    for i in range(40):
        a = i * 2.39996
        rr = radius * math.sqrt((i + 0.5) / 40) * 0.82
        parts.append(obj_from_bmesh(f'{name}_rosette{i}',
            bm_blade(0.18, 0.075, 0.045, 0.05, a, 0.25,
                     Vector((math.cos(a) * rr, math.sin(a) * rr, 0.015))),
            coll, mat('Leaf_A'), smooth=True))
    # curved grass blades poking through
    for i in range(16):
        ang = rng.random() * math.tau
        rr = radius * (0.15 + rng.random() * 0.8)
        blade = 0.17 + rng.random() * 0.20
        parts.append(obj_from_bmesh(
            f"{name}_grass{i}",
            bm_blade(blade, 0.030, blade * 0.35, blade * 0.30,
                     rng.random() * math.tau, math.radians(58 + rng.random() * 22),
                     Vector((math.cos(ang) * rr, math.sin(ang) * rr, 0.04))),
            coll, mat("Leaf_C")))
    # blooms carpeting the mound — mixed colours, bent stems, cupped heads
    palettes = ["Flower_Pink", "Flower_Yellow", "Flower_White",
                "Flower_Pink", "Flower_Yellow"]
    count = 32 + int(rng.random() * 4)
    for i in range(count):
        ang = rng.random() * math.tau
        rr = radius * math.sqrt(rng.random()) * 0.96
        base = Vector((math.cos(ang) * rr, math.sin(ang) * rr,
                       0.04 + (1 - rr / radius) * 0.09))
        stem_h = 0.10 + rng.random() * 0.15
        lean_dir = rng.random() * math.tau
        lean = 0.15 + rng.random() * 0.35
        sbm, top, tilt = bm_bent_stem(base, stem_h, lean_dir, lean,
                                      segs_n=3, sides=4, r1=0.013, r2=0.007)
        parts.append(obj_from_bmesh(f"{name}_stem{i}", sbm, coll, mat("Stem")))
        parts.extend(flower_at(coll, name, i, top, -tilt * 0.8, lean_dir + math.pi / 2,
                               rng.choice(palettes), rng,
                               petal_r=0.09 + rng.random() * 0.04))
    finish(coll, name)


# ── wildflowers ─────────────────────────────────────────────
def build_wildflowers(name):
    """Clump of tall wildflower stalks — bent multi-segment stems (no straight
    cones), curved leaf blades, cupped mixed-colour heads."""
    coll = asset_collection(name)
    rng = random.Random(seed_of(name))
    parts = []
    palettes = ["Flower_Pink", "Flower_Yellow", "Flower_White"]
    stalks = 12
    for i in range(stalks):
        ang = (i / stalks) * math.tau + rng.random() * 0.5
        base_r = 0.04 + rng.random() * 0.17
        base = Vector((math.cos(ang) * base_r, math.sin(ang) * base_r, 0))
        height = 0.48 + rng.random() * 0.42
        lean_dir = ang + (rng.random() - 0.5) * 1.2
        lean = 0.12 + rng.random() * 0.28
        sbm, top, tilt = bm_bent_stem(base, height, lean_dir, lean,
                                      segs_n=5, sides=5, r1=0.018, r2=0.007)
        parts.append(obj_from_bmesh(f"{name}_stem{i}", sbm, coll, mat("Leaf_C")))
        # two curved leaf blades midway up
        for k in range(2):
            h = height * (0.30 + k * 0.22)
            lp = base + Vector((math.sin(tilt * h / height) * math.cos(lean_dir),
                                math.sin(tilt * h / height) * math.sin(lean_dir), 0)) * h
            lp.z = h * math.cos(tilt * 0.5)
            parts.append(obj_from_bmesh(
                f"{name}_leaf{i}_{k}",
                bm_blade(0.15 + rng.random() * 0.05, 0.045, 0.03, 0.05,
                         ang + k * math.pi + rng.random() * 0.6,
                         math.radians(30 + rng.random() * 20), lp),
                coll, mat("Leaf_B")))
        # nodding head at the stem tip
        parts.extend(flower_at(coll, name, i, top, -(0.9 + tilt),
                               lean_dir + math.pi / 2, rng.choice(palettes), rng,
                               petal_r=0.09 + rng.random() * 0.02))
    # woody root nub at the clump center (keeps the Stem material slot the
    # client expects on this asset) + grass tuft tying it to the ground
    nbm = bmesh.new()
    bmesh.ops.create_icosphere(nbm, subdivisions=1, radius=0.07)
    for v in nbm.verts:
        v.co.z *= 0.5
    bmesh.ops.transform(nbm, matrix=Matrix.Translation((0, 0, 0.01)), verts=nbm.verts)
    parts.append(obj_from_bmesh(f"{name}_root", nbm, coll, mat("Stem")))
    for g in range(6):
        gang = rng.random() * math.tau
        parts.append(obj_from_bmesh(
            f"{name}_tuft{g}",
            bm_blade(0.14 + rng.random() * 0.08, 0.028, 0.04, 0.04,
                     gang, math.radians(52 + rng.random() * 25),
                     Vector((math.cos(gang) * 0.08, math.sin(gang) * 0.08, 0))),
            coll, mat("Leaf_C")))
    finish(coll, name)


build_bush("bush")
build_bush("bush_berry", berry="Berry_Red")
build_bush("flower_bush", flower="Flower_Pink")
build_fern("fern_plant")
build_flower_patch("flower_patch")
build_wildflowers("wildflowers")
render_nature(('bush', 'fern_plant', 'flower_patch'), RENDER_DIR)
print("PLANTS DONE")
