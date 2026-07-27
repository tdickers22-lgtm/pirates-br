# castaway_camp — hero story scene for Castaway Reach (fidelity pass).
# The marooned man: a skeleton propped against a lone dead palm trunk (his
# gravestone), flintlock in its lap, empty rum bottle beside; a driftwood
# TALLY BOARD carved with dozens of tally-mark grooves; a half-built escape
# raft (lashed barrels + planks, half the deck missing) on log rollers; a
# fish-drying rack; a cold fire ring. Focal: the tally board beside the
# skeleton. Scene faces -Y.
# Headless: Blender -b -P scripts/blender/build_scene_castaway.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())

RENDER_DIR = os.environ.get("PBR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("PBR_EXPORT_DIR", EXPORT_DIR)

EXTRA = {
    # AgX-compensated shore sand (matches _detail.AGX_OVERRIDES): the old
    # near-0.7 pad tonemapped to near-white and read as a paint splat.
    "Sand_Pad": ((0.400, 0.330, 0.208, 1.0), 0.95, 0.0),
    "Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0),
    "Bottle_Green": ((0.10, 0.30, 0.16, 1.0), 0.35, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)
# UNIVERSAL PAD RULE: warm beach sand, no channel above 0.8 (local override,
# name kept so the client material contract is unchanged).
PALETTE["Sand"] = ((0.70, 0.63, 0.48, 1.0), 0.95, 0.0)

clear_default_scene()
rng = random.Random(23)


# ── generic helpers ──────────────────────────────────────────
def M_of(loc=(0, 0, 0), rot=(0, 0, 0)):
    return Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4()


def tube(coll, name, pts, r1, r2, material, segs=7, smooth=True):
    parts = []
    n = len(pts) - 1
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        d = b - a
        if d.length < 1e-5:
            continue
        ta, tb = i / max(1, n), (i + 1) / max(1, n)
        bm = bm_cylinder(r1 + (r2 - r1) * ta, r1 + (r2 - r1) * tb,
                         d.length + 0.008, segs=segs)
        quat = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @
                            quat.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{name}_{i}", bm, coll, material, smooth=smooth))
    return parts


def lashing(coll, name, center, axis, r, n=3, rr=0.016):
    parts = []
    c, ax = Vector(center), Vector(axis).normalized()
    t = ax.cross(Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))).normalized()
    b = ax.cross(t)
    for k in range(n):
        cc = c + ax * ((k - (n - 1) / 2) * rr * 2.4)
        pts = [cc + (t * math.cos(a) + b * math.sin(a)) * r
               for a in [2 * math.pi * j / 8 for j in range(9)]]
        parts += tube(coll, f"{name}_{k}", pts, rr, rr, mat("Rope"), segs=4)
    return parts


def ball(coll, name, loc, r, material=None, sub=1, sx=1.0, sy=1.0, sz=1.0,
         smooth=True, rot=None):
    bm = bm_icosphere(r, sub)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    if rot is not None:
        bmesh.ops.transform(bm, matrix=Euler(rot).to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(loc), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material or mat("Bone"), smooth=smooth)


