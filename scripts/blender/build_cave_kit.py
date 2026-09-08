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
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)

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
def build_dripstone(name, up, seed, count, budget):
    """stalactite_cluster_* (up=False) / stalagmite_cluster_* (up=True)."""
    coll = asset_collection(name)
    rng = random.Random(seed)
    rock = mat('Rock_Flow' if up else 'Rock_Cave')
    # A collar plate where the cluster meets the rock: a bare cone reads as a
    # traffic cone glued to the ceiling, the collar makes it grow out of stone.
    blob(coll, 'collar', (0, 0, 0.0), (0.62, 0.55, 0.16), mat('Rock_Cave'), subdiv=1, seed=seed, disp=0.07)
    for i in range(count):
        a = rng.uniform(0, math.tau)
        rad = rng.uniform(0.0, 0.42)
        r = rng.uniform(0.10, 0.24) * (1.0 - rad * 0.6)
        h = rng.uniform(0.55, 1.45) * (1.0 - rad * 0.35)
        spike(coll, f'spike{i}', (math.cos(a) * rad, math.sin(a) * rad, 0.0),
              r, h, up, rock, segs=7, cuts=1, seed=seed * 31 + i,
              lean=rng.uniform(-0.16, 0.16), yaw=a)
    return finish_cave(coll, name, budget, mode='floor' if up else 'ceiling', seed=seed)


def build_rock_arch_cave():
    name = 'rock_arch_cave'
    coll = asset_collection(name)
    rock = mat('Rock_Cave')
    # A span you can walk under: two piers and a lintel arc, 2.6 m clear.
    pts = []
    for i in range(11):
        t = i / 10.0
        a = math.pi * t
        pts.append(Vector((math.cos(a) * 1.85, 0.0, 0.15 + math.sin(a) * 2.55)))
    chain_pts(coll, 'span', pts, 0.30, 0.30, rock, segs=8, smooth=False)
    for s in (-1, 1):
        slab(coll, f'pier{s}', (s * 1.85, 0, 0.55), (0.78, 0.70, 1.10), rock, seed=7 + s)
    blob(coll, 'crown', (0, 0, 2.62), (0.55, 0.42, 0.34), rock, subdiv=1, seed=13)
    return finish_cave(coll, name, 1500, mode='floor', seed=13)


def build_cave_ledge():
    name = 'cave_ledge'
    coll = asset_collection(name)
    rock = mat('Rock_Cave')
    # A shelf a pirate can stand on: 2.4 x 1.3 deck, 0.55 thick, on two brackets.
    # The client gives it a matching server collider (islandworld-01).
    slab(coll, 'deck', (0, 0, 0.95), (2.40, 1.30, 0.34), rock, seed=3, disp=0.055)
    for s in (-1, 1):
        slab(coll, f'bracket{s}', (s * 0.78, 0.18, 0.42), (0.42, 0.72, 0.90), rock, seed=5 + s,
             rot=(0.22 * s, 0, 0))
    slab(coll, 'back', (0, 0.58, 0.62), (2.30, 0.26, 1.24), rock, seed=9, disp=0.10)
    return finish_cave(coll, name, 1200, mode='floor', seed=5)


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


def build_cave_pool_rim():
    name = 'cave_pool_rim'
    coll = asset_collection(name)
    rng = random.Random(23)
    rock = mat('Rock_Flow')
    # A 1.5 m rimstone dam: the ring of lipped stone a cave pool sits inside.
    for i in range(14):
        a = i / 14.0 * math.tau
        r = 1.45 + rng.uniform(-0.10, 0.10)
        h = rng.uniform(0.16, 0.30)
        slab(coll, f'lip{i}', (math.cos(a) * r, math.sin(a) * r, h * 0.5),
             (0.40, 0.30, h), rock, seed=23 + i, disp=0.05, rot=(0, 0, a), cuts=1)
    return finish_cave(coll, name, 1400, mode='floor', seed=23)


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
    out['stalactite_cluster_a'] = build_dripstone('stalactite_cluster_a', False, 101, 6, 900)
    out['stalactite_cluster_b'] = build_dripstone('stalactite_cluster_b', False, 103, 9, 1300)
    out['stalagmite_cluster_a'] = build_dripstone('stalagmite_cluster_a', True, 107, 5, 900)
    out['stalagmite_cluster_b'] = build_dripstone('stalagmite_cluster_b', True, 109, 8, 1300)
    out['rock_arch_cave'] = build_rock_arch_cave()
    out['cave_ledge'] = build_cave_ledge()
    out['crystal_vein_a'] = build_crystal_vein('crystal_vein_a', 113, 7, 800)
    out['crystal_vein_b'] = build_crystal_vein('crystal_vein_b', 127, 11, 1100)
    out['cave_pool_rim'] = build_cave_pool_rim()
    out['rope_bridge_short'] = build_rope_bridge_short()
    out['wall_torch'] = build_wall_torch()
    out['bone_pile_cave'] = build_bone_pile_cave()
    out['skull_shrine'] = build_skull_shrine()
    out['cave_painting_panel'] = build_cave_painting_panel()
    print('\nCAVE KIT SUMMARY')
    total = 0
    for k, v in out.items():
        total += v['tris']
        print(f"  {k:24} {v['tris']:5} tris  bbox {v['bbox_min']} .. {v['bbox_max']}")
    print(f"  {'TOTAL':24} {total:5} tris over {len(out)} pieces")


main()
