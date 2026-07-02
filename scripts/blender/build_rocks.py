# Builds stylized rocks: 3 island boulders + 3 jagged sea rocks.
# Origin: rocks sit on Z=0 (slightly sunk for natural grounding).
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

H = HELPERS


def build_boulder(name, radius, squash, seed, material="Rock_Grey"):
    coll = H["asset_collection"](name)
    bm = H["bm_icosphere"](radius, 2)
    bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, squash)), verts=bm.verts)
    obj = H["obj_from_bmesh"](name, bm, coll, H["mat"](material))
    H["displace_noise"](obj, strength=radius * 0.45, scale=radius * 1.1, seed=seed)
    H["decimate"](obj, 0.22)
    H["apply_modifiers"](obj)
    # ground it: sink lowest 15% below Z=0
    obj.location.z = radius * squash * 0.72
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True)
    return coll, obj


def build_searock(name, height, seed):
    """Jagged spire cluster jutting from the water (origin at waterline)."""
    coll = H["asset_collection"](name)
    rng = random.Random(seed)
    parts = []
    spires = 3
    for k in range(spires):
        h = height * (1.0 if k == 0 else rng.uniform(0.4, 0.7))
        r = h * rng.uniform(0.30, 0.42)
        bm = H["bm_cylinder"](r, r * rng.uniform(0.15, 0.3), h, segs=7)
        # tilt and offset each spire
        tilt = Matrix.Rotation(rng.uniform(-0.22, 0.22), 4, 'X') @ \
               Matrix.Rotation(rng.uniform(-0.22, 0.22), 4, 'Y')
        off = Vector((0, 0, h * 0.30)) if k == 0 else \
              Vector((rng.uniform(-r * 2.2, r * 2.2),
                      rng.uniform(-r * 2.2, r * 2.2), h * 0.18))
        bmesh.ops.transform(bm, matrix=Matrix.Translation(off) @ tilt, verts=bm.verts)
        obj = H["obj_from_bmesh"](f"{name}_s{k}", bm, coll, H["mat"]("Rock_Sea"))
        H["displace_noise"](obj, strength=h * 0.16, scale=h * 0.5, seed=seed + k)
        H["apply_modifiers"](obj)
        parts.append(obj)
    rock = H["join"](parts, name)
    return coll, rock


BOULDERS = [
    ("boulder_a", 1.6, 0.85, 101, "Rock_Grey"),
    ("boulder_b", 2.6, 0.70, 202, "Rock_Grey"),
    ("boulder_c", 1.1, 1.05, 303, "Rock_Dark"),
]
SEAROCKS = [
    ("searock_a", 4.5, 404),
    ("searock_b", 7.0, 505),
    ("searock_c", 3.0, 606),
]

x = -12
for name, r, sq, seed, m in BOULDERS:
    _, obj = build_boulder(name, r, sq, seed, m)
    obj.location.x = x; x += 5
    print(f"built {name}")
for name, h, seed in SEAROCKS:
    _, obj = build_searock(name, h, seed)
    obj.location.x = x; x += 7
    print(f"built {name}")

print("ROCKS DONE")
