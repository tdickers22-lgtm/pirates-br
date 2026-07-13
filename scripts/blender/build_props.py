# Builds gameplay props (fidelity pass): barrel, powder keg, treasure chest
# (closed/open), crate, campfire, dock modules (mid + end).
# Origins: all sit on Z=0. dock_mid/dock_end are tiling modules — length/width
# must stay EXACT (mid: X in [-3,3], end: X in [-2,2], section Y max ~1.57).
# lantern_post lives in build_landmarks.py (not this script).
import os
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())

# ── local palette extensions ─────────────────────────────────
EXTRA = {
    "Ember":    ((0.85, 0.30, 0.08, 1.0), 0.75, 0.0),
    "Wood_Wet": ((0.10, 0.085, 0.06, 1.0), 0.92, 0.0),
    "Bone":     ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

# Ember gets a gentle warm emission (<=2 per brief)
_em = mat("Ember")
_eb = _em.node_tree.nodes.get("Principled BSDF")
_eb.inputs["Emission Color"].default_value = (0.95, 0.38, 0.10, 1.0)
_eb.inputs["Emission Strength"].default_value = 1.8

SCRATCH = os.environ.get(
    "PROPS_SCRATCH",
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad")
ROUND = os.environ.get("PROPS_ROUND", "1")
RENDER_DIR = os.path.join(SCRATCH, "renders", "u-props", f"round{ROUND}")
if os.environ.get("PROPS_FINAL") != "1":
    EXPORT_DIR = os.path.join(SCRATCH, "glb_test")  # noqa: F811 (test exports)

clear_default_scene()


# ── small builders ───────────────────────────────────────────
def _finish(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def add_box(coll, name, w, d, h, loc, mname, rot=None, bevel=0.012, smooth=False):
    bm = bm_box(w, d, h)
    M = Matrix.Translation(Vector(loc))
    if rot is not None:
        M = M @ rot
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel)
        apply_modifiers(o)
    return o


def add_cyl(coll, name, r1, r2, depth, loc, mname, segs=8, rot=None,
            bevel=0.0, smooth=True, cap=True):
    bm = bm_cylinder(r1, r2, depth, segs=segs, cap=cap)
    M = Matrix.Translation(Vector(loc))
    if rot is not None:
        M = M @ rot
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel)
        apply_modifiers(o)
    return o


def add_rivet(coll, name, loc, normal, r=0.018, depth=0.035, mname="Metal_Iron"):
    bm = bm_cylinder(r, r * 0.65, depth, segs=5)
    quat = Vector(normal).normalized().to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(loc)) @
                        quat.to_matrix().to_4x4(), verts=bm.verts)
    _finish(bm)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)


def chip_corner(bm, co, no):
    """Slice a corner off (chipped wood) and fill the hole flat."""
    res = bmesh.ops.bisect_plane(
        bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
        plane_co=Vector(co), plane_no=Vector(no).normalized(),
        clear_outer=True)
    edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=12)


def make_stave(coll, name, radius, height, a0, a1, thick, mname,
               bulge=0.16, rings=5, splay=0.0, tilt=0.0, z_jit=0.0):
    """One curved barrel stave (solid, 4-vert cross section per ring).
    splay: extra radial offset at the top (staves lean outward slightly)."""
    bm = bmesh.new()
    rows = []
    for i in range(rings + 1):
        t = i / rings
        b = 1.0 + bulge * math.sin(t * math.pi)
        r_out = radius * b + splay * t
        r_in = r_out - thick
        aa0 = a0 + tilt * t
        aa1 = a1 + tilt * t
        row = []
        for a, r in ((aa0, r_out), (aa1, r_out), (aa1, r_in), (aa0, r_in)):
            row.append(bm.verts.new((r * math.cos(a), r * math.sin(a),
                                     height * t + z_jit * t)))
        rows.append(row)
    for i in range(rings):
        A, B = rows[i], rows[i + 1]
        for j in range(4):
            k = (j + 1) % 4
            bm.faces.new((A[j], A[k], B[k], B[j]))
    bm.faces.new(tuple(reversed(rows[0])))
    bm.faces.new(tuple(rows[-1]))
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)
    return o


