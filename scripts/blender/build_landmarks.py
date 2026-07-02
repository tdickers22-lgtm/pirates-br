# Island landmark assets: watchtower ruin, shipwreck, standing stones, lantern post.
# These give islands readable identity/POIs. Origins at ground center, Z=0.
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

H = HELPERS


def ring_of_blocks(coll, name, radius, z, count, block, material, rng,
                   gap_chance=0.0, jitter=0.02):
    parts = []
    for k in range(count):
        if rng.random() < gap_chance:
            continue
        a = 2 * math.pi * (k + (z * 0.5)) / count  # offset alternate courses
        bm = H["bm_box"](*block)
        rot = Matrix.Rotation(a, 4, 'Z')
        pos = Vector((radius * math.cos(a), radius * math.sin(a),
                      z + rng.uniform(-jitter, jitter)))
        bmesh.ops.transform(bm, matrix=Matrix.Translation(pos) @ rot, verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_b{z:.1f}_{k}", bm, coll, material))
    return parts


def build_watchtower(name="watchtower"):
    """Ruined stone watchtower ~9u tall: solid tapered shell with a
    collapsed jagged top edge, doorway, lookout floor, rubble skirt."""
    coll = H["asset_collection"](name)
    rng = random.Random(42)
    stone = H["mat"]("Rock_Grey")
    dark = H["mat"]("Rock_Dark")
    parts = []
    segs = 14
    rings = 8
    r_base, r_top = 2.35, 1.85
    h_max, h_min = 9.0, 5.2  # jagged top: tallest on -X, collapsed on +X
    bm = bmesh.new()
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        r = r_base + (r_top - r_base) * t
        # subtle stone-course banding: alternate ring radius pulses
        r *= 1.0 + (0.035 if i % 2 == 0 else -0.015)
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            # per-column top height: collapse toward +X, ragged crenel notches
            col_h = h_min + (h_max - h_min) * (0.5 - 0.5 * math.cos(a))
            col_h += (0.55 if j % 2 == 0 else -0.45) + rng.uniform(-0.25, 0.25)
            z = min(t * h_max, col_h)
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            v1, v2, v3, v4 = a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]
            # skip degenerate quads where jagged cap flattened the column
            if abs(v1.co.z - v4.co.z) < 1e-4 and abs(v2.co.z - v3.co.z) < 1e-4:
                continue
            bm.faces.new((v1, v2, v3, v4))
    shell = H["obj_from_bmesh"](f"{name}_shell", bm, coll, stone)
    # wall thickness + stone irregularity
    solid = shell.modifiers.new("Solidify", 'SOLIDIFY')
    solid.thickness = 0.45
    H["displace_noise"](shell, strength=0.30, scale=0.9, seed=42)
    H["apply_modifiers"](shell)
    parts.append(shell)
    # doorway: dark inset arch at base front (-Y)
    bm = H["bm_box"](1.3, 0.9, 2.2)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -r_base + 0.25, 1.1)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_door", bm, coll, H["mat"]("Char_Black")))
    # stone lintel above doorway
    bm = H["bm_box"](1.7, 0.7, 0.45)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, -r_base + 0.3, 2.42)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_lintel", bm, coll, dark))
    # wooden lookout floor visible through collapsed side
    bm = H["bm_cylinder"](r_top + 0.1, r_top + 0.1, 0.14, segs=segs)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, h_min - 0.4)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_floor", bm, coll, H["mat"]("Wood_Bleached")))
    # broken flag post at the high rim
    bm = H["bm_cylinder"](0.09, 0.06, 2.4, segs=6)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((-r_top + 0.4, 0, h_max + 0.9)) @
                        Matrix.Rotation(0.2, 4, 'Y'), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_post", bm, coll, H["mat"]("Wood_Dark")))
    # rubble skirt on the collapsed (+X) side
    for k in range(10):
        a = rng.uniform(-0.9, 0.9)
        d = rng.uniform(r_base + 0.2, r_base + 2.2)
        bm = H["bm_icosphere"](rng.uniform(0.25, 0.6), 1)
        bmesh.ops.scale(bm, vec=Vector((1.3, 1.0, 0.55)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (d * math.cos(a), d * math.sin(a), 0.15)), verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_rub{k}", bm, coll,
                                         stone if k % 2 else dark))
    obj = H["join"](parts, name)
    return coll, obj


