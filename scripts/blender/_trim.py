"""FAMILY TRIM SHEETS (b3.4c; assets-14, assets-02). PBR infrastructure II, beside _hires / _pbr.

A trim sheet is ONE baked texture set (baseColor / normal / ORM) cut into horizontal STRIPS. Each strip
tiles along U and is a finished surface across V: a plank with rounded long edges, an iron band with
rivet heads, an ashlar course with mortar joints, a hemmed canvas edge, a laid three-strand rope, a
course of shingles. An asset UVs its faces onto strips (`trim_uv`) instead of baking its own atlas, so
every barrel, crate, hull rail and roof in a family shares one material and one set of images, and the
bevels / rivets / seams come from the sheet's normal map instead of from geometry.

Families (PLAN 3.12 / section 6, row 5): wood_iron, stone, canvas, rope, shingle. Every source is a
PolyHaven CC0 set by id (via `_pbr.fetch`, cached, a TEXTURE_LICENSES.md row each).

How a sheet is made (`build_sheet`): a 1 m x 1 m plane with 0..1 UVs is the bake target; above it, per
strip, HIGH geometry authored in sheet space (bevelled slabs, grooved blocks, lathed rivet heads, lofted
mouldings and helical rope strands) carries a box-projected PolyHaven material. `_pbr.bake_pbr` bakes
high -> plane through a cage. Everything along X is PERIODIC in the sheet width (joint pitch, rope lay
and the source texture's repeat all divide 1 m), so U wraps without a seam. The result is cached under
scripts/blender/.cache/trim/<family>/<tier>/ keyed on the family spec + tier + samples + source md5s,
so a second build in any script is a file read, not a bake.

    import _trim as TR
    sheet = TR.build_sheet('wood_iron', tier='near')       # {'paths', 'strips': {name: (v0, v1)}, ...}
    mat = TR.trim_material('wood_iron', sheet)             # one PBR material, single-sided
    TR.trim_uv(obj, {'wood': 'plank', 'iron': 'iron_band'}, sheet, run={'plank': 'z', 'iron_band': 'ring'})

`trim_uv` maps every face by its material slot name to a strip: U runs along `run` ('x'|'y'|'z' world
axis, or 'ring' = around the object's Z axis) at the sheet's world density; V is the face's extent
across the run, fitted inside the strip with a pixel pad, so a face never samples its neighbour strip.
"""
import hashlib
import json
import math
import os

import bmesh
import bpy
from mathutils import Vector

import _hires as H
import _pbr as P

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache', 'trim')
SHEET_M = 1.0          # the sheet covers 1 m x 1 m of surface: 1024 px = ~1 px/mm at the near tier
PAD_PX = 3             # V pad inside a strip (texels) so bilinear + mips never bleed into the neighbour
OFF = Vector((0.0, 0.0, -400.0))   # the sheet is built far below any asset (AO rays never reach it)
VERSION = 1

WOOD, IRON, SLATE, LINEN, HESSIAN = ('brown_planks_03', 'rust_coarse_01', 'castle_wall_slates',
                                     'rough_linen', 'hessian_230')

