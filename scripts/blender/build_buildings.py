# Island buildings: a half-timbered pirate TAVERN (7.6 x 6.4, seated gable roof
# — no floating roof) and a small market STALL/shop with a canopy. Front (door /
# counter) faces Blender -Y  (= game +Z). Origin at ground, floor top at +0.18.
# Headless: Blender -b -P scripts/blender/build_buildings.py
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())

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


def box(coll, name, w, d, h, x, y, z, material, rot=None):
    bm = bm_box(w, d, h)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material))


def build_tavern(name="tavern"):
    coll = asset_collection(name)
    W, D = 7.6, 6.4
    floorTop = 0.18
    wallH = 3.0
    wallTop = floorTop + wallH
    th = 0.2
    parts = []

    # ── plank floor / footing ──
    parts.append(box(coll, "floor", W + 0.6, D + 0.6, floorTop, 0, 0, floorTop * 0.5, "Wood_Mid"))
    parts.append(box(coll, "footing", W + 0.9, D + 0.9, 0.14, 0, 0, 0.07, "Rock_Grey"))

    # ── plaster walls (daub infill) ──
    parts.append(box(coll, "wall_back", W, th, wallH, 0, D * 0.5, floorTop + wallH * 0.5, "Plaster"))
    for sx in (-1, 1):
        parts.append(box(coll, f"wall_side{sx}", th, D, wallH, sx * W * 0.5, 0, floorTop + wallH * 0.5, "Plaster"))
    # front wall split around a door
    doorW = 1.7
    sideW = (W - doorW) * 0.5
    for sx in (-1, 1):
        parts.append(box(coll, f"wall_front{sx}", sideW, th, wallH, sx * (W * 0.5 - sideW * 0.5), -D * 0.5, floorTop + wallH * 0.5, "Plaster"))
    parts.append(box(coll, "lintel", doorW + 0.3, th, 0.5, 0, -D * 0.5, wallTop - 0.25, "Timber"))
    parts.append(box(coll, "door", doorW - 0.1, 0.08, wallH - 0.5, 0, -D * 0.5 - 0.04, floorTop + (wallH - 0.5) * 0.5, "Wood_Dark"))

    # ── half-timber framing: corner posts + sill/mid/top rails + braces ──
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(box(coll, f"post{sx}{sz}", 0.24, 0.24, wallH + 0.1, sx * (W * 0.5 - 0.05), sz * (D * 0.5 - 0.05), floorTop + wallH * 0.5, "Timber"))
    for ry, rn in ((floorTop + 0.15, "sill"), (floorTop + wallH * 0.55, "mid"), (wallTop - 0.05, "top")):
        parts.append(box(coll, f"rail_b_{rn}", W, 0.16, 0.16, 0, D * 0.5, ry, "Timber"))
        for sx in (-1, 1):
            parts.append(box(coll, f"rail_s{sx}_{rn}", 0.16, D, 0.16, sx * W * 0.5, 0, ry, "Timber"))
    # diagonal braces on the side walls
    for sx in (-1, 1):
        rot = Matrix.Rotation(math.radians(38), 4, 'X')
        parts.append(box(coll, f"brace{sx}", 0.14, 2.4, 0.14, sx * W * 0.5, D * 0.24, floorTop + wallH * 0.5, "Timber", rot))

    # ── shuttered windows (glow) on the side walls ──
    for sx in (-1, 1):
        parts.append(box(coll, f"win{sx}", th + 0.06, 1.0, 1.0, sx * W * 0.5, -D * 0.12, floorTop + 1.5, "GlassWarm"))
        for sh in (-1, 1):
            parts.append(box(coll, f"shut{sx}_{sh}", 0.05, 0.5, 1.0, sx * (W * 0.5 + 0.04), -D * 0.12 + sh * 0.62, floorTop + 1.5, "Wood_Dark"))

    # ── SEATED gable roof: two slabs whose lower eave rests on the wall top and
    #    overhangs it, meeting at a ridge — no floating gap. ──
    rise = 1.9
    eave = 0.6
    half = D * 0.5 + eave
    slabLen = math.hypot(half, rise)
    slope = math.atan2(rise, half)
    for sz in (-1, 1):
        rot = Matrix.Rotation(sz * (math.pi * 0.5 - (math.pi * 0.5 - slope)), 4, 'X')  # tilt to the slope
        rot = Matrix.Rotation(-sz * slope, 4, 'X')
        cy = sz * half * 0.5
        cz = wallTop + rise * 0.5
        parts.append(box(coll, f"roof{sz}", W + 1.0, slabLen, 0.18, 0, cy, cz, "Shingle", rot))
    # ridge beam
    parts.append(box(coll, "ridge", W + 1.0, 0.22, 0.22, 0, 0, wallTop + rise, "Timber"))
    # gable end triangles (fill the front/back peak)
    for sz in (-1, 1):
        bm = bmesh.new()
        v = [bm.verts.new(p) for p in [(-W * 0.5, sz * D * 0.5, wallTop), (W * 0.5, sz * D * 0.5, wallTop), (0, sz * D * 0.5, wallTop + rise)]]
        bm.faces.new(v)
        parts.append(obj_from_bmesh(f"gable{sz}", bm, coll, mat("Plaster")))
    # eave fascia
    for sz in (-1, 1):
        parts.append(box(coll, f"fascia{sz}", W + 1.1, 0.14, 0.28, 0, sz * half, wallTop + 0.02, "Timber"))

    # ── stone chimney on the back-right, breaking the roofline ──
    parts.append(box(coll, "chimney", 0.9, 0.9, wallTop + rise + 1.1, W * 0.32, D * 0.34, (wallTop + rise + 1.1) * 0.5, "Rock_Grey"))
    parts.append(box(coll, "chimcap", 1.1, 1.1, 0.2, W * 0.32, D * 0.34, wallTop + rise + 1.1, "Rock_Dark"))

    # ── hanging tavern sign by the door ──
    parts.append(box(coll, "signarm", 1.1, 0.12, 0.12, -W * 0.5 + 0.5, -D * 0.5 - 0.55, wallTop - 0.2, "Timber"))
    parts.append(box(coll, "signboard", 0.9, 0.08, 0.7, -W * 0.5 + 0.95, -D * 0.5 - 0.55, wallTop - 0.75, "Wood_Bleached"))
    for sx in (-1, 1):
        parts.append(box(coll, f"signchain{sx}", 0.03, 0.03, 0.28, -W * 0.5 + 0.95 + sx * 0.3, -D * 0.5 - 0.55, wallTop - 0.4, "Metal_Iron"))

    join(parts, name)
    export_collection(coll, f"{name}.glb")
    print(f"built {name}")


