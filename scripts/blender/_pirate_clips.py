"""Pirate clips (b3.2b): Quaternius Universal Animation Library 1 + 2 Standard (CC0, the UBC skeleton) retargeted
onto the RETARGETED pirate rest pose, renamed to game clip ids, resampled on an exact 30 fps grid, root motion
stripped (the _RM source is kept for roll / vault / slide), plus gap clips authored as keyed layers over UAL poses.

  python3 scripts/blender/_pirate_clips.py        (pure Python, no bpy: glTF JSON + BIN in, glTF out)
  build_pirates.py calls build() after the base stage.

Retarget: the pirate rest differs from UAL's (bone-length edits moved the joint heads, up to ~17 deg at the neck).
For every bone b with rest world rotations U(b) (UAL) and P(b) (pirate), d(b) = U(b)^-1 P(b) and the new local
rotation is d(parent)^-1 * ual_local(b) * d(b): each bone's WORLD rotation delta from rest equals UAL's, so knees,
elbows and the spine bend exactly as the mocap does, on our bone lengths. Only the pelvis translates (the UAL
offset from its rest, scaled by the pelvis-height ratio); every other translation is the pirate rest.
Layers are model-space rotations (glTF: +Y up, the pirate faces +Z, its left is +X, right axis -X).
"""
import json
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
Q = os.path.join(REPO, "assets-src", "quaternius")
SRC = {"ual1": os.path.join(Q, "ual1", "Unreal-Godot", "UAL1_Standard.glb"),
       "ual2": os.path.join(Q, "ual2", "Unreal-Godot", "UAL2_Standard.glb")}
SRC_RM = {k: v.replace("_Standard.glb", "_Standard_RM.glb") for k, v in SRC.items()}
BASE = os.path.join(Q, "out", "pirate_base_male.glb")
OUT = os.path.join(REPO, "public", "assets", "models", "pirate_clips.glb")
FPS = 30

