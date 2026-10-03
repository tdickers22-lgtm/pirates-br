"""R3 creature review sheet (b5.2b, D37): shark, gull, crab, pig, chicken mid-gait, rendered from the SHIPPED GLBs.

  blender -b --factory-startup -P scripts/blender/render_creature_sheet.py -- <outDir>

Per creature three Cycles (CPU, 24 spp) 640x360 frames under a noon sun + sky:
  <kind>_detail.png  framed on the bounds from the 3/4 front (eyes, fin roots, texture)
  <kind>_3m.png      camera 3 m away at a player's eye height, 60 deg vertical FOV (the in-game read)
  <kind>_20m.png     camera 20 m away, same FOV (silhouette and gait read)
The shark is posed 1.2 m above a dark sea plane and the 3 m view looks up at its belly (counter-shading).
Walkers stand on a sand plane at z 0 (their feet are authored at 0). Each armature plays its gait clip at the
mid-stride frame (shark swim / gull flap / crab scuttle / pig and chicken walk), a third into the cycle.
Writes <outDir>/sheet.json with the frame, clip and bounds per creature.
"""
import bpy, mathutils, sys, os, json, math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(ROOT, 'docs/asset-sheets/creatures/r3')
os.makedirs(OUT, exist_ok=True)
CREATURES = [('shark', 'swim'), ('gull', 'flap'), ('crab', 'scuttle'), ('pig', 'walk'), ('chicken', 'walk')]
report = {}

for kind, gait in CREATURES:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 24; sc.cycles.use_denoising = True
    sc.render.resolution_x = 640; sc.render.resolution_y = 360
    sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
    world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
    nt = world.node_tree; bg = nt.nodes['Background']
    sky = nt.nodes.new('ShaderNodeTexSky')
    try: sky.sky_type = 'HOSEK_WILKIE'
    except Exception: pass
    nt.links.new(sky.outputs['Color'], bg.inputs['Color']); bg.inputs['Strength'].default_value = 0.6
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.rotation_euler = (math.radians(35), math.radians(10), math.radians(40))

    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, f'public/assets/models/{kind}.glb'))
    objs = [o for o in sc.objects if o.type in ('MESH', 'ARMATURE')]
    arm = next((o for o in objs if o.type == 'ARMATURE'), None)
    info = {'clip': None, 'frame': None}
    if arm and bpy.data.actions:
        act = next((a for a in bpy.data.actions if a.name.lower().startswith(gait)), bpy.data.actions[0])
        arm.animation_data_create(); arm.animation_data.action = act
        try:
            if act.slots: arm.animation_data.action_slot = act.slots[0]
        except Exception: pass
        f0, f1 = act.frame_range
        fr = int(round(f0 + (f1 - f0) * 0.3))  # a third of the cycle: legs split, not crossing
        sc.frame_set(fr + 1); sc.frame_set(fr)
        info.update(clip=act.name, frame=fr, clips=[a.name for a in bpy.data.actions])
    # hide LOD siblings if the import carried any, and the importer's bone-display shape (an Icosphere of radius 1
    # that is a custom shape, not part of the asset; it framed every camera on a 2 m sphere in the first pass)
    shapes = {pb.custom_shape for a in sc.objects if a.type == 'ARMATURE' for pb in a.pose.bones if pb.custom_shape}
    for o in sc.objects:
        if o.type == 'MESH' and ('LOD' in o.name or o.name.endswith('_far') or o in shapes
                                 or o.name.startswith('Icosphere') or not o.visible_get()):
            o.hide_render = True
    lift = 1.2 if kind == 'shark' else (1.0 if kind == 'gull' else 0.0)
    for o in sc.objects:
        if o.parent is None and o.type in ('MESH', 'ARMATURE', 'EMPTY') and o.name not in ('sun',): o.location.z += lift
    bpy.context.view_layer.update()
    pts = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in sc.objects:
        if o.type != 'MESH' or o.hide_render: continue
        ev = o.evaluated_get(dg); me = ev.to_mesh()
        pts += [ev.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear()
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2; size = (hi - lo).length
    info['bounds'] = {'min': [round(x, 3) for x in lo], 'max': [round(x, 3) for x in hi]}

    ground = bpy.data.meshes.new('g'); ground.from_pydata([(-80, -80, 0), (80, -80, 0), (80, 80, 0), (-80, 80, 0)], [], [(0, 1, 2, 3)])
    gobj = bpy.data.objects.new('ground', ground); sc.collection.objects.link(gobj)
    gm = bpy.data.materials.new('gm'); gm.use_nodes = True
    bsdf = gm.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (0.02, 0.07, 0.1, 1) if kind == 'shark' else (0.62, 0.52, 0.36, 1)
    bsdf.inputs['Roughness'].default_value = 0.15 if kind == 'shark' else 0.9
    ground.materials.append(gm)

    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    def shoot(name, loc, target, fov_deg=60.0):
        cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(fov_deg)
        cam.location = loc; cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(OUT, f'{kind}_{name}.png'); bpy.ops.render.render(write_still=True)
    # glTF +Z forward imports as Blender -Y; look from front-left-above for the 3/4 detail
    d3 = mathutils.Vector((0.75, -1.0, 0.45)).normalized()
    shoot('detail', c + d3 * (size * 1.25), c, 35.0)
    eye = 1.62
    if kind == 'shark':
        shoot('3m', c + mathutils.Vector((2.2, -1.6, -0.9)), c)          # under and beside: belly + flank
        shoot('20m', c + mathutils.Vector((14.0, -14.0, 3.0)), c)
    else:
        flat = mathutils.Vector((0.6, -1.0, 0)).normalized()
        shoot('3m', mathutils.Vector((c.x, c.y, 0)) + flat * 3.0 + mathutils.Vector((0, 0, eye)), c)
        shoot('20m', mathutils.Vector((c.x, c.y, 0)) + flat * 20.0 + mathutils.Vector((0, 0, eye)), c)
    report[kind] = info
    print('SHEET', kind, json.dumps(info))

with open(os.path.join(OUT, 'sheet.json'), 'w') as f:
    json.dump({'renderer': 'Cycles CPU 24 spp 640x360, noon sun + sky', 'creatures': report}, f, indent=1)
