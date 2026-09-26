# SHIP HARDWARE v2 (b3.4h, assets-01 / assets-02): the four pieces a pirate stands beside for the whole
# match (cannon, ship's wheel, capstan, hanging lantern) rebuilt at the D27 hero bands on ONE shared
# PBR hardware atlas (baseColor + normal + ORM baked from PolyHaven CC0 sources), single-sided.
#
#   D27 bands (test-asset-tiers TIERS): cannon 14-20k, wheel 10-14k, capstan 8-12k, lantern 3-5k.
#   Each piece is modelled from turned profiles (lathe) and bevelled timber; a density loop rebuilds a
#   piece whose triangle count lands outside its band, so the band is a build contract, not a hope.
#
# THE PIVOT IS THE API (b3.4e mounts these on the pinned pivots; PLAN section 6):
#   cannon        carriage base at y=0, muzzle +Z; node `barrel` has its ORIGIN on the trunnion line
#                 (0, 0.60, 0.02), the client elevates by rotating it.
#   wheel         origin ON the axle; the disc lies in XY and spins with rotation.z (node `wheel_body`).
#   capstan       origin at the deck; node `drum` (drum, whelps, bars) turns about Y over `capstan_body`.
#   ship_lantern  the HOOK is at y=0 and the body hangs below it; `glass` keeps its own emissive
#                 material (the ship replaces it with its night-ramped glass).
#
# SHARED ATLAS: all four pieces are smart-UV'd into one layout and baked once (_atlas.pbr_atlas), so
# every file carries byte-identical baseColor/normal/ORM images (test-hero-assets [o]).
#
# FAR: `<name>_far.glb` keeps the node names and is decimated to at most the triangle count the
# previous far file had (the low tier draws only far hardware, so the galleon's low-tier bill cannot
# grow), and never above 45% of LOD0 (test-hero-assets [h]). `<name>_lods.glb` comes from build_lods.py.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_ship_hardware.py
#   env: HARDWARE_OUT (dir), HARDWARE_SAMPLES (bake samples, 16)
import os
import sys
import math
import json
import struct
import bpy
import bmesh
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
exec(open(os.path.join(HERE, '_helpers.py')).read())
import _hires as H  # noqa: E402
import _pbr as P  # noqa: E402
import _atlas as A  # noqa: E402

OUT = os.environ.get('HARDWARE_OUT') or EXPORT_DIR  # noqa: F821 (from _helpers)
SAMPLES = int(os.environ.get('HARDWARE_SAMPLES', '16'))
BANDS = {'cannon': (14000, 20000), 'wheel': (10000, 14000), 'capstan': (8000, 12000), 'ship_lantern': (3000, 5000)}
SOURCES = ['metal_plate', 'walnut_veneer', 'brown_planks_03']
FAR_CAP = {'cannon': 1654, 'wheel': 916, 'capstan': 748, 'ship_lantern': 304}  # v1 _far.glb tris (7c2ff264)
FAR_ATLAS = int(os.environ.get('HARDWARE_FAR_ATLAS', '256'))
DENS = {}

clear_default_scene()  # noqa: F821

MATS = {
    'iron': P.metal_material('HW_Iron', 'metal_plate', 'iron', scale=2.0, tint=(0.30, 0.31, 0.33), wear=0.30),
    'brass': P.metal_material('HW_Brass', 'metal_plate', 'brass', scale=2.0, tint=(0.95, 0.72, 0.36), wear=0.35),
    'oak': P.source_material('HW_Oak', 'brown_planks_03', scale=1.0, tint=(0.72, 0.55, 0.40), wear=0.15),
    'oak_dark': P.source_material('HW_OakDark', 'brown_planks_03', scale=1.0, tint=(0.45, 0.33, 0.24), wear=0.10),
    'walnut': P.source_material('HW_Walnut', 'walnut_veneer', scale=1.4, tint=(0.80, 0.60, 0.45), wear=0.20),
}
GLASS = bpy.data.materials.new('Glass_Flame')
GLASS.use_nodes = True
_b = GLASS.node_tree.nodes.get('Principled BSDF')
_b.inputs['Base Color'].default_value = (1.0, 0.72, 0.32, 1.0)
_b.inputs['Roughness'].default_value = 0.15
_b.inputs['Emission Color'].default_value = (1.0, 0.68, 0.28, 1.0)
_b.inputs['Emission Strength'].default_value = 2.6
GLASS.use_backface_culling = True