# game id -> (source clip, options). loop defaults to the source's _Loop suffix; rm = keep root motion (_RM file)
MAP = {
    "idle": "Idle_Loop", "idle_talk": "Idle_Talking_Loop", "idle_fold_arms": "Idle_FoldArms_Loop",
    "idle_no": "Idle_No_Loop", "idle_yes": "Yes", "lantern_idle": "Idle_Lantern_Loop", "torch_idle": "Idle_Torch_Loop",
    "rail_idle": "Idle_Rail_Loop", "rail_call": "Idle_Rail_Call",
    "walk": "Walk_Loop", "walk_formal": "Walk_Formal_Loop", "run": "Jog_Fwd_Loop", "sprint": "Sprint_Loop",
    "crouch_idle": "Crouch_Idle_Loop", "crouch_walk": "Crouch_Fwd_Loop", "carry": "Walk_Carry_Loop",
    "jump": "Jump_Start", "fall": "Jump_Loop", "land": "Jump_Land",
    "jump_high": "NinjaJump_Start", "fall_high": "NinjaJump_Idle_Loop", "land_high": "NinjaJump_Land",
    "roll": ("Roll", {"rm": True}), "vault": ("ClimbUp_1m", {"rm": True}),
    "slide_start": ("Slide_Start", {"rm": True}), "slide": "Slide_Loop", "slide_exit": ("Slide_Exit", {"rm": True}),
    "swim": "Swim_Fwd_Loop", "tread": "Swim_Idle_Loop",
    "capstan_push": "Push_Loop", "cannon_aim": "Push_Loop", "cannon_fire": "Interact",
    "repair": "Fixing_Kneeling", "bail": "Farm_Watering", "dig": "Farm_Harvest", "plant": "Farm_PlantSeed",
    "interact": "Interact", "chest_open": "Chest_Open", "pickup": "PickUp_Table", "throw": "OverhandThrow",
    "drink": "Consume", "sit_enter": "Sitting_Enter", "sit_idle": "Sitting_Idle_Loop", "sit_talk": "Sitting_Talking_Loop",
    "sit_exit": "Sitting_Exit", "dance": "Dance_Loop",
    "cutlass_idle": "Sword_Idle", "cutlass_swing_a": "Sword_Regular_A", "cutlass_recover_a": "Sword_Regular_A_Rec",
    "cutlass_swing_b": "Sword_Regular_B", "cutlass_recover_b": "Sword_Regular_B_Rec", "cutlass_swing_c": "Sword_Regular_C",
    "cutlass_combo": "Sword_Regular_Combo", "cutlass_heavy": "Sword_Heavy_Combo", "cutlass_attack": "Sword_Attack",
    "cutlass_lunge": "Sword_Dash", "block": "Sword_Block",
    "shield_idle": "Idle_Shield_Loop", "shield_bash": "Shield_OneShot", "shield_dash": "Shield_Dash",
    "shield_break": "Idle_Shield_Break",
    "punch_jab": "Punch_Jab", "punch_cross": "Punch_Cross", "melee_hook": "Melee_Hook", "melee_hook_recover": "Melee_Hook_Rec",
    "pistol_idle": "Pistol_Idle_Loop", "aim_pistol": "Pistol_Aim_Neutral", "aim_pistol_up": "Pistol_Aim_Up",
    "aim_pistol_down": "Pistol_Aim_Down", "fire_pistol": "Pistol_Shoot", "reload": "Pistol_Reload",
    "hit_front": "Hit_Chest", "hit_head": "Hit_Head", "hit_back": "Hit_Knockback",
    "death_shot": "Death01", "death_fall": "Death01", "revive": "LayToIdle",
    "skeleton_idle": "Zombie_Idle_Loop", "skeleton_walk": "Zombie_Walk_Fwd_Loop", "skeleton_attack": "Zombie_Scratch",
}
# not shipped: A_TPose (x2, reference), Idle_TalkingPhone_Loop (anachronism), Spell_Simple_* (no magic in the game)
DROPPED = ["A_TPose", "Idle_TalkingPhone_Loop", "Spell_Simple_Enter", "Spell_Simple_Idle_Loop", "Spell_Simple_Shoot",
           "Spell_Simple_Exit"]


# ---- glTF io -------------------------------------------------------------------------------------------------
def read_glb(path):
    with open(path, "rb") as f:
        buf = f.read()
    jl = struct.unpack_from("<I", buf, 12)[0]
    gltf = json.loads(buf[20:20 + jl])
    o = 20 + jl
    bl = struct.unpack_from("<I", buf, o)[0]
    return gltf, buf[o + 8:o + 8 + bl]


def acc(g, b, i):
    a = g["accessors"][i]
    v = g["bufferViews"][a["bufferView"]]
    n = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[a["type"]]
    assert a["componentType"] == 5126, "float accessors only"
    off = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    st = v.get("byteStride", 4 * n)
    return [struct.unpack_from(f"<{n}f", b, off + k * st) for k in range(a["count"])]


# ---- quaternions (x, y, z, w) --------------------------------------------------------------------------------
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qinv(q):
    return (-q[0], -q[1], -q[2], q[3])


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


def qaxis(axis, ang):
    n = math.sqrt(sum(c * c for c in axis)) or 1.0
    s = math.sin(ang / 2) / n
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(ang / 2))


def qrot(q, v):
    r = qmul(qmul(q, (v[0], v[1], v[2], 0.0)), qinv(q))
    return r[:3]


def slerp(a, b, t):
    d = sum(x * y for x, y in zip(a, b))
    if d < 0:
        b, d = tuple(-c for c in b), -d
    if d > 0.9995:
        return qnorm(tuple(x + (y - x) * t for x, y in zip(a, b)))
    th = math.acos(d)
    s = math.sin(th)
    wa, wb = math.sin((1 - t) * th) / s, math.sin(t * th) / s
    return tuple(wa * x + wb * y for x, y in zip(a, b))


