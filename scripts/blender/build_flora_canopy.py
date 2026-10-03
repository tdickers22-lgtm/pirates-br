# Canopy flora kit (b4.7d, islands-09; PLAN section 6 row 20).
# The jungle was one layer: five palm GLBs over a lawn of bushes, and the banana "tree" was a 6-sided
# cylinder with flat planes (DecorScatter). This kit gives the islands a real three-layer jungle:
#   CANOPY (8-14 m):    tree_broadleaf_a / _b (9-12k), tree_buttress (ceiba with plank roots, 12-16k)
#   SHORE:              tree_mangrove (arching prop roots into the tide line, 6.5-9.5k)
#   SNAGS:              tree_dead_a / _b (bare, bleached; highland/volcanic/bone)
#   UNDERSTORY (1-3 m): banana_plant (pseudostem + paddle leaves with midribs), fern_giant
#   GROUND:             tall_grass (curved blade clump)
# Every leaf is a real cupped blade with a raised midvein and droop (no alpha cards), every branch a
# tapered chain off its parent, so the silhouettes hold at LOD0 and decimate cleanly in build_lods.py.
# Material names are a client API (PropScatterer sway/tint reads Leaf_*): do not rename.
# Origin = trunk base on the ground, +Z up in Blender (+Y in the GLB). Seeds are crc32(name): the
# build is deterministic.
# Outputs (public/assets/models/): tree_broadleaf_a.glb, tree_broadleaf_b.glb, tree_buttress.glb, tree_mangrove.glb, tree_dead_a.glb,
#   tree_dead_b.glb, banana_plant.glb, fern_giant.glb, tall_grass.glb
#   (+ scripts/blender/lod_proxies/<key>_<LOD1|LOD2|far>.glb for build_lods.py).
# Headless: /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_flora_canopy.py
# BR_CANOPY_ONLY=tree_broadleaf_a,tall_grass builds a subset; CANOPY_RENDER_DIR=<dir> writes review renders.
import bpy
import bmesh
import math
import random
import zlib
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_nature.py')).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)
RENDER_DIR = os.environ.get('CANOPY_RENDER_DIR', '')
ONLY = [s for s in os.environ.get('BR_CANOPY_ONLY', '').split(',') if s]
clear_default_scene()

