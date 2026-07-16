# Creature GLBs with named animatable pivot nodes: shark, crab, chicken, pig,
# gull. Each moving part is its OWN exported object re-origined onto its joint
# axis (tavern-door pattern) so the game swings it with a simple node rotation;
# everything else joins into one main object. 1 unit = 1 m; forward = -Y
# (= game +Z). Land animals stand on z = 0; the shark's origin is mid-body.
# Headless: Blender -b -P scripts/blender/build_animals.py
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get(
    "BR_RENDER_DIR",
    "/private/tmp/claude-501/-Users-tobiasdicker/9b33795a-f2a3-4c74-a2c2-322440e34d92/scratchpad/renders/animals")

# Saturated/dark albedo on purpose — the render view transform and in-game
# lighting both wash colors toward pastel; pale picks read as white.
EXTRA = {
    "Shark_Grey":  ((0.28, 0.33, 0.40, 1.0), 0.85, 0.0),
    "Shark_Belly": ((0.88, 0.90, 0.92, 1.0), 0.85, 0.0),
    "Shark_Dark":  ((0.15, 0.18, 0.23, 1.0), 0.85, 0.0),
    "Mouth_Red":   ((0.42, 0.07, 0.07, 1.0), 0.90, 0.0),
    "Teeth_White": ((0.95, 0.93, 0.86, 1.0), 0.70, 0.0),
    "Eye_Black":   ((0.03, 0.03, 0.03, 1.0), 0.40, 0.0),
    "Crab_Red":    ((0.70, 0.16, 0.05, 1.0), 0.80, 0.0),
    "Crab_Dark":   ((0.38, 0.08, 0.03, 1.0), 0.80, 0.0),
    "Hen_Brown":   ((0.46, 0.24, 0.10, 1.0), 0.85, 0.0),
    "Hen_Cream":   ((0.76, 0.60, 0.38, 1.0), 0.85, 0.0),
    "Comb_Red":    ((0.70, 0.07, 0.05, 1.0), 0.80, 0.0),
    "Beak_Yellow": ((0.85, 0.58, 0.08, 1.0), 0.70, 0.0),
    "Pig_Pink":    ((0.83, 0.42, 0.36, 1.0), 0.85, 0.0),
    "Pig_Snout":   ((0.68, 0.28, 0.24, 1.0), 0.85, 0.0),
    "Hoof_Dark":   ((0.18, 0.11, 0.07, 1.0), 0.85, 0.0),
    "Gull_White":  ((0.90, 0.91, 0.93, 1.0), 0.85, 0.0),
    "Gull_Grey":   ((0.36, 0.41, 0.48, 1.0), 0.85, 0.0),
    "Gull_Dark":   ((0.08, 0.09, 0.11, 1.0), 0.80, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


# ── local builders ───────────────────────────────────────────
def box(coll, name, w, d, h, x, y, z, material, rot=None):
    bm = bm_box(w, d, h)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material))


def blob(coll, name, r, x, y, z, material, subdiv=2, scale=(1, 1, 1), rot=None):
    bm = bm_icosphere(r, subdiv)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def seg(coll, name, p1, p2, r1, r2, material, segs=8):
    """Tapered cylinder from p1 to p2 (limb segments, beaks, peduncles)."""
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, d.length, segs=segs)
    m = Matrix.Translation((p1 + p2) * 0.5) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def fin(coll, name, pts, thickness, material, matrix=None, plane='yz'):
    """Thin solidified polygon plate. pts are 2D perimeter points in 'yz'
    (sagittal fin: dorsal/caudal) or 'xy' (horizontal: pectorals, wings)."""
    bm = bmesh.new()
    if plane == 'yz':
        vs = [bm.verts.new((0.0, p[0], p[1])) for p in pts]
    else:
        vs = [bm.verts.new((p[0], p[1], 0.0)) for p in pts]
    bm.faces.new(vs)
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thickness)
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material))


def repivot(obj, pivot):
    """Re-origin a moving part onto its joint axis; world placement preserved
    (vertices shift by -pivot, object moves to +pivot) — the exported GLB node
    then rotates about the joint at runtime."""
    p = Vector(pivot)
    obj.data.transform(Matrix.Translation(-p))
    obj.location = p


