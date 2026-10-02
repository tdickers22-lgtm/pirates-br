# ROCK KIT v2 CORE (b4.5a; assets-08, assets-09, PLAN 3.12 + section 6 row 12).
#
# The 2026-09 rocks were an icosphere with two noise displacements decimated into split-vertex flat
# facets (verts/tris 3.00, "smooth blobs with painted strata") and lathed pagoda pillars. This module
# is the shared rock core every rock-family build uses (build_rocks.py now; build_crag.py,
# build_cave_kit.py and the b4.6 cliff kit next):
#
#   voronoi_cell(seed, ...)     one VORONOI CELL: the convex intersection of the half-spaces that
#                               separate a site from its neighbours, clipped from a dense sphere, so
#                               the base form is a fractured block with real planar breaks, not a blob
#   fracture_cluster(cells)     several cells unioned through a voxel remesh (a split boulder, a
#                               leaning shard on a slab, a sedimentary stack of bedding slabs)
#   sedimentary_stack(...)      layered searock: dipping bedding slabs, soft beds set back into
#                               ledges, taper, companion stacks and a rubble skirt
#   HeightMap(id)               a PolyHaven CC0 rock DISPLACEMENT map, read into numpy, sampled
#                               triplanar at real-world scale
#   sculpt(obj, recipe)         the HIGH sculpt (300-600k tris from a voxel remesh sized by area):
#                               multi-octave displacement = macro fBm + three octaves of the height
#                               map + bedding joints + vertical joint fissures + the wave notch
#                               (horizontal undercut at the waterline, the sea-cut nip of a stack)
#   lod0(high, target)          collapse-decimated to the D27 band from the welded high surface,
#                               shade smooth, sharp only on real creases, FACE-AREA weighted normals:
#                               ONE welded surface (verts/tris ~0.5, assets-09) instead of 3x split
#   zone_materials(...)         wet band / body / sun-bleached crown by height and facing, then the
#                               shared AO + moss/low-band tint pass (_ao.bake_ao, _detail.tint_pass)
#   fit_bounds(objs, name)      the legacy game-space AABB (_nature.NATURE_BOUNDS): colliders,
#                               propBaseLift and test-asset-bounds stay valid (footprints within 10%)
#
# Load after _helpers.py, _ao.py, _detail.py and _nature.py (exec into the build's namespace, the
# same pattern as _nature.py). Deterministic: every random draw is random.Random(seed) or the
# integer-hash noise below; no numpy RNG.
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

_ROCK_HERE = os.path.dirname(os.path.abspath(__file__))
if _ROCK_HERE not in sys.path:
    sys.path.insert(0, _ROCK_HERE)
import _pbr as _RP  # noqa: E402

# PolyHaven CC0 height sources (TEXTURE_LICENSES.md rows). Real-world tile sizes come from the
# PolyHaven manifest (rock_face 2.38 m, rock_boulder_dry 1.80 m).
ROCK_HEIGHT_SOURCES = ('rock_face', 'rock_boulder_dry')
HIGH_TRIS = 450000          # the sculpt target; the band is 300-600k (PLAN section 6 row 12)


# ── integer-hash value noise (numpy, deterministic, no RNG state) ─────────────────────────────
def _hash3(ix, iy, iz, seed):
    h = (ix.astype(np.uint64) * np.uint64(73856093)) ^ (iy.astype(np.uint64) * np.uint64(19349663)) \
        ^ (iz.astype(np.uint64) * np.uint64(83492791)) ^ np.uint64((seed * 2654435761) & 0xffffffff)
    h = h & np.uint64(0xffffffff)
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & np.uint64(0xffffffff)
    h = h ^ (h >> np.uint64(16))
    return (h & np.uint64(0xffff)).astype(np.float64) / 65535.0


