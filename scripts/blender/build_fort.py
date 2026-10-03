# COASTAL BATTERY FORT (b5.1b, assets-12; was a toy castle with cone-roof turrets and a giant
# skull): a rocky mount, a battered 16-sided curtain wall with a cordon, a thick embrasured
# artillery parapet and a timber gun platform on posts with guns run out seaward, an ARCHED gate
# with open iron-bound leaves, four squat gun bastions on the old tower centres (the gate pair
# carry timber hoardings), and a central cavalier (raised gun platform, three guns, flagstaff).
# Footprint, gate arc, bastion and cavalier centres are unchanged so the props.ts colliders hold.
# Trim-sheet materials (stone / wood_iron / shingle / canvas) + authored LOD proxies.
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
exec(open(os.path.join(HERE, "_detail.py")).read())
import sys
sys.path.insert(0, HERE)
import _trim as TR
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)
exec(open(os.path.join(HERE, "_trimkit.py")).read())
# fort masonry + flag + finial onto the trim strips (b5.1b)
TRIM_OF.update({"Stone_Fort": ("stone", "ashlar"), "Stone_Dark": ("stone", "ashlar_small"),
                "Gold": ("wood_iron", "brass")})

RENDER_DIR = os.environ.get(
    "BR_RENDER_DIR",
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad/renders/u-buildings/round1")

EXTRA = {
    "Bone":        ((0.84, 0.80, 0.68, 1.0), 0.68, 0.0),   # skull / carved bone
    "Bone_Shadow": ((0.46, 0.43, 0.36, 1.0), 0.82, 0.0),
    "Stone_Fort":  ((0.46, 0.44, 0.41, 1.0), 0.93, 0.0),   # fort masonry
    "Stone_Dark":  ((0.29, 0.28, 0.27, 1.0), 0.9, 0.0),
    "Shingle":     ((0.34, 0.24, 0.16, 1.0), 0.92, 0.0),   # hoarding roofs (shingle strip)
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


def parapet_ring(coll, name, ring_r, z, count, emb_w, ph, pd, material, gap_dir=None, gap_half=0.0,
                 rng=None, phase=0.0):
    """Artillery parapet: thick blocks with a sloped superior face (outer edge lower, the
    'superior slope' a gunner fires over) separated by embrasures emb_w wide. Skips a gate arc."""
    objs, embrasures = [], []
    chord = math.tau * ring_r / count
    bw = max(chord - emb_w, 0.4)
    for i in range(count):
        a = (i + phase) / count * math.tau
        if gap_dir is not None:
            d = math.atan2(math.sin(a - gap_dir), math.cos(a - gap_dir))
            if abs(d) < gap_half:
                continue
        bm = bm_box(bw, pd, ph)
        for v in bm.verts:               # local -y = outward after _place(rot a + pi/2)
            if v.co.z > 0 and v.co.y < 0:
                v.co.z -= ph * 0.22
        bm_bevel(bm, 0.035)
        zj = rng.uniform(-0.03, 0.03) if rng else 0.0
        _place(bm, (math.cos(a) * ring_r, math.sin(a) * ring_r, z + ph * 0.5 + zj), a + math.pi / 2)
        objs.append(obj_from_bmesh(f"{name}_p{i}", bm, coll, material))
        embrasures.append(a + 0.5 * math.tau / count)
    return objs, embrasures


def cordon(coll, name, r, z, segs=32):
    """Rounded string course (the cordon) that marks the rampart line on a battered wall."""
    bm = bm_cylinder(r + 0.12, r + 0.12, 0.2, segs=segs, cap=False)
    _place(bm, (0, 0, z))
    return obj_from_bmesh(name, bm, coll, mat("Stone_Dark"), smooth=True)


def cannon(coll, name, loc, yaw, scale=1.0):
    """Garrison gun on a truck carriage, muzzle along +X before yaw: tapered barrel with
    reinforce rings, cascabel, two cheeks, four trucks, axletrees."""
    s = scale
    parts = []
    L = 2.1 * s
    gs = int(os.environ.get("B51B_GUN_SEGS", "10"))
    bm = bm_cylinder(0.2 * s, 0.13 * s, L, segs=gs)
    bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((0.35 * s, 0, 0.62 * s)), verts=bm.verts)
    parts.append(("Metal_Iron", bm, True))
    for k, (x, rr) in enumerate(((-0.55, 0.23), (-0.1, 0.205), (0.75, 0.17), (1.38, 0.16))):
        bm = bm_cylinder(rr * s, rr * s, 0.09 * s, segs=gs)
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((x * s, 0, 0.62 * s)), verts=bm.verts)
        parts.append(("Metal_Iron", bm, True))
    bm = bm_icosphere(0.1 * s, 2)
    bmesh.ops.translate(bm, vec=Vector((-0.78 * s, 0, 0.62 * s)), verts=bm.verts)
    parts.append(("Metal_Iron", bm, True))
    for sy in (-1, 1):               # carriage cheeks, stepped
        bm = bm_box(1.25 * s, 0.11 * s, 0.42 * s)
        for v in bm.verts:
            if v.co.z > 0 and v.co.x < 0:
                v.co.z -= 0.16 * s
        bm_bevel(bm, 0.015 * s)
        bmesh.ops.translate(bm, vec=Vector((-0.1 * s, sy * 0.27 * s, 0.43 * s)), verts=bm.verts)
        parts.append(("Wood_Dark", bm, False))
    for x in (-0.55, 0.38):          # axletrees + trucks
        bm = bm_box(0.16 * s, 0.7 * s, 0.13 * s)
        bmesh.ops.translate(bm, vec=Vector((x * s, 0, 0.2 * s)), verts=bm.verts)
        parts.append(("Wood_Mid", bm, False))
        for sy in (-1, 1):
            bm = bm_cylinder(0.19 * s, 0.19 * s, 0.09 * s, segs=10)
            bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.pi / 2, 4, 'X'), verts=bm.verts)
            bmesh.ops.translate(bm, vec=Vector((x * s, sy * 0.4 * s, 0.19 * s)), verts=bm.verts)
            parts.append(("Wood_Dark", bm, True))
    bm = bm_box(0.5 * s, 0.4 * s, 0.07 * s)             # quoin under the breech
    bmesh.ops.translate(bm, vec=Vector((-0.45 * s, 0, 0.42 * s)), verts=bm.verts)
    parts.append(("Wood_Mid", bm, False))
    M = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(yaw, 4, 'Z')
    out = []
    for k, (mname, bm, sm) in enumerate(parts):
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        out.append(obj_from_bmesh(f"{name}_{k}", bm, coll, mat(mname), smooth=sm))
    return out