def finish(coll, name):
    bake_ao(coll)
    export_collection_vc(coll, f"{name}.glb")
    verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    render_turntable(coll, name, RENDER_DIR)
    # Delete after render: part names like 'body'/'leg0' repeat across assets
    # and Blender's .001 suffixing would leak into the next GLB's node names.
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    print(f"built {name}")


# ── shark: 3.4 m, nose y=-1.7, tail tip y=+1.7, origin mid-body ─
def _shark_profile(t):
    """Half-girth along the unit body axis: conical snout, max girth ~35 %
    back, hard taper into the caudal peduncle."""
    if t <= -0.3:
        return max(0.0, (t + 1.0) / 0.7) ** 0.8
    u = (t + 0.3) / 1.3
    return 1.0 - 0.85 * u ** 1.35


def _fusiform(subdiv, sx, sz, y0, ylen, belly_flat=0.85):
    """Icosphere reshaped by the shark profile (radial normalised so the
    profile fully owns the silhouette)."""
    bm = bm_icosphere(1.0, subdiv)
    for v in bm.verts:
        t = v.co.y
        s = math.sqrt(max(1e-4, 1.0 - t * t))
        f = _shark_profile(t) / s
        v.co.x *= sx * f
        v.co.z *= sz * f
        if v.co.z < 0:
            v.co.z *= belly_flat
        v.co.y = y0 + t * ylen
    return bm


def build_shark(name="shark"):
    coll = asset_collection(name)
    parts = []
    # grey hull + white belly under-mesh (protrudes below for the two-tone keel)
    parts.append(obj_from_bmesh("hull", _fusiform(4, 0.40, 0.52, -0.275, 1.425),
                                coll, mat("Shark_Grey"), smooth=True))
    belly = obj_from_bmesh("belly", _fusiform(3, 0.365, 0.47, -0.30, 1.32),
                           coll, mat("Shark_Belly"), smooth=True)
    belly.data.transform(Matrix.Translation((0, 0, -0.07)))
    parts.append(belly)
    # dorsal fins
    parts.append(fin(coll, "dorsal", [(-0.55, 0.38), (0.28, 1.00), (0.32, 0.62), (0.15, 0.38)],
                     0.07, "Shark_Grey"))
    parts.append(fin(coll, "dorsal2", [(0.76, 0.08), (0.92, 0.30), (0.97, 0.08)],
                     0.045, "Shark_Grey"))
    # gill slits (three per side)
    for sx in (-1, 1):
        for i, gy in enumerate((-0.70, -0.60, -0.50)):
            rot = Matrix.Rotation(sx * math.radians(8), 4, 'Y')
            parts.append(box(coll, f"gill{sx}{i}", 0.02, 0.045, 0.30,
                             sx * 0.365, gy, 0.02, "Shark_Dark", rot))
    # eyes
    for sx in (-1, 1):
        parts.append(blob(coll, f"eye{sx}", 0.045, sx * 0.19, -1.25, 0.06, "Eye_Black", 1))
    # upper teeth row on the snout underside (visible when the jaw swings open);
    # kept behind the nose tip so the mouth reads underslung, not beak-like
    parts.append(box(coll, "mouth_top", 0.20, 0.26, 0.02, 0, -1.26, -0.10, "Mouth_Red"))
    for i in range(5):
        parts.append(box(coll, f"utooth{i}", 0.026, 0.026, 0.04,
                         -0.08 + i * 0.04, -1.37, -0.11, "Teeth_White"))
    body = join(parts, name)

    # lower jaw wedge + teeth strip; hinge under the snout
    jaw = []
    jaw.append(box(coll, "jaw_w", 0.20, 0.30, 0.07, 0, -1.26, -0.16, "Shark_Belly"))
    jaw.append(box(coll, "jaw_in", 0.17, 0.26, 0.02, 0, -1.25, -0.125, "Mouth_Red"))
    for i in range(5):
        jaw.append(box(coll, f"jtooth{i}", 0.024, 0.024, 0.045,
                       -0.076 + i * 0.038, -1.39, -0.125, "Teeth_White"))
    jaw_obj = join(jaw, "shark_jaw")
    repivot(jaw_obj, (0, -1.12, -0.12))

    # tail: peduncle + crescent caudal (long upper lobe), pivot at the peduncle
    tail = []
    tail.append(seg(coll, "peduncle", (0, 1.02, 0), (0, 1.40, 0.02), 0.10, 0.04,
                    "Shark_Grey", segs=10))
    tail.append(fin(coll, "caudal_up", [(1.22, 0.05), (1.58, 0.80), (1.70, 0.74), (1.42, -0.02)],
                    0.055, "Shark_Grey"))
    tail.append(fin(coll, "caudal_lo", [(1.26, 0.02), (1.58, -0.48), (1.68, -0.40), (1.44, 0.06)],
                    0.05, "Shark_Grey"))
    tail_obj = join(tail, "shark_tail")
    repivot(tail_obj, (0, 1.05, 0))

    # pectorals: swept-back horizontal plates, rolled 26° down, pivot at root
    for sx, pname in ((1, "shark_pec_l"), (-1, "shark_pec_r")):
        m = (Matrix.Translation((sx * 0.30, -0.55, -0.12)) @
             Matrix.Rotation(-sx * math.radians(26), 4, 'Y'))
        pec = fin(coll, pname,
                  [(0.0, -0.06), (sx * 0.50, 0.36), (sx * 0.56, 0.55), (sx * 0.10, 0.28)],
                  0.045, "Shark_Grey", matrix=m, plane='xy')
        repivot(pec, (sx * 0.30, -0.55, -0.12))

    finish(coll, name)
    return coll


