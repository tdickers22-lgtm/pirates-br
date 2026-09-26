"""PBR SOURCE + BAKE CHAIN (b3.4b; assets-02, assets-14, PLAN 3.12 / D5 / section 6).

The 2026-09 hero atlas (_atlas.hero_atlas) is a DIFFUSE COLOR transfer of palette x AO: no grain, no
wear, no normal map, metallic 0 / roughness 0.62 on steel, brass and wood alike. This module is the
material half of the rebuild:

  fetch(id)                  PolyHaven CC0 texture set by id over api.polyhaven.com (Diffuse, nor_gl,
                             arm = AO/rough/metal) into the gitignored scripts/blender/.cache/polyhaven,
                             md5-checked, with a manifest (name, authors, CC0, source URL); offline runs
                             reuse the cache and never touch the network
  require_licensed(ids)      every id used by a build has a row in public/assets/models/TEXTURE_LICENSES.md
  source_material(...)       box-projected (object space, real-world scale from the asset's dimensions)
                             Principled material: albedo x tint, roughness, metal (or an override), tangent
                             normal, optional edge wear from pointiness
  smart_uv(objs)             one shared smart-UV layout (the low mesh's bake target, the high mesh's tangents)
  make_cage(low, offset)     explicit bake cage: the low mesh pushed out along its vertex normals
  bake_pbr(low, high, ...)   Cycles CPU bake (<= 32 samples) high -> low through the cage:
                             BaseColor (sRGB), tangent Normal, ORM (R AO, G roughness, B metal) at
                             1024 (near) / 512 (far), written as PNG next to each other
  apply_baked(low, maps)     ONE glTF-ready material: baseColor, ORM -> occlusion + metallicRoughness,
                             normalTexture, single-sided (use_backface_culling -> doubleSided false)

BaseColor, roughness and metal are baked through an EMISSION swap (Cycles has no metallic bake, and
its DIFFUSE colour pass reads black on a metal), so every channel is exactly the source socket's value.
Machine protection (COMMON.md): headless Blender only, Cycles CPU, samples <= 32, one process.
"""
import hashlib
import json
import os
import subprocess
import time
import urllib.request

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CACHE = os.path.join(HERE, '.cache', 'polyhaven')
LICENSES_MD = os.path.join(ROOT, 'public', 'assets', 'models', 'TEXTURE_LICENSES.md')
API = 'https://api.polyhaven.com'
UA = 'pirates-br-asset-build/1.0 (+scripts/blender/_pbr.py)'
MAPS = ('Diffuse', 'nor_gl', 'arm')
MAX_SAMPLES = 32
BAKE_SIZE = {'near': 1024, 'far': 512}

# PLAN 3.12 metals: metalness 1.0, iron roughness 0.4-0.7, brass 0.3-0.5.
METAL = {'iron': (1.0, 0.55), 'brass': (1.0, 0.4), 'steel': (1.0, 0.35)}

_net_calls = 0


def net_calls():
    """How many HTTP requests this process made (the smoke test proves the cache is used)."""
    return _net_calls


def _get(url):
    global _net_calls
    _net_calls += 1
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except Exception:
        # Blender's bundled Python has no system CA store on some installs: curl has.
        return subprocess.run(['curl', '-fsSL', '-m', '60', '-A', UA, url], check=True,
                              capture_output=True).stdout


