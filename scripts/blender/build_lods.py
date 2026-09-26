"""LOD chain for every GLB (b3.4d; assets-07, D6, PLAN section 6 row 6).

"Way higher poly" is only affordable through LOD chains (D6). Before this file
only 35 assets had a far sibling (`<name>_far.glb`, build_far_lods.py) and no
asset had an intermediate level, so every hero drew its full LOD0 from 1 m to
the fog line. This builds, for every `<key>.glb` whose tier in
scripts/test-asset-tiers.mjs asks for a chain, ONE sibling `<key>_lods.glb`
holding the levels as nodes named `<key>_LOD1`, `<key>_LOD2`, `<key>_far`
(the b3.4a contract test-asset-tiers [lods] reads; each strictly coarser).

THE RECIPE (the rocks lesson, build_far_lods.py WHY THE WELD):
  - the SOURCE GLB is the truth (not a build scene): imported, every mesh's
    world transform baked in, custom normals read (flat faces stay flat, as a
    face flag the exporter re-splits) and dropped, positions welded at 1e-4 so
    the split-vertex export is one connected surface again;
  - each level is decimated PER LOOSE PART (Collapse, a closed part never
    under 12 triangles) toward the tier's target (LOD1 ~40%, LOD2 ~12%, far
    ~3% of LOD0, or the tier's absolute caps);
  - ADAPTIVE: the target ratio is a target, the SURFACE is the contract. A
    level that opens a boundary loop the source does not have, or keeps less
    than 92% (or more than 108%) of the source area, is retried at x1.3 the
    ratio, never past 90% of the level above. A level that cannot be both is
    built at the surface-safe ratio and its tier ceiling stays red in the
    test-asset-tiers ratchet: an honest red row beats a see-through rock;
  - the far level REUSES the shipped `<key>_far.glb` when one exists and is
    coarser than LOD2 (the flora cards, the story proxies: already graded by
    test-far-lod-integrity and what the runtime draws today), else it is
    decimated like the others and its base is re-snapped onto the source's
    lowest point (a far rock never sinks under the terrain);
  - UV (TEXCOORD_0) and vertex colour (COLOR_0, the baked AO) ride through the
    decimate (Blender interpolates loop data) and are exported; the gate
    fails a level that drops an attribute its LOD0 has.

NO IMAGES IN THE LODS FILE. The levels reference their materials BY NAME and
the file ships no image (export_image_format NONE): the runtime binds the LOD0
file's material of the same name, so a LOD swap never re-downloads, re-decodes
or re-uploads a texture and the levels batch with LOD0 (AssetLibrary lodKey,
b3.1 hook). A lods file is geometry only.

Skinned sources (pirate_base: its chain comes from the character rebuild) and
animation-only containers are skipped and reported.

THE BUILD VERIFIES ITSELF: a level that still opens a hole or loses area
after the adaptive retries exits 1 (no silent "done").
scripts/test-far-lod-integrity.mjs grades the same census on the shipped files
without Blender, for every asset x every level.

Run headless, one process, never while a browser probe runs:
    /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_lods.py
BR_LODS_ONLY=barrel,keg builds only those keys; BR_EXPORT_DIR redirects the output;
BR_LODS_REPORT=<path> writes the per-level JSON report (default /tmp/pbr-build-lods.json).
"""
import json
import os
import shutil
import subprocess
import sys
import time

import bpy
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_far_lods as F  # noqa: E402  (helpers only: its build is guarded by __main__)

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC_DIR = os.path.join(ROOT, 'public', 'assets', 'models')
OUT_DIR = os.environ.get('BR_EXPORT_DIR') or SRC_DIR
REPORT = os.environ.get('BR_LODS_REPORT') or '/tmp/pbr-build-lods.json'
LABELS = ('LOD1', 'LOD2', 'far')
MIN_AREA, MAX_AREA = 0.92, 1.08      # test-far-lod-integrity MIN_AREA_KEEP / _detail.LOD_MAX_AREA
AIM = 0.95                           # aim under a ceiling: Collapse lands a few % off its ratio
GROW = 1.3
TRIES = 8


def node_bin():
    for c in (os.environ.get('BR_NODE'), shutil.which('node'),
              os.path.expanduser('~/.nvm/versions/node/v20.20.0/bin/node'), '/opt/homebrew/bin/node'):
        if c and os.path.exists(c):
            return c
    raise RuntimeError('node not found (set BR_NODE)')


