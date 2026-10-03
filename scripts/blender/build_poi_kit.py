# POI KIT (lane b4.7). Part 1 = the CLIMB KIT (b4.7b; islands-05, vm:islands:1). Part 2 = the POI
# PIECES (b4.7c2, islands-04): one GLB per placed kind/variant, drawn by Landmarks.buildPois at every
# island.pois entry (src/server/world/placement/pois.ts), one InstancedMesh per key + the
# `<key>_lods.glb` chain (build_lods.py, tier rows 'poi-*' in scripts/test-asset-tiers.mjs).
#
#   poi_ruin_temple        stepped platform, portico columns (some broken/fallen), cella walls, altar  18-30k
#   poi_ruin_wall_a/b/c    a straight wall with a window, b L corner, c low broken wall + rubble       3-5k
#   poi_ruin_arch          two piers + a voussoir arch, the walk-through faces +-Z                     3-6k
#   poi_stilt_outpost      plank hut on stilts, porch, thatch hip roof, front ladder                   ~12k
#   poi_skeleton_camp      A-frame tent, fire ring, bedrolls, crates, barrel, two skeletons, flag      ~15k
#   poi_overlook_platform  braced timber deck at 2.6 m, rail, front stair                              ~6k
#   poi_small_lighthouse   coursed stone tower, gallery, glazed lantern room (Lantern_Glass emissive)  ~20k
#   poi_jungle_shrine      stepped plinth, carved stele, braziers, offering bowl, vines                ~8k
#   poi_grotto_landing     plank jetty on piles out to the sea (+Z front), bollards, lamp  ~6k
#
# FRAME (the contract pois.ts states): origin = the stamped ground centre (foundations sink to -0.4 m so
# the 0.35 m stamp relief never shows air), game +Y up, local game +Z = the FRONT (= Blender -Y): the
# trail link for ruins/camps/overlooks, the sea for lighthouse/stilt/grotto. Every vertex fits inside
# POI_FOOTPRINT_M[kind] horizontally (asserted below, the build fails otherwise).
#
# Headless:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_poi_kit.py
# env: BR_EXPORT_DIR (output dir), POI_ONLY=climb_kit,poi_ruin_temple,...
import bpy
import bmesh
import math
import os
import random
from mathutils import Matrix, Vector

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


# ---------------------------------------------------------------------------------------------
# POI PIECES (b4.7c2). Built in Blender space with FRONT = -Y (exports to game +Z).
# ---------------------------------------------------------------------------------------------
POI_FOOTPRINT_M = {  # mirror of pois.ts POI_FOOTPRINT_M (test-island-props-poi checks the drawn bounds)
    'ruin_temple': 10, 'ruin_wall': 4.5, 'ruin_arch': 4, 'stilt_outpost': 6.5, 'skeleton_camp': 6.5,
    'overlook_platform': 4.5, 'small_lighthouse': 5, 'jungle_shrine': 4, 'grotto_landing': 5.5,
}


class Kit:
    """Parts accumulator for one POI key; every helper appends one object."""

    def __init__(self, key, seed):
        self.key = key
        self.coll = asset_collection(key)
        self.parts = []
        self.rnd = random.Random(seed)

    def _place(self, bm, at, rz=0.0, rx=0.0, ry=0.0):
        rot = Matrix.Rotation(rz, 3, 'Z') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rx, 3, 'X')
        bmesh.ops.rotate(bm, verts=bm.verts[:], cent=(0, 0, 0), matrix=rot)
        bmesh.ops.translate(bm, verts=bm.verts[:], vec=Vector(at))

    def block(self, w, d, h, at, material, rz=0.0, rx=0.0, ry=0.0, cuts=1, chip=0.035, smooth=True):
        """A dressed block, subdivided and chipped (weathered arrises, never a clean box)."""
        bm = bm_box(w, d, h)
        if cuts:
            bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
        r = self.rnd
        a = chip * min(w, d, h)
        for v in bm.verts:
            v.co += Vector((r.uniform(-a, a), r.uniform(-a, a), r.uniform(-a, a)))
        self._place(bm, at, rz, rx, ry)
        self.parts.append(obj_from_bmesh('blk', bm, self.coll, material=material, smooth=smooth))

    def post(self, r0, r1, h, at, material, sides=8, rings=4, rz=0.0, rx=0.0, ry=0.0, lobes=HEWN8, cap1=True):
        rings_ = [ring((0, 0, h * k / rings), r0 + (r1 - r0) * k / rings, sides, 0.13 * k, lobes) for k in range(rings + 1)]
        o = loft('post', rings_, material, self.coll, cap1=cap1, smooth=True)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        self._place(bm, at, rz, rx, ry)
        bm.to_mesh(o.data)
        bm.free()
        self.parts.append(o)

    def rock(self, r, at, material, sub=2, squash=0.6):
        bm = bm_icosphere(r, sub)
        rr = self.rnd
        for v in bm.verts:
            v.co *= rr.uniform(0.82, 1.12)
            v.co.z *= squash
        self._place(bm, at, rr.uniform(0, TAU))
        self.parts.append(obj_from_bmesh('rock', bm, self.coll, material=material, smooth=True))

    def leaves(self, r, at, n=3):
        for _ in range(n):
            o = (self.rnd.uniform(-r, r) * 0.6, self.rnd.uniform(-r, r) * 0.6, self.rnd.uniform(0, r * 0.4))
            self.rock(r * self.rnd.uniform(0.5, 0.8), (at[0] + o[0], at[1] + o[1], at[2] + o[2]),
                      mat(self.rnd.choice(('Leaf_Green', 'Leaf_Green_Lt'))), sub=1, squash=0.55)

    def finish(self, kind, sink=-0.4):
        obj = join(self.parts, self.key)
        me = obj.data
        rmax = max(math.hypot(v.co.x, v.co.y) for v in me.vertices)
        zmin = min(v.co.z for v in me.vertices)
        tris = sum(len(p.vertices) - 2 for p in me.polygons)
        lim = POI_FOOTPRINT_M[kind]
        print(f'POI_PIECE {self.key} tris {tris} rmax {rmax:.2f}/{lim} zmin {zmin:.2f}')
        if rmax > lim:
            raise SystemExit(f'{self.key}: drawn radius {rmax:.2f} m exceeds POI_FOOTPRINT_M[{kind}] = {lim}')
        export_collection(self.coll, f'{self.key}.glb')


