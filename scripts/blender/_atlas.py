# HERO UV ATLAS BAKE — the texture half of the hybrid strategy (PLAN 2.4b).
#
# The 63 island GLBs keep flat palette materials x baked vertex AO. A HERO asset
# (weapon, ship hardware, rig, tavern) is looked at from 40 cm away for a whole
# match, and at that range a per-vertex tone is a coloured blob: the wood has no
# grain, the brass has no wear, and every part of a five-material union costs its
# own draw. So hero assets get ONE authored UV atlas instead:
#
#   bake_ao -> tint_pass  (unchanged: the AO x tint the other assets ship in
#                          COLOR_0 is what we WANT in the texture)
#   hero_atlas()          -> smart-UV every mesh into one shared 0..1 layout,
#                            wire base-colour x 'Col' into each material, Cycles-
#                            bake DIFFUSE COLOR (no direct, no indirect: this is
#                            a texture transfer, not a light bake) into one image,
#                            replace every material slot with a single
#                            `Atlas_<name>` material, and flatten 'Col' to WHITE.
#
# WHY COLOR_0 GOES WHITE AND STAYS PRESENT. `AssetLibrary.mergedGeometry` needs
# uniform attributes across a GLB (all-or-nothing COLOR_0), and the client
# multiplies vertexColors into the albedo. The AO is now IN the atlas, so a
# second multiply would darken it twice; dropping the attribute instead would
# make the file the odd one out in the merge. White is both safe and free.
#
# COST. One 512^2 albedo (no normal map: an extra sampler per hero material is
# not free on the low tier, and these are stylised flat-lit assets) = 1.05 MB of
# VRAM per asset actually drawn, uploaded lazily by three.js on first render.
# The five weapons share nothing, but only ONE is ever in the viewmodel.
#
# Order is load-bearing: hero_atlas() runs AFTER bake_ao + tint_pass and BEFORE
# join/export. Materials are copied per object first, so the shared PALETTE
# materials are never mutated (the next asset in the same script would inherit
# the image node and a second vertex-colour mix otherwise).
import bpy
import math
import os
from mathutils import Vector, Matrix


def _unique_materials(objs):
    """Give every object its own material copies (never touch the palette)."""
    for obj in objs:
        me = obj.data
        for i, m in enumerate(me.materials):
            if m is None:
                continue
            me.materials[i] = m.copy()


def _wire_vertex_colour(objs, attr_name='Col'):
    """Base Color <- base x COLOR_0, so the bake carries AO + tint."""
    done = set()
    for obj in objs:
        for m in obj.data.materials:
            if m is None or not m.use_nodes or m.name in done:
                continue
            done.add(m.name)
            nt = m.node_tree
            bsdf = nt.nodes.get('Principled BSDF')
            if bsdf is None:
                continue
            base = bsdf.inputs['Base Color']
            col = tuple(base.default_value)
            att = nt.nodes.new('ShaderNodeAttribute')
            att.attribute_type = 'GEOMETRY'
            att.attribute_name = attr_name
            att.location = (-620, 220)
            mixn = nt.nodes.new('ShaderNodeMix')
            mixn.data_type = 'RGBA'
            mixn.blend_type = 'MULTIPLY'
            mixn.location = (-320, 220)
            rgba_in = [s for s in mixn.inputs if s.type == 'RGBA']
            [s for s in mixn.inputs if s.name == 'Factor'][0].default_value = 1.0
            rgba_in[0].default_value = col
            nt.links.new(att.outputs['Color'], rgba_in[1])
            out = [s for s in mixn.outputs if s.type == 'RGBA'][0]
            nt.links.new(out, base)
    return len(done)


def _bake_target(objs, image):
    """Every material gets the same image as its ACTIVE texture node."""
    for obj in objs:
        for m in obj.data.materials:
            if m is None or not m.use_nodes:
                continue
            nt = m.node_tree
            node = nt.nodes.new('ShaderNodeTexImage')
            node.image = image
            node.location = (-320, -260)
            node.select = True
            nt.nodes.active = node


