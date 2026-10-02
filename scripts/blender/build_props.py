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

# Props v2 (b4.5c, assets-10): two-segment bevels so every board edge catches a highlight, smooth-shaded
# bevelled solids (one shared vertex per corner, verts/tris <= 1.3 after export) and real detail:
# 18 bulged staves with chime + croze-set heads, 4 riveted hoops, nails, a coopered chest lid, a modelled
# coin hoard and a goblet. LOD0 sits in the props band 2.5-8k (test-asset-tiers); build_lods.py makes
# the <key>_lods chain.
BEV_SEGS = 2


# ── small builders ───────────────────────────────────────────
def _finish(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def add_box(coll, name, w, d, h, loc, mname, rot=None, bevel=0.012, smooth=True):
    bm = bm_box(w, d, h)
    M = Matrix.Translation(Vector(loc))
    if rot is not None:
        M = M @ rot
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel, segments=BEV_SEGS)
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
        bevel_obj(o, width=bevel, segments=BEV_SEGS)
        apply_modifiers(o)
    return o


def add_rivet(coll, name, loc, normal, r=0.018, depth=0.035, mname="Metal_Iron", segs=6):
    bm = bm_cylinder(r, r * 0.65, depth, segs=segs)
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
               bulge=0.16, rings=10, splay=0.0, tilt=0.0, z_jit=0.0):
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
        am = (aa0 + aa1) / 2
        for a, r in ((aa0, r_out), (am, r_out), (aa1, r_out), (aa1, r_in), (am, r_in), (aa0, r_in)):
            row.append(bm.verts.new((r * math.cos(a), r * math.sin(a),
                                     height * t + z_jit * t)))
        rows.append(row)
    for i in range(rings):
        A, B = rows[i], rows[i + 1]
        for j in range(6):
            k = (j + 1) % 6
            bm.faces.new((A[j], A[k], B[k], B[j]))
    bm.faces.new(tuple(reversed(rows[0])))
    bm.faces.new(tuple(rows[-1]))
    _finish(bm)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)
    return o


# ── barrel / keg ─────────────────────────────────────────────
def build_barrel(name, height=1.0, radius=0.38, woods=("Wood_Mid", "Wood_Mid",
                 "Wood_Light", "Wood_Mid", "Wood_Dark"),
                 band="Metal_Band", bands=(0.09, 0.27, 0.73, 0.91), seed=3,
                 n_staves=18, rivet_every=1, bung=True):
    coll = asset_collection(name)
    rng = random.Random(seed)
    parts = []
    gap_frac = 0.035  # angular gap between staves (thin shadow lines)
    STAVE_SPLAY = 0.004   # max outward lean at the top: a hoop drawn tight leaves the staves only mm of play

    def stave_r(z):
        """Outer stave radius at height z (bulge profile + the widest splay): what a hoop must hug."""
        t = min(1.0, max(0.0, z / height))
        return radius * (1.0 + 0.16 * math.sin(t * math.pi)) + STAVE_SPLAY * t
    for j in range(n_staves):
        a0 = 2 * math.pi * j / n_staves
        span = 2 * math.pi / n_staves
        g = span * gap_frac * rng.uniform(0.6, 1.4)
        s = make_stave(coll, f"{name}_stave{j}", radius, height,
                       a0 + g / 2, a0 + span - g / 2, 0.045,
                       rng.choice(woods),
                       splay=rng.uniform(0.0, STAVE_SPLAY),
                       tilt=rng.uniform(-0.015, 0.015),
                       z_jit=rng.uniform(-0.010, 0.006))
        parts.append(s)
    # iron hoops driven tight: each band is a frustum whose inner face follows the stave bulge across
    # its own width (r at the lower edge, r at the upper edge), 1.5 mm clear of the widest stave, so it
    # sits ON the staves instead of standing off them (round1 turntable: 2.8 cm gap). Rivet heads are
    # set into the band and stand 3 mm proud.
    band_rivets = []
    BW, BT = 0.065, 0.016            # band width, band thickness (solidified outward)
    for bi, bt in enumerate(bands):
        zc = height * bt
        r_lo = stave_r(zc - BW / 2) + 0.0015
        r_hi = stave_r(zc + BW / 2) + 0.0015
        b = add_cyl(coll, f"{name}_band{bi}", r_lo, r_hi, BW,
                    (0, 0, zc), band, segs=30, cap=False)
        bevel_obj(b, width=0.005, segments=BEV_SEGS)
        sol = b.modifiers.new("Solid", 'SOLIDIFY')
        sol.thickness = BT
        sol.offset = 1.0
        b.modifiers.move(len(b.modifiers) - 1, 0)
        apply_modifiers(b)
        parts.append(b)
        r_out = (r_lo + r_hi) / 2 + BT
        for j in range(0, n_staves, rivet_every):
            a = 2 * math.pi * (j + 0.5) / n_staves
            n = Vector((math.cos(a), math.sin(a), 0))
            band_rivets.append(add_rivet(
                coll, f"{name}_riv{bi}_{j}",
                n * (r_out + 0.0004) + Vector((0, 0, zc)), n, r=0.010, depth=0.0022, segs=5))
    parts += band_rivets
    # heads set into the croze: the staves stand proud above them as the chime (5 cm), and a dark
    # croze ring shows the groove the head boards are let into
    for zi, zc in ((1, height - 0.055), (0, 0.055)):
        top_r = radius * (1.0 + 0.16 * math.sin(math.pi * zc / height)) - 0.045
        n_boards = 5
        bw = 2 * top_r / n_boards
        for i in range(n_boards):
            yc = -top_r + bw * (i + 0.5)
            half_chord = math.sqrt(max(0.01, top_r * top_r - yc * yc))
            rot = Matrix.Rotation(rng.uniform(-0.03, 0.03), 4, 'X')
            parts.append(add_box(coll, f"{name}_head{zi}_{i}",
                                 2 * half_chord * 0.99, bw * 0.95, 0.03,
                                 (0, yc, zc + rng.uniform(-0.004, 0.004)),
                                 rng.choice(woods), rot=rot, bevel=0.006))
        parts.append(add_cyl(coll, f"{name}_croze{zi}", top_r + 0.004, top_r + 0.004, 0.012,
                             (0, 0, zc + 0.02), "Wood_Dark", segs=36, cap=False))
        parts[-1].data.flip_normals()   # seen from inside the chime
    if bung:
        # bung stave: a tapered plug at the belly, on the stave between two rivet columns
        n = Vector((1, 0, 0))
        parts.append(add_rivet(coll, f"{name}_bung", n * (radius * 1.16 + 0.004) + Vector((0, 0, height * 0.5)),
                               n, r=0.03, depth=0.03, mname="Wood_Dark", segs=12))
    obj = join(parts, name)
    return coll, obj


