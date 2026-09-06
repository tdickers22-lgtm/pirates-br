# Builds stylized rocks: 3 island boulders + 3 eroded sea stacks.
# Fidelity pass: boulders rebuilt at 2-4k tris (dual voronoi displacement,
# decimated flat facets, distinct silhouettes: a=rounded, b=angular slab,
# c=stacked/split with a crack). Sea stacks at 4-8k tris: high-res lathed
# pillars with deep strata banding, lean, waterline undercut, companion
# spires and a wet rubble skirt. Origin at ground center (waterline for sea
# rocks). Each asset is post-fit to its legacy bbox so colliders/placement
# stay valid. Baked vertex AO on everything.
# Headless: Blender -b -P scripts/blender/build_rocks.py
# Optional turntable renders: set env ROCKS_RENDER_DIR=<dir>
import bpy
import bmesh
import math
import random
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "_helpers.py")).read())
exec(open(os.path.join(HERE, "_ao.py")).read())
exec(open(os.path.join(HERE, "_detail.py")).read())
exec(open(os.path.join(HERE, "_nature.py")).read())
EXPORT_DIR = os.environ.get('BR_EXPORT_DIR', EXPORT_DIR)

RENDER_DIR = os.environ.get("ROCKS_RENDER_DIR", "")

# Weathered rock tones for the stacks (lighter + warmer than the old near-black
# Rock_Sea so they read as sun-and-salt-eroded stone, not flat grey cones).
EXTRA = {
    "Rock_Stack":  ((0.29, 0.27, 0.23, 1.0), 0.94, 0.0),  # weathered body
    "Rock_Wet":    ((0.16, 0.17, 0.18, 1.0), 0.78, 0.0),  # dark wet base
    "Rock_Pale":   ((0.45, 0.42, 0.35, 1.0), 0.95, 0.0),  # sun-bleached / guano crown
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)


# ── shared: fit final mesh into the legacy collider envelope ─────────────
def fit_envelope(obj, target_r, target_top, target_bot):
    """Uniformly rescale XY so the max horizontal half-extent == target_r,
    rescale+shift Z so the mesh spans [target_bot, target_top]. Keeps every
    asset's footprint/height identical to the legacy GLB (collider contract)."""
    me = obj.data
    r_now = max(max(abs(v.co.x), abs(v.co.y)) for v in me.vertices)
    zmin = min(v.co.z for v in me.vertices)
    zmax = max(v.co.z for v in me.vertices)
    sxy = target_r / max(1e-6, r_now)
    sz = (target_top - target_bot) / max(1e-6, zmax - zmin)
    dz = target_bot - zmin * sz
    for v in me.vertices:
        v.co.x *= sxy
        v.co.y *= sxy
        v.co.z = v.co.z * sz + dz


def finish(coll, obj, name, target_r, target_top, target_bot):
    # Fit the unjoined parts so AO/tint see their individual materials and
    # the final node has no leftover transform that could lift it off ground.
    finish_nature(coll, name)


# ── boulders ──────────────────────────────────────────────────────────────
def rock_lump(name, coll, r, squash, seed, material,
              coarse=0.45, coarse_scale=1.4, fine=0.08, fine_scale=0.5,
              subdiv=3, deci=0.6, stretch=(1.0, 1.0)):
    """Icosphere -> dual voronoi displacement -> decimate to mixed flat facets."""
    bm = bm_icosphere(r, subdiv)
    carve_facets(bm, r, count=17, depth=(0.76, 0.96), seed=seed, softness=r * 0.07)
    # Weathered bedding planes and a diagonal fault weather into the mesh;
    # extra vertices describe relief instead of only subdividing flat faces.
    for v in bm.verts:
        p = v.co.copy()
        band = math.sin(p.z * 17.0 / r + p.x * 1.7 / r + seed)
        notch = max(0.0, band) ** 9 * 0.042
        fault = math.exp(-((p.x + p.z * 0.22 - r * 0.18) / (r * 0.05)) ** 2) * 0.085
        v.co *= 1.0 - notch - fault
    bmesh.ops.scale(bm, vec=Vector((stretch[0], stretch[1], squash)), verts=bm.verts)
    obj = obj_from_bmesh(name, bm, coll, mat(material), smooth=False)
    # Small coherent weathering preserves the broad carved planes. Large
    # normal displacement after carving folded adjacent facets into spikes.
    displace_noise(obj, strength=r * coarse * 0.18, scale=coarse_scale, seed=seed)
    displace_noise(obj, strength=fine * 0.35, scale=fine_scale, seed=seed + 31)
    decimate(obj, deci)
    apply_modifiers(obj)
    return obj


