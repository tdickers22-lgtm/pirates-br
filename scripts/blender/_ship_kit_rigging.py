# SHIP KIT II (b4.3b; ships-07, ships-09, verifier assets missing[0]): the deck, rig and ground-tackle parts of
# the Blender ship kit. Not a standalone script: build_ship_kit.py exec()s this file when KIT=b, so every helper
# (box/lathe/ball/torus/tube/ring_loft/bez/line/spiral/pane/sock/seg, MATS, the density loop, the ONE baked
# trim atlas, per-node LOD export, the contact sheet) is shared with kit I and only the PART LIST differs.
#
#   KIT=b /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/build_ship_kit.py
#   -> public/assets/models/ship_kit_b.glb + ship_kit_b_lods.glb, docs/asset-sheets/ship-kit/ship_kit_b.png
#
# PARTS (top-level nodes; every part has its own band + LOD chain, test-asset-tiers `ship-kit` tier):
#   channel           channel board with moulded edge, 4 capped chainplate notches, 3 iron knee brackets   2-8k
#   deadeye_pair      chainplate + iron-stropped lower deadeye, rope lanyard rove through 3 holes, upper
#                     deadeye turned into the shroud end with seizings (one per shroud, at a channel notch)  1-4k
#   pin_rail          bulwark pin rail on two knees, 8 turned belaying pins, 3 hanging rope coils             2-6k
#   bell_belfry       turned posts, crossbeam, scroll-ended cap, knee braces                              \
#   bell              bronze bell (lip, waist, shoulder bands, crown loop), headstock, clapper, bell rope   / 2-8k
#   taffrail_lantern  hexagonal stern lantern: gilt base, 6 bronze posts, domed vented top, finial, scroll
#                     feet; panes on taffrail_lantern_glass (Glass_Gallery, emissive, NO light)              3-5k
#   crows_nest        round top: planked floor ring with mast hole, slatted wall with a ladder entry gap,
#                     split top + mid rails, trestle trees, crosstrees, 4 futtock shrouds, mast band       3-8k
#   cannonball_rack   shot garland: plank on legs, 2 x 5 tarred recesses, 10 iron round shot             2-6k
#   barrel            on-deck cask: 18 grooved staves with bilge, recessed heads, 4 flush iron hoops, bung
#                     (replaces the dressing.ts barrel whose black torus hoops read as a tyre stack)      1.5-4k
#   bilge_pump        elm-tree pump: banded trunk, cistern head, spout, fulcrum cheeks;
#   bilge_pump_handle brake lever + crossbar grip + spear (pivots)                                         2-6k
#   anchor            admiralty anchor: ring with puddening, banded wooden stock, square shank, crown,
#                     curved arms with spade palms and bills                                              3-8k
#   anchor_cable      TILEABLE 1.0 m of 3-strand cable laid along +Z (3 whole turns: tile end to end)    1-3k
#   hawse             iron-lined hawse hole in a bolster with a bolt ring                                   1-3k
#   rig_block         single-sheave block: two cheeks, grooved sheave, pin, rope strop, iron thimble       1-3k
#
# FRAMES (the API b4.3c mounts by; same rules as kit I: origin AT THE MOUNT, x right, y up, z out):
#   hull/bulwark parts (channel, deadeye_pair, pin_rail, hawse): +Z = OUT along the surface normal (outboard
#     for channel/deadeye_pair/hawse, inboard off the bulwark face for pin_rail), +Y up, X along the ship.
#   deck parts (bell_belfry, bell, cannonball_rack, barrel, bilge_pump, taffrail_lantern): +Y = deck normal,
#     +Z = toward the bow; their mount socket has out = +Y (the surface normal) and up = +Z.
#   crows_nest: origin on the mast axis under the floor, +Y up the mast, +Z forward; floor hole r 0.17.
#   anchor: origin at the top of the ring, shank hangs down -Y, arms spread in +-X, stock along Z.
#   rig_block: origin at the thimble top, block hangs down -Y, sheave turns about X.
#   Pivoting nodes: bell (origin on the headstock axle, swings with rotation.x), bilge_pump_handle (origin on
#   the fulcrum pin, strokes with rotation.x within +-0.35 rad; the grip end is the -Z end).
#   Rigging endpoints (ships-09): sock_deadeye_shroud (shroud start, out up the shroud), sock_pin_rail_pin_k
#   (halyard/sheet belay), sock_rig_block / sock_rig_block_sheave (braces, lifts), sock_crows_nest_futtock_k.
SHEET = os.environ.get('KIT_SHEET', os.path.join(ROOT, 'docs', 'asset-sheets', 'ship-kit', 'ship_kit_b.png'))
ATLAS = 'ship_trim_b'
CAGE = 0.003  # 3 mm for the 7-9 mm ropes; measured: no change vs the 6 mm kit I cage (the dark ropes are texel starvation of sub-cm UV islands in the 1024 atlas, not the cage)
SOURCES = SOURCES + ['hessian_230']
MATS['rope'] = P.source_material('KIT_Rope', 'hessian_230', scale=3.0, tint=(0.70, 0.56, 0.38), wear=0.10)
MATS['bronze'] = P.metal_material('KIT_Bronze', 'metal_plate', 'brass', scale=2.0, tint=(0.70, 0.48, 0.24), wear=0.25)
MATS['tar'] = P.source_material('KIT_Tar', 'brown_planks_03', scale=1.0, tint=(0.10, 0.08, 0.06), wear=0.05)
# (lo, hi, density target): the band is PLAN section 6 row 11 (1-8k each); the target keeps the parts that are
# instanced many times per ship (deadeyes, blocks, cable tiles, barrels) near the low end. Bolts and seizings
# set a floor the density loop cannot go under (lathe >= 12 segments, PLAN 3.12).
PB = {'channel': (2000, 8000, 5000), 'deadeye': (1000, 6000, 3000), 'm': (2000, 8000, 5000), 'lant': (3000, 5000, 4000),
      'l': (3000, 8000, 6000), 'barrel': (1500, 5000, 3000), 't': (1000, 4000, 2000)}


