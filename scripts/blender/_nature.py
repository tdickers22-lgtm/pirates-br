# Nature fidelity utilities. Load after _helpers.py, _ao.py and _detail.py.
# Fixed envelopes are from the shipped GLBs; rebuilding never compounds scale.
NATURE_BOUNDS = {
    'bush': ((-0.648674, -0.046449, -0.715874), (0.567304, 0.961728, 0.627349)),
    'bush_berry': ((-0.537251, -0.046449, -0.449794), (0.685297, 1.062253, 0.525471)),
    'flower_bush': ((-0.625581, -0.046449, -0.638230), (0.549412, 1.015214, 0.563179)),
    'fern_plant': ((-0.459562, -0.040500, -0.527485), (0.439704, 0.844204, 0.497993)),
    'flower_patch': ((-0.802877, -0.089137, -0.776814), (0.796951, 0.393312, 0.769338)),
    'wildflowers': ((-0.300466, -0.025000, -0.328547), (0.307885, 0.986615, 0.281702)),
    # Previous boulders accidentally retained their first piece's transform,
    # lifting them above ground. Preserve world footprint/height, seat the root.
    'boulder_a': ((-1.132365, -0.083000, -1.120312), (1.443000, 2.226000, 1.294010)),
    'boulder_b': ((-2.558698, -0.120000, -1.230191), (1.945897, 3.257999, 2.096798)),
    'boulder_c': ((-0.837160, -0.100000, -0.525576), (0.658487, 2.023988, 0.596422)),
    'searock_a': ((-5.163000, -1.026000, -4.038444), (4.367576, 10.050000, 3.906805)),
    'searock_b': ((-6.875256, -1.268000, -8.185000), (5.934717, 14.156000, 5.826898)),
    'searock_c': ((-4.378306, -0.785000, -4.560000), (3.532979, 5.964000, 4.015130)),
    'palm_a': ((-0.976589, 0, -3.434532), (4.793835, 9.000184, 1.181062)),
    'palm_b': ((-0.476307, 0, -1.402105), (4.586514, 6.989917, 2.291952)),
    'palm_c': ((-0.876444, 0, -2.275867), (2.530952, 5.498523, 0.628898)),
}


def fit_nature(coll, name):
    """Freeze each transform, then fit in world space before tinting/joining."""
    objs = [o for o in coll.objects if o.type == 'MESH']
    for obj in objs:
        bpy.context.view_layer.update()
        obj.data.transform(obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)
    lo, hi = NATURE_BOUNDS[name]
    low = Vector((lo[0], -hi[2], lo[1]))
    high = Vector((hi[0], -lo[2], hi[1]))
    vs = [v for obj in objs for v in obj.data.vertices]
    amin = Vector(tuple(min(v.co[a] for v in vs) for a in range(3)))
    amax = Vector(tuple(max(v.co[a] for v in vs) for a in range(3)))
    for v in vs:
        for a in range(3):
            v.co[a] = low[a] + (v.co[a] - amin[a]) * (high[a] - low[a]) / max(1e-6, amax[a] - amin[a])
    for obj in objs:
        obj.data.update()


def finish_nature(coll, name, budget=6000):
    fit_nature(coll, name)
    bake_ao(coll, samples=24, floor=0.66, max_dist=3.5, height_gradient=0.06)
    spec = tint_spec(moss=0.40)
    for leaf in ('Leaf_A', 'Leaf_B', 'Leaf_C', 'Leaf_Green', 'Leaf_Green_Lt'):
        spec[leaf] = dict(tone=0.13, hue=((1.12, 1.02, 0.83), (0.79, 0.93, 0.88)),
                          scale=0.33, mottle=0.06, mscale=0.09)
    for stone in ('Rock_Grey', 'Rock_Stack', 'Rock_Pale', 'Rock_Wet'):
        spec[stone] = dict(spec['Rock_Grey'], tone=0.12,
                           streak=dict(axis='z', freq=9.0 if 'boulder' in name else 3.7, amt=0.17),
                           low=dict(z=0.65, amt=0.30, col=(0.59, 0.65, 0.56)))
    spec['Trunk_Palm'] = dict(spec['Wood_Mid'], streak=dict(axis='z', freq=24.0, amt=0.14))
    tint_pass(coll, spec, seed=19)
    join([o for o in coll.objects if o.type == 'MESH'], name)
    path = export_collection_vc(coll, name + '.glb')
    info = verify_glb(path)
    assert info['tris'] <= budget, (name, info['tris'], budget)
    assert info['color0'] and len(info['materials']) <= 6, info
    for obj in coll.objects:
        obj.hide_render = True
    return info


def render_nature(names, out_dir):
    """CPU Cycles contact-sheet views, after ALL exports (preview changes nodes).
    No Eevee/Metal GPU work: this machine must serialize its graphics workloads.
    """
    if not out_dir:
        return
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 20
    scene.cycles.use_denoising = True
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 4
    scene.render.resolution_x = 900
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.30, 0.40, 0.50, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.7
    sun_data = bpy.data.lights.new('_nature_sun', 'SUN')
    sun_data.energy = 2.4
    sun_data.angle = math.radians(6)
    sun = bpy.data.objects.new('_nature_sun', sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(32), math.radians(-25), math.radians(-30))
    camera = bpy.data.objects.new('_nature_camera', bpy.data.cameras.new('_nature_camera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = 'ORTHO'
    ground_coll = asset_collection('_nature_ground')
    ground = obj_from_bmesh('_nature_ground', bm_box(100, 100, 0.04), ground_coll,
                           mat('Sand'))
    ground.location.z = -0.025
    for name in names:
        coll = bpy.data.collections.get(name)
        if coll is None:
            continue
        for obj in coll.objects:
            obj.hide_render = False
        preview_vertex_colors(coll)
        bpy.context.view_layer.update()
        pts = [o.matrix_world @ Vector(b) for o in coll.objects for b in o.bound_box]
        low = Vector(tuple(min(p[a] for p in pts) for a in range(3)))
        high = Vector(tuple(max(p[a] for p in pts) for a in range(3)))
        center = (low + high) * 0.5
        size = (high - low).length
        camera.data.ortho_scale = size * 1.02
        for angle in (-65, 45):
            az = math.radians(angle)
            camera.location = center + Vector((math.cos(az), math.sin(az), 0.48)) * size * 2
            camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = os.path.join(out_dir, f'{name}_{angle}.png')
            bpy.ops.render.render(write_still=True)
            print('NATURE_RENDER', scene.render.filepath)
        for obj in coll.objects:
            obj.hide_render = True
