# Builds the 3 coconut palm variants -> palm_a.glb, palm_b.glb, palm_c.glb (flora v2, b4.5d).
# Origin: base of trunk at (0,0,0); heights and envelopes (NATURE_BOUNDS) match the shipped set,
# so placement, colliders and the height-driven sway shader see the same tree.
# Geometry lives in _nature.py palm_v2: ring-scarred trunk (~7 rings/m, groove + lip every third
# ring, root lobes), 9-12 fronds of 26 leaflet pairs (narrow blades with a raised midvein,
# 10 tris each), spear fronds, a hanging dead-frond skirt, coconuts. Tier band 10-16k tris.
# LOD chain: build_far_lods.py (BR_FAR_ONLY) then build_lods.py (BR_LODS_ONLY).
# Headless: Blender -b -P scripts/blender/build_palms.py   (BR_PALMS_ONLY=palm_a to rebuild one)
# Optional env RENDER_DIR=/path -> contact renders.
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_nature.py')).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
ONLY = {n.strip() for n in os.environ.get('BR_PALMS_ONLY', '').split(',') if n.strip()}

# name, height, lean(XY at top), green fronds, dead fronds, seed
SPECS = [
    ("palm_a", 8.5, (1.6, 0.4), 11, 3, 11),
    ("palm_b", 6.5, (2.3, -0.8), 9, 3, 23),
    ("palm_c", 5.0, (0.7, 0.9), 12, 2, 37),
]

RENDER_DIR = os.environ.get("RENDER_DIR", "")
clear_default_scene()
done = []
for name, height, lean, fronds, dead, seed in SPECS:
    if ONLY and name not in ONLY:
        continue
    coll, _ = palm_v2(name, height, lean, fronds, dead, seed)
    finish_nature(coll, name, budget=PALM_BAND[1], floor=PALM_BAND[0])
    done.append(name)
    print(f"built {name}")

render_nature(tuple(done), RENDER_DIR)
print("PALMS DONE", done)