def vnoise3(p, seed=0):
    """Value noise in [0, 1] at points p (N x 3), smoothstep-interpolated lattice."""
    f = np.floor(p)
    t = p - f
    t = t * t * (3.0 - 2.0 * t)
    i = f.astype(np.int64) + (1 << 20)
    out = np.zeros(len(p))
    for dx in (0, 1):
        wx = t[:, 0] if dx else 1.0 - t[:, 0]
        for dy in (0, 1):
            wy = t[:, 1] if dy else 1.0 - t[:, 1]
            for dz in (0, 1):
                wz = t[:, 2] if dz else 1.0 - t[:, 2]
                out += wx * wy * wz * _hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm(p, octaves=4, seed=0, lac=2.03, gain=0.5):
    """Signed fractal noise, roughly [-1, 1]."""
    out = np.zeros(len(p))
    amp, norm, q = 1.0, 0.0, p.copy()
    for o in range(octaves):
        out += amp * (vnoise3(q, seed + 17 * o) * 2.0 - 1.0)
        norm += amp
        amp *= gain
        q = q * lac + 3.17
    return out / norm


# ── PolyHaven height map ──────────────────────────────────────────────────────────────────────
class HeightMap:
    def __init__(self, asset_id):
        got = _RP.fetch(asset_id, res='1k', maps=('Displacement',), fmt='jpg')
        img = bpy.data.images.load(got['maps']['Displacement'], check_existing=True)
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        a = px.reshape(h, w, 4)[:, :, 0].astype(np.float64)
        a -= a.mean()
        a /= max(1e-6, np.abs(a).max())
        self.a, self.w, self.h = a, w, h
        self.tile = (got['manifest'].get('dimensions_mm') or [2000])[0] / 1000.0
        self.id = asset_id

    def _sample(self, u, v, tile):
        x = u / tile * self.w
        y = v / tile * self.h
        x0 = np.floor(x)
        y0 = np.floor(y)
        fx, fy = x - x0, y - y0
        x0 = x0.astype(np.int64) % self.w
        y0 = y0.astype(np.int64) % self.h
        x1, y1 = (x0 + 1) % self.w, (y0 + 1) % self.h
        a = self.a
        return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x1] * fx * (1 - fy)
                + a[y1, x0] * (1 - fx) * fy + a[y1, x1] * fx * fy)

    def triplanar(self, co, nrm, tile, offset=(0.0, 0.0, 0.0)):
        """Height in [-1, 1] at world-scale `tile` metres per repeat, blended on |n|^4."""
        p = co + np.asarray(offset)
        wgt = np.abs(nrm) ** 4
        wgt /= np.maximum(1e-9, wgt.sum(axis=1))[:, None]
        return (wgt[:, 0] * self._sample(p[:, 1], p[:, 2], tile)
                + wgt[:, 1] * self._sample(p[:, 0], p[:, 2], tile)
                + wgt[:, 2] * self._sample(p[:, 0], p[:, 1], tile))


_HEIGHTS = {}


def height_map(asset_id):
    if asset_id not in _HEIGHTS:
        _HEIGHTS[asset_id] = HeightMap(asset_id)
    return _HEIGHTS[asset_id]


# ── base forms ────────────────────────────────────────────────────────────────────────────────
def _fib_sphere(n):
    pts = []
    ga = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        z = 1.0 - 2.0 * (i + 0.5) / n
        r = math.sqrt(max(0.0, 1.0 - z * z))
        pts.append(Vector((math.cos(ga * i) * r, math.sin(ga * i) * r, z)))
    return pts


def voronoi_cell(name, coll, seed, scale=(1.0, 1.0, 1.0), planes=11, reach=(0.62, 0.95),
                 points=1400, up_bias=0.0, caps=None):
    """Convex Voronoi cell around the origin: each neighbour site at 2h along a random direction
    contributes the bisector plane n.x <= h. Points of a dense sphere are pulled onto the nearest
    violated plane, and the convex hull of the result is the cell (planar fracture faces, rounded
    only where no plane cut). `up_bias` > 0 keeps the cell's top a fracture face (slab tops)."""
    rng = random.Random(seed)
    cuts = []
    for k in range(planes):
        d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1) + (up_bias if k == 0 else 0.0)))
        if d.length < 1e-6:
            continue
        d.normalize()
        cuts.append((d, rng.uniform(*reach)))
    # caps: flat bedding faces (a slab is cut top and bottom, so its sides stand near-vertical
    # instead of closing into a lens: the 'stacked pancake' tell of the v1 stacks)
    for c in (caps or ()):
        cuts.append((Vector((rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), 1.0)).normalized(), c))
        cuts.append((Vector((rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), -1.0)).normalized(), c))
    bm = bmesh.new()
    for p in _fib_sphere(points):
        t = 1.0
        for n, h in cuts:
            dn = n.dot(p)
            if dn > 1e-6:
                t = min(t, h / dn)
        q = p * t
        bm.verts.new((q.x * scale[0], q.y * scale[1], q.z * scale[2]))
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    drop = {v for v in list(res['geom_interior']) + list(res['geom_unused']) if isinstance(v, bmesh.types.BMVert)}
    if drop:
        bmesh.ops.delete(bm, geom=list(drop), context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    return obj


def place(obj, loc=(0, 0, 0), rot_deg=(0, 0, 0)):
    obj.location = Vector(loc)
    obj.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.context.view_layer.update()
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)
    return obj