# Strips top to bottom; h = fraction of the sheet (a family sums to 1.0). kind:
#   slab     one bevelled board across the sheet          grooved  blocks of `joint` m with V-joints
#   rivets   a bevelled band with lathed rivet heads      round    a half-round moulding / hem / bead
#   rope     `strands` helical strands, lay `pitch` m     shingles overlapping tilted tiles `joint` wide
FAMILIES = {
    'wood_iron': {'ao': 0.03, 'strips': [
        dict(name='plank', h=0.22, kind='slab', src=WOOD, bevel=0.012, wear=0.3),
        dict(name='plank_narrow', h=0.12, kind='slab', src=WOOD, bevel=0.008, tint=(0.82, 0.74, 0.64), wear=0.3),
        dict(name='plank_dark', h=0.14, kind='slab', src=WOOD, bevel=0.010, tint=(0.55, 0.47, 0.40), wear=0.2),
        dict(name='moulding', h=0.08, kind='round', src=WOOD),
        dict(name='iron_band', h=0.10, kind='rivets', src=IRON, metal='iron', pitch=0.1, bevel=0.004),
        dict(name='iron_plate', h=0.14, kind='slab', src=IRON, metal='iron', bevel=0.006),
        dict(name='brass', h=0.08, kind='round', src=IRON, metal='brass', tint=(1.0, 0.74, 0.36)),
        dict(name='plank_worn', h=0.12, kind='grooved', src=WOOD, joint=0.25, bevel=0.008, wear=0.5,
             tint=(0.76, 0.72, 0.68)),
    ]},
    'stone': {'ao': 0.06, 'strips': [
        dict(name='ashlar', h=0.34, kind='grooved', src=SLATE, joint=0.25, bevel=0.015),
        dict(name='ashlar_small', h=0.20, kind='grooved', src=SLATE, joint=0.125, bevel=0.010),
        dict(name='ledge', h=0.16, kind='slab', src=SLATE, bevel=0.020),
        dict(name='rubble', h=0.18, kind='grooved', src=SLATE, joint=0.1, bevel=0.012, tint=(0.8, 0.8, 0.78)),
        dict(name='plinth', h=0.12, kind='round', src=SLATE),
    ]},
    'canvas': {'ao': 0.02, 'strips': [
        # rough_linen's albedo is a cool grey: the warm tint makes it unbleached sailcloth
        dict(name='panel', h=0.40, kind='grooved', src=LINEN, joint=0.25, bevel=0.004, tint=(1.0, 0.9, 0.72)),
        dict(name='plain', h=0.30, kind='slab', src=LINEN, bevel=0.003, tint=(1.0, 0.9, 0.72)),
        dict(name='hem', h=0.15, kind='round', src=LINEN, tint=(0.95, 0.84, 0.66)),
        dict(name='patch', h=0.15, kind='grooved', src=LINEN, joint=0.2, bevel=0.004, tint=(0.72, 0.66, 0.56)),
    ]},
    'rope': {'ao': 0.15, 'strips': [
        dict(name='rope_thick', h=0.40, kind='rope', src=HESSIAN, strands=3, pitch=0.5, tint=(0.78, 0.66, 0.48)),
        dict(name='rope_thin', h=0.25, kind='rope', src=HESSIAN, strands=3, pitch=0.25, tint=(0.78, 0.66, 0.48)),
        dict(name='lashing', h=0.20, kind='rope', src=HESSIAN, strands=4, pitch=0.2, tint=(0.62, 0.52, 0.38)),
        dict(name='whipping', h=0.15, kind='round', src=HESSIAN, tint=(0.5, 0.42, 0.32)),
    ]},
    'shingle': {'ao': 0.06, 'strips': [
        dict(name='wood_shingle', h=0.35, kind='shingles', src=WOOD, joint=0.125, tint=(0.7, 0.68, 0.64), wear=0.3),
        dict(name='slate', h=0.30, kind='shingles', src=SLATE, joint=0.2),
        dict(name='ridge', h=0.15, kind='round', src=WOOD, tint=(0.62, 0.58, 0.54)),
        dict(name='fascia', h=0.20, kind='slab', src=WOOD, bevel=0.01, tint=(0.66, 0.6, 0.54)),
    ]},
}


def sources(family):
    return sorted({s['src'] for s in FAMILIES[family]['strips']})


def strip_ranges(family):
    """{strip: (v0, v1)} in UV space; the first strip sits at the TOP of the image (v = 1)."""
    out, top = {}, 1.0
    for s in FAMILIES[family]['strips']:
        out[s['name']] = (round(top - s['h'], 6) + 0.0, round(top, 6) + 0.0)
        top -= s['h']
    if abs(top) > 1e-6:
        raise ValueError(f'trim {family}: strip heights sum to {1 - top:.3f}, not 1.0')
    return out


# ── sheet geometry (sheet space: x, y in [0, SHEET_M], plane at z = 0) ──────────────────────
def _box(name, x0, x1, y0, y1, z0, z1, mat, bevel):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), (y0 + y1) / 2 + v.co.y * (y1 - y0),
                       (z0 + z1) / 2 + v.co.z * (z1 - z0)))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat)
    if bevel:
        H.bevel(ob, bevel, segments=3, angle_deg=30, weighted=False)
    return ob