def sample(ch, t):
    ts, vs = ch
    if t <= ts[0]:
        return vs[0]
    if t >= ts[-1]:
        return vs[-1]
    lo, hi = 0, len(ts) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if ts[m] <= t:
            lo = m
        else:
            hi = m
    u = (t - ts[lo]) / ((ts[hi] - ts[lo]) or 1)
    if len(vs[0]) == 4:
        return slerp(vs[lo], vs[hi], u)
    return tuple(x + (y - x) * u for x, y in zip(vs[lo], vs[hi]))


# ---- skeletons -----------------------------------------------------------------------------------------------
def skeleton(g):
    joints = g["skins"][0]["joints"]
    parent = {}
    for i, n in enumerate(g["nodes"]):
        for c in n.get("children", []):
            parent[c] = i
    names = {j: ("head" if g["nodes"][j]["name"] == "Head" else g["nodes"][j]["name"]) for j in joints}
    js = set(joints)
    rest = {names[j]: (tuple(g["nodes"][j].get("rotation", (0, 0, 0, 1))), tuple(g["nodes"][j].get("translation", (0, 0, 0))))
            for j in joints}
    par = {names[j]: (names[parent[j]] if parent.get(j) in js else None) for j in joints}
    order = []
    seen = set()
    def visit(b):
        if b in seen:
            return
        if par[b]:
            visit(par[b])
        seen.add(b)
        order.append(b)
    for j in joints:
        visit(names[j])
    return {"names": names, "rest": rest, "par": par, "order": order}


def world_rots(sk, local):
    w = {}
    for b in sk["order"]:
        p = sk["par"][b]
        w[b] = qmul(w[p], local[b]) if p else local[b]
    return w


def world_pos(sk, local, trans):
    wr, wp = {}, {}
    for b in sk["order"]:
        p = sk["par"][b]
        if p:
            wr[b] = qmul(wr[p], local[b])
            t = qrot(wr[p], trans[b])
            wp[b] = tuple(x + y for x, y in zip(wp[p], t))
        else:
            wr[b], wp[b] = local[b], trans[b]
    return wr, wp


def hinge_local(sk, bone, axis_model):
    """the rest-pose model axis a joint flexes about, in its PARENT bone's local frame (fixed to that bone)"""
    wr = world_rots(sk, {b: sk["rest"][b][0] for b in sk["order"]})
    return qrot(qinv(wr[sk["par"][bone]]), axis_model)


# rest T-pose: an upper arm along +-X flexes its forearm toward +Z (the front); a thigh along -Y flexes its calf
# toward -Z. Correct flexion axis = cross(parent dir, child dir): left arm -Y, right arm +Y, both knees +X.
HINGES = {"lowerarm_l": (0, -1, 0), "lowerarm_r": (0, 1, 0), "calf_l": (1, 0, 0), "calf_r": (1, 0, 0)}


# ---- layers --------------------------------------------------------------------------------------------------
def layer(sk, local, bone, q_model):
    """rotate ``bone`` (and its subtree) by the model-space rotation q_model"""
    w = world_rots(sk, local)
    p = sk["par"][bone]
    wp = w[p] if p else (0, 0, 0, 1)
    local[bone] = qnorm(qmul(qmul(qmul(qinv(wp), q_model), wp), local[bone]))


def flex(sk, local, joint, ang):
    """flex a hinge joint (elbow / knee) the ANATOMICAL way by ang rad about its rest hinge axis"""
    w = world_rots(sk, local)
    axis = qrot(w[sk["par"][joint]], hinge_local(sk, joint, HINGES[joint]))
    layer(sk, local, joint, qaxis(axis, ang))


def _sin(t, T, ph=0.0):
    return math.sin(2 * math.pi * t / T + ph)


