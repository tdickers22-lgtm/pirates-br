"""Pirate wardrobe II (b3.2d, characters-01/03): deforming body garments, scripted on each normalised body.

  coat_frock      captain's frock coat: open front, turned-back lapels and big cuffs in the crew facing colour,
                  standing collar, gold buttons (fronts + cuffs), a knee-length skirt with a back vent and pleats
  coat_jacket     deckhand's short jacket to the hip: open front, narrow cuffs, collar, a double row of buttons
  vest_waistcoat  ochre waistcoat: V neck, armholes, six buttons down the front, hem at the hip
  sash            crew-colour waist sash with gathered folds, a knot at the left hip and two hanging tails
  belt            leather belt with a gold buckle, worn over the sash
  breeches_knee   brown wool knee breeches with a buttoned knee band
  breeches_slops  wide canvas sailor slops to mid calf with a rolled hem
  boots_tall      leather boots with a flared bucket top above the knee
  boots_shoes     low leather shoes with a gold buckle on the instep

How: every fitted garment is a SHELL of the body's own faces (the ones the garment covers), pushed out along
the body normals by the garment's layer offset, relaxed, then held off the skin by a nearest-surface clearance
pass, so each body type (the stout's gut included, handoff b3.2a) gets its own fit. Openings are cut on the
body topology and their boundaries snapped to clean lines; cuffs, lapels, collars, knee bands and bucket tops
are extrusions of those boundaries. The skirt, sash and belt are lofts around the convex envelope (support
function) of the body's slab at each height, so they drape over both legs instead of following each one.
Layers (distance from the skin, m): breeches 0.009 (slops 0.012 -> 0.037 at the hem) < waistcoat 0.013 <
sash hull+0.016 < belt hull+0.023 < jacket 0.019 / frock coat 0.024 on the trunk (0.012-0.013 on the arms) <
skirt hull+0.026 (flaring). Boots sit over the breeches (0.016 on the leg).

Weights: Blender Data Transfer (nearest face, interpolated) from the body, normalised, 4 influences; the skirt
and the sash tails get authored weights instead (pelvis fading into the thigh on their side, so a stride does
not tear the skirt between the legs). Solidify gives every cloth garment a real thickness whose inner shell is
the crew-colour lining (material slot 1); lapels and the frock cuffs are the crew facing. Crew mask = the
wardrobe material "crew" (extras.crewTint), shared with the bandana and the hat braids (b3.2c).
Every garment is one node, parented to the body's armature, hidden in renders and pirateDefault false.
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import _pirate_wardrobe as W

UP = Vector((0, 0, 1))
HAND = ("hand", "thumb", "index", "middle", "ring", "pinky")
NON_DEFORM = ("eye_", "lid_")
CUR_BODY = []   # the Body being dressed (solidify reads its skin to thin the lining where the shell is tight)
SLOTS = ("shirt_linen", "coat_frock", "coat_jacket", "vest_waistcoat", "sash", "belt", "breeches_knee", "breeches_slops",
         "boots_tall", "boots_shoes")


def ctx(o):
    return bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o])


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


class Body:
    def __init__(self, arm, body):
        self.arm, self.obj = arm, body
        dg = bpy.context.evaluated_depsgraph_get()
        e = body.evaluated_get(dg)
        me = e.to_mesh()
        mw = e.matrix_world
        nm = mw.to_3x3().inverted().transposed()
        self.P = [mw @ v.co for v in me.vertices]
        self.N = [(nm @ v.normal).normalized() for v in me.vertices]
        self.F = [list(p.vertices) for p in me.polygons]
        e.to_mesh_clear()
        names = {g.index: g.name for g in body.vertex_groups}
        self.Wt = [{names[g.group]: g.weight for g in v.groups if g.weight > 0} for v in body.data.vertices]
        self.bvh = BVHTree.FromPolygons(self.P, self.F)
        self._part = {}
        self.A = np.array([tuple(p) for p in self.P])
        b = self.b
        self.hip = (b("thigh_l").z + b("thigh_r").z) / 2
        self.knee = (b("calf_l").z + b("calf_r").z) / 2
        self.ankle = (b("foot_l").z + b("foot_r").z) / 2
        self.shoulder = b("upperarm_l").z
        self.neck = b("neck_01").z
        self.H = float(self.A[:, 2].max() - self.A[:, 2].min())
        self.waist = self.hip + 0.11 * self.H / 1.76
        self.cx, self.cy = b("pelvis").x, (b("pelvis").y + b("spine_03").y) / 2
        self.left = "l" if b("thigh_l").x > self.cx else "r"     # the side at +X
        self.trunk = np.array([self.w(i, "upperarm", "lowerarm", *HAND) < 0.3 for i in range(len(self.P))])

    def b(self, n, tail=False):
        bo = self.arm.data.bones[n]
        return self.arm.matrix_world @ (bo.tail_local if tail else bo.head_local)

    def part(self, i):   # rigid region a skin vertex belongs to: an arm, a leg, or the trunk
        if i not in self._part:
            a, l = self.w(i, "upperarm", "lowerarm", *HAND), self.w(i, "thigh", "calf", "foot", "ball")
            self._part[i] = ("arm" if a > 0.5 else "leg" if l > 0.5 else "trunk") + (
                self.side(self.P[i]) if max(a, l) > 0.5 else "")
        return self._part[i]

    def w(self, i, *pref):
        return sum(v for k, v in self.Wt[i].items() if k.startswith(pref))

    def side(self, p):
        return self.left if p.x > self.cx else ("r" if self.left == "l" else "l")

    def forearm(self, s):
        e, h = self.b(f"lowerarm_{s}"), self.b(f"hand_{s}")
        return e, h

    def frac(self, p, s):   # 0 at the elbow, 1 at the wrist
        e, h = self.forearm(s)
        d = h - e
        return (p - e).dot(d) / d.length_squared

    def arm_radial(self, p, s):
        e, h = self.forearm(s)
        a = (h - e).normalized()
        r = (p - e) - (p - e).dot(a) * a
        return r.normalized(), a

    def leg_radial(self, p, s):
        hip, knee, ank = self.b(f"thigh_{s}"), self.b(f"calf_{s}"), self.b(f"foot_{s}")
        a0, a1 = (hip, knee) if p.z > knee.z else (knee, ank)
        a = (a1 - a0).normalized()
        r = (p - a0) - (p - a0).dot(a) * a
        return r.normalized()

    def support(self, z, phi, half=0.025):
        """convex-envelope radius of the trunk+legs slab at height z in direction phi (0 = +X, 90 = back)."""
        sel = self.A[self.trunk & (np.abs(self.A[:, 2] - z) < half)]
        if not len(sel):
            return 0.12
        d = sel[:, :2] - np.array([self.cx, self.cy])
        return float((d @ np.array([math.cos(phi), math.sin(phi)])).max())

    def ring_pt(self, z, phi, r):
        return Vector((self.cx + r * math.cos(phi), self.cy + r * math.sin(phi), z))


# ── generic builders ───────────────────────────────────────────────────────────────────────────
def shell(B, keep, off, smooth=2, pin=None):
    bm = bmesh.new()
    src = bm.verts.layers.int.new("src")
    vmap = {}
    eff = {}

    def off_eff(i):   # where the body faces itself (inner thighs, a stout armpit) the two shells share the gap
        if i not in eff:
            hit_, _, _, d = B.bvh.ray_cast(B.P[i] + B.N[i] * 0.002, B.N[i], 0.12)
            eff[i] = off(i) if hit_ is None else min(off(i), 0.45 * (d + 0.002))
        return eff[i]
    # weld the body's split vertices first (UV seams: the glTF body is split along them). Without it a seam is an
    # open boundary in the shell, and the boundary snap (hem/top) dragged the inner-leg seam of the breeches from
    # the knee to the waist: 0.58 m sliver faces through both thighs (the b3.2d residual inner-thigh pokes)
    canon, first = {}, {}
    for i, p in enumerate(B.P):
        canon[i] = first.setdefault((round(p.x, 5), round(p.y, 5), round(p.z, 5)), i)
    for i, p in enumerate(B.P):
        if canon[i] == i and keep(i):
            v = bm.verts.new(p + B.N[i] * off_eff(i))
            v[src] = i
            vmap[i] = v
    for f in B.F:
        f = [canon[i] for i in f]
        if all(i in vmap for i in f) and len(set(f)) == len(f):
            try:
                bm.faces.new([vmap[i] for i in f])
            except ValueError:
                pass
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # drop specks (islands under 30 faces: a stray fingertip or nipple ring)
    seen, small = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        isl, stack = [], [f]
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        if len(isl) < 30:
            small += isl
    if small:
        bmesh.ops.delete(bm, geom=small, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    relax(B, bm, src, off_eff, smooth, pin)
    return bm, src


def relax(B, bm, src, off, passes, pin=None):
    free = [v for v in bm.verts if not v.is_boundary and not (pin and pin(v[src]))]
    for _ in range(passes):
        bmesh.ops.smooth_vert(bm, verts=free, factor=0.5,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in bm.verts:   # clearance: never nearer the skin than 80% of the layer offset
        loc, n, fi, _ = B.bvh.find_nearest(v.co)
        if loc is None:
            continue
        k = 0.8 * off(v[src])
        i = v[src]
        if B.part(B.F[fi][0]) != B.part(i):
            # the nearest skin is ANOTHER part (the arm over a stout's flank, the belly over the thigh): pushing
            # off that surface drove the shell into its own skin. Hold it off its own vertex along its own normal
            loc, n = B.P[i], B.N[i]
        s = (v.co - loc).dot(n)
        if s < k:
            v.co += n * (k - s)


def boundary_loops(bm):
    """the shell's open boundaries as ordered vertex loops"""
    seen, loops = set(), []
    for v0 in bm.verts:
        if v0 in seen or not v0.is_boundary:
            continue
        loop, prev, cur = [v0], None, v0
        seen.add(v0)
        while True:
            nxt = None
            for e in cur.link_edges:
                if e.is_boundary:
                    o = e.other_vert(cur)
                    if o is not prev and o not in seen:
                        nxt = o
                        break
            if nxt is None:
                break
            seen.add(nxt)
            loop.append(nxt)
            prev, cur = cur, nxt
        if len(loop) >= 6:
            loops.append(loop)
    return loops


