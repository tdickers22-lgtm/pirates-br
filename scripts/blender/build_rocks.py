# Builds stylized rocks: 3 island boulders + 3 eroded sea stacks.
# Sea stacks are tall, weathered, strata-banded rock pillars (SoT-style) — a
# lathed column with per-ring radius profile (sedimentary bands), a gentle lean,
# per-vertex erosion, companion spires and a rubble skirt. Origin at the
# waterline (Z=0 base). The client rescales each to fit its collision cylinder,
# so author roughly columnar (height ~= 1.5x diameter).
# Headless: Blender -b -P scripts/blender/build_rocks.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_helpers.py")
exec(open(HELPERS).read())

# Weathered rock tones for the stacks (lighter + warmer than the old near-black
# Rock_Sea so they read as sun-and-salt-eroded stone, not flat grey cones).
EXTRA = {
    "Rock_Stack":  ((0.40, 0.38, 0.34, 1.0), 0.94, 0.0),  # weathered body
    "Rock_Wet":    ((0.24, 0.24, 0.25, 1.0), 0.72, 0.0),  # dark wet base
    "Rock_Pale":   ((0.60, 0.57, 0.50, 1.0), 0.95, 0.0),  # sun-bleached / guano crown
}
for name, (col, rough, metal) in EXTRA.items():
    if name not in PALETTE:
        PALETTE[name] = (col, rough, metal)


def bm_pillar(height, base_r, seed, segs=16, rings=18, taper=0.6,
              strata=0.16, lean=0.05, cap_r=0.16):
    """A lathed, strata-banded, eroded rock column rising along +Z from 0.

    - taper: how much the radius shrinks base->top (0.6 => top is 40% of base)
    - strata: amplitude of the sedimentary radius banding
    - lean: how far the column drifts off-axis over its height (fraction)
    - cap_r: minimum radius fraction so the top isn't a needle point
    """
    rng = random.Random(seed)
    bm = bmesh.new()
    ring_verts = []
    lx = ly = 0.0
    vx = rng.uniform(-0.02, 0.02)
    vy = rng.uniform(-0.02, 0.02)
    for j in range(rings + 1):
        t = j / rings                       # 0 base .. 1 top
        z = t * height
        # radius profile: taper up, sedimentary strata bulges, gentle random wobble
        prof = 1.0 - taper * t
        band = 1.0 + strata * math.sin(t * math.pi * 4.5 + seed) \
                   + strata * 0.5 * math.sin(t * math.pi * 9.0 + seed * 1.7)
        wob = 1.0 + rng.uniform(-0.05, 0.05)
        r = max(base_r * cap_r, base_r * prof * band * wob)
        # accumulate a slow lean so the stack isn't a perfect axis
        vx = vx * 0.82 + rng.uniform(-0.02, 0.02)
        vy = vy * 0.82 + rng.uniform(-0.02, 0.02)
        lx += vx * (height / rings) * lean * 20.0
        ly += vy * (height / rings) * lean * 20.0
        verts = []
        for s in range(segs):
            a = (s / segs) * math.tau
            rr = r * (1.0 + rng.uniform(-0.09, 0.09))   # per-vertex erosion
            verts.append(bm.verts.new((lx + math.cos(a) * rr,
                                       ly + math.sin(a) * rr, z)))
        ring_verts.append(verts)
    for j in range(rings):
        a, b = ring_verts[j], ring_verts[j + 1]
        for s in range(segs):
            s2 = (s + 1) % segs
            bm.faces.new((a[s], a[s2], b[s2], b[s]))
    bm.faces.new(list(reversed(ring_verts[0])))   # bottom cap
    bm.faces.new(list(ring_verts[-1]))            # top cap
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def build_searock(name, height, base_r, seed, companions, squat=False):
    """Eroded sea stack: main pillar + companion spires + rubble skirt."""
    coll = asset_collection(name)
    rng = random.Random(seed)
    parts = []

    # main pillar (weathered body)
    bm = bm_pillar(height, base_r, seed,
                   taper=0.5 if squat else 0.62,
                   strata=0.2 if squat else 0.15,
                   lean=0.03 if squat else 0.06)
    main = obj_from_bmesh(f"{name}_main", bm, coll, mat("Rock_Stack"), smooth=False)
    displace_noise(main, strength=base_r * 0.14, scale=base_r * 0.9, seed=seed)
    apply_modifiers(main)
    parts.append(main)

    # a sun-bleached crown band near the top
    crown = obj_from_bmesh(f"{name}_crown",
                           bm_pillar(height * 0.16, base_r * (0.44 if not squat else 0.7),
                                     seed + 91, segs=14, rings=4, taper=0.5, strata=0.1),
                           coll, mat("Rock_Pale"), smooth=False)
    crown.location.z = height * (0.82 if not squat else 0.6)
    apply_modifiers(crown)
    parts.append(crown)

    # companion spires clustered at the base
    for k in range(companions):
        ch = height * rng.uniform(0.28, 0.52)
        cr = base_r * rng.uniform(0.4, 0.62)
        cbm = bm_pillar(ch, cr, seed + 200 + k, segs=12, rings=10,
                        taper=0.66, strata=0.18, lean=0.09)
        spire = obj_from_bmesh(f"{name}_c{k}", cbm, coll, mat("Rock_Stack"), smooth=False)
        ang = rng.uniform(0, math.tau)
        d = base_r * rng.uniform(0.9, 1.5)
        spire.location = Vector((math.cos(ang) * d, math.sin(ang) * d, -0.4))
        displace_noise(spire, strength=cr * 0.16, scale=cr * 0.9, seed=seed + k)
        apply_modifiers(spire)
        parts.append(spire)

    # wet rubble skirt grounding the cluster at the waterline
    skirt_bm = bm_icosphere(base_r * 1.35, 2)
    bmesh.ops.scale(skirt_bm, vec=Vector((1.0, 1.0, 0.34)), verts=skirt_bm.verts)
    skirt = obj_from_bmesh(f"{name}_skirt", skirt_bm, coll, mat("Rock_Wet"), smooth=False)
    skirt.location.z = base_r * 0.12
    displace_noise(skirt, strength=base_r * 0.28, scale=base_r * 0.8, seed=seed + 7)
    decimate(skirt, 0.5)
    apply_modifiers(skirt)
    parts.append(skirt)

    rock = join(parts, name)
    export_collection(coll, f"{name}.glb")
    return coll, rock


