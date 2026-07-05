# Island vegetation set: leafy bush, berry bush, flowering shrub, and a proper
# 3D fern — stylized low-poly foliage to replace the flat-quad greebles.
# Headless: Blender -b -P scripts/blender/build_plants.py
import bpy
import bmesh
import math
import random
import os

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())

# Extra foliage/accent materials (added to the shared palette namespace).
EXTRA = {
    "Leaf_A": ((0.16, 0.40, 0.16, 1.0), 0.82, 0.0),
    "Leaf_B": ((0.22, 0.50, 0.20, 1.0), 0.8, 0.0),
    "Leaf_C": ((0.30, 0.44, 0.16, 1.0), 0.84, 0.0),
    "Berry_Red": ((0.62, 0.10, 0.12, 1.0), 0.42, 0.0),
    "Berry_Blue": ((0.20, 0.24, 0.52, 1.0), 0.45, 0.0),
    "Flower_Pink": ((0.86, 0.42, 0.60, 1.0), 0.6, 0.0),
    "Flower_Yellow": ((0.92, 0.80, 0.30, 1.0), 0.6, 0.0),
    "Flower_White": ((0.94, 0.92, 0.86, 1.0), 0.7, 0.0),
    "Stem": ((0.34, 0.24, 0.13, 1.0), 0.9, 0.0),
}
for name, (col, rough, metal) in EXTRA.items():
    if name not in PALETTE:
        PALETTE[name] = (col, rough, metal)


def leaf_clump(coll, name, radius, leaf_mats, rng, jitter=0.32):
    """A rounded bush body from overlapping faceted leaf blobs."""
    parts = []
    blobs = 5 + int(rng.random() * 4)
    for i in range(blobs):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius * (0.45 + rng.random() * 0.4))
        ang = rng.random() * math.tau
        rr = radius * rng.random() * jitter
        off = Vector((math.cos(ang) * rr, math.sin(ang) * rr,
                      radius * (0.25 + rng.random() * 0.75)))
        # squash slightly so bushes read wider than tall
        for v in bm.verts:
            v.co.z *= 0.82
        bmesh.ops.transform(bm, matrix=Matrix.Translation(off), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_leaf{i}", bm, coll,
                                         mat(leaf_mats[i % len(leaf_mats)]), smooth=False))
    return parts


def build_bush(name, berry=None, flower=None):
    coll = asset_collection(name)
    rng = random.Random(hash(name) & 0xffff)
    radius = 0.7
    parts = leaf_clump(coll, name, radius, ["Leaf_A", "Leaf_B", "Leaf_C"], rng)

    # short woody base
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.09, radius2=0.06, depth=0.35)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.14)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_base", bm, coll, mat("Stem")))

    # accents: berries or flowers dotted over the canopy
    accents = 0
    if berry:
        accents = 14 + int(rng.random() * 10)
    elif flower:
        accents = 9 + int(rng.random() * 6)
    for i in range(accents):
        ang = rng.random() * math.tau
        el = 0.2 + rng.random() * 0.75
        rr = radius * (0.55 + rng.random() * 0.4)
        pos = Vector((math.cos(ang) * rr, math.sin(ang) * rr, radius * el + 0.2))
        if berry:
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.055)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(pos), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_berry{i}", bm, coll, mat(berry)))
        else:
            # flat 5-petal flower disc
            bm = bmesh.new()
            bmesh.ops.create_circle(bm, cap_ends=True, segments=5, radius=0.075)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(pos)
                                @ Matrix.Rotation(rng.random() * math.tau, 4, 'Z')
                                @ Matrix.Rotation(-1.2 + rng.random() * 0.6, 4, 'X'),
                                verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_flower{i}", bm, coll, mat(flower)))
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.022)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(pos + Vector((0, 0, 0.01))), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_center{i}", bm, coll, mat("Flower_Yellow")))

    obj = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return obj


