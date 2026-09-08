# HERO WEAPONS (WEAPON-01 / assets-15) — cutlass, flintlock, flintknock,
# eye_of_reach, blunderbuss as authored GLBs with one baked atlas each.
#
# WHAT THEY REPLACE. `WeaponMeshFactory.makeHeldWeaponMesh` unions 20-40 THREE
# primitives per weapon, and that union fills the lower third of the screen for
# the whole match: box blades, 8-segment barrels, a cone tip. Every one of those
# primitives is also its own draw call in the viewmodel layer.
#
# FRAME (game space, and the GLB must match the procedural fallback exactly or
# the viewmodel jumps when the file lands):
#   * origin = the GRIP, at (0,0,0) — the hand anchor.
#   * guns point +Z (muzzle forward), sights up +Y, lock plate to +X.
#   * the cutlass blade runs up +Y.
# Blender authoring axes: game +Z = Blender -Y, game +Y = Blender +Z (export_yup).
#
# NODE NAMES ARE AN API. `hammer`, `trigger` and `muzzle` stay separate objects
# (the fire/reload animation and the muzzle flash anchor address them by name);
# the eye_of_reach's scope parts are named `scope_*` because the client hides
# everything else when you look down it (ViewmodelController.eorKeepInScope).
# Everything else joins into `<name>_body`, so a weapon is 2-6 draws, not 40.
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/build_weapons.py
import os
import bpy
import bmesh
import math
import random
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, '_helpers.py')).read())
exec(open(os.path.join(HERE, '_ao.py')).read())
exec(open(os.path.join(HERE, '_detail.py')).read())
exec(open(os.path.join(HERE, '_atlas.py')).read())

if os.environ.get('WEAPONS_OUT'):
    EXPORT_DIR = os.environ['WEAPONS_OUT']  # noqa: F811

ATLAS_SIZE = int(os.environ.get('WEAPONS_ATLAS', '512'))
# Round-count multiplier. A hero weapon is graded at 4-8k tris
# (scripts/test-hero-assets.mjs [a]): under it the barrels read as octagons at
# 40 cm, over it the viewmodel layer eats the low tier's triangle budget.
DENSITY = float(os.environ.get('WEAPONS_DENSITY', '1.7'))


def _segs(n):
    return max(6, int(round(n * DENSITY)))

EXTRA = {
    'Steel_Blade':  ((0.52, 0.56, 0.60, 1.0), 0.30, 0.90),
    'Steel_Edge':   ((0.78, 0.82, 0.86, 1.0), 0.18, 0.95),
    'Gun_Iron':     ((0.17, 0.18, 0.20, 1.0), 0.42, 0.85),
    'Brass_Worn':   ((0.62, 0.45, 0.16, 1.0), 0.44, 0.80),
    'Walnut':       ((0.20, 0.12, 0.07, 1.0), 0.72, 0.0),
    'Walnut_Light': ((0.31, 0.19, 0.10, 1.0), 0.70, 0.0),
    'Leather_Wrap': ((0.16, 0.11, 0.08, 1.0), 0.88, 0.0),
    'Lens_Glass':   ((0.30, 0.52, 0.62, 1.0), 0.12, 0.0),
}
for k, v in EXTRA.items():
    PALETTE.setdefault(k, v)

clear_default_scene()


# ── game-space authoring helpers ─────────────────────────────
def G(x, y, z):
    """game (right, up, forward) -> Blender (x, y, z)."""
    return Vector((x, -z, y))


def _axis_rot(axis):
    if axis == 'y':
        return Matrix.Identity(4)
    if axis == 'z':
        return Matrix.Rotation(math.radians(90), 4, 'X')
    return Matrix.Rotation(math.radians(90), 4, 'Y')


def cyl(coll, name, r1, r2, length, center, axis='z', mname='Gun_Iron',
        segs=18, smooth=True, tilt=None, bevel=0.0):
    bm = bm_cylinder(r1, r2, length, segs=_segs(segs))
    M = Matrix.Translation(G(*center)) @ (tilt or Matrix.Identity(4)) @ _axis_rot(axis)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel, segments=2)
        apply_modifiers(o)
    return o


def box(coll, name, w, h, d, center, mname='Walnut', tilt=None, bevel=0.006,
        smooth=False, segments=3):
    """w along game x, h along game y, d along game z."""
    bm = bm_box(w, d, h)
    M = Matrix.Translation(G(*center)) @ (tilt or Matrix.Identity(4))
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bmesh(name, bm, coll, mat(mname), smooth=smooth)
    if bevel:
        bevel_obj(o, width=bevel, segments=segments)
        apply_modifiers(o)
    return o