def _periodic(pitch):
    n = SHEET_M / pitch
    if abs(n - round(n)) > 1e-6:
        raise ValueError(f'trim: pitch {pitch} does not divide the {SHEET_M} m sheet (U would seam)')
    return int(round(n))


def _strip_geometry(fam, s, y0, y1, mat):
    hw, yc, name = y1 - y0, (y0 + y1) / 2, f'_trim_{fam}_{s["name"]}'
    k, objs = s['kind'], []
    X0, X1 = -0.06, SHEET_M + 0.06          # past both sheet edges so no end bevel is baked
    if k == 'slab':
        objs.append(_box(name, X0, X1, y0, y1, -0.03, 0.006, mat, s.get('bevel', 0.008)))
    elif k in ('grooved', 'rivets'):
        if k == 'grooved':
            j = s['joint']
            for i in range(-1, _periodic(j) + 1):
                objs.append(_box(f'{name}{i}', i * j + 0.003, (i + 1) * j - 0.003, y0, y1, -0.03, 0.006, mat,
                                 s.get('bevel', 0.008)))
        else:
            objs.append(_box(name, X0, X1, y0, y1, -0.03, 0.004, mat, s.get('bevel', 0.004)))
            r = min(0.3 * hw, 0.012)
            prof = [(r, 0.0), (0.92 * r, 0.3 * r), (0.7 * r, 0.6 * r), (0.35 * r, 0.8 * r), (0.0, 0.85 * r)]
            for i in range(-1, _periodic(s['pitch']) + 1):
                for yy in (y0 + 0.28 * hw, y1 - 0.28 * hw):
                    rv = H.lathe(f'{name}_rv{i}_{int(yy * 1e4)}', prof, 16, cap_start=True, material=mat)
                    rv.location = ((i + 0.5) * s['pitch'], yy, 0.004)
                    objs.append(rv)
    elif k == 'round':
        rz = min(hw / 2, 0.03)
        path = [Vector((X0 + (X1 - X0) * t / 8, yc, 0.0)) for t in range(9)]
        ob = H.loft(name, path, H.circle(32, hw / 2), material=mat)
        for v in ob.data.vertices:
            v.co.z *= rz / (hw / 2)
        objs.append(ob)
    elif k == 'rope':
        rr, n = hw / 2, s['strands']
        a, rs = rr * 0.45, rr * 0.56
        per = _periodic(s['pitch'])
        core = H.loft(f'{name}_core', [Vector((X0, yc, 0.0)), Vector((X1, yc, 0.0))], H.circle(16, rr * 0.5),
                      material=mat)
        objs.append(core)
        steps = 24 * (per + 2)
        for si in range(n):
            pts = []
            for t in range(steps + 1):
                x = -s['pitch'] + (per + 2) * s['pitch'] * t / steps
                th = 2 * math.pi * (x / s['pitch'] + si / n)
                pts.append(Vector((x, yc + a * math.cos(th), a * math.sin(th))))
            objs.append(H.loft(f'{name}_s{si}', pts, H.circle(10, rs), material=mat))
    elif k == 'shingles':
        j = s['joint']
        for i in range(-1, _periodic(j) + 1):
            ob = _box(f'{name}{i}', i * j + 0.004, (i + 1) * j - 0.004, y0, y1, -0.012, 0.0, mat, 0.004)
            tilt = math.radians(5.0)
            for v in ob.data.vertices:      # the lower (butt) edge stands proud: the course overlaps
                v.co.z += (y1 - v.co.y) * math.tan(tilt)
            objs.append(ob)
    else:
        raise ValueError(f'trim {fam}: unknown strip kind {k}')
    if k in ('grooved', 'shingles', 'rope'):
        # A recessed BACKING (mortar, roof boards, the rope's shadow) so every ray lands on a surface:
        # without it the joints and the gaps beside the strands bake black in baseColor and flat in normal.
        zt = -0.012 if k != 'rope' else -hw * 0.25
        objs.append(_box(f'{name}_back', X0, X1, y0, y1, zt - 0.04, zt, mat, 0))
    top = max((ob.matrix_world @ Vector(c)).z for ob in objs for c in ob.bound_box)
    return objs, top


