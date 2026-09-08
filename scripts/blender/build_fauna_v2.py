# Fauna v2 — the hero shark, rebuilt as a LOFTED, SKINNED mesh (FAUNAGLB-01).
#
# WHAT WAS WRONG. build_animals.py's shark is a 1,972-tri union of twelve rigid
# blobs and plates whose "swimming" is three node rotations (assets-12). It is
# the single most-watched creature in the game — it swims at your face, in the
# dodge window, filling the screen — and it is the lowest-fidelity asset we own.
# Two specific ugly things a player sees today:
#   * the white belly is a SECOND icosphere pushed 7 cm down through the grey
#     hull, so the two surfaces interpenetrate along the whole flank — a moving
#     z-fight the moment the two get within depth precision;
#   * the tail is a rigid plate on a hinge, so the body stays a stiff torpedo
#     and only the very end wags. Sharks bend along their whole length.
#
# WHAT THIS BUILDS.
#   shark.glb      ~9k tris, ONE lofted fusiform (no interpenetrating belly:
#                  countershading is a material boundary along the lateral
#                  line, exactly where a real shark's is), smooth-shaded,
#                  skinned to a 9-bone armature (6 along the body + 2 pectorals
#                  + jaw) with `swim` and `bite` actions. export_skins=True.
#   shark_far.glb  ~2k tris, NOT skinned, carrying the four pivot node names
#                  build_animals.py used (shark_tail / shark_jaw /
#                  shark_pec_l / shark_pec_r) so the existing pivot animator
#                  drives it verbatim.
#
# WHY BOTH. SHARK.MAX_WORLD is 4, so the skinned hero costs 4 x 9k = 36k tris
# where the old puppet cost 4 x 2k = 8k. On the low tier that is a real bill for
# a creature that is usually a fin on the horizon. FaunaMeshFactory takes
# shark_far on `low` and keeps the pivot animator; balanced/high get the skinned
# hero. The far file is therefore a TIER GATE, not decoration: on low the
# triangle count and the shader variant are what they are today.
#
# The body keeps today's dimensions exactly (nose y=-1.70, caudal tip y=+1.75,
# max half-width 0.41 x 0.53, origin mid-body): SHARK colliders, the hull
# avoidance radius and Match's seating all measure the old numbers.
#
# 1 unit = 1 m; forward = -Y (= game +Z); Z up.
# Headless: /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_fauna_v2.py
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())

RENDER_DIR = os.environ.get("BR_RENDER_DIR", "/tmp/pbr-fauna-v2")

EXTRA = {
    "Shark_Grey":  ((0.28, 0.33, 0.40, 1.0), 0.85, 0.0),
    "Shark_Belly": ((0.88, 0.90, 0.92, 1.0), 0.85, 0.0),
    "Shark_Dark":  ((0.15, 0.18, 0.23, 1.0), 0.85, 0.0),
    "Mouth_Red":   ((0.42, 0.07, 0.07, 1.0), 0.90, 0.0),
    "Teeth_White": ((0.95, 0.93, 0.86, 1.0), 0.70, 0.0),
    "Eye_Black":   ((0.03, 0.03, 0.03, 1.0), 0.40, 0.0),
}
for _n, (_c, _r, _m) in EXTRA.items():
    if _n not in PALETTE:
        PALETTE[_n] = (_c, _r, _m)


# ── shared little builders (same conventions as build_animals.py) ────────────
def blob(coll, name, r, x, y, z, material, subdiv=2, scale=(1, 1, 1), rot=None):
    bm = bm_icosphere(r, subdiv)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def box(coll, name, w, d, h, x, y, z, material, rot=None):
    bm = bm_box(w, d, h)
    m = Matrix.Translation((x, y, z))
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material))


def seg(coll, name, p1, p2, r1, r2, material, segs=8):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bm = bm_cylinder(r1, r2, d.length, segs=segs)
    m = Matrix.Translation((p1 + p2) * 0.5) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=True)


