# Builds the 15-piece CAVE INTERIOR KIT (CAVE-01 / islandworld-03).
#
# WHY. Everything standing inside a cave was a ConeGeometry / DodecahedronGeometry
# / BoxGeometry union built in the client at runtime: 6-segment cones for
# stalactites, a dodecahedron for a crystal bed, three boxes for a torch, two
# boxes for a chest. Caves photographed as "tan flat walls with blue flat-blade
# crystals" because there was nothing authored in them. This is the authored kit
# CaveBuilder instances instead.
#
# CONVENTIONS (same as build_rocks.py / build_plants.py):
#   1 Blender unit = 1 m, +Z up (glTF export flips to +Y up).
#   FLOOR pieces are anchored minZ = 0 so they seat on the cave floor.
#   CEILING pieces are anchored maxZ = 0 and hang into -Z, so the client seats
#     them by putting their origin ON the ceiling plane. scripts/test-asset-bounds
#     pins that negative base in PINNED_BASE — a rebuild that moves the anchor
#     fails there first.
#   Vertex-colour AO + tint pass, no textures; the client's rock triplanar family
#     paints the surface.
#
# Rock pieces (dripstones, rock_arch_cave, cave_ledge, cave_pool_rim) are rock kit v2 (b4.5b, see the
# ROCK KIT v2 II block below); CAVE_ONLY=<keys> rebuilds only those keys.
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_cave_kit.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())
exec(open(os.path.join(HERE, "_detail.py")).read())
exec(open(os.path.join(HERE, "_nature.py")).read())
exec(open(os.path.join(HERE, "_rock.py")).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
CAVE_ONLY = {n.strip() for n in os.environ.get('CAVE_ONLY', '').split(',') if n.strip()}

# Cave-specific palette entries. Names are stable: the client's
# AssetMaterialCollapse keys its cave tint off them.
PALETTE.setdefault("Rock_Cave",   ((0.26, 0.22, 0.18, 1.0), 0.95, 0.0))
PALETTE.setdefault("Rock_Flow",   ((0.38, 0.32, 0.24, 1.0), 0.92, 0.0))   # flowstone, paler
PALETTE.setdefault("Crystal_Glow", ((0.42, 0.78, 1.00, 1.0), 0.25, 0.0))
PALETTE.setdefault("Flame_Glow",  ((1.00, 0.66, 0.24, 1.0), 0.30, 0.0))
PALETTE.setdefault("Bone_White",  ((0.82, 0.79, 0.70, 1.0), 0.92, 0.0))
PALETTE.setdefault("Ochre_Paint", ((0.66, 0.31, 0.14, 1.0), 0.95, 0.0))


# ── shared finishing ─────────────────────────────────────────────────────────
def freeze(coll):
    """Bake every object transform into its mesh so AO/tint/join see world space."""
    for obj in [o for o in coll.objects if o.type == 'MESH']:
        bpy.context.view_layer.update()
        obj.data.transform(obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)


def anchor(coll, mode):
    """Move the whole asset so its mount plane sits at z = 0 and it is centred
    in XY. 'floor' -> minZ = 0, 'ceiling' -> maxZ = 0 (hangs into -Z)."""
    objs = [o for o in coll.objects if o.type == 'MESH']
    vs = [v for o in objs for v in o.data.vertices]
    zmin = min(v.co.z for v in vs)
    zmax = max(v.co.z for v in vs)
    cx = (min(v.co.x for v in vs) + max(v.co.x for v in vs)) * 0.5
    cy = (min(v.co.y for v in vs) + max(v.co.y for v in vs)) * 0.5
    dz = -zmin if mode == 'floor' else -zmax
    for o in objs:
        for v in o.data.vertices:
            v.co.x -= cx
            v.co.y -= cy
            v.co.z += dz
        o.data.update()


def finish_cave(coll, name, budget, mode='floor', ao_floor=0.52, seed=11):
    freeze(coll)
    anchor(coll, mode)
    # A cave has no sky: the AO floor is darker than the nature pass (0.66) so
    # the crown of a formation reads dark and its lit face reads by contrast.
    bake_ao(coll, samples=22, floor=ao_floor, max_dist=2.6, height_gradient=0.0)
    spec = tint_spec(moss=0.0)
    cave_stone = dict(
        tone=0.15,
        hue=((1.14, 1.06, 0.94), (0.84, 0.86, 0.94)), scale=0.9,
        mottle=0.12, mscale=0.22,
        streak=dict(axis='z', freq=7.0, amt=0.16),
        low=dict(z=0.30, amt=0.26, col=(0.52, 0.50, 0.44)),
    )
    spec['Rock_Cave'] = cave_stone
    spec['Rock_Flow'] = dict(cave_stone, tone=0.12, streak=dict(axis='z', freq=14.0, amt=0.20))
    spec['Bone_White'] = dict(tone=0.10, hue=((1.06, 1.03, 0.96), (0.88, 0.86, 0.80)),
                              scale=0.5, mottle=0.07, mscale=0.14)
    # Emissive channels must NOT be tinted: a jittered glow reads as dirt.
    spec.pop('Crystal_Glow', None)
    spec.pop('Flame_Glow', None)
    tint_pass(coll, spec, seed=seed, verbose=False)
    join([o for o in coll.objects if o.type == 'MESH'], name)
    path = export_collection_vc(coll, name + '.glb')
    info = verify_glb(path)
    assert info['tris'] <= budget, (name, info['tris'], budget)
    assert info['color0'] and len(info['materials']) <= 6, info
    for obj in coll.objects:
        obj.hide_render = True
    return info


def spike(coll, name, pos, r, h, up, material, segs=7, cuts=1, seed=0, lean=0.0, yaw=0.0):
    """One dripstone cone. `up` False hangs it (tip at the low end)."""
    bm = bm_cylinder(r if up else r * 0.05, r * 0.05 if up else r, h, segs)
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    xform(bm, T(0, 0, h * 0.5 if up else -h * 0.5))
    if lean:
        xform(bm, RY(lean) if up else RY(-lean))
    xform(bm, RZ(yaw))
    xform(bm, T(*pos))
    o = obj_from_bmesh(name, bm, coll, material)
    displace_noise(o, strength=r * 0.55, scale=0.5 + r, seed=seed)
    apply_modifiers(o)
    return o


def blob(coll, name, pos, scale, material, subdiv=1, seed=0, disp=0.16):
    bm = bm_icosphere(1.0, subdiv)
    xform(bm, S(*scale))
    xform(bm, T(*pos))
    o = obj_from_bmesh(name, bm, coll, material)
    if disp:
        displace_noise(o, strength=disp, scale=0.9, seed=seed)
        apply_modifiers(o)
    return o


def slab(coll, name, pos, size, material, seed=0, disp=0.09, rot=(0, 0, 0), cuts=2):
    bm = bm_box(*size)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    if rot[0]:
        xform(bm, RX(rot[0]))
    if rot[1]:
        xform(bm, RY(rot[1]))
    if rot[2]:
        xform(bm, RZ(rot[2]))
    xform(bm, T(*pos))
    o = obj_from_bmesh(name, bm, coll, material)
    if disp:
        displace_noise(o, strength=disp, scale=1.1, seed=seed)
        apply_modifiers(o)
    return o


# ── the twelve-plus-three pieces ─────────────────────────────────────────────
# ── ROCK KIT v2 II (b4.5b; assets-08, liveplay-11): the rock pieces on the shared rock core ──────
# stalactite/stalagmite clusters, rock_arch_cave, cave_ledge and cave_pool_rim were 420-740 tri
# unions of 7-sided cones, boxes and icospheres ("flat cones", "an empty brown tube"). They are now
# built like build_rocks.py: overlapping primitives unioned through a voxel remesh into ONE welded
# 300-600k HIGH surface, sculpted (PolyHaven CC0 height map octaves, growth rings / bedding grooves,
# chips), collapse-decimated into the cave-cluster band (3-8k, PLAN section 6 row 13) with face-area
# weighted normals (verts/tris ~0.5), then fitted per axis into the HEAD AABB (measured 2026-10-02) so
# the test-asset-bounds pins (ceiling pieces hang from maxZ = 0) and CaveBuilder spacing hold, and
# finished by finish_cave (AO + cave tint; Rock_Cave / Rock_Flow names unchanged).
CAVE_BOXES = {
    'stalactite_cluster_a': ((-0.528, -0.456, -1.446), (0.528, 0.456, 0.0)),
    'stalactite_cluster_b': ((-0.528, -0.453, -1.411), (0.528, 0.453, 0.0)),
    'stalagmite_cluster_a': ((-0.528, -0.453, 0.0), (0.528, 0.453, 1.337)),
    'stalagmite_cluster_b': ((-0.528, -0.483, 0.0), (0.528, 0.483, 1.334)),
    'cave_ledge': ((-1.212, -0.684, 0.0), (1.212, 0.684, 1.316)),
    'cave_pool_rim': ((-1.710, -1.672, 0.0), (1.710, 1.672, 0.302)),
    'rock_arch_cave': ((-2.249, -0.360, 0.0), (2.249, 0.360, 3.009)),
}
CAVE_BAND = (3000, 8000)
CAVE_SCULPT = dict(macro=(0.012, 0.5), heights=((0, 0.9, 0.010), (1, 0.35, 0.005), (0, 0.15, 0.002)),
                   strata=dict(bed=0.11, amp=0.006, dip=(0.0, 0.0, 1.0)), chips=0.004)


def _fit_box(objs, box):
    lo, hi = Vector(box[0]), Vector(box[1])
    vs = [v for o in objs for v in o.data.vertices]
    amin = Vector(tuple(min(v.co[a] for v in vs) for a in range(3)))
    amax = Vector(tuple(max(v.co[a] for v in vs) for a in range(3)))
    for v in vs:
        for a in range(3):
            v.co[a] = lo[a] + (v.co[a] - amin[a]) * (hi[a] - lo[a]) / max(1e-6, amax[a] - amin[a])
    for o in objs:
        o.data.update()


def _cone(coll, name, base, r0, r1, h, tilt, yaw, segs=14):
    """A raw dripstone cone (no material, no displacement: the sculpt does the surface). Growth
    bulges every ~0.2 m so the remeshed column is not a perfect lathe."""
    bm = bmesh.new()
    rings = max(4, int(h / 0.06))
    rows = []
    for i in range(rings + 1):
        t = i / rings
        r = (r0 + (r1 - r0) * t ** 0.8) * (1.0 + 0.10 * math.sin(t * h * 31.0 + yaw * 5.0))
        rows.append([bm.verts.new((math.cos(a) * r, math.sin(a) * r, t * h))
                     for a in (k / segs * math.tau for k in range(segs))])
    for i in range(rings):
        for k in range(segs):
            j = (k + 1) % segs
            bm.faces.new((rows[i][k], rows[i][j], rows[i + 1][j], rows[i + 1][k]))
    bm.faces.new(list(reversed(rows[0])))
    bm.faces.new(rows[-1])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return place(o, base, (math.degrees(tilt[0]), math.degrees(tilt[1]), math.degrees(yaw)))


def _rock_piece(name, parts_fn, target, zones, mode, seed, recipe=None, smooth_iters=1):
    coll = asset_collection(name)
    scratch = asset_collection(name + '_hi')
    parts = parts_fn(scratch)
    high, voxel = fracture_cluster(parts, name + '_hi', smooth_iters=smooth_iters)
    sculpt(high, seed, **(recipe or CAVE_SCULPT))
    hi_tris = tri_count(high)
    low = lod0(high, name, coll, target)
    bpy.data.objects.remove(high, do_unlink=True)
    _fit_box([low], CAVE_BOXES[name])
    zone_materials(low, zones)
    info = finish_cave(coll, name, CAVE_BAND[1], mode=mode, seed=seed)
    print(f"CAVE {name} high={hi_tris} voxel={voxel:.4f} lod0={info['tris']}", flush=True)
    assert 300000 <= hi_tris <= 600000, (name, 'high sculpt', hi_tris)
    assert CAVE_BAND[0] <= info['tris'] <= CAVE_BAND[1], (name, info['tris'])
    return info


def build_dripstone(name, up, seed, count, target):
    """stalactite_cluster_* (up=False, hangs from the ceiling) / stalagmite_cluster_* (up=True):
    a flowstone collar with `count` dripstones that merge into it, thinning to real tips."""
    def parts(coll):
        rng = random.Random(seed)
        sgn = 1.0 if up else -1.0
        out = [place(voronoi_cell('collar', coll, seed, scale=(0.60, 0.52, 0.17), planes=9, reach=(0.6, 0.92),
                                  caps=(0.9,)), (0, 0, 0.02 * sgn))]
        for i in range(count):
            a = rng.uniform(0, math.tau)
            rad = 0.42 * math.sqrt(rng.uniform(0.0, 1.0))
            r0 = rng.uniform(0.09, 0.20) * (1.0 - rad * 0.6)
            h = rng.uniform(0.55, 1.40) * (1.0 - rad * 0.45)
            lean = rng.uniform(-0.12, 0.12)
            tilt = (lean, rng.uniform(-0.08, 0.08)) if up else (math.pi + lean, rng.uniform(-0.08, 0.08))
            out.append(_cone(coll, f'drip{i}', (math.cos(a) * rad, math.sin(a) * rad, -0.05 * sgn),
                             r0, max(0.012, r0 * 0.07), h, tilt, a))
            if rng.random() < 0.45:  # a soda straw / sibling growing off the same collar
                b = a + rng.uniform(-0.5, 0.5)
                out.append(_cone(coll, f'straw{i}', (math.cos(b) * (rad + 0.08), math.sin(b) * (rad + 0.08),
                                                     -0.03 * sgn), r0 * 0.45, 0.01, h * 0.45, tilt, b))
        return out
    if up:
        zones = [('Rock_Cave', lambda z, nz: z < 0.16), ('Rock_Flow', lambda z, nz: True)]
    else:
        zones = [('Rock_Cave', lambda z, nz: True)]
    return _rock_piece(name, parts, target, zones, 'floor' if up else 'ceiling', seed)


def build_rock_arch_cave():
    """A cave arch carved from ONE mass (boolean tunnel through a Voronoi block), not a tube on boxes."""
    name = 'rock_arch_cave'

    def parts(coll):
        mass = place(voronoi_cell('mass', coll, 131, scale=(2.35, 0.50, 1.62), planes=12, reach=(0.74, 0.96),
                                  up_bias=1.5, caps=(0.94,)), (0, 0, 1.45), (0, 2, 0))
        bm = bmesh.new()
        segs, ring = 72, []
        for i in range(segs):
            a = i / segs * math.tau
            w = 1.0 + 0.06 * math.sin(3 * a + 0.4)
            ring.append((math.cos(a) * 1.42 * w, -0.25 + math.sin(a) * 2.35 * w))
        f = [bm.verts.new((x, -1.5, z)) for x, z in ring]
        b = [bm.verts.new((x, 1.5, z)) for x, z in ring]
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((f[i], f[j], b[j], b[i]))
        bm.faces.new(list(reversed(f)))
        bm.faces.new(b)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new('tunnel')
        bm.to_mesh(me)
        bm.free()
        cut = bpy.data.objects.new('tunnel', me)
        coll.objects.link(cut)
        md = mass.modifiers.new('carve', 'BOOLEAN')
        md.operation = 'DIFFERENCE'
        md.solver = 'EXACT'
        md.object = cut
        _apply(mass, md)
        bpy.data.objects.remove(cut, do_unlink=True)
        out = [mass]
        for s, k in ((-1, 0), (1, 1)):  # piers outside the cut carry the span onto the floor
            out.append(place(voronoi_cell(f'pier{k}', coll, 150 + k, scale=(0.46, 0.46, 0.95), planes=9,
                                          reach=(0.66, 0.95), caps=(0.92,)), (s * 1.78, 0.0, 0.85), (0, 3 * s, 8 * s)))
        for s, k in ((-1, 0), (1, 1)):  # fallen blocks at the feet
            out.append(place(voronoi_cell(f'foot{k}', coll, 140 + k, scale=(0.38, 0.30, 0.26), planes=8,
                                          reach=(0.6, 0.92), points=600), (s * 2.05, 0.05, 0.10), (12, -8, 30 * s)))
        return out
    recipe = dict(CAVE_SCULPT, macro=(0.03, 1.0), heights=((0, 1.6, 0.024), (1, 0.6, 0.010), (0, 0.25, 0.004)),
                  strata=dict(bed=0.30, amp=0.016, dip=(0.08, 0.0, 1.0)), chips=0.008)
    return _rock_piece(name, parts, 6500, [('Rock_Cave', lambda z, nz: True)], 'floor', 13, recipe, 2)


def build_cave_ledge():
    """A bedded rock shelf: a flat-capped deck slab on two corbels against a back wall."""
    name = 'cave_ledge'

    def parts(coll):
        return [place(voronoi_cell('deck', coll, 3, scale=(1.30, 0.70, 0.26), planes=16, reach=(0.50, 0.84),
                                   caps=(0.80,)), (0, -0.04, 1.04), (0, 1.5, 0)),
                place(voronoi_cell('deck2', coll, 4, scale=(0.70, 0.52, 0.20), planes=12, reach=(0.55, 0.88),
                                   caps=(0.78,)), (0.55, -0.12, 0.86), (0, -3, 25)),
                place(voronoi_cell('br0', coll, 5, scale=(0.30, 0.42, 0.55), planes=8, reach=(0.62, 0.92)),
                      (-0.72, 0.12, 0.55), (10, 0, 12)),
                place(voronoi_cell('br1', coll, 6, scale=(0.34, 0.40, 0.50), planes=8, reach=(0.62, 0.92)),
                      (0.78, 0.15, 0.50), (-12, 0, -8)),
                place(voronoi_cell('back', coll, 9, scale=(1.20, 0.20, 0.68), planes=10, reach=(0.66, 0.95)),
                      (0, 0.50, 0.66), (0, 0, 2))]
    recipe = dict(CAVE_SCULPT, strata=dict(bed=0.16, amp=0.010, dip=(0.05, 0.0, 1.0)))
    return _rock_piece(name, parts, 5000, [('Rock_Cave', lambda z, nz: True)], 'floor', 5, recipe)


def build_cave_pool_rim():
    """Rimstone dam: scalloped gour lips around the pool, unioned into one welded rim."""
    name = 'cave_pool_rim'

    def parts(coll):
        rng = random.Random(23)
        out = []
        for i in range(22):
            a = i / 22.0 * math.tau + rng.uniform(-0.04, 0.04)
            r = 1.48 + rng.uniform(-0.08, 0.08)
            h = rng.uniform(0.11, 0.17)
            out.append(place(voronoi_cell(f'lip{i}', coll, 23 + i, scale=(0.26, 0.46, h), planes=9,
                                          reach=(0.66, 0.94), points=700, caps=(0.85,)),
                             (math.cos(a) * r, math.sin(a) * r, h * 0.85), (0, 0, math.degrees(a))))
        return out
    recipe = dict(CAVE_SCULPT, strata=dict(bed=0.05, amp=0.004, dip=(0.0, 0.0, 1.0)))
    return _rock_piece(name, parts, 5000, [('Rock_Flow', lambda z, nz: True)], 'floor', 23, recipe, 2)


def build_crystal_vein(name, seed, shards, budget):
    coll = asset_collection(name)
    rng = random.Random(seed)
    glow = emissive('Crystal_Glow', (0.42, 0.78, 1.00, 1.0), 2.6)
    bed = mat('Rock_Dark')
    blob(coll, 'bed', (0, 0, 0.10), (0.52, 0.40, 0.18), bed, subdiv=1, seed=seed, disp=0.10)
    for i in range(shards):
        a = rng.uniform(0, math.tau)
        rad = rng.uniform(0.0, 0.30)
        h = rng.uniform(0.35, 0.95)
        r = rng.uniform(0.055, 0.11)
        bm = bm_cylinder(r, r * 0.55, h, 6)         # hexagonal prism, tapered tip
        xform(bm, T(0, 0, h * 0.5))
        xform(bm, RY(rng.uniform(-0.5, 0.5)))
        xform(bm, RZ(a))
        xform(bm, T(math.cos(a) * rad, math.sin(a) * rad, 0.10))
        obj_from_bmesh(f'shard{i}', bm, coll, glow)
    return finish_cave(coll, name, budget, mode='floor', ao_floor=0.7, seed=seed)


def build_rope_bridge_short():
    name = 'rope_bridge_short'
    coll = asset_collection(name)
    rope = mat('Rope')
    wood = mat('Wood_Dark')
    span = 5.0
    for s in (-1, 1):
        rope_cat(coll, f'deckrope{s}', Vector((-span / 2, s * 0.55, 0.30)),
                 Vector((span / 2, s * 0.55, 0.30)), sag=0.22, r=0.035, segs=9, material=rope)
        rope_cat(coll, f'handrope{s}', Vector((-span / 2, s * 0.62, 1.10)),
                 Vector((span / 2, s * 0.62, 1.10)), sag=0.16, r=0.028, segs=9, material=rope)
    for i in range(11):
        t = i / 10.0
        x = -span / 2 + span * t
        sag = 0.22 * math.sin(math.pi * t)
        slab(coll, f'plank{i}', (x, 0, 0.30 - sag), (0.34, 1.18, 0.07), wood, seed=0, disp=0.0, cuts=0)
    return finish_cave(coll, name, 1400, mode='floor', ao_floor=0.6, seed=31)


def build_wall_torch():
    name = 'wall_torch'
    coll = asset_collection(name)
    iron = mat('Metal_Iron')
    wood = mat('Wood_Dark')
    flame = emissive('Flame_Glow', (1.00, 0.62, 0.20, 1.0), 3.4)
    slab(coll, 'plate', (0, 0.06, 0.22), (0.20, 0.08, 0.44), iron, disp=0.0)
    bm = bm_cylinder(0.045, 0.055, 0.62, 7)
    xform(bm, RX(-0.42))
    xform(bm, T(0, -0.10, 0.52))
    obj_from_bmesh('staff', bm, coll, wood)
    bm = bm_cylinder(0.09, 0.13, 0.16, 8)
    xform(bm, T(0, -0.22, 0.82))
    obj_from_bmesh('cup', bm, coll, iron)
    blob(coll, 'flame', (0, -0.22, 0.97), (0.11, 0.11, 0.19), flame, subdiv=1, seed=0, disp=0.0)
    return finish_cave(coll, name, 700, mode='floor', ao_floor=0.7, seed=41)


def build_bone_pile_cave():
    name = 'bone_pile_cave'
    coll = asset_collection(name)
    rng = random.Random(53)
    bone = mat('Bone_White')
    for i in range(7):
        a = rng.uniform(0, math.tau)
        L = rng.uniform(0.45, 0.85)
        bm = bm_cylinder(0.045, 0.055, L, 6)
        xform(bm, RY(math.pi / 2 + rng.uniform(-0.35, 0.35)))
        xform(bm, RZ(a))
        xform(bm, T(rng.uniform(-0.35, 0.35), rng.uniform(-0.30, 0.30), 0.06 + i * 0.035))
        obj_from_bmesh(f'bone{i}', bm, coll, bone)
    blob(coll, 'skull', (0.24, -0.16, 0.20), (0.16, 0.19, 0.15), bone, subdiv=2, seed=53, disp=0.03)
    blob(coll, 'jaw', (0.24, -0.30, 0.11), (0.13, 0.09, 0.05), bone, subdiv=1, seed=54, disp=0.0)
    return finish_cave(coll, name, 900, mode='floor', ao_floor=0.6, seed=53)


def build_skull_shrine():
    name = 'skull_shrine'
    coll = asset_collection(name)
    rng = random.Random(67)
    rock = mat('Rock_Cave')
    bone = mat('Bone_White')
    wax = emissive('Flame_Glow', (1.00, 0.62, 0.20, 1.0), 3.4)
    for i in range(5):
        z = 0.14 + i * 0.20
        w = 0.72 - i * 0.10
        slab(coll, f'cairn{i}', (rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), z),
             (w, w * 0.85, 0.22), rock, seed=67 + i, disp=0.06, rot=(0, 0, rng.uniform(0, 1.2)))
    blob(coll, 'skull', (0, 0, 1.26), (0.20, 0.23, 0.19), bone, subdiv=2, seed=67, disp=0.03)
    for s in (-1, 1):
        bm = bm_cylinder(0.035, 0.030, 0.16, 6)
        xform(bm, T(s * 0.30, 0.06, 1.16))
        obj_from_bmesh(f'candle{s}', bm, coll, bone)
        blob(coll, f'wick{s}', (s * 0.30, 0.06, 1.28), (0.035, 0.035, 0.06), wax, subdiv=1, disp=0.0)
    return finish_cave(coll, name, 1300, mode='floor', ao_floor=0.55, seed=67)


