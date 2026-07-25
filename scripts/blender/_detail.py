# Fidelity helpers, round 2 — "no flat primitives" toolkit.
# Load AFTER _helpers.py and _ao.py:
#   exec(open(os.path.join(HERE, '_detail.py')).read())
#
# What lives here and why:
#  * agx_palette()  — AgX + the in-game tonemap wash out mid-grey stone into
#    white "lego" plastic (see audit: widow_memorial). One place to DARKEN and
#    SATURATE the shared palette for the scripts that opt in. Only affects the
#    headless session that execs this file, so other GLBs are untouched.
#  * tint_pass(coll, spec) — the big one. bake_ao() writes grey hemisphere AO
#    into COLOR_0; this MULTIPLIES that by a per-material, per-object,
#    per-vertex tint (tonal jitter between blocks, low-freq mottle, moss/rust/
#    verdigris/damp patches, wood grain streaks). Vertex colors multiply the
#    material base color in three.js, so tints must average ~1.0.
#    CALL ORDER:  bake_ao(coll) -> tint_pass(coll, SPEC) -> join(...) -> export.
#    (tint_pass needs one material per object, so it runs BEFORE the join.)
#  * carve_facets / chisel — turn smooth icospheres into carved stone (the
#    audit called out raw icosphere tessellation on skull_totem).
#  * small shared builders (T/RX/RY/RZ/xform, bevel, tapered segments, torus,
#    catenary rope, iron strap + bolt heads, rope lashing, feather, plank).
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix


# ── transforms ───────────────────────────────────────────────
def T(x, y, z):
    return Matrix.Translation((x, y, z))


def RX(a):
    return Matrix.Rotation(a, 4, 'X')


def RY(a):
    return Matrix.Rotation(a, 4, 'Y')


def RZ(a):
    return Matrix.Rotation(a, 4, 'Z')


def S(x, y, z):
    m = Matrix.Identity(4)
    m[0][0], m[1][1], m[2][2] = x, y, z
    return m


def xform(bm, m):
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return bm


def bm_bevel(bm, width=0.02, segments=2, profile=0.7):
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, offset_type='OFFSET',
                    segments=segments, profile=profile, affect='EDGES',
                    clamp_overlap=True)
    return bm


def bm_torus(R, r, segs=16, rings=7):
    bm = bmesh.new()
    grid = []
    for i in range(segs):
        a = math.tau * i / segs
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(rings):
            b = math.tau * j / rings
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * ca, rr * sa, r * math.sin(b))))
        grid.append(ring)
    for i in range(segs):
        for j in range(rings):
            bm.faces.new((grid[i][j], grid[(i + 1) % segs][j],
                          grid[(i + 1) % segs][(j + 1) % rings],
                          grid[i][(j + 1) % rings]))
    return bm


def seg_between(coll, name, p1, p2, r1, r2, material, segs=7, smooth=True):
    """Tapered cylinder from p1 to p2 (world space)."""
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, max(0.01, d.length), segs=segs)
    q = d.to_track_quat('Z', 'Y')
    xform(bm, Matrix.Translation((p1 + p2) / 2) @ q.to_matrix().to_4x4())
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)


def chain_pts(coll, name, pts, r1, r2, material, segs=7, smooth=True,
              balls=True):
    """Chain of tapered cylinders through pts, optional joint spheres."""
    out = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        t0, t1 = i / n, (i + 1) / n
        d = b - a
        bm = bm_cylinder(r1 + (r2 - r1) * t0, r1 + (r2 - r1) * t1,
                         d.length + 0.01, segs=segs)
        q = d.to_track_quat('Z', 'Y')
        xform(bm, Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4())
        out.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material,
                                  smooth=smooth))
    if balls:
        for i in range(1, n):
            t = i / n
            bm = bm_icosphere((r1 + (r2 - r1) * t) * 1.03, 1)
            xform(bm, Matrix.Translation(Vector(pts[i])))
            out.append(obj_from_bmesh(f"{name}_j{i}", bm, coll, material,
                                      smooth=True))
    return out


def timber_between(coll, name, p1, p2, w, d, material, bevel=0.02, roll=0.0,
                   over=0.0):
    """Square-section beam from p1 to p2 — reads as sawn timber where a
    cylinder reads as a black straw. over: extra length past each end."""
    p1, p2 = Vector(p1), Vector(p2)
    v = p2 - p1
    bm = bm_bevel(bm_box(w, d, v.length + over * 2), bevel, 2)
    q = v.to_track_quat('Z', 'Y')
    xform(bm, Matrix.Translation((p1 + p2) / 2) @ q.to_matrix().to_4x4() @
          Matrix.Rotation(roll, 4, 'Z'))
    return obj_from_bmesh(name, bm, coll, material)


