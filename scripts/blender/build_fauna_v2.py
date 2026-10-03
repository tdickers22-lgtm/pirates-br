# Fauna v2 — the hero shark, rebuilt as a LOFTED, SKINNED mesh (FAUNAGLB-01).
#
# WHAT WAS WRONG. build_animals.py's shark is a 1,972-tri union of twelve rigid
# blobs and plates whose "swimming" is three node rotations (assets-12). It is
# the single most-watched creature in the game — it swims at your face, in the
# dodge window, filling the screen — and it is the lowest-fidelity asset we own.
# Two specific ugly things a player sees today:
#   * the white belly is a SECOND icosphere pushed 7 cm down through the grey
#     hull, so the two surfaces interpenetrate along the whole flank — a moving
#     z-fight the moment the two get within depth precision;
#   * the tail is a rigid plate on a hinge, so the body stays a stiff torpedo
#     and only the very end wags. Sharks bend along their whole length.
#
# WHAT THIS BUILDS.
#   shark.glb      ~9k tris, ONE lofted fusiform (no interpenetrating belly:
#                  countershading is a material boundary along the lateral
#                  line, exactly where a real shark's is), smooth-shaded,
#                  skinned to a 9-bone armature (6 along the body + 2 pectorals
#                  + jaw) with `swim` and `bite` actions. export_skins=True.
#   shark_far.glb  ~2k tris, NOT skinned, carrying the four pivot node names
#                  build_animals.py used (shark_tail / shark_jaw /
#                  shark_pec_l / shark_pec_r) so the existing pivot animator
#                  drives it verbatim.
#
# WHY BOTH. SHARK.MAX_WORLD is 4, so the skinned hero costs 4 x 9k = 36k tris
# where the old puppet cost 4 x 2k = 8k. On the low tier that is a real bill for
# a creature that is usually a fin on the horizon. FaunaMeshFactory takes
# shark_far on `low` and keeps the pivot animator; balanced/high get the skinned
# hero. The far file is therefore a TIER GATE, not decoration: on low the
# triangle count and the shader variant are what they are today.
#
# The body keeps today's dimensions exactly (nose y=-1.70, caudal tip y=+1.75,
# max half-width 0.41 x 0.53, origin mid-body): SHARK colliders, the hull
# avoidance radius and Match's seating all measure the old numbers.
#
# 1 unit = 1 m; forward = -Y (= game +Z); Z up.
# Headless: /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_fauna_v2.py
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "/tmp/pbr-fauna-v2")

EXTRA = {
    "Shark_Grey":  ((0.28, 0.33, 0.40, 1.0), 0.85, 0.0),
    "Shark_Belly": ((0.88, 0.90, 0.92, 1.0), 0.85, 0.0),
    "Shark_Dark":  ((0.15, 0.18, 0.23, 1.0), 0.85, 0.0),
    "Mouth_Red":   ((0.42, 0.07, 0.07, 1.0), 0.90, 0.0),
    "Teeth_White": ((0.95, 0.93, 0.86, 1.0), 0.70, 0.0),
    "Eye_Black":   ((0.03, 0.03, 0.03, 1.0), 0.40, 0.0),
    "Beak_Yellow": ((0.86, 0.62, 0.12, 1.0), 0.50, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


# ── shared little builders (same conventions as build_animals.py) ────────────
def blob(coll, name, r, x, y, z, material, subdiv=2, scale=(1, 1, 1), rot=None):
    bm = bm_icosphere(r, subdiv)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def box(coll, name, w, d, h, x, y, z, material, rot=None):
    bm = bm_box(w, d, h)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material))


def seg(coll, name, p1, p2, r1, r2, material, segs=8):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, d.length, segs=segs)
    m = Matrix.Translation((p1 + p2) * 0.5) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def fin(coll, name, pts, thickness, material, matrix=None, plane='yz', cuts=0, smooth=True):
    """Thin solidified polygon plate. `cuts` subdivides it so a skinned fin
    bends with the body instead of shearing away from it at the root."""
    bm = bmesh.new()
    if plane == 'yz':
        vs = [bm.verts.new((0.0, p[0], p[1])) for p in pts]
    else:
        vs = [bm.verts.new((p[0], p[1], 0.0)) for p in pts]
    bm.faces.new(vs)
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thickness)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=m4(matrix), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=smooth)


def m4(m):
    return m


def repivot(obj, pivot):
    p = Vector(pivot)
    obj.data.transform(Matrix.Translation(-p))
    obj.location = p


# ── the fusiform loft ────────────────────────────────────────────────────────
# Half-width factor along the body axis. Keys are (t, f) with t = -1 at the nose
# tip and +1 at the caudal peduncle end; smoothstep between keys keeps the
# silhouette C1 so smooth normals have nothing to crease over.
PROFILE = [
    (-1.000, 0.000), (-0.955, 0.135), (-0.880, 0.300), (-0.760, 0.530),
    (-0.600, 0.760), (-0.420, 0.925), (-0.230, 1.000), (0.000, 0.980),
    (0.190, 0.905), (0.380, 0.790), (0.560, 0.620), (0.700, 0.420),
    (0.820, 0.235), (0.910, 0.130), (1.000, 0.082),
]


def profile(t):
    if t <= PROFILE[0][0]:
        return PROFILE[0][1]
    if t >= PROFILE[-1][0]:
        return PROFILE[-1][1]
    for i in range(len(PROFILE) - 1):
        ta, fa = PROFILE[i]
        tb, fb = PROFILE[i + 1]
        if ta <= t <= tb:
            u = (t - ta) / (tb - ta)
            u = u * u * (3.0 - 2.0 * u)
            return fa + (fb - fa) * u
    return PROFILE[-1][1]


BODY_Y0, BODY_Y1 = -1.70, 1.45     # nose tip .. peduncle end (unchanged size)
BODY_SX, BODY_SZ = 0.41, 0.53
BELLY_FLAT = 0.86
BELLY_NZ = -0.30                   # normal.z under which a face is countershaded


def build_body(coll, name, rings, radial, materials):
    """Lofted fusiform closed with a nose pole and a peduncle pole.
    materials = (grey, belly); faces are assigned by their averaged normal so
    the countershading boundary follows the lateral line and NOTHING
    interpenetrates (the old build had a second belly sphere inside the hull)."""
    bm = bmesh.new()
    loops = []
    for i in range(rings):
        t = i / (rings - 1) * 2.0 - 1.0
        y = BODY_Y0 + (t + 1.0) * 0.5 * (BODY_Y1 - BODY_Y0)
        f = profile(t)
        if f <= 1e-4:
            loops.append([bm.verts.new((0.0, y, 0.0))])
            continue
        ring = []
        for j in range(radial):
            a = j / radial * math.tau
            x = math.cos(a) * f * BODY_SX
            z = math.sin(a) * f * BODY_SZ
            if z < 0:
                z *= BELLY_FLAT
            # dorsal keel: a touch of squared-off back so the dorsal fin has a
            # base to sit on rather than a bare cylinder.
            ring.append(bm.verts.new((x, y, z)))
        loops.append(ring)
    for i in range(rings - 1):
        a, b = loops[i], loops[i + 1]
        if len(a) == 1:
            for j in range(radial):
                bm.faces.new((a[0], b[j], b[(j + 1) % radial]))
        elif len(b) == 1:
            for j in range(radial):
                bm.faces.new((a[j], a[(j + 1) % radial], b[0]))
        else:
            for j in range(radial):
                k = (j + 1) % radial
                bm.faces.new((a[j], a[k], b[k], b[j]))
    # cap the peduncle end (the caudal fin roots into it)
    if len(loops[-1]) > 1:
        bm.faces.new(tuple(loops[-1]))
    bm.normal_update()
    obj = obj_from_bmesh(name, bm, coll, mat(materials[0]), smooth=True)
    obj.data.materials.append(mat(materials[1]))
    for p in obj.data.polygons:
        p.material_index = 1 if p.normal.z < BELLY_NZ else 0
    return obj