# ── barrel / keg ─────────────────────────────────────────────
def build_barrel(name, height=1.0, radius=0.38, woods=("Wood_Mid", "Wood_Mid",
                 "Wood_Light", "Wood_Mid", "Wood_Dark"),
                 band="Metal_Band", bands=(0.20, 0.80), seed=3,
                 n_staves=12, rivet_every=2):
    coll = asset_collection(name)
    rng = random.Random(seed)
    parts = []
    gap_frac = 0.035  # angular gap between staves (thin shadow lines)
    for j in range(n_staves):
        a0 = 2 * math.pi * j / n_staves
        span = 2 * math.pi / n_staves
        g = span * gap_frac * rng.uniform(0.6, 1.4)
        s = make_stave(coll, f"{name}_stave{j}", radius, height,
                       a0 + g / 2, a0 + span - g / 2, 0.045,
                       rng.choice(woods),
                       splay=rng.uniform(0.0, 0.015),
                       tilt=rng.uniform(-0.015, 0.015),
                       z_jit=rng.uniform(-0.010, 0.006))
        parts.append(s)
    # iron bands, beveled, with rivet studs
    band_rivets = []
    for bi, bt in enumerate(bands):
        bulge = 1.0 + 0.16 * math.sin(bt * math.pi)
        br = radius * bulge + 0.028
        b = add_cyl(coll, f"{name}_band{bi}", br, br, 0.075,
                    (0, 0, height * bt), band, segs=14, bevel=0.012)
        parts.append(b)
        for j in range(0, n_staves, rivet_every):
            a = 2 * math.pi * (j + 0.5) / n_staves
            n = Vector((math.cos(a), math.sin(a), 0))
            band_rivets.append(add_rivet(
                coll, f"{name}_riv{bi}_{j}",
                n * (br + 0.008) + Vector((0, 0, height * bt)), n))
    parts += band_rivets
    # warped end boards on top
    top_r = radius * 0.96
    n_boards = 4
    bw = 2 * top_r / n_boards
    for i in range(n_boards):
        yc = -top_r + bw * (i + 0.5)
        half_chord = math.sqrt(max(0.01, top_r * top_r - yc * yc))
        rot = Matrix.Rotation(rng.uniform(-0.05, 0.05), 4, 'X')
        parts.append(add_box(coll, f"{name}_endboard{i}",
                             2 * half_chord * 0.98, bw * 0.92, 0.035,
                             (0, yc, height - 0.02 + rng.uniform(-0.012, 0.012)),
                             rng.choice(woods), rot=rot, bevel=0.008))
    obj = join(parts, name)
    return coll, obj


def build_keg(name="keg"):
    coll, obj = build_barrel(name, height=0.8, radius=0.34,
                             woods=("Wood_Dark", "Wood_Dark", "Wood_Dark",
                                    "Wood_Mid"),
                             band="Keg_Red", bands=(0.16, 0.5, 0.84),
                             seed=11, n_staves=11, rivet_every=3)
    # fuse coil on top
    rope_pts = []
    for i in range(14):
        t = i / 13
        a = t * math.pi * 3.2
        r = 0.12 * (1 - t * 0.5)
        rope_pts.append(Vector((r * math.cos(a), r * math.sin(a),
                                0.80 + t * 0.11)))
    fuse = []
    for k in range(len(rope_pts) - 1):
        seg = rope_pts[k + 1] - rope_pts[k]
        c = bm_cylinder(0.022, 0.022, seg.length + 0.012, segs=5, cap=(k in (0, 12)))
        quat = seg.to_track_quat('Z', 'Y')
        bmesh.ops.transform(c, matrix=Matrix.Translation(
            (rope_pts[k] + rope_pts[k + 1]) / 2) @ quat.to_matrix().to_4x4(),
            verts=c.verts)
        _finish(c)
        fuse.append(obj_from_bmesh(f"{name}_fuse{k}", c, coll, mat("Rope"),
                                   smooth=True))
    obj = join([obj] + fuse, name)
    return coll, obj


