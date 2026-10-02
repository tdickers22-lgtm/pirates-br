# Builds palm_tall.glb (very tall thin coconut palm) and palm_ground.glb (low ground fan palm,
# big fanned fronds with wider leaflets), flora v2 (b4.5d): same _nature.py palm_v2 kit as
# build_palms.py, tier band 10-16k tris, tinted + AO-baked by finish_nature.
# Headless: Blender -b -P scripts/blender/build_palms_extra.py   (BR_PALMS_ONLY=palm_tall)
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

RENDER_DIR = os.environ.get("RENDER_DIR", "")
clear_default_scene()

BUILDS = [
    # Very tall thin coconut palm: upright, whippy, sparse crown, ~13.5 m.
    dict(name="palm_tall", height=13.5, lean=(1.1, -0.5), fronds=10, dead=2,
         seed=71, r0=0.22, r1=0.10, frond_scale=0.32, cocos=4, pairs=24,
         tilts=(0.26, 0.55, 0.90), segs=14, core_r=0.26),
    # Short ground fan palm: low stump, big fanned fronds with wide blades.
    dict(name="palm_ground", height=1.4, lean=(0.18, 0.10), fronds=11, dead=3,
         seed=88, r0=0.28, r1=0.20, frond_scale=0.66, cocos=0, pairs=34,
         tilts=(-0.85, -0.35, 0.30), blade=0.54, spears=2, segs=16, core_r=0.22),
]

done = []
for spec in BUILDS:
    if ONLY and spec['name'] not in ONLY:
        continue
    coll, _ = palm_v2(**spec)
    finish_nature(coll, spec['name'], budget=PALM_BAND[1], floor=PALM_BAND[0])
    done.append(spec['name'])
    print(f"built {spec['name']}")

render_nature(tuple(done), RENDER_DIR)
print("PALMS EXTRA DONE", done)