def build_keg(name="keg"):
    coll, obj = build_barrel(name, height=0.8, radius=0.34,
                             woods=("Wood_Dark", "Wood_Dark", "Wood_Dark",
                                    "Wood_Mid"),
                             band="Keg_Red", bands=(0.16, 0.5, 0.84),
                             seed=11, n_staves=16, rivet_every=1, bung=False)
    # fuse coil on top
    rope_pts = []
    for i in range(14):
        t = i / 13
        a = t * math.pi * 3.2
        r = 0.12 * (1 - t * 0.5)
        rope_pts.append(Vector((r * math.cos(a), r * math.sin(a),
                                0.75 + t * 0.11)))
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
    base = obj_from_bmesh(f"{name}_base", bm, coll, mat("Wood_Dark"), smooth=True)
    bevel_obj(base, width=0.02, segments=BEV_SEGS)
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
    # +70 deg about the back hinge swings the front edge UP and back (v1 used -52 and sank the lid into the box)
    lid_rot = (Matrix.Rotation(math.radians(70), 4, 'X') if open_lid
               else Matrix.Identity(4))
    pivot = Vector((0, -D / 2, Hh))
    lid_M = Matrix.Translation(pivot) @ lid_rot @ Matrix.Translation(Vector((0, D / 2, 0)))
    bmesh.ops.transform(bm, matrix=lid_M, verts=bm.verts)
    _finish(bm)
    lid = obj_from_bmesh(f"{name}_lid", bm, coll, mat("Wood_Dark"), smooth=False)
    parts.append(lid)
    # coopered lid: 7 bevelled slats laid round the arch like barrel staves, proud of the core
    n_sl = 7
    for i in range(n_sl):
        a = math.pi * (i + 0.5) / n_sl
        span = math.pi / n_sl
        rr = D / 2 + 0.008
        chord = 2 * rr * math.sin(span / 2) * 0.97
        sl = bm_box(W * 0.985, chord, 0.020)
        M = (lid_M @ Matrix.Translation((0, rr * math.cos(a), rr * math.sin(a))) @
             Matrix.Rotation(a - math.pi / 2, 4, 'X') @
             Matrix.Rotation(rng.uniform(-0.01, 0.01), 4, 'Z'))
        bmesh.ops.transform(sl, matrix=M, verts=sl.verts)
        _finish(sl)
        o = obj_from_bmesh(f"{name}_slat{i}", sl, coll, mat("Wood_Dark" if i % 3 else "Wood_Mid"), smooth=True)
        bevel_obj(o, width=0.007, segments=BEV_SEGS)
        apply_modifiers(o)
        parts.append(o)
    # iron straps: vertical on base + arc over lid (follow lid transform)
    def strap_arc(xo):
        bmm = bmesh.new()
        segsA = 18
        w2, th = 0.045, 0.034
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
        # rivets over the strap arc (they follow the lid when it is open)
        for k in range(1, 6):
            a = math.pi * k / 6
            rr = D / 2 + 0.036
            pt = lid_M @ Vector((xo, rr * math.cos(a), rr * math.sin(a)))
            nn = (lid_M.to_3x3() @ Vector((0, math.cos(a), math.sin(a)))).normalized()
            rivets.append(add_rivet(coll, f"{name}_rarc{xo:.1f}{k}", pt, nn, r=0.014, depth=0.02))
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
    hasp = obj_from_bmesh(f"{name}_hasp", hasp_bm, coll, mat("Metal_Iron"), smooth=True)
    bevel_obj(hasp, width=0.008, segments=BEV_SEGS)
    apply_modifiers(hasp)
    parts.append(hasp)
    # padlock: a bevelled iron body under a round shackle through the staple (hangs open on the open chest)
    lock_z = Hh * 0.62 if not open_lid else Hh * 0.58
    parts.append(add_box(coll, f"{name}_padlock", 0.09, 0.035, 0.08,
                         (0, D / 2 + 0.07, lock_z), "Metal_Iron", bevel=0.01))
    sh = bmesh.new()
    bmesh.ops.create_circle(sh, cap_ends=False, segments=16, radius=0.032)
    bmesh.ops.transform(sh, matrix=Matrix.Translation((0, D / 2 + 0.07, lock_z + 0.045)) @
                        Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=sh.verts)
    sho = obj_from_bmesh(f"{name}_shackle", sh, coll, mat("Metal_Iron"), smooth=True)
    sk = sho.modifiers.new("Skin", 'SKIN')
    for v in sho.data.skin_vertices[0].data:
        v.radius = (0.008, 0.008)
    sub = sho.modifiers.new("Sub", 'SUBSURF')
    sub.levels = 1
    apply_modifiers(sho)
    parts.append(sho)
    # rope side handles
    for sx in (-1, 1):
        parts.append(add_cyl(coll, f"{name}_handle{sx}", 0.022, 0.022, 0.16,
                             (sx * (W / 2 + 0.02), 0, Hh * 0.62), "Rope",
                             segs=6, rot=Matrix.Rotation(math.pi / 2, 4, 'X')))
    if open_lid:
        # coin hoard (round2 fix: round1 read as crumpled foil = a flat-shaded, hard-displaced mound under
        # 6 cm coins tilted up to 0.35). Now: a smooth low mound, 3.5-4 cm coins 2 mm thick with 8 sides,
        # laid nearly flat on the slope (+-0.12), 215 on the mound, three short stacks, 8 spilled, a goblet.
        bm = bm_icosphere(0.33, 2)
        bmesh.ops.scale(bm, vec=Vector((1.25, 0.8, 0.42)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0.03, Hh + 0.02)),
                            verts=bm.verts)
        _finish(bm)
        o = obj_from_bmesh(f"{name}_gold", bm, coll, mat("Gold"), smooth=True)
        displace_noise(o, strength=0.035, scale=0.14, seed=9)
        apply_modifiers(o)
        parts.append(o)
        # coins sit on the REAL displaced mound (ray cast), not on an analytic dome: round2's analytic
        # profile ran ~1 cm under the ellipsoid's mid-slope and buried every thin coin there
        from mathutils.bvhtree import BVHTree
        _mbm = bmesh.new()
        _mbm.from_mesh(o.data)
        _mbm.transform(o.matrix_world)
        _mtree = BVHTree.FromBMesh(_mbm)
        _mbm.free()

        def mound_hit(x, y):
            hit = _mtree.ray_cast(Vector((x, y, Hh + 1.0)), Vector((0, 0, -1)))
            if hit[0] is None:
                return Hh + 0.02, Vector((0, 0, 1))
            n = hit[1] if hit[1].z > 0 else -hit[1]
            return hit[0].z, n.normalized()

        def mound(x, y):
            return mound_hit(x, y)[0]
        coin_bms = bmesh.new()
        COIN_T = 0.002   # centre thickness (rim is sharp)

        def put_coin(x, y, z, nrm, cap_bottom):
            """One coin as a closed 16-tri lens: an 8-sided rim with a centre vertex 1 mm above and below
            (2 mm thick at the middle, sharp milled rim). Closed and 4V/A ~1.3 mm, so build_lods can
            cull it as a sub-pixel part at LOD2/far; 3.5-4 cm across, 8 sides (round1 read as foil)."""
            r = rng.uniform(0.0175, 0.020)
            c = bmesh.new()
            rim = [c.verts.new((r * math.cos(2 * math.pi * k / 8), r * math.sin(2 * math.pi * k / 8), 0.0))
                   for k in range(8)]
            top = c.verts.new((0, 0, COIN_T / 2))
            bot = c.verts.new((0, 0, -COIN_T / 2))
            for k in range(8):
                a, b = rim[k], rim[(k + 1) % 8]
                c.faces.new((a, b, top))
                c.faces.new((b, a, bot))
            q = Vector(nrm).normalized().to_track_quat('Z', 'Y')
            bmesh.ops.transform(c, matrix=Matrix.Translation((x, y, z + COIN_T / 2)) @ q.to_matrix().to_4x4() @
                                Matrix.Rotation(rng.uniform(0, math.pi), 4, 'Z'), verts=c.verts)
            mesh_tmp = bpy.data.meshes.new("coin_tmp")
            c.to_mesh(mesh_tmp)
            c.free()
            coin_bms.from_mesh(mesh_tmp)
            bpy.data.meshes.remove(mesh_tmp)

        def slope_n(x, y):
            return mound_hit(x, y)[1]

        n_coin = 0
        while n_coin < 215:   # ~60% cover of the mound top: the hoard reads as coins, not a gold blob
            x = rng.uniform(-0.44, 0.44)
            y = rng.uniform(-0.26, 0.29)
            if (x / 0.44) ** 2 + ((y - 0.015) / 0.28) ** 2 > 1.0:
                continue
            nrm = slope_n(x, y) + Vector((rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), 0))
            put_coin(x, y, mound(x, y) - 0.0005, nrm, False)
            n_coin += 1
        for sx, sy, k in ((-0.22, -0.06, 7), (0.08, 0.12, 5), (-0.02, -0.14, 4)):   # short stacks
            z = mound(sx, sy) - 0.001
            nrm = slope_n(sx, sy)
            for i in range(k):
                put_coin(sx + rng.uniform(-0.003, 0.003), sy + rng.uniform(-0.003, 0.003),
                         z + i * COIN_T * 1.02 * nrm.z, nrm + Vector((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), 0)),
                         False)
        for i in range(8):   # spilled over the front rim and onto the ground
            x = rng.uniform(-0.40, 0.40)
            y, z = (D / 2 + rng.uniform(0.03, 0.07), 0.0) if i < 6 else (D / 2 - 0.02, Hh + 0.008)
            put_coin(x, y, z, (rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), 1.0), True)
        _finish(coin_bms)
        parts.append(obj_from_bmesh(f"{name}_coins", coin_bms, coll, mat("Gold"), smooth=True))   # pillowed rims; flat split 3 verts per tri (v/t 1.83)
        # goblet: lathed foot, knopped stem and bowl
        prof = [(0.0, 0.0), (0.045, 0.0), (0.05, 0.008), (0.02, 0.02), (0.012, 0.05), (0.022, 0.065),
                (0.012, 0.08), (0.02, 0.095), (0.045, 0.12), (0.055, 0.17), (0.05, 0.172), (0.04, 0.125),
                (0.0, 0.11)]
        gb = bmesh.new()
        segG = 16
        ringsG = []
        for k in range(segG):
            a = 2 * math.pi * k / segG
            ringsG.append([gb.verts.new((r * math.cos(a), r * math.sin(a), z)) for r, z in prof])
        for k in range(segG):
            A, B = ringsG[k], ringsG[(k + 1) % segG]
            for j in range(len(prof) - 1):
                if prof[j][0] == 0.0 and prof[j + 1][0] == 0.0:
                    continue
                gb.faces.new((A[j], B[j], B[j + 1], A[j + 1]))
        bmesh.ops.remove_doubles(gb, verts=gb.verts, dist=1e-5)
        bmesh.ops.transform(gb, matrix=Matrix.Translation((0.30, 0.0, mound(0.30, 0.0) - 0.05)) @
                            Matrix.Rotation(0.18, 4, 'Y'), verts=gb.verts)
        _finish(gb)
        parts.append(obj_from_bmesh(f"{name}_goblet", gb, coll, mat("Gold"), smooth=True))
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
                               mat(woods[(face + i) % 4]), smooth=True)
            bevel_obj(o, width=0.008, segments=BEV_SEGS)
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
            o = obj_from_bmesh(f"{name}_bat{sx}{sy}", bm, coll, mat("Wood_Dark"), smooth=True)
            bevel_obj(o, width=0.012, segments=BEV_SEGS)
            apply_modifiers(o)
            parts.append(o)
    # nails: two per board end, driven through the battens on both faces of each corner
    for sx in (-1, 1):
        for sy in (-1, 1):
            for i in range(3):
                for k, dz in enumerate((-0.035, 0.035)):
                    z = plank_h * (i + 0.5) + dz
                    parts.append(add_rivet(coll, f"{name}_nx{sx}{sy}{i}{k}", (sx * (S / 2 + 0.046), sy * (S / 2 - 0.022), z),
                                           (sx, 0, 0), r=0.009, depth=0.012))
                    parts.append(add_rivet(coll, f"{name}_ny{sx}{sy}{i}{k}", (sx * (S / 2 - 0.022), sy * (S / 2 + 0.046), z),
                                           (0, sy, 0), r=0.009, depth=0.012))
    for i in range(3):   # lid boards nailed at both ends
        y = -S / 2 + (S / 3) * (i + 0.5)
        for sx in (-1, 1):
            parts.append(add_rivet(coll, f"{name}_nt{i}{sx}", (sx * S * 0.42, y, S + 0.006), (0, 0, 1),
                                   r=0.009, depth=0.012))
    obj = join(parts, name)
    return coll, obj