def course_wall(k, x0, x1, y, z0, courses, bw, bd, bh, material, top=None, gap=None, cuts=1):
    """Running-bond wall along X at depth y. top(x) -> number of courses standing at x (broken crest);
    gap = (xa, xb, course_from) leaves a window/door open from that course up to the crest."""
    for c in range(courses):
        off = (bw * 0.5) if c % 2 else 0.0
        x = x0 - off
        while x < x1 - 0.05:
            xa, xb = max(x, x0), min(x + bw, x1)
            xm = 0.5 * (xa + xb)
            if xb - xa > 0.2 and (top is None or c < top(xm)) and not (gap and gap[0] < xm < gap[1] and c >= gap[2]):
                k.block(xb - xa - 0.03, bd * k.rnd.uniform(0.94, 1.0), bh - 0.02,
                        (xm, y + k.rnd.uniform(-0.02, 0.02), z0 + bh * (c + 0.5)), material,
                        rz=k.rnd.uniform(-0.02, 0.02), cuts=cuts)
            x += bw


def wall_y(k, y0, y1, x, z0, courses, bw, bd, bh, material, top=None, cuts=1):
    """Same wall along Y at x (built along X then turned 90 deg about its own line)."""
    for c in range(courses):
        off = (bw * 0.5) if c % 2 else 0.0
        y = y0 - off
        while y < y1 - 0.05:
            ya, yb = max(y, y0), min(y + bw, y1)
            ym = 0.5 * (ya + yb)
            if yb - ya > 0.2 and (top is None or c < top(ym)):
                k.block(bd * k.rnd.uniform(0.94, 1.0), yb - ya - 0.03, bh - 0.02, (x, ym, z0 + bh * (c + 0.5)), material,
                        rz=k.rnd.uniform(-0.02, 0.02), cuts=cuts)
            y += bw


FLUTE = [1.0, 0.94]


def column(k, r, h, at, material, broken=0.0, segs=16, rings=8):
    x, y, z = at
    k.block(r * 2.7, r * 2.7, 0.3, (x, y, z + 0.15), material, cuts=2)
    hh = h * (1.0 - broken)
    rings_ = []
    for i in range(rings + 1):
        t = i / rings
        rr = r * (1.0 - 0.12 * t) * (1.0 + 0.04 * math.sin(math.pi * t))
        rings_.append(ring((x, y, z + 0.3 + hh * t), rr, segs, 0.0, FLUTE))
    if broken:
        rings_[-1] = [p + Vector((0, 0, k.rnd.uniform(-0.25, 0.05))) for p in rings_[-1]]
    k.parts.append(loft('col', rings_, material, k.coll, smooth=True))
    if not broken:
        k.block(r * 2.5, r * 2.5, 0.32, (x, y, z + 0.3 + hh + 0.16), material, cuts=2)


def fallen_drum(k, r, length, at, rz, material):
    x, y, z = at
    o = loft('drum', [ring((0, 0, length * (i / 4 - 0.5)), r, 16, 0.0, FLUTE) for i in range(5)], material, k.coll)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    k._place(bm, (x, y, z + r * 0.85), rz, 0.0, math.pi / 2)
    bm.to_mesh(o.data)
    bm.free()
    k.parts.append(o)