def rope_cat(coll, name, p1, p2, sag, r=0.02, segs=7, material=None):
    """Catenary-ish hanging rope between two points."""
    p1, p2 = Vector(p1), Vector(p2)
    pts = []
    for i in range(segs + 1):
        t = i / segs
        p = p1.lerp(p2, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    return chain_pts(coll, name, pts, r, r, material or mat("Rope"), segs=6,
                     balls=False)


def rope_lash(coll, name, center, axis, r_out, turns=3, r_rope=0.022,
              material=None, spread=0.10):
    """Rope lashing: `turns` slightly offset rings wrapped around a member.
    axis: 'X'|'Y'|'Z' direction the member runs."""
    out = []
    rot = {'X': RY(math.pi / 2), 'Y': RX(math.pi / 2), 'Z': Matrix.Identity(4)}[axis]
    for i in range(turns):
        off = (i - (turns - 1) / 2) * spread
        d = {'X': Vector((off, 0, 0)), 'Y': Vector((0, off, 0)),
             'Z': Vector((0, 0, off))}[axis]
        bm = bm_torus(r_out, r_rope, segs=14, rings=6)
        xform(bm, Matrix.Translation(Vector(center) + d) @ rot)
        out.append(obj_from_bmesh(f"{name}_{i}", bm, coll,
                                  material or mat("Rope"), smooth=True))
    return out


def iron_strap(coll, name, m, w, d, t=0.035, bolts=2, material=None,
               bolt_material=None):
    """Flat iron band (w x d x t, local XY plane) + domed bolt heads.
    m: placement matrix, band centred at the local origin."""
    out = []
    mi = material or mat("Metal_Band")
    bm = bm_bevel(bm_box(w, d, t), t * 0.35, 1)
    xform(bm, m)
    out.append(obj_from_bmesh(name, bm, coll, mi))
    bmt = bolt_material or mat("Metal_Iron")
    for i in range(bolts):
        f = (i + 0.5) / bolts - 0.5
        b = bm_icosphere(t * 0.85, 1)
        bmesh.ops.scale(b, vec=Vector((1, 1, 0.6)), verts=b.verts)
        xform(b, m @ T(w * f * 0.72, 0, t * 0.55))
        out.append(obj_from_bmesh(f"{name}_bolt{i}", b, coll, bmt, smooth=True))
    return out


def plank(coll, name, m, w, l, t, material, rng=None, warp=0.02, split=0.0,
          bevel=0.012):
    """Weathered plank: slight lengthwise warp, tapered ends, optional split
    corner. Local: length along Y, thickness along Z."""
    r = rng or random
    bm = bm_box(w, l, t)
    for v in bm.verts:
        f = (v.co.y / (l / 2))
        v.co.z += warp * (f * f - 0.4)
        v.co.x *= 1.0 - 0.05 * abs(f)
        if split > 0 and v.co.y > l * 0.2 and v.co.x > 0:
            v.co.x += split
            v.co.z += split * 0.3
    bm_bevel(bm, bevel, 1)
    xform(bm, m)
    return obj_from_bmesh(name, bm, coll, material)


def rough_block_bm(w, d, h, rng, jitter=0.07, chip=0.45, bevel=0.028,
                   taper=0.10, segments=2):
    """Hand-dressed masonry block: corner jitter (non-planar faces read as
    faceted stone under flat shading), a dressed taper on the outward -Y face,
    an optional knocked-off corner, and a chunky 2-segment bevel.
    This is the difference between 'stone wall' and 'lego bricks'."""
    bm = bm_box(w, d, h)
    for v in bm.verts:
        v.co.x += rng.uniform(-1, 1) * jitter * w
        v.co.y += rng.uniform(-1, 1) * jitter * d * 0.8
        v.co.z += rng.uniform(-1, 1) * jitter * h * 0.7
        if v.co.y < 0:                       # dressed outer face pulls in
            v.co.y += taper * d * rng.uniform(0.2, 1.0)
    if rng.random() < chip:                  # knocked-off corner
        v = rng.choice(list(bm.verts))
        v.co.x -= math.copysign(w * rng.uniform(0.15, 0.30), v.co.x)
        v.co.z -= math.copysign(h * rng.uniform(0.15, 0.35), v.co.z)
    bm_bevel(bm, bevel, segments)
    return bm


def feather(coll, name, m, length, material, width=0.035):
    """Flat tapered feather with a nicked edge — silhouette detail."""
    bm = bmesh.new()
    pts = []
    n = 7
    for i in range(n + 1):
        t = i / n
        w = width * math.sin(t * math.pi) ** 0.7 * (1.0 - 0.35 * t)
        if i % 2 == 0:
            w *= 0.72                       # nicked / worn edge
        pts.append((w, length * t))
    left = [bm.verts.new((-w, y, 0)) for w, y in pts]
    right = [bm.verts.new((w, y, 0)) for w, y in pts]
    for i in range(n):
        bm.faces.new((left[i], right[i], right[i + 1], left[i + 1]))
    xform(bm, m)
    o = obj_from_bmesh(name, bm, coll, material)
    sm = o.modifiers.new("Sol", 'SOLIDIFY')
    sm.thickness = 0.008
    apply_modifiers(o)
    # quill
    q = bm_cylinder(0.006, 0.003, length * 1.05, segs=4)
    xform(q, m @ T(0, length * 0.5, 0) @ RX(math.pi / 2))
    return [o, obj_from_bmesh(name + "_quill", q, coll, material, smooth=True)]


# ── carved-stone shaping ─────────────────────────────────────
def chisel(bm, direction, offset, softness=0.0):
    """Flatten everything past a plane (n·p = offset) back onto it — a chisel
    facet. softness>0 blends the last `softness` metres for a worn edge."""
    n = Vector(direction).normalized()
    for v in bm.verts:
        d = v.co.dot(n) - offset
        if d > 0:
            if softness > 0:
                k = min(1.0, d / softness)
                v.co -= n * d * (0.35 + 0.65 * k)
            else:
                v.co -= n * d


def carve_facets(bm, radius, count=13, depth=(0.86, 0.97), seed=0,
                 softness=0.05, skip_dirs=()):
    """Chisel `count` pseudo-random planes tangent to a sphere of `radius` so a
    smooth blob reads as hand-carved stone. skip_dirs: unit dirs to protect
    (e.g. the face of a skull) — planes within 0.55 rad are dropped."""
    rg = random.Random(seed)
    prot = [Vector(d).normalized() for d in skip_dirs]
    for _ in range(count):
        d = Vector((rg.uniform(-1, 1), rg.uniform(-1, 1), rg.uniform(-1, 1)))
        if d.length < 0.2:
            continue
        d.normalize()
        if any(d.angle(p) < 0.55 for p in prot):
            continue
        chisel(bm, d, radius * rg.uniform(*depth), softness)


def crack_band(bm, axis, freq, amount, seed=0):
    """Push verts in/out along a sine band — cheap strata / crack relief."""
    a = {'x': 0, 'y': 1, 'z': 2}[axis]
    rg = random.Random(seed)
    ph = rg.uniform(0, 6.0)
    for v in bm.verts:
        s = math.sin(v.co[a] * freq + ph)
        f = 1.0 + amount * (s * s - 0.5)
        v.co.x *= f if a != 0 else 1.0
        v.co.y *= f if a != 1 else 1.0
        if a != 2:
            pass


# ── value noise (no numpy dependency, stable across runs) ────
def _lat(i, j, k, seed):
    n = (i * 374761393 + j * 668265263 + k * 1274126177 + seed * 2654435761) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFFFF) / 0xFFFFFF


