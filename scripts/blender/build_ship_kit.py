# SHIP KIT I (b4.3a; ships-07, ships-08): the ship-only parts that make a hull read as a ship instead of a
# model kit, authored in Blender on the b3.4 PBR chain (_hires forms, _pbr PolyHaven CC0 sources, ONE baked
# ship trim atlas via _atlas.pbr_atlas, single-sided) and shipped as ONE file, public/assets/models/ship_kit_a.glb,
# plus its geometry-only LOD sibling ship_kit_a_lods.glb (per node `<node>_LOD1` / `<node>_LOD2`).
#
# PARTS (top-level nodes; every part has its own density loop and band, test-asset-tiers `ship-kit` tier):
#   figurehead_sloop        carved fiddlehead scroll with acanthus fronds and bead-and-reel trailboards  12-20k
#   figurehead_brigantine   rising sea serpent: ridged body, jawed head, horns, dorsal frill               12-20k
#   figurehead_galleon      crowned lion: maned head, forepaws on a scroll knee                            12-20k
#   stern_gallery_galleon   lower tier: 5 arched windows, balcony with turned balusters                    2-10k
#   stern_gallery_galleon_upper  upper tier: 5 arched windows, gilt taffrail crest (mounts on the lower)    2-10k
#   stern_gallery_brigantine 1 tier x 4 windows with a balcony, taffrail crest                            2-10k
#   stern_transom_sloop     transom with 2 windows, moulded rim, small crest                                2-10k
#   quarter_gallery_galleon / quarter_gallery_brigantine   3-light bay, domed roof, drop finial            2-10k
#   gunport + gunport_lid   bevelled frame with hinge plates; planked lid with straps, hinge knuckles, ring 2-10k
#   rudder + rudder_gudgeons  tapered blade with pintle straps and pins; gudgeon straps and eyes (fixed)   2-10k
#   cathead                 beam, knee, iron bands, two sheaves, carved end boss                            2-10k
#   *_glass                 glazing panes (stern/quarter galleries): material Glass_Gallery, emissive warm,
#                           NO light: night glazing rides the shared lantern budget (the client ramps the
#                           emissive with the lantern night ramp; it never adds a light).
#
# THE FRAME IS THE API (b4.3c mounts these at sockets computed from sampleHullSurface):
#   every part is modelled in game space (x right, y up, z = OUT along the hull surface normal at the mount)
#   with its ORIGIN AT THE MOUNT POINT on the surface. The figurehead's out is forward along the stem, the stern
#   parts' out is aft, the quarter gallery / gunport / cathead out is outboard (mirror x for the port side;
#   three.js flips the winding for a negative determinant). Pivoting nodes:
#     gunport_lid      origin on the hinge line (top outer edge); open = rotation.x toward -1.4 rad.
#     rudder           origin on the pintle axis at the head of the sternpost; turns with rotation.y;
#                      rudder_gudgeons shares the origin and stays fixed on the hull.
#   SOCKET EMPTIES (nodes named sock_*, no mesh): local +Z = out, +Y = up, at the mount and at every attach
#   point (taffrail lantern seats, pintles, tiller, hinge, muzzle, cathead sheave) so the client never hand-
#   places an offset. Node extras: kit_part (part name), socket (true on sockets).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_ship_kit.py
#   env: KIT_OUT (dir), KIT_SAMPLES (bake samples, 12), KIT_SHEET (contact sheet PNG path, '' to skip)
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

name = 'ship_kit_a'
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.environ.get('KIT_OUT') or EXPORT_DIR  # noqa: F821 (from _helpers)
SAMPLES = int(os.environ.get('KIT_SAMPLES', '12'))
SHEET = os.environ.get('KIT_SHEET', os.path.join(ROOT, 'docs', 'asset-sheets', 'ship-kit', 'ship_kit_a.png'))
FIG = (12000, 20000)
PART = (2000, 10000)
LOD_R = {'LOD1': 0.36, 'LOD2': 0.10}
SOURCES = ['metal_plate', 'walnut_veneer', 'brown_planks_03']
DENS = {}

clear_default_scene()  # noqa: F821

MATS = {
    'iron': P.metal_material('KIT_Iron', 'metal_plate', 'iron', scale=2.0, tint=(0.30, 0.31, 0.33), wear=0.30),
    # gilt = yellow-ochre gilding paint on carved wood (a metal read black under the grey review sky and the
    # carving is wood under the paint): non-metal, walnut grain, warm gold tint
    'gilt': P.source_material('KIT_Gilt', 'walnut_veneer', scale=1.4, tint=(0.95, 0.72, 0.30), wear=0.30, metallic=0.0, roughness=0.45),
    'oak': P.source_material('KIT_Oak', 'brown_planks_03', scale=1.0, tint=(0.72, 0.55, 0.40), wear=0.15),
    'oak_dark': P.source_material('KIT_OakDark', 'brown_planks_03', scale=1.0, tint=(0.42, 0.31, 0.22), wear=0.10),
    'carve': P.source_material('KIT_Carve', 'walnut_veneer', scale=1.4, tint=(0.86, 0.66, 0.48), wear=0.25),
    'paint_red': P.source_material('KIT_PaintRed', 'brown_planks_03', scale=1.0, tint=(0.55, 0.16, 0.12), wear=0.20),
    'paint_blue': P.source_material('KIT_PaintBlue', 'brown_planks_03', scale=1.0, tint=(0.16, 0.24, 0.40), wear=0.20),
}
GLASS = bpy.data.materials.new('Glass_Gallery')
GLASS.use_nodes = True
_b = GLASS.node_tree.nodes.get('Principled BSDF')
_b.inputs['Base Color'].default_value = (0.10, 0.13, 0.16, 1.0)
_b.inputs['Roughness'].default_value = 0.08
_b.inputs['Metallic'].default_value = 0.0
_b.inputs['Emission Color'].default_value = (1.0, 0.70, 0.34, 1.0)
_b.inputs['Emission Strength'].default_value = 1.0
GLASS.use_backface_culling = True


# ── game-space helpers (x right, y up, z out) ─────────────────────────────────
def G(x, y, z):
    return Vector((x, -z, y))


CM = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # game -> blender
AX = {'y': Matrix.Identity(4), 'z': Matrix.Rotation(math.radians(90), 4, 'X'),
      'x': Matrix.Rotation(math.radians(90), 4, 'Y')}
D = {'d': 1.0}


def seg(n, lo=12):
    return max(lo, min(160, int(round(n * D['d'] / 4.0)) * 4))


def mat_of(m):
    return GLASS if m == 'glass' else MATS[m]


def xf(o, M):
    o.data.transform(M)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def lathe(coll, nm, prof, axis, at, mat, segs=32, scale=None, **kw):
    o = H.lathe(nm, prof, seg(segs), collection=coll, material=mat_of(mat), **kw)
    S = Matrix.Identity(4)
    if scale:
        S = Matrix.Diagonal((scale[0], scale[2], scale[1], 1.0))  # game (x, y, z) scale in blender axes
    return xf(o, Matrix.Translation(G(*at)) @ S @ AX[axis])