def build_poi_ruin_temple():
    k = Kit('poi_ruin_temple', 101)
    st, dk = mat('Rock_Grey'), mat('Rock_Dark')
    # Three-tier platform, block grid, slight settling per block. Front (-Y) carries the stair.
    tiers = [(13.0, 12.0), (11.0, 10.2), (9.0, 8.6)]
    th = 0.45
    for i, (w, d) in enumerate(tiers):
        nx, ny = int(round(w / 1.6)), int(round(d / 1.5))
        for a in range(nx):
            for b in range(ny):
                bx, by = -w / 2 + (a + 0.5) * w / nx, -d / 2 + (b + 0.5) * d / ny
                k.block(w / nx - 0.04, d / ny - 0.04, th + (0.4 if i == 0 else 0.0),
                        (bx, by, -0.2 + i * th + (0.0 if i else -0.2) + k.rnd.uniform(-0.03, 0.02)),
                        st if (a + b) % 3 else dk, rz=k.rnd.uniform(-0.015, 0.015))
    # Front stair, 6 steps from the ground to the top tier.
    top = -0.2 + 2 * th + th * 0.5
    for s in range(6):
        k.block(4.2 - s * 0.1, 0.42, 0.24, (0.0, -6.35 + 0.42 * s, 0.0 + 0.24 * s * (top / 1.44)), dk, cuts=2)
    z1 = top
    # Portico: 6 columns across the front, 2 per side; three broken, two fallen drums on the platform.
    broken = {1: 0.55, 4: 0.3, 7: 0.7}
    spots = [(-3.6 + 1.44 * i, -3.5) for i in range(6)] + [(-3.6, -0.6), (3.6, -0.6), (-3.6, 2.2), (3.6, 2.2)]
    for i, (cx, cy) in enumerate(spots):
        column(k, 0.36, 4.2, (cx, cy, z1), st, broken=broken.get(i, 0.0))
    # Architrave: spans the standing pairs, one slab slid off and resting tilted against the platform.
    for xa, xb in ((-3.6, -2.16), (0.72, 2.16), (2.16, 3.6)):
        k.block(xb - xa + 0.7, 0.8, 0.5, ((xa + xb) / 2, -3.5, z1 + 0.3 + 4.2 + 0.32 + 0.25), st, cuts=2)
    k.block(2.0, 0.8, 0.5, (-1.1, -5.3, 0.7), st, rx=0.5, rz=0.3, cuts=2)
    fallen_drum(k, 0.34, 1.6, (1.4, -2.2, z1), 0.4, st)
    fallen_drum(k, 0.34, 1.1, (-5.4, -6.3, -0.1), 1.9, st)
    # Cella: side + back walls with broken crests, front wall with a door.
    crest = lambda x: 6 - int(2.5 * abs(math.sin(x * 1.7)) + (x > 1.0) * 2)
    course_wall(k, -3.0, 3.0, 3.4, z1, 6, 1.0, 0.7, 0.5, st, top=crest)
    course_wall(k, -3.0, 3.0, -1.6, z1, 6, 1.0, 0.7, 0.5, st, top=lambda x: 6 - int(abs(x) < 2.2) - (x < -1.5) * 2,
                gap=(-0.8, 0.8, 0))
    wall_y(k, -1.6, 3.4, -3.0, z1, 6, 1.0, 0.7, 0.5, st, top=lambda y: 6 - int(3 * abs(math.cos(y))))
    wall_y(k, -1.6, 3.4, 3.0, z1, 6, 1.0, 0.7, 0.5, dk, top=lambda y: 3 + int(2 * abs(math.sin(y * 0.8))))
    k.block(2.2, 0.75, 0.45, (0.0, -1.6, z1 + 2.2), dk, cuts=2)  # door lintel
    # Altar and offering bowl.
    k.block(1.6, 1.0, 0.9, (0.0, 2.2, z1 + 0.45), dk, cuts=2)
    k.post(0.32, 0.4, 0.22, (0.0, 2.2, z1 + 0.9), mat('Rock_Dark'), sides=12, rings=2, lobes=None)
    # Rubble and greenery.
    for _ in range(26):
        a, rr = k.rnd.uniform(0, TAU), k.rnd.uniform(4.0, 7.6)
        k.block(k.rnd.uniform(0.4, 0.9), k.rnd.uniform(0.35, 0.7), k.rnd.uniform(0.25, 0.45),
                (math.cos(a) * rr, math.sin(a) * rr * 0.9, k.rnd.uniform(-0.1, 0.1)), st,
                rz=k.rnd.uniform(0, TAU), rx=k.rnd.uniform(-0.3, 0.3), chip=0.09)
    for p in ((-4.2, 3.6, z1), (4.0, -4.2, 0.6), (-3.1, -1.6, z1 + 2.4), (2.9, 3.3, z1 + 1.2), (-6.0, 1.0, 0.3)):
        k.leaves(0.7, p)
    k.finish('ruin_temple')


def build_poi_ruin_wall(variant):
    k = Kit(f'poi_ruin_wall_{variant}', 200 + ord(variant))
    st, dk = mat('Rock_Grey'), mat('Rock_Dark')
    if variant == 'a':
        course_wall(k, -3.4, 3.4, 0.0, -0.3, 6, 0.9, 0.6, 0.48, st,
                    top=lambda x: 6 - int(2.6 * abs(math.sin(x * 0.9 + 0.4))), gap=(-0.5, 0.6, 3))
        k.block(1.4, 0.62, 0.4, (0.05, 0.0, -0.3 + 0.48 * 3 - 0.2), dk, cuts=1)
    elif variant == 'b':
        course_wall(k, -3.0, 1.6, 1.2, -0.3, 6, 0.9, 0.6, 0.48, st, top=lambda x: 6 - int(x < -1.2) * 2 - int(x < -2.3))
        wall_y(k, -2.6, 0.9, 1.3, -0.3, 6, 0.9, 0.6, 0.48, dk, top=lambda y: 6 - int(y < -1.0) * 3)
    else:
        course_wall(k, -3.2, 3.2, 0.4, -0.3, 3, 0.9, 0.6, 0.48, st, top=lambda x: 3 - int(abs(x) > 2.2), cuts=2)
        fallen_drum(k, 0.3, 1.3, (1.6, -1.6, -0.1), 0.7, dk)
    for _ in range(26):
        a, rr = k.rnd.uniform(0, TAU), k.rnd.uniform(1.0, 3.6)
        k.block(k.rnd.uniform(0.3, 0.8), k.rnd.uniform(0.3, 0.6), k.rnd.uniform(0.2, 0.4),
                (math.cos(a) * rr, -abs(math.sin(a)) * rr * 0.8 - 0.6, -0.05), st, rz=k.rnd.uniform(0, TAU),
                rx=k.rnd.uniform(-0.3, 0.3), chip=0.09)
    k.leaves(0.55, (k.rnd.uniform(-2, 2), 0.3, 1.2), n=2)
    k.finish('ruin_wall')