def lathe(coll, name, profile, ns, material, loc=(0, 0, 0), rot=(0, 0, 0),
          smooth=True):
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        ring = [bm.verts.new((r * math.cos(2 * math.pi * j / ns),
                              r * math.sin(2 * math.pi * j / ns), z))
                for j in range(ns)]
        rings.append(ring)
    for i in range(len(rings) - 1):
        for j in range(ns):
            bm.faces.new((rings[i][j], rings[i][(j + 1) % ns],
                          rings[i + 1][(j + 1) % ns], rings[i + 1][j]))
    bm.faces.new(tuple(reversed(rings[0])))
    bm.faces.new(tuple(rings[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.transform(bm, matrix=M_of(loc, rot), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, material, smooth=smooth)



def rim_scale(a, wobble, seed):
    """Deterministic angular noise in [1-wobble, 1] — fingers the pad rim so its
    edge is never a clean arc (the "decal stamp" read)."""
    s = 0.0
    for k, (f, w) in enumerate(((3, 0.5), (7, 0.3), (13, 0.2))):
        s += w * math.sin(a * f + seed * 1.7 + k * 2.1)
    return 1.0 - wobble * (0.5 + 0.5 * s)


def damp_rim(obj, z_hi=-0.22, z_lo=-1.4, col=(0.60, 0.64, 0.72), amt=0.6):
    """Vertex-blend the sunk pad rim + skirt toward WET sand. Run after bake_ao
    (it multiplies the baked AO), before export. Only the pad reaches below
    z_hi, so this is safe to run on the joined scene."""
    me = obj.data
    attr = me.color_attributes.get('Col')
    if attr is None:
        return
    span = max(1e-4, z_hi - z_lo)
    for i, v in enumerate(me.vertices):
        z = v.co.z
        if z >= z_hi:
            continue
        k = amt * min(1.0, (z_hi - z) / span)
        c = attr.data[i].color
        attr.data[i].color = (c[0] * ((1 - k) + k * col[0]),
                              c[1] * ((1 - k) + k * col[1]),
                              c[2] * ((1 - k) + k * col[2]), 1.0)


def ground_disc(coll, name, R, hfn, m_main, nr=70, ns=118, rim_z=-0.45,
                sink=0.55, skirt=2.4, wobble=0.20, seed=6):
    """Scene ground pad, feathered so it can never read as a cake platter: the
    rim radius is angular-noise fingered (no clean arc), the outer 30% SINKS
    `sink` below the pad surface so the boundary is buried inside the terrain
    stamp instead of ending in mid-air, and a skirt drops `skirt` further —
    below the waterline on shoreline placements — so the pad never shows its
    underside and no vertical rim is ever exposed."""
    bm = bmesh.new()
    center = bm.verts.new((0, 0, hfn(0, 0)))
    rings = []
    radii = [R * rim_scale(2 * math.pi * j / ns, wobble, seed) for j in range(ns)]
    for i in range(1, nr + 1):
        t = i / nr
        ring = []
        for j in range(ns):
            a = 2 * math.pi * j / ns
            r = radii[j] * t
            x, y = r * math.cos(a), r * math.sin(a)
            z = hfn(x, y)
            f = min(1.0, max(0.0, (t - 0.70) / 0.30))
            f = f * f * (3 - 2 * f)
            ring.append(bm.verts.new((x, y, z * (1 - f) + (rim_z - sink) * f)))
        rings.append(ring)
    if skirt > 0:
        ring = []
        for j in range(ns):
            a = 2 * math.pi * j / ns
            r = radii[j] * 0.995
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a),
                                      rim_z - sink - skirt)))
        rings.append(ring)
    for j in range(ns):
        bm.faces.new((center, rings[0][j], rings[0][(j + 1) % ns]))
    for i in range(len(rings) - 1):
        for j in range(ns):
            bm.faces.new((rings[i][j], rings[i + 1][j],
                          rings[i + 1][(j + 1) % ns], rings[i][(j + 1) % ns]))
    return obj_from_bmesh(name, bm, coll, m_main, smooth=True)


def finish(objs, width=0.014, segments=1):
    for o in objs:
        bevel_obj(o, width=width, segments=segments)
        apply_modifiers(o)


def ship(coll, name, parts):
    obj = join(parts, name)
    bake_ao(coll)
    damp_rim(obj)
    path = export_collection_vc(coll, f"{name}.glb")
    verify_glb(path)
    if RENDER_DIR:
        render_turntable(coll, name, RENDER_DIR, views=4)
    print(f"built {name}")
    return obj


# ── scene ground ─────────────────────────────────────────────
R = 3.6            # <= the flat core of the 6 m terrain stamp (blend 0.45)
PALM = (0.95, 1.35)       # the lone trunk
RAFT = (1.95, -1.85)      # half-built raft
FIRE = (-0.35, -1.75)     # cold fire ring


def hfn(x, y):
    z = 0.05 + 0.042 * math.sin(x * 1.2 + 0.3) * math.sin(y * 1.0 + 0.8) \
        + 0.018 * math.sin(x * 3.2 - y * 2.4)
    dp = math.hypot(x - PALM[0], y - PALM[1])
    z += 0.16 * math.exp(-(dp / 1.0) ** 2)          # root mound under the palm
    dr = math.hypot((x - RAFT[0]) * 0.8, y - RAFT[1])
    z -= 0.03 * math.exp(-(dr / 1.4) ** 2)          # worked-flat raft area
    df = math.hypot(x - FIRE[0], y - FIRE[1])
    z -= 0.05 * math.exp(-(df / 0.45) ** 2)         # fire pit hollow
    return z