def gap_layers(gid, sk, local, pel, t, T):
    X, Y = (1, 0, 0), (0, 1, 0)
    if gid in ("walk_back", "run_back"):
        layer(sk, local, "spine_01", qaxis(X, -0.07 if gid == "walk_back" else -0.1))    # lean back into the step
    elif gid in ("strafe_l", "strafe_r"):
        s = 1 if gid == "strafe_l" else -1   # legs walk toward the pirate's left (+X) / right; chest stays forward
        layer(sk, local, "pelvis", qaxis(Y, s * 0.87))
        for b, a in (("spine_01", -0.40), ("spine_02", -0.27), ("spine_03", -0.20)):
            layer(sk, local, b, qaxis(Y, s * a))
    elif gid == "climb":     # ladder: hands alternate overhead on the rungs, knees lift to the next rung
        for side, ph in (("l", 0.0), ("r", math.pi)):
            layer(sk, local, f"upperarm_{side}", qaxis(X, -(2.45 + 0.30 * _sin(t, T, ph))))
            flex(sk, local, f"lowerarm_{side}", 0.55 + 0.35 * _sin(t, T, ph + math.pi))
            layer(sk, local, f"thigh_{side}", qaxis(X, -(0.55 + 0.45 * _sin(t, T, ph + math.pi))))
            flex(sk, local, f"calf_{side}", 0.5 + 0.45 * _sin(t, T, ph + math.pi))
    elif gid == "spyglass":  # right hand brings the glass to the right eye, left hand steadies the barrel
        layer(sk, local, "upperarm_r", qaxis(X, -1.15))
        layer(sk, local, "upperarm_r", qaxis(Y, 0.55))
        flex(sk, local, "lowerarm_r", 1.75)   # 2.0 on top of the idle base folded 156 deg (> 150, anatomy gate)
        layer(sk, local, "upperarm_l", qaxis(X, -1.0))
        layer(sk, local, "upperarm_l", qaxis(Y, -0.35))
        flex(sk, local, "lowerarm_l", 1.35)
        layer(sk, local, "head", qaxis(X, -0.05 * _sin(t, T)))
    elif gid == "helm":      # R2 F5: STANDING at the wheel (UAL Driving_Loop is a seated car loop: the pirate squatted
        # on an invisible chair). Idle legs, feet planted; both hands forward on the spokes at ~1.1 m, working the
        # wheel a few degrees each way, weight shifting from foot to foot with it
        w = _sin(t, T)
        pel[0] += 0.012 * w
        pel[2] += 0.012   # the idle stands with the knees bent ~29 deg: brace them to ~20 and lift the hips to keep the feet down
        for side in "lr":
            flex(sk, local, f"calf_{side}", -0.16)
        layer(sk, local, "spine_01", qaxis((0, 0, 1), -0.03 * w))
        layer(sk, local, "spine_02", qaxis(X, 0.06))    # a little over the wheel
        for side, sg in (("l", 1), ("r", -1)):
            layer(sk, local, f"upperarm_{side}", qaxis(X, -(HELM_ARM[0] + 0.06 * sg * w)))
            layer(sk, local, f"upperarm_{side}", qaxis(Y, -sg * HELM_ARM[1]))
            flex(sk, local, f"lowerarm_{side}", HELM_ARM[2] - 0.08 * sg * w)
    elif gid == "downed":    # held on the ground, laboured breathing
        layer(sk, local, "spine_02", qaxis(X, 0.035 * _sin(t, T / 2)))
    elif gid in ("drown", "death_drown"):   # face tipped up for air, arms clawing, sinking
        layer(sk, local, "head", qaxis(X, -0.45))
        for side, ph in (("l", 0.0), ("r", math.pi)):
            layer(sk, local, f"upperarm_{side}", qaxis(X, -(1.2 + 0.6 * _sin(t, 0.9, ph))))
            flex(sk, local, f"lowerarm_{side}", 0.6 + 0.4 * _sin(t, 0.9, ph))
        if gid == "death_drown":
            pel[1] -= 0.35 * (t / T)


