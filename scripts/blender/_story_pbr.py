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
    box-UV'd. Returns the kept parts (trimify drops DROP blobs)."""
    built = set()
    for name, kw in procedural.items():
        if name not in built and bpy.data.materials.get(name) is not None:
            wet_flesh_material(name, **kw)
            built.add(name)
    if sub:
        for o in parts:
            mname = o.data.materials[0].name if o.data.materials else ""
            if mname in procedural:
                subsurf(o, sub)
    for o in parts:
        mname = o.data.materials[0].name if o.data.materials else ""
        if mname in procedural:
            for poly in o.data.polygons:
                poly.use_smooth = True
            box_uv(o, tile)
    return trimify(parts, L)