# ── crab: 0.55 m red-orange, six pivoting legs ───────────────
def build_crab(name="crab"):
    coll = asset_collection(name)
    parts = []
    cara = blob(coll, "cara", 1.0, 0, 0.01, 0.155, "Crab_Red", 3, scale=(0.26, 0.20, 0.105))
    displace_noise(cara, strength=0.012, scale=0.35, seed=3)
    apply_modifiers(cara)
    parts.append(cara)
    parts.append(blob(coll, "under", 1.0, 0, 0.01, 0.13, "Crab_Dark", 2,
                      scale=(0.22, 0.17, 0.085)))
    # eye stalks
    for sx in (-1, 1):
        parts.append(seg(coll, f"stalk{sx}", (sx * 0.07, -0.17, 0.20),
                         (sx * 0.09, -0.22, 0.28), 0.016, 0.012, "Crab_Red", 6))
        parts.append(blob(coll, f"ceye{sx}", 0.027, sx * 0.09, -0.22, 0.29, "Eye_Black", 1))
    # chunky claws: arm, bulb, converging tapered pincer tips
    for sx in (-1, 1):
        parts.append(seg(coll, f"arm{sx}", (sx * 0.19, -0.08, 0.13),
                         (sx * 0.29, -0.23, 0.11), 0.034, 0.026, "Crab_Red", 8))
        parts.append(blob(coll, f"claw{sx}", 1.0, sx * 0.30, -0.31, 0.105, "Crab_Red", 2,
                          scale=(0.085, 0.115, 0.07)))
        parts.append(seg(coll, f"pinc_a{sx}", (sx * 0.28, -0.39, 0.13),
                         (sx * 0.255, -0.49, 0.115), 0.024, 0.004, "Crab_Dark", 6))
        parts.append(seg(coll, f"pinc_b{sx}", (sx * 0.33, -0.39, 0.08),
                         (sx * 0.29, -0.49, 0.095), 0.022, 0.004, "Crab_Dark", 6))
    join(parts, "body")

    # legs: bent hip->knee->tip segments, pivot at each hip on the carapace edge
    for side, sx in ((0, 1), (3, -1)):
        for i in range(3):
            hy = -0.075 + i * 0.095
            hip = (sx * 0.21, hy, 0.11)
            knee = (sx * 0.32, hy + 0.02, 0.16)
            tip = (sx * 0.40, hy + 0.045, 0.0)
            leg = join([
                seg(coll, "l_a", hip, knee, 0.021, 0.017, "Crab_Red", 6),
                seg(coll, "l_b", knee, tip, 0.016, 0.006, "Crab_Dark", 6),
                blob(coll, "l_k", 0.022, *knee, "Crab_Red", 1),
            ], f"leg{side + i}")
            repivot(leg, hip)

    finish(coll, name)
    return coll