def fin(coll, name, pts, thickness, material, matrix=None, plane='yz', cuts=0, smooth=True):
    """Thin solidified polygon plate. `cuts` subdivides it so a skinned fin
    bends with the body instead of shearing away from it at the root."""
    bm = bmesh.new()
    if plane == 'yz':
        vs = [bm.verts.new((0.0, p[0], p[1])) for p in pts]
    else:
        vs = [bm.verts.new((p[0], p[1], 0.0)) for p in pts]
    bm.faces.new(vs)
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thickness)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=m4(matrix), verts=bm.verts)
    return obj_from_bmesh(name, bm, coll, mat(material), smooth=smooth)


def m4(m):
    return m


def repivot(obj, pivot):
    p = Vector(pivot)
    obj.data.transform(Matrix.Translation(-p))
    obj.location = p


# ── the fusiform loft ────────────────────────────────────────────────────────
# Half-width factor along the body axis. Keys are (t, f) with t = -1 at the nose
# tip and +1 at the caudal peduncle end; smoothstep between keys keeps the
# silhouette C1 so smooth normals have nothing to crease over.
PROFILE = [
    (-1.000, 0.000), (-0.955, 0.135), (-0.880, 0.300), (-0.760, 0.530),
    (-0.600, 0.760), (-0.420, 0.925), (-0.230, 1.000), (0.000, 0.980),
    (0.190, 0.905), (0.380, 0.790), (0.560, 0.620), (0.700, 0.420),
    (0.820, 0.235), (0.910, 0.130), (1.000, 0.082),
]


def profile(t):
    if t <= PROFILE[0][0]:
        return PROFILE[0][1]
    if t >= PROFILE[-1][0]:
        return PROFILE[-1][1]
    for i in range(len(PROFILE) - 1):
        ta, fa = PROFILE[i]
        tb, fb = PROFILE[i + 1]
        if ta <= t <= tb:
            u = (t - ta) / (tb - ta)
            u = u * u * (3.0 - 2.0 * u)
            return fa + (fb - fa) * u
    return PROFILE[-1][1]


BODY_Y0, BODY_Y1 = -1.70, 1.45     # nose tip .. peduncle end (unchanged size)
BODY_SX, BODY_SZ = 0.41, 0.53
BELLY_FLAT = 0.86
BELLY_NZ = -0.30                   # normal.z under which a face is countershaded


def build_body(coll, name, rings, radial, materials):
    """Lofted fusiform closed with a nose pole and a peduncle pole.
    materials = (grey, belly); faces are assigned by their averaged normal so
    the countershading boundary follows the lateral line and NOTHING
    interpenetrates (the old build had a second belly sphere inside the hull)."""
    bm = bmesh.new()
    loops = []
    for i in range(rings):
        t = i / (rings - 1) * 2.0 - 1.0
        y = BODY_Y0 + (t + 1.0) * 0.5 * (BODY_Y1 - BODY_Y0)
        f = profile(t)
        if f <= 1e-4:
            loops.append([bm.verts.new((0.0, y, 0.0))])
            continue
        ring = []
        for j in range(radial):
            a = j / radial * math.tau
            x = math.cos(a) * f * BODY_SX
            z = math.sin(a) * f * BODY_SZ
            if z < 0:
                z *= BELLY_FLAT
            # dorsal keel: a touch of squared-off back so the dorsal fin has a
            # base to sit on rather than a bare cylinder.
            ring.append(bm.verts.new((x, y, z)))
        loops.append(ring)
    for i in range(rings - 1):
        a, b = loops[i], loops[i + 1]
        if len(a) == 1:
            for j in range(radial):
                bm.faces.new((a[0], b[j], b[(j + 1) % radial]))
        elif len(b) == 1:
            for j in range(radial):
                bm.faces.new((a[j], a[(j + 1) % radial], b[0]))
        else:
            for j in range(radial):
                k = (j + 1) % radial
                bm.faces.new((a[j], a[k], b[k], b[j]))
    # cap the peduncle end (the caudal fin roots into it)
    if len(loops[-1]) > 1:
        bm.faces.new(tuple(loops[-1]))
    bm.normal_update()
    obj = obj_from_bmesh(name, bm, coll, mat(materials[0]), smooth=True)
    obj.data.materials.append(mat(materials[1]))
    for p in obj.data.polygons:
        p.material_index = 1 if p.normal.z < BELLY_NZ else 0
    return obj