# ── campfire ─────────────────────────────────────────────────
def split_log(coll, name, r, length, mname, seed=0):
    """Charred split log: half-cylinder with flat split face, faceted."""
    rng = random.Random(seed)
    bm = bm_cylinder(r, r * 0.82, length, segs=14)
    bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges
                                         if abs(e.verts[0].co.z - e.verts[1].co.z) > length * 0.5],
                              cuts=5)
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
    bevel_obj(o, width=0.01, segments=BEV_SEGS)
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
        bm = bm_icosphere(r, 3)
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
                           smooth=True)
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
    for i in range(12):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.02, 0.19)
        bm = bm_icosphere(rng.uniform(0.03, 0.05), 1)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (r * math.cos(a), r * math.sin(a), 0.085)), verts=bm.verts)
        _finish(bm)
        parts.append(obj_from_bmesh(f"{name}_ember{i}", bm, coll, mat("Ember"),
                                    smooth=False))
    obj = join(parts, name)
    return coll, obj


# ── dock modules ─────────────────────────────────────────────
def _dense_box(w, d, h, nx, ny, nz):
    """Closed box centred at the origin, cut into nx x ny x nz cells (bisect planes), so a surface
    displacement has vertices to move (the buildings tier wants the wood grain IN the mesh)."""
    bm = bm_box(w, d, h)
    for axis, n, size in ((0, nx, w), (1, ny, d), (2, nz, h)):
        for k in range(1, n):
            co = [0.0, 0.0, 0.0]
            co[axis] = -size / 2 + size * k / n
            no = [0.0, 0.0, 0.0]
            no[axis] = 1.0
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                                   plane_co=Vector(co), plane_no=Vector(no))
    return bm


