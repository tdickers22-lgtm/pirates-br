"""First-person arms from the character asset (b3.2h, characters-11 / liveplay-12).

The viewmodel used to grip every weapon and tool with a primitive fist: one box palm, four box fingers
and a brown cylinder sleeve (PlayerMeshFactory.makeViewHand). This stage cuts the REAL forearm and hand
out of the built male body (assets-src/quaternius/out/pirate_base_male.glb, b3.2a..d), with the coat_frock
sleeve and its turned-back crew cuff over it, closes the five fingers round a 32 mm handle on the rig's own
finger bones, and bakes the result as two static meshes in the viewmodel hand frame:

  origin  = the centre of the handle the fist closes on (the primitive's grip point)
  +Y      = back of the hand (fingers curl under, toward -Y)
  +Z      = the forearm, running back toward the camera and out of frame
  thumb   = inboard (-X on the right hand, +X on the left), laid over the index finger

-> public/assets/models/pirate_fp_arms.glb, nodes fp_arm_r / fp_arm_l (no skin, no images: the skin albedo is
baked to COLOR_0 from the per-body T_body_male_BaseColor.png, the sleeve / cuff take the crew colour at runtime
through the fp_sleeve / fp_cuff materials). Node extras carry what the gate reads (fingers, tris, handle
clearance, sleeve colour roles).
"""
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HANDLE_R = 0.016          # the fist closes on a 32 mm handle (cutlass grip, pistol grip, haft)
# (MCP, PIP, DIP) flexion in degrees: a power grip, the little finger closing hardest.
CURL = {"index": (62, 78, 38), "middle": (70, 84, 42), "ring": (74, 86, 44), "pinky": (78, 88, 46)}
ELBOW_KEEP = 0.05         # keep this much upper arm above the elbow so the sleeve exits the frame
TRI_CAP_PER_ARM = 1900    # both arms <= 4k (PLAN 3.11 row 4)


def _arm_space(arm, name):
    b = arm.data.bones[name]
    return arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local


def _posed(arm, name):
    pb = arm.pose.bones[name]
    return arm.matrix_world @ pb.head, arm.matrix_world @ pb.tail


def _rotate_bone(arm, name, axis, deg):
    """Rotate a pose bone about a world axis through its own posed head (children follow)."""
    pb = arm.pose.bones[name]
    head = pb.head.copy()
    aw = (arm.matrix_world.to_3x3().inverted() @ axis).normalized()
    r = Matrix.Rotation(math.radians(deg), 4, aw)
    pb.matrix = Matrix.Translation(head) @ r @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def _hand_frame(arm, s):
    wrist, _ = _arm_space(arm, f"hand_{s}")
    knuckle, _ = _arm_space(arm, f"middle_01_{s}")
    d = (knuckle - wrist).normalized()
    across = (_arm_space(arm, f"pinky_01_{s}")[0] - _arm_space(arm, f"index_01_{s}")[0])
    across = (across - d * across.dot(d)).normalized()
    t = _arm_space(arm, f"thumb_01_{s}")[0] - wrist
    n = d.cross(across)
    if n.dot(t) < 0:
        n = -n                   # palm normal: the side the thumb metacarpal hangs toward
    return d, n


def curl_fingers(arm, s):
    d, n = _hand_frame(arm, s)
    for f, angles in CURL.items():
        h0, t0 = _arm_space(arm, f"{f}_01_{s}")
        fd = (t0 - h0).normalized()
        axis = fd.cross(n).normalized()          # rotating about d x n swings the tip toward the palm
        for k, deg in zip(("01", "02", "03"), angles):
            _rotate_bone(arm, f"{f}_{k}_{s}", axis, deg)
    # Thumb: swing the whole chain so its tip lands over the middle phalanx of the closed index finger.
    th, _ = _posed(arm, f"thumb_01_{s}")
    _, tip = _posed(arm, f"thumb_03_{s}")
    ih, _ = _posed(arm, f"index_02_{s}")
    target = ih + (-n) * 0.012 + d * 0.004
    a, b = (tip - th).normalized(), (target - th).normalized()
    ax = a.cross(b)
    if ax.length > 1e-6:
        _rotate_bone(arm, f"thumb_01_{s}", ax.normalized(), math.degrees(a.angle(b)))
    tax = (_posed(arm, f"thumb_02_{s}")[1] - _posed(arm, f"thumb_02_{s}")[0]).normalized().cross(n)
    _rotate_bone(arm, f"thumb_02_{s}", tax.normalized(), 14)
    _rotate_bone(arm, f"thumb_03_{s}", tax.normalized(), 22)


def handle_centre(arm, s):
    """Centre of the ring the closed middle finger makes round the handle."""
    pts = [_posed(arm, f"middle_01_{s}")[0], _posed(arm, f"middle_02_{s}")[0],
           _posed(arm, f"middle_03_{s}")[0], _posed(arm, f"middle_03_{s}")[1]]
    return sum(pts, Vector()) / len(pts)


