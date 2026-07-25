# SKULL TOTEM — Skull Cove hero story scene: "ritual gone wrong".
# A giant rock monolith carved into a glaring skull (~3.8 m) atop a cairn of
# heaped stones; ring of 6 unlit torch stakes (one fallen), an offering bowl of
# coins at the mouth, one skeleton kneeling in supplication and a second
# face-down mid-flee with a cutlass in its back.
# Skull glare faces Blender -Y (= game +Z). Origin at ground center.
# Headless: Blender -b -P scripts/blender/build_scene_skulltotem.py
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())
exec(open(os.path.join(HERE, "_detail.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "")
EXPORT_DIR = os.environ.get("BR_EXPORT_DIR", EXPORT_DIR)

rng = random.Random(42)


# ── stylized skeleton (chunky, readable, ~1.8k tris) ─────────
def skel_head(coll, name, world, pos, yaw, pitch, parts):
    """Skull ~0.22m. Local face = -Y, then RZ(yaw)@RX(pitch), then world."""
    R = world @ T(*pos) @ RZ(yaw) @ RX(pitch)
    bm = bm_icosphere(0.115, 3)
    bmesh.ops.scale(bm, vec=Vector((0.88, 1.0, 1.02)), verts=bm.verts)
    xform(bm, R)
    parts.append(obj_from_bmesh(name, bm, coll, mat("Bone"), smooth=True))
    jaw = bm_bevel(bm_box(0.13, 0.11, 0.07), 0.02, 1)
    xform(jaw, R @ T(0, -0.035, -0.10))
    parts.append(obj_from_bmesh(name + "_jaw", jaw, coll, mat("Bone")))
    for sx in (-1, 1):
        e = bm_icosphere(0.032, 1)
        xform(e, R @ T(sx * 0.044, -0.086, 0.018))
        parts.append(obj_from_bmesh(f"{name}_eye{sx}", e, coll,
                                    mat("Char_Black"), smooth=True))


def skeleton(coll, name, loc, yaw, pose):
    """pose: dict of local-frame joints (facing local -Y) + head_pitch."""
    world = T(*loc) @ RZ(yaw)
    P = {k: (world @ Vector(v)) for k, v in pose.items() if k != "head_pitch"}
    parts = []
    # pelvis
    pel = bm_bevel(bm_box(0.26, 0.17, 0.13), 0.035, 1)
    xform(pel, Matrix.Translation(P["pelvis"]) @ RZ(yaw))
    parts.append(obj_from_bmesh(name + "_pelvis", pel, coll, mat("Bone")))
    # spine + ribs
    parts.append(seg_between(coll, name + "_spine", P["pelvis"], P["neck"],
                             0.05, 0.04, mat("Bone"), segs=8))
    sp, np_ = Vector(P["pelvis"]), Vector(P["neck"])
    d = (np_ - sp)
    q = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    for i, (f, rr) in enumerate(((0.42, 0.14), (0.56, 0.165), (0.70, 0.155),
                                 (0.82, 0.125))):
        rib = bm_torus(rr, 0.032, segs=12, rings=5)
        bmesh.ops.scale(rib, vec=Vector((1.0, 0.78, 0.5)), verts=rib.verts)
        xform(rib, Matrix.Translation(sp + d * f) @ q)
        parts.append(obj_from_bmesh(f"{name}_rib{i}", rib, coll,
                                    mat("Bone"), smooth=True))
    skel_head(coll, name + "_skull", Matrix.Identity(4), P["head"],
              yaw, pose.get("head_pitch", 0.0), parts)
    # arms + legs with ball joints
    limbs = [("shoulderL", "elbowL", 0.04, 0.033), ("elbowL", "handL", 0.033, 0.026),
             ("shoulderR", "elbowR", 0.04, 0.033), ("elbowR", "handR", 0.033, 0.026),
             ("hipL", "kneeL", 0.05, 0.04), ("kneeL", "footL", 0.04, 0.031),
             ("hipR", "kneeR", 0.05, 0.04), ("kneeR", "footR", 0.04, 0.031)]
    for a, b, r1, r2 in limbs:
        parts.append(seg_between(coll, f"{name}_{a}_{b}", P[a], P[b], r1, r2,
                                 mat("Bone")))
    for s in ("L", "R"):  # clavicles + hip struts so the frame reads connected
        parts.append(seg_between(coll, f"{name}_clav{s}", P["neck"],
                                 P["shoulder" + s], 0.028, 0.024, mat("Bone")))
        parts.append(seg_between(coll, f"{name}_hipb{s}", P["pelvis"],
                                 P["hip" + s], 0.034, 0.03, mat("Bone")))
    for j in ("shoulderL", "shoulderR", "elbowL", "elbowR",
              "hipL", "hipR", "kneeL", "kneeR"):
        jb = bm_icosphere(0.06 if "sho" in j or "hip" in j else 0.052, 2)
        xform(jb, Matrix.Translation(P[j]))
        parts.append(obj_from_bmesh(f"{name}_j_{j}", jb, coll,
                                    mat("Bone"), smooth=True))
    for h in ("handL", "handR", "footL", "footR"):
        hb = bm_bevel(bm_box(0.08, 0.11, 0.04), 0.012, 1)
        xform(hb, Matrix.Translation(P[h]) @ RZ(yaw))
        parts.append(obj_from_bmesh(f"{name}_{h}", hb, coll, mat("Bone")))
    return parts


POSE_KNEEL = {  # kneeling in supplication, arms raised toward -Y, head up
    "pelvis": (0, 0, 0.36), "neck": (0, 0.03, 0.85), "head": (0, -0.05, 1.0),
    "head_pitch": -0.55,
    "shoulderL": (-0.20, 0.02, 0.80), "elbowL": (-0.29, -0.20, 0.68),
    "handL": (-0.20, -0.44, 0.88),
    "shoulderR": (0.20, 0.02, 0.80), "elbowR": (0.29, -0.20, 0.68),
    "handR": (0.20, -0.44, 0.88),
    "hipL": (-0.11, 0.0, 0.32), "kneeL": (-0.13, -0.06, 0.07),
    "footL": (-0.13, 0.40, 0.05),
    "hipR": (0.11, 0.0, 0.32), "kneeR": (0.13, -0.06, 0.07),
    "footR": (0.13, 0.40, 0.05),
}

POSE_FLEE = {  # face-down mid-flee (away = local -Y), arms forward, leg bent
    "pelvis": (0, 0, 0.13), "neck": (0, -0.46, 0.15), "head": (0, -0.64, 0.12),
    "head_pitch": 1.15,
    "shoulderL": (-0.20, -0.44, 0.14), "elbowL": (-0.31, -0.66, 0.08),
    "handL": (-0.29, -0.92, 0.04),
    "shoulderR": (0.20, -0.44, 0.14), "elbowR": (0.30, -0.60, 0.10),
    "handR": (0.42, -0.80, 0.05),
    "hipL": (-0.11, 0.02, 0.12), "kneeL": (-0.14, 0.36, 0.09),
    "footL": (-0.15, 0.72, 0.07),
    "hipR": (0.11, 0.02, 0.12), "kneeR": (0.22, 0.26, 0.20),
    "footR": (0.16, 0.55, 0.10),
}


def cutlass_in_back(coll, name, loc, yaw, parts):
    """Blade stabbed downward into a prone ribcage; grip up at ~35 deg."""
    R = T(*loc) @ RZ(yaw) @ RX(math.radians(-35))
    blade = bm_bevel(bm_box(0.045, 0.012, 0.42), 0.006, 1)
    xform(blade, R @ T(0, 0, 0.10))
    parts.append(obj_from_bmesh(name + "_blade", blade, coll, mat("Metal_Iron")))
    guard = bm_cylinder(0.075, 0.075, 0.025, segs=10)
    xform(guard, R @ T(0, 0, 0.32))
    parts.append(obj_from_bmesh(name + "_guard", guard, coll,
                                mat("Metal_Iron"), smooth=True))
    grip = bm_cylinder(0.024, 0.02, 0.14, segs=8)
    xform(grip, R @ T(0, 0, 0.40))
    parts.append(obj_from_bmesh(name + "_grip", grip, coll, mat("Wood_Dark"),
                                smooth=True))
    pommel = bm_icosphere(0.03, 1)
    xform(pommel, R @ T(0, 0, 0.48))
    parts.append(obj_from_bmesh(name + "_pommel", pommel, coll,
                                mat("Metal_Iron"), smooth=True))


def face_yaw(from_xy, to_xy):
    d = Vector((to_xy[0] - from_xy[0], to_xy[1] - from_xy[1], 0)).normalized()
    return math.atan2(d.x, -d.y)


# ── scene build ──────────────────────────────────────────────
def carve(bm, direction, width, depth):
    """Push unit-sphere verts inward around a direction (cosine falloff)."""
    dn = Vector(direction).normalized()
    for v in bm.verts:
        ang = v.co.normalized().angle(dn)
        if ang < width:
            f = 0.5 + 0.5 * math.cos(ang / width * math.pi)
            v.co *= (1.0 - depth * f)


def build():
    clear_default_scene()
    agx_palette({
        "Feather_Black": ((0.045, 0.042, 0.050, 1.0), 0.70, 0.0),
        "Ember":         ((0.55, 0.16, 0.03, 1.0), 0.80, 0.0),
    })
    emissive("Ember", (1.0, 0.40, 0.10, 1.0), 2.6)
    name = "skull_totem"
    coll = asset_collection(name)
    parts = []

    SX, SY, SZ = 1.55, 1.35, 1.90   # skull half-extents (h = 3.8m)
    CZ = 0.75                        # cairn top / skull center rests here
    skull_c = Vector((0, 0.15, CZ + SZ * 0.88))

    # ── the skull monolith: icosphere subdiv 5, carved then displaced ──
    bm = bm_icosphere(1.0, 5)
    # cranium shaping: flatten the back, narrow the jaw, seat the base
    for v in bm.verts:
        if v.co.y > 0.3:
            v.co.y *= 0.90
        if v.co.z < -0.35:                      # narrow toward the jaw
            v.co.x *= (1.0 + 0.38 * v.co.z)
        if v.co.z < -0.72:                      # flatten base into the cairn
            v.co.z = -0.72 + (v.co.z + 0.72) * 0.25
    # cheekbone bulges (negative carve = bulge)
    carve(bm, (-0.80, -0.55, -0.12), 0.34, -0.10)
    carve(bm, (0.80, -0.55, -0.12), 0.34, -0.10)
    # eye sockets — the glare (deep, slightly angled = angry)
    carve(bm, (-0.40, -0.86, 0.16), 0.36, 0.36)
    carve(bm, (0.40, -0.86, 0.16), 0.36, 0.36)
    # brow shelf above sockets (bulge) → shadowed glare
    carve(bm, (-0.38, -0.80, 0.44), 0.26, -0.09)
    carve(bm, (0.38, -0.80, 0.44), 0.26, -0.09)
    # nose cavity
    carve(bm, (0, -0.99, -0.18), 0.20, 0.24)
    # mouth recess band
    carve(bm, (0, -0.90, -0.52), 0.30, 0.18)
    # temple dents (weathering)
    carve(bm, (-0.95, -0.1, 0.35), 0.30, 0.08)
    carve(bm, (0.92, 0.2, 0.30), 0.32, 0.08)
    # CARVED, not tessellated: chisel planes everywhere except the face, then
    # flat-shade. This is the fix for the audit's "raw icosphere facets".
    carve_facets(bm, 1.0, count=26, depth=(0.72, 0.91), seed=5, softness=0.0,
                 skip_dirs=((0, -1, 0), (-0.4, -0.86, 0.16), (0.4, -0.86, 0.16),
                            (0, -0.9, -0.5)))
    # ── the BACK of the head (round 2) ──────────────────────────
    # The face carving was the whole fidelity budget last pass, so anyone who
    # walked round the monolith saw a featureless grey wedge. Detail here has
    # to be carved INTO the mesh: the chisel planes above pull the real surface
    # 9-28% inside the ideal sphere, so any box "stuck on" at the nominal
    # radius floats off in space and reads as black tape (tried it; it did).
    def back_dir(a, e):
        """Unit direction, a = yaw from +Y (the back), e = elevation."""
        return (math.sin(a) * math.cos(e), math.cos(a) * math.cos(e),
                math.sin(e))

    # two courses of tally grooves cut round the occiput
    # width must stay well above the subdiv-5 icosphere's ~0.035 rad vertex
    # spacing or the groove falls between verts and simply never appears
    for elev, cnt, span, dep in ((0.32, 7, 1.20, 0.085),
                                 (-0.10, 6, 1.00, 0.070)):
        for k in range(cnt):
            a = (k / (cnt - 1) - 0.5) * 2.0 * span
            d = back_dir(a, elev)
            # every third stroke is the deeper "count of five" cut
            carve(bm, d, 0.155, dep * (1.5 if k % 3 == 0 else 1.0))
    # split fissures running down the crown and the back
    for fa, fe, n, dep in ((0.42, 0.86, 5, 0.075), (-0.62, 0.70, 4, 0.062),
                           (0.15, 0.48, 4, 0.050), (-1.10, 0.30, 3, 0.044)):
        for s in range(n):
            t = s / max(1, n - 1)
            carve(bm, back_dir(fa + 0.05 * math.sin(t * 4.0), fe - t * 0.36),
                  0.20, dep * 1.5 * (1.0 - 0.30 * t))
    # weather-blistered shelves: shallow wide scoops that catch the sun and
    # give the back a value break instead of one uniform grey plane
    for sa, se, w, dep in ((0.95, 0.52, 0.44, 0.055), (-0.85, 0.14, 0.40, 0.048),
                           (0.30, -0.20, 0.36, 0.042), (-0.20, 0.72, 0.34, 0.040)):
        carve(bm, back_dir(sa, se), w, dep)
    bmesh.ops.scale(bm, vec=Vector((SX, SY, SZ)), verts=bm.verts)
    xform(bm, Matrix.Translation(skull_c))
    skull = obj_from_bmesh("skull_mono", bm, coll, mat("Rock_Dark"), smooth=False)
    displace_noise(skull, strength=0.05, scale=1.1, seed=7)
    apply_modifiers(skull)
    parts.append(skull)

    # ── votive spikes driven into the back of the skull ──────────
    # Anything ADDED to the monolith has to be driven deep enough to survive
    # the chisel planes pulling the real surface up to 28% inside the ideal
    # sphere — hence the 0.80 seat factor and the long buried shank.
    def on_skull(a, e, k=0.80):
        d = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e),
                    math.sin(e)))
        return skull_c + Vector((d.x * SX, d.y * SY, d.z * SZ)) * k, d

    for si, (sa, se) in enumerate(((0.75, 0.58), (-0.45, 0.40), (0.20, 0.80),
                                   (-1.02, 0.18))):
        p, d = on_skull(sa, se)
        out_n = Vector((d.x / SX, d.y / SY, d.z / SZ)).normalized()
        sp = bm_cylinder(0.045, 0.016, 0.78, segs=6)
        q = out_n.to_track_quat('Z', 'Y')
        xform(sp, Matrix.Translation(p + out_n * 0.30) @ q.to_matrix().to_4x4())
        parts.append(obj_from_bmesh(f"votive{si}", sp, coll, mat("Rust"),
                                    smooth=True))
        if si % 2 == 0:                          # bone charm hung off the spike
            tip = p + out_n * 0.60
            ch = bm_icosphere(0.058, 2)
            bmesh.ops.scale(ch, vec=Vector((0.8, 0.8, 1.30)), verts=ch.verts)
            xform(ch, Matrix.Translation(tip - Vector((0, 0, 0.22))))
            parts.append(obj_from_bmesh(f"charm{si}", ch, coll, mat("Bone"),
                                        smooth=True))
            cd = bm_cylinder(0.008, 0.008, 0.20, segs=4)
            xform(cd, Matrix.Translation(tip - Vector((0, 0, 0.10))))
            parts.append(obj_from_bmesh(f"charmcord{si}", cd, coll,
                                        mat("Rope"), smooth=True))
    # cranial suture: a shallow inlaid ridge of paler stone, sunk into the
    # crown so it reads as a carved line, not a blade stuck to the face
    for i, (ax, az, ln, yaw2) in enumerate(((-0.34, 1.30, 0.85, 0.30),
                                            (0.30, 1.42, 0.70, -0.40))):
        cut = bm_bevel(bm_box(0.05, 0.16, ln), 0.012, 1)
        xform(cut, Matrix.Translation(skull_c) @
              T(ax * SX * 0.55, -SY * 0.60, az * SZ * 0.30) @ RY(yaw2) @
              RX(math.radians(12)))
        parts.append(obj_from_bmesh(f"suture{i}", cut, coll, mat("Rock_Grey")))

    # brow ridge slabs (glare) — Bone_Shadow accents, embedded in the rock
    for sx in (-1, 1):
        bb = bm_bevel(bm_box(0.62, 0.30, 0.20), 0.05, 2)
        m = (Matrix.Translation(skull_c) @
             T(sx * 0.60, -SY * 0.40, SZ * 0.30) @
             RZ(sx * -0.10) @ RX(math.radians(26)) @ RY(sx * math.radians(-16)))
        xform(bb, m)
        o = obj_from_bmesh(f"brow{sx}", bb, coll, mat("Bone_Shadow"))
        displace_noise(o, strength=0.05, scale=0.6, seed=21 + sx)
        apply_modifiers(o)
        parts.append(o)

    # eye socket shadow plugs — big, deep, the actual glare
    for sx in (-1, 1):
        e = bm_icosphere(0.44, 3)
        bmesh.ops.scale(e, vec=Vector((1.0, 0.5, 0.8)), verts=e.verts)
        xform(e, Matrix.Translation(skull_c) @ T(sx * 0.58, -SY * 0.60, SZ * 0.14))
        parts.append(obj_from_bmesh(f"socket{sx}", e, coll, mat("Char_Black"),
                                    smooth=True))
    # nose shadow
    nb = bm_icosphere(0.22, 3)
    bmesh.ops.scale(nb, vec=Vector((0.75, 0.5, 1.15)), verts=nb.verts)
    xform(nb, Matrix.Translation(skull_c) @ T(0, -SY * 0.80, -SZ * 0.12))
    parts.append(obj_from_bmesh("nose", nb, coll, mat("Char_Black"), smooth=True))

    # mouth: dark recess slab + a row of carved teeth (Bone_Shadow)
    mrec = bm_icosphere(0.62, 3)
    bmesh.ops.scale(mrec, vec=Vector((1.35, 0.4, 0.5)), verts=mrec.verts)
    xform(mrec, Matrix.Translation(skull_c) @ T(0, -SY * 0.72, -SZ * 0.52))
    parts.append(obj_from_bmesh("maw", mrec, coll, mat("Char_Black"), smooth=True))
    n_teeth = 7
    for i in range(n_teeth):
        t = (i / (n_teeth - 1) - 0.5)
        a = t * 1.15
        tw = 0.20 - abs(t) * 0.05
        th = 0.34 - abs(t) * 0.10 + rng.uniform(-0.03, 0.03)
        if i == 2:      # one tooth broken
            th *= 0.45
        tb = bm_bevel(bm_box(tw, 0.16, th), 0.03, 2)
        px = math.sin(a) * SX * 0.72
        py = -math.cos(a * 0.8) * SY * 0.86
        pz = -SZ * 0.44 - abs(t) * 0.14
        xform(tb, Matrix.Translation(skull_c) @ T(px, py, pz) @ RZ(a * 0.6))
        parts.append(obj_from_bmesh(f"tooth{i}", tb, coll, mat("Bone_Shadow")))

    # ── the cairn: heaped stones under the skull ──
    n_st = 34
    for i in range(n_st):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.2, 1.9) * (0.6 + 0.4 * rng.random())
        sr = rng.uniform(0.24, 0.55) * (1.25 - rr / 2.6)
        sz = max(-0.05, (1.0 - rr / 2.4) * rng.uniform(0.15, 0.75) - sr * 0.35)
        st = bm_icosphere(sr, 3)
        bmesh.ops.scale(st, vec=Vector((rng.uniform(0.8, 1.3),
                                        rng.uniform(0.8, 1.3),
                                        rng.uniform(0.55, 0.85))), verts=st.verts)
        carve_facets(st, sr, count=8, depth=(0.74, 0.95), seed=100 + i,
                     softness=0.015)
        xform(st, T(math.cos(a) * rr, math.sin(a) * rr * 0.9 + 0.15, sz) @
              RZ(rng.uniform(0, math.tau)))
        parts.append(obj_from_bmesh(f"cairn{i}", st, coll,
                                    mat("Rock_Grey" if rng.random() < 0.55
                                        else "Rock_Dark"), smooth=False))
    # core mound so no gaps under the skull
    core = bm_icosphere(1.0, 4)
    bmesh.ops.scale(core, vec=Vector((1.75, 1.55, 0.62)), verts=core.verts)
    xform(core, T(0, 0.15, 0.20))
    o = obj_from_bmesh("cairn_core", core, coll, mat("Rock_Grey"), smooth=False)
    displace_noise(o, strength=0.28, scale=1.4, seed=88)
    apply_modifiers(o)
    parts.append(o)

    # ── ring of 6 torch stakes (unlit, one fallen) ──
    ring_r = 3.3
    for i in range(6):
        a = i * math.tau / 6 + math.tau / 12
        px, py = math.cos(a) * ring_r, math.sin(a) * ring_r * 0.95
        fallen = (i == 4)
        h = 1.75
        if fallen:
            m = T(px, py, 0.10) @ RZ(a + 0.7) @ RX(math.radians(87))
        else:
            m = (T(px, py, 0) @
                 RX(math.radians(rng.uniform(-7, 7))) @
                 RY(math.radians(rng.uniform(-7, 7))))
        pole = bm_cylinder(0.055, 0.04, h, segs=8)
        xform(pole, m @ T(0, 0, h / 2))
        parts.append(obj_from_bmesh(f"stake{i}", pole, coll, mat("Wood_Dark"),
                                    smooth=True))
        wrap = bm_cylinder(0.075, 0.07, 0.16, segs=8)
        xform(wrap, m @ T(0, 0, h - 0.14))
        parts.append(obj_from_bmesh(f"wrap{i}", wrap, coll, mat("Bone_Shadow"),
                                    smooth=True))
        head = bm_icosphere(0.12, 3)
        bmesh.ops.scale(head, vec=Vector((1, 1, 1.35)), verts=head.verts)
        xform(head, m @ T(0, 0, h + 0.06))
        o = obj_from_bmesh(f"torch{i}", head, coll, mat("Char_Black"), smooth=True)
        displace_noise(o, strength=0.04, scale=0.2, seed=200 + i)
        apply_modifiers(o)
        parts.append(o)
        # rope lashing + feather charms, built on the stake's own matrix so
        # they ride the lean instead of floating beside it
        for li in range(3):
            ring = bm_torus(0.072, 0.017, segs=12, rings=5)
            xform(ring, m @ T(0, 0, h * 0.62 + (li - 1) * 0.055))
            parts.append(obj_from_bmesh(f"stakelash{i}_{li}", ring, coll,
                                        mat("Rope"), smooth=True))
        for k in range(2):
            fm = (m @ T(0, 0, h * 0.62) @ RZ(k * 2.1 + 0.6) @
                  T(0, -0.07, -0.02) @ RX(math.radians(166 + k * 8)))
            parts += feather(coll, f"stakefeather{i}_{k}", fm, 0.26,
                             mat("Feather_Black"), width=0.045)
        tie = bm_cylinder(0.012, 0.008, 0.16, segs=5)
        xform(tie, m @ T(0.05, -0.05, h * 0.55) @ RX(math.radians(20)))
        parts.append(obj_from_bmesh(f"staketie{i}", tie, coll, mat("Rope"),
                                    smooth=True))

    # ── two BONE TOTEM spears: stacked skulls, rope lashings, feathers ──
    def bone_totem(tag, bx, by, yaw, n_sk=3, h=2.35):
        nonlocal parts
        m0 = T(bx, by, 0) @ RZ(yaw) @ RY(math.radians(rng.uniform(-6, 6)))
        shaft = bm_cylinder(0.055, 0.038, h, segs=8)
        xform(shaft, m0 @ T(0, 0, h / 2))
        parts.append(obj_from_bmesh(f"{tag}_shaft", shaft, coll,
                                    mat("Wood_Dark"), smooth=True))
        for k in range(n_sk):
            z = h - 0.30 - k * 0.42
            sc = 1.0 - k * 0.08
            sk = bm_icosphere(0.155 * sc, 2)
            bmesh.ops.scale(sk, vec=Vector((0.88, 1.0, 1.05)), verts=sk.verts)
            carve_facets(sk, 0.155 * sc, count=7, depth=(0.88, 0.99),
                         seed=500 + k, softness=0.01,
                         skip_dirs=((0, -1, 0),))
            xform(sk, m0 @ T(0, 0, z) @ RZ(rng.uniform(-0.4, 0.4)))
            parts.append(obj_from_bmesh(f"{tag}_skull{k}", sk, coll,
                                        mat("Bone"), smooth=False))
            jw = bm_bevel(bm_box(0.17 * sc, 0.14 * sc, 0.075), 0.02, 1)
            xform(jw, m0 @ T(0, -0.03, z - 0.135 * sc))
            parts.append(obj_from_bmesh(f"{tag}_jaw{k}", jw, coll,
                                        mat("Bone")))
            for sxe in (-1, 1):               # socket shadows
                e = bm_icosphere(0.045 * sc, 2)
                bmesh.ops.scale(e, vec=Vector((1.0, 0.6, 0.85)), verts=e.verts)
                xform(e, m0 @ T(sxe * 0.062 * sc, -0.115 * sc, z + 0.025))
                parts.append(obj_from_bmesh(f"{tag}_eye{k}{sxe}", e, coll,
                                            mat("Char_Black"), smooth=True))
            for li in range(2):
                g = bm_torus(0.075, 0.016, segs=12, rings=5)
                xform(g, m0 @ T(0, 0, z - 0.26 + li * 0.05))
                parts.append(obj_from_bmesh(f"{tag}_lash{k}_{li}", g, coll,
                                            mat("Rope"), smooth=True))
        for k in range(3):
            fm = (m0 @ T(0.06 * (k - 1), -0.02, h - 0.02) @ RZ(k * 1.2 - 1.2) @
                  RX(math.radians(150 + k * 10)))
            parts += feather(coll, f"{tag}_feather{k}", fm, 0.30,
                             mat("Feather_Black"), width=0.05)
        for gi in range(4):
            g = bm_torus(0.062, 0.015, segs=12, rings=5)
            xform(g, m0 @ T(0, 0, 0.95 + (gi - 1.5) * 0.05))
            parts.append(obj_from_bmesh(f"{tag}_grip{gi}", g, coll, mat("Rope"),
                                        smooth=True))

    bone_totem("totemL", -2.55, 1.25, 0.5)
    bone_totem("totemR", 2.70, 0.55, -0.7, n_sk=2, h=2.05)

    # ── iron brazier (bible): tripod legs, coal bowl, ember glow ──
    BX, BY = 2.30, -2.15
    for k in range(3):
        a = k * math.tau / 3 + 0.4
        parts.append(seg_between(coll, f"brz_leg{k}",
                                 (BX + math.cos(a) * 0.30,
                                  BY + math.sin(a) * 0.30, 0.0),
                                 (BX + math.cos(a) * 0.09,
                                  BY + math.sin(a) * 0.09, 0.72),
                                 0.032, 0.026, mat("Metal_Iron"), segs=6))
    bowl2 = bm_cylinder(0.42, 0.26, 0.30, segs=14)
    xform(bowl2, T(BX, BY, 0.86))
    parts.append(obj_from_bmesh("brz_bowl", bowl2, coll, mat("Rust"),
                                smooth=True))
    rim = bm_torus(0.42, 0.035, segs=16, rings=6)
    xform(rim, T(BX, BY, 1.01))
    parts.append(obj_from_bmesh("brz_rim", rim, coll, mat("Metal_Iron"),
                                smooth=True))
    for k in range(9):                        # coals + one live ember
        cz = bm_icosphere(rng.uniform(0.05, 0.09), 1)
        xform(cz, T(BX + rng.uniform(-0.24, 0.24), BY + rng.uniform(-0.24, 0.24),
                    0.99 + rng.uniform(0, 0.05)))
        parts.append(obj_from_bmesh(f"brz_coal{k}", cz, coll,
                                    mat("Ember" if k in (2, 6) else "Char_Black"),
                                    smooth=False))

    # ── bone heap banked against the cairn (backlog: the bone-heap beat) ──
    for i in range(11):
        a = rng.uniform(-2.5, -0.6)
        rr = rng.uniform(1.6, 2.4)
        bx2, by2 = math.cos(a) * rr, math.sin(a) * rr * 0.95 + 0.15
        kind = i % 3
        if kind == 0:
            sk = bm_icosphere(0.135, 2)
            bmesh.ops.scale(sk, vec=Vector((0.88, 1.0, 1.02)), verts=sk.verts)
            carve_facets(sk, 0.135, count=6, depth=(0.9, 0.99), seed=600 + i,
                         softness=0.01, skip_dirs=((0, -1, 0),))
            xform(sk, T(bx2, by2, 0.14) @ RZ(rng.uniform(0, 3)) @
                  RX(rng.uniform(-0.6, 0.6)))
            parts.append(obj_from_bmesh(f"heap_sk{i}", sk, coll, mat("Bone"),
                                        smooth=False))
        elif kind == 1:
            rib = bm_torus(0.20, 0.024, segs=12, rings=5)
            bmesh.ops.scale(rib, vec=Vector((1, 0.7, 0.45)), verts=rib.verts)
            xform(rib, T(bx2, by2, 0.06) @ RZ(rng.uniform(0, 3)) @
                  RX(math.radians(rng.uniform(60, 100))))
            parts.append(obj_from_bmesh(f"heap_rib{i}", rib, coll, mat("Bone"),
                                        smooth=True))
        else:
            lb = bm_cylinder(0.040, 0.032, 0.52, segs=6)
            xform(lb, T(bx2, by2, 0.05) @ RZ(rng.uniform(0, 3)) @
                  RX(math.radians(rng.uniform(78, 100))))
            parts.append(obj_from_bmesh(f"heap_bn{i}", lb, coll, mat("Bone"),
                                        smooth=True))
            kn = bm_icosphere(0.052, 1)
            xform(kn, T(bx2 + rng.uniform(-0.22, 0.22),
                        by2 + rng.uniform(-0.22, 0.22), 0.05))
            parts.append(obj_from_bmesh(f"heap_kn{i}", kn, coll, mat("Bone"),
                                        smooth=True))

    # ── offering bowl of coins at the mouth ──
    ped = bm_icosphere(0.42, 2)
    bmesh.ops.scale(ped, vec=Vector((1.1, 1.0, 0.5)), verts=ped.verts)
    xform(ped, T(0, -1.95, 0.16))
    o = obj_from_bmesh("bowl_ped", ped, coll, mat("Rock_Grey"), smooth=True)
    displace_noise(o, strength=0.10, scale=0.7, seed=55)
    apply_modifiers(o)
    parts.append(o)
    bowl = bm_cylinder(0.40, 0.26, 0.22, segs=14)
    xform(bowl, T(0, -1.95, 0.44))
    parts.append(obj_from_bmesh("bowl", bowl, coll, mat("Metal_Iron"),
                                smooth=True))
    heap = bm_icosphere(0.30, 2)
    bmesh.ops.scale(heap, vec=Vector((1.05, 1.05, 0.42)), verts=heap.verts)
    xform(heap, T(0, -1.95, 0.55))
    o = obj_from_bmesh("coin_heap", heap, coll, mat("Gold"), smooth=True)
    displace_noise(o, strength=0.035, scale=0.12, seed=66)
    apply_modifiers(o)
    parts.append(o)
    for i in range(34):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(0.0, 0.34) if i < 18 else rng.uniform(0.45, 0.9)
        z = 0.64 if i < 18 else 0.02
        c = bm_cylinder(0.038, 0.038, 0.009, segs=7)
        xform(c, T(math.cos(a) * rr, -1.95 + math.sin(a) * rr, z) @
              RX(rng.uniform(-0.5, 0.5)) @ RY(rng.uniform(-0.5, 0.5)))
        parts.append(obj_from_bmesh(f"coin{i}", c, coll, mat("Gold")))

    # ── the two skeletons ──
    k_loc = (0.95, -3.1, 0.0)
    skeleton(coll, "kneeler", k_loc, face_yaw(k_loc, (0, 0.15)), POSE_KNEEL)
    f_loc = (-1.85, -3.6, 0.0)
    f_yaw = face_yaw((0, 0.15), f_loc)  # fleeing AWAY from the skull
    skeleton(coll, "fleer", f_loc, f_yaw, POSE_FLEE)
    # cutlass in the fleer's back (over the ribcage, between shoulders)
    back = (T(*f_loc) @ RZ(f_yaw)) @ Vector((0.02, -0.28, 0.16))
    cutlass_in_back(coll, "cutlass", back, f_yaw + 0.5, parts)

    # scatter bones near the cairn edge
    for i, (bx, by) in enumerate(((2.1, -1.6), (-2.4, -0.8), (1.6, 1.9))):
        rib = bm_torus(0.14, 0.018, segs=10, rings=5)
        bmesh.ops.scale(rib, vec=Vector((1, 0.75, 0.5)), verts=rib.verts)
        xform(rib, T(bx, by, 0.03) @ RZ(rng.uniform(0, 3)) @
              RX(math.radians(80)))
        parts.append(obj_from_bmesh(f"srib{i}", rib, coll, mat("Bone"),
                                    smooth=True))
        lb = bm_cylinder(0.03, 0.024, 0.4, segs=6)
        xform(lb, T(bx + 0.2, by + 0.15, 0.03) @ RZ(rng.uniform(0, 3)) @
              RX(math.radians(88)))
        parts.append(obj_from_bmesh(f"sbone{i}", lb, coll, mat("Bone"),
                                    smooth=True))

    SPEC = tint_spec(moss=0.40)
    SPEC['Rock_Dark'] = dict(
        tone=0.14, hue=((1.22, 1.10, 0.94), (0.76, 0.82, 0.96)), scale=1.8,
        mottle=0.13, mscale=0.32,
        patch=dict(col=(0.45, 0.85, 0.35), amt=0.55, scale=0.9, thresh=0.62,
                   width=0.14, up=0.8),
        low=dict(z=0.55, amt=0.30, col=(0.55, 0.52, 0.42)))
    SPEC['Bone'] = dict(
        tone=0.14, hue=((1.18, 1.12, 1.00), (0.78, 0.78, 0.74)), scale=0.5,
        mottle=0.10, mscale=0.13,
        patch=dict(col=(0.55, 0.72, 0.42), amt=0.45, scale=0.4, thresh=0.66,
                   width=0.12, up=0.7),
        low=dict(z=0.25, amt=0.40, col=(0.45, 0.44, 0.36)))
    SPEC['Feather_Black'] = dict(tone=0.10, mottle=0.12, mscale=0.08)
    ship_asset(coll, name, spec=SPEC, ao=dict(samples=22, floor=0.42),
               render_dir=RENDER_DIR, views=4, elev=14)
    print(f"built {name}")


build()
print("SKULLTOTEM DONE")