# ── chest ────────────────────────────────────────────────────
def build_chest(name, open_lid=False):
    coll = asset_collection(name)
    rng = random.Random(5 if open_lid else 4)
    W, D, Hh = 0.95, 0.62, 0.55
    parts = []
    # base box (beveled) with chipped bottom corner
    bm = bm_box(W, D, Hh)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, Hh / 2)), verts=bm.verts)
    chip_corner(bm, (W / 2 - 0.05, D / 2 - 0.05, 0.06), (1, 1, -1))
    _finish(bm)
    base = obj_from_bmesh(f"{name}_base", bm, coll, mat("Wood_Dark"))
    bevel_obj(base, width=0.02)
    apply_modifiers(base)
    parts.append(base)
    # horizontal plank overlay strips (front + back + ends)
    for sy in (-1, 1):
        for zi, z in enumerate((Hh * 0.28, Hh * 0.68)):
            parts.append(add_box(
                coll, f"{name}_plank{sy}{zi}", W * 0.97, 0.025, 0.015,
                (rng.uniform(-0.01, 0.01), sy * (D / 2), z),
                "Wood_Mid", bevel=0.005))
    for sx in (-1, 1):
        for zi, z in enumerate((Hh * 0.28, Hh * 0.68)):
            parts.append(add_box(
                coll, f"{name}_eplank{sx}{zi}", 0.025, D * 0.94, 0.015,
                (sx * (W / 2), rng.uniform(-0.01, 0.01), z),
                "Wood_Mid", bevel=0.005))
    # arched lid: half-cylinder along X, 16 segs for a smooth bevel curve
    lid_parts_bm = []
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=D / 2,
                          radius2=D / 2, depth=W)
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'),
                     verts=bm.verts)
    for v in bm.verts:
        if v.co.z < 0:
            v.co.z = 0
    lid_rot = (Matrix.Rotation(math.radians(-52), 4, 'X') if open_lid
               else Matrix.Identity(4))
    pivot = Vector((0, -D / 2, Hh))
    lid_M = Matrix.Translation(pivot) @ lid_rot @ Matrix.Translation(Vector((0, D / 2, 0)))
    bmesh.ops.transform(bm, matrix=lid_M, verts=bm.verts)
    _finish(bm)
    lid = obj_from_bmesh(f"{name}_lid", bm, coll, mat("Wood_Dark"), smooth=False)
    parts.append(lid)
    # iron straps: vertical on base + arc over lid (follow lid transform)
    def strap_arc(xo):
        bmm = bmesh.new()
        segsA = 9
        w2, th = 0.045, 0.022
        rows = []
        for i in range(segsA + 1):
            a = math.pi * i / segsA
            y = (D / 2 + th) * math.cos(a)
            z = (D / 2 + th) * math.sin(a)
            yi = (D / 2 + 0.004) * math.cos(a)
            zi = (D / 2 + 0.004) * math.sin(a)
            row = [bmm.verts.new((xo - w2, y, z)), bmm.verts.new((xo + w2, y, z)),
                   bmm.verts.new((xo + w2, yi, zi)), bmm.verts.new((xo - w2, yi, zi))]
            rows.append(row)
        for i in range(segsA):
            A, B = rows[i], rows[i + 1]
            for j in range(4):
                k = (j + 1) % 4
                bmm.faces.new((A[j], A[k], B[k], B[j]))
        bmm.faces.new(tuple(reversed(rows[0])))
        bmm.faces.new(tuple(rows[-1]))
        bmesh.ops.transform(bmm, matrix=lid_M, verts=bmm.verts)
        _finish(bmm)
        return obj_from_bmesh(f"{name}_straparc{xo:.2f}", bmm, coll,
                              mat("Metal_Iron"), smooth=True)
    rivets = []
    for xo in (-W * 0.32, W * 0.32):
        # vertical band on base
        parts.append(add_box(coll, f"{name}_strapv{xo:.2f}", 0.09, D + 0.045,
                             Hh + 0.015, (xo, 0, (Hh + 0.015) / 2 - 0.01),
                             "Metal_Iron", bevel=0.008))
        parts.append(strap_arc(xo))
        # rivets down the front + back of the vertical strap
        for sy in (-1, 1):
            for z in (Hh * 0.2, Hh * 0.5, Hh * 0.8):
                rivets.append(add_rivet(coll, f"{name}_riv{xo:.1f}{sy}{z:.1f}",
                                        (xo, sy * (D / 2 + 0.024), z),
                                        (0, sy, 0), r=0.016, depth=0.03))
    parts += rivets
    # hasp + gold lock plate on front (+Y)
    parts.append(add_box(coll, f"{name}_lockplate", 0.17, 0.045, 0.21,
                         (0, D / 2 + 0.015, Hh * 0.80), "Gold", bevel=0.008))
    hasp_bm = bm_box(0.07, 0.035, 0.16)
    hM = Matrix.Translation((0, D / 2 + 0.045, Hh * 0.95))
    if open_lid:
        hM = Matrix.Translation(pivot) @ lid_rot @ Matrix.Translation(-pivot) @ hM
    bmesh.ops.transform(hasp_bm, matrix=hM, verts=hasp_bm.verts)
    _finish(hasp_bm)
    hasp = obj_from_bmesh(f"{name}_hasp", hasp_bm, coll, mat("Metal_Iron"))
    bevel_obj(hasp, width=0.008)
    apply_modifiers(hasp)
    parts.append(hasp)
    # rope side handles
    for sx in (-1, 1):
        parts.append(add_cyl(coll, f"{name}_handle{sx}", 0.022, 0.022, 0.16,
                             (sx * (W / 2 + 0.02), 0, Hh * 0.62), "Rope",
                             segs=6, rot=Matrix.Rotation(math.pi / 2, 4, 'X')))
    if open_lid:
        # coin heap: faceted gold mound + scattered coins
        bm = bm_icosphere(0.33, 2)
        bmesh.ops.scale(bm, vec=Vector((1.25, 0.8, 0.5)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0.03, Hh + 0.02)),
                            verts=bm.verts)
        _finish(bm)
        o = obj_from_bmesh(f"{name}_gold", bm, coll, mat("Gold"), smooth=False)
        displace_noise(o, strength=0.12, scale=0.14, seed=9)
        apply_modifiers(o)
        parts.append(o)
        for i in range(7):
            a = rng.uniform(0, 2 * math.pi)
            r = rng.uniform(0.12, 0.40)
            x, y = r * math.cos(a) * 1.1, r * math.sin(a) * 0.6
            z = Hh + 0.10 if r < 0.18 else Hh + 0.03
            parts.append(add_cyl(coll, f"{name}_coin{i}", 0.045, 0.045, 0.012,
                                 (x, y + 0.03, z), "Gold", segs=7,
                                 rot=Matrix.Rotation(rng.uniform(-0.5, 0.5), 4, 'X'),
                                 smooth=False))
    obj = join(parts, name)
    return coll, obj