def shot_pile(coll, name, loc, n=3, r=0.11):
    """Pyramid of round shot on a timber frame."""
    out = []
    bm = bm_box(n * 2 * r + 0.1, n * 2 * r + 0.1, 0.08)
    _place(bm, (loc[0], loc[1], loc[2] + 0.04))
    out.append(obj_from_bmesh(name + "_frame", bm, coll, mat("Wood_Mid")))
    bm = bmesh.new()
    for layer in range(n):
        m = n - layer
        for i in range(m):
            for j in range(m):
                b = bm_icosphere(r, 1)
                c = Vector((loc[0] + (i - (m - 1) / 2) * 2 * r, loc[1] + (j - (m - 1) / 2) * 2 * r,
                            loc[2] + 0.08 + r + layer * r * 1.42))
                bmesh.ops.translate(b, vec=c, verts=b.verts)
                me = bpy.data.meshes.new("tmp")
                b.to_mesh(me)
                bm.from_mesh(me)
                bpy.data.meshes.remove(me)
                b.free()
    out.append(obj_from_bmesh(name + "_shot", bm, coll, mat("Metal_Iron"), smooth=True))
    return out


def powder_barrel(coll, name, loc, rot=0.0):
    out = []
    bm = bm_cylinder(0.27, 0.27, 0.72, segs=16)
    for v in bm.verts:               # bilge bulge
        v.co.x *= 1.0 + 0.12 * (1 - (2 * v.co.z / 0.72) ** 2)
        v.co.y *= 1.0 + 0.12 * (1 - (2 * v.co.z / 0.72) ** 2)
    _place(bm, (loc[0], loc[1], loc[2] + 0.36), rot)
    out.append(obj_from_bmesh(name + "_staves", bm, coll, mat("Wood_Mid"), smooth=True))
    for z in (0.08, 0.64):
        bm = bm_cylinder(0.285, 0.285, 0.05, segs=16, cap=False)
        _place(bm, (loc[0], loc[1], loc[2] + z))
        out.append(obj_from_bmesh(f"{name}_hoop{int(z * 100)}", bm, coll, mat("Metal_Iron"), smooth=True))
    return out