def _join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def _apply(obj, mod):
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def surface_area(obj):
    return sum(p.area for p in obj.data.polygons)


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def fracture_cluster(parts, name, high_tris=HIGH_TRIS, smooth_iters=2):
    """Union overlapping cells into ONE closed, welded surface through a voxel remesh whose voxel
    size gives ~high_tris triangles (tris ~ 2 * area / voxel^2), then soften the remesh stair-steps
    (water-worn edges grow with smooth_iters)."""
    obj = _join(parts, name) if len(parts) > 1 else parts[0]
    # The joined cells overlap, so their summed area over-counts the outer surface: remesh, measure,
    # and re-remesh at a corrected voxel until the sculpt lands inside the 300-600k band.
    voxel = math.sqrt(2.0 * surface_area(obj) / high_tris)
    for attempt in range(3):
        rm = obj.modifiers.new('rk_remesh', 'REMESH')
        rm.mode = 'VOXEL'
        rm.voxel_size = voxel
        rm.adaptivity = 0.0
        _apply(obj, rm)
        t = tri_count(obj)
        if 300000 <= t <= 600000:
            break
        voxel *= math.sqrt(t / high_tris)
    if smooth_iters:
        sm = obj.modifiers.new('rk_smooth', 'SMOOTH')
        sm.factor = 0.5
        sm.iterations = smooth_iters
        _apply(obj, sm)
    obj.data.shade_smooth()
    return obj, voxel


def sedimentary_stack(name, coll, seed, height, base_r, aspect=0.82, base_z=-1.2, bed=(0.8, 1.9),
                      taper=0.55, dip_deg=9.0, soft_set_back=0.93, lean=0.10, crown=0.34, jitter=0.07):
    """Bedding slabs (each a flat Voronoi cell, so its outline is jointed, not round) stacked along
    +Z with a common dip, the soft beds set back so the hard beds stand out as ledges, tapering
    to a crown and drifting off-axis with height (lean)."""
    rng = random.Random(seed)
    dip_az = rng.uniform(0, 360)
    slabs, z, k = [], base_z, 0
    dx = dy = 0.0
    while z < height:
        t = rng.uniform(*bed)
        u = max(0.0, (z - base_z) / max(1e-6, height - base_z))
        r = base_r * (1.0 - taper * u) * rng.uniform(0.92, 1.06)
        r = max(base_r * crown, r)
        soft = rng.random() < 0.30 and 0.08 < u < 0.92
        if soft:
            r *= soft_set_back
        dx += rng.uniform(-1, 1) * lean * t
        dy += rng.uniform(-1, 1) * lean * t
        s = voronoi_cell(f'{name}_bed{k}', coll, seed * 31 + k, scale=(r, r * aspect, t * 0.95),
                         planes=8, reach=(0.52, 0.92), points=900, caps=(0.56,))
        jx, jy = rng.uniform(-1, 1) * jitter * r, rng.uniform(-1, 1) * jitter * r
        place(s, (dx + jx, dy + jy, z + t * 0.5), (dip_deg * math.cos(math.radians(dip_az)),
                                          dip_deg * math.sin(math.radians(dip_az)), rng.uniform(-14, 14)))
        slabs.append(s)
        z += t * 0.97
        k += 1
    return slabs