def build_boulder_a(name, seed):
    """Rounded weathered dome — soft silhouette, broad facets."""
    coll = asset_collection(name)
    main = rock_lump(f"{name}_m", coll, 1.0, 0.82, seed, "Rock_Grey",
                     coarse=0.50, coarse_scale=1.0, fine=0.10, fine_scale=0.5,
                     subdiv=5, deci=0.80)
    main.location.z = 0.62
    # small bury-skirt lump seating it into terrain
    skirt = rock_lump(f"{name}_s", coll, 0.72, 0.42, seed + 5, "Rock_Grey",
                      coarse=0.35, coarse_scale=1.1, fine=0.06, fine_scale=0.45,
                      subdiv=4, deci=0.45, stretch=(1.25, 1.1))
    skirt.location = Vector((0.35, -0.25, 0.02))
    obj = [main, skirt]
    finish(coll, obj, name, 1.443, 2.226, -0.083)


def build_boulder_b(name, seed):
    """Angular tilted slab — hard chiseled facets, one leaning shard."""
    coll = asset_collection(name)
    main = rock_lump(f"{name}_m", coll, 1.0, 0.50, seed, "Rock_Grey",
                     coarse=0.62, coarse_scale=2.3, fine=0.09, fine_scale=0.5,
                     subdiv=5, deci=0.57, stretch=(1.45, 0.82))
    main.rotation_euler = (math.radians(9), math.radians(-16), math.radians(24))
    main.location.z = 0.62
    shard = rock_lump(f"{name}_sh", coll, 0.55, 0.85, seed + 9, "Rock_Grey",
                      coarse=0.55, coarse_scale=1.6, fine=0.08, fine_scale=0.5,
                      subdiv=4, deci=0.5, stretch=(0.72, 1.15))
    shard.rotation_euler = (math.radians(-18), math.radians(30), math.radians(-40))
    shard.location = Vector((0.95, 0.45, 0.42))
    skirt = rock_lump(f"{name}_s", coll, 0.8, 0.35, seed + 4, "Rock_Grey",
                      coarse=0.4, coarse_scale=1.2, fine=0.06, fine_scale=0.45,
                      subdiv=4, deci=0.45, stretch=(1.3, 1.05))
    skirt.location = Vector((-0.45, -0.2, 0.0))
    obj = [main, shard, skirt]
    finish(coll, obj, name, 2.469, 3.013, -0.693)


def build_boulder_c(name, seed):
    """Split stack — two lobes with a dark crack, third capping stone on top."""
    coll = asset_collection(name)
    lobe_l = rock_lump(f"{name}_l", coll, 0.62, 0.95, seed, "Rock_Grey",
                       coarse=0.38, coarse_scale=0.75, fine=0.08, fine_scale=0.45,
                       subdiv=4, deci=0.98, stretch=(0.85, 1.05))
    lobe_l.location = Vector((-0.34, 0.02, 0.52))
    lobe_l.rotation_euler = (0, math.radians(-8), math.radians(12))
    lobe_r = rock_lump(f"{name}_r", coll, 0.58, 1.0, seed + 3, "Rock_Grey",
                       coarse=0.38, coarse_scale=0.7, fine=0.08, fine_scale=0.45,
                       subdiv=4, deci=0.98, stretch=(0.9, 1.0))
    lobe_r.location = Vector((0.36, -0.04, 0.50))
    lobe_r.rotation_euler = (0, math.radians(10), math.radians(-15))
    # dark crack core hidden in the split (smaller than both lobes so only the
    # shadowed sliver shows through the gap)
    core = obj_from_bmesh(f"{name}_k", bm_box(0.13, 0.55, 0.7), coll,
                          mat("Rock_Dark"), smooth=False)
    core.location = Vector((0.01, 0.0, 0.48))
    core.rotation_euler = (0, math.radians(4), math.radians(-2))
    cap = rock_lump(f"{name}_t", coll, 0.42, 0.72, seed + 7, "Rock_Grey",
                    coarse=0.36, coarse_scale=0.7, fine=0.07, fine_scale=0.45,
                    subdiv=4, deci=0.98, stretch=(1.1, 0.95))
    cap.location = Vector((-0.05, 0.05, 1.12))
    cap.rotation_euler = (math.radians(6), math.radians(-5), math.radians(30))
    obj = [lobe_l, lobe_r, core, cap]
    finish(coll, obj, name, 1.052, 1.907, -0.261)