def build_cave_painting_panel():
    name = 'cave_painting_panel'
    coll = asset_collection(name)
    rng = random.Random(71)
    rock = mat('Rock_Flow')
    ochre = mat('Ochre_Paint')
    slab(coll, 'panel', (0, 0.09, 0.85), (1.90, 0.18, 1.70), rock, seed=71, disp=0.07)
    # Hand-prints and a tally of ships, 1 cm proud of the face so they catch the
    # torch instead of relying on a texture the kit does not ship.
    for i in range(9):
        x = -0.68 + (i % 5) * 0.34 + rng.uniform(-0.05, 0.05)
        z = 0.55 + (i // 5) * 0.52 + rng.uniform(-0.06, 0.06)
        bm = bm_box(0.15, 0.02, 0.19)
        xform(bm, T(x, -0.01, z))
        obj_from_bmesh(f'hand{i}', bm, coll, ochre)
    for i in range(4):
        bm = bm_box(0.035, 0.02, 0.42)
        xform(bm, RY(rng.uniform(-0.2, 0.2)))
        xform(bm, T(0.60 + i * 0.10, -0.01, 1.15))
        obj_from_bmesh(f'tally{i}', bm, coll, ochre)
    return finish_cave(coll, name, 900, mode='floor', ao_floor=0.62, seed=71)


def main():
    clear_default_scene()
    out = {}
    builds = [
        ('stalactite_cluster_a', lambda: build_dripstone('stalactite_cluster_a', False, 101, 7, 4500)),
        ('stalactite_cluster_b', lambda: build_dripstone('stalactite_cluster_b', False, 103, 10, 6000)),
        ('stalagmite_cluster_a', lambda: build_dripstone('stalagmite_cluster_a', True, 107, 6, 4500)),
        ('stalagmite_cluster_b', lambda: build_dripstone('stalagmite_cluster_b', True, 109, 9, 6000)),
        ('rock_arch_cave', build_rock_arch_cave),
        ('cave_ledge', build_cave_ledge),
        ('crystal_vein_a', lambda: build_crystal_vein('crystal_vein_a', 113, 7, 800)),
        ('crystal_vein_b', lambda: build_crystal_vein('crystal_vein_b', 127, 11, 1100)),
        ('cave_pool_rim', build_cave_pool_rim),
        ('rope_bridge_short', build_rope_bridge_short),
        ('wall_torch', build_wall_torch),
        ('bone_pile_cave', build_bone_pile_cave),
        ('skull_shrine', build_skull_shrine),
        ('cave_painting_panel', build_cave_painting_panel),
    ]
    for key, fn in builds:
        if CAVE_ONLY and key not in CAVE_ONLY:
            continue
        out[key] = fn()
    print('\nCAVE KIT SUMMARY')
    total = 0
    for k, v in out.items():
        total += v['tris']
        print(f"  {k:24} {v['tris']:5} tris  bbox {v['bbox_min']} .. {v['bbox_max']}")
    print(f"  {'TOTAL':24} {total:5} tris over {len(out)} pieces")


main()