HELM_ARM = (0.85, 0.30, 0.90)   # upper arm raise forward, swing inward, elbow flex (rad)
GAPS = {   # game id -> (source, time map, duration or None = source's, loop)
    "walk_back": ("Walk_Loop", "reverse", None, True), "run_back": ("Jog_Fwd_Loop", "reverse", None, True),
    "strafe_l": ("Walk_Loop", "same", None, True), "strafe_r": ("Walk_Loop", "same", None, True),
    "climb": ("Walk_Loop", "slow", 1.6, True), "spyglass": ("Idle_Loop", "same", None, True),
    "helm": ("Idle_Loop", "same", None, True),
    "hammer": ("TreeChopping_Loop", "fast", 0.8, True),
    "downed": ("LayToIdle", "hold0", 2.5, True), "drown": ("Swim_Idle_Loop", "same", None, True),
    "death_drown": ("Swim_Idle_Loop", "same", 2.0, False),
}


# ---- build ---------------------------------------------------------------------------------------------------
def load_src(path):
    g, b = read_glb(path)
    sk = skeleton(g)
    names = sk["names"]
    clips = {}
    for a in g["animations"]:
        chans = {}
        for c in a["channels"]:
            j = c["target"]["node"]
            if j not in names or c["target"]["path"] not in ("rotation", "translation"):
                continue
            s = a["samplers"][c["sampler"]]
            chans[(names[j], c["target"]["path"])] = ([x[0] for x in acc(g, b, s["input"])], acc(g, b, s["output"]))
        dur = max(ch[0][-1] for ch in chans.values())
        clips[a["name"]] = (chans, dur)
    return sk, clips


def build(out=OUT):
    bg, bb = read_glb(BASE)
    P = skeleton(bg)
    srcs, srcs_rm = {}, {}
    U = None
    for k in SRC:
        sk, clips = load_src(SRC[k])
        U = U or sk
        srcs.update(clips)
        srcs_rm.update(load_src(SRC_RM[k])[1])
    urest = world_rots(U, {b: U["rest"][b][0] for b in U["order"]})
    prest_l = {b: P["rest"][b][0] for b in P["order"]}
    prest = world_rots(P, prest_l)
    d = {b: qmul(qinv(urest[b]), prest[b]) for b in P["order"] if b in urest}
    anim_b = [b for b in P["order"] if b in urest and b not in ("root",)]
    s_pel = math.dist((0, 0, 0), P["rest"]["pelvis"][1]) / math.dist((0, 0, 0), U["rest"]["pelvis"][1])   # root is -90 X: z is up
    _, wp = world_pos(P, prest_l, {b: P["rest"][b][1] for b in P["order"]})
    assert wp["ball_l"][2] > wp["foot_l"][2], "the pirate must face +Z"
    assert wp["hand_l"][0] > 0.5 if "hand_l" in wp else True, "left arm on +X"

    jobs = {gid: ((v, {}) if isinstance(v, str) else v) for gid, v in MAP.items()}
    for gid, (src, mode, dur, loop) in GAPS.items():
        jobs[gid] = (src, {"gap": mode, "dur": dur, "loop": loop})
    out_clips = []
    for gid, (src, opt) in jobs.items():
        chans, sdur = (srcs_rm if opt.get("rm") else srcs)[src]
        loop = opt.get("loop", src.endswith("_Loop"))
        mode = opt.get("gap")
        T = opt.get("dur") or sdur
        n = max(2, int(round(T * FPS)) + 1)
        T = (n - 1) / FPS
        frames = []
        for k in range(n):
            t = k / FPS
            ts = {None: t, "same": t % (sdur + 1e-9) if loop else min(t, sdur), "reverse": sdur - (t % (sdur + 1e-9)),
                  "slow": sdur * t / T, "fast": sdur * t / T, "hold0": 0.0}[mode]
            ul = {b: (sample(chans[(b, "rotation")], ts) if (b, "rotation") in chans else U["rest"][b][0]) for b in U["order"]}
            local = dict(prest_l)
            for b in anim_b:
                p = P["par"][b]
                dp = d[p] if p else (0, 0, 0, 1)
                local[b] = qnorm(qmul(qmul(qinv(dp), ul[b]), d[b]))
            ut = sample(chans[("pelvis", "translation")], ts) if ("pelvis", "translation") in chans else U["rest"]["pelvis"][1]
            pel = [P["rest"]["pelvis"][1][i] + (ut[i] - U["rest"]["pelvis"][1][i]) * s_pel for i in range(3)]
            root = None
            if opt.get("rm") and ("root", "translation") in chans:
                root = [c * s_pel for c in sample(chans[("root", "translation")], ts)]
            if mode:
                gap_layers(gid, P, local, pel, t, T)
            frames.append((local, pel, root))
        out_clips.append((gid, src, loop, bool(opt.get("rm")), mode, frames))
    write(bg, P, anim_b, out_clips, out)
    return {"clips": len(out_clips), "sources": len(set(j[0] for j in jobs.values())), "pelvisScale": round(s_pel, 4),
            "maxRestDeltaDeg": round(max(2 * math.degrees(math.acos(min(1, abs(q[3])))) for q in d.values()), 1)}


