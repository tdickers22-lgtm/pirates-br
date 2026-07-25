# Shared story-prop builders — used BOTH as standalone GLBs
# (build_props_story.py -> rowboat.glb, signal_pyre.glb) and dropped into the
# hero scenes that the story bible ties them to (mermaid_shrine, crow_roost).
# Load AFTER _helpers.py, _ao.py and _detail.py:
#   exec(open(os.path.join(HERE, '_story_props.py')).read())
#
# Every builder takes (coll, name, M, parts, ...) where M is a placement matrix
# in the target scene's space and appends its meshes to `parts`, so a scene can
# seat one wherever it likes without a second export path.
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix


# ══════════════════════════════════════════════════════════════
# ROWBOAT — clinker-built ship's tender, weathered and beached.
#   Length 2.60, beam 1.14, sheer height 0.62 in local space.
#   Bow toward -Y (project convention), keel on z=0, origin amidships.
#   Built as a lapstrake shell (overlapping planks, not one smooth tub) with
#   sawn frames, thwarts, a capping rail, one sprung plank and a stove-in
#   garboard — the silhouette interest lives in the laps and the rail line.
# ══════════════════════════════════════════════════════════════
BOAT_L = 2.60
BOAT_B = 0.57            # half-beam at the widest station
BOAT_H = 0.62            # sheer above the keel amidships


def _boat_beam(t):
    """Half-breadth at station t in [0,1] (0 = bow, 1 = stern)."""
    # fine entry at the bow, fuller run aft, transom stern
    return BOAT_B * (math.sin(math.pi * min(1.0, t * 1.06)) ** 0.62) * \
        (0.62 + 0.44 * t) + 0.035


def _boat_sheer(t):
    """Sheer (gunwale) height at station t — rises toward both ends."""
    return BOAT_H + 0.20 * (2.0 * t - 1.0) ** 2


def _boat_pt(t, v, side):
    """Point on the hull surface. v in [0,1] from keel rabbet to sheer."""
    y = (t - 0.5) * BOAT_L
    half = _boat_beam(t)
    sh = _boat_sheer(t)
    # rounded bilge: breadth fills in fast, height climbs slower
    b = half * (0.10 + 0.90 * v ** 0.58)
    z = sh * (v ** 1.45)
    return Vector((side * b, -y, z))


