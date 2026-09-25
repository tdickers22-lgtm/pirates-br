"""Pirate characters build (D25): Quaternius CC0 anatomy + our scripted pirate wardrobe.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_pirates.py -- [--renders] [--raw]
  (--raw skips the proportion retarget and writes to /tmp/pbr-pirates-raw: the gate's red run)

Stages (one module each, run in this order; later slices append theirs):
  base (b3.2a, _pirate_import.py)  import + normalise the three body types (male, female, stout) on the
                                   55-bone named skeleton; writes assets-src/quaternius/out/pirate_base_<body>.glb
                                   (geometry + skin + material slots, images not embedded: the shipped
                                   atlas is baked in b3.2e) and pirate_base.report.json; --renders writes
                                   the R1 review sheet to docs/asset-sheets/characters/r1/.
Inputs are restored by `node assets-src/quaternius/fetch.mjs` (sha256-pinned, CC0).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
import _pirate_import as imp  # noqa: E402

REPO = imp.REPO
OUT = os.path.join(REPO, "assets-src", "quaternius", "out")
RAW = "--raw" in sys.argv   # red-run aid: skip the proportion retarget, export to /tmp (never the repo)
if RAW:
    OUT = "/tmp/pbr-pirates-raw"
SHEET = os.path.join(REPO, "docs", "asset-sheets", "characters", "r1")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def material_slots(meshes):
    mats = {}
    for m in meshes:
        for mat in m.data.materials:
            if not mat or mat.name in mats or not mat.use_nodes:
                continue
            slots = {}
            for n in mat.node_tree.nodes:
                if n.type != "TEX_IMAGE" or not n.image:
                    continue
                for l in n.outputs["Color"].links:
                    to = l.to_node
                    key = "normal" if to.type == "NORMAL_MAP" else (l.to_socket.name.lower().replace(" ", ""))
                    if to.type == "SEPARATE_COLOR" or to.type == "SEPARATE_RGB":
                        key = "orm"
                    slots[key] = os.path.relpath(bpy.path.abspath(n.image.filepath), REPO)
            mats[mat.name] = slots
    return mats


def export(arm, meshes, path):
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for m in meshes:
        m.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_image_format="NONE",
                              export_animations=False, export_skins=True, export_yup=True, export_apply=False,
                              export_extras=True)   # hair pirateDefault, brows castShadow, lid closeDeg, hairTint
    tint_factors(path)


def tint_factors(path):
    """R1 F3: write each hair material's extras.hairTint as its glTF baseColorFactor (the exporter drops the
    Mix-node constant when images are not embedded). Rewrites the JSON chunk only; the BIN chunk is untouched."""
    import struct
    with open(path, "rb") as f:
        buf = f.read()
    jl = struct.unpack_from("<I", buf, 12)[0]
    gltf = json.loads(buf[20:20 + jl])
    for m in gltf.get("materials", []):
        t = (m.get("extras") or {}).get("hairTint")
        if t:
            m.setdefault("pbrMetallicRoughness", {})["baseColorFactor"] = [round(x, 4) for x in t] + [1.0]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    rest = buf[20 + jl:]
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + len(rest)) + struct.pack("<II", len(js), 0x4E4F534A) + js + rest
    with open(path, "wb") as f:
        f.write(out)


def setup_render(night):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 24
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    sc.view_settings.view_transform = "AgX"
    w = sc.world or bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    for o in [o for o in bpy.data.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o, do_unlink=True)
    def light(kind, energy, color, rot=None, loc=None, size=None):
        d = bpy.data.lights.new(kind, kind)
        d.energy, d.color = energy, color
        if size is not None:
            d.shadow_soft_size = size
        o = bpy.data.objects.new(kind, d)
        sc.collection.objects.link(o)
        if rot:
            o.rotation_euler = [math.radians(a) for a in rot]
        if loc:
            o.location = loc
    if night:   # moonlight + a deck lantern, the game's night key
        bg.inputs[0].default_value = (0.02, 0.03, 0.06, 1)
        bg.inputs[1].default_value = 0.6
        light("SUN", 0.35, (0.62, 0.72, 1.0), rot=(55, 0, 140))
        light("POINT", 60, (1.0, 0.62, 0.3), loc=(0.9, -1.4, 1.9), size=0.1)
    else:       # noon sun + sky
        bg.inputs[0].default_value = (0.55, 0.66, 0.82, 1)
        bg.inputs[1].default_value = 0.9
        light("SUN", 4.0, (1.0, 0.96, 0.9), rot=(35, 0, -30))
    if "ground" not in bpy.data.objects:
        bpy.ops.mesh.primitive_plane_add(size=30)
        g = bpy.context.active_object
        g.name = "ground"
        mat = bpy.data.materials.new("deck")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.17, 0.1, 1)
        g.data.materials.append(mat)


def camera(loc, target, lens=50):
    sc = bpy.context.scene
    cam = sc.camera
    if cam is None:
        cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
        sc.collection.objects.link(cam)
        sc.camera = cam
    cam.data.lens = lens
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("wrote", path)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(OUT, exist_ok=True)
    report = {"skeleton": "Quaternius UE-style 65 minus 12 leaf plus eye_l/eye_r", "targets": {
        "headY": imp.HEAD_Y, "headRatio": imp.HEAD_RATIO, "handRatio": imp.HAND_RATIO},
        "sources": ["quaternius-universal-base-characters"], "bodies": {}, "materials": {}}
    built = {}
    for body_id in ("male", "female", "stout"):
        rep = {}
        arm, meshes = imp.build_base(body_id, rep, do_retarget=not RAW, out_dir=OUT)
        imp.repoint_images(rep)
        report["bodies"][body_id] = rep[body_id] | {k: v for k, v in rep.items() if k != body_id}
        report["materials"].update(material_slots(meshes))
        export(arm, meshes, os.path.join(OUT, f"pirate_base_{body_id}.glb"))
        for m in meshes:     # free the names for the next body (the export already has the clean ones)
            m.name = f"{body_id}_{m.name}"
        built[body_id] = (arm, meshes)
    with open(os.path.join(OUT, "pirate_base.report.json"), "w") as f:
        json.dump(report, f, indent=1, sort_keys=True)
    print(json.dumps({b: report["bodies"][b]["after"] for b in built}, indent=1))

    if "--renders" not in ARGS:
        return
    os.makedirs(SHEET, exist_ok=True)
    for arm, _ in built.values():   # the glTF importer leaves QUATERNION mode, which ignores rotation_euler:
        arm.rotation_mode = "XYZ"   # b3.2a's four turntable angles were all the same front view
    for i, (b, (arm, _)) in enumerate(built.items()):
        arm.location.x = 0 if b == "male" else 50 + i * 10   # park the others off camera
    male = built["male"][0]
    for night in (False, True):
        setup_render(night)
        tag = "night" if night else "noon"
        for ang, name in ((0, "front"), (40, "threequarter"), (90, "side"), (180, "back")):
            male.rotation_euler.z = math.radians(ang)
            # 40 mm from 4.6 m frames z -0.25..2.05: crown to soles (b3.2a2: the 50 mm shot cut at the shins)
            camera((0, -4.6, 1.0), (0, 0, 0.9), lens=40)
            render(os.path.join(SHEET, f"turntable-{tag}-{name}.png"))
        male.rotation_euler.z = math.radians(20)   # a slight three-quarter so the nose, lips and an ear read
        bpy.context.view_layer.update()
        # Aim at the DRAWN head centre (HEAD_Y), under the eyes' midpoint, from 1 m straight ahead: the frame
        # (0.40 m tall at 50 mm) then holds hair to beard. b3.2a aimed at z 1.70 (the brow) and cut the mouth.
        eyes = [male.matrix_world @ male.data.bones[b].head_local for b in ("eye_l", "eye_r")]
        mid = (eyes[0] + eyes[1]) / 2
        tgt = (mid.x, mid.y, imp.HEAD_Y)
        camera((tgt[0], tgt[1] - 1.0, tgt[2] + 0.02), tgt, lens=50)
        render(os.path.join(SHEET, f"face-1m-{tag}.png"))
        # R1 F4: the same shot with both lids closed by their bones (closeDeg about the rig X axis, as b3.2g will)
        male.rotation_mode = "XYZ"
        for s in "lr":
            pb = male.pose.bones[f"lid_upper_{s}"]
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (0, 0, 0)
            # bone local X is the rig X for a bone pointing -Y with roll 0; sign so the front edge goes DOWN
            pb.rotation_euler.x = -math.radians(male.data.bones[f"lid_upper_{s}"]["closeDeg"])
        bpy.context.view_layer.update()
        render(os.path.join(SHEET, f"face-1m-{tag}-lids-closed.png"))
        for s in "lr":
            male.pose.bones[f"lid_upper_{s}"].rotation_euler = (0, 0, 0)
        male.rotation_euler.z = 0
    setup_render(False)
    for x, b in zip((-2.0, 0.0, 2.0), ("female", "male", "stout")):   # R1 obs: >= 2.0 m so T-pose arms never overlap
        built[b][0].location.x = x
    camera((0, -8.4, 1.1), (0, 0, 0.95), lens=40)
    render(os.path.join(SHEET, "bodies-lineup-noon.png"))
    for b, x in (("male", 0.0), ("stout", 2.0)):   # R1 F1/F2: the torsos close up (abs, gut, deltoids, lats)
        camera((x, -2.2, 1.15), (x, 0, 1.1), lens=50)
        render(os.path.join(SHEET, f"torso-{b}-front-noon.png"))
    for b in built:   # the same three in profile: the stout's gut and the female's shape read from the side
        built[b][0].rotation_euler.z = math.radians(90)
    render(os.path.join(SHEET, "bodies-lineup-side-noon.png"))


main()