def vnoise(p, scale=1.0, seed=0):
    """Smooth 3-D value noise in [0,1]."""
    x, y, z = p[0] / scale, p[1] / scale, p[2] / scale
    i, j, k = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - i, y - j, z - k
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    fz = fz * fz * (3 - 2 * fz)
    c = [[[_lat(i + a, j + b, k + c_, seed) for c_ in (0, 1)] for b in (0, 1)]
         for a in (0, 1)]
    x00 = c[0][0][0] + (c[1][0][0] - c[0][0][0]) * fx
    x10 = c[0][1][0] + (c[1][1][0] - c[0][1][0]) * fx
    x01 = c[0][0][1] + (c[1][0][1] - c[0][0][1]) * fx
    x11 = c[0][1][1] + (c[1][1][1] - c[0][1][1]) * fx
    y0 = x00 + (x10 - x00) * fy
    y1 = x01 + (x11 - x01) * fy
    return y0 + (y1 - y0) * fz


def _hash01(s, salt=0):
    h = 2166136261 ^ (salt * 16777619)
    for ch in str(s):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h / 0xFFFFFFFF


# ── palette: AgX-compensated overrides (darker + more saturated) ──
# The renderer's tonemap lifts mids hard; 0.46-grey stone reads as white
# plastic in game. These are the values that survive it.
AGX_OVERRIDES = {
    "Stone_Fort":    ((0.248, 0.212, 0.162, 1.0), 0.94, 0.0),
    "Stone_Dark":    ((0.132, 0.118, 0.100, 1.0), 0.92, 0.0),
    "Stone_Moss":    ((0.155, 0.190, 0.115, 1.0), 0.93, 0.0),
    "Rock_Grey":     ((0.180, 0.168, 0.152, 1.0), 0.93, 0.0),
    "Rock_Dark":     ((0.115, 0.112, 0.120, 1.0), 0.90, 0.0),
    "Rock_Sea":      ((0.105, 0.115, 0.135, 1.0), 0.78, 0.0),
    "Sand":          ((0.560, 0.462, 0.290, 1.0), 0.95, 0.0),
    "Sand_Pad":      ((0.400, 0.330, 0.208, 1.0), 0.95, 0.0),
    "Grave_Dirt":    ((0.230, 0.180, 0.115, 1.0), 0.96, 0.0),
    "Dirt":          ((0.215, 0.168, 0.108, 1.0), 0.96, 0.0),
    "Wood_Dark":     ((0.098, 0.062, 0.036, 1.0), 0.88, 0.0),
    "Wood_Mid":      ((0.196, 0.118, 0.058, 1.0), 0.85, 0.0),
    "Wood_Light":    ((0.330, 0.208, 0.100, 1.0), 0.82, 0.0),
    "Wood_Bleached": ((0.345, 0.290, 0.208, 1.0), 0.90, 0.0),
    "Rope":          ((0.330, 0.262, 0.150, 1.0), 0.96, 0.0),
    "Canvas":        ((0.480, 0.430, 0.320, 1.0), 0.92, 0.0),
    "Canvas_Dirty":  ((0.300, 0.258, 0.180, 1.0), 0.96, 0.0),
    "Bone":          ((0.560, 0.520, 0.410, 1.0), 0.90, 0.0),
    "Bone_Shadow":   ((0.250, 0.228, 0.175, 1.0), 0.86, 0.0),
    "Metal_Iron":    ((0.075, 0.075, 0.082, 1.0), 0.52, 0.85),
    "Metal_Band":    ((0.115, 0.108, 0.100, 1.0), 0.58, 0.75),
    "Rust":          ((0.235, 0.105, 0.048, 1.0), 0.95, 0.10),
    "Verdigris":     ((0.105, 0.235, 0.190, 1.0), 0.70, 0.25),
    "Copper":        ((0.360, 0.165, 0.075, 1.0), 0.45, 0.85),
    "Coral":         ((0.520, 0.185, 0.155, 1.0), 0.88, 0.0),
    "Coral_Pink":    ((0.560, 0.290, 0.300, 1.0), 0.88, 0.0),
    "Shell_Pearl":   ((0.540, 0.500, 0.440, 1.0), 0.45, 0.10),
    "Char_Black":    ((0.030, 0.026, 0.024, 1.0), 0.96, 0.0),
    "Crow_Black":    ((0.036, 0.034, 0.040, 1.0), 0.72, 0.0),
    "Coconut":       ((0.185, 0.130, 0.062, 1.0), 0.88, 0.0),
    "Gold":          ((0.640, 0.430, 0.075, 1.0), 0.38, 1.0),
    "Leaf_Dry":      ((0.370, 0.290, 0.115, 1.0), 0.90, 0.0),
    "Leaf_Green":    ((0.075, 0.235, 0.078, 1.0), 0.80, 0.0),
    "Tar_Black":     ((0.026, 0.024, 0.028, 1.0), 0.60, 0.0),
}


