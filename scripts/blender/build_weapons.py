# HERO WEAPONS v2 (b3.4f: assets-04, assets-05, assets-02) — cutlass, flintlock,
# flintknock, eye_of_reach, blunderbuss as authored PBR GLBs.
#
# WHAT CHANGED FROM v1. v1 was a port of the THREE primitive union: the cutlass
# blade was three tilted boxes (a stair-stepped, kinked silhouette at 40 cm),
# the flintknock was the musket builder with a 0.34 m shoulder stock that the
# client shrank by 0.5 to fit a pistol envelope, and every file was one flat
# 512^2 albedo on a doubleSided metallic-0 material. v2:
#   * cutlass: ONE lofted blade on a curved spine (>= 100 stations, ~0.9 cm
#     apart), distal taper 6.2 -> 2.2 mm, a bevelled cutting-edge loop, a real
#     fuller groove that fades out before the point; a swept knuckle bow, an
#     oval shell guard, a rear quillon curl, an oval grip under a two-strand
#     wire wrap, brass ferrules and a peened pommel.
#   * flintknock: a true one-handed sea-service pistol, 0.52 m, bird-head grip
#     at ~115 degrees to the bore, lock plate + cock + frizzen + pan, belt hook,
#     ramrod pipe, brass butt cap and nose cap. Authored at a size the shipped
#     heroWeaponFit lands in [0.85, 1.15] (the primitive envelope is 0.569 m,
#     so a 0.40-0.46 m pistol would be fitted at 1.24-1.42: see the b3.4 report).
#   * flintlock / eye_of_reach / blunderbuss: one lofted stock (butt, wrist,
#     lock panel, fore-end), octagon-to-round barrels with a baluster ring and a
#     hollow crowned (or belled) muzzle, oval barrel bands, the same lock.
#   * every file: PolyHaven CC0 sources (TEXTURE_LICENSES.md) baked through
#     _atlas.pbr_atlas into ONE single-sided material with baseColor + normal +
#     ORM (metal charts metalness 1.0), LOD0 in the D27 fp-weapons band
#     18-30k tris. LOD1/LOD2/far come from build_lods.py (BR_LODS_ONLY=<keys>).
#
# FRAME (game space; must match the procedural fallback's frame):
#   origin = the GRIP (hand anchor); guns point +Z, sights up +Y, lock plate +X;
#   the cutlass blade runs up +Y.  Blender: game +Z = -Y, game +Y = +Z (yup export).
# NODE NAMES ARE AN API: `hammer`, `trigger`, `muzzle` (guns), `scope` (eye of
# reach, ViewmodelController.eorKeepInScope), `blade` (cutlass, graded by
# test-hero-assets [l]); everything else joins into `<name>_body`.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_weapons.py
#   env WEAPONS_ONLY=cutlass,flintknock  WEAPONS_OUT=/tmp/dir  WEAPONS_DENSITY=1.0
import os
import sys
import math
import json
import struct
import bpy
import bmesh
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
exec(open(os.path.join(HERE, '_helpers.py')).read())
import _hires as H  # noqa: E402
import _pbr as P  # noqa: E402
import _atlas as A  # noqa: E402

OUT = os.environ.get('WEAPONS_OUT') or EXPORT_DIR  # noqa: F821 (from _helpers)
ONLY = {s.strip() for s in os.environ.get('WEAPONS_ONLY', '').split(',') if s.strip()}
DENSITY = float(os.environ.get('WEAPONS_DENSITY', '1.0'))
BAND = (18000, 30000)  # D27 fp-weapons, test-asset-tiers TIERS['fp-weapons'].band
SAMPLES = int(os.environ.get('WEAPONS_SAMPLES', '16'))
SOURCES = ['metal_plate', 'walnut_veneer', 'brown_leather']

clear_default_scene()  # noqa: F821


def seg(n):
    """Round segment count, a multiple of 4 inside _hires' [12, 96]."""
    return max(12, min(96, int(round(n * DENSITY / 4.0)) * 4))


def st(n):
    return max(4, int(round(n * DENSITY)))


def G(x, y, z):
    return Vector((x, -z, y))


AX = {'y': Matrix.Identity(4), 'z': Matrix.Rotation(math.radians(90), 4, 'X'),
      'x': Matrix.Rotation(math.radians(90), 4, 'Y')}


def xf(o, M):
    o.data.transform(M)
    o.data.update()
    return o


def lerp(a, b, t):
    return a + (b - a) * t


def ease(t):
    return t * t * (3 - 2 * t)


