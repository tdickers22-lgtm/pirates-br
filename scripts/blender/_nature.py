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


def finish_nature(coll, name, budget=6000, floor=0):
    if name in NATURE_BOUNDS:
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
    assert floor <= info['tris'] <= budget, (name, info['tris'], floor, budget)
    print('NATURE_TRIS', name, info['tris'])
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


# ── Palm kit v2 (b4.5d, assets-11): shared by build_palms.py and build_palms_extra.py ──
# Geometry first (PLAN 1426: alpha cards are high-tier only and wait on the D28 foliage atlas):
#   - trunk: ~7 rings per metre, every third ring a leaf-scar groove + lip, each scar tilted a
#     little (real scars are not horizontal), six root lobes in the flare, wider fibrous shank
#     under the crown;
#   - frond: 16-station midrib, 22-34 leaflet PAIRS, each leaflet a narrow linear blade with a
#     raised midvein over 3 stations + tip (10 tris), drooping along its own length;
#   - origin at the trunk base, crown mass at the top: the instanced sway shader
#     (PropScatterer.applyFoliageSway) bends by local height, so no sway attribute is needed.
PALM_BAND = (10000, 16000)


def palm_trunk(name, coll, height, lean, seed, r0=0.30, r1=0.16, segs=20,
               curve_pow=1.7, per_m=7.0):
    rng = random.Random(seed)
    rings = max(18, int(round(height * per_m)))
    rings -= rings % 3
    pts = [Vector((lean[0] * (t ** curve_pow), lean[1] * (t ** curve_pow), height * t))
           for t in (i / rings for i in range(rings + 1))]
    bm = bmesh.new()
    rows = []
    for i, p in enumerate(pts):
        t = i / rings
        base_r = r0 * (1 - t) + r1 * t
        if t < 0.10:
            base_r *= 1.0 + 0.60 * (1.0 - t / 0.10) ** 2
        if t > 0.93:
            base_r *= 1.0 + 0.9 * (t - 0.93)      # fibrous shank under the crown
        band = i % 3
        scar = (0.0, -0.055, 0.045)[band] if 0.04 < t < 0.95 else 0.0
        tilt_a = rng.uniform(0, math.tau)
        tilt_z = height / rings * 0.35 * (band - 1)
        row = []
        for j in range(segs):
            a = math.tau * j / segs
            r = base_r * (1.0 + scar + rng.uniform(-0.008, 0.008))
            if t < 0.10:
                r *= 1.0 + 0.16 * (1.0 - t / 0.10) * max(0.0, math.cos(6 * a + seed)) ** 2
            z = p.z + (tilt_z * math.cos(a - tilt_a) if scar else 0.0)
            row.append(bm.verts.new((p.x + r * math.cos(a), p.y + r * math.sin(a), max(0.0, z))))
        rows.append(row)
    for i in range(rings):
        a, b = rows[i], rows[i + 1]
        for j in range(segs):
            bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    bm.faces.new(tuple(reversed(rows[0])))
    bm.faces.new(tuple(rows[-1]))
    obj = obj_from_bmesh(name, bm, coll, mat('Trunk_Palm'), smooth=True)
    return obj, pts[-1], (pts[-1] - pts[-2]).normalized()