EXTRA = {
    "Leaf_A": ((0.09, 0.28, 0.105, 1.0), 0.82, 0.0),
    "Leaf_B": ((0.16, 0.39, 0.13, 1.0), 0.8, 0.0),
    "Leaf_C": ((0.23, 0.33, 0.10, 1.0), 0.84, 0.0),
    "Bark_Broad": ((0.27, 0.22, 0.17, 1.0), 0.9, 0.0),
    "Bark_Pale": ((0.47, 0.43, 0.36, 1.0), 0.9, 0.0),
    "Banana_Leaf": ((0.20, 0.45, 0.12, 1.0), 0.7, 0.0),
    "Grass_Tall": ((0.36, 0.45, 0.16, 1.0), 0.85, 0.0),
    "Stem": ((0.34, 0.24, 0.13, 1.0), 0.9, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

# (lo, hi) triangle bands per asset (PLAN section 6 row 20; test-asset-tiers 'canopy-*' rows).
BAND = {
    'tree_broadleaf_a': (9000, 12000), 'tree_broadleaf_b': (9000, 12000),
    'tree_buttress': (12000, 16000), 'tree_mangrove': (6500, 9500),
    'tree_dead_a': (1500, 5000), 'tree_dead_b': (1500, 5000),
    'banana_plant': (1800, 4500), 'fern_giant': (3000, 6000), 'tall_grass': (1000, 3000),
}
UP = Vector((0, 0, 1))


def rng_of(name):
    return random.Random(zlib.crc32(name.encode()) & 0xffffffff)


def frame(d):
    d = d.normalized()
    s = d.cross(UP)
    if s.length < 1e-4:
        s = Vector((1, 0, 0))
    s.normalize()
    return d, s, s.cross(d).normalized()


def add_blade(bm, base, d, length, width, droop, cup=0.25, n=4, curl=0.0):
    """Cupped leaf blade: centre (midvein, raised) + two margin rows, pointed tip. 2(2n-1) tris."""
    d, s, u = frame(d)
    cs, ls, rs = [], [], []
    for i in range(n + 1):
        t = i / n
        sag = Vector((0, 0, -droop * t * t))
        c = base + d * (length * t) + sag + u * (0.02 * length * math.sin(math.pi * t))
        cs.append(bm.verts.new(c))
        if 0 < i < n:
            w = width * math.sin(math.pi * min(1.0, t * 1.15)) * (1 - curl * t)
            lift = u * (-cup * w)
            ls.append(bm.verts.new(c + s * w + lift))
            rs.append(bm.verts.new(c - s * w + lift))
    for side in (ls, rs):
        rows = [cs[0]] + side + [cs[n]]
        for i in range(n):
            a, b = cs[i], cs[i + 1]
            sa, sb = rows[i], rows[i + 1]
            if sb is not b:
                bm.faces.new((a, b, sb) if side is ls else (a, sb, b))
            if sa is not a and sa is not sb:
                bm.faces.new((a, sb, sa) if side is ls else (a, sa, sb))


def rot_about(v, axis, ang):
    return Matrix.Rotation(ang, 3, axis.normalized()) @ v


class Tree:
    """Recursive tapered branching. Branch meshes per material; leaves into one bmesh per material."""

    def __init__(self, name, coll, rng, bark):
        self.name, self.coll, self.rng, self.bark = name, coll, rng, bark
        self.leaf_bms = {}
        self.parts = []
        self.n = 0

    def leaf_bm(self, m):
        if m not in self.leaf_bms:
            self.leaf_bms[m] = bmesh.new()
        return self.leaf_bms[m]

    def limb(self, p, d, length, r0, r1, segs=7, bend=0.12, pts_n=4):
        rng = self.rng
        pts = [Vector(p)]
        dd = Vector(d).normalized()
        step = length / pts_n
        for i in range(pts_n):
            jitter = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.3, 0.6))) * bend
            dd = (dd + jitter).normalized()
            pts.append(pts[-1] + dd * step)
        self.n += 1
        self.parts += chain_pts(self.coll, f"{self.name}_l{self.n}", pts, r0, r1, mat(self.bark), segs=segs,
                                balls=False)
        return pts

    def cluster(self, tip, out, count, length, width, mats, spread=1.1, droop=0.25):
        rng = self.rng
        for _ in range(count):
            axis = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
            if axis.length < 1e-3:
                axis = Vector((1, 0, 0))
            d = rot_about(Vector(out), axis, rng.uniform(0, spread))
            d.z = max(d.z, -0.35)
            L = length * rng.uniform(0.75, 1.2)
            base = tip + d.normalized() * rng.uniform(0.0, 0.25)
            add_blade(self.leaf_bm(rng.choice(mats)), base, d, L, width * rng.uniform(0.8, 1.15),
                      droop * L, cup=0.3)

    def branch(self, p, d, length, r, depth, leaves):
        pts = self.limb(p, d, length, r, r * 0.55, segs=max(4, 8 - 2 * (3 - depth)))
        if depth == 0:
            leaves(pts[-1], (pts[-1] - pts[-2]).normalized())
            return
        rng = self.rng
        kids = rng.randint(2, 3)
        dirv = (pts[-1] - pts[-2]).normalized()
        for k in range(kids):
            at = pts[rng.randint(len(pts) // 2, len(pts) - 1)]
            ang = (k / kids) * math.tau + rng.uniform(-0.5, 0.5)
            side = Vector((math.cos(ang), math.sin(ang), 0))
            nd = (dirv * 0.6 + side * rng.uniform(0.55, 0.95) + UP * rng.uniform(0.1, 0.45)).normalized()
            self.branch(at, nd, length * rng.uniform(0.55, 0.72), r * 0.55, depth - 1, leaves)

    def finish(self):
        for m, bm in self.leaf_bms.items():
            self.parts.append(obj_from_bmesh(f"{self.name}_leaf_{m}", bm, self.coll, mat(m), smooth=True))
        return self.parts


def finish_canopy(coll, name):
    lo, hi = BAND[name]
    info = finish_nature(coll, name, budget=hi, floor=lo)
    print('CANOPY_TRIS', name, info['tris'])
    write_canopy_proxies(coll, name)


# LOD PROXIES (b4.7d-rest). build_lods.py cannot reach the canopy ceilings by Collapse: every open
# leaf blade is a boundary loop its surface contract keeps (tree_broadleaf_a LOD1 stuck at 59%).
# So this build writes the chain itself to lod_proxies/<key>_<LOD1|LOD2|far>.glb, which build_lods.py
# prefers (graded as a proxy, extras.lod_reuse):
#   trees (broadleaf, buttress, mangrove): leaf blades k-means-clustered into closed jittered
#     ellipsoid blobs (80 tris near, 20 far), one per cluster, on the cluster's dominant leaf material;
#   understory + grass: a deterministic subset of whole blades (slightly enlarged) near, blobs far;
#   wood: the largest bark/stem parts (smallest twigs dropped further out), Collapse-decimated.
# Vertex colour (AO + tint) is copied from the nearest LOD0 vertex so a swap never pops brighter.
PROXY_DIR = os.path.join(HERE, 'lod_proxies')
# (LOD1, LOD2, far) ceilings: the test-asset-tiers canopy-* CHAIN rows. Aim 0.88 of each.
PROXY_RATIOS = {
    'tree_broadleaf_a': (0.23, 0.08, 0.025), 'tree_broadleaf_b': (0.23, 0.08, 0.025),
    'tree_buttress': (0.18, 0.06, 0.02), 'tree_mangrove': (0.3, 0.1, 0.03),
    'tree_dead_a': (0.4, 0.15, 0.05), 'tree_dead_b': (0.4, 0.15, 0.05),
    'banana_plant': (0.4, 0.12, 0.04), 'fern_giant': (0.4, 0.12, 0.04), 'tall_grass': (0.4, 0.12, 0.04),
}
BLOB_KEYS = ('tree_broadleaf_a', 'tree_broadleaf_b', 'tree_buttress', 'tree_mangrove')
LEAF_MATS = ('Leaf_A', 'Leaf_B', 'Leaf_C', 'Banana_Leaf', 'Grass_Tall')
WOOD_KEEP = {'LOD1': 1.0, 'LOD2': 0.92, 'far': 0.8}     # cumulative wood area kept, largest parts first


def _components(bm, faces):
    """Connected face sets (by shared edge) among `faces`."""
    pool = set(faces)
    out = []
    while pool:
        seed = pool.pop()
        comp, stack = [seed], [seed]
        while stack:
            f = stack.pop()
            for e in f.edges:
                for g in e.link_faces:
                    if g in pool:
                        pool.discard(g)
                        comp.append(g)
                        stack.append(g)
        out.append(comp)
    return out


def _tris(faces):
    return sum(len(f.verts) - 2 for f in faces)


def _kmeans(pts, wts, k, iters=8):
    """Deterministic weighted k-means (farthest-point init) -> list of member index lists."""
    cents = [pts[max(range(len(pts)), key=lambda i: wts[i])]]
    while len(cents) < k:
        cents.append(pts[max(range(len(pts)), key=lambda i: min((pts[i] - c).length for c in cents))])
    for _ in range(iters):
        groups = [[] for _ in cents]
        for i, p in enumerate(pts):
            groups[min(range(len(cents)), key=lambda j: (p - cents[j]).length)].append(i)
        cents = [sum((pts[i] * wts[i] for i in g), Vector()) / max(1e-9, sum(wts[i] for i in g)) if g else c
                 for g, c in zip(groups, cents)]
    return [g for g in groups if g]


def write_canopy_proxies(coll, name):
    from mathutils.kdtree import KDTree
    src = [o for o in coll.objects if o.type == 'MESH'][0]
    me0 = src.data
    bm0 = bmesh.new()
    bm0.from_mesh(me0)
    bm0.transform(src.matrix_world)
    n0 = _tris(bm0.faces)
    names = [m.name if m else '' for m in me0.materials]
    leafset = {i for i, m in enumerate(names) if m.split('.')[0] in LEAF_MATS}
    leaf_comps = _components(bm0, [f for f in bm0.faces if f.material_index in leafset])
    wood_comps = _components(bm0, [f for f in bm0.faces if f.material_index not in leafset])
    wood_comps.sort(key=lambda c: -sum(f.calc_area() for f in c))
    wood_area = sum(f.calc_area() for c in wood_comps for f in c) or 1.0
    col0 = me0.color_attributes.get('Col')
    kd = KDTree(len(bm0.verts))
    for v in bm0.verts:
        kd.insert(v.co, v.index)
    kd.balance()
    src_cols = [tuple(col0.data[i].color) for i in range(len(bm0.verts))] if col0 and col0.domain == 'POINT' else None
    rng = rng_of(name + '_proxy')
    os.makedirs(PROXY_DIR, exist_ok=True)
    for label, ceil in zip(('LOD1', 'LOD2', 'far'), PROXY_RATIOS[name]):
        for attempt in range(8):
            target = int(n0 * ceil * 0.88 * 0.85 ** attempt)
            bm = bmesh.new()
            # Wood: largest parts to the kept area share, copied in, decimated below.
            acc, wood = 0.0, []
            for c in wood_comps:
                if wood and acc / wood_area >= WOOD_KEEP[label] * 0.8 ** attempt:
                    break
                wood.append(c)
                acc += sum(f.calc_area() for f in c)
            wood_t = _tris([f for c in wood for f in c])
            wood_goal = wood_t if not leaf_comps else min(wood_t, max(24, int(target * 0.4)))
            if not leaf_comps:
                wood_goal = min(wood_t, target)
            vmap = {}

            def copy_faces(faces, scale_about=None, s=1.0):
                for f in faces:
                    vs = []
                    for v in f.verts:
                        key = (v.index, id(faces))
                        if key not in vmap:
                            co = v.co if scale_about is None else scale_about + (v.co - scale_about) * s
                            vmap[key] = bm.verts.new(co)
                        vs.append(vmap[key])
                    try:
                        nf = bm.faces.new(vs)
                        nf.material_index = f.material_index
                        nf.smooth = True
                    except ValueError:
                        pass

            wood_faces = [f for c in wood for f in c]
            copy_faces(wood_faces)
            bm.faces.ensure_lookup_table()
            nwood = len(bm.faces)
            leaf_goal = max(0, target - wood_goal)
            leaf_t = _tris([f for c in leaf_comps for f in c])
            if leaf_comps and (name not in BLOB_KEYS) and label != 'far':
                # Whole-blade subset, enlarged about each blade's foot so the clump keeps its mass.
                keep = max(1, min(len(leaf_comps), int(len(leaf_comps) * leaf_goal / max(1, leaf_t))))
                order = sorted(range(len(leaf_comps)), key=lambda i: rng.random())[:keep]
                s = min(1.3, (len(leaf_comps) / keep) ** 0.2)
                for i in order:
                    c = leaf_comps[i]
                    foot = min((v.co for f in c for v in f.verts), key=lambda co: co.z)
                    copy_faces(c, foot.copy(), s)
            elif leaf_comps:
                sub = 1 if leaf_goal >= 80 * 6 else 0
                per = 80 if sub else 20
                k = max(1, min(len(leaf_comps), leaf_goal // per))
                pts = [sum((f.calc_center_median() for f in c), Vector()) / len(c) for c in leaf_comps]
                wts = [sum(f.calc_area() for f in c) for c in leaf_comps]
                for g in _kmeans(pts, wts, k):
                    vs = [v.co for i in g for f in leaf_comps[i] for v in f.verts]
                    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
                    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
                    ctr, half = (lo + hi) / 2, (hi - lo) / 2
                    mats = {}
                    for i in g:
                        m = leaf_comps[i][0].material_index
                        mats[m] = mats.get(m, 0) + wts[i]
                    mi = max(mats, key=mats.get)
                    res = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
                    for v in res['verts']:
                        j = 1.0 + rng.uniform(-0.12, 0.12)
                        v.co = ctr + Vector((v.co.x * max(0.12, half.x * 0.85), v.co.y * max(0.12, half.y * 0.85),
                                             v.co.z * max(0.1, half.z * 0.8))) * j
                    for f in {f for v in res['verts'] for f in v.link_faces}:
                        f.material_index = mi
                        f.smooth = True
            o_me = bpy.data.meshes.new(f'{name}_{label}')
            bm.to_mesh(o_me)
            bm.free()
            for m in me0.materials:
                o_me.materials.append(m)
            lcoll = asset_collection(f'{name}_{label}')
            o = bpy.data.objects.new(f'{name}_{label}', o_me)
            lcoll.objects.link(o)
            if wood_goal < wood_t and nwood:
                # Collapse only the wood: the leaf faces sit in a vertex group the modifier leaves alone.
                vg = o.vertex_groups.new(name='wood')
                vg.add([v for p in o_me.polygons[:nwood] for v in p.vertices], 1.0, 'REPLACE')
                dc = o.modifiers.new('dc', 'DECIMATE')
                dc.decimate_type = 'COLLAPSE'
                # Collapse's ratio counts the WHOLE mesh; the leaf faces (weight 0) are held.
                tot = sum(len(p.vertices) - 2 for p in o_me.polygons)
                dc.ratio = max(0.01, (tot - (wood_t - wood_goal)) / tot)
                dc.vertex_group = 'wood'
                dc.use_collapse_triangulate = True
                bpy.context.view_layer.objects.active = o
                bpy.ops.object.modifier_apply(modifier=dc.name)
            if src_cols is not None:
                ca = o_me.color_attributes.new('Col', col0.data_type, 'POINT')
                for v in o_me.vertices:
                    ca.data[v.index].color = src_cols[kd.find(v.co)[1]]
                o_me.color_attributes.active_color = ca
            tris = sum(len(p.vertices) - 2 for p in o_me.polygons)
            print(f'CANOPY_PROXY {name} {label} tris {tris} ({100 * tris / n0:.1f}%, ceiling {100 * ceil:.1f}%)')
            if tris > n0 * ceil:
                # Thin twigs refuse to collapse further: rebuild the level on a smaller budget.
                bpy.data.objects.remove(o, do_unlink=True)
                continue
            global EXPORT_DIR
            keep_dir, EXPORT_DIR = EXPORT_DIR, PROXY_DIR
            try:
                export_collection_vc(lcoll, f'{name}_{label}.glb')
            finally:
                EXPORT_DIR = keep_dir
            o.hide_render = True
            break
        else:
            raise AssertionError((name, label, 'proxy over its ceiling after 8 budgets'))
    bm0.free()


def build_broadleaf(name, height, crown_r, lean, leaf_mats, leaf_len, per_tip):
    rng = rng_of(name)
    coll = asset_collection(name)
    t = Tree(name, coll, rng, 'Bark_Broad')
    trunk_h = height * 0.5
    ang = rng.uniform(0, math.tau)
    top = t.limb(Vector((0, 0, -0.25)), Vector((math.cos(ang) * lean, math.sin(ang) * lean, 1)),
                 trunk_h + 0.25, 0.42, 0.24, segs=12, bend=0.05, pts_n=6)[-1]
    # Root flare: four short spurs at the foot.
    for k in range(4):
        a = k * math.tau / 4 + rng.uniform(-0.3, 0.3)
        t.limb(Vector((0, 0, 0.55)), Vector((math.cos(a), math.sin(a), -0.55)), 0.9, 0.2, 0.06, segs=6,
               bend=0.0, pts_n=2)

    def leaves(tip, out):
        t.cluster(tip, (out + UP * 0.6).normalized(), per_tip, leaf_len, leaf_len * 0.3, leaf_mats)

    for k in range(5):
        a = k * math.tau / 5 + rng.uniform(-0.3, 0.3)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.55, 0.9)))
        t.branch(top, d, crown_r * 0.55, 0.2, 2, leaves)
    t.finish()
    finish_canopy(coll, name)


def build_buttress(name):
    rng = rng_of(name)
    coll = asset_collection(name)
    t = Tree(name, coll, rng, 'Bark_Pale')
    top = t.limb(Vector((0, 0, -0.2)), UP, 9.0, 0.62, 0.38, segs=14, bend=0.02, pts_n=7)[-1]
    # Plank buttress fins: thin sinuous wedges from 3 m up the trunk to 2.2 m out on the ground.
    for k in range(6):
        a = k * math.tau / 6 + rng.uniform(-0.25, 0.25)
        rad = Vector((math.cos(a), math.sin(a), 0))
        tan = Vector((-rad.y, rad.x, 0))
        bm = bmesh.new()
        reach = rng.uniform(1.8, 2.5)
        rows = []
        n = 14
        for i in range(n + 1):
            f = i / n
            rr_ = 0.35 + f * reach
            h = 3.2 * (1 - f) ** 1.7 + 0.05
            wig = tan * (0.12 * math.sin(f * 7 + k))
            th = 0.13 * (1 - 0.6 * f) + 0.03
            c = rad * rr_ + wig
            rows.append([bm.verts.new(c + tan * th + Vector((0, 0, -0.15))),
                         bm.verts.new(c + tan * th + Vector((0, 0, h))),
                         bm.verts.new(c - tan * th + Vector((0, 0, h))),
                         bm.verts.new(c - tan * th + Vector((0, 0, -0.15)))])
        for i in range(n):
            a0, a1 = rows[i], rows[i + 1]
            for j in range(3):
                bm.faces.new((a0[j], a1[j], a1[j + 1], a0[j + 1]))
        bm.faces.new(tuple(reversed(rows[n])))
        t.parts.append(obj_from_bmesh(f"{name}_fin{k}", bm, coll, mat('Bark_Pale'), smooth=True))

    def leaves(tip, out):
        t.cluster(tip, (out * 0.4 + UP).normalized(), 23, 0.75, 0.24, ('Leaf_A', 'Leaf_B'), spread=1.3)

    for k in range(6):
        a = k * math.tau / 6 + rng.uniform(-0.25, 0.25)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.25, 0.45)))
        t.branch(top, d, 4.2, 0.26, 2, leaves)
    t.finish()
    finish_canopy(coll, name)


