# Pirate SKULL FORT — a Sea of Thieves-style stone fortress landmark: a rocky
# mount, an octagon-plan battlement wall (16 segs, jittered masonry banding)
# with an ARCHED gate, corner towers, a crenellated central keep crowned with a
# giant carved bone skull, and a sagging cloth banner (TeamTint).
# Front (gate + skull) faces Blender -Y  (= game +Z, the island's seaward look).
# Headless: Blender -b -P scripts/blender/build_fort.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get(
    "BR_RENDER_DIR",
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad/renders/u-buildings/round1")

EXTRA = {
    "Bone":        ((0.84, 0.80, 0.68, 1.0), 0.68, 0.0),   # skull / carved bone
    "Bone_Shadow": ((0.46, 0.43, 0.36, 1.0), 0.82, 0.0),
    "Stone_Fort":  ((0.46, 0.44, 0.41, 1.0), 0.93, 0.0),   # fort masonry
    "Stone_Dark":  ((0.29, 0.28, 0.27, 1.0), 0.9, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


def bm_bevel(bm, width=0.02):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=1, profile=0.72, affect='EDGES', clamp_overlap=True)
    return bm


def _place(bm, loc, rot_z=0.0):
    m = Matrix.Translation(Vector(loc))
    if rot_z:
        m = m @ Matrix.Rotation(rot_z, 4, 'Z')
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def merlon_ring(coll, name, ring_r, z, count, mw, mh, md, material, gap_dir=None,
                gap_half=0.0, rng=None):
    """Beveled crenellation blocks around a ring at height z; skip a gate arc."""
    objs = []
    for i in range(count):
        a = (i / count) * math.tau
        if gap_dir is not None:
            d = math.atan2(math.sin(a - gap_dir), math.cos(a - gap_dir))
            if abs(d) < gap_half:
                continue
        bm = bm_box(mw, md, mh)
        bm_bevel(bm, 0.04)
        zj = rng.uniform(-0.05, 0.05) if rng else 0.0
        _place(bm, (math.cos(a) * ring_r, math.sin(a) * ring_r, z + zj), a + math.pi / 2)
        objs.append(obj_from_bmesh(f"{name}_m{i}", bm, coll, material))
    return objs


def crenel_tower(coll, name, r, h, seed, merlon_n=10, cap_cone=False, rng=None):
    parts = []
    body = obj_from_bmesh(name + "_body", bm_cylinder(r, r * 0.9, h, segs=16), coll,
                          mat("Stone_Fort"), smooth=True)
    body.location.z = h * 0.5
    displace_noise(body, strength=r * 0.05, scale=r * 1.2, seed=seed)
    apply_modifiers(body)
    parts.append(body)
    # masonry band mid-height
    band = obj_from_bmesh(name + "_band", bm_cylinder(r * 1.0, r * 0.98, 0.22, segs=16),
                          coll, mat("Stone_Dark"), smooth=True)
    band.location.z = h * 0.55
    apply_modifiers(band)
    parts.append(band)
    rim = obj_from_bmesh(name + "_rim", bm_cylinder(r * 1.08, r * 1.02, 0.34, segs=16),
                         coll, mat("Stone_Dark"), smooth=True)
    rim.location.z = h + 0.05
    apply_modifiers(rim)
    parts.append(rim)
    if cap_cone:
        cone = obj_from_bmesh(name + "_cap", bm_cylinder(r * 1.06, 0.05, r * 1.5, segs=16),
                              coll, mat("Wood_Dark"), smooth=True)
        cone.location.z = h + r * 0.75
        apply_modifiers(cone)
        parts.append(cone)
    else:
        parts += merlon_ring(coll, name, r * 0.98, h + 0.4, merlon_n, r * 0.34, 0.72,
                             0.32, mat("Stone_Fort"), rng=rng)
        floor = obj_from_bmesh(name + "_floor", bm_cylinder(r * 0.9, r * 0.9, 0.16, segs=16),
                               coll, mat("Wood_Bleached"))
        floor.location.z = h + 0.1
        apply_modifiers(floor)
        parts.append(floor)
    return parts


def build_skull(coll, name, s, face_y):
    """Stylized bone skull facing -Y, centered at (0, face_y, 0), size ~s."""
    parts = []
    # smooth high-detail cranium with fine surface chatter
    cranium = obj_from_bmesh(name + "_cranium", bm_icosphere(s, 5), coll, mat("Bone"),
                             smooth=True)
    cranium.scale = (1.15, 1.0, 1.05)
    cranium.location = Vector((0, face_y, 0))
    displace_noise(cranium, strength=0.045, scale=0.55, seed=31)
    apply_modifiers(cranium)
    parts.append(cranium)
    # brow ridge (beveled, softened)
    bm = bm_box(s * 1.7, s * 0.4, s * 0.34)
    bm_bevel(bm, s * 0.07)
    brow = obj_from_bmesh(name + "_brow", bm, coll, mat("Bone_Shadow"), smooth=True)
    brow.location = Vector((0, face_y - s * 0.85, s * 0.34))
    parts.append(brow)
    # eye sockets — deep dark recesses
    for sx in (-1, 1):
        eye = obj_from_bmesh(f"{name}_eye{sx}", bm_icosphere(s * 0.36, 2), coll,
                             mat("Char_Black"), smooth=True)
        eye.scale = (1.0, 0.7, 0.92)
        eye.location = Vector((sx * s * 0.46, face_y - s * 0.78, s * 0.06))
        apply_modifiers(eye)
        parts.append(eye)
        # bone eye rims
        rim = obj_from_bmesh(f"{name}_rim{sx}", bm_cylinder(s * 0.42, s * 0.40, s * 0.1, segs=14),
                             coll, mat("Bone_Shadow"), smooth=True)
        rim.rotation_euler[0] = math.radians(90)
        rim.location = Vector((sx * s * 0.46, face_y - s * 0.86, s * 0.06))
        apply_modifiers(rim)
        parts.append(rim)
    # nasal cavity
    bm = bm_box(s * 0.3, s * 0.4, s * 0.44)
    bm_bevel(bm, s * 0.05)
    nose = obj_from_bmesh(name + "_nose", bm, coll, mat("Char_Black"), smooth=True)
    nose.location = Vector((0, face_y - s * 0.86, -s * 0.34))
    nose.rotation_euler[0] = math.radians(28)
    parts.append(nose)
    # cheekbones
    for sx in (-1, 1):
        bm = bm_box(s * 0.5, s * 0.45, s * 0.34)
        bm_bevel(bm, s * 0.08)
        ch = obj_from_bmesh(f"{name}_cheek{sx}", bm, coll, mat("Bone"), smooth=True)
        ch.location = Vector((sx * s * 0.62, face_y - s * 0.7, -s * 0.36))
        parts.append(ch)
    # jaw
    bm = bm_box(s * 1.5, s * 0.7, s * 0.42)
    bm_bevel(bm, s * 0.09)
    jaw = obj_from_bmesh(name + "_jaw", bm, coll, mat("Bone"), smooth=True)
    jaw.location = Vector((0, face_y - s * 0.6, -s * 0.9))
    parts.append(jaw)
    # teeth row (jittered)
    trng = random.Random(5)
    for i in range(7):
        bm = bm_box(s * 0.14, s * 0.16, s * 0.28 * trng.uniform(0.85, 1.1))
        bm_bevel(bm, s * 0.02)
        t = obj_from_bmesh(f"{name}_tooth{i}", bm, coll, mat("Bone"), smooth=True)
        t.location = Vector(((i - 3) * s * 0.2, face_y - s * 0.9, -s * 0.72))
        t.rotation_euler[1] = trng.uniform(-0.08, 0.08)
        parts.append(t)
    return parts


def build_fort(name="fort"):
    clear_default_scene()
    coll = asset_collection(name)
    rng = random.Random(7)
    parts = []
    front = -math.pi / 2  # gate faces -Y

    # ── rocky mount the fort is built on (faceted, two displace octaves) ──
    mount = obj_from_bmesh(name + "_mount", bm_icosphere(8.2, 4), coll, mat("Rock_Dark"))
    mount.scale = (1.0, 1.0, 0.42)
    displace_noise(mount, strength=1.6, scale=6.0, seed=3)
    displace_noise(mount, strength=0.22, scale=1.1, seed=8)
    decimate(mount, 0.5)
    mount.location.z = -1.6
    apply_modifiers(mount)
    # bake the mount transform so the join target has identity transform
    bpy.ops.object.select_all(action='DESELECT')
    mount.select_set(True)
    bpy.context.view_layer.objects.active = mount
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    parts.append(mount)

    # ── battlement wall: 16 segs x 8 rings, per-vertex stone jitter +
    #    alternating-ring masonry banding, gate gap at the front ──
    segs, rings = 16, 8
    r_base, r_top = 6.6, 6.3
    wall_h = 3.4
    gap_half = 0.42  # gate opening arc (rad)
    jr = random.Random(13)
    bm = bmesh.new()
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        r = r_base + (r_top - r_base) * t
        r += 0.05 if i % 2 == 0 else -0.03           # masonry banding
        ring = []
        for j in range(segs):
            a = math.tau * j / segs + math.pi / segs  # flat faces front
            dr = jr.uniform(-0.07, 0.07)              # per-vertex stone jitter
            dz = jr.uniform(-0.045, 0.045) if 0 < i < rings else 0.0
            z = t * wall_h + dz
            ring.append(bm.verts.new(((r + dr) * math.cos(a), (r + dr) * math.sin(a), z)))
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
    displace_noise(wall, strength=0.10, scale=1.1, seed=11)
    apply_modifiers(wall)
    parts.append(wall)
    # beveled merlons along the wall walk (skip the gate)
    parts += merlon_ring(coll, name + "_wm", r_top, wall_h + 0.25, 18, 0.68, 0.7, 0.34,
                         mat("Stone_Fort"), gap_dir=front, gap_half=gap_half + 0.12, rng=rng)
    # wall-walk coping ring under the merlons
    cop = obj_from_bmesh(name + "_cope", bm_cylinder(r_top + 0.42, r_top + 0.38, 0.22, segs=16, cap=False),
                         coll, mat("Stone_Dark"))
    cop.location.z = wall_h - 0.05
    apply_modifiers(cop)
    parts.append(cop)

    # ── stone-block greebles along the wall base (fallen / footing masonry) ──
    grng = random.Random(29)
    for i in range(22):
        a = grng.uniform(0, math.tau)
        d = math.atan2(math.sin(a - front), math.cos(a - front))
        if abs(d) < gap_half + 0.18:
            continue                                  # keep the gate approach clear
        rr = r_base + grng.uniform(0.15, 0.75)
        s = grng.uniform(0.35, 0.85)
        bm = bm_box(s, s * grng.uniform(0.6, 0.9), s * grng.uniform(0.5, 0.8))
        bm_bevel(bm, s * 0.07)
        _place(bm, (math.cos(a) * rr, math.sin(a) * rr, 0.9 + s * 0.2), grng.uniform(0, math.tau))
        mname = "Stone_Dark" if i % 3 == 0 else "Stone_Fort"
        parts.append(obj_from_bmesh(f"{name}_gr{i}", bm, coll, mat(mname)))

    # ── ARCHED gate: jamb stacks + voussoir arch + dark arched recess ──
    gy = -r_base + 0.25
    arch_r = 1.45
    arch_z = 2.3
    # jamb block stacks narrowing the opening
    for sx in (-1, 1):
        for k in range(4):
            bw = 1.35 + jr.uniform(-0.08, 0.08)
            bm = bm_box(bw, 1.15, 0.85)
            bm_bevel(bm, 0.05)
            _place(bm, (sx * (arch_r + bw * 0.5 - 0.1 + jr.uniform(-0.04, 0.04)),
                        gy + jr.uniform(-0.05, 0.05), 0.45 + k * 0.85),
                   jr.uniform(-0.04, 0.04))
            mname = "Stone_Dark" if k % 2 else "Stone_Fort"
            parts.append(obj_from_bmesh(f"{name}_jamb{sx}_{k}", bm, coll, mat(mname)))
    # voussoir arch over the opening
    nv = 9
    for i in range(nv):
        aa = math.pi * (i + 0.5) / nv
        vx, vz = math.cos(aa) * (arch_r + 0.28), arch_z + math.sin(aa) * (arch_r + 0.28)
        bm = bm_box(0.64, 1.05, 0.66)
        bm_bevel(bm, 0.045)
        m = (Matrix.Translation((vx, gy, vz)) @ Matrix.Rotation(aa - math.pi / 2, 4, 'Y'))
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_vous{i}", bm, coll, mat("Stone_Dark")))
    # keystone
    bm = bm_box(0.62, 1.1, 0.8)
    bm_bevel(bm, 0.05)
    _place(bm, (0, gy, arch_z + arch_r + 0.34))
    parts.append(obj_from_bmesh(name + "_keystone", bm, coll, mat("Stone_Fort")))
    # dark arched recess (opening reads deep, not a black box)
    bm = bm_box(arch_r * 2 - 0.1, 0.35, arch_z)
    _place(bm, (0, gy + 0.75, arch_z * 0.5))
    parts.append(obj_from_bmesh(name + "_gatedark", bm, coll, mat("Char_Black")))
    hc = bm_cylinder(arch_r - 0.05, arch_r - 0.05, 0.35, segs=14)
    bmesh.ops.transform(hc, matrix=Matrix.Rotation(math.pi / 2, 4, 'X'), verts=hc.verts)
    _place(hc, (0, gy + 0.75, arch_z))
    parts.append(obj_from_bmesh(name + "_gatedarktop", hc, coll, mat("Char_Black"), smooth=True))
    # threshold step
    bm = bm_box(arch_r * 2 + 0.6, 1.6, 0.22)
    bm_bevel(bm, 0.04)
    _place(bm, (0, gy - 0.4, 0.11))
    parts.append(obj_from_bmesh(name + "_step", bm, coll, mat("Stone_Dark")))

    # ── corner towers (two flanking the gate, capped; two rear, crenellated) ──
    for k, ang in enumerate([front - 0.72, front + 0.72, front + math.pi - 0.5, front + math.pi + 0.5]):
        tx, tz = math.cos(ang) * (r_base + 0.3), math.sin(ang) * (r_base + 0.3)
        tparts = crenel_tower(coll, f"{name}_t{k}", 1.5, 5.2 if k < 2 else 4.4,
                              seed=20 + k, cap_cone=(k < 2), rng=rng)
        for o in tparts:
            o.location.x += tx
            o.location.y += tz
        parts += tparts

    # ── central keep + giant skull + banner ──
    parts += crenel_tower(coll, name + "_keep", 2.8, 8.4, seed=40, merlon_n=12, rng=rng)
    skull_parts = build_skull(coll, name + "_skull", 1.7, -2.5)
    for o in skull_parts:
        o.location.z += 6.4
    parts += skull_parts
    # banner pole + sagging cloth banner (TeamTint — name is a client API)
    pole = bm_cylinder(0.12, 0.09, 4.2, segs=8)
    _place(pole, (0, 0, 8.4 + 2.1))
    parts.append(obj_from_bmesh(name + "_pole", pole, coll, mat("Wood_Dark"), smooth=True))
    ftop = bm_cylinder(0.16, 0.02, 0.3, segs=8)
    _place(ftop, (0, 0, 8.4 + 4.3))
    parts.append(obj_from_bmesh(name + "_poletop", ftop, coll, mat("Gold"), smooth=True))
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=16, y_segments=10, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((1.1, 0.7, 1.0)), verts=bm.verts)  # 2.2 x 1.4 cloth
    for v in bm.verts:
        ty = (v.co.x / 1.1 + 1.0) * 0.5     # 0 at pole edge, 1 at fly edge
        v.co.y -= 0.20 * ty * ty                          # fly-end droop
        v.co.z = 0.14 * math.sin(ty * math.pi * 2.2) * ty  # flutter (becomes world X)
    # permutation: local x -> world +Y (out from pole), local y -> world Z (height),
    # local z (flutter) -> world X
    m = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 1.16, 8.4 + 3.35)) @ m, verts=bm.verts)
    flag = obj_from_bmesh(name + "_flag", bm, coll, mat("TeamTint"), smooth=True)
    fs = flag.modifiers.new("Solid", 'SOLIDIFY')
    fs.thickness = 0.05
    apply_modifiers(flag)
    parts.append(flag)

    # ── braziers flanking the gate: iron bowl, legs, coal + ember glow ──
    for sx in (-1, 1):
        bx, by = sx * 3.8, gy - 0.5
        bowl = bm_cylinder(0.55, 0.34, 0.55, segs=10, cap=True)
        _place(bowl, (bx, by, 1.2))
        parts.append(obj_from_bmesh(f"{name}_brazier{sx}", bowl, coll, mat("Metal_Iron"), smooth=True))
        for li in range(3):
            la = li * math.tau / 3 + 0.4
            leg = bm_cylinder(0.06, 0.045, 1.1, segs=6)
            _place(leg, (bx + math.cos(la) * 0.3, by + math.sin(la) * 0.3, 0.55))
            parts.append(obj_from_bmesh(f"{name}_bleg{sx}{li}", leg, coll, mat("Metal_Iron"), smooth=True))
        coals = bm_icosphere(0.40, 2)
        bmesh.ops.scale(coals, vec=Vector((1.1, 1.1, 0.55)), verts=coals.verts)
        _place(coals, (bx, by, 1.5))
        ember = obj_from_bmesh(f"{name}_fire{sx}", coals, coll, mat("Lantern_Glass"), smooth=True)
        displace_noise(ember, strength=0.07, scale=0.25, seed=50 + sx)
        apply_modifiers(ember)
        parts.append(ember)

    join(parts, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR)
    print(f"built {name}")


build_fort()
print("FORT DONE")
