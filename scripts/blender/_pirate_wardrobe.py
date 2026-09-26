"""Pirate wardrobe I (b3.2c, characters-01/03): rigid head-chain items, scripted on each normalised body.

  hat_tricorn    felt crown fitted to the skull + a brim cocked up on three sides (corner forward), crew braid
  hat_bicorn     felt crown + a crescent brim folded up fore and aft (worn athwart), gold edge, crew cockade
  hat_bandana    close cotton cap in the crew colour, rolled hem, knot and two short tails at the back
  hat_headscarf  fuller wrap with gathered folds, thick rolled hem, knot at the back-right, long tails
  acc_eyepatch   stiff leather patch over the right eye, projected on the face, strap round the head
  acc_earring    gold hoop through the left ear lobe
  hair_<style>_hat  hat-safe cut of every hair style except the beard: nothing above the hat line

Every item is a separate node, 100% weighted to the head joint, parented to the body's armature, hidden in
renders and not a default (the client toggles variants). All hats share one HAT LINE per body: a plane
through the mid-forehead (eye + 4.8 cm) and the occiput (eye + 1.2 cm), tilted down toward the back as a hat
sits, clear of the ear tops. Crowns are ray-cast from a point on that plane onto the skull, so the fit
follows each body's own head; nothing of a hat reaches below the line and every hat-safe cut stops 4 mm
under it, which is what test-character-asset measures (rays from the head centre, not this construction).

Materials carry generated tileable albedo + normal maps (T_wardrobe_<class>_*.png, authored here, CC0) and
extras {wardrobeTint, wardrobeClass, crewTint}; build_pirates.tint_factors writes wardrobeTint as the glTF
baseColorFactor. crewTint marks the mask the client tints with the crew colour (characters-03).
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

X = Vector((1, 0, 0))
N_SEG = 32          # around the crown (R2 F9: 64 x 32 rows made the tricorn 9,216 tris)
K_ROWS = 9          # pole to hat line
M_BRIM = 7          # hat line to brim edge
CUT_MARGIN = 0.004  # hat-safe cuts stop this far under the hat line

MATS = {  # class: (linear tint, roughness, metallic, crew mask)
    "felt": ((0.030, 0.024, 0.020), 0.88, 0.0, False),
    "band": ((0.012, 0.010, 0.009), 0.7, 0.0, False),
    "crew": ((0.55, 0.06, 0.05), 0.8, 0.0, True),
    "scarf": ((0.42, 0.24, 0.07), 0.85, 0.0, False),
    "leather": ((0.022, 0.016, 0.012), 0.55, 0.0, False),
    "gold": ((0.76, 0.46, 0.10), 0.3, 1.0, False),   # R2 F8: (0.83, 0.62, 0.26) rendered grey-silver (sRGB sat 0.41)
    "boot": ((0.16, 0.085, 0.035), 0.5, 0.0, False),   # R2 F7: mid-brown boot leather, 1.6x the breeches' value (near-black boots read as stockings)
    # b3.2d wardrobe II (_pirate_wardrobe_cloth.py): body garments share this one material set
    "wool": ((0.018, 0.026, 0.060), 0.9, 0.0, False),       # frock coat / short jacket broadcloth, navy
    "canvas": ((0.36, 0.32, 0.25), 0.92, 0.0, False),       # slops, sailcloth duck, undyed
    "brocade": ((0.34, 0.20, 0.035), 0.75, 0.0, False),     # waistcoat, ochre damask
    "breeches": ((0.085, 0.058, 0.036), 0.88, 0.0, False),  # knee breeches, brown wool
}


# ── textures (tileable, generated: our own work, no third-party source) ──────────────────────────
def _noise(n, fc, seed):
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)
    r = np.sqrt(f[:, None] ** 2 + f[None, :] ** 2)
    h = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((n, n))) * np.exp(-(r / fc) ** 2)))
    return (h - h.mean()) / (h.std() + 1e-9)


def _height(cls, n=512):
    y, x = np.mgrid[0:n, 0:n] / n
    if cls in ("felt", "band"):
        return 0.6 * _noise(n, 0.08, 1) + 0.25 * _noise(n, 0.3, 2)
    if cls in ("crew", "scarf"):   # cotton twill: diagonal ribs + slub
        return 0.7 * np.sin(2 * math.pi * 48 * (x + y)) * (0.8 + 0.2 * _noise(n, 0.02, 3)) + 0.3 * _noise(n, 0.1, 4)
    if cls in ("wool", "breeches"):   # fulled broadcloth: fine felted nap + a faint twill
        return 0.5 * _noise(n, 0.12, 21) + 0.25 * np.sin(2 * math.pi * 64 * (x + y)) + 0.2 * _noise(n, 0.35, 22)
    if cls == "canvas":   # plain weave: warp x weft ridges + slub
        return 0.45 * np.sin(2 * math.pi * 72 * x) * np.sin(2 * math.pi * 72 * y) + 0.35 * _noise(n, 0.04, 23)
    if cls == "brocade":   # damask: a low motif (sin lattice) over a satin rib
        motif = np.cos(2 * math.pi * 6 * x) * np.cos(2 * math.pi * 6 * y) + 0.5 * np.cos(2 * math.pi * 12 * (x - y))
        return 0.6 * np.tanh(2 * motif) + 0.2 * np.sin(2 * math.pi * 96 * y)
    if cls in ("leather", "boot"):
        g = _noise(n, 0.12, 5)
        return np.abs(g) * -0.8 + 0.3 * _noise(n, 0.4, 6)
    return 0.4 * _noise(n, 0.3, 7)   # gold: faint hammering


def _save(path, rgb, non_color):
    n = rgb.shape[0]
    img = bpy.data.images.new(os.path.basename(path), n, n, alpha=False)
    rgba = np.concatenate([rgb, np.ones((n, n, 1))], axis=2)[::-1].astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img.filepath = path
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def _textures(cls, out_dir):
    h = _height(cls)
    # R2 F8: at 1 m every cloth read as the same coarse stucco: cloth normal strength halved, felt near-smooth
    strength = {"felt": 0.45, "band": 0.8, "crew": 0.45, "scarf": 0.45, "leather": 1.6, "boot": 1.2, "gold": 0.5,
                "wool": 0.5, "canvas": 0.55, "brocade": 0.5, "breeches": 0.5}.get(cls, 1.0)
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    nrm = np.stack([-dx, dy, np.ones_like(h)], axis=2)
    nrm /= np.linalg.norm(nrm, axis=2, keepdims=True)
    cloth = cls in ("crew", "scarf", "wool", "canvas", "brocade", "breeches")   # cotton: faint slub only (0.06 read as cork on the headscarf, set c)
    alb = np.clip(0.82 + (0.02 if cloth else 0.06) * _noise(h.shape[0], 0.05, 11) + (0.01 if cloth else 0.03) * h, 0.6, 1.0)
    a = _save(os.path.join(out_dir, f"T_wardrobe_{cls}_BaseColor.png"), np.repeat(alb[:, :, None], 3, axis=2), False)
    nm = _save(os.path.join(out_dir, f"T_wardrobe_{cls}_Normal.png"), nrm * 0.5 + 0.5, True)
    return a, nm


_MAT_CACHE = {}


def material(cls, out_dir):
    if cls in _MAT_CACHE:
        return _MAT_CACHE[cls]
    tint, rough, metal, crew = MATS[cls]
    a, nm = _textures(cls, out_dir)
    m = bpy.data.materials.new(f"MI_wardrobe_{cls}")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    ta = nt.nodes.new("ShaderNodeTexImage")
    ta.image = a
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = nm
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    mix = nt.nodes.new("ShaderNodeMix")   # image x tint (the hair's pattern: tint_factors writes the factor)
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    ca = next(x for x in mix.inputs if x.name == "A" and x.type == "RGBA")
    cb = next(x for x in mix.inputs if x.name == "B" and x.type == "RGBA")
    cb.default_value = (*tint, 1)
    nt.links.new(ta.outputs["Color"], ca)
    nt.links.new(next(x for x in mix.outputs if x.type == "RGBA"), bsdf.inputs["Base Color"])
    nt.links.new(tn.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    m.diffuse_color = (*tint, 1)
    m["wardrobeTint"] = list(tint)
    m["wardrobeClass"] = cls
    m["crewTint"] = crew
    _MAT_CACHE[cls] = m
    return m


# ── geometry helpers ──────────────────────────────────────────────────────────────────────────
def _world_bvh(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    V, P = [], []
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        base = len(V)
        V += [e.matrix_world @ v.co for v in me.vertices]
        P += [[base + i for i in p.vertices] for p in me.polygons]
        e.to_mesh_clear()
    return BVHTree.FromPolygons(V, P), V


def _mesh_obj(name, verts, faces, uvs=None, mat_idx=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    if uvs is not None:
        uvl = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li, vi in zip(poly.loop_indices, poly.vertices):
                uvl.data[li].uv = uvs[vi]
    if mat_idx is not None:
        for poly, k in zip(me.polygons, mat_idx):
            poly.material_index = k
    me.validate()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _grid(name, rows, pole=None, closed=True, v_scale=1.0, u_tiles=4, mat_rows=None):
    """rows: list of point lists (same length); optional pole vertex before the first row."""
    verts, uvs, faces, mids = [], [], [], []
    n = len(rows[0])
    if pole is not None:
        verts.append(pole)
        uvs.append((0.5 * u_tiles, 0))
    off = len(verts)
    acc = 0.0
    for r, row in enumerate(rows):
        if r:
            acc += sum((a - b).length for a, b in zip(row, rows[r - 1])) / n
        for j, p in enumerate(row):
            verts.append(p)
            uvs.append((u_tiles * j / (n if closed else n - 1), acc * v_scale))
    cols = n if closed else n - 1
    if pole is not None:
        for j in range(cols):
            faces.append((0, off + (j + 1) % n, off + j))
            mids.append(mat_rows(0) if mat_rows else 0)
    for r in range(len(rows) - 1):
        for j in range(cols):
            a, b = off + r * n + j, off + r * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
            mids.append(mat_rows(r + 1) if mat_rows else 0)
    # seam: closed grids share the last column's UV with the first (u wraps visibly only at one meridian)
    return _mesh_obj(name, verts, faces, uvs, mids)


def _tube(name, pts, radius, closed=True, seg=8):
    n = len(pts)
    rows = []
    for i, p in enumerate(pts):
        t = (pts[(i + 1) % n] - pts[i - 1]) if closed else (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)])
        t.normalize()
        a = t.cross(Vector((0, 0, 1)))
        if a.length < 1e-4:
            a = t.cross(X)
        a.normalize()
        b = t.cross(a)
        rows.append([p + radius * (math.cos(2 * math.pi * k / seg) * a + math.sin(2 * math.pi * k / seg) * b) for k in range(seg)])
    verts, uvs, faces = [], [], []
    for i, row in enumerate(rows):
        for k, q in enumerate(row):
            verts.append(q)
            uvs.append((k / seg, i * 0.25))
    last = n if closed else n - 1
    for i in range(last):
        for k in range(seg):
            a = i * seg + k
            b = i * seg + (k + 1) % seg
            c = ((i + 1) % n) * seg + (k + 1) % seg
            d = ((i + 1) % n) * seg + k
            faces.append((a, b, c, d))
    return _mesh_obj(name, verts, faces, uvs)


def _solidify(o, thickness, offset=1.0):
    m = o.modifiers.new("solid", "SOLIDIFY")
    m.thickness = thickness
    m.offset = offset
    m.use_even_offset = True
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
        bpy.ops.object.modifier_apply(modifier=m.name)


def _rig(o, arm):
    for vg in list(o.vertex_groups):
        o.vertex_groups.remove(vg)
    g = o.vertex_groups.new(name="head")
    g.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    mw = o.matrix_world.copy()
    o.parent = arm
    o.matrix_world = mw
    m = o.modifiers.new("Armature", "ARMATURE")
    m.object = arm
    for p in o.data.polygons:
        p.use_smooth = True
    try:   # creases (hat line, brim edge, patch rim) stay crisp; the glTF exporter splits normals there
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
    except Exception as ex:   # noqa: BLE001  (older Blender: smooth everywhere)
        print("shade_smooth_by_angle unavailable:", ex)
    o["pirateDefault"] = False
    o.hide_render = True
    return o


# ── the head frame: hat line, skull fit ───────────────────────────────────────────────────────
class Frame:
    def __init__(self, arm, body):
        self.bvh, V = _world_bvh([body])
        hi = body.vertex_groups["head"].index
        el = arm.matrix_world @ arm.data.bones["eye_l"].head_local
        er = arm.matrix_world @ arm.data.bones["eye_r"].head_local
        self.el, self.er = el, er
        self.eye_z = (el.z + er.z) / 2
        head = [V[v.index] for v in body.data.vertices
                if v.groups and max(v.groups, key=lambda g: g.weight).group == hi]
        self.head = head
        cran = [p for p in head if p.z > self.eye_z - 0.03]
        c = sum(cran, Vector()) / len(cran)
        c.x = 0.0
        self.c = c
        zf, zb = self.eye_z + 0.048, self.eye_z + 0.012
        yf = self._hit(Vector((0, c.y, zf)), Vector((0, -1, 0))).y
        yb = self._hit(Vector((0, c.y, zb)), Vector((0, 1, 0))).y
        F, B = Vector((0, yf, zf)), Vector((0, yb, zb))
        d = B - F
        n = Vector((0, -d.z, d.y)).normalized()
        self.n = n if n.z > 0 else -n
        self.o = c - (c - F).dot(self.n) * self.n
        self.u = X.copy()
        self.v = self.n.cross(self.u).normalized()   # +v = toward the back
        self.front, self.back = F, B

    def _hit(self, org, d):
        loc, _, _, _ = self.bvh.ray_cast(org, d.normalized(), 1.0)
        return loc if loc is not None else org + 0.09 * d.normalized()

    def radial(self, phi):   # in-plane unit: phi 0 = +X (left), 90 = back, 180 = right, 270 = front
        return math.cos(phi) * self.u + math.sin(phi) * self.v

    def dir(self, phi, theta):
        return math.cos(theta) * self.n + math.sin(theta) * self.radial(phi)

    def above(self, p):
        return (p - self.o).dot(self.n)

    def skull(self):
        """r[k][j] from the hat-line centre to the skin, k = 1..K rows (theta k/K x 90 deg), j = N_SEG columns."""
        if hasattr(self, "_r"):
            return self._r
        r = []
        for k in range(1, K_ROWS + 1):
            th = math.radians(90.0 * k / K_ROWS)
            row = []
            for j in range(N_SEG):
                d = self.dir(2 * math.pi * j / N_SEG, th)
                row.append((self._hit(self.o, d) - self.o).length)
            r.append(row)
        pole = (self._hit(self.o, self.n) - self.o).length
        self._r = (pole, r)
        return self._r


def _crown_rows(fr, off, raise_, wrinkle=None):
    pole_r, raw = fr.skull()
    sm = [row[:] for row in raw]
    for _ in range(4):   # smooth the fit (felt does not follow every skull bump), both directions
        nxt = []
        for k, row in enumerate(sm):
            up = sm[k - 1] if k else [pole_r] * N_SEG
            dn = sm[k + 1] if k + 1 < len(sm) else row
            nxt.append([0.4 * row[j] + 0.15 * (row[j - 1] + row[(j + 1) % N_SEG] + up[j] + dn[j]) for j in range(N_SEG)])
        sm = nxt
    rows = []
    for k in range(K_ROWS):
        th = math.radians(90.0 * (k + 1) / K_ROWS)
        row = []
        for j in range(N_SEG):
            phi = 2 * math.pi * j / N_SEG
            rr = max(sm[k][j] + off, raw[k][j] + 0.6 * off) + raise_ * math.cos(th) ** 1.6
            if wrinkle:
                rr += wrinkle(phi, th)
            row.append(fr.o + rr * fr.dir(phi, th))
        rows.append(row)
    pole = fr.o + (pole_r + off + raise_) * fr.n
    return pole, rows


def _brim_rows(fr, ring, a_f, b_f, A_f):
    rows = []
    for i in range(1, M_BRIM + 1):
        s = i / M_BRIM
        row = []
        for j, p in enumerate(ring):
            phi = 2 * math.pi * j / N_SEG
            A = math.radians(A_f(phi))
            row.append(p + a_f(phi) * math.sin(s * A) * fr.radial(phi) + b_f(phi) * (1 - math.cos(s * A)) * fr.n)
        rows.append(row)
    return rows


def _lerp(a, b, t):
    return a + (b - a) * t


def _cocked_hat(name, fr, arm, out_dir, a_f, b_f, A_f, raise_, trim_cls, extra=None):
    pole, crown = _crown_rows(fr, 0.012, raise_)
    brim = _brim_rows(fr, crown[-1], a_f, b_f, A_f)
    shell = _grid(f"{name}_shell", crown + brim, pole=pole, v_scale=6.0,
                  mat_rows=lambda r: 1 if K_ROWS - 1 <= r <= K_ROWS else 0)   # the band: ~20 deg of crown at 9 rows
    shell.data.materials.append(material("felt", out_dir))
    shell.data.materials.append(material("band", out_dir))
    if shell.data.polygons[0].normal.dot(fr.n) < 0:   # the pole fan must face up/out: solidify goes outward
        bm = bmesh.new()
        bm.from_mesh(shell.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(shell.data)
        bm.free()
    _solidify(shell, 0.0035)
    edge = [p + 0.002 * fr.n for p in brim[-1]]
    braid = _tube(f"{name}_trim", edge, 0.0032, seg=5)
    braid.data.materials.append(material(trim_cls, out_dir))
    parts = [shell, braid] + (extra(brim) if extra else [])
    with bpy.context.temp_override(active_object=shell, selected_editable_objects=parts, selected_objects=parts):
        bpy.ops.object.join()
    shell.name = shell.data.name = name
    return _rig(shell, arm)


def tricorn(fr, arm, out_dir):
    corner = lambda phi: ((1 + math.cos(3 * (phi - math.radians(270)))) / 2) ** 4   # a corner points forward
    return _cocked_hat("hat_tricorn", fr, arm, out_dir,
                       a_f=lambda p: _lerp(0.035, 0.12, corner(p)), b_f=lambda p: _lerp(0.095, 0.16, corner(p)),
                       A_f=lambda p: _lerp(95, 70, corner(p)), raise_=0.012, trim_cls="crew")


def bicorn(fr, arm, out_dir):
    side = lambda phi: abs(math.cos(phi)) ** 3      # tips over the ears, tall crescent walls fore and aft

    def cockade(brim):
        j = int(N_SEG * (270 + 28) / 360) % N_SEG   # front wall, left of centre
        s = int(M_BRIM * 0.62)
        p, q, r = brim[s][j], brim[s][(j + 1) % N_SEG], brim[s + 1][j]
        nrm = (q - p).cross(r - p).normalized()
        if nrm.dot(fr.radial(math.radians(298))) < 0:
            nrm = -nrm
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.021, depth=0.005, calc_uvs=True,
                                            location=p + 0.006 * nrm, rotation=nrm.to_track_quat("Z", "Y").to_euler())
        co = bpy.context.active_object
        co.name = "cockade"
        co.data.materials.append(material("crew", out_dir))
        return [co]
    return _cocked_hat("hat_bicorn", fr, arm, out_dir,
                       a_f=lambda p: _lerp(0.024, 0.13, side(p)), b_f=lambda p: _lerp(0.115, 0.075, side(p)),
                       A_f=lambda p: _lerp(102, 58, side(p)), raise_=0.008, trim_cls="gold", extra=cockade)


def _cloth_cap(name, fr, arm, out_dir, cls, off, fold, hem_r, knot_phi, tail_len, tail_w):
    def wrinkle(phi, th):   # gathered folds toward the knot, flat on the forehead
        near = max(0.0, math.cos(phi - knot_phi)) ** 2
        return fold * near * math.sin(14 * phi) * (th / (math.pi / 2)) ** 2
    pole, crown = _crown_rows(fr, off, 0.0, wrinkle)
    cap = _grid(f"{name}_cap", crown, pole=pole, v_scale=6.0)
    if cap.data.polygons[0].normal.dot(fr.n) < 0:
        bm = bmesh.new()
        bm.from_mesh(cap.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(cap.data)
        bm.free()
    _solidify(cap, 0.0018)
    ring = crown[-1]
    hem = _tube(f"{name}_hem", [p + hem_r * fr.n + 0.6 * hem_r * (p - fr.o - (p - fr.o).dot(fr.n) * fr.n).normalized()
                                for p in ring], hem_r)
    j = int(round(knot_phi / (2 * math.pi) * N_SEG)) % N_SEG
    rad = fr.radial(knot_phi)
    kc = ring[j] + 0.014 * rad + 0.010 * fr.n
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0, location=kc, calc_uvs=True)
    knot = bpy.context.active_object
    knot.scale = (0.022, 0.017, 0.016)
    knot.rotation_euler = rad.to_track_quat("Y", "Z").to_euler()
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    parts = [cap, hem, knot]
    side = fr.n.cross(rad).normalized()
    for sgn in (-1, 1):   # two tails: a strip out of the knot, drooping down and away from the head
        pts = []
        for i in range(9):
            t = i / 8
            drop = tail_len * t
            # cloth hangs: mostly down, a little out from the nape, a slight spread and swing
            p = kc + (0.012 + 0.30 * drop + 0.25 * drop * t) * rad - drop * fr.n + sgn * (0.006 + 0.14 * drop) * side
            pts.append(p)
        rows = []
        for i, p in enumerate(pts):
            w = tail_w * (1 - 0.45 * i / 8)
            rows.append([p - 0.5 * w * side, p + 0.5 * w * side])
        verts = [q for row in rows for q in row]
        faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(rows) - 1)]
        uvs = [(k, i * 0.5) for i in range(len(rows)) for k in (0, 1)]
        tail = _mesh_obj(f"{name}_tail{sgn}", verts, faces, uvs)
        _solidify(tail, 0.0018, 0.0)
        parts.append(tail)
    for o in parts:
        o.data.materials.clear()
        o.data.materials.append(material(cls, out_dir))
    with bpy.context.temp_override(active_object=cap, selected_editable_objects=parts, selected_objects=parts):
        bpy.ops.object.join()
    cap.name = cap.data.name = name
    return _rig(cap, arm)


def bandana(fr, arm, out_dir):
    return _cloth_cap("hat_bandana", fr, arm, out_dir, "crew", 0.005, 0.0015, 0.0045, math.radians(90), 0.085, 0.034)


def headscarf(fr, arm, out_dir):   # 11 mm off the skull: at 32 x 9 crown rows 8 mm let 6-8 long-hair verts through
    return _cloth_cap("hat_headscarf", fr, arm, out_dir, "scarf", 0.011, 0.005, 0.006, math.radians(128), 0.19, 0.05)


def eyepatch(fr, arm, eyes, out_dir):
    bvh, _ = _world_bvh([bpy.data.objects["body"], eyes])
    e = fr.er
    pts, uvs = [], []
    R, S = 8, 32
    def proj(dx, dz, bulge):
        org = Vector((e.x + dx, e.y - 0.12, e.z + dz))
        loc, _, _, _ = bvh.ray_cast(org, Vector((0, 1, 0)), 0.3)
        y = (loc.y if loc is not None else e.y - 0.01) - 0.0035 - bulge
        return Vector((e.x + dx, y, e.z + dz))
    centre = proj(0, 0.002, 0.004)
    for i in range(1, R + 1):
        rho = i / R
        for k in range(S):
            a = 2 * math.pi * k / S
            hx = 0.0225 * (1.0 + 0.08 * math.sin(a))   # a soft shield, a touch wider at the top
            hz = 0.0185
            dx, dz = rho * hx * math.cos(a), 0.002 + rho * hz * math.sin(a)
            pts.append(proj(dx, dz, 0.004 * (1 - rho * rho)))
            uvs.append((0.5 + 0.5 * rho * math.cos(a), 0.5 + 0.5 * rho * math.sin(a)))
    rows = [pts[i * S:(i + 1) * S] for i in range(R)]
    patch = _grid("patch", rows, pole=centre, u_tiles=1, v_scale=20.0)
    if patch.data.polygons[0].normal.y > 0:
        bm = bmesh.new()
        bm.from_mesh(patch.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(patch.data)
        bm.free()
    _solidify(patch, 0.002, -1.0)
    # strap: a band in the plane through the patch's temple and nasal-top edges and the back of the head
    pt = Vector((e.x - 0.021, e.y, e.z + 0.004))
    pn = Vector((e.x + 0.017, e.y, e.z + 0.014))
    q = Vector((0.0, fr.back.y, fr.eye_z + 0.05))
    m = (pn - pt).cross(q - pt).normalized()
    oc = fr.c - (fr.c - pt).dot(m) * m
    e1 = (q - oc).normalized()
    e2 = m.cross(e1).normalized()
    rails = []
    for w in (-0.005, 0.005):
        rail = []
        for k in range(120):
            a = 2 * math.pi * k / 120
            d = math.cos(a) * e1 + math.sin(a) * e2
            loc, nrm, _, _ = fr.bvh.ray_cast(oc + w * m, d, 0.3)
            if loc is None:
                rail.append(None)
                continue
            rail.append(loc + 0.0025 * d)
        rails.append(rail)
    keep = [k for k in range(120) if rails[0][k] and rails[1][k]
            and not (abs(rails[0][k].x - e.x) < 0.02 and rails[0][k].y < e.y + 0.015 and abs(rails[0][k].z - e.z) < 0.024)]
    gap = [k for k in range(120) if k not in keep]
    start = (max(gap) + 1) % 120 if gap and max(gap) - min(gap) < 60 else (keep[0] if keep else 0)
    order = [(start + i) % 120 for i in range(120) if (start + i) % 120 in keep]
    verts = [rails[s][k] for k in order for s in (0, 1)]
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(order) - 1)]
    uvs2 = [(s, i * 0.1) for i in range(len(order)) for s in (0, 1)]
    strap = _mesh_obj("strap", verts, faces, uvs2)
    _solidify(strap, 0.0015, 0.0)
    parts = [patch, strap]
    for o in parts:
        o.data.materials.clear()
        o.data.materials.append(material("leather", out_dir))
    with bpy.context.temp_override(active_object=patch, selected_editable_objects=parts, selected_objects=parts):
        bpy.ops.object.join()
    patch.name = patch.data.name = "acc_eyepatch"
    return _rig(patch, arm)


def earring(fr, arm, out_dir):
    band = [p for p in fr.head if p.x > 0 and fr.eye_z - 0.075 < p.z < fr.eye_z + 0.01]
    mx = max(p.x for p in band)
    ear = [p for p in band if p.x > mx - 0.012]
    lobe = min(ear, key=lambda p: p.z)
    R = 0.0085
    bpy.ops.mesh.primitive_torus_add(major_segments=40, minor_segments=10, major_radius=R, minor_radius=0.0011,
                                     location=(lobe.x + 0.0012, lobe.y, lobe.z + 0.0025 - R),
                                     rotation=(0, math.radians(90), 0))
    o = bpy.context.active_object
    o.name = o.data.name = "acc_earring"
    if not o.data.uv_layers:
        o.data.uv_layers.new(name="UVMap")
    o.data.materials.append(material("gold", out_dir))
    return _rig(o, arm)


def hat_safe_cuts(fr, arm, meshes):
    cuts = []
    for h in [m for m in meshes if m.name.startswith("hair_") and "beard" not in m.name and not m.name.endswith("_hat")]:
        c = h.copy()
        c.data = h.data.copy()
        bpy.context.scene.collection.objects.link(c)
        c.name = c.data.name = f"{h.name}_hat"
        bm = bmesh.new()
        bm.from_mesh(c.data)
        mw = c.matrix_world
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if fr.above(mw @ v.co) > -CUT_MARGIN], context="VERTS")
        bm.to_mesh(c.data)
        bm.free()
        c["pirateDefault"] = False
        c["hatSafeOf"] = h.name
        c.hide_render = True
        cuts.append(c)
    return cuts


def dress(arm, meshes, body_id, out_dir, report):
    """Adds the wardrobe-I nodes to one body; returns the new mesh objects (all non-default variants)."""
    body = next(m for m in meshes if m.name == "body")
    eyes = next(m for m in meshes if m.name == "eyes")
    fr = Frame(arm, body)
    new = [tricorn(fr, arm, out_dir), bicorn(fr, arm, out_dir), bandana(fr, arm, out_dir),
           headscarf(fr, arm, out_dir), eyepatch(fr, arm, eyes, out_dir), earring(fr, arm, out_dir)]
    new += hat_safe_cuts(fr, arm, meshes)
    report.setdefault(body_id, {})["wardrobe"] = {
        "hatLine": {"origin": list(fr.o), "normal": list(fr.n), "frontZ": fr.front.z, "backZ": fr.back.z},
        "nodes": {o.name: len(o.data.polygons) for o in new}}
    return new
