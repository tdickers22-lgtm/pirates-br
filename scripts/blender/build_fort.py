# Pirate SKULL FORT — a Sea of Thieves-style stone fortress landmark: a rocky
# mount, an octagonal battlement wall with a gate, corner towers, a crenellated
# central keep crowned with a giant carved bone skull, and a red pirate banner.
# Front (gate + skull) faces Blender -Y  (= game +Z, the island's seaward look).
# Headless: Blender -b -P scripts/blender/build_fort.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())

EXTRA = {
    "Bone":        ((0.84, 0.80, 0.68, 1.0), 0.68, 0.0),   # skull / carved bone
    "Bone_Shadow": ((0.46, 0.43, 0.36, 1.0), 0.82, 0.0),
    "Stone_Fort":  ((0.46, 0.44, 0.41, 1.0), 0.93, 0.0),   # fort masonry
    "Stone_Dark":  ((0.29, 0.28, 0.27, 1.0), 0.9, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


def _place(bm, loc, rot_z=0.0):
    m = Matrix.Translation(Vector(loc))
    if rot_z:
        m = m @ Matrix.Rotation(rot_z, 4, 'Z')
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def merlon_ring(coll, name, ring_r, z, count, mw, mh, md, material, gap_dir=None, gap_half=0.0):
    """Crenellation blocks around a ring at height z; skip a gate arc if given."""
    objs = []
    for i in range(count):
        a = (i / count) * math.tau
        if gap_dir is not None:
            d = math.atan2(math.sin(a - gap_dir), math.cos(a - gap_dir))
            if abs(d) < gap_half:
                continue
        bm = bm_box(mw, md, mh)
        _place(bm, (math.cos(a) * ring_r, math.sin(a) * ring_r, z), a + math.pi / 2)
        objs.append(obj_from_bmesh(f"{name}_m{i}", bm, coll, material))
    return objs


def crenel_tower(coll, name, r, h, seed, merlon_n=10, cap_cone=False):
    parts = []
    body = obj_from_bmesh(name + "_body", bm_cylinder(r, r * 0.9, h, segs=12), coll, mat("Stone_Fort"))
    body.location.z = h * 0.5
    displace_noise(body, strength=r * 0.05, scale=r * 1.2, seed=seed)
    apply_modifiers(body)
    parts.append(body)
    rim = obj_from_bmesh(name + "_rim", bm_cylinder(r * 1.08, r * 1.02, 0.34, segs=12), coll, mat("Stone_Dark"))
    rim.location.z = h + 0.05
    apply_modifiers(rim)
    parts.append(rim)
    if cap_cone:
        cone = obj_from_bmesh(name + "_cap", bm_cylinder(r * 1.06, 0.05, r * 1.5, segs=12), coll, mat("Wood_Dark"))
        cone.location.z = h + r * 0.75
        apply_modifiers(cone)
        parts.append(cone)
    else:
        parts += merlon_ring(coll, name, r * 0.98, h + 0.4, merlon_n, r * 0.34, 0.72, 0.32, mat("Stone_Fort"))
        floor = obj_from_bmesh(name + "_floor", bm_cylinder(r * 0.9, r * 0.9, 0.16, segs=12), coll, mat("Wood_Bleached"))
        floor.location.z = h + 0.1
        apply_modifiers(floor)
        parts.append(floor)
    return parts


def build_skull(coll, name, s, face_y):
    """Stylized bone skull facing -Y, centered at (0, face_y, 0), size ~s."""
    parts = []
    cranium = obj_from_bmesh(name + "_cranium", bm_icosphere(s, 3), coll, mat("Bone"))
    cranium.scale = (1.15, 1.0, 1.05)
    cranium.location = Vector((0, face_y, 0))
    apply_modifiers(cranium)
    parts.append(cranium)
    # brow ridge
    brow = obj_from_bmesh(name + "_brow", bm_box(s * 1.7, s * 0.4, s * 0.34), coll, mat("Bone_Shadow"))
    brow.location = Vector((0, face_y - s * 0.85, s * 0.34))
    parts.append(brow)
    # eye sockets — deep dark recesses
    for sx in (-1, 1):
        eye = obj_from_bmesh(f"{name}_eye{sx}", bm_icosphere(s * 0.36, 2), coll, mat("Char_Black"))
        eye.scale = (1.0, 0.7, 0.92)
        eye.location = Vector((sx * s * 0.46, face_y - s * 0.78, s * 0.06))
        apply_modifiers(eye)
        parts.append(eye)
    # nasal cavity
    nose = obj_from_bmesh(name + "_nose", bm_box(s * 0.3, s * 0.4, s * 0.44), coll, mat("Char_Black"))
    nose.location = Vector((0, face_y - s * 0.86, -s * 0.34))
    nose.rotation_euler[0] = math.radians(28)
    parts.append(nose)
    # cheekbones
    for sx in (-1, 1):
        ch = obj_from_bmesh(f"{name}_cheek{sx}", bm_box(s * 0.5, s * 0.45, s * 0.34), coll, mat("Bone"))
        ch.location = Vector((sx * s * 0.62, face_y - s * 0.7, -s * 0.36))
        parts.append(ch)
    # jaw
    jaw = obj_from_bmesh(name + "_jaw", bm_box(s * 1.5, s * 0.7, s * 0.42), coll, mat("Bone"))
    jaw.location = Vector((0, face_y - s * 0.6, -s * 0.9))
    parts.append(jaw)
    # teeth row
    for i in range(7):
        t = obj_from_bmesh(f"{name}_tooth{i}", bm_box(s * 0.14, s * 0.16, s * 0.28), coll, mat("Bone"))
        t.location = Vector(((i - 3) * s * 0.2, face_y - s * 0.9, -s * 0.72))
        parts.append(t)
    return parts


def build_fort(name="fort"):
    clear_default_scene()
    coll = asset_collection(name)
    rng = random.Random(7)
    parts = []
    front = -math.pi / 2  # gate faces -Y

    # ── rocky mount the fort is built on ──
    mount = obj_from_bmesh(name + "_mount", bm_icosphere(8.2, 3), coll, mat("Rock_Dark"))
    mount.scale = (1.0, 1.0, 0.42)
    displace_noise(mount, strength=1.6, scale=6.0, seed=3)
    decimate(mount, 0.5)
    mount.location.z = -1.6
    apply_modifiers(mount)
    parts.append(mount)

    # ── octagonal battlement wall (ring shell with crenellated top + gate gap) ──
    segs, rings = 8, 4
    r_base, r_top = 6.6, 6.3
    wall_h = 3.4
    gap_half = 0.42  # gate opening arc (rad)
    bm = bmesh.new()
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        r = r_base + (r_top - r_base) * t
        ring = []
        for j in range(segs):
            a = math.tau * j / segs + math.pi / segs  # flat faces front
            crenel = (0.5 if (i == rings and j % 2 == 0) else 0.0)
            z = t * wall_h + crenel
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        ring_verts.append(ring)
    for i in range(rings):
        a, b = ring_verts[i], ring_verts[i + 1]
        for j in range(segs):
            mid = math.tau * (j + 0.5) / segs + math.pi / segs
            d = math.atan2(math.sin(mid - front), math.cos(mid - front))
            if abs(d) < gap_half:  # leave the gate open
                continue
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    wall = obj_from_bmesh(name + "_wall", bm, coll, mat("Stone_Fort"))
    solid = wall.modifiers.new("Solidify", 'SOLIDIFY')
    solid.thickness = 0.7
    displace_noise(wall, strength=0.18, scale=1.4, seed=11)
    apply_modifiers(wall)
    parts.append(wall)
    # merlons along the wall walk (skip the gate)
    parts += merlon_ring(coll, name + "_wm", r_top, wall_h + 0.25, 16, 0.7, 0.7, 0.34,
                         mat("Stone_Fort"), gap_dir=front, gap_half=gap_half + 0.12)

    # ── gate: dark arch recess + heavy stone lintel ──
    gate = bm_box(2.4, 1.2, 3.0)
    _place(gate, (0, -r_base + 0.2, 1.5))
    parts.append(obj_from_bmesh(name + "_gate", gate, coll, mat("Char_Black")))
    lintel = bm_box(3.1, 1.0, 0.7)
    _place(lintel, (0, -r_base + 0.35, 3.2))
    parts.append(obj_from_bmesh(name + "_lintel", lintel, coll, mat("Stone_Dark")))

    # ── corner towers (two flanking the gate, capped; two rear, crenellated) ──
    for k, ang in enumerate([front - 0.72, front + 0.72, front + math.pi - 0.5, front + math.pi + 0.5]):
        tx, tz = math.cos(ang) * (r_base + 0.3), math.sin(ang) * (r_base + 0.3)
        tparts = crenel_tower(coll, f"{name}_t{k}", 1.5, 5.2 if k < 2 else 4.4,
                              seed=20 + k, cap_cone=(k < 2))
        for o in tparts:
            o.location.x += tx
            o.location.y += tz
        parts += tparts

    # ── central keep + giant skull + banner ──
    keep = crenel_tower(coll, name + "_keep", 2.8, 8.4, seed=40, merlon_n=12)
    parts += keep
    parts += build_skull(coll, name + "_skull", 1.7, -2.5)
    # move skull up onto the keep face (build_skull centers at z=0, y=face_y)
    for o in parts[-14:]:
        o.location.z += 6.4
    # banner pole + red flag atop the keep
    pole = bm_cylinder(0.12, 0.09, 4.2, segs=6)
    _place(pole, (0, 0, 8.4 + 2.1))
    parts.append(obj_from_bmesh(name + "_pole", pole, coll, mat("Wood_Dark")))
    flag = bm_box(0.08, 2.0, 1.3)
    _place(flag, (0, 1.0, 8.4 + 3.0))
    parts.append(obj_from_bmesh(name + "_flag", flag, coll, mat("TeamTint")))

    # ── brazier glow flanking the gate ──
    for sx in (-1, 1):
        bowl = bm_cylinder(0.4, 0.28, 0.5, segs=8)
        _place(bowl, (sx * 2.0, -r_base + 0.9, 3.2))
        parts.append(obj_from_bmesh(f"{name}_brazier{sx}", bowl, coll, mat("Metal_Iron")))
        fire = bm_icosphere(0.34, 1)
        _place(fire, (sx * 2.0, -r_base + 0.9, 3.55))
        parts.append(obj_from_bmesh(f"{name}_fire{sx}", fire, coll, mat("Lantern_Glass")))

    join(parts, name)
    export_collection(coll, f"{name}.glb")
    print(f"built {name}")


build_fort()
print("FORT DONE")
