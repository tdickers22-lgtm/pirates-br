# CAMPSITE TENT VARIANTS — tent_b, tent_c.
# The audit's "identical campsite kit copy-pasted on every island" finding
# needs more than one tent silhouette to fix. tent_a (build_camp.py) is a
# symmetric A-frame; these two deliberately break that read from any angle:
#
#   tent_b  LEAN-TO / half-shelter. One canted canvas slope over a ridge pole
#           carried on two forked stakes, open face toward -Y, driftwood
#           windbreak along the closed side, guy lines to driven pegs.
#           Reads as "someone made this from wreckage", not camping gear.
#   tent_c  BELL / sail tent. A salvaged topsail wrapped round one centre pole
#           with a canted spar, scalloped hem pegged in a ring, a rolled-back
#           door flap and a smoke vent. Round footprint vs A-frame rectangle.
#
# Both stay in tent_a's footprint class (~2.4 x 4.4 x 2.1) so they can drop
# into the existing camp spacing solver without retuning colliders.
# Headless: Blender -b -P scripts/blender/build_tents_bc.py
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

clear_default_scene()
agx_palette()


def canvas_spec():
    """Tired, salt-stained, sun-bleached cloth.
    A cone or a single slope presents nearly the same normal everywhere, so a
    normal-driven bleach patch alone leaves the cloth one flat value. The
    seam streak + wider-amplitude mottle are what actually break it up."""
    return dict(
        tone=0.12, hue=((1.24, 1.17, 1.02), (0.68, 0.70, 0.76)), scale=0.85,
        mottle=0.16, mscale=0.20,
        # panel seams: the sail this was cut from was sewn from strips
        streak=dict(axis='z', freq=7.0, amt=0.10),
        # sun bleaches whatever faces the sky, mildew creeps up from the hem
        patch=dict(col=(1.30, 1.26, 1.14), amt=0.40, scale=0.55, thresh=0.50,
                   width=0.16, up=0.75),
        low=dict(z=0.70, amt=0.52, col=(0.42, 0.43, 0.37)),
    )


def tent_spec():
    S = tint_spec(moss=0.22, seed=3)
    S['Canvas'] = canvas_spec()
    S['Canvas_Dirty'] = dict(canvas_spec(),
                             hue=((1.14, 1.08, 0.96), (0.72, 0.73, 0.74)))
    for w in ('Wood_Dark', 'Wood_Mid', 'Wood_Light', 'Wood_Bleached'):
        S[w] = dict(
            tone=0.20, hue=((1.22, 1.12, 0.96), (0.72, 0.71, 0.70)), scale=0.9,
            mottle=0.10, mscale=0.14,
            streak=dict(axis='z', freq=13.0, amt=0.14),
            low=dict(z=0.26, amt=0.42, col=(0.44, 0.44, 0.40)))
    S['Rope'] = dict(tone=0.15, hue=((1.20, 1.10, 0.90), (0.74, 0.73, 0.70)),
                     scale=0.4, mottle=0.12, mscale=0.09)
    return S


def guy_line(coll, tag, top, peg_xy, parts, sag=0.05):
    """Guy rope from an anchor point down to a driven peg."""
    peg = Vector((peg_xy[0], peg_xy[1], 0.10))
    parts.extend(rope_cat(coll, tag, Vector(top), peg, sag, r=0.014, segs=5,
                          material=mat("Rope")))
    pg = bm_cylinder(0.032, 0.018, 0.34, segs=5)
    xform(pg, T(peg.x, peg.y, 0.04) @ RX(math.radians(17)) @
          RZ(math.atan2(peg.y - top[1], peg.x - top[0])))
    parts.append(obj_from_bmesh(tag + "_peg", pg, coll, mat("Wood_Dark"),
                                smooth=True))