def _strip_material(fam, s):
    src = P.fetch(s['src'])['manifest']
    world_m = max(1e-3, (src['dimensions_mm'] or [2000])[0] / 1000.0)
    reps = max(1, round(s.get('density', 1.0) * SHEET_M / world_m))
    scale = reps * world_m / SHEET_M        # an integer number of source repeats per sheet width
    kw = dict(scale=scale, tint=s.get('tint'), wear=s.get('wear', 0.0))
    name = f'_trim_{fam}_{s["name"]}'
    if s.get('metal'):
        return P.metal_material(name, s['src'], s['metal'], **kw)
    return P.source_material(name, s['src'], **kw)


def _key(family, tier, samples):
    md5 = {i: P.fetch(i)['manifest'].get('md5', {}) for i in sources(family)}
    # the geometry is CODE, not spec: hash this module (and _hires/_pbr) so any edit re-bakes
    code = [hashlib.sha1(open(os.path.join(HERE, f), 'rb').read()).hexdigest() for f in ('_trim.py', '_hires.py', '_pbr.py')]
    blob = json.dumps([VERSION, SHEET_M, FAMILIES[family], tier, samples, md5, code], sort_keys=True, default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def build_sheet(family, tier='near', samples=8, force=False):
    """Bake (or read from the cache) one family sheet. Returns {'paths': {basecolor, normal, orm},
    'strips': {name: (v0, v1)}, 'size', 'cached', 'seconds', 'family', 'sources'}."""
    import time
    if family not in FAMILIES:
        raise KeyError(f'trim: no family {family!r} (have {", ".join(FAMILIES)})')
    P.require_licensed(sources(family))
    ranges = strip_ranges(family)
    out_dir = os.path.join(CACHE, family, tier)
    meta_p = os.path.join(out_dir, 'meta.json')
    key = _key(family, tier, samples)
    if not force and os.path.exists(meta_p):
        meta = json.load(open(meta_p))
        if meta.get('key') == key and all(os.path.exists(p) for p in meta['paths'].values()):
            meta.update(cached=True, strips={k: tuple(v) for k, v in meta['strips'].items()})
            return meta
    t0 = time.time()
    me = bpy.data.meshes.new(f'_trim_{family}_plane')
    me.from_pydata([(0, 0, 0), (SHEET_M, 0, 0), (SHEET_M, SHEET_M, 0), (0, SHEET_M, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name='UVMap')
    for li, lp in enumerate(me.loops):
        co = me.vertices[lp.vertex_index].co
        uv.data[li].uv = (co.x / SHEET_M, co.y / SHEET_M)
    plane = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(plane)
    highs, mats, top = [], [], 0.0
    for s in FAMILIES[family]['strips']:
        v0, v1 = ranges[s['name']]
        m = _strip_material(family, s)
        mats.append(m)
        objs, t = _strip_geometry(family, s, v0 * SHEET_M, v1 * SHEET_M, m)
        highs += objs
        top = max(top, t)
    for ob in highs + [plane]:
        ob.location = ob.location + OFF
    cage = P.make_cage(plane, top + 0.02)
    res = P.bake_pbr(plane, highs, out_dir, f'trim_{family}', tier=tier, samples=samples, cage=cage,
                     ao_distance=FAMILIES[family]['ao'], margin_px=2)
    for ob in highs + [plane, cage]:
        bpy.data.objects.remove(ob)
    for m in mats:
        bpy.data.materials.remove(m)
    meta = {'key': key, 'family': family, 'tier': tier, 'size': res['size'], 'samples': samples,
            'paths': res['paths'], 'strips': ranges, 'sources': sources(family),
            'seconds': round(time.time() - t0, 2), 'high_objects': len(highs)}
    with open(meta_p, 'w') as f:
        json.dump(meta, f, indent=1)
    meta['cached'] = False
    return meta


def trim_material(family, sheet):
    """ONE material `Trim_<family>` sampling the sheet: baseColor, ORM (occlusion via the glTF output
    group, rough G, metal B) and a tangent-space normal. Single-sided (glTF doubleSided false)."""
    name = f'Trim_{family}'
    old = bpy.data.materials.get(name)
    if old is not None and old.get('trim_key') == sheet['key']:
        return old
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')

    def tex(key, data):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = P._img(sheet['paths'][key], data)
        return n

    nt.links.new(tex('basecolor', False).outputs['Color'], bsdf.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tex('orm', True).outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    grp = nt.nodes.new('ShaderNodeGroup')
    grp.node_tree = P._gltf_output_group()
    nt.links.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex('normal', True).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    mat['trim_family'] = family
    mat['trim_key'] = sheet['key']
    mat['pbr_sources'] = ','.join(sheet['sources'])
    return mat


_AXES = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def trim_uv(obj, mapping, sheet, run='z', u_scale=1.0, pad_px=PAD_PX, v_world=True):
    """UV every face of `obj` onto a strip of `sheet` and give it the family material as its ONLY slot.

    mapping: a strip name for every face, or {material slot name: strip}. run: 'x'|'y'|'z'|'ring', or
    {strip: run}. U follows the run at the sheet's world density (x u_scale); V is the face's extent
    across the run, at world density when it fits the strip, squeezed to fit when it does not, centred,
    with `pad_px` texels clear of both strip edges. Returns {strip: faces}."""
    ranges = sheet['strips']
    pad = pad_px / float(sheet['size'])
    me = obj.data
    slot_names = [m.name if m else '' for m in me.materials]
    mw, rot = obj.matrix_world, obj.matrix_world.to_3x3()
    centre = mw.translation
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    count = {}
    for f in bm.faces:
        strip = mapping if isinstance(mapping, str) else mapping.get(slot_names[f.material_index] if slot_names else '')
        if strip is None or strip not in ranges:
            bm.free()
            raise KeyError(f'trim_uv {obj.name}: face material {slot_names[f.material_index]!r} maps to no strip '
                           f'of {sheet["family"]} ({", ".join(ranges)})')
        rmode = run if isinstance(run, str) else run.get(strip, 'z')
        n = (rot @ f.normal).normalized()
        pts = [mw @ l.vert.co for l in f.loops]
        pc = sum(pts, Vector()) / len(pts)
        if rmode == 'ring':
            rad = Vector((pc.x - centre.x, pc.y - centre.y, 0.0))
            R = Vector((0, 0, 1)).cross(rad).normalized() if rad.length > 1e-5 else Vector((1, 0, 0))
        else:
            R = _AXES[rmode].copy()
        if abs(n.dot(R)) > 0.8:        # a face looking down the run (an end cap): run across it instead
            R = min(_AXES.values(), key=lambda a: abs(n.dot(a))).copy()
            rmode = 'axis'
        R = (R - n * n.dot(R)).normalized()
        V = n.cross(R).normalized()
        if rmode == 'ring':
            ac = math.atan2(pc.y - centre.y, pc.x - centre.x)
            rc = Vector((pc.x - centre.x, pc.y - centre.y)).length
            us = [(ac + _wrap(math.atan2(p.y - centre.y, p.x - centre.x) - ac)) * rc for p in pts]
        else:
            us = [p.dot(R) for p in pts]
        vs = [p.dot(V) for p in pts]
        v0, v1 = ranges[strip]
        room = (v1 - v0) - 2 * pad
        span = max(vs) - min(vs)
        k = 1.0 / SHEET_M if v_world else room / max(span, 1e-9)
        if span * k > room:
            k = room / span
        base = v0 + pad + (room - span * k) / 2 - min(vs) * k
        for l, u, v in zip(f.loops, us, vs):
            l[uvl].uv = (u / SHEET_M * u_scale, base + v * k)
        f.material_index = 0
        count[strip] = count.get(strip, 0) + 1
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(trim_material(sheet['family'], sheet))
    return count


print('trim helpers loaded')
