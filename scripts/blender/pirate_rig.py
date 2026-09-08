# THE PIRATE, REBUILT AS A SKINNED RIG (RIG-01 / avatar-14, assets-16, avatar-13).
#
# WHAT WAS WRONG. `makePlayerMesh` builds a pirate out of 22-26 boxes, spheres
# and cylinders with 9-14 FRESH MeshStandardMaterials per avatar, and
# PlayerAnimator moves it by writing Euler angles onto six pivots. There is no
# elbow, no knee, no wrist, no ankle, no spine — an arm is one cylinder on a
# shoulder pivot. A dense fight with 30-40 avatars in view is 700-1000 draw
# calls of boxes, and no amount of Euler tuning gets that figure to read as a
# person.
#
# WHAT THIS BUILDS. public/assets/models/pirate_base.glb:
#   * ONE 23-bone skeleton (PLAN §2.5's 22 named bones + a `root` at the sole),
#     head bone exactly at PLAYER.HEAD_Y so the drawn head, the server's
#     headshot sphere and the first-person eye stay one figure (AVATAR-01);
#   * lofted, smooth-shaded body/limbs — no interpenetrating primitives, so
#     nothing z-fights along a seam as the pirate moves;
#   * MODULAR children on that one skeleton: 6 heads, 3 hats (tricorn, bandana,
#     bare), 2 coats. The client shows one of each and deletes the rest, so a
#     dressed pirate is ~3.2k tris in 7 primitives instead of 26 draws;
#   * the 33 clips of PLAN §2.5 at 30 fps, authored from the numbers
#     PlayerAnimator already uses (its gait amplitudes, its cutlass timings, its
#     death crumple) so the rig starts where the hand-lerped pirate ended up
#     rather than throwing eight campaigns of pose tuning away.
#
# WHY THE REST POSE IS AN A-POSE, NOT A T-POSE. Every clip here is authored as
# bone-local Euler deltas from rest. From a T-pose each of the ~200 arm keys
# would carry a constant −1.4 rad "put the arm back down" term, which is both
# noise in the file and a place for a sign error to hide. Rest is arms-down, and
# each bone is roll-aligned (see ROLL below) so that in EVERY limb a positive
# rotation.x swings that limb FORWARD. That one convention is what makes 33
# procedurally-authored clips reviewable.
#
# TEAM COLOUR. The coats carry the `TeamTint` material and nothing else does, so
# PlayerRigFactory clones exactly one material per crew colour.
#
# NO AO BAKE. bake_ao would occlude every variant against every other variant
# (six heads and two coats live at the same coordinates), painting black
# patches onto parts that are never worn together.
#
# 1 unit = 1 m; Z up; the pirate FACES −Y so glTF's +Z (export_yup) is the game
# forward, the same convention as every other asset in this pipeline.
#
# Headless:
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/pirate_rig.py
import bpy
import bmesh
import math
import os
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

# ── shared height constants (mirror of PLAYER / AVATAR_RIG) ─────────────────
# These are the SAME numbers src/shared/constants PLAYER carries. If they ever
# drift, scripts/test-avatar-rig.mjs fails on the head bone.
HEAD_Y = 1.62          # PLAYER.HEAD_Y — headshot sphere centre == head bone
HEIGHT = 1.75          # PLAYER.HEIGHT
HIP_Y = 0.93           # AVATAR_RIG.pelvisY
SHOULDER_Y = 1.43      # arm root (AVATAR_RIG.armPivotY 1.42, one cm up the clavicle)
SHOULDER_X = 0.20
HIP_X = 0.115