def G(x, y, z):
    return Vector((x, -z, y))


AX = {'y': Matrix.Identity(4), 'z': Matrix.Rotation(math.radians(90), 4, 'X'),
      'x': Matrix.Rotation(math.radians(90), 4, 'Y')}
D = {'d': 1.0}


def seg(n):
    return max(12, min(160, int(round(n * D['d'] / 4.0)) * 4))


def xf(o, M):
    o.data.transform(M)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def lathe(coll, name, prof, axis, at, mat, segs=48, **kw):
    o = H.lathe(name, prof, seg(segs), collection=coll, material=MATS[mat] if isinstance(mat, str) else mat, **kw)
    return xf(o, Matrix.Translation(G(*at)) @ AX[axis])


def lathe_dir(coll, name, prof, d_game, at, mat, segs=16, **kw):
    o = H.lathe(name, prof, seg(segs), collection=coll, material=MATS[mat], **kw)
    q = Vector((0, 0, 1)).rotation_difference(G(*d_game).normalized())
    return xf(o, Matrix.Translation(G(*at)) @ q.to_matrix().to_4x4())


def torus(coll, name, R, r, axis, at, mat, segs=48, rsegs=10):
    prof = [(R + r * math.cos(2 * math.pi * k / rsegs), r * math.sin(2 * math.pi * k / rsegs)) for k in range(rsegs)]
    return lathe(coll, name, prof, axis, at, mat, segs, closed=True)


def box(coll, name, w, h, d, at, mat, rot=None, bev=0.012, cuts=0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(w, d, h), verts=bm.verts)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    me.materials.append(MATS[mat])
    me.transform(Matrix.Translation(G(*at)) @ (rot or Matrix.Identity(4)))
    H.bevel(o, bev, 3)
    return o


def join_as(objs, name, pivot=None):
    base = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs,
                                       selected_editable_objects=objs):
            bpy.ops.object.join()
    base.name = name
    base.data.name = name
    if pivot is not None:
        base.data.transform(Matrix.Translation(-G(*pivot)))
        base.location = G(*pivot)
    return base