# ── sea stacks ────────────────────────────────────────────────────────────
def bm_pillar(height, base_r, seed, segs=16, rings=18, taper=0.6,
              strata=0.16, lean=0.05, cap_r=0.16,
              undercut=0.0, undercut_z=0.55, undercut_w=0.55):
    """A lathed, strata-banded, eroded rock column rising along +Z from 0.

    - taper: how much the radius shrinks base->top (0.6 => top is 40% of base)
    - strata: amplitude of the sedimentary radius banding
    - lean: how far the column drifts off-axis over its height (fraction)
    - cap_r: minimum radius fraction so the top isn't a needle point
    - undercut: wave-eroded pinch just above the waterline (0..~0.3),
      centered at undercut_z (m) with gaussian width undercut_w (m)
    """
    rng = random.Random(seed)
    bm = bmesh.new()
    ring_verts = []
    lx = ly = 0.0
    vx = rng.uniform(-0.02, 0.02)
    vy = rng.uniform(-0.02, 0.02)
    for j in range(rings + 1):
        t = j / rings                       # 0 base .. 1 top
        z = t * height
        # radius profile: taper up, sedimentary strata bulges, gentle random wobble
        prof = 1.0 - taper * t
        band = 1.0 + strata * math.sin(t * math.pi * 4.5 + seed) \
                   + strata * 0.55 * math.sin(t * math.pi * 9.0 + seed * 1.7) \
                   + strata * 0.3 * math.sin(t * math.pi * 17.0 + seed * 2.3)
        wob = 1.0 + rng.uniform(-0.05, 0.05)
        r = max(base_r * cap_r, base_r * prof * band * wob)
        if undercut > 0.0:
            g = math.exp(-(((z - undercut_z) / undercut_w) ** 2))
            r *= (1.0 - undercut * g)
        # accumulate a slow lean so the stack isn't a perfect axis
        vx = vx * 0.82 + rng.uniform(-0.02, 0.02)
        vy = vy * 0.82 + rng.uniform(-0.02, 0.02)
        lx += vx * (height / rings) * lean * 20.0
        ly += vy * (height / rings) * lean * 20.0
        verts = []
        for s in range(segs):
            a = (s / segs) * math.tau
            # Continuous angular faults create coherent flutes and ledges;
            # independent vertex jitter previously looked like crumpled foil.
            flutes = 0.08 * math.sin(a * 5 + seed) + 0.055 * math.sin(a * 9 + t * 1.4)
            fissure = max(0.0, math.cos(a * 3 + seed * 0.31 + t * 0.4)) ** 18 * 0.14
            grain = (vnoise((math.cos(a) * r, math.sin(a) * r, z), 0.48, seed) - 0.5) * 0.045
            rr = r * (1.0 + flutes - fissure + grain)
            verts.append(bm.verts.new((lx + math.cos(a) * rr,
                                       ly + math.sin(a) * rr, z)))
        ring_verts.append(verts)
    for j in range(rings):
        a, b = ring_verts[j], ring_verts[j + 1]
        for s in range(segs):
            s2 = (s + 1) % segs
            bm.faces.new((a[s], a[s2], b[s2], b[s]))
    bm.faces.new(list(reversed(ring_verts[0])))   # bottom cap
    bm.faces.new(list(ring_verts[-1]))            # top cap
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def build_searock(name, height, base_r, seed, companions, squat, envelope):
    """Eroded sea stack: hi-res strata pillar w/ waterline undercut + companion
    spires + wet rubble skirt. Fit to legacy bbox envelope."""
    coll = asset_collection(name)
    rng = random.Random(seed)
    parts = []

    # main pillar (weathered body, deep strata, waterline undercut)
    bm = bm_pillar(height, base_r, seed,
                   segs=34, rings=42,
                   taper=0.5 if squat else 0.62,
                   strata=0.24 if squat else 0.20,
                   lean=0.04 if squat else 0.07,
                   undercut=0.30, undercut_z=max(1.4, height * 0.18),
                   undercut_w=max(0.6, height * 0.07))
    main = obj_from_bmesh(f"{name}_main", bm, coll, mat("Rock_Stack"), smooth=False)
    displace_noise(main, strength=base_r * 0.13, scale=base_r * 0.9, seed=seed)
    displace_noise(main, strength=0.08, scale=0.5, seed=seed + 31)
    apply_modifiers(main)
    parts.append(main)

    # a sun-bleached crown band near the top
    crown = obj_from_bmesh(f"{name}_crown",
                           bm_pillar(height * 0.18, base_r * (0.35 if not squat else 0.60),
                                     seed + 91, segs=18, rings=6, taper=0.45, strata=0.10),
                           coll, mat("Rock_Pale"), smooth=False)
    crown.location.z = height * (0.80 if not squat else 0.58)
    displace_noise(crown, strength=0.06, scale=0.45, seed=seed + 55)
    apply_modifiers(crown)
    parts.append(crown)

    # companion spires clustered at the base
    for k in range(companions):
        ch = height * rng.uniform(0.26, 0.55)
        cr = base_r * rng.uniform(0.4, 0.6)
        cbm = bm_pillar(ch, cr, seed + 200 + k, segs=16, rings=16,
                        taper=0.6, strata=0.14, lean=0.09, cap_r=0.22,
                        undercut=0.10, undercut_z=0.5, undercut_w=0.5)
        spire = obj_from_bmesh(f"{name}_c{k}", cbm, coll, mat("Rock_Stack"), smooth=False)
        ang = rng.uniform(0, math.tau)
        d = base_r * rng.uniform(0.9, 1.5)
        spire.location = Vector((math.cos(ang) * d, math.sin(ang) * d, -0.4))
        displace_noise(spire, strength=cr * 0.16, scale=cr * 0.9, seed=seed + k)
        displace_noise(spire, strength=0.07, scale=0.5, seed=seed + 60 + k)
        apply_modifiers(spire)
        parts.append(spire)

    # wet rubble skirt grounding the cluster at the waterline
    skirt_bm = bm_icosphere(base_r * 1.35, 4)
    bmesh.ops.scale(skirt_bm, vec=Vector((1.0, 1.0, 0.26)), verts=skirt_bm.verts)
    skirt = obj_from_bmesh(f"{name}_skirt", skirt_bm, coll, mat("Rock_Wet"), smooth=False)
    skirt.location.z = base_r * 0.10
    displace_noise(skirt, strength=base_r * 0.26, scale=base_r * 0.8, seed=seed + 7)
    displace_noise(skirt, strength=0.08, scale=0.5, seed=seed + 71)
    decimate(skirt, 0.5)
    apply_modifiers(skirt)
    parts.append(skirt)

    rock = parts
    finish(coll, rock, name, *envelope)
    return coll, rock


clear_default_scene()

# legacy bbox envelopes (max horiz half-extent, top z, bottom z) — collider contract
BOULDERS = [
    ("boulder_a", 101, build_boulder_a),
    ("boulder_b", 202, build_boulder_b),
    ("boulder_c", 303, build_boulder_c),
]
# (name, authored height, base radius, seed, companion spires, squat, envelope)
SEAROCKS = [
    ("searock_a", 10.0, 3.4, 404, 3, False, (5.163, 10.050, -1.026)),
    ("searock_b", 14.0, 4.2, 505, 3, False, (8.185, 14.156, -1.268)),
    ("searock_c", 6.0, 2.6, 606, 4, True,  (4.560, 5.964, -0.785)),
]

for name, seed, builder in BOULDERS:
    builder(name, seed)
    print(f"built {name}")
for name, h, br, seed, comp, squat, env in SEAROCKS:
    build_searock(name, h, br, seed, comp, squat, env)
    print(f"built {name}")

render_nature(('boulder_b', 'searock_a'), RENDER_DIR)
print("ROCKS DONE")