# ── crate ────────────────────────────────────────────────────
def build_crate(name="crate"):
    coll = asset_collection(name)
    rng = random.Random(21)
    S = 0.72
    parts = []
    plank_h = S / 3
    woods = ("Wood_Mid", "Wood_Mid", "Wood_Light", "Wood_Mid")
    # slatted sides: 3 horizontal planks per face, small gaps, slight jitter
    for face in range(4):
        a = face * math.pi / 2
        rot = Matrix.Rotation(a, 4, 'Z')
        for i in range(3):
            z = plank_h * (i + 0.5) + rng.uniform(-0.008, 0.008)
            bm = bm_box(S * 0.98, 0.05, plank_h * 0.86)
            if face == 1 and i == 2:  # one chipped plank corner
                chip_corner(bm, (S * 0.40, 0, plank_h * 0.24), (1, 0, 1))
            if face == 3 and i == 0:
                chip_corner(bm, (-S * 0.42, 0, -plank_h * 0.26), (-1, 0, -1))
            M = rot @ Matrix.Translation((0, -S / 2 + 0.01, 0)) @ \
                Matrix.Rotation(rng.uniform(-0.02, 0.02), 4, 'Y')
            bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, z)) @ M,
                                verts=bm.verts)
            _finish(bm)
            o = obj_from_bmesh(f"{name}_p{face}{i}", bm, coll,
                               mat(woods[(face + i) % 4]))
            bevel_obj(o, width=0.008)
            apply_modifiers(o)
            parts.append(o)
    # top: 3 planks with gaps, one askew
    for i in range(3):
        y = -S / 2 + (S / 3) * (i + 0.5)
        rot = Matrix.Rotation(rng.uniform(-0.03, 0.03) + (0.06 if i == 1 else 0),
                              4, 'Z')
        parts.append(add_box(coll, f"{name}_top{i}", S * 0.96, S / 3 * 0.86, 0.05,
                             (0, y, S - 0.02), woods[i], rot=rot, bevel=0.008))
    # bottom board
    parts.append(add_box(coll, f"{name}_bot", S * 0.9, S * 0.9, 0.04,
                         (0, 0, 0.03), "Wood_Dark", bevel=0))
    # corner braces (battens), slightly proud
    for sx in (-1, 1):
        for sy in (-1, 1):
            bm = bm_box(0.09, 0.09, S + 0.015)
            if sx == 1 and sy == -1:  # chip one batten top
                chip_corner(bm, (0.02, -0.02, S / 2 - 0.04), (1, -1, 1))
            bmesh.ops.transform(bm, matrix=Matrix.Translation(
                (sx * S / 2, sy * S / 2, S / 2)), verts=bm.verts)
            _finish(bm)
            o = obj_from_bmesh(f"{name}_bat{sx}{sy}", bm, coll, mat("Wood_Dark"))
            bevel_obj(o, width=0.012)
            apply_modifiers(o)
            parts.append(o)
    obj = join(parts, name)
    return coll, obj


