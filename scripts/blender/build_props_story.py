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

    SPEC = tint_spec(moss=0.18, seed=9)
    for w in ('Wood_Dark', 'Wood_Mid', 'Wood_Light', 'Wood_Bleached'):
        SPEC[w] = wood_spec()
    # waterline: everything below 0.28 has been wet twice a day for years
    for w in ('Wood_Dark', 'Wood_Mid', 'Wood_Light', 'Wood_Bleached'):
        SPEC[w] = dict(SPEC[w],
                       low=dict(z=0.30, amt=0.52, col=(0.40, 0.46, 0.44)),
                       patch=dict(col=(0.50, 0.78, 0.42), amt=0.34, scale=0.55,
                                  thresh=0.63, width=0.14, up=0.30))
    SPEC['Rust'] = dict(tone=0.14, mottle=0.16, mscale=0.14,
                        hue=((1.22, 1.02, 0.86), (0.74, 0.76, 0.80)), scale=0.3)
    info = ship_asset(coll, name, spec=SPEC, ao=dict(samples=24, floor=0.44),
                      tint_seed=9, render_dir=RENDER_DIR,
                      angles=(-90, -35, 25, 120), elev=20)
    return info


def build_signal_pyre():
    name = "signal_pyre"
    coll = asset_collection(name)
    parts = []
    rng = random.Random(404)
    signal_pyre(coll, name, Matrix.Identity(4), parts, rng=rng)

    SPEC = tint_spec(moss=0.22, seed=13)
    for w in ('Wood_Dark', 'Wood_Mid', 'Wood_Light', 'Wood_Bleached'):
        SPEC[w] = wood_spec()
    SPEC['Tar_Black'] = dict(tone=0.07, mottle=0.10, mscale=0.10,
                             hue=((1.18, 1.14, 1.10), (0.80, 0.82, 0.88)),
                             scale=0.30)
    SPEC['Leaf_Dry'] = dict(tone=0.20, mottle=0.14, mscale=0.20,
                            hue=((1.24, 1.12, 0.90), (0.76, 0.78, 0.76)),
                            scale=0.45)
    SPEC['Metal_Band'] = dict(tone=0.10, mottle=0.12, mscale=0.10,
                              patch=dict(col=RUST_C, amt=0.70, scale=0.32,
                                         thresh=0.46, width=0.16, up=0.35))
    info = ship_asset(coll, name, spec=SPEC, ao=dict(samples=24, floor=0.42),
                      tint_seed=13, render_dir=RENDER_DIR,
                      angles=(-90, -35, 25, 120), elev=18)
    return info


def stow(coll):
    """render_orbit renders the whole SCENE (it only frames the camera on the
    collection), so a finished asset must be hidden or it photobombs the next
    one's turntable."""
    for o in coll.objects:
        o.hide_render = True


build_rowboat()
stow(bpy.data.collections["rowboat"])
build_signal_pyre()
print("story props built")