# ── materials (PolyHaven CC0 sources, baked into one atlas per weapon) ────
MATS = {
    'steel': P.metal_material('W_Steel', 'metal_plate', 'steel', scale=2.5, tint=(0.86, 0.89, 0.92), wear=0.35),
    'iron': P.metal_material('W_Iron', 'metal_plate', 'iron', scale=2.5, tint=(0.34, 0.35, 0.37), wear=0.30),
    'brass': P.metal_material('W_Brass', 'metal_plate', 'brass', scale=2.5, tint=(0.95, 0.72, 0.36), wear=0.35),
    'walnut': P.source_material('W_Walnut', 'walnut_veneer', scale=1.2, tint=(0.70, 0.50, 0.38), wear=0.12),
    'leather': P.source_material('W_Leather', 'brown_leather', scale=1.6, wear=0.10),
    'glass': P.source_material('W_Glass', 'metal_plate', tint=(0.10, 0.20, 0.27), metallic=0.0, roughness=0.08),
    'flint': P.source_material('W_Flint', 'metal_plate', tint=(0.30, 0.28, 0.25), metallic=0.0, roughness=0.55),
}
for m in (MATS['brass'], MATS['walnut']):
    for n in m.node_tree.nodes:
        if n.bl_idname == 'ShaderNodeMix':
            a = [l.to_socket.type for l in m.node_tree.links if l.to_node == n and l.to_socket.name == 'A']
            print(f'MIXCHECK {m.name} {n.blend_type}: A linked as {a}')


# ── game-space primitives ───────────────────────────────────
def lathe(coll, name, prof, axis, at, mat, segs=48, **kw):
    o = H.lathe(name, prof, seg(segs), collection=coll, material=MATS[mat], **kw)
    return xf(o, Matrix.Translation(G(*at)) @ AX[axis])


def lathe_dir(coll, name, prof, d_game, at, mat, segs=48, **kw):
    o = H.lathe(name, prof, seg(segs), collection=coll, material=MATS[mat], **kw)
    q = Vector((0, 0, 1)).rotation_difference(G(*d_game).normalized())
    return xf(o, Matrix.Translation(G(*at)) @ q.to_matrix().to_4x4())


def loft(coll, name, pts, section, mat, scales=None):
    return H.loft(name, [G(*p) for p in pts], section, scales=scales, collection=coll, material=MATS[mat])


