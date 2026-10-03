# Trim-sheet building kit (b5.1a): shared by build_buildings.py (tavern, stall), build_landmarks.py
# (watchtower) and build_tents_bc.py (tents). exec()d into the caller after _helpers/_ao/_detail, so
# it sees mat/join/bm_box/contact_sheet and the caller's globals. Needs `import _trim as TR`.

# ── b5.1a: buildings v2 on the family trim sheets (assets-12, PLAN 3.12 / section 6 row 21) ──
# Every part keeps its authored form; its flat colour becomes a strip of a shared PolyHaven-CC0
# trim sheet (stone / wood_iron / shingle / canvas; plaster = the warm unbleached canvas 'plain'
# strip, a lime-daub read). Long faces are split along their length first so the strip's V never
# squeezes past ~2x and U stays continuous along a board (verts/tris <= 1.3 on LOD0: a split row
# shares its verts, a lone quad does not). GlassWarm stays an emissive pane (tier-exempt).
TRIM_OF = {
    "Rock_Grey": ("stone", "ashlar"), "Rock_Dark": ("stone", "rubble"), "Char_Black": ("stone", "rubble"),
    "Plaster": ("canvas", "plain"), "Canvas": ("canvas", "panel"), "Awning_Red": ("canvas", "patch"),
    "Awning_Cream": ("canvas", "hem"), "Keg_Red": ("canvas", "patch"),
    "Timber": ("wood_iron", "plank_dark"), "Wood_Dark": ("wood_iron", "plank_dark"),
    "Wood_Mid": ("wood_iron", "plank"), "Wood_Bleached": ("wood_iron", "plank_worn"),
    "Wood_Light": ("wood_iron", "plank_worn"), "Metal_Iron": ("wood_iron", "iron_plate"),
    "Shingle": ("shingle", "wood_shingle"), "Shingle_Lt": ("shingle", "wood_shingle"),
    # tents (b5.1a3): weathered canvas, lashings, keg hoops
    "Canvas_Dirty": ("canvas", "patch"), "Rope": ("rope", "rope_thin"), "Metal_Band": ("wood_iron", "iron_plate"),
}
DROP = {"Leaf_Green"}          # untextured foliage blobs: a building has no business carrying them
_SHEETS = {}


def _sheet(fam):
    if fam not in _SHEETS:
        # The 512 'far' tier (~2 px/mm on a 1 m sheet): a building is never closer than a few metres,
        # and the 1024 near sheets made the packed tavern 6.5 MB (4 families x 3 maps per GLB).
        _SHEETS[fam] = TR.build_sheet(fam, tier=os.environ.get("B51A_SHEET_TIER", "far"))
    return _SHEETS[fam]