# ── the dead palm trunk (his gravestone) ─────────────────────
def palm_trunk(coll, tag):
    parts = []
    base = Vector((PALM[0], PALM[1], hfn(*PALM) - 0.10))
    # curved trunk sweeping away from the audience (+Y lean)
    spine = [base + Vector((0.34 * t * t, 0.52 * t * t, 4.35 * t))
             for t in (0, 0.22, 0.44, 0.66, 0.85, 1.0)]
    parts += tube(coll, f"{tag}_trunk", spine, 0.21, 0.125,
                  mat("Trunk_Palm"), segs=14)
    # ring ridges up the trunk (old frond scars)
    for i in range(9):
        t = 0.09 + i * 0.105
        p = base + Vector((0.34 * t * t, 0.52 * t * t, 4.35 * t))
        d = Vector((0.68 * t, 1.04 * t, 4.35)).normalized()
        r = 0.215 - 0.085 * t
        bm = bm_cylinder(r + 0.018, r + 0.014, 0.07, segs=12, cap=False)
        q = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p) @
                            q.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_ring{i}", bm, coll,
                                    mat("Trunk_Palm"), smooth=True))
    # snapped, SPLINTERED top — jagged shard ring, not a clean cut
    top = spine[-1]
    d_top = Vector((0.68, 1.04, 4.35)).normalized()
    u = d_top.cross(Vector((0, 0, 1))).normalized()
    v = d_top.cross(u)
    # ring of 8 uneven shards around the break rim, bases sunk into the trunk
    for i in range(8):
        a = i * 2 * math.pi / 8 + rng.uniform(-0.22, 0.22)
        ro = rng.uniform(0.055, 0.095)
        off = (u * math.cos(a) + v * math.sin(a)) * ro
        h = rng.uniform(0.10, 0.55) if i % 2 else rng.uniform(0.28, 0.62)
        rb = rng.uniform(0.028, 0.055)
        bm = bm_cylinder(rb, 0.003, h, segs=5)
        tilt = rng.uniform(0.15, 0.55)
        q = (d_top + (u * math.cos(a) + v * math.sin(a)) * tilt).to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(top + off - d_top * 0.10 +
                                                          d_top * (h / 2)) @
                            q.to_matrix().to_4x4(), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_splint{i}", bm, coll, mat("Trunk_Palm")))
    # one long hero shard and a snapped-back flap hanging off the rim
    bm = bm_cylinder(0.05, 0.003, 0.85, segs=5)
    q = (d_top + u * 0.18 - v * 0.10).to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(top - d_top * 0.12 + d_top * 0.42 +
                                                      u * 0.04) @
                        q.to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_splintH", bm, coll, mat("Trunk_Palm")))
    bm = bm_cylinder(0.045, 0.004, 0.42, segs=5)
    q = (-v * 1.0 + d_top * 0.35 - u * 0.3).to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(top - d_top * 0.06 - v * 0.20 -
                                                      u * 0.05) @
                        q.to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_splintF", bm, coll, mat("Trunk_Palm")))
    # ragged core: irregular cone plug filling the break so no flat cap shows
    bm = bm_cylinder(0.115, 0.01, 0.30, segs=9)
    for vv in bm.verts:
        if vv.co.z > 0:
            vv.co.z += rng.uniform(-0.06, 0.10)
    q = d_top.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(top + d_top * 0.06) @
                        q.to_matrix().to_4x4(), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_splintC", bm, coll, mat("Trunk_Palm")))
    # root flare
    for i in range(5):
        a = i * 2 * math.pi / 5 + 0.5
        bm = bm_cylinder(0.085, 0.02, 0.5, segs=6)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(
            base + Vector((0.24 * math.cos(a), 0.24 * math.sin(a), 0.12))) @
            Euler((math.radians(115), 0, a + math.pi / 2)).to_matrix().to_4x4(),
            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_root{i}", bm, coll,
                                    mat("Trunk_Palm"), smooth=True))
    return parts