def build_poi_ruin_arch():
    k = Kit('poi_ruin_arch', 301)
    st, dk = mat('Rock_Grey'), mat('Rock_Dark')
    span, rise0 = 1.7, 2.4   # half-span of the opening, springing height
    for sx in (-1, 1):
        for c in range(5):
            for j in range(2):
                k.block(0.55, 0.95, 0.47, (sx * (span + 0.3 + 0.03 + j * 0.56), 0.0, -0.3 + 0.48 * (c + 0.5) + 0.0),
                        st if (c + j) % 2 else dk, cuts=2, rz=k.rnd.uniform(-0.02, 0.02))
    R = span + 0.3
    n = 11
    for i in range(n):
        if i in (8, 9):  # two voussoirs dropped out of the right haunch
            continue
        a = math.pi * (i + 0.5) / n
        k.block(0.5, 0.95, 0.42 * R * math.pi / n * 2.2, (math.cos(a) * R, 0.0, rise0 - 0.3 + math.sin(a) * R),
                dk if i == 5 else st, ry=-(a - math.pi / 2), cuts=2)
    k.block(0.5, 0.95, 0.5, (2.2, -1.4, 0.05), st, rx=0.6, rz=0.4, cuts=2)
    k.block(0.5, 0.95, 0.5, (2.6, -0.9, 0.0), st, rx=-0.3, rz=1.2, cuts=2)
    for _ in range(10):
        a, rr = k.rnd.uniform(0, TAU), k.rnd.uniform(1.2, 3.2)
        k.block(k.rnd.uniform(0.25, 0.6), k.rnd.uniform(0.25, 0.5), k.rnd.uniform(0.2, 0.35),
                (math.cos(a) * rr, math.sin(a) * rr * 0.6, -0.05), st, rz=k.rnd.uniform(0, TAU), chip=0.09)
    k.leaves(0.5, (-2.3, 0.2, 2.4), n=2)
    k.finish('ruin_arch')


def plank_floor(k, x0, x1, y0, y1, z, material, along='x', w=0.26, t=0.07, cuts=2):
    if along == 'x':
        n = int((y1 - y0) / w)
        for i in range(n):
            k.block(x1 - x0 + k.rnd.uniform(-0.1, 0.1), w - 0.02, t, ((x0 + x1) / 2, y0 + (i + 0.5) * (y1 - y0) / n, z),
                    material, cuts=cuts, chip=0.02)
    else:
        n = int((x1 - x0) / w)
        for i in range(n):
            k.block(w - 0.02, y1 - y0 + k.rnd.uniform(-0.1, 0.1), t, (x0 + (i + 0.5) * (x1 - x0) / n, (y0 + y1) / 2, z),
                    material, cuts=cuts, chip=0.02)


def rail_run(k, a, b, h, material, posts=True):
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    rz = math.atan2(d.y, d.x)
    if posts:
        n = max(2, int(L / 1.1) + 1)
        for i in range(n):
            p = a + d * (i / (n - 1))
            k.post(0.06, 0.055, h, (p.x, p.y, p.z), mat('Wood_Mid'), sides=6, rings=2, lobes=HEWN6)
    k.post(0.045, 0.045, L, (a.x, a.y, a.z + h), material, sides=6, rings=3, lobes=HEWN6, ry=math.pi / 2, rz=rz)


