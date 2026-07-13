# Island buildings: a half-timbered pirate TAVERN (7.6 x 6.4, seated gable roof
# with individual shingle rows, sagging ridge, round stone chimney) and a small
# market STALL/shop with a sagging scalloped canopy + produce. Front (door /
# counter) faces Blender -Y  (= game +Z). Origin at ground, floor top at +0.18.
# Headless: Blender -b -P scripts/blender/build_buildings.py
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get(
    "BR_RENDER_DIR",
    "/private/tmp/claude-501/-Users-tobiasdicker/41616ba1-624a-493b-a065-3ec5830f1dbe/scratchpad/renders/u-buildings/round1")

EXTRA = {
    "Plaster":   ((0.80, 0.72, 0.56, 1.0), 0.92, 0.0),   # daub infill between timbers
    "Timber":    ((0.24, 0.15, 0.09, 1.0), 0.9, 0.0),    # dark oak framing
    "Shingle":   ((0.34, 0.24, 0.16, 1.0), 0.92, 0.0),   # wood-shingle roof
    "Shingle_Lt":((0.44, 0.32, 0.2, 1.0), 0.92, 0.0),
    "Awning_Red":((0.62, 0.2, 0.16, 1.0), 0.9, 0.0),
    "Awning_Cream":((0.86, 0.8, 0.66, 1.0), 0.9, 0.0),
    "GlassWarm": ((0.98, 0.78, 0.4, 1.0), 0.2, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)
# GlassWarm emits so windows glow.
_gw = mat("GlassWarm")
_gw.node_tree.nodes.get("Principled BSDF").inputs["Emission Color"].default_value = (0.98, 0.7, 0.32, 1.0)
_gw.node_tree.nodes.get("Principled BSDF").inputs["Emission Strength"].default_value = 2.4


def bm_bevel(bm, width=0.02):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=1, profile=0.72, affect='EDGES', clamp_overlap=True)
    return bm


def box(coll, name, w, d, h, x, y, z, material, rot=None, bev=0.0, smooth=False):
    bm = bm_box(w, d, h)
    if bev > 0:
        bm_bevel(bm, bev)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=smooth)


def cyl(coll, name, r1, r2, depth, x, y, z, material, segs=12, rot=None, smooth=True):
    bm = bm_cylinder(r1, r2, depth, segs=segs)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=smooth)


def blob(coll, name, r, x, y, z, material, subdiv=1, scale=(1, 1, 1)):
    bm = bm_icosphere(r, subdiv)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, z)), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def plaster_box(coll, name, w, d, h, x, y, z, cuts=5, seed=5, strength=0.06):
    """Subdivided box with low displace = wattle-and-daub lumpiness."""
    bm = bm_box(w, d, h)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, z)), verts=bm.verts)
    obj = obj_from_bmesh(name, bm, coll, mat("Plaster"))
    displace_noise(obj, strength=strength, scale=0.8, seed=seed)
    apply_modifiers(obj)
    return obj