def build_shipwreck(name="shipwreck"):
    """Broken hull half beached at an angle — ribs exposed. ~11u long."""
    coll = H["asset_collection"](name)
    rng = random.Random(7)
    wood = H["mat"]("Wood_Bleached")
    dark = H["mat"]("Wood_Dark")
    parts = []
    L, W, Hh = 11.0, 4.2, 3.0
    # keel
    bm = H["bm_box"](L, 0.4, 0.5)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.4)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_keel", bm, coll, dark))
    # ribs: curved frames rooted at the keel, arcing up-and-out (quarter ellipse)
    nribs = 9
    def rib_arc(side, taper, broken):
        """Points from keel (0) up along an ellipse to the sheer line."""
        pts = []
        n = 5
        top = 1.0 if not broken else rng.uniform(0.35, 0.6)
        for s in range(n + 1):
            t = (s / n) * top
            ang = t * math.pi / 2
            y = side * (W / 2) * taper * math.sin(ang)
            z = 0.45 + Hh * taper * (1 - math.cos(ang))
            pts.append(Vector((0, y, z)))
        return pts
    for i in range(nribs):
        x = -L / 2 + L * i / (nribs - 1)
        taper = 1.0 - 0.55 * (abs(x) / (L / 2)) ** 1.6
        for side in (-1, 1):
            broken = rng.random() < 0.25
            pts = rib_arc(side, taper, broken)
            for s in range(len(pts) - 1):
                seg = pts[s + 1] - pts[s]
                mid = (pts[s] + pts[s + 1]) / 2 + Vector((x, 0, 0))
                bm = H["bm_cylinder"](0.15, 0.13, seg.length + 0.06, segs=6)
                quat = seg.to_track_quat('Z', 'Y')
                bmesh.ops.transform(bm, matrix=Matrix.Translation(mid) @
                                    quat.to_matrix().to_4x4(), verts=bm.verts)
                parts.append(H["obj_from_bmesh"](f"{name}_rib{i}{side}{s}", bm,
                                                 coll, wood))
    # surviving hull planks on the port side, following the rib curve
    for i in range(5):
        ang = (0.15 + i * 0.17) * math.pi / 2
        y = -(W / 2) * 0.92 * math.sin(ang)
        z = 0.45 + Hh * 0.92 * (1 - math.cos(ang))
        frac = 1.0 - i * 0.14
        bm = H["bm_box"](L * frac * rng.uniform(0.82, 0.95), 0.09, 0.38)
        # tilt plank to lie tangent to the hull curve
        tilt = Matrix.Rotation(-ang * 0.9, 4, 'X')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (rng.uniform(-0.5, 0.5), y, z)) @ tilt, verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_plank{i}", bm, coll,
                                         wood if i % 2 else dark))
    # broken mast leaning
    bm = H["bm_cylinder"](0.22, 0.14, 6.0, segs=8)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((1.5, 0.6, 2.6)) @
                        Matrix.Rotation(1.05, 4, 'Y') @
                        Matrix.Rotation(0.3, 4, 'X'), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_mast", bm, coll, dark))
    obj = H["join"](parts, name)
    # settle the wreck into the sand with a list to one side
    obj.rotation_euler = (0.14, 0.0, 0.0)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(rotation=True)
    return coll, obj


def build_standing_stones(name="standing_stones"):
    """Mysterious mossy monolith circle ~6u across with a fallen slab."""
    coll = H["asset_collection"](name)
    rng = random.Random(13)
    parts = []
    n = 5
    for k in range(n):
        a = 2 * math.pi * k / n
        h = rng.uniform(2.2, 3.4)
        bm = H["bm_box"](0.9, 0.55, h)
        lean = Matrix.Rotation(rng.uniform(-0.12, 0.12), 4, 'X') @ \
               Matrix.Rotation(rng.uniform(-0.12, 0.12), 4, 'Y')
        rot = Matrix.Rotation(a + rng.uniform(-0.2, 0.2), 4, 'Z')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (3.0 * math.cos(a), 3.0 * math.sin(a), h / 2)) @ rot @ lean, verts=bm.verts)
        o = H["obj_from_bmesh"](f"{name}_m{k}", bm, coll, H["mat"]("Rock_Dark"))
        H["displace_noise"](o, strength=0.09, scale=0.8, seed=k)
        H["apply_modifiers"](o)
        parts.append(o)
    # fallen slab
    bm = H["bm_box"](0.9, 0.55, 3.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.4, 0.2, 0.3)) @
                        Matrix.Rotation(math.pi / 2 * 0.94, 4, 'Y') @
                        Matrix.Rotation(0.5, 4, 'Z'), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_fallen", bm, coll, H["mat"]("Rock_Dark")))
    # gold glint in the center (treasure tease)
    bm = H["bm_icosphere"](0.18, 1)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.1)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_gold", bm, coll, H["mat"]("Gold")))
    obj = H["join"](parts, name)
    return coll, obj


def build_lantern_post(name="lantern_post"):
    """Dock/camp lantern on a post with emissive glass. ~2.6u tall."""
    coll = H["asset_collection"](name)
    parts = []
    bm = H["bm_cylinder"](0.09, 0.07, 2.3, segs=7)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 1.15)) @
                        Matrix.Rotation(0.05, 4, 'X'), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_post", bm, coll, H["mat"]("Wood_Dark")))
    # arm
    bm = H["bm_box"](0.7, 0.08, 0.08)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.3, 0, 2.25)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_arm", bm, coll, H["mat"]("Wood_Dark")))
    # lantern cage
    bm = H["bm_box"](0.22, 0.22, 0.3)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.62, 0, 2.0)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_cage", bm, coll, H["mat"]("Metal_Iron")))
    bm = H["bm_box"](0.15, 0.15, 0.2)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0.62, 0, 2.0)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_glass", bm, coll, H["mat"]("Lantern_Glass")))
    obj = H["join"](parts, name)
    return coll, obj


BUILDS = [build_watchtower(), build_shipwreck(), build_standing_stones(),
          build_lantern_post()]
x = 0
for c, o in BUILDS:
    o.location.y = 14
    o.location.x = x
    x += 14
    print(f"built {o.name}")
print("LANDMARKS DONE")
