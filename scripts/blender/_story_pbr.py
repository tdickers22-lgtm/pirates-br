# _story_pbr.py (b5.1c) — shared ORIGINAL procedural PBR for the story scenes (exec'd, like _trimkit.py).
# wet_flesh_material (lifted from build_scene_kraken.py): FFT-tiled periodic noise -> base / normal / ORM.
# With a dry palette and high roughness the same generator gives bone, shell, coral and sand: mottle,
# growth rings, pitting spots, a cavity-AO channel. No third-party texture source anywhere.
import os
import math
import bmesh
from mathutils import Vector


def _tile_noise(n, rng, beta, k0=2.0):
    """Periodic (FFT-filtered) noise in [0, 1]: tiles seamlessly in both axes."""
    import numpy as np
    w = rng.standard_normal((n, n))
    ky = np.fft.fftfreq(n)[:, None] * n
    kx = np.fft.fftfreq(n)[None, :] * n
    k = np.sqrt(kx * kx + ky * ky)
    k[0, 0] = 1.0
    f = np.real(np.fft.ifft2(np.fft.fft2(w) / np.maximum(k, k0) ** beta))
    return (f - f.min()) / (f.max() - f.min() + 1e-9)


def _save_img(name, arr, data):
    import numpy as np
    n = arr.shape[0]
    cache = globals().get("FLESH_CACHE") or os.path.join(HERE, ".cache", "story_pbr")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"{name}.png")
    img = bpy.data.images.new(name, n, n, alpha=False)
    rgba = np.concatenate([arr, np.ones((n, n, 1))], axis=2)
    img.pixels.foreach_set(np.flipud(rgba).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img.colorspace_settings.name = "Non-Color" if data else "sRGB"
    return img


def wet_flesh_material(mat_name, base, belly, rough, ring_freq, seed, n=None, nrm_s=6.0):
    """Original procedural PBR set (no third-party source): mottled skin with chromatophore spots,
    wrinkle rings across the run, a cavity-AO channel and LOW roughness = the wet specular sheen.
    Rebuilds the palette material IN PLACE so AssetMaterialCollapse keeps classing it by name."""
    import numpy as np
    # 256 px (b5.1c size pass): six 512 flesh maps were ~0.9 MB of KTX2 in the packed kraken; the
    # periodic noise tiles along the run, so 256 loses no read at story-scene distances.
    n = n or int(os.environ.get("B51C_FLESH_N", "256"))
    rng = np.random.default_rng(seed)
    big, mid, fine = _tile_noise(n, rng, 2.2), _tile_noise(n, rng, 1.6), _tile_noise(n, rng, 1.0, 24.0)
    yy = np.arange(n)[:, None] / n
    wr = 0.5 + 0.5 * np.sin(2 * np.pi * (ring_freq * yy + 0.9 * mid))           # wrinkle rings
    spots = np.clip((fine - 0.62) * 6.0, 0, 1) * (0.4 + 0.6 * big)               # chromatophores
    height = 0.55 * wr + 0.30 * mid + 0.15 * fine
    lin = lambda c: np.array(c)[None, None, :] ** 2.2
    col = lin(base) * (1 - big[..., None] * 0.55) + lin(belly) * (big[..., None] * 0.55)
    col = col * (0.82 + 0.30 * wr[..., None]) * (1 - 0.45 * spots[..., None])
    col = np.clip(col, 0, 1) ** (1 / 2.2)
    gy, gx = np.gradient(height)
    s = nrm_s
    nrm = np.stack([-gx * s * n / 64, gy * s * n / 64, np.ones_like(height)], axis=2)
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    orm = np.stack([0.62 + 0.38 * height, np.clip(rough + 0.14 * mid - 0.08 * wr, 0.08, 0.9),
                    np.zeros_like(height)], axis=2)
    m = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        if nd.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(nd)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], nt.nodes["Material Output"].inputs["Surface"])

    def tex(img):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img
        return t
    nt.links.new(tex(_save_img(f"{mat_name}_base", col, False)).outputs["Color"], bsdf.inputs["Base Color"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tex(_save_img(f"{mat_name}_orm", orm, True)).outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    grp = nt.nodes.new("ShaderNodeGroup")
    import _pbr as P
    grp.node_tree = P._gltf_output_group()
    nt.links.new(sep.outputs["Red"], grp.inputs["Occlusion"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tex(_save_img(f"{mat_name}_nrm", nrm * 0.5 + 0.5, True)).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def box_uv(obj, tile=1.0):
    """Per-face dominant-axis (box) projection in world metres / tile. The maps are periodic, so the
    only seams are where the projection axis flips, which a smooth organic part hides in its curvature."""
    me = obj.data
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    for p in me.polygons:
        n = p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for li in p.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (co[a] / tile, co[b] / tile)


def subsurf(obj, levels=1):
    """Catmull-Clark the authored cage once: rounder bone shafts / drifts, 4x the triangles."""
    m = obj.modifiers.new("Sub", "SUBSURF")
    m.levels = m.render_levels = levels
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=m.name)


def story_pbrify(parts, procedural, L=1.0, sub=0, tile=1.0):
    """Story-scene material pass: palette materials in TRIM_OF go on the trim sheets (trimify), names in
    `procedural` {name: wet_flesh_material kwargs} are rebuilt IN PLACE as original procedural PBR and
    box-UV'd. A procedural entry may carry '_tile' (metres per map repeat) and '_sub' (Catmull-Clark
    levels) overriding the call-wide tile/sub; a procedural name wins over its TRIM_OF row (the giant
    skull's Rock_Dark read as basket weave on the 0.5 m rubble strip). Returns the kept parts."""
    built = set()
    for name, kw in procedural.items():
        if name not in built and bpy.data.materials.get(name) is not None:
            wet_flesh_material(name, **{k: v for k, v in kw.items() if not k.startswith("_")})
            built.add(name)
    for o in parts:
        mname = o.data.materials[0].name if o.data.materials else ""
        if mname not in procedural:
            continue
        lv = procedural[mname].get("_sub", sub)
        if lv:
            subsurf(o, lv)
        for poly in o.data.polygons:
            poly.use_smooth = True
        box_uv(o, procedural[mname].get("_tile", tile))
    saved = {k: TRIM_OF.pop(k) for k in list(TRIM_OF) if k in procedural}
    try:
        return trimify(parts, L)
    finally:
        TRIM_OF.update(saved)


def _soften(img, k=0.5):
    """Blend an image with its 3x3 binomial blur (wrapping: the sheets tile in U, strips carry V pads)."""
    import numpy as np
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)
    b = a.copy()
    for ax in (0, 1):
        b = 0.25 * np.roll(b, 1, ax) + 0.5 * b + 0.25 * np.roll(b, -1, ax)
    out = (1 - k) * a + k * b
    out[..., 3] = a[..., 3]
    img.pixels.foreach_set(out.ravel())
    img.update()


def story_ship_prep(obj, procedural, trim_px=None, proc_px=None):
    """b5.1d size pass on the JOINED scene object, right before ship_building (story scenes <= 1.2 MB
    packed). Three cuts, none of them visible at story-scene distances:
    1. Only the active-render UV layer survives. The join carried a second, unreferenced layer
       (TEXCOORD_1: 30-230 KB of float UVs per packed scene that no material samples).
    2. Each textured material's UVs are rebased into [0,1] (integer shift, then divided by the integer
       span S per axis) and a Mapping node scales them back by S, which the glTF exporter writes as
       KHR_texture_transform. Box-UV'd procedural parts and long trim runs repeat the maps many times,
       so their UVs ran far outside [0,1] and pack-models could not quantise them (float TEXCOORD_0 was
       up to 400 KB per scene). The integer shift is invisible (the maps tile with period 1).
    3. Trim-family sheets are resampled to trim_px (B51D_TRIM_PX, default 256) and the procedural maps
       to proc_px (B51D_PROC_PX, default 128): 3 maps per family per GLB were 1-1.7 MB of KTX2."""
    trim_px = trim_px or int(os.environ.get("B51D_TRIM_PX", "256"))
    proc_px = proc_px or int(os.environ.get("B51D_PROC_PX", "128"))
    # 4. The resampled stone basecolor packs ashlar joints + grain into 4 mm texels; ETC1S then misses
    #    the source by mean deltaE 3.56 (test-texture-budget wants < 3). A binomial soften (1.5 passes, B51D_SOFTEN_K)
    #    soften on that one map (B51D_SOFTEN families) brings it under without touching the normals.
    soften = [f for f in os.environ.get("B51D_SOFTEN", "stone").split(",") if f]
    me = obj.data
    keep = next((l for l in me.uv_layers if l.active_render), me.uv_layers.active)
    for l in [l for l in me.uv_layers if l.name != keep.name]:
        me.uv_layers.remove(l)
    uvl = me.uv_layers[0].data
    loops_of = {}
    for p in me.polygons:
        loops_of.setdefault(p.material_index, []).extend(p.loop_indices)
    report = []
    for mi, loops in loops_of.items():
        m = me.materials[mi] if mi < len(me.materials) else None
        if m is None or not m.use_nodes:
            continue
        imgs = [n for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image is not None]
        if imgs and m.get("b51d_prepped"):
            # b5.1e: a script that ships SEVERAL assets in one process (story props, boneyard) shares the
            # cached trim materials; the first asset already rebased + mapped this one, so its scale would
            # land on the next asset's un-rebased UVs. Give this asset its own copy without our mapping.
            m = m.copy()
            me.materials[mi] = m
            nt = m.node_tree
            for n in [n for n in nt.nodes if n.name.startswith("B51D_")]:
                nt.nodes.remove(n)
            del m["b51d_prepped"]
            imgs = [n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image is not None]
        if not imgs or any(n.inputs["Vector"].is_linked for n in imgs):
            continue
        m["b51d_prepped"] = 1
        us = [uvl[li].uv[0] for li in loops]
        vs = [uvl[li].uv[1] for li in loops]
        f_u, f_v = math.floor(min(us)), math.floor(min(vs))
        s_u, s_v = max(1, math.ceil(max(us) - f_u)), max(1, math.ceil(max(vs) - f_v))
        if (f_u, f_v, s_u, s_v) != (0, 0, 1, 1):
            for li in loops:
                u, v = uvl[li].uv
                uvl[li].uv = ((u - f_u) / s_u, (v - f_v) / s_v)
            nt = m.node_tree
            tc = nt.nodes.new("ShaderNodeTexCoord")
            mp = nt.nodes.new("ShaderNodeMapping")
            tc.name, mp.name = "B51D_tc", "B51D_map"
            mp.vector_type = "POINT"
            mp.inputs["Scale"].default_value = (s_u, s_v, 1.0)
            nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
            for n in imgs:
                nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        px = proc_px if m.name in procedural else trim_px
        for n in imgs:
            w, h = n.image.size
            if max(w, h) > px:
                n.image.scale(px, max(1, round(h * px / w)))
                if any(f"trim_{f}_basecolor" == n.image.name.split(".")[0] for f in soften):
                    k = float(os.environ.get("B51D_SOFTEN_K", "1.5"))   # 1.0 = one full pass (2.99, no margin)
                    while k > 1e-6:
                        _soften(n.image, min(k, 1.0))
                        k -= 1.0
        report.append(f"{m.name}:S{s_u}x{s_v}@{px}")
    print("B51D ship_prep", obj.name, " ".join(report))


# ── b5.1e: story scenes III share one preset library and one ship call ─────────────────────────────
STORY_SHEETS = os.path.join(HERE, "..", "..", "docs", "asset-sheets", "story")
STORY_LEVELS = (("LOD1", 0.36), ("LOD2", 0.10), ("far", 0.035, 3600))
# Original procedural looks (no third-party source) for every non-trim, non-emissive palette name the
# smuggler / wrecker / rum still / crow roost / castaway / gibbet scenes use. Seeds match the b5.1c/d
# scenes where the name already had a look (Bone 21, Gold 51, Rust 61, Sand_Pad 33, Flag_Fin 143).
STORY_PBR_LIB = {
    "Bone": dict(base=(0.72, 0.68, 0.56), belly=(0.86, 0.83, 0.72), rough=0.72, ring_freq=3, seed=21, nrm_s=3.0),
    "Gold": dict(base=(0.80, 0.62, 0.24), belly=(0.92, 0.76, 0.36), rough=0.30, ring_freq=1, seed=51, nrm_s=1.0,
                 _sub=0),
    "Rust": dict(base=(0.40, 0.20, 0.10), belly=(0.55, 0.30, 0.14), rough=0.85, ring_freq=2, seed=61, nrm_s=4.0),
    "Sand_Pad": dict(base=(0.66, 0.58, 0.42), belly=(0.80, 0.72, 0.55), rough=0.90, ring_freq=2, seed=33, nrm_s=2.0,
                     _sub=0),
    "Sand": dict(base=(0.70, 0.62, 0.46), belly=(0.58, 0.50, 0.36), rough=0.92, ring_freq=2, seed=34, nrm_s=2.5,
                 _sub=0, _tile=1.6),
    "Flag_Fin": dict(base=(0.12, 0.26, 0.30), belly=(0.09, 0.19, 0.22), rough=0.92, ring_freq=16, seed=143, nrm_s=1.5,
                     _sub=0, _tile=1.0),
    # bottle glass: dark green, glossy, faint seed bubbles (ring_freq); dead lantern pane: smoked, sooty
    "Bottle_Green": dict(base=(0.08, 0.24, 0.12), belly=(0.16, 0.36, 0.18), rough=0.16, ring_freq=7, seed=161,
                         nrm_s=1.0),
    "Glass_Dead": dict(base=(0.20, 0.20, 0.17), belly=(0.32, 0.30, 0.24), rough=0.30, ring_freq=5, seed=162,
                       nrm_s=1.0, _sub=0),
    # hammered still copper: warm metal, green-brown tarnish in the lows
    "Copper": dict(base=(0.62, 0.34, 0.20), belly=(0.36, 0.40, 0.28), rough=0.42, ring_freq=4, seed=163, nrm_s=3.0),
    "Leaf_Dry": dict(base=(0.52, 0.42, 0.22), belly=(0.40, 0.30, 0.16), rough=0.86, ring_freq=12, seed=164, nrm_s=2.0,
                     _sub=0),
    "Crow_Black": dict(base=(0.05, 0.05, 0.06), belly=(0.12, 0.13, 0.17), rough=0.55, ring_freq=14, seed=41,
                       nrm_s=2.0),
    "Tar_Black": dict(base=(0.05, 0.04, 0.03), belly=(0.10, 0.08, 0.06), rough=0.38, ring_freq=2, seed=165, nrm_s=1.5),
    # red-lead painted keg staves and a tarred oilcloth tarp: warm, so the cache does not read as the canvas
    # trim family's cold blue-grey (handoff open with the trim-sheet owner)
    "Keg_Red": dict(base=(0.46, 0.13, 0.09), belly=(0.32, 0.12, 0.08), rough=0.70, ring_freq=10, seed=167, nrm_s=3.0),
    "Canvas_Dirty": dict(base=(0.40, 0.34, 0.24), belly=(0.28, 0.24, 0.17), rough=0.86, ring_freq=16, seed=168,
                         nrm_s=1.5, _sub=0, _tile=1.0),
    # rowboat tribute offerings: the mermaid shrine's shell/coral looks (same seeds as build_scene_mermaid.py)
    "Shell_Pearl": dict(base=(0.88, 0.82, 0.74), belly=(0.74, 0.80, 0.88), rough=0.32, ring_freq=11, seed=81,
                        nrm_s=2.5),
    "Coral": dict(base=(0.80, 0.32, 0.20), belly=(0.94, 0.56, 0.36), rough=0.72, ring_freq=6, seed=82, nrm_s=5.0),
    "Coral_Pink": dict(base=(0.90, 0.46, 0.55), belly=(0.97, 0.72, 0.72), rough=0.70, ring_freq=6, seed=83, nrm_s=5.0),
    "Trunk_Palm": dict(base=(0.44, 0.34, 0.24), belly=(0.30, 0.23, 0.16), rough=0.86, ring_freq=18, seed=166,
                       nrm_s=5.0),
}


def _split_by_material(objs):
    """trimify/story_pbrify read materials[0] only: a multi-material part (rum still's firebox carries
    Char_Black in a second slot) would ship that slot untextured. Split those parts per material first."""
    out = []
    for o in objs:
        if len({m.name for m in o.data.materials if m}) < 2:
            out.append(o)
            continue
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
        pieces = list(bpy.context.selected_objects)
        for x in pieces:
            used = {poly.material_index for poly in x.data.polygons}
            keep = [x.data.materials[i] for i in sorted(used)]
            x.data.materials.clear()
            for m in keep:
                x.data.materials.append(m)
            for poly in x.data.polygons:
                poly.material_index = 0
        print(f"B51E split {o.name} -> {[(x.name, x.data.materials[0].name) for x in pieces]}")
        out += pieces
    return out


PROPS_SHEETS = os.path.join(HERE, "..", "..", "docs", "asset-sheets", "props")


def story_ship(coll, name, L, sub=1, tile=0.6, extra=None, levels=None, sheet_dir=None):
    """b5.1e one-call story ship: STORY_PBR_LIB looks for the names this scene uses (+ `extra`), wood/iron/
    rope/char on the trim sheets, Catmull-Clark on the procedural parts, size prep (one UV layer, [0,1] UVs
    + texture transform, 256/128 maps), LOD0 + authored LOD chain + 4-angle sheet. B51E_COUNT_ONLY=1 prints
    the LOD0 tris without exporting. `levels`/`sheet_dir` override the story tier: the standalone story props
    (rowboat, signal_pyre, driftwood_log, bone_pile, grave_marker) ship on PROP_LEVELS (far <= 140) into
    docs/asset-sheets/props."""
    objs = _split_by_material([o for o in coll.objects if o.type == "MESH"])
    used = {m.name for o in objs for m in o.data.materials if m}
    pbr = {k: v for k, v in STORY_PBR_LIB.items() if k in used}
    pbr.update(extra or {})
    objs = story_pbrify(objs, pbr, L=L, sub=sub, tile=tile)
    bare = sorted(m.name for o in objs for m in o.data.materials
                  if m and m.name not in pbr and m.name not in TRIM_OF)
    n = tri_count(objs)
    print(f"B51E {name} tris: {n} untextured: {sorted(set(bare))}")
    # far proxy aims >= 2400 tris: the node gate counts DRAWN (welded, degenerate-free) triangles against the
    # 2000-4000 story band, and a 3.5% hull of a ~63k scene (2156 in Blender) drew under 2000 and was dropped
    if levels is None:
        levels = STORY_LEVELS[:2] + (("far", max(STORY_LEVELS[2][1], 2400.0 / max(1, n)), STORY_LEVELS[2][2]),)
    if os.environ.get("B51E_COUNT_ONLY"):
        return None
    joined = join(objs, name)
    story_ship_prep(joined, pbr)
    return ship_building([joined], name, sheet_dir=sheet_dir or STORY_SHEETS, levels=levels, four=True)