def build_boulder(name, radius, squash, seed, material="Rock_Grey"):
    coll = asset_collection(name)
    bm = bm_icosphere(radius, 2)
    bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, squash)), verts=bm.verts)
    obj = obj_from_bmesh(name, bm, coll, mat(material))
    displace_noise(obj, strength=radius * 0.45, scale=radius * 1.1, seed=seed)
    decimate(obj, 0.24)
    apply_modifiers(obj)
    obj.location.z = radius * squash * 0.72
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True)
    export_collection(coll, f"{name}.glb")
    return coll, obj


clear_default_scene()

BOULDERS = [
    ("boulder_a", 1.6, 0.85, 101, "Rock_Grey"),
    ("boulder_b", 2.6, 0.70, 202, "Rock_Grey"),
    ("boulder_c", 1.1, 1.05, 303, "Rock_Grey"),
]
# (name, authored height, base radius, seed, companion spires, squat)
SEAROCKS = [
    ("searock_a", 10.0, 3.4, 404, 2, False),   # mid pillar + 2 spires
    ("searock_b", 14.0, 4.2, 505, 1, False),   # tall dramatic spire
    ("searock_c", 6.0, 2.6, 606, 3, True),     # squat clustered stack
]

for name, r, sq, seed, m in BOULDERS:
    build_boulder(name, r, sq, seed, m)
    print(f"built {name}")
for name, h, br, seed, comp, squat in SEAROCKS:
    build_searock(name, h, br, seed, comp, squat)
    print(f"built {name}")

print("ROCKS DONE")