# ── armature + skin ─────────────────────────────────────────────────────────
# head..tail chain (6) + two pectorals + jaw. Every bone points down +Y so a
# positive rotation.z is a yaw to the shark's left in every one of them.
BONES = [
    # name,      head,                 tail,                 parent,   connected
    ("root",     (0.0, -0.35, 0.00),   (0.0, 0.10, 0.00),    None,     False),
    ("head",     (0.0, -1.05, 0.00),   (0.0, -0.35, 0.00),   "root",   False),
    ("jaw",      (0.0, -1.12, -0.12),  (0.0, -1.46, -0.15),  "head",   False),
    ("spine1",   (0.0, 0.10, 0.00),    (0.0, 0.55, 0.00),    "root",   True),
    ("spine2",   (0.0, 0.55, 0.00),    (0.0, 1.00, 0.00),    "spine1", True),
    ("tail1",    (0.0, 1.00, 0.00),    (0.0, 1.38, 0.01),    "spine2", True),
    ("tail2",    (0.0, 1.38, 0.01),    (0.0, 1.72, 0.02),    "tail1",  True),
    ("pec_l",    (0.30, -0.55, -0.12), (0.78, -0.24, -0.20), "root",   False),
    ("pec_r",    (-0.30, -0.55, -0.12), (-0.78, -0.24, -0.20), "root",  False),
]

# Body-bone influence anchors along Y, in order. A vertex blends between the two
# it lies between with a smoothstep, so the skin has no crease at any joint.
CHAIN = [("head", -0.70), ("root", -0.125), ("spine1", 0.325),
         ("spine2", 0.775), ("tail1", 1.19), ("tail2", 1.55)]

PEC_ROOT = {"pec_l": Vector((0.30, -0.55, -0.12)), "pec_r": Vector((-0.30, -0.55, -0.12))}


def chain_weights(y):
    if y <= CHAIN[0][1]:
        return [(CHAIN[0][0], 1.0)]
    if y >= CHAIN[-1][1]:
        return [(CHAIN[-1][0], 1.0)]
    for i in range(len(CHAIN) - 1):
        na, ya = CHAIN[i]
        nb, yb = CHAIN[i + 1]
        if ya <= y <= yb:
            u = (y - ya) / (yb - ya)
            u = u * u * (3.0 - 2.0 * u)
            return [(na, 1.0 - u), (nb, u)]
    return [(CHAIN[-1][0], 1.0)]


def build_armature(coll, name="shark_rig"):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for bname, head, tail, parent, connected in BONES:
        eb = arm_data.edit_bones.new(bname)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        made[bname] = eb
    for bname, _h, _t, parent, connected in BONES:
        if parent:
            made[bname].parent = made[parent]
            made[bname].use_connect = connected
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
    return arm


def skin(obj, arm, mode="chain"):
    """Fill vertex groups analytically (no ARMATURE_AUTO operator: heat-map
    weighting is neither deterministic nor headless-safe), then bind."""
    for bname, _h, _t, _p, _c in BONES:
        if obj.vertex_groups.get(bname) is None:
            obj.vertex_groups.new(name=bname)
    me = obj.data
    for vi, v in enumerate(me.vertices):
        co = v.co
        if mode in ("pec_l", "pec_r"):
            d = (Vector((co.x, co.y, co.z)) - PEC_ROOT[mode]).length
            u = min(1.0, max(0.0, (d - 0.04) / 0.20))
            u = u * u * (3.0 - 2.0 * u)
            pairs = [(mode, u)]
            for bn, bw in chain_weights(co.y):
                pairs.append((bn, bw * (1.0 - u)))
        elif mode == "jaw":
            pairs = [("jaw", 1.0)]
        else:
            pairs = chain_weights(co.y)
        for bn, bw in pairs:
            if bw > 1e-4:
                obj.vertex_groups[bn].add([vi], bw, 'REPLACE')
    m = obj.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    obj.parent = arm


# ── actions ─────────────────────────────────────────────────────────────────
FPS = 24


def _pose(arm, poses, frame):
    for bname, rot in poses.items():
        pb = arm.pose.bones[bname]
        pb.rotation_euler = rot
        arm.keyframe_insert(data_path=f'pose.bones["{bname}"].rotation_euler', frame=frame)