# ── the four pieces (game space: x right, y up, z forward) ─────────────────────
def build_cannon(coll):
    TR = (0.0, 0.60, 0.02)
    body, barrel = [], []
    # Barrel: cascabel button, breech, base ring, first and second reinforce, chase girdle, chase,
    # muzzle astragal and swell, the muzzle face and a real bore (the profile turns back down it).
    prof = [(0.0, -0.665), (0.024, -0.662), (0.036, -0.645), (0.036, -0.625), (0.026, -0.608), (0.022, -0.592),
            (0.050, -0.578), (0.080, -0.562), (0.104, -0.540), (0.122, -0.512), (0.133, -0.480), (0.138, -0.450),
            (0.148, -0.438), (0.150, -0.418), (0.140, -0.408), (0.137, -0.380), (0.136, -0.150), (0.144, -0.140),
            (0.145, -0.118), (0.132, -0.108), (0.128, 0.290), (0.136, 0.300), (0.137, 0.322), (0.118, 0.334),
            (0.110, 0.360), (0.108, 0.420), (0.113, 0.428), (0.113, 0.444), (0.104, 0.452), (0.094, 0.880),
            (0.100, 0.890), (0.100, 0.905), (0.090, 0.915), (0.088, 0.940), (0.098, 0.975), (0.110, 1.010),
            (0.114, 1.045), (0.110, 1.062), (0.098, 1.070), (0.068, 1.070), (0.064, 1.058), (0.064, 0.760),
            (0.0, 0.750)]
    barrel.append(lathe(coll, 'bbody', prof, 'z', (0, TR[1], 0), 'iron', 72))
    for i, (z, R) in enumerate(((-0.108, 0.133), (0.334, 0.119), (0.905, 0.092))):
        barrel.append(torus(coll, f'astragal_{i}', R, 0.009, 'z', (0, TR[1], z), 'brass', 72, 8))
    for sx in (-1, 1):
        tp = [(0.0, 0.0), (0.056, 0.0), (0.060, 0.012), (0.060, 0.098), (0.055, 0.110), (0.0, 0.112)]
        t = lathe_dir(coll, f'trunnion_{sx}', tp, (sx, 0, 0), (sx * 0.118, TR[1], TR[2]), 'iron', 40)
        barrel.append(t)
        # dolphins: the two lifting handles over the trunnions
        barrel.append(torus(coll, f'dolphin_{sx}', 0.045, 0.012, 'x', (sx * 0.05, TR[1] + 0.14, 0.02), 'iron', 32, 8))
    barrel.append(lathe_dir(coll, 'vent', [(0.0, 0.0), (0.018, 0.0), (0.020, 0.010), (0.014, 0.022), (0.0, 0.024)],
                            (0, 1, 0), (0, TR[1] + 0.13, -0.40), 'iron', 20))
    # Carriage: stepped cheeks, bed, transom, axletrees, trucks with iron tyres and linchpins, quoin,
    # cap squares over the trunnions, breeching and train-tackle ringbolts.
    for sx in (-1, 1):
        for i, (z, h) in enumerate(((0.36, 0.50), (0.02, 0.48), (-0.32, 0.32))):
            body.append(box(coll, f'cheek_{sx}_{i}', 0.10, h, 0.36, (sx * 0.24, 0.12 + h * 0.5, z), 'oak_dark',
                            bev=0.014, cuts=2))
        body.append(box(coll, f'capsq_{sx}', 0.11, 0.022, 0.18, (sx * 0.24, 0.672, TR[2]), 'iron', bev=0.006))
        for j, z in enumerate((0.40, -0.36)):
            body.append(torus(coll, f'ringbolt_{sx}_{j}', 0.040, 0.010, 'x', (sx * 0.30, 0.40, z), 'iron', 32, 8))
            body.append(lathe_dir(coll, f'boltboss_{sx}_{j}', [(0.0, 0.0), (0.026, 0.0), (0.024, 0.012), (0.0, 0.014)],
                                  (sx, 0, 0), (sx * 0.29, 0.40, z), 'iron', 20))
    body.append(box(coll, 'bed', 0.40, 0.08, 1.02, (0, 0.16, 0.02), 'oak', cuts=2))
    body.append(box(coll, 'transom', 0.40, 0.20, 0.10, (0, 0.30, 0.48), 'oak_dark'))
    body.append(box(coll, 'quoin', 0.18, 0.14, 0.32, (0, 0.30, -0.26), 'oak',
                    rot=Matrix.Rotation(math.radians(8), 4, 'X')))
    body.append(lathe_dir(coll, 'quoin_handle', [(0.0, 0.0), (0.016, 0.0), (0.014, 0.10), (0.022, 0.11),
                                                 (0.020, 0.13), (0.0, 0.135)], (0, 0, -1), (0, 0.32, -0.42), 'walnut', 16))
    for i, z in enumerate((0.42, -0.36)):
        body.append(box(coll, f'axletree_{i}', 0.66, 0.11, 0.13, (0, 0.13, z), 'oak_dark', cuts=1))
        for sx in (-1, 1):
            tp = [(0.0, -0.05), (0.040, -0.05), (0.048, -0.046), (0.094, -0.044), (0.106, -0.040), (0.108, -0.030),
                  (0.108, 0.030), (0.106, 0.040), (0.094, 0.044), (0.048, 0.046), (0.040, 0.05), (0.0, 0.05)]
            body.append(lathe(coll, f'truck_{i}_{sx}', tp, 'x', (sx * 0.38, 0.115, z), 'oak', 48))
            body.append(torus(coll, f'tyre_{i}_{sx}', 0.110, 0.011, 'x', (sx * 0.38, 0.115, z), 'iron', 48, 8))
            body.append(lathe_dir(coll, f'axlecap_{i}_{sx}', [(0.0, 0.050), (0.030, 0.050), (0.032, 0.070),
                                                              (0.020, 0.080), (0.0, 0.082)], (sx, 0, 0),
                                  (sx * 0.38, 0.115, z), 'iron', 24))
            body.append(lathe_dir(coll, f'linchpin_{i}_{sx}', [(0.0, 0.0), (0.007, 0.0), (0.007, 0.05), (0.012, 0.055),
                                                              (0.0, 0.06)], (0, 1, 0), (sx * 0.46, 0.12, z), 'iron', 12))
    return {'cannon_body': (body, None), 'barrel': (barrel, TR)}