# ── the high sculpt ──────────────────────────────────────────────────────────────────────────
def _arrays(me):
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get('co', co)
    nr = np.empty(n * 3)
    me.vertices.foreach_get('normal', nr)
    return co.reshape(n, 3), nr.reshape(n, 3)


def sculpt(obj, seed, macro=(0.10, 1.6), heights=((0, 2.6, 0.050), (1, 0.9, 0.022), (0, 0.33, 0.008)),
           strata=None, joints=(), notch=None, chips=0.0):
    """Displace the welded high mesh along its normals (all amplitudes in metres):
      macro    (amp, wavelength) fBm lumps that break the cell planes into weathered faces
      heights  ((source index, tile m, amp), ...) the PolyHaven height map at three octaves
      strata   dict(bed, amp, dip(vec3)) bedding joints: a V-groove at every bed boundary
      joints   ((point, normal, width, depth), ...) vertical joint fissures
      notch    dict(z, width, depth) the wave-cut notch: a horizontal undercut at the waterline
      chips    amp of a sharpened (ridged) noise that chips the fracture edges"""
    me = obj.data
    co, nr = _arrays(me)
    disp = np.zeros(len(co))
    amp, wl = macro
    if amp:
        disp += amp * fbm(co / wl, 4, seed)
    for src, tile, a in heights:
        hm = height_map(ROCK_HEIGHT_SOURCES[src])
        disp += a * hm.triplanar(co, nr, tile, offset=(seed * 0.37, seed * 0.11, seed * 0.23))
    if chips:
        r = 1.0 - np.abs(fbm(co / 0.22, 3, seed + 5))
        disp -= chips * r ** 6
    if strata:
        d = np.asarray(strata.get('dip', (0.0, 0.0, 1.0)))
        d = d / np.linalg.norm(d)
        s = co @ d / strata['bed'] + 0.15 * fbm(co / 3.0, 2, seed + 9)
        frac = s - np.floor(s)
        groove = np.exp(-((np.minimum(frac, 1.0 - frac)) / 0.07) ** 2)
        horiz = np.sqrt(np.maximum(0.0, 1.0 - (nr @ d) ** 2))
        disp -= strata['amp'] * groove * horiz
    for p, n, w, depth in joints:
        n = np.asarray(n, dtype=np.float64)
        n /= np.linalg.norm(n)
        dist = np.abs((co - np.asarray(p)) @ n)
        wob = 1.0 + 0.5 * fbm(co / 0.8, 2, seed + 13)
        disp -= depth * np.exp(-(dist / (w * wob)) ** 2) * np.sqrt(np.maximum(0.0, 1.0 - (nr @ n) ** 2))
    if notch:
        horiz = np.sqrt(nr[:, 0] ** 2 + nr[:, 1] ** 2)
        g = np.exp(-((co[:, 2] - notch['z']) / notch['width']) ** 2)
        # the roof of the notch is a sharp lip, the floor a ramp: skew the profile upward
        lip = np.where(co[:, 2] > notch['z'], np.exp(-((co[:, 2] - notch['z']) / (notch['width'] * 0.45)) ** 2), g)
        disp -= notch['depth'] * lip * horiz * (0.75 + 0.25 * fbm(co / 1.7, 2, seed + 21))
    co += nr * disp[:, None]
    me.vertices.foreach_set('co', co.reshape(-1))
    me.update()
    return float(np.abs(disp).max())


# ── LOD0 from the high sculpt ─────────────────────────────────────────────────────────────────
def lod0(high, name, coll, target, sharp_deg=58.0):
    """Collapse-decimate a copy of the welded high mesh into the band, then face-area weighted
    normals with sharp edges only on creases steeper than sharp_deg. Returns the LOD0 object."""
    low = high.copy()
    low.data = high.data.copy()
    low.name = name
    coll.objects.link(low)
    ratio = target / max(1, tri_count(high))
    dm = low.modifiers.new('rk_lod0', 'DECIMATE')
    dm.decimate_type = 'COLLAPSE'
    dm.ratio = ratio
    _apply(low, dm)
    me = low.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    wn = low.modifiers.new('rk_wn', 'WEIGHTED_NORMAL')
    wn.weight = 50
    wn.keep_sharp = True
    wn.mode = 'FACE_AREA'
    _apply(low, wn)
    return low