# ── b5.2a: UVs, the painted atlas, lofted airfoil fins ──────────────────────
# characters-08: the 2026-09 shark read as "a lumpy grey slug with black card
# fins" and every other creature was a rigid untextured toy. Three tools fix it:
#   * every part gets UVs into ONE atlas per creature (body loft = cylindrical
#     unwrap, fins = chord x span rectangles with separate upper/lower halves,
#     small parts = flat colour swatches), so one PBR material draws the lot;
#   * the atlas is PAINTED here in numpy (deterministic seeds, no generator
#     output, no third-party pixels): counter-shading with a wavy lateral
#     boundary, dorsal darkening, mottling, gill slits as grooves in the
#     normal map, darker fin margins; baseColor + tangent normal + ORM;
#   * fins are LOFTED AIRFOILS (NACA 00xx thickness + optional camber) along
#     >= 6 span stations, with the root station sunk into the body and the
#     root thickness flared, so a fin is a thick blended limb, never a card.
import json
import numpy as np

exec(open(os.path.join(HERE, "_pbr.py")).read())

ATLAS_BODY_V = 0.62                 # body loft occupies v in [0, 0.62)
FIN_V0, FIN_V1 = 0.64, 0.94         # fin rectangles
SW_V0, SW_V1 = 0.955, 0.995         # swatch row
FIN_RECT = {"vert": ((0.0, 0.5), (0.0, 0.5)),            # (upper u0,w), (lower u0,w)
            "pair": ((0.5, 0.25), (0.75, 0.25))}
SWATCH = {"eye": 0, "mouth": 1, "teeth": 2, "belly": 3, "gill": 4, "beak": 5, "spot": 6, "leg": 7}
SWATCH_COL = {0: ((0.03, 0.03, 0.035), 0.12), 1: ((0.55, 0.22, 0.22), 0.60), 2: ((0.95, 0.93, 0.86), 0.35),
              3: ((0.93, 0.93, 0.92), 0.55), 4: ((0.12, 0.14, 0.17), 0.60), 5: ((0.95, 0.76, 0.22), 0.45),
              6: ((0.82, 0.16, 0.10), 0.45), 7: ((0.90, 0.64, 0.50), 0.60)}


def swatch_uv(i):
    return ((i + 0.5) / 8.0, (SW_V0 + SW_V1) * 0.5)