def loft_var(coll, name, pts, sections, mat):
    """Loft with a different (same-length) section per station."""
    path, frames = H._frames([G(*p) for p in pts])
    bm = bmesh.new()
    rings = []
    for p, (t, nrm, bi), sec in zip(path, frames, sections):
        rings.append([bm.verts.new(p + nrm * x + bi * y) for (x, y) in sec])
    m = len(sections[0])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(m):
            j = (k + 1) % m
            bm.faces.new((a[k], a[j], b[j], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    o = H._finish(name, bm, coll, MATS[mat], True)
    o.data.set_sharp_from_angle(angle=math.radians(40))
    return o


def bez(p0, p1, p2, p3, n):
    return [tuple(v) for v in H.bezier(p0, p1, p2, p3, n)]


def catmull(knots, n):
    """Catmull-Rom through game-space knots, n stations per span; returns (points, knot param)."""
    K = [Vector(k) for k in knots]
    K = [K[0] + (K[0] - K[1])] + K + [K[-1] + (K[-1] - K[-2])]
    pts, par = [], []
    spans = len(knots) - 1
    for s in range(spans):
        p0, p1, p2, p3 = K[s:s + 4]
        for k in range(n + (1 if s == spans - 1 else 0)):
            t = k / n
            pts.append(tuple(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                                    + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)))
            par.append(s + t)
    return pts, par


def ring_prof(r_in, r_out, z0, z1):
    return [(r_in, z0), (r_out - 0.0008, z0), (r_out, z0 + 0.0008), (r_out, z1 - 0.0008),
            (r_out - 0.0008, z1), (r_in, z1)]


def ellipse(ax, ay):
    return lambda i, t, r, z: r / math.sqrt((math.cos(t) / ax) ** 2 + (math.sin(t) / ay) ** 2)


RR = H.rounded_rect(1.0, 1.0, 0.42, corner_segments=5)


def outline(length, height, n=40, tail=0.45):
    """Teardrop lock-plate outline in (up, forward) section coordinates, blunt end forward."""
    out = []
    for k in range(n):
        th = 2 * math.pi * k / n
        f = math.cos(th)
        out.append((-height / 2 * math.sin(th) * ((1 - tail) + tail * (1 + f) / 2), length / 2 * f))
    return out


# ── cutlass ─────────────────────────────────────────────────
BLADE_TOP = [(1.00, 0.50), (0.95, 0.92), (0.82, 1.0), (0.62, 1.0), (0.55, 0.78), (0.46, 0.52), (0.36, 0.46),
             (0.26, 0.52), (0.17, 0.78), (0.10, 1.0), (-0.12, 0.97), (-0.40, 0.72), (-0.68, 0.42),
             (-0.86, 0.20), (-0.94, 0.09)]
FULLER = {4, 5, 6, 7, 8}


def blade_section(half_w, half_t, fuller):
    top = []
    for k, (u, v) in enumerate(BLADE_TOP):
        if k in FULLER:
            v = lerp(1.0, v, fuller)
        top.append((u * half_w, v * half_t))
    return top + [(-half_w, 0.0)] + [(u, -v) for (u, v) in reversed(top)]


def build_cutlass():
    name = 'cutlass'
    coll = asset_collection(name)  # noqa: F821
    body = []
    n = max(120, st(120))
    y0, y1 = 0.040, 1.135
    pts, secs = [], []
    for i in range(n + 1):
        s = i / n
        w = 0.040 - 0.007 * s
        if s > 0.80:  # cosine ogive point: finite slope at the tip, no last-centimetre cliff
            u = (s - 0.80) / 0.20
            w *= max(0.03, math.cos(u * math.pi / 2))
        t = 0.0062 - 0.0040 * s
        fuller = 1.0 if s < 0.66 else max(0.0, 1 - (s - 0.66) / 0.14)
        pts.append((0.10 * (s * s - 0.45 * s ** 3), lerp(y0, y1, s), 0.0))  # sabre sweep, steepest mid-blade
        secs.append(blade_section(w / 2, t / 2, fuller))
    blade = loft_var(coll, 'p_blade', pts, secs, 'steel')
    # Ricasso shoulder, shell guard, knuckle bow, rear quillon.
    body.append(loft(coll, 'p_ricasso', [(0, 0.004, 0), (0, 0.020, 0), (0, 0.046, 0)], RR, 'steel',
                     scales=[(0.046, 0.011), (0.044, 0.0095), (0.041, 0.0075)]))
    shell = [(0.016, 0.000), (0.040, 0.004), (0.058, 0.013), (0.068, 0.024), (0.071, 0.031), (0.068, 0.034),
             (0.064, 0.027), (0.055, 0.017), (0.038, 0.008), (0.016, 0.004)]
    sh = lathe(coll, 'p_shell', shell, 'y', (0, -0.006, 0), 'brass', segs=64, closed=True)
    body.append(xf(sh, Matrix.Diagonal(Vector((1.0, 0.62, 1.0, 1.0)))))
    bow = bez((-0.064, 0.022, 0), (-0.118, -0.030, 0), (-0.098, -0.205, 0), (-0.012, -0.262, 0), st(56))
    body.append(loft(coll, 'p_knuckle_bow', bow, H.rounded_rect(0.0065, 0.017, 0.0028, 4), 'brass'))
    curl = bez((0.030, 0.012, 0), (0.070, 0.016, 0), (0.084, 0.050, 0), (0.060, 0.064, 0), st(28))
    body.append(loft(coll, 'p_quillon', curl, H.circle(12, 0.0055), 'brass',
                     scales=[lerp(1.0, 0.65, k / (len(curl) - 1)) for k in range(len(curl))]))
    # Grip core (oval, barrel-shaped) under a two-strand wire wrap.
    g0, g1 = -0.240, -0.030

    def grip_r(y):
        return 0.0128 + 0.0030 * math.sin(math.pi * (y - g0) / (g1 - g0))
    prof = [(grip_r(lerp(g0, g1, k / 24)), lerp(g0, g1, k / 24)) for k in range(25)]
    body.append(lathe(coll, 'p_grip', prof, 'y', (0, 0, 0), 'leather', segs=64, radius_fn=ellipse(1.16, 1.0)))
    turns, per = 14, st(20)
    for strand in range(2):
        hp = []
        for k in range(turns * per + 1):
            u = k / (turns * per)
            y = lerp(g0 + 0.006, g1 - 0.006, u)
            th = 2 * math.pi * turns * u + math.pi * strand
            r = grip_r(y) + 0.0011
            hp.append((r * 1.16 * math.cos(th) / math.sqrt(1 + 0.16 * math.cos(th) ** 2), y,
                       r * math.sin(th)))
        body.append(loft(coll, f'p_wire_{strand}', hp, H.circle(6, 0.0013), 'brass'))
    body.append(lathe(coll, 'p_ferrule_top', ring_prof(0.0, 0.0172, -0.034, -0.010), 'y', (0, 0, 0), 'brass', segs=64))
    body.append(lathe(coll, 'p_ferrule_bot', ring_prof(0.0, 0.0165, -0.252, -0.236), 'y', (0, 0, 0), 'brass', segs=64))
    pom = [(0.0, -0.287), (0.0068, -0.2855), (0.0062, -0.2815), (0.0105, -0.2785), (0.0180, -0.2700),
           (0.0212, -0.2580), (0.0200, -0.2480), (0.0165, -0.2420)]
    body.append(lathe(coll, 'p_pommel', pom, 'y', (0, 0, 0), 'brass', segs=64, cap_start=False))
    return name, coll, {'blade': [blade], f'{name}_body': body}


# ── the flintlock family ─────────────────────────────────────
def barrel(coll, zb, L, rb, rm, yb, bore, flare=None):
    """Octagon-to-round barrel with a baluster ring (body) + a hollow muzzle node."""
    oct_end = 0.30 * L

    def octo(i, t, r, z):
        if z <= oct_end + 1e-6 and r > 1e-6:
            return r * math.cos(math.pi / 8) / math.cos(((t + math.pi / 8) % (math.pi / 4)) - math.pi / 8)
        return r
    mz = 0.06 if flare is None else 0.24
    body_len = L - mz + 0.004
    prof = [(0.0, 0.0), (rb * 0.94, 0.0), (rb, 0.004)]
    for k in range(1, 11):
        prof.append((lerp(rb, rb * 0.93, k / 10), oct_end * k / 10))
    rr = rb * 0.93
    prof += [(rr + 0.0032, oct_end + 0.004), (rr + 0.0032, oct_end + 0.014), (rr * 0.97, oct_end + 0.019)]
    for k in range(1, 25):
        u = k / 24
        prof.append((lerp(rr * 0.97, rm, u), lerp(oct_end + 0.019, body_len, u)))
    prof.append((0.0, body_len))
    b = lathe(coll, 'p_barrel', prof, 'z', (0, yb, zb), 'iron', segs=64, radius_fn=octo)
    z0 = zb + L - mz
    if flare is None:
        mp = [(0.0, 0.0), (rm, 0.0), (rm * 1.10, mz * 0.35), (rm * 1.14, mz * 0.70), (rm * 1.12, mz * 0.93),
              (rm * 1.04, mz), (bore, mz), (bore, mz - 0.04), (0.0, mz - 0.04)]
        mat = 'brass'
    else:
        mp = [(0.0, 0.0), (rm, 0.0)]
        for k in range(1, 15):
            u = k / 14
            mp.append((rm + (flare - rm) * u ** 2.2, mz * 0.93 * u))
        mp += [(flare + 0.004, mz * 0.95), (flare + 0.004, mz), (flare - 0.006, mz),
               (flare - 0.010, mz * 0.80), (bore, mz * 0.45), (0.0, mz * 0.45)]
        mat = 'iron'
    m = lathe(coll, 'p_muzzle', mp, 'z', (0, yb, z0), mat, segs=64)
    return b, m


def stock(coll, knots, n=14):
    """Lofted stock through (z, y, height, width) knots (game), rounded section."""
    pts, par = catmull([(0.0, k[1], k[0]) for k in knots], st(n))
    sc = []
    for p in par:
        i = min(int(p), len(knots) - 2)
        t = ease(p - i)
        sc.append((lerp(knots[i][2], knots[i + 1][2], t), lerp(knots[i][3], knots[i + 1][3], t)))
    return loft(coll, 'p_stock', pts, RR, 'walnut', scales=sc), pts, sc


def lock(coll, x, yc, zc, yb, s=1.0):
    """Lock plate + frizzen + spring + pan on +X (body); cock with jaws and flint (hammer node)."""
    body, hammer = [], []
    body.append(loft(coll, 'p_lock_plate', [(x - 0.003, yc, zc), (x + 0.0035, yc, zc)],
                     outline(0.130 * s, 0.030 * s), 'iron'))
    body.append(loft(coll, 'p_side_plate', [(-x - 0.003, yc, zc - 0.01), (-x + 0.003, yc, zc - 0.01)],
                     outline(0.110 * s, 0.022 * s, tail=0.2), 'brass'))
    xo = x + 0.007
    zp = zc + 0.050 * s
    body.append(lathe(coll, 'p_pan', [(0.0, 0.0), (0.0095 * s, 0.0), (0.011 * s, 0.004), (0.010 * s, 0.007),
                                       (0.006 * s, 0.0055), (0.0, 0.0055)], 'y', (xo, yb - 0.012, zp), 'iron', segs=32))
    fz = bez((xo, yb - 0.004, zp + 0.008 * s), (xo, yb + 0.010, zp + 0.012 * s),
             (xo, yb + 0.024, zp + 0.008 * s), (xo, yb + 0.034 * s, zp - 0.002), st(20))
    body.append(loft(coll, 'p_frizzen', fz, H.rounded_rect(0.005, 0.017 * s, 0.002, 3), 'steel'))
    sp = bez((xo - 0.002, yb - 0.018, zp + 0.004), (xo - 0.002, yb - 0.026, zp + 0.030 * s),
             (xo - 0.002, yb - 0.020, zp + 0.050 * s), (xo - 0.002, yb - 0.012, zp + 0.052 * s), st(16))
    body.append(loft(coll, 'p_frizzen_spring', sp, H.rounded_rect(0.003, 0.006, 0.0012, 2), 'iron'))
    for k, dz in enumerate((-0.035, 0.010)):
        body.append(lathe(coll, f'p_lock_screw_{k}', [(0.0, 0.0), (0.0042, 0.0), (0.0044, 0.0015),
                                                      (0.0030, 0.0030), (0.0, 0.0032)],
                          'x', (x + 0.0035, yc - 0.004, zc + dz * s), 'steel', segs=24))
    tz, ty = zc - 0.012 * s, yc
    neck = bez((xo, ty, tz), (xo, ty + 0.020 * s, tz - 0.026 * s), (xo, yb + 0.034 * s, tz - 0.004),
               (xo, yb + 0.030 * s, zp - 0.016 * s), st(36))
    hammer.append(loft(coll, 'p_cock', neck, H.rounded_rect(0.0075, 0.0095 * s, 0.003, 3), 'steel',
                       scales=[lerp(1.2, 0.85, k / (len(neck) - 1)) for k in range(len(neck))]))
    jx, jy, jz = xo, yb + 0.030 * s, zp - 0.016 * s
    for k, dy in enumerate((-0.006, 0.006)):
        hammer.append(loft(coll, f'p_jaw_{k}', [(jx, jy + dy * s, jz - 0.006), (jx, jy + dy * s, jz + 0.010 * s)],
                           H.rounded_rect(0.004 * s, 0.012 * s, 0.0015, 3), 'steel'))
    hammer.append(loft(coll, 'p_flint', [(jx, jy, jz + 0.004), (jx, jy, jz + 0.017 * s)],
                       H.rounded_rect(0.006 * s, 0.011 * s, 0.001, 2), 'flint', scales=[1.0, 0.55]))
    hammer.append(lathe(coll, 'p_jaw_screw', [(0.0, 0.0), (0.0025, 0.0), (0.0025, 0.016 * s), (0.0045, 0.017 * s),
                                              (0.0045, 0.021 * s), (0.0, 0.022 * s)], 'y',
                        (jx, jy - 0.004, jz + 0.002), 'steel', segs=24))
    return body, hammer


def furniture(coll, zg, yg, s=1.0, span=0.16):
    """Trigger guard (body) and trigger blade (trigger node) under the wrist at z=zg."""
    guard = bez((0, yg, zg + span * 0.62), (0, yg - 0.060 * s, zg + span * 0.45),
                (0, yg - 0.062 * s, zg - span * 0.05), (0, yg - 0.004, zg - span * 0.40), st(56))
    g = loft(coll, 'p_trigger_guard', guard, H.rounded_rect(0.0055, 0.011 * s, 0.0022, 3), 'brass')
    tr = bez((0, yg + 0.004, zg + 0.020 * s), (0, yg - 0.016 * s, zg + 0.022 * s),
             (0, yg - 0.030 * s, zg + 0.012 * s), (0, yg - 0.036 * s, zg + 0.002), st(24))
    t = loft(coll, 'p_trigger', tr, H.rounded_rect(0.0045, 0.0065, 0.0018, 3), 'steel',
             scales=[lerp(1.0, 0.8, k / (len(tr) - 1)) for k in range(len(tr))])
    return g, t


def rod(coll, z0, z1, y, r=0.0045):
    prof = [(0.0, 0.0), (r * 1.5, 0.0), (r * 1.5, 0.012), (r, 0.016), (r, z1 - z0 - 0.004), (r * 0.8, z1 - z0),
            (0.0, z1 - z0)]
    return lathe(coll, 'p_ramrod', prof, 'z', (0, y, z0), 'walnut', segs=24)


def swivel(coll, name, at):
    prof = [(0.009 + 0.0019 * math.cos(2 * math.pi * k / 10), 0.0019 * math.sin(2 * math.pi * k / 10))
            for k in range(10)]
    return lathe(coll, name, prof, 'x', at, 'iron', segs=24, closed=True)


def build_long_gun(name, zb, L, rb, rm, yb, butt_z, k=1.0, flare=None, scope=False):
    coll = asset_collection(name)  # noqa: F821
    body = []
    b, muzzle = barrel(coll, zb, L, rb, rm, yb, bore=(rm * 0.55 if flare is None else flare * 0.70), flare=flare)
    body.append(b)
    zf = zb + 0.84 * L if flare is None else zb + 0.70 * L
    knots = [(butt_z, -0.050 * k, 0.140 * k, 0.046), (butt_z * 0.5, -0.030 * k, 0.100 * k, 0.044),
             (-0.075, -0.010, 0.052, 0.040), (0.0, 0.0, 0.044, 0.037), (0.065, 0.028, 0.062, 0.044),
             (zb + 0.12, yb - 0.016, 0.046, 0.040), (zf, yb - 0.012, 0.030, 0.034)]
    stk, pts, sc = stock(coll, knots)
    body.append(stk)
    bp = [(0.0, knots[0][1], butt_z - 0.007), (0.0, knots[0][1], butt_z + 0.004)]
    body.append(loft(coll, 'p_butt_plate', bp, RR, 'brass', scales=[(0.146 * k, 0.050), (0.144 * k, 0.049)]))
    lb, ham = lock(coll, 0.023, 0.030, 0.055, yb)
    body += lb
    g, trig = furniture(coll, 0.020, -0.020)
    body.append(g)
    body.append(loft(coll, 'p_tang', [(0.0, 0.021, -0.070), (0.0, 0.026, 0.0), (0.0, yb - 0.006, zb)],
                     H.rounded_rect(0.004, 0.014, 0.0018, 3), 'iron', scales=[0.6, 1.0, 1.0]))
    body.append(rod(coll, zb + 0.08, zf + 0.03, yb - 0.032))
    for j, t in enumerate((0.34, 0.60, 0.82)):
        z = zb + L * t
        if z > zf - 0.01:
            continue
        body.append(lathe(coll, f'p_band_{j}', ring_prof(0.020, 0.023, 0.0, 0.012), 'z', (0, yb - 0.012, z - 0.006),
                          'brass', segs=48, radius_fn=ellipse(1.0, 1.55)))
    for j, t in enumerate((0.25, 0.55)):
        body.append(lathe(coll, f'p_pipe_{j}', ring_prof(0.0, 0.0075, 0.0, 0.022), 'z',
                          (0, yb - 0.032, zb + L * t), 'brass', segs=24))
    body.append(lathe(coll, 'p_nose_cap', ring_prof(0.0, 0.019, 0.0, 0.014), 'z', (0, yb - 0.013, zf - 0.006),
                      'brass', segs=48, radius_fn=ellipse(0.95, 1.10)))
    body.append(swivel(coll, 'p_swivel_0', (0, knots[1][1] - knots[1][2] * 0.5 - 0.008, butt_z * 0.5)))
    body.append(swivel(coll, 'p_swivel_1', (0, yb - 0.038, zb + L * 0.45)))
    sight_z = zb + L - (0.08 if flare is None else 0.27)
    body.append(loft(coll, 'p_front_sight', [(0, yb + rm * 0.9, sight_z), (0, yb + rm + 0.009, sight_z + 0.004)],
                     H.rounded_rect(0.003, 0.014, 0.0012, 2), 'brass', scales=[1.0, 0.6]))
    body.append(loft(coll, 'p_rear_sight', [(0, yb + rb * 0.85, zb + 0.03), (0, yb + rb + 0.008, zb + 0.03)],
                     H.rounded_rect(0.014, 0.008, 0.002, 2), 'iron'))
    groups = {f'{name}_body': body, 'hammer': ham, 'trigger': [trig], 'muzzle': [muzzle]}
    if scope:
        sy, s0, s1 = yb + 0.080, -0.06, 0.46
        tube = [(0.0, 0.0), (0.030, 0.0), (0.040, 0.012), (0.041, 0.070), (0.028, 0.100), (0.024, 0.120)]
        for j in range(1, 12):
            tube.append((0.024 + (0.003 if j in (4, 8) else 0.0), 0.120 + (s1 - s0 - 0.25) * j / 12))
        l_end = s1 - s0
        tube += [(0.026, l_end - 0.120), (0.042, l_end - 0.050), (0.046, l_end - 0.012), (0.044, l_end),
                 (0.036, l_end), (0.036, l_end - 0.010), (0.0, l_end - 0.010)]
        sc_ = [lathe(coll, 'p_scope_tube', tube, 'z', (0, sy, s0), 'brass', segs=64)]
        sc_.append(lathe(coll, 'p_scope_lens', [(0.0, 0.0), (0.036, 0.0), (0.036, 0.004), (0.0, 0.006)], 'z',
                         (0, sy, s0 + l_end - 0.014), 'glass', segs=48))
        sc_.append(lathe(coll, 'p_scope_eye', [(0.0, 0.0), (0.024, 0.0), (0.024, 0.003), (0.0, 0.004)], 'z',
                         (0, sy, s0 - 0.001), 'glass', segs=48))
        for j, z in enumerate((0.02, 0.26)):
            sc_.append(loft(coll, f'p_scope_mount_{j}', [(0, yb + rb * 0.7, z), (0, sy - 0.020, z)],
                            H.rounded_rect(0.014, 0.020, 0.003, 3), 'iron', scales=[(1.0, 1.3), (1.0, 1.0)]))
            sc_.append(lathe(coll, f'p_scope_ring_{j}', ring_prof(0.0, 0.029, -0.008, 0.008), 'z', (0, sy, z),
                             'iron', segs=48))
        groups['scope'] = sc_
    return name, coll, groups


def build_pistol(name='flintknock'):
    """Sea-service pistol: bird-head grip ~115 deg to the bore, 0.52 m overall."""
    coll = asset_collection(name)  # noqa: F821
    zb, L, yb = 0.070, 0.350, 0.056
    body = []
    b, muzzle = barrel(coll, zb, L, 0.0150, 0.0128, yb, bore=0.0078)
    body.append(b)
    zf = zb + L - 0.050
    # (z, y, height, width) from the butt up the grip, over the wrist and down the fore-end.
    knots = [(-0.082, -0.128, 0.050, 0.036), (-0.066, -0.090, 0.040, 0.032), (-0.040, -0.040, 0.036, 0.030),
             (-0.010, 0.004, 0.038, 0.031), (0.030, 0.028, 0.048, 0.036), (0.100, yb - 0.014, 0.036, 0.032),
             (zf, yb - 0.012, 0.026, 0.028)]
    pts, par = catmull([(0.0, k[1], k[0]) for k in knots], st(14))
    sc = []
    for p in par:
        i = min(int(p), len(knots) - 2)
        t = ease(p - i)
        sc.append((lerp(knots[i][2], knots[i + 1][2], t), lerp(knots[i][3], knots[i + 1][3], t)))
    body.append(loft(coll, 'p_stock', pts, RR, 'walnut', scales=sc))
    d = (Vector(pts[0]) - Vector(pts[3])).normalized()
    cap = [(0.0205, -0.004), (0.0215, 0.0), (0.0195, 0.006), (0.014, 0.011), (0.006, 0.0135), (0.0, 0.014)]
    body.append(lathe_dir(coll, 'p_butt_cap', cap, tuple(d), tuple(Vector(pts[0]) - d * 0.002), 'brass', segs=48,
                          cap_start=True, radius_fn=ellipse(1.0, 1.35)))
    lb, ham = lock(coll, 0.019, 0.030, 0.040, yb, s=0.85)
    body += lb
    g, trig = furniture(coll, 0.004, -0.014, s=0.85, span=0.12)
    body.append(g)
    body.append(rod(coll, zb + 0.07, zf + 0.02, yb - 0.026, r=0.0038))
    body.append(lathe(coll, 'p_pipe', ring_prof(0.0, 0.0064, 0.0, 0.020), 'z', (0, yb - 0.026, zb + 0.16),
                      'brass', segs=24))
    body.append(lathe(coll, 'p_nose_cap', ring_prof(0.0, 0.016, 0.0, 0.012), 'z', (0, yb - 0.012, zf - 0.006),
                      'brass', segs=48, radius_fn=ellipse(0.90, 1.05)))
    hook = bez((-0.017, 0.036, 0.010), (-0.024, 0.038, 0.060), (-0.026, 0.040, 0.130), (-0.021, 0.040, 0.175), st(40))
    body.append(loft(coll, 'p_belt_hook', hook, H.rounded_rect(0.003, 0.010, 0.0012, 3), 'steel',
                     scales=[lerp(1.0, 0.7, k / (len(hook) - 1)) for k in range(len(hook))]))
    body.append(loft(coll, 'p_tang', [(0.0, 0.020, -0.040), (0.0, 0.026, 0.02), (0.0, yb - 0.006, zb)],
                     H.rounded_rect(0.004, 0.012, 0.0016, 3), 'iron', scales=[0.6, 1.0, 1.0]))
    body.append(loft(coll, 'p_front_sight', [(0, yb + 0.012, zb + L - 0.07), (0, yb + 0.020, zb + L - 0.066)],
                     H.rounded_rect(0.003, 0.012, 0.0012, 2), 'brass', scales=[1.0, 0.6]))
    return name, coll, {f'{name}_body': body, 'hammer': ham, 'trigger': [trig], 'muzzle': [muzzle]}


# ── bake, export, verify ─────────────────────────────────────
def join_as(objs, name):
    base = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs,
                                       selected_editable_objects=objs):
            bpy.ops.object.join()
    base.name = name
    base.data.name = name
    return base


