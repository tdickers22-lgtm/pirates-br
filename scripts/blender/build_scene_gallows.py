# Gallows Sands hero scene — `gallows`
#   Mass hanging site on a dune top. Weathered TRIPLE gallows (heavy beveled
#   frame, leaning), three FRAYED CUT ropes swinging free, kicked-over stool,
#   three shallow graves but FOUR hats on marker stakes, coffin cart with one
#   wheel off, crow on the crossbeam. Focal: cut ropes + the fourth hat.
#   Faces its audience toward Blender -Y (graves + cut ropes front side).
# Headless: Blender -b -P scripts/blender/build_scene_gallows.py
# PBR_RENDER_DIR -> turntable renders; PBR_EXPORT_DIR -> scratch export override.
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", os.environ.get("PBR_RENDER_DIR", ""))
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR))

clear_default_scene()
# AgX-compensated palette (audit: the dune pad + timber washed out to a flat
# beige cone at distance). Registers Sand_Pad/Grave_Dirt darker than the old
# local overrides, so the pad reads as damp dune sand, not paper.
agx_palette({"Dirt_Fresh": ((0.230, 0.180, 0.115, 1.0), 0.96, 0.0)})

rng = random.Random(1746)

# ── dune ground profile ──────────────────────────────────────
BASE_R = 4.0
BASE_H = 0.62
BEAM_Z = 5.0            # crossbeam centre height — frame tops out ~5.2m


def rim_sink(rr):
    """Feathered rim drop (universal pad rule): 0 at the dune centre easing
    to 0.55 below z=0 at the rim so the pad meets terrain with no hard seam.
    rr is the normalized radius (1.0 = pad edge)."""
    t = min(1.0, max(0.0, (rr - 0.55) / 0.45))
    return 0.55 * t * t * (3.0 - 2.0 * t)


def gz(x, y):
    """Approx dune-cap height at (x,y) so props seat into the mound."""
    r2 = (x * x + (y / 0.92) ** 2) / (BASE_R * BASE_R)
    return BASE_H * math.sqrt(max(0.0, 1.0 - r2)) - 0.05 - rim_sink(math.sqrt(r2))


# ── generic builders ─────────────────────────────────────────
def chain_pts(coll, name, pts, r1, r2, material, segs=7, smooth=True, balls=False):
    """Chain of tapered cylinders through pts (ropes, curved members).
    balls=True adds joint spheres so direction changes read smooth."""
    parts = []
    n = len(pts) - 1
    if balls:
        for i in range(1, n):
            t = i / n
            bm = bm_icosphere((r1 + (r2 - r1) * t) * 1.02, 2)
            bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(pts[i])), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_j{i}", bm, coll, material, smooth=True))
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        t0, t1 = i / n, (i + 1) / n
        bm = bm_cylinder(r1 + (r2 - r1) * t0, r1 + (r2 - r1) * t1,
                         d.length + 0.012, segs=segs)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material, smooth=smooth))
    return parts


def bm_torus(R, r, segs=16, rings=6):
    bm = bmesh.new()
    grid = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(rings):
            b = 2 * math.pi * j / rings
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * ca, rr * sa, r * math.sin(b))))
        grid.append(ring)
    for i in range(segs):
        for j in range(rings):
            bm.faces.new((grid[i][j], grid[(i + 1) % segs][j],
                          grid[(i + 1) % segs][(j + 1) % rings],
                          grid[i][(j + 1) % rings]))
    return bm


