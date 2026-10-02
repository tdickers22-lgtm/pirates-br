"""Convex-hull colliders for the cliff kit (b4.6c, islands-02).

Reads every kit LOD0 GLB under public/assets/models/ (the drawn mesh), splits it into <= 6 convex
pieces, reduces each hull to <= 32 vertices and writes src/shared/generated/kitColliders.json, the
single collider truth read by src/shared/hullCollide.ts (server physics, client prediction, rays).

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/export_colliders.py
  env COLLIDER_ONLY=sea_arch_a,searock_d   limit the run (the JSON keeps the other rows)

Frame: game space (glTF, +Y up), piece origin = the GLB origin (the placement frame of b4.6d).
Partition:
  * sea_arch_a: 2 legs + 4 span slabs (x edges +-11.9, +-10, 0). A span slab only takes vertices on
    or above the superellipse intrados (ARCH_* in build_cliff_kit.py), so a slab hull's underside
    is a chord of the soffit and the 18 m channel stays open; anything below the intrados goes to
    the leg on its side.
  * sea_arch_b (land bridge): 2 piers + 2 deck halves split at x = 0 above the flat keel soffit.
  * everything else: deterministic k-means (k = 1..6), the smallest k whose summed hull volume is
    within 15 % of the k = 6 volume.
Reduction: greedy farthest-point selection on the full hull until <= 32 vertices or every vertex
is within 2 cm; every plane is then pushed out to the farthest drawn vertex on its side, so the
collider ENCLOSES every drawn vertex of its group (0 shoot-through by construction). The push is
reported per piece (inflate).
"""
import bpy
import bmesh
import json
import math
import os
import sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODELS = os.path.join(ROOT, 'public', 'assets', 'models')
OUT = os.path.join(ROOT, 'src', 'shared', 'generated', 'kitColliders.json')

KIT_KEYS = (
    'cliff_face_a', 'cliff_face_b', 'cliff_face_c', 'cliff_overhang_a', 'cliff_overhang_b',
    'rock_shelf_a', 'rock_shelf_b', 'sea_arch_a', 'sea_arch_b', 'basalt_columns_a', 'scree_fan_a',
    'searock_d', 'searock_e', 'searock_f', 'searock_g', 'strata_slab_a', 'strata_slab_b',
    'strata_slab_c', 'spire_a', 'spire_b', 'spire_c', 'reef_a', 'reef_b', 'reef_c',
)
MAX_VERTS = 32
MAX_HULLS = 6
TOL = 0.02
# Mirrors build_cliff_kit.py (b4.6b2): intrados superellipse a 11.9, z0 9.5, b 18.5, n 4.
ARCH_A, ARCH_Z0, ARCH_B, ARCH_N = 11.9, 9.5, 18.5, 4.0
# Overhangs (b4.6a2 handoff): wall front at game z (Blender -y) and lip soffit height, metres.
OVERHANG = {'cliff_overhang_a': (0.66, 4.75), 'cliff_overhang_b': (0.74, 2.71)}


def intrados_y(x):
    u = min(1.0, abs(x) / ARCH_A)
    return ARCH_Z0 + ARCH_B * (1.0 - u ** ARCH_N) ** (1.0 / ARCH_N)


def load_verts(key):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, key + '.glb'))
    pts = []
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH':
            continue
        mw = ob.matrix_world
        for v in ob.data.vertices:
            w = mw @ v.co
            pts.append((w.x, w.z, -w.y))  # Blender Z-up -> glTF/game Y-up
    return np.unique(np.round(np.array(pts, dtype=np.float64), 5), axis=0)


def hull_faces(P):
    """(vertex indices into P used by the hull, plane list [(n, d)]) of the convex hull of P."""
    bm = bmesh.new()
    vs = [bm.verts.new(tuple(p)) for p in P]
    for i, v in enumerate(vs):
        v.index = i
    res = bmesh.ops.convex_hull(bm, input=vs, use_existing_faces=False)
    del res
    used, planes = set(), []
    centre = np.asarray(P, dtype=np.float64).mean(axis=0)
    for f in bm.faces:
        n = f.normal.copy()
        if n.length < 1e-9:
            continue
        n.normalize()
        c = f.calc_center_median()
        nv, d = np.array((n.x, n.y, n.z)), float(n.dot(c))
        if float(nv @ centre) > d:  # keep every normal pointing out of the hull
            nv, d = -nv, -d
        planes.append((nv, d))
        for v in f.verts:
            used.add(v.index)
    bm.free()
    return sorted(used), planes