def ring(coll, name, R, r, center, axis='z', mname='Brass_Worn', segs=18, rings=8):
    bm = bm_torus(R, r, segs=_segs(segs), rings=_segs(rings))
    M = Matrix.Translation(G(*center)) @ _axis_rot(axis)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)


def sphere(coll, name, r, center, mname='Brass_Worn', subdiv=2, scale=(1, 1, 1)):
    bm = bm_icosphere(r, subdiv=subdiv)
    M = (Matrix.Translation(G(*center))
         @ Matrix.Diagonal(Vector((scale[0], scale[2], scale[1]))).to_4x4())
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, coll, mat(mname), smooth=True)


def arc(coll, name, pts, r1, r2, mname='Brass_Worn', segs=10):
    """A swept bar through game-space points (knuckle bow, trigger guard)."""
    return chain_pts(coll, name, [G(*p) for p in pts], r1, r2, mat(mname), segs=_segs(segs))


# ── the five weapons ─────────────────────────────────────────
def build_cutlass(name='cutlass'):
    coll = asset_collection(name)
    body = []
    # Grip: leather over a tapered core, four lashing rings.
    body.append(cyl(coll, 'grip', 0.030, 0.024, 0.16, (0, -0.082, 0), 'y',
                    'Leather_Wrap', segs=20))
    for i, y in enumerate((-0.145, -0.115, -0.085, -0.055, -0.025)):
        body.append(ring(coll, f'grip_lash_{i}', 0.029, 0.0055, (0, y, 0), 'y',
                         'Leather_Wrap', segs=18, rings=6))
    body.append(sphere(coll, 'pommel', 0.040, (0, -0.176, 0), 'Brass_Worn',
                       subdiv=3, scale=(1, 0.85, 1)))
    body.append(cyl(coll, 'pommel_collar', 0.030, 0.034, 0.028, (0, -0.155, 0), 'y',
                    'Brass_Worn', segs=20))
    # Guard: quillon block + a knuckle bow sweeping to the pommel + a shell.
    body.append(box(coll, 'quillon', 0.20, 0.030, 0.056, (0, 0.010, 0),
                    'Brass_Worn', bevel=0.008, smooth=False))
    body.append(arc(coll, 'knuckle_bow', [
        (0.092, 0.012, 0.004), (0.128, -0.020, 0.010), (0.140, -0.072, 0.012),
        (0.120, -0.126, 0.010), (0.062, -0.164, 0.004), (0.010, -0.172, 0.0),
    ], 0.013, 0.010, 'Brass_Worn', segs=10))
    body.append(arc(coll, 'shell_guard', [
        (-0.030, 0.020, -0.052), (-0.062, 0.006, -0.020), (-0.070, 0.000, 0.020),
        (-0.044, 0.010, 0.052),
    ], 0.016, 0.014, 'Brass_Worn', segs=10))
    # Blade: three swept, tapered segments + a ground edge strip + fuller.
    segs = [(0.148, 0.30, 0.062, 0.0, 0.000), (0.448, 0.30, 0.056, 0.05, 0.012),
            (0.742, 0.28, 0.046, 0.11, 0.038)]
    for i, (y, ln, w, tilt, x) in enumerate(segs):
        rot = Matrix.Rotation(-tilt, 4, 'Y')  # game roll about +Z
        body.append(box(coll, f'blade_{i}', w, ln, 0.023, (x, y, 0),
                        'Steel_Blade', tilt=rot, bevel=0.006, segments=3))
        body.append(box(coll, f'blade_edge_{i}', 0.013, ln, 0.027,
                        (x + w * 0.46, y, 0), 'Steel_Edge', tilt=rot,
                        bevel=0.004, segments=2))
        body.append(box(coll, f'blade_fuller_{i}', 0.016, ln * 0.9, 0.030,
                        (x - w * 0.10, y, 0), 'Gun_Iron', tilt=rot,
                        bevel=0.004, segments=2))
    body.append(cyl(coll, 'blade_tip', 0.034, 0.002, 0.17, (0.064, 0.965, 0), 'y',
                    'Steel_Edge', segs=16, tilt=Matrix.Rotation(-0.14, 4, 'Y')))
    body.append(cyl(coll, 'ricasso', 0.034, 0.030, 0.045, (0, 0.030, 0), 'y',
                    'Steel_Blade', segs=18))
    return coll, {f'{name}_body': body}