def build_poi_stilt_outpost():
    k = Kit('poi_stilt_outpost', 401)
    wd, wm, wl = mat('Wood_Dark'), mat('Wood_Mid'), mat('Wood_Light')
    fz = 1.9
    for x in (-2.6, 0.0, 2.6):
        for y in (-2.4, 0.0, 2.2):
            k.post(0.13, 0.11, fz + 0.4, (x, y, -0.5), wd, sides=8, rings=6)
    for y in (-2.4, 0.0, 2.2):
        k.block(5.6, 0.22, 0.22, (0.0, y, fz - 0.15), wm, cuts=2)
    plank_floor(k, -2.9, 2.9, -2.6, 2.4, fz, wl)
    # Hut walls (vertical planks) 3.8 x 3.0, door on the front (-Y).
    hx, y0, y1, wh = 1.9, -0.9, 2.1, 2.2
    def vplanks(xa, xb, y, door=None):
        n = int((xb - xa) / 0.25)
        for i in range(n):
            x = xa + (i + 0.5) * (xb - xa) / n
            if door and door[0] < x < door[1]:
                continue
            k.block(0.23, 0.06, wh + k.rnd.uniform(-0.05, 0.05), (x, y, fz + wh / 2), wm if i % 3 else wd, cuts=2, chip=0.02)
    vplanks(-hx, hx, y0, door=(-0.5, 0.5))
    vplanks(-hx, hx, y1)
    for sx in (-1, 1):
        n = int((y1 - y0) / 0.25)
        for i in range(n):
            k.block(0.06, 0.23, wh, (sx * hx, y0 + (i + 0.5) * (y1 - y0) / n, fz + wh / 2), wm if i % 4 else wd, cuts=2, chip=0.02)
    # Thatch hip roof: three shaggy layers, 4-sided lofts with a lobed eave.
    for layer in range(3):
        rings_ = []
        for i in range(7):
            t = i / 6
            r = (3.4 - layer * 0.12) * (1 - t) + 0.12
            lob = [1.0, 0.96, 1.02, 0.97, 1.0, 0.95] if i == 0 else None
            rings_.append(ring((0, 0.6, fz + wh - 0.1 + layer * 0.08 + 1.7 * t), r, 24, math.pi / 4, lob))
        o = loft('thatch', rings_, mat('Leaf_Dry'), k.coll, cap0=False)
        o.scale = (0.78, 0.72, 1.0)
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.transform_apply(scale=True)
        o.select_set(False)
        k.parts.append(o)
    # Porch rail, front ladder down to the sand.
    rail_run(k, (-2.8, -2.55, fz), (-0.6, -2.55, fz), 0.95, wl)
    rail_run(k, (0.6, -2.55, fz), (2.8, -2.55, fz), 0.95, wl)
    for sx in (-1, 1):
        k.post(0.05, 0.05, 2.5, (sx * 0.32, -2.75, -0.3), wm, sides=6, rings=3, lobes=HEWN6, rx=-0.32)
    for i in range(6):
        k.block(0.7, 0.07, 0.06, (0.0, -2.75 - (i * 0.34 + 0.3) * math.sin(0.32), -0.3 + (i * 0.34 + 0.3) * math.cos(0.32)), wl, cuts=1)
    for p in ((1.8, -1.6, fz + 0.3), (-2.2, 1.5, fz + 0.3)):
        k.block(0.6, 0.6, 0.6, p, wm, cuts=2)
    k.finish('stilt_outpost')


def skeleton(k, at, rz):
    b = mat('Wood_Bleached')
    x, y, z = at
    c, s = math.cos(rz), math.sin(rz)
    def P(dx, dy, dz=0.0):
        return (x + dx * c - dy * s, y + dx * s + dy * c, z + dz)
    k.rock(0.12, P(0.0, 0.75, 0.1), b, sub=3, squash=0.9)                     # skull
    k.post(0.03, 0.03, 0.55, P(0.0, 0.62, 0.06), b, sides=6, rings=4, lobes=None, rx=math.pi / 2, rz=rz)  # spine
    for i in range(5):                                                        # ribs
        for sx in (-1, 1):
            k.post(0.015, 0.012, 0.22, P(sx * 0.02, 0.5 - i * 0.07, 0.08), b, sides=5, rings=2, lobes=None,
                   ry=sx * 1.25, rz=rz)
    for sx in (-1, 1):                                                        # limbs
        k.post(0.025, 0.02, 0.48, P(sx * 0.12, -0.05, 0.04), b, sides=6, rings=3, lobes=None, rx=math.pi / 2 + 0.1, rz=rz + sx * 0.15)
        k.post(0.022, 0.018, 0.42, P(sx * 0.3, 0.45, 0.04), b, sides=6, rings=3, lobes=None, ry=sx * 1.4, rz=rz)


