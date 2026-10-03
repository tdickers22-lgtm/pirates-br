# Standalone story props authored from the backlog (previously unshipped):
#   rowboat       weathered clinker tender, beached and listing, tribute
#                 offerings heaped in the bilge (mermaid's folly beat)
#   signal_pyre   unlit crib-stacked timber beacon with an open tar barrel
#                 (crow's perch beat)
# Both are ALSO placed inside their hero scenes via _story_props.py, so the
# geometry never diverges between the standalone prop and the scene dressing.
# Headless: Blender -b -P scripts/blender/build_props_story.py
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
exec(open(os.path.join(HERE, "_story_props.py")).read())
import sys
sys.path.insert(0, HERE)
import _trim as TR
exec(open(os.path.join(HERE, "_trimkit.py")).read())     # b5.1e: wood/iron/rope/stone on the trim sheets
exec(open(os.path.join(HERE, "_story_pbr.py")).read())   # original procedural PBR + story_ship (props tier)

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

clear_default_scene()
agx_palette()


def wood_spec(seed=0):
    """Shared timber recipe: sun-bleached up-faces, damp/greyed ground band."""
    return dict(
        tone=0.19, hue=((1.22, 1.12, 0.96), (0.72, 0.71, 0.70)), scale=1.0,
        mottle=0.09, mscale=0.15,
        streak=dict(axis='z', freq=12.0, amt=0.13),
        patch=dict(col=(1.28, 1.22, 1.08), amt=0.32, scale=1.1, thresh=0.54,
                   width=0.20, up=0.85),
        low=dict(z=0.30, amt=0.42, col=(0.44, 0.44, 0.40)),
    )


def build_rowboat():
    name = "rowboat"
    coll = asset_collection(name)
    parts = []
    rng = random.Random(91)
    # beached: dug into the sand bow-up, listing to port, so it never reads as
    # a symmetric bathtub sitting on the grass
    M = (Matrix.Translation((0, 0, 0.10)) @
         Matrix.Rotation(math.radians(-6.5), 4, 'X') @
         Matrix.Rotation(math.radians(9.0), 4, 'Y'))
    rowboat(coll, name, M, parts, rng=rng)

    # b5.1e: props tier on the trim sheets + procedural PBR (the vertex-colour tint/AO path is retired)
    path = story_ship(coll, name, L=float(os.environ.get("B51E_L_ROWBOAT", "0.3")),
                      sub=int(os.environ.get("B51E_SUB_ROWBOAT", "0")), levels=PROP_LEVELS,
                      sheet_dir=PROPS_SHEETS)
    return path


def build_signal_pyre():
    name = "signal_pyre"
    coll = asset_collection(name)
    parts = []
    rng = random.Random(404)
    signal_pyre(coll, name, Matrix.Identity(4), parts, rng=rng)

    path = story_ship(coll, name, L=float(os.environ.get("B51E_L_SIGNAL_PYRE", "0.3")),
                      sub=int(os.environ.get("B51E_SUB_SIGNAL_PYRE", "0")), levels=PROP_LEVELS,
                      sheet_dir=PROPS_SHEETS)
    return path


def stow(coll):
    """render_orbit renders the whole SCENE (it only frames the camera on the
    collection), so a finished asset must be hidden or it photobombs the next
    one's turntable."""
    for o in bpy.data.objects:      # the joined asset AND its LOD proxies left in the scene
        o.hide_render = True


build_rowboat()
stow(None)
build_signal_pyre()
print("story props built")