def build_mangrove(name):
    rng = rng_of(name)
    coll = asset_collection(name)
    t = Tree(name, coll, rng, 'Bark_Broad')
    base = Vector((0, 0, 1.5))
    # Arching prop roots: from the trunk foot out and down into the mud/tide line.
    for k in range(10):
        a = k * math.tau / 10 + rng.uniform(-0.2, 0.2)
        out = rng.uniform(1.4, 2.3)
        p0 = base + Vector((0, 0, rng.uniform(-0.2, 0.6)))
        p2 = Vector((math.cos(a) * out, math.sin(a) * out, -0.35))
        p1 = (p0 + p2) / 2 + Vector((math.cos(a) * 0.5, math.sin(a) * 0.5, 0.9))
        pts = [((1 - s) ** 2) * p0 + 2 * (1 - s) * s * p1 + (s * s) * p2 for s in (0, .2, .4, .6, .8, 1)]
        t.n += 1
        t.parts += chain_pts(coll, f"{name}_root{k}", pts, 0.09, 0.05, mat('Bark_Broad'), segs=7, balls=False)
    top = t.limb(base, UP, 3.2, 0.24, 0.15, segs=10, bend=0.08, pts_n=4)[-1]

    def leaves(tip, out):
        t.cluster(tip, (out + UP * 0.8).normalized(), 17, 0.36, 0.13, ('Leaf_A', 'Leaf_C'), spread=1.2)

    for k in range(4):
        a = k * math.tau / 4 + rng.uniform(-0.4, 0.4)
        t.branch(top, Vector((math.cos(a), math.sin(a), 0.6)), 2.1, 0.12, 2, leaves)
    t.finish()
    finish_canopy(coll, name)


