# EXPOSED BEDROCK CRAG — crag.glb
#
# Replaces the deleted client-only procedural crag decoration (Game.ts →
# IslandBuilder "Exposed bedrock CRAGS on the upper flanks"), which drew
# 2-4 stretched boulder primitives per outcrop with a flat rock material and
# NO collision. The registry version is one authored GLB scattered by
# MapGenerator on mountain/rocky islands, so the rock you see is the rock you
# bump into.
#
# Silhouette brief (matching the old builder's read):
#   * a fin/blade group — tall, thin, leaning, NOT a rounded boulder
#   * 3 main blades of different heights on one ridge line (Blender +X), so a
#     yaw spin still reads as "strata pushed up out of the hillside"
#   * dark crevices between the blades (Rock_Dark cores in the gaps)
#   * a rubble skirt + buried base so it seats into a slope without daylight
#     under the downhill edge
#
# Nominal envelope: horizontal half-extent 1.60, top +3.40, bottom -1.55
# (buried skirt + root — the origin sits at the visible ground line). MapGenerator scales instances 1.0-2.2, which reproduces the
# old builder's 1.3-3.4 "bigness" range.
#
# Headless: Blender -b -P scripts/blender/build_crag.py
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

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

clear_default_scene()
agx_palette()


def bake_xform(obj):
    """Freeze loc/rot/scale into the mesh so every part lives in one shared
    space — required before a group fit, and it keeps join() from inheriting
    the first part's transform."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def fit_group(objs, target_r, target_top, target_bot):
    """Fit a GROUP of transform-baked meshes into a collider envelope: uniform
    XY rescale to a max horizontal half-extent, Z rescale+shift to a span.
    (build_rocks.py's fit_envelope, generalised past a single joined mesh so
    the fit can happen BEFORE the tint pass — tint_pass needs one material per
    object, so the join must stay last.)"""
    vs = [v for o in objs for v in o.data.vertices]
    r_now = max(max(abs(v.co.x), abs(v.co.y)) for v in vs)
    zmin = min(v.co.z for v in vs)
    zmax = max(v.co.z for v in vs)
    sxy = target_r / max(1e-6, r_now)
    sz = (target_top - target_bot) / max(1e-6, zmax - zmin)
    dz = target_bot - zmin * sz
    for o in objs:
        for v in o.data.vertices:
            v.co.x *= sxy
            v.co.y *= sxy
            v.co.z = v.co.z * sz + dz


def blade(name, coll, w, d, h, seed, material="Rock_Grey",
          coarse=0.26, fine=0.05, deci=0.55, cuts=5):
    """A chiselled rock fin: subdivided box -> dual voronoi displacement ->
    decimate to flat facets. Boxes (not icospheres) keep the blade silhouette
    the old builder got from stretching a boulder mesh."""
    bm = bm_box(w, d, h)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    obj = obj_from_bmesh(name, bm, coll, mat(material), smooth=False)
    displace_noise(obj, strength=min(w, d) * coarse + h * 0.05, scale=1.5, seed=seed)
    displace_noise(obj, strength=fine, scale=0.45, seed=seed + 17)
    decimate(obj, deci)
    apply_modifiers(obj)
    return obj


def build_crag(name="crag", seed=8171):
    rng = random.Random(seed)
    coll = asset_collection(name)
    parts = []

    # ── three ridge blades, tallest in the middle-back ────────────────────
    spec = [
        # (x,        y,      w,    d,    h,    rot_y_deg, rot_z_deg)
        (-1.05, 0.18, 0.95, 0.72, 2.35, -13.0, 14.0),
        (0.05, -0.10, 1.15, 0.86, 3.55, 7.0, -8.0),
        (1.15, 0.24, 0.80, 0.62, 2.05, 19.0, 26.0),
    ]
    for i, (x, y, w, d, h, ry, rz) in enumerate(spec):
        b = blade(f"{name}_b{i}", coll, w, d, h, seed + i * 13)
        b.location = Vector((x, y, h * 0.5 - 0.55))
        b.rotation_euler = (math.radians(rng.uniform(-6, 6)),
                            math.radians(ry), math.radians(rz))
        parts.append(b)

    # ── dark crevice cores in the gaps between blades ─────────────────────
    for i, (cx, cy, ch) in enumerate(((-0.50, 0.02, 1.75), (0.62, 0.05, 1.55))):
        core = obj_from_bmesh(f"{name}_c{i}", bm_box(0.30, 0.55, ch), coll,
                              mat("Rock_Dark"), smooth=False)
        core.location = Vector((cx, cy, ch * 0.5 - 0.55))
        core.rotation_euler = (0, math.radians(rng.uniform(-8, 8)),
                               math.radians(rng.uniform(-10, 10)))
        parts.append(core)

    # ── shed rubble + buried skirt so it grows out of the hillside ────────
    for i in range(4):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.9, 1.7)
        s = rng.uniform(0.34, 0.62)
        chunk = blade(f"{name}_r{i}", coll, s * 1.6, s * 1.3, s,
                      seed + 200 + i * 7, material="Rock_Grey",
                      coarse=0.34, deci=0.55, cuts=3)
        chunk.location = Vector((math.cos(a) * r, math.sin(a) * r * 0.7, -0.42 + s * 0.3))
        chunk.rotation_euler = (math.radians(rng.uniform(-25, 25)),
                                math.radians(rng.uniform(-25, 25)),
                                math.radians(rng.uniform(0, 180)))
        parts.append(chunk)
    # The skirt doubles as the ROOT: on a steep flank a tilted blade lifts its
    # downhill corner, so the mesh has to carry ~1.5 m of rock below the origin
    # for the outcrop to bite into the slope instead of showing daylight.
    skirt = blade(f"{name}_sk", coll, 2.9, 1.9, 0.75, seed + 401,
                  material="Rock_Grey", coarse=0.30, deci=0.5, cuts=4)
    skirt.location = Vector((0.0, 0.05, -0.72))
    parts.append(skirt)
    root = blade(f"{name}_rt", coll, 2.4, 1.6, 1.1, seed + 431,
                 material="Rock_Dark", coarse=0.22, deci=0.4, cuts=2)
    root.location = Vector((0.0, 0.0, -1.15))
    parts.append(root)

    for p in parts:
        bake_xform(p)
    fit_group(parts, 1.60, 3.40, -1.55)

    spec_t = tint_spec(moss=0.38, seed=4)
    # Bedrock reads as strata, not a paint bucket: horizontal banding + a damp
    # shaded base where the outcrop meets the slope.
    spec_t['Rock_Grey'] = dict(
        spec_t['Rock_Grey'],
        tone=0.19, mottle=0.15, mscale=0.30,
        streak=dict(axis='z', freq=4.5, amt=0.13),
        low=dict(z=0.34, amt=0.22, col=(0.52, 0.53, 0.47)),
    )
    spec_t['Rock_Dark'] = dict(spec_t['Rock_Dark'], tone=0.11, mottle=0.16)
    return ship_asset(coll, name, spec=spec_t, tint_seed=4,
                      ao=dict(samples=24, max_dist=3.4, floor=0.60),
                      render_dir=RENDER_DIR or None,
                      angles=(-90, -20, 40, 130))


info = build_crag()
print("CRAG DONE")