def write(bg, P, anim_b, clips, out):
    names = P["names"]
    idx = {v: k for k, v in names.items()}
    nodes = bg["nodes"]
    keep = sorted(set(idx.values()) | {i for i, n in enumerate(nodes) if any(c in idx.values() for c in n.get("children", []))})
    remap = {o: i for i, o in enumerate(keep)}
    nn = []
    for o in keep:
        n = {k: v for k, v in nodes[o].items() if k in ("name", "rotation", "translation", "scale")}
        ch = [remap[c] for c in nodes[o].get("children", []) if c in remap]
        if ch:
            n["children"] = ch
        nn.append(n)
    roots = [remap[o] for o in keep if not any(o in nodes[p].get("children", []) for p in keep)]
    blob = bytearray()
    views, accs, anims = [], [], []
    def put(vals, typ, mn=None, mx=None):
        flat = [c for v in vals for c in (v if isinstance(v, (tuple, list)) else (v,))]
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": 4 * len(flat)})
        blob.extend(struct.pack(f"<{len(flat)}f", *flat))
        a = {"bufferView": len(views) - 1, "componentType": 5126, "count": len(vals), "type": typ}
        if mn is not None:
            a["min"], a["max"] = mn, mx
        accs.append(a)
        return len(accs) - 1
    for gid, src, loop, rm, mode, frames in clips:
        times = [k / FPS for k in range(len(frames))]
        ti = put(times, "SCALAR", [0.0], [times[-1]])
        samplers, chans = [], []
        for b in anim_b:
            samplers.append({"input": ti, "output": put([f[0][b] for f in frames], "VEC4"), "interpolation": "LINEAR"})
            chans.append({"sampler": len(samplers) - 1, "target": {"node": remap[idx[b]], "path": "rotation"}})
        samplers.append({"input": ti, "output": put([tuple(f[1]) for f in frames], "VEC3"), "interpolation": "LINEAR"})
        chans.append({"sampler": len(samplers) - 1, "target": {"node": remap[idx["pelvis"]], "path": "translation"}})
        if rm and frames[0][2] is not None:
            samplers.append({"input": ti, "output": put([tuple(f[2]) for f in frames], "VEC3"), "interpolation": "LINEAR"})
            chans.append({"sampler": len(samplers) - 1, "target": {"node": remap[idx["root"]], "path": "translation"}})
        anims.append({"name": gid, "samplers": samplers, "channels": chans,
                      "extras": {"source": src, "fps": FPS, "loop": loop, "rootMotion": rm, "gapLayer": mode}})
    gltf = {"asset": {"version": "2.0", "generator": "pirates-br _pirate_clips.py (b3.2b)",
                      "extras": {"license": "CC0 1.0 (Quaternius Universal Animation Library 1+2)", "dropped": DROPPED}},
            "scene": 0, "scenes": [{"nodes": roots}], "nodes": nn, "animations": anims,
            "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accs}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    with open(out, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


if __name__ == "__main__":
    print(json.dumps(build()))