def rowboat(coll, name, M, parts, rng=None, offerings=True, oars=True,
            sprung_plank=True, strakes=6, stations=13):
    """Weathered clinker rowboat. M places it; returns the parts appended."""
    r = rng or random.Random(91)
    WD = mat("Wood_Dark")
    WM = mat("Wood_Mid")
    WL = mat("Wood_Light")
    WB = mat("Wood_Bleached")
    out = []

    def add(o):
        parts.append(o)
        out.append(o)
        return o

    # ── hull shell: one watertight skin, then lapstrake ribbons on top ──
    shell = bmesh.new()
    grid = {}
    for si, side in enumerate((-1, 1)):
        for i in range(stations + 1):
            t = i / stations
            for j in range(strakes + 1):
                v = j / strakes
                p = _boat_pt(t, v, side)
                # tired boat: the sheer sags amidships, planks work a little
                p.z -= 0.035 * math.sin(math.pi * t) * v
                p.x *= 1.0 + 0.02 * math.sin(t * 9.0 + j * 1.7)
                grid[(si, i, j)] = shell.verts.new(p)
    for si, side in enumerate((-1, 1)):
        for i in range(stations):
            for j in range(strakes):
                a = grid[(si, i, j)]
                b = grid[(si, i + 1, j)]
                c = grid[(si, i + 1, j + 1)]
                d = grid[(si, i, j + 1)]
                shell.faces.new((a, b, c, d) if side > 0 else (d, c, b, a))
    # bottom: close the two garboard edges across the keel line
    for i in range(stations):
        a = grid[(0, i, 0)]
        b = grid[(0, i + 1, 0)]
        c = grid[(1, i + 1, 0)]
        d = grid[(1, i, 0)]
        shell.faces.new((a, b, c, d))
    bmesh.ops.recalc_face_normals(shell, faces=shell.faces)
    add(obj_from_bmesh(f"{name}_hull", shell, coll, WM, smooth=False))

    # ── lapstrake ribbons: the overlapping plank edges, proud of the shell ──
    for j in range(1, strakes):
        v = j / strakes
        lap = bmesh.new()
        for side in (-1, 1):
            ring = []
            for i in range(stations + 1):
                t = i / stations
                p = _boat_pt(t, v, side)
                p.z -= 0.035 * math.sin(math.pi * t) * v
                n = Vector((side, 0, 0.28)).normalized()
                ring.append((p, n))
            vs_in, vs_out = [], []
            for p, n in ring:
                vs_in.append(lap.verts.new(p + n * 0.008))
                vs_out.append(lap.verts.new(p + n * 0.030 + Vector((0, 0, -0.026))))
            for i in range(stations):
                if side > 0:
                    lap.faces.new((vs_in[i], vs_in[i + 1], vs_out[i + 1], vs_out[i]))
                else:
                    lap.faces.new((vs_out[i], vs_out[i + 1], vs_in[i + 1], vs_in[i]))
        bmesh.ops.recalc_face_normals(lap, faces=lap.faces)
        add(obj_from_bmesh(f"{name}_lap{j}", lap, coll,
                           (WL, WM, WB)[j % 3], smooth=False))

    # ── stem post (bow) and transom (stern) ──
    stem = bm_box(0.075, 0.10, _boat_sheer(0.0) + 0.16)
    for v_ in stem.verts:                       # raked, tapered stem head
        if v_.co.z > 0:
            v_.co.y -= 0.085
            v_.co.x *= 0.72
    xform(stem, Matrix.Translation((0, BOAT_L * 0.5 - 0.02,
                                    (_boat_sheer(0.0) + 0.16) * 0.5 - 0.04)))
    add(obj_from_bmesh(f"{name}_stem", bm_bevel(stem, 0.012, 1), coll, WD))
    trans = bmesh.new()
    tw, th = _boat_beam(1.0), _boat_sheer(1.0)
    tv = [trans.verts.new(p) for p in (
        (-tw * 0.30, 0, 0.02), (tw * 0.30, 0, 0.02),
        (tw * 1.00, 0.10, th), (-tw * 1.00, 0.10, th))]
    trans.faces.new(tv)
    xform(trans, Matrix.Translation((0, -BOAT_L * 0.5 + 0.015, 0)))
    o = obj_from_bmesh(f"{name}_transom", trans, coll, WD, smooth=False)
    sm = o.modifiers.new("Sol", 'SOLIDIFY')
    sm.thickness = 0.05
    apply_modifiers(o)
    add(o)

    # ── capping rail along the sheer, both sides ──
    for side in (-1, 1):
        pts = []
        for i in range(stations + 1):
            t = i / stations
            p = _boat_pt(t, 1.0, side)
            p.z -= 0.035 * math.sin(math.pi * t)
            pts.append(p)
        rail = bmesh.new()
        lo, hi = [], []
        for i, p in enumerate(pts):
            n = Vector((side, 0, 0)).normalized()
            lo.append(rail.verts.new(p + n * -0.022))
            hi.append(rail.verts.new(p + n * 0.034))
        for i in range(stations):
            rail.faces.new((lo[i], lo[i + 1], hi[i + 1], hi[i]))
        o = obj_from_bmesh(f"{name}_rail{side}", rail, coll, WD, smooth=False)
        sm = o.modifiers.new("Sol", 'SOLIDIFY')
        sm.thickness = 0.045
        apply_modifiers(o)
        add(o)

    # ── sawn frames (ribs) standing inside the shell ──
    for i in (2, 4, 6, 8, 10):
        t = i / stations
        for side in (-1, 1):
            fr = bmesh.new()
            inner, outer = [], []
            for j in range(strakes + 1):
                v = j / strakes
                p = _boat_pt(t, v, side)
                p.z -= 0.035 * math.sin(math.pi * t) * v
                n = Vector((-side, 0, 0.2)).normalized()
                inner.append(fr.verts.new(p + n * 0.036))
                outer.append(fr.verts.new(p - n * 0.004))
            for j in range(strakes):
                fr.faces.new((inner[j], inner[j + 1], outer[j + 1], outer[j]))
            o = obj_from_bmesh(f"{name}_frame{i}{side}", fr, coll, WD,
                               smooth=False)
            sm = o.modifiers.new("Sol", 'SOLIDIFY')
            sm.thickness = 0.032
            apply_modifiers(o)
            add(o)

    # ── thwarts (rowing benches) + knees ──
    for ti, t in enumerate((0.28, 0.52, 0.76)):
        w = _boat_beam(t) * 2.02
        z = _boat_sheer(t) - 0.035 * math.sin(math.pi * t) - 0.11
        th_ = bm_bevel(bm_box(w, 0.20, 0.045), 0.010, 1)
        xform(th_, Matrix.Translation((0, -(t - 0.5) * BOAT_L, z)) @
              Matrix.Rotation(r.uniform(-0.03, 0.03), 4, 'Y'))
        add(obj_from_bmesh(f"{name}_thwart{ti}", th_, coll,
                           WL if ti % 2 else WB))
        for side in (-1, 1):                    # knee brackets
            kn = bm_box(0.035, 0.16, 0.14)
            xform(kn, Matrix.Translation((side * (w * 0.5 - 0.04),
                                          -(t - 0.5) * BOAT_L, z - 0.09)))
            add(obj_from_bmesh(f"{name}_knee{ti}{side}", kn, coll, WD))

    # ── the wear that sells "abandoned": one sprung plank, one stove garboard ──
    if sprung_plank:
        sp = bm_box(0.030, 0.86, 0.075)
        for v_ in sp.verts:                     # bows away from the frames
            v_.co.x += 0.075 * math.cos(v_.co.y * 3.2)
        xform(sp, Matrix.Translation((_boat_beam(0.62) * 0.99, -0.24, 0.40)) @
              Matrix.Rotation(math.radians(11), 4, 'Y'))
        add(obj_from_bmesh(f"{name}_sprung", sp, coll, WB))
        for si2 in range(3):                    # the nails that let go
            nb = bm_cylinder(0.010, 0.006, 0.06, segs=5)
            xform(nb, Matrix.Translation((_boat_beam(0.62) * 1.06,
                                          -0.55 + si2 * 0.30, 0.40)) @
                  Matrix.Rotation(math.pi / 2, 4, 'Y'))
            add(obj_from_bmesh(f"{name}_nail{si2}", nb, coll, mat("Rust"),
                               smooth=True))

    # ── painter rope coiled round the stem + a mooring ring ──
    ring = bm_torus(0.055, 0.013, segs=12, rings=6)
    xform(ring, Matrix.Translation((0, BOAT_L * 0.5 + 0.02,
                                    _boat_sheer(0.0) - 0.04)) @
          Matrix.Rotation(math.pi / 2, 4, 'X'))
    add(obj_from_bmesh(f"{name}_ring", ring, coll, mat("Rust"), smooth=True))
    for ci in range(4):
        co = bm_torus(0.125 - ci * 0.012, 0.021, segs=13, rings=6)
        xform(co, Matrix.Translation((0.16, BOAT_L * 0.32,
                                      0.10 + ci * 0.036)) @
              Matrix.Rotation(ci * 0.6, 4, 'Z') @
              Matrix.Rotation(0.07 * ci, 4, 'X'))
        add(obj_from_bmesh(f"{name}_painter{ci}", co, coll, mat("Rope"),
                           smooth=True))

    # ── oars: one shipped along the thwarts, one snapped over the rail ──
    if oars:
        def oar(tag, OM, length=1.55, broken=False):
            ln = length * (0.62 if broken else 1.0)
            sh = bm_cylinder(0.030, 0.022, ln, segs=8)
            xform(sh, OM @ Matrix.Translation((0, 0, ln * 0.5)))
            add(obj_from_bmesh(f"{name}_{tag}_shaft", sh, coll, WL, smooth=True))
            gr = bm_cylinder(0.034, 0.034, 0.13, segs=8)
            xform(gr, OM @ Matrix.Translation((0, 0, 0.07)))
            add(obj_from_bmesh(f"{name}_{tag}_grip", gr, coll, WD, smooth=True))
            if broken:
                # splintered stub instead of a blade
                for k in range(4):
                    sp2 = bm_cylinder(0.011, 0.002, 0.11, segs=4)
                    xform(sp2, OM @ Matrix.Translation(
                        (0.012 * math.cos(k * 1.6), 0.012 * math.sin(k * 1.6),
                         ln + 0.05)) @ Matrix.Rotation(0.2 * k, 4, 'X'))
                    add(obj_from_bmesh(f"{name}_{tag}_spl{k}", sp2, coll, WB,
                                       smooth=True))
                return
            bl = bmesh.new()
            prof = [(0.022, 0.0), (0.075, 0.16), (0.082, 0.44), (0.048, 0.62),
                    (0.0, 0.68), (-0.048, 0.62), (-0.082, 0.44),
                    (-0.075, 0.16), (-0.022, 0.0)]
            vs = [bl.verts.new((px, 0, pz)) for px, pz in prof]
            bl.faces.new(vs)
            for v_ in bl.verts:                 # dished blade
                v_.co.y = 0.026 * math.sin(v_.co.z * 4.6)
            xform(bl, OM @ Matrix.Translation((0, 0, ln - 0.02)))
            o2 = obj_from_bmesh(f"{name}_{tag}_blade", bl, coll, WB,
                                smooth=False)
            sm2 = o2.modifiers.new("Sol", 'SOLIDIFY')
            sm2.thickness = 0.016
            apply_modifiers(o2)
            add(o2)
        # both oars are SHIPPED (stowed fore-and-aft inside the boat) — an oar
        # started at the bow runs 1.5 m out past the stem and wrecks the bbox
        oar("oarA", Matrix.Translation((-0.22, -0.98, 0.28)) @
            Matrix.Rotation(math.radians(-93), 4, 'X') @
            Matrix.Rotation(math.radians(6), 4, 'Y'))
        oar("oarB", Matrix.Translation((0.30, -0.62, 0.44)) @
            Matrix.Rotation(math.radians(-104), 4, 'X') @
            Matrix.Rotation(math.radians(-22), 4, 'Y'), broken=True)

    # ── offerings heaped in the bilge (the tribute beat) ──
    if offerings:
        for k in range(9):                      # shells
            a = r.uniform(0, math.tau)
            sx2 = r.uniform(-0.24, 0.24)
            sy2 = r.uniform(-0.75, 0.55)
            s = r.uniform(0.055, 0.105)
            sh2 = bm_cylinder(s, s * 0.55, s * 0.42, segs=9)
            for v_ in sh2.verts:                # ribbed fan
                v_.co.z += s * 0.22 * abs(math.sin(
                    math.atan2(v_.co.y, v_.co.x) * 5))
            xform(sh2, Matrix.Translation((sx2, sy2, 0.10)) @
                  Matrix.Rotation(a, 4, 'Z') @
                  Matrix.Rotation(r.uniform(-0.4, 0.4), 4, 'Y'))
            add(obj_from_bmesh(f"{name}_shell{k}", sh2, coll,
                               mat("Shell_Pearl"), smooth=True))
        for k in range(12):                     # coins
            c = bm_cylinder(0.032, 0.032, 0.009, segs=9)
            xform(c, Matrix.Translation((r.uniform(-0.22, 0.22),
                                         r.uniform(-0.85, 0.70),
                                         0.085 + r.uniform(0, 0.05))) @
                  Matrix.Rotation(r.uniform(0, 3), 4, 'Z') @
                  Matrix.Rotation(r.uniform(-0.5, 0.5), 4, 'X'))
            add(obj_from_bmesh(f"{name}_coin{k}", c, coll, mat("Gold"),
                               smooth=True))
        for k in range(4):                      # coral sprigs laid as flowers
            br = bm_cylinder(0.020, 0.008, r.uniform(0.16, 0.26), segs=5)
            xform(br, Matrix.Translation((r.uniform(-0.20, 0.20),
                                          r.uniform(-0.60, 0.60), 0.13)) @
                  Matrix.Rotation(r.uniform(1.1, 1.8), 4, 'X') @
                  Matrix.Rotation(r.uniform(0, 3), 4, 'Z'))
            add(obj_from_bmesh(f"{name}_sprig{k}", br, coll,
                               mat("Coral_Pink" if k % 2 else "Coral"),
                               smooth=True))

    for o in out:
        o.matrix_world = M @ o.matrix_world
    return out


