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
SLOTS = ("coat_frock", "coat_jacket", "vest_waistcoat", "sash", "belt", "breeches_knee", "breeches_slops",
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
def shell(B, keep, off, smooth=2):
    bm = bmesh.new()
    src = bm.verts.layers.int.new("src")
    vmap = {}
    eff = {}

    def off_eff(i):   # where the body faces itself (inner thighs, a stout armpit) the two shells share the gap
        if i not in eff:
            hit_, _, _, d = B.bvh.ray_cast(B.P[i] + B.N[i] * 0.002, B.N[i], 0.12)
            eff[i] = off(i) if hit_ is None else min(off(i), 0.45 * (d + 0.002))
        return eff[i]
    for i, p in enumerate(B.P):
        if keep(i):
            v = bm.verts.new(p + B.N[i] * off_eff(i))
            v[src] = i
            vmap[i] = v
    for f in B.F:
        if all(i in vmap for i in f):
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
    relax(B, bm, src, off_eff, smooth)
    return bm, src


def relax(B, bm, src, off, passes):
    for _ in range(passes):
        bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if not v.is_boundary], factor=0.5,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    for v in bm.verts:   # clearance: never nearer the skin than 80% of the layer offset
        loc, n, _, _ = B.bvh.find_nearest(v.co)
        if loc is None:
            continue
        k = 0.8 * off(v[src])
        s = (v.co - loc).dot(n)
        if s < k:
            v.co += n * (k - s)


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
    m.material_offset = mat_offset
    m.material_offset_rim = mat_offset
    with ctx(o):
        bpy.ops.object.modifier_apply(modifier=m.name)


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
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=12, radius1=r, radius2=r * 0.78, depth=depth)
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
def upper(B, name, hem, torso_off, arm_off, gap, mats, out_dir, cuff, lapels, collar):
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
        extrude(bm, neck, up, 0)
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
    solidify(o, 0.0032)
    return o


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
    rows, cols = 16, 22
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
    orient(B, bm)
    o = to_obj("vest_waistcoat", bm, ["brocade", "crew", "crew", "gold"], out_dir)
    o.data.materials[1] = W.material("breeches", out_dir)   # plain wool back lining, not the crew colour
    o.data.materials[2] = W.material("breeches", out_dir)
    solidify(o, 0.0025)
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


def boots(B, kind, out_dir):
    tall = kind == "tall"
    top = B.knee + 0.04 if tall else B.ankle + 0.035

    def keep(i):
        return B.P[i].z < top + 0.015 and B.w(i, "upperarm", "lowerarm", *HAND) < 0.2

    def off(i):
        if B.N[i].z < -0.5:
            return 0.006
        return 0.007 + (0.010 * smoothstep(B.ankle + 0.02, B.ankle + 0.08, B.P[i].z) if tall else 0.0)
    bm, src = shell(B, keep, off, smooth=2)
    # only the TOP rim: the kit foot has its own sole boundary, and snapping that to the knee made pillars
    top_v = [v for v in bm.verts if v.is_boundary and v.co.z > top - 0.04]
    for v in top_v:
        v.co.z = top
    if tall:   # bucket top: flares out and up past the knee
        nv = extrude(bm, top_v, lambda v: v.co + B.leg_radial(v.co, B.side(v.co)) * 0.012 + UP * 0.022, 0)
        extrude(bm, nv, lambda v: v.co + B.leg_radial(v.co, B.side(v.co)) * 0.02 + UP * 0.03, 0)
    else:      # shoe collar lip
        extrude(bm, top_v, lambda v: v.co + B.leg_radial(v.co, B.side(v.co)) * 0.002 + UP * 0.006, 0)
    orient(B, bm)
    o = to_obj(f"boots_{kind}", bm, ["leather", "leather", "leather", "gold"], out_dir)
    solidify(o, 0.003, 0)
    if not tall:
        parts = []
        for s in "lr":
            a, bb = B.b(f"foot_{s}"), B.b(f"ball_{s}")
            p = a.lerp(bb, 0.55)
            loc, n = hit(o, Vector((p.x, p.y, p.z + 0.3)), -UP)
            if loc is not None:
                parts.append(frame(loc, n, Vector((1, 0, 0)), 0.03, 0.024, 0.005, 0.003, 3))
        append(o, parts)
    transfer_weights(o, B)
    return finish(o, B, "feet")


def dress(arm, meshes, body_id, out_dir, report):
    body = next(m for m in meshes if m.name == "body")
    B = Body(arm, body)
    new = [coat_frock(B, out_dir), coat_jacket(B, out_dir), vest_waistcoat(B, out_dir), sash(B, out_dir),
           belt(B, out_dir), breeches(B, "knee", out_dir), breeches(B, "slops", out_dir),
           boots(B, "tall", out_dir), boots(B, "shoes", out_dir)]
    report.setdefault(body_id, {})["wardrobeII"] = {
        "landmarks": {k: round(getattr(B, k), 4) for k in ("hip", "waist", "knee", "ankle", "shoulder", "neck")},
        "nodes": {o.name: {"tris": sum(len(p.vertices) - 2 for p in o.data.polygons),
                           "groups": sorted(g.name for g in o.vertex_groups)} for o in new}}
    return new


# ── review: posed weight QA (Workbench) and the R2 sheets (Cycles) in a fresh scene ─────────────
OUTFITS = {   # name: (body, nodes)
    "captain": ("male", ["hat_tricorn", "coat_frock", "vest_waistcoat", "sash", "breeches_knee", "boots_tall", "acc_earring"]),
    "deckhand": ("stout", ["hat_bandana", "coat_jacket", "belt", "breeches_slops", "boots_shoes"]),
    "bosun": ("female", ["hat_bicorn", "vest_waistcoat", "sash", "belt", "breeches_knee", "boots_tall"]),
    "gunner": ("male", ["hat_headscarf", "vest_waistcoat", "belt", "breeches_slops", "boots_shoes", "acc_eyepatch"]),
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