def densify(obj, L):
    """Split every edge longer than L (grid-filled), at most 6 passes."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for _ in range(6):
        long_e = [e for e in bm.edges if e.calc_length() > L]
        if not long_e:
            break
        bmesh.ops.subdivide_edges(bm, edges=long_e, cuts=1, use_grid_fill=True)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def trimify(parts, L):
    """UV each single-material part onto its family strip (run = its longest world axis)."""
    kept = []
    for o in parts:
        mname = o.data.materials[0].name if o.data.materials else ""
        if mname in DROP:
            bpy.data.objects.remove(o)
            continue
        kept.append(o)
        if mname not in TRIM_OF:
            continue                     # GlassWarm (emissive pane)
        densify(o, L)
        for poly in o.data.polygons:      # one smooth surface per part: normals never split a vertex
            poly.use_smooth = True
        fam, strip = TRIM_OF[mname]
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        ext = [max(v[i] for v in bb) - min(v[i] for v in bb) for i in range(3)]
        run = "xyz"[ext.index(max(ext))]
        sheet = _sheet(fam)
        TR.trim_uv(o, strip, sheet, run=run)
        regroup_uv(o, strip, sheet, run)
    return kept


_AX = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}


def regroup_uv(o, strip, sheet, run):
    """Box-project each SIDE of a part (faces grouped by dominant normal axis) with ONE V base per
    side, so a side's faces share their vertices' UVs instead of each face being centred in the
    strip on its own (trim_uv's per-face fit splits every row: verts/tris 1.4-1.6). A side whose
    across-run span does not fit the strip keeps trim_uv's per-face fit (no stretch past 1:1)."""
    v0, v1 = sheet["strips"][strip]
    pad = TR.PAD_PX / float(sheet["size"])
    room = (v1 - v0) - 2 * pad
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uvl = bm.loops.layers.uv.verify()
    mw = o.matrix_world
    mwi = mw.inverted()
    room_w = room * TR.SHEET_M

    def sides():
        g = {}
        for f in bm.faces:
            n = (mw.to_3x3() @ f.normal)
            a = max(range(3), key=lambda i: abs(n[i]))
            g.setdefault((a, n[a] > 0), []).append(f)
        return g

    def axes(a):
        ra = "xyz".index(run)
        ua = ra if ra != a else min(i for i in range(3) if i != a)
        return ua, 3 - a - ua

    # an oversize side (a 3 m plaster wall) is cut into bands one strip tall: each band maps 1:1 with
    # its own base, so vertices split only along the band lines, never per face, and nothing stretches
    for (a, _s), faces in list(sides().items()):
        _ua, va = axes(a)
        vs = [(mw @ v.co)[va] for f in faces for v in f.verts]
        lo, hi = min(vs), max(vs)
        if hi - lo <= room_w:
            continue
        geom = list({e for f in faces for e in f.edges}) + faces + list({v for f in faces for v in f.verts})
        cut = lo + room_w
        while cut < hi - 1e-4:
            co = Vector((0, 0, 0)); co[va] = cut
            no = Vector((0, 0, 0)); no[va] = 1.0
            res = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=mwi @ co,
                                         plane_no=(mwi.to_3x3().transposed().inverted() @ no).normalized())
            geom = [g for g in res["geom"] if g.is_valid]
            cut += room_w
    for (a, _s), faces in sides().items():
        ua, va = axes(a)
        vs = [(mw @ v.co)[va] for f in faces for v in f.verts]
        lo, hi = min(vs), max(vs)
        single = hi - lo <= room_w
        for f in faces:
            if single:
                b0 = lo - (room_w - (hi - lo)) / 2
            else:
                cv = sum((mw @ v.co)[va] for v in f.verts) / len(f.verts)
                b0 = lo + math.floor((cv - lo) / room_w) * room_w
            for l in f.loops:
                p = mw @ l.vert.co
                v = v0 + pad + (p[va] - b0) / TR.SHEET_M
                l[uvl].uv = (p[ua] / TR.SHEET_M, min(max(v, v0 + pad * 0.5), v1 - pad * 0.5))
    bm.to_mesh(o.data)
    bm.free()


def tri_count(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.type == "MESH")


SHEET_DIR = os.path.join(HERE, "..", "..", "docs", "asset-sheets", "buildings")


# LOD PROXIES (b5.1a2). build_lods.py decimates PER LOOSE PART with a 12/8/4-triangle floor per part,
# and a building is hundreds of loose boards and shingles: the tavern chain landed at LOD1 41%,
# LOD2 15%, far 5% (ceilings 40/12/3%). The levels are authored here instead, from ONE joined,
# welded world-space copy (what build_lods grades as the source), and build_lods reuses
# lod_proxies/<key>_<LOD1|LOD2|far>.glb (extras.lod_reuse):
#   LOD1 / LOD2: whole-mesh Collapse (the densified coplanar rows collapse first, at ~zero error;
#                a shingle is merged into its course instead of being held at 12 triangles);
#   far:         voxel remesh into one closed hull, collapsed to budget, each face takes the nearest
#                source face's material and each vertex the nearest source vertex's UV, clamped to
#                the LOD0 box (a far building never grows past its footprint).
# Geometry only (no images): the runtime binds the LOD0 file's materials by name.
PROXY_DIR = os.path.join(HERE, "lod_proxies")
PROXY_LEVELS = (("LOD1", 0.36), ("LOD2", 0.10), ("far", 0.024))
# props tier (tents): 40% / 12% / far <= 150 tris; (label, share of LOD0, absolute cap or None)
PROP_LEVELS = (("LOD1", 0.36), ("LOD2", 0.10), ("far", 0.03, 140))