# ── the castaway (seated against the trunk, facing -Y) ───────
def skeleton(coll, tag):
    parts = []
    cx = PALM[0] - 0.08
    gy = PALM[1] - 0.42          # in front of the trunk
    gz = hfn(cx, gy)
    pelvis = Vector((cx, gy + 0.10, gz + 0.13))
    parts.append(ball(coll, f"{tag}_pelvis", pelvis, 0.09, sx=1.3, sy=0.95, sz=0.75))
    # spine leaning back against the trunk
    spine = [pelvis + Vector((0.005 * i, 0.045 * i, 0.145 * i)) for i in range(5)]
    parts += tube(coll, f"{tag}_spine", spine, 0.028, 0.022, mat("Bone"), segs=6)
    neck = spine[-1]
    # skull tilted, chin dropped to chest
    SKM = (Matrix.Translation(neck + Vector((0.015, -0.045, 0.10))) @
           Matrix.Rotation(math.radians(30), 4, 'X') @
           Matrix.Rotation(math.radians(-10), 4, 'Z'))
    bm = bm_icosphere(0.105, 2)
    bmesh.ops.scale(bm, vec=Vector((0.88, 1.0, 1.06)), verts=bm.verts)
    bmesh.ops.transform(bm, matrix=SKM, verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_skull", bm, coll, mat("Bone"), smooth=True))
    for sx in (-1, 1):
        bm = bm_box(0.036, 0.02, 0.045)
        bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((sx * 0.038, -0.088, 0.005)),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_eye{sx}", bm, coll, mat("Char_Black")))
    bm = bm_box(0.075, 0.06, 0.03)
    bmesh.ops.transform(bm, matrix=SKM @ Matrix.Translation((0, -0.07, -0.098)) @
                        Matrix.Rotation(0.25, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_jaw", bm, coll, mat("Bone")))
    # ribcage
    for ri in range(5):
        t = ri / 4
        c = pelvis.lerp(neck, 0.45 + 0.5 * t) + Vector((0, -0.01, 0))
        r = 0.15 - abs(ri - 1.7) * 0.016
        arc = []
        for k in range(6):
            th = -2.25 + k * 0.9
            arc.append((c.x + r * math.sin(th) * 0.95, c.y - r * math.cos(th) * 0.85,
                        c.z - 0.045 * (1 - math.cos(th)) * 0.5))
        parts += tube(coll, f"{tag}_rib{ri}", arc, 0.011, 0.011, mat("Bone"), segs=5)
    # arms: slack at the sides, hands meeting on the lap (over the flintlock)
    for sx in (-1, 1):
        sh = neck + Vector((sx * 0.155, -0.01, -0.03))
        el = sh + Vector((sx * 0.075, -0.10, -0.26))
        ha = Vector((cx + sx * 0.10, gy - 0.28, gz + 0.30))
        parts += tube(coll, f"{tag}_uarm{sx}", [sh, el], 0.018, 0.015, mat("Bone"), segs=5)
        parts += tube(coll, f"{tag}_farm{sx}", [el, ha], 0.014, 0.011, mat("Bone"), segs=5)
        parts.append(ball(coll, f"{tag}_shj{sx}", sh, 0.028))
        parts.append(ball(coll, f"{tag}_elj{sx}", el, 0.024))
        parts.append(ball(coll, f"{tag}_hand{sx}", ha, 0.027, sx=1.1, sy=1.35, sz=0.6))
    # legs stretched out toward -Y, splayed
    for sx in (-1, 1):
        hip = pelvis + Vector((sx * 0.085, -0.02, 0.0))
        kn = Vector((cx + sx * 0.16, gy - 0.52, gz + 0.16))
        ft = Vector((cx + sx * 0.24, gy - 0.94, gz + 0.075))
        parts += tube(coll, f"{tag}_thigh{sx}", [hip, kn], 0.021, 0.017, mat("Bone"), segs=5)
        parts += tube(coll, f"{tag}_shin{sx}", [kn, ft], 0.016, 0.012, mat("Bone"), segs=5)
        parts.append(ball(coll, f"{tag}_knj{sx}", kn, 0.028))
        bm = bm_box(0.06, 0.15, 0.04)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(ft + Vector((0, -0.05, 0))) @
                            Matrix.Rotation(sx * 0.35, 4, 'Z'), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_foot{sx}", bm, coll, mat("Bone")))
    # flintlock resting across the lap (upscaled ~1.35x so it reads at 8m)
    FM = M_of((cx, gy - 0.27, gz + 0.31),
              (math.radians(4), math.radians(-8), math.radians(78))) @ \
        Matrix.Scale(1.35, 4)
    bm = bm_box(0.055, 0.34, 0.075)                     # stock
    bmesh.ops.transform(bm, matrix=FM @ Matrix.Translation((0, 0.21, -0.01)) @
                        Matrix.Rotation(0.12, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_stock", bm, coll, mat("Wood_Mid")))
    bm = bm_box(0.05, 0.14, 0.11)                       # grip drop
    bmesh.ops.transform(bm, matrix=FM @ Matrix.Translation((0, 0.36, -0.055)) @
                        Matrix.Rotation(0.55, 4, 'X'), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_grip", bm, coll, mat("Wood_Mid")))
    bm = bm_cylinder(0.021, 0.018, 0.42, segs=8)        # barrel
    bmesh.ops.transform(bm, matrix=FM @ M_of((0, -0.10, 0.033), (math.pi / 2, 0, 0)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_barrel", bm, coll, mat("Char_Black"), smooth=True))
    bm = bm_box(0.03, 0.07, 0.06)                       # lock
    bmesh.ops.transform(bm, matrix=FM @ Matrix.Translation((0.03, 0.10, 0.02)), verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_lock", bm, coll, mat("Char_Black")))
    # empty rum bottle tipped over by his right hand (upscaled 1.3x)
    bx, by = cx + 0.52, gy - 0.38
    prof = [(rr * 1.3, zz * 1.3) for (rr, zz) in
            [(0.045, 0.0), (0.05, 0.02), (0.05, 0.18), (0.032, 0.22),
             (0.016, 0.25), (0.016, 0.32)]]
    parts.append(lathe(coll, f"{tag}_bottle", prof, 10, mat("Bottle_Green"),
                       loc=(bx, by, hfn(bx, by) + 0.065),
                       rot=(math.radians(94), 0, math.radians(-35))))
    return parts


# ── the tally board (FOCAL) ──────────────────────────────────
def tally_board(coll, tag):
    parts, bev = [], []
    C = Vector((-1.45, 0.15, 0))
    yaw = math.radians(-14)          # angled to face -Y and the skeleton
    Mb = M_of(C, (math.radians(-4), math.radians(2), yaw))

    def add(bm, m, sm=False, bv=True):
        bmesh.ops.transform(bm, matrix=Mb, verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_{len(parts)}", bm, coll, m, smooth=sm)
        parts.append(o)
        if bv:
            bev.append(o)
        return o

    # two driftwood posts
    for px in (-0.92, 0.92):
        gp = Mb @ Vector((px, 0.06, 0))
        gz = hfn(gp.x, gp.y)
        bm = bm_cylinder(0.075, 0.055, 1.65, segs=8)
        for v in bm.verts:
            v.co.x += 0.02 * math.sin(v.co.z * 4.0 + px)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((px, 0.06, gz + 0.62 - hfn(0, 0))) @
                            Euler((rng.uniform(-0.04, 0.04), rng.uniform(-0.05, 0.05), 0)
                                  ).to_matrix().to_4x4(), verts=bm.verts)
        add(bm, mat("Wood_Bleached"), sm=True, bv=False)
    # 4 plank rows, driftwood mix, uneven; top plank cracked short
    plank_rows = ((0.42, 2.02, "Wood_Bleached"), (0.66, 2.06, "Wood_Mid"),
                  (0.90, 1.98, "Wood_Bleached"), (1.14, 1.55, "Wood_Bleached"))
    for pi, (pz, ln, m) in enumerate(plank_rows):
        off = 0.0 if pi < 3 else -0.22       # cracked top plank sits short, left
        bm = bm_box(ln, 0.055, 0.205)
        bmesh.ops.transform(bm, matrix=M_of((off, 0, pz),
                                            (rng.uniform(-0.015, 0.015), 0,
                                             rng.uniform(-0.02, 0.02))), verts=bm.verts)
        add(bm, mat(m))
    # broken stub of the top plank, fallen against the post
    bm = bm_box(0.38, 0.055, 0.20)
    bmesh.ops.transform(bm, matrix=M_of((0.86, -0.18, 0.28),
                                        (math.radians(12), math.radians(58), 0.2)),
                        verts=bm.verts)
    add(bm, mat("Wood_Bleached"))
    # THE TALLY MARKS: carved groove rows on the -Y face (Char_Black insets)
    mark_z = {0: 0.42, 1: 0.66, 2: 0.90, 3: 1.14}
    total = 0
    for row in range(4):
        pz = mark_z[row]
        ngroups = (7, 8, 7, 4)[row]
        x0 = -0.86 + (0.0 if row < 3 else -0.22)
        for g in range(ngroups):
            gx = x0 + g * 0.245 + rng.uniform(-0.01, 0.01)
            full = not (row == 3 and g == ngroups - 1)
            nmarks = 4 if full else 3        # the last group unfinished — he stopped
            for mki in range(nmarks):
                bm = bm_box(0.016, 0.02, 0.115)
                bmesh.ops.transform(bm, matrix=M_of(
                    (gx + mki * 0.042, -0.022, pz + rng.uniform(-0.008, 0.008)),
                    (rng.uniform(-0.05, 0.05), 0, rng.uniform(-0.06, 0.06))),
                    verts=bm.verts)
                add(bm, mat("Char_Black"), bv=False)
                total += 1
            if full:                          # the diagonal fifth stroke
                bm = bm_box(0.016, 0.02, 0.17)
                bmesh.ops.transform(bm, matrix=M_of((gx + 0.063, -0.024, pz),
                                                    (0, math.radians(-38), 0)),
                                    verts=bm.verts)
                add(bm, mat("Char_Black"), bv=False)
                total += 1
    print(f"tally marks: {total}")
    # the carving knife left jammed into the top plank
    kb = Mb @ Vector((-0.05, -0.04, 1.26))
    kt = Mb @ Vector((0.02, -0.26, 1.44))
    parts += tube(coll, f"{tag}_knife", [kb, kt], 0.012, 0.010, mat("Char_Black"), segs=5)
    bm = bm_cylinder(0.02, 0.017, 0.11, segs=6)
    q = (kt - kb).to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation(kt) @ q.to_matrix().to_4x4(),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_hilt", bm, coll, mat("Wood_Mid"), smooth=True))
    finish(bev, width=0.010)
    return parts


# ── the half-built escape raft on rollers ────────────────────
def raft(coll, tag):
    parts, bev = [], []
    yaw = math.radians(20)
    gz = hfn(*RAFT) - 0.02
    Mr = M_of((RAFT[0], RAFT[1], gz), (0, 0, yaw))

    def to_w(p):
        return Mr @ Vector(p)

    # two log rollers underneath (perpendicular to launch direction -Y)
    for ry in (-0.62, 0.55):
        bm = bm_cylinder(0.10, 0.09, 2.35, segs=10)
        bmesh.ops.transform(bm, matrix=Mr @ M_of((0.05 * ry, ry, 0.10),
                                                 (0, math.pi / 2, 0.05)), verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_roller{ry}", bm, coll,
                                    mat("Wood_Bleached"), smooth=True))
    # four lashed barrels as floats: two per side, end-to-end along y
    prof = [(0.185, 0.0), (0.245, 0.10), (0.27, 0.29), (0.245, 0.48), (0.185, 0.58)]
    for bx in (-0.52, 0.52):
        for j, by in enumerate((0.68, 0.06)):
            # Euler XYZ: X(+90) lays the lathe axis along -y, then Z yaws
            parts.append(lathe(coll, f"{tag}_barrel{bx}_{j}", prof, 13, mat("Wood_Mid"),
                               loc=to_w((bx, by, 0.42)), rot=(math.pi / 2, 0, yaw)))
            c = to_w((bx, by - 0.29, 0.42))
            parts += lashing(coll, f"{tag}_blash{bx}{j}", c,
                             Mr.to_3x3() @ Vector((0, 1, 0)), 0.285, n=2)
    # two stringers lying across the barrels
    for sy in (-0.30, 0.42):
        bm = bm_box(1.65, 0.095, 0.08)
        bmesh.ops.transform(bm, matrix=Mr @ Matrix.Translation((0, sy, 0.735)), verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_str{sy}", bm, coll, mat("Wood_Mid"))
        parts.append(o); bev.append(o)
    # deck planks — ONLY the left half is planked; right half bare stringers
    for i in range(4):
        px = -0.68 + i * 0.29
        bm = bm_box(0.25, 1.25, 0.05)
        bmesh.ops.transform(bm, matrix=Mr @ M_of((px, 0.06, 0.80),
                                                 (rng.uniform(-0.02, 0.02), 0,
                                                  rng.uniform(-0.05, 0.05))), verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_deck{i}", bm, coll,
                           mat("Wood_Bleached" if i % 2 else "Wood_Mid"))
        parts.append(o); bev.append(o)
        for sy in (-0.30, 0.42):
            c = to_w((px, sy, 0.78))
            parts += lashing(coll, f"{tag}_dlash{i}{sy}", c,
                             Mr.to_3x3() @ Vector((1, 0, 0)), 0.085, n=2, rr=0.013)
    # the NEXT plank, half-lashed, hanging off the edge — work interrupted
    bm = bm_box(0.25, 1.3, 0.05)
    bmesh.ops.transform(bm, matrix=Mr @ M_of((0.55, 0.25, 0.84),
                                             (math.radians(7), math.radians(-4), 0.35)),
                        verts=bm.verts)
    o = obj_from_bmesh(f"{tag}_wip", bm, coll, mat("Wood_Bleached"))
    parts.append(o); bev.append(o)
    # stack of plank stock waiting beside the raft
    for i in range(3):
        wx, wy = RAFT[0] + 1.35, RAFT[1] + 0.55 + i * 0.06
        bm = bm_box(0.24, 1.5, 0.05)
        bmesh.ops.transform(bm, matrix=M_of((wx, wy - i * 0.02, hfn(wx, wy) + 0.05 + i * 0.055),
                                            (0, 0, math.radians(75 + i * 7))), verts=bm.verts)
        o = obj_from_bmesh(f"{tag}_stock{i}", bm, coll,
                           mat("Wood_Mid" if i == 1 else "Wood_Bleached"))
        parts.append(o); bev.append(o)
    # coil of lashing rope dropped mid-job
    cx, cy = RAFT[0] - 1.15, RAFT[1] - 0.5
    for k in range(3):
        zc = hfn(cx, cy) + 0.035 + k * 0.03
        rr = 0.17 - k * 0.018
        pts = [(cx + rr * math.cos(a), cy + rr * math.sin(a), zc)
               for a in [2 * math.pi * t / 10 + k for t in range(11)]]
        parts += tube(coll, f"{tag}_coil{k}", pts, 0.017, 0.017, mat("Rope"), segs=5)
    finish(bev, width=0.012)
    return parts


# ── fish-drying rack ─────────────────────────────────────────
def fish_rack(coll, tag):
    parts = []
    C = Vector((-2.05, 1.75, 0))
    yaw = math.radians(30)
    Mr = M_of(C, (0, 0, yaw))
    ridge_h = 1.32
    # two A-frames
    for ax in (-0.75, 0.75):
        for s in (-1, 1):
            foot = Mr @ Vector((ax + s * 0.06, s * 0.42, 0))
            gz = hfn(foot.x, foot.y)
            top = Mr @ Vector((ax, 0, ridge_h))
            parts += tube(coll, f"{tag}_a{ax}{s}", [(foot.x, foot.y, gz - 0.05), top],
                          0.042, 0.034, mat("Wood_Bleached"), segs=6)
        parts += lashing(coll, f"{tag}_alash{ax}", Mr @ Vector((ax, 0, ridge_h - 0.04)),
                         Mr.to_3x3() @ Vector((1, 0, 0)), 0.07, n=2, rr=0.014)
    # ridge pole
    e0 = Mr @ Vector((-0.95, 0, ridge_h + 0.04))
    e1 = Mr @ Vector((0.95, 0, ridge_h + 0.02))
    parts += tube(coll, f"{tag}_ridge", [e0, e1], 0.038, 0.034,
                  mat("Wood_Mid"), segs=6)
    # 5 dried fish hanging from short cords
    for i in range(5):
        fx = -0.66 + i * 0.33
        hang = Mr @ Vector((fx, 0, ridge_h))
        fz = ridge_h - 0.22 - (i % 2) * 0.05
        fc = Mr @ Vector((fx, 0, fz))
        parts += tube(coll, f"{tag}_cord{i}", [hang, fc + Vector((0, 0, 0.06))],
                      0.008, 0.008, mat("Rope"), segs=4)
        bm = bm_icosphere(0.10, 2)
        bmesh.ops.scale(bm, vec=Vector((0.45, 1.6, 0.9)), verts=bm.verts)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(fc - Vector((0, 0, 0.10))) @
                            Euler((math.radians(90 - 6 + (i % 2) * 12), 0,
                                   yaw + 0.2 * (i % 2))).to_matrix().to_4x4(),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_fish{i}", bm, coll, mat("Bone"), smooth=True))
        # tail fin
        bm = bm_box(0.015, 0.09, 0.09)
        bmesh.ops.transform(bm, matrix=Matrix.Translation(fc - Vector((0, 0, 0.30))),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_tail{i}", bm, coll, mat("Bone")))
    return parts


# ── cold fire ring ───────────────────────────────────────────
def fire_ring(coll, tag):
    parts = []
    fz = hfn(*FIRE)
    # soot-blackened stones
    for i in range(11):
        a = i * 2 * math.pi / 11 + rng.uniform(-0.12, 0.12)
        r = 0.46 + rng.uniform(-0.03, 0.04)
        sx, sy = FIRE[0] + r * math.cos(a), FIRE[1] + r * math.sin(a)
        o = ball(coll, f"{tag}_stone{i}", (sx, sy, hfn(sx, sy) + 0.035),
                 rng.uniform(0.085, 0.125), material=mat("Char_Black"), sub=2,
                 sx=1.0 + rng.uniform(-0.15, 0.25), sy=1.0 + rng.uniform(-0.15, 0.25),
                 sz=0.7, rot=(0, 0, rng.uniform(0, 6.28)))
        displace_noise(o, strength=0.03, scale=0.35, seed=i)
        apply_modifiers(o)
        parts.append(o)
    # ash bed
    bm = bm_cylinder(0.30, 0.34, 0.05, segs=12)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((FIRE[0], FIRE[1], fz + 0.01)),
                        verts=bm.verts)
    parts.append(obj_from_bmesh(f"{tag}_ash", bm, coll, mat("Bone"), smooth=True))
    # charred log ends crossing the pit, unburnt tips
    for i, a in enumerate((0.4, 1.9, 3.6, 5.0)):
        p0 = Vector((FIRE[0] + 0.42 * math.cos(a), FIRE[1] + 0.42 * math.sin(a), fz + 0.10))
        p1 = Vector((FIRE[0] - 0.18 * math.cos(a), FIRE[1] - 0.18 * math.sin(a), fz + 0.055))
        parts += tube(coll, f"{tag}_log{i}", [p0, p1], 0.05, 0.038,
                      mat("Char_Black"), segs=6)
        bm = bm_cylinder(0.052, 0.05, 0.09, segs=6)
        q = (p1 - p0).to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation(p0) @ q.to_matrix().to_4x4(),
                            verts=bm.verts)
        parts.append(obj_from_bmesh(f"{tag}_logend{i}", bm, coll,
                                    mat("Wood_Bleached"), smooth=True))
    return parts


# ── build ────────────────────────────────────────────────────
def build(name):
    coll = asset_collection(name)
    parts = []

    parts.append(ground_disc(coll, f"{name}_ground", R, hfn, mat("Sand_Pad")))
    displace_noise(parts[0], strength=0.03, scale=0.5, seed=3)
    apply_modifiers(parts[0])

    parts += palm_trunk(coll, f"{name}_palm")
    parts += skeleton(coll, f"{name}_cast")
    parts += tally_board(coll, f"{name}_tally")
    parts += raft(coll, f"{name}_raft")
    parts += fish_rack(coll, f"{name}_rack")
    parts += fire_ring(coll, f"{name}_fire")

    # driftwood snags washed up around the camp edge
    for i, (dx, dy, dyaw, ln) in enumerate(((2.6, 0.9, 0.9, 1.9),
                                            (-2.9, -1.4, 2.3, 1.5),
                                            (0.4, -3.3, 0.35, 1.7),
                                            (3.3, -0.6, 1.7, 1.3),
                                            (-1.2, 3.1, 0.6, 1.6))):
        p0 = Vector((dx - ln / 2 * math.cos(dyaw), dy - ln / 2 * math.sin(dyaw), 0))
        p1 = Vector((dx + ln / 2 * math.cos(dyaw), dy + ln / 2 * math.sin(dyaw), 0))
        p0.z = hfn(p0.x, p0.y) + 0.02
        p1.z = hfn(p1.x, p1.y) + 0.10
        mid = p0.lerp(p1, 0.5) + Vector((0.1, -0.08, 0.05))
        for o in tube(coll, f"{name}_drift{i}", [p0, mid, p1], 0.11, 0.055,
                      mat("Wood_Bleached"), segs=9):
            displace_noise(o, strength=0.035, scale=0.4, seed=20 + i)
            apply_modifiers(o)
            parts.append(o)
        # one snapped branch stub
        bp = mid + Vector((0, 0, 0.02))
        parts += tube(coll, f"{name}_driftb{i}", [bp, bp + Vector(
            (0.28 * math.sin(dyaw), -0.28 * math.cos(dyaw), 0.30))],
            0.04, 0.012, mat("Wood_Bleached"), segs=6)

    # dead frond litter around the trunk base (his old roof thatch, long rotted)
    for i in range(6):
        a = i * 1.15 + 0.4
        fx = PALM[0] + (0.7 + 0.35 * (i % 3)) * math.cos(a)
        fy = PALM[1] + (0.7 + 0.35 * (i % 3)) * math.sin(a)
        rib0 = Vector((fx, fy, hfn(fx, fy) + 0.03))
        rib1 = rib0 + Vector((0.85 * math.cos(a + 0.7), 0.85 * math.sin(a + 0.7), 0.02))
        parts += tube(coll, f"{name}_frond{i}", [rib0, rib1], 0.028, 0.008,
                      mat("Trunk_Palm"), segs=5)
        # a few dry leaflets: flat tapered boxes splayed off the rib
        for k in range(4):
            t = 0.25 + k * 0.18
            base_p = rib0.lerp(rib1, t)
            side = 1 if k % 2 else -1
            bm = bm_box(0.05, 0.30, 0.012)
            for v in bm.verts:
                if v.co.y > 0.1:
                    v.co.x *= 0.2
            bmesh.ops.transform(bm, matrix=M_of(base_p + Vector((0, 0, 0.005)),
                                                (0, side * 0.15,
                                                 a + 0.7 + side * 0.85)), verts=bm.verts)
            parts.append(obj_from_bmesh(f"{name}_leaf{i}_{k}", bm, coll,
                                        mat("Wood_Bleached")))

    ship(coll, name, parts)


build("castaway_camp")
print("CASTAWAY SCENE DONE")