# ══════════════════════════════════════════════════════════════
# SIGNAL PYRE — unlit stacked-timber beacon with a tar barrel.
#   Crib-stacked logs (log-cabin courses), brush kindling stuffed in the gaps,
#   a staved tar barrel with iron hoops open on top, tar runs down the crib,
#   a pitch bucket and a spare log leaning. Footprint ~2.0 x 2.0, height ~2.1.
#   Origin at ground centre; the open "light it here" face is toward -Y.
# ══════════════════════════════════════════════════════════════
def signal_pyre(coll, name, M, parts, rng=None, courses=5, crib=1.55):
    r = rng or random.Random(404)
    WD = mat("Wood_Dark")
    WM = mat("Wood_Mid")
    WB = mat("Wood_Bleached")
    out = []

    def add(o):
        parts.append(o)
        out.append(o)
        return o

    def log(tag, p, axis, length, rad, material, sag=0.0):
        """Bark-textured log: octagonal section, taper, knots, slight bow."""
        bm = bm_cylinder(rad, rad * r.uniform(0.86, 0.97), length, segs=9)
        for v in bm.verts:
            a = math.atan2(v.co.y, v.co.x)
            f = 1.0 + 0.075 * math.sin(a * 5.0 + v.co.z * 2.2)   # bark ridges
            v.co.x *= f
            v.co.y *= f
            v.co.x += sag * (1.0 - (v.co.z / (length * 0.5)) ** 2)
        rot = (Matrix.Rotation(math.pi / 2, 4, 'Y') if axis == 'X'
               else Matrix.Rotation(math.pi / 2, 4, 'X') if axis == 'Y'
               else Matrix.Identity(4))
        xform(bm, Matrix.Translation(p) @ rot)
        o = add(obj_from_bmesh(tag, bm, coll, material, smooth=False))
        # a knot stub or two — silhouette break on the log run
        if r.random() < 0.55:
            kt = bm_cylinder(rad * 0.28, rad * 0.16, rad * 0.9, segs=5)
            ka = r.uniform(0, math.tau)
            off = r.uniform(-0.35, 0.35) * length
            local = (Vector((0, 0, off)) + Vector((math.cos(ka), math.sin(ka), 0))
                     * rad * 0.9)
            xform(kt, Matrix.Translation(p) @ rot @ Matrix.Translation(local) @
                  Matrix.Rotation(ka, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
            add(obj_from_bmesh(tag + "_knot", kt, coll, material, smooth=True))
        return o

    # ── crib: alternating courses of 3 logs, tapering inward as it rises ──
    z = 0.0
    course_z = []
    for c in range(courses):
        t = c / max(1, courses - 1)
        rad = 0.105 - 0.018 * t
        span = crib * (1.0 - 0.16 * t)
        z += rad
        course_z.append(z)
        axis = 'X' if c % 2 == 0 else 'Y'
        n = 3
        for k in range(n):
            off = (k - (n - 1) / 2) * (span * 0.34)
            jitter = r.uniform(-0.035, 0.035)
            p = (Vector((0, off + jitter, z)) if axis == 'X'
                 else Vector((off + jitter, 0, z)))
            log(f"{name}_crib{c}_{k}", p, axis,
                span * r.uniform(0.94, 1.06), rad,
                (WM, WD, WB)[(c + k) % 3], sag=r.uniform(-0.01, 0.01))
        z += rad * 1.72

    top_z = z

    # ── kindling: brush and split billets rammed into the crib voids ──
    for k in range(26):
        a = r.uniform(0, math.tau)
        rr = r.uniform(0.10, crib * 0.46)
        h = r.uniform(0.16, 0.52)
        st = bm_cylinder(r.uniform(0.010, 0.026), 0.006, h, segs=4)
        xform(st, Matrix.Translation((math.cos(a) * rr, math.sin(a) * rr,
                                      r.uniform(0.10, top_z * 0.92))) @
              Matrix.Rotation(r.uniform(0, math.tau), 4, 'Z') @
              Matrix.Rotation(r.uniform(0.5, 2.4), 4, 'X'))
        add(obj_from_bmesh(f"{name}_kindle{k}", st, coll,
                           WB if k % 3 else mat("Leaf_Dry"), smooth=True))

    # ── tar barrel on the crown: staves, iron hoops, lid off, tar surface ──
    BZ = top_z + 0.34
    n_st = 13
    BR = 0.315
    for k in range(n_st):
        a = k * math.tau / n_st
        # staves must ABUT (circumference / count) or the barrel reads as a
        # birdcage; the bulge is RADIAL (local Y), not tangential.
        st = bm_box(math.tau * BR / n_st * 1.06, 0.065, 0.66)
        for v in st.verts:
            # local +Y points radially INWARD after the RZ below, so subtract
            v.co.y -= 0.055 * (1.0 - (v.co.z / 0.33) ** 2)
            v.co.x *= 1.0 + 0.16 * (1.0 - (v.co.z / 0.33) ** 2)
        xform(st, Matrix.Translation((math.cos(a) * BR, math.sin(a) * BR, BZ)) @
              Matrix.Rotation(a + math.pi / 2, 4, 'Z'))
        add(obj_from_bmesh(f"{name}_stave{k}", st, coll,
                           WD if k % 4 else WM))
    for hz, hr in ((BZ - 0.28, 0.368), (BZ - 0.02, 0.418), (BZ + 0.28, 0.368)):
        hp = bm_cylinder(hr, hr, 0.058, segs=18, cap=False)
        xform(hp, Matrix.Translation((0, 0, hz)))
        add(obj_from_bmesh(f"{name}_hoop{hz:.2f}", hp, coll, mat("Metal_Band"),
                           smooth=True))
    # the tar itself must fill the mouth just under the rim, or the barrel
    # reads as an empty bucket from every approach
    tar = bm_cylinder(0.352, 0.352, 0.05, segs=18)
    for v in tar.verts:                          # congealed, uneven surface
        if v.co.z > 0:
            v.co.z += 0.012 * math.sin(math.atan2(v.co.y, v.co.x) * 3.0 +
                                       math.hypot(v.co.x, v.co.y) * 9.0)
    xform(tar, Matrix.Translation((0, 0, BZ + 0.285)))
    add(obj_from_bmesh(f"{name}_tar", tar, coll, mat("Tar_Black"), smooth=True))
    # tar runs congealed down the staves and onto the crib
    for k in range(6):
        a = r.uniform(0, math.tau)
        rl = r.uniform(0.30, 0.72)
        run = bm_cylinder(0.030, 0.016, rl, segs=5)
        for v in run.verts:
            v.co.x += 0.03 * math.sin(v.co.z * 8.0)
        xform(run, Matrix.Translation((math.cos(a) * 0.372, math.sin(a) * 0.372,
                                       BZ + 0.24 - rl * 0.5)))
        add(obj_from_bmesh(f"{name}_run{k}", run, coll, mat("Tar_Black"),
                           smooth=True))
    # discarded barrel lid propped against the crib — the pivot must lift it by
    # r*sin(tilt) or the disc buries itself 0.29 m underground
    LID_R, LID_TILT = 0.36, math.radians(52)
    lid = bm_cylinder(LID_R, 0.34, 0.055, segs=15)
    xform(lid, Matrix.Translation((crib * 0.62, -crib * 0.30,
                                   LID_R * math.sin(LID_TILT) + 0.02)) @
          Matrix.Rotation(0.9, 4, 'Z') @ Matrix.Rotation(LID_TILT, 4, 'X'))
    add(obj_from_bmesh(f"{name}_lid", lid, coll, WD, smooth=False))
    # brush bundles rammed under the crown — the "light me" read
    for k, (bx, by, ba) in enumerate(((-0.52, 0.30, 0.5), (0.46, -0.40, 2.2),
                                      (-0.10, 0.58, 3.9))):
        for s in range(7):
            tw = bm_cylinder(0.014, 0.005, r.uniform(0.34, 0.52), segs=4)
            xform(tw, Matrix.Translation(
                (bx + r.uniform(-0.07, 0.07), by + r.uniform(-0.07, 0.07),
                 top_z * 0.62 + r.uniform(-0.10, 0.12))) @
                Matrix.Rotation(ba + r.uniform(-0.5, 0.5), 4, 'Z') @
                Matrix.Rotation(r.uniform(1.0, 2.1), 4, 'X'))
            add(obj_from_bmesh(f"{name}_brush{k}_{s}", tw, coll,
                               mat("Leaf_Dry"), smooth=True))
        bnd = bm_torus(0.085, 0.014, segs=10, rings=5)
        xform(bnd, Matrix.Translation((bx, by, top_z * 0.62)) @
              Matrix.Rotation(math.pi / 2, 4, 'X') @ Matrix.Rotation(ba, 4, 'Z'))
        add(obj_from_bmesh(f"{name}_bband{k}", bnd, coll, mat("Rope"),
                           smooth=True))

    # ── pitch bucket + spare log leaning on the crib (approach dressing) ──
    bk = bm_cylinder(0.135, 0.115, 0.26, segs=11)
    xform(bk, Matrix.Translation((-crib * 0.66, -crib * 0.42, 0.13)))
    add(obj_from_bmesh(f"{name}_bucket", bk, coll, WD, smooth=False))
    bkt = bm_cylinder(0.12, 0.12, 0.04, segs=11)
    xform(bkt, Matrix.Translation((-crib * 0.66, -crib * 0.42, 0.25)))
    add(obj_from_bmesh(f"{name}_pitch", bkt, coll, mat("Tar_Black"),
                       smooth=True))
    bh = bm_torus(0.13, 0.011, segs=12, rings=5)
    xform(bh, Matrix.Translation((-crib * 0.66, -crib * 0.42, 0.30)) @
          Matrix.Rotation(math.pi / 2, 4, 'Y'))
    add(obj_from_bmesh(f"{name}_bail", bh, coll, mat("Metal_Band"), smooth=True))
    # spare log leaning against the crib — rotate about ITS OWN centre, or the
    # world-origin rotation drives the far end 0.7 m underground
    sc = Vector((crib * 0.52, crib * 0.30, 0.42))
    spare = log(f"{name}_spare", sc, 'Z', 1.30, 0.10, WM)
    spare.matrix_world = (Matrix.Translation(sc) @
                          Matrix.Rotation(math.radians(38), 4, 'Y') @
                          Matrix.Translation(-sc) @ spare.matrix_world)

    # ── lashings binding the crown course logs (wrapped ON a log, not air) ──
    crown_axis = 'X' if (courses - 1) % 2 == 0 else 'Y'
    crown_z = course_z[-1]
    for k, off in enumerate((-0.34, 0.34)):
        cx, cy = ((off, 0.0) if crown_axis == 'Y' else (0.0, off))
        lash = bm_torus(0.125, 0.024, segs=12, rings=6)
        rot = (Matrix.Rotation(math.pi / 2, 4, 'Y') if crown_axis == 'X'
               else Matrix.Rotation(math.pi / 2, 4, 'X'))
        xform(lash, Matrix.Translation((cx, cy, crown_z)) @ rot)
        add(obj_from_bmesh(f"{name}_lash{k}", lash, coll, mat("Rope"),
                           smooth=True))

    for o in out:
        o.matrix_world = M @ o.matrix_world
    return out


print("story prop builders loaded")