def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_animations=False, export_skins=False, export_morph=False, export_image_format='JPEG',
              export_jpeg_quality=90, export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
    last = None
    for drop in ((), ('export_active_vertex_color_when_no_material',), ('export_jpeg_quality',)):
        try:
            bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k not in drop})
            return path
        except TypeError as e:
            last = e
    raise last


def glb_json(path):
    with open(path, 'rb') as f:
        data = f.read()
    jl = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + jl])


def verify(path, nodes):
    j = glb_json(path)
    errs = []
    tris = sum(j['accessors'][p['indices']]['count'] // 3 for m in j['meshes'] for p in m['primitives'])
    if not BAND[0] <= tris <= BAND[1]:
        errs.append(f'{tris} tris outside {BAND}')
    names = {n.get('name') for n in j['nodes']}
    errs += [f'node {n} missing' for n in nodes if n not in names]
    for m in j.get('materials', []):
        pmr = m.get('pbrMetallicRoughness', {})
        if m.get('doubleSided'):
            errs.append(f"{m['name']} doubleSided")
        if not all(k in pmr for k in ('baseColorTexture', 'metallicRoughnessTexture')) or 'normalTexture' not in m \
                or 'occlusionTexture' not in m:
            errs.append(f"{m['name']} lacks baseColor + normal + ORM")
    if len(j.get('materials', [])) != 1:
        errs.append(f"{len(j.get('materials', []))} materials")
    if any('COLOR_0' not in p['attributes'] for m in j['meshes'] for p in m['primitives']):
        errs.append('a primitive has no COLOR_0')
    return tris, errs


BUILDS = [
    ('cutlass', build_cutlass),
    ('flintlock', lambda: build_long_gun('flintlock', 0.10, 0.68, 0.0160, 0.0130, 0.062, -0.30)),
    ('flintknock', build_pistol),
    ('eye_of_reach', lambda: build_long_gun('eye_of_reach', 0.10, 1.16, 0.0145, 0.0120, 0.062, -0.555, k=1.05,
                                            scope=True)),
    ('blunderbuss', lambda: build_long_gun('blunderbuss', 0.10, 0.84, 0.0220, 0.0260, 0.070, -0.515, k=1.08,
                                           flare=0.058)),
]

P.require_licensed(SOURCES)
report, failed = {}, []
for key, fn in BUILDS:
    if ONLY and key not in ONLY:
        continue
    name, coll, groups = fn()
    nodes = [join_as(parts, gname) for gname, parts in groups.items()]
    A.pbr_atlas(nodes, name, tier='near', samples=SAMPLES)
    for o in nodes:
        for poly in o.data.polygons:
            poly.material_index = 0
        col = o.data.color_attributes.get('Col') or o.data.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        for dcol in col.data:
            dcol.color = (1.0, 1.0, 1.0, 1.0)
        o.data.color_attributes.active_color = col
    path = export(nodes, os.path.join(OUT, f'{name}.glb'))
    tris, errs = verify(path, list(groups))
    box = [min((o.matrix_world @ Vector(c))[i] for o in nodes for c in o.bound_box) for i in range(3)] + \
          [max((o.matrix_world @ Vector(c))[i] for o in nodes for c in o.bound_box) for i in range(3)]
    report[name] = {'tris': tris, 'nodes': {o.name: len(o.data.vertices) for o in nodes},
                    'game_len_z': round(box[4] - box[1], 4), 'game_len_y': round(box[5] - box[2], 4),
                    'bytes': os.path.getsize(path), 'errors': errs}
    print(f'WEAPON {name}: {json.dumps(report[name])}', flush=True)
    if errs:
        failed.append(name)
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)

print('WEAPONS REPORT ' + json.dumps(report))
if failed:
    print(f'WEAPONS FAILED: {failed}')
    sys.exit(1)
print('WEAPONS DONE')