def crow(coll, name, loc, yaw):
    """Chunky crow silhouette, Char_Black."""
    parts = []
    M = Matrix.Translation(loc) @ Matrix.Rotation(yaw, 4, 'Z')
    bm = bm_icosphere(0.085, 2)
    bmesh.ops.scale(bm, vec=Vector((0.72, 1.55, 0.95)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0, 0.115)) @
                        Matrix.Rotation(0.18, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_body", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_icosphere(0.05, 2)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0.115, 0.20)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_head", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_cylinder(0.018, 0.003, 0.075, segs=6)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0.185, 0.185)) @
                        Matrix.Rotation(-math.pi / 2, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_beak", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_box(0.055, 0.16, 0.02)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, -0.145, 0.14)) @
                        Matrix.Rotation(-0.42, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_tail", bm, coll, mat("Char_Black")))
    return parts


def hat(coll, name, loc, yaw, tilt):
    """Weathered tricorn-ish hat: curled brim + tapered crown + rope band."""
    parts = []
    M = Matrix.Translation(loc) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'X')
    bm = bm_cylinder(0.255, 0.235, 0.03, segs=14)
    for v in bm.verts:
        ang = math.atan2(v.co.y, v.co.x)
        rr = math.hypot(v.co.x, v.co.y)
        v.co.z += 0.075 * max(0.0, math.cos(3 * ang)) * (rr / 0.255)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_brim", bm, coll, mat("Coconut"), smooth=True))
    bm = bm_cylinder(0.148, 0.118, 0.17, segs=12)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0, 0.095)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_crown", bm, coll, mat("Coconut"), smooth=True))
    bm = bm_cylinder(0.155, 0.152, 0.035, segs=12, cap=False)
    bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, 0, 0.045)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_band", bm, coll, mat("Rope"), smooth=True))
    return parts


def finish(objs, width=0.02, segments=2):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


