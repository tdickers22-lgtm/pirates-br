# SHIP HARDWARE (HWGLB-01 / assets-14) — the four pieces a pirate stands beside
# for the whole match: cannon, ship's wheel, capstan, hanging lantern.
#
# WHAT THEY REPLACE. ShipRenderer builds each of these out of primitives at a
# named pivot: the wheel is a torus with spokes, the capstan a cylinder + a
# torus + a hub, a cannon ten prims. From the helm you are 60 cm from the wheel.
#
# THE PIVOT IS THE API, and it is why these are separate nodes rather than one
# joined mesh (PLAN section 6):
#   cannon        carriage base at y=0; node `barrel`, whose ORIGIN is the
#                 trunnion line — the client elevates by rotating that node.
#   wheel         origin ON the axle; the client spins it with rotation.z, so
#                 the disc is authored in the XY plane facing +Z.
#   capstan       origin at the deck; node `drum` carries the whelps and bars
#                 and turns about Y.
#   ship_lantern  the HOOK is at y=0 and the body hangs below it, so hanging it
#                 is a position, not a position minus a guessed height. `glass`
#                 stays out of the atlas and keeps its emissive material.
#
# Each piece also ships `<name>_far.glb` (a decimated LOD1 for the 60 m swap):
# eight cannons on a galleon x six hulls is the one place this geometry is
# multiplied, and the low tier must not pay 3k triangles a cannon across the bay.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_ship_hardware.py
import os
import bpy
import bmesh
import math
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_atlas.py')).read())

if os.environ.get('HARDWARE_OUT'):
    EXPORT_DIR = os.environ['HARDWARE_OUT']  # noqa: F811
ATLAS_SIZE = int(os.environ.get('HARDWARE_ATLAS', '512'))
DENSITY = float(os.environ.get('HARDWARE_DENSITY', '1.5'))
FAR_RATIO = float(os.environ.get('HARDWARE_FAR', '0.28'))

EXTRA = {
    'Gun_Iron':     ((0.17, 0.18, 0.20, 1.0), 0.42, 0.85),
    'Brass_Worn':   ((0.62, 0.45, 0.16, 1.0), 0.44, 0.80),
    'Oak_Dark':     ((0.19, 0.12, 0.07, 1.0), 0.78, 0.0),
    'Oak_Mid':      ((0.31, 0.20, 0.11, 1.0), 0.76, 0.0),
    'Oak_Worn':     ((0.44, 0.31, 0.18, 1.0), 0.72, 0.0),
    'Glass_Flame':  ((1.00, 0.72, 0.32, 1.0), 0.15, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)
_gf = mat('Glass_Flame')
_gb = _gf.node_tree.nodes.get('Principled BSDF')
_gb.inputs['Emission Color'].default_value = (1.0, 0.68, 0.28, 1.0)
_gb.inputs['Emission Strength'].default_value = 2.6

clear_default_scene()


def _segs(n):
    return max(6, int(round(n * DENSITY)))


def cyl(coll, name, r1, r2, length, center, axis='y', mname='Gun_Iron',
        segs=16, smooth=True, tilt=None):
    bm = bm_cylinder(r1, r2, length, segs=_segs(segs))
    M = Matrix.Translation(G(*center)) @ (tilt or Matrix.Identity(4)) @ game_axis_rot(axis)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)


def box(coll, name, w, h, d, center, mname='Oak_Mid', tilt=None, bevel=0.012,
        smooth=False):
    bm = bm_box(w, d, h)
    M = Matrix.Translation(G(*center)) @ (tilt or Matrix.Identity(4))
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel, segments=2)
        apply_modifiers(o)
    return o


def ring(coll, name, R, r, center, axis='y', mname='Brass_Worn', segs=18, rings=7):
    bm = bm_torus(R, r, segs=_segs(segs), rings=_segs(rings))
    M = Matrix.Translation(G(*center)) @ game_axis_rot(axis)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)