def agx_palette(extra=None):
    """Register + apply the AgX-compensated palette. Call BEFORE any mat()."""
    for k, v in AGX_OVERRIDES.items():
        PALETTE[k] = v
    for k, v in (extra or {}).items():
        PALETTE[k] = v
    # retro-fit any material already created in this session
    for name, (col, rough, metal) in PALETTE.items():
        m = bpy.data.materials.get(name)
        if not m or not m.use_nodes:
            continue
        b = m.node_tree.nodes.get("Principled BSDF")
        if not b:
            continue
        b.inputs["Base Color"].default_value = col
        b.inputs["Roughness"].default_value = rough
        b.inputs["Metallic"].default_value = metal
    print(f"agx_palette applied ({len(AGX_OVERRIDES)} overrides)")


def emissive(name, color, strength=3.0):
    m = mat(name)
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Emission Color"].default_value = color
    b.inputs["Emission Strength"].default_value = strength
    return m


# ── the tint pass ────────────────────────────────────────────
# spec[material_name] = dict(
#   tone   = 0.16,                  per-OBJECT tonal jitter amplitude (blocks!)
#   hue    = ((1.10,1.05,0.96), (0.86,0.88,0.95)),  two tints, noise-blended
#   scale  = 1.4,                   blend-noise wavelength (metres)
#   mottle = 0.10, mscale = 0.30,   fine grey speckle
#   streak = dict(axis='z', freq=9.0, amt=0.12),   grain / strata
#   patch  = dict(col=(0.55,0.80,0.40), amt=0.7, scale=0.8, thresh=0.60,
#                 up=0.7, zmax=None, zmin=None),   moss/rust/verdigris/damp
#   low    = dict(z=0.35, amt=0.30, col=(0.75,0.80,0.85)),  ground damp/dirt band
# )
def _mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def tint_pass(coll, spec, seed=5, verbose=True):
    """Multiply the baked AO in COLOR_0 by per-material vertex tints.
    Run AFTER bake_ao and BEFORE join (needs one material per object)."""
    n_obj = 0
    for obj in coll.objects:
        if obj.type != 'MESH' or not obj.data.materials:
            continue
        mname = obj.data.materials[0].name if obj.data.materials[0] else ''
        s = spec.get(mname) or spec.get('*')
        if not s:
            continue
        me = obj.data
        attr = me.color_attributes.get('Col')
        if attr is None:
            attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
            for d in attr.data:
                d.color = (1, 1, 1, 1)
        me.color_attributes.active_color = attr
        mw = obj.matrix_world
        nw = mw.inverted_safe().transposed().to_3x3()
        tone = 1.0 + (_hash01(obj.name, seed) - 0.5) * 2.0 * s.get('tone', 0.0)
        hue = s.get('hue')
        scale = s.get('scale', 1.2)
        mot, mscale = s.get('mottle', 0.0), s.get('mscale', 0.3)
        streak = s.get('streak')
        patch = s.get('patch')
        low = s.get('low')
        for i, v in enumerate(me.vertices):
            p = mw @ v.co
            col = [tone, tone, tone]
            if hue:
                t = vnoise(p, scale, seed + 11)
                h = _mix(hue[0], hue[1], t)
                col = [col[c] * h[c] for c in range(3)]
            if mot:
                m2 = (vnoise(p, mscale, seed + 23) - 0.5) * 2.0 * mot
                col = [c * (1.0 + m2) for c in col]
            if streak:
                ax = {'x': 0, 'y': 1, 'z': 2}[streak.get('axis', 'z')]
                sv = math.sin(p[ax] * streak.get('freq', 8.0) +
                              vnoise(p, 1.7, seed + 31) * 6.0)
                col = [c * (1.0 + streak.get('amt', 0.1) * sv) for c in col]
            if patch:
                t = vnoise(p, patch.get('scale', 0.8), seed + 47)
                th = patch.get('thresh', 0.6)
                if t > th:
                    # ramp over `width` (not the whole 1-th range) — a linear
                    # ramp to 1.0 leaves every patch a whisper of its colour.
                    ramp = min(1.0, (t - th) / max(1e-4, patch.get('width', 0.16)))
                    ramp = ramp * ramp * (3.0 - 2.0 * ramp)
                    k = ramp * patch.get('amt', 0.6)
                    up = patch.get('up', 0.0)
                    if up:
                        nrm = (nw @ v.normal).normalized()
                        k *= (1.0 - up) + up * max(0.0, nrm.z)
                    zmax, zmin = patch.get('zmax'), patch.get('zmin')
                    if zmax is not None and p.z > zmax:
                        k = 0.0
                    if zmin is not None and p.z < zmin:
                        k = 0.0
                    if k > 0:
                        pc = patch['col']
                        col = [col[c] * (1 - k) + pc[c] * k for c in range(3)]
            if low:
                zz = low.get('z', 0.3)
                if p.z < zz:
                    k = (1.0 - max(0.0, p.z) / zz) * low.get('amt', 0.3)
                    lc = low.get('col', (0.7, 0.7, 0.7))
                    col = [col[c] * (1 - k) + lc[c] * k for c in range(3)]
            old = attr.data[i].color
            attr.data[i].color = (min(1.0, max(0.0, old[0] * col[0])),
                                  min(1.0, max(0.0, old[1] * col[1])),
                                  min(1.0, max(0.0, old[2] * col[2])), 1.0)
        n_obj += 1
    if verbose:
        print(f"tint_pass: {n_obj} objects tinted")