def _pile(x, y, z0, z1, r0, r1, rng, seed, wet_top=0.62):
    """One dock pile: 32-sided, ringed every 2 cm through the wet band and 6 cm above, with vertical
    grain grooves, a weathered taper, a chamfered crown and barnacle crowns (raised rims with a
    crater) displaced INTO the surface in the wet band: one closed part, so LOD decimation keeps it
    one shape instead of 30 loose spheres."""
    from mathutils import noise
    segs = 32
    zs = [z0 + k * 0.02 for k in range(int((wet_top - z0) / 0.02))]
    zz = wet_top
    while zz < z1 - 0.06:
        zs.append(zz)
        zz += 0.06
    zs += [z1 - 0.035, z1]
    bm = bmesh.new()
    rings = []
    barn = [(rng.uniform(0, 2 * math.pi), rng.uniform(z0 + 0.06, wet_top - 0.04), rng.uniform(0.018, 0.032))
            for _ in range(rng.randint(11, 16))]
    for zi, z in enumerate(zs):
        t = (z - z0) / (z1 - z0)
        rr = r0 + (r1 - r0) * t
        if zi == len(zs) - 1:
            rr -= 0.03                       # chamfered crown
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            groove = 0.006 * noise.noise(Vector((math.cos(a) * 3.0 + seed, math.sin(a) * 3.0, z * 0.6)))
            split = -0.010 if (k % 11 == seed % 11 and 0.2 < t < 0.9) else 0.0
            dr = groove + split
            for ba, bz, brad in barn:
                da = math.atan2(math.sin(a - ba), math.cos(a - ba)) * rr
                dd = math.hypot(da, z - bz) / brad
                if dd < 1.0:                   # volcano: rim up, crater down
                    dr += brad * 0.55 * (math.sin(dd * math.pi) * 0.9 - (0.35 if dd < 0.35 else 0.0))
            ring.append(bm.verts.new((x + (rr + dr) * math.cos(a), y + (rr + dr) * math.sin(a), z)))
        rings.append(ring)
    for r_a, r_b in zip(rings, rings[1:]):
        for k in range(segs):
            bm.faces.new((r_a[k], r_a[(k + 1) % segs], r_b[(k + 1) % segs], r_b[k]))
    bm.faces.new(list(reversed(rings[0])))
    top = bm.verts.new((x, y, z1 + 0.005))
    for k in range(segs):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % segs], top))
    _finish(bm)
    return bm