def fair_rims(B, bm, src, off, span=0.04, corner_deg=60.0, passes=60):
    """R2 F1: an opening cut on the body's face grid is a staircase (torn paper at 1.5 m). Every boundary loop becomes a
    smooth curve: corners are found at the 3 cm scale (the staircase averages out there, a hem x front corner does
    not) and pinned; between them the loop is Taubin-smoothed (no shrink), re-spaced evenly by arc length, then held
    off the skin again; the two rings of faces behind the rim are relaxed so no face folds over the new edge."""
    for loop in boundary_loops(bm):
        n = len(loop)
        P = [v.co.copy() for v in loop]
        seg = [(P[(i + 1) % n] - P[i]).length for i in range(n)]
        per = sum(seg) or 1.0
        k = max(3, int(round(span / (per / n))))

        def turn(i):
            a, b = P[i] - P[(i - k) % n], P[(i + k) % n] - P[i]
            return 0.0 if a.length < 1e-6 or b.length < 1e-6 else math.degrees(a.angle(b))
        ang = [turn(i) for i in range(n)]
        pinned = {i for i in range(n) if corner_deg < ang[i] < 140 and all(ang[i] >= ang[(i + d) % n] for d in range(-k, k + 1))}
        pinned = set(sorted(pinned, key=lambda i: -ang[i])[:4])   # authored corners: hem x front, collar x front
        # (a turn >= 140 deg is not a corner, it is the staircase folding back on itself: smoothed away, never pinned)
        print(f"fair_rims: loop {n} verts, {per:.2f} m, k {k}, corners {sorted(round(ang[i]) for i in pinned)}")
        for _ in range(passes):
            for lam in (0.5, -0.53):
                Q = [P[i] if i in pinned else P[i] + ((P[(i - 1) % n] + P[(i + 1) % n]) * 0.5 - P[i]) * lam for i in range(n)]
                P = Q
        # even arc-length spacing between consecutive corners (a closed loop without corners: from vertex 0)
        cs = sorted(pinned) or [0]
        newP = list(P)
        for ci, c0 in enumerate(cs):
            c1 = cs[(ci + 1) % len(cs)]
            idx = [(c0 + j) % n for j in range(((c1 - c0) % n) or n)] + [c1]
            pts = [P[i] for i in idx]
            acc = [0.0]
            for a, b in zip(pts, pts[1:]):
                acc.append(acc[-1] + (b - a).length)
            tot = acc[-1] or 1.0
            m = len(idx) - 1
            q = 0
            for j in range(1, m):
                target = tot * j / m
                while q < m - 1 and acc[q + 1] < target:
                    q += 1
                u = (target - acc[q]) / max(1e-9, acc[q + 1] - acc[q])
                newP[idx[j]] = pts[q].lerp(pts[q + 1], min(1.0, max(0.0, u)))
        for v, co in zip(loop, newP):
            v.co = co
            loc, nn, fi, _ = B.bvh.find_nearest(v.co)
            if loc is not None:
                sd = (v.co - loc).dot(nn)
                kk = 0.8 * off(v[src])
                if sd < kk:
                    v.co += nn * (kk - sd)
    ring = {e.other_vert(v) for v in bm.verts if v.is_boundary for e in v.link_edges} - {v for v in bm.verts if v.is_boundary}
    ring2 = ring | {e.other_vert(v) for v in ring for e in v.link_edges if not e.other_vert(v).is_boundary}
    for _ in range(4):
        bmesh.ops.smooth_vert(bm, verts=list(ring2), factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in ring2:   # smoothing pulls the band into the skin: hold it off again (the relax() clearance rule)
        loc, nn, fi, _ = B.bvh.find_nearest(v.co)
        if loc is None:
            continue
        if B.part(B.F[fi][0]) != B.part(v[src]):
            loc, nn = B.P[v[src]], B.N[v[src]]
        sd, kk = (v.co - loc).dot(nn), 0.8 * off(v[src])
        if sd < kk:
            v.co += nn * (kk - sd)


def refair_outer(o, B, span=0.04, corner_deg=60.0, passes=40, max_corners=4, open_corners=6, clear=0.005):
    """R2 F1 (second pass): fair_rims() runs on the bare shell, but the collar and lapel extrusions, decimate(),
    solidify() and bridge_folds() all move rim vertices afterwards, and those kinks are what the gate still counted
    (coat opening 11/8/18 spikes, vest 9). This runs LAST on the finished garment: every boundary of the outer cloth
    (material 0) faces, the line test-character-asset resamples, is Taubin-smoothed between its authored corners
    (found at the 4 cm scale) and re-spaced by arc length. Whatever hangs off a rim vertex and is not outer cloth
    (the solidify rim + lining vertex, the lapel and cuff extrusions) moves with it, so the edge keeps its thickness
    and the facings stay attached. The longest loop (the coat opening: hem x front, collar foot, collar top, each
    side) may keep six corners, every other loop four."""
    mw = o.matrix_world
    inv = mw.inverted()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    outer = lambda f: f.material_index == 0
    adj = {}
    for e in bm.edges:
        if sum(1 for f in e.link_faces if outer(f)) == 1:
            a, b = e.verts
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    used, loops = set(), []
    for s0 in adj:
        if s0 in used:
            continue
        L, prev, cur = [s0], None, s0
        used.add(s0)
        while True:
            nx = next((w for w in adj[cur] if w is not prev and w not in used), None)
            if nx is None:
                break
            used.add(nx)
            L.append(nx)
            prev, cur = cur, nx
        if len(L) >= 8:
            loops.append(L)
    loops.sort(key=lambda L: -len(L))
    rimset = set(used)
    moved = 0
    for li, loop in enumerate(loops):
        n = len(loop)
        P0 = [mw @ v.co for v in loop]
        P = list(P0)
        per = sum((P[(i + 1) % n] - P[i]).length for i in range(n)) or 1.0
        k = max(2, int(round(span / (per / n))))

        def turn(i):
            a, b = P[i] - P[(i - k) % n], P[(i + k) % n] - P[i]
            return 0.0 if a.length < 1e-6 or b.length < 1e-6 else math.degrees(a.angle(b))
        ang = [turn(i) for i in range(n)]
        cap = open_corners if (li == 0 and open_corners) else max_corners
        pinned = {i for i in range(n) if corner_deg < ang[i] < 140 and all(ang[i] >= ang[(i + d) % n] for d in range(-k, k + 1))}
        pinned = set(sorted(pinned, key=lambda i: -ang[i])[:cap])
        for _ in range(passes):
            for lam in (0.5, -0.53):
                P = [P[i] if i in pinned else P[i] + ((P[(i - 1) % n] + P[(i + 1) % n]) * 0.5 - P[i]) * lam for i in range(n)]
        cs = sorted(pinned) or [0]
        newP = list(P)
        for ci, c0 in enumerate(cs):
            c1 = cs[(ci + 1) % len(cs)]
            idx = [(c0 + j) % n for j in range(((c1 - c0) % n) or n)] + [c1]
            pts = [P[i] for i in idx]
            acc = [0.0]
            for a, b in zip(pts, pts[1:]):
                acc.append(acc[-1] + (b - a).length)
            tot, m, q = acc[-1] or 1.0, len(idx) - 1, 0
            for j in range(1, m):
                t = tot * j / m
                while q < m - 1 and acc[q + 1] < t:
                    q += 1
                u = (t - acc[q]) / max(1e-9, acc[q + 1] - acc[q])
                newP[idx[j]] = pts[q].lerp(pts[q + 1], min(1.0, max(0.0, u)))
        for v, p0, p1 in zip(loop, P0, newP):
            loc, nn, _, _ = B.bvh.find_nearest(p1)
            if loc is not None and (p1 - loc).dot(nn) < clear:   # never faired into the skin
                p1 = p1 + nn * (clear - (p1 - loc).dot(nn))
            d = p1 - p0
            if d.length < 1e-7:
                continue
            moved += 1
            v.co = inv @ p1
            for e in v.link_edges:   # the lining/rim vertex and the facing hanging off this rim vertex follow it
                w = e.other_vert(v)
                if w not in rimset and not any(outer(f) for f in w.link_faces):
                    q = (mw @ w.co) + d
                    loc, nn, _, _ = B.bvh.find_nearest(q)
                    if loc is not None and (q - loc).dot(nn) < 0.0015:   # the lining stays off the skin too
                        q = q + nn * (0.0015 - (q - loc).dot(nn))
                    w.co = inv @ q
    # the two rings of outer cloth behind a moved rim: a rounded strap corner or a respaced rim leaves the faces behind
    # it cutting a convex ridge of skin (the waistcoat armhole over the shoulder): hold them off the skin like the rim
    ring = {e.other_vert(v) for L in loops for v in L for e in v.link_edges} - rimset
    ring |= {e.other_vert(v) for v in ring for e in v.link_edges} - rimset
    for v in ring:   # outer cloth held at the rim clearance, the lining behind it at 1.5 mm
        c = clear if any(outer(f) for f in v.link_faces) else 0.0015
        p = mw @ v.co
        loc, nn, _, _ = B.bvh.find_nearest(p)
        if loc is not None and (p - loc).dot(nn) < c:
            v.co = inv @ (p + nn * (c - (p - loc).dot(nn)))
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return moved


def decimate(o, ratio):
    """R2 F9: the shell carries the body's full face density; collapse its interior (the rim loops are held by a zero
    weight so the faired openings keep their line) before the lining doubles it"""
    g = o.vertex_groups.new(name="_dec")
    bnd = set()
    for e in o.data.edges:
        pass
    me = o.data
    cnt = {}
    for poly in me.polygons:
        for ek in poly.edge_keys:
            cnt[ek] = cnt.get(ek, 0) + 1
    for ek, c in cnt.items():
        if c == 1:
            bnd.update(ek)
    g.add([i for i in range(len(me.vertices)) if i not in bnd], 1.0, "REPLACE")
    g.add(list(bnd), 0.0, "REPLACE")
    m = o.modifiers.new("dec", "DECIMATE")
    m.decimate_type, m.ratio, m.vertex_group, m.vertex_group_factor = "COLLAPSE", ratio, g.name, 1000.0
    with ctx(o):
        bpy.ops.object.modifier_apply(modifier=m.name)
    o.vertex_groups.remove(o.vertex_groups["_dec"])


def extrude(bm, verts, move, mat=None):
    vs = set(verts)
    edges = [e for e in bm.edges if e.is_boundary and e.verts[0] in vs and e.verts[1] in vs]
    if not edges:
        return []
    r = bmesh.ops.extrude_edge_only(bm, edges=edges)
    nv = [g for g in r["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in nv:
        v.co = move(v)
    if mat is not None:
        for g in r["geom"]:
            if isinstance(g, bmesh.types.BMFace):
                g.material_index = mat
    return nv


def orient(B, bm):
    bm.normal_update()
    flip = []
    for f in bm.faces:
        c = f.calc_center_median()
        loc, _, _, _ = B.bvh.find_nearest(c)
        if loc is not None and f.normal.dot(c - loc) < 0:
            flip.append(f)
    if flip:
        bmesh.ops.reverse_faces(bm, faces=flip)


def box_uv(me, scale=0.3):
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        ax = max(range(3), key=lambda k: abs(poly.normal[k]))
        a, b = ((1, 2), (0, 2), (0, 1))[ax]
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (co[a] / scale, co[b] / scale)


def to_obj(name, bm, mats, out_dir):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for cls in mats:
        me.materials.append(W.material(cls, out_dir))
    box_uv(me)
    return o


def solidify(o, t, mat_offset=1):
    m = o.modifiers.new("solid", "SOLIDIFY")
    # even offset OFF: at the zero-area folds a snapped boundary leaves it divides by ~0 (b3.2d first build: boot
    # and breeches vertices shot 1-6 m out of the model)
    m.thickness, m.offset, m.use_even_offset = t, -1.0, False
    m.use_quality_normals = True
    if CUR_BODY:
        # the lining goes INWARD by t: where the shell sits closer to the skin than t + 1.5 mm (the gap shared under a
        # stout's arm, the belly over the thigh) the lining thins instead of sinking into the skin
        Bd, g = CUR_BODY[0], o.vertex_groups.new(name="_thick")
        mw = o.matrix_world
        for v in o.data.vertices:
            p = mw @ v.co
            loc, n, _, _ = Bd.bvh.find_nearest(p)
            s = (p - loc).dot(n) if loc is not None else 1.0
            g.add([v.index], min(1.0, max(0.02, (s - 0.0015) / t)), "REPLACE")
        m.vertex_group, m.thickness_vertex_group = g.name, 0.02
    m.material_offset = mat_offset
    m.material_offset_rim = mat_offset
    with ctx(o):
        bpy.ops.object.modifier_apply(modifier=m.name)
    if o.vertex_groups.get("_thick"):
        o.vertex_groups.remove(o.vertex_groups["_thick"])


def append(o, parts):
    """bmesh-append part objects (same slot order) into o; returns the vertex index range of each part."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    ranges = []
    for p in parts:
        n0 = len(bm.verts)
        bm.from_mesh(p.data)
        ranges.append(range(n0, len(bm.verts)))
        bpy.data.objects.remove(p, do_unlink=True)
    bm.to_mesh(o.data)
    bm.free()
    return ranges


def part(name, verts, faces, mat=0, uvs=None):
    o = W._mesh_obj(name, verts, faces, uvs, [mat] * len(faces))
    if uvs is None:
        box_uv(o.data, 0.1)
    return o


def button(c, n, r=0.0075, depth=0.0035, mat=3, name="btn"):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=r, radius2=r * 0.78, depth=depth)
    M = Matrix.Translation(c + n * depth * 0.5) @ n.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.material_index = mat
        p.use_smooth = True
    me.uv_layers.new(name="UVMap")
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def frame(c, n, t, w, h, bar, thick, mat, name="buckle"):
    """solid rectangular buckle frame centred on c, lying on the surface with normal n, long side along t."""
    t = (t - t.dot(n) * n).normalized()
    b = n.cross(t)
    verts = []
    for dz in (0.0, thick):
        for (hw, hh) in ((w / 2, h / 2), (w / 2 - bar, h / 2 - bar)):
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                verts.append(c + n * (dz + 0.001) + t * sx * hw + b * sy * hh)
    O0, I0, O1, I1 = 0, 4, 8, 12
    faces = []
    for k in range(4):
        k2 = (k + 1) % 4
        faces += [(O1 + k, O1 + k2, I1 + k2, I1 + k), (O0 + k2, O0 + k, I0 + k, I0 + k2),
                  (O0 + k, O0 + k2, O1 + k2, O1 + k), (I0 + k2, I0 + k, I1 + k, I1 + k2)]
    return part(name, verts, faces, mat)


def hit(o, org, d):
    bvh = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())
    loc, n, _, _ = bvh.ray_cast(org, d.normalized(), 3.0)
    if loc is None:
        return None, None
    return loc, (n if n.dot(d) < 0 else -n)


def transfer_weights(o, B, override=None):
    m = o.modifiers.new("dt", "DATA_TRANSFER")
    m.object = B.obj
    m.use_vert_data = True
    m.data_types_verts = {"VGROUP_WEIGHTS"}
    m.vert_mapping = "POLYINTERP_NEAREST"
    m.layers_vgroup_select_src = "ALL"
    m.layers_vgroup_select_dst = "NAME"
    with ctx(o):
        bpy.ops.object.datalayout_transfer(modifier=m.name)
        bpy.ops.object.modifier_apply(modifier=m.name)
    bones = {bo.name for bo in B.arm.data.bones if not bo.name.startswith(NON_DEFORM)}
    head, neck = o.vertex_groups.get("head"), o.vertex_groups.get("neck_01") or o.vertex_groups.new(name="neck_01")
    if head is not None:   # a collar near the jaw follows the neck, not every look of the head
        for v in o.data.vertices:
            for g in v.groups:
                if g.group == head.index and g.weight > 0:
                    neck.add([v.index], g.weight, "ADD")
        o.vertex_groups.remove(head)
    for vg in list(o.vertex_groups):
        if vg.name not in bones:
            o.vertex_groups.remove(vg)
    for idx_range, fn in (override or []):
        for i in idx_range:
            for vg in o.vertex_groups:
                vg.remove([i])
            for name, wt in fn(o.data.vertices[i].co).items():
                if wt > 1e-4:
                    g = o.vertex_groups.get(name) or o.vertex_groups.new(name=name)
                    g.add([i], wt, "REPLACE")
    with ctx(o):
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    used = {g.group for v in o.data.vertices for g in v.groups if g.weight > 0}
    for vg in [vg for vg in o.vertex_groups if vg.index not in used]:
        o.vertex_groups.remove(vg)
    empty = [v.index for v in o.data.vertices if not v.groups]
    if empty:   # a vertex the transfer left unweighted follows the pelvis rather than staying in bind space
        g = o.vertex_groups.get("pelvis") or o.vertex_groups.new(name="pelvis")
        g.add(empty, 1.0, "REPLACE")


def finish(o, B, cls_note):
    mw = o.matrix_world.copy()
    o.parent = B.arm
    o.matrix_world = mw
    m = o.modifiers.new("Armature", "ARMATURE")
    m.object = B.arm
    for p in o.data.polygons:
        p.use_smooth = True
    try:
        with ctx(o):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
    except Exception as ex:   # noqa: BLE001
        print("shade_smooth_by_angle unavailable:", ex)
    o["pirateDefault"] = False
    o["wardrobeSlot"] = cls_note
    o.hide_render = True
    return o


def skirt_weights(B, top, hem, share=0.6):
    thl, thr = f"thigh_{B.left}", f"thigh_{'r' if B.left == 'l' else 'l'}"

    def fn(co):
        t = min(1.0, max(0.0, (top - co.z) / (top - hem)))
        u = min(1.0, max(0.0, 0.5 + (co.x - B.cx) / 0.16))
        return {"pelvis": 1 - share * t, thl: share * t * u, thr: share * t * (1 - u)}
    return fn


# ── upper garments ─────────────────────────────────────────────────────────────────────────────
def upper(B, name, hem, torso_off, arm_off, gap, mats, out_dir, cuff, lapels, collar, dec=0.6):
    def armw(i):
        return min(1.0, 1.5 * B.w(i, "upperarm", "lowerarm"))

    def keep(i):
        p = B.P[i]
        if B.w(i, *HAND) > 0.2 or B.w(i, "neck", "head") > 0.35 or p.z < hem - 0.015:
            return False
        if B.w(i, "upperarm", "lowerarm") > 0.3:
            return B.frac(p, B.side(p)) < 0.93
        if p.z > B.neck + 0.01:
            return False
        return not (p.y < B.cy and abs(p.x - B.cx) < gap)

    def off(i):
        a = armw(i)
        return arm_off * a + torso_off * (1 - a)
    bm, src = shell(B, keep, off)
    bnd = [v for v in bm.verts if v.is_boundary]
    wrist = [v for v in bnd if B.w(v[src], "upperarm", "lowerarm") > 0.3 and B.frac(v.co, B.side(v.co)) > 0.7]
    front = [v for v in bnd if v not in wrist and v.co.y < B.cy and abs(v.co.x - B.cx) < gap + 0.03
             and hem + 0.02 < v.co.z < B.neck - 0.015]
    ws = set(wrist) | set(front)
    neck = [v for v in bnd if v not in ws and v.co.z > B.shoulder - 0.07 and B.w(v[src], "upperarm", "lowerarm") < 0.3]
    hemv = [v for v in bnd if v not in ws and v.co.z < B.waist + 0.05]
    for v in wrist:   # square the sleeve end on the forearm
        s = B.side(v.co)
        e, h = B.forearm(s)
        v.co -= (h - e) * (B.frac(v.co, s) - 0.93)
    for v in front:
        v.co.x = B.cx + math.copysign(gap, v.co.x - B.cx)
    for v in hemv:
        v.co.z = hem
    fair_rims(B, bm, src, off)
    if cuff:
        lip, back, flare, mat = cuff
        nv = extrude(bm, wrist, lambda v: v.co + B.arm_radial(v.co, B.side(v.co))[0] * lip, mat)
        extrude(bm, nv, lambda v: v.co - B.arm_radial(v.co, B.side(v.co))[1] * back
                + B.arm_radial(v.co, B.side(v.co))[0] * flare, mat)
    if collar:
        c = B.b("neck_01")

        def up(v):
            r = Vector((v.co.x - c.x, v.co.y - c.y, 0)).normalized()
            return v.co + UP * collar + r * 0.012
        smooth_polar(extrude(bm, neck, up, 0), c)
    if lapels:
        z0 = B.waist + 0.04

        def lap(v):
            t = (v.co.z - z0) / max(0.05, B.neck - z0)
            w = 0.014 if t < 0 else 0.016 + lapels * smoothstep(0.0, 0.75, t) * (1 - 0.35 * smoothstep(0.85, 1.0, t))
            loc, n, _, _ = B.bvh.find_nearest(v.co)
            return v.co + Vector((math.copysign(w, v.co.x - B.cx), 0, 0)) + n * 0.005 + UP * (0.004 if t > 0.9 else 0)
        extrude(bm, front, lap, 1)
    orient(B, bm)
    o = to_obj(name, bm, mats, out_dir)
    decimate(o, dec)
    solidify(o, 0.0032)
    bridge_folds(o, B, ["spine_02", "spine_03", "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"])
    refair_outer(o, B)
    # fairing moves the rim a few mm; where that uncovered a fold (the stout's shoulder under the collar end) the
    # bridge pass pushes the sheet back out, then the rim is faired once more (the bridge falloff can kink it)
    if bridge_folds(o, B, ["spine_02", "spine_03", "upperarm_l", "upperarm_r"], passes=4):
        refair_outer(o, B, passes=80)
    return o


def smooth_polar(vs, c, win=0.55):
    """R2 F1 (stout collar): the collar is extruded straight up from the neck hole, and on the stout the hole follows
    the kit's face grid out over a high trapezius (x 0.21) and turns round the back in two kinks, so the collar top
    kept three spikes the rim fairing could not remove without eating the collar's front corners. The collar top is
    free (only the collar hangs off it), so it is smoothed in polar form round the neck: radius and height averaged
    over +-win rad (Hann weights, no wrap across the front opening), which rounds the kinks without shrinking it."""
    pol = [(math.atan2(v.co.x - c.x, v.co.y - c.y), math.hypot(v.co.x - c.x, v.co.y - c.y), v.co.z, v) for v in vs]
    out = []
    for th, _r, _z, v in pol:
        sw = sr = sz = 0.0
        for t2, r2, z2, _ in pol:
            d = abs(t2 - th)
            if d < win:
                w = math.cos(0.5 * math.pi * d / win) ** 2
                sw, sr, sz = sw + w, sr + w * r2, sz + w * z2
        # the front ends (the collar's authored corners at the opening) keep their place; inward moves are capped
        # at 4 mm so the collar never leans into a stout's trapezius (a free inward average cut the skin at x 0.24)
        a = 1.0 - smoothstep(math.pi - 0.9, math.pi - 0.3, abs(th))
        # only a kink moves (>= 4-10 mm off the running average): a collar that is already a clean curve (male,
        # female) keeps its authored shape and its two front corners
        a *= smoothstep(0.004, 0.010, max(abs(sr / sw - _r), abs(sz / sw - _z)))
        out.append((th, _r + a * (max(sr / sw, _r - 0.004) - _r), _z + a * (sz / sw - _z), v))
    for th, r, z, v in out:
        v.co.x, v.co.y, v.co.z = c.x + r * math.sin(th), c.y + r * math.cos(th), z


def hold_out_radial(o, B, bones=("spine_02", "spine_03"), outer=0.004, lining=0.0015):
    """R2 F1 regression (waistcoat armholes): the re-fair rounds the strap corners, and at the armhole the lining
    ended 5-7 mm under the chest / shoulder-blade skin (male 1, stout 4 gate probes from spine_03 crossed it).
    Nearest-surface clearance cannot see it there (the nearest skin is the arm's, facing sideways), and
    bridge_folds() works from skin probes. This works from the garment: every face centre and edge midpoint is seen
    from the spine bin centres the gate casts from; a sample the skin still covers along that ray moves its face (or
    edge) out along it to the skin + clearance (outer cloth 4 mm, lining 1.5 mm), up to four passes."""
    mw = B.arm.matrix_world
    segs = []
    for n in bones:
        bo = B.arm.data.bones.get(n)
        if bo is not None:
            h = mw @ bo.head_local
            segs += [(h, mw @ ch.head_local) for ch in bo.children] or [(h, mw @ bo.tail_local)]
    me, ow = o.data, o.matrix_world
    inv = ow.inverted()
    # the probes are face samples, not vertices: after decimate a long armhole triangle has its corners on the
    # skin and its middle chord 5-7 mm under the shoulder ridge (the vertices alone were never covered)
    moved = 0
    for _ in range(4):
        W = [ow @ v.co for v in me.vertices]
        disp = {}
        for f in me.polygons:
            c = outer if f.material_index == 0 else lining
            vs = list(f.vertices)
            samples = [(sum((W[i] for i in vs), Vector()) / len(vs), vs)]
            samples += [((W[a] + W[b]) * 0.5, (a, b)) for a, b in zip(vs, vs[1:] + vs[:1])]
            for sp, owners in samples:
                for h, t in segs:   # the gate's origins: the centre of the bin (1/8 of a bone axis) it projects into
                    ax = t - h
                    k = min(7, max(0, int(8 * (sp - h).dot(ax) / max(ax.length_squared, 1e-9))))
                    q = h + ax * ((k + 0.5) / 8)
                    d = sp - q
                    L = d.length
                    if L < 0.02:
                        continue
                    d /= L
                    loc, _n, _i, bd = B.bvh.ray_cast(q, d, L + 0.03)
                    if loc is not None and L - c < bd < L + 0.02:
                        dv = d * (bd + c - L)
                        for i in owners:
                            if dv.length > disp.get(i, Vector()).length:
                                disp[i] = dv
        if not disp:
            break
        for i, dv in disp.items():
            me.vertices[i].co = inv @ (W[i] + dv)
        moved += len(disp)
    me.update()
    return moved


def bridge_folds(o, B, bones, passes=8, r=0.03, margin=0.0035):
    """the garment must enclose every skin vertex it wraps as seen from the bone (the test-character-asset probe:
    rays from 8 bins along each covered bone to the skin vertices that bone dominates). Where the body folds on
    itself (a stout's back-armpit crease under the arm, the belly underside over the thigh) the shell tucked into the
    fold and the ray to the fold's outer sheet crossed it. Push the crossing sheet (shell and lining together) out
    past the skin with a smooth falloff, so the garment bridges the fold like cloth does."""
    from mathutils.kdtree import KDTree
    mw = B.arm.matrix_world
    axes = {}
    for n in bones:
        bo = B.arm.data.bones.get(n)
        if bo is None:
            continue
        h = mw @ bo.head_local
        axes[n] = [(h, mw @ c.head_local) for c in bo.children] or [(h, mw @ bo.tail_local)]
    me = o.data
    zs = [v.co.z for v in me.vertices]
    z0, z1 = min(zs), max(zs) - 0.02
    probes = []
    for i, p in enumerate(B.P):
        if not (z0 < p.z < z1) or not B.Wt[i]:
            continue
        # every covered bone carrying >= 30% of the vertex (the gate takes the dominant joint AFTER the 4-limit and
        # renormalise of the export, which can differ from Blender's where two bones share a vertex)
        js = [j for j, wt in B.Wt[i].items() if j in axes and wt >= 0.3] or \
            [j for j in (max(B.Wt[i].items(), key=lambda kv: kv[1])[0],) if j in axes]
        for j, (h, t) in ((j, a) for j in js for a in axes[j]):
            if j.startswith("thigh_") and abs(p.x) < 0.03:
                continue
            ax = t - h
            k = min(7, max(0, int(8 * (p - h).dot(ax) / max(ax.length_squared, 1e-9))))
            probes.append((h + ax * ((k + 0.5) / 8), p, i))
    moved = 0
    for _ in range(passes):
        bvh = BVHTree.FromPolygons([v.co for v in me.vertices], [list(q.vertices) for q in me.polygons])
        hits = []
        for c, p, i in probes:
            d = p - c
            L = d.length
            if L < 0.01:
                continue
            d = d / L
            loc, fn, fi, hd = bvh.ray_cast(c, d, L - 0.001)
            if loc is None:
                continue
            bl, _, _, bd = B.bvh.ray_cast(c, d, L - 0.001)
            if bl is not None and bd < L - 0.004:
                continue   # hidden from the bone by the body's own skin (the gate drops these probes too)
            # move the crossing sheet along its own normal (away from the bone): a plane moved by t along n moves the
            # crossing by t / (n.d). Sliding it along the ray instead barely moved a sheet the ray grazes (the stout's
            # belly underside over the thigh: 0.6 mm a pass, never cleared)
            nf = fn if fn.dot(d) > 0 else -fn
            # (a sheet the ray meets head-on, the stout's back-armpit crease, slides out along the ray: that cleared it)
            dv = d * (L - hd + margin) if nf.dot(d) >= 0.5 else nf * min(0.02, (L - hd + margin) / max(0.25, nf.dot(d)))
            hits.append((loc, dv, fi))
        if not hits:
            break
        kd = KDTree(len(me.vertices))
        for v in me.vertices:
            kd.insert(v.co, v.index)
        kd.balance()
        disp = {}
        for loc, dv, fi in hits:
            own = set(me.polygons[fi].vertices)   # the crossed face itself moves the full amount
            for _co, vi, dd in kd.find_range(loc, r):
                w = 1.0 if vi in own else (1 - (dd / r) ** 2) ** 2
                if w * dv.length > disp.get(vi, Vector()).length:
                    disp[vi] = dv * w
        for vi, dv in disp.items():
            me.vertices[vi].co += dv
        moved += len(hits)
    o["bridgedProbes"] = moved
    return moved


def buttons_on(o, pts, d, r=0.0075, mat=3):
    out = []
    for p in pts:
        loc, n = hit(o, p - d * 0.4, d)
        if loc is not None:
            out.append(button(loc, n, r=r, mat=mat))
    return out


def coat_frock(B, out_dir):
    hem_up = B.waist - 0.02
    gap = 0.05
    o = upper(B, "coat_frock", hem_up, 0.024, 0.013, gap, ["wool", "crew", "crew", "gold"], out_dir,
              cuff=(0.006, 0.08, 0.015, 1), lapels=0.055, collar=0.04)
    parts = []
    # skirt: two panels (left through +X, right through -X) from the waist to below the knee
    top, hem = B.waist + 0.03, B.knee - 0.03
    rows, cols = 12, 16
    for side in (0, 1):
        verts, faces = [], []
        for r in range(rows):
            t = r / (rows - 1)
            z = top + (hem - top) * t
            o_ang = math.radians(18 + 30 * t ** 1.3)
            vent = math.radians(0.4 if z > B.hip - 0.02 else 3.0)
            a0, a1 = (-math.pi / 2 + o_ang, math.pi / 2 - vent) if side == 0 else (math.pi / 2 + vent, 1.5 * math.pi - o_ang)
            for j in range(cols):
                phi = a0 + (a1 - a0) * j / (cols - 1)
                back = max(0.0, math.cos(phi - math.pi / 2))
                rr = B.support(z, phi) + 0.026 + 0.10 * t ** 1.6 + 0.009 * t * back ** 2 * math.sin(5 * phi) ** 2
                verts.append(B.ring_pt(z, phi, rr))
        for r in range(rows - 1):
            for j in range(cols - 1):
                a, b = r * cols + j, r * cols + j + 1
                faces.append((a, a + cols, b + cols, b))
        sk = part(f"skirt{side}", verts, faces, 0)
        sk.data.materials.append(W.material("wool", out_dir))
        solidify(sk, 0.0035)
        parts.append(sk)
    # buttons: five down each front edge (on the lapel where it is folded back), three on each cuff
    pts = []
    for sgn in (1, -1):
        for k in range(5):
            z = B.waist + 0.02 + k * (B.shoulder - 0.12 - B.waist) / 4
            pts.append(Vector((B.cx + sgn * (gap + 0.012), B.cy, z)))
    btn = buttons_on(o, pts, Vector((0, 1, 0)))
    for s in "lr":
        e, h = B.forearm(s)
        for f in (0.6, 0.7, 0.8):
            p = e + (h - e) * f
            btn += buttons_on(o, [p + UP * 0.15], -UP, r=0.006)
    ranges = append(o, parts + btn)
    wf = skirt_weights(B, top, hem)
    transfer_weights(o, B, [(ranges[0], wf), (ranges[1], wf)])
    return finish(o, B, "coat")


def coat_jacket(B, out_dir):
    gap = 0.06
    hem = B.hip - 0.03
    o = upper(B, "coat_jacket", hem, 0.019, 0.012, gap, ["wool", "crew", "crew", "gold"], out_dir,
              cuff=(0.003, 0.035, 0.004, 0), lapels=0.0, collar=0.03)
    pts = []
    for sgn in (1, -1):
        for k in range(4):
            pts.append(Vector((B.cx + sgn * (gap + 0.022), B.cy, hem + 0.04 + k * 0.065)))
    btn = buttons_on(o, pts, Vector((0, 1, 0)), r=0.0065)
    append(o, btn)
    transfer_weights(o, B)
    return finish(o, B, "coat")


def vest_waistcoat(B, out_dir):
    hem = B.hip - 0.04
    zv = B.shoulder - 0.17
    ux = abs(B.b("upperarm_l").x - B.cx)

    def keep(i):
        p = B.P[i]
        if B.w(i, "upperarm", "lowerarm", *HAND) > 0.12 or B.w(i, "neck", "head") > 0.3:
            return False
        if p.z < hem - 0.015 or p.z > B.neck:
            return False
        if abs(p.x - B.cx) > 0.8 * ux and p.z > B.shoulder - 0.13:
            return False
        if p.y < B.cy and p.z > zv and abs(p.x - B.cx) < 0.075 * (p.z - zv) / max(0.05, B.neck - zv):
            return False
        return True
    bm, src = shell(B, keep, lambda i: 0.013)
    for v in bm.verts:
        if v.is_boundary and v.co.z < B.waist:
            v.co.z = hem - (0.03 * max(0.0, 1 - abs(v.co.x - B.cx) / 0.09) if v.co.y < B.cy else 0.0)   # front points
    fair_rims(B, bm, src, lambda i: 0.013)
    orient(B, bm)
    o = to_obj("vest_waistcoat", bm, ["brocade", "crew", "crew", "gold"], out_dir)
    decimate(o, 0.8)
    o.data.materials[1] = W.material("breeches", out_dir)   # plain wool back lining, not the crew colour
    o.data.materials[2] = W.material("breeches", out_dir)
    solidify(o, 0.0025)
    refair_outer(o, B, max_corners=1, open_corners=0, passes=80)   # only the V / hem front point stays sharp: the strap corners round off at ~2 cm
    if bridge_folds(o, B, ["spine_02", "spine_03"], passes=4):
        refair_outer(o, B, max_corners=1, open_corners=0, passes=80)
    o["heldOut"] = hold_out_radial(o, B)
    pts = [Vector((B.cx, B.cy, hem + 0.03 + k * (zv - 0.02 - hem - 0.03) / 5)) for k in range(6)]
    append(o, buttons_on(o, pts, Vector((0, 1, 0)), r=0.006))
    transfer_weights(o, B)
    return finish(o, B, "vest")


def band(B, name, z0, z1, off, mats, out_dir, rows=4, cols=64, fold=0.0):
    verts, faces = [], []
    for r in range(rows):
        z = z0 + (z1 - z0) * r / (rows - 1)
        for j in range(cols):
            phi = 2 * math.pi * j / cols
            rr = B.support(z, phi, 0.03) + off + fold * math.sin(3 * phi + 5 * r / rows) * math.sin(math.pi * r / (rows - 1))
            verts.append(B.ring_pt(z, phi, rr))
    for r in range(rows - 1):
        for j in range(cols):
            a, b = r * cols + j, r * cols + (j + 1) % cols
            faces.append((a + cols, a, b, b + cols))
    uvs = [(8 * (k % cols) / cols, (k // cols) * 0.3) for k in range(len(verts))]
    o = part(name, verts, faces, 0, uvs)
    for cls in mats:
        o.data.materials.append(W.material(cls, out_dir))
    return o


def sash(B, out_dir):
    z0, z1 = B.waist - 0.075, B.waist + 0.03
    o = band(B, "sash", z0, z1, 0.016, ["crew", "crew"], out_dir, rows=7, fold=0.003)
    solidify(o, 0.003, 0)
    phi = math.radians(-30)
    zk = (z0 + z1) / 2 - 0.01
    rk = B.support(zk, phi) + 0.03
    ck = B.ring_pt(zk, phi, rk)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=0.028)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(ck) @ Matrix.Rotation(phi + math.pi / 2, 4, "Z")
                        @ Matrix.Diagonal((1.0, 0.55, 0.85, 1.0)), verts=bm.verts)
    me = bpy.data.meshes.new("knot")
    bm.to_mesh(me)
    bm.free()
    knot = bpy.data.objects.new("knot", me)
    bpy.context.scene.collection.objects.link(knot)
    box_uv(me, 0.1)
    tails = []
    zt = B.hip - 0.22
    for k, (dphi, w, drop) in enumerate(((-0.10, 0.065, 0.0), (0.09, 0.055, 0.06))):
        verts, faces = [], []
        rows, cols = 12, 4
        for r in range(rows):
            t = r / (rows - 1)
            z = zk - 0.01 + (zt - drop - zk) * t
            rr = B.support(z, phi + dphi, 0.03) + 0.03 + 0.012 * t
            for j in range(cols):
                a = phi + dphi + (j / (cols - 1) - 0.5) * (w * (1 + 0.3 * t)) / rr
                verts.append(B.ring_pt(z, a, rr + 0.004 * math.sin(math.pi * j / (cols - 1))))
        for r in range(rows - 1):
            for j in range(cols - 1):
                a, b = r * cols + j, r * cols + j + 1
                faces.append((a, a + cols, b + cols, b))
        tl = part(f"tail{k}", verts, faces, 0)
        tl.data.materials.append(W.material("crew", out_dir))
        solidify(tl, 0.003, 0)
        tails.append(tl)
    ranges = append(o, [knot] + tails)
    thl = f"thigh_{B.left}"

    def tailw(co):
        t = min(1.0, max(0.0, (zk - co.z) / (zk - zt)))
        return {"pelvis": 1 - 0.7 * t, thl: 0.7 * t}
    transfer_weights(o, B, [(ranges[0], lambda co: {"pelvis": 1.0}), (ranges[1], tailw), (ranges[2], tailw)])
    return finish(o, B, "waist")


def belt(B, out_dir):
    zc = (B.hip + B.waist) / 2 - 0.01
    o = band(B, "belt", zc - 0.022, zc + 0.022, 0.023, ["leather", "leather", "leather", "gold"], out_dir, rows=3)
    solidify(o, 0.004, 0)
    r = B.support(zc, -math.pi / 2, 0.03) + 0.023
    c = B.ring_pt(zc, -math.pi / 2, r)
    append(o, [frame(c, Vector((0, -1, 0)), Vector((1, 0, 0)), 0.062, 0.052, 0.009, 0.005, 3)])
    transfer_weights(o, B, [(range(len(o.data.vertices) - 16, len(o.data.vertices)), lambda co: {"pelvis": 1.0})])
    return finish(o, B, "waist")


# ── legs ───────────────────────────────────────────────────────────────────────────────────────
def breeches(B, kind, out_dir):
    knee = kind == "knee"
    hem = B.knee - (0.05 if knee else 0.20)
    top = B.waist + 0.01

    def keep(i):
        p = B.P[i]
        return hem - 0.015 < p.z < top + 0.015 and B.w(i, "upperarm", "lowerarm", *HAND) < 0.2

    def off(i):
        z = B.P[i].z
        if knee:
            return 0.009 + 0.006 * math.exp(-((z - (B.hip + B.knee) / 2) / 0.12) ** 2)
        return 0.012 + 0.025 * smoothstep(B.hip, hem, z) ** 1.3
    bm, src = shell(B, keep, off, smooth=2 if knee else 4)
    bnd = [v for v in bm.verts if v.is_boundary]
    low = [v for v in bnd if v.co.z < B.knee + 0.08]
    for v in bnd:
        v.co.z = hem if v in low else top
    if knee:   # knee band: turned-back strip, 3.5 cm
        nv = extrude(bm, low, lambda v: v.co + B.leg_radial(v.co, B.side(v.co)) * 0.004, 0)
        extrude(bm, nv, lambda v: v.co + UP * 0.035 + B.leg_radial(v.co, B.side(v.co)) * 0.001, 0)
    else:      # rolled hem
        nv = extrude(bm, low, lambda v: v.co + B.leg_radial(v.co, B.side(v.co)) * 0.005 - UP * 0.004, 0)
        extrude(bm, nv, lambda v: v.co + UP * 0.018, 0)
    orient(B, bm)
    name = f"breeches_{kind}"
    cls = "breeches" if knee else "canvas"
    o = to_obj(name, bm, [cls, cls, cls, "gold"], out_dir)
    solidify(o, 0.0025, 0)
    bridge_folds(o, B, ["thigh_l", "thigh_r"])
    if knee:
        btn = []
        for s in "lr":
            k = B.b(f"calf_{s}")
            sgn = 1 if k.x > B.cx else -1
            for dz in (-0.03, -0.045):
                btn += buttons_on(o, [Vector((k.x, k.y, hem + 0.035 + dz + 0.03))], Vector((-sgn, 0, 0)), r=0.005)
        append(o, btn)
    transfer_weights(o, B)
    return finish(o, B, "legs")


def _hull2(pts):
    """2D convex hull (Andrew's monotone chain), counter-clockwise."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cr(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for q in pts:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], q) <= 0:
            lo.pop()
        lo.append(q)
    for q in reversed(pts):
        while len(up) >= 2 and cr(up[-2], up[-1], q) <= 0:
            up.pop()
        up.append(q)
    return lo[:-1] + up[:-1]


def _outline(pts, off, back, n):
    """offset convex outline of a point slab (Minkowski sum with a disc of radius off), resampled at n points of equal
    arc length, counter-clockwise, starting where a ray from the centroid along `back` leaves it (so consecutive rings
    of a loft correspond heel to heel and toe to toe)."""
    ring = [(x + off * math.cos(a), y + off * math.sin(a)) for (x, y) in _hull2(pts)
            for a in (2 * math.pi * k / 16 for k in range(16))]
    h = _hull2(ring)
    cx, cy = sum(q[0] for q in h) / len(h), sum(q[1] for q in h) / len(h)
    start, k0 = None, 0
    for k in range(len(h)):
        ax, ay = h[k]
        ex, ey = h[(k + 1) % len(h)][0] - ax, h[(k + 1) % len(h)][1] - ay
        den = back[0] * ey - back[1] * ex
        if abs(den) < 1e-12:
            continue
        t = ((ax - cx) * ey - (ay - cy) * ex) / den
        u = ((ax - cx) * back[1] - (ay - cy) * back[0]) / den
        if t > 0 and -1e-9 <= u <= 1 + 1e-9:
            start, k0 = (ax + u * ex, ay + u * ey), k
            break
    if start is None:
        start, k0 = h[0], 0
    path = [start] + [h[(k0 + 1 + j) % len(h)] for j in range(len(h))] + [start]
    seg = [math.dist(path[j], path[j + 1]) for j in range(len(path) - 1)]
    total, out, j, acc = sum(seg), [], 0, 0.0
    for m in range(n):
        want = total * m / n
        while acc + seg[j] < want:
            acc += seg[j]
            j += 1
        f = (want - acc) / max(seg[j], 1e-12)
        out.append((path[j][0] + f * (path[j + 1][0] - path[j][0]), path[j][1] + f * (path[j + 1][1] - path[j][1])))
    return out, (cx, cy)


def boots(B, kind, out_dir):
    """a boot is NOT a shell of the foot (b3.2d R2 own check: toes and the arch read through, footwear looked like
    socks). Each side is lofted from horizontal slices of the leg and foot: every ring is the convex outline of the
    skin within the slab around it (so the toes merge into one toe box and the arch is bridged), offset outward, with
    extra room over the toes. Below it a welted sole (outset, dark) and a stacked heel block at the back."""
    tall = kind == "tall"
    top = B.knee + 0.04 if tall else B.ankle + 0.035
    N = 20 if tall else 26   # shoes: a 20-gon toe box chord cut the stout and female toes (R2 budget pass)
    bm = bmesh.new()
    heels, tops = [], []
    for s in "lr":
        idx = [i for i in range(len(B.P)) if B.P[i].z < top + 0.03 and B.side(B.P[i]) == s
               and B.w(i, "upperarm", "lowerarm", *HAND) < 0.2 and B.w(i, "thigh", "calf", "foot", "ball") > 0.3]
        A = B.A[idx]
        zmin = float(A[:, 2].min())
        f3 = B.b(f"ball_{s}") - B.b(f"foot_{s}")
        fwd = Vector((f3.x, f3.y)).normalized()
        back = (-fwd.x, -fwd.y)
        toe_z = zmin + 0.045   # over the toes and the ball: the toe box

        def slab(z, half):
            sel = A[np.abs(A[:, 2] - z) <= half]
            if not len(sel):
                sel = A[np.abs(A[:, 2] - z) <= half + 0.02]
            return [(float(x), float(y)) for x, y in sel[:, :2]]

        def off(z):
            o = 0.007 + (0.010 * smoothstep(B.ankle + 0.02, B.ankle + 0.08, z) if tall else 0.0)
            return o + 0.007 * (1 - smoothstep(toe_z - 0.02, toe_z, z))   # toe box room (4 mm: a 26-gon chord poked the stout's toes)
        # ring heights: dense over the foot, sparser up the shaft
        zs, z = [], zmin + 0.016
        while z < top - 1e-4:
            zs.append(z)
            z += 0.014 if z < B.ankle + 0.06 else 0.045
        zs.append(top)
        rings = []   # (z, pts, material of the band BELOW this ring)
        sole_pts = slab(zmin + 0.006, 0.012)
        sole, c0 = _outline(sole_pts, off(zmin) + 0.005, back, N)
        rings.append((zmin - 0.008, sole, 2))
        rings.append((zmin + 0.009, sole, 2))
        up0, _ = _outline(sole_pts, off(zmin), back, N)
        rings.append((zmin + 0.009, up0, 0))
        for z in zs:
            # the slab is dilated vertically by the offset too, so a ring above the toes still clears them
            # the slab reaches half way to the next ring, so the straight band between two sparse rings still clears
            # the calf bulge between them (the R2 budget pass spaced shaft rings 4.5 cm)
            ring, _ = _outline(slab(z, max(off(z) + 0.004, 0.6 * (0.014 if z < B.ankle + 0.06 else 0.045))), off(z), back, N)
            rings.append((z, ring, 0))
        zt, rt, _ = rings[-1]
        cx, cy = sum(q[0] for q in rt) / N, sum(q[1] for q in rt) / N

        def flare(dr, dz):
            return (zt + dz, [(x + dr * (x - cx) / max(1e-6, math.hypot(x - cx, y - cy)),
                               y + dr * (y - cy) / max(1e-6, math.hypot(x - cx, y - cy))) for x, y in rt], 0)
        if tall:   # bucket top: flares out and up past the knee
            rings += [flare(0.012, 0.022), flare(0.032, 0.052)]
        else:      # shoe collar lip
            rings.append(flare(0.002, 0.006))
        vs = [[bm.verts.new((x, y, z)) for (x, y) in r] for (z, r, _) in rings]
        tops.append(vs[-1])
        for k in range(len(rings) - 1):
            for j in range(N):
                f = bm.faces.new((vs[k][j], vs[k][(j + 1) % N], vs[k + 1][(j + 1) % N], vs[k + 1][j]))
                f.material_index = rings[k][2] if k < 2 else 0
        cap = bm.verts.new((c0[0], c0[1], zmin - 0.008))
        for j in range(N):
            bm.faces.new((vs[0][(j + 1) % N], vs[0][j], cap)).material_index = 2
        # stacked heel: the back of the sole outline (behind 27% of the foot length), 3 cm tall, outset 2 mm
        proj = [(x - c0[0]) * fwd.x + (y - c0[1]) * fwd.y for x, y in sole]
        cut = min(proj) + 0.27 * (max(proj) - min(proj))
        arc = [j for j in list(range(N // 2, N)) + list(range(0, N // 2)) if proj[j] < cut]
        def toward(q, d):   # move an outline point d toward the sole centroid
            vx, vy = c0[0] - q[0], c0[1] - q[1]
            ln = max(1e-6, math.hypot(vx, vy))
            return (q[0] + d * vx / ln, q[1] + d * vy / ln)
        poly = [toward(sole[j], -0.002) for j in arc]
        inner = [toward(sole[j], 0.006) for j in arc]
        heels.append((poly, inner, zmin - 0.008, zmin + 0.030))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    orient(B, bm)
    for top_ring in tops:   # the lining lip: 4 mm in, 25 mm down (the leather reads thick at the opening, no solidify)
        cx_ = sum(v.co.x for v in top_ring) / N
        cy_ = sum(v.co.y for v in top_ring) / N

        def lip(v, d, dz):
            r = Vector((v.co.x - cx_, v.co.y - cy_, 0))
            return v.co - r.normalized() * d + UP * dz
        nv = extrude(bm, top_ring, lambda v: lip(v, 0.004, -0.002), 1)
        extrude(bm, nv, lambda v: lip(v, 0.0, -0.025), 1)
    o = to_obj(f"boots_{kind}", bm, ["boot", "boot", "band", "gold"], out_dir)
    parts = []
    for n_, (poly, inner, z0, z1) in enumerate(heels):
        # a C-section solid round the back of the sole: outer wall, top lift, inner wall buried in the upper, and
        # end caps. NOT a filled prism: that filled the heel of the foot and every ray from the foot bone to the heel
        # skin crossed its top (first loft build: shoes 38/23/42 pokes)
        m = len(poly)
        rows = [[(x, y, z0) for x, y in poly], [(x, y, z1) for x, y in poly],
                [(x, y, z1) for x, y in inner], [(x, y, z0) for x, y in inner]]
        verts = [q for r in rows for q in r]
        faces = [(a * m + j, a * m + j + 1, (a + 1) % 4 * m + j + 1, (a + 1) % 4 * m + j)
                 for a in range(4) for j in range(m - 1)]
        faces += [(3 * m, 2 * m, m, 0), (m - 1, 2 * m - 1, 3 * m - 1, 4 * m - 1)]
        parts.append(part(f"heel{n_}", verts, faces, 2))
    if not tall:
        for s in "lr":
            a, bb = B.b(f"foot_{s}"), B.b(f"ball_{s}")
            p = a.lerp(bb, 0.55)
            loc, n = hit(o, Vector((p.x, p.y, p.z + 0.3)), -UP)
            if loc is not None:
                parts.append(frame(loc, n, Vector((1, 0, 0)), 0.03, 0.024, 0.005, 0.003, 3))
    append(o, parts)
    transfer_weights(o, B)
    return finish(o, B, "feet")


def shirt_linen(B, out_dir):
    """R2 F2: the linen shirt every outfit wears first (no bare chest, no kit bra through the waistcoat V). Trunk +
    full sleeves (the cuff shows ~2 cm past the coat's 0.93 sleeve end), tucked: the hem sits under the breeches'
    waistband (breeches start at waist + 1 cm, 9-12 mm out; the shirt is 6 mm out), shallow open placket at the neck.
    Laid inside every other layer (coat 24/13 mm, jacket 19/12, waistcoat 13 mm)."""
    hem = B.hip - 0.02
    zv = B.neck - 0.085

    def keep(i):
        p = B.P[i]
        if B.w(i, *HAND) > 0.2 or B.w(i, "neck", "head") > 0.35 or p.z < hem - 0.015:
            return False
        if B.w(i, "upperarm", "lowerarm") > 0.3:
            return B.frac(p, B.side(p)) < 0.98
        if p.z > B.neck + 0.005:
            return False
        return not (p.y < B.cy and p.z > zv and abs(p.x - B.cx) < 0.035 * (p.z - zv) / max(0.03, B.neck - zv))

    def off(i):
        a = min(1.0, 1.5 * B.w(i, "upperarm", "lowerarm"))
        return 0.0075 * a + 0.006 * (1 - a)
    bm, src = shell(B, keep, off, smooth=4)
    bnd = [v for v in bm.verts if v.is_boundary]
    wrist = [v for v in bnd if B.w(v[src], "upperarm", "lowerarm") > 0.3 and B.frac(v.co, B.side(v.co)) > 0.7]
    for v in wrist:
        s = B.side(v.co)
        e, h = B.forearm(s)
        v.co -= (h - e) * (B.frac(v.co, s) - 0.98)
    for v in bnd:
        if v not in wrist and v.co.z < B.waist:
            v.co.z = hem
    fair_rims(B, bm, src, off)
    orient(B, bm)
    o = to_obj("shirt_linen", bm, ["linen", "linen"], out_dir)
    decimate(o, 0.42)
    solidify(o, 0.0015)
    bridge_folds(o, B, ["spine_02", "spine_03", "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"])
    refair_outer(o, B, max_corners=2, open_corners=0)
    if bridge_folds(o, B, ["spine_02", "spine_03", "upperarm_l", "upperarm_r"], passes=4):   # as upper(): the re-fair can uncover a fold
        refair_outer(o, B, max_corners=2, open_corners=0, passes=80)
    # the stout's shoulder fold: one decimated face chord under the skin seen from the bone (gate 1/1115 probes)
    o["heldOut"] = hold_out_radial(o, B, bones=("spine_02", "spine_03", "upperarm_l", "upperarm_r", "lowerarm_l",
                                                "lowerarm_r"), outer=0.003, lining=0.0015)
    transfer_weights(o, B)
    return finish(o, B, "shirt")


def dress(arm, meshes, body_id, out_dir, report):
    body = next(m for m in meshes if m.name == "body")
    B = Body(arm, body)
    CUR_BODY[:] = [B]
    new = [shirt_linen(B, out_dir), coat_frock(B, out_dir), coat_jacket(B, out_dir), vest_waistcoat(B, out_dir), sash(B, out_dir),
           belt(B, out_dir), breeches(B, "knee", out_dir), breeches(B, "slops", out_dir),
           boots(B, "tall", out_dir), boots(B, "shoes", out_dir)]
    report.setdefault(body_id, {})["wardrobeII"] = {
        "landmarks": {k: round(getattr(B, k), 4) for k in ("hip", "waist", "knee", "ankle", "shoulder", "neck")},
        "nodes": {o.name: {"tris": sum(len(p.vertices) - 2 for p in o.data.polygons),
                           "groups": sorted(g.name for g in o.vertex_groups)} for o in new}}
    return new


# ── review: posed weight QA (Workbench) and the R2 sheets (Cycles) in a fresh scene ─────────────
OUTFITS = {   # name: (body, nodes)
    "captain": ("male", ["hat_tricorn", "shirt_linen", "coat_frock", "vest_waistcoat", "sash", "breeches_knee", "boots_tall", "acc_earring"]),
    "deckhand": ("stout", ["hat_bandana", "shirt_linen", "coat_jacket", "belt", "breeches_slops", "boots_shoes"]),
    "bosun": ("female", ["hat_bicorn", "shirt_linen", "vest_waistcoat", "sash", "belt", "breeches_knee", "boots_tall"]),
    "gunner": ("male", ["hat_headscarf", "shirt_linen", "vest_waistcoat", "belt", "breeches_slops", "boots_shoes", "acc_eyepatch"]),
}
POSES = [("idle", 10), ("crouch_idle", 10), ("aim_pistol_up", 10), ("helm", 10), ("walk", 5), ("cutlass_heavy", 12)]


def _load_clips(repo):
    import json
    import struct
    from mathutils import Quaternion
    path = os.path.join(repo, "public", "assets", "models", "pirate_clips.glb")
    sc = bpy.context.scene
    before = set(sc.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    raw = open(path, "rb").read()
    jl = struct.unpack("<I", raw[12:16])[0]
    G = json.loads(raw[20:20 + jl])
    # names may carry .001 in a scene that already holds objects; bone names never contain a dot
    E = {o.name.split(".")[0]: o for o in sc.objects if o not in before and o.type == "EMPTY"}
    for n in G["nodes"]:
        o = E.get(n["name"])
        if o is None:
            continue
        if o.animation_data:
            o.animation_data.action = None
            for t in o.animation_data.nla_tracks:
                t.mute = True
        if o.parent is None:
            continue
        t, r = n.get("translation", [0, 0, 0]), n.get("rotation", [0, 0, 0, 1])
        o.rotation_mode = "QUATERNION"
        o.location = (t[0], -t[2], t[1])
        o.rotation_quaternion = Quaternion((r[3], r[0], -r[2], r[1]))
    bpy.context.view_layer.update()
    acts = {a.name: a for a in bpy.data.actions}
    for o in E.values():   # rest, restored before every bind (a posed empty would bake its pose into the offset)
        o["rest"] = [*o.location, *(o.rotation_quaternion if o.rotation_mode == "QUATERNION" else (1, 0, 0, 0))]
    return E, acts, [o for o in sc.objects if o not in before]


def _pose(E, acts, clip, k):
    a = acts.get(clip) or next((x for n, x in acts.items() if n.split("_Armature")[0] == clip), None)
    if a is None:
        print("MISSING clip", clip)
        return
    for name, o in E.items():
        slot = next((s for s in a.slots if s.identifier == "OB" + o.name), None)
        if slot is None:
            slot = next((s for s in a.slots if s.identifier == "OB" + name), None)
        if slot is None:
            continue
        ad = o.animation_data_create()
        ad.action = a
        ad.action_slot = slot
    f0, f1 = a.frame_range
    fr = f0 + (f1 - f0) * k / 20.0
    bpy.context.scene.frame_set(int(fr), subframe=fr - int(fr))


def _bind(E, arm):
    for o in E.values():
        if o.animation_data:
            o.animation_data.action = None
        if o.parent is not None and o.rotation_mode == "QUATERNION":
            r = list(o["rest"])
            o.location, o.rotation_quaternion = r[:3], r[3:]
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    offs, cons = [], []
    for pb in arm.pose.bones:
        e = E.get(pb.name)
        if e is None:
            continue
        off = bpy.data.objects.new("off_" + pb.name, None)
        bpy.context.scene.collection.objects.link(off)
        off.parent = e
        off.matrix_world = arm.matrix_world @ pb.bone.matrix_local
        c = pb.constraints.new("COPY_TRANSFORMS")
        c.target = off
        offs.append(off)
        cons.append((pb, c))
    return offs, cons


def _montage(tiles_rows, path):
    rows = [np.concatenate(r, axis=1) for r in tiles_rows]
    sheet = np.concatenate(rows[::-1], axis=0)
    img = bpy.data.images.new(os.path.basename(path), sheet.shape[1], sheet.shape[0], alpha=True)
    img.pixels.foreach_set(sheet.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    print("wrote", path)


def _shot(cam, loc, tgt, lens, w, h, tmp):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = w, h
    cam.data.lens = lens
    cam.location = loc
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp)
    px = np.array(img.pixels[:]).reshape(h, w, 4)
    bpy.data.images.remove(img)
    os.remove(tmp)
    return px


def review_sheets(built, repo, setup_render, cycles=True):
    """Runs in the build scene (textured materials), after export: clips drive each body through offset empties."""
    sheet_dir = os.path.join(repo, "docs", "asset-sheets", "characters", "wardrobe-ii")
    os.makedirs(sheet_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    E, acts, clip_objs = _load_clips(repo)
    for m in bpy.data.materials:   # Workbench MATERIAL colour for the untinted base materials
        if m.name.startswith("MI_body"):
            m.diffuse_color = (0.62, 0.43, 0.31, 1)
        elif m.name.startswith("MI_Hair"):
            m.diffuse_color = (0.05, 0.035, 0.02, 1)
    cam = sc.camera or bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam
    tmp = "/tmp/pbr-b32d-tile.png"
    lineup = {False: [], True: []}
    all_meshes = [o for _, ms in built.values() for o in ms]
    for name, (b, nodes) in OUTFITS.items():
        arm, meshes = built[b]
        arm.location = (0, 0, 0)
        hat = any(n.startswith("hat_") for n in nodes)
        show = {"body", "eyes", "brows"} | set(nodes)
        for o in meshes:
            nm = o.name[len(b) + 1:]
            if nm.startswith("hair_") and o.get("pirateDefault"):
                show.add(nm + "_hat" if hat and "beard" not in nm else nm)
        for o in all_meshes:
            o.hide_render = not (o in meshes and o.name[len(b) + 1:] in show)
        offs, cons = _bind(E, arm)
        sc.render.engine = "BLENDER_WORKBENCH"
        sc.display.shading.light = "STUDIO"
        sc.display.shading.color_type = "MATERIAL"
        sc.display.shading.show_cavity = True
        sc.world = sc.world or bpy.data.worlds.new("w")
        sc.world.color = (0.55, 0.6, 0.66)
        g = bpy.data.objects.get("ground")
        if g:
            g.hide_render = True
        fronts, sides = [], []
        for clip, k in POSES:
            _pose(E, acts, clip, k)
            pel = arm.matrix_world @ arm.pose.bones["pelvis"].head
            tgt = Vector((pel.x, pel.y, max(pel.z, 0.5) + 0.2))
            fronts.append(_shot(cam, tgt + Vector((0.9, -3.6, 0.3)), tgt, 50, 300, 440, tmp))
            sides.append(_shot(cam, tgt + Vector((3.7, -0.4, 0.3)), tgt, 50, 300, 440, tmp))
        _montage([fronts, sides], os.path.join(sheet_dir, f"qa-{name}-poses.png"))
        if cycles:
            _pose(E, acts, "idle", 0)
            for night in (False, True):
                setup_render(night)
                sc.cycles.samples = 16
                g = bpy.data.objects.get("ground")
                if g:
                    g.hide_render = False
                lineup[night].append(_shot(cam, (0, -20, 1.0), (0, 0, 0.9), 85, 240, 540, tmp))
                if name in ("captain", "deckhand"):
                    row = []
                    for ang in (0, 40, 90, 180):
                        a = math.radians(ang)
                        row.append(_shot(cam, (4.6 * math.sin(a), -4.6 * math.cos(a), 1.0), (0, 0, 0.9), 40, 360, 540, tmp))
                    tag = "night" if night else "noon"
                    _montage([row], os.path.join(sheet_dir, f"r2-{name}-turntable-{tag}.png"))
                    head = arm.matrix_world @ arm.pose.bones["head"].head
                    t = (head.x, head.y, head.z + 0.1)
                    face = _shot(cam, (t[0] + 0.34, t[1] - 0.94, t[2] + 0.02), t, 50, 400, 400, tmp)
                    _montage([[face]], os.path.join(sheet_dir, f"r2-{name}-face-1m-{tag}.png"))
        for pb, c in cons:
            pb.constraints.remove(c)
        for o in offs:
            bpy.data.objects.remove(o, do_unlink=True)
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix.Identity(4)
    for o in all_meshes:
        o.hide_render = True
    for o in clip_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    if cycles:
        for night, tiles in lineup.items():
            _montage([tiles], os.path.join(sheet_dir, f"r2-crew-lineup-20m-{'night' if night else 'noon'}.png"))
