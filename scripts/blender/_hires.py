"""HIGH-POLY FORM HELPERS (b3.4b; assets-14, PLAN 3.12 / D5 / D6).

The 2026-09 helpers (_helpers.py) default to 10-segment cylinders and 1-segment bevels, which is
where the "primitive tells within 5 m" of the audit come from: 6-10-sided round parts, uncapped
tubes, flat-shaded faceting. This module is the shared replacement every hero/family build uses:

  segments_for(radius, view)   segment count from the SCREEN SIZE a round part reaches (never < 12)
  lathe(name, profile, n)      revolve an (r, z) profile: barrels, cannon barrels, lantern bodies,
                               turned handles; capped (closed, manifold) unless told otherwise;
                               closed profiles give rings/hoops; radius_fn adds staves/fluting
  loft(name, path, section)    sweep a 2D section along a 3D path with parallel-transport frames
                               (no twist flips), per-station scale/twist: rails, hilts, rope, knees
  circle / rounded_rect / bezier   section and path builders for loft
  bevel(obj, width, 2|3)       2-3 segment angle-limited bevel with hardened normals
  weighted_normals(obj)        face-area weighted normals, sharp edges kept
  stats(obj)                   tris / verts / non-manifold edges (what the gates grade)

Everything is plain bpy + bmesh, so a build script imports it after
`sys.path.insert(0, os.path.dirname(__file__))`. Authoring is in Blender space (Z up); hero
builders that author in game space keep using `_atlas.G()` for positions.
"""
import math

import bmesh
import bpy
from mathutils import Vector

# PLAN 3.12: "no uncapped or 6-10-sided round parts". 12 is the floor for ANY round part, even far.
MIN_ROUND_SEGMENTS = 12
MAX_ROUND_SEGMENTS = 96

# Screen-size presets: the NEAREST distance (m) a part is normally seen from, at the game's 70 deg
# vertical FOV. fp = viewmodel (weapon/tool in hand), hero = a crewmate's gear / deck hardware at
# arm's length, hardware = cannon/wheel/capstan from the deck, prop = island props, far = LOD2 band.
VIEW = {
    'fp': 0.35,
    'hero': 1.5,
    'hardware': 2.5,
    'prop': 5.0,
    'far': 40.0,
}


def segments_for(radius, view='prop', dist=None, fov_deg=70.0, screen_h=1080, edge_px=8.0,
                 lo=MIN_ROUND_SEGMENTS, hi=MAX_ROUND_SEGMENTS, multiple=4):
    """Segment count so one polygon edge of a round part of `radius` (m) spans <= `edge_px` pixels
    at the nearest distance it is seen from (a 1080p screen). Rounded UP to a multiple of 4 (so
    quarter-turn features land on vertices) and clamped to [lo, hi]; lo is never below 12."""
    if radius <= 0:
        raise ValueError(f'segments_for: radius must be > 0, got {radius}')
    d = float(dist if dist is not None else VIEW[view])
    px_per_m = screen_h / (2.0 * d * math.tan(math.radians(fov_deg) / 2.0))
    n = math.ceil(2.0 * math.pi * radius * px_per_m / edge_px)
    n = max(max(lo, MIN_ROUND_SEGMENTS), min(hi, n))
    return int(math.ceil(n / multiple) * multiple)


def _link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def _finish(name, bm, collection, material, smooth):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        me.shade_smooth()
    obj = _link(bpy.data.objects.new(name, me), collection)
    if material is not None:
        me.materials.append(material)
    return obj