def palm_frond(name, coll, origin, yaw, tilt, length, material, seed, pairs=26,
               blade=0.30, droopy=False, n=16):
    rng = random.Random(seed)
    sag = length * (0.95 if droopy else 0.55)
    rise = 0.0 if droopy else length * 0.10
    path = [Vector((length * t, 0.0, rise * math.sin(min(t * 2.2, math.pi)) - sag * t ** 2.2))
            for t in (i / n for i in range(n + 1))]
    bm = bmesh.new()
    rib = []
    for i, p in enumerate(path):
        t = i / n
        r = (0.030 - 0.024 * t) * max(1.0, length / 2.8)
        tang = (path[min(i + 1, n)] - path[max(i - 1, 0)]).normalized()
        side = tang.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(tang)
        rib.append([bm.verts.new(p + side * (r * math.cos(a)) + up * (r * math.sin(a)))
                    for a in (math.tau * j / 5 for j in range(5))])
    for i in range(n):
        a, b = rib[i], rib[i + 1]
        for j in range(5):
            bm.faces.new((a[j], a[(j + 1) % 5], b[(j + 1) % 5], b[j]))
    bm.faces.new(tuple(reversed(rib[0])))
    bm.faces.new(tuple(rib[-1]))

    def at(t):
        f = t * n
        i = min(int(f), n - 1)
        p = path[i].lerp(path[i + 1], f - i)
        tang = (path[i + 1] - path[i]).normalized()
        side = tang.cross(Vector((0, 0, 1))).normalized()
        return p, tang, side, side.cross(tang)

    for k in range(pairs):
        t = 0.08 + 0.90 * k / max(1, pairs - 1)
        p, tang, side, up = at(t)
        prof = math.sin(math.pi * min(t * 1.05 + 0.08, 1.0)) ** 0.7
        llen = length * blade * max(0.28, prof) * rng.uniform(0.9, 1.1)
        va = (0.55 - 0.40 * t) * (0.4 if droopy else 1.0)
        drop = llen * ((0.55 if droopy else 0.20) + 0.50 * t)
        sweep = llen * 0.40
        w = llen * (0.11 if droopy else 0.085)
        for sgn in (-1.0, 1.0):
            d = (side * sgn * math.cos(va) + up * math.sin(va)).normalized()
            across = d.cross(up).normalized() if abs(d.dot(up)) < 0.98 else tang
            stations = []
            for s, (u, wf) in enumerate(((0.0, 0.55), (0.33, 1.0), (0.68, 0.80))):
                c = p + d * llen * u + tang * sweep * u - up * drop * u * u
                half = across * w * wf * 0.5
                vein = c + up * w * (0.22 if s else 0.08)
                stations.append([bm.verts.new(q) for q in (c - half - up * w * 0.05, vein,
                                                           c + half - up * w * 0.05)])
            tip = bm.verts.new(p + d * llen + tang * sweep - up * drop)
            for s in range(2):
                a, b = stations[s], stations[s + 1]
                bm.faces.new((a[0], a[1], b[1], b[0]))
                bm.faces.new((a[1], a[2], b[2], b[1]))
            l = stations[2]
            bm.faces.new((l[0], l[1], tip))
            bm.faces.new((l[1], l[2], tip))
    rot = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(origin) @ rot, verts=bm.verts)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, material, smooth=True)


def palm_v2(name, height, lean, fronds, dead, seed, r0=0.30, r1=0.16, frond_scale=0.42,
            cocos=4, pairs=26, tilts=(0.34, 0.66, 0.98), blade=0.30, spears=2, core_r=0.30,
            segs=20):
    coll = asset_collection(name)
    trunk, top, tip = palm_trunk(f'{name}_trunk', coll, height, lean, seed, r0=r0, r1=r1, segs=segs)
    bm = bm_icosphere(core_r, 1)
    bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.35)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(top + tip * 0.10), verts=bm.verts)
    parts = [trunk, obj_from_bmesh(f'{name}_core', bm, coll, mat('Trunk_Palm'), smooth=True)]
    rng = random.Random(seed + 77)
    golden = math.pi * (3 - math.sqrt(5))
    for k in range(fronds):
        tier = k % 3
        length = height * frond_scale * (1.0, 0.94, 0.82)[tier] * rng.uniform(0.9, 1.08)
        parts.append(palm_frond(f'{name}_frond{k}', coll, top + tip * 0.10,
                                k * golden + rng.uniform(-0.18, 0.18),
                                tilts[tier] + rng.uniform(-0.10, 0.10), length,
                                mat('Leaf_Green' if k % 2 == 0 else 'Leaf_Green_Lt'),
                                seed * 31 + k, pairs=pairs, blade=blade))
    for k in range(spears):
        parts.append(palm_frond(f'{name}_spear{k}', coll, top + tip * 0.14,
                                rng.uniform(0, math.tau), 0.10 + 0.12 * k,
                                height * frond_scale * 0.55, mat('Leaf_Green_Lt'),
                                seed * 17 + k, pairs=14, blade=blade))
    for k in range(dead):
        parts.append(palm_frond(f'{name}_dead{k}', coll, top + Vector((0, 0, -0.05)),
                                rng.uniform(0, math.tau), rng.uniform(1.55, 1.85),
                                height * frond_scale * rng.uniform(0.55, 0.7), mat('Leaf_Dry'),
                                seed * 53 + k, pairs=16, blade=blade, droopy=True))
    crng = random.Random(seed + 5)
    for k in range(cocos):
        a = k * (math.tau / cocos) + crng.uniform(-0.3, 0.3)
        bm = bm_icosphere(0.21 + crng.uniform(0.0, 0.05), 2)
        bmesh.ops.scale(bm, vec=Vector((1.0, 1.0, 1.15)), verts=bm.verts)
        pos = top + tip * 0.06 + Vector((0.46 * math.cos(a), 0.46 * math.sin(a),
                                          -0.56 - crng.uniform(0.0, 0.12)))
        bmesh.ops.transform(bm, matrix=Matrix.Translation(pos), verts=bm.verts)
        parts.append(obj_from_bmesh(f'{name}_coco{k}', bm, coll, mat('Coconut'), smooth=True))
    return coll, parts
