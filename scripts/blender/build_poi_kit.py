# POI KIT (lane b4.7). Part 1 = the CLIMB KIT (b4.7b; islands-05, vm:islands:1); the POI pieces
# (ruin temple, walls, arch, stilt outpost, ...) join this file in b4.7c.
#
# climb_kit.glb carries five NODES that Landmarks.buildRopeLadder instances along every placed
# climb route (src/server/world/placement/climbs.ts -> island.climbs), one InstancedMesh per node:
#
#   climb_rail   hewn ladder rail, 1 unit along game +Y from its foot (scaled to the segment length),
#                8-sided with adze facets, r 0.045 m
#   climb_rung   round rung, 1 unit along game X centred on 0 (scaled to the rail span + overhang),
#                r 0.03 m, a 3-turn rope lashing where it crosses each rail (Rope)
#   climb_rope   laid three-strand hawser, 1 unit along +Y (scaled per segment), r 0.038 m; the
#                lobes turn 120 deg per unit so segments join seamlessly at any length
#   climb_knot   stopper knot, metres (unscaled), centred on 0, axis +Y, 0.075 m bulge
#   climb_stake  hewn mooring stake, UNIT radius and length (scaled to r, h): pointed foot at 0,
#                chamfered head at 1, rope whipping under the head
#
# Wood_Mid + Rope palette materials (no textures: the climb kit is a near prop drawn from the
# island build, never a far silhouette). Tier 'climb-kit' in scripts/test-asset-tiers.mjs.
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_poi_kit.py
# env: BR_EXPORT_DIR (output dir), POI_ONLY=climb_kit
import bpy
import bmesh
import math
import os
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
ONLY = {s.strip() for s in os.environ.get('POI_ONLY', '').split(',') if s.strip()}

RAIL_HALF = 0.24   # Landmarks CLIMB_RAIL_HALF_M
RUNG_OVER = 0.04   # rung overhang past each rail
TAU = 2.0 * math.pi


def ring(c, r, sides, phase=0.0, lobes=None, axis='Z'):
    """A ring of `sides` points around centre c, in the plane normal to `axis` (Blender space)."""
    pts = []
    for i in range(sides):
        a = phase + TAU * i / sides
        rr = r * (lobes[i % len(lobes)] if lobes else 1.0)
        ca, sa = math.cos(a) * rr, math.sin(a) * rr
        pts.append(Vector((c[0] + ca, c[1] + sa, c[2])) if axis == 'Z' else Vector((c[0], c[1] + ca, c[2] + sa)))
    return pts


def loft(name, rings, material, coll, cap0=True, cap1=True, smooth=True):
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap0:
        bm.faces.new(list(reversed(vs[0])))
    if cap1:
        bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return obj_from_bmesh(name, bm, coll, material=material, smooth=smooth)


HEWN8 = [1.0, 0.93, 1.0, 0.96, 1.0, 0.92, 1.0, 0.95]
HEWN6 = [1.0, 0.94, 1.0, 0.97, 1.0, 0.92]
LAID = [1.0, 0.8]  # 3 strands on a 6-gon: 120 deg symmetric


def build_climb_kit():
    coll = asset_collection('climb_kit')
    wood = mat('Wood_Mid')
    rope = mat('Rope')

    # Rail: foot at z 0, 1 unit up, a slight twist so the facets catch light differently per segment.
    loft('climb_rail', [ring((0, 0, z), 0.045, 8, 0.12 * z, HEWN8) for z in (0.0, 0.5, 1.0)], wood, coll)

    # Rung: x -0.5..0.5, lashings where the rails cross (x = +-RAIL_HALF / span in unit space).
    span = 2.0 * (RAIL_HALF + RUNG_OVER)
    rung = loft('climb_rung', [ring((x, 0, 0), r, 6, 0.0, None, 'X')
                               for x, r in ((-0.5, 0.027), (0.0, 0.031), (0.5, 0.027))], wood, coll)
    parts = [rung]
    for s in (-1.0, 1.0):
        xc = s * RAIL_HALF / span
        w = 0.05 / span
        parts.append(loft(f'lash{s:+.0f}', [ring((xc + dx, 0, 0), r, 6, 0.4, LAID, 'X')
                                            for dx, r in ((-w, 0.036), (0.0, 0.046), (w, 0.036))], rope, coll))
    join(parts, 'climb_rung')

    # Rope: 7 rings, the lay turns 120 deg over the unit (3-fold lobes -> seamless at any segment scale).
    loft('climb_rope', [ring((0, 0, k / 6), 0.038, 6, (TAU / 3) * k / 6, LAID) for k in range(7)], rope, coll,
         cap0=False, cap1=False)

    # Knot: a wrapped bulge 0.16 m long, centred on the rope line (no caps: its ends sit inside the rope).
    loft('climb_knot', [ring((0, 0, z), r, 6, ph, [1.0, 0.72]) for z, r, ph in
                        ((-0.08, 0.036, 0.0), (-0.04, 0.062, 1.0), (0.0, 0.075, 2.0), (0.04, 0.062, 3.0), (0.08, 0.036, 4.0))],
         rope, coll, cap0=False, cap1=False)

    # Stake: unit radius/length, pointed foot, chamfered head, rope whipping under the head.
    stake = loft('climb_stake', [ring((0, 0, z), r, 6, 0.0, HEWN6) for z, r in
                                 ((0.0, 0.08), (0.14, 0.86), (0.82, 1.0), (0.95, 0.96), (1.0, 0.74))], wood, coll, smooth=False)
    band = loft('whip', [ring((0, 0, z), r, 6, 0.5, LAID) for z, r in ((0.76, 1.08), (0.80, 1.16), (0.84, 1.08))],
                rope, coll, cap0=False, cap1=False)
    join([stake, band], 'climb_stake')

    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in coll.objects}
    print('CLIMB_KIT_TRIS', tris, 'total', sum(tris.values()))
    export_collection(coll, 'climb_kit.glb')


clear_default_scene()
BUILDERS = [('climb_kit', build_climb_kit)]
for key, fn in BUILDERS:
    if not ONLY or key in ONLY:
        fn()