# ═════════════════════════════════════════════════════════════
# GALLOWS — hero scene, 25-45k tris
# ═════════════════════════════════════════════════════════════
def build_gallows(name="gallows"):
    coll = asset_collection(name)
    parts, bev = [], []

    # ── dune cap base ────────────────────────────────────────
    # AUDIT FIX: this read as "a large smooth beige cone". Now: crescent
    # wind ripples (barchan-style, transverse to the prevailing -Y wind),
    # a scalloped deflation hollow on the lee side, and a slumped windward
    # brow — so the silhouette has direction instead of being a dome.
    bm = bm_icosphere(1.0, 5)
    bmesh.ops.scale(bm, vec=Vector((BASE_R, BASE_R * 0.92, BASE_H)), verts=bm.verts)
    for v in bm.verts:
        up = max(0.0, v.co.z / BASE_H)
        rr = math.hypot(v.co.x / BASE_R, v.co.y / (BASE_R * 0.92))
        # primary ripple train, crests running across the wind
        v.co.z += 0.055 * math.sin(v.co.y * 4.6 + v.co.x * 0.7) * up
        # secondary finer ripples, phase-shifted so crests wander
        v.co.z += 0.022 * math.sin(v.co.y * 11.0 + math.sin(v.co.x * 2.2) * 1.6) * up
        # windward brow steepens, lee face slumps out into a longer tail
        v.co.z += 0.075 * up * math.cos(math.atan2(v.co.y, v.co.x) + 1.35) * rr
        # deflation hollow scooped behind the frame
        d = math.hypot(v.co.x - 0.4, v.co.y - 2.0)
        if d < 1.5:
            v.co.z -= 0.085 * (1.0 - d / 1.5) ** 2 * up
    o = obj_from_bmesh(f"{name}_dune", bm, coll, mat("Sand_Pad"), smooth=True)
    displace_noise(o, strength=0.09, scale=2.2, seed=3)
    displace_noise(o, strength=0.045, scale=0.55, seed=13)
    apply_modifiers(o)
    parts.append(o)
    # half-buried shells + shale chips: scale reference on the bare sand, and
    # the thing that stops a 8 m pad reading as one untextured surface
    for ci in range(22):
        a = rng.uniform(0, math.tau)
        rr = math.sqrt(rng.uniform(0.10, 1.0)) * BASE_R * 0.88
        cx, cy = math.cos(a) * rr, math.sin(a) * rr * 0.92
        s = rng.uniform(0.05, 0.13)
        bm = bm_icosphere(s, 1)
        bmesh.ops.scale(bm, vec=Vector((1.0, rng.uniform(0.7, 1.3),
                                        rng.uniform(0.25, 0.45))), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (cx, cy, gz(cx, cy) + s * 0.10)) @ Matrix.Rotation(a, 4, 'Z') @
            Matrix.Rotation(rng.uniform(-0.3, 0.3), 4, 'Y'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_chip{ci}", bm, coll,
                                    mat("Wood_Bleached") if ci % 3 == 0
                                    else mat("Rock_Grey"), smooth=False))

    # ── the frame: heavy triple gallows, leaning ─────────────
    LEAN = Matrix.Rotation(math.radians(3.2), 4, 'Y') @ Matrix.Rotation(math.radians(1.8), 4, 'X')
    post_woods = (mat("Wood_Dark"), mat("Wood_Mid"))
    for k, sx in enumerate((-1, 1)):
        base = gz(sx * 1.9, 0)
        bm = bm_box(0.30, 0.30, 4.15)
        # ADZE-HEWN, not sawn: shallow tool facets down two faces + a taper
        # toward the head, so the post silhouette breaks under raking light.
        for v in bm.verts:
            if v.co.z > 1.5:
                v.co.x += 0.02 * math.sin(v.co.z * 2.1 + sx)
            f = 1.0 - 0.055 * max(0.0, (v.co.z + 2.075) / 4.15)   # slight taper
            v.co.x *= f
            v.co.y *= f
            v.co.x += 0.014 * math.sin(v.co.z * 5.3 + k * 2.0) * (1 if v.co.x > 0 else -1)
            v.co.y += 0.011 * math.sin(v.co.z * 3.7 + 1.1 + k) * (1 if v.co.y > 0 else -1)
        m = Matrix.Translation((sx * 1.9, 0, base + 4.15 / 2 - 0.35))
        bmesh.ops.transform(bm, matrix=LEAN @ m, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_post{k}", bm, coll, post_woods[k])
        parts.append(o); bev.append(o)
        # THROUGH-TENON head: the post's reduced tongue standing proud of the
        # crossbeam, pinned by a drawbore peg driven across it. This one detail
        # is the difference between "two sticks and a plank" and joinery.
        ten = bm_box(0.155, 0.30, 0.34)
        for v in ten.verts:                     # chamfered, weather-rounded top
            if v.co.z > 0.10:
                v.co.x *= 0.80
                v.co.y *= 0.86
        bmesh.ops.transform(ten, matrix=LEAN @ Matrix.Translation(
            (sx * 1.9, 0, base + 3.97)), verts=ten.verts)
        o = obj_from_bmesh(f"{name}_tenon{k}", ten, coll, post_woods[k])
        parts.append(o); bev.append(o)
        peg = bm_cylinder(0.036, 0.032, 0.42, segs=7)
        bmesh.ops.transform(peg, matrix=LEAN @ Matrix.Translation(
            (sx * 1.9, 0, base + 3.90)) @ Matrix.Rotation(math.pi / 2, 4, 'X'),
            verts=peg.verts)
        parts.append(obj_from_bmesh(f"{name}_peg{k}", peg, coll,
                                    mat("Wood_Light"), smooth=True))
        # forged iron strap wrapping the post/beam junction, four bolt heads
        for zoff, wband in ((3.62, 0.36), (3.86, 0.34)):
            for face in (-1, 1):
                bm2 = bm_box(0.335, 0.05, 0.11)
                bmesh.ops.transform(bm2, matrix=LEAN @ Matrix.Translation(
                    (sx * 1.9, face * 0.168, base + zoff)), verts=bm2.verts)
                o = obj_from_bmesh(f"{name}_strap{k}{face}{int(zoff*10)}", bm2,
                                   coll, mat("Metal_Band"))
                parts.append(o); bev.append(o)
                for bi in (-1, 1):
                    bh = bm_icosphere(0.033, 1)
                    bmesh.ops.scale(bh, vec=Vector((1, 0.55, 1)), verts=bh.verts)
                    bmesh.ops.transform(bh, matrix=LEAN @ Matrix.Translation(
                        (sx * 1.9 + bi * 0.11, face * 0.196, base + zoff)),
                        verts=bh.verts)
                    parts.append(obj_from_bmesh(
                        f"{name}_bolt{k}{face}{bi}{int(zoff*10)}", bh, coll,
                        mat("Metal_Iron"), smooth=True))
        # rot at the ground line: a ragged char/damp collar where sand meets post
        collar = bm_cylinder(0.245, 0.215, 0.30, segs=12)
        for v in collar.verts:
            a2 = math.atan2(v.co.y, v.co.x)
            v.co.z += 0.055 * math.sin(a2 * 4.0 + k) * (1 if v.co.z > 0 else 0.2)
        bmesh.ops.transform(collar, matrix=Matrix.Translation(
            (sx * 1.9, 0, base + 0.04)), verts=collar.verts)
        parts.append(obj_from_bmesh(f"{name}_rot{k}", collar, coll,
                                    mat("Wood_Dark"), smooth=False))
        # ground feet beam (half sunk)
        bm = bm_box(0.34, 1.35, 0.20)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((sx * 1.9, 0.05 * sx, base + 0.03)) @
                            Matrix.Rotation(0.05 * sx, 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_foot{k}", bm, coll, mat("Wood_Bleached"))
        parts.append(o); bev.append(o)
    # crossbeam (extends past the posts, end-checked)
    bm = bm_box(5.5, 0.26, 0.30)
    for v in bm.verts:
        if v.co.x > 2.6:                       # split/checked beam end
            v.co.z += 0.035 if v.co.z > 0 else -0.01
            v.co.y *= 0.8
    bmesh.ops.transform(bm, matrix=LEAN @ Matrix.Translation((0.1, 0, 3.95)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_beam", bm, coll, mat("Wood_Mid"))
    parts.append(o); bev.append(o)
    # knee braces
    for sx in (-1, 1):
        bm = bm_box(0.14, 0.17, 1.42)
        m = (Matrix.Translation((sx * 1.42, 0, 3.42)) @
             Matrix.Rotation(-sx * math.radians(44), 4, 'Y'))
        bmesh.ops.transform(bm, matrix=LEAN @ m, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_brace{sx}", bm, coll, mat("Wood_Mid"))
        parts.append(o); bev.append(o)
    # iron-less joint wraps: rope lashings where braces meet the beam
    for sx in (-1, 1):
        bm = bm_cylinder(0.20, 0.20, 0.06, segs=10, cap=False)
        m = Matrix.Translation((sx * 0.95, 0, 3.95)) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
        bmesh.ops.transform(bm, matrix=LEAN @ m, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_wrap{sx}", bm, coll, mat("Rope"), smooth=True))

    # ── three frayed CUT ropes, swinging free ────────────────
    beam_bot = 3.95 - 0.135
    for ri, (rx, length, amp, ph) in enumerate(((-1.25, 1.55, -0.30, 0.0),
                                                (0.05, 1.10, 0.22, 1.3),
                                                (1.35, 1.80, -0.16, 2.2))):
        attach = LEAN @ Vector((rx, 0, beam_bot + 0.05))
        # knot wrap around the beam
        bm = bm_cylinder(0.185, 0.185, 0.055, segs=10, cap=False)
        m = Matrix.Translation((rx, 0, 3.95)) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
        bmesh.ops.transform(bm, matrix=LEAN @ m, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_knot{ri}", bm, coll, mat("Rope"), smooth=True))
        pts = []
        n = 10
        for i in range(n + 1):
            t = i / n
            pts.append((attach.x + 0.05 * math.sin(ph + t * 2.2) * t,
                        attach.y + amp * t * t,
                        attach.z - length * t))
        parts += chain_pts(coll, f"{name}_rope{ri}", pts, 0.045, 0.036, mat("Rope"),
                           segs=8, balls=True)
        # frayed cut end: splayed strands
        end = Vector(pts[-1])
        for si in range(5):
            a = ph + si * 1.35
            d = Vector((math.cos(a) * 0.07, math.sin(a) * 0.07, -0.14))
            parts += chain_pts(coll, f"{name}_fray{ri}_{si}",
                               [end, end + d * 0.5 + Vector((0, 0, -0.02)), end + d],
                               0.013, 0.005, mat("Rope"), segs=5)

    # ── hangman's stool, kicked over ─────────────────────────
    sb = gz(0.35, 0.75)
    SM = (Matrix.Translation((0.35, 0.75, sb + 0.16)) @
          Matrix.Rotation(0.7, 4, 'Z') @ Matrix.Rotation(math.radians(103), 4, 'X'))
    bm = bm_box(0.36, 0.36, 0.05)
    bmesh.ops.transform(bm, matrix=SM @ Matrix.Translation((0, 0, 0.21)), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_seat", bm, coll, mat("Wood_Light"))
    parts.append(o); bev.append(o)
    for lx in (-1, 1):
        for ly in (-1, 1):
            bm = bm_cylinder(0.028, 0.02, 0.42, segs=6)
            m = SM @ Matrix.Translation((lx * 0.13, ly * 0.13, 0)) @ \
                Matrix.Rotation(lx * 0.1, 4, 'Y') @ Matrix.Rotation(-ly * 0.1, 4, 'X')
            bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
            o = obj_from_bmesh(f"{name}_leg{lx}{ly}", bm, coll, mat("Wood_Light"), smooth=True)
            parts.append(o)

    # ── three shallow graves ... four hats on stakes ─────────
    graves = ((-2.55, -1.65, 0.28), (-1.3, -2.0, -0.08), (0.0, -1.8, 0.15))
    for gi, (gx, gy, gyaw) in enumerate(graves):
        bm = bm_icosphere(1.0, 4)
        bmesh.ops.scale(bm, vec=Vector((0.40, 0.86, 0.27)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((gx, gy, gz(gx, gy) + 0.015)) @
                            Matrix.Rotation(gyaw, 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_grave{gi}", bm, coll, mat("Grave_Dirt"), smooth=True)
        displace_noise(o, strength=0.05, scale=0.5, seed=23 + gi)
        apply_modifiers(o)
        parts.append(o)
        # turned-earth clods heaped round the mound: gives the grave a real
        # edge against the sand instead of a soft airbrushed lump
        for ci in range(9):
            ca = rng.uniform(0, math.tau)
            crr = rng.uniform(0.30, 0.92)
            clx = gx + math.cos(ca + gyaw) * crr * 0.52
            cly = gy + math.sin(ca + gyaw) * crr * 1.0
            cs = rng.uniform(0.055, 0.125)
            cb = bm_icosphere(cs, 1)
            bmesh.ops.scale(cb, vec=Vector((1.0, rng.uniform(0.7, 1.3),
                                            rng.uniform(0.45, 0.8))),
                            verts=cb.verts)
            bmesh.ops.transform(cb, matrix=Matrix.Translation(
                (clx, cly, gz(clx, cly) + cs * 0.30)) @
                Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=cb.verts)
            parts.append(obj_from_bmesh(f"{name}_clod{gi}{ci}", cb, coll,
                                        mat("Grave_Dirt"), smooth=False))
    # stakes: 3 at grave heads + THE FOURTH with no grave (front & center)
    stakes = [(gx + 0.95 * math.sin(gyaw), gy - 0.95 * math.cos(gyaw), gyaw)
              for gx, gy, gyaw in graves]
    stakes.append((1.3, -2.0, -0.3))            # the fourth hat — no grave
    for si, (sx_, sy_, syaw) in enumerate(stakes):
        base = gz(sx_, sy_)
        tiltx, tilty = rng.uniform(-0.12, 0.12), rng.uniform(-0.14, 0.14)
        SM2 = (Matrix.Translation((sx_, sy_, base - 0.06)) @
               Matrix.Rotation(tiltx, 4, 'X') @ Matrix.Rotation(tilty, 4, 'Y'))
        bm = bm_cylinder(0.042, 0.03, 0.95, segs=7)
        bmesh.ops.transform(bm, matrix=SM2 @ Matrix.Translation((0, 0, 0.47)), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_stake{si}", bm, coll,
                           mat("Wood_Bleached") if si % 2 else mat("Wood_Dark"), smooth=True)
        parts.append(o); bev.append(o)
        top = SM2 @ Vector((0, 0, 0.93))
        parts += hat(coll, f"{name}_hat{si}", top, syaw + rng.uniform(-0.5, 0.5),
                     rng.uniform(0.06, 0.22))

    # ── coffin cart, one wheel off ───────────────────────────
    # tipped 17.5deg about the surviving wheel's contact point so the bare
    # axle stub digs into the sand
    cb = gz(2.35, 1.55)
    pivot = Vector((-0.72, 0.1, -0.02))
    TIP = (Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(17.5), 4, 'Y') @
           Matrix.Translation(-pivot))
    CART = Matrix.Translation((2.35, 1.55, cb)) @ Matrix.Rotation(0.55, 4, 'Z') @ TIP
    # bed planks (uneven)
    for pi in range(5):
        px = -0.42 + pi * 0.21
        bm = bm_box(0.185, 1.95 + rng.uniform(-0.1, 0.08), 0.05)
        bmesh.ops.transform(bm, matrix=CART @ Matrix.Translation((px, rng.uniform(-0.04, 0.04), 0.60)) @
                            Matrix.Rotation(rng.uniform(-0.02, 0.02), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_bed{pi}", bm, coll,
                           mat("Wood_Light") if pi % 2 else mat("Wood_Mid"))
        parts.append(o); bev.append(o)
    # side rails + axle
    for sx in (-1, 1):
        bm = bm_box(0.08, 2.0, 0.16)
        bmesh.ops.transform(bm, matrix=CART @ Matrix.Translation((sx * 0.52, 0, 0.70)), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_rail{sx}", bm, coll, mat("Wood_Dark"))
        parts.append(o); bev.append(o)
    bm = bm_cylinder(0.055, 0.055, 1.55, segs=8)
    bmesh.ops.transform(bm, matrix=CART @ Matrix.Translation((0, 0.1, 0.48)) @
                        Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{name}_axle", bm, coll, mat("Wood_Dark"), smooth=True))
    # pull shafts resting on the ground
    for sx in (-1, 1):
        bm = bm_cylinder(0.045, 0.032, 1.6, segs=7)
        m = CART @ Matrix.Translation((sx * 0.42, -1.55, 0.28)) @ Matrix.Rotation(math.radians(115), 4, 'X')
        bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_shaft{sx}", bm, coll, mat("Wood_Mid"), smooth=True))

    def wheel(tag, M):
        w = []
        bm = bm_torus(0.46, 0.048, segs=24, rings=8)
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        w.append(obj_from_bmesh(f"{name}_{tag}_rim", bm, coll, mat("Wood_Dark"), smooth=True))
        bm = bm_cylinder(0.10, 0.10, 0.14, segs=9)
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        w.append(obj_from_bmesh(f"{name}_{tag}_hub", bm, coll, mat("Wood_Mid"), smooth=True))
        for k in range(8):
            a = k * math.pi / 4
            bm = bm_box(0.045, 0.045, 0.40)
            mm = M @ Matrix.Rotation(a, 4, 'Z') @ Matrix.Translation((0, 0.25, 0)) @ \
                Matrix.Rotation(math.pi / 2, 4, 'X')
            bmesh.ops.transform(bm, matrix=mm, verts=bm.verts)
            w.append(obj_from_bmesh(f"{name}_{tag}_sp{k}", bm, coll, mat("Wood_Light")))
        return w
    # attached left wheel (upright, on the axle)
    parts += wheel("wheelL", CART @ Matrix.Translation((-0.72, 0.1, 0.48)) @
                   Matrix.Rotation(math.pi / 2, 4, 'Y'))
    # detached wheel lying flat on the sand
    dwb = gz(3.2, 0.4)
    parts += wheel("wheelOff", Matrix.Translation((3.2, 0.4, dwb + 0.06)) @
                   Matrix.Rotation(0.9, 4, 'Z') @ Matrix.Rotation(math.radians(8), 4, 'X'))

    # coffin on the bed (slid against the low rail), lid askew
    outline = [(-0.11, -0.95), (-0.18, 0.25), (-0.13, 0.92),
               (0.13, 0.92), (0.18, 0.25), (0.11, -0.95)]
    CM = CART @ Matrix.Translation((0.12, 0.05, 0.655)) @ Matrix.Rotation(0.08, 4, 'Z')

    def prism(tag, scale, h, M, material):
        bm = bmesh.new()
        vs = [bm.verts.new((x * scale, y * scale, 0)) for x, y in outline]
        f = bm.faces.new(vs)
        ext = bmesh.ops.extrude_face_region(bm, geom=[f])
        up = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, vec=(0, 0, h), verts=up)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_{tag}", bm, coll, material)
        parts.append(o); bev.append(o)
    prism("coffin", 1.0, 0.30, CM, mat("Wood_Mid"))
    prism("cofflid", 1.06, 0.055, CM @ Matrix.Translation((0.05, -0.06, 0.30)) @
          Matrix.Rotation(0.09, 4, 'Z') @ Matrix.Rotation(0.03, 4, 'Y'), mat("Wood_Light"))

    # ── sand drifts against the posts + debris ───────────────
    for di, (dx, dy, s) in enumerate(((-2.15, 0.35, 0.55), (1.7, -0.4, 0.45),
                                      (2.0, 2.3, 0.5), (-1.2, 1.4, 0.62),
                                      (0.6, -0.9, 0.4), (-2.9, -0.6, 0.48))):
        bm = bm_icosphere(1.0, 4)
        bmesh.ops.scale(bm, vec=Vector((s, s * 1.3, s * 0.32)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((dx, dy, gz(dx, dy) + 0.01)) @
                            Matrix.Rotation(rng.uniform(0, 3), 4, 'Z'), verts=bm.verts)
        o = obj_from_bmesh(f"{name}_drift{di}", bm, coll, mat("Sand_Pad"), smooth=True)
        displace_noise(o, strength=0.05, scale=0.5, seed=41 + di)
        apply_modifiers(o)
        parts.append(o)
    # dropped rope coil near the stool
    for ci in range(3):
        bm = bm_torus(0.16 - ci * 0.012, 0.026, segs=14, rings=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            (0.95, 0.45, gz(0.95, 0.45) + 0.03 + ci * 0.045)) @
            Matrix.Rotation(ci * 0.5, 4, 'Z') @ Matrix.Rotation(0.06 * ci, 4, 'X'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_coil{ci}", bm, coll, mat("Rope"), smooth=True))
    # snapped plank half-buried
    bm = bm_box(0.16, 1.1, 0.045)
    for v in bm.verts:
        if v.co.y > 0.5:
            v.co.x += (v.co.y - 0.5) * 0.3      # splintered skew
    bmesh.ops.transform(bm, matrix=Matrix.Translation((-1.4, 1.6, gz(-1.4, 1.6) + 0.01)) @
                        Matrix.Rotation(1.1, 4, 'Z') @ Matrix.Rotation(0.05, 4, 'Y'), verts=bm.verts)
    o = obj_from_bmesh(f"{name}_plank", bm, coll, mat("Wood_Bleached"))
    parts.append(o); bev.append(o)

    # ── crow on the crossbeam ────────────────────────────────
    beam_top = LEAN @ Vector((2.35, 0, 3.95 + 0.15))
    parts += crow(coll, f"{name}_crow", beam_top, 2.6)

    finish(bev, width=0.02, segments=2)

    # ── vertex-colour recipe ─────────────────────────────────
    # AUDIT FIX: the scene shipped with AO only, so every timber was one flat
    # tone and the pad was a paper disc. Sun-bleach the up-faces of the wood,
    # sink a damp band at the sand line, and give the pad a wind-streak so the
    # ripples read in colour as well as in relief.
    SPEC = tint_spec(moss=0.0, damp=False, seed=17)
    SPEC['Sand_Pad'] = dict(
        tone=0.05, hue=((1.13, 1.07, 0.97), (0.83, 0.85, 0.90)), scale=3.2,
        mottle=0.11, mscale=0.42,
        streak=dict(axis='y', freq=4.6, amt=0.085),
        patch=dict(col=(0.78, 0.72, 0.58), amt=0.35, scale=1.4, thresh=0.62,
                   width=0.18, up=0.55),
        # damp/shadowed rim: the pad's outer skirt darkens into the terrain
        # instead of stamping a hard bright ellipse on the grass (audit)
        low=dict(z=0.34, amt=0.42, col=(0.58, 0.56, 0.50)),
    )
    # graves must NOT read as more sand — they are freshly turned wet earth,
    # so they sit a full stop darker than the pad they are cut into
    SPEC['Grave_Dirt'] = dict(
        tone=0.13, hue=((1.02, 0.92, 0.76), (0.60, 0.62, 0.66)), scale=0.9,
        mottle=0.20, mscale=0.24,
        patch=dict(col=(0.58, 0.64, 0.42), amt=0.30, scale=0.7, thresh=0.66,
                   width=0.14, up=0.8),
        low=dict(z=0.30, amt=0.30, col=(0.55, 0.50, 0.42)),
    )
    for w in ('Wood_Dark', 'Wood_Mid', 'Wood_Light', 'Wood_Bleached'):
        SPEC[w] = dict(
            tone=0.19,
            hue=((1.22, 1.12, 0.96), (0.72, 0.71, 0.70)), scale=1.0,
            mottle=0.09, mscale=0.15,
            streak=dict(axis='z', freq=12.0, amt=0.13),
            # sun bleaches the up-facing grain, sand-blast greys the base
            patch=dict(col=(1.30, 1.24, 1.10), amt=0.34, scale=1.1, thresh=0.52,
                       width=0.20, up=0.85),
            low=dict(z=0.55, amt=0.40, col=(0.42, 0.40, 0.35)),
        )
    SPEC['Rope'] = dict(
        tone=0.15, hue=((1.20, 1.10, 0.90), (0.72, 0.71, 0.68)), scale=0.45,
        mottle=0.13, mscale=0.09,
        low=dict(z=1.2, amt=0.22, col=(0.55, 0.52, 0.46)),
    )
    SPEC['Metal_Band'] = dict(
        tone=0.10, mottle=0.12, mscale=0.10,
        patch=dict(col=RUST_C, amt=0.72, scale=0.35, thresh=0.44, width=0.16,
                   up=0.35))
    SPEC['Metal_Iron'] = SPEC['Metal_Band']
    SPEC['Coconut'] = dict(
        tone=0.20, hue=((1.24, 1.12, 0.94), (0.70, 0.70, 0.72)), scale=0.55,
        mottle=0.12, mscale=0.14,
        patch=dict(col=(0.55, 0.55, 0.50), amt=0.32, scale=0.4, thresh=0.60,
                   width=0.16, up=0.6))
    SPEC['Rock_Grey'] = dict(tone=0.18, mottle=0.14, mscale=0.20,
                             hue=((1.16, 1.10, 1.00), (0.78, 0.80, 0.86)),
                             scale=0.6)

    info = ship_asset(coll, name, spec=SPEC, ao=dict(samples=24, floor=0.42),
                      tint_seed=17, render_dir=RENDER_DIR,
                      angles=(-90, -35, 25, 120), elev=15)
    print(f"built {name}")
    return info


build_gallows("gallows")
print("GALLOWS SCENE DONE")
