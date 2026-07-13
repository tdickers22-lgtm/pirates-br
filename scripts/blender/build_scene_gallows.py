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

RENDER_DIR = os.environ.get("PBR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)

clear_default_scene()

rng = random.Random(1746)

# ── palette additions (fidelity remediation) ─────────────────
EXTRA = {
    "Dirt_Fresh": ((0.45, 0.38, 0.28, 1.0), 0.95, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)
# UNIVERSAL PAD RULE: tint this scene's ground to warm dune sand. Local
# override of the bright palette Sand — the script runs in its own headless
# session so only this GLB is affected; the material NAME stays "Sand".
EXTRA_PAD = {
    "Sand_Pad": ((0.66, 0.58, 0.42, 1.0), 0.95, 0.0),
    "Grave_Dirt": ((0.45, 0.38, 0.28, 1.0), 0.95, 0.0),
}
for _k, _v in EXTRA_PAD.items():
    if _k not in PALETTE:
        PALETTE[_k] = _v
_sand = mat("Sand_Pad")
_sand.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
    (0.66, 0.58, 0.42, 1.0)

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
    bm = bm_icosphere(1.0, 5)
    bmesh.ops.scale(bm, vec=Vector((BASE_R, BASE_R * 0.92, BASE_H)), verts=bm.verts)
    for v in bm.verts:                          # wind-blown ripples
        v.co.z += 0.028 * math.sin(v.co.x * 3.4 + v.co.y * 1.2) * max(0.0, v.co.z / BASE_H)
    o = obj_from_bmesh(f"{name}_dune", bm, coll, mat("Sand_Pad"), smooth=True)
    displace_noise(o, strength=0.09, scale=2.2, seed=3)
    displace_noise(o, strength=0.04, scale=0.55, seed=13)
    apply_modifiers(o)
    parts.append(o)

    # ── the frame: heavy triple gallows, leaning ─────────────
    LEAN = Matrix.Rotation(math.radians(3.2), 4, 'Y') @ Matrix.Rotation(math.radians(1.8), 4, 'X')
    post_woods = (mat("Wood_Dark"), mat("Wood_Mid"))
    for k, sx in enumerate((-1, 1)):
        base = gz(sx * 1.9, 0)
        bm = bm_box(0.30, 0.30, 4.15)
        # weather the post: twist the top verts a touch, chip one corner
        for v in bm.verts:
            if v.co.z > 1.5:
                v.co.x += 0.02 * math.sin(v.co.z * 2.1 + sx)
        m = Matrix.Translation((sx * 1.9, 0, base + 4.15 / 2 - 0.35))
        bmesh.ops.transform(bm, matrix=LEAN @ m, verts=bm.verts)
        o = obj_from_bmesh(f"{name}_post{k}", bm, coll, post_woods[k])
        parts.append(o); bev.append(o)
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
    obj = join(parts, name)
    bake_ao(coll)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")
    return obj


build_gallows("gallows")
print("GALLOWS SCENE DONE")