# ══════════════════════════════════════════════════════════════
# tent_b — lean-to half-shelter
# ══════════════════════════════════════════════════════════════
def build_tent_b():
    name = "tent_b"
    coll = asset_collection(name)
    rng = random.Random(31)
    parts = []

    L = 2.55                 # ridge length (along Y)
    RIDGE_H = 1.72
    BACK_X = -0.62           # closed (windward) side
    FRONT_X = 1.18           # open lip, canvas pegged low

    # ── forked stakes + ridge pole ──
    for ey in (-L / 2, L / 2):
        st = bm_cylinder(0.058, 0.042, RIDGE_H + 0.20, segs=7)
        for v in st.verts:                      # natural taper + slight bow
            v.co.x += 0.02 * math.sin(v.co.z * 2.4)
        xform(st, T(BACK_X, ey, (RIDGE_H + 0.20) * 0.5 - 0.05) @
              RY(math.radians(-4)))
        parts.append(obj_from_bmesh(f"{name}_stake{ey:.1f}", st, coll,
                                    mat("Wood_Mid"), smooth=True))
        for fk in (-1, 1):                      # the fork that carries the pole
            fb = bm_cylinder(0.030, 0.018, 0.30, segs=5)
            xform(fb, T(BACK_X, ey + fk * 0.035, RIDGE_H + 0.02) @
                  RX(-fk * math.radians(24)))
            parts.append(obj_from_bmesh(f"{name}_fork{ey:.1f}{fk}", fb, coll,
                                        mat("Wood_Mid"), smooth=True))
    ridge = bm_cylinder(0.052, 0.044, L + 0.62, segs=8)
    for v in ridge.verts:
        v.co.x += 0.022 * math.sin(v.co.z * 1.9)
    xform(ridge, T(BACK_X, 0, RIDGE_H) @ RX(math.pi / 2))
    parts.append(obj_from_bmesh(f"{name}_ridge", ridge, coll, mat("Wood_Dark"),
                                smooth=True))
    for ey in (-L / 2, L / 2):                  # lashings at the forks
        parts += rope_lash(coll, f"{name}_lash{ey:.1f}",
                           (BACK_X, ey, RIDGE_H), 'Y', 0.075, turns=3,
                           r_rope=0.016, spread=0.05)

    # ── the single canted canvas slope ──
    # ONE surface function, shared by the canvas grid and everything stitched
    # onto it — patches computed off an idealised slope float above sagging
    # cloth, which is the classic "sticker floating over the tent" artifact.
    def slope(u, v):
        x = BACK_X + u * (FRONT_X - BACK_X)
        y = (v - 0.5) * (L + 0.30)
        z = RIDGE_H * (1.0 - u) ** 1.18 + 0.05
        # cloth sags between the two stakes and bellies down the slope
        z -= math.sin(v * math.pi) * 0.150 * (0.35 + 0.65 * u)
        z -= math.sin(u * math.pi) * 0.105
        # wrinkle noise, strongest where the cloth is unsupported — a flat
        # sheet is what made round 1 read as a folded bedsheet
        z += (math.sin(u * 17 + v * 11) + math.sin(u * 8 - v * 19)) * \
            0.042 * (0.25 + 0.75 * u)
        z += math.sin(u * 31 + v * 23) * 0.016
        # hem scallops: cloth pulls up between the three lip pegs
        z += math.cos(v * math.pi * 3.0) * 0.055 * (u ** 2.2)
        y += math.sin(u * 13 + v * 5) * 0.055 * u          # hem wander
        return Vector((x, y, max(z, 0.015)))

    bm = bmesh.new()
    nx, ny = 15, 14
    grid = {}
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            grid[(ix, iy)] = bm.verts.new(slope(ix / nx, iy / ny))
    for iy in range(ny):
        for ix in range(nx):
            bm.faces.new((grid[(ix, iy)], grid[(ix + 1, iy)],
                          grid[(ix + 1, iy + 1)], grid[(ix, iy + 1)]))
    o = obj_from_bmesh(f"{name}_canvas", bm, coll, mat("Canvas_Dirty"),
                       smooth=True)
    sm = o.modifiers.new("Sol", 'SOLIDIFY')
    sm.thickness = 0.016
    apply_modifiers(o)
    parts.append(o)

    # ── the patches that say "mended twice" — laid ON the sagging surface ──
    # irregular quads in (u,v), so they never read as a printed white rectangle
    for pi, (pu, pv_, du, dv) in enumerate(((0.36, 0.62, 0.19, 0.13),
                                            (0.63, 0.34, 0.15, 0.10))):
        corners = ((0.0, 0.0), (du, 0.018), (du * 0.88, dv), (-0.022, dv * 0.92))
        bmp = bmesh.new()
        pvs = [bmp.verts.new(slope(pu + cu, pv_ + cv) + Vector((0, 0, 0.012)))
               for cu, cv in corners]
        bmp.faces.new(pvs)
        o = obj_from_bmesh(f"{name}_patch{pi}", bmp, coll, mat("Canvas"),
                           smooth=False)
        sm = o.modifiers.new("Sol", 'SOLIDIFY')
        sm.thickness = 0.010
        apply_modifiers(o)
        parts.append(o)
        for si in range(7):                     # cross-stitches round the rim
            a = si / 6
            cu = corners[0][0] * (1 - a) + corners[1][0] * a
            cv = corners[0][1] * (1 - a) + corners[1][1] * a
            p0 = slope(pu + cu, pv_ + cv) + Vector((0, 0, 0.020))
            stb = bm_box(0.052, 0.013, 0.011)
            xform(stb, T(p0.x, p0.y, p0.z) @ RY(math.radians(-38)))
            parts.append(obj_from_bmesh(f"{name}_st{pi}{si}", stb, coll,
                                        mat("Rope")))

    # ── torn corner: the detail that says "this canvas has a history" ──
    for k in range(5):
        tr = bm_box(0.03 + 0.05 * (k % 2), 0.10, 0.16 + 0.09 * (k % 3))
        p0 = slope(0.95, 0.965 - k * 0.028)
        xform(tr, T(p0.x + 0.02, p0.y, p0.z + 0.05) @
              RY(math.radians(-62)) @ RZ(rng.uniform(-0.3, 0.3)))
        parts.append(obj_from_bmesh(f"{name}_tear{k}", tr, coll,
                                    mat("Canvas_Dirty")))

    # ── driftwood windbreak stacked along the closed side ──
    for k in range(5):
        ln = rng.uniform(1.5, 2.3)
        lg = bm_cylinder(rng.uniform(0.055, 0.095), rng.uniform(0.04, 0.08),
                         ln, segs=7)
        for v in lg.verts:                      # bark ridging
            a = math.atan2(v.co.y, v.co.x)
            f = 1.0 + 0.09 * math.sin(a * 5 + v.co.z * 2.6)
            v.co.x *= f
            v.co.y *= f
        xform(lg, T(BACK_X - 0.30 - (k % 2) * 0.11,
                    rng.uniform(-0.45, 0.45),
                    0.075 + (k // 2) * 0.135) @
              RX(math.pi / 2) @ RZ(rng.uniform(-0.09, 0.09)) @
              RY(rng.uniform(-0.05, 0.05)))
        parts.append(obj_from_bmesh(f"{name}_drift{k}", lg, coll,
                                    mat("Wood_Bleached") if k % 2
                                    else mat("Wood_Mid"), smooth=False))

    # ── guy lines fore and aft, plus the lip pegs ──
    guy_line(coll, f"{name}_guyA", (BACK_X, -L / 2 - 0.28, RIDGE_H + 0.05),
             (BACK_X - 0.30, -L / 2 - 1.05), parts)
    guy_line(coll, f"{name}_guyB", (BACK_X, L / 2 + 0.28, RIDGE_H + 0.05),
             (BACK_X - 0.30, L / 2 + 1.05), parts)
    for py in (-0.85, 0.0, 0.85):
        pg = bm_cylinder(0.030, 0.016, 0.30, segs=5)
        xform(pg, T(FRONT_X + 0.04, py, 0.035) @ RY(math.radians(19)))
        parts.append(obj_from_bmesh(f"{name}_lip{py:.1f}", pg, coll,
                                    mat("Wood_Dark"), smooth=True))

    # ── bedroll shoved under the high side (occupied-shelter read) ──
    br = bm_cylinder(0.19, 0.17, 1.45, segs=10)
    for v in br.verts:
        v.co.x *= 1.0 + 0.10 * math.sin(v.co.z * 4.0)
    xform(br, T(BACK_X + 0.38, -0.10, 0.19) @ RX(math.pi / 2) @ RZ(0.06))
    # Canvas (not Canvas_Dirty) rendered as a bright white barrel parked next
    # to the shelter — a bedroll that has lived on a beach is the dirty one
    parts.append(obj_from_bmesh(f"{name}_bedroll", br, coll,
                                mat("Canvas_Dirty"), smooth=True))
    for k in range(2):
        tie = bm_torus(0.185, 0.020, segs=11, rings=5)
        xform(tie, T(BACK_X + 0.30, -0.10 + (k * 2 - 1) * 0.42, 0.19) @
              RX(math.pi / 2))
        parts.append(obj_from_bmesh(f"{name}_tie{k}", tie, coll, mat("Rope"),
                                    smooth=True))

    return ship_asset(coll, name, spec=tent_spec(),
                      ao=dict(samples=22, floor=0.46), tint_seed=3,
                      render_dir=RENDER_DIR, angles=(-90, -35, 25, 120),
                      elev=17)


# ══════════════════════════════════════════════════════════════
# tent_c — bell tent cut from a salvaged sail
# ══════════════════════════════════════════════════════════════
def build_tent_c():
    name = "tent_c"
    coll = asset_collection(name)
    rng = random.Random(77)
    parts = []

    APEX = 2.02
    R = 1.28                 # hem radius
    DOOR_A = -math.pi / 2    # door faces -Y (approach side)
    DOOR_W = 0.62            # half-width of the door gap, radians

    # ── centre pole poking through the apex + a canted salvage spar ──
    pole = bm_cylinder(0.062, 0.046, APEX + 0.34, segs=8)
    for v in pole.verts:
        v.co.x += 0.018 * math.sin(v.co.z * 2.1)
    xform(pole, T(0, 0.06, (APEX + 0.34) * 0.5))
    parts.append(obj_from_bmesh(f"{name}_pole", pole, coll, mat("Wood_Mid"),
                                smooth=True))
    spar = bm_cylinder(0.046, 0.030, 1.55, segs=7)
    xform(spar, T(0.42, 0.55, 1.10) @ RY(math.radians(31)) @
          RX(math.radians(-14)))
    parts.append(obj_from_bmesh(f"{name}_spar", spar, coll,
                                mat("Wood_Bleached"), smooth=True))
    parts += rope_lash(coll, f"{name}_sparlash", (0.12, 0.22, 1.52), 'Z',
                       0.085, turns=3, r_rope=0.016, spread=0.055)

    # ── the sail wrapped into a cone: scalloped hem, seam ribs, door gap ──
    bm = bmesh.new()
    nA, nV = 30, 9
    grid = {}
    for iv in range(nV + 1):
        t = iv / nV                              # 0 apex -> 1 hem
        for ia in range(nA + 1):
            a = ia / nA * math.tau - math.pi
            # door: the cloth is pulled back, so the panel is cut away there
            rr = R * (t ** 0.86)
            z = APEX * (1.0 - t) ** 1.22
            # cloth sags between the pegged points (scalloped hem)
            scallop = math.sin(a * 8.0) * 0.045 * t * t
            rr *= 1.0 + scallop
            z -= math.sin(t * math.pi) * 0.085 * (0.6 + 0.4 * math.cos(a * 8))
            # sail seams read as shallow ridges running down the cone
            z += math.sin(a * 8.0) * 0.016 * t
            rr += math.sin(a * 16.0 + t * 5.0) * 0.012 * t
            grid[(ia, iv)] = bm.verts.new(
                (math.cos(a) * rr, math.sin(a) * rr + 0.06 * (1 - t),
                 max(z, 0.02)))
    for iv in range(nV):
        for ia in range(nA):
            a0 = (ia / nA) * math.tau - math.pi
            d = abs(((a0 - DOOR_A + math.pi) % math.tau) - math.pi)
            if d < DOOR_W and iv >= 2:           # door opening
                continue
            bm.faces.new((grid[(ia, iv)], grid[(ia + 1, iv)],
                          grid[(ia + 1, iv + 1)], grid[(ia, iv + 1)]))
    o = obj_from_bmesh(f"{name}_canvas", bm, coll, mat("Canvas"), smooth=True)
    sm = o.modifiers.new("Sol", 'SOLIDIFY')
    sm.thickness = 0.018
    apply_modifiers(o)
    parts.append(o)

    # ── rolled-back door flap, lying ALONG the door edge of the cone ──
    # (round 1 stood it bolt upright a full radius out, where it read as a
    # marble column parked next to the tent)
    DR_A = DOOR_A + DOOR_W * 0.92
    DR_LEN = 1.55
    roll = bm_cylinder(0.088, 0.070, DR_LEN, segs=10)
    for v in roll.verts:                        # a roll of cloth, not a pipe
        v.co.x *= 1.0 + 0.20 * math.sin(v.co.z * 5.0)
        v.co.y *= 1.0 + 0.16 * math.cos(v.co.z * 4.2 + 1.0)
    # follow the cone's slope: base at the hem, top toward the apex
    base = Vector((math.cos(DR_A) * R * 0.92, math.sin(DR_A) * R * 0.92 + 0.02,
                   0.06))
    top = Vector((math.cos(DR_A) * R * 0.16, math.sin(DR_A) * R * 0.16 + 0.05,
                  APEX * 0.78))
    d = top - base
    q = d.to_track_quat('Z', 'Y')
    xform(roll, Matrix.Translation((base + top) * 0.5) @ q.to_matrix().to_4x4())
    parts.append(obj_from_bmesh(f"{name}_doorroll", roll, coll,
                                mat("Canvas_Dirty"), smooth=True))
    for k in range(3):
        t = 0.22 + k * 0.30
        p = base.lerp(top, t)
        tie = bm_torus(0.105, 0.017, segs=11, rings=5)
        xform(tie, Matrix.Translation(p) @ q.to_matrix().to_4x4())
        parts.append(obj_from_bmesh(f"{name}_dtie{k}", tie, coll, mat("Rope"),
                                    smooth=True))

    # ── smoke vent: a propped flap high on the lee side ──
    vent = bmesh.new()
    va = DOOR_A + math.pi
    vpts = [(-0.20, 0.0), (0.20, 0.0), (0.15, 0.34), (-0.15, 0.30)]
    vvs = [vent.verts.new((px, 0, pz)) for px, pz in vpts]
    vent.faces.new(vvs)
    xform(vent, T(math.cos(va) * R * 0.40, math.sin(va) * R * 0.40 + 0.04,
                  1.30) @ RZ(va + math.pi / 2) @ RX(math.radians(-34)))
    ov = obj_from_bmesh(f"{name}_vent", vent, coll, mat("Canvas_Dirty"),
                        smooth=False)
    smv = ov.modifiers.new("Sol", 'SOLIDIFY')
    smv.thickness = 0.014
    apply_modifiers(ov)
    parts.append(ov)
    vs = bm_cylinder(0.020, 0.012, 0.50, segs=5)
    xform(vs, T(math.cos(va) * R * 0.52, math.sin(va) * R * 0.52 + 0.04,
                1.42) @ RX(math.radians(58)) @ RZ(va))
    parts.append(obj_from_bmesh(f"{name}_ventprop", vs, coll,
                                mat("Wood_Bleached"), smooth=True))

    # ── hem peg ring + guy lines from the apex ──
    for k in range(9):
        a = k * math.tau / 9 + 0.2
        d = abs(((a - DOOR_A + math.pi) % math.tau) - math.pi)
        if d < DOOR_W * 0.8:
            continue
        pr = R * 1.02
        pg = bm_cylinder(0.030, 0.016, 0.30, segs=5)
        xform(pg, T(math.cos(a) * pr, math.sin(a) * pr + 0.03, 0.035) @
              RY(math.radians(16)) @ RZ(a))
        parts.append(obj_from_bmesh(f"{name}_peg{k}", pg, coll,
                                    mat("Wood_Dark"), smooth=True))
        if k % 3 == 0:                          # every third gets a guy line
            guy_line(coll, f"{name}_guy{k}", (0, 0.06, APEX + 0.10),
                     (math.cos(a) * (R + 0.34), math.sin(a) * (R + 0.34)),
                     parts, sag=0.07)

    # ── kit stowed against the lee wall ──
    kg = bm_cylinder(0.185, 0.175, 0.40, segs=11)
    for v in kg.verts:
        v.co.x *= 1.0 + 0.13 * (1 - (v.co.z / 0.2) ** 2)
        v.co.y *= 1.0 + 0.13 * (1 - (v.co.z / 0.2) ** 2)
    xform(kg, T(math.cos(va) * (R + 0.24), math.sin(va) * (R + 0.24), 0.20))
    parts.append(obj_from_bmesh(f"{name}_keg", kg, coll, mat("Wood_Dark"),
                                smooth=False))
    for hz in (0.06, 0.34):
        hp = bm_cylinder(0.205, 0.205, 0.035, segs=13, cap=False)
        xform(hp, T(math.cos(va) * (R + 0.24), math.sin(va) * (R + 0.24), hz))
        parts.append(obj_from_bmesh(f"{name}_keghoop{hz:.2f}", hp, coll,
                                    mat("Metal_Band"), smooth=True))

    return ship_asset(coll, name, spec=tent_spec(),
                      ao=dict(samples=22, floor=0.46), tint_seed=7,
                      render_dir=RENDER_DIR, angles=(-90, -35, 25, 120),
                      elev=17)


def stow(coll_name):
    for o in bpy.data.collections[coll_name].objects:
        o.hide_render = True


build_tent_b()
stow("tent_b")
build_tent_c()
print("tent variants built")