EXTRA = {
    "Skin":     ((0.78, 0.58, 0.42, 1.0), 0.72, 0.0),
    "Cloth":    ((0.80, 0.75, 0.63, 1.0), 0.92, 0.0),
    "Leather":  ((0.24, 0.16, 0.11, 1.0), 0.80, 0.0),
    "Hair":     ((0.13, 0.10, 0.08, 1.0), 0.88, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


# ── skeleton ────────────────────────────────────────────────────────────────
# name, head, tail, parent, connected, roll-target
# ROLL: every bone's local +Z is aligned to the vector below, which fixes the
# local frame so that +rotation.x is "forward" for spine, arms and legs alike,
# and "toe up" for the feet. Without this Blender picks a roll per bone and the
# sign of a shoulder swing differs from the sign of a hip swing.
FWD = Vector((0.0, -1.0, 0.0))   # the direction the pirate faces
UP = Vector((0.0, 0.0, 1.0))

BONES = [
    ("root",   (0.0, 0.0, 0.0),          (0.0, 0.0, 0.16),        None,     False, FWD),
    ("hips",   (0.0, 0.0, HIP_Y),        (0.0, 0.0, 1.03),        "root",   False, FWD),
    ("spine1", (0.0, 0.0, 1.03),         (0.0, 0.0, 1.14),        "hips",   True,  FWD),
    ("spine2", (0.0, 0.0, 1.14),         (0.0, 0.0, 1.26),        "spine1", True,  FWD),
    ("chest",  (0.0, 0.0, 1.26),         (0.0, 0.0, 1.45),        "spine2", True,  FWD),
    ("neck",   (0.0, 0.0, 1.45),         (0.0, 0.0, HEAD_Y),      "chest",  True,  FWD),
    ("head",   (0.0, 0.0, HEAD_Y),       (0.0, 0.0, 1.79),        "neck",   True,  FWD),
]
for _s, _sx in (("l", 1.0), ("r", -1.0)):
    BONES += [
        (f"clavicle_{_s}", (_sx * 0.045, 0.0, 1.42),      (_sx * SHOULDER_X, 0.0, SHOULDER_Y),  "chest",           False, UP),
        (f"upperarm_{_s}", (_sx * SHOULDER_X, 0.0, SHOULDER_Y), (_sx * 0.225, 0.0, 1.155),      f"clavicle_{_s}",  False, FWD),
        (f"forearm_{_s}",  (_sx * 0.225, 0.0, 1.155),     (_sx * 0.238, 0.0, 0.905),            f"upperarm_{_s}",  True,  FWD),
        (f"hand_{_s}",     (_sx * 0.238, 0.0, 0.905),     (_sx * 0.243, 0.0, 0.795),            f"forearm_{_s}",   True,  FWD),
        (f"thigh_{_s}",    (_sx * HIP_X, 0.0, 0.90),      (_sx * 0.112, 0.0, 0.495),            "hips",            False, FWD),
        (f"shin_{_s}",     (_sx * 0.112, 0.0, 0.495),     (_sx * 0.108, 0.0, 0.125),            f"thigh_{_s}",     True,  FWD),
        (f"foot_{_s}",     (_sx * 0.108, 0.0, 0.125),     (_sx * 0.108, -0.115, 0.045),         f"shin_{_s}",      True,  UP),
        (f"toe_{_s}",      (_sx * 0.108, -0.115, 0.045),  (_sx * 0.108, -0.205, 0.032),         f"foot_{_s}",      True,  UP),
    ]

ALL_BONES = [b[0] for b in BONES]
assert len(ALL_BONES) == 23, len(ALL_BONES)


def build_armature(coll, name="pirate_rig"):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for bname, head, tail, _p, _c, roll_to in BONES:
        eb = arm_data.edit_bones.new(bname)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        made[bname] = eb
    for bname, _h, _t, parent, connected, _r in BONES:
        if parent:
            made[bname].parent = made[parent]
            made[bname].use_connect = connected
    # Roll AFTER parenting: use_connect can rewrite a head and thus the axis.
    for bname, _h, _t, _p, _c, roll_to in BONES:
        made[bname].align_roll(roll_to)
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
    return arm


# ── geometry helpers ────────────────────────────────────────────────────────
def loft(bm, rings, radial, closed_ends=True, cx=0.0, cy=0.0):
    """rings = [(z, rx, ry, dy)] bottom to top. Elliptical cross sections,
    quad-stripped, optional pole caps. Returns the created verts (rows)."""
    rows = []
    for (z, rx, ry, dy) in rings:
        row = []
        for i in range(radial):
            a = (i / radial) * math.tau
            row.append(bm.verts.new((cx + math.cos(a) * rx, cy + dy + math.sin(a) * ry, z)))
        rows.append(row)
    for r in range(len(rows) - 1):
        for i in range(radial):
            j = (i + 1) % radial
            bm.faces.new((rows[r][i], rows[r][j], rows[r + 1][j], rows[r + 1][i]))
    if closed_ends:
        bm.faces.new(list(reversed(rows[0])))
        bm.faces.new(rows[-1])
    return rows


def sphere(bm, cx, cy, cz, rx, ry, rz, segs=20, rings=12):
    verts = []
    for j in range(1, rings):
        v = j / rings
        phi = v * math.pi
        row = []
        for i in range(segs):
            a = (i / segs) * math.tau
            row.append(bm.verts.new((
                cx + math.sin(phi) * math.cos(a) * rx,
                cy + math.sin(phi) * math.sin(a) * ry,
                cz + math.cos(phi) * rz,
            )))
        verts.append(row)
    top = bm.verts.new((cx, cy, cz + rz))
    bot = bm.verts.new((cx, cy, cz - rz))
    for j in range(len(verts) - 1):
        for i in range(segs):
            k = (i + 1) % segs
            bm.faces.new((verts[j][i], verts[j][k], verts[j + 1][k], verts[j + 1][i]))
    for i in range(segs):
        k = (i + 1) % segs
        bm.faces.new((top, verts[0][k], verts[0][i]))
        bm.faces.new((bot, verts[-1][i], verts[-1][k]))
    return verts


def box(bm, cx, cy, cz, sx, sy, sz):
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((cx, cy, cz)) @ Matrix.Diagonal((sx, sy, sz, 1.0)))


def finish(name, bm, coll, material, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = new_obj(name, me, coll)
    obj.data.materials.append(mat(material))
    for p in obj.data.polygons:
        p.use_smooth = smooth
    return obj


# ── analytic skinning ───────────────────────────────────────────────────────
# A vertex's weights come from the chain its PART belongs to, blended by a
# single scalar (usually height). No proximity search: an arm hanging beside the
# ribs is 1 cm from the chest and a nearest-bone solve would weld the two.
def chain_weights(chain, t):
    """chain = [(bone, t_anchor)] in increasing t. Smoothstep blend."""
    if t <= chain[0][1]:
        return [(chain[0][0], 1.0)]
    if t >= chain[-1][1]:
        return [(chain[-1][0], 1.0)]
    for i in range(len(chain) - 1):
        na, ta = chain[i]
        nb, tb = chain[i + 1]
        if ta <= t <= tb:
            u = (t - ta) / (tb - ta)
            u = u * u * (3.0 - 2.0 * u)
            return [(na, 1.0 - u), (nb, u)]
    return [(chain[-1][0], 1.0)]


def paint(obj, chain, axis='z'):
    """Fill vertex groups from a chain, blending along one local axis."""
    for bname in ALL_BONES:
        if obj.vertex_groups.get(bname) is None:
            obj.vertex_groups.new(name=bname)
    idx = {'x': 0, 'y': 1, 'z': 2}[axis]
    for vi, v in enumerate(obj.data.vertices):
        for bn, bw in chain_weights(chain, v.co[idx]):
            if bw > 1e-4:
                obj.vertex_groups[bn].add([vi], bw, 'REPLACE')


TORSO_CHAIN = [("hips", 0.84), ("spine1", 1.035), ("spine2", 1.145), ("chest", 1.30), ("neck", 1.49)]
COAT_CHAIN = [("hips", 0.86), ("spine1", 1.04), ("spine2", 1.16), ("chest", 1.34)]
HEAD_CHAIN = [("neck", 1.50), ("head", 1.60)]


def arm_chain(side):
    # blended DOWNWARD (z decreasing), so the anchors are reversed into
    # increasing-t order for chain_weights.
    return [(f"hand_{side}", 0.86), (f"forearm_{side}", 1.02),
            (f"upperarm_{side}", 1.30), (f"clavicle_{side}", 1.45)]


def leg_chain(side):
    return [(f"foot_{side}", 0.10), (f"shin_{side}", 0.34),
            (f"thigh_{side}", 0.78), ("hips", 0.92)]


# ── the body (skin + cloth + leather, one object, three primitives) ─────────
def build_body(coll):
    parts = []

    # torso: shirt over the ribs, tapering into the neck. One loft, so there is
    # no primitive boundary to z-fight along the flank.
    bm = bmesh.new()
    loft(bm, [
        (0.84, 0.150, 0.105, 0.0),
        (0.95, 0.165, 0.112, 0.0),
        (1.07, 0.175, 0.118, 0.0),
        (1.19, 0.190, 0.124, 0.0),
        (1.31, 0.205, 0.128, -0.004),
        (1.40, 0.200, 0.124, -0.006),
        (1.46, 0.150, 0.104, -0.006),
        (1.49, 0.092, 0.078, -0.004),
    ], 20)
    torso = finish("p_torso", bm, coll, "Cloth")
    paint(torso, TORSO_CHAIN)
    parts.append(torso)

    # trousers: hips to knee, one loft per leg (the shins are bare-ish boot top)
    for side, sx in (("l", 1.0), ("r", -1.0)):
        bm = bmesh.new()
        loft(bm, [
            (0.44, 0.072, 0.078, 0.0),
            (0.60, 0.081, 0.088, 0.0),
            (0.76, 0.093, 0.100, 0.0),
            (0.90, 0.105, 0.112, 0.0),
        ], 12, cx=sx * HIP_X)
        trouser = finish(f"p_trouser_{side}", bm, coll, "Cloth")
        paint(trouser, leg_chain(side))
        parts.append(trouser)

    # neck + hands are the only skin the body object carries (the face is a
    # modular head).
    bm = bmesh.new()
    loft(bm, [(1.44, 0.062, 0.058, -0.004), (1.53, 0.058, 0.055, -0.004)], 12)
    neck = finish("p_neck", bm, coll, "Skin")
    paint(neck, HEAD_CHAIN)
    parts.append(neck)

    for side, sx in (("l", 1.0), ("r", -1.0)):
        bm = bmesh.new()
        # upper arm -> forearm -> wrist, one tapered tube through the elbow
        loft(bm, [
            (0.905, 0.042, 0.038, 0.0),
            (1.00, 0.046, 0.042, 0.0),
            (1.09, 0.050, 0.046, 0.0),
            (1.155, 0.055, 0.051, 0.0),
            (1.24, 0.060, 0.056, 0.0),
            (1.34, 0.066, 0.062, 0.0),
            (1.43, 0.072, 0.068, 0.0),
        ], 12, cx=sx * 0.215)
        arm = finish(f"p_arm_{side}", bm, coll, "Skin")
        paint(arm, arm_chain(side))
        parts.append(arm)

        bm = bmesh.new()
        sphere(bm, sx * 0.240, -0.005, 0.855, 0.048, 0.036, 0.062, segs=10, rings=7)
        hand = finish(f"p_hand_{side}", bm, coll, "Skin")
        paint(hand, arm_chain(side))
        parts.append(hand)

    # boots and belt: the only Leather on the body
    for side, sx in (("l", 1.0), ("r", -1.0)):
        bm = bmesh.new()
        loft(bm, [
            (0.005, 0.058, 0.115, -0.052),
            (0.055, 0.062, 0.118, -0.050),
            (0.11, 0.062, 0.086, -0.022),
            (0.22, 0.070, 0.078, 0.0),
            (0.42, 0.082, 0.086, 0.0),
            (0.50, 0.088, 0.092, 0.0),
        ], 12, cx=sx * 0.108)
        boot = finish(f"p_boot_{side}", bm, coll, "Leather")
        paint(boot, leg_chain(side))
        parts.append(boot)

    bm = bmesh.new()
    loft(bm, [(0.885, 0.163, 0.118, 0.0), (0.935, 0.166, 0.120, 0.0)], 20, closed_ends=False)
    belt = finish("p_belt", bm, coll, "Leather")
    paint(belt, TORSO_CHAIN)
    parts.append(belt)

    body = join(parts, "body")
    return body


# ── modular heads (skin + hair) ─────────────────────────────────────────────
HEAD_VARIANTS = [
    # name,    skull (rx,ry,rz), nose len, jaw, hair style, beard
    ("head_a", (0.098, 0.106, 0.118), 0.030, 1.00, "crop",  None),
    ("head_b", (0.104, 0.112, 0.120), 0.036, 1.08, "long",  "full"),
    ("head_c", (0.094, 0.100, 0.114), 0.026, 0.94, "queue", None),
    ("head_d", (0.100, 0.108, 0.116), 0.034, 1.02, "bald",  "goatee"),
    ("head_e", (0.096, 0.104, 0.122), 0.028, 0.96, "long",  None),
    ("head_f", (0.102, 0.110, 0.118), 0.032, 1.06, "crop",  "full"),
]


def build_head(name, skull, nose_len, jaw, hair_style, beard):
    coll = bpy.data.collections[COLL_NAME]
    rx, ry, rz = skull
    cz = HEAD_Y

    bm = bmesh.new()
    sphere(bm, 0.0, 0.0, cz, rx, ry, rz, segs=20, rings=12)
    # jaw / chin: a squashed blob under the skull so the head is not a ball
    sphere(bm, 0.0, -0.020, cz - 0.062 * jaw, rx * 0.80, ry * 0.86, rz * 0.46, segs=12, rings=7)
    # nose
    sphere(bm, 0.0, -(ry + nose_len * 0.42), cz - 0.012, 0.017, nose_len * 0.62, 0.020, segs=8, rings=5)
    # ears
    for sx in (1.0, -1.0):
        sphere(bm, sx * (rx + 0.004), 0.008, cz + 0.004, 0.012, 0.026, 0.032, segs=8, rings=5)
    skin_obj = finish(f"{name}_skin", bm, coll, "Skin")
    paint(skin_obj, HEAD_CHAIN)

    hair_parts = []
    bm = bmesh.new()
    if hair_style == "crop":
        sphere(bm, 0.0, 0.012, cz + 0.020, rx + 0.010, ry + 0.008, rz + 0.006, segs=16, rings=6)
    elif hair_style == "long":
        sphere(bm, 0.0, 0.016, cz + 0.014, rx + 0.012, ry + 0.010, rz + 0.008, segs=16, rings=7)
        loft(bm, [
            (cz - 0.16, 0.062, 0.040, 0.052),
            (cz - 0.06, 0.082, 0.052, 0.058),
            (cz + 0.04, 0.092, 0.058, 0.050),
        ], 10)
    elif hair_style == "queue":
        sphere(bm, 0.0, 0.012, cz + 0.018, rx + 0.009, ry + 0.008, rz + 0.005, segs=16, rings=6)
        loft(bm, [
            (cz - 0.20, 0.020, 0.020, 0.086),
            (cz - 0.08, 0.028, 0.028, 0.086),
            (cz + 0.02, 0.034, 0.034, 0.074),
        ], 8)
    else:  # bald — a stubble skullcap only, so the head is never a bare egg
        sphere(bm, 0.0, 0.030, cz + 0.030, rx * 0.86, ry * 0.80, rz * 0.72, segs=12, rings=5)

    if beard == "full":
        sphere(bm, 0.0, -0.030, cz - 0.086 * jaw, rx * 0.84, ry * 0.92, rz * 0.44, segs=12, rings=6)
    elif beard == "goatee":
        sphere(bm, 0.0, -(ry * 0.86), cz - 0.088 * jaw, 0.030, 0.026, 0.038, segs=8, rings=5)

    hair_obj = finish(f"{name}_hair", bm, coll, "Hair")
    paint(hair_obj, HEAD_CHAIN)
    hair_parts.append(hair_obj)

    return join([skin_obj] + hair_parts, name)


# ── hats and coats ──────────────────────────────────────────────────────────
def build_hats():
    coll = bpy.data.collections[COLL_NAME]
    out = []

    # tricorn: a wide cocked brim + a low crown. One draw (Canvas).
    bm = bmesh.new()
    loft(bm, [
        (HEAD_Y + 0.086, 0.108, 0.114, 0.0),
        (HEAD_Y + 0.104, 0.170, 0.176, 0.0),
        (HEAD_Y + 0.116, 0.176, 0.182, 0.0),
        (HEAD_Y + 0.126, 0.150, 0.156, 0.0),
        (HEAD_Y + 0.150, 0.104, 0.108, 0.0),
        (HEAD_Y + 0.182, 0.086, 0.090, 0.0),
    ], 16)
    out.append(finish("hat_tricorn", bm, coll, "Canvas"))

    # bandana: a band on the skull with a knot at the back. TeamTint, so a crew
    # reads at a glance even when the coat is off.
    bm = bmesh.new()
    loft(bm, [
        (HEAD_Y + 0.016, 0.106, 0.114, 0.006),
        (HEAD_Y + 0.062, 0.100, 0.107, 0.010),
        (HEAD_Y + 0.096, 0.062, 0.066, 0.014),
    ], 16)
    sphere(bm, 0.0, 0.106, HEAD_Y + 0.030, 0.026, 0.030, 0.024, segs=8, rings=5)
    out.append(finish("hat_bandana", bm, coll, "TeamTint"))

    # bare: nothing but the hairline tuft that would otherwise be a hat's job.
    bm = bmesh.new()
    sphere(bm, 0.0, 0.024, HEAD_Y + 0.034, 0.098, 0.098, 0.086, segs=12, rings=5)
    out.append(finish("hat_bare", bm, coll, "Hair"))

    for o in out:
        paint(o, HEAD_CHAIN)
    return out


def build_coats():
    coll = bpy.data.collections[COLL_NAME]
    out = []
    for name, hem in (("coat_long", 0.62), ("coat_short", 0.84)):
        bm = bmesh.new()
        # a shell 1.2 cm outside the torso loft: never coplanar, so no z-fight
        rings = [
            (hem, 0.216, 0.150, 0.0),
            (hem + (0.90 - hem) * 0.45, 0.200, 0.140, 0.0),
            (0.92, 0.180, 0.132, 0.0),
            (1.06, 0.190, 0.132, 0.0),
            (1.20, 0.204, 0.138, -0.004),
            (1.32, 0.219, 0.142, -0.006),
            (1.41, 0.213, 0.138, -0.008),
        ]
        loft(bm, rings, 16, closed_ends=False)
        # shoulder yoke so the coat does not end in a floating ring
        loft(bm, [(1.41, 0.213, 0.138, -0.008), (1.445, 0.170, 0.116, -0.008)], 16, closed_ends=False)
        obj = finish(name, bm, coll, "TeamTint")
        paint(obj, COAT_CHAIN)
        out.append(obj)
    return out


# ── clips ───────────────────────────────────────────────────────────────────
FPS = 30


def bp(**kw):
    """A FULL-body pose: every bone keyed, defaults at rest. Full-body keys are
    what lets PlayerRigFactory mask a clip into an upper-body layer (aim while
    walking) by dropping tracks instead of authoring 33 more clips."""
    p = {b: (0.0, 0.0, 0.0) for b in ALL_BONES}
    for k, v in kw.items():
        p[k] = v
    return p


def sym(p, bone_base, l, r=None):
    """Set a left/right pair. `l`/`r` are (x,y,z) tuples."""
    p[f"{bone_base}_l"] = l
    p[f"{bone_base}_r"] = r if r is not None else l
    return p


def _pose(arm, poses, frame):
    for bname, rot in poses.items():
        pb = arm.pose.bones[bname]
        pb.rotation_euler = rot
        arm.keyframe_insert(data_path=f'pose.bones["{bname}"].rotation_euler', frame=frame)


def make_action(arm, name, frames):
    """frames = [(frame, full-body pose dict)]."""
    arm.animation_data_create()
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    for frame, poses in frames:
        _pose(arm, poses, frame)
    act = arm.animation_data.action
    act.name = name
    act.use_fake_user = True
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    return act


def gait(leg, arm_swing, lean, knee, bob_spine, period=24, arm_bend=0.24):
    """A contralateral walk/run cycle over `period` frames, looping exactly.
    Amplitudes come from PlayerAnimator's existing numbers: its walk swings the
    legs 0.42 rad and the arms 0.30, its run 0.78 / 0.62."""
    out = []
    steps = 8
    for k in range(steps + 1):
        f = 1 + round(k * period / steps)
        ph = (k / steps) * math.tau
        s = math.sin(ph)
        c = math.cos(ph)
        p = bp(
            hips=(lean * 0.25, 0.0, 0.0),
            spine1=(lean * 0.3, s * 0.05, 0.0),
            spine2=(lean * 0.3, -s * 0.05, 0.0),
            chest=(lean * 0.4, -s * 0.06, 0.0),
            neck=(-lean * 0.5, 0.0, 0.0),
            head=(-lean * 0.4, 0.0, 0.0),
        )
        # legs: sine forward swing, knee bends on the back half of the stride
        for side, sgn in (("l", 1.0), ("r", -1.0)):
            swing = s * sgn
            p[f"thigh_{side}"] = (swing * leg, 0.0, 0.0)
            p[f"shin_{side}"] = (max(0.0, -swing) * knee + knee * 0.12, 0.0, 0.0)
            p[f"foot_{side}"] = (-swing * leg * 0.35 + 0.06, 0.0, 0.0)
            p[f"toe_{side}"] = (max(0.0, swing) * 0.20, 0.0, 0.0)
            # arms swing OPPOSITE the same-side leg
            p[f"upperarm_{side}"] = (-swing * arm_swing, 0.0, sgn * 0.10)
            p[f"forearm_{side}"] = (arm_bend + max(0.0, -swing) * 0.22, 0.0, 0.0)
            p[f"clavicle_{side}"] = (-swing * arm_swing * 0.10, 0.0, 0.0)
        p["hips"] = (lean * 0.25 + abs(c) * bob_spine, 0.0, 0.0)
        out.append((f, p))
    return out


def breath(base, amp=0.018, period=60):
    """A held pose that is never dead: the chest and head drift on a slow loop."""
    out = []
    for k in range(3):
        f = 1 + round(k * period / 2)
        s = math.sin((k / 2) * math.tau)
        p = dict(base)
        p["chest"] = tuple(v + (amp if i == 0 else 0.0) * s for i, v in enumerate(p["chest"]))
        p["neck"] = tuple(v - (amp * 0.6 if i == 0 else 0.0) * s for i, v in enumerate(p["neck"]))
        p["head"] = tuple(v + (amp * 0.4 if i == 1 else 0.0) * s for i, v in enumerate(p["head"]))
        out.append((f, p))
    return out


def arms_down(fwd_l=0.0, fwd_r=0.0, out_l=0.10, out_r=-0.10, bend=0.22):
    return {
        "upperarm_l": (fwd_l, 0.0, out_l),
        "upperarm_r": (fwd_r, 0.0, out_r),
        "forearm_l": (bend, 0.0, 0.0),
        "forearm_r": (bend, 0.0, 0.0),
    }


IDLE_BASE = bp(**arms_down(), thigh_l=(0.0, 0.0, 0.03), thigh_r=(0.0, 0.0, -0.03),
               chest=(0.02, 0.0, 0.0), neck=(-0.02, 0.0, 0.0), head=(0.0, 0.0, 0.0))


def two_handed(fwd, bend, out=0.32):
    """Both hands to a shared grip (helm, capstan, bail, spyglass). Arms only —
    the caller owns the spine, so `bp(**two_handed(...), chest=...)` is legal."""
    return {
        "upperarm_l": (fwd, 0.0, out),
        "upperarm_r": (fwd, 0.0, -out),
        "forearm_l": (bend, 0.0, 0.0),
        "forearm_r": (bend, 0.0, 0.0),
    }


def clip_table():
    """Every clip PLAN §2.5 names, in the order the state machine reaches for
    them. (name, loop, frames)."""
    T = []

    T.append(("idle", breath(IDLE_BASE)))
    T.append(("walk", gait(leg=0.42, arm_swing=0.30, lean=0.06, knee=0.34, bob_spine=0.010, period=24)))
    T.append(("run", gait(leg=0.78, arm_swing=0.62, lean=0.22, knee=0.86, bob_spine=0.020, period=16, arm_bend=0.62)))

    # strafes: the legs cross over, the chest stays square to the aim
    for side, sgn in (("l", 1.0), ("r", -1.0)):
        frames = []
        for k in range(5):
            f = 1 + k * 5
            s = math.sin((k / 4) * math.tau)
            p = bp(**arms_down(bend=0.30))
            p["hips"] = (0.03, 0.0, sgn * 0.05)
            p["chest"] = (0.05, sgn * -0.08, 0.0)
            p["thigh_l"] = (s * 0.10, 0.0, sgn * (0.16 + s * 0.14))
            p["thigh_r"] = (-s * 0.10, 0.0, sgn * (0.16 - s * 0.14))
            p["shin_l"] = (max(0.0, s) * 0.34 + 0.06, 0.0, 0.0)
            p["shin_r"] = (max(0.0, -s) * 0.34 + 0.06, 0.0, 0.0)
            p["upperarm_l"] = (0.0, 0.0, 0.12 + abs(s) * 0.10)
            p["upperarm_r"] = (0.0, 0.0, -0.12 - abs(s) * 0.10)
            frames.append((f, p))
        T.append((f"strafe_{side}", frames))

    T.append(("jump", [
        (1, bp(**arms_down(bend=0.30), thigh_l=(0.55, 0, 0), thigh_r=(0.55, 0, 0), shin_l=(0.85, 0, 0), shin_r=(0.85, 0, 0), hips=(0.16, 0, 0))),
        (5, bp(upperarm_l=(-1.10, 0, 0.30), upperarm_r=(-1.10, 0, -0.30), forearm_l=(0.20, 0, 0), forearm_r=(0.20, 0, 0),
               thigh_l=(-0.18, 0, 0), thigh_r=(-0.18, 0, 0), shin_l=(0.10, 0, 0), shin_r=(0.10, 0, 0), hips=(-0.08, 0, 0))),
        (10, bp(upperarm_l=(-0.55, 0, 0.26), upperarm_r=(-0.55, 0, -0.26), forearm_l=(0.35, 0, 0), forearm_r=(0.35, 0, 0),
                thigh_l=(0.30, 0, 0), thigh_r=(0.14, 0, 0), shin_l=(0.42, 0, 0), shin_r=(0.24, 0, 0))),
    ]))
    T.append(("fall", breath(bp(upperarm_l=(-0.85, 0, 0.42), upperarm_r=(-0.85, 0, -0.42),
                                forearm_l=(0.55, 0, 0), forearm_r=(0.55, 0, 0),
                                thigh_l=(0.38, 0, 0.06), thigh_r=(0.16, 0, -0.06),
                                shin_l=(0.60, 0, 0), shin_r=(0.34, 0, 0), chest=(0.10, 0, 0)), amp=0.05, period=30)))
    T.append(("land", [
        (1, bp(thigh_l=(0.34, 0, 0.04), thigh_r=(0.34, 0, -0.04), shin_l=(0.52, 0, 0), shin_r=(0.52, 0, 0),
               hips=(0.20, 0, 0), chest=(0.14, 0, 0), **arms_down(fwd_l=-0.30, fwd_r=-0.30, bend=0.50))),
        (6, bp(thigh_l=(0.62, 0, 0.06), thigh_r=(0.62, 0, -0.06), shin_l=(0.98, 0, 0), shin_r=(0.98, 0, 0),
               foot_l=(-0.24, 0, 0), foot_r=(-0.24, 0, 0), hips=(0.34, 0, 0), chest=(0.24, 0, 0), neck=(-0.18, 0, 0),
               **arms_down(fwd_l=0.30, fwd_r=0.30, bend=0.80))),
        (14, dict(IDLE_BASE)),
    ]))

    # swim: front crawl. tread: upright sculling.
    swim = []
    for k in range(9):
        f = 1 + k * 3
        ph = (k / 8) * math.tau
        s, c = math.sin(ph), math.cos(ph)
        p = bp(hips=(1.15, 0, 0), spine1=(0.10, 0, s * 0.06), spine2=(0.08, 0, -s * 0.05),
               chest=(0.06, 0, 0), neck=(-0.42, 0, 0), head=(-0.30, 0, s * 0.20))
        p["upperarm_l"] = (-1.30 + s * 1.50, 0.0, 0.22)
        p["upperarm_r"] = (-1.30 - s * 1.50, 0.0, -0.22)
        p["forearm_l"] = (0.30 + max(0.0, -s) * 0.55, 0, 0)
        p["forearm_r"] = (0.30 + max(0.0, s) * 0.55, 0, 0)
        p["thigh_l"] = (c * 0.24, 0, 0.04)
        p["thigh_r"] = (-c * 0.24, 0, -0.04)
        p["shin_l"] = (max(0.0, -c) * 0.34, 0, 0)
        p["shin_r"] = (max(0.0, c) * 0.34, 0, 0)
        swim.append((f, p))
    T.append(("swim", swim))

    tread = []
    for k in range(5):
        f = 1 + k * 8
        s = math.sin((k / 4) * math.tau)
        p = bp(hips=(0.28, 0, 0), chest=(0.06, 0, 0), neck=(-0.16, 0, 0))
        p["upperarm_l"] = (-0.55, 0, 0.62 + s * 0.16)
        p["upperarm_r"] = (-0.55, 0, -0.62 - s * 0.16)
        p["forearm_l"] = (0.90, 0, 0)
        p["forearm_r"] = (0.90, 0, 0)
        p["thigh_l"] = (0.55 + s * 0.28, 0, 0.10)
        p["thigh_r"] = (0.55 - s * 0.28, 0, -0.10)
        p["shin_l"] = (0.70 - s * 0.24, 0, 0)
        p["shin_r"] = (0.70 + s * 0.24, 0, 0)
        tread.append((f, p))
    T.append(("tread", tread))

    climb = []
    for k in range(5):
        f = 1 + k * 6
        s = math.sin((k / 4) * math.tau)
        p = bp(chest=(0.16, 0, 0), neck=(-0.20, 0, 0), hips=(0.08, 0, 0))
        p["upperarm_l"] = (-2.10 + s * 0.55, 0, 0.28)
        p["upperarm_r"] = (-2.10 - s * 0.55, 0, -0.28)
        p["forearm_l"] = (0.40 + max(0.0, s) * 0.60, 0, 0)
        p["forearm_r"] = (0.40 + max(0.0, -s) * 0.60, 0, 0)
        p["thigh_l"] = (0.70 - s * 0.42, 0, 0.14)
        p["thigh_r"] = (0.70 + s * 0.42, 0, -0.14)
        p["shin_l"] = (0.86 + s * 0.30, 0, 0)
        p["shin_r"] = (0.86 - s * 0.30, 0, 0)
        climb.append((f, p))
    T.append(("climb", climb))

    # stations
    helm_base = bp(**two_handed(-0.95, 0.72, out=0.34), thigh_l=(0.0, 0, 0.10), thigh_r=(0.0, 0, -0.10),
                   chest=(0.05, 0, 0), neck=(-0.05, 0, 0))
    helm = []
    for k in range(5):
        f = 1 + k * 12
        s = math.sin((k / 4) * math.tau)
        p = dict(helm_base)
        p["upperarm_l"] = (-0.95 + s * 0.16, 0.0, 0.34)
        p["upperarm_r"] = (-0.95 - s * 0.16, 0.0, -0.34)
        p["chest"] = (0.05, s * 0.10, 0.0)
        p["hips"] = (0.0, s * 0.05, 0.0)
        helm.append((f, p))
    T.append(("helm", helm))

    T.append(("cannon_aim", breath(bp(**two_handed(-0.35, 0.95, out=0.22), hips=(0.30, 0, 0), spine1=(0.10, 0, 0),
                                      chest=(0.14, 0, 0), neck=(-0.30, 0, 0), head=(-0.14, 0, 0),
                                      thigh_l=(0.34, 0, 0.10), thigh_r=(-0.22, 0, -0.10),
                                      shin_l=(0.30, 0, 0), shin_r=(0.16, 0, 0)), amp=0.03, period=48)))
    T.append(("cannon_fire", [
        (1, bp(**two_handed(-0.35, 0.95, out=0.22), hips=(0.30, 0, 0), chest=(0.14, 0, 0), neck=(-0.30, 0, 0),
               thigh_l=(0.34, 0, 0.10), thigh_r=(-0.22, 0, -0.10))),
        (4, bp(**two_handed(-0.10, 0.55, out=0.30), hips=(-0.24, 0, 0), chest=(-0.20, 0, 0), neck=(0.26, 0, 0),
               thigh_l=(-0.10, 0, 0.14), thigh_r=(0.30, 0, -0.14), shin_l=(0.20, 0, 0), shin_r=(0.40, 0, 0))),
        (12, bp(**two_handed(-0.30, 0.85, out=0.24), hips=(0.22, 0, 0), chest=(0.10, 0, 0), neck=(-0.24, 0, 0),
                thigh_l=(0.28, 0, 0.10), thigh_r=(-0.16, 0, -0.10))),
    ]))

    capstan = []
    for k in range(5):
        f = 1 + k * 9
        s = math.sin((k / 4) * math.tau)
        p = bp(**two_handed(-1.15, 0.30, out=0.26), hips=(0.42, 0, 0.0), spine1=(0.12, 0, 0),
               chest=(0.16, 0, 0), neck=(-0.46, 0, 0))
        p["thigh_l"] = (0.52 + s * 0.30, 0, 0.10)
        p["thigh_r"] = (-0.12 - s * 0.30, 0, -0.10)
        p["shin_l"] = (0.34 - s * 0.20, 0, 0)
        p["shin_r"] = (0.52 + s * 0.24, 0, 0)
        p["hips"] = (0.42, 0, s * 0.06)
        capstan.append((f, p))
    T.append(("capstan_push", capstan))

    bail = []
    for k, (fwd, bend, hip) in enumerate([(-0.20, 0.50, 0.10), (-1.55, 1.30, 0.72), (-0.55, 1.05, 0.36), (-0.20, 0.50, 0.10)]):
        f = 1 + k * 7
        bail.append((f, bp(**two_handed(fwd, bend, out=0.16), hips=(hip, 0, 0), spine1=(hip * 0.25, 0, 0),
                           chest=(hip * 0.30, 0, 0), neck=(-hip * 0.55, 0, 0),
                           thigh_l=(hip * 0.55, 0, 0.10), thigh_r=(hip * 0.30, 0, -0.10),
                           shin_l=(hip * 0.40, 0, 0), shin_r=(hip * 0.55, 0, 0))))
    T.append(("bail", bail))

    hammer = []
    for k, (fwd, bend) in enumerate([(-0.30, 0.85), (-2.05, 0.35), (-0.10, 1.25), (-0.30, 0.85)]):
        f = 1 + k * 5
        p = bp(hips=(0.22, 0, 0), chest=(0.16, 0, 0.06), neck=(-0.26, 0, 0),
               thigh_l=(0.30, 0, 0.12), thigh_r=(-0.10, 0, -0.12), shin_l=(0.26, 0, 0), shin_r=(0.30, 0, 0))
        p["upperarm_r"] = (fwd, 0.0, -0.18)
        p["forearm_r"] = (bend, 0.0, 0.0)
        p["upperarm_l"] = (-0.55, 0.0, 0.30)
        p["forearm_l"] = (1.10, 0.0, 0.0)
        hammer.append((f, p))
    T.append(("hammer", hammer))

    dig = []
    for k, (fwd, bend, hip) in enumerate([(-0.35, 0.70, 0.24), (-1.35, 0.95, 0.86), (-0.25, 0.45, 0.30), (-0.35, 0.70, 0.24)]):
        f = 1 + k * 8
        dig.append((f, bp(**two_handed(fwd, bend, out=0.18), hips=(hip, 0, 0), spine1=(hip * 0.22, 0, 0),
                          chest=(hip * 0.26, 0, 0), neck=(-hip * 0.60, 0, 0),
                          thigh_l=(hip * 0.60, 0, 0.12), thigh_r=(hip * 0.22, 0, -0.12),
                          shin_l=(hip * 0.45, 0, 0), shin_r=(hip * 0.62, 0, 0))))
    T.append(("dig", dig))

    T.append(("spyglass", breath(bp(upperarm_r=(-1.42, 0.0, -0.28), forearm_r=(1.35, 0.0, 0.0),
                                    upperarm_l=(-0.75, 0.0, 0.34), forearm_l=(1.05, 0.0, 0.0),
                                    chest=(-0.06, 0, 0), neck=(0.10, 0, 0), head=(-0.08, 0, 0),
                                    thigh_l=(0.0, 0, 0.08), thigh_r=(0.0, 0, -0.08)), amp=0.02, period=54)))

    # firearms
    aim = bp(upperarm_r=(-1.48, 0.0, -0.14), forearm_r=(0.14, 0.0, 0.0),
             upperarm_l=(-1.30, 0.0, 0.30), forearm_l=(0.62, 0.0, 0.0),
             chest=(0.0, -0.16, 0.0), spine2=(0.0, -0.08, 0.0), neck=(0.04, 0.10, 0.0),
             thigh_l=(0.08, 0, 0.10), thigh_r=(-0.06, 0, -0.10), shin_l=(0.12, 0, 0), shin_r=(0.14, 0, 0))
    T.append(("aim_pistol", breath(aim, amp=0.014, period=42)))
    T.append(("fire_pistol", [
        (1, dict(aim)),
        (3, bp(upperarm_r=(-1.86, 0.0, -0.16), forearm_r=(0.06, 0.0, 0.0),
               upperarm_l=(-1.34, 0.0, 0.32), forearm_l=(0.70, 0.0, 0.0),
               chest=(-0.08, -0.16, 0.0), neck=(0.10, 0.10, 0.0),
               thigh_l=(0.08, 0, 0.10), thigh_r=(-0.06, 0, -0.10))),
        (11, dict(aim)),
    ]))
    T.append(("reload", [
        (1, dict(aim)),
        (8, bp(upperarm_r=(-0.85, 0.0, -0.22), forearm_r=(1.25, 0.0, 0.0),
               upperarm_l=(-0.45, 0.0, 0.26), forearm_l=(1.45, 0.0, 0.0),
               chest=(0.10, -0.06, 0.0), neck=(-0.18, 0.0, 0.0), head=(-0.16, 0.0, 0.0),
               thigh_l=(0.04, 0, 0.10), thigh_r=(-0.02, 0, -0.10))),
        (18, bp(upperarm_r=(-1.05, 0.0, -0.18), forearm_r=(0.95, 0.0, 0.0),
                upperarm_l=(-0.95, 0.0, 0.30), forearm_l=(0.55, 0.0, 0.0),
                chest=(0.04, -0.10, 0.0), neck=(-0.06, 0.0, 0.0))),
        (26, dict(aim)),
    ]))

    # cutlass — timings from PlayerAnimator's CUTLASS_VIEW_CHARGE_TIME 0.72 s
    guard = bp(upperarm_r=(-0.95, 0.0, -0.34), forearm_r=(1.05, 0.0, 0.0),
               upperarm_l=(-0.35, 0.0, 0.42), forearm_l=(0.75, 0.0, 0.0),
               chest=(0.04, -0.22, 0.0), spine2=(0.0, -0.10, 0.0), neck=(0.0, 0.16, 0.0),
               thigh_l=(0.16, 0, 0.14), thigh_r=(-0.12, 0, -0.14), shin_l=(0.22, 0, 0), shin_r=(0.24, 0, 0))
    T.append(("cutlass_idle", breath(guard, amp=0.024, period=36)))
    T.append(("cutlass_swing_a", [
        (1, dict(guard)),
        (7, bp(upperarm_r=(-2.05, 0.0, -0.50), forearm_r=(1.30, 0.0, 0.0),
               upperarm_l=(-0.25, 0.0, 0.46), forearm_l=(0.85, 0.0, 0.0),
               chest=(-0.06, -0.42, 0.0), spine2=(0.0, -0.20, 0.0), neck=(0.0, 0.30, 0.0),
               thigh_l=(0.10, 0, 0.14), thigh_r=(-0.08, 0, -0.14))),
        (12, bp(upperarm_r=(-0.20, 0.0, 0.30), forearm_r=(0.30, 0.0, 0.0),
                upperarm_l=(-0.30, 0.0, 0.50), forearm_l=(1.10, 0.0, 0.0),
                chest=(0.16, 0.34, 0.0), spine2=(0.06, 0.18, 0.0), neck=(-0.10, -0.26, 0.0),
                thigh_l=(0.34, 0, 0.14), thigh_r=(-0.18, 0, -0.14), shin_l=(0.30, 0, 0))),
        (22, dict(guard)),
    ]))
    T.append(("cutlass_swing_b", [
        (1, dict(guard)),
        (6, bp(upperarm_r=(-0.55, 0.0, 0.34), forearm_r=(1.35, 0.0, 0.0),
               upperarm_l=(-0.40, 0.0, 0.40), forearm_l=(0.80, 0.0, 0.0),
               chest=(0.06, 0.30, 0.0), neck=(0.0, -0.22, 0.0))),
        (11, bp(upperarm_r=(-1.35, 0.0, -0.62), forearm_r=(0.22, 0.0, 0.0),
                upperarm_l=(-0.28, 0.0, 0.44), forearm_l=(1.05, 0.0, 0.0),
                chest=(0.10, -0.40, 0.0), spine2=(0.04, -0.18, 0.0), neck=(-0.06, 0.28, 0.0),
                thigh_l=(0.30, 0, 0.14), thigh_r=(-0.20, 0, -0.14))),
        (20, dict(guard)),
    ]))
    T.append(("block", breath(bp(upperarm_r=(-1.30, 0.0, -0.10), forearm_r=(1.55, 0.0, 0.0),
                                 upperarm_l=(-1.05, 0.0, 0.34), forearm_l=(1.40, 0.0, 0.0),
                                 chest=(0.16, -0.10, 0.0), neck=(-0.14, 0.0, 0.0), head=(0.10, 0.0, 0.0),
                                 hips=(0.10, 0, 0), thigh_l=(0.22, 0, 0.14), thigh_r=(-0.14, 0, -0.14),
                                 shin_l=(0.28, 0, 0), shin_r=(0.30, 0, 0)), amp=0.02, period=30)))

    # hit reactions (played as one-shots over the base; the client also blends
    # an additive flinch toward the attacker, as it does today)
    T.append(("hit_front", [
        (1, dict(IDLE_BASE)),
        (3, bp(hips=(-0.20, 0, 0), spine1=(-0.14, 0, 0), spine2=(-0.16, 0, 0), chest=(-0.22, 0, 0),
               neck=(0.30, 0, 0), head=(0.22, 0, 0),
               upperarm_l=(-0.30, 0, 0.36), upperarm_r=(-0.30, 0, -0.36),
               forearm_l=(0.60, 0, 0), forearm_r=(0.60, 0, 0),
               thigh_l=(-0.16, 0, 0.06), thigh_r=(0.12, 0, -0.06), shin_l=(0.24, 0, 0), shin_r=(0.20, 0, 0))),
        (12, dict(IDLE_BASE)),
    ]))
    T.append(("hit_back", [
        (1, dict(IDLE_BASE)),
        (3, bp(hips=(0.24, 0, 0), spine1=(0.16, 0, 0), spine2=(0.16, 0, 0), chest=(0.24, 0, 0),
               neck=(-0.30, 0, 0), head=(-0.24, 0, 0),
               upperarm_l=(0.42, 0, 0.30), upperarm_r=(0.42, 0, -0.30),
               forearm_l=(0.30, 0, 0), forearm_r=(0.30, 0, 0),
               thigh_l=(0.26, 0, 0.06), thigh_r=(0.10, 0, -0.06), shin_l=(0.16, 0, 0), shin_r=(0.30, 0, 0))),
        (12, dict(IDLE_BASE)),
    ]))

    # downed / revive — the client keeps its own CorpseState timings; these are
    # the poses those timings drive.
    downed_pose = bp(hips=(1.10, 0, 0), spine1=(0.24, 0, 0.16), spine2=(0.20, 0, 0.16), chest=(0.26, 0, 0.14),
                     neck=(-0.55, 0, 0), head=(-0.30, 0.24, 0),
                     upperarm_l=(-0.95, 0, 0.55), upperarm_r=(-0.75, 0, -0.50),
                     forearm_l=(1.25, 0, 0), forearm_r=(1.10, 0, 0),
                     thigh_l=(1.35, 0, 0.20), thigh_r=(1.20, 0, -0.16),
                     shin_l=(1.05, 0, 0), shin_r=(0.85, 0, 0), foot_l=(0.20, 0, 0), foot_r=(0.16, 0, 0))
    T.append(("downed", breath(downed_pose, amp=0.05, period=48)))
    T.append(("revive", [
        (1, dict(downed_pose)),
        (14, bp(hips=(0.72, 0, 0), spine1=(0.16, 0, 0), chest=(0.20, 0, 0), neck=(-0.34, 0, 0),
                upperarm_l=(-0.30, 0, 0.42), upperarm_r=(-0.28, 0, -0.40),
                forearm_l=(1.30, 0, 0), forearm_r=(1.25, 0, 0),
                thigh_l=(1.05, 0, 0.18), thigh_r=(0.35, 0, -0.12),
                shin_l=(0.95, 0, 0), shin_r=(0.55, 0, 0))),
        (30, dict(IDLE_BASE)),
    ]))

    # deaths — three causes, three falls (PlayerAnimator's crumple, on bones)
    T.append(("death_shot", [
        (1, dict(IDLE_BASE)),
        (4, bp(hips=(-0.18, 0, 0), chest=(-0.30, 0, 0), neck=(0.34, 0, 0), head=(0.26, 0, 0),
               upperarm_l=(0.55, 0, 0.50), upperarm_r=(0.52, 0, -0.48),
               forearm_l=(0.30, 0, 0), forearm_r=(0.30, 0, 0),
               thigh_l=(0.20, 0, 0.08), thigh_r=(0.14, 0, -0.08), shin_l=(0.34, 0, 0), shin_r=(0.30, 0, 0))),
        (14, bp(hips=(0.95, 0, 0.20), spine1=(0.26, 0, 0.14), spine2=(0.22, 0, 0.14), chest=(0.30, 0, 0.12),
                neck=(-0.50, 0, 0), head=(-0.34, 0.30, 0),
                upperarm_l=(-0.55, 0, 0.70), upperarm_r=(-0.45, 0, -0.66),
                forearm_l=(0.85, 0, 0), forearm_r=(0.80, 0, 0),
                thigh_l=(1.45, 0, 0.26), thigh_r=(1.15, 0, -0.20),
                shin_l=(1.15, 0, 0), shin_r=(0.90, 0, 0), foot_l=(0.24, 0, 0), foot_r=(0.18, 0, 0))),
        (26, bp(hips=(1.42, 0, 0.24), spine1=(0.20, 0, 0.16), spine2=(0.16, 0, 0.16), chest=(0.18, 0, 0.14),
                neck=(-0.34, 0, 0), head=(-0.20, 0.34, 0),
                upperarm_l=(-0.30, 0, 0.85), upperarm_r=(-0.22, 0, -0.80),
                forearm_l=(0.55, 0, 0), forearm_r=(0.50, 0, 0),
                thigh_l=(1.52, 0, 0.30), thigh_r=(1.30, 0, -0.24),
                shin_l=(0.95, 0, 0), shin_r=(0.75, 0, 0), foot_l=(0.28, 0, 0), foot_r=(0.22, 0, 0))),
    ]))
    T.append(("death_fall", [
        (1, bp(upperarm_l=(-1.10, 0, 0.62), upperarm_r=(-1.05, 0, -0.58), forearm_l=(0.45, 0, 0), forearm_r=(0.42, 0, 0),
               thigh_l=(0.42, 0, 0.10), thigh_r=(0.20, 0, -0.10), shin_l=(0.55, 0, 0), shin_r=(0.35, 0, 0),
               chest=(0.12, 0, 0), neck=(-0.20, 0, 0))),
        (9, bp(hips=(1.05, 0, -0.16), spine1=(0.16, 0, -0.10), chest=(0.20, 0, -0.12), neck=(-0.34, 0, 0),
               head=(-0.26, -0.24, 0),
               upperarm_l=(-0.62, 0, 0.80), upperarm_r=(-0.30, 0, -0.72), forearm_l=(0.70, 0, 0), forearm_r=(0.55, 0, 0),
               thigh_l=(1.25, 0, -0.22), thigh_r=(1.40, 0, 0.18), shin_l=(0.85, 0, 0), shin_r=(1.05, 0, 0))),
        (24, bp(hips=(1.46, 0, -0.20), spine1=(0.14, 0, -0.12), chest=(0.14, 0, -0.12), neck=(-0.24, 0, 0),
                head=(-0.16, -0.30, 0),
                upperarm_l=(-0.24, 0, 0.90), upperarm_r=(-0.16, 0, -0.86), forearm_l=(0.40, 0, 0), forearm_r=(0.35, 0, 0),
                thigh_l=(1.50, 0, -0.26), thigh_r=(1.55, 0, 0.22), shin_l=(0.70, 0, 0), shin_r=(0.80, 0, 0))),
    ]))
    T.append(("death_drown", [
        (1, bp(hips=(0.60, 0, 0), chest=(0.10, 0, 0), neck=(-0.30, 0, 0),
               upperarm_l=(-1.05, 0, 0.55), upperarm_r=(-1.00, 0, -0.52), forearm_l=(0.85, 0, 0), forearm_r=(0.80, 0, 0),
               thigh_l=(0.60, 0, 0.12), thigh_r=(0.55, 0, -0.12), shin_l=(0.40, 0, 0), shin_r=(0.36, 0, 0))),
        (16, bp(hips=(1.35, 0, 0.06), spine1=(0.10, 0, 0), chest=(0.06, 0, 0), neck=(-0.20, 0, 0), head=(-0.10, 0.10, 0),
                upperarm_l=(-1.55, 0, 0.75), upperarm_r=(-1.50, 0, -0.72), forearm_l=(0.30, 0, 0), forearm_r=(0.28, 0, 0),
                thigh_l=(1.05, 0, 0.14), thigh_r=(1.00, 0, -0.14), shin_l=(0.24, 0, 0), shin_r=(0.22, 0, 0))),
        (40, bp(hips=(1.52, 0, 0.04), chest=(0.04, 0, 0), neck=(-0.14, 0, 0), head=(-0.08, 0.06, 0),
                upperarm_l=(-1.70, 0, 0.82), upperarm_r=(-1.66, 0, -0.78), forearm_l=(0.20, 0, 0), forearm_r=(0.18, 0, 0),
                thigh_l=(1.20, 0, 0.16), thigh_r=(1.16, 0, -0.16), shin_l=(0.16, 0, 0), shin_r=(0.14, 0, 0))),
    ]))

    return T


# ── export ──────────────────────────────────────────────────────────────────
def export_skinned(objs, filename):
    os.makedirs(EXPORT_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(EXPORT_DIR, filename)
    # export_apply MUST stay False: applying modifiers evaluates the armature
    # away and ships a rigid mesh with a skeleton nothing is bound to.
    base = dict(filepath=path, export_format='GLB', use_selection=True,
                export_apply=False, export_yup=True,
                export_animations=True, export_skins=True, export_morph=False)
    for extra in ({'export_anim_single_armature': True}, {}):
        try:
            bpy.ops.export_scene.gltf(**base, **extra)
            print(f"EXPORTED {path}")
            return path
        except TypeError:
            continue
    raise RuntimeError('skinned gltf export failed for all kwarg variants')


COLL_NAME = "pirate_base"


def main():
    clear_default_scene()
    coll = asset_collection(COLL_NAME)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[COLL_NAME])

    body = build_body(coll)
    heads = [build_head(*v) for v in HEAD_VARIANTS]
    hats = build_hats()
    coats = build_coats()
    meshes = [body] + heads + hats + coats

    arm = build_armature(coll)
    for obj in meshes:
        m = obj.modifiers.new("Armature", 'ARMATURE')
        m.object = arm
        obj.parent = arm

    for name, frames in clip_table():
        make_action(arm, name, frames)

    path = export_skinned([arm] + meshes, "pirate_base.glb")

    import json
    import struct
    info = verify_glb(path)
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        clen, _ = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(clen))
    anims = [a.get('name', '?') for a in gltf.get('animations', [])]
    joints = sum(len(s.get('joints', [])) for s in gltf.get('skins', []))
    print(f"VERIFY-RIG: {joints} joints, {len(anims)} clips, {len(gltf.get('meshes', []))} meshes")
    print(f"CLIPS: {sorted(anims)}")
    assert joints == 23, f"expected 23 joints, got {joints}"
    assert len(anims) == len(clip_table()), f"{len(anims)} clips exported of {len(clip_table())}"
    print("OK pirate_base.glb")


main()