def lathe(name, profile, segments, cap_start=True, cap_end=True, closed=False, radius_fn=None,
          collection=None, material=None, smooth=True, sharp_angle_deg=40.0):
    """Revolve `profile` [(r, z), ...] (bottom to top) about Blender +Z into `segments` columns.

    r == 0 at an end collapses that ring to a pole (no cap needed). Open ends are capped with an
    n-gon unless cap_start/cap_end is False. `closed=True` treats the profile as a loop (a hoop,
    a torus-like rim): no caps, the last point joins the first. `radius_fn(i, theta, r, z) -> r`
    perturbs the radius per column (barrel staves, fluting, octagonal grips).
    Sharp edges are marked from `sharp_angle_deg` so smooth shading keeps real creases."""
    if segments < MIN_ROUND_SEGMENTS:
        raise ValueError(f'lathe {name}: {segments} segments < {MIN_ROUND_SEGMENTS} (PLAN 3.12)')
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        if r <= 1e-7:
            rings.append([bm.verts.new((0.0, 0.0, z))])
            continue
        ring = []
        for i in range(segments):
            t = 2.0 * math.pi * i / segments
            rr = radius_fn(i, t, r, z) if radius_fn else r
            ring.append(bm.verts.new((rr * math.cos(t), rr * math.sin(t), z)))
        rings.append(ring)
    pairs = list(zip(rings[:-1], rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(segments):
            j = (i + 1) % segments
            if len(a) == 1:
                bm.faces.new((a[0], b[i], b[j]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[j], b[0]))
            else:
                bm.faces.new((a[i], a[j], b[j], b[i]))
    if not closed:
        if cap_start and len(rings[0]) > 1:
            bm.faces.new(list(reversed(rings[0])))
        if cap_end and len(rings[-1]) > 1:
            bm.faces.new(rings[-1])
    obj = _finish(name, bm, collection, material, smooth)
    if smooth:
        obj.data.set_sharp_from_angle(angle=math.radians(sharp_angle_deg))
    return obj


# ── loft ─────────────────────────────────────────────────────
def circle(n, r=1.0):
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def rounded_rect(w, h, radius, corner_segments=3):
    """Closed 2D section, counter-clockwise, corners rounded with `corner_segments` + 1 points."""
    radius = min(radius, w / 2 - 1e-5, h / 2 - 1e-5)
    pts = []
    for cx, cy, a0 in ((w / 2 - radius, h / 2 - radius, 0.0), (-w / 2 + radius, h / 2 - radius, 90.0),
                       (-w / 2 + radius, -h / 2 + radius, 180.0), (w / 2 - radius, -h / 2 + radius, 270.0)):
        for k in range(corner_segments + 1):
            a = math.radians(a0 + 90.0 * k / corner_segments)
            pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return pts


def bezier(p0, p1, p2, p3, n):
    """n + 1 points on a cubic Bezier (Vectors or tuples)."""
    p0, p1, p2, p3 = (Vector(p) for p in (p0, p1, p2, p3))
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3)
    return out


def _frames(path):
    """Parallel-transport frames (T, N, B) along a polyline: no Frenet flips on straight runs."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    tans = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        t = (b - a)
        tans.append(t.normalized() if t.length > 1e-9 else Vector((0, 0, 1)))
    ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - tans[0] * ref.dot(tans[0])).normalized()
    frames = []
    for i in range(n):
        if i > 0:
            q = tans[i - 1].rotation_difference(tans[i])
            nrm = (q @ nrm)
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
        frames.append((tans[i], nrm, tans[i].cross(nrm)))
    return pts, frames


def loft(name, path, section, scales=None, twist_deg=None, cap=True, collection=None, material=None,
         smooth=True, sharp_angle_deg=40.0):
    """Sweep the closed 2D `section` [(x, y), ...] along `path` [3D points]. `scales` (per station,
    float or (sx, sy)) tapers it, `twist_deg` (per station) rotates it about the path. Ends are
    capped (closed manifold) unless cap=False."""
    pts, frames = _frames(path)
    if len(section) < 3 or len(pts) < 2:
        raise ValueError(f'loft {name}: need >= 3 section points and >= 2 path points')
    bm = bmesh.new()
    rings = []
    for i, (p, (t, nrm, bi)) in enumerate(zip(pts, frames)):
        s = scales[i] if scales is not None else 1.0
        sx, sy = (s, s) if not isinstance(s, (tuple, list)) else s
        tw = math.radians(twist_deg[i]) if twist_deg is not None else 0.0
        c, sn = math.cos(tw), math.sin(tw)
        ring = []
        for (x, y) in section:
            x, y = x * sx, y * sy
            x, y = x * c - y * sn, x * sn + y * c
            ring.append(bm.verts.new(p + nrm * x + bi * y))
        rings.append(ring)
    m = len(section)
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(m):
            j = (k + 1) % m
            bm.faces.new((a[k], a[j], b[j], b[k]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    obj = _finish(name, bm, collection, material, smooth)
    if smooth:
        obj.data.set_sharp_from_angle(angle=math.radians(sharp_angle_deg))
    return obj


# ── bevels + normals ─────────────────────────────────────────
def _apply(obj, mod):
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj],
                                   selected_editable_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def bevel(obj, width, segments=2, angle_deg=30.0, profile=0.5, harden=True, apply=True,
          weighted=True):
    """PLAN 3.12 "generous 2-3 segment bevels with weighted normals": angle-limited bevel so only
    real creases round off, clamp overlap on, hardened normals, then weighted normals."""
    if segments not in (2, 3):
        raise ValueError(f'bevel {getattr(obj, "name", obj)}: segments must be 2 or 3 (PLAN 3.12), got {segments}')
    mod = obj.modifiers.new('hires_bevel', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(angle_deg)
    mod.profile = profile
    mod.use_clamp_overlap = True
    mod.harden_normals = harden
    if apply:
        _apply(obj, mod)
    if weighted:
        weighted_normals(obj, apply=apply)
    return obj


def weighted_normals(obj, weight=50, keep_sharp=True, sharp_angle_deg=40.0, apply=True):
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_angle_deg))
    mod = obj.modifiers.new('hires_wn', 'WEIGHTED_NORMAL')
    mod.weight = weight
    mod.keep_sharp = keep_sharp
    mod.mode = 'FACE_AREA'
    if apply:
        _apply(obj, mod)
    return obj


def stats(obj):
    """{'tris', 'verts', 'non_manifold'} of the evaluated mesh (modifiers included)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    out = {'tris': tris, 'verts': len(bm.verts), 'non_manifold': nm}
    bm.free()
    ev.to_mesh_clear()
    return out


def join(objs, name):
    """Join meshes into the first; returns it renamed."""
    base = objs[0]
    with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    base.name = name
    base.data.name = name
    return base