def lobed(n, k=3, a=0.14):
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        r = 1 + a * math.cos(k * t)
        out.append((r * math.cos(t), r * math.sin(t)))
    return out


def rope(coll, nm, pts, r, cap=True):
    """Laid rope: 3-lobe section twisted at a lay length of ~16 radii."""
    L = sum((Vector(b) - Vector(a)).length for a, b in zip(pts, pts[1:]))
    turns = L / (r * 16)
    return tube(coll, nm, pts, 'rope', r, sec=lobed(max(9, seg(12, 9) // 3 * 3)), twist=lambda t: 360 * turns * t, cap=cap)


def sag(p0, p1, s, n):
    L = (Vector(p1) - Vector(p0)).length
    out = []
    for i in range(n + 1):
        t = i / n
        p = [a + (b - a) * t for a, b in zip(p0, p1)]
        p[1] -= 4 * s * L * t * (1 - t)
        out.append(tuple(p))
    return out


def ring_pts(c, R, n, axis='y', a0=0.0, a1=2 * math.pi):
    out = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        if axis == 'y':
            out.append((c[0] + R * math.sin(a), c[1], c[2] + R * math.cos(a)))
        elif axis == 'z':
            out.append((c[0] + R * math.cos(a), c[1] + R * math.sin(a), c[2]))
        else:
            out.append((c[0], c[1] + R * math.sin(a), c[2] + R * math.cos(a)))
    return out


def hoop(coll, nm, r, y, w, at_axis, at, mat='iron', t=0.008):
    """A flush hoop/band lathe ring of radius r about the axis through `at`, centred `y` along it."""
    prof = [(r - 0.002, y - w / 2), (r + t * 0.7, y - w / 2), (r + t, y - w * 0.3), (r + t, y + w * 0.3), (r + t * 0.7, y + w / 2), (r - 0.002, y + w / 2)]
    return lathe(coll, nm, prof, at_axis, at, mat, 40, closed=True)


def deadeye(coll, nm, at, R, parts, top=True):
    T = R * 0.66
    prof = [(0.0, -T / 2), (R * 0.80, -T / 2), (R * 0.95, -T * 0.42), (R, -T * 0.24), (R * 0.88, -T * 0.08),
            (R * 0.88, T * 0.08), (R, T * 0.24), (R * 0.95, T * 0.42), (R * 0.80, T / 2), (0.0, T / 2)]
    parts.append(lathe(coll, nm, prof, 'z', at, 'oak_dark', 28))
    holes = []
    for k in range(3):
        a = (math.pi / 2 if top else -math.pi / 2) + 2 * math.pi * k / 3
        hp = (at[0] + 0.46 * R * math.cos(a), at[1] + 0.46 * R * math.sin(a), at[2])
        parts.append(lathe(coll, f'{nm}_hole{k}', [(0.0, -T / 2 - 0.0015), (0.2 * R, -T / 2 - 0.0015), (0.2 * R, T / 2 + 0.0015), (0.0, T / 2 + 0.0015)], 'z', hp, 'tar', 12))
        holes.append(hp)
    return holes, T


# ── hull / bulwark parts ─────────────────────────────────────────────────────
def build_channel(coll):
    L, Wd, Th = 2.4, 0.46, 0.09
    p = [box(coll, 'cn_board', L, Th, Wd, (0, -Th / 2, Wd / 2), 'oak', bev=0.015)]
    p.append(tube(coll, 'cn_mould', line((-L / 2, -Th / 2, Wd + 0.005), (L / 2, -Th / 2, Wd + 0.005), seg(8, 4)), 'oak_dark', (0.028, 0.05), sec=rrect()))
    for k in range(4):
        x = -0.9 + 0.6 * k
        p.append(box(coll, f'cn_cap{k}', 0.09, 0.016, 0.12, (x, 0.008, Wd - 0.05), 'iron', bev=0.004))
        for b in (-1, 1):
            p.append(ball(coll, f'cn_capbolt{k}{b}', 0.011, (x + b * 0.03, 0.018, Wd - 0.09), 'iron', 10, scale=(1, 0.5, 1)))
    for k, x in enumerate((-1.0, 0.0, 1.0)):
        kp = bez((x, -0.55, 0.02), (x, -0.30, 0.03), (x, -0.12, 0.12), (x, -Th - 0.005, Wd * 0.8), seg(14))
        p.append(tube(coll, f'cn_knee{k}', kp, 'iron', taper(0.030, 0.020), sec=rrect()))
        for b in range(3):
            p.append(ball(coll, f'cn_kbolt{k}{b}', 0.013, (x, -0.50 + b * 0.14, 0.04), 'iron', 10))
    for b in range(10):
        p.append(ball(coll, f'cn_bolt{b}', 0.012, (-1.1 + 0.244 * b, -Th * 0.5, 0.012), 'iron', 10, scale=(1, 1, 0.5)))
    sock('channel', 'sock_channel', (0, 0, 0))
    for k in range(4):
        sock('channel', f'sock_channel_notch_{k}', (-0.9 + 0.6 * k, 0.0, Wd - 0.05))
    return {'channel': (p, None)}


def build_deadeye_pair(coll):
    R = 0.075
    p = []
    lo_c, up_c = (0, 0.11, 0.0), (0, 0.42, 0.0)
    lh, T = deadeye(coll, 'de_lower', lo_c, R, p, top=True)
    uh, _ = deadeye(coll, 'de_upper', up_c, R, p, top=False)
    p.append(torus(coll, 'de_strop', R * 0.90, 0.008, 'z', lo_c, 'iron', 32, 8))
    cp = bez((0, lo_c[1] - R * 0.95, 0), (0, -0.15, 0.0), (0, -0.42, -0.22), (0, -0.72, -0.40), seg(14))
    p.append(tube(coll, 'de_chainplate', cp, 'iron', (0.024, 0.011), sec=rrect()))
    p.append(torus(coll, 'de_link', 0.034, 0.010, 'x', (0, -0.30, -0.10), 'iron', 20, 8))
    p.append(box(coll, 'de_footplate', 0.07, 0.16, 0.02, (0, -0.74, -0.41), 'iron', bev=0.005))
    for b in range(3):
        p.append(ball(coll, f'de_bolt{b}', 0.012, (0, -0.68 - b * 0.05, -0.395), 'iron', 10, scale=(1, 1, 0.5)))
    # lanyard: rove through the three hole pairs, alternating faces, with a short tail
    for k in range(3):
        a, b = uh[k], lh[(k + 1) % 3]
        dz = T / 2 * (1 if k % 2 == 0 else -1)
        p.append(rope(coll, f'de_lanyard{k}', [(a[0], a[1], a[2] + dz), ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dz * 1.2), (b[0], b[1], b[2] + dz)], 0.0075))
    # shroud turned round the upper deadeye and seized above it
    p.append(torus(coll, 'de_shroud_turn', R * 0.90, 0.013, 'z', up_c, 'rope', 32, 8))
    for sx in (-1, 1):
        p.append(rope(coll, f'de_shroud_leg{sx}', bez((sx * R * 0.85, up_c[1] + 0.03, 0), (sx * R * 0.6, up_c[1] + 0.12, 0), (sx * 0.02, up_c[1] + 0.20, 0), (sx * 0.012, up_c[1] + 0.30, 0), seg(10)), 0.013))
    top = up_c[1] + 0.58
    p.append(rope(coll, 'de_shroud', line((0, up_c[1] + 0.28, 0), (0, top, 0), seg(6, 4)), 0.016))
    for k, y in enumerate((up_c[1] + 0.17, up_c[1] + 0.25)):
        p.append(torus(coll, f'de_seizing{k}', 0.030, 0.007, 'y', (0, y, 0), 'rope', 20, 6))
    sock('deadeye_pair', 'sock_deadeye_pair', (0, 0, 0))
    sock('deadeye_pair', 'sock_deadeye_shroud', (0, top, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('deadeye_pair', 'sock_deadeye_chain', (0, -0.74, -0.42))
    return {'deadeye_pair': (p, None)}


def build_pin_rail(coll):
    L = 1.6
    p = [box(coll, 'pr_rail', L, 0.08, 0.16, (0, 0, 0.08), 'oak', bev=0.014)]
    p.append(tube(coll, 'pr_mould', line((-L / 2, 0.035, 0.165), (L / 2, 0.035, 0.165), seg(8, 4)), 'oak_dark', (0.012, 0.016), sec=rrect()))
    for k, x in enumerate((-0.62, 0.62)):
        kp = bez((x, -0.40, 0.012), (x, -0.22, 0.02), (x, -0.10, 0.07), (x, -0.045, 0.14), seg(12))
        p.append(tube(coll, f'pr_knee{k}', kp, 'oak_dark', taper(0.035, 0.028), sec=rrect()))
    pin = [(0.0, 0.31), (0.012, 0.305), (0.019, 0.285), (0.021, 0.24), (0.018, 0.17), (0.026, 0.155), (0.026, 0.135),
           (0.016, 0.12), (0.014, -0.06), (0.010, -0.11), (0.0, -0.115)]
    for k in range(8):
        x = -0.70 + 0.2 * k
        p.append(lathe(coll, f'pr_pin{k}', pin, 'y', (x, -0.09, 0.09), 'carve', 16))
        sock('pin_rail', f'sock_pin_rail_pin_{k}', (x, 0.07, 0.09), out=(0, 1, 0), up=(0, 0, 1))
    for c, k in enumerate((1, 3, 6)):
        x = -0.70 + 0.2 * k
        p.append(torus(coll, f'pr_turn{c}', 0.024, 0.009, 'y', (x, 0.075, 0.09), 'rope', 20, 6))
        for j in range(3):
            n = seg(28)
            rx_, ry_ = 0.075 + 0.012 * j, 0.48 + 0.04 * j
            cy = 0.075 - 0.5 * ry_ - 0.006 * j
            pts = []
            for i in range(n + 1):
                th = 2 * math.pi * i / n
                y2 = cy - 0.5 * ry_ * math.cos(th)
                w = min(1.0, max(0.0, (y2 - 0.0) / 0.06))  # over the pin at the top, clear of the rail face below
                z2 = 0.09 * w + (0.19 + 0.022 * j + 0.02 * (0.5 + 0.5 * math.cos(th))) * (1 - w)
                pts.append((x + rx_ * math.sin(th) + 0.006 * j, y2, z2))
            p.append(rope(coll, f'pr_coil{c}_{j}', pts, 0.009, cap=False))
    sock('pin_rail', 'sock_pin_rail', (0, 0, 0))
    return {'pin_rail': (p, None)}


def build_hawse(coll):
    prof = [(0.070, -0.16), (0.070, 0.045), (0.078, 0.062), (0.11, 0.070), (0.15, 0.064), (0.165, 0.040),
            (0.16, 0.015), (0.15, 0.0), (0.09, 0.0), (0.082, -0.16)]
    p = [lathe(coll, 'hw_pipe', prof, 'z', (0, 0, 0), 'iron', 40, closed=True)]
    p.append(lathe(coll, 'hw_bolster', [(0.16, -0.02), (0.30, -0.02), (0.33, 0.0), (0.32, 0.03), (0.27, 0.05), (0.17, 0.05)],
                   'z', (0, 0, 0), 'oak_dark', 40, closed=True))
    for k in range(8):
        a = 2 * math.pi * k / 8
        p.append(ball(coll, f'hw_bolt{k}', 0.014, (0.24 * math.cos(a), 0.24 * math.sin(a), 0.045), 'iron', 10, scale=(1, 1, 0.5)))
    sock('hawse', 'sock_hawse', (0, 0, 0))
    sock('hawse', 'sock_hawse_lead', (0, 0, 0.07))
    return {'hawse': (p, None)}


# ── deck parts (+Y deck normal, +Z bow) ──────────────────────────────────────
def build_bell(coll):
    fb, bl = [], []
    post = [(0.0, 0.0), (0.07, 0.0), (0.075, 0.03), (0.06, 0.06), (0.05, 0.12), (0.055, 0.45), (0.045, 0.80),
            (0.06, 0.84), (0.06, 0.88), (0.045, 0.90), (0.045, 1.08), (0.0, 1.08)]
    for sx in (-1, 1):
        fb.append(lathe(coll, f'bf_post{sx}', post, 'y', (sx * 0.34, 0, 0), 'oak', 20))
        for sz in (-1, 1):
            fb.append(tube(coll, f'bf_brace{sx}{sz}', bez((sx * 0.34, 0.42, sz * 0.03), (sx * 0.34, 0.25, sz * 0.12), (sx * 0.34, 0.08, sz * 0.24), (sx * 0.34, 0.01, sz * 0.30), seg(8)),
                           'oak_dark', taper(0.028, 0.034), sec=rrect()))
    fb.append(box(coll, 'bf_beam', 0.86, 0.10, 0.12, (0, 1.12, 0), 'oak', bev=0.012))
    fb.append(box(coll, 'bf_cap', 0.98, 0.04, 0.17, (0, 1.19, 0), 'oak_dark', bev=0.01))
    for sx in (-1, 1):
        fb.append(tube(coll, f'bf_scroll{sx}', spiral((sx * 0.47, 1.12, 0.0), 0.05, 0.012, 0.0, 1.3, seg(24), u=(sx, 0, 0), v=(0, -1, 0)),
                       'gilt', taper(0.018, 0.007), sec=ellipse(1, 1, seg(10, 8))))
        fb.append(box(coll, f'bf_cheek{sx}', 0.03, 0.10, 0.10, (sx * 0.22, 1.05, 0), 'iron', bev=0.005))
    yb = 1.04
    bell = [(0.0, 0.320), (0.05, 0.322), (0.085, 0.305), (0.098, 0.27), (0.103, 0.20), (0.115, 0.12), (0.140, 0.05),
            (0.160, 0.015), (0.165, 0.0), (0.150, -0.004), (0.128, 0.025), (0.098, 0.11), (0.088, 0.22), (0.07, 0.28), (0.0, 0.29)]
    y0 = yb - 0.36
    bl.append(lathe(coll, 'bl_bell', bell, 'y', (0, y0, 0), 'bronze', 40))
    for k, (r, y) in enumerate(((0.101, 0.24), (0.152, 0.03))):
        bl.append(hoop(coll, f'bl_band{k}', r, y, 0.012, 'y', (0, y0, 0), 'bronze', 0.004))
    bl.append(torus(coll, 'bl_crown', 0.032, 0.011, 'z', (0, y0 + 0.345, 0), 'bronze', 20, 8))
    bl.append(box(coll, 'bl_headstock', 0.42, 0.07, 0.08, (0, yb, 0), 'oak_dark', bev=0.01))
    bl.append(lathe(coll, 'bl_axle', [(0.016, -0.24), (0.016, 0.24)], 'x', (0, yb, 0), 'iron', 12))
    bl.append(lathe(coll, 'bl_clapper_rod', [(0.007, 0.0), (0.007, 0.24), (0.0, 0.245)], 'y', (0, y0 + 0.05, 0), 'iron', 12))
    bl.append(ball(coll, 'bl_clapper', 0.026, (0, y0 + 0.05, 0), 'iron', 16))
    rp = sag((0, y0 + 0.03, 0.0), (0, y0 - 0.30, 0.02), 0.01, seg(10))
    bl.append(rope(coll, 'bl_rope', rp, 0.008))
    bl.append(ball(coll, 'bl_knot', 0.022, (0, y0 - 0.28, 0.02), 'rope', 14, scale=(1, 1.3, 1)))
    sock('bell_belfry', 'sock_bell', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('bell', 'sock_bell_pivot', (0, yb, 0))
    sock('bell', 'sock_bell_rope', (0, y0 - 0.28, 0.02))
    return {'bell_belfry': (fb, None), 'bell': (bl, (0, yb, 0))}


def build_taffrail_lantern(coll):
    p, gl = [], []
    Rh = 0.12
    p.append(lathe(coll, 'tl_base', [(0.0, 0.0), (0.06, 0.0), (0.07, 0.02), (0.11, 0.04), (0.15, 0.065), (0.155, 0.085), (0.14, 0.095), (0.0, 0.095)], 'y', (0, 0, 0), 'gilt', 36))
    p.append(lathe(coll, 'tl_dome', [(0.0, 0.40), (0.145, 0.40), (0.155, 0.415), (0.14, 0.43), (0.11, 0.47), (0.07, 0.51), (0.045, 0.53),
                                     (0.045, 0.57), (0.06, 0.58), (0.06, 0.60), (0.03, 0.61), (0.0, 0.61)], 'y', (0, 0, 0), 'bronze', 36))
    for k in range(6):
        a = 2 * math.pi * k / 6
        p.append(lathe(coll, f'tl_vent{k}', [(0.0, -0.004), (0.016, -0.004), (0.016, 0.004), (0.0, 0.004)], 'z', (0, 0, 0), 'tar', 12))
        p[-1].data.transform(Matrix.Translation(G(0.062 * math.sin(a), 0.56, 0.062 * math.cos(a))) @ ry(a) @ Matrix.Translation(-G(0, 0, 0)))
        ca = a + math.pi / 6
        p.append(tube(coll, f'tl_post{k}', line((Rh * math.sin(ca), 0.09, Rh * math.cos(ca)), (Rh * math.sin(ca), 0.41, Rh * math.cos(ca)), seg(4, 2)),
                      'bronze', 0.009))
        ap = Rh * math.cos(math.pi / 6)
        gl.append(pane(coll, f'tl_pane{k}', Rh * 0.98, 0.30, (ap * math.sin(a), 0.25, ap * math.cos(a)), ry(a)))
        p.append(ball(coll, f'tl_rivet{k}', 0.010, (Rh * math.sin(ca), 0.25, Rh * math.cos(ca)), 'bronze', 10))
    for k, y in enumerate((0.10, 0.395)):
        p.append(torus(coll, f'tl_hoop{k}', Rh * 0.98, 0.010, 'y', (0, y, 0), 'bronze', 36, 8))
    p.append(ball(coll, 'tl_finial', 0.035, (0, 0.645, 0), 'gilt', 18, scale=(1, 1.4, 1)))
    p.append(torus(coll, 'tl_ring', 0.03, 0.007, 'z', (0, 0.70, 0), 'bronze', 20, 6))
    for sx in (-1, 1):
        p.append(tube(coll, f'tl_foot{sx}', spiral((sx * 0.13, 0.03, 0.0), 0.04, 0.008, 0.0, 1.2, seg(20), u=(sx, 0, 0), v=(0, 1, 0)),
                      'gilt', taper(0.014, 0.005), sec=ellipse(1, 1, seg(10, 8))))
    sock('taffrail_lantern', 'sock_taffrail_lantern', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('taffrail_lantern', 'sock_taffrail_lantern_flame', (0, 0.25, 0), out=(0, 1, 0), up=(0, 0, 1))
    return {'taffrail_lantern': (p, None), 'taffrail_lantern_glass': (gl, None)}


def build_crows_nest(coll):
    Ro, Rm = 0.72, 0.17
    p = [lathe(coll, 'cw_floor', [(Rm, 0.0), (Ro - 0.02, 0.0), (Ro, 0.02), (Ro, 0.06), (Ro - 0.02, 0.08), (Rm, 0.08)], 'y', (0, 0, 0), 'oak', 48, closed=True)]
    gap = 0.38  # ladder entry, aft (-Z)
    n = 24
    for k in range(n):
        a = math.pi + gap + (2 * math.pi - 2 * gap) * (k + 0.5) / n
        p.append(box(coll, f'cw_slat{k}', 0.075, 0.78, 0.026, (0.68 * math.sin(a), 0.47, 0.68 * math.cos(a)), 'oak', rot=ry(a), bev=0.006, bseg=2))
    for k, (y, r) in enumerate(((0.88, 0.032), (0.50, 0.022))):
        p.append(tube(coll, f'cw_rail{k}', ring_pts((0, y, 0), 0.69, seg(40), 'y', math.pi + gap * 0.8, 3 * math.pi - gap * 0.8), 'oak_dark', r, sec=rrect()))
    for sx in (-1, 1):
        p.append(box(coll, f'cw_trestle{sx}', 0.09, 0.12, 1.30, (sx * 0.22, -0.06, 0), 'oak_dark', bev=0.012))
        p.append(box(coll, f'cw_cross{sx}', 1.40, 0.09, 0.09, (0, -0.165, sx * 0.34), 'oak_dark', bev=0.01))
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        top = (0.66 * math.sin(a), -0.01, 0.66 * math.cos(a))
        bot = (0.16 * math.sin(a), -0.85, 0.16 * math.cos(a))
        p.append(rope(coll, f'cw_futtock{k}', line(top, bot, seg(6, 4)), 0.014))
        p.append(box(coll, f'cw_fplate{k}', 0.05, 0.10, 0.012, (0.705 * math.sin(a), 0.02, 0.705 * math.cos(a)), 'iron', rot=ry(a), bev=0.004))
        sock('crows_nest', f'sock_crows_nest_futtock_{k}', top, out=(0, -1, 0), up=(math.sin(a), 0, math.cos(a)))
    p.append(hoop(coll, 'cw_mastband', 0.15, -0.85, 0.06, 'y', (0, 0, 0), 'iron', 0.012))
    sock('crows_nest', 'sock_crows_nest', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('crows_nest', 'sock_crows_nest_floor', (0, 0.08, 0.40), out=(0, 1, 0), up=(0, 0, 1))
    sock('crows_nest', 'sock_crows_nest_entry', (0, 0.08, -Ro), out=(0, 0, -1))
    return {'crows_nest': (p, None)}


def build_cannonball_rack(coll):
    p = [box(coll, 'cr_plank', 1.10, 0.09, 0.30, (0, 0.30, 0), 'oak', bev=0.014)]
    for sx in (-1, 1):
        p.append(box(coll, f'cr_leg{sx}', 0.09, 0.27, 0.24, (sx * 0.48, 0.135, 0), 'oak_dark', bev=0.012))
        p.append(box(coll, f'cr_strap{sx}', 0.10, 0.012, 0.32, (sx * 0.48, 0.35, 0), 'iron', bev=0.004))
    for sz in (-1, 1):
        p.append(tube(coll, f'cr_lip{sz}', line((-0.55, 0.35, sz * 0.15), (0.55, 0.35, sz * 0.15), seg(8, 4)), 'oak_dark', (0.016, 0.022), sec=rrect()))
    k = 0
    for row in (-1, 1):
        for i in range(5):
            x, z = -0.40 + 0.2 * i, row * 0.072
            p.append(lathe(coll, f'cr_cup{k}', [(0.0, 0.338), (0.045, 0.340), (0.058, 0.3455), (0.0, 0.3455)], 'y', (x, 0, z), 'tar', 20))
            p.append(ball(coll, f'cr_shot{k}', 0.055, (x, 0.345 + 0.04, z), 'iron', 24))
            sock('cannonball_rack', f'sock_cannonball_{k}', (x, 0.385, z), out=(0, 1, 0), up=(0, 0, 1))
            k += 1
    sock('cannonball_rack', 'sock_cannonball_rack', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    return {'cannonball_rack': (p, None)}


def build_barrel(coll):
    H_, Re, Rb = 0.90, 0.255, 0.305
    rad = lambda y: Re + (Rb - Re) * math.sin(math.pi * y / H_)  # noqa: E731
    ny = seg(14, 8)
    prof = [(Re - 0.022, H_ - 0.035), (Re - 0.012, H_)] + [(rad(H_ * (1 - i / ny)), H_ * (1 - i / ny)) for i in range(ny + 1)] + [(Re - 0.012, 0.0), (Re - 0.022, 0.035)]
    prof = list(reversed(prof))
    staves = 18
    groove = lambda i, t, r, z: r * (1 - 0.012 * max(0.0, math.cos(staves * t)) ** 30) if r > Re - 0.02 else r  # noqa: E731
    p = [lathe(coll, 'br_body', prof, 'y', (0, 0, 0), 'oak', 72, closed=True, radius_fn=groove)]
    for k, y in enumerate((0.035, H_ - 0.035)):
        p.append(lathe(coll, f'br_head{k}', [(0.0, -0.008), (Re - 0.018, -0.008), (Re - 0.018, 0.008), (0.0, 0.008)], 'y', (0, y, 0), 'oak_dark', 40))
        for s in (-1, 1):
            p.append(box(coll, f'br_seam{k}{s}', 0.004, 0.003, 2 * (Re - 0.03) * math.sqrt(1 - (0.07 / (Re - 0.03)) ** 2), (s * 0.07, y + (0.0085 if k else -0.0085), 0), 'tar', bev=0))
    for k, y in enumerate((0.07, 0.25, H_ - 0.25, H_ - 0.07)):
        p.append(hoop(coll, f'br_hoop{k}', rad(y), y, 0.045 if k in (0, 3) else 0.035, 'y', (0, 0, 0), 'iron', 0.006))
    p.append(lathe(coll, 'br_bung', [(0.0, 0.0), (0.024, 0.0), (0.022, 0.012), (0.0, 0.014)], 'z', (0, H_ / 2, Rb - 0.006), 'oak_dark', 14))
    sock('barrel', 'sock_barrel', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('barrel', 'sock_barrel_top', (0, H_, 0), out=(0, 1, 0), up=(0, 0, 1))
    return {'barrel': (p, None)}


def build_bilge_pump(coll):
    p, h = [], []
    p.append(lathe(coll, 'bp_partner', [(0.0, 0.0), (0.18, 0.0), (0.18, 0.05), (0.15, 0.07), (0.0, 0.07)], 'y', (0, 0, 0), 'oak_dark', 32))
    p.append(lathe(coll, 'bp_trunk', [(0.0, 0.0), (0.115, 0.0), (0.11, 0.80), (0.12, 0.84), (0.0, 0.84)], 'y', (0, 0.05, 0), 'oak', 32,
                   radius_fn=lambda i, t, r, z: r * (1 - 0.06 * max(0.0, math.cos(4 * t)) ** 8)))
    for k, y in enumerate((0.25, 0.62)):
        p.append(hoop(coll, f'bp_band{k}', 0.112, y, 0.04, 'y', (0, 0, 0), 'iron', 0.007))
    p.append(box(coll, 'bp_head', 0.30, 0.18, 0.30, (0, 0.96, 0), 'oak', bev=0.02))
    p.append(box(coll, 'bp_headband', 0.315, 0.035, 0.315, (0, 0.92, 0), 'iron', bev=0.006))
    sp = bez((0.14, 0.94, 0), (0.25, 0.94, 0), (0.33, 0.92, 0), (0.42, 0.87, 0), seg(10))
    p.append(tube(coll, 'bp_spout', sp, 'oak_dark', taper(0.045, 0.055), sec=rrect(), cap=True))
    p.append(lathe(coll, 'bp_spout_mouth', [(0.0, -0.004), (0.04, -0.004), (0.04, 0.004), (0.0, 0.004)], 'x', (0.425, 0.87, 0), 'tar', 16))
    piv = (0, 1.13, -0.12)
    for sx in (-1, 1):
        p.append(box(coll, f'bp_cheek{sx}', 0.025, 0.16, 0.10, (sx * 0.05, 1.10, -0.12), 'iron', bev=0.005))
    p.append(lathe(coll, 'bp_pin', [(0.0, -0.08), (0.016, -0.08), (0.016, 0.08), (0.0, 0.08)], 'x', piv, 'iron', 12))
    h.append(tube(coll, 'bp_lever', bez((0, 1.13, 0.04), (0, 1.15, -0.30), (0, 1.19, -0.65), (0, 1.23, -1.0), seg(14)), 'oak', taper(0.034, 0.024), sec=rrect()))
    h.append(lathe(coll, 'bp_grip', [(0.0, -0.22), (0.018, -0.22), (0.022, -0.20), (0.022, 0.20), (0.018, 0.22), (0.0, 0.22)], 'x', (0, 1.23, -1.0), 'carve', 16))
    h.append(box(coll, 'bp_clevis', 0.06, 0.08, 0.06, (0, 1.10, 0.02), 'iron', bev=0.006))
    h.append(lathe(coll, 'bp_spear', [(0.0, 0.0), (0.014, 0.0), (0.014, 0.20), (0.0, 0.20)], 'y', (0, 0.88, 0.02), 'iron', 12))
    sock('bilge_pump', 'sock_bilge_pump', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('bilge_pump', 'sock_bilge_pump_spout', (0.425, 0.87, 0), out=(1, 0, 0))
    sock('bilge_pump_handle', 'sock_bilge_pump_pivot', piv, out=(1, 0, 0))
    sock('bilge_pump_handle', 'sock_bilge_pump_grip', (0, 1.23, -1.0), out=(0, 1, 0), up=(0, 0, -1))
    return {'bilge_pump': (p, None), 'bilge_pump_handle': (h, piv)}


# ── ground tackle + rig blocks ───────────────────────────────────────────────
def build_anchor(coll):
    p = []
    rc = (0, -0.10, 0)
    p.append(torus(coll, 'an_ring', 0.10, 0.022, 'x', rc, 'iron', 36, 10))
    n = seg(120, 40)
    wrap = []
    for i in range(n + 1):
        u = math.pi * (0.25 + 1.5 * i / n)
        v = 2 * math.pi * 14 * i / n
        c = Vector((0, rc[1] + 0.10 * math.sin(u), 0.10 * math.cos(u)))
        radial = Vector((0, math.sin(u), math.cos(u)))
        wrap.append(tuple(c + 0.028 * (math.cos(v) * radial + math.sin(v) * Vector((1, 0, 0)))))
    p.append(rope(coll, 'an_pudden', wrap, 0.007))
    p.append(lathe(coll, 'an_eye', [(0.0, -0.06), (0.06, -0.06), (0.07, -0.03), (0.07, 0.03), (0.06, 0.06), (0.0, 0.06)], 'x', (0, -0.22, 0), 'iron', 24))
    ys = -0.34
    p.append(tube(coll, 'an_stock', line((0, ys, -0.95), (0, ys, 0.95), seg(12, 6)), 'oak', lambda t: 0.045 + 0.04 * math.sin(math.pi * t), sec=rrect()))
    for k, z in enumerate((-0.42, -0.14, 0.14, 0.42)):
        r = 0.045 + 0.04 * math.sin(math.pi * (z + 0.95) / 1.9)
        p.append(hoop(coll, f'an_sband{k}', r * 1.15, z, 0.035, 'z', (0, ys, 0), 'iron', 0.008))
    p.append(tube(coll, 'an_shank', line((0, -0.24, 0), (0, -2.15, 0), seg(16, 6)), 'iron', taper(0.050, 0.068), sec=rrect()))
    p.append(ball(coll, 'an_crown', 0.11, (0, -2.20, 0), 'iron', 24, scale=(1.3, 0.8, 0.9)))
    for i, sx in enumerate((-1, 1)):
        arm = bez((0, -2.22, 0), (sx * 0.35, -2.27, 0), (sx * 0.64, -2.05, 0), (sx * 0.80, -1.62, 0), seg(20))
        p.append(tube(coll, f'an_arm{sx}', arm, 'iron', taper(0.072, 0.040), sec=rrect()))
        palm = arm[int(len(arm) * 0.55):] + [(sx * 0.86, -1.48, 0)]
        p.append(tube(coll, f'an_palm{sx}', palm, 'iron', lambda t: (0.03 + 0.20 * math.sin(math.pi * min(1.0, t * 1.1)) ** 0.7, 0.022), sec=ellipse(1, 1, seg(16, 12))))
        tip = palm[-1]
        sock('anchor', f'sock_anchor_bill_{i}', tip, out=(sx * 0.35, 0.94, 0), up=(0, 0, 1))
    sock('anchor', 'sock_anchor_ring', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('anchor', 'sock_anchor_crown', (0, -2.20, 0), out=(0, -1, 0), up=(0, 0, 1))
    return {'anchor': (p, None)}


def build_anchor_cable(coll):
    p, n = [], seg(72, 36)
    for s in range(3):
        pts = []
        for i in range(n + 1):
            t = i / n
            a = 2 * math.pi * (3 * t + s / 3)
            pts.append((0.028 * math.cos(a), 0.028 * math.sin(a), t * 1.0))
        p.append(tube(coll, f'cb_strand{s}', pts, 'rope', 0.026, sec=lobed(max(9, seg(12, 9) // 3 * 3), 3, 0.10), twist=lambda t: -360 * 3 * t, cap=False))
    sock('anchor_cable', 'sock_anchor_cable_start', (0, 0, 0))
    sock('anchor_cable', 'sock_anchor_cable_end', (0, 0, 1.0))
    return {'anchor_cable': (p, None)}


def build_rig_block(coll):
    c = (0, -0.13, 0)
    p = []
    for sx in (-1, 1):
        p.append(ball(coll, f'rb_cheek{sx}', 0.085, (sx * 0.026, c[1], 0), 'oak', 24, scale=(0.26, 1.0, 0.78)))
    p.append(lathe(coll, 'rb_sheave', [(0.012, -0.018), (0.062, -0.018), (0.066, -0.010), (0.058, 0.0), (0.066, 0.010), (0.062, 0.018), (0.012, 0.018)], 'x', c, 'oak_dark', 28, closed=True))
    p.append(lathe(coll, 'rb_pin', [(0.0, -0.058), (0.012, -0.058), (0.012, 0.058), (0.0, 0.058)], 'x', c, 'iron', 12))
    p.append(torus(coll, 'rb_strop', 0.088, 0.010, 'x', c, 'rope', 36, 8))
    p.append(torus(coll, 'rb_thimble', 0.024, 0.008, 'z', (0, -0.028, 0), 'iron', 20, 8))
    p.append(torus(coll, 'rb_seizing', 0.014, 0.006, 'y', (0, -0.05, 0), 'rope', 16, 6))
    sock('rig_block', 'sock_rig_block', (0, 0, 0), out=(0, 1, 0), up=(0, 0, 1))
    sock('rig_block', 'sock_rig_block_sheave', c, out=(1, 0, 0))
    return {'rig_block': (p, None)}


BUILDS_B = [
    ('channel', PB['channel'], build_channel),
    ('deadeye_pair', PB['deadeye'], build_deadeye_pair),
    ('pin_rail', PB['m'], build_pin_rail),
    ('bell', PB['m'], build_bell),
    ('taffrail_lantern', PB['lant'], build_taffrail_lantern),
    ('crows_nest', PB['l'], build_crows_nest),
    ('cannonball_rack', PB['m'], build_cannonball_rack),
    ('barrel', PB['barrel'], build_barrel),
    ('bilge_pump', PB['m'], build_bilge_pump),
    ('anchor', PB['l'], build_anchor),
    ('anchor_cable', PB['t'], build_anchor_cable),
    ('hawse', PB['t'], build_hawse),
    ('rig_block', PB['t'], build_rig_block),
]
