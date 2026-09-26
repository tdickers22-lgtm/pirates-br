"""Contact sheet per asset family (b3.4a; assets-16, PLAN 3.12 "contact sheets per family committed
under docs/asset-sheets/").

Generalised from the 2026-09-22 audit's render script: every GLB of a family (a tier of
scripts/test-asset-tiers.mjs, or an explicit list) is imported into an empty scene, framed by an
orthographic camera from a fixed 3/4 view (22 deg elevation, 35 deg yaw, so every sheet of every
revision is shot the same way and two sheets diff by eye), lit by one sun + a flat sky, rendered to a
tile with a label (key, level, triangles), and the tiles are composited into one PNG grid. With
--lods each key gets a row: LOD0, then every level of `<key>_lods.glb` (nodes ending LOD1 / LOD2 /
far, each rendered alone) or the legacy `<key>_far.glb`, all framed on LOD0's bounds so a level that
shrinks or drifts is visible.

Machine protection (COMMON.md): headless only, one Blender at a time, never alongside a browser
probe, Cycles CPU <= 32 samples (default 12) or Workbench, tile <= 480x360.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/render_contact_sheet.py -- \
      --family cannon,wheel,capstan,lantern --lods --out docs/asset-sheets/ship-hardware.png
  ... -- --names cutlass,flintlock --engine workbench --out /tmp/weapons.png
"""
import argparse
import json
import math
import os
import subprocess
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = os.path.join(ROOT, 'public', 'assets', 'models')
LEVEL_SUFFIXES = ('LOD1', 'LOD2', 'far')


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser(prog='render_contact_sheet.py')
    ap.add_argument('--family', default='', help='comma-separated test-asset-tiers tier names')
    ap.add_argument('--names', default='', help='comma-separated model keys (public/assets/models/<key>.glb)')
    ap.add_argument('--out', required=True, help='output PNG path')
    ap.add_argument('--lods', action='store_true', help='one row per key: LOD0 + every LOD level')
    ap.add_argument('--engine', choices=('cycles', 'workbench'), default='cycles')
    ap.add_argument('--samples', type=int, default=12)
    ap.add_argument('--tile', default='320x240')
    ap.add_argument('--cols', type=int, default=4)
    a = ap.parse_args(argv)
    a.samples = max(1, min(32, a.samples))
    tw, th = (int(v) for v in a.tile.lower().split('x'))
    a.tw, a.th = min(tw, 480), min(th, 360)
    return a


def family_keys(tiers):
    out = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'test-asset-tiers.mjs'), '--tiers'],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    table = json.loads(out)
    keys = []
    for t in tiers:
        if t not in table:
            raise SystemExit(f'unknown tier {t}; tiers: {", ".join(table)}')
        keys += table[t]
    return keys


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights, bpy.data.curves):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def tris_of(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH' and not o.hide_render:
            n += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return n


def bounds(objs):
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            v = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, v))
            mx = Vector(map(max, mx, v))
    return mn, mx


def descendants(o):
    out = [o]
    for c in o.children:
        out += descendants(c)
    return out


def setup_scene(a):
    scn = bpy.context.scene
    if a.engine == 'cycles':
        scn.render.engine = 'CYCLES'
        scn.cycles.device = 'CPU'
        scn.cycles.samples = a.samples
        scn.cycles.use_denoising = False
        scn.render.threads_mode = 'FIXED'
        scn.render.threads = 3
    else:
        scn.render.engine = 'BLENDER_WORKBENCH'
        scn.display.shading.light = 'STUDIO'
        scn.display.shading.color_type = 'TEXTURE'
    scn.render.resolution_x, scn.render.resolution_y = a.tw, a.th
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = False
    scn.render.image_settings.file_format = 'PNG'
    scn.view_settings.view_transform = 'AgX' if a.engine == 'cycles' else 'Standard'
    w = bpy.data.worlds.new('sheet_sky')
    scn.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs[1].default_value = 0.9
    return scn


def render_tile(scn, a, objs, frame_bounds, label, path):
    """Frame `frame_bounds`, add camera + sun + label, render `objs` (others hidden by the caller)."""
    mn, mx = frame_bounds
    size = max(max(mx - mn), 1e-3)
    ctr = (mn + mx) / 2
    cam = bpy.data.objects.new('sheet_cam', bpy.data.cameras.new('sheet_cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = size * 1.45
    cam.data.shift_y = -0.07  # model sits above the label band
    el, yaw, d = math.radians(22), math.radians(35), size * 10
    cam.location = ctr + Vector((d * math.cos(el) * math.sin(yaw), -d * math.cos(el) * math.cos(yaw), d * math.sin(el)))
    cam.rotation_euler = (math.radians(90) - el, 0, yaw)
    cam.data.clip_end = d * 4
    sun = bpy.data.objects.new('sheet_sun', bpy.data.lights.new('sheet_sun', 'SUN'))
    scn.collection.objects.link(sun)
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), math.radians(15), math.radians(35))
    txt_curve = bpy.data.curves.new('sheet_label', 'FONT')
    txt_curve.body = label
    txt_curve.size = cam.data.ortho_scale * 0.055
    txt = bpy.data.objects.new('sheet_label', txt_curve)
    scn.collection.objects.link(txt)
    txt.parent = cam
    aspect = a.th / a.tw
    txt.location = (-cam.data.ortho_scale * 0.47, -cam.data.ortho_scale * 0.47 * aspect, -1.0)
    mat = bpy.data.materials.new('sheet_label_mat')
    mat.diffuse_color = (0.02, 0.02, 0.03, 1)
    txt_curve.materials.append(mat)
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in (cam, sun, txt):
        bpy.data.objects.remove(o, do_unlink=True)