def atlas_unwrap(objs, angle_deg=66.0, island_margin=0.02):
    """Smart-UV every mesh at once so the islands share ONE 0..1 layout."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg),
                             island_margin=island_margin,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def hero_atlas(coll, name, size=512, samples=1, roughness=0.62, metallic=0.0,
               angle_deg=66.0, island_margin=0.02, margin_px=6, keep=()):
    """AO x tint x albedo -> one `atlas_<name>` image; returns (image, material).
    Run after bake_ao + tint_pass, before join/export.

    `keep` names objects that stay OUT of the atlas and keep their own material:
    an emissive lantern glass is not an albedo, and baking it flat would put the
    lit pane in the same unlit draw as the iron."""
    kept = [o for o in coll.objects
            if o.type == 'MESH' and any(o.name.startswith(k) for k in keep)]
    objs = [o for o in coll.objects if o.type == 'MESH' and o.data.materials
            and o not in kept]
    if not objs:
        raise RuntimeError(f'hero_atlas: {name} has no textured meshes')
    _unique_materials(objs)
    atlas_unwrap(objs, angle_deg, island_margin)
    n_mats = _wire_vertex_colour(objs)

    img = bpy.data.images.get(f'atlas_{name}')
    if img is not None:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(f'atlas_{name}', width=size, height=size, alpha=False)
    img.generated_color = (0.0, 0.0, 0.0, 1.0)
    _bake_target(objs, img)

    scn = bpy.context.scene
    prev_engine = scn.render.engine
    scn.render.engine = 'CYCLES'
    scn.cycles.device = 'CPU'
    scn.cycles.samples = samples
    scn.cycles.use_denoising = False
    bake = scn.render.bake
    bake.use_pass_direct = False
    bake.use_pass_indirect = False
    bake.use_pass_color = True
    bake.margin = margin_px
    bake.use_selected_to_active = False
    bake.use_clear = True
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type='DIFFUSE')
    scn.render.engine = prev_engine

    # One material for the whole asset, sampling the atlas.
    amat = bpy.data.materials.get(f'Atlas_{name}')
    if amat is not None:
        bpy.data.materials.remove(amat)
    amat = bpy.data.materials.new(f'Atlas_{name}')
    amat.use_nodes = True
    nt = amat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.location = (-340, 200)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])

    _unique_materials(kept)
    for obj in objs + kept:
        me = obj.data
        if obj in objs:
            me.materials.clear()
            me.materials.append(amat)
        # COLOR_0 stays present (uniform attributes for the merge) but WHITE:
        # the AO it used to carry now lives in the atlas.
        attr = me.color_attributes.get('Col')
        if attr is not None:
            me.color_attributes.active_color = attr
            for d in attr.data:
                d.color = (1.0, 1.0, 1.0, 1.0)

    # JPEG, not PNG, and it has to go through a FILE to get there: the glTF
    # exporter's AUTO format re-encodes a GENERATED image as PNG whatever
    # `file_format` says, and the PNG of this bake is ~6x the bytes for no
    # visible gain on an opaque albedo of soft gradients (2.2 MB of hero weapons
    # is 2.2 MB the queue has to pull before the match starts).
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), f'pbr_atlas_{name}.jpg')
    img.filepath_raw = tmp
    img.file_format = 'JPEG'
    img.save()
    disk = bpy.data.images.load(tmp)
    disk.name = f'atlas_{name}_jpg'
    disk.pack()
    tex.image = disk
    bpy.data.images.remove(img)
    img = disk
    print(f'ATLAS {name}: {size}x{size} baked from {n_mats} materials '
          f'on {len(objs)} objects -> Atlas_{name}')
    return img, amat


# ── hero authoring frame ─────────────────────────────────────
# Hero builders author in GAME space (x right, y up, z forward = the bow, the
# muzzle, the direction the client's +Z points) and this converts once, so a
# pivot in the plan reads the same in the script: game +Y = Blender +Z, game +Z
# = Blender -Y (the export is yup).
def G(x, y, z):
    return Vector((x, -z, y))


def game_axis_rot(axis):
    """Rotation that points a Blender-Z primitive down a GAME axis."""
    if axis == 'y':
        return Matrix.Identity(4)
    if axis == 'z':
        return Matrix.Rotation(math.radians(90), 4, 'X')
    return Matrix.Rotation(math.radians(90), 4, 'Y')


def set_origin_game(obj, pivot):
    """Move the object's ORIGIN to a game-space point without moving the mesh.
    The node's translation is what the client rotates about: a cannon barrel
    elevates around its trunnions, a wheel spins on its axle."""
    p = G(*pivot)
    for v in obj.data.vertices:
        v.co = v.co - p
    obj.location = obj.location + p


print('atlas helpers loaded')