def bastion_drum(coll, name, r, h, seed, rng, hoarding=False, face=0.0):
    """Squat battered gun bastion: talus, cordon, embrasured parapet, timber gun deck. The two
    by the gate carry timber hoardings (a covered fighting gallery on brackets) instead of the
    old fairy-tale cone caps."""
    parts = []
    body = obj_from_bmesh(name + "_body", bm_cylinder(r * 1.12, r * 0.94, h, segs=24), coll,
                          mat("Stone_Fort"), smooth=True)
    body.location.z = h * 0.5
    displace_noise(body, strength=r * 0.03, scale=r * 1.2, seed=seed)
    apply_modifiers(body)
    parts.append(body)
    talus = obj_from_bmesh(name + "_talus", bm_cylinder(r * 1.25, r * 1.1, 0.9, segs=24, cap=False),
                           coll, mat("Stone_Dark"), smooth=True)
    talus.location.z = 0.45
    apply_modifiers(talus)
    parts.append(talus)
    parts.append(cordon(coll, name + "_cordon", r * 0.95, h - 0.1, segs=24))
    deck = obj_from_bmesh(name + "_deck", bm_cylinder(r * 0.9, r * 0.9, 0.14, segs=24), coll,
                          mat("Wood_Bleached"))
    deck.location.z = h + 0.07
    apply_modifiers(deck)
    parts.append(deck)
    if hoarding:
        # hoarding: brackets, gallery floor, plank screen with loop slots, low lean-to roof
        hr = r * 1.22
        for i in range(10):
            a = i / 10 * math.tau
            bm = bm_box(0.16, 0.7, 0.18)
            for v in bm.verts:
                if v.co.y > 0 and v.co.z < 0:
                    v.co.z += 0.14
            _place(bm, (math.cos(a) * (r * 0.98), math.sin(a) * (r * 0.98), h - 0.35), a - math.pi / 2)
            parts.append(obj_from_bmesh(f"{name}_brk{i}", bm, coll, mat("Wood_Dark")))
        fl = obj_from_bmesh(name + "_hfloor", bm_cylinder(hr, hr, 0.1, segs=24, cap=False), coll,
                            mat("Wood_Mid"))
        fl.location.z = h - 0.2
        apply_modifiers(fl)
        parts.append(fl)
        n = 18
        for i in range(n):
            if i % 3 == 1:
                continue             # loop slot between plank screens
            a = (i + 0.5) / n * math.tau
            bm = bm_box(math.tau * hr / n * 0.98, 0.07, 1.25)
            bm_bevel(bm, 0.01)
            _place(bm, (math.cos(a) * hr, math.sin(a) * hr, h + 0.45 + rng.uniform(-0.02, 0.02)),
                   a + math.pi / 2)
            parts.append(obj_from_bmesh(f"{name}_scr{i}", bm, coll, mat("Wood_Bleached")))
        rail = obj_from_bmesh(name + "_hrail", bm_cylinder(hr + 0.05, hr + 0.05, 0.12, segs=24, cap=False),
                              coll, mat("Wood_Dark"))
        rail.location.z = h + 1.1
        apply_modifiers(rail)
        parts.append(rail)
        roof = obj_from_bmesh(name + "_hroof", bm_cylinder(hr + 0.3, r * 0.55, 0.55, segs=24, cap=True),
                              coll, mat("Shingle"))
        roof.location.z = h + 1.42
        apply_modifiers(roof)
        parts.append(roof)
    else:
        p, emb = parapet_ring(coll, name, r * 0.98, h, 6, 0.7, 0.95, 0.5, mat("Stone_Fort"), rng=rng,
                              phase=face / math.tau * 6 - 0.5)   # an embrasure on the gun line
        parts += p
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
    decimate(mount, float(os.environ.get("B51B_MOUNT_DEC", "0.15")))
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
    # embrasured artillery parapet along the rampart (skip the gate): 16 thick blocks, sloped
    # superior face, 0.95 m embrasures a gun fires through
    par, embs = parapet_ring(coll, name + "_wp", r_top + 0.05, wall_h, 16, 0.95, 1.0, 0.9,
                             mat("Stone_Fort"), gap_dir=front, gap_half=gap_half + 0.1, rng=rng, phase=0.5)
    parts += par
    parts.append(cordon(coll, name + "_cordon", r_top + 0.02, wall_h - 0.35, segs=48))
    # timber gun platform (terreplein deck) on posts inside the curtain: the courtyard stays
    # walkable underneath, the guns sit at the embrasure sill
    deck_in, deck_out, deck_z = 4.75, r_top - 0.3, wall_h - 0.12
    n = int(os.environ.get("B51B_DECK_N", "36"))
    for j in range(n):
        a0 = (j + 0.5) / n * math.tau
        d = math.atan2(math.sin(a0 - front), math.cos(a0 - front))
        if abs(d) < gap_half + 0.1:
            continue
        bm = bm_box(deck_out - deck_in, math.tau * deck_out / n * 1.02, 0.12)
        bm_bevel(bm, 0.008)
        mr = (deck_in + deck_out) / 2
        _place(bm, (math.cos(a0) * mr, math.sin(a0) * mr, deck_z + rng.uniform(-0.01, 0.01)), a0)
        parts.append(obj_from_bmesh(f"{name}_dk{j}", bm, coll, mat("Wood_Bleached")))
        if j % 3 == 0:
            for rr in (deck_in + 0.12, deck_out - 0.1):
                bm = bm_box(0.2, 0.2, deck_z - 0.06)
                bm_bevel(bm, 0.02)
                _place(bm, (math.cos(a0) * rr, math.sin(a0) * rr, (deck_z - 0.06) * 0.5), a0)
                parts.append(obj_from_bmesh(f"{name}_po{j}_{int(rr * 10)}", bm, coll, mat("Wood_Dark")))
            bm = bm_box(deck_out - deck_in + 0.2, 0.18, 0.2)
            _place(bm, (math.cos(a0) * mr, math.sin(a0) * mr, deck_z - 0.16), a0)
            parts.append(obj_from_bmesh(f"{name}_jo{j}", bm, coll, mat("Wood_Dark")))
    # guns run out through the seaward embrasures (front half, either side of the gate)
    gi = 0
    for ea in embs:
        d = math.atan2(math.sin(ea - front), math.cos(ea - front))
        if abs(d) > 1.75 or abs(d) < gap_half + 0.3:
            continue
        rr = r_top - 1.05
        parts += cannon(coll, f"{name}_gun{gi}", (math.cos(ea) * rr, math.sin(ea) * rr, deck_z + 0.06), ea)
        if gi % 2 == 0:
            sa = ea + (0.12 if d > 0 else -0.12)
            parts += shot_pile(coll, f"{name}_shot{gi}", (math.cos(sa) * 5.05, math.sin(sa) * 5.05, deck_z + 0.06))
        gi += 1
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
    # gate passage soffit + iron-bound timber leaves swung open inward (the gate stays passable:
    # props.ts leaves this arc open)
    hc = bm_cylinder(arch_r + 0.05, arch_r + 0.05, 0.9, segs=18, cap=False)
    bmesh.ops.transform(hc, matrix=Matrix.Rotation(math.pi / 2, 4, 'X'), verts=hc.verts)
    bmesh.ops.delete(hc, geom=[v for v in hc.verts if v.co.z < -0.01], context='VERTS')
    _place(hc, (0, gy + 0.55, arch_z))
    parts.append(obj_from_bmesh(name + "_soffit", hc, coll, mat("Stone_Dark"), smooth=True))
    for sx in (-1, 1):
        lw = arch_r - 0.05
        bm = bm_box(lw, 0.14, arch_z + 0.6)
        bm_bevel(bm, 0.012)
        M = (Matrix.Translation((sx * (arch_r - 0.05), gy + 0.95, (arch_z + 0.6) * 0.5)) @
             Matrix.Rotation(sx * -1.25, 4, 'Z') @ Matrix.Translation((-sx * lw * 0.5, 0, 0)))
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_leaf{sx}", bm, coll, mat("Wood_Dark")))
        for z in (0.5, arch_z - 0.2):
            bm = bm_box(lw * 0.92, 0.17, 0.12)
            bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0, z - (arch_z + 0.6) * 0.5)), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_strap{sx}_{int(z * 10)}", bm, coll, mat("Metal_Iron")))
    # threshold step
    bm = bm_box(arch_r * 2 + 0.6, 1.6, 0.22)
    bm_bevel(bm, 0.04)
    _place(bm, (0, gy - 0.4, 0.11))
    parts.append(obj_from_bmesh(name + "_step", bm, coll, mat("Stone_Dark")))

    # ── four gun bastions on the old tower centres (props.ts colliders unchanged): the gate pair
    #    carry timber hoardings, the rear pair an embrasured gun deck with a gun each ──
    for k, ang in enumerate([front - 0.72, front + 0.72, front + math.pi - 0.5, front + math.pi + 0.5]):
        tx, ty = math.cos(ang) * (r_base + 0.3), math.sin(ang) * (r_base + 0.3)
        th = 5.2 if k < 2 else 4.4
        tparts = bastion_drum(coll, f"{name}_t{k}", 1.5, th, seed=20 + k, rng=rng, hoarding=(k < 2), face=ang)
        if k >= 2:
            tparts += cannon(coll, f"{name}_t{k}_gun", (0.35 * math.cos(ang), 0.35 * math.sin(ang), th + 0.14),
                             ang, scale=0.85)
        for o in tparts:
            o.location.x += tx
            o.location.y += ty
        parts += tparts

    # ── central cavalier: the raised gun platform that commands the anchorage (keep footprint
    #    r 2.8 = props.ts capsule), battered drum, cordon, embrasured parapet, three guns, a
    #    stair-door at the base, the flagstaff ──
    ch = 6.2
    body = obj_from_bmesh(name + "_cav", bm_cylinder(3.0, 2.65, ch, segs=32), coll, mat("Stone_Fort"),
                          smooth=True)
    body.location.z = ch * 0.5
    displace_noise(body, strength=0.07, scale=2.6, seed=40)
    apply_modifiers(body)
    parts.append(body)
    tal = obj_from_bmesh(name + "_cavtalus", bm_cylinder(3.15, 3.0, 0.8, segs=32, cap=False), coll,
                         mat("Stone_Dark"), smooth=True)
    tal.location.z = 0.4
    apply_modifiers(tal)
    parts.append(tal)
    parts.append(cordon(coll, name + "_cavcordon", 2.62, ch - 0.12, segs=32))
    cdeck = obj_from_bmesh(name + "_cavdeck", bm_cylinder(2.55, 2.55, 0.14, segs=32), coll,
                           mat("Wood_Bleached"))
    cdeck.location.z = ch + 0.07
    apply_modifiers(cdeck)
    parts.append(cdeck)
    cp, cembs = parapet_ring(coll, name + "_cavp", 2.62, ch, 9, 0.85, 1.0, 0.7, mat("Stone_Fort"),
                             rng=rng, phase=0.0)
    parts += cp
    for gi2, ea in enumerate(sorted(cembs, key=lambda e: abs(math.atan2(math.sin(e - front),
                                                                        math.cos(e - front))))[:3]):
        parts += cannon(coll, f"{name}_cgun{gi2}", (math.cos(ea) * 1.55, math.sin(ea) * 1.55, ch + 0.14), ea)
    parts += shot_pile(coll, name + "_cshot", (0.9, 0.9, ch + 0.14))
    # stair door at the cavalier foot (rear, facing the courtyard) + powder store by it
    bm = bm_box(1.1, 0.25, 2.0)
    bm_bevel(bm, 0.02)
    _place(bm, (0, 2.98, 1.0))
    parts.append(obj_from_bmesh(name + "_cavdoor", bm, coll, mat("Wood_Dark")))
    bm = bm_box(1.45, 0.4, 0.25)
    bm_bevel(bm, 0.03)
    _place(bm, (0, 2.95, 2.12))
    parts.append(obj_from_bmesh(name + "_cavlintel", bm, coll, mat("Stone_Dark")))
    for bi, (bx, by) in enumerate(((1.25, 3.55), (1.85, 3.25), (-1.45, 3.5))):
        parts += powder_barrel(coll, f"{name}_pb{bi}", (bx, by, 0.0), rot=bi * 0.7)
    # flagstaff + weathered ensign (cloth stays a separate part on the canvas strip)
    pole = bm_cylinder(0.12, 0.08, 6.0, segs=12)
    _place(pole, (0, 0, ch + 3.0))
    parts.append(obj_from_bmesh(name + "_pole", pole, coll, mat("Wood_Dark"), smooth=True))
    ftop = bm_cylinder(0.16, 0.02, 0.3, segs=12)
    _place(ftop, (0, 0, ch + 6.15))
    parts.append(obj_from_bmesh(name + "_poletop", ftop, coll, mat("Gold"), smooth=True))
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=12, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((1.1, 0.7, 1.0)), verts=bm.verts)
    for v in bm.verts:
        ty = (v.co.x / 1.1 + 1.0) * 0.5
        v.co.y -= 0.20 * ty * ty
        v.co.z = 0.14 * math.sin(ty * math.pi * 2.2) * ty
    m = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 1.16, ch + 5.1)) @ m, verts=bm.verts)
    flag = obj_from_bmesh(name + "_flag", bm, coll, mat("Canvas_Dirty"), smooth=True)
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

    # b5.1b: every part onto the stone / wood_iron / shingle / canvas trim strips, LOD chain from the
    # authored proxies (build_lods reuses lod_proxies/fort_*.glb)
    parts = trimify(parts, float(os.environ.get("B51B_L_FORT", "4")))
    if os.environ.get("B51B_TRI_REPORT"):     # per-kind tri budget (part name minus its index)
        import re
        tally = {}
        for o in parts:
            k = re.sub(r"\d+", "#", o.name.split(".")[0])
            tally[k] = tally.get(k, 0) + sum(len(p.vertices) - 2 for p in o.data.polygons)
        for k, t in sorted(tally.items(), key=lambda kv: -kv[1])[:25]:
            print(f"B51B_TRIS {k} {t}")
    obj = join(parts, name)
    ship_building([obj], name, four=True)
    print(f"built {name}")


build_fort()
print("FORT DONE")