# ── reusable tint recipes ────────────────────────────────────
MOSS = (0.42, 0.72, 0.30)
LICHEN = (0.86, 0.92, 0.72)
RUST_C = (1.35, 0.62, 0.32)
DAMP = (0.62, 0.68, 0.76)
SOOT = (0.30, 0.28, 0.28)


def tint_spec(moss=0.45, damp=True, seed=0):
    """Sensible per-material recipes for the whole shared palette.
    Scenes override individual entries after calling this."""
    stone = dict(
        tone=0.20,
        hue=((1.16, 1.10, 0.98), (0.80, 0.83, 0.90)), scale=1.5,
        mottle=0.13, mscale=0.28,
        patch=dict(col=MOSS, amt=moss, scale=0.85, thresh=0.58, up=0.75),
        low=dict(z=0.30, amt=0.28, col=(0.55, 0.58, 0.50)),
    )
    rock = dict(
        tone=0.16,
        hue=((1.14, 1.10, 1.02), (0.82, 0.84, 0.90)), scale=2.2,
        mottle=0.11, mscale=0.35,
        patch=dict(col=MOSS, amt=moss * 0.8, scale=1.1, thresh=0.62, up=0.8),
    )
    wood = dict(
        tone=0.18,
        hue=((1.18, 1.08, 0.94), (0.78, 0.76, 0.74)), scale=1.1,
        mottle=0.07, mscale=0.16,
        streak=dict(axis='z', freq=11.0, amt=0.11),
        low=dict(z=0.22, amt=0.35, col=(0.45, 0.44, 0.38)),
    )
    return {
        'Stone_Fort': stone,
        'Stone_Dark': dict(stone, tone=0.22, patch=dict(col=MOSS, amt=moss * 0.7,
                                                        scale=0.8, thresh=0.62,
                                                        up=0.8)),
        'Stone_Moss': dict(stone, tone=0.18),
        'Rock_Grey': rock,
        'Rock_Dark': dict(rock, tone=0.13),
        'Rock_Sea': dict(rock, tone=0.12,
                         hue=((1.10, 1.12, 1.14), (0.80, 0.86, 0.94)),
                         patch=dict(col=(0.95, 0.90, 0.78), amt=0.35, scale=0.55,
                                    thresh=0.66, up=0.5),
                         low=dict(z=0.30, amt=0.42, col=DAMP) if damp else None),
        'Wood_Dark': wood,
        'Wood_Mid': wood,
        'Wood_Light': dict(wood, tone=0.20),
        'Wood_Bleached': dict(
            wood, tone=0.16, hue=((1.20, 1.14, 1.02), (0.74, 0.74, 0.72)),
            streak=dict(axis='z', freq=13.0, amt=0.14)),
        'Timber': wood,
        'Rope': dict(tone=0.14, hue=((1.18, 1.10, 0.92), (0.78, 0.76, 0.72)),
                     scale=0.5, mottle=0.10, mscale=0.10),
        'Canvas': dict(tone=0.10, hue=((1.12, 1.09, 1.02), (0.80, 0.80, 0.82)),
                       scale=1.0, mottle=0.08, mscale=0.22,
                       patch=dict(col=(0.62, 0.58, 0.48), amt=0.45, scale=0.7,
                                  thresh=0.60, up=0.4),
                       low=dict(z=0.35, amt=0.40, col=(0.50, 0.47, 0.40))),
        'Canvas_Dirty': dict(tone=0.10,
                             hue=((1.14, 1.10, 1.00), (0.78, 0.78, 0.78)),
                             scale=0.9, mottle=0.09, mscale=0.20,
                             low=dict(z=0.35, amt=0.45, col=(0.45, 0.42, 0.36))),
        'Bone': dict(tone=0.12, hue=((1.16, 1.12, 1.02), (0.80, 0.80, 0.78)),
                     scale=0.6, mottle=0.09, mscale=0.14,
                     patch=dict(col=(0.60, 0.68, 0.45), amt=0.30, scale=0.5,
                                thresh=0.68, up=0.7),
                     low=dict(z=0.20, amt=0.35, col=(0.50, 0.48, 0.40))),
        'Bone_Shadow': dict(tone=0.14, mottle=0.10, mscale=0.16),
        'Metal_Iron': dict(tone=0.10, hue=((1.10, 1.02, 0.96), (0.84, 0.86, 0.92)),
                           scale=0.7, mottle=0.10, mscale=0.12,
                           patch=dict(col=RUST_C, amt=0.55, scale=0.45,
                                      thresh=0.55, up=0.35)),
        'Metal_Band': dict(tone=0.10, mottle=0.10, mscale=0.12,
                           patch=dict(col=RUST_C, amt=0.60, scale=0.40,
                                      thresh=0.52, up=0.3)),
        'Rust': dict(tone=0.14, mottle=0.14, mscale=0.20,
                     hue=((1.18, 1.05, 0.90), (0.76, 0.78, 0.82)), scale=0.5),
        'Sand': dict(tone=0.06, hue=((1.10, 1.07, 1.02), (0.86, 0.86, 0.86)),
                     scale=2.4, mottle=0.09, mscale=0.45),
        'Sand_Pad': dict(tone=0.05, hue=((1.12, 1.08, 1.00), (0.82, 0.84, 0.86)),
                         scale=2.8, mottle=0.10, mscale=0.55,
                         patch=dict(col=(0.72, 0.80, 0.52), amt=0.30, scale=1.6,
                                    thresh=0.62, up=0.6)),
        'Grave_Dirt': dict(tone=0.10, mottle=0.14, mscale=0.4,
                           hue=((1.14, 1.06, 0.94), (0.80, 0.80, 0.82)), scale=1.0),
        'Char_Black': dict(tone=0.12, mottle=0.16, mscale=0.20,
                           hue=((1.30, 1.16, 1.02), (0.72, 0.72, 0.76)), scale=0.6),
        'Coconut': wood,
        'Gold': dict(tone=0.08, mottle=0.10, mscale=0.10,
                     hue=((1.12, 1.06, 0.94), (0.86, 0.88, 0.92)), scale=0.4),
        'Coral': dict(tone=0.16, hue=((1.22, 1.02, 0.94), (0.80, 0.86, 0.94)),
                      scale=0.7, mottle=0.12, mscale=0.18,
                      patch=dict(col=(0.95, 0.98, 0.90), amt=0.35, scale=0.4,
                                 thresh=0.66, up=0.5)),
        'Shell_Pearl': dict(tone=0.12, hue=((1.14, 1.10, 1.06), (0.84, 0.88, 0.98)),
                            scale=0.55, mottle=0.08, mscale=0.14,
                            low=dict(z=0.45, amt=0.30, col=DAMP)),
        'Verdigris': dict(tone=0.12, hue=((1.20, 1.10, 0.96), (0.80, 0.92, 0.96)),
                          scale=0.45, mottle=0.14, mscale=0.14),
        'Copper': dict(tone=0.10, mottle=0.10, mscale=0.14,
                       patch=dict(col=(0.35, 0.95, 0.80), amt=0.55, scale=0.4,
                                  thresh=0.55, up=0.4)),
        'Leaf_Dry': dict(tone=0.16, mottle=0.12, mscale=0.25,
                         hue=((1.18, 1.10, 0.92), (0.80, 0.82, 0.80)), scale=0.6),
        'Crow_Black': dict(tone=0.08, mottle=0.10, mscale=0.10),
        'Tar_Black': dict(tone=0.08, mottle=0.12, mscale=0.12),
    }


