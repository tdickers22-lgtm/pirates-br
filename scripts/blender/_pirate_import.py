"""Stage 1 of the pirate build (b3.2a, D25): import and normalise the Quaternius CC0 base.

What this stage guarantees to every later stage (clips, wardrobe, LODs, runtime):
  * the 55-bone NAMED skeleton: the kit's 65-bone UE-style skeleton minus its 12 leaf bones
    (``*_04_leaf_*`` x10, ``ball_leaf_*`` x2, their weights merged into the parent) plus ``eye_l`` /
    ``eye_r`` under ``head`` (the kit's ``Head`` is renamed to the lower-case name the game uses);
  * each eyeball is weighted 100% to its own eye bone so the face rig (b3.2g) can aim the eyes;
  * hair, beard and brows come from the kit's "Rigged to Head Bone" set, re-parented onto this armature;
  * every image the Godot export points at exists (the export references ``*_Normal_png.png`` copies
    that are not in the zip; they are re-pointed to the real ``*_Normal.png``);
  * proportions are retargeted by bone-length edits (head and hands scaled at their joints, then one
    uniform scale) so the SoT-family proportions of D25 hold (head:height 1:6.5-7, hands 1.1-1.2x a
    realistic hand = 0.108 x height) and the DRAWN HEAD CENTRE sits at PLAYER.HEAD_Y (1.62).
    Why the centre and not the head bone: src/shared/constants documents HEAD_Y as "centre of the drawn
    head AND of the server headshot sphere" (AVATAR-01). The old 24-bone rig put its head bone there, so
    "head bone == HEAD_Y" was the same statement; on the UE skeleton the head bone is the skull-base
    pivot, ~11 cm below the centre. Putting that pivot at 1.62 would draw a 1.88 m pirate whose head
    floats above the 1.75 m capsule and the headshot sphere (the three-heights bug AVATAR-01 closed).
    With the centre at 1.62 and head:height 6.75 the crown lands at 1.75 = PLAYER.HEIGHT.
Pure bpy; no network, no generator output.
"""
import math
import os
import bpy
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
Q = os.path.join(REPO, "assets-src", "quaternius")
UBC_BODY = os.path.join(Q, "ubc", "Base Characters", "Godot - UE")
UBC_HAIR = os.path.join(Q, "ubc", "Hairstyles", "Rigged to Head Bone", "glTF (Godot -Unreal)")
TEX_DIRS = [UBC_BODY, UBC_HAIR, os.path.join(Q, "mco", "Exports", "glTF (Godot-Unreal)", "Outfits")]

HEAD_Y = 1.62                # src/shared/constants PLAYER.HEAD_Y
HEAD_RATIO = 6.75            # height / head height, D25 target band 6.5-7
HAND_RATIO = 1.15            # hand length / (0.108 x height), D25 target band 1.1-1.2
REAL_HAND = 0.108

BODIES = {
    # body id: (kit file, hair meshes (first = default), stout)
    "male": ("Superhero_Male_FullBody.gltf", ["Hair_SimpleParted", "Hair_Beard", "Hair_Buzzed", "Hair_Long"], False),
    "female": ("Superhero_Female_FullBody.gltf", ["Hair_Buns", "Hair_BuzzedFemale", "Hair_Long"], False),
    "stout": ("Superhero_Male_FullBody.gltf", ["Hair_Buzzed", "Hair_Beard", "Hair_SimpleParted"], True),
}
DEFAULT_HAIR = {"male": {"Hair_SimpleParted", "Hair_Beard"}, "female": {"Hair_Buns"}, "stout": {"Hair_Buzzed", "Hair_Beard"}}
# R1 F3: the kit hair texture is a grey (mean 143) map meant to be tinted. The tint is a material factor on
# every hair, beard and brows material (glTF baseColorFactor + extras.hairTint, so b3.2c/b3.2e can re-tint
# variants). Linear RGB, dark defaults.
HAIR_TINT = {"male": (0.050, 0.032, 0.020), "female": (0.085, 0.046, 0.026), "stout": (0.042, 0.030, 0.022)}
# R1 F2 ("SoT family, not superhero"): how far each region's kit normal map is flattened toward (0.5, 0.5, 1)
# (1 - strength): the shredded 8-pack, striated deltoids and pec lines drop to ~0.35 strength; face, hands and
# feet keep the full map. The stout's belly/chest are flattened fully (R1 F1: no abs printed on a gut).
NORMAL_FLATTEN = {"pelvis": 0.65, "spine_01": 0.65, "spine_02": 0.65, "spine_03": 0.65, "clavicle_l": 0.65,
                  "clavicle_r": 0.65, "neck_01": 0.4, "upperarm_l": 0.6, "upperarm_r": 0.6, "lowerarm_l": 0.4,
                  "lowerarm_r": 0.4, "thigh_l": 0.5, "thigh_r": 0.5, "calf_l": 0.3, "calf_r": 0.3}
LID_OVERLAP_DEG = 4.0