# ── chicken: 0.55 m hen ──────────────────────────────────────
def build_chicken(name="chicken"):
    coll = asset_collection(name)
    parts = []
    parts.append(blob(coll, "torso", 1.0, 0, 0.02, 0.26, "Hen_Brown", 3,
                      scale=(0.15, 0.20, 0.155)))
    parts.append(blob(coll, "breast", 1.0, 0, -0.10, 0.22, "Hen_Cream", 2,
                      scale=(0.115, 0.115, 0.115)))
    # tail: fan of thin feather plates sweeping up-back from the rump
    for i, az in enumerate((-0.55, -0.28, 0.0, 0.28, 0.55)):
        m = (Matrix.Translation((0, 0.15, 0.33)) @ Matrix.Rotation(az, 4, 'Z'))
        parts.append(fin(coll, f"tailf{i}",
                         [(0.0, 0.0), (0.15, 0.15 - abs(az) * 0.06), (0.20, 0.10 - abs(az) * 0.06),
                          (0.10, -0.02)],
                         0.014, "Hen_Brown", matrix=m))
    # thin legs + feet
    for sx in (-1, 1):
        parts.append(seg(coll, f"cleg{sx}", (sx * 0.05, 0.02, 0.13), (sx * 0.05, 0.02, 0.0),
                         0.012, 0.012, "Beak_Yellow", 6))
        parts.append(box(coll, f"cfoot{sx}", 0.055, 0.075, 0.014, sx * 0.05, -0.01, 0.008,
                         "Beak_Yellow"))
    join(parts, "body")

    # head on a short neck: comb, beak, wattle, eyes; pivot at the neck base
    neck = (0, -0.13, 0.35)
    head = [
        seg(coll, "neck", neck, (0, -0.165, 0.45), 0.055, 0.05, "Hen_Brown", 8),
        blob(coll, "skull", 0.085, 0, -0.17, 0.47, "Hen_Brown", 2),
        seg(coll, "beak", (0, -0.24, 0.465), (0, -0.32, 0.455), 0.024, 0.003, "Beak_Yellow", 6),
        blob(coll, "wattle", 0.028, 0, -0.235, 0.415, "Comb_Red", 1, scale=(0.8, 0.8, 1.3)),
    ]
    for i in range(3):
        head.append(blob(coll, f"comb{i}", 0.028, 0, -0.205 + i * 0.045, 0.552 - abs(1 - i) * 0.008,
                         "Comb_Red", 1, scale=(0.45, 0.9, 1.25)))
    for sx in (-1, 1):
        head.append(blob(coll, f"heye{sx}", 0.016, sx * 0.062, -0.20, 0.49, "Eye_Black", 1))
    head_obj = join(head, "head")
    repivot(head_obj, neck)

    # wings: flattened side blobs tucked against the body, pivot at the shoulder
    for sx, wname in ((1, "leftWing"), (-1, "rightWing")):
        w = blob(coll, wname, 1.0, sx * 0.135, 0.035, 0.28, "Hen_Cream", 2,
                 scale=(0.04, 0.16, 0.11),
                 rot=Matrix.Rotation(math.radians(-14), 4, 'X') @
                     Matrix.Rotation(sx * math.radians(-8), 4, 'Y'))
        repivot(w, (sx * 0.115, -0.01, 0.34))

    finish(coll, name)
    return coll


# ── pig: 0.9 m long ──────────────────────────────────────────
def build_pig(name="pig"):
    coll = asset_collection(name)
    parts = []
    parts.append(blob(coll, "barrel", 1.0, 0, 0.05, 0.31, "Pig_Pink", 3,
                      scale=(0.185, 0.315, 0.185)))
    # curly tail: sphere chain along a helix at the rump
    for i in range(7):
        a = i * 1.05
        parts.append(blob(coll, f"tail{i}", 0.021 - i * 0.001, math.sin(a) * 0.012,
                          0.355 + i * 0.006, 0.40 + math.sin(a * 0.9 + 1.2) * 0.035 + i * 0.004,
                          "Pig_Pink", 1))
    join(parts, "body")

    # head: dome + snout disc + nostrils + floppy ears; pivot at the neck
    neck = (0, -0.24, 0.33)
    head = [
        blob(coll, "dome", 1.0, 0, -0.36, 0.32, "Pig_Pink", 3, scale=(0.15, 0.145, 0.14)),
        seg(coll, "snout", (0, -0.46, 0.295), (0, -0.555, 0.295), 0.075, 0.068, "Pig_Snout", 10),
    ]
    for sx in (-1, 1):
        head.append(blob(coll, f"nost{sx}", 0.016, sx * 0.028, -0.558, 0.295, "Hoof_Dark", 1))
        head.append(blob(coll, f"peye{sx}", 0.019, sx * 0.088, -0.445, 0.385, "Eye_Black", 1))
        # floppy ears: small base on the crown, tip drooping over the eye
        m = (Matrix.Translation((sx * 0.085, -0.36, 0.45)) @
             Matrix.Rotation(sx * math.radians(30), 4, 'Y'))
        head.append(fin(coll, f"ear{sx}", [(-0.03, 0.0), (0.045, 0.02), (-0.13, -0.07)],
                        0.022, "Pig_Snout", matrix=m))
    head_obj = join(head, "head")
    repivot(head_obj, neck)

    # legs: stub cylinders + dark hooves; pivot at the hips
    for i, (sx, hy) in enumerate(((1, -0.17), (-1, -0.17), (1, 0.23), (-1, 0.23))):
        leg = join([
            seg(coll, "pl", (sx * 0.10, hy, 0.17), (sx * 0.10, hy, 0.03), 0.042, 0.034,
                "Pig_Pink", 8),
            seg(coll, "ph", (sx * 0.10, hy, 0.035), (sx * 0.10, hy, 0.0), 0.035, 0.035,
                "Hoof_Dark", 8),
        ], f"leg{i}")
        repivot(leg, (sx * 0.10, hy, 0.18))

    finish(coll, name)
    return coll