def rows_for(key, a, tmp, scn):
    """Render LOD0 (+ levels with --lods); return a list of tile PNG paths for this key's row."""
    tiles = []
    clear_scene()
    objs = import_glb(os.path.join(MODELS, f'{key}.glb'))
    bpy.context.view_layer.update()
    fb = bounds(objs)
    p = os.path.join(tmp, f'{key}__lod0.png')
    render_tile(scn, a, objs, fb, f'{key}  LOD0  {tris_of(objs)} tris', p)
    tiles.append(p)
    if not a.lods:
        return tiles
    lods_path = os.path.join(MODELS, f'{key}_lods.glb')
    far_path = os.path.join(MODELS, f'{key}_far.glb')
    if os.path.exists(lods_path):
        clear_scene()
        objs = import_glb(lods_path)
        bpy.context.view_layer.update()
        for suffix in LEVEL_SUFFIXES:
            roots = [o for o in objs if o.name.split('.')[0].lower().endswith(suffix.lower())]
            if not roots:
                continue
            keep = set()
            for r in roots:
                keep.update(descendants(r))
            for o in objs:
                o.hide_render = o not in keep
            p = os.path.join(tmp, f'{key}__{suffix}.png')
            render_tile(scn, a, list(keep), fb, f'{key}  {suffix}  {tris_of(list(keep))} tris', p)
            tiles.append(p)
    elif os.path.exists(far_path):
        clear_scene()
        objs = import_glb(far_path)
        bpy.context.view_layer.update()
        p = os.path.join(tmp, f'{key}__far.png')
        render_tile(scn, a, objs, fb, f'{key}  _far (legacy)  {tris_of(objs)} tris', p)
        tiles.append(p)
    return tiles


def composite(rows, a, out):
    """Paste tile PNGs into one grid (rows = list of tile lists; without --lods rows are wrapped to --cols)."""
    import numpy as np
    if not a.lods:
        flat = [t for r in rows for t in r]
        rows = [flat[i:i + a.cols] for i in range(0, len(flat), a.cols)]
    ncols = max(len(r) for r in rows)
    W, H = ncols * a.tw, len(rows) * a.th
    sheet = np.ones((H, W, 4), dtype=np.float32)
    sheet[..., :3] = 0.12
    for ri, r in enumerate(rows):
        for ci, tp in enumerate(r):
            img = bpy.data.images.load(tp)
            px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(img.size[1], img.size[0], 4)
            # Blender image rows run bottom-up: row 0 of the sheet array is the BOTTOM of the PNG.
            y0 = H - (ri + 1) * a.th
            sheet[y0:y0 + img.size[1], ci * a.tw:ci * a.tw + img.size[0]] = px
            bpy.data.images.remove(img)
    out_img = bpy.data.images.new('contact_sheet', W, H, alpha=True)
    out_img.pixels.foreach_set(sheet.ravel())
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    out_img.filepath_raw = out
    out_img.file_format = 'PNG'
    out_img.save()
    return W, H


def main():
    a = parse_args()
    keys = [k for k in a.names.split(',') if k]
    if a.family:
        keys += family_keys([t for t in a.family.split(',') if t])
    if not keys:
        raise SystemExit('nothing to render: pass --family <tier[,tier]> or --names <key[,key]>')
    missing = [k for k in keys if not os.path.exists(os.path.join(MODELS, f'{k}.glb'))]
    if missing:
        raise SystemExit(f'no GLB for: {", ".join(missing)}')
    tmp = os.path.join(bpy.app.tempdir or '/tmp', 'pbr_contact_sheet')
    os.makedirs(tmp, exist_ok=True)
    scn = setup_scene(a)
    rows = []
    for k in keys:
        rows.append(rows_for(k, a, tmp, scn))
        print('SHEET_TILE', k, len(rows[-1]), flush=True)
    W, H = composite(rows, a, a.out)
    print(f'SHEET_WRITTEN {a.out} {W}x{H} keys={len(keys)} tiles={sum(len(r) for r in rows)}', flush=True)


main()