def build_poi_skeleton_camp():
    k = Kit('poi_skeleton_camp', 501)
    cv, wd, wm = mat('Canvas_Dirty'), mat('Wood_Dark'), mat('Wood_Mid')
    # A-frame tent at the back, opening to the front.
    ridge = 1.7
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=28, y_segments=28, size=1.0)
        for v in bm.verts:
            u, w = (v.co.x + 1) / 2, (v.co.y + 1) / 2
            sag = 0.08 * math.sin(math.pi * u) * math.sin(math.pi * w)
            v.co = Vector((sx * (1.35 * (1 - u)) - sx * sag, 1.4 + (w - 0.5) * 2.8, ridge * u - 0.02))
        k.parts.append(obj_from_bmesh('tent', bm, k.coll, material=cv, smooth=True))
    k.post(0.04, 0.04, 3.0, (0.0, -0.1, ridge), wd, sides=6, rings=3, lobes=HEWN6, rx=-math.pi / 2)
    for y in (0.0, 2.8):
        k.post(0.045, 0.04, ridge + 0.1, (0.0, y, -0.1), wd, sides=6, rings=3, lobes=HEWN6)
    # Fire ring with charred logs, a spit.
    fx, fy = 0.0, -2.4
    for i in range(11):
        a = TAU * i / 11
        k.rock(0.17, (fx + math.cos(a) * 0.7, fy + math.sin(a) * 0.7, 0.05), mat('Rock_Grey'), sub=3)
    for i in range(4):
        k.post(0.07, 0.06, 0.9, (fx - 0.35 * math.cos(i * 1.6), fy - 0.35 * math.sin(i * 1.6), 0.08), mat('Char_Black'),
               sides=7, rings=3, ry=math.pi / 2 - 0.2, rz=i * 1.6)
    for sx in (-1, 1):
        k.post(0.035, 0.03, 1.0, (fx + sx * 0.85, fy, -0.1), wd, sides=6, rings=2, lobes=HEWN6)
    k.post(0.025, 0.025, 1.9, (fx - 0.95, fy, 0.85), mat('Metal_Iron'), sides=6, rings=2, lobes=None, ry=math.pi / 2)
    # Log seats, bedrolls, crates, barrel.
    for p, rz in (((-2.2, -2.3, 0.0), 1.4), ((2.1, -2.7, 0.0), 1.8)):
        k.post(0.2, 0.19, 1.6, (p[0], p[1], 0.18), wm, sides=14, rings=10, ry=math.pi / 2, rz=rz - math.pi / 2)
    for sx in (-1, 1):
        k.post(0.17, 0.17, 1.6, (sx * 0.6, 0.6, 0.12), mat('Canvas'), sides=10, rings=5, lobes=None, rx=math.pi / 2)
    for p in ((3.4, 1.4, 0.3), (3.3, 2.1, 0.3), (3.35, 1.75, 0.9)):
        k.block(0.6, 0.6, 0.6, p, wm, cuts=5, chip=0.02, rz=k.rnd.uniform(-0.2, 0.2))
    k.post(0.32, 0.28, 0.9, (-3.2, 1.6, -0.05), mat('Wood_Mid'), sides=20, rings=10, lobes=None)
    for _ in range(8):  # scattered stones
        a, rr = k.rnd.uniform(0, TAU), k.rnd.uniform(3.0, 4.6)
        k.rock(k.rnd.uniform(0.15, 0.35), (math.cos(a) * rr, math.sin(a) * rr, 0.0), mat('Rock_Grey'), sub=3)
    # Lean-to tarp on three poles beside the tent.
    for p in ((-2.9, -0.4), (-2.9, 1.2), (-1.9, 0.4)):
        k.post(0.04, 0.035, 1.5, (p[0], p[1], -0.1), wd, sides=6, rings=2, lobes=HEWN6)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=16, y_segments=16, size=1.0)
    for v in bm.verts:
        u, w = (v.co.x + 1) / 2, (v.co.y + 1) / 2
        v.co = Vector((-2.95 + 1.1 * u, -0.5 + 1.8 * w, 1.42 - 0.35 * u - 0.1 * math.sin(math.pi * w) * math.sin(math.pi * u)))
    k.parts.append(obj_from_bmesh('tarp', bm, k.coll, material=mat('Canvas'), smooth=True))
    # Two skeletons: one slumped by the fire, one by the tent mouth. A tattered flag on a pole.
    skeleton(k, (-1.4, -3.6, 0.0), 0.8)
    skeleton(k, (1.7, -0.5, 0.0), -2.3)
    k.post(0.05, 0.04, 4.2, (-3.6, -1.2, -0.3), wd, sides=6, rings=4, lobes=HEWN6)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=12, size=0.5)
    for v in bm.verts:
        u = (v.co.x + 0.5)
        v.co = Vector((-3.6 + u * 1.1, -1.2 + 0.08 * math.sin(u * 7), 3.4 + v.co.y * 1.2 - 0.1 * u))
    k.parts.append(obj_from_bmesh('flag', bm, k.coll, material=mat('Char_Black'), smooth=True))
    k.finish('skeleton_camp')


def build_poi_overlook_platform():
    k = Kit('poi_overlook_platform', 601)
    wd, wm, wl = mat('Wood_Dark'), mat('Wood_Mid'), mat('Wood_Light')
    dz, hw = 2.6, 1.6
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.post(0.14, 0.12, dz + 2.3, (sx * hw, sy * hw, -0.4), wd, sides=10, rings=9)
    for sx in (-1, 1):  # X braces on the sides and back
        for sgn in (-1, 1):
            k.post(0.05, 0.05, 3.4, (sx * hw, sgn * hw, 0.1), wm, sides=6, rings=3, lobes=HEWN6, rx=sgn * -0.83)
    for sgn in (-1, 1):
        k.post(0.05, 0.05, 3.4, (sgn * hw, hw, 0.1), wm, sides=6, rings=3, lobes=HEWN6, ry=sgn * 0.83)
    for y in (-hw, hw):
        k.block(2 * hw + 0.3, 0.2, 0.22, (0.0, y, dz - 0.15), wm, cuts=1)
    plank_floor(k, -hw - 0.15, hw + 0.15, -hw - 0.15, hw + 0.15, dz, wl, cuts=3)
    rail_run(k, (-hw, hw, dz), (hw, hw, dz), 1.0, wl, posts=False)
    rail_run(k, (-hw, -hw, dz), (-hw, hw, dz), 1.0, wl, posts=False)
    rail_run(k, (hw, -hw, dz), (hw, hw, dz), 1.0, wl, posts=False)
    rail_run(k, (-hw, -hw, dz), (-0.5, -hw, dz), 1.0, wl, posts=False)
    # Front stair: stringers + treads from the deck to the ground.
    run, n = 3.0, 9
    ang = math.atan2(dz, run - 0.4)
    for sx in (-0.45, 0.45):
        k.block(0.06, math.hypot(dz, run - 0.4) + 0.2, 0.22, (sx + 0.0, -hw - (run - 0.4) / 2, dz / 2 - 0.1), wd, rx=-ang, cuts=1)
    for i in range(n):
        t = (i + 0.5) / n
        k.block(1.0, 0.28, 0.05, (0.0, -hw - (run - 0.4) * (1 - t), dz * t), wl, cuts=3)
    for layer in range(2):  # thatch canopy over the deck, inside the footprint
        o = loft('canopy', [ring((0, 0, dz + 2.0 + layer * 0.07 + 0.9 * t), 2.3 * (1 - t) + 0.08, 24, math.pi / 4,
                                 [1.0, 0.96, 1.02, 0.97] if t == 0 else None) for t in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)],
                 mat('Leaf_Dry'), k.coll, cap0=False)
        k.parts.append(o)
    k.finish('overlook_platform')