def uv_swatch(obj, key):
    """Every loop of `obj` samples one flat swatch tile."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    u, v = swatch_uv(SWATCH[key])
    for lp in me.uv_layers[0].data:
        lp.uv = (u, v)
    return obj


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def vnoise(rng, size, cells):
    """Value noise on [0,1)^2, tileable in u (columns)."""
    g = rng.random((cells + 1, cells + 1))
    g[:, cells] = g[:, 0]
    s = (np.arange(size) + 0.5) / size * cells
    i0 = np.floor(s).astype(int)
    f = s - i0
    f = f * f * (3.0 - 2.0 * f)
    a = g[i0][:, i0]
    b = g[i0][:, i0 + 1]
    c = g[i0 + 1][:, i0]
    d = g[i0 + 1][:, i0 + 1]
    fx = f[None, :]
    fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(rng, size, cells, octaves=4):
    out = np.zeros((size, size))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += vnoise(rng, size, cells * (2 ** o)) * amp
        tot += amp
        amp *= 0.5
    return out / tot


def paint_swatches(base, rough, height, S):
    v0, v1 = int(SW_V0 * S) - 2, int(SW_V1 * S) + 2
    for i, (col, r) in SWATCH_COL.items():
        u0, u1 = int(i / 8 * S), int((i + 1) / 8 * S)
        base[v0:v1, u0:u1] = col
        rough[v0:v1, u0:u1] = r
        height[v0:v1, u0:u1] = 0.0


def write_maps(name, base, rough, height, strength, out_dir):
    """baseColor (sRGB), tangent normal from `height` (OpenGL +Y), ORM (R=1: AO is the
    baked vertex colour, G roughness, B metal 0). Returns {basecolor, normal, orm} paths."""
    S = base.shape[0]
    os.makedirs(out_dir, exist_ok=True)
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    maps = {"basecolor": (np.clip(base, 0, 1), False),
            "normal": (n * 0.5 + 0.5, True),
            "orm": (np.stack([np.ones_like(rough), np.clip(rough, 0.05, 1), np.zeros_like(rough)], -1), True)}
    paths = {}
    for key, (rgb, data) in maps.items():
        img = _new_image(f"{name}_{key}", S, data)
        px = np.concatenate([rgb.reshape(-1, 3), np.ones((S * S, 1))], axis=1).astype(np.float32)
        img.pixels.foreach_set(px.ravel())
        path = os.path.join(out_dir, f"{name}_{key}.png")
        _save_png(img, path)
        bpy.data.images.remove(img)
        paths[key] = path
    return paths


def share_material(objs, paths, name):
    m = apply_baked(objs[0], paths, name)
    for o in objs[1:]:
        o.data.materials.clear()
        o.data.materials.append(m)
    for o in objs:
        for p in o.data.polygons:
            p.material_index = 0
    return m


def foil(coll, name, keys, stations=10, npts=10, camber=0.0, flare=0.8, sink=0.05,
         region="vert", up=(0.0, 0.0, 1.0), report=None):
    """A lofted airfoil limb. keys = [(s, le, te, thick_ratio)] with s 0 (root, at the
    body surface) .. 1 (tip). The root ring is pushed `sink` metres back INTO the
    body along the span and its thickness flared by (1 + flare), dying out by
    s ~ 0.3, so the fin grows out of the flank like a real one instead of being a
    plate glued on. Thickness direction = chord x span, signed toward `up`
    (the upper surface, which samples the region's upper rectangle)."""
    K = [(s, Vector(le), Vector(te), tr) for s, le, te, tr in keys]

    def at(s):
        s = min(max(s, 0.0), 1.0)
        for i in range(len(K) - 1):
            if K[i][0] <= s <= K[i + 1][0]:
                u = (s - K[i][0]) / (K[i + 1][0] - K[i][0])
                return (K[i][1].lerp(K[i + 1][1], u), K[i][2].lerp(K[i + 1][2], u),
                        K[i][3] + (K[i + 1][3] - K[i][3]) * u)
        return K[-1][1].copy(), K[-1][2].copy(), K[-1][3]

    mid0 = (K[0][1] + K[0][2]) * 0.5
    mid1 = (K[-1][1] + K[-1][2]) * 0.5
    span = (mid1 - mid0).normalized()
    upv = Vector(up)
    ss = [-1.0] + [i / (stations - 1) for i in range(stations)]
    bm = bmesh.new()
    rings, meta = [], {}
    root_thick = root_chord = 0.0
    for si, s in enumerate(ss):
        le, te, tr = at(s)
        if s < 0:
            le = le - span * sink
            te = te - span * sink
        f = 1.0
        if s > 0.72:
            f = math.sqrt(max(0.0036, 1.0 - ((s - 0.72) / 0.28) ** 2))
        p0 = le.lerp(te, 0.3)
        le = p0 + (le - p0) * f
        te = p0 + (te - p0) * f
        C = te - le
        cl = C.length
        n = C.cross(span)
        if n.length < 1e-9:
            n = upv.copy()
        n.normalize()
        if n.dot(upv) < 0:
            n = -n
        fl = 1.0 + flare * math.exp(-max(s, 0.0) / 0.10) * (1.1 if s < 0 else 1.0)
        thick = tr * fl
        if s == 0.0:
            root_thick, root_chord = thick * cl, cl
        ring = []
        pts = []
        for i in range(npts + 1):
            x = (1.0 - math.cos(math.pi * i / npts)) * 0.5
            pts.append((x, 1))
        for i in range(npts - 1, 0, -1):
            x = (1.0 - math.cos(math.pi * i / npts)) * 0.5
            pts.append((x, -1))
        for x, side in pts:
            yt = 5.0 * thick * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x * x
                                + 0.2843 * x ** 3 - 0.1036 * x ** 4)
            yc = camber * 4.0 * x * (1.0 - x)
            v = bm.verts.new(le + C * x + n * ((yc + side * yt) * cl))
            meta[v] = (x, side, max(s, 0.0))
            ring.append(v)
        rings.append(ring)
    R = len(rings[0])
    faces = []
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(R):
            k = (j + 1) % R
            faces.append(bm.faces.new((a[j], a[k], b[k], b[j])))
    for ring, s in ((rings[0], 0.0), (rings[-1], 1.0)):
        c = bm.verts.new(sum((v.co for v in ring), Vector()) / R)
        meta[c] = (0.35, 1, s)
        for j in range(R):
            faces.append(bm.faces.new((ring[j], ring[(j + 1) % R], c)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uvl = bm.loops.layers.uv.new("UVMap")
    rect = FIN_RECT[region]
    for f in bm.faces:
        sides = [meta[v][1] for v in f.verts if 0.02 < meta[v][0] < 0.98]
        side = 1 if not sides or sum(sides) >= 0 else -1
        u0, w = rect[0] if side > 0 else rect[1]
        for lp in f.loops:
            x, _sd, s = meta[lp.vert]
            lp[uvl].uv = (u0 + x * w, FIN_V0 + s * (FIN_V1 - FIN_V0))
    if report is not None:
        report[name] = {"rootThick": round(root_thick, 4), "rootChord": round(root_chord, 4),
                        "stations": stations, "camber": camber}
    return obj_from_bmesh(name, bm, coll, None, smooth=True)


def loft(coll, name, stations, radial, rings, a0=math.pi / 2):
    """Closed loft through (y, zc, rx, rz) stations (Catmull-Rom between them), poles
    at both ends, cylindrical UVs into the body band. Returns (obj, (y_min, y_max))."""
    P = [Vector(s) for s in stations]

    def cr(t):
        f = t * (len(P) - 1)
        i = min(int(f), len(P) - 2)
        u = f - i
        p0, p1, p2, p3 = P[max(i - 1, 0)], P[i], P[i + 1], P[min(i + 2, len(P) - 1)]
        return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                      + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)
    bm = bmesh.new()
    loops, meta = [], {}
    for i in range(rings):
        t = i / (rings - 1)
        y, zc, rx, rz = cr(t)
        if i in (0, rings - 1):
            v = bm.verts.new((0.0, y, zc))
            meta[v] = (None, t)
            loops.append([v])
            continue
        ring = []
        for j in range(radial):
            a = a0 + j / radial * math.tau
            v = bm.verts.new((math.cos(a) * max(rx, 1e-4), y, zc + math.sin(a) * max(rz, 1e-4)))
            meta[v] = (j, t)
            ring.append(v)
        loops.append(ring)
    return _close_loft(coll, name, bm, loops, meta, radial)


def _close_loft(coll, name, bm, loops, meta, radial):
    for i in range(len(loops) - 1):
        a, b = loops[i], loops[i + 1]
        if len(a) == 1:
            for j in range(radial):
                bm.faces.new((a[0], b[j], b[(j + 1) % radial]))
        elif len(b) == 1:
            for j in range(radial):
                bm.faces.new((a[j], a[(j + 1) % radial], b[0]))
        else:
            for j in range(radial):
                k = (j + 1) % radial
                bm.faces.new((a[j], a[k], b[k], b[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        js = [meta[v][0] for v in f.verts if meta[v][0] is not None]
        wrap = js and max(js) == radial - 1 and min(js) == 0
        jc = (sum(js) / len(js)) if js else 0.0
        for lp in f.loops:
            j, t = meta[lp.vert]
            if j is None:
                u = (jc + 0.5) / radial
            else:
                u = (radial if (wrap and j == 0) else j) / radial
            lp[uvl].uv = (u, t * ATLAS_BODY_V)
    return obj_from_bmesh(name, bm, coll, None, smooth=True)


# ── armature + skin ─────────────────────────────────────────────────────────
# head..tail chain (6) + two pectorals + jaw. Every bone points down +Y so a
# positive rotation.z is a yaw to the shark's left in every one of them.
BONES = [
    # name,      head,                 tail,                 parent,   connected
    ("root",     (0.0, -0.35, 0.00),   (0.0, 0.10, 0.00),    None,     False),
    ("head",     (0.0, -1.05, 0.00),   (0.0, -0.35, 0.00),   "root",   False),
    ("jaw",      (0.0, -1.12, -0.12),  (0.0, -1.46, -0.15),  "head",   False),
    ("spine1",   (0.0, 0.10, 0.00),    (0.0, 0.55, 0.00),    "root",   True),
    ("spine2",   (0.0, 0.55, 0.00),    (0.0, 1.00, 0.00),    "spine1", True),
    ("tail1",    (0.0, 1.00, 0.00),    (0.0, 1.38, 0.01),    "spine2", True),
    ("tail2",    (0.0, 1.38, 0.01),    (0.0, 1.72, 0.02),    "tail1",  True),
    ("pec_l",    (0.30, -0.55, -0.12), (0.78, -0.24, -0.20), "root",   False),
    ("pec_r",    (-0.30, -0.55, -0.12), (-0.78, -0.24, -0.20), "root",  False),
]

# Body-bone influence anchors along Y, in order. A vertex blends between the two
# it lies between with a smoothstep, so the skin has no crease at any joint.
CHAIN = [("head", -0.70), ("root", -0.125), ("spine1", 0.325),
         ("spine2", 0.775), ("tail1", 1.19), ("tail2", 1.55)]

PEC_ROOT = {"pec_l": Vector((0.30, -0.55, -0.12)), "pec_r": Vector((-0.30, -0.55, -0.12))}


def chain_weights(y):
    if y <= CHAIN[0][1]:
        return [(CHAIN[0][0], 1.0)]
    if y >= CHAIN[-1][1]:
        return [(CHAIN[-1][0], 1.0)]
    for i in range(len(CHAIN) - 1):
        na, ya = CHAIN[i]
        nb, yb = CHAIN[i + 1]
        if ya <= y <= yb:
            u = (y - ya) / (yb - ya)
            u = u * u * (3.0 - 2.0 * u)
            return [(na, 1.0 - u), (nb, u)]
    return [(CHAIN[-1][0], 1.0)]


def build_armature(coll, name="shark_rig"):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for bname, head, tail, parent, connected in BONES:
        eb = arm_data.edit_bones.new(bname)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        made[bname] = eb
    for bname, _h, _t, parent, connected in BONES:
        if parent:
            made[bname].parent = made[parent]
            made[bname].use_connect = connected
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
    return arm


def skin(obj, arm, mode="chain"):
    """Fill vertex groups analytically (no ARMATURE_AUTO operator: heat-map
    weighting is neither deterministic nor headless-safe), then bind."""
    for bname, _h, _t, _p, _c in BONES:
        if obj.vertex_groups.get(bname) is None:
            obj.vertex_groups.new(name=bname)
    me = obj.data
    for vi, v in enumerate(me.vertices):
        co = v.co
        if mode in ("pec_l", "pec_r"):
            d = (Vector((co.x, co.y, co.z)) - PEC_ROOT[mode]).length
            u = min(1.0, max(0.0, (d - 0.04) / 0.20))
            u = u * u * (3.0 - 2.0 * u)
            pairs = [(mode, u)]
            for bn, bw in chain_weights(co.y):
                pairs.append((bn, bw * (1.0 - u)))
        elif mode == "jaw":
            pairs = [("jaw", 1.0)]
        else:
            pairs = chain_weights(co.y)
        for bn, bw in pairs:
            if bw > 1e-4:
                obj.vertex_groups[bn].add([vi], bw, 'REPLACE')
    m = obj.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    obj.parent = arm


# ── actions ─────────────────────────────────────────────────────────────────
FPS = 24


def _pose(arm, poses, frame):
    for bname, rot in poses.items():
        pb = arm.pose.bones[bname]
        pb.rotation_euler = rot
        arm.keyframe_insert(data_path=f'pose.bones["{bname}"].rotation_euler', frame=frame)


def make_action(arm, name, frames):
    """frames = [(frame, {bone: (rx,ry,rz)})]. Built by keyframing with NO
    action assigned so Blender creates (and slots) a fresh one, which is then
    renamed and given a fake user; the glTF exporter walks bpy.data.actions."""
    arm.animation_data_create()
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    for frame, poses in frames:
        _pose(arm, poses, frame)
    act = arm.animation_data.action
    act.name = name
    act.use_fake_user = True
    # Blender 5's slotted actions have no `.fcurves` (channels live under
    # layers/strips/channelbags); the default BEZIER interpolation is what we
    # want anyway, so there is nothing to walk here.
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    return act


def swim_frames(amp=1.0):
    """One second of anguilliform travel: the wave runs nose-to-tail, amplitude
    growing aft. Loops exactly (frame 25 == frame 1)."""
    chain = [("head", 0.030, 0.00), ("root", 0.035, 0.12), ("spine1", 0.055, 0.26),
             ("spine2", 0.085, 0.42), ("tail1", 0.135, 0.60), ("tail2", 0.175, 0.78)]
    out = []
    for k in range(9):
        f = 1 + k * 3
        ph = k / 8.0
        poses = {}
        for bname, a, lag in chain:
            poses[bname] = (0.0, 0.0, math.sin((ph - lag) * math.tau) * a * amp)
        # pectorals ride a slower roll so they are never dead
        poses["pec_l"] = (0.0, math.sin(ph * math.tau) * 0.05, 0.0)
        poses["pec_r"] = (0.0, -math.sin(ph * math.tau) * 0.05, 0.0)
        poses["jaw"] = (0.0, 0.0, 0.0)
        out.append((f, poses))
    return out


def bite_frames():
    """0.75 s: rear back, gape, snap, recover. Frames 1..19."""
    def p(jaw, rear, flare, thrash):
        return {
            "jaw": (jaw, 0.0, 0.0),
            "head": (rear, 0.0, 0.0),
            "root": (rear * 0.4, 0.0, 0.0),
            "spine1": (0.0, 0.0, thrash * 0.4),
            "spine2": (0.0, 0.0, thrash * 0.7),
            "tail1": (0.0, 0.0, thrash),
            "tail2": (0.0, 0.0, thrash * 1.2),
            "pec_l": (0.0, flare, 0.0),
            "pec_r": (0.0, -flare, 0.0),
        }
    return [
        (1,  p(0.05, 0.00, 0.00, 0.00)),
        (5,  p(0.62, -0.16, 0.42, -0.16)),
        (8,  p(0.70, -0.20, 0.46, 0.10)),
        (11, p(0.02, 0.10, 0.10, 0.26)),
        (14, p(0.10, 0.04, 0.16, -0.12)),
        (19, p(0.05, 0.00, 0.00, 0.00)),
    ]


# ── export with skins + animations ──────────────────────────────────────────
def export_skinned(objs, filename):
    os.makedirs(EXPORT_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(EXPORT_DIR, filename)
    # export_apply MUST stay False: applying modifiers would evaluate the
    # armature away and ship a rigid mesh with a skeleton nothing is bound to.
    base = dict(filepath=path, export_format='GLB', use_selection=True,
                export_apply=False, export_yup=True,
                export_animations=True, export_skins=True, export_morph=False,
                export_extras=True)
    for extra in (
        {'export_vertex_color': 'ACTIVE', 'export_active_vertex_color_when_no_material': True},
        {'export_vertex_color': 'ACTIVE'},
        {},
    ):
        try:
            bpy.ops.export_scene.gltf(**base, **extra)
            print(f"EXPORTED {path} (vc opts: {list(extra) or 'defaults'})")
            return path
        except TypeError:
            continue
    raise RuntimeError('skinned gltf export failed for all kwarg variants')


def verify_skinned(path):
    """verify_glb + the two things that make this file worth building: does it
    carry skins, and which animations came out."""
    import json
    import struct
    info = verify_glb(path)
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        clen, _ = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(clen))
    skins = gltf.get('skins', [])
    anims = [a.get('name', '?') for a in gltf.get('animations', [])]
    joints = sum(len(s.get('joints', [])) for s in skins)
    skinned_prims = sum(
        1 for m in gltf.get('meshes', []) for p in m.get('primitives', [])
        if 'JOINTS_0' in p.get('attributes', {})
    )
    print(f"VERIFY-SKIN {os.path.basename(path)}: {len(skins)} skin(s), {joints} joints, "
          f"{skinned_prims} skinned prim(s), animations {anims}")
    info.update(skins=len(skins), joints=joints, animations=anims,
                skinned_prims=skinned_prims)
    return info


# ── shark_far: the low-tier / far puppet (rigid, pivot nodes) ───────────────
def build_shark_far(name="shark_far"):
    coll = asset_collection(name)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[coll.name])
    # Body stops at the peduncle so the caudal plate can hang off shark_tail.
    body = build_body(coll, "far_body", rings=34, radial=14,
                      materials=("Shark_Grey", "Shark_Belly"))
    parts = [body]
    parts.append(fin(coll, "dorsal", [(-0.52, 0.40), (0.26, 1.02), (0.34, 0.64), (0.16, 0.40)],
                     0.07, "Shark_Grey"))
    for sx in (-1, 1):
        parts.append(blob(coll, f"eye{sx}", 0.045, sx * 0.19, -1.25, 0.06, "Eye_Black", 1))
    parts.append(box(coll, "mouth_top", 0.20, 0.26, 0.02, 0, -1.26, -0.10, "Mouth_Red"))
    join(parts, "body")

    jaw = join([box(coll, "jaw_w", 0.20, 0.30, 0.07, 0, -1.26, -0.16, "Shark_Belly"),
                box(coll, "jaw_in", 0.17, 0.26, 0.02, 0, -1.25, -0.125, "Mouth_Red")],
               "shark_jaw")
    repivot(jaw, (0, -1.12, -0.12))

    tail = join([fin(coll, "caudal_up", [(1.22, 0.05), (1.58, 0.82), (1.72, 0.74), (1.44, -0.02)],
                     0.055, "Shark_Grey"),
                 fin(coll, "caudal_lo", [(1.26, 0.02), (1.58, -0.50), (1.70, -0.40), (1.46, 0.06)],
                     0.05, "Shark_Grey")], "shark_tail")
    repivot(tail, (0, 1.05, 0))

    for sx, pname in ((1, "shark_pec_l"), (-1, "shark_pec_r")):
        m = (Matrix.Translation((sx * 0.30, -0.55, -0.12)) @
             Matrix.Rotation(-sx * math.radians(26), 4, 'Y'))
        pec = fin(coll, pname,
                  [(0.0, -0.06), (sx * 0.50, 0.36), (sx * 0.56, 0.55), (sx * 0.10, 0.28)],
                  0.045, "Shark_Grey", matrix=m, plane='xy')
        repivot(pec, (sx * 0.30, -0.55, -0.12))

    bake_ao(coll, samples=10, floor=0.62, height_gradient=0.0)
    export_collection_vc(coll, f"{name}.glb")
    info = verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    assert info['tris'] <= 3200, f"shark_far is {info['tris']} tris, ceiling is 3200"
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    print(f"built {name}")
    return info


# ── shark: hero (skinned, textured, lofted fins) ────────────────────────────
def shark_body(coll, name, rings, radial):
    """The fusiform of build_body (same PROFILE, size and flattened belly), started at
    the dorsal midline so the UV seam runs down the back where the paint is uniform."""
    bm = bmesh.new()
    loops, meta = [], {}
    for i in range(rings):
        t = i / (rings - 1) * 2.0 - 1.0
        y = BODY_Y0 + (t + 1.0) * 0.5 * (BODY_Y1 - BODY_Y0)
        f = profile(t)
        if f <= 1e-4 or i == rings - 1:
            v = bm.verts.new((0.0, y, 0.0))
            meta[v] = (None, (t + 1) * 0.5)
            loops.append([v])
            continue
        ring = []
        for j in range(radial):
            a = math.pi / 2 + j / radial * math.tau
            z = math.sin(a) * f * BODY_SZ
            if z < 0:
                z *= BELLY_FLAT
            v = bm.verts.new((math.cos(a) * f * BODY_SX, y, z))
            meta[v] = (j, (t + 1) * 0.5)
            ring.append(v)
        loops.append(ring)
    return _close_loft(coll, name, bm, loops, meta, radial)


def surf(y, where):
    """A point on the shark's skin at body station y: 'top', 'bot', or ('flank', side, zfrac)."""
    t = (y - BODY_Y0) / (BODY_Y1 - BODY_Y0) * 2.0 - 1.0
    f = profile(t)
    if where == "top":
        return Vector((0.0, y, f * BODY_SZ))
    if where == "bot":
        return Vector((0.0, y, -f * BODY_SZ * BELLY_FLAT))
    _w, side, zf = where
    return Vector((side * f * BODY_SX * math.sqrt(max(0.0, 1 - zf * zf)), y, zf * f * BODY_SZ * BELLY_FLAT))


def paint_shark(S=512, seed=20260803):
    rng = np.random.default_rng(seed)
    base = np.zeros((S, S, 3))
    rough = np.full((S, S), 0.55)
    height = np.zeros((S, S))
    u = (np.arange(S) + 0.5) / S
    U, V = np.meshgrid(u, u)
    # body band
    t = np.clip(V / ATLAS_BODY_V, 0, 1) * 2 - 1
    a = math.pi / 2 + U * math.tau
    z, xs = np.sin(a), np.cos(a)
    low = fbm(rng, S, 4, 3)
    mott = fbm(rng, S, 24, 4)
    fine = fbm(rng, S, 96, 2)
    bz = -0.26 + 0.10 * (low - 0.5) + 0.03 * np.sin(t * 21.0 + U * 6.0)
    belly = smoothstep(-0.05, 0.05, bz - z)
    dors = smoothstep(0.25, 1.0, z)
    back = np.array([0.43, 0.48, 0.54]) * (1 - dors)[..., None] + np.array([0.29, 0.34, 0.40]) * dors[..., None]
    back = back * (0.90 + 0.18 * mott)[..., None]
    snout = smoothstep(-0.80, -1.0, t)[..., None] * 0.12
    col = back * (1 - snout) + np.array([0.93, 0.93, 0.92]) * belly[..., None] * (1 - snout)
    col = back * (1 - belly[..., None]) + np.array([0.93, 0.93, 0.92]) * (0.97 + 0.04 * fine)[..., None] * belly[..., None]
    # lateral line: a faint light thread from the gills to the peduncle
    lat = np.exp(-((z - (bz + 0.30)) / 0.012) ** 2) * smoothstep(-0.45, -0.3, t) * 0.06
    col += lat[..., None]
    h = 0.35 * fine + 0.15 * mott
    # five gill slits per flank: dark grooves, slightly raked
    for gy in (-0.72, -0.62, -0.52, -0.42, -0.32):
        tg = (gy - BODY_Y0) / (BODY_Y1 - BODY_Y0) * 2 - 1
        d = np.abs(t - tg - 0.015 * z) / 0.0055
        m = np.exp(-d * d) * (np.abs(xs) > 0.55) * smoothstep(-0.32, -0.18, z) * smoothstep(0.38, 0.22, z)
        col *= (1 - 0.62 * m)[..., None]
        h -= 2.2 * m
    body = V < ATLAS_BODY_V + 0.005
    base[body] = col[body]
    rough[body] = (0.50 + 0.08 * belly + 0.06 * mott)[body]
    height[body] = h[body]
    # fin rectangles
    fin = (V >= FIN_V0 - 0.005) & (V <= FIN_V1 + 0.005)
    s = np.clip((V - FIN_V0) / (FIN_V1 - FIN_V0), 0, 1)
    for u0, w, lower in ((0.0, 0.5, False), (0.5, 0.25, False), (0.75, 0.25, True)):
        r = fin & (U >= u0) & (U < u0 + w)
        x = np.clip((U - u0) / w, 0, 1)
        edge = np.clip(0.55 * smoothstep(0.80, 1.0, x) + 0.45 * smoothstep(0.75, 1.0, s), 0, 0.7)
        c = np.array([0.40, 0.45, 0.51]) * (0.92 + 0.14 * mott)[..., None]
        if lower:
            c = c * 0.35 + np.array([0.90, 0.90, 0.89]) * 0.65
        c = c * (1 - 0.55 * edge)[..., None]
        base[r] = c[r]
        rough[r] = 0.52
        height[r] = (0.25 * fine + 0.12 * np.sin(x * 70.0) * (1 - s))[r]
    paint_swatches(base, rough, height, S)
    return base, rough, height


def build_shark_hero(name="shark"):
    coll = asset_collection(name)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[coll.name])
    fins = {}
    body = shark_body(coll, "shark_body", rings=100, radial=32)
    trim = []
    T = surf
    # first dorsal: tall, swept, recurved trailing edge; symmetric section
    trim.append(foil(coll, "dorsal", [
        (0.0, T(-0.50, "top"), T(0.16, "top"), 0.15),
        (0.55, (0.0, -0.06, 0.82), (0.0, 0.27, 0.71), 0.12),
        (1.0, (0.0, 0.22, 1.02), (0.0, 0.31, 0.99), 0.08)], stations=10, npts=10, up=(1, 0, 0), report=fins))
    trim.append(foil(coll, "dorsal2", [
        (0.0, T(0.80, "top"), T(0.98, "top"), 0.14),
        (1.0, T(0.96, "top") + Vector((0, 0, 0.17)), T(1.00, "top") + Vector((0, 0, 0.15)), 0.08)],
        stations=6, npts=8, up=(1, 0, 0), report=fins))
    trim.append(foil(coll, "anal", [
        (0.0, T(0.72, "bot"), T(0.92, "bot"), 0.14),
        (1.0, T(0.90, "bot") - Vector((0, 0, 0.16)), T(0.95, "bot") - Vector((0, 0, 0.14)), 0.08)],
        stations=6, npts=8, up=(1, 0, 0), report=fins))
    for sx in (-1, 1):
        r0, r1 = T(0.18, ("flank", sx, -0.85)), T(0.40, ("flank", sx, -0.85))
        trim.append(foil(coll, f"pelvic{sx}", [
            (0.0, r0, r1, 0.14),
            (1.0, r0 + Vector((sx * 0.20, 0.24, -0.14)), r1 + Vector((sx * 0.20, 0.08, -0.13)), 0.08)],
            stations=6, npts=8, camber=0.03, region="pair", report=fins))
    trim.append(foil(coll, "caudal_up", [
        (0.0, (0.0, 1.22, 0.07), (0.0, 1.47, 0.01), 0.14),
        (0.5, (0.0, 1.40, 0.46), (0.0, 1.62, 0.37), 0.10),
        (1.0, (0.0, 1.58, 0.84), (0.0, 1.70, 0.78), 0.07)], stations=10, npts=10, sink=0.04,
        up=(1, 0, 0), report=fins))
    trim.append(foil(coll, "caudal_lo", [
        (0.0, (0.0, 1.27, -0.01), (0.0, 1.48, 0.03), 0.14),
        (0.5, (0.0, 1.42, -0.26), (0.0, 1.59, -0.20), 0.10),
        (1.0, (0.0, 1.58, -0.50), (0.0, 1.70, -0.42), 0.07)], stations=8, npts=10, sink=0.04,
        up=(1, 0, 0), report=fins))
    for sx in (-1, 1):
        trim.append(uv_swatch(blob(coll, f"eye{sx}", 0.045, sx * 0.19, -1.25, 0.06, "Eye_Black", 2), "eye"))
    trim.append(uv_swatch(box(coll, "mouth_top", 0.21, 0.27, 0.02, 0, -1.26, -0.105, "Mouth_Red"), "mouth"))
    for i in range(7):
        trim.append(uv_swatch(box(coll, f"utooth{i}", 0.024, 0.024, 0.042,
                                  -0.09 + i * 0.03, -1.375, -0.115, "Teeth_White"), "teeth"))
    body = join([body] + trim, "shark_body")

    jaw_parts = [uv_swatch(box(coll, "jaw_w", 0.21, 0.31, 0.07, 0, -1.26, -0.165, "Shark_Belly"), "belly"),
                 uv_swatch(box(coll, "jaw_in", 0.18, 0.27, 0.02, 0, -1.25, -0.128, "Mouth_Red"), "mouth")]
    for i in range(7):
        jaw_parts.append(uv_swatch(box(coll, f"jtooth{i}", 0.023, 0.023, 0.046,
                                       -0.087 + i * 0.029, -1.395, -0.127, "Teeth_White"), "teeth"))
    jaw = join(jaw_parts, "shark_jawmesh")

    pecs = {}
    for sx, key in ((1, "pec_l"), (-1, "pec_r")):
        pecs[key] = foil(coll, f"shark_{key}", [
            (0.0, (sx * 0.31, -0.72, -0.14), (sx * 0.31, -0.36, -0.14), 0.15),
            (0.6, (sx * 0.62, -0.42, -0.27), (sx * 0.62, -0.22, -0.26), 0.11),
            (1.0, (sx * 0.86, -0.14, -0.37), (sx * 0.86, -0.08, -0.36), 0.08)],
            stations=10, npts=10, camber=0.04, region="pair", report=fins)

    bake_ao(coll, samples=12, floor=0.62, height_gradient=0.0)
    paths = write_maps("shark", *paint_shark(), strength=3.0, out_dir=os.path.join(RENDER_DIR, "tex"))
    share_material([body, jaw] + list(pecs.values()), paths, "shark")

    arm = build_armature(coll)
    skin(body, arm, "chain")
    skin(jaw, arm, "jaw")
    for key, obj in pecs.items():
        skin(obj, arm, key)

    make_action(arm, "swim", swim_frames())
    make_action(arm, "bite", bite_frames())
    bpy.context.scene["fins"] = json.dumps(fins)

    objs = [arm, body, jaw] + list(pecs.values())
    path = export_skinned(objs, f"{name}.glb")
    info = verify_skinned(path)
    assert 8000 <= info['tris'] <= 12000, f"shark hero is {info['tris']} tris, band is 8000-12000"
    assert info['skins'] >= 1 and info['skinned_prims'] >= 1, "shark hero exported without skins"
    assert set(info['animations']) >= {"swim", "bite"}, f"actions missing: {info['animations']}"
    if os.environ.get('BR_FAUNA_RENDER'):
        quick_render(objs, name, (4.2, -3.2, 1.6), (0, 0, 0.1))
    del bpy.context.scene["fins"]
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    print(f"built {name} fins={json.dumps(fins)}")
    return info


# ── gull: 6-bone skinned bird (b5.2a) ───────────────────────────────────────
GULL_BONES = [
    ("body",      (0.0, 0.12, 0.20),     (0.0, -0.04, 0.20),   None,     False),
    ("head",      (0.0, -0.09, 0.225),   (0.0, -0.20, 0.27),   "body",   False),
    ("wing_l",    (0.055, 0.0, 0.238),   (0.30, 0.0, 0.252),   "body",   False),
    ("wingtip_l", (0.30, 0.0, 0.252),    (0.64, 0.05, 0.255),  "wing_l", True),
    ("wing_r",    (-0.055, 0.0, 0.238),  (-0.30, 0.0, 0.252),  "body",   False),
    ("wingtip_r", (-0.30, 0.0, 0.252),   (-0.64, 0.05, 0.255), "wing_r", True),
]


def build_rig(coll, name, bones):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for bname, head, tail, parent, connected in bones:
        eb = arm_data.edit_bones.new(bname)
        eb.head, eb.tail = Vector(head), Vector(tail)
        eb.align_roll(Vector((0.0, 0.0, 1.0)))   # local Z = world up on every bone
        made[bname] = eb
    for bname, _h, _t, parent, connected in bones:
        if parent:
            made[bname].parent = made[parent]
            made[bname].use_connect = connected
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
    return arm


def gull_weights(co):
    ax = abs(co.x)
    side = "l" if co.x >= 0 else "r"
    if co.z > 0.17 and ax > 0.045 and -0.09 < co.y < 0.12:      # wing territory
        w = float(smoothstep(0.050, 0.105, ax))
        tip = float(smoothstep(0.26, 0.34, ax))
        return [("body", 1 - w), (f"wing_{side}", w * (1 - tip)), (f"wingtip_{side}", w * tip)]
    h = float(smoothstep(-0.075, -0.135, co.y))
    return [("body", 1 - h), ("head", h)]


def skin_with(obj, arm, bones, fn):
    for b in bones:
        if obj.vertex_groups.get(b[0]) is None:
            obj.vertex_groups.new(name=b[0])
    for vi, v in enumerate(obj.data.vertices):
        for bn, bw in fn(v.co):
            if bw > 1e-4:
                obj.vertex_groups[bn].add([vi], bw, 'REPLACE')
    m = obj.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    obj.parent = arm


def make_action_s(arm, name, frames):
    """make_action with scale: poses map bone -> (rot) or ((rot), (scale)); every bone is
    keyed every key (rot + scale) so a crossfade never inherits another clip's fold."""
    arm.animation_data_create()
    arm.animation_data.action = None
    for frame, poses in frames:
        for pb in arm.pose.bones:
            val = poses.get(pb.name, (0.0, 0.0, 0.0))
            rot, scl = (val if isinstance(val[0], tuple) else (val, (1.0, 1.0, 1.0)))
            pb.rotation_euler = rot
            pb.scale = scl
            arm.keyframe_insert(data_path=f'pose.bones["{pb.name}"].rotation_euler', frame=frame)
            arm.keyframe_insert(data_path=f'pose.bones["{pb.name}"].scale', frame=frame)
    act = arm.animation_data.action
    act.name = name
    act.use_fake_user = True
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)
    return act


def gull_flap():
    """3 Hz powered flight (8 frames at 24 fps): the hand lags the arm, sweeps back on
    the upstroke, the body bobs and the head stays level."""
    out = []
    for k in range(9):
        ph = k / 8.0 * math.tau
        rx = 0.10 + 0.62 * math.sin(ph)
        tw = 0.10 * math.cos(ph)
        sw = 0.14 * max(0.0, -math.sin(ph))
        tip = 0.38 * math.sin(ph - 0.7)
        out.append((1 + k, {
            "body": (-0.04 * math.sin(ph), 0.0, 0.0), "head": (0.04 * math.sin(ph), 0.0, 0.0),
            "wing_l": (rx, tw, 0.5 * sw), "wing_r": (rx, -tw, -0.5 * sw),
            "wingtip_l": (tip, 0.0, sw), "wingtip_r": (tip, 0.0, -sw)}))
    return out


def gull_glide():
    """1.33 s soar: slight dihedral, the hands trim, the head scans."""
    out = []
    for k in range(9):
        ph = k / 8.0 * math.tau
        out.append((1 + k * 4, {
            "body": (0.0, 0.05 * math.sin(ph), 0.0), "head": (0.0, 0.0, 0.22 * math.sin(ph)),
            "wing_l": (0.07 + 0.025 * math.sin(ph), 0.03 * math.sin(ph), 0.0),
            "wing_r": (0.07 + 0.025 * math.sin(ph), -0.03 * math.sin(ph), 0.0),
            "wingtip_l": (-0.06 + 0.03 * math.sin(ph - 0.8), 0.0, 0.0),
            "wingtip_r": (-0.06 + 0.03 * math.sin(ph - 0.8), 0.0, 0.0)}))
    return out


def fold_rot(arm, bname, span, normal):
    """Pose euler (bone-local XYZ) that lays a wing bone's span along `span` with its
    upper surface (bone +Z) facing `normal`, both in armature space. Solved from the
    rest matrix, so no hand-derived axis conventions can invert it."""
    B = arm.data.bones[bname].matrix_local.to_3x3()
    y = Vector(span).normalized()
    z = Vector(normal)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    D = Matrix((x, y, z)).transposed()
    e = (B.transposed() @ D).to_euler('XYZ')
    return (e.x, e.y, e.z)


def gull_idle(arm):
    """2 s perched: wings folded back along the flanks (span swept back and a little
    down, upper surface out and up), the hand folded under to half length,
    breathing, head looking about."""
    fl = (fold_rot(arm, "wing_l", (0.20, 1.0, -0.12), (1.0, -0.15, 0.55)), (1.0, 1.0, 1.0))
    fr = (fold_rot(arm, "wing_r", (-0.20, 1.0, -0.12), (-1.0, -0.15, 0.55)), (1.0, 1.0, 1.0))
    out = []
    for k in range(9):
        ph = k / 8.0 * math.tau
        out.append((1 + k * 6, {
            "body": (0.015 * math.sin(2 * ph), 0.0, 0.0),
            "head": (-0.08 + 0.08 * math.sin(2 * ph), 0.0, 0.40 * math.sin(ph)),
            "wing_l": fl, "wing_r": fr,
            "wingtip_l": ((0.0, 0.0, 0.0), (1.0, 0.5, 1.0)),
            "wingtip_r": ((0.0, 0.0, 0.0), (1.0, 0.5, 1.0))}))
    return out


GULL_STATIONS = [  # (y, zc, rx, rz): beak base .. tail
    (-0.222, 0.262, 0.0, 0.0), (-0.215, 0.263, 0.026, 0.024), (-0.195, 0.268, 0.040, 0.040),
    (-0.170, 0.270, 0.047, 0.048), (-0.145, 0.263, 0.044, 0.046), (-0.118, 0.247, 0.037, 0.041),
    (-0.092, 0.232, 0.046, 0.051), (-0.060, 0.213, 0.070, 0.070), (-0.020, 0.199, 0.085, 0.081),
    (0.030, 0.196, 0.084, 0.077), (0.080, 0.201, 0.074, 0.065), (0.130, 0.206, 0.057, 0.049),
    (0.180, 0.209, 0.038, 0.031), (0.215, 0.210, 0.022, 0.016), (0.235, 0.210, 0.0, 0.0),
]


def paint_gull(S=256, seed=20260804):
    rng = np.random.default_rng(seed)
    base = np.zeros((S, S, 3))
    rough = np.full((S, S), 0.7)
    height = np.zeros((S, S))
    u = (np.arange(S) + 0.5) / S
    U, V = np.meshgrid(u, u)
    fine = fbm(rng, S, 48, 3)
    t = np.clip(V / ATLAS_BODY_V, 0, 1)
    z = np.sin(math.pi / 2 + U * math.tau)
    mantle = smoothstep(0.45, 0.75, z) * smoothstep(0.38, 0.45, t) * smoothstep(0.92, 0.80, t)
    white = np.array([0.95, 0.95, 0.94])
    grey = np.array([0.66, 0.70, 0.76])
    col = white * (1 - mantle[..., None]) + grey * mantle[..., None]
    col *= (0.95 + 0.07 * fine)[..., None]
    body = V < ATLAS_BODY_V + 0.005
    base[body] = col[body]
    height[body] = (0.5 * fine)[body]
    s = np.clip((V - FIN_V0) / (FIN_V1 - FIN_V0), 0, 1)
    fin = (V >= FIN_V0 - 0.005) & (V <= FIN_V1 + 0.005)
    for u0, w, lower in ((0.0, 0.5, False), (0.5, 0.25, False), (0.75, 0.25, True)):
        r = fin & (U >= u0) & (U < u0 + w)
        x = np.clip((U - u0) / w, 0, 1)
        tipb = smoothstep(0.74, 0.80, s)
        mirror = np.exp(-(((s - 0.93) / 0.035) ** 2 + ((x - 0.45) / 0.12) ** 2))
        trail = smoothstep(0.82, 0.92, x) * (1 - tipb)
        c = (np.array([0.88, 0.89, 0.90]) if lower else grey) * (0.96 + 0.06 * fine)[..., None]
        c = c * (1 - trail[..., None]) + white * trail[..., None]
        blk = np.array([0.07, 0.07, 0.08]) * (1 - mirror[..., None]) + white * mirror[..., None]
        c = c * (1 - tipb[..., None]) + blk * tipb[..., None]
        base[r] = c[r]
        rough[r] = 0.62
        height[r] = (0.4 * np.abs(np.sin(s * 80.0 + x * 3.0)) * smoothstep(0.5, 1.0, x) + 0.2 * fine)[r]
    paint_swatches(base, rough, height, S)
    return base, rough, height


def build_gull(name="gull"):
    coll = asset_collection(name)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[coll.name])
    body = loft(coll, "gull_body", GULL_STATIONS, radial=20, rings=40)
    parts = [body]
    # beak: tapered, hooked tip (upper mandible), yellow
    bk = loft(coll, "beak", [(-0.300, 0.246, 0.0, 0.0), (-0.290, 0.250, 0.005, 0.008),
                             (-0.270, 0.254, 0.008, 0.011), (-0.245, 0.259, 0.011, 0.014),
                             (-0.215, 0.263, 0.017, 0.017)], radial=10, rings=8)
    parts.append(uv_swatch(bk, "beak"))
    for sx in (-1, 1):
        parts.append(uv_swatch(blob(coll, f"geye{sx}", 0.011, sx * 0.040, -0.188, 0.282, "Eye_Black", 1), "eye"))
        parts.append(uv_swatch(seg(coll, f"gleg{sx}", (sx * 0.033, 0.035, 0.150), (sx * 0.033, 0.035, 0.0),
                                   0.009, 0.007, "Beak_Yellow", 6), "leg"))
        parts.append(uv_swatch(box(coll, f"gfoot{sx}", 0.045, 0.06, 0.010, sx * 0.033, 0.012, 0.006,
                                   "Beak_Yellow"), "leg"))
    parts.append(foil(coll, "tail", [
        (0.0, (-0.040, 0.165, 0.214), (0.040, 0.165, 0.214), 0.12),
        (1.0, (-0.060, 0.305, 0.206), (0.060, 0.305, 0.206), 0.06)], stations=6, npts=8, flare=0.4,
        sink=0.03, region="pair", up=(0, 0, 1)))
    for sx in (-1, 1):
        parts.append(foil(coll, f"wing{sx}", [
            (0.0, (sx * 0.055, -0.075, 0.240), (sx * 0.055, 0.075, 0.236), 0.12),
            (0.42, (sx * 0.30, -0.070, 0.255), (sx * 0.30, 0.070, 0.250), 0.09),
            (1.0, (sx * 0.64, 0.030, 0.255), (sx * 0.64, 0.075, 0.250), 0.05)],
            stations=12, npts=10, camber=0.06, flare=0.5, sink=0.03, region="pair", up=(0, 0, 1)))
    gull = join(parts, "gull_body")
    bake_ao(coll, samples=10, floor=0.66, height_gradient=0.0)
    paths = write_maps("gull", *paint_gull(), strength=2.0, out_dir=os.path.join(RENDER_DIR, "tex"))
    share_material([gull], paths, "gull")
    arm = build_rig(coll, "gull_rig", GULL_BONES)
    skin_with(gull, arm, GULL_BONES, gull_weights)
    make_action_s(arm, "flap", gull_flap())
    make_action_s(arm, "glide", gull_glide())
    make_action_s(arm, "idle", gull_idle(arm))
    objs = [arm, gull]
    path = export_skinned(objs, f"{name}.glb")
    info = verify_skinned(path)
    assert 2500 <= info['tris'] <= 4000, f"gull is {info['tris']} tris, band is 2500-4000"
    assert info['joints'] == 6, f"gull rig has {info['joints']} joints"
    assert set(info['animations']) >= {"flap", "glide", "idle"}, f"actions missing: {info['animations']}"
    if os.environ.get('BR_FAUNA_RENDER'):
        quick_render(objs, name, (0.9, -1.0, 0.75), (0, 0, 0.2), action="idle", frame=1)
        quick_render(objs, name + "_flap", (0.9, -1.0, 0.75), (0, 0, 0.2), action="flap", frame=3)
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    print(f"built {name}")
    return info


