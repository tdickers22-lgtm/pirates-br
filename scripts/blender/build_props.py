# Builds gameplay props: barrel, powder keg, treasure chest (closed/open),
# crate, campfire, dock modules (mid + end).
# Origins: all sit on Z=0.
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

H = HELPERS


def build_barrel(name, height=1.0, radius=0.38, wood="Wood_Mid",
                 band="Metal_Band", bands=(0.22, 0.78)):
    coll = H["asset_collection"](name)
    segs = 12
    bm = bmesh.new()
    rings = 6
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        bulge = 1.0 + 0.16 * math.sin(t * math.pi)
        r = radius * bulge
        ring = [bm.verts.new((r * math.cos(2 * math.pi * j / segs),
                              r * math.sin(2 * math.pi * j / segs),
                              height * t)) for j in range(segs)]
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    bm.faces.new(tuple(reversed(ring_verts[0])))
    bm.faces.new(tuple(ring_verts[-1]))
    body = H["obj_from_bmesh"](f"{name}_body", bm, coll, H["mat"](wood))
    parts = [body]
    for bi, bt in enumerate(bands):
        bulge = 1.0 + 0.16 * math.sin(bt * math.pi)
        bm = H["bm_cylinder"](radius * bulge + 0.025, radius * bulge + 0.025,
                              0.07, segs=segs)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, height * bt)),
                            verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_band{bi}", bm, coll,
                                         H["mat"](band)))
    obj = H["join"](parts, name)
    return coll, obj


def build_keg(name="keg"):
    coll, obj = build_barrel(name, height=0.8, radius=0.34,
                             wood="Wood_Dark", band="Keg_Red",
                             bands=(0.18, 0.5, 0.82))
    # fuse coil on top
    bm = bmesh.new()
    prev = None
    rope_pts = []
    for i in range(20):
        t = i / 19
        a = t * math.pi * 3.2
        r = 0.13 * (1 - t * 0.5)
        rope_pts.append(Vector((r * math.cos(a), r * math.sin(a),
                                0.82 + t * 0.12)))
    for k in range(len(rope_pts) - 1):
        seg = rope_pts[k + 1] - rope_pts[k]
        c = H["bm_cylinder"](0.022, 0.022, seg.length + 0.01, segs=5)
        quat = seg.to_track_quat('Z', 'Y')
        bmesh.ops.transform(c, matrix=Matrix.Translation(
            (rope_pts[k] + rope_pts[k + 1]) / 2) @ quat.to_matrix().to_4x4(),
            verts=c.verts)
        me = bpy.data.meshes.new("fuse_seg")
        c.to_mesh(me)
        c.free()
        o = H["new_obj"]("fuse_seg", me, coll)
        o.data.materials.append(H["mat"]("Rope"))
        prev = o
    objs = [o for o in coll.objects]
    obj = H["join"](objs, name)
    return coll, obj


def build_chest(name, open_lid=False):
    coll = H["asset_collection"](name)
    W, D, Hh = 0.95, 0.62, 0.55  # base box
    parts = []
    bm = H["bm_box"](W, D, Hh)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, Hh / 2)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_base", bm, coll, H["mat"]("Wood_Dark")))
    # arched lid: half-cylinder along X
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=D / 2,
                          radius2=D / 2, depth=W)
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'),
                     verts=bm.verts)
    # slice off bottom half by clamping z
    for v in bm.verts:
        if v.co.z < 0:
            v.co.z = 0
    lid_rot = Matrix.Rotation(math.radians(-52), 4, 'X') if open_lid else Matrix.Identity(4)
    pivot = Vector((0, -D / 2, Hh))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(pivot) @ lid_rot @
                        Matrix.Translation(Vector((0, D / 2, 0))), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_lid", bm, coll, H["mat"]("Wood_Dark")))
    # gold trim bands
    for xo in (-W * 0.32, W * 0.32):
        bm = H["bm_box"](0.07, D + 0.03, Hh + 0.02)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((xo, 0, Hh / 2)), verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_trim", bm, coll, H["mat"]("Gold")))
    # lock plate
    bm = H["bm_box"](0.16, 0.05, 0.2)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, D / 2 + 0.02, Hh * 0.82)),
                        verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_lock", bm, coll, H["mat"]("Gold")))
    if open_lid:
        # coin pile: squashed noisy sphere
        bm = H["bm_icosphere"](0.34, 2)
        bmesh.ops.scale(bm, vec=Vector((1.25, 0.8, 0.5)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, Hh + 0.05)), verts=bm.verts)
        o = H["obj_from_bmesh"](f"{name}_gold", bm, coll, H["mat"]("Gold"))
        H["displace_noise"](o, strength=0.08, scale=0.2, seed=9)
        H["apply_modifiers"](o)
        parts.append(o)
    obj = H["join"](parts, name)
    return coll, obj