def _md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(asset_id, res='1k', maps=MAPS, fmt='jpg'):
    """Return {'maps': {map: path}, 'manifest': {...}} for a PolyHaven texture set, downloading only
    what the cache lacks (or what fails its md5)."""
    d = os.path.join(CACHE, asset_id, res)
    os.makedirs(d, exist_ok=True)
    man_path = os.path.join(d, 'manifest.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else None
    have = man is not None and all(
        m in man['files'] and os.path.exists(os.path.join(d, man['files'][m]['file']))
        and _md5(os.path.join(d, man['files'][m]['file'])) == man['files'][m]['md5'] for m in maps)
    if not have:
        info = json.loads(_get(f'{API}/info/{asset_id}'))
        if info.get('type') != 1:
            raise RuntimeError(f'polyhaven {asset_id}: not a texture asset (type {info.get("type")})')
        files = json.loads(_get(f'{API}/files/{asset_id}'))
        man = {
            'id': asset_id, 'name': info.get('name', asset_id),
            'authors': sorted((info.get('authors') or {}).keys()),
            'license': 'CC0 1.0', 'source': f'https://polyhaven.com/a/{asset_id}',
            'dimensions_mm': info.get('dimensions') or [2000, 2000],
            'res': res, 'fetched': time.strftime('%Y-%m-%d'), 'files': {},
        }
        for m in maps:
            ent = files[m][res][fmt]
            name = os.path.basename(ent['url'])
            path = os.path.join(d, name)
            if not (os.path.exists(path) and _md5(path) == ent['md5']):
                data = _get(ent['url'])
                with open(path, 'wb') as f:
                    f.write(data)
                if _md5(path) != ent['md5']:
                    raise RuntimeError(f'polyhaven {asset_id} {m}: md5 mismatch')
            man['files'][m] = {'file': name, 'md5': ent['md5'], 'url': ent['url']}
        with open(man_path, 'w') as f:
            json.dump(man, f, indent=1)
    return {'maps': {m: os.path.join(d, man['files'][m]['file']) for m in maps}, 'manifest': man}


def licensed_ids():
    """PolyHaven ids with a row in TEXTURE_LICENSES.md (first column, backticked)."""
    if not os.path.exists(LICENSES_MD):
        return set()
    out = set()
    for line in open(LICENSES_MD, encoding='utf-8'):
        if line.startswith('| `'):
            out.add(line.split('`')[1])
    return out


def require_licensed(ids):
    missing = sorted(set(ids) - licensed_ids())
    if missing:
        raise RuntimeError(f'TEXTURE_LICENSES.md has no row for {missing}: add one per source (D37)')


# ── source materials ─────────────────────────────────────────
def _img(path, data):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return img


def source_material(name, asset_id, res='1k', scale=1.0, tint=None, metallic=None, roughness=None,
                    rough_mul=1.0, normal_strength=1.0, wear=0.0, blend=0.25):
    """Box-projected PolyHaven material. `scale` multiplies the texture's real-world density (2 = the
    grain twice as fine). `metallic`/`roughness` override the arm channels with constants (a metal
    source's arm often has no metal); `wear` (0-1) lightens and smooths convex edges (pointiness)."""
    src = fetch(asset_id, res)
    world_m = max(1e-3, (src['manifest']['dimensions_mm'] or [2000])[0] / 1000.0)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (scale / world_m,) * 3
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])

    def tex(path, data):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = _img(path, data)
        n.projection = 'BOX'
        n.projection_blend = blend
        nt.links.new(mp.outputs['Vector'], n.inputs['Vector'])
        return n

    alb = tex(src['maps']['Diffuse'], False)
    col = alb.outputs['Color']
    if tint is not None:
        mx = nt.nodes.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        mx.inputs['Factor'].default_value = 1.0
        nt.links.new(col, mx.inputs['A'])
        mx.inputs['B'].default_value = (*tint[:3], 1.0)
        col = mx.outputs['Result']
    arm = tex(src['maps']['arm'], True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(arm.outputs['Color'], sep.inputs['Color'])
    rough = sep.outputs['Green']
    if roughness is not None:
        bsdf.inputs['Roughness'].default_value = roughness
        rough = None
    elif rough_mul != 1.0:
        mm = nt.nodes.new('ShaderNodeMath')
        mm.operation = 'MULTIPLY'
        mm.use_clamp = True
        nt.links.new(rough, mm.inputs[0])
        mm.inputs[1].default_value = rough_mul
        rough = mm.outputs['Value']
    if wear > 0:
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        ramp = nt.nodes.new('ShaderNodeMapRange')
        ramp.inputs['From Min'].default_value = 0.5
        ramp.inputs['From Max'].default_value = 0.62
        ramp.inputs['To Max'].default_value = wear
        nt.links.new(geo.outputs['Pointiness'], ramp.inputs['Value'])
        wm = nt.nodes.new('ShaderNodeMix')
        wm.data_type = 'RGBA'
        wm.blend_type = 'SCREEN'
        nt.links.new(ramp.outputs['Result'], wm.inputs['Factor'])
        nt.links.new(col, wm.inputs['A'])
        wm.inputs['B'].default_value = (0.55, 0.52, 0.48, 1.0)
        col = wm.outputs['Result']
        if rough is not None:
            rs = nt.nodes.new('ShaderNodeMath')
            rs.operation = 'SUBTRACT'
            rs.use_clamp = True
            nt.links.new(rough, rs.inputs[0])
            nt.links.new(ramp.outputs['Result'], rs.inputs[1])
            rough = rs.outputs['Value']
    nt.links.new(col, bsdf.inputs['Base Color'])
    if rough is not None:
        nt.links.new(rough, bsdf.inputs['Roughness'])
    if metallic is not None:
        bsdf.inputs['Metallic'].default_value = metallic
    else:
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    nrm = tex(src['maps']['nor_gl'], True)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = normal_strength
    nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    mat['pbr_source'] = asset_id
    return mat


def metal_material(name, asset_id, kind='iron', **kw):
    """PLAN 3.12 metal: metalness 1.0 and the kind's roughness band centre."""
    m, r = METAL[kind]
    met = kw.pop('metallic', None)
    return source_material(name, asset_id, metallic=m if met is None else met,
                           roughness=kw.pop('roughness', r), **kw)


# ── UVs, cage ────────────────────────────────────────────────
def _select(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def smart_uv(objs, angle_deg=66.0, island_margin=0.02):
    import math
    _select(objs, objs[0])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=island_margin,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def make_cage(low, offset=0.02):
    """Explicit cage: same topology as `low`, every vertex pushed `offset` m along its normal."""
    me = low.data.copy()
    me.name = f'{low.name}_cage'
    for v in me.vertices:
        v.co = v.co + v.normal * offset
    cage = bpy.data.objects.new(me.name, me)
    cage.matrix_world = low.matrix_world.copy()
    for c in low.users_collection:
        c.objects.link(cage)
    cage.hide_render = True
    return cage


# ── bake ─────────────────────────────────────────────────────
def _new_image(name, size, data):
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, width=size, height=size, alpha=False)
    img.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return img


def _target(low, img):
    """The low mesh's materials get `img` as their ACTIVE image node (Cycles bakes into it)."""
    if not low.data.materials:
        low.data.materials.append(bpy.data.materials.new(f'{low.name}_bake'))
    added = []
    for m in low.data.materials:
        m.use_nodes = True
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        n.image = img
        n.select = True
        m.node_tree.nodes.active = n
        added.append((m, n))
    return added


def _emission_swap(mats, socket):
    """Route Principled `socket` (linked or constant) into an Emission shader on the output."""
    undo = []
    for m in mats:
        nt = m.node_tree
        bsdf = nt.nodes.get('Principled BSDF')
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
        if bsdf is None or out is None:
            continue
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.0
        s = bsdf.inputs[socket]
        if s.is_linked:
            nt.links.new(s.links[0].from_socket, em.inputs['Color'])
        else:
            v = s.default_value
            em.inputs['Color'].default_value = (tuple(v)[:3] + (1.0,)) if hasattr(v, '__len__') else (v, v, v, 1.0)
        prev = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        undo.append((nt, em, out, prev))
    return undo


def _emission_restore(undo):
    for nt, em, out, prev in undo:
        nt.nodes.remove(em)
        if prev is not None:
            nt.links.new(prev, out.inputs['Surface'])


def _pixels(img):
    import numpy as np
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def _save_png(img, path):
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def bake_pbr(low, high, out_dir, name, size=None, tier='near', samples=16, cage=None,
             cage_offset=0.02, margin_px=8, ao_distance=0.25):
    """Bake high (list of objects, or None = the low's own materials) onto `low` (already UV'd).
    Writes <name>_basecolor.png, <name>_normal.png, <name>_orm.png into out_dir; returns their paths
    and the per-pass seconds."""
    import numpy as np
    if samples > MAX_SAMPLES:
        raise ValueError(f'bake_pbr {name}: {samples} samples > {MAX_SAMPLES} (machine protection)')
    size = size or BAKE_SIZE[tier]
    highs = list(high) if high else []
    os.makedirs(out_dir, exist_ok=True)
    scn = bpy.context.scene
    prev_engine = scn.render.engine
    scn.render.engine = 'CYCLES'
    scn.cycles.device = 'CPU'
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    if scn.world is None:
        scn.world = bpy.data.worlds.new('bake_world')
    scn.world.light_settings.distance = ao_distance
    bk = scn.render.bake
    bk.margin = margin_px
    bk.use_clear = True
    bk.use_selected_to_active = bool(highs)
    own_cage = False
    if highs:
        if cage is None:
            cage = make_cage(low, cage_offset)
            own_cage = True
        bk.use_cage = True
        bk.cage_object = cage
        bk.cage_extrusion = 0.0
        bk.max_ray_distance = 0.0
        _select(highs + [low], low)
    else:
        _select([low], low)
    src_mats = {m for o in (highs or [low]) for m in o.data.materials if m is not None and m.use_nodes}

    def run(kind, img, socket=None):
        added = _target(low, img)
        undo = _emission_swap(src_mats, socket) if socket else []
        t0 = time.time()
        try:
            if kind == 'NORMAL':
                bk.normal_space = 'TANGENT'
                bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
            else:
                bpy.ops.object.bake(type=kind)
        finally:
            _emission_restore(undo)
            for m, n in added:
                m.node_tree.nodes.remove(n)
        return time.time() - t0

    times = {}
    base = _new_image(f'{name}_basecolor', size, False)
    times['basecolor'] = run('EMIT', base, 'Base Color')
    nrm = _new_image(f'{name}_normal', size, True)
    times['normal'] = run('NORMAL', nrm)
    ao = _new_image(f'{name}_ao', size, True)
    times['ao'] = run('AO', ao)
    rough = _new_image(f'{name}_rough', size, True)
    times['rough'] = run('EMIT', rough, 'Roughness')
    metal = _new_image(f'{name}_metal', size, True)
    times['metal'] = run('EMIT', metal, 'Metallic')

    orm = _new_image(f'{name}_orm', size, True)
    px = np.ones((size * size, 4), dtype=np.float32)
    px[:, 0] = _pixels(ao)[:, 0]
    px[:, 1] = _pixels(rough)[:, 0]
    px[:, 2] = _pixels(metal)[:, 0]
    orm.pixels.foreach_set(px.ravel())
    paths = {
        'basecolor': os.path.join(out_dir, f'{name}_basecolor.png'),
        'normal': os.path.join(out_dir, f'{name}_normal.png'),
        'orm': os.path.join(out_dir, f'{name}_orm.png'),
    }
    _save_png(base, paths['basecolor'])
    _save_png(nrm, paths['normal'])
    _save_png(orm, paths['orm'])
    for img in (ao, rough, metal):
        bpy.data.images.remove(img)
    if own_cage:
        bpy.data.objects.remove(cage)
    scn.render.engine = prev_engine
    return {'paths': paths, 'seconds': times, 'size': size, 'samples': samples}


# ── the shipped material ─────────────────────────────────────
def _gltf_output_group():
    """The node group the glTF exporter reads occlusion from."""
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return ng


def apply_baked(low, paths, name):
    """Replace every slot on `low` with ONE material `PBR_<name>` sampling the baked maps."""
    mat = bpy.data.materials.new(f'PBR_{name}')
    mat.use_nodes = True
    mat.use_backface_culling = True  # glTF doubleSided false (closed meshes)
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')

    def tex(key, data):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = _img(paths[key], data)
        return n

    b = tex('basecolor', False)
    nt.links.new(b.outputs['Color'], bsdf.inputs['Base Color'])
    o = tex('orm', True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(o.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    grp = nt.nodes.new('ShaderNodeGroup')
    grp.node_tree = _gltf_output_group()
    nt.links.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    n = tex('normal', True)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    low.data.materials.clear()
    low.data.materials.append(mat)
    return mat