def finish_bevel(objs, width=0.02, segments=2):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


def preview_vertex_colors(coll):
    """Wire COLOR_0 ('Col') into every material's Base Color as a MULTIPLY so
    turntable renders show what three.js will show (base x vertex color).
    Call AFTER export — the GLB must keep its flat material colors."""
    done = set()
    for obj in coll.objects:
        if obj.type != 'MESH':
            continue
        for m in obj.data.materials:
            if m is None or m.name in done or not m.use_nodes:
                continue
            done.add(m.name)
            nt = m.node_tree
            bsdf = nt.nodes.get("Principled BSDF")
            if bsdf is None:
                continue
            base = bsdf.inputs["Base Color"]
            col = tuple(base.default_value)
            att = nt.nodes.new('ShaderNodeAttribute')
            att.attribute_type = 'GEOMETRY'
            att.attribute_name = 'Col'
            att.location = (-600, 200)
            mixn = nt.nodes.new('ShaderNodeMix')
            mixn.data_type = 'RGBA'
            mixn.blend_type = 'MULTIPLY'
            mixn.location = (-300, 200)
            rgba_in = [s for s in mixn.inputs if s.type == 'RGBA']
            fac = [s for s in mixn.inputs if s.name == 'Factor'][0]
            fac.default_value = 1.0
            rgba_in[0].default_value = col
            nt.links.new(att.outputs['Color'], rgba_in[1])
            out = [s for s in mixn.outputs if s.type == 'RGBA'][0]
            nt.links.new(out, base)
    print(f"preview_vertex_colors: {len(done)} materials wired")