# ── campfire ─────────────────────────────────────────────────
def split_log(coll, name, r, length, mname, seed=0):
    """Charred split log: half-cylinder with flat split face, faceted."""
    rng = random.Random(seed)
    bm = bm_cylinder(r, r * 0.82, length, segs=8)
    off = rng.uniform(-0.2, 0.3) * r
    res = bmesh.ops.bisect_plane(
        bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
        plane_co=Vector((off, 0, 0)), plane_no=Vector((1, 0, 0)),
        clear_outer=True)
    edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=16)
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=False)
    displace_noise(o, strength=0.02, scale=0.25, seed=seed + 3)
    bevel_obj(o, width=0.01)
    apply_modifiers(o)
    return o


def build_campfire(name="campfire"):
    coll = asset_collection(name)
    rng = random.Random(7)
    parts = []
    # stone ring: varied sizes / squash / rotation, two greys
    n_st = 8
    for k in range(n_st):
        a = 2 * math.pi * k / n_st + rng.uniform(-0.12, 0.12)
        r = rng.uniform(0.11, 0.17)
        bm = bm_icosphere(r, 2)
        bmesh.ops.scale(bm, vec=Vector((rng.uniform(1.0, 1.35),
                                        rng.uniform(0.85, 1.1),
                                        rng.uniform(0.6, 0.8))), verts=bm.verts)
        rot = Matrix.Rotation(rng.uniform(0, math.pi), 4, 'Z')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.52 * math.cos(a), 0.52 * math.sin(a), r * 0.5)) @ rot,
            verts=bm.verts)
        _finish(bm)
        o = obj_from_bmesh(f"{name}_stone{k}", bm, coll,
                           mat("Rock_Grey" if k % 3 else "Rock_Dark"),
                           smooth=False)
        displace_noise(o, strength=0.035, scale=0.3, seed=k)
        apply_modifiers(o)
        parts.append(o)
    # charred split logs leaning to center (teepee) + one fallen
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        log = split_log(coll, f"{name}_log{k}", 0.07, 0.60,
                        "Char_Black" if k != 2 else "Wood_Dark", seed=k)
        tilt = Vector((math.cos(a), math.sin(a), 0))
        quat = (Vector((0, 0, 1)) * 0.8 - tilt).to_track_quat('Z', 'Y')
        log.matrix_world = (Matrix.Translation(
            (0.17 * math.cos(a), 0.17 * math.sin(a), 0.21)) @
            quat.to_matrix().to_4x4())
        parts.append(log)
    fallen = split_log(coll, f"{name}_log4", 0.05, 0.5, "Char_Black", seed=9)
    fallen.matrix_world = (Matrix.Translation((0.42, -0.38, 0.05)) @
                           Matrix.Rotation(math.radians(80), 4, 'Y') @
                           Matrix.Rotation(0.6, 4, 'Z'))
    parts.append(fallen)
    # ember bed: faceted mound + glowing lumps
    bm = bm_icosphere(0.26, 2)
    bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 0.28)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, 0.03)), verts=bm.verts)
    _finish(bm)
    bed = obj_from_bmesh(f"{name}_bed", bm, coll, mat("Char_Black"), smooth=False)
    displace_noise(bed, strength=0.03, scale=0.12, seed=5)
    apply_modifiers(bed)
    parts.append(bed)
    for i in range(6):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.02, 0.16)
        bm = bm_icosphere(rng.uniform(0.03, 0.05), 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (r * math.cos(a), r * math.sin(a), 0.085)), verts=bm.verts)
        _finish(bm)
        parts.append(obj_from_bmesh(f"{name}_ember{i}", bm, coll, mat("Ember"),
                                    smooth=False))
    obj = join(parts, name)
    return coll, obj