def build_wheel(coll):
    body = []
    R = 0.52
    rr = []  # the felloe: a rounded-rectangle section swept round the axle
    for k in range(20):
        a = 2 * math.pi * k / 20
        rr.append((R + 0.046 * math.cos(a) * (1.0 if abs(math.cos(a)) > 0.3 else 0.9), 0.040 * math.sin(a)))
    felloe = rr
    body.append(lathe(coll, 'rim', felloe, 'z', (0, 0, 0), 'oak', 112, closed=True))
    body.append(torus(coll, 'rim_band', R + 0.047, 0.008, 'z', (0, 0, 0), 'brass', 112, 8))
    for i, zz in enumerate((-0.043, 0.043)):
        body.append(torus(coll, f'rim_face_{i}', R, 0.006, 'z', (0, 0, zz), 'brass', 96, 6))
    hub = [(0.0, -0.11), (0.060, -0.11), (0.080, -0.10), (0.120, -0.08), (0.140, -0.06), (0.146, -0.03),
           (0.146, 0.03), (0.140, 0.06), (0.120, 0.08), (0.080, 0.10), (0.060, 0.11), (0.030, 0.13),
           (0.034, 0.15), (0.0, 0.155)]
    body.append(lathe(coll, 'hub', hub, 'z', (0, 0, 0), 'walnut', 56))
    for i, zz in enumerate((-0.07, 0.07)):
        body.append(torus(coll, f'hub_band_{i}', 0.136, 0.012, 'z', (0, 0, zz), 'brass', 56, 8))
    # Ten turned spokes run from the hub through the rim into turned handles.
    sp = [(0.0, 0.12), (0.030, 0.12), (0.030, 0.16), (0.036, 0.18), (0.032, 0.22), (0.026, 0.30), (0.028, 0.36),
          (0.034, 0.38), (0.028, 0.40), (0.026, 0.46), (0.024, 0.52), (0.024, 0.58), (0.030, 0.60), (0.036, 0.63),
          (0.030, 0.66), (0.026, 0.70), (0.034, 0.74), (0.038, 0.78), (0.034, 0.82), (0.024, 0.85), (0.0, 0.855)]
    for i in range(10):
        a = 2 * math.pi * i / 10
        body.append(lathe_dir(coll, f'spoke_{i}', sp, (math.cos(a), math.sin(a), 0), (0, 0, 0), 'walnut', 20))
    return {'wheel_body': (body, None)}


def build_capstan(coll):
    body, drum = [], []
    base = [(0.0, 0.0), (0.44, 0.0), (0.46, 0.012), (0.46, 0.05), (0.44, 0.07), (0.40, 0.08), (0.38, 0.10),
            (0.34, 0.105), (0.0, 0.106)]
    body.append(lathe(coll, 'base', base, 'y', (0, 0, 0), 'oak_dark', 64))
    body.append(torus(coll, 'pawl_rim', 0.415, 0.022, 'y', (0, 0.10, 0), 'iron', 64, 8))
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        body.append(box(coll, f'pawl_{k}', 0.05, 0.04, 0.14, (math.cos(a) * 0.40, 0.13, math.sin(a) * 0.40), 'iron',
                        rot=Matrix.Rotation(-a, 4, 'Z'), bev=0.006))
    dp = [(0.0, 0.10), (0.30, 0.10), (0.31, 0.12), (0.27, 0.16), (0.25, 0.44), (0.27, 0.70), (0.31, 0.72),
          (0.35, 0.74), (0.36, 0.80), (0.35, 0.86), (0.30, 0.88), (0.12, 0.90), (0.08, 0.95), (0.0, 0.96)]
    drum.append(lathe(coll, 'drum', dp, 'y', (0, 0, 0), 'oak', 64))
    for k, y in enumerate((0.20, 0.64)):
        drum.append(torus(coll, f'drum_band_{k}', 0.262 + 0.004 * k, 0.012, 'y', (0, y, 0), 'brass', 64, 8))
    for i in range(6):
        a = 2 * math.pi * i / 6
        cx, cz = math.cos(a), math.sin(a)
        drum.append(box(coll, f'whelp_{i}', 0.08, 0.50, 0.12, (cx * 0.29, 0.43, cz * 0.29), 'oak_dark',
                        rot=Matrix.Rotation(-a, 4, 'Z'), bev=0.012, cuts=2))
        bp = [(0.0, 0.20), (0.040, 0.20), (0.042, 0.26), (0.036, 0.30), (0.034, 0.60), (0.032, 0.86), (0.036, 0.92),
              (0.034, 0.98), (0.0, 0.99)]
        drum.append(lathe_dir(coll, f'bar_{i}', bp, (cx, 0, cz), (0, 0.80, 0), 'walnut', 20))
    return {'capstan_body': (body, None), 'drum': (drum, (0, 0, 0))}