def _tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def _apply_mod(o, mod):
    with bpy.context.temp_override(object=o, active_object=o):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def _collapse_to(o, target):
    for _ in range(5):
        t = _tris(o)
        if t <= target:
            return
        dc = o.modifiers.new("dc", "DECIMATE")
        dc.decimate_type = "COLLAPSE"
        dc.ratio = max(0.01, target / t * 0.98)
        dc.use_collapse_triangulate = True
        _apply_mod(o, dc)


def write_lod_proxies(objs, name, levels=None):
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree
    os.makedirs(PROXY_DIR, exist_ok=True)
    bpy.context.view_layer.update()
    copies = []
    for o in objs:
        me = o.data.copy()
        me.transform(o.matrix_world)
        c = bpy.data.objects.new(f"{o.name}_px", me)
        bpy.context.scene.collection.objects.link(c)
        copies.append(c)
    src = join(copies, f"{name}_pxsrc")
    bm = bmesh.new()
    bm.from_mesh(src.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(src.data)
    bm.free()
    n0 = _tris(src)
    sme = src.data
    lo = Vector([min(v.co[i] for v in sme.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in sme.vertices) for i in range(3)])
    bvh = BVHTree.FromPolygons([v.co.copy() for v in sme.vertices], [list(p.vertices) for p in sme.polygons])
    mats = [p.material_index for p in sme.polygons]
    kd = KDTree(len(sme.vertices))
    for v in sme.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    uv_of = {}
    if sme.uv_layers:
        uvl = sme.uv_layers.active.data
        for l in sme.loops:
            uv_of.setdefault(l.vertex_index, tuple(uvl[l.index].uv))
    span = max(hi - lo)
    out, prev = [], n0
    for lvl in (levels or PROXY_LEVELS):
        label, share = lvl[0], lvl[1]
        target = int(n0 * share)
        if len(lvl) > 2 and lvl[2]:
            target = min(target, lvl[2])
        o = bpy.data.objects.new(f"{name}_{label}", sme.copy())
        bpy.context.scene.collection.objects.link(o)
        if label == "far":
            for attempt in range(6):
                if attempt:
                    bpy.data.objects.remove(o)
                    o = bpy.data.objects.new(f"{name}_{label}", sme.copy())
                    bpy.context.scene.collection.objects.link(o)
                rm = o.modifiers.new("rm", "REMESH")
                rm.mode = "VOXEL"
                rm.voxel_size = max(0.04, span / (90.0 * 0.75 ** attempt))
                rm.adaptivity = 0.0
                _apply_mod(o, rm)
                _collapse_to(o, target)
                if _tris(o) <= target * 1.05:
                    break
            me = o.data
            for p in me.polygons:
                hit = bvh.find_nearest(p.center)
                if hit[2] is not None:
                    p.material_index = mats[hit[2]]
                p.use_smooth = True
            for v in me.vertices:
                v.co = Vector([min(max(v.co[i], lo[i]), hi[i]) for i in range(3)])
            if uv_of:
                if not me.uv_layers:
                    me.uv_layers.new(name="UVMap")
                d = me.uv_layers.active.data
                for l in me.loops:
                    _, idx, _ = kd.find(me.vertices[l.vertex_index].co)
                    d[l.index].uv = uv_of.get(idx, (0.5, 0.5))
        else:
            _collapse_to(o, target)
        t = _tris(o)
        assert t < prev, f"{name} {label} proxy {t} tris is not cheaper than {prev}"
        prev = t
        print(f"B51A_PROXY {name} {label} tris {t} ({100 * t / n0:.1f}% of {n0})")
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.export_scene.gltf(filepath=os.path.join(PROXY_DIR, f"{name}_{label}.glb"), export_format="GLB",
                                  use_selection=True, export_image_format="NONE", export_apply=True)
        out.append(o)
    for o in out + [src]:
        bpy.data.objects.remove(o)


def ship_building(objs, name, sheet_dir=None, levels=None, four=False):
    sheet_dir = sheet_dir or SHEET_DIR
    os.makedirs(sheet_dir, exist_ok=True)
    print(f"B51A {name}: LOD0 {tri_count(objs)} tris before export")
    # LOD0 only: the chain is build_lods.py's job (geometry-only <name>_lods.glb, adaptive surface
    # contract). Sheet images ride as JPEG in the SOURCE file; pack-models.mjs turns them into KTX2.
    import _pbr as P
    ids = set()
    for o in objs:
        for m in o.data.materials:
            if m is not None:
                ids |= {i for i in str(m.get("pbr_sources", "")).split(",") if i}
    P.require_licensed(sorted(ids))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(EXPORT_DIR, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_image_format="JPEG", export_jpeg_quality=88, export_apply=True)
    # proxies BEFORE the contact sheet: contact_sheet lays the parts side by side and restores
    # .location, leaving matrix_world stale until the next depsgraph update.
    write_lod_proxies(objs, name, levels)
    if four:
        four_angle_sheet(objs, os.path.join(sheet_dir, f"{name}-4angle.png"))
    contact_sheet(objs, os.path.join(sheet_dir, f"{name}.png"))
    print(f"B51A {name}: exported {os.path.getsize(path)} B, sources {sorted(ids)}")
    return path


def four_angle_sheet(objs, path, tile=(480, 400)):
    """A true 4-angle review sheet (front / right / back / left at 30 deg elevation), Workbench textured,
    one 2x2 PNG. render_contact_sheet.py (b3.4a) renders ONE angle per key; this yaw loop is local."""
    import numpy as np
    scn = bpy.context.scene
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    ctr, rad = (lo + hi) / 2, (hi - lo).length / 2
    cd = bpy.data.cameras.new("_fa_cam")
    cd.type = "ORTHO"
    cd.ortho_scale = rad * 2.15
    cam = bpy.data.objects.new("_fa_cam", cd)
    scn.collection.objects.link(cam)
    prev_cam, prev_eng = scn.camera, scn.render.engine
    scn.camera = cam
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "STUDIO"
    scn.display.shading.color_type = "TEXTURE"
    scn.render.resolution_x, scn.render.resolution_y = tile
    scn.render.resolution_percentage = 100
    tiles = []
    tmp = path[:-4] + "_tile.png"
    for k, yaw in enumerate((-90.0, 0.0, 90.0, 180.0)):     # camera on -Y (front), +X, +Y, -X
        a = math.radians(yaw)
        d = Vector((math.cos(a), math.sin(a), math.tan(math.radians(30))))
        cam.location = ctr + d.normalized() * rad * 4
        cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tmp)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(tile[1], tile[0], 4)
        bpy.data.images.remove(img)
        tiles.append(px)
    os.remove(tmp)
    top = np.concatenate([tiles[2], tiles[3]], axis=1)     # pixels are bottom-up: row 0 = bottom
    bot = np.concatenate([tiles[0], tiles[1]], axis=1)
    grid = np.concatenate([bot, top], axis=0)
    out = bpy.data.images.new("_fa_sheet", tile[0] * 2, tile[1] * 2, alpha=True)
    out.pixels[:] = grid.ravel().tolist()
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    scn.camera, scn.render.engine = prev_cam, prev_eng
    bpy.data.objects.remove(cam)
    print(f"B51A four-angle sheet {path}")