def build_dead(name, height, twist):
    rng = rng_of(name)
    coll = asset_collection(name)
    t = Tree(name, coll, rng, 'Bark_Pale')
    top = t.limb(Vector((0, 0, -0.2)), Vector((twist, 0.1, 1)), height * 0.55, 0.3, 0.14, segs=10, bend=0.1,
                 pts_n=5)[-1]

    def stub(tip, out):
        pass

    for k in range(3):
        a = k * math.tau / 3 + rng.uniform(-0.6, 0.6)
        t.branch(top, Vector((math.cos(a), math.sin(a), 0.7)), height * 0.3, 0.12, 2, stub)
    t.finish()
    finish_canopy(coll, name)


def build_banana(name):
    rng = rng_of(name)
    coll = asset_collection(name)
    parts = []
    for s in range(3):  # a clump: mother stem + two suckers
        off = Vector((0, 0, 0)) if s == 0 else Vector((math.cos(s * 2.3) * 0.5, math.sin(s * 2.3) * 0.5, 0))
        h = (2.6, 1.4, 1.0)[s]
        parts.append(seg_between(coll, f"{name}_stem{s}", off + Vector((0, 0, -0.15)), off + Vector((0, 0, h)),
                                 0.16 * (1 - s * 0.25), 0.1 * (1 - s * 0.25), mat('Trunk_Palm'), segs=12))
        bm = bmesh.new()
        nl = (12, 7, 5)[s]
        for i in range(nl):
            a = i * 2.4 + rng.uniform(-0.2, 0.2)
            d = Vector((math.cos(a), math.sin(a), rng.uniform(0.6, 1.4)))
            L = h * rng.uniform(0.75, 1.0)
            add_blade(bm, off + Vector((0, 0, h * rng.uniform(0.85, 1.0))), d, L, L * 0.2, 0.45 * L,
                      cup=0.12, n=20)
        parts.append(obj_from_bmesh(f"{name}_leaves{s}", bm, coll, mat('Banana_Leaf'), smooth=True))
    # Hanging fruit bunch + purple bell on the mother stem.
    parts.append(seg_between(coll, f"{name}_stalk", Vector((0, 0, 2.5)), Vector((0.45, 0, 1.9)), 0.03, 0.025,
                             mat('Leaf_C'), segs=6))
    for i in range(14):
        z = 2.2 - i * 0.03
        a = i * 1.9
        bm = bm_cylinder(0.03, 0.018, 0.2, segs=6)
        xform(bm, Matrix.Translation((0.3 + math.cos(a) * 0.09, math.sin(a) * 0.09, z)) @ Matrix.Rotation(0.6, 4, 'Y'))
        parts.append(obj_from_bmesh(f"{name}_fruit{i}", bm, coll, mat('Leaf_B'), smooth=True))
    finish_canopy(coll, name)