def ball(coll, nm, r, at, mat, segs=20, scale=None):
    n = max(6, seg(segs, 8) // 2)
    prof = [(r * math.sin(math.pi * k / n), -r * math.cos(math.pi * k / n)) for k in range(n + 1)]
    prof[0] = (0.0, -r)
    prof[-1] = (0.0, r)
    return lathe(coll, nm, prof, 'y', at, mat, segs, scale=scale)


def torus(coll, nm, R, r, axis, at, mat, segs=32, rsegs=8):
    prof = [(R + r * math.cos(2 * math.pi * k / rsegs), r * math.sin(2 * math.pi * k / rsegs)) for k in range(rsegs)]
    return lathe(coll, nm, prof, axis, at, mat, segs, closed=True)


def box(coll, nm, w, h, d, at, mat, rot=None, bev=0.012, bseg=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(w, d, h), verts=bm.verts)
    me = bpy.data.meshes.new(nm)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(nm, me)
    coll.objects.link(o)
    me.materials.append(mat_of(mat))
    me.transform(Matrix.Translation(G(*at)) @ (rot or Matrix.Identity(4)))
    if bev:
        H.bevel(o, bev, bseg)
    return o


def ring_loft(coll, nm, rings, mat, cap=True, smooth=True):
    bm = bmesh.new()
    vr = [[bm.verts.new(G(*p)) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vr, vr[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap:
        bm.faces.new(list(reversed(vr[0])))
        bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(nm)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(nm, me)
    coll.objects.link(o)
    me.materials.append(mat_of(mat))
    for p in me.polygons:
        p.use_smooth = smooth
    return o


def ellipse(rx=1.0, ry=1.0, n=12):
    return [(rx * math.cos(2 * math.pi * k / n), ry * math.sin(2 * math.pi * k / n)) for k in range(n)]


def rrect(n=3):
    return [tuple(p) for p in H.rounded_rect(2.0, 2.0, 0.45, max(2, n))]


def ridged(n, bump=0.35, at=math.pi / 2, width=0.35):
    out = []
    for k in range(n):
        a = 2 * math.pi * k / n
        d = math.atan2(math.sin(a - at), math.cos(a - at))
        r = 1.0 + bump * math.exp(-(d / width) ** 2)
        out.append((r * math.cos(a), r * math.sin(a)))
    return out


def bez(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(tuple(u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d
                         for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def line(p0, p1, n=2):
    return [tuple(a + (b - a) * i / n for a, b in zip(p0, p1)) for i in range(n + 1)]


def spiral(c, r0, r1, a0, turns, n, u=(0, 1, 0), v=(0, 0, 1)):
    """Points c + r (sin a * u + cos a * v), r easing r0 -> r1 over `turns` turns."""
    out = []
    for i in range(n + 1):
        t = i / n
        a = a0 + 2 * math.pi * turns * t
        r = r0 + (r1 - r0) * (1 - (1 - t) ** 1.6)
        out.append(tuple(cc + r * (math.sin(a) * uu + math.cos(a) * vv) for cc, uu, vv in zip(c, u, v)))
    return out


def frames(pts):
    Pp = [Vector(p) for p in pts]
    T = []
    for i in range(len(Pp)):
        a, b = Pp[max(i - 1, 0)], Pp[min(i + 1, len(Pp) - 1)]
        T.append((b - a).normalized())
    n = Vector((0, 1, 0)).cross(T[0])
    if n.length < 1e-4:
        n = Vector((1, 0, 0)).cross(T[0])
    n.normalize()
    N = [n]
    for i in range(1, len(Pp)):
        q = T[i - 1].rotation_difference(T[i])
        m = q @ N[-1]
        m = (m - T[i] * m.dot(T[i])).normalized()
        N.append(m)
    return Pp, T, N, [t.cross(m) for t, m in zip(T, N)]


def tube(coll, nm, pts, mat, radii=1.0, sec=None, twist=None, cap=True):
    sec = sec or ellipse(1, 1, seg(12))
    Pp, T, N, B = frames(pts)
    rings = []
    for i, p in enumerate(Pp):
        r = radii(i / max(1, len(Pp) - 1)) if callable(radii) else radii
        sx, sy = (r, r) if not isinstance(r, (list, tuple)) else r
        tw = math.radians(twist(i / max(1, len(Pp) - 1))) if twist else 0.0
        c, s = math.cos(tw), math.sin(tw)
        ring = []
        for (x, y) in sec:
            x2, y2 = (x * c - y * s) * max(sx, 0.002), (x * s + y * c) * max(sy, 0.002)
            ring.append(tuple(p + N[i] * x2 + B[i] * y2))
        rings.append(ring)
    return ring_loft(coll, nm, rings, mat, cap)


def taper(a, b, p=1.0):
    return lambda t: a + (b - a) * (t ** p)


def pane(coll, nm, w, h, at, rot=None):
    bm = bmesh.new()
    vs = [bm.verts.new(Vector(v)) for v in ((-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2))]
    bm.faces.new(vs)
    me = bpy.data.meshes.new(nm)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(nm, me)
    coll.objects.link(o)
    me.materials.append(GLASS)
    # the quad faces blender -y = game +z (out)
    me.transform(Matrix.Translation(G(*at)) @ (rot or Matrix.Identity(4)))
    for p in me.polygons:
        if p.normal.dot(G(0, 0, 1) if rot is None else (rot.to_3x3() @ G(0, 0, 1))) < 0:
            p.flip()
    return o


def ry(a):
    return Matrix.Rotation(a, 4, 'Z')  # rotation about game +Y


def rx(a):
    return Matrix.Rotation(a, 4, 'X')  # rotation about game +X


SOCK = {}


def sock(part, nm, at, out=(0, 0, 1), up=(0, 1, 0)):
    SOCK[nm] = (part, at, out, up)


# ── figureheads ──────────────────────────────────────────────────────────────
def knee(coll, pre, L, parts):
    kp = bez((0, -0.22 * L, -0.06 * L), (0, -0.02 * L, 0.18 * L), (0, 0.18 * L, 0.36 * L), (0, 0.36 * L, 0.46 * L), seg(28))
    parts.append(tube(coll, pre + '_knee', kp, 'oak', lambda t: (0.07 * L * (1 - 0.35 * t), 0.10 * L * (1 - 0.30 * t)), sec=rrect()))
    for sx in (-1, 1):
        off = [(sx * 0.075 * L * (1 - 0.3 * i / len(kp)), y, z) for i, (x, y, z) in enumerate(kp)]
        parts.append(tube(coll, f'{pre}_trail{sx}', off[2:-2], 'carve', (0.010 * L, 0.035 * L), sec=rrect()))
        v = spiral((sx * 0.08 * L, -0.12 * L, 0.02 * L), 0.07 * L, 0.012 * L, math.pi, 1.4, seg(40), u=(0, 1, 0), v=(0, 0, 1))
        parts.append(tube(coll, f'{pre}_trailscroll{sx}', v, 'gilt', taper(0.016 * L, 0.006 * L), sec=ellipse(1, 1, seg(10, 8))))
        for k in range(10):
            p = kp[2 + int((len(kp) - 5) * k / 9)]
            parts.append(ball(coll, f'{pre}_bead{sx}_{k}', 0.014 * L, (sx * 0.086 * L, p[1] - 0.02 * L, p[2]), 'gilt', 12))
    return kp[-1]


def frond(coll, nm, p0, p1, p2, p3, w, mat='carve'):
    pts = bez(p0, p1, p2, p3, seg(16))
    return tube(coll, nm, pts, mat, lambda t: (w * (math.sin(math.pi * min(t, 0.92) / 0.92) + 0.08), w * 0.45),
                sec=ellipse(1, 1, seg(10, 8)), twist=lambda t: 20 * t)


def build_figurehead_sloop(coll):
    L, parts = 1.3, []
    E = knee(coll, 'fh_s', L, parts)
    C = (0, E[1] + 0.13 * L, E[2] + 0.02 * L)
    r0 = math.hypot(E[1] - C[1], E[2] - C[2])
    a0 = math.atan2(E[1] - C[1], E[2] - C[2])
    for x, rr, mat in ((0.0, (0.055 * L, 0.07 * L), 'carve'), (0.05 * L, (0.012 * L, 0.03 * L), 'gilt'), (-0.05 * L, (0.012 * L, 0.03 * L), 'gilt')):
        sp = spiral((x, C[1], C[2]), r0, 0.018 * L, a0, 2.1, seg(96))
        parts.append(tube(coll, f'fh_s_volute{x:+.2f}', sp, mat, lambda t, rr=rr: (rr[0] * (1 - 0.72 * t), rr[1] * (1 - 0.72 * t)),
                          sec=rrect() if mat == 'carve' else ellipse(1, 1, seg(10, 8))))
    for sx in (-1, 1):
        for k in range(4):
            y = E[1] - 0.1 * L - 0.08 * L * k
            z = E[2] - 0.12 * L * k
            parts.append(frond(coll, f'fh_s_leaf{sx}_{k}', (sx * 0.06 * L, y, z), (sx * 0.14 * L, y + 0.05 * L, z + 0.06 * L),
                               (sx * 0.16 * L, y + 0.14 * L, z + 0.05 * L), (sx * 0.10 * L, y + 0.16 * L, z - 0.02 * L), 0.035 * L))
    parts.append(ball(coll, 'fh_s_boss', 0.035 * L, (0, C[1], C[2]), 'gilt', 16, scale=(1.6, 1, 1)))
    sock('figurehead_sloop', 'sock_figurehead_sloop', (0, 0, 0))
    return {'figurehead_sloop': (parts, None)}


def build_figurehead_brig(coll):
    L, parts = 1.8, []
    E = knee(coll, 'fh_b', L, parts)
    body = bez(E, (0, E[1] + 0.28 * L, E[2] + 0.22 * L), (0, E[1] + 0.12 * L, E[2] + 0.52 * L), (0, E[1] + 0.40 * L, E[2] + 0.66 * L), seg(48))
    parts.append(tube(coll, 'fh_b_body', body, 'carve', taper(0.085 * L, 0.06 * L), sec=ridged(seg(16), 0.35)))
    Hd = Vector(body[-1])
    head = line(tuple(Hd), tuple(Hd + Vector((0, -0.02 * L, 0.26 * L))), seg(16))
    parts.append(tube(coll, 'fh_b_head', head, 'carve', lambda t: (0.065 * L * (1 - 0.6 * t), 0.06 * L * (1 - 0.45 * t)), sec=ridged(seg(16), 0.2)))
    jaw = bez(tuple(Hd + Vector((0, -0.04 * L, 0.02 * L))), tuple(Hd + Vector((0, -0.07 * L, 0.10 * L))),
              tuple(Hd + Vector((0, -0.08 * L, 0.18 * L))), tuple(Hd + Vector((0, -0.07 * L, 0.24 * L))), seg(14))
    parts.append(tube(coll, 'fh_b_jaw', jaw, 'carve', lambda t: (0.045 * L * (1 - 0.6 * t), 0.022 * L * (1 - 0.4 * t)), sec=ellipse(1, 1, seg(12))))
    for sx in (-1, 1):
        parts.append(ball(coll, f'fh_b_eye{sx}', 0.016 * L, tuple(Hd + Vector((sx * 0.045 * L, 0.03 * L, 0.06 * L))), 'gilt', 14))
        horn = bez(tuple(Hd + Vector((sx * 0.03 * L, 0.05 * L, 0.02 * L))), tuple(Hd + Vector((sx * 0.07 * L, 0.12 * L, -0.02 * L))),
                   tuple(Hd + Vector((sx * 0.09 * L, 0.16 * L, -0.10 * L))), tuple(Hd + Vector((sx * 0.07 * L, 0.13 * L, -0.16 * L))), seg(16))
        parts.append(tube(coll, f'fh_b_horn{sx}', horn, 'carve', taper(0.016 * L, 0.003 * L), sec=ellipse(1, 1, seg(10, 8))))
        fin = bez(tuple(Hd + Vector((sx * 0.05 * L, -0.01 * L, 0.0))), tuple(Hd + Vector((sx * 0.12 * L, 0.0, -0.04 * L))),
                  tuple(Hd + Vector((sx * 0.15 * L, -0.03 * L, -0.10 * L))), tuple(Hd + Vector((sx * 0.13 * L, -0.07 * L, -0.12 * L))), seg(12))
        parts.append(tube(coll, f'fh_b_fin{sx}', fin, 'carve', lambda t: (0.035 * L * math.sin(math.pi * min(t, 0.9) / 0.9) + 0.002, 0.006 * L), sec=ellipse(1, 1, seg(10, 8))))
        for k in range(6):
            p = Vector(jaw[min(len(jaw) - 1, 3 + k * (len(jaw) - 4) // 6)])
            parts.append(lathe(coll, f'fh_b_tooth{sx}_{k}', [(0.008 * L, 0.0), (0.0, 0.025 * L)], 'y', tuple(p + Vector((sx * 0.02 * L, 0.012 * L, 0))), 'gilt', 12))
    for k in range(9):
        i = int(4 + k * (len(body) - 10) / 8)
        p, q = Vector(body[i]), Vector(body[min(i + 2, len(body) - 1)])
        tdir = (q - p).normalized()
        sp = bez(tuple(p + Vector((0, 0.07 * L, 0))), tuple(p + Vector((0, 0.12 * L, 0)) - tdir * 0.03 * L),
                 tuple(p + Vector((0, 0.15 * L, 0)) - tdir * 0.07 * L), tuple(p + Vector((0, 0.15 * L, 0)) - tdir * 0.11 * L), seg(10, 8))
        parts.append(tube(coll, f'fh_b_frill{k}', sp, 'gilt', lambda t: (0.006 * L, 0.02 * L * (1 - t) + 0.002), sec=ellipse(1, 1, seg(10, 8))))
    sock('figurehead_brigantine', 'sock_figurehead_brigantine', (0, 0, 0))
    return {'figurehead_brigantine': (parts, None)}


def build_figurehead_galleon(coll):
    L, parts = 2.6, []
    E = knee(coll, 'fh_g', L, parts)
    Hc = Vector((0, E[1] + 0.20 * L, E[2] + 0.10 * L))
    parts.append(ball(coll, 'fh_g_skull', 0.11 * L, tuple(Hc), 'carve', 28, scale=(1.0, 1.05, 1.1)))
    parts.append(ball(coll, 'fh_g_muzzle', 0.065 * L, tuple(Hc + Vector((0, -0.03 * L, 0.10 * L))), 'carve', 24, scale=(1.15, 0.8, 1.0)))
    parts.append(ball(coll, 'fh_g_nose', 0.03 * L, tuple(Hc + Vector((0, 0.0, 0.155 * L))), 'carve', 16, scale=(1.3, 0.8, 0.9)))
    parts.append(ball(coll, 'fh_g_chin', 0.04 * L, tuple(Hc + Vector((0, -0.08 * L, 0.08 * L))), 'carve', 16, scale=(1.0, 0.7, 1.0)))
    brow = bez(tuple(Hc + Vector((-0.07 * L, 0.04 * L, 0.08 * L))), tuple(Hc + Vector((-0.03 * L, 0.06 * L, 0.11 * L))),
               tuple(Hc + Vector((0.03 * L, 0.06 * L, 0.11 * L))), tuple(Hc + Vector((0.07 * L, 0.04 * L, 0.08 * L))), seg(16))
    for i, bp in enumerate(brow[1:-1:max(1, len(brow) // 6)]):
        parts.append(ball(coll, f'fh_g_brow{i}', 0.022 * L, bp, 'carve', 12, scale=(1.4, 0.7, 0.9)))
    for sx in (-1, 1):
        parts.append(ball(coll, f'fh_g_eye{sx}', 0.014 * L, tuple(Hc + Vector((sx * 0.04 * L, 0.025 * L, 0.10 * L))), 'gilt', 12))
        parts.append(ball(coll, f'fh_g_ear{sx}', 0.025 * L, tuple(Hc + Vector((sx * 0.08 * L, 0.09 * L, -0.01 * L))), 'carve', 12, scale=(0.6, 1.0, 0.8)))
    # mane: three rings of tapering curled locks radiating round the face
    for ring in range(3):
        n = 14 - 2 * ring
        for j in range(n):
            ph = 2 * math.pi * (j + 0.5 * ring) / n
            dvec = Vector((math.cos(ph), math.sin(ph), 0))
            b = Hc + dvec * (0.09 * L) + Vector((0, 0, -0.02 * L - 0.035 * L * ring))
            pts = bez(tuple(b), tuple(b + dvec * 0.05 * L + Vector((0, 0, -0.07 * L))),
                      tuple(b + dvec * 0.08 * L + Vector((0, -0.03 * L, -0.15 * L))),
                      tuple(b + dvec * 0.06 * L + Vector((0, -0.07 * L, -0.15 * L))), seg(14, 8))
            parts.append(tube(coll, f'fh_g_lock{ring}_{j}', pts, 'carve', lambda t: (0.038 * L * (1 - 0.85 * t), 0.022 * L * (1 - 0.8 * t)),
                              sec=ellipse(1, 1, seg(10, 8)), twist=lambda t: 50 * t))
    crown_y = Hc + Vector((0, 0.11 * L, -0.01 * L))
    parts.append(lathe(coll, 'fh_g_crown', [(0.06 * L, 0.0), (0.065 * L, 0.0), (0.07 * L, 0.03 * L), (0.064 * L, 0.035 * L), (0.058 * L, 0.004 * L)],
                       'y', tuple(crown_y), 'gilt', 40, closed=True))
    for k in range(8):
        a = 2 * math.pi * k / 8
        p = crown_y + Vector((0.067 * L * math.cos(a), 0.03 * L, 0.067 * L * math.sin(a)))
        parts.append(lathe(coll, f'fh_g_point{k}', [(0.012 * L, 0.0), (0.004 * L, 0.04 * L), (0.0, 0.045 * L)], 'y', tuple(p), 'gilt', 12))
        parts.append(ball(coll, f'fh_g_pearl{k}', 0.007 * L, tuple(p + Vector((0, 0.048 * L, 0))), 'gilt', 10))
    chest = Hc + Vector((0, -0.14 * L, -0.03 * L))
    parts.append(ball(coll, 'fh_g_chest', 0.09 * L, tuple(chest), 'carve', 24, scale=(1.0, 1.2, 0.9)))
    for sx in (-1, 1):
        leg = bez(tuple(chest + Vector((sx * 0.06 * L, 0, 0.03 * L))), tuple(chest + Vector((sx * 0.08 * L, -0.08 * L, 0.08 * L))),
                  tuple(chest + Vector((sx * 0.07 * L, -0.14 * L, 0.10 * L))), tuple(chest + Vector((sx * 0.06 * L, -0.19 * L, 0.13 * L))), seg(16))
        parts.append(tube(coll, f'fh_g_leg{sx}', leg, 'carve', taper(0.035 * L, 0.025 * L), sec=ellipse(1, 1, seg(12))))
        paw = Vector(leg[-1])
        parts.append(ball(coll, f'fh_g_paw{sx}', 0.03 * L, tuple(paw), 'carve', 16, scale=(1.0, 0.7, 1.2)))
        for t in range(4):
            parts.append(ball(coll, f'fh_g_toe{sx}_{t}', 0.011 * L, tuple(paw + Vector(((t - 1.5) * 0.014 * L, -0.008 * L, 0.03 * L))), 'carve', 10))
    parts.append(lathe(coll, 'fh_g_shield', [(0.0, 0.0), (0.07 * L, 0.0), (0.075 * L, 0.012 * L), (0.06 * L, 0.02 * L), (0.0, 0.024 * L)], 'z',
                       tuple(chest + Vector((0, -0.17 * L, 0.10 * L))), 'gilt', 32, scale=(0.85, 1.0, 1.0)))
    sock('figurehead_galleon', 'sock_figurehead_galleon', (0, 0, 0))
    return {'figurehead_galleon': (parts, None)}


# ── stern galleries ──────────────────────────────────────────────────────────
MOULD = None


def window(coll, pre, x, yc, ww, hw, arch, parts, glass, z=0.0, rot=None):
    R = rot or Matrix.Identity(4)

    def at(px, py, pz):
        v = R.to_3x3() @ G(px - x, py, pz)
        return v

    def bx(nm, w, h, d, px, py, pz, mat='carve', bev=0.01):
        o = box(coll, nm, w, h, d, (0, 0, 0), mat, bev=bev, bseg=2)
        o.data.transform(Matrix.Translation(G(x, 0, z) + at(px + x, py, pz)) @ R)
        parts.append(o)
    bx(f'{pre}_ft', ww + 0.12, 0.06, 0.07, 0, yc + hw / 2, 0.035)
    bx(f'{pre}_fb', ww + 0.16, 0.07, 0.09, 0, yc - hw / 2, 0.045)
    for sx in (-1, 1):
        bx(f'{pre}_fs{sx}', 0.06, hw, 0.07, sx * ww / 2, yc, 0.035)
    bx(f'{pre}_bv', 0.022, hw, 0.03, 0, yc, 0.02, 'oak_dark', 0)
    for k in (-1, 1):
        bx(f'{pre}_bh{k}', ww, 0.022, 0.03, 0, yc + k * hw / 6, 0.02, 'oak_dark', 0)
    if arch:
        na = seg(16, 6)
        pts = [(x + ww / 2 * math.cos(math.pi * i / na), yc + hw / 2 + ww / 2 * math.sin(math.pi * i / na), 0.035) for i in range(na + 1)]
        o = tube(coll, f'{pre}_arch', pts, 'carve', (0.03, 0.035), sec=ellipse(1, 1, 8))
        o.data.transform(Matrix.Translation(G(x, 0, z)) @ R @ Matrix.Translation(-G(x, 0, 0)))
        parts.append(o)
    g = pane(coll, f'{pre}_glass', ww, hw + (ww * 0.4 if arch else 0), (0, 0, 0))
    g.data.transform(Matrix.Translation(G(x, 0, z) + at(x, yc + (ww * 0.2 if arch else 0), 0.012)) @ R)
    glass.append(g)


def gallery(coll, pre, W, tiers, nwin, Ht, balcony, arch, crest=True, paint0=0):
    parts, glass = [], []
    pitch = W / nwin
    for t in range(tiers):
        y0 = t * Ht
        parts.append(box(coll, f'{pre}_panel{t}', W, Ht, 0.05, (0, y0 + Ht / 2, -0.025), 'paint_red' if (t + paint0) % 2 == 0 else 'paint_blue', bev=0.01))
        parts.append(tube(coll, f'{pre}_sill{t}', line((-W / 2 - 0.05, y0 + 0.04, 0.06), (W / 2 + 0.05, y0 + 0.04, 0.06)), 'carve', (0.06, 0.05), sec=rrect()))
        parts.append(tube(coll, f'{pre}_cornice{t}', line((-W / 2 - 0.08, y0 + Ht - 0.05, 0.08), (W / 2 + 0.08, y0 + Ht - 0.05, 0.08)), 'carve', (0.08, 0.06), sec=rrect()))
        ww, hw = pitch * 0.58, Ht * (0.48 if arch else 0.56)
        for i in range(nwin):
            window(coll, f'{pre}_w{t}_{i}', -W / 2 + pitch * (i + 0.5), y0 + Ht * 0.44, ww, hw, arch, parts, glass)
        for i in range(nwin + 1):
            x = -W / 2 + pitch * i
            parts.append(box(coll, f'{pre}_pil{t}_{i}', 0.10, Ht * 0.80, 0.09, (x, y0 + Ht * 0.47, 0.045), 'carve', bev=0.01))
            parts.append(box(coll, f'{pre}_cap{t}_{i}', 0.15, 0.06, 0.12, (x, y0 + Ht * 0.88, 0.06), 'gilt', bev=0.01))
            parts.append(torus(coll, f'{pre}_ros{t}_{i}', 0.03, 0.012, 'z', (x, y0 + Ht * 0.72, 0.095), 'gilt', 12, 4))
        if balcony and t == 0:
            parts.append(box(coll, f'{pre}_floor', W + 0.2, 0.07, 0.6, (0, y0 - 0.035, 0.3), 'oak'))
            nb = max(6, int(W / 0.2 * min(1.0, D['d'])))
            for i in range(nb):
                x = -W / 2 + (W) * (i + 0.5) / nb
                parts.append(lathe(coll, f'{pre}_bal{i}', [(0.03, 0.0), (0.02, 0.06), (0.04, 0.18), (0.02, 0.32), (0.028, 0.40), (0.0, 0.40)],
                                   'y', (x, y0, 0.55), 'carve', 12, cap_start=True, cap_end=False))
            parts.append(box(coll, f'{pre}_rail', W + 0.2, 0.06, 0.09, (0, y0 + 0.43, 0.55), 'oak_dark'))
            for i in range(nwin + 1):
                x = -W / 2 + pitch * i
                br = bez((x, -0.55, 0.0), (x, -0.30, 0.02), (x, -0.10, 0.25), (x, -0.06, 0.55), seg(12, 4))
                parts.append(tube(coll, f'{pre}_brk{i}', br, 'carve', taper(0.05, 0.035), sec=ellipse(1, 1, 8)))
    top = tiers * Ht
    if not crest:
        return parts, glass
    crest = bez((-W / 2, top, 0.05), (-W / 4, top + 0.12 * Ht + 0.15, 0.05), (W / 4, top + 0.12 * Ht + 0.15, 0.05), (W / 2, top, 0.05), seg(32, 8))
    parts.append(tube(coll, f'{pre}_crest', crest, 'carve', (0.05, 0.07), sec=rrect(2)))
    for sx in (-1, 1):
        sp = spiral((sx * (W / 2 - 0.06), top + 0.08, 0.06), 0.10, 0.015, 0.0 if sx > 0 else math.pi, 1.6, seg(32, 8), u=(sx, 0, 0), v=(0, 1, 0))
        parts.append(tube(coll, f'{pre}_scroll{sx}', sp, 'gilt', taper(0.03, 0.008), sec=ellipse(1, 1, 8)))
    parts.append(lathe(coll, f'{pre}_cartouche', [(0.0, 0.0), (0.16, 0.0), (0.17, 0.03), (0.12, 0.05), (0.0, 0.06)], 'z',
                       (0, top + 0.12 * Ht + 0.12, 0.06), 'gilt', 32, scale=(1.3, 1.0, 1.0)))
    return parts, glass


def build_stern(cls, W, tiers, nwin, Ht, balcony, arch, crest=True, suffix='', paint0=0, nl=1, above=None):
    # The galleon's two gallery tiers are two parts (lower with the balcony, upper with the taffrail),
    # each inside the 2-10k band; the lower carries the socket the upper mounts on.
    def fn(coll):
        parts, glass = gallery(coll, f'sg_{cls}{suffix}', W, tiers, nwin, Ht, balcony, arch, crest, paint0)
        pre = ('stern_transom_sloop' if cls == 'sloop' else f'stern_gallery_{cls}') + suffix
        if above:
            sock(pre, f'sock_{above}', (0, tiers * Ht, 0))
        for i in range(nl if crest else 0):
            x = 0.0 if nl == 1 else -W / 2 + 0.2 + (W - 0.4) * i / (nl - 1)
            sock(pre, f'sock_{pre}_lantern_{i}', (x, tiers * Ht + 0.06, 0.08))
        sock(pre, f'sock_{pre}', (0, 0, 0))
        return {pre: (parts, None), f'{pre}_glass': (glass, None)}
    return fn


def build_quarter(cls, Wq, Hq, depth):
    def fn(coll):
        parts, glass = [], []
        pre = f'quarter_gallery_{cls}'
        cw = Wq * 0.5
        poly = [(-Wq / 2, 0.0), (-cw / 2, depth), (cw / 2, depth), (Wq / 2, 0.0)]
        ang = math.atan2(depth, Wq / 2 - cw / 2)
        faces = [((0, depth), cw, 0.0), ((-(cw / 2 + Wq / 2) / 2, depth / 2), math.hypot(Wq / 2 - cw / 2, depth), -ang),
                 (((cw / 2 + Wq / 2) / 2, depth / 2), math.hypot(Wq / 2 - cw / 2, depth), ang)]
        for i, ((fx, fz), fw, a) in enumerate(faces):
            window(coll, f'qg_{cls}_w{i}', fx, Hq * 0.5, fw * 0.62, Hq * 0.55, False, parts, glass, z=fz, rot=ry(a))
            pnl = box(coll, f'qg_{cls}_pnl{i}', fw, Hq, 0.04, (0, 0, 0), 'paint_blue', bev=0.008)
            pnl.data.transform(Matrix.Translation(G(fx, Hq / 2, fz - 0.025)) @ ry(a))
            parts.append(pnl)
        n = seg(8, 6)
        for side, y0, sgn in (('roof', Hq, 1), ('drop', 0.0, -1)):
            rings = []
            for k in range(n + 1):
                t = k / n
                s = math.cos(t * math.pi / 2) * 0.999 + 0.001
                cz = depth * 0.35
                rings.append([(x * s, y0 + sgn * (0.12 + 0.30 * Hq * math.sin(t * math.pi / 2)), cz + (z - cz) * s) for (x, z) in poly + [(0, -0.02)]])
            rings.insert(0, [(x, y0, z) for (x, z) in poly + [(0, -0.02)]])
            parts.append(ring_loft(coll, f'qg_{cls}_{side}', rings, 'carve' if side == 'roof' else 'paint_red'))
        parts.append(lathe(coll, f'qg_{cls}_finial', [(0.0, 0.0), (0.04, 0.03), (0.06, 0.10), (0.03, 0.16), (0.045, 0.22), (0.0, 0.28)], 'y',
                           (0, -0.12 - 0.30 * Hq - 0.26, depth * 0.35), 'gilt', 16))
        parts.append(ball(coll, f'qg_{cls}_knob', 0.05, (0, Hq + 0.12 + 0.30 * Hq + 0.04, depth * 0.35), 'gilt', 14))
        for (x, z) in poly:
            parts.append(lathe(coll, f'qg_{cls}_post{x:+.2f}', [(0.045, 0.0), (0.05, 0.05), (0.035, 0.12), (0.035, Hq - 0.12), (0.05, Hq - 0.05), (0.045, Hq)],
                               'y', (x, 0.0, z), 'carve', 12))
        for y in (0.0, Hq):
            parts.append(tube(coll, f'qg_{cls}_band{y:.1f}', [(x, y, z + 0.02) for (x, z) in poly], 'carve', (0.05, 0.04), sec=rrect(2)))
        sock(pre, f'sock_{pre}', (0, 0, 0))
        return {pre: (parts, None), f'{pre}_glass': (glass, None)}
    return fn


# ── gunport, rudder, cathead ─────────────────────────────────────────────────
def build_gunport(coll):
    w, h, t = 0.78, 0.70, 0.09
    fr, lid = [], []
    for sy in (-1, 1):
        fr.append(box(coll, f'gp_tb{sy}', w + 2 * t, t, 0.12, (0, sy * (h / 2 + t / 2), 0.03), 'oak_dark'))
        fr.append(box(coll, f'gp_side{sy}', t, h, 0.12, (sy * (w / 2 + t / 2), 0, 0.03), 'oak_dark'))
    fr.append(box(coll, 'gp_sill', w + 2 * t + 0.08, 0.05, 0.16, (0, -h / 2 - t - 0.02, 0.05), 'carve'))
    fr.append(box(coll, 'gp_lintel', w + 2 * t + 0.08, 0.05, 0.14, (0, h / 2 + t + 0.02, 0.04), 'carve'))
    hy, hz = h / 2 + 0.03, 0.14
    for sx in (-1, 1):
        fr.append(box(coll, f'gp_plate{sx}', 0.08, 0.13, 0.015, (sx * w * 0.28, h / 2 + t * 0.55, 0.095), 'iron', bev=0.004))
        fr.append(lathe(coll, f'gp_pin{sx}', [(0.022, 0.0), (0.022, 0.07), (0.0, 0.07)], 'x', (sx * w * 0.28 - 0.035, hy, hz), 'iron', 16))
    fr.append(torus(coll, 'gp_tackle_eye', 0.03, 0.009, 'z', (0, h / 2 + t + 0.06, 0.07), 'iron', 16, 6))
    pw = (w + 0.04) / 4
    for i in range(4):
        lid.append(box(coll, f'gp_plank{i}', pw - 0.008, h + 0.06, 0.05, (-w / 2 - 0.02 + pw * (i + 0.5), hy - (h + 0.06) / 2, hz - 0.025), 'oak'))
    for sy in (-1, 1):
        lid.append(box(coll, f'gp_batten{sy}', w - 0.04, 0.08, 0.04, (0, hy - (h + 0.06) / 2 + sy * h * 0.28, hz - 0.07), 'oak_dark'))
    for sx in (-1, 1):
        lid.append(box(coll, f'gp_strap{sx}', 0.06, h * 0.9, 0.012, (sx * w * 0.28, hy - h * 0.45, hz + 0.006), 'iron', bev=0.004))
        lid.append(lathe(coll, f'gp_knuckle{sx}', [(0.026, 0.0), (0.026, 0.07), (0.0, 0.07)], 'x', (sx * w * 0.28 - 0.035, hy, hz + 0.002), 'iron', 16))
        for k in range(5):
            lid.append(ball(coll, f'gp_bolt{sx}_{k}', 0.012, (sx * w * 0.28, hy - 0.08 - k * h * 0.17, hz + 0.014), 'iron', 10))
    lid.append(torus(coll, 'gp_ring', 0.05, 0.011, 'z', (0, hy - h - 0.0, hz + 0.02), 'iron', 24, 8))
    lid.append(lathe(coll, 'gp_ringbolt', [(0.02, 0.0), (0.016, 0.03), (0.0, 0.035)], 'z', (0, hy - h + 0.05, hz), 'iron', 12))
    sock('gunport', 'sock_gunport', (0, 0, 0))
    sock('gunport', 'sock_gunport_hinge', (0, hy, hz))
    sock('gunport', 'sock_gunport_muzzle', (0, 0, -0.05))
    return {'gunport': (fr, None), 'gunport_lid': (lid, (0, hy, hz))}


def build_rudder(coll):
    Lr, n = 3.0, seg(24)
    rings = []
    m = seg(20)
    for k in range(n + 1):
        u = k / n
        y = 0.05 - Lr * u
        c = 0.42 + 0.38 * u ** 0.8
        t = 0.17 - 0.03 * u
        ring = []
        for j in range(m):
            a = 2 * math.pi * j / m
            z = 0.04 + c / 2 * (1 - math.cos(a))
            hh = t / 2 * (1 - 0.45 * (z / (c + 0.04)))
            s = math.sin(a)
            ring.append((math.copysign(abs(s) ** 0.55, s) * hh, y, z))
        rings.append(ring)
    blade = [ring_loft(coll, 'rd_blade', rings, 'oak')]
    blade.append(box(coll, 'rd_head', 0.22, 0.65, 0.26, (0, 0.35, 0.12), 'oak'))
    blade.append(box(coll, 'rd_mortise', 0.06, 0.12, 0.27, (0, 0.52, 0.12), 'oak_dark', bev=0.004))
    blade.append(box(coll, 'rd_headband', 0.25, 0.06, 0.29, (0, 0.18, 0.12), 'iron', bev=0.006))
    gud = []
    for k in range(4):
        y = -0.25 - k * 0.78
        blade.append(box(coll, f'rd_strap{k}', 0.19, 0.08, 0.55, (0, y, 0.33), 'iron', bev=0.006))
        blade.append(lathe(coll, f'rd_pin{k}', [(0.034, 0.0), (0.034, 0.16), (0.045, 0.17), (0.045, 0.19), (0.0, 0.19)], 'y', (0, y - 0.26, 0.0), 'iron', 16))
        for sx in (-1, 1):
            for b in range(3):
                blade.append(ball(coll, f'rd_bolt{k}{sx}{b}', 0.011, (sx * 0.097, y, 0.16 + b * 0.15), 'iron', 8))
        for sx in (-1, 1):
            gud.append(box(coll, f'rd_gstrap{k}{sx}', 0.03, 0.08, 0.6, (sx * 0.12, y - 0.13, -0.33), 'iron', bev=0.006))
            for b in range(3):
                gud.append(ball(coll, f'rd_gbolt{k}{sx}{b}', 0.011, (sx * 0.137, y - 0.13, -0.15 - b * 0.16), 'iron', 8))
        gud.append(torus(coll, f'rd_eye{k}', 0.065, 0.026, 'y', (0, y - 0.13, 0.0), 'iron', 24, 8))
        sock('rudder_gudgeons', f'sock_rudder_pintle_{k}', (0, y - 0.13, 0.0))
    sock('rudder_gudgeons', 'sock_rudder_axis', (0, 0, 0))
    sock('rudder', 'sock_rudder_tiller', (0, 0.52, 0.12))
    return {'rudder_gudgeons': (gud, None), 'rudder': (blade, None)}


def build_cathead(coll):
    parts = [box(coll, 'ch_beam', 0.30, 0.30, 1.4, (0, 0, 0.5), 'oak', bev=0.02)]
    kp = bez((0, -0.95, 0.02), (0, -0.55, 0.05), (0, -0.25, 0.35), (0, -0.16, 0.80), seg(16))
    parts.append(tube(coll, 'ch_knee', kp, 'oak_dark', taper(0.12, 0.09), sec=rrect()))
    for z in (0.10, 0.62):
        parts.append(box(coll, f'ch_band{z}', 0.33, 0.33, 0.07, (0, 0, z), 'iron', bev=0.008))
    for sx in (-1, 1):
        parts.append(box(coll, f'ch_slot{sx}', 0.05, 0.31, 0.32, (sx * 0.07, 0, 0.95), 'oak_dark', bev=0.004))
        parts.append(lathe(coll, f'ch_sheave{sx}', [(0.03, -0.02), (0.11, -0.02), (0.12, -0.01), (0.10, 0.0), (0.12, 0.01), (0.11, 0.02), (0.03, 0.02)],
                           'x', (sx * 0.07, 0.0, 0.95), 'oak_dark', 24, closed=True))
        parts.append(lathe(coll, f'ch_axle{sx}', [(0.025, -0.17), (0.025, 0.17)], 'x', (0, 0, 0.95), 'iron', 12))
    parts.append(lathe(coll, 'ch_boss', [(0.0, 0.0), (0.13, 0.0), (0.135, 0.02), (0.10, 0.045), (0.05, 0.06), (0.0, 0.065)], 'z', (0, 0, 1.2), 'carve', 32))
    for k in range(8):
        a = 2 * math.pi * k / 8
        parts.append(ball(coll, f'ch_petal{k}', 0.035, (0.08 * math.cos(a), 0.08 * math.sin(a), 1.235), 'gilt', 10, scale=(1.0, 1.0, 0.5)))
    parts.append(torus(coll, 'ch_eye', 0.035, 0.012, 'z', (0, -0.18, 1.05), 'iron', 16, 6))
    sock('cathead', 'sock_cathead', (0, 0, 0))
    sock('cathead', 'sock_cathead_sheave', (0, -0.05, 0.95))
    return {'cathead': (parts, None)}


BUILDS = [
    ('figurehead_sloop', FIG, build_figurehead_sloop),
    ('figurehead_brigantine', FIG, build_figurehead_brig),
    ('figurehead_galleon', FIG, build_figurehead_galleon),
    ('stern_gallery_galleon', PART, build_stern('galleon', 5.0, 1, 5, 1.35, True, True, crest=False, above='stern_gallery_galleon_upper')),
    ('stern_gallery_galleon_upper', PART, build_stern('galleon', 4.8, 1, 5, 1.25, False, True, suffix='_upper', paint0=1, nl=3)),
    ('stern_gallery_brigantine', PART, build_stern('brigantine', 3.6, 1, 4, 1.3, True, False, nl=2)),
    ('stern_transom_sloop', PART, build_stern('sloop', 2.4, 1, 2, 1.1, False, False, nl=1)),
    ('quarter_gallery_galleon', PART, build_quarter('galleon', 1.8, 1.25, 0.55)),
    ('quarter_gallery_brigantine', PART, build_quarter('brigantine', 1.3, 1.0, 0.42)),
    ('gunport', PART, build_gunport),
    ('rudder', PART, build_rudder),
    ('cathead', PART, build_cathead),
]


def tris_of(objs):
    return sum(len(p.vertices) - 2 for o in objs for p in o.data.polygons)


def join_as(objs, nm, pivot=None):
    base = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    base.name = nm
    base.data.name = nm
    if pivot is not None:
        base.data.transform(Matrix.Translation(-G(*pivot)))
        base.location = G(*pivot)
    return base


def build(key, band, fn):
    lo, hi = band
    target = (lo + hi) / 2
    D['d'] = 1.0
    for attempt in range(6):
        coll = asset_collection(key)  # noqa: F821
        socks0 = dict(SOCK)
        groups = fn(coll)
        nodes = [join_as(parts, g, pivot) for g, (parts, pivot) in groups.items() if parts]
        t = tris_of(nodes)
        print(f'BUILD {key} d={D["d"]:.3f} tris={t}', flush=True)
        if lo <= t <= hi:
            DENS[key] = round(D['d'], 3)
            return coll, nodes, t
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        SOCK.clear()
        SOCK.update(socks0)
        D['d'] *= target / t
    raise RuntimeError(f'{key}: could not land in {band}')


def export(objs, path, images=True):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_animations=False, export_skins=False, export_morph=False, export_extras=True,
              export_image_format='JPEG' if images else 'NONE', export_jpeg_quality=90,
              export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
    last = None
    for drop in ((), ('export_active_vertex_color_when_no_material',), ('export_jpeg_quality',)):
        try:
            bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k not in drop})
            return path
        except TypeError as e:
            last = e
    raise last


def glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    jl = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + jl])


def node_tris(j):
    out = {}
    for n in j['nodes']:
        if n.get('mesh') is not None:
            out[n['name']] = sum(j['accessors'][p['indices']]['count'] // 3 for p in j['meshes'][n['mesh']]['primitives'])
    return out


def white(objs):
    for o in objs:
        col = o.data.color_attributes.get('Col') or o.data.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
        for c in col.data:
            c.color = (1.0, 1.0, 1.0, 1.0)
        o.data.color_attributes.active_color = col


P.require_licensed(SOURCES)
built = {}
for key, band, fn in BUILDS:
    built[key] = (band,) + build(key, band, fn)
# ONE ship trim atlas for the kit: park the parts apart so nothing occludes another in the AO bake.
atlas_objs = []
for i, (key, (band, coll, nodes, t)) in enumerate(built.items()):
    for o in nodes:
        o.location.x += 7.0 * i
        if not o.name.endswith('_glass'):
            atlas_objs.append(o)
# cage 6 mm: the default 20 mm cage is thicker than the fronds, frill spines and crown points and baked them black
A.pbr_atlas(atlas_objs, 'ship_trim', tier='near', samples=SAMPLES, cage_offset=0.006)
for i, (key, (band, coll, nodes, t)) in enumerate(built.items()):
    for o in nodes:
        o.location.x -= 7.0 * i
all_nodes, part_of = [], {}
for key, (band, coll, nodes, t) in built.items():
    for o in nodes:
        part_of[o.name] = key
        o['kit_part'] = key
        if not o.name.endswith('_glass'):
            for poly in o.data.polygons:
                poly.material_index = 0
        all_nodes.append(o)
    white(nodes)
# socket empties: local +Z = out, +Y = up (game), at the mount / attach point
sock_objs = []
for sn, (part, at, out, up) in SOCK.items():
    e = bpy.data.objects.new(sn, None)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = 0.15
    bpy.context.scene.collection.objects.link(e)
    gz = Vector(out).normalized()
    gy = (Vector(up) - gz * Vector(up).dot(gz)).normalized()
    gx = gy.cross(gz)
    Mg = Matrix(((gx.x, gy.x, gz.x, at[0]), (gx.y, gy.y, gz.y, at[1]), (gx.z, gy.z, gz.z, at[2]), (0, 0, 0, 1)))
    e.matrix_world = CM @ Mg @ CM.inverted()
    e['kit_part'] = part
    e['socket'] = True
    sock_objs.append(e)
path = export(all_nodes + sock_objs, os.path.join(OUT, f'{name}.glb'))
j = glb(path)
nt = node_tris(j)
errs, report = [], {'parts': {}, 'sockets': sorted(SOCK), 'bytes': os.path.getsize(path)}
for key, (band, coll, nodes, t) in built.items():
    tris = sum(nt.get(o.name, 0) for o in nodes)
    report['parts'][key] = {'tris': tris, 'band': band, 'density': DENS[key], 'nodes': sorted(o.name for o in nodes)}
    if not band[0] <= tris <= band[1]:
        errs.append(f'{key} {tris} tris outside {band}')
names = {n['name'] for n in j['nodes']}
for sn in SOCK:
    if sn not in names:
        errs.append(f'socket {sn} not exported')
for m in j.get('materials', []):
    pmr = m.get('pbrMetallicRoughness', {})
    if m['name'] == 'Glass_Gallery':
        if not any(v > 0 for v in m.get('emissiveFactor', [0, 0, 0])):
            errs.append('Glass_Gallery lost its emissive')
        continue
    if m.get('doubleSided'):
        errs.append(f"{m['name']} doubleSided")
    if 'normalTexture' not in m or 'metallicRoughnessTexture' not in pmr or 'baseColorTexture' not in pmr:
        errs.append(f"{m['name']} lacks baseColor + normal + ORM")
report['tris'] = sum(nt.values())
# LODs: per node (glass panes excluded: 2 tris a pane, the LOD0 panes serve every level), welded then
# collapsed; geometry only (no images), materials by name, `<node>_LOD1` / `<node>_LOD2`.
lod_objs = {'LOD1': [], 'LOD2': []}
for o in all_nodes:
    if o.name.endswith('_glass'):
        continue
    for lvl, r in LOD_R.items():
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        c.name = c.data.name = f'{o.name}_{lvl}'
        bm = bmesh.new()
        bm.from_mesh(c.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        bm.to_mesh(c.data)
        bm.free()
        mod = c.modifiers.new('lod', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = r
        with bpy.context.temp_override(object=c, active_object=c):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        lod_objs[lvl].append(c)
lpath = export(lod_objs['LOD1'] + lod_objs['LOD2'], os.path.join(OUT, f'{name}_lods.glb'), images=False)
lt = node_tris(glb(lpath))
for key, (band, coll, nodes, t) in built.items():
    prev = report['parts'][key]['tris']
    for lvl, r in LOD_R.items():
        v = sum(lt.get(f'{o.name}_{lvl}', 0) for o in nodes if not o.name.endswith('_glass'))
        report['parts'][key][lvl] = v
        if v <= 0 or v >= prev or v > report['parts'][key]['tris'] * (0.40 if lvl == 'LOD1' else 0.12):
            errs.append(f'{key} {lvl} {v} not under its ratio of {report["parts"][key]["tris"]}')
        prev = v
report['lods_bytes'] = os.path.getsize(lpath)
report['errors'] = errs
with open('/tmp/pbr-ship-kit.json', 'w') as f:
    json.dump(report, f, indent=1)
print('SHIP KIT REPORT ' + json.dumps(report))


# ── contact sheet: one row per part, LOD0 | LOD1 | LOD2 (Cycles CPU, small tiles) ──
def render_sheet(out):
    import numpy as np
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.device = 'CPU'
    scn.cycles.samples = 10
    scn.cycles.use_denoising = False
    scn.render.threads_mode = 'FIXED'
    scn.render.threads = 3
    tw, th = 300, 225
    scn.render.resolution_x, scn.render.resolution_y = tw, th
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = 'PNG'
    scn.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('kit_sky')
    scn.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.62, 0.72, 1)
    sun = bpy.data.objects.new('kit_sun', bpy.data.lights.new('kit_sun', 'SUN'))
    scn.collection.objects.link(sun)
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), math.radians(15), math.radians(35))
    cam = bpy.data.objects.new('kit_cam', bpy.data.cameras.new('kit_cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.type = 'ORTHO'
    every = [o for o in scn.objects if o.type == 'MESH']
    tmp = '/tmp/pbr_ship_kit_sheet'
    os.makedirs(tmp, exist_ok=True)
    rows = []
    for key, (band, coll, nodes, t) in built.items():
        row = []
        for lvl in ('LOD0', 'LOD1', 'LOD2'):
            show = nodes if lvl == 'LOD0' else [c for c in lod_objs[lvl] if part_of.get(c.name[:-5]) == key] + [o for o in nodes if o.name.endswith('_glass')]
            for o in every:
                o.hide_render = o not in show
            bpy.context.view_layer.update()
            pts = [o.matrix_world @ Vector(c) for o in nodes for c in o.bound_box]
            mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
            mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
            size, ctr = max(mx - mn), (mn + mx) / 2
            cam.data.ortho_scale = size * 1.3
            el, yaw, dd = math.radians(18), math.radians(70 if key == 'rudder' else 35), size * 10
            # yaw 0 puts the camera on blender -y = game +z: it looks at the OUT face
            cam.location = ctr + Vector((dd * math.cos(el) * math.sin(yaw), -dd * math.cos(el) * math.cos(yaw), dd * math.sin(el)))
            cam.rotation_euler = (math.radians(90) - el, 0, yaw)
            cam.data.clip_end = dd * 4
            p = os.path.join(tmp, f'{key}_{lvl}.png')
            scn.render.filepath = p
            bpy.ops.render.render(write_still=True)
            row.append(p)
        rows.append(row)
        print('SHEET_ROW', key, flush=True)
    cols = 6  # two parts per sheet row
    pairs = [rows[i] + (rows[i + 1] if i + 1 < len(rows) else []) for i in range(0, len(rows), 2)]
    W_, H_ = cols * tw, len(pairs) * th
    sheet = np.ones((H_, W_, 4), dtype=np.float32)
    sheet[..., :3] = 0.12
    for ri, r in enumerate(pairs):
        for ci, tp in enumerate(r):
            img = bpy.data.images.load(tp)
            px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            y0 = H_ - (ri + 1) * th
            sheet[y0:y0 + th, ci * tw:(ci + 1) * tw] = px.reshape(img.size[1], img.size[0], 4)
            bpy.data.images.remove(img)
    im = bpy.data.images.new('kit_sheet', W_, H_, alpha=True)
    im.pixels.foreach_set(sheet.ravel())
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.filepath_raw = out
    im.file_format = 'PNG'
    im.save()
    print(f'SHEET_WRITTEN {out} {W_}x{H_}', flush=True)


if SHEET:
    render_sheet(SHEET)
if errs:
    print(f'SHIP KIT FAILED: {errs}')
    sys.exit(1)
print('SHIP KIT DONE')