def build_stall(name="stall"):
    coll = asset_collection(name)
    parts = []
    W, D, H = 2.6, 1.3, 2.4
    # counter
    parts.append(box(coll, "counter", W, D, 1.0, 0, -0.1, 0.5, "Wood_Mid"))
    parts.append(box(coll, "counter_top", W + 0.2, D + 0.2, 0.1, 0, -0.1, 1.05, "Wood_Dark"))
    parts.append(box(coll, "counter_front", W, 0.1, 0.8, 0, -0.1 - D * 0.5, 0.5, "Timber"))
    # four posts
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(box(coll, f"post{sx}{sz}", 0.12, 0.12, H, sx * (W * 0.5 - 0.05), 0.4 + sz * (D * 0.5), H * 0.5, "Timber"))
    # slanted striped canopy (two slabs meeting at a ridge, front lower)
    rise = 0.5
    rot = Matrix.Rotation(math.radians(-16), 4, 'X')
    canvas = "Awning_Red"
    parts.append(box(coll, "canopy", W + 0.6, D + 1.4, 0.08, 0, 0.15, H + rise * 0.5, canvas, rot))
    # scalloped valance
    for i in range(6):
        parts.append(box(coll, f"scallop{i}", (W + 0.6) / 6 * 0.8, 0.06, 0.22, -(W + 0.6) * 0.5 + (i + 0.5) * (W + 0.6) / 6, -0.1 - D * 0.5 - 0.2, H + 0.02, "Awning_Cream"))
    # a lantern hook + warm lamp on a post
    parts.append(box(coll, "lamp", 0.16, 0.16, 0.22, W * 0.5 - 0.05, 0.4 - D * 0.5, H - 0.2, "GlassWarm"))
    join(parts, name)
    export_collection(coll, f"{name}.glb")
    print(f"built {name}")


clear_default_scene()
build_tavern()
build_stall()
print("BUILDINGS DONE")