def render_orbit(coll, name, out_dir, angles=(-90, -35, 25, 120), elev=16,
                 res=(800, 600), dist_k=2.3, ground=True):
    """Named-angle renders. angle 0 = camera on +X, -90 = camera on -Y, i.e.
    the FRONT of every asset (bows/faces are authored toward -Y). Always look
    at the -90 shot before calling an asset done."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.image_settings.file_format = 'PNG'
    world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.42, 0.52, 0.62, 1.0)
        bg.inputs[1].default_value = 0.85
    pts = [o.matrix_world @ Vector(b) for o in coll.objects if o.type == 'MESH'
           for b in o.bound_box]
    if not pts:
        print('render_orbit: empty collection')
        return []
    ctr = sum(pts, Vector()) / len(pts)
    rad = max((p - ctr).length for p in pts)
    dist = rad * dist_k + 0.5
    if ground:
        g = bpy.data.objects.get('_ro_ground')
        if g is None:
            me = bpy.data.meshes.new('_ro_ground')
            bm = bmesh.new()
            bmesh.ops.create_grid(bm, x_segments=1, y_segments=1,
                                  size=max(30.0, rad * 6))
            bm.to_mesh(me)
            bm.free()
            gm = bpy.data.materials.new('_ro_groundmat')
            gm.use_nodes = True
            gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"] \
                .default_value = (0.115, 0.155, 0.075, 1.0)
            gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"] \
                .default_value = 0.95
            me.materials.append(gm)
            g = bpy.data.objects.new('_ro_ground', me)
            scene.collection.objects.link(g)
        zmin = min(p.z for p in pts)
        g.location = (ctr.x, ctr.y, zmin + 0.005)
    sun = bpy.data.objects.get('_ro_sun')
    if sun is None:
        sd = bpy.data.lights.new('_ro_sun', 'SUN')
        sd.energy = 3.0
        sd.angle = math.radians(3.0)
        sun = bpy.data.objects.new('_ro_sun', sd)
        scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(52), 0, math.radians(-125))
    cam = bpy.data.objects.get('_ro_cam')
    if cam is None:
        cd = bpy.data.cameras.new('_ro_cam')
        cam = bpy.data.objects.new('_ro_cam', cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    paths = []
    for a_deg in angles:
        a = math.radians(a_deg)
        el = math.radians(elev)
        cam.location = ctr + Vector((math.cos(a) * math.cos(el),
                                     math.sin(a) * math.cos(el),
                                     math.sin(el))) * dist
        look = ctr - cam.location
        cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler()
        p = os.path.join(out_dir, f"{name}_a{int(a_deg)}.png")
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        paths.append(p)
        print(f"RENDERED {p}")
    return paths


def ship_asset(coll, name, spec=None, ao=None, tint_seed=5, join_all=True,
               render_dir=None, views=4, preview_vc=True, res=(800, 600),
               angles=None, elev=16):
    """bake AO -> tint -> join -> export -> verify -> optional turntable
    (with COLOR_0 previewed so the render matches the engine)."""
    import os
    ao_kw = dict(samples=22, max_dist=6.0, floor=0.44, height_gradient=0.10)
    ao_kw.update(ao or {})
    bake_ao(coll, **ao_kw)
    tint_pass(coll, spec if spec is not None else tint_spec(), seed=tint_seed)
    if join_all:
        objs = [o for o in coll.objects if o.type == 'MESH']
        join(objs, name)
    path = export_collection_vc(coll, f"{name}.glb")
    info = verify_glb(path)
    d = [round(info['bbox_max'][i] - info['bbox_min'][i], 3) for i in range(3)]
    print(f"DIMS {name}: {d} (glTF x,y-up,z)")
    if render_dir:
        if preview_vc:
            preview_vertex_colors(coll)
        render_orbit(coll, name, render_dir,
                     angles=angles or (-90, -35, 25, 120), elev=elev, res=res)
    return info


print("detail helpers loaded")