def build_fern(name):
    coll = asset_collection(name)
    rng = random.Random(41)
    parts = []
    fronds = 9
    for i in range(fronds):
        yaw = (i / fronds) * math.tau + rng.random() * 0.3
        arch = 0.9 + rng.random() * 0.3
        length = 0.85 + rng.random() * 0.3
        # rachis as a tapered strip; pinnae as small angled blades
        rbm = bmesh.new()
        bmesh.ops.create_cone(rbm, cap_ends=True, segments=4, radius1=0.02, radius2=0.006, depth=length)
        m = (Matrix.Rotation(yaw, 4, 'Z')
             @ Matrix.Translation((0, 0, length * 0.5))
             @ Matrix.Rotation(math.radians(58) * arch, 4, 'X'))
        bmesh.ops.transform(rbm, matrix=m, verts=rbm.verts)
        parts.append(obj_from_bmesh(f"{name}_rachis{i}", rbm, coll, mat("Leaf_C")))
        # leaflet blades along the frond
        for k in range(1, 6):
            t = k / 6.0
            lbm = bmesh.new()
            plen = (1 - t) * 0.28 + 0.06
            bmesh.ops.create_cone(lbm, cap_ends=True, segments=3, radius1=0.05, radius2=0.006, depth=plen)
            local = (Matrix.Rotation(yaw, 4, 'Z')
                     @ Matrix.Translation((0, math.sin(t) * 0.16, t * length * 0.9 + 0.08))
                     @ Matrix.Rotation(math.radians(55), 4, 'X')
                     @ Matrix.Rotation(math.radians(70), 4, 'Y'))
            bmesh.ops.transform(lbm, matrix=local, verts=lbm.verts)
            parts.append(obj_from_bmesh(f"{name}_pin{i}_{k}", lbm, coll, mat("Leaf_B")))
    obj = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return obj


def _flower(coll, name, i, pos, tilt, petal_mat, rng, petal_r=0.085):
    """A stylized 5-petal flower head + yellow center on a short stem."""
    parts = []
    # short stem
    sbm = bmesh.new()
    stem_h = 0.10 + rng.random() * 0.14
    bmesh.ops.create_cone(sbm, cap_ends=True, segments=4, radius1=0.012, radius2=0.008, depth=stem_h)
    bmesh.ops.transform(sbm, matrix=Matrix.Translation((pos.x, pos.y, pos.z + stem_h * 0.5)), verts=sbm.verts)
    parts.append(obj_from_bmesh(f"{name}_stem{i}", sbm, coll, mat("Stem")))
    head = Vector((pos.x, pos.y, pos.z + stem_h))
    # petals
    pbm = bmesh.new()
    bmesh.ops.create_circle(pbm, cap_ends=True, segments=5, radius=petal_r)
    bmesh.ops.transform(
        pbm,
        matrix=Matrix.Translation(head)
        @ Matrix.Rotation(rng.random() * math.tau, 4, 'Z')
        @ Matrix.Rotation(tilt, 4, 'X'),
        verts=pbm.verts,
    )
    parts.append(obj_from_bmesh(f"{name}_petal{i}", pbm, coll, mat(petal_mat)))
    # center
    cbm = bmesh.new()
    bmesh.ops.create_icosphere(cbm, subdivisions=0, radius=petal_r * 0.34)
    bmesh.ops.transform(cbm, matrix=Matrix.Translation(head + Vector((0, 0, 0.012))), verts=cbm.verts)
    parts.append(obj_from_bmesh(f"{name}_center{i}", cbm, coll, mat("Flower_Yellow")))
    return parts