def _lashing(x, y, zc, rad, turns=3, pitch=0.045, rope_r=0.021, steps=30, sides=8):
    """Rope lashing: a closed helical tube wound `turns` times round a pile (capped ends)."""
    bm = bmesh.new()
    n = int(turns * steps)
    rings = []
    for i in range(n + 1):
        th = 2 * math.pi * i / steps
        z = zc + pitch * (i / steps - turns / 2)
        c = Vector((x + rad * math.cos(th), y + rad * math.sin(th), z))
        tng = Vector((-math.sin(th) * rad * 2 * math.pi, math.cos(th) * rad * 2 * math.pi, pitch)).normalized()
        nrm = Vector((math.cos(th), math.sin(th), 0))
        bi = tng.cross(nrm).normalized()
        nrm = bi.cross(tng).normalized()
        twist = 0.004 * math.sin(i * 1.9)      # laid strands: the tube breathes a little
        rings.append([bm.verts.new(c + (rope_r + twist) * (math.cos(2 * math.pi * k / sides) * nrm +
                                                            math.sin(2 * math.pi * k / sides) * bi))
                      for k in range(sides)])
    for r_a, r_b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((r_a[k], r_a[(k + 1) % sides], r_b[(k + 1) % sides], r_b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    _finish(bm)
    return bm


def build_dock(name, length=6.0, end_cap=False):
    """Tiling dock module, buildings tier (25-60k, LOD chain). CONTRACT (it tiles, keep it EXACT):
    X extent exactly [-L/2, L/2] (stringers + plank run), section as v1 (piles at y=+/-1.4, rope
    lashing outer |y| <= 1.57, deck z=1.1, piles to z=1.85). v2: dense weathered planks (cupped,
    grain-waved, chipped ends, gaps, nailed at both stringers), 32-sided piles with grain grooves,
    splits and barnacle crowns in the wet band, 3-turn rope lashings, pile caps across each bent,
    X-bracing along both sides and across each bent, cleats, and bollards on the end module."""
    from mathutils import noise
    coll = asset_collection(name)
    rng = random.Random(len(name))
    parts = []
    deck_z = 1.1
    width = 3.0
    n = round(length / 0.55)
    plank_w = length / n  # spacing covers the EXACT module length (tiling)
    str_y = width / 2 - 0.35
    for i in range(n):
        x = -length / 2 + plank_w * (i + 0.5)
        pw, pd, ph = plank_w * 0.88, width * rng.uniform(0.95, 1.0), 0.09
        bm = _dense_box(pw, pd, ph, 6, 40, 2)
        seed = rng.uniform(0, 100)
        for v in bm.verts:
            u = v.co.x / (pw / 2)                       # -1..1 across the plank
            cup = 0.004 * u * u                          # weathered boards cup: edges rise
            grain = 0.0025 * noise.noise(Vector((v.co.x * 9.0 + seed, v.co.y * 0.9, seed)))
            if v.co.z > 0:
                v.co.z += cup + grain
            if abs(v.co.x) < pw / 2 - 1e-4:              # side faces stay put; inner verts may wander
                continue
            v.co.x += 0.0015 * noise.noise(Vector((seed, v.co.y * 1.7, v.co.z * 5.0)))
        if i in (1, n - 2):
            sy = 1 if i % 2 else -1
            chip_corner(bm, (pw * 0.30, sy * pd * 0.47, 0.012), (0.6, sy, 0.9))
        y_off = rng.uniform(-0.01, 0.01)
        M = (Matrix.Translation((x, y_off, deck_z + rng.uniform(-0.004, 0.004))) @
             Matrix.Rotation(rng.uniform(-0.012, 0.012), 4, 'Z') @ Matrix.Rotation(rng.uniform(-0.004, 0.004), 4, 'X'))
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        _finish(bm)
        m = "Wood_Bleached" if i % 3 else "Wood_Light"
        o = obj_from_bmesh(f"{name}_plank{i}", bm, coll, mat(m))
        bevel_obj(o, width=0.010)
        apply_modifiers(o)
        parts.append(o)
        for sy in (-1, 1):                               # two nails into each stringer, set on the
            for dx in (-0.11, 0.11):                     # displaced top (same cup + grain function)
                ly = sy * str_y - y_off
                uu = dx / (pw / 2)
                top_z = ph / 2 + 0.004 * uu * uu + 0.0025 * noise.noise(Vector((dx * 9.0 + seed, ly * 0.9, seed)))
                parts.append(add_rivet(coll, f"{name}_nail{i}{sy}{dx:+.2f}",
                                       M @ Vector((dx, ly, top_z + 0.0005)), M.to_3x3() @ Vector((0, 0, 1)),
                                       r=0.008, depth=0.002, segs=6))
    # piles (bents of two), each with a rope lashing under the deck lip
    xs = [-length / 2 + 0.4, 0, length / 2 - 0.4]
    py_ = width / 2 - 0.1
    for xi, x in enumerate(xs):
        for sy in (-1, 1):
            py = sy * py_
            seed = xi * 7 + (sy + 1)
            bm = _pile(x, py, 0.0, deck_z + 0.75, 0.145, 0.115, rng, seed)
            parts.append(obj_from_bmesh(f"{name}_pile{xi}{sy}", bm, coll, mat("Wood_Dark"), smooth=True))
            zc = deck_z + 0.46
            r_here = 0.145 + (0.115 - 0.145) * zc / (deck_z + 0.75)
            parts.append(obj_from_bmesh(f"{name}_lash{xi}{sy}", _lashing(x, py, zc, r_here + 0.020),
                                        coll, mat("Rope"), smooth=True))
            # wet stain band: a thin dark sleeve would z-fight; the AO bake + barnacles carry it
        # pile cap (header) across the bent, under the stringers
        cap = _dense_box(0.20, 2 * py_ - 0.05, 0.18, 2, 16, 2)
        bmesh.ops.transform(cap, matrix=Matrix.Translation((x, 0, deck_z - 0.29)), verts=cap.verts)
        _finish(cap)
        o = obj_from_bmesh(f"{name}_capb{xi}", cap, coll, mat("Wood_Dark"))
        bevel_obj(o, width=0.012)
        apply_modifiers(o)
        parts.append(o)
        # X-brace across the bent (between the two piles of the pair)
        for k, (za, zb) in enumerate(((0.35, deck_z - 0.42), (deck_z - 0.42, 0.35))):
            a = Vector((x + (0.16 if k == 0 else 0.21), -py_ + 0.1, za))
            b = Vector((a.x, py_ - 0.1, zb))
            v = b - a
            # square 9 cm timbers, unbevelled 12-tri boxes: build_lods leaves them whole (a round
            # brace collapsed flat and its area rescale stretched the LOD to |y| 1.84 vs 1.56)
            parts.append(add_box(coll, f"{name}_xb{xi}{k}", 0.09, 0.09, v.length, (a + b) / 2, "Wood_Dark",
                                 rot=v.to_track_quat('Z', 'Y').to_matrix().to_4x4(), bevel=0))
    # stringers (define the EXACT X extent)
    for sy in (-1, 1):
        sb = _dense_box(length, 0.18, 0.16, 30, 2, 2)
        bmesh.ops.transform(sb, matrix=Matrix.Translation((0, sy * str_y, deck_z - 0.12)), verts=sb.verts)
        _finish(sb)
        o = obj_from_bmesh(f"{name}_str{sy}", sb, coll, mat("Wood_Dark"))
        bevel_obj(o, width=0.015)
        apply_modifiers(o)
        parts.append(o)
    # X-bracing along both sides between neighbouring bents
    for xi in range(len(xs) - 1):
        x, x2 = xs[xi], xs[xi + 1]
        for sy in (-1, 1):
            py = sy * (py_ - 0.17)
            for k, (za, zb) in enumerate(((0.25, deck_z - 0.40), (deck_z - 0.40, 0.25))):
                a, b = Vector((x + 0.12, py, za)), Vector((x2 - 0.12, py + sy * 0.0, zb))
                v = b - a
                parts.append(add_box(coll, f"{name}_brace{xi}{sy}{k}", 0.10, 0.10, v.length,
                                     (a + b) / 2 + Vector((0, sy * 0.05 * k, 0)), "Wood_Dark",
                                     rot=v.to_track_quat('Z', 'Y').to_matrix().to_4x4(), bevel=0))
    # mooring cleats on deck edges (T-shape)
    cleat_xs = [-length / 2 + 1.0, length / 2 - 1.0]
    for ci, cx in enumerate(cleat_xs):
        sy = -1 if ci % 2 else 1
        cy = sy * (width / 2 - 0.22)
        parts.append(add_box(coll, f"{name}_cleatb{ci}", 0.10, 0.10, 0.14,
                             (cx, cy, deck_z + 0.10), "Wood_Dark", bevel=0.012))
        parts.append(add_cyl(coll, f"{name}_cleatt{ci}", 0.045, 0.035, 0.34,
                             (cx, cy, deck_z + 0.18), "Wood_Dark", segs=12,
                             rot=Matrix.Rotation(math.pi / 2, 4, 'Y'), bevel=0.01))
    if end_cap:
        # end bumper board across the outer end (inside the exact length) + two bollards
        parts.append(add_box(coll, f"{name}_bumper", 0.10, width * 0.92, 0.28,
                             (length / 2 - 0.05, 0, deck_z - 0.02), "Wood_Dark", bevel=0.015))
        for sy in (-1, 1):
            parts.append(add_cyl(coll, f"{name}_bollard{sy}", 0.12, 0.10, 0.42,
                                 (length / 2 - 0.30, sy * 0.95, deck_z + 0.25), "Wood_Dark", segs=20,
                                 bevel=0.02))
            parts.append(add_cyl(coll, f"{name}_bollcap{sy}", 0.14, 0.14, 0.05,
                                 (length / 2 - 0.30, sy * 0.95, deck_z + 0.47), "Metal_Iron", segs=20,
                                 bevel=0.01))
    obj = join(parts, name)
    return coll, obj


# ── build, bake, export, verify, render ──────────────────────
_ALL = [
    ("barrel", lambda: build_barrel("barrel")),
    ("keg", lambda: build_keg("keg")),
    ("chest_closed", lambda: build_chest("chest_closed", False)),
    ("chest_open", lambda: build_chest("chest_open", True)),
    ("crate", lambda: build_crate("crate")),
    ("campfire", lambda: build_campfire("campfire")),
    ("dock_mid", lambda: build_dock("dock_mid", 6.0)),
    ("dock_end", lambda: build_dock("dock_end", 4.0, True)),
]
# PROPS_ONLY=barrel,chest_open rebuilds (and re-exports) only those keys; the rest stay on disk untouched.
_ONLY = {k.strip() for k in os.environ.get("PROPS_ONLY", "").split(",") if k.strip()}
BUILDS = [f() for k, f in _ALL if not _ONLY or k in _ONLY]

for coll, obj in BUILDS:
    bake_ao(coll)
    path = export_collection_vc(coll, f"{obj.name}.glb")
    verify_glb(path)
    # isolate for the turntable: hide every other asset collection
    for c2, _ in BUILDS:
        c2.hide_render = (c2 is not coll)
    render_turntable(coll, obj.name, RENDER_DIR)

print("PROPS DONE")