def barrel(coll, name, x, y, z, r=0.30, h=0.78, rot_z=0.0, tilt=0.0):
    """Bulged rum barrel with iron bands."""
    parts = []
    rot = Matrix.Rotation(rot_z, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'X')
    for sz, z0 in ((1, h * 0.25), (-1, -h * 0.25)):
        bm = bm_cylinder(r, r * 0.85, h * 0.5, segs=12)
        if sz < 0:
            bmesh.ops.scale(bm, vec=Vector((1, 1, -1)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, z0)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, z + h * 0.5)) @ rot,
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_b{sz}", bm, coll, mat("Wood_Mid"), smooth=True))
    for bz in (-h * 0.32, 0.0, h * 0.32):
        bm = bm_cylinder(r * 1.03 - abs(bz) / h * r * 0.24, r * 1.03 - abs(bz) / h * r * 0.24,
                         0.05, segs=12)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((x, y, z + h * 0.5)) @ rot @
                            Matrix.Translation((0, 0, bz)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_band{bz:.2f}", bm, coll, mat("Metal_Iron"), smooth=True))
    return parts


def crate(coll, name, s, x, y, z, rot_z, material="Wood_Mid"):
    parts = [box(coll, name, s, s, s * 0.86, x, y, z + s * 0.43, material,
                 rot=Matrix.Rotation(rot_z, 4, 'Z'), bev=0.015)]
    # corner trim battens
    rot = Matrix.Rotation(rot_z, 4, 'Z')
    for sx in (-1, 1):
        for sy in (-1, 1):
            off = rot @ Vector((sx * s * 0.5, sy * s * 0.5, 0))
            parts.append(box(coll, f"{name}_c{sx}{sy}", 0.06, 0.06, s * 0.9,
                             x + off.x, y + off.y, z + s * 0.45, "Wood_Dark",
                             rot=rot, bev=0.01))
    return parts


def build_tavern(name="tavern"):
    coll = asset_collection(name)
    rng = random.Random(11)
    W, D = 7.6, 6.4          # footprint contract — EXACT
    floorTop = 0.18
    wallH = 3.0
    wallTop = floorTop + wallH
    th = 0.2
    parts = []

    # ── plank-groove floor / footing ──
    parts.append(box(coll, "footing", W + 0.9, D + 0.9, 0.14, 0, 0, 0.07, "Rock_Grey", bev=0.03))
    nplank = 12
    pw = (D + 0.6) / nplank
    for i in range(nplank):
        py = -(D + 0.6) * 0.5 + (i + 0.5) * pw
        pl = "Wood_Mid" if i % 3 else "Wood_Dark"
        parts.append(box(coll, f"floor{i}", W + 0.6 - rng.uniform(0, 0.06), pw * 0.92,
                         floorTop - 0.02, rng.uniform(-0.03, 0.03), py,
                         floorTop * 0.5 + rng.uniform(-0.006, 0.006), pl, bev=0.012))

    # ── plaster walls (daub infill, lumpy) ──
    parts.append(plaster_box(coll, "wall_back", W, th, wallH, 0, D * 0.5, floorTop + wallH * 0.5, seed=5))
    for sx in (-1, 1):
        parts.append(plaster_box(coll, f"wall_side{sx}", th, D, wallH, sx * W * 0.5, 0,
                                 floorTop + wallH * 0.5, seed=6 + sx))
    # front wall split around a door (position/clearance as-is)
    doorW = 1.7
    sideW = (W - doorW) * 0.5
    for sx in (-1, 1):
        parts.append(plaster_box(coll, f"wall_front{sx}", sideW, th, wallH,
                                 sx * (W * 0.5 - sideW * 0.5), -D * 0.5,
                                 floorTop + wallH * 0.5, seed=9 + sx))
    parts.append(box(coll, "lintel", doorW + 0.3, th + 0.08, 0.5, 0, -D * 0.5, wallTop - 0.25, "Timber", bev=0.02))
    parts.append(box(coll, "door", doorW - 0.1, 0.08, wallH - 0.5, 0, -D * 0.5 - 0.04,
                     floorTop + (wallH - 0.5) * 0.5, "Wood_Dark", bev=0.015))
    # door planks + iron hinges + handle
    for i in range(3):
        parts.append(box(coll, f"doorp{i}", 0.05, 0.03, wallH - 0.6, -0.5 + i * 0.5,
                         -D * 0.5 - 0.09, floorTop + (wallH - 0.5) * 0.5, "Wood_Dark", bev=0.008))
    for hz in (0.8, 2.2):
        parts.append(box(coll, f"hinge{hz}", 0.9, 0.03, 0.09, -0.3, -D * 0.5 - 0.10,
                         floorTop + hz, "Metal_Iron", bev=0.008))
    parts.append(box(coll, "handle", 0.06, 0.08, 0.22, 0.6, -D * 0.5 - 0.11, floorTop + 1.25, "Metal_Iron", bev=0.01))
    # door frame jambs
    for sx in (-1, 1):
        parts.append(box(coll, f"jamb{sx}", 0.16, th + 0.1, wallH - 0.3, sx * doorW * 0.5,
                         -D * 0.5, floorTop + (wallH - 0.3) * 0.5, "Timber", bev=0.02))

    # ── half-timber framing: beveled posts + sill/mid/top rails + braces.
    #    Members must be DEEPER than the wall (th 0.2 + displace) to protrude. ──
    td = 0.36  # timber depth through the wall — protrudes ~0.08 each side
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(box(coll, f"post{sx}{sz}", 0.34, 0.34, wallH + 0.1,
                             sx * (W * 0.5 - 0.02), sz * (D * 0.5 - 0.02),
                             floorTop + wallH * 0.5, "Timber", bev=0.03))
    for ry, rn in ((floorTop + 0.15, "sill"), (floorTop + wallH * 0.55, "mid"), (wallTop - 0.05, "top")):
        parts.append(box(coll, f"rail_b_{rn}", W, td, 0.18, 0, D * 0.5, ry, "Timber", bev=0.025))
        parts.append(box(coll, f"rail_f_{rn}", W, td, 0.18, 0, -D * 0.5, ry, "Timber", bev=0.025))
        for sx in (-1, 1):
            parts.append(box(coll, f"rail_s{sx}_{rn}", td, D, 0.18, sx * W * 0.5, 0, ry, "Timber", bev=0.025))
    # diagonal braces on side + front walls
    for sx in (-1, 1):
        rot = Matrix.Rotation(math.radians(38), 4, 'X')
        parts.append(box(coll, f"brace{sx}", td, 2.4, 0.15, sx * W * 0.5, D * 0.24,
                         floorTop + wallH * 0.5, "Timber", rot, bev=0.02))
        rotf = Matrix.Rotation(sx * math.radians(-30), 4, 'Y')
        parts.append(box(coll, f"bracef{sx}", 1.5, td, 0.15, sx * 1.55, -D * 0.5,
                         floorTop + 0.78, "Timber", rotf, bev=0.02))
    # vertical studs on the front wall
    for sx in (-1, 1):
        for xi in (1.9, 3.0):
            parts.append(box(coll, f"stud{sx}{xi}", 0.14, td, wallH - 0.2, sx * xi,
                             -D * 0.5, floorTop + wallH * 0.5 - 0.05, "Timber", bev=0.018))

    # ── shuttered windows (glow) on side + front walls, with window boxes ──
    def window(tag, x, y, z, along_x):
        # along_x: window face normal is +-X (side wall) else -Y (front wall)
        if along_x:
            parts.append(box(coll, f"win{tag}", th + 0.06, 1.0, 1.0, x, y, z, "GlassWarm"))
            parts.append(box(coll, f"mulH{tag}", th + 0.1, 1.04, 0.06, x, y, z, "Timber", bev=0.008))
            parts.append(box(coll, f"mulV{tag}", th + 0.1, 0.06, 1.04, x, y, z, "Timber", bev=0.008))
            sxd = 1 if x > 0 else -1
            for sh in (-1, 1):
                rot = Matrix.Rotation(sh * math.radians(6), 4, 'Z')
                parts.append(box(coll, f"shut{tag}_{sh}", 0.05, 0.5, 1.05, x + sxd * 0.17,
                                 y + sh * 0.66, z, "Wood_Dark", rot, bev=0.01))
            parts.append(box(coll, f"wbox{tag}", 0.3, 1.16, 0.24, x + sxd * 0.2, y, z - 0.66, "Wood_Dark", bev=0.015))
            for i in range(3):
                parts.append(blob(coll, f"wleaf{tag}{i}", 0.13, x + sxd * 0.24,
                                  y - 0.36 + i * 0.36, z - 0.5, "Leaf_Green",
                                  scale=(1, 1.15, 0.8)))
        else:
            parts.append(box(coll, f"win{tag}", 1.0, th + 0.06, 1.0, x, y, z, "GlassWarm"))
            parts.append(box(coll, f"mulH{tag}", 1.04, th + 0.1, 0.06, x, y, z, "Timber", bev=0.008))
            parts.append(box(coll, f"mulV{tag}", 0.06, th + 0.1, 1.04, x, y, z, "Timber", bev=0.008))
            for sh in (-1, 1):
                rot = Matrix.Rotation(sh * math.radians(-8), 4, 'Z')
                parts.append(box(coll, f"shut{tag}_{sh}", 0.5, 0.05, 1.05, x + sh * 0.66,
                                 y - 0.13, z, "Wood_Dark", rot, bev=0.01))
            parts.append(box(coll, f"wbox{tag}", 1.16, 0.3, 0.24, x, y - 0.2, z - 0.66, "Wood_Dark", bev=0.015))
            for i in range(3):
                parts.append(blob(coll, f"wleaf{tag}{i}", 0.13, x - 0.36 + i * 0.36,
                                  y - 0.24, z - 0.5, "Leaf_Green", scale=(1.15, 1, 0.8)))

    for sx in (-1, 1):
        window(f"s{sx}", sx * W * 0.5, -D * 0.12, floorTop + 1.6, True)
    for sx in (-1, 1):
        window(f"f{sx}", sx * 2.55, -D * 0.5, floorTop + 1.75, False)

    # ── SEATED gable roof with SAGGING ridge + individual shingle rows ──
    rise = 1.9
    eave = 0.6
    half = D * 0.5 + eave
    slabLen = math.hypot(half, rise)
    slope = math.atan2(rise, half)
    SAG = 0.13

    def sag(x):
        t = max(0.0, 1.0 - (2.0 * x / W) ** 2)
        return SAG * t

    for sz in (-1, 1):
        rot = Matrix.Rotation(-sz * slope, 4, 'X')
        cy = sz * half * 0.5
        cz = wallTop + rise * 0.5
        Mslab = Matrix.Translation((0, cy, cz)) @ rot
        # under-slab (stops see-through between shingles), sagged toward ridge
        bm = bm_box(W + 1.0, slabLen + 0.05, 0.12)
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=7, use_grid_fill=True)
        for v in bm.verts:
            ridge_t = min(1.0, max(0.0, 0.5 - sz * v.co.y / slabLen))
            v.co.z -= sag(v.co.x) * ridge_t
        bmesh.ops.transform(bm, matrix=Mslab, verts=bm.verts)
        parts.append(obj_from_bmesh(f"roofslab{sz}", bm, coll, mat("Shingle")))
        # shingle rows: strips of thin boxes with per-shingle jitter
        nrows = 9
        rowL = slabLen / nrows
        for row in range(nrows):
            t = (row + 0.5) / nrows          # 0 = eave, 1 = ridge
            yloc = sz * (0.5 - t) * slabLen
            ncol = 19
            colW = (W + 1.0) / ncol
            stag = (row % 2) * colW * 0.5
            for c in range(ncol + (row % 2)):
                xloc = -(W + 1.0) * 0.5 + (c + 0.5) * colW - stag
                if xloc < -(W + 1.0) * 0.5 - 0.01 or xloc > (W + 1.0) * 0.5 + 0.01:
                    continue
                sw = colW * rng.uniform(0.86, 0.98)
                sl = rowL + 0.12
                bm = bm_box(sw, sl, 0.055)
                jr = (Matrix.Rotation(rng.uniform(-0.05, 0.05), 4, 'X') @
                      Matrix.Rotation(rng.uniform(-0.035, 0.035), 4, 'Z'))
                zj = 0.09 + rng.uniform(-0.012, 0.012) - sag(xloc) * t
                bmesh.ops.transform(bm, matrix=Matrix.Translation((xloc, yloc, zj)) @ jr,
                                    verts=bm.verts)
                bmesh.ops.transform(bm, matrix=Mslab, verts=bm.verts)
                mname = "Shingle_Lt" if rng.random() < 0.30 else "Shingle"
                parts.append(obj_from_bmesh(f"sh{sz}_{row}_{c}", bm, coll, mat(mname)))
    # sagging ridge beam
    bm = bm_box(W + 1.0, 0.26, 0.26)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=8, use_grid_fill=True)
    for v in bm.verts:
        v.co.z -= sag(v.co.x)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, wallTop + rise + 0.04)), verts=bm.verts)
    parts.append(obj_from_bmesh("ridge", bm, coll, mat("Timber")))
    # gable end triangles at x = +-W/2 (fill under the roof planes)
    for sx in (-1, 1):
        bm = bmesh.new()
        v = [bm.verts.new(p) for p in [(sx * W * 0.5, -D * 0.5, wallTop),
                                       (sx * W * 0.5, D * 0.5, wallTop),
                                       (sx * W * 0.5, 0, wallTop + rise - 0.02)]]
        bm.faces.new(v)
        res = bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.16)
        parts.append(obj_from_bmesh(f"gable{sx}", bm, coll, mat("Plaster")))
        # gable timber battens (king post + rakes hugging the roof edge line)
        parts.append(box(coll, f"gking{sx}", 0.14, 0.20, rise - 0.15, sx * (W * 0.5 - 0.02), 0,
                         wallTop + rise * 0.5 - 0.1, "Timber", bev=0.015))
        for sy in (-1, 1):
            rot = Matrix.Rotation(-sy * slope, 4, 'X')
            parts.append(box(coll, f"grake{sx}{sy}", 0.14, slabLen * 0.9, 0.14,
                             sx * (W * 0.5 - 0.02), sy * half * 0.48,
                             wallTop + rise * 0.5 - 0.16, "Timber", rot, bev=0.012))
    # eave fascia
    for sz in (-1, 1):
        parts.append(box(coll, f"fascia{sz}", W + 1.1, 0.14, 0.30, 0, sz * half,
                         wallTop + 0.02, "Timber", bev=0.02))

    # ── ROUND stone chimney with banding, breaking the roofline ──
    chx, chy = W * 0.32, D * 0.34
    chTop = wallTop + rise + 1.05
    bm = bm_cylinder(0.58, 0.46, chTop, segs=12)
    bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges
                                         if abs(e.verts[0].co.z - e.verts[1].co.z) > 0.1],
                              cuts=5)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((chx, chy, chTop * 0.5)), verts=bm.verts)
    chim = obj_from_bmesh("chimney", bm, coll, mat("Rock_Grey"), smooth=False)
    displace_noise(chim, strength=0.06, scale=0.5, seed=17)
    apply_modifiers(chim)
    parts.append(chim)
    for i, bz in enumerate((1.3, 2.9, 4.3)):
        rr = 0.58 - (bz / chTop) * 0.12
        parts.append(cyl(coll, f"chband{i}", rr + 0.13, rr + 0.10, 0.30, chx, chy, bz,
                         "Rock_Dark", segs=12, smooth=False))
    parts.append(cyl(coll, "chimcap", 0.62, 0.56, 0.26, chx, chy, chTop, "Rock_Dark", segs=12, smooth=False))
    parts.append(cyl(coll, "chimhole", 0.32, 0.32, 0.12, chx, chy, chTop + 0.12, "Char_Black", segs=10))

    # ── hanging tavern sign on a wall bracket with chains (protrudes -Y) ──
    bx = -W * 0.5 + 0.7
    parts.append(box(coll, "signarm", 0.12, 1.15, 0.12, bx, -D * 0.5 - 0.45, wallTop - 0.12, "Timber", bev=0.015))
    rot = Matrix.Rotation(math.radians(-42), 4, 'X')
    parts.append(box(coll, "signstrut", 0.09, 0.85, 0.09, bx, -D * 0.5 - 0.28, wallTop - 0.42, "Timber", rot, bev=0.012))
    sy = -D * 0.5 - 0.78
    for sxo in (-0.32, 0.32):
        for li in range(3):
            rotl = Matrix.Rotation((li % 2) * math.pi * 0.5, 4, 'X')
            parts.append(cyl(coll, f"chain{sxo}{li}", 0.028, 0.028, 0.10, bx + sxo, sy,
                             wallTop - 0.26 - li * 0.09, "Metal_Iron", segs=6, rot=rotl))
    rot = Matrix.Rotation(math.radians(5), 4, 'Y')
    parts.append(box(coll, "signboard", 0.95, 0.07, 0.62, bx, sy, wallTop - 0.82, "Wood_Bleached", rot, bev=0.02))
    parts.append(box(coll, "signtrim", 1.02, 0.06, 0.1, bx, sy, wallTop - 0.54, "Wood_Dark", rot, bev=0.01))
    parts.append(box(coll, "signmug", 0.28, 0.09, 0.3, bx - 0.08, sy - 0.04, wallTop - 0.85, "Wood_Dark", rot, bev=0.015))

    # ── barrel + crate triad at the door (right side, door clearance kept) ──
    parts += barrel(coll, "bar1", 2.05, -D * 0.5 - 0.55, 0.0, r=0.31, h=0.82, rot_z=0.4)
    parts += crate(coll, "crt1", 0.62, 2.85, -D * 0.5 - 0.35, 0.14, math.radians(14))
    parts += crate(coll, "crt2", 0.44, 2.62, -D * 0.5 - 0.78, 0.14 + 0.54, math.radians(-9), "Wood_Dark")
    parts += barrel(coll, "bar2", -1.85, -D * 0.5 - 0.42, 0.02, r=0.24, h=0.6,
                    rot_z=1.2, tilt=math.radians(4))

    join(parts, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR)
    print(f"built {name}")
    return coll