def build_lantern(coll):
    body, glass = [], []
    body.append(torus(coll, 'hook', 0.040, 0.009, 'x', (0, -0.040, 0), 'iron', 28, 8))
    top = [(0.0, -0.075), (0.014, -0.078), (0.020, -0.095), (0.070, -0.115), (0.120, -0.150), (0.190, -0.200),
           (0.195, -0.215), (0.170, -0.228), (0.0, -0.230)]
    body.append(lathe(coll, 'roof', list(reversed(top)), 'y', (0, 0, 0), 'iron', 40,
                      cap_start=False, cap_end=False))
    body.append(torus(coll, 'roof_band', 0.165, 0.008, 'y', (0, -0.232, 0), 'brass', 40, 8))
    pan = [(0.0, -0.66), (0.10, -0.66), (0.16, -0.645), (0.185, -0.62), (0.185, -0.60), (0.160, -0.590),
           (0.150, -0.585), (0.0, -0.584)]
    body.append(lathe(coll, 'base_pan', pan, 'y', (0, 0, 0), 'iron', 40,
                      cap_start=False, cap_end=False))
    for i in range(6):
        a = 2 * math.pi * i / 6
        pp = [(0.0, 0.0), (0.012, 0.0), (0.010, 0.03), (0.010, 0.31), (0.012, 0.34), (0.0, 0.345)]
        body.append(lathe(coll, f'post_{i}', pp, 'y', (math.cos(a) * 0.148, -0.585, math.sin(a) * 0.148),
                          'brass', 12))
    for i, y in enumerate((-0.30, -0.50)):
        body.append(torus(coll, f'guard_{i}', 0.152, 0.006, 'y', (0, y, 0), 'iron', 40, 6))
    gp = [(0.0, -0.58), (0.132, -0.58), (0.132, -0.24), (0.0, -0.24)]
    glass.append(lathe(coll, 'glass_pane', gp, 'y', (0, 0, 0), GLASS, 32,
                       cap_start=False, cap_end=False))
    return {'ship_lantern_body': (body, None), 'glass': (glass, None)}


BUILDS = [('cannon', build_cannon), ('wheel', build_wheel), ('capstan', build_capstan),
          ('ship_lantern', build_lantern)]


def tris_of(objs):
    return sum(len(p.vertices) - 2 for o in objs for p in o.data.polygons)


def build(key, fn):
    """Build at density d; rebuild at a scaled density until the piece is inside its D27 band."""
    lo, hi = BANDS[key]
    target = (lo + hi) / 2
    D['d'] = 1.0
    for attempt in range(5):
        coll = asset_collection(key)  # noqa: F821 (from _helpers)
        groups = fn(coll)
        nodes = [join_as(parts, gname, pivot) for gname, (parts, pivot) in groups.items()]
        t = tris_of(nodes)
        print(f'BUILD {key} d={D["d"]:.3f} tris={t}', flush=True)
        if lo <= t <= hi:
            DENS[key] = round(D['d'], 3)
            return coll, nodes, t
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        D['d'] *= target / t
    raise RuntimeError(f'{key}: could not land in {BANDS[key]}')


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_animations=False, export_skins=False, export_morph=False, export_image_format='JPEG',
              export_jpeg_quality=90, export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
    last = None
    for drop in ((), ('export_active_vertex_color_when_no_material',), ('export_jpeg_quality',)):
        try:
            bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k not in drop})
            return path
        except TypeError as e:
            last = e
    raise last


def glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    jl = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + jl])


def glb_tris(path):
    j = glb(path)
    return sum(j['accessors'][p['indices']]['count'] // 3 for m in j['meshes'] for p in m['primitives'])


def white(objs):
    for o in objs:
        col = o.data.color_attributes.get('Col') or o.data.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        for c in col.data:
            c.color = (1.0, 1.0, 1.0, 1.0)
        o.data.color_attributes.active_color = col


P.require_licensed(SOURCES)
built = {}
for key, fn in BUILDS:
    built[key] = build(key, fn)
# ONE atlas for the whole kit: park the pieces apart so nothing occludes another in the AO bake.
atlas_objs = []
for i, (key, (coll, nodes, t)) in enumerate(built.items()):
    for o in nodes:
        o.location.x += 4.0 * i
        if o.name != 'glass':
            atlas_objs.append(o)
A.pbr_atlas(atlas_objs, 'ship_hardware', tier='near', samples=SAMPLES)
for i, (key, (coll, nodes, t)) in enumerate(built.items()):
    for o in nodes:
        o.location.x -= 4.0 * i
report, failed = {}, []
for key, (coll, nodes, t) in built.items():
    for o in nodes:
        for poly in o.data.polygons:
            poly.material_index = 0
    white(nodes)
    path = export(nodes, os.path.join(OUT, f'{key}.glb'))
    j = glb(path)
    errs = []
    lo, hi = BANDS[key]
    tris = glb_tris(path)
    if not lo <= tris <= hi:
        errs.append(f'{tris} tris outside {BANDS[key]}')
    for m in j.get('materials', []):
        pmr = m.get('pbrMetallicRoughness', {})
        card = 'glass' in m['name'].lower() or 'flame' in m['name'].lower()
        if m.get('doubleSided') and not card:
            errs.append(f"{m['name']} doubleSided")
        if not card and ('normalTexture' not in m or 'occlusionTexture' not in m
                         or 'metallicRoughnessTexture' not in pmr or 'baseColorTexture' not in pmr):
            errs.append(f"{m['name']} lacks baseColor + normal + ORM")
    report[key] = {'tris': tris, 'density': DENS[key], 'nodes': sorted(o.name for o in nodes),
                   'bytes': os.path.getsize(path), 'errors': errs}
# FAR: the same shared atlas at FAR_ATLAS px (a 60 m+ piece covers a few dozen pixels), the same nodes,
# decimated to the v1 far file's triangle count so the low tier (far only) pays no more than before.
for img in {n.image for m in bpy.data.materials if m.node_tree for n in m.node_tree.nodes
            if n.type == 'TEX_IMAGE' and n.image and m.name.startswith('PBR_')}:
    img.scale(FAR_ATLAS, FAR_ATLAS)
for key, (coll, nodes, t) in built.items():
    tris, errs = report[key]['tris'], report[key]['errors']
    ratio = max(0.01, min(0.45, FAR_CAP[key] / float(tris)))
    for o in nodes:
        mod = o.modifiers.new('far', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    fpath = export(nodes, os.path.join(OUT, f'{key}_far.glb'))
    ftris = glb_tris(fpath)
    if ftris > tris * 0.45 or ftris > FAR_CAP[key]:
        errs.append(f'far {ftris} tris > v1 far {FAR_CAP[key]} or 45% of {tris}')
    report[key].update(far_tris=ftris, far_cap=FAR_CAP[key], far_bytes=os.path.getsize(fpath))
    print(f'HARDWARE {key}: {json.dumps(report[key])}', flush=True)
    if errs:
        failed.append(key)

print('HARDWARE REPORT ' + json.dumps(report))
if failed:
    print(f'HARDWARE FAILED: {failed}')
    sys.exit(1)
print('SHIP HARDWARE DONE')