def make_action(arm, name, frames):
    """frames = [(frame, {bone: (rx,ry,rz)})]. Built by keyframing with NO
    action assigned so Blender creates (and slots) a fresh one, which is then
    renamed and given a fake user; the glTF exporter walks bpy.data.actions."""
    arm.animation_data_create()
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    for frame, poses in frames:
        _pose(arm, poses, frame)
    act = arm.animation_data.action
    act.name = name
    act.use_fake_user = True
    # Blender 5's slotted actions have no `.fcurves` (channels live under
    # layers/strips/channelbags); the default BEZIER interpolation is what we
    # want anyway, so there is nothing to walk here.
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0.0, 0.0, 0.0)
    return act


def swim_frames(amp=1.0):
    """One second of anguilliform travel: the wave runs nose-to-tail, amplitude
    growing aft. Loops exactly (frame 25 == frame 1)."""
    chain = [("head", 0.030, 0.00), ("root", 0.035, 0.12), ("spine1", 0.055, 0.26),
             ("spine2", 0.085, 0.42), ("tail1", 0.135, 0.60), ("tail2", 0.175, 0.78)]
    out = []
    for k in range(9):
        f = 1 + k * 3
        ph = k / 8.0
        poses = {}
        for bname, a, lag in chain:
            poses[bname] = (0.0, 0.0, math.sin((ph - lag) * math.tau) * a * amp)
        # pectorals ride a slower roll so they are never dead
        poses["pec_l"] = (0.0, math.sin(ph * math.tau) * 0.05, 0.0)
        poses["pec_r"] = (0.0, -math.sin(ph * math.tau) * 0.05, 0.0)
        poses["jaw"] = (0.0, 0.0, 0.0)
        out.append((f, poses))
    return out


def bite_frames():
    """0.75 s: rear back, gape, snap, recover. Frames 1..19."""
    def p(jaw, rear, flare, thrash):
        return {
            "jaw": (jaw, 0.0, 0.0),
            "head": (rear, 0.0, 0.0),
            "root": (rear * 0.4, 0.0, 0.0),
            "spine1": (0.0, 0.0, thrash * 0.4),
            "spine2": (0.0, 0.0, thrash * 0.7),
            "tail1": (0.0, 0.0, thrash),
            "tail2": (0.0, 0.0, thrash * 1.2),
            "pec_l": (0.0, flare, 0.0),
            "pec_r": (0.0, -flare, 0.0),
        }
    return [
        (1,  p(0.05, 0.00, 0.00, 0.00)),
        (5,  p(0.62, -0.16, 0.42, -0.16)),
        (8,  p(0.70, -0.20, 0.46, 0.10)),
        (11, p(0.02, 0.10, 0.10, 0.26)),
        (14, p(0.10, 0.04, 0.16, -0.12)),
        (19, p(0.05, 0.00, 0.00, 0.00)),
    ]


# ── export with skins + animations ──────────────────────────────────────────
def export_skinned(objs, filename):
    os.makedirs(EXPORT_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(EXPORT_DIR, filename)
    # export_apply MUST stay False: applying modifiers would evaluate the
    # armature away and ship a rigid mesh with a skeleton nothing is bound to.
    base = dict(filepath=path, export_format='GLB', use_selection=True,
                export_apply=False, export_yup=True,
                export_animations=True, export_skins=True, export_morph=False)
    for extra in (
        {'export_vertex_color': 'ACTIVE', 'export_active_vertex_color_when_no_material': True},
        {'export_vertex_color': 'ACTIVE'},
        {},
    ):
        try:
            bpy.ops.export_scene.gltf(**base, **extra)
            print(f"EXPORTED {path} (vc opts: {list(extra) or 'defaults'})")
            return path
        except TypeError:
            continue
    raise RuntimeError('skinned gltf export failed for all kwarg variants')


def verify_skinned(path):
    """verify_glb + the two things that make this file worth building: does it
    carry skins, and which animations came out."""
    import json
    import struct
    info = verify_glb(path)
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))
        clen, _ = struct.unpack('<II', f.read(8))
        gltf = json.loads(f.read(clen))
    skins = gltf.get('skins', [])
    anims = [a.get('name', '?') for a in gltf.get('animations', [])]
    joints = sum(len(s.get('joints', [])) for s in skins)
    skinned_prims = sum(
        1 for m in gltf.get('meshes', []) for p in m.get('primitives', [])
        if 'JOINTS_0' in p.get('attributes', {})
    )
    print(f"VERIFY-SKIN {os.path.basename(path)}: {len(skins)} skin(s), {joints} joints, "
          f"{skinned_prims} skinned prim(s), animations {anims}")
    info.update(skins=len(skins), joints=joints, animations=anims,
                skinned_prims=skinned_prims)
    return info