def build_gun(name, barrel_len=0.72, barrel_r=(0.021, 0.028), muzzle_r=(0.048, 0.040),
              butt_len=0.36, butt_z=-0.32, scope=False, flare=False, ramrod=True):
    """One parameterised flintlock family: pistol, hand cannon, musket, blunderbuss."""
    coll = asset_collection(name)
    body, extra = [], {}
    z0 = 0.10  # breech
    # Stock: butt -> wrist -> grip -> fore-end, all walnut.
    body.append(cyl(coll, 'butt', 0.086, 0.128, butt_len, (0, -0.038, butt_z), 'z',
                    'Walnut', segs=18))
    body.append(box(coll, 'butt_plate', 0.128, 0.176, 0.034,
                    (0, -0.050, butt_z - butt_len * 0.55), 'Brass_Worn', bevel=0.008))
    body.append(cyl(coll, 'wrist', 0.050, 0.066, abs(butt_z) * 0.85,
                    (0, -0.014, butt_z * 0.42), 'z', 'Walnut_Light', segs=16))
    body.append(cyl(coll, 'grip', 0.038, 0.054, 0.24, (0, -0.138, -0.040), 'y',
                    'Walnut', segs=16, tilt=Matrix.Rotation(-0.24, 4, 'X')))
    body.append(cyl(coll, 'fore_end', 0.044, 0.058, barrel_len * 0.9,
                    (0, 0.006, z0 + barrel_len * 0.42), 'z', 'Walnut_Light', segs=16))
    # Lock: plate, frizzen, pan; the hammer is its own node.
    body.append(box(coll, 'receiver', 0.092, 0.084, 0.16, (0, 0.034, z0 - 0.05),
                    'Gun_Iron', bevel=0.006))
    body.append(box(coll, 'lock_plate', 0.022, 0.066, 0.150, (0.058, 0.048, z0 - 0.07),
                    'Brass_Worn', bevel=0.005))
    body.append(box(coll, 'frizzen', 0.026, 0.052, 0.038, (0.050, 0.084, z0 - 0.02),
                    'Gun_Iron', bevel=0.005))
    # Barrel + bands.
    body.append(cyl(coll, 'barrel', barrel_r[0], barrel_r[1], barrel_len,
                    (0, 0.072, z0 + barrel_len * 0.5), 'z', 'Gun_Iron', segs=22))
    for i, t in enumerate((0.18, 0.46, 0.76)):
        body.append(ring(coll, f'band_{i}', barrel_r[0] + 0.030 + (t * 0.02 if flare else 0),
                         0.010, (0, 0.052, z0 + barrel_len * t), 'z',
                         'Brass_Worn', segs=18, rings=6))
    if ramrod:
        body.append(cyl(coll, 'ramrod', 0.011, 0.011, barrel_len * 0.88,
                        (0, -0.048, z0 + barrel_len * 0.46), 'z', 'Walnut', segs=10))
    body.append(cyl(coll, 'front_sight', 0.010, 0.006, 0.030,
                    (0, 0.072 + barrel_r[1] + 0.014, z0 + barrel_len * 0.92), 'y',
                    'Brass_Worn', segs=10))
    body.append(cyl(coll, 'pan', 0.020, 0.024, 0.020, (0.040, 0.070, z0 - 0.045), 'y',
                    'Brass_Worn', segs=14))
    body.append(box(coll, 'breech_tang', 0.030, 0.014, 0.090, (0, 0.062, z0 - 0.13),
                    'Gun_Iron', bevel=0.004))
    for i, t in enumerate((0.30, 0.86)):
        body.append(ring(coll, f'swivel_{i}', 0.018, 0.005,
                         (0, -0.030, z0 + barrel_len * t), 'y', 'Gun_Iron',
                         segs=12, rings=6))
    for i, t in enumerate((-0.10, 0.02)):
        body.append(cyl(coll, f'lock_screw_{i}', 0.007, 0.007, 0.026,
                        (0.062, 0.048, z0 + t), 'x', 'Brass_Worn', segs=10))
    # Trigger guard rides the body; the trigger blade is its own node.
    body.append(arc(coll, 'trigger_guard', [
        (0, -0.052, z0 - 0.13), (0, -0.086, z0 - 0.09), (0, -0.092, z0 - 0.03),
        (0, -0.062, z0 + 0.010),
    ], 0.011, 0.010, 'Brass_Worn', segs=9))

    extra['hammer'] = [
        cyl(coll, 'hammer', 0.017, 0.013, 0.082, (-0.024, 0.108, z0 - 0.075), 'y',
            'Gun_Iron', segs=14, tilt=Matrix.Rotation(0.48, 4, 'Y')),
        box(coll, 'hammer_jaw', 0.030, 0.036, 0.030, (-0.030, 0.142, z0 - 0.062),
            'Gun_Iron', bevel=0.005),
    ]
    extra['trigger'] = [
        cyl(coll, 'trigger', 0.008, 0.006, 0.052, (0, -0.062, z0 - 0.048), 'y',
            'Gun_Iron', segs=10, tilt=Matrix.Rotation(0.35, 4, 'X')),
    ]
    muz_z = z0 + barrel_len + 0.02
    if flare:
        extra['muzzle'] = [
            cyl(coll, 'muzzle', muzzle_r[0], muzzle_r[1], 0.30, (0, 0.072, muz_z - 0.12),
                'z', 'Gun_Iron', segs=24),
            cyl(coll, 'muzzle_lip', muzzle_r[0] + 0.022, muzzle_r[0], 0.070,
                (0, 0.072, muz_z + 0.030), 'z', 'Brass_Worn', segs=24),
        ]
    else:
        extra['muzzle'] = [
            cyl(coll, 'muzzle', muzzle_r[0], muzzle_r[1], 0.075, (0, 0.072, muz_z), 'z',
                'Brass_Worn', segs=20),
        ]
    if scope:
        sc = []
        sc.append(cyl(coll, 'scope_tube', 0.034, 0.034, 0.48, (0, 0.158, z0 + 0.16),
                      'z', 'Gun_Iron', segs=22))
        sc.append(cyl(coll, 'scope_rear', 0.046, 0.062, 0.12, (0, 0.158, z0 - 0.12),
                      'z', 'Brass_Worn', segs=20))
        sc.append(cyl(coll, 'scope_front', 0.064, 0.044, 0.13, (0, 0.158, z0 + 0.45),
                      'z', 'Brass_Worn', segs=20))
        sc.append(cyl(coll, 'scope_lens', 0.048, 0.048, 0.012, (0, 0.158, z0 + 0.52),
                      'z', 'Lens_Glass', segs=20))
        for i, t in enumerate((-0.02, 0.24)):
            sc.append(box(coll, f'scope_mount_{i}', 0.026, 0.090, 0.036,
                          (0, 0.110, z0 + t), 'Brass_Worn', bevel=0.005))
        extra['scope'] = sc
    return coll, dict({f'{name}_body': body}, **extra)