def build_fern_giant(name):
    rng = rng_of(name)
    coll = asset_collection(name)
    bm = bmesh.new()
    parts = []
    for f in range(11):
        a = f * math.tau / 11 + rng.uniform(-0.15, 0.15)
        d = Vector((math.cos(a), math.sin(a), 0.0))
        L = rng.uniform(1.8, 2.4)
        rise = rng.uniform(0.9, 1.4)
        pts = []
        for i in range(12):
            s = i / 11
            pts.append(Vector((0, 0, 0.1)) + d * (L * s) + Vector((0, 0, rise * math.sin(math.pi * s * 0.75))))
        parts += chain_pts(coll, f"{name}_rachis{f}", pts, 0.025, 0.008, mat('Stem'), segs=4, balls=False)
        side = d.cross(UP).normalized()
        for i in range(1, 11):
            p = pts[i]
            plen = 0.45 * (1 - (i / 11) ** 1.4)
            for sgn in (1, -1):
                add_blade(bm, p, (side * sgn + d * 0.35).normalized(), plen, plen * 0.18, plen * 0.3, cup=0.2, n=4)
    parts.append(obj_from_bmesh(f"{name}_pinnae", bm, coll, mat('Leaf_A'), smooth=True))
    finish_canopy(coll, name)


def build_tall_grass(name):
    rng = rng_of(name)
    coll = asset_collection(name)
    bms = {'Grass_Tall': bmesh.new(), 'Leaf_C': bmesh.new()}
    for i in range(70):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0, 0.35)
        base = Vector((math.cos(a) * r, math.sin(a) * r, -0.02))
        d = Vector((math.cos(a) * rng.uniform(0.1, 0.45), math.sin(a) * rng.uniform(0.1, 0.45), 1))
        L = rng.uniform(0.8, 1.5)
        add_blade(bms[rng.choice(list(bms))], base, d, L, 0.025, L * 0.35, cup=0.3, n=6, curl=0.6)
    for m, bm in bms.items():
        obj_from_bmesh(f"{name}_{m}", bm, coll, mat(m), smooth=True)
    finish_canopy(coll, name)


