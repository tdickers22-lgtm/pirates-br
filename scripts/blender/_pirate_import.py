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


def stoutify(body):
    """Third body type: a barrel chest and belly (normal offset weighted by the trunk groups), same skeleton."""
    wmap = {"spine_01": 1.0, "spine_02": 1.0, "pelvis": 0.7, "spine_03": 0.45, "thigh_l": 0.35, "thigh_r": 0.35}
    idx = {body.vertex_groups[g].index: w for g, w in wmap.items() if g in body.vertex_groups}
    me = body.data
    for v in me.vertices:
        w = min(1.0, sum(g.weight * idx[g.group] for g in v.groups if g.group in idx))
        if w > 0:
            v.co += v.normal * (0.032 * w)
    me.update()


def build_base(body_id, report, do_retarget=True):
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
    if stout:
        stoutify(body)
    rep["before"] = measure(arm, body)
    rep["after"] = retarget(arm, body, meshes) if do_retarget else rep["before"]
    rep["bones"] = sorted(b.name for b in arm.data.bones)
    arm.name = f"{body_id}_rig"
    for m in meshes:
        if m.name.startswith("hair_") and m.name[5:] not in {h.lower()[5:] for h in DEFAULT_HAIR[body_id]}:
            m.hide_render = True
    return arm, meshes