def quick_render(objs, name, cam_pos, target, action=None, frame=1):
    """Workbench, textured, 640x400: art check only (COMMON.md: <= 960x540)."""
    sc = bpy.context.scene
    arm = objs[0]
    if action:
        arm.animation_data_create()
        arm.animation_data.action = bpy.data.actions[action]
        try:
            arm.animation_data.action_slot = bpy.data.actions[action].slots[0]
        except Exception:
            pass
        sc.frame_set(frame)
    cam = bpy.data.objects.new("qcam", bpy.data.cameras.new("qcam"))
    sc.collection.objects.link(cam)
    cam.location = cam_pos
    cam.rotation_euler = (Vector(target) - Vector(cam_pos)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 640, 400
    os.makedirs(RENDER_DIR, exist_ok=True)
    sc.render.filepath = os.path.join(RENDER_DIR, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    if action:
        arm.animation_data.action = None


clear_default_scene()
hero = build_shark_hero()
gull = build_gull()
far = build_shark_far() if os.environ.get('BR_FAUNA_FAR') else {'tris': 'kept'}
print(f"FAUNA V2 DONE hero={hero['tris']} gull={gull['tris']} far={far['tris']} "
      f"joints={hero['joints']}/{gull['joints']} anims={hero['animations']}/{gull['animations']}")