BUILDS = {
    'tree_broadleaf_a': lambda n: build_broadleaf(n, 12.5, 5.6, 0.08, ('Leaf_A', 'Leaf_B'), 0.62, 23),
    'tree_broadleaf_b': lambda n: build_broadleaf(n, 10.5, 4.8, 0.16, ('Leaf_B', 'Leaf_C'), 0.55, 20),
    'tree_buttress': build_buttress,
    'tree_mangrove': build_mangrove,
    'tree_dead_a': lambda n: build_dead(n, 8.0, 0.05),
    'tree_dead_b': lambda n: build_dead(n, 6.0, 0.3),
    'banana_plant': build_banana,
    'fern_giant': build_fern_giant,
    'tall_grass': build_tall_grass,
}
FAILED = []
for key, fn in BUILDS.items():
    if ONLY and key not in ONLY:
        continue
    try:
        fn(key)
    except AssertionError as e:  # out of its tri band: report every asset, then fail the build
        print('CANOPY_BAND_FAIL', key, e)
        FAILED.append(key)
if FAILED:
    raise SystemExit('canopy build failed: ' + ','.join(FAILED))
if RENDER_DIR:
    render_nature(tuple(k for k in BUILDS if not ONLY or k in ONLY), RENDER_DIR)
print("CANOPY DONE")