def fit_bounds(objs, name):
    """Fit (per axis, linear) into the legacy game-space AABB from _nature.NATURE_BOUNDS (game Y up,
    Blender Z up; game z = -Blender y), so colliders and placement stay valid."""
    lo, hi = NATURE_BOUNDS[name]  # noqa: F821 (from _nature.py)
    low = Vector((lo[0], -hi[2], lo[1]))
    high = Vector((hi[0], -lo[2], hi[1]))
    vs = [v for o in objs for v in o.data.vertices]
    amin = Vector(tuple(min(v.co[a] for v in vs) for a in range(3)))
    amax = Vector(tuple(max(v.co[a] for v in vs) for a in range(3)))
    for v in vs:
        for a in range(3):
            v.co[a] = low[a] + (v.co[a] - amin[a]) * (high[a] - low[a]) / max(1e-6, amax[a] - amin[a])
    for o in objs:
        o.data.update()


def zone_materials(low, zones):
    """zones: list of (material name, predicate(centroid z, normal z)) tried in order; the last
    zone is the default. Splits the object by material (tint_pass wants one material per object)."""
    me = low.data
    me.materials.clear()
    for mname, _ in zones:
        me.materials.append(mat(mname))  # noqa: F821 (from _helpers.py)
    for p in me.polygons:
        z, nz = p.center.z, p.normal.z
        p.material_index = len(zones) - 1
        for i, (_, pred) in enumerate(zones):
            if pred(z, nz):
                p.material_index = i
                break
    used = {p.material_index for p in me.polygons}
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    if len(used) > 1:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
    parts = [o for o in low.users_collection[0].objects if o.type == 'MESH']
    for o in parts:
        keep = [i for i, m in enumerate(o.data.materials) if any(p.material_index == i for p in o.data.polygons)]
        if len(keep) == 1 and keep[0] != 0:
            m = o.data.materials[keep[0]]
            for p in o.data.polygons:
                p.material_index = 0
            o.data.materials.clear()
            o.data.materials.append(m)
        elif len(keep) == 1:
            m = o.data.materials[0]
            o.data.materials.clear()
            o.data.materials.append(m)
    return parts


def rock_finish(coll, name, moss=0.40, low_band=0.65, strata_freq=9.0):
    """Shared AO + moss + low wet band tint (the finish_nature stone recipe), joined to one node."""
    bake_ao(coll, samples=24, floor=0.66, max_dist=3.5, height_gradient=0.06)  # noqa: F821
    spec = tint_spec(moss=moss)  # noqa: F821
    for stone in ('Rock_Grey', 'Rock_Stack', 'Rock_Pale', 'Rock_Wet', 'Rock_Dark'):
        spec[stone] = dict(spec['Rock_Grey'], tone=0.12, streak=dict(axis='z', freq=strata_freq, amt=0.12),
                           low=dict(z=low_band, amt=0.30, col=(0.59, 0.65, 0.56)))
    tint_pass(coll, spec, seed=19)  # noqa: F821
    objs = [o for o in coll.objects if o.type == 'MESH']
    return _join(objs, name) if len(objs) > 1 else objs[0]


def decimated_copy(src, name, coll, ratio):
    o = src.copy()
    o.data = src.data.copy()
    o.name = name
    coll.objects.link(o)
    dm = o.modifiers.new('rk_far', 'DECIMATE')
    dm.decimate_type = 'COLLAPSE'
    dm.ratio = ratio
    _apply(o, dm)
    # a far rock never floats: re-seat its lowest point on the source's lowest point
    zs = min(v.co.z for v in src.data.vertices)
    zf = min(v.co.z for v in o.data.vertices)
    for v in o.data.vertices:
        v.co.z += zs - zf
    o.data.update()
    return o


def stats_line(obj):
    me = obj.data
    me.calc_loop_triangles()
    return {'tris': len(me.loop_triangles), 'verts': len(me.vertices)}