def build_stall(name="stall"):
    coll = asset_collection(name)
    rng = random.Random(23)
    parts = []
    W, D, H = 2.6, 1.3, 2.4
    # counter (plank front + top)
    parts.append(box(coll, "counter", W, D, 1.0, 0, -0.1, 0.5, "Wood_Mid", bev=0.015))
    nt = 5
    for i in range(nt):
        tw = (W + 0.2) / nt
        parts.append(box(coll, f"ctop{i}", tw * 0.94, D + 0.24, 0.09,
                         -(W + 0.2) * 0.5 + (i + 0.5) * tw, -0.1,
                         1.05 + rng.uniform(-0.006, 0.006), "Wood_Dark", bev=0.012))
    for i in range(5):
        pw = W / 5
        parts.append(box(coll, f"cfront{i}", pw * 0.9, 0.1, 0.82, -W * 0.5 + (i + 0.5) * pw,
                         -0.1 - D * 0.5, 0.48 + rng.uniform(-0.01, 0.01), "Timber", bev=0.012))
    # four beveled posts (slight lean on one); tops meet the tilted canopy plane
    for k, (sx, sz) in enumerate(((-1, -1), (-1, 1), (1, -1), (1, 1))):
        py = 0.4 + sz * (D * 0.5)
        ph = H + 0.28 + (py - 0.15) * math.tan(math.radians(14)) - 0.04
        rot = Matrix.Rotation(math.radians(2.5 if k == 2 else 0), 4, 'Y')
        parts.append(box(coll, f"post{sx}{sz}", 0.13, 0.13, ph, sx * (W * 0.5 - 0.05),
                         py, ph * 0.5, "Timber", rot, bev=0.02))
    # cross rails between rear posts
    parts.append(box(coll, "rail_r", W - 0.1, 0.09, 0.09, 0, 0.4 + D * 0.5, H - 0.35, "Timber", bev=0.012))

    # ── sagging canopy: subdivided grid + sag/wave, solidified ──
    cw, cd = W + 0.7, D + 1.5
    Mcan = Matrix.Translation((0, 0.15, H + 0.28)) @ Matrix.Rotation(math.radians(14), 4, 'X')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=22, y_segments=14, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((cw * 0.5, cd * 0.5, 1.0)), verts=bm.verts)
    for v in bm.verts:
        tx = v.co.x / (cw * 0.5)          # -1..1
        ty = v.co.y / (cd * 0.5)          # -1 front .. 1 back
        sagc = 0.20 * (1 - tx * tx) * (1 - ty * ty)           # center belly
        ripple = 0.04 * math.sin(tx * math.pi * 3.2) * max(0.0, -ty)  # free front edge flutter
        v.co.z = -sagc + ripple
    bmesh.ops.transform(bm, matrix=Mcan, verts=bm.verts)   # +14 deg: front edge drops
    canopy = obj_from_bmesh("canopy", bm, coll, mat("Awning_Red"), smooth=True)
    sol = canopy.modifiers.new("Solid", 'SOLIDIFY')
    sol.thickness = 0.045
    apply_modifiers(canopy)
    parts.append(canopy)

    # ── curved scallops (9) along the front eave, placed via the canopy matrix ──
    ns = 9
    for i in range(ns):
        lx = -cw * 0.5 + (i + 0.5) * cw / ns
        p = Mcan @ Vector((lx, -cd * 0.5, 0.04 * math.sin(lx / (cw * 0.5) * math.pi * 3.2)))
        rot = Matrix.Rotation(math.pi * 0.5, 4, 'X')
        parts.append(cyl(coll, f"scal{i}", cw / ns * 0.52, cw / ns * 0.52, 0.05,
                         p.x, p.y, p.z - 0.03, "Awning_Cream", segs=12, rot=rot))
    # hem strip hiding scallop tops, following the front edge
    ph = Mcan @ Vector((0, -cd * 0.5 + 0.02, 0))
    parts.append(box(coll, "hem", cw + 0.02, 0.07, 0.18, ph.x, ph.y, ph.z + 0.03,
                     "Awning_Cream", Matrix.Rotation(math.radians(14), 4, 'X')))

    # ── produce / goods dressing on the counter ──
    parts += crate(coll, "pcrate", 0.5, -0.78, -0.28, 1.09, math.radians(10))
    for i in range(6):
        a = i * 1.05
        parts.append(blob(coll, f"apple{i}", 0.095, -0.78 + 0.13 * math.cos(a) * (1 + i % 2),
                          -0.28 + 0.13 * math.sin(a), 1.56 + (0.05 if i > 3 else 0), "Keg_Red"))
    for i in range(4):
        parts.append(blob(coll, f"green{i}", 0.13, 0.35 + (i % 2) * 0.24, -0.44 + (i // 2) * 0.26,
                          1.16, "Leaf_Green", scale=(1, 1, 0.75)))
    # sack (leaning, canvas)
    sk = blob(coll, "sack", 0.26, 1.0, -0.25, 1.32, "Canvas", subdiv=2, scale=(1, 0.9, 1.15))
    displace_noise(sk, strength=0.05, scale=0.4, seed=9)
    apply_modifiers(sk)
    parts.append(sk)
    parts.append(cyl(coll, "sackneck", 0.09, 0.05, 0.14, 1.0, -0.25, 1.62, "Canvas", segs=8))
    # two bottles
    for i, bx in enumerate((-0.15, 0.02)):
        parts.append(cyl(coll, f"bottle{i}", 0.055, 0.05, 0.26, bx, -0.62, 1.23, "GlassWarm", segs=8))
        parts.append(cyl(coll, f"bneck{i}", 0.022, 0.02, 0.12, bx, -0.62, 1.42, "GlassWarm", segs=8))
    # a lantern hook + warm lamp on a post
    parts.append(box(coll, "lamp", 0.16, 0.16, 0.22, W * 0.5 - 0.05, 0.4 - D * 0.5, H - 0.2, "GlassWarm", bev=0.02))
    parts.append(box(coll, "lampcap", 0.2, 0.2, 0.05, W * 0.5 - 0.05, 0.4 - D * 0.5, H - 0.07, "Metal_Iron", bev=0.01))

    join(parts, name)
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR)
    print(f"built {name}")
    return coll


clear_default_scene()
_tav = build_tavern()
for _o in _tav.objects:
    _o.hide_render = True
build_stall()
print("BUILDINGS DONE")