def _import(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in list(new):
        if o.type == "MESH" and o.name.startswith("Icosphere"):   # kit export junk (no material, no skin)
            new.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    return new


def repoint_images(report):
    """The Godot export references *_png.png copies; point every missing image at the real file."""
    for img in bpy.data.images:
        if img.source != "FILE" or not img.filepath:
            continue
        p = bpy.path.abspath(img.filepath)
        if os.path.exists(p):
            continue
        base = os.path.basename(p).replace("_png.png", ".png")
        for d in TEX_DIRS:
            cand = os.path.join(d, base)
            if os.path.exists(cand):
                img.filepath = cand
                img.reload()
                report.setdefault("repointed", []).append([os.path.basename(p), os.path.relpath(cand, REPO)])
                break
        else:
            report.setdefault("missingImages", []).append(os.path.basename(p))


def _merge_group(mesh, src, dst):
    gs = mesh.vertex_groups.get(src)
    if gs is None:
        return
    gd = mesh.vertex_groups.get(dst) or mesh.vertex_groups.new(name=dst)
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.group == gs.index and g.weight > 0:
                gd.add([v.index], g.weight, "ADD")
    mesh.vertex_groups.remove(gs)


def strip_leaves(arm, meshes):
    leaves = [(b.name, b.parent.name) for b in arm.data.bones if "_leaf" in b.name]
    for m in meshes:
        for name, parent in leaves:
            _merge_group(m, name, parent)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, _ in leaves:
        arm.data.edit_bones.remove(arm.data.edit_bones[name])
    bpy.ops.object.mode_set(mode="OBJECT")
    return len(leaves)


def add_eye_bones(arm, eyes):
    """eye_l (+X side, the kit's left) and eye_r at each eyeball's centre, forward = -Y (Blender front)."""
    mw = eyes.matrix_world
    sides = {"l": [], "r": []}
    for v in eyes.data.vertices:
        w = mw @ v.co
        sides["l" if w.x > 0 else "r"].append((v.index, w))
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    for s, vs in sides.items():
        c = sum((w for _, w in vs), Vector()) / len(vs)
        b = eb.new(f"eye_{s}")
        b.head = c
        b.tail = c + Vector((0, -0.03, 0))
        b.parent = eb["head"]
    bpy.ops.object.mode_set(mode="OBJECT")
    for g in list(eyes.vertex_groups):
        eyes.vertex_groups.remove(g)
    for s, vs in sides.items():
        g = eyes.vertex_groups.new(name=f"eye_{s}")
        g.add([i for i, _ in vs], 1.0, "REPLACE")


def attach_hair(arm, name, report):
    new = _import(os.path.join(UBC_HAIR, f"{name}.gltf"))
    mesh = next(o for o in new if o.type == "MESH")
    for o in new:
        if o.type == "ARMATURE":
            bpy.data.objects.remove(o, do_unlink=True)
    if "Head" in mesh.vertex_groups:
        mesh.vertex_groups["Head"].name = "head"
    mw = mesh.matrix_world.copy()
    mesh.parent = arm
    mesh.matrix_world = mw
    mods = [m for m in mesh.modifiers if m.type == "ARMATURE"] or [mesh.modifiers.new("Armature", "ARMATURE")]
    mods[0].object = arm
    mesh.name = name.lower()
    report.setdefault("hair", []).append(mesh.name)
    return mesh


def _dominant(mesh, groups):
    idx = {mesh.vertex_groups[g].index for g in groups if g in mesh.vertex_groups}
    out = []
    for v in mesh.data.vertices:
        tot = sum(g.weight for g in v.groups)
        w = sum(g.weight for g in v.groups if g.group in idx)
        if tot > 0 and w / tot >= 0.5:
            out.append(mesh.matrix_world @ v.co)
    return out


def measure(arm, body):
    """Height, head height (crown to the lowest head-dominant vertex = chin), hand length (wrist joint
    to the farthest hand-dominant vertex), head joint height. Same definitions as test-character-asset."""
    zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
    height = max(zs) - min(zs)
    head = _dominant(body, ["head", "eye_l", "eye_r"])
    head_h = max(zs) - min(p.z for p in head)
    hand_bones = [b.name for b in arm.data.bones if b.name == "hand_l" or (b.parent and _under(b, "hand_l"))]
    wrist = arm.matrix_world @ arm.data.bones["hand_l"].head_local
    hand = max((p - wrist).length for p in _dominant(body, hand_bones))
    hj = (arm.matrix_world @ arm.data.bones["head"].head_local).z
    chin = min(p.z for p in head)
    return {"height": height, "headH": head_h, "headRatio": height / head_h, "hand": hand,
            "handRatio": hand / (REAL_HAND * height), "headJoint": hj, "crown": max(zs), "chin": chin,
            "headCentre": (max(zs) + chin) / 2, "sole": min(zs)}


def _under(b, name):
    while b.parent:
        if b.parent.name == name:
            return True
        b = b.parent
    return False


def _apply_pose(arm, meshes):
    for m in meshes:
        bpy.context.view_layer.objects.active = m
        mod = next(md for md in m.modifiers if md.type == "ARMATURE")
        bpy.ops.object.modifier_apply(modifier=mod.name)
        nm = m.modifiers.new("Armature", "ARMATURE")
        nm.object = arm
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.armature_apply(selected=False)
    for pb in arm.pose.bones:
        pb.scale = (1, 1, 1)
    bpy.ops.object.mode_set(mode="OBJECT")


def retarget(arm, body, meshes):
    """Bone-length edits: head scaled at its joint to reach HEAD_RATIO, hands at the wrist to reach
    HAND_RATIO, then one uniform scale about the origin so the drawn head centre lands on HEAD_Y. Two passes
    because the neck blend vertices follow the head only partially."""
    for _ in range(2):
        m = measure(arm, body)
        c = m["crown"] - m["headJoint"]
        s_head = (m["height"] - c) / (HEAD_RATIO * m["headH"] - c)
        s_hand = HAND_RATIO / m["handRatio"]
        arm.pose.bones["head"].scale = (s_head,) * 3
        arm.pose.bones["hand_l"].scale = (s_hand,) * 3
        arm.pose.bones["hand_r"].scale = (s_hand,) * 3
        _apply_pose(arm, meshes)
    s_u = HEAD_Y / measure(arm, body)["headCentre"]
    arm.pose.bones["root"].scale = (s_u,) * 3
    _apply_pose(arm, meshes)
    return measure(arm, body)


def _positions(body):
    """Welded positions of the body: {rounded world pos: [normal sum, {group: weight sum}, count, [vertex idx]]}.
    The kit splits vertices along UV seams and layers the briefs over the skin, so every vertex edit here is
    made once per POSITION (averaged normal and weights) or the trunk tears open at the seams."""
    gi = {g.index: g.name for g in body.vertex_groups}
    bw = body.matrix_world
    r = bw.to_3x3()
    acc = {}
    for v in body.data.vertices:
        p = bw @ v.co
        k = (round(p.x, 4), round(p.y, 4), round(p.z, 4))
        e = acc.setdefault(k, [Vector(), {}, 0, []])
        e[0] += (r @ v.normal).normalized()
        for g in v.groups:
            if g.group in gi:
                e[1][gi[g.group]] = e[1].get(gi[g.group], 0.0) + g.weight
        e[2] += 1
        e[3].append(v.index)
    return acc


def _move(body, acc, field):
    """field(p, n, w) -> world offset per welded position (w = averaged group weights)."""
    rinv = body.matrix_world.inverted().to_3x3()
    me = body.data
    for k, (nsum, wsum, cnt, idxs) in acc.items():
        w = {g: x / cnt for g, x in wsum.items()}
        n = nsum.normalized() if nsum.length > 1e-9 else Vector()
        off = field(Vector(k), n, w)
        if off is None or off.length == 0:
            continue
        d = rinv @ off
        for i in idxs:
            me.vertices[i].co += d
    me.update()


def _smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def _jw(arm, name):
    return arm.matrix_world @ arm.data.bones[name].head_local


def soften_physique(arm, body):
    """R1 F2: every body keeps the kit's 'Superhero' V-taper. Vertex-only (bone lengths untouched):
      * deltoid: positions around each shoulder joint pulled toward the arm axis (30% of their radius at the
        joint, Gaussian 9 cm), so the capped, striated shoulder reads as a working sailor's;
      * lat flare: trunk positions between spine_02 and the armpit pulled in sideways (20% of their width
        beyond 9 cm), which flattens the V-taper without touching the waist or the arms."""
    sh = {s: (_jw(arm, f"upperarm_{s}"), (_jw(arm, f"lowerarm_{s}") - _jw(arm, f"upperarm_{s}")).normalized()) for s in "lr"}
    z_lo = _jw(arm, "spine_02").z
    z_hi = sh["l"][0].z - 0.03
    acc = _positions(body)

    def field(p, n, w):
        tot = sum(w.values()) or 1.0
        off = Vector()
        s = "l" if p.x > 0 else "r"
        j, ax = sh[s]
        share = sum(w.get(g, 0) for g in (f"upperarm_{s}", f"clavicle_{s}", "spine_03")) / tot
        if share > 0:
            d = p - j
            along = d.dot(ax)
            radial = d - ax * along
            g = math.exp(-((d.length / 0.09) ** 2)) * share
            off -= radial * (0.30 * g)
        trunk = sum(w.get(b, 0) for b in ("spine_02", "spine_03", "spine_01")) / tot
        if trunk > 0 and abs(p.x) > 0.09:
            band = _smooth(z_lo - 0.04, z_lo + 0.04, p.z) * (1 - _smooth(z_hi - 0.02, z_hi + 0.04, p.z))
            off.x -= math.copysign(0.20 * (abs(p.x) - 0.09) * band * trunk, p.x)
        return off
    _move(body, acc, field)


def stoutify(arm, body):
    """Third body type: a heavy-set sailor on the same skeleton (bone lengths untouched, so every clip and the
    HEAD_Y retarget still hold). Vertex-only edits, each weighted by the skin so joints blend:
      * mass: a normal offset over the trunk and the WHOLE limb chain + neck (R1 F1: the b3.2a2 stout kept the
        male's arms, thighs and neck, so it only read by its waist);
      * waist: the trunk pushed out sideways around the navel, widest at the belly, fading to the chest and hips;
      * belly: the front of the trunk pushed forward around the navel (a round gut, not a uniform inflate);
      * jowls: the lower face and under-chin filled out (fades out above the mouth; eyes, nose, lids untouched);
      * shoulder slope: the trapezius raised between the neck and the shoulder, so the shoulder line slopes
        instead of the male's square V."""
    mass = {"spine_01": 1.0, "spine_02": 1.0, "pelvis": 0.8, "spine_03": 0.8, "neck_01": 0.9, "clavicle_l": 0.7,
            "clavicle_r": 0.7, "thigh_l": 0.9, "thigh_r": 0.9, "upperarm_l": 0.8, "upperarm_r": 0.8,
            "calf_l": 0.45, "calf_r": 0.45, "lowerarm_l": 0.5, "lowerarm_r": 0.5}
    trunk = {"spine_01": 1.0, "spine_02": 1.0, "pelvis": 0.75, "spine_03": 0.5}
    z_belly = _jw(arm, "spine_01").z * 0.35 + _jw(arm, "spine_02").z * 0.65
    span = _jw(arm, "spine_03").z - _jw(arm, "pelvis").z      # hip -> chest
    y_spine = _jw(arm, "spine_01").y     # the spine runs near the back; the gut is in front of it
    head_j = _jw(arm, "head")
    z_sh = _jw(arm, "upperarm_l").z
    x_sh = abs(_jw(arm, "upperarm_l").x)
    acc = _positions(body)
    head_pts = [Vector(k) for k, e in acc.items() if e[1].get("head", 0) / max(1e-9, sum(e[1].values())) >= 0.5]
    chin = min(p.z for p in head_pts)

    def field(p, n, w):
        tot = sum(w.values()) or 1.0
        wm = min(1.0, sum(x * mass.get(g, 0) for g, x in w.items()) / tot)
        wt = min(1.0, sum(x * trunk.get(g, 0) for g, x in w.items()) / tot)
        wh = w.get("head", 0) / tot
        off = n * (0.030 * wm)
        if wt > 0:
            fall = math.exp(-(((p.z - z_belly) / (0.55 * span)) ** 2))
            off.x += 0.040 * wt * fall * math.tanh(p.x / 0.06)
            front = min(1.0, max(0.0, (y_spine - p.y) / 0.16))
            off.y -= 0.075 * wt * fall * front * front * (3 - 2 * front)
        if wh > 0:      # jowls: lower face and under-chin, front and sides only (not the skull)
            low = 1 - _smooth(chin + 0.025, chin + 0.065, p.z)
            fwd = 1 - _smooth(head_j.y - 0.01, head_j.y + 0.04, p.y)
            off += n * (0.010 * wh * low * fwd)
        ws = sum(w.get(g, 0) for g in ("spine_03", "neck_01", "clavicle_l", "clavicle_r")) / tot
        if ws > 0 and 0.03 < abs(p.x) < x_sh + 0.02 and p.z > z_sh - 0.03:   # trapezius: slope, not a square yoke
            bump = math.exp(-(((abs(p.x) - 0.5 * x_sh) / (0.35 * x_sh)) ** 2))
            off.z += 0.022 * ws * bump * _smooth(z_sh - 0.03, z_sh + 0.03, p.z)
        return off
    _move(body, acc, field)


def smooth_abs(arm, body, amount, iters, shoulders=0.0):
    """R1 F1/F2: the kit SCULPTS the 8-pack and pec lines into the trunk geometry (the normal map only
    sharpens them), so flattening the map alone left them readable. Taubin smoothing (lambda/mu, no volume
    loss) over welded positions, weighted by trunk share x front-of-spine x ``amount``: the stout gets a
    smooth gut and chest, the male/female a softened abdomen. Silhouette and bone lengths hold."""
    acc = _positions(body)
    keys = list(acc)
    at = {}
    for k, e in acc.items():
        for i in e[3]:
            at[i] = k
    nb = {k: set() for k in keys}
    for ed in body.data.edges:
        a, b = at[ed.vertices[0]], at[ed.vertices[1]]
        if a != b:
            nb[a].add(b)
            nb[b].add(a)
    y_spine = _jw(arm, "spine_02").y
    z_lo, z_hi = _jw(arm, "pelvis").z, _jw(arm, "spine_03").z + 0.12
    trunk = ("pelvis", "spine_01", "spine_02", "spine_03")
    ua = {s: _jw(arm, f"upperarm_{s}") for s in "lr"}
    f = {}
    for k, e in acc.items():
        tot = sum(e[1].values()) or 1.0
        t = sum(e[1].get(g, 0) for g in trunk) / tot
        front = _smooth(0.0, 0.05, y_spine - k[1])
        band = _smooth(z_lo - 0.02, z_lo + 0.06, k[2]) * (1 - _smooth(z_hi - 0.04, z_hi, k[2]))
        f[k] = amount * t * front * band
        if shoulders > 0:     # R1 re-review F2: light deltoid/pec cap relief smooth (male)
            sh = sum(e[1].get(g, 0) for g in ("upperarm_l", "upperarm_r", "clavicle_l", "clavicle_r")) / tot
            near = 1 - _smooth(0.05, 0.11, min((Vector(k) - ua[s]).length for s in "lr"))
            f[k] = max(f[k], shoulders * sh * near)
    pos = {k: Vector(k) for k in keys}
    for it in range(iters * 2):
        lam = 0.5 if it % 2 == 0 else -0.53
        new = {}
        for k in keys:
            if f[k] <= 0 or not nb[k]:
                continue
            avg = sum((pos[n] for n in nb[k]), Vector()) / len(nb[k])
            new[k] = pos[k] + (avg - pos[k]) * (lam * f[k])
        pos.update(new)
    rinv = body.matrix_world.inverted().to_3x3()
    for k in keys:
        d = pos[k] - Vector(k)
        if d.length > 0:
            for i in acc[k][3]:
                body.data.vertices[i].co += rinv @ d
    body.data.update()


def add_lid_bones(arm, body, eyes, brows, report):
    """R1 F4: lid_upper_l / lid_upper_r leaf bones under head, head at the eyeball centre, pointing forward.
    The upper-lid skin of the body (a radial shell over the front-top of each eyeball, fading to the canthi and
    to the brow) and the upper lash cards of the brows mesh are weighted to them. Rotating a lid bone about the
    rig's +X axis (glTF +X too) by ``closeDeg`` closes the lid; see close_lids()."""
    ev = {"l": [], "r": []}
    for v in eyes.data.vertices:
        w = eyes.matrix_world @ v.co
        ev["l" if w.x > 0 else "r"].append(w)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    cen = {}
    for s in "lr":
        c = eb[f"eye_{s}"].head.copy()
        cen[s] = c
        b = eb.new(f"lid_upper_{s}")
        b.head = c
        b.tail = c + Vector((0, -0.025, 0))
        b.roll = 0
        b.parent = eb["head"]
    bpy.ops.object.mode_set(mode="OBJECT")
    rmax = {s: max((p - cen[s]).length for p in ev[s]) for s in "lr"}

    def lid_w(p, s):
        c, r = cen[s], rmax[s]
        d = p - c
        a = math.degrees(math.atan2(d.z, -d.y))          # 0 = straight ahead, 90 = straight up
        shell = 1 - _smooth(r + 0.004, r + 0.011, d.length)
        corner = 1 - _smooth(0.6 * r, 1.05 * r, abs(d.x))
        up = _smooth(0.0, 4.0, a) * (1 - _smooth(70.0, 110.0, a))
        # R1 re-review F5: fade to 0 at the lid crease (r + 3 mm above the eye centre, below the brow ridge),
        # or closing the lid drags the brow-ridge skin down with it (64788b33: skin moved 6.3 mm above r + 4 mm)
        crease = 1 - _smooth(r - 0.003, r + 0.003, d.z)
        return shell * corner * up * crease

    gi = {g.index: g.name for g in body.vertex_groups}
    groups = {s: body.vertex_groups.new(name=f"lid_upper_{s}") for s in "lr"}
    bw = body.matrix_world
    n_lid = {"l": 0, "r": 0}
    for v in body.data.vertices:
        tot = sum(g.weight for g in v.groups) or 1.0
        if sum(g.weight for g in v.groups if gi.get(g.group) == "head") / tot < 0.5:
            continue
        p = bw @ v.co
        s = "l" if p.x > 0 else "r"
        w = lid_w(p, s)
        if w <= 0.01:
            continue
        for g in list(v.groups):
            body.vertex_groups[g.group].add([v.index], g.weight * (1 - w), "REPLACE")
        groups[s].add([v.index], w * tot, "REPLACE")
        n_lid[s] += 1
    # upper lash cards BY ISLAND (R1 re-review F5). The brows mesh holds four islands once welded by position:
    # a lash strip per eye (centroid ~2 mm above the eye centre, ~10 mm from it) and a brow card per side
    # (centroid ~17 mm up). The earlier distance rule weighted the lower rows of the brow cards too, and a
    # closed lid tore a wedge out of each brow (brows moved up to 25 mm). Lash islands get the lid weight with
    # the same canthus fade as the skin; brow islands get none.
    lash = {"l": [], "r": []}
    bwm = brows.matrix_world
    for s_ in "lr":
        brows.vertex_groups.get(f"lid_upper_{s_}") or brows.vertex_groups.new(name=f"lid_upper_{s_}")
    bme = brows.data
    par = list(range(len(bme.vertices)))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i
    weld = {}
    for v in bme.vertices:
        weld.setdefault(tuple(round(c, 5) for c in (bwm @ v.co)), []).append(v.index)
    for ids in weld.values():
        for i in ids[1:]:
            par[find(i)] = find(ids[0])
    for ed in bme.edges:
        par[find(ed.vertices[0])] = find(ed.vertices[1])
    islands = {}
    for v in bme.vertices:
        islands.setdefault(find(v.index), []).append(v)
    brow_islands = 0
    for vs in islands.values():
        cpos = sum((bwm @ v.co for v in vs), Vector()) / len(vs)
        s_ = "l" if cpos.x > 0 else "r"
        rel = cpos - cen[s_]
        if not (rel.z < 0.5 * rmax[s_] and rel.length < rmax[s_]):
            brow_islands += 1
            continue
        for v in vs:
            d = (bwm @ v.co) - cen[s_]
            w = 1 - _smooth(0.6 * rmax[s_], 1.05 * rmax[s_], abs(d.x))
            if w <= 0.01:
                continue
            tot = sum(g.weight for g in v.groups) or 1.0
            for og in list(v.groups):
                brows.vertex_groups[og.group].add([v.index], og.weight * (1 - w), "REPLACE")
            brows.vertex_groups[f"lid_upper_{s_}"].add([v.index], w * tot, "REPLACE")
            lash[s_].append(v.index)
    report["browIslands"] = brow_islands
    report["lids"] = {"bodyVerts": n_lid, "lashVerts": {s: len(lash[s]) for s in "lr"},
                      "eyeRadius": {s: round(rmax[s], 4) for s in "lr"}}
    return lash


def close_lids(arm, body, eyes, report):
    """After the retarget: the close angle (upper margin elevation - lower margin elevation + overlap), then a
    rest-pose sculpt so the closed lid never enters the eyeball: every lid position whose CLOSED radius would
    fall inside the eye surface in that direction is pushed out radially by the deficit + 0.8 mm (rotation
    about the eye centre keeps radius, so the fix holds for any angle up to closeDeg)."""
    gi = {g.index: g.name for g in body.vertex_groups}
    bw, rinv = body.matrix_world, body.matrix_world.inverted().to_3x3()
    ew = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
    out = {}
    for s in "lr":
        c = _jw(arm, f"eye_{s}")
        eye = [p - c for p in ew if (p.x > 0) == (s == "l")]
        r = max(d.length for d in eye)
        lid, lower = [], []
        for v in body.data.vertices:
            p = bw @ v.co
            if (p.x > 0) != (s == "l"):
                continue
            d = p - c
            if d.length > r + 0.012:
                continue
            tot = sum(g.weight for g in v.groups) or 1.0
            w = sum(g.weight for g in v.groups if gi.get(g.group) == f"lid_upper_{s}") / tot
            a = math.degrees(math.atan2(d.z, -d.y))
            if w > 0.01:
                lid.append((v, d, w, a))
            elif a < 0 and d.length < r + 0.004 and abs(d.x) < 0.4 * r and -d.y > 0:
                lower.append(a)
        upper = min(a for _, d, w, a in lid if w >= 0.8 and abs(d.x) < 0.4 * r)
        lo = max(lower) if lower else -25.0
        close = min(75.0, max(15.0, upper - lo + LID_OVERLAP_DEG))

        def rot(d, deg):
            t = math.radians(deg)
            return Vector((d.x, d.y * math.cos(t) - d.z * math.sin(t), d.y * math.sin(t) + d.z * math.cos(t)))

        def surf(u):
            best = 0.0
            for e in eye:
                if e.length > 1e-6 and e.normalized().dot(u) > 0.985:
                    best = max(best, e.length)
            return best
        pushed = 0
        for v, d, w, a in lid:
            worst = 0.0
            for f in (0.25, 0.5, 0.75, 1.0):
                q = d + (rot(d, close * f) - d) * w
                need = surf(q.normalized()) + 0.0008 - q.length
                worst = max(worst, need)
            if worst > 0:
                v.co += rinv @ (d.normalized() * worst)
                pushed += 1
        # Margin angles are a first guess (one low-poly lower-lid vertex can sit high); the angle is then raised
        # until rays from the eye centre through >= 98% of the iris hit the posed skin at or beyond the iris,
        # the same test test-character-asset runs on the exported GLB.
        from mathutils.bvhtree import BVHTree
        dv = {v.index: (bw @ v.co) - c for v in body.data.vertices if ((bw @ v.co).x > 0) == (s == "l")}
        lw = {v.index: w for v, d, w, a in lid}
        near = {i for i, d in dv.items() if d.length < r + 0.015}
        polys = [list(p.vertices) for p in body.data.polygons if any(i in near for i in p.vertices) and all(i in dv for i in p.vertices)]
        used = sorted({i for p in polys for i in p})
        at = {i: k for k, i in enumerate(used)}
        iris = [(e.normalized(), e.length) for e in eye if e.length > 1e-6 and e.normalized().dot(Vector((0, -1, 0))) > math.cos(math.radians(25))]

        def coverage(deg):
            P = [dv[i] + (rot(dv[i], deg) - dv[i]) * lw.get(i, 0.0) for i in used]
            bvh = BVHTree.FromPolygons(P, [[at[i] for i in p] for p in polys])
            return sum(1 for u, rr in iris if bvh.ray_cast(u * (rr - 0.0003), u)[0] is not None) / max(1, len(iris))
        cov = coverage(close)
        while cov < 0.98 and close < 75.0:
            close += 1.5
            cov = coverage(close)
        arm.data.bones[f"lid_upper_{s}"]["closeDeg"] = round(close, 2)
        arm.data.bones[f"lid_upper_{s}"]["closeAxis"] = [1.0, 0.0, 0.0]
        out[s] = {"upperMarginDeg": round(upper, 1), "lowerMarginDeg": round(lo, 1), "closeDeg": round(close, 2),
                  "pushedOut": pushed, "irisCovered": round(cov, 3), "openCovered": round(coverage(0.0), 3)}
    body.data.update()
    report.setdefault("lids", {}).update(out)
    return out


def tint_hair(body_id, meshes):
    """R1 F3: hair, beard and brows (incl. the lash cards) multiplied by the body's hair tint, as a MATERIAL
    factor: in Blender the kit Mix node multiplies the texture by a constant tint (its vertex-colour input is
    unlinked), and build_pirates writes the same tint as the glTF baseColorFactor, which three.js multiplies
    into the map. (The kit's colour attributes do not survive the Blender 5.1 exporter as COLOR_0, measured.)
    The brows cast no shadow: the opaque lash cards drew a grey band down each cheek at noon."""
    tint = HAIR_TINT[body_id]
    for m in meshes:
        if not (m.name.startswith("hair_") or m.name == "brows"):
            continue
        for mat in m.data.materials:
            if not mat or not mat.use_nodes:
                continue
            nt = mat.node_tree
            if not any(n.type == "MIX" for n in nt.nodes):     # the Rigged-to-Head hair: image -> Base Color
                bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
                lk = next((l for l in nt.links if l.to_socket == bsdf.inputs["Base Color"]), None)
                if lk:
                    mx = nt.nodes.new("ShaderNodeMix")
                    mx.data_type = "RGBA"
                    src = lk.from_socket
                    nt.links.remove(lk)
                    nt.links.new(src, mx.inputs[6])
                    nt.links.new(mx.outputs[2], bsdf.inputs["Base Color"])
                    mx.inputs[7].default_value = (1, 1, 1, 1)
            for n in nt.nodes:
                if n.type != "MIX" or getattr(n, "data_type", "") != "RGBA":
                    continue
                n.blend_type = "MULTIPLY"
                n.inputs[0].default_value = 1.0
                n.inputs[7].default_value = tuple(tint) + (1.0,)
                for l in list(nt.links):
                    if l.to_node == n and l.from_node.type == "VERTEX_COLOR":
                        sock = l.to_socket
                        nt.links.remove(l)
                        sock.default_value = tuple(tint) + (1.0,)
            mat["hairTint"] = list(tint)
        if m.name == "brows":
            m.visible_shadow = False
            m["castShadow"] = False
    return tint


def _uv_field(body, fv, W, H):
    """Rasterise a per-vertex field ``fv`` into UV space (512 px, dilated into the island padding so a
    bilinear/mip fetch at a seam stays in the field), upsampled to W x H and 5x5 box-blurred. Row 0 = v 0."""
    import numpy as np
    me = body.data
    me.calc_loop_triangles()
    uvl = next((l for l in me.uv_layers if l.active_render), me.uv_layers[0])
    N = 512
    mask = np.zeros((N, N), np.float32)
    filled = np.zeros((N, N), bool)
    for tri in me.loop_triangles:
        uv = np.array([uvl.data[li].uv[:] for li in tri.loops], np.float64) * N
        fw = fv[list(tri.vertices)]
        x0, y0 = np.floor(uv.min(0)).astype(int)
        x1, y1 = np.ceil(uv.max(0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, N - 1), min(y1, N - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = uv
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        l0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
        l1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
        l2 = 1 - l0 - l1
        ins = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
        val = l0 * fw[0] + l1 * fw[1] + l2 * fw[2]
        sub = mask[y0:y1 + 1, x0:x1 + 1]
        fsub = filled[y0:y1 + 1, x0:x1 + 1]
        sub[ins] = np.maximum(np.where(fsub[ins], sub[ins], 0), val[ins])
        fsub[ins] = True
    for _ in range(4):     # dilate into the island padding so the bilinear/mip fetch at a seam stays flat
        pad = np.pad(mask, 1)
        pf = np.pad(filled, 1)
        best = np.zeros_like(mask)
        got = np.zeros_like(filled)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                m2 = pf[dy:dy + N, dx:dx + N]
                best = np.where(m2 & (~got | (pad[dy:dy + N, dx:dx + N] > best)), pad[dy:dy + N, dx:dx + N], best)
                got |= m2
        mask = np.where(filled, mask, best)
        filled |= got
    big = np.kron(mask, np.ones((H // N, W // N), np.float32))
    cs = np.cumsum(np.cumsum(np.pad(big, ((2, 2), (2, 2)), mode="edge"), 0), 1)
    cs = np.pad(cs, ((1, 0), (1, 0)))
    big = (cs[5:, 5:] - cs[:-5, 5:] - cs[5:, :-5] + cs[:-5, :-5]) / 25.0
    return big


def soften_normals(arm, body, body_id, out_dir, report):
    """R1 F1/F2: write a per-body copy of the kit normal map with the torso/limb regions flattened toward
    (0.5, 0.5, 1) by NORMAL_FLATTEN (and the stout's trunk fully flat), and point the body material at it.
    The flatten amount is a per-vertex field rasterised into UV space (512 px, dilated into the island
    padding, upsampled + box-blurred), so the transition follows the skin weights, not a UV rectangle."""
    import numpy as np
    mat = body.data.materials[0]
    mat.name = f"MI_body_{body_id}"
    nn = next(n for n in mat.node_tree.nodes if n.type == "NORMAL_MAP")
    tex = nn.inputs["Color"].links[0].from_node
    src = tex.image
    W, H = src.size
    gi = {g.index: g.name for g in body.vertex_groups}
    stout = BODIES[body_id][2]
    z_belly = _jw(arm, "spine_01").z * 0.35 + _jw(arm, "spine_02").z * 0.65
    span = _jw(arm, "spine_03").z - _jw(arm, "pelvis").z
    trunk_b = {"pelvis", "spine_01", "spine_02", "spine_03"}
    bw = body.matrix_world
    fv = np.zeros(len(body.data.vertices), np.float32)
    for v in body.data.vertices:
        tot = sum(g.weight for g in v.groups) or 1.0
        f = sum(g.weight * NORMAL_FLATTEN.get(gi.get(g.group, ""), 0.0) for g in v.groups) / tot
        if stout:
            t = sum(g.weight for g in v.groups if gi.get(g.group) in trunk_b) / tot
            f = max(f, min(1.0, 0.92 * t + 0.08 * t * math.exp(-(((bw @ v.co).z - z_belly) / span) ** 2)))
        fv[v.index] = f
    big = _uv_field(body, fv, W, H)
    px = np.empty(W * H * 4, np.float32)
    src.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    n = px[..., :3] * 2 - 1
    m3 = big[..., None]
    n = n * (1 - m3) + np.array([0, 0, 1], np.float32) * m3
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
    px[..., :3] = n * 0.5 + 0.5
    px[..., 3] = 1.0
    img = bpy.data.images.new(f"T_body_{body_id}_Normal", W, H, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(px.ravel())
    path = os.path.join(out_dir, f"T_body_{body_id}_Normal.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    tex.image = img
    report["normal"] = {"kit": os.path.relpath(bpy.path.abspath(src.filepath), REPO), "softened": os.path.relpath(path, REPO),
                        "meanFlatten": round(float(big.mean()), 3)}


def recolor_periocular(arm, body, eyes, body_id, out_dir, report):
    """R1 re-review F3: the kit 'Dark' albedo paints a desaturated grey-green patch under and inside each eye
    that reads as bruising against the warm skin (reviewer diag: a flat albedo removes it, hiding the eyeballs
    does not). Write a per-body copy (out/T_body_<b>_BaseColor.png) whose periocular field takes the cheek's
    chroma: each texel becomes cheek colour x (its own luminance / cheek luminance, lifted halfway to 1), so a
    faint warm socket shade and the texel detail survive and the green cast goes. Point the material at it."""
    import numpy as np
    mat = body.data.materials[0]
    tex = next(l.from_node for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"
               for l in n.inputs["Base Color"].links if l.from_node.type == "TEX_IMAGE") \
        if any(n.type == "BSDF_PRINCIPLED" and n.inputs["Base Color"].links and n.inputs["Base Color"].links[0].from_node.type == "TEX_IMAGE"
               for n in mat.node_tree.nodes) else None
    if tex is None:     # the kit routes Base Color through a mix node: take the colour image that is not the normal/ORM
        nn = next(n for n in mat.node_tree.nodes if n.type == "NORMAL_MAP")
        skip = {nn.inputs["Color"].links[0].from_node.name}
        tex = next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.name not in skip
                   and n.image and n.image.colorspace_settings.name != "Non-Color")
    src = tex.image
    W, H = src.size
    ev = {"l": [], "r": []}
    for v in eyes.data.vertices:
        w = eyes.matrix_world @ v.co
        ev["l" if w.x > 0 else "r"].append(w)
    cen = {s: _jw(arm, f"eye_{s}") for s in "lr"}
    rmax = {s: max((p - cen[s]).length for p in ev[s]) for s in "lr"}
    bw = body.matrix_world
    fv = np.zeros(len(body.data.vertices), np.float32)
    cheek, ring = [], []
    for v in body.data.vertices:
        p = bw @ v.co
        s = "l" if p.x > 0 else "r"
        d, r = p - cen[s], rmax[s]
        if d.y > 0.01:
            continue
        fv[v.index] = (1 - _smooth(r + 0.008, r + 0.018, d.length)) * _smooth(-0.004, 0.006, -d.y)
        if abs(d.x) < 1.2 * r and -(r + 0.035) < d.z < -(r + 0.020) and d.y < 0:
            cheek.append(v.index)
        elif r + 0.018 < d.length < r + 0.028 and d.y < 0:
            ring.append(v.index)
    me = body.data
    uvl = next((l for l in me.uv_layers if l.active_render), me.uv_layers[0])
    px = np.empty(W * H * 4, np.float32)
    src.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    def mean_at(ids):
        ids, uv = set(ids), {}
        for loop in me.loops:
            if loop.vertex_index in ids:
                uv[loop.vertex_index] = uvl.data[loop.index].uv[:]
        return np.array([px[min(H - 1, int(v * H)), min(W - 1, int(u * W)), :3] for u, v in uv.values()], np.float32)
    samp = mean_at(cheek)
    # the cheek alone painted a rosy halo round the eyes (cheek chroma is redder than brow and temple skin):
    # take half the chroma from the skin ring just outside the field, all the way round
    ck = 0.5 * samp.mean(0) + 0.5 * mean_at(ring).mean(0)
    lum = lambda c: c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
    lc = float(lum(ck))
    m = _uv_field(body, fv, W, H)[..., None]
    ratio = lum(px[..., :3]) / max(lc, 1e-4)
    ratio = np.where(ratio < 1, ratio + 0.5 * (1 - ratio), np.minimum(ratio, 1.08))[..., None]
    tgt = np.clip(ck[None, None, :] * ratio, 0, 1)
    px[..., :3] = px[..., :3] * (1 - m) + tgt * m
    img = bpy.data.images.new(f"T_body_{body_id}_BaseColor", W, H, alpha=False)
    img.pixels.foreach_set(px.ravel())
    path = os.path.join(out_dir, f"T_body_{body_id}_BaseColor.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    tex.image = img
    report["baseColor"] = {"kit": os.path.relpath(bpy.path.abspath(src.filepath), REPO), "recoloured": os.path.relpath(path, REPO),
                           "cheekRGB": [round(float(c), 4) for c in ck], "cheekSamples": len(samp),
                           "maskTexels": int((m[..., 0] > 0.5).sum())}


def build_base(body_id, report, do_retarget=True, out_dir=None):
    """Returns (armature, [meshes]) for one body type, normalised; objects prefixed with the body id."""
    kit, hairs, stout = BODIES[body_id]
    new = _import(os.path.join(UBC_BODY, kit))
    arm = next(o for o in new if o.type == "ARMATURE")
    arm.data.bones["Head"].name = "head"          # renames the vertex groups of the skinned children too
    meshes = [o for o in new if o.type == "MESH"]
    body = next(o for o in meshes if o.name.startswith("SuperHero") or o.name.startswith("Superhero"))
    eyes = next(o for o in meshes if o.name.startswith("Eyes"))
    brows = next(o for o in meshes if o.name.startswith("Eyebrows"))
    body.name, eyes.name, brows.name = "body", "eyes", "brows"
    rep = report.setdefault(body_id, {})
    for h in hairs:
        meshes.append(attach_hair(arm, h, rep))
    rep["leafBonesRemoved"] = strip_leaves(arm, meshes)
    add_eye_bones(arm, eyes)
    lash = add_lid_bones(arm, body, eyes, brows, rep)
    soften_physique(arm, body)
    if stout:
        stoutify(arm, body)
    # R1 re-review F2: the male abdomen 0.5 x 6 left a geometric 8-pack at 4 m (4.29 mm sculpt relief)
    male = body_id == "male"
    smooth_abs(arm, body, 1.0 if stout else (0.9 if male else 0.5), 18 if stout else (12 if male else 6),
               shoulders=0.35 if male else 0.0)
    rep["before"] = measure(arm, body)
    rep["after"] = retarget(arm, body, meshes) if do_retarget else rep["before"]
    close_lids(arm, body, eyes, rep)
    rep["hairTint"] = list(tint_hair(body_id, meshes))
    if out_dir:
        soften_normals(arm, body, body_id, out_dir, rep)
        recolor_periocular(arm, body, eyes, body_id, out_dir, rep)
    rep["bones"] = sorted(b.name for b in arm.data.bones)
    arm.name = f"{body_id}_rig"
    defaults = {h.lower() for h in DEFAULT_HAIR[body_id]}
    for m in meshes:
        if m.name.startswith("hair_"):
            m["pirateDefault"] = m.name in defaults     # glTF node extras: which styles a naive load shows
            m.hide_render = m.name not in defaults
    rep["defaultHair"] = sorted(defaults)
    return arm, meshes