# ── the four pieces ──────────────────────────────────────────
def build_cannon(name='cannon'):
    """Carriage base at y=0, bow +Z. `barrel` pivots on its trunnions."""
    coll = asset_collection(name)
    body, barrel = [], []
    TR = (0.0, 0.60, 0.02)  # trunnion line = the barrel node's origin
    # Carriage: two cheeks stepped down aft, axletrees, four trucks, a quoin.
    for sx in (-1, 1):
        for i, (z, h) in enumerate(((0.38, 0.46), (0.02, 0.40), (-0.34, 0.30))):
            body.append(box(coll, f'cheek_{sx}_{i}', 0.10, h, 0.40,
                            (sx * 0.30, 0.10 + h * 0.5, z), 'Oak_Dark'))
    body.append(box(coll, 'bed', 0.56, 0.10, 1.10, (0, 0.15, 0.02), 'Oak_Mid'))
    for i, z in enumerate((0.44, -0.40)):
        body.append(box(coll, f'axletree_{i}', 0.74, 0.11, 0.13, (0, 0.12, z), 'Oak_Dark'))
        for sx in (-1, 1):
            body.append(cyl(coll, f'truck_{i}_{sx}', 0.115, 0.115, 0.10,
                            (sx * 0.36, 0.115, z), 'x', 'Oak_Worn', segs=16))
            body.append(ring(coll, f'tyre_{i}_{sx}', 0.112, 0.016,
                             (sx * 0.36, 0.115, z), 'x', 'Gun_Iron', segs=16, rings=6))
    body.append(box(coll, 'quoin', 0.22, 0.16, 0.34, (0, 0.30, -0.24), 'Oak_Worn',
                    tilt=Matrix.Rotation(math.radians(9), 4, 'X')))
    for sx in (-1, 1):
        body.append(ring(coll, f'ringbolt_{sx}', 0.055, 0.014, (sx * 0.34, 0.36, -0.50),
                         'z', 'Gun_Iron', segs=14, rings=6))
    # Barrel: breech ball, reinforce, chase taper, muzzle swell, trunnions.
    barrel.append(cyl(coll, 'breech', 0.135, 0.128, 0.34, (0, TR[1], -0.30), 'z',
                      'Gun_Iron', segs=22))
    barrel.append(cyl(coll, 'reinforce', 0.128, 0.104, 0.52, (0, TR[1], 0.02), 'z',
                      'Gun_Iron', segs=22))
    barrel.append(cyl(coll, 'chase', 0.104, 0.082, 0.72, (0, TR[1], 0.62), 'z',
                      'Gun_Iron', segs=22))
    barrel.append(cyl(coll, 'muzzle_swell', 0.098, 0.088, 0.14, (0, TR[1], 1.02), 'z',
                      'Gun_Iron', segs=22))
    barrel.append(cyl(coll, 'bore', 0.062, 0.062, 0.08, (0, TR[1], 1.06), 'z',
                      'Oak_Dark', segs=20))
    barrel.append(bpy.data.objects[cyl(coll, 'cascabel', 0.062, 0.030, 0.14,
                                       (0, TR[1], -0.52), 'z', 'Gun_Iron', segs=16).name])
    for i, z in enumerate((-0.14, 0.30)):
        barrel.append(ring(coll, f'astragal_{i}', 0.112 - i * 0.012, 0.014,
                           (0, TR[1], z), 'z', 'Brass_Worn', segs=20, rings=6))
    for sx in (-1, 1):
        barrel.append(cyl(coll, f'trunnion_{sx}', 0.058, 0.058, 0.16,
                          (sx * 0.17, TR[1], TR[2]), 'x', 'Gun_Iron', segs=16))
    return coll, {f'{name}_body': body, 'barrel': barrel}, {'barrel': TR}


def build_wheel(name='wheel'):
    """Origin ON the axle; the disc lies in XY so rotation.z spins it."""
    coll = asset_collection(name)
    body = []
    R, spokes = 0.52, 10
    body.append(ring(coll, 'rim', R, 0.052, (0, 0, 0), 'z', 'Oak_Mid', segs=30, rings=9))
    body.append(cyl(coll, 'hub', 0.135, 0.115, 0.20, (0, 0, 0), 'z', 'Brass_Worn', segs=20))
    body.append(ring(coll, 'hub_band', 0.14, 0.020, (0, 0, 0.07), 'z', 'Brass_Worn',
                     segs=20, rings=6))
    for i in range(spokes):
        a = 2 * math.pi * i / spokes
        cx, cy = math.cos(a), math.sin(a)
        span = R + 0.22
        # A cylinder authored along game +Y is turned into the spoke direction by
        # a roll about game +Z, and a roll about game +Z is a Blender rotation
        # about -Y: the quarter turn is not cosmetic, without it every spoke
        # comes out tangential to the rim and the handles float off the ends.
        roll = Matrix.Rotation(-(a - math.pi * 0.5), 4, 'Y')
        body.append(cyl(coll, f'spoke_{i}', 0.028, 0.034, span,
                        (cx * span * 0.5, cy * span * 0.5, 0),
                        'y', 'Oak_Worn', segs=12, tilt=roll))
        body.append(cyl(coll, f'handle_{i}', 0.036, 0.028, 0.12,
                        (cx * (span + 0.04), cy * (span + 0.04), 0), 'y',
                        'Oak_Dark', segs=12, tilt=roll))
    return coll, {f'{name}_body': body}, {}