# ── gull: 0.5 m, wide flapping wings ─────────────────────────
def build_gull(name="gull"):
    coll = asset_collection(name)
    parts = []
    parts.append(blob(coll, "torso", 1.0, 0, 0.02, 0.17, "Gull_White", 3,
                      scale=(0.085, 0.175, 0.09)))
    # grey mantle over the back
    parts.append(blob(coll, "mantle", 1.0, 0, 0.035, 0.225, "Gull_Grey", 2,
                      scale=(0.075, 0.13, 0.035)))
    # tail wedge
    parts.append(box(coll, "tail", 0.085, 0.15, 0.018, 0, 0.235, 0.185, "Gull_White",
                     Matrix.Rotation(math.radians(8), 4, 'X')))
    # legs + webbed feet
    for sx in (-1, 1):
        parts.append(seg(coll, f"gleg{sx}", (sx * 0.033, 0.035, 0.095), (sx * 0.033, 0.035, 0.0),
                         0.009, 0.009, "Beak_Yellow", 6))
        parts.append(box(coll, f"gfoot{sx}", 0.045, 0.06, 0.010, sx * 0.033, 0.012, 0.006,
                         "Beak_Yellow"))
    join(parts, "body")

    # head + beak, pivot at the neck base
    neck = (0, -0.12, 0.21)
    head = [
        blob(coll, "skull", 0.065, 0, -0.165, 0.265, "Gull_White", 2),
        seg(coll, "gneck", neck, (0, -0.155, 0.25), 0.05, 0.045, "Gull_White", 8),
        seg(coll, "gbeak", (0, -0.215, 0.26), (0, -0.295, 0.25), 0.017, 0.004, "Beak_Yellow", 6),
    ]
    for sx in (-1, 1):
        head.append(blob(coll, f"geye{sx}", 0.014, sx * 0.047, -0.185, 0.285, "Eye_Black", 1))
    head_obj = join(head, "head")
    repivot(head_obj, neck)

    # WIDE wings (~0.45 m each): grey plates with dark tips, pivot at shoulders
    for sx, wname in ((1, "leftWing"), (-1, "rightWing")):
        root = (sx * 0.06, 0.0, 0.235)
        m = Matrix.Translation(root) @ Matrix.Rotation(-sx * math.radians(6), 4, 'Y')
        wing = [
            fin(coll, "w_main",
                [(0.0, -0.075), (sx * 0.24, -0.09), (sx * 0.44, -0.03), (sx * 0.46, 0.035),
                 (sx * 0.22, 0.065), (0.0, 0.075)],
                0.014, "Gull_Grey", matrix=m, plane='xy'),
            fin(coll, "w_tip",
                [(sx * 0.36, -0.055), (sx * 0.46, 0.02), (sx * 0.35, 0.05)],
                0.018, "Gull_Dark", matrix=m, plane='xy'),
        ]
        wing_obj = join(wing, wname)
        repivot(wing_obj, root)

    finish(coll, name)
    return coll


clear_default_scene()
build_shark()
build_crab()
build_chicken()
build_pig()
build_gull()
print("ANIMALS DONE")
