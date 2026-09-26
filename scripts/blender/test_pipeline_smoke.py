"""PIPELINE SMOKE (b3.4b; assets-14, assets-02). A test barrel goes through the whole PBR chain:

  _hires   segment policy by screen size, capped lathe (staves with real stave grooves on the HIGH
           mesh), closed-profile lathe hoops, 2-3 segment bevel + weighted normals on the LOW mesh
  _pbr     PolyHaven CC0 wood + iron by id (cached; the second fetch makes no request), licence rows,
           box projection on smart UVs, cage bake high -> low: BaseColor / Normal / ORM
  export   one glTF material with baseColor + normal + occlusion + metallicRoughness, single-sided

and every step is graded on its SIDE EFFECT (the PNG pixels, the GLB JSON), not a return value.
Must finish in < 90 s headless. Exit 0 only when every check passes.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/blender/test_pipeline_smoke.py
  PIRATES_BR_MUTATE=smoke:<flat|nometal|twosided|segments|unlicensed> ... proves the matching check goes red.

Machine protection (COMMON.md): headless, Cycles CPU, 512^2 far-tier bake at 8 samples, one process.
"""
import json
import os
import struct
import sys
import time

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
MUT = set(os.environ.get('PIRATES_BR_MUTATE', '').replace('smoke:', '').split(',')) - {''}
fails = []


def check(ok, label, detail=''):
    print(f'{"✓" if ok else "✗"} {label}{(" : " + detail) if detail else ""}', flush=True)
    if not ok:
        fails.append(label)


def done():
    wall = time.time() - T0
    check(wall < 90.0, 'wall < 90 s', f'{wall:.1f} s')
    print(f'\n{"PASS" if not fails else "FAIL"} test_pipeline_smoke: {len(fails)} failed'
          + (f' ({", ".join(fails)})' if fails else ''), flush=True)
    sys.stdout.flush()
    os._exit(0 if not fails else 1)


try:
    import bpy
    import numpy as np
    import _hires as H
    import _pbr as P
except Exception as e:  # RED on a tree without the modules
    check(False, 'import _hires/_pbr', repr(e))
    done()

WOOD, IRON = 'brown_planks_03', 'rust_coarse_01'
OUT = os.environ.get('PBR_SMOKE_OUT', '/tmp/pbr-pipeline-smoke')
os.makedirs(OUT, exist_ok=True)

try:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # ── _hires: segment policy ──
    n_fp = H.segments_for(0.02, 'fp')
    n_far = H.segments_for(0.02, 'far')
    n_hw = H.segments_for(0.15, 'hardware')
    if 'segments' in MUT:
        n_far = 8
    check(n_far >= 12 and n_fp > n_far and n_fp % 4 == 0 and n_hw % 4 == 0,
          'segment policy: >= 12, grows with screen size, multiple of 4',
          f'flintlock barrel r=2cm fp={n_fp} far={n_far}; cannon r=15cm hardware={n_hw}')
    check(H.segments_for(0.3, 'prop') > H.segments_for(0.1, 'prop'), 'segment policy grows with radius')
    try:
        H.bevel(None, 0.01, segments=1)
        check(False, 'bevel refuses 1 segment')
    except ValueError:
        check(True, 'bevel refuses 1 segment (PLAN 3.12: 2-3)')

    # ── _hires: barrel, high and low ──
    R0, R1, HGT = 0.26, 0.31, 0.86
    prof = [(R0 + (R1 - R0) * (1 - ((z / HGT) * 2 - 1) ** 2), z) for z in
            [HGT * k / 16 for k in range(17)]]
    n_hi = H.segments_for(R1, 'hero')
    n_lo = H.segments_for(R1, 'prop')
    staves = 18

    def groove(i, t, r, z):  # a 4 mm groove at every stave joint, HIGH mesh only
        per = n_hi / staves
        return r - 0.004 if (i % per) < 1.0 else r

    wood = P.source_material('smoke_wood', WOOD, scale=1.5, wear=0.25)
    iron = P.metal_material('smoke_iron', IRON, 'iron', metallic=0.0 if 'nometal' in MUT else None)
    hi_body = H.lathe('hi_body', prof, n_hi, radius_fn=groove, material=wood)
    lo_body = H.lathe('lo_body', prof, n_lo, material=wood)
    hoops_hi, hoops_lo = [], []
    for k, zc in enumerate((0.07, 0.2, HGT - 0.2, HGT - 0.07)):
        rz = R0 + (R1 - R0) * (1 - ((zc / HGT) * 2 - 1) ** 2)
        ring = [(rz + 0.004, zc - 0.022), (rz + 0.012, zc - 0.018), (rz + 0.012, zc + 0.018),
                (rz + 0.004, zc + 0.022)]
        hoops_hi.append(H.lathe(f'hi_hoop{k}', ring, n_hi, closed=True, material=iron))
        hoops_lo.append(H.lathe(f'lo_hoop{k}', ring, n_lo, closed=True, material=iron))
    st_body = H.stats(lo_body)
    st_hoop = H.stats(hoops_lo[0])
    check(st_body['non_manifold'] == 0 and st_hoop['non_manifold'] == 0,
          'lathe barrel and hoops are closed manifolds', f'{st_body} / {st_hoop}')
    before = st_body['verts']
    H.bevel(lo_body, 0.008, segments=2, angle_deg=35)
    after = H.stats(lo_body)
    check(after['verts'] > before and after['non_manifold'] == 0,
          '2-segment bevel + weighted normals applied, still manifold', f'verts {before} -> {after["verts"]}')
    low = H.join([lo_body] + hoops_lo, 'smoke_barrel')
    for h in hoops_hi:
        H.weighted_normals(h)
    highs = [hi_body] + hoops_hi
    st_low, st_high = H.stats(low), {'tris': sum(H.stats(o)['tris'] for o in highs)}
    check(st_high['tris'] > 2 * st_low['tris'], 'high mesh carries more detail than low',
          f'high {st_high["tris"]} tris, low {st_low["tris"]} tris')

    # ── _pbr: sources, cache, licences ──
    calls = P.net_calls()
    P.fetch(WOOD)
    P.fetch(IRON)
    check(P.net_calls() == calls, 'second fetch is a cache hit (no request)', f'{P.net_calls() - calls} requests')
    man = P.fetch(WOOD)['manifest']
    check(man['license'] == 'CC0 1.0' and man['authors'] and man['source'].startswith('https://polyhaven.com/a/'),
          'manifest carries CC0 + authors + source', f'{man["name"]} by {", ".join(man["authors"])}')
    try:
        P.require_licensed([WOOD, IRON] + (['not_a_logged_texture'] if 'unlicensed' in MUT else []))
        check(True, 'every source has a TEXTURE_LICENSES.md row')
    except RuntimeError as e:
        check(False, 'every source has a TEXTURE_LICENSES.md row', str(e))
    try:
        P.bake_pbr(low, highs, OUT, 'x', samples=64)
        check(False, 'bake refuses > 32 samples')
    except ValueError:
        check(True, 'bake refuses > 32 samples')

    # ── bake high -> low through a cage ──
    P.smart_uv(highs)
    P.smart_uv([low])
    cage = P.make_cage(low, 0.02)
    res = P.bake_pbr(low, None if 'flat' in MUT else highs, OUT, 'smoke_barrel', tier='far',
                     samples=8, cage=cage)
    paths = res['paths']
    check(res['size'] == 512 and all(os.path.getsize(p) > 1000 for p in paths.values()),
          'basecolor + normal + ORM PNGs written at the far tier size',
          ', '.join(f'{k} {os.path.getsize(v) // 1024} KB' for k, v in paths.items())
          + f'; bake s {json.dumps({k: round(v, 1) for k, v in res["seconds"].items()})}')

    def load(p):
        img = bpy.data.images.load(p)
        img.colorspace_settings.name = 'Non-Color'
        a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        a = a.reshape(-1, 4)
        cov = a[:, :3].sum(1) > 0.02  # baked texels (outside the islands the image is black)
        return a, cov

    def normal_detail(p):
        # Hidden faces (a hoop's inner band sits against the staves) get rays that hit a back face:
        # those texels are not blue-dominant. Grade detail on the valid texels, bound the rest.
        a, cov = load(p)
        v = a[cov]
        ok = v[:, 2] > 0.6
        vv = v[ok]
        return cov, vv, float(1 - ok.mean()), float(np.mean(np.abs(vv[:, 0] - 0.5) + np.abs(vv[:, 1] - 0.5)))

    cov_n, nn, bad, detail = normal_detail(paths['normal'])
    if 'flat' in MUT:
        # unplug every source normal and re-bake the low alone: the gate must see it flat
        for m in {m for o in [low] for m in o.data.materials}:
            nt = m.node_tree
            b = nt.nodes.get('Principled BSDF')
            for lk in list(b.inputs['Normal'].links):
                nt.links.remove(lk)
        r2 = P.bake_pbr(low, None, OUT, 'smoke_flat', tier='far', samples=4)
        cov_n, nn, bad, detail = normal_detail(r2['paths']['normal'])
    check(bad < 0.3 and float(nn[:, 2].mean()) > 0.7 and detail > 0.02,
          'normal map: tangent-space (blue-dominant) and NOT flat (grooves, grain, bevels)',
          f'non-blue texels {bad:.2f} (hidden hoop faces), mean B {nn[:, 2].mean():.2f}, |RG-0.5| {detail:.3f}')
    orm, cov_o = load(paths['orm'])
    oo = orm[cov_o]
    metal_frac = float((oo[:, 2] > 0.5).mean())
    check(0.03 < metal_frac < 0.6, 'ORM B = metal: iron hoops metal, wood not', f'metal texels {metal_frac:.2f}')
    check(0.15 < float(oo[:, 1].mean()) < 0.97 and float(oo[:, 1].std()) > 0.02,
          'ORM G = roughness varies (wood vs iron, grain)', f'mean {oo[:, 1].mean():.2f} std {oo[:, 1].std():.3f}')
    check(0.3 < float(oo[:, 0].mean()) <= 1.0 and float(oo[:, 0].std()) > 0.01,
          'ORM R = AO has occlusion (under the hoops, in grooves)', f'mean {oo[:, 0].mean():.2f} std {oo[:, 0].std():.3f}')
    base, cov_b = load(paths['basecolor'])
    check(float(base[cov_b][:, :3].std()) > 0.02, 'basecolor carries texture (not one flat tone)',
          f'std {base[cov_b][:, :3].std():.3f}')

    # ── one shipped material, exported ──
    mat = P.apply_baked(low, paths, 'smoke_barrel')
    if 'twosided' in MUT:
        mat.use_backface_culling = False
    for o in highs + [cage]:
        bpy.data.objects.remove(o)
    glb = os.path.join(OUT, 'smoke_barrel.glb')
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True,
                              export_image_format='AUTO')
    with open(glb, 'rb') as f:
        f.read(12)
        ln, _ = struct.unpack('<II', f.read(8))
        gj = json.loads(f.read(ln))
    mats = gj.get('materials', [])
    m0 = mats[0] if mats else {}
    pmr = m0.get('pbrMetallicRoughness', {})
    check(len(mats) == 1, 'GLB: exactly one material', f'{len(mats)}')
    check('normalTexture' in m0 and 'occlusionTexture' in m0 and 'metallicRoughnessTexture' in pmr
          and 'baseColorTexture' in pmr, 'GLB: baseColor + normal + occlusion + metallicRoughness textures',
          ', '.join(k for k in ('normalTexture', 'occlusionTexture') if k in m0) + ', '
          + ', '.join(k for k in pmr if k.endswith('Texture')))
    check(not m0.get('doubleSided', False), 'GLB: single-sided (doubleSided false)')
    check(len(gj.get('images', [])) in (3,), 'GLB: 3 images (ORM shared by occlusion + metalRough)',
          f'{len(gj.get("images", []))}')
except Exception as e:
    import traceback
    traceback.print_exc()
    check(False, 'pipeline ran without an exception', repr(e))
done()