def build_capstan(name='capstan'):
    """Origin at the deck; `drum` turns about Y and carries the bars."""
    coll = asset_collection(name)
    body, drum = [], []
    body.append(cyl(coll, 'base', 0.46, 0.40, 0.10, (0, 0.05, 0), 'y', 'Oak_Dark', segs=22))
    body.append(ring(coll, 'pawl_rim', 0.42, 0.030, (0, 0.11, 0), 'y', 'Gun_Iron',
                     segs=24, rings=6))
    drum.append(cyl(coll, 'drum', 0.30, 0.26, 0.62, (0, 0.44, 0), 'y', 'Oak_Mid', segs=22))
    drum.append(cyl(coll, 'drum_head', 0.34, 0.30, 0.14, (0, 0.80, 0), 'y', 'Oak_Worn', segs=22))
    drum.append(ring(coll, 'drum_band', 0.31, 0.022, (0, 0.20, 0), 'y', 'Brass_Worn',
                     segs=22, rings=6))
    for i in range(6):
        a = 2 * math.pi * i / 6
        cx, cz = math.cos(a), math.sin(a)
        drum.append(box(coll, f'whelp_{i}', 0.09, 0.44, 0.16,
                        (cx * 0.30, 0.42, cz * 0.30), 'Oak_Dark',
                        tilt=Matrix.Rotation(-a, 4, 'Z')))
        drum.append(cyl(coll, f'bar_{i}', 0.040, 0.034, 0.80,
                        (cx * 0.62, 0.80, cz * 0.62), 'x', 'Oak_Worn', segs=12,
                        tilt=Matrix.Rotation(-a, 4, 'Z')))
    return coll, {f'{name}_body': body, 'drum': drum}, {'drum': (0, 0, 0)}


def build_lantern(name='ship_lantern'):
    """The HOOK is at y=0; the lantern hangs below it. `glass` stays emissive."""
    coll = asset_collection(name)
    body, glass = [], []
    body.append(ring(coll, 'hook', 0.045, 0.011, (0, -0.045, 0), 'x', 'Gun_Iron',
                     segs=16, rings=6))
    body.append(cyl(coll, 'cap', 0.13, 0.09, 0.09, (0, -0.13, 0), 'y', 'Gun_Iron', segs=16))
    body.append(cyl(coll, 'roof', 0.19, 0.10, 0.11, (0, -0.21, 0), 'y', 'Gun_Iron', segs=16))
    body.append(cyl(coll, 'base_pan', 0.17, 0.19, 0.07, (0, -0.62, 0), 'y', 'Gun_Iron', segs=16))
    for i in range(6):
        a = 2 * math.pi * i / 6
        body.append(cyl(coll, f'post_{i}', 0.014, 0.014, 0.34,
                        (math.cos(a) * 0.145, -0.42, math.sin(a) * 0.145), 'y',
                        'Brass_Worn', segs=8))
    glass.append(cyl(coll, 'glass', 0.135, 0.135, 0.32, (0, -0.42, 0), 'y',
                     'Glass_Flame', segs=20))
    return coll, {f'{name}_body': body, 'glass': glass}, {}


BUILDS = [build_cannon(), build_wheel(), build_capstan(), build_lantern()]

SPEC = tint_spec(moss=0.0, damp=False)
SPEC['*'] = dict(tone=0.12, mottle=0.07, mscale=0.5)

for coll, groups, pivots in BUILDS:
    name = [k for k in groups if k.endswith('_body')][0][:-5]
    bake_ao(coll, samples=18, max_dist=2.0, floor=0.50, height_gradient=0.06)
    tint_pass(coll, SPEC, seed=13, verbose=False)
    hero_atlas(coll, name, size=ATLAS_SIZE, keep=('glass',))
    joined = {}
    for gname, parts in groups.items():
        flat = []
        for p in parts:
            flat.extend(p if isinstance(p, list) else [p])
        flat = [o for o in flat if o.name in bpy.data.objects]
        if len(flat) > 1:
            joined[gname] = join(flat, gname)
        else:
            flat[0].name = gname
            joined[gname] = flat[0]
    for gname, pivot in pivots.items():
        set_origin_game(joined[gname], pivot)
    path = export_collection_vc(coll, f'{name}.glb')
    verify_glb(path)
    print(f'NODES {name}: {sorted(o.name for o in coll.objects)}')
    # LOD1 for the 60 m swap: same nodes, same atlas, a third of the triangles.
    for o in coll.objects:
        decimate(o, ratio=FAR_RATIO)
        apply_modifiers(o)
    far = export_collection_vc(coll, f'{name}_far.glb')
    verify_glb(far)
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)

print('SHIP HARDWARE DONE')