def tier_spec():
    """{key: {tier, lods, noMesh}} straight from the test-asset-tiers TIERS table (one source of truth)."""
    js = ("import {TIERS} from './scripts/test-asset-tiers.mjs';const o={};"
          "for(const [t,v] of Object.entries(TIERS))for(const k of v.keys)o[k]={tier:t,lods:v.lods,noMesh:!!v.noMesh};"
          "console.log(JSON.stringify(o))")
    out = subprocess.run([node_bin(), '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def _glb_json(path):
    import struct
    with open(path, 'rb') as f:
        f.read(12)
        ln, _ = struct.unpack('<II', f.read(8))
        return json.loads(f.read(ln))


def import_world(path):
    """Import a GLB and return ONE welded mesh object in world space (flat faces flagged)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in imported if o.type == 'MESH']
    for o in meshes:
        o.data = o.data.copy()
        flags = F.flat_face_flags(o.data)
        F.clear_custom_normals(o)
        o.data.polygons.foreach_set('use_smooth', [not f for f in flags])
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in imported:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=meshes[0], object=meshes[0], selected_objects=meshes,
                                       selected_editable_objects=meshes):
            bpy.ops.object.join()
    base = meshes[0]
    F.weld(base.data)
    return base


def dup(obj, name):
    c = obj.copy()
    c.data = obj.data.copy()
    bpy.context.scene.collection.objects.link(c)
    c.name = c.data.name = name
    return c


def targets(spec, n0):
    """Per level: (aim ratio, hard ratio ceiling or None, floor ratio)."""
    out = {}
    for label in spec['need']:
        lv = spec.get(label, {})
        ceil = None
        if 'r' in lv:
            ceil = lv['r']
        if 'max' in lv:
            m = lv['max'] / max(n0, 1)
            ceil = m if ceil is None else min(ceil, m)
        floor = lv.get('min', 0) / max(n0, 1)
        default = {'LOD1': 0.40, 'LOD2': 0.12, 'far': 0.03}[label]
        aim = (ceil if ceil is not None else default) * AIM
        out[label] = (max(aim, floor * 1.05), ceil, floor)
    return out


# Per-part triangle floors per level: (closed part, open sheet). A box stays a box near; a leaf
# card of 16-26 triangles may fall to a 2-triangle card far out (area is rescaled either way).
FLOOR = {'LOD1': (12, 6), 'LOD2': (8, 4), 'far': (4, 2)}


def reduce_parts(obj, ratio, floor, cards=False):
    """Collapse each LOOSE PART on its own toward `ratio` (never under `floor` triangles), then scale
    it about its centre back to its own source area (capped, build_far_lods.rescale_to_area): Collapse
    shrinks convex parts and pulls sheet boundaries inward, and the rescale is what keeps a 40% barrel
    hoop or a 40% palm frond the same size on screen. The far-LOD story recipe, at every level."""
    existing = set(bpy.data.objects)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    parts = [obj] + [o for o in bpy.data.objects if o not in existing and o.type == 'MESH']
    for part in parts:
        tris = sum(max(0, len(p.vertices) - 2) for p in part.data.polygons)
        sheet = F.has_boundary(part.data)
        fl = floor[1] if sheet else floor[0]
        r = max(ratio, min(1.0, fl / max(1, tris)))
        if r >= 0.999:
            continue
        s0 = F.surface_stats(part.data)
        keep_me = part.data.copy()
        mod = part.modifiers.new('lod', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = r
        mod.use_collapse_triangulate = True
        F.apply_modifier(part, mod)
        F.rescale_to_area(part, s0['area'])
        # PER-PART SURFACE CONTRACT (b3.4d finisher): a part that Collapse+rescale cannot keep
        # (a keg hoop or a wheel spoke folded to a line, a curled leaf pulled to 61% of its area)
        # becomes, at the far level, ONE equal-area card when it is an open sheet
        # (build_far_lods.card_from_part), else it keeps its source mesh. The level may then sit
        # over its tier ceiling (an honest ratchet row), never see-through or shrunken.
        st = F.surface_stats(part.data)
        if st['loops'] > s0['loops'] or not (MIN_AREA <= st['area'] / max(s0['area'], 1e-12) <= MAX_AREA):
            old = part.data
            part.data = keep_me
            bpy.data.meshes.remove(old)
            if cards and sheet:
                F.card_from_part(part)
        else:
            bpy.data.meshes.remove(keep_me)
    bpy.ops.object.select_all(action='DESELECT')
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if len(parts) > 1:
        bpy.ops.object.join()
    return obj


def ok_surface(src, st):
    keep = st['area'] / max(src['area'], 1e-12)
    return st['loops'] <= src['loops'] and MIN_AREA <= keep <= MAX_AREA, keep


def build_key(key, spec):
    F.wipe()
    src_path = os.path.join(SRC_DIR, f'{key}.glb')
    base = import_world(src_path)
    base.name = f'{key}_src'
    src = F.surface_stats(base.data)
    src_base = F.world_min_z([base])
    n0 = src['tris']
    tg = targets(spec, n0)
    levels, rows, cap = [], [], n0
    far_path = os.path.join(SRC_DIR, f'{key}_far.glb')
    for label in spec['need']:
        aim, ceil, floor = tg[label]
        top = 0.9 * cap / n0
        row = {'label': label, 'aim': round(aim, 4), 'ceil': ceil}
        c = None
        if label == 'far' and os.path.exists(far_path):
            f = import_world(far_path)
            fst = F.surface_stats(f.data)
            if fst['tris'] < cap:
                c = f
                c.name = c.data.name = f'{key}_{label}'
                row.update(reuse=True, ratio=round(fst['tris'] / n0, 4))
            else:
                bpy.data.objects.remove(f)
        if c is None:
            r = min(aim, top)
            for attempt in range(TRIES):
                # Each level decimates the level ABOVE it (LOD0 for LOD1): a part the per-part
                # contract refuses to reduce keeps its coarser parent mesh, so a level is never
                # heavier than the one above (the first run's keg/palm/arch far levels were).
                parent = levels[-1] if levels else base
                pr = min(1.0, r * n0 / max(1, F.surface_stats(parent.data)['tris']))
                c = dup(parent, f'{key}_{label}')
                reduce_parts(c, pr, FLOOR[label], cards=label == 'far')
                st = F.surface_stats(c.data)
                good, _ = ok_surface(src, st)
                if (good and st['tris'] < cap) or r >= top or attempt == TRIES - 1:
                    break
                bpy.data.objects.remove(c)
                r = min(r * GROW, top)
            row.update(reuse=False, ratio=round(r, 4), attempts=attempt + 1)
            if label == 'far':
                row['snapped'] = F.snap_base(c, src_base)
        st = F.surface_stats(c.data)
        good, keep = ok_surface(src, st)
        row.update(tris=st['tris'], keep=round(st['tris'] / n0, 4), area=round(keep, 4), loops=st['loops'],
                   src_loops=src['loops'], surface_ok=bool(good) or row.get('reuse', False),
                   coarser=st['tris'] < cap,
                   under_ceiling=ceil is None or st['tris'] <= ceil * n0)
        rows.append(row)
        levels.append(c)
        cap = st['tris']
    path = export(levels, key)
    bpy.data.objects.remove(base)
    return {'key': key, 'tier': spec_tier(key), 'src_tris': n0, 'src_loops': src['loops'],
            'src_area': round(src['area'], 4), 'levels': rows, 'path': path}


_TIER = {}


def spec_tier(key):
    return _TIER.get(key)


def export(levels, key):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f'{key}_lods.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for o in levels:
        o.select_set(True)
    bpy.context.view_layer.objects.active = levels[0]
    kwargs = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                  export_animations=False, export_skins=False, export_morph=False, export_image_format='NONE')
    for extra in ({'export_vertex_color': 'ACTIVE', 'export_all_vertex_colors': False},
                  {'export_vertex_color': 'ACTIVE'}, {}):
        try:
            bpy.ops.export_scene.gltf(**kwargs, **extra)
            break
        except TypeError:
            continue
    else:
        raise RuntimeError(f'gltf export failed for {key}')
    return path


def main():
    t0 = time.time()
    spec = tier_spec()
    only = {n.strip() for n in os.environ.get('BR_LODS_ONLY', '').split(',') if n.strip()}
    unknown = only - set(spec)
    if unknown:
        print(f"BR_LODS_ONLY names no tiered key: {', '.join(sorted(unknown))}")
        sys.exit(1)
    rows, skipped = [], []
    for key in sorted(spec):
        s = spec[key]
        _TIER[key] = s['tier']
        if only and key not in only:
            continue
        if s['noMesh'] or not s['lods']:
            skipped.append((key, 'no chain in its tier'))
            continue
        j = _glb_json(os.path.join(SRC_DIR, f'{key}.glb'))
        if j.get('skins'):
            skipped.append((key, 'skinned: its chain comes from the character rebuild'))
            continue
        try:
            row = build_key(key, s['lods'])
        except Exception as e:  # one broken source must not hide the rest; it fails the build below
            row = {'key': key, 'error': repr(e), 'levels': []}
        rows.append(row)
        lv = ', '.join(f"{l['label']} {l['tris']} ({l['keep']:.0%}, area {l['area']:.0%}, loops {l['loops']}/{l['src_loops']}"
                       f"{', reuse' if l.get('reuse') else ''}{'' if l['under_ceiling'] else ', OVER CEILING'})"
                       for l in row['levels'])
        print(f"LODS {key:>18} {row.get('src_tris', 0):>6}: {lv or row.get('error')}", flush=True)
    # A hole or lost surface fails the build; a level that is not coarser than the one above (a
    # small multi-part prop at its part floors) is reported and stays red in test-asset-tiers.
    failed = [r['key'] for r in rows if r.get('error') or not all(l['surface_ok'] for l in r['levels'])]
    over = [f"{r['key']}:{l['label']}" for r in rows for l in r['levels'] if not l['under_ceiling']]
    with open(REPORT, 'w') as f:
        json.dump({'rows': rows, 'skipped': skipped, 'failed': failed, 'overCeiling': over,
                   'seconds': round(time.time() - t0, 1)}, f, indent=1)
    for k, why in skipped:
        print(f'  skipped {k}: {why}')
    print(f'{len(rows)} chains in {time.time() - t0:.0f} s; over a tier ceiling (stays ratcheted): {len(over)}')
    if failed:
        print(f"LODS FAILED (hole or lost area): {', '.join(failed)}")
        sys.exit(1)
    print('LODS DONE')


if __name__ == '__main__':
    main()