# ── shark: hero (skinned) ───────────────────────────────────────────────────
def build_shark_hero(name="shark"):
    coll = asset_collection(name)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[coll.name])

    body = build_body(coll, "shark_body", rings=104, radial=34,
                      materials=("Shark_Grey", "Shark_Belly"))
    trim = []
    # dorsal fin + second dorsal, subdivided so they bend with the flank
    trim.append(fin(coll, "dorsal", [(-0.52, 0.40), (0.26, 1.02), (0.34, 0.64), (0.16, 0.40)],
                    0.07, "Shark_Grey", cuts=3))
    trim.append(fin(coll, "dorsal2", [(0.78, 0.10), (0.94, 0.31), (0.99, 0.10)],
                    0.045, "Shark_Grey", cuts=1))
    # anal + pelvic fins (the old shark had neither, and their absence is why it
    # read as a torpedo from below — the angle you meet one from in the water)
    trim.append(fin(coll, "anal", [(0.60, -0.28), (0.80, -0.52), (0.86, -0.30)],
                    0.04, "Shark_Grey", cuts=1))
    for sx in (-1, 1):
        m = Matrix.Translation((sx * 0.14, 0.0, 0.0))
        trim.append(fin(coll, f"pelvic{sx}", [(0.16, -0.30), (0.36, -0.50), (0.42, -0.28)],
                        0.035, "Shark_Grey", matrix=m, cuts=1))
    # caudal: crescent, long upper lobe
    trim.append(fin(coll, "caudal_up",
                    [(1.22, 0.05), (1.58, 0.82), (1.72, 0.74), (1.44, -0.02)],
                    0.055, "Shark_Grey", cuts=3))
    trim.append(fin(coll, "caudal_lo",
                    [(1.26, 0.02), (1.58, -0.50), (1.70, -0.40), (1.46, 0.06)],
                    0.05, "Shark_Grey", cuts=2))
    # gill slits, eyes, upper tooth row
    for sx in (-1, 1):
        for i, gy in enumerate((-0.72, -0.62, -0.52, -0.42, -0.32)):
            rot = Matrix.Rotation(sx * math.radians(8), 4, 'Y')
            trim.append(box(coll, f"gill{sx}{i}", 0.02, 0.042, 0.30,
                            sx * 0.372, gy, 0.02, "Shark_Dark", rot))
        trim.append(blob(coll, f"eye{sx}", 0.045, sx * 0.19, -1.25, 0.06, "Eye_Black", 2))
    trim.append(box(coll, "mouth_top", 0.21, 0.27, 0.02, 0, -1.26, -0.105, "Mouth_Red"))
    for i in range(7):
        trim.append(box(coll, f"utooth{i}", 0.024, 0.024, 0.042,
                        -0.09 + i * 0.03, -1.375, -0.115, "Teeth_White"))
    body = join([body] + trim, "shark_body")

    jaw_parts = [box(coll, "jaw_w", 0.21, 0.31, 0.07, 0, -1.26, -0.165, "Shark_Belly"),
                 box(coll, "jaw_in", 0.18, 0.27, 0.02, 0, -1.25, -0.128, "Mouth_Red")]
    for i in range(7):
        jaw_parts.append(box(coll, f"jtooth{i}", 0.023, 0.023, 0.046,
                             -0.087 + i * 0.029, -1.395, -0.127, "Teeth_White"))
    jaw = join(jaw_parts, "shark_jawmesh")

    pecs = {}
    for sx, key in ((1, "pec_l"), (-1, "pec_r")):
        m = (Matrix.Translation((sx * 0.30, -0.55, -0.12)) @
             Matrix.Rotation(-sx * math.radians(26), 4, 'Y'))
        pecs[key] = fin(coll, f"shark_{key}",
                        [(0.0, -0.06), (sx * 0.52, 0.36), (sx * 0.58, 0.56), (sx * 0.10, 0.28)],
                        0.045, "Shark_Grey", matrix=m, plane='xy', cuts=2)

    # AO before the armature exists (bake_ao walks MESH objects only) and before
    # the meshes are joined into one skin, so each part shades against the whole.
    bake_ao(coll, samples=12, floor=0.62, height_gradient=0.0)

    arm = build_armature(coll)
    skin(body, arm, "chain")
    skin(jaw, arm, "jaw")
    for key, obj in pecs.items():
        skin(obj, arm, key)

    make_action(arm, "swim", swim_frames())
    make_action(arm, "bite", bite_frames())

    objs = [arm, body, jaw] + list(pecs.values())
    path = export_skinned(objs, f"{name}.glb")
    info = verify_skinned(path)
    assert info['tris'] >= 8000, f"shark hero is {info['tris']} tris, budget is >= 8000"
    assert info['skins'] >= 1 and info['skinned_prims'] >= 1, "shark hero exported without skins"
    assert set(info['animations']) >= {"swim", "bite"}, f"actions missing: {info['animations']}"
    if os.environ.get('BR_FAUNA_RENDER'):
        render_turntable(coll, name, RENDER_DIR, views=2)
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    print(f"built {name}")
    return info