def build_crate(name="crate"):
    coll = H["asset_collection"](name)
    S = 0.72
    parts = []
    bm = H["bm_box"](S, S, S)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, S / 2)), verts=bm.verts)
    parts.append(H["obj_from_bmesh"](f"{name}_body", bm, coll, H["mat"]("Wood_Mid")))
    # corner battens
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = H["bm_box"](0.09, 0.09, S + 0.02)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (sx * S / 2, sy * S / 2, S / 2)), verts=bm.verts)
            parts.append(H["obj_from_bmesh"](f"{name}_bat", bm, coll,
                                             H["mat"]("Wood_Dark")))
    obj = H["join"](parts, name)
    return coll, obj


def build_campfire(name="campfire"):
    coll = H["asset_collection"](name)
    rng = random.Random(7)
    parts = []
    # stone ring
    for k in range(7):
        a = 2 * math.pi * k / 7
        bm = H["bm_icosphere"](0.16, 1)
        bmesh.ops.scale(bm, vec=Vector((1.2, 1.0, 0.75)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.55 * math.cos(a), 0.55 * math.sin(a), 0.08)), verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_stone{k}", bm, coll,
                                         H["mat"]("Rock_Grey")))
    # charred logs leaning to center
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        bm = H["bm_cylinder"](0.06, 0.05, 0.62, segs=6)
        tilt = Vector((math.cos(a), math.sin(a), 0))
        quat = (Vector((0, 0, 1)) * 0.8 - tilt).to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.18 * math.cos(a), 0.18 * math.sin(a), 0.22)) @
            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_log{k}", bm, coll,
                                         H["mat"]("Char_Black")))
    obj = H["join"](parts, name)
    return coll, obj


def build_dock(name, length=6.0, end_cap=False):
    """Dock module, WIDTH 3 along Y... walkway runs along X. Deck at z=1.1."""
    coll = H["asset_collection"](name)
    rng = random.Random(len(name))
    parts = []
    deck_z = 1.1
    width = 3.0
    plank_w = 0.55
    n = int(length / plank_w)
    for i in range(n):
        x = -length / 2 + plank_w * (i + 0.5)
        bm = H["bm_box"](plank_w * 0.92, width * rng.uniform(0.96, 1.0), 0.1)
        rot = Matrix.Rotation(rng.uniform(-0.015, 0.015), 4, 'Z')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (x, 0, deck_z + rng.uniform(-0.012, 0.012))) @ rot, verts=bm.verts)
        m = "Wood_Bleached" if i % 3 else "Wood_Light"
        parts.append(H["obj_from_bmesh"](f"{name}_plank{i}", bm, coll, H["mat"](m)))
    # posts: pairs every 2m, poking above deck
    xs = [-length / 2 + 0.4, 0, length / 2 - 0.4]
    for xi, x in enumerate(xs):
        for sy in (-1, 1):
            bm = H["bm_cylinder"](0.14, 0.12, deck_z + 0.75, segs=7)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (x, sy * (width / 2 - 0.1), (deck_z + 0.75) / 2)), verts=bm.verts)
            parts.append(H["obj_from_bmesh"](f"{name}_post{xi}{sy}", bm, coll,
                                             H["mat"]("Wood_Dark")))
            # mooring rope wrap
            bm = H["bm_cylinder"](0.17, 0.17, 0.1, segs=7)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (x, sy * (width / 2 - 0.1), deck_z + 0.45)), verts=bm.verts)
            parts.append(H["obj_from_bmesh"](f"{name}_rope{xi}{sy}", bm, coll,
                                             H["mat"]("Rope")))
    # stringers under planks
    for sy in (-1, 1):
        bm = H["bm_box"](length, 0.18, 0.16)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0, sy * (width / 2 - 0.35), deck_z - 0.12)), verts=bm.verts)
        parts.append(H["obj_from_bmesh"](f"{name}_str{sy}", bm, coll,
                                         H["mat"]("Wood_Dark")))
    obj = H["join"](parts, name)
    return coll, obj


BUILDS = []
c, o = build_barrel("barrel"); BUILDS.append((c, o))
c, o = build_keg("keg"); BUILDS.append((c, o))
c, o = build_chest("chest_closed", False); BUILDS.append((c, o))
c, o = build_chest("chest_open", True); BUILDS.append((c, o))
c, o = build_crate("crate"); BUILDS.append((c, o))
c, o = build_campfire("campfire"); BUILDS.append((c, o))
c, o = build_dock("dock_mid", 6.0); BUILDS.append((c, o))
c, o = build_dock("dock_end", 4.0, True); BUILDS.append((c, o))

x = -14
for c, o in BUILDS:
    o.location.y = -8
    o.location.x = x
    x += 4
    print(f"built {o.name}")

print("PROPS DONE")