def build_poi_small_lighthouse():
    k = Kit('poi_small_lighthouse', 701)
    st, dk, pw = mat('Rock_Grey'), mat('Rock_Dark'), mat('Paint_White')
    # Plinth ring of big blocks.
    for i in range(14):
        a = TAU * i / 14
        k.block(1.0, 0.8, 0.6, (math.cos(a) * 2.35, math.sin(a) * 2.35, -0.1), dk, rz=a + math.pi / 2, cuts=2)
    # Coursed tower: 15 courses of 14 blocks, radius 2.0 -> 1.45, alternate courses limewashed.
    courses, H = 15, 7.5
    for c in range(courses):
        t = c / courses
        r = 2.0 - 0.55 * t
        n = 12
        for i in range(n):
            a = TAU * (i + 0.5 * (c % 2)) / n
            if c < 4 and abs(math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))) < 0.3:
                continue  # door, front (-Y)
            if c in (8, 9) and abs(math.atan2(math.sin(a - math.pi / 2), math.cos(a - math.pi / 2))) < 0.25:
                continue  # sea-side window, back (+Y)
            k.block(TAU * r / n + 0.02, 0.42, H / courses - 0.02, (math.cos(a) * (r - 0.21), math.sin(a) * (r - 0.21), 0.2 + H * (c + 0.5) / courses),
                    pw if (c // 3) % 2 else st, rz=a + math.pi / 2, cuts=2)
    k.post(1.7, 1.25, H, (0, 0, 0.2), dk, sides=14, rings=2, lobes=None, cap1=False)  # inner core (no see-through)
    k.block(1.2, 0.5, 0.35, (0.0, -1.9, 2.15), dk, cuts=2)  # door lintel
    # Gallery deck, rail, lantern room (8 emissive panes + mullions), roof cone and finial.
    gz = 0.2 + H
    k.post(2.1, 2.1, 0.22, (0, 0, gz), dk, sides=24, rings=1, lobes=None)
    for i in range(16):
        a = TAU * i / 16
        k.post(0.035, 0.035, 0.9, (math.cos(a) * 1.95, math.sin(a) * 1.95, gz + 0.22), mat('Metal_Iron'), sides=6, rings=1, lobes=None)
    k.parts.append(loft('railring', [ring((0, 0, gz + 1.1 + dz), 1.95 + dr, 24) for dz, dr in ((-0.03, 0), (0.03, 0))],
                        mat('Metal_Iron'), k.coll))
    lz = gz + 0.22
    k.post(1.0, 1.0, 0.35, (0, 0, lz), dk, sides=16, rings=1, lobes=None)
    k.post(0.9, 0.9, 1.4, (0, 0, lz + 0.35), mat('Lantern_Glass'), sides=8, rings=4, lobes=None)
    k.rock(0.3, (0, 0, lz + 1.05), mat('Lantern_Glass'), sub=2, squash=1.0)
    for i in range(8):
        a = TAU * (i + 0.5) / 8
        k.post(0.05, 0.05, 1.4, (math.cos(a) * 0.93, math.sin(a) * 0.93, lz + 0.35), mat('Metal_Band'), sides=6, rings=1, lobes=None)
    k.parts.append(loft('roof', [ring((0, 0, lz + 1.75 + 1.1 * t), 1.25 * (1 - t) + 0.05, 24, 0.0, [1.0, 0.97])
                                 for t in (0.0, 0.25, 0.5, 0.75, 1.0)], mat('Metal_Band'), k.coll))
    k.rock(0.14, (0, 0, lz + 2.95), mat('Metal_Band'), sub=2, squash=1.0)
    k.finish('small_lighthouse')


def build_poi_jungle_shrine():
    k = Kit('poi_jungle_shrine', 801)
    st, dk = mat('Rock_Grey'), mat('Rock_Dark')
    for i, (w, h) in enumerate(((4.6, 0.5), (3.6, 0.45), (2.6, 0.4))):
        z0 = -0.35 + sum(hh for _, hh in ((4.6, 0.5), (3.6, 0.45), (2.6, 0.4))[:i])
        n = 3 + (2 - i)
        for a in range(n):
            for b in range(n):
                k.block(w / n - 0.04, w / n - 0.04, h, (-w / 2 + (a + 0.5) * w / n, -w / 2 + (b + 0.5) * w / n + 0.3, z0 + h / 2),
                        st if (a + b) % 2 else dk, cuts=2)
    top = -0.35 + 1.35
    # Stele with a carved face toward the front (-Y): brow, eyes, nose, mouth in relief.
    k.block(1.1, 0.6, 2.4, (0.0, 0.8, top + 1.2), dk, cuts=4, chip=0.02)
    k.block(0.9, 0.12, 0.16, (0.0, 0.46, top + 1.85), st, cuts=2)
    for sx in (-1, 1):
        k.block(0.24, 0.1, 0.16, (sx * 0.24, 0.47, top + 1.62), mat('Gold'), cuts=1)
    k.block(0.2, 0.18, 0.5, (0.0, 0.43, top + 1.35), st, cuts=2)
    k.block(0.6, 0.1, 0.14, (0.0, 0.47, top + 0.95), st, cuts=2)
    k.block(1.3, 0.75, 0.28, (0.0, 0.8, top + 2.5), st, cuts=2)
    # Braziers flanking the stair, offering bowl with coins.
    for sx in (-1, 1):
        k.post(0.12, 0.14, 0.8, (sx * 1.0, -0.7, top), dk, sides=10, rings=3, lobes=None)
        k.parts.append(loft('bowl', [ring((sx * 1.0, -0.7, top + 0.8 + dz), r, 14) for dz, r in ((0.0, 0.16), (0.12, 0.34), (0.24, 0.38))],
                            mat('Metal_Band'), k.coll, cap1=False))
        k.rock(0.22, (sx * 1.0, -0.7, top + 0.98), mat('Lantern_Glass'), sub=1, squash=0.5)
    k.parts.append(loft('offer', [ring((0, -0.1, top + dz), r, 16) for dz, r in ((0.0, 0.2), (0.14, 0.32), (0.2, 0.34))], dk, k.coll))
    for i in range(7):
        a = TAU * i / 7
        k.post(0.045, 0.045, 0.02, (0.12 * math.cos(a), -0.1 + 0.12 * math.sin(a), top + 0.15 + 0.012 * i), mat('Gold'), sides=10, rings=1, lobes=None)
    for s in range(4):  # front stair
        k.block(1.2, 0.35, 0.3, (0.0, -2.25 + 0.35 * s, -0.2 + 0.3 * s), dk, cuts=2)
    for p in ((-1.8, 1.8, 0.5), (1.7, 1.6, 0.9), (-0.6, 1.2, top + 2.7), (1.9, -1.4, 0.2)):
        k.leaves(0.55, p)
    k.finish('jungle_shrine')


def build_poi_grotto_landing():
    k = Kit('poi_grotto_landing', 901)
    wd, wm, wl = mat('Wood_Dark'), mat('Wood_Mid'), mat('Wood_Light')
    # Jetty runs from the land (+Y, back) out over the water (-Y = game +Z, the sea).
    dz = 0.6
    for y in (-4.6, -2.6, -0.6, 1.4):
        for sx in (-1, 1):
            k.post(0.14, 0.12, 2.6, (sx * 1.1, y, -2.0), wd, sides=8, rings=6)
        k.block(2.6, 0.2, 0.2, (0.0, y, dz - 0.15), wm, cuts=2)
    plank_floor(k, -1.25, 1.25, -5.0, 2.6, dz, wl, along='y', cuts=3)
    for p in ((-1.1, -4.6), (1.1, -4.6)):
        k.post(0.18, 0.15, 0.55, (p[0], p[1], dz), wd, sides=10, rings=3)
        k.parts.append(loft('coil', [ring((p[0], p[1], dz + 0.25 + 0.05 * i), 0.22, 10, 0.3 * i, LAID) for i in range(4)],
                            mat('Rope'), k.coll, cap0=False, cap1=False))
    k.post(0.07, 0.06, 2.2, (0.95, 1.0, dz), wd, sides=6, rings=3, lobes=HEWN6)
    k.post(0.03, 0.03, 0.4, (0.95, 1.0, dz + 2.2), mat('Metal_Iron'), sides=6, rings=1, lobes=None, ry=math.pi / 2 - 0.1, rz=math.pi)
    k.post(0.12, 0.12, 0.3, (0.6, 1.0, dz + 1.95), mat('Lantern_Glass'), sides=8, rings=2, lobes=None)
    for p in ((-0.7, 1.8, dz + 0.3), (-0.6, 1.1, dz + 0.3), (-0.65, 1.45, dz + 0.9)):
        k.block(0.6, 0.6, 0.6, p, wm, cuts=3, chip=0.02, rz=k.rnd.uniform(-0.2, 0.2))
    k.post(0.3, 0.27, 0.85, (0.5, -1.0, dz), wm, sides=16, rings=6, lobes=None)
    for _ in range(9):
        a, rr = k.rnd.uniform(0, TAU), k.rnd.uniform(2.0, 4.6)
        k.rock(k.rnd.uniform(0.3, 0.6), (math.cos(a) * rr * 0.6, 2.2 + math.sin(a) * 1.4, -0.1), mat('Rock_Sea'), sub=2)
    k.finish('grotto_landing')


clear_default_scene()
BUILDERS = [('climb_kit', build_climb_kit), ('poi_ruin_temple', build_poi_ruin_temple),
            ('poi_ruin_wall_a', lambda: build_poi_ruin_wall('a')), ('poi_ruin_wall_b', lambda: build_poi_ruin_wall('b')),
            ('poi_ruin_wall_c', lambda: build_poi_ruin_wall('c')), ('poi_ruin_arch', build_poi_ruin_arch),
            ('poi_stilt_outpost', build_poi_stilt_outpost), ('poi_skeleton_camp', build_poi_skeleton_camp),
            ('poi_overlook_platform', build_poi_overlook_platform), ('poi_small_lighthouse', build_poi_small_lighthouse),
            ('poi_jungle_shrine', build_poi_jungle_shrine), ('poi_grotto_landing', build_poi_grotto_landing)]
for key, fn in BUILDERS:
    if not ONLY or key in ONLY:
        fn()