def _bake(obj, dg):
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    o = bpy.data.objects.new(obj.name + "_fp", me)
    o.matrix_world = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(o)
    return o


def _srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _bake_skin_colours(me, image_path):
    img = bpy.data.images.load(image_path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    uv = me.uv_layers.active.data
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    for i, lp in enumerate(me.loops):
        u, v = uv[i].uv
        x = min(w - 1, max(0, int((u % 1.0) * w)))
        y = min(h - 1, max(0, int((v % 1.0) * h)))
        c = px[y, x, :3]
        lin = _srgb_to_linear(c)
        attr.data[i].color = (float(lin[0]), float(lin[1]), float(lin[2]), 1.0)
    me.color_attributes.active_color = attr


def _material(name, rgb, rough, vcol=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    if vcol:
        ca = m.node_tree.nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        m.node_tree.links.new(ca.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def _keep_faces(obj, pred):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    mw = obj.matrix_world
    kill = [f for f in bm.faces if not pred([mw @ v.co for v in f.verts])]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def _tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def build(repo, render_dir=None):
    src = os.path.join(repo, "assets-src", "quaternius", "out", "pirate_base_male.glb")
    albedo = os.path.join(repo, "assets-src", "quaternius", "out", "T_body_male_BaseColor.png")
    out = os.path.join(repo, "public", "assets", "models", "pirate_fp_arms.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    body = bpy.data.objects["body"]
    coat = bpy.data.objects["coat_frock"]
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    frames = {}
    for s in ("r", "l"):
        frames[s] = _hand_frame(arm, s)
        curl_fingers(arm, s)
    centres = {s: handle_centre(arm, s) for s in ("r", "l")}
    bpy.ops.object.mode_set(mode="OBJECT")
    dg = bpy.context.evaluated_depsgraph_get()
    mats = {
        "skin": _material("fp_skin", (1, 1, 1), 0.62, vcol=True),
        "sleeve": _material("fp_sleeve", (0.24, 0.17, 0.12), 0.9),
        "cuff": _material("fp_cuff", (0.55, 0.1, 0.08), 0.85),
        "gold": _material("fp_gold", (0.76, 0.46, 0.10), 0.35),
        "cap": _material("fp_cap", (0.05, 0.04, 0.035), 1.0),
    }
    mats["gold"].metallic = 1.0
    report = {}
    arms = []
    for s in ("r", "l"):
        sign = -1 if s == "r" else 1        # T-pose: the right arm runs toward -X (Blender), the left toward +X
        elbow, _ = _arm_space(arm, f"lowerarm_{s}")
        wrist, _ = _arm_space(arm, f"hand_{s}")
        cut = elbow.x - sign * ELBOW_KEEP
        beyond = (lambda x, c=cut: (x - c) * sign > 0)
        c = _bake(coat, dg)
        _keep_faces(c, lambda vs: all(beyond(v.x) for v in vs))
        # The sleeve's distal end: skin further out than this (wrist, hand, fingers) stays, the covered forearm goes.
        sleeve_end = max((c.matrix_world @ v.co).x * sign for v in c.data.vertices) * sign
        b = _bake(body, dg)
        _keep_faces(b, lambda vs: all((v.x - sleeve_end) * sign > -0.02 for v in vs))
        _bake_skin_colours(b.data, albedo)
        # Materials: skin on the body cut; the coat keeps its roles (wool -> sleeve, crew -> cuff, gold buttons).
        b.data.materials.clear()
        b.data.materials.append(mats["skin"])
        role = {"MI_wardrobe_wool": "sleeve", "MI_wardrobe_crew": "cuff", "MI_wardrobe_gold": "gold"}
        old = [m.name if m else "" for m in c.data.materials]
        old_idx = [p.material_index for p in c.data.polygons]   # read before clear(): it clamps the indices
        c.data.materials.clear()
        for key in ("sleeve", "cuff", "gold", "cap"):
            c.data.materials.append(mats[key])
        order = ["sleeve", "cuff", "gold", "cap"]
        for p, mi in zip(c.data.polygons, old_idx):
            p.material_index = order.index(role.get(old[mi].split(".")[0], "sleeve"))
        # Close the sleeve where it was cut above the elbow (dark cap, never a see-through tube).
        bm = bmesh.new()
        bm.from_mesh(c.data)
        edges = [e for e in bm.edges if e.is_boundary and all(abs((c.matrix_world @ v.co).x - cut) < 0.03 for v in e.verts)]
        res = bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        for f in res["faces"]:
            f.material_index = 3
        bm.to_mesh(c.data)
        bm.free()
        # Decimate the skin to the per-arm budget (the sleeve keeps its authored rims).
        budget = TRI_CAP_PER_ARM - _tris(c)
        if _tris(b) > budget:
            mod = b.modifiers.new("dec", "DECIMATE")
            mod.ratio = max(0.2, budget / _tris(b))
            bpy.context.view_layer.objects.active = b
            bpy.ops.object.modifier_apply(modifier="dec")
        # One object per arm, then into the viewmodel hand frame.
        bpy.ops.object.select_all(action="DESELECT")
        b.select_set(True)
        c.select_set(True)
        bpy.context.view_layer.objects.active = b
        bpy.ops.object.join()
        o = b
        o.name = f"fp_arm_{s}"
        o.data.name = f"fp_arm_{s}"
        d, n = frames[s]
        e = d.cross(-n).normalized()
        n = (n - d * n.dot(d)).normalized()
        # Rows [e, d, -n]: e -> Blender +X, fingers -> +Y (glTF -Z, forward), back of hand -> +Z (glTF +Y, up).
        rot = Matrix((e, d, -n)).to_4x4()
        o.matrix_world = rot @ Matrix.Translation(-centres[s]) @ o.matrix_world
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        o.select_set(False)
        # The bone-ring centre is only a seed: the handle goes where the fist actually has its hole, the
        # largest empty circle in the knuckle band (Blender Y/Z) that the closed hand surrounds on >= 6 of 8 sides.
        pts = np.array([v.co[:] for v in o.data.vertices])
        band = pts[np.abs(pts[:, 0]) < 0.035][:, 1:3]
        best, best_r = (0.0, 0.0), -1.0
        for gy in np.arange(-0.024, 0.026, 0.002):   # stay under the knuckle row (the seed), never the palm heel
            for gz in np.arange(-0.05, 0.006, 0.002):
                dv = band - (gy, gz)
                dist = np.hypot(dv[:, 0], dv[:, 1])
                r = dist.min()
                if r <= best_r:
                    continue
                ring = dv[dist < r + 0.03]
                bins = set((np.floor((np.arctan2(ring[:, 1], ring[:, 0]) + math.pi) / (math.pi / 4)) % 8).astype(int))
                if len(bins) >= 6:
                    best, best_r = (gy, gz), r
        for v in o.data.vertices:
            v.co.y -= best[0]
            v.co.z -= best[1]
        # Clearance of the closed fist from the handle axis (Blender X = glTF X, the across-the-knuckles axis).
        pts = np.array([v.co[:] for v in o.data.vertices])
        near = pts[np.abs(pts[:, 0]) < 0.04]
        radial = np.sqrt(near[:, 1] ** 2 + near[:, 2] ** 2) if len(near) else np.array([0.0])
        thumb_x = float(np.mean(pts[(pts[:, 2] > -0.01) & (pts[:, 1] > 0.0) & (np.abs(pts[:, 0]) > 0.03)][:, 0])) \
            if len(pts) else 0.0
        info = {
            "tris": _tris(o), "fingers": 5, "handleR": HANDLE_R,
            "handleClearMin": round(float(radial.min()), 4), "holeShift": [round(float(best[0]), 4), round(float(best[1]), 4)],
            "sleeveEnd": round(float(sleeve_end), 4),
            "extentZ": [round(float(pts[:, 1].min()), 4), round(float(pts[:, 1].max()), 4)],
            "thumbSideX": round(thumb_x, 4),
            "materials": ["fp_skin", "fp_sleeve", "fp_cuff", "fp_gold", "fp_cap"],
        }
        o["fpArms"] = json.dumps(info)
        report[s] = info
        arms.append(o)
    for ob in list(bpy.data.objects):
        if ob not in arms:
            bpy.data.objects.remove(ob, do_unlink=True)
    for o in arms:
        o.select_set(True)
    kw = dict(filepath=out, export_format="GLB", use_selection=True, export_extras=True, export_yup=True,
              export_apply=True, export_texcoords=False, export_normals=True, export_materials="EXPORT",
              export_image_format="NONE")
    try:
        bpy.ops.export_scene.gltf(export_vertex_color="ACTIVE", **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)
    print("FP_ARMS", json.dumps(report))
    if render_dir:
        _review(arms, render_dir)
    return report


def _review(arms, render_dir):
    """Workbench review sheet: both fists on a 32 mm handle, three angles (960x540)."""
    os.makedirs(render_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.color_type = "VERTEX"
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    for i, o in enumerate(arms):
        o.location.x = 0.13 if o.name.endswith("_r") else -0.13
    for x in (0.13, -0.13):
        bpy.ops.mesh.primitive_cylinder_add(radius=HANDLE_R, depth=0.2, location=(x, 0, 0), rotation=(0, math.pi / 2, 0))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    for tag, loc in (("fp-view", (0.0, -0.45, 0.28)), ("side", (0.75, 0.0, 0.0)), ("under", (0.1, -0.35, -0.4))):
        cam.location = loc
        direction = Vector((0, 0.05, 0)) - Vector(loc)
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(render_dir, f"fp-arms-{tag}.png")
        bpy.ops.render.render(write_still=True)