BUILDS = [
    build_cutlass('cutlass'),
    build_gun('flintlock', barrel_len=0.72, butt_len=0.30, butt_z=-0.26),
    build_gun('flintknock', barrel_len=0.50, barrel_r=(0.030, 0.038),
              muzzle_r=(0.060, 0.050), butt_len=0.34, butt_z=-0.28),
    build_gun('eye_of_reach', barrel_len=1.34, barrel_r=(0.021, 0.028),
              butt_len=0.42, butt_z=-0.36, scope=True),
    build_gun('blunderbuss', barrel_len=0.76, barrel_r=(0.046, 0.062),
              muzzle_r=(0.120, 0.092), butt_len=0.38, butt_z=-0.33, flare=True),
]

SPEC = tint_spec(moss=0.0, damp=False)
SPEC['*'] = dict(tone=0.10, mottle=0.06, mscale=0.45)

for coll, groups in BUILDS:
    name = [k for k in groups if k.endswith('_body')][0][:-5]
    bake_ao(coll, samples=18, max_dist=1.2, floor=0.52, height_gradient=0.0)
    tint_pass(coll, SPEC, seed=11, verbose=False)
    hero_atlas(coll, name, size=ATLAS_SIZE)
    for gname, parts in groups.items():
        flat = []
        for p in parts:  # chain_pts/arc hand back a LIST of segments
            flat.extend(p if isinstance(p, list) else [p])
        parts = [o for o in flat if o.name in bpy.data.objects]
        if len(parts) > 1:
            join(parts, gname)
        else:
            parts[0].name = gname
    path = export_collection_vc(coll, f'{name}.glb')
    info = verify_glb(path)
    print(f'NODES {name}: {sorted(o.name for o in coll.objects)}')
    for o in list(coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)

print('WEAPONS DONE')