# ── shark_far: the low-tier / far puppet (rigid, pivot nodes) ───────────────
def build_shark_far(name="shark_far"):
    coll = asset_collection(name)
    bpy.context.view_layer.active_layer_collection = (
        bpy.context.view_layer.layer_collection.children[coll.name])
    # Body stops at the peduncle so the caudal plate can hang off shark_tail.
    body = build_body(coll, "far_body", rings=34, radial=14,
                      materials=("Shark_Grey", "Shark_Belly"))
    parts = [body]
    parts.append(fin(coll, "dorsal", [(-0.52, 0.40), (0.26, 1.02), (0.34, 0.64), (0.16, 0.40)],
                     0.07, "Shark_Grey"))
    for sx in (-1, 1):
        parts.append(blob(coll, f"eye{sx}", 0.045, sx * 0.19, -1.25, 0.06, "Eye_Black", 1))
    parts.append(box(coll, "mouth_top", 0.20, 0.26, 0.02, 0, -1.26, -0.10, "Mouth_Red"))
    join(parts, "body")

    jaw = join([box(coll, "jaw_w", 0.20, 0.30, 0.07, 0, -1.26, -0.16, "Shark_Belly"),
                box(coll, "jaw_in", 0.17, 0.26, 0.02, 0, -1.25, -0.125, "Mouth_Red")],
               "shark_jaw")
    repivot(jaw, (0, -1.12, -0.12))

    tail = join([fin(coll, "caudal_up", [(1.22, 0.05), (1.58, 0.82), (1.72, 0.74), (1.44, -0.02)],
                     0.055, "Shark_Grey"),
                 fin(coll, "caudal_lo", [(1.26, 0.02), (1.58, -0.50), (1.70, -0.40), (1.46, 0.06)],
                     0.05, "Shark_Grey")], "shark_tail")
    repivot(tail, (0, 1.05, 0))

    for sx, pname in ((1, "shark_pec_l"), (-1, "shark_pec_r")):
        m = (Matrix.Translation((sx * 0.30, -0.55, -0.12)) @
             Matrix.Rotation(-sx * math.radians(26), 4, 'Y'))
        pec = fin(coll, pname,
                  [(0.0, -0.06), (sx * 0.50, 0.36), (sx * 0.56, 0.55), (sx * 0.10, 0.28)],
                  0.045, "Shark_Grey", matrix=m, plane='xy')
        repivot(pec, (sx * 0.30, -0.55, -0.12))

    bake_ao(coll, samples=10, floor=0.62, height_gradient=0.0)
    export_collection_vc(coll, f"{name}.glb")
    info = verify_glb(os.path.join(EXPORT_DIR, f"{name}.glb"))
    assert info['tris'] <= 3200, f"shark_far is {info['tris']} tris, ceiling is 3200"
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    print(f"built {name}")
    return info


clear_default_scene()
hero = build_shark_hero()
far = build_shark_far()
print(f"FAUNA V2 DONE hero={hero['tris']} far={far['tris']} "
      f"joints={hero['joints']} anims={hero['animations']}")