def build_flower_patch(name):
    """A dense, flourishing bed: a low grassy mound carpeted with flowers — the
    'chock-full' patch dropped into meadow clusters."""
    coll = asset_collection(name)
    rng = random.Random(hash(name) & 0xffff)
    parts = []
    radius = 0.74
    # low green mound base (squashed sphere)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius * 0.94)
    for v in bm.verts:
        v.co.z *= 0.2
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.05)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_mound", bm, coll, mat("Leaf_A"), smooth=False))
    # tufts of grass blades poking through
    for i in range(14):
        ang = rng.random() * math.tau
        rr = radius * (0.15 + rng.random() * 0.8)
        gbm = bmesh.new()
        blade = 0.16 + rng.random() * 0.22
        bmesh.ops.create_cone(gbm, cap_ends=True, segments=3, radius1=0.02, radius2=0.004, depth=blade)
        bmesh.ops.transform(
            gbm,
            matrix=Matrix.Translation((math.cos(ang) * rr, math.sin(ang) * rr, blade * 0.5 + 0.03))
            @ Matrix.Rotation((rng.random() - 0.5) * 0.5, 4, 'X'),
            verts=gbm.verts,
        )
        parts.append(obj_from_bmesh(f"{name}_grass{i}", gbm, coll, mat("Leaf_C")))
    # flowers carpeting the mound — dense, bold heads so the bed reads as a
    # flourishing burst of colour, not a green lump with a few dots.
    palettes = ["Flower_Pink", "Flower_Yellow", "Flower_White", "Flower_Pink", "Flower_Yellow"]
    count = 46 + int(rng.random() * 12)
    for i in range(count):
        ang = rng.random() * math.tau
        rr = radius * math.sqrt(rng.random()) * 0.98
        pos = Vector((math.cos(ang) * rr, math.sin(ang) * rr, 0.05 + rng.random() * 0.08))
        tilt = -1.2 + rng.random() * 0.55
        parts.extend(_flower(coll, name, i, pos, tilt, rng.choice(palettes), rng, petal_r=0.1 + rng.random() * 0.045))
    join(parts, name)
    export_collection(coll, f"{name}.glb")


def build_wildflowers(name):
    """A clump of tall wildflower stalks — vertical flower interest for lush
    meadows, mixed colours on slender stems."""
    coll = asset_collection(name)
    rng = random.Random(hash(name) & 0xffff)
    parts = []
    palettes = ["Flower_Pink", "Flower_Yellow", "Flower_White"]
    stalks = 6 + int(rng.random() * 3)
    for i in range(stalks):
        ang = rng.random() * math.tau
        base_r = rng.random() * 0.28
        bx = math.cos(ang) * base_r
        by = math.sin(ang) * base_r
        height = 0.5 + rng.random() * 0.42
        lean = (rng.random() - 0.5) * 0.35
        stem = bmesh.new()
        bmesh.ops.create_cone(stem, cap_ends=True, segments=4, radius1=0.02, radius2=0.008, depth=height)
        m = (Matrix.Translation((bx, by, 0))
             @ Matrix.Rotation(ang, 4, 'Z')
             @ Matrix.Rotation(lean, 4, 'X')
             @ Matrix.Translation((0, 0, height * 0.5)))
        bmesh.ops.transform(stem, matrix=m, verts=stem.verts)
        parts.append(obj_from_bmesh(f"{name}_stem{i}", stem, coll, mat("Leaf_C")))
        # a couple of leaves midway
        for k in range(2):
            leaf = bmesh.new()
            bmesh.ops.create_cone(leaf, cap_ends=True, segments=3, radius1=0.05, radius2=0.006, depth=0.16)
            lm = (Matrix.Translation((bx, by, height * (0.4 + k * 0.2)))
                  @ Matrix.Rotation(ang + k * math.pi, 4, 'Z')
                  @ Matrix.Rotation(math.radians(60), 4, 'X'))
            bmesh.ops.transform(leaf, matrix=lm, verts=leaf.verts)
            parts.append(obj_from_bmesh(f"{name}_leaf{i}_{k}", leaf, coll, mat("Leaf_B")))
        # flower head on top (lean carries it outward)
        head = Vector((bx + math.sin(ang) * math.sin(lean) * height,
                       by - math.cos(ang) * math.sin(lean) * height,
                       height * math.cos(lean)))
        parts.extend(_flower(coll, name, i, head, -1.4, rng.choice(palettes), rng, petal_r=0.1))
    join(parts, name)
    export_collection(coll, f"{name}.glb")


build_bush("bush")
build_bush("bush_berry", berry="Berry_Red")
build_bush("flower_bush", flower="Flower_Pink")
build_fern("fern_plant")
build_flower_patch("flower_patch")
build_wildflowers("wildflowers")
print("PLANTS DONE")