# ── dock modules ─────────────────────────────────────────────
def build_dock(name, length=6.0, end_cap=False):
    """Tiling dock module. CONTRACT: X extent exactly [-L/2, L/2], section
    matches existing (posts at y=+/-1.4, rope wrap r=0.17 -> |y|max 1.57,
    deck z=1.1, posts to z=1.85)."""
    coll = asset_collection(name)
    rng = random.Random(len(name))
    parts = []
    deck_z = 1.1
    width = 3.0
    n = round(length / 0.55)
    plank_w = length / n  # spacing covers the EXACT module length (tiling)
    for i in range(n):
        x = -length / 2 + plank_w * (i + 0.5)
        bm = bm_box(plank_w * 0.88, width * rng.uniform(0.95, 1.0), 0.09)
        # chip a couple of plank ends
        if i in (1, n - 2):
            sy = 1 if i % 2 else -1
            chip_corner(bm, (plank_w * 0.30, sy * width * 0.42, 0.012),
                        (0.6, sy, 0.9))
        rotz = Matrix.Rotation(rng.uniform(-0.018, 0.018), 4, 'Z')
        rotx = Matrix.Rotation(rng.uniform(-0.02, 0.02), 4, 'X')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (x, rng.uniform(-0.01, 0.01), deck_z + rng.uniform(-0.015, 0.015)))
            @ rotz @ rotx, verts=bm.verts)
        _finish(bm)
        m = "Wood_Bleached" if i % 3 else "Wood_Light"
        o = obj_from_bmesh(f"{name}_plank{i}", bm, coll, mat(m))
        bevel_obj(o, width=0.012)
        apply_modifiers(o)
        parts.append(o)
    # posts: pairs, wet-darkened below waterline band, barnacles, rope wraps
    xs = [-length / 2 + 0.4, 0, length / 2 - 0.4]
    for xi, x in enumerate(xs):
        for sy in (-1, 1):
            py = sy * (width / 2 - 0.1)
            lean = rng.uniform(-0.015, 0.015)
            # wet lower section
            parts.append(add_cyl(coll, f"{name}_postw{xi}{sy}", 0.145, 0.138,
                                 0.5, (x, py, 0.25), "Wood_Wet", segs=8))
            # dry upper section with chamfered top
            top = add_cyl(coll, f"{name}_post{xi}{sy}", 0.138, 0.115,
                          deck_z + 0.25, (x + lean, py, 0.5 + (deck_z + 0.25) / 2),
                          "Wood_Dark", segs=8, bevel=0.025)
            parts.append(top)
            # barnacle band near waterline
            for bi in range(3):
                a = rng.uniform(0, 2 * math.pi)
                bz = rng.uniform(0.12, 0.34)
                br = 0.145
                bm = bm_icosphere(rng.uniform(0.022, 0.034), 1)
                bmesh.ops.scale(bm, vec=Vector((1, 1, 0.6)), verts=bm.verts)
                quat = Vector((math.cos(a), math.sin(a), 0)).to_track_quat('Z', 'Y')
                bmesh.ops.transform(bm, matrix=Matrix.Translation(
                    (x + br * math.cos(a), py + br * math.sin(a), bz)) @
                    quat.to_matrix().to_4x4(), verts=bm.verts)
                _finish(bm)
                parts.append(obj_from_bmesh(f"{name}_barn{xi}{sy}{bi}", bm,
                                            coll, mat("Bone"), smooth=False))
            # rope wrap: two stacked coils below deck lip (keeps |y|max 1.57)
            for ri, rz in enumerate((deck_z + 0.42, deck_z + 0.50)):
                parts.append(add_cyl(coll, f"{name}_rope{xi}{sy}{ri}", 0.17, 0.17,
                                     0.075, (x, py, rz), "Rope", segs=10,
                                     bevel=0.02))
    # stringers (define the EXACT X extent)
    for sy in (-1, 1):
        parts.append(add_box(coll, f"{name}_str{sy}", length, 0.18, 0.16,
                             (0, sy * (width / 2 - 0.35), deck_z - 0.12),
                             "Wood_Dark", bevel=0.015))
    # diagonal cross-braces between post pairs (under deck)
    for xi, x in enumerate(xs[:-1] if not end_cap else xs):
        x2 = xs[xi + 1] if xi + 1 < len(xs) else None
        if x2 is None:
            continue
        for sy in (-1, 1):
            py = sy * (width / 2 - 0.1)
            v = Vector((x2 - x, 0, deck_z - 0.35))
            quat = v.to_track_quat('Z', 'Y')
            parts.append(add_cyl(coll, f"{name}_brace{xi}{sy}", 0.05, 0.05,
                                 v.length * 0.96,
                                 ((x + x2) / 2, py, (0.25 + deck_z - 0.1) / 2),
                                 "Wood_Dark", segs=6,
                                 rot=quat.to_matrix().to_4x4()))
    # mooring cleats on deck edges (T-shape, iron-dark wood)
    cleat_xs = [-length / 2 + 1.0, length / 2 - 1.0]
    for ci, cx in enumerate(cleat_xs):
        sy = -1 if ci % 2 else 1
        cy = sy * (width / 2 - 0.22)
        parts.append(add_box(coll, f"{name}_cleatb{ci}", 0.10, 0.10, 0.14,
                             (cx, cy, deck_z + 0.10), "Wood_Dark", bevel=0.012))
        parts.append(add_cyl(coll, f"{name}_cleatt{ci}", 0.045, 0.035, 0.34,
                             (cx, cy, deck_z + 0.18), "Wood_Dark", segs=6,
                             rot=Matrix.Rotation(math.pi / 2, 4, 'Y'),
                             bevel=0.01))
    if end_cap:
        # end bumper board across the outer end (inside the exact length)
        parts.append(add_box(coll, f"{name}_bumper", 0.10, width * 0.92, 0.28,
                             (length / 2 - 0.05, 0, deck_z - 0.02),
                             "Wood_Dark", bevel=0.015))
    obj = join(parts, name)
    return coll, obj


# ── build, bake, export, verify, render ──────────────────────
BUILDS = [
    build_barrel("barrel"),
    build_keg("keg"),
    build_chest("chest_closed", False),
    build_chest("chest_open", True),
    build_crate("crate"),
    build_campfire("campfire"),
    build_dock("dock_mid", 6.0),
    build_dock("dock_end", 4.0, True),
]

for coll, obj in BUILDS:
    bake_ao(coll)
    path = export_collection_vc(coll, f"{obj.name}.glb")
    verify_glb(path)
    # isolate for the turntable: hide every other asset collection
    for c2, _ in BUILDS:
        c2.hide_render = (c2 is not coll)
    render_turntable(coll, obj.name, RENDER_DIR)

print("PROPS DONE")