def outside(P, planes):
    N = np.array([p[0] for p in planes])
    D = np.array([p[1] for p in planes])
    return (P @ N.T - D).max(axis=1)


def hull_volume(P):
    if len(P) < 4:
        return 0.0
    idx, planes = hull_faces(P)
    c = P[idx].mean(axis=0)
    # sum of pyramids from the centroid: area is not kept, so use the AABB-free tetra fan instead
    bm = bmesh.new()
    vs = [bm.verts.new(tuple(p)) for p in P]
    bmesh.ops.convex_hull(bm, input=vs, use_existing_faces=False)
    vol = 0.0
    for f in bm.faces:
        if len(f.verts) < 3:
            continue
        a = np.array(f.verts[0].co)
        for i in range(1, len(f.verts) - 1):
            b, d = np.array(f.verts[i].co), np.array(f.verts[i + 1].co)
            vol += abs(np.dot(a - c, np.cross(b - c, d - c))) / 6.0
    bm.free()
    return vol


def reduce_hull(P):
    idx, planes = hull_faces(P)
    H = P[idx]
    if len(H) <= MAX_VERTS:
        sel = list(range(len(H)))
    else:
        dirs = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
        dirs += [(sx, sy, sz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        sel = []
        for d in dirs:
            i = int(np.argmax(H @ np.array(d, dtype=np.float64)))
            if i not in sel:
                sel.append(i)
        while True:
            used, pl = hull_faces(H[sel])
            sel = [sel[u] for u in used]
            if len(sel) >= MAX_VERTS:
                break
            o = outside(H, pl)
            j = int(np.argmax(o))
            if o[j] < TOL:
                break
            sel.append(j)
        while True:  # the last add can leave > 32 hull vertices: drop the least useful until legal
            used, pl = hull_faces(H[sel])
            sel = [sel[u] for u in used]
            if len(sel) <= MAX_VERTS:
                break
            sel.pop(int(np.argmin(outside(H[sel], hull_faces(H[sel[:-1]])[1]))))
    V = H[sel]
    _, pl = hull_faces(V)
    out_planes, inflate = [], 0.0
    for n, d in pl:
        far = float((P @ n).max())
        if far > d:
            inflate = max(inflate, far - d)
            d = far
        dup = False
        for m, e in out_planes:
            if np.dot(m, n) > 0.99995 and abs(e - d) < 1e-3:
                dup = True
                break
        if not dup:
            out_planes.append((n, d))
    return V, out_planes, inflate


def kmeans(P, k, iters=24):
    rng = np.random.default_rng(4242 + k)
    C = [P[int(np.argmin(((P - P.mean(axis=0)) ** 2).sum(axis=1)))]]
    while len(C) < k:
        d2 = np.min([((P - c) ** 2).sum(axis=1) for c in C], axis=0)
        C.append(P[int(rng.choice(len(P), p=d2 / d2.sum()))])
    C = np.array(C)
    for _ in range(iters):
        lab = np.argmin(((P[:, None, :] - C[None, :, :]) ** 2).sum(axis=2), axis=1)
        for j in range(k):
            if np.any(lab == j):
                C[j] = P[lab == j].mean(axis=0)
    return [np.where(lab == j)[0] for j in range(k) if np.count_nonzero(lab == j) >= 4]


def partition(key, P):
    x, y = P[:, 0], P[:, 1]
    if key == 'sea_arch_a':
        zc = np.array([intrados_y(v) - 0.4 for v in x])
        below = (np.abs(x) < ARCH_A) & (y < zc)
        groups = [np.where((x < 0) & ((x <= -ARCH_A) | below))[0], np.where((x >= 0) & ((x >= ARCH_A) | below))[0]]
        edges = (-ARCH_A, -10.0, 0.0, 10.0, ARCH_A)
        for a, b in zip(edges[:-1], edges[1:]):
            groups.append(np.where((x >= a) & (x < b) & ~below)[0])
        return groups
    if key == 'sea_arch_b':
        inner = 6.1
        mid = np.abs(x) < inner - 0.5
        soffit = float(y[mid & (y > 2.0)].min()) - 0.4
        below = (np.abs(x) < inner) & (y < soffit)
        print(f'  sea_arch_b soffit {soffit + 0.4:.2f}')
        return [np.where((x < 0) & ((x <= -inner) | below))[0], np.where((x >= 0) & ((x >= inner) | below))[0],
                np.where((x < 0) & (x > -inner) & ~below)[0], np.where((x >= 0) & (x < inner) & ~below)[0]]
    if key in OVERHANG:
        # Keep the undercut OPEN: the lip (above the soffit, in front of the wall), the wall and the
        # foot rubble under the lip are hulled apart, so no hull bridges the cavity.
        wf, soffit = OVERHANG[key]
        z = P[:, 2]
        front = z > wf + 0.4
        lip = front & (y > soffit - 0.25)
        foot = front & ~lip
        out = []
        for mask in (lip, ~front, foot):
            idx = np.where(mask)[0]
            if len(idx) >= 4:
                out += [idx[g] for g in best_kmeans(P[idx], 2)]
        return out
    return best_kmeans(P, MAX_HULLS)


def best_kmeans(P, kmax):
    vols, parts = {}, {}
    for k in range(1, kmax + 1):
        parts[k] = kmeans(P, k) if k > 1 else [np.arange(len(P))]
        vols[k] = sum(hull_volume(P[g]) for g in parts[k])
    best = next(k for k in range(1, kmax + 1) if vols[k] <= vols[kmax] * 1.15)
    print(f'  k-means vols ' + ' '.join(f'{k}:{v:.0f}' for k, v in vols.items()) + f' -> k={best}')
    return parts[best]


def r4(v):
    return [round(float(t), 4) for t in v]


def main():
    only = [s for s in os.environ.get('COLLIDER_ONLY', '').split(',') if s]
    data = {'version': 1, 'pieces': {}}
    if os.path.exists(OUT):
        data = json.load(open(OUT))
    data['note'] = ('Generated by scripts/blender/export_colliders.py from the LOD0 GLBs; do not hand-edit. '
                    'Game frame (+Y up), piece origin = GLB origin. Plane rows [nx, ny, nz, d]: inside when '
                    'n.p <= d for every row.')
    data['maxVerts'] = MAX_VERTS
    data['maxHulls'] = MAX_HULLS
    for key in KIT_KEYS:
        if only and key not in only:
            continue
        P = load_verts(key)
        print(f'{key}: {len(P)} verts')
        hulls, worst = [], 0.0
        for g in partition(key, P):
            if len(g) < 4:
                continue
            V, planes, inflate = reduce_hull(P[g])
            worst = max(worst, inflate)
            G = P[g]
            rows = []
            for n, d in planes:  # round the normal, then re-seat d on the drawn vertices + 3 mm (rounding-safe)
                nr = np.round(n, 4)
                rows.append([float(t) for t in nr] + [math.ceil((max(d, float((G @ nr).max())) + 0.003) * 1e4) / 1e4])
            hulls.append({'verts': [r4(v) for v in V], 'planes': rows,
                          'min': r4(G.min(axis=0)), 'max': r4(G.max(axis=0))})
            print(f'  hull {len(hulls)}: {len(G)} pts -> {len(V)} verts, {len(planes)} planes, inflate {inflate:.3f} m')
        assert 1 <= len(hulls) <= MAX_HULLS, f'{key}: {len(hulls)} hulls'
        assert all(len(h['verts']) <= MAX_VERTS for h in hulls), key
        mn = np.min([h['min'] for h in hulls], axis=0)
        mx = np.max([h['max'] for h in hulls], axis=0)
        rxz = float(np.sqrt((P[:, 0] ** 2 + P[:, 2] ** 2).max()))
        data['pieces'][key] = {'hulls': hulls, 'min': r4(mn), 'max': r4(mx), 'radiusXZ': round(rxz + 0.05, 3),
                               'inflate': round(worst, 3)}
    data['pieces'] = {k: data['pieces'][k] for k in KIT_KEYS if k in data['pieces']}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {OUT}: {len(data["pieces"])} pieces')


try:
    main()
except Exception:
    import traceback
    traceback.print_exc()
    sys.exit(1)
