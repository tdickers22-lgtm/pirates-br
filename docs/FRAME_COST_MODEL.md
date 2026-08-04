# The cost of a frame in pirates-br

Phase 1 of the smoothness campaign. **Measurement only** — no rendering or gameplay
code was changed. Everything below was taken on the fanless 16 GB MacBook Air the
game is built on and targets, under software ANGLE (SwiftShader), against a
**pinned map (seed 20260801)** on a private game server on :8091, at a pinned
960×540 framebuffer and pixel ratio 1.

---

## 0. What is exact here, and what is not

| class | why | trust |
|---|---|---|
| draw calls, triangles, programs, geometry/texture/render-target residency and bytes | three's own bookkeeping and the scene graph — no backend knows or cares | **exact** |
| shadow-pass / main-pass / post-pass split, in draws and triangles | read off the counter on either side of the renderer's own `shadowMap.render` and `composer.render` | **exact** |
| **depth complexity (overdraw)** | counted in the *stencil buffer by the rasteriser*, one increment per fragment that survives its own alpha test and the depth test | **exact** |
| fragment / texel arithmetic derived from those | multiplication | **exact** |
| CPU profile *ordering*, hitch *shape*, GC pause counts, allocation bytes | JS work per frame does not change with the GL backend | **real shape** |
| any absolute millisecond | SwiftShader is a CPU rasteriser | **advisory only** |

Two things about the working tree these numbers describe:

1. **HEAD is 8b87f0e, but the tree is not.** `src/client/rendering/OceanRenderer.ts`
   carries an uncommitted change that coarsens the ocean's OUTER LOD ring (high:
   32 m → 48 m cell, balanced: 64 m → 96 m). Every triangle count below includes
   that diet. At HEAD the three rings are 73.7k + 69.1k + 78.6k = 221.4k triangles;
   here the ocean measures **177.8k** at `high`, so add ~44k triangles to every
   `high` scene to read these as HEAD numbers. Nothing else in the model moves.
2. **The reference framebuffer is the real one.** 960×540 = 518,400 px. A `low`-tier
   player on this Air renders at `maxPixelRatio` 0.62 into a ~1512×945 window =
   ~549,000 px. The measured framebuffer is within 6% of the shipped one, so the
   fragment arithmetic below is the arithmetic of the actual device.

### Instruments added (all new, all in `scripts/`)

- `scripts/lib/cost-model-probes.mjs` — the in-page instruments: stencil overdraw
  census, pass split, resource-byte census, frame inventory, subsystem tagger,
  sky-occlusion probe, frame-counted timer, frustum-entity counter.
- `scripts/lib/cost-model-prelude.mjs` — packs them into one installable source string.
- `scripts/lib/dev-client.mjs` — a Vite that lives exactly as long as the run.
- `scripts/perf-cost-model.mjs` — per-scene, per-tier battery (counts + passes +
  bytes + overdraw + attribution). `--only-sky` runs the sky reading alone.
- `scripts/perf-frame-profile.mjs` — CDP CPU profile, allocation rate, GC, hitch census.
- `scripts/perf-scaling.mjs` — pixel-ratio sweep and the yaw-sweep regressions.

---

## 1. The five findings

1. **The low tier buys geometry. It does not buy fill.** `low` draws 2.6–6.6× fewer
   calls and 3.4–7.6× fewer triangles than `high` — and shades the screen the *same
   number of times*: dock-vista 1.94 vs 1.94 layers, storm 2.37 vs 2.40, the worst
   case 2.30 vs 2.35, combat 2.54 vs 2.62. On a fanless integrated GPU, which is short
   of fill and bandwidth rather than of draw submission, the quality ladder is
   currently pulling the wrong lever. What `low` *does* buy is that it turns off the
   two things that dominate the fill bill: the shadow map and the post chain.
2. **The sky dome is a full screen of shading in every frame, and nothing can reject
   it.** Built with `depthTest: false, depthWrite: false, renderOrder: -1`, it reads
   **exactly 1.000 layers over 100.0% of the framebuffer in all nine scenes at both
   tiers** — 518,400 fragments of a procedural sky shader every frame, most of them
   under ocean, terrain or a hull. It is 34–62% of everything the main pass shades.
3. **The 4096×4096 shadow map is the largest single fill item in the game.** It covers
   a 310 m box — 7.6 cm per texel — and costs **16,777,216 texels of clear plus 201–561
   draws and 223–450k triangles of depth-only rasterisation, every frame**. That is
   **32× the main framebuffer's pixel count**, and 112 MB of the 160.5 MB of
   render-target residency. `low` pays none of it.
4. **The post chain costs 3.92 full screens of fill and ~21 MB/frame of MSAA resolve
   traffic**, for 15 draws — one and a half to two times the entire main pass's shaded
   fragments. `low` pays none of it either.
5. **The client's own JavaScript is ~2% of CPU time. Shader links are not, and they
   are still happening during play.** With the framebuffer collapsed so rasterisation
   cannot hide anything, game JS across every subsystem is 3.2 s out of 180 s. The
   rest is GL. And in 60 s of ordinary play at `low`, `getProgramInfoLog` /
   `getShaderInfoLog` / `getProgramParameter` — the synchronous joins on a shader
   link — took 58.0 s of 60. Loading pays for some programs; walking round a corner
   still pays for the rest.

---

## 2. Counts and the pass split

One settled frame per scene, pinned map, 960×540, ratio 1. `draws`/`tris` are the
mean over the captured frames; the pass columns are one instrumented frame, so they
carry the scene's own frame-to-frame spread (±5–15%, mostly where the bot ships are).

| scene | tier | draws | tris | programs | shadow draws | shadow tris | post draws | main draws | main tris |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| dock-vista | high | 1515 | 1803k | 105 | 201 | 383k | 15 | 1327 | 1422k |
| dock-vista | low | 548 | 526k | 58 | 0 | 0 | 0 | 615 | 531k |
| deck-aft | high | 2695 | 2716k | 131 | 561 | 439k | 15 | 2550 | 2332k |
| deck-aft | low | 836 | 684k | 60 | 0 | 0 | 0 | 934 | 694k |
| island-interior | high | 1513 | 2024k | 137 | 332 | 418k | 15 | 1174 | 1605k |
| island-interior | low | 231 | 266k | 60 | 0 | 0 | 0 | 243 | 267k |
| cave-interior | high | 2908 | 2899k | 145 | 339 | 223k | 15 | 2648 | 2686k |
| cave-interior | low | 733 | 576k | 60 | 0 | 0 | 0 | 845 | 586k |
| waterfall-deck | high | 2846 | 2711k | 154 | 378 | 409k | 15 | 2687 | 2351k |
| waterfall-deck | low | 869 | 527k | 60 | 0 | 0 | 0 | 742 | 494k |
| open-sea | high | 1322 | 1061k | 155 | 0 | 0 | 15 | 1462 | 1079k |
| open-sea | low | 294 | 158k | 60 | 0 | 0 | 0 | 294 | 158k |
| combat-burst | high | 1648 | 1513k | 113 | 470 | 331k | 15 | 1232 | 1188k |
| combat-burst | low | 366 | 381k | 58 | 0 | 0 | 0 | 442 | 387k |
| storm-sea | high | 991 | 863k | 106 | 0 | 0 | 15 | 1113 | 876k |
| storm-sea | low | 286 | 156k | 62 | 0 | 0 | 0 | 444 | 172k |
| **worst-case** | high | 2234 | 2531k | 143 | 260 | 385k | 15 | 1960 | 2140k |
| **worst-case** | low | 870 | 527k | 63 | 0 | 0 | 0 | 963 | 538k |

**worst-case** is constructed, not found: the storm session (rain shells, rain haze,
cloud deck) standing off the one island that has a waterfall on it, with the scripted
keg/cannon FX burst firing. Every blended layer the game owns, in one frustum.

Notes.

- **Shadows are 13–21% of all draws and 8–21% of all triangles at `high`** — a whole
  second pass over the scene, into a texture the player never sees.
- **Open water and the storm demo cast no shadows at all** (0 draws): the 310 m ortho
  box is empty out there. The 4096² clear is paid anyway.
- Draw-call sources are dominated by one bucket in every single scene:

| scene | #1 source | calls | #2 | calls |
|---|---|--:|---|--:|
| dock-vista | island-decor | 343 | island-Castaway Reach | 117 |
| deck-aft | island-decor | 455 | ship | 334 |
| island-interior | island-decor | 266 | island-Castaway Reach | 117 |
| cave-interior | island-decor | 668 | ship | 249 |
| waterfall-deck | ship | 538 | island-decor | 385 |
| open-sea | island-decor | 321 | ship | 185 |
| combat-burst | island-decor | 293 | ship | 109 |
| storm-sea | island-decor | 247 | ship | 149 |
| worst-case | island-decor | 378 | playerMeshes[] | 175 |

`island-decor` is instanced (227–290 instances in frame) and *still* issues 247–668
calls, i.e. it is many separate `InstancedMesh` objects rather than few.

- **The scene graph holds 9,201–9,388 drawables** at `high` once the world has streamed
  in — meshes, points, sprites and lines — of which 231–2,908 are drawn.

  **CORRECTED 2026-08-02.** This bullet used to continue "three's `projectObject` walks
  all of them every frame", and lever 3 below was sized off that sentence. It is wrong,
  and the error is in this rig, not in three: the 9,201 comes from a `scene.traverse()`,
  which visits every node in the graph, and `projectObject` returns at the first
  `visible === false`. Every node under a hidden island detail root, proxy root or micro
  tier — which is most of them — is never visited at all. Counted properly
  (`TALLY_TRAVERSAL` in `scripts/lib/perf-scenes.mjs`, which prunes exactly where three
  prunes), the walk is **4,526 nodes at dock-vista, 4,079 at cave-interior and 1,562 at
  open-sea**, roughly *half* the figure this section reported. Lever 3's "−70–80% of the
  per-frame traversal" was an estimate off the wrong number; the group-level cull that
  landed measures **−16%, −6% and −13%**.

---

## 3. Overdraw — the reading nothing here had ever taken

Stencil-counted depth complexity: every fragment that survives its own alpha test and
the depth test increments the pixel's stencil by one; the value is read back with 24
full-screen stencil-tested quads. No material is swapped, so vertex displacement,
foliage alpha cutouts and per-particle point sizes are all exactly what ships. 960×540.

| scene | tier | mean layers | of which blended | opaque | p50 | p90 | p95 | p99 | max | px ≥4 layers |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| dock-vista | high | 1.94 | 1.25 | 0.70 | 2 | 3 | 3 | 4 | 12 | 1.1% |
| dock-vista | low | **1.94** | 1.23 | 0.71 | 2 | 3 | 3 | 3 | 12 | 0.8% |
| deck-aft | high | 2.66 | 1.09 | 1.56 | 2 | 5 | 6 | 7 | 14 | 21.0% |
| deck-aft | low | **3.03** | 1.06 | 1.97 | 2 | 6 | 7 | 9 | 13 | 30.9% |
| island-interior | high | 2.21 | 1.42 | 0.78 | 2 | 3 | 3 | 4 | 13 | 2.3% |
| island-interior | low | 1.91 | 1.18 | 0.73 | 2 | 3 | 3 | 4 | 10 | 1.5% |
| cave-interior | high | 2.96 | 1.63 | 1.33 | 3 | 4 | 4 | 6 | 15 | 14.1% |
| cave-interior | low | 2.27 | 1.06 | 1.20 | 3 | 3 | 3 | 5 | 12 | 4.3% |
| waterfall-deck | high | 2.55 | 1.93 | 0.63 | 2 | 3 | 4 | 6 | 17 | 7.8% |
| waterfall-deck | low | 1.78 | 1.13 | 0.65 | 2 | 2 | 3 | 4 | 11 | 1.7% |
| open-sea | high | 1.62 | 1.04 | 0.58 | 2 | 2 | 2 | 4 | 18 | 2.0% |
| open-sea | low | 1.86 | 1.30 | 0.56 | 2 | 2 | 3 | 4 | 17 | 2.1% |
| combat-burst | high | 2.62 | 1.68 | 0.94 | 2 | 5 | 6 | 9 | 17 | 21.9% |
| combat-burst | low | 2.54 | 1.46 | 1.09 | 2 | 5 | 6 | 8 | 16 | 19.5% |
| storm-sea | high | 2.40 | 1.73 | 0.67 | 2 | 4 | 4 | 6 | 19 | 10.4% |
| storm-sea | low | 2.37 | 1.78 | 0.59 | 2 | 3 | 4 | 5 | 16 | 9.9% |
| **worst-case** | high | 2.35 | 1.93 | 0.42 | 2 | 3 | 4 | 6 | 18 | 7.9% |
| **worst-case** | low | 2.30 | 1.86 | 0.44 | 2 | 3 | 4 | 7 | 16 | 7.8% |

### 3.1 What blends, measured

Per-source stencil census: the named source's materials are armed, everything else
still renders and still occludes. Mean layers is over the **whole** framebuffer, so
the column sums to the blended total.

| source | dock-vista | storm-sea | waterfall-deck | worst-case | what it is |
|---|--:|--:|--:|--:|---|
| `renderer.skyMesh` | **1.000** | **1.000** | **1.000** | **1.000** | the sky dome, `depthTest:false` |
| `combatFx.flame.points` | – | – | 0.000 | **0.484** (13.0% of screen, p95 3) | keg/cannon flame particles |
| `envFx.rainHaze` | – | **0.473** (47.3%) | – | – | 96 m rain-haze cylinder |
| `envFx.stormFront` | **0.266** (26.6%) | 0.199 | **0.432** (43.2%) | 0.153 | the safe-ring weather wall |
| `combatFx.smoke.points` | – | – | 0.000 | **0.159** (5.2%) | keg/cannon smoke |
| rain streaks (`LineSegments`) | – | 0.017 | 0.026 | 0.013 | 3 shells of drop segments |
| `island-<name>` foliage/micro | 0.000 | 0.000 | 0.008 | 0.008 | alpha-cut leaves, grass |
| `waterfall` sheets | – | – | **0.003** | **0.003** | the fall itself |
| `fx-mist` (723 points) | – | – | **0.002** | **0.002** | plunge-pool mist |
| `island-contact-shadows` | 0.000 | – | 0.001 | 0.001 | 288 instanced blobs |
| `ship` translucents, `envFx.lanternRoot` glow sprites, `stormRing`, `stormHalo`, `sunGlow`, `sunDisc`, foam/wake sprites | 0.000 | 0.000 | 0.000 | 0.000 | — |
| **attributed** | 1.274 | 1.689 | ~1.46 | 1.895 | |
| **measured blended total** | 1.248 | 1.726 | 1.15–1.93 | 1.895 | |

**Half of the suspect list is innocent.** Waterfall sheets, plunge mist, foam and
wake sprites, lantern/glow sprites, the storm ring and halo, the sun disc and glow,
and the contact-shadow blobs together account for **under 0.02 layers**. Whatever
those cost, it is not fill.

**The whole blended bill is five things:** the sky (1.000, always, everywhere), the
combat flame/smoke particle burst (0.64 combined, in a burst), the rain haze cylinder
(0.47, in a storm), the safe-ring storm front (0.12–0.43, **in ordinary play**), and
the rain streaks (0.01–0.03).

### 3.2 How much of the sky nobody sees

> **LANDED, phase 4.** The dome is depth-tested and pinned to the far plane, and the
> after reading lands on this table's prediction to the decimal: 40.1% / 48.5% / 43.2%
> against the 40.2 / 48.5 / 43.1 predicted below. `docs/FILL_AND_SHADER_PASS.md` §2.2.


The dome was flipped to depth-tested and sorted last for a single instrumented frame,
its stencil armed, and the pixels it still reached counted. Nothing else changed;
`depthTest` and `renderOrder` are state, not program keys.

| scene | as shipped | depth-tested, drawn last | **shaded and thrown away** |
|---|--:|--:|--:|
| dock-vista | 100.0% | 40.2% | **59.8%** = 310,231 frag |
| deck-aft | 100.0% | 36.8% | **63.2%** = 327,507 frag |
| cave-interior | 100.0% | 37.8% | **62.2%** = 322,409 frag |
| open-sea | 100.0% | 48.5% | **51.5%** = 266,935 frag |
| worst-case | 100.0% | 43.3% | **56.7%** = 294,120 frag |

`SKY_FRAG` is 138 lines and ~470 operation tokens with no texture fetches — a heavy
procedural shader. **Between 267k and 328k fragments of it are computed and then
painted over, in every frame, at every tier.** For comparison, `OCEAN_FRAG` is 184
lines / ~793 tokens, so the water that covers most of those same pixels is *heavier
still* — the two are being run one on top of the other over half the screen.

### 3.3 Opaque overdraw

`mean − blended` is the opaque contribution, and on a deck it is the larger half:
**1.56 layers at `high`, 1.97 at `low`, with p95 6–7 and 21–31% of the framebuffer
shaded four times or more.** Standing on your own ship is the most fill-expensive
place in the game and it has nothing to do with weather or particles — it is hull,
deck, interior and rigging stacked in depth with (at `low`) *worse* sorting than at
`high`. This is the one number in the table I did not attribute to a source; see §9.

---

## 4. The fill budget, in fragments

Everything here is arithmetic on exact counts. 518,400 px reference.

### 4.1 Main pass

| scene | tier | shaded fragments | of which sky |
|---|---|--:|--:|
| dock-vista | high | 1.006 M | 0.518 M (52%) |
| deck-aft | high | 1.379 M | 0.518 M (38%) |
| cave-interior | high | 1.534 M | 0.518 M (34%) |
| waterfall-deck | high | 1.322 M | 0.518 M (39%) |
| combat-burst | high | 1.358 M | 0.518 M (38%) |
| worst-case | high | 1.218 M | 0.518 M (43%) |
| open-sea | high | 0.840 M | 0.518 M (62%) |
| dock-vista | low | 1.006 M | 0.518 M (52%) |
| worst-case | low | 1.192 M | 0.518 M (43%) |

### 4.2 Post chain (`high` and `balanced` only; `low` has none)

`RenderPass → UnrealBloomPass → OutputPass → grade ShaderPass`, 15 draws:

| pass | target | fragments |
|---|---|--:|
| bloom luminosity high-pass | 480×270 | 129,600 |
| bloom blur, 5 levels × 2 (480×270 … 30×17) | – | 345,420 |
| bloom composite | 960×540 | 518,400 |
| OutputPass (ACES + sRGB) | 960×540 | 518,400 |
| grade / vignette | 960×540 | 518,400 |
| **total** | | **2,030,220 = 3.92 screens** |

Plus 4× MSAA on the two 960×540 HalfFloat composer targets: 21.8 MB each resident,
and a per-frame resolve of ~16.6 MB read → 4.1 MB write. The blur taps are 3/5/7/9/11
wide, so the bloom passes are texture-fetch bound above their fragment count.

### 4.3 Shadow map (`high` and `balanced` only)

| | |
|---|--:|
| map size | 4096 × 4096 |
| texels | **16,777,216** = 32.4× the main framebuffer |
| ortho box | 310 m × 310 m (`SHADOW_HALF_EXTENT` 155) |
| texel density | 13.2 texels/m — **7.6 cm per texel** |
| caster draws / triangles | 201–561 / 223–450k per frame |
| bytes | 112.0 MB (colour + depth), 70% of all render-target memory |
| paid when nothing casts | yes — the clear runs every frame (open sea: 0 draws) |

### 4.4 So, at `high`, one frame asks for

```
main pass        0.84 – 1.53 M shaded fragments   (0.52 M of it the invisible-able sky)
post chain       2.03 M fragments + ~21 MB MSAA resolve
shadow map      16.78 M texels cleared + 0.2–0.45 M triangles of depth-only raster
```

**The post chain alone is bigger than the entire main pass. The shadow map is an
order of magnitude bigger than both together.** At `low`, both are zero — which is
the real reason `low` is fast, and the reason its identical overdraw did not show up
as a problem before.

---

## 5. Resident bytes

| | high | low |
|---|--:|--:|
| geometries | 5,681–5,900 | 4,253–4,424 |
| geometry bytes | **70.5–71.0 MB** | 60.1–60.4 MB |
| textures | 94–98 | 87–93 |
| texture bytes | 19.2–19.5 MB | 18.8–19.0 MB |
| render targets | **160.5 MB** | **0** |
| materials | 3,545–3,607 | 2,701–2,759 |
| linked programs | 105–155 | 58–63 |
| **total GPU-resident** | **~250 MB** | **~79 MB** |

Render targets, `high`:

| target | size | samples | MB |
|---|--:|--:|--:|
| `sun.shadow.map` | 4096×4096 | 0 | **112.0** |
| `composer.renderTarget1` | 960×540 | 4 | 21.8 |
| `composer.renderTarget2` | 960×540 | 4 | 21.8 |
| bloom mip chain (11 targets) | 480×270 … 30×17 | 0 | 4.9 |

Geometry by owner (worst case, `high`): `ship` **25.7 MB** — more than a third of all
geometry bytes, and more than the five largest islands put together (`island-Old Maw
Caldera` 5.2, `island-Widow's Watch` 3.9, `island-terrain` 3.9, `island-Skull Cove`
2.8, `island-Booty Bay` 2.7). `ocean.group` is 2.1 MB, `waterfall` 1.7 MB.

Textures: the largest twelve are all **512×192 RGBA, 512 KB each = 6.1 MB** for twelve
distinct objects with no `name` set. That is 31% of the texture budget in a shape that
looks like a repeated generated canvas; identifying them is a cheap follow-up (§9).

---

## 6. CPU cost of a frame

Two CDP profiles per tier. The full-resolution one says how much of a frame is fill;
the second collapses the framebuffer to 96×54 so that rasterisation cannot hide the
JS, and *that* is the pass the subsystem table comes from.

### 6.1 Full resolution, `low` tier, 60 s of driven play (59 frames)

| bucket | self time | share |
|---|--:|--:|
| **gl:shader-link** (`getProgramInfoLog`, `getShaderInfoLog`, `getProgramParameter`) | **58.0 s** | **85.5%** |
| gl:uniform-upload | 4.8 s | 7.1% |
| gl:draw-submit | 1.4 s | 2.0% |
| gl:geometry-upload | 0.7 s | 1.0% |
| garbage collector | 0.24 s | 0.3% |
| all client JavaScript | 0.9 s | 1.3% |

At `high` the same 60 s produced **24 frames**, median 4.68 s, max 84.8 s, with
`getProgramParameter` 39.3 s + `getProgramInfoLog` 25.3 s + `getShaderInfoLog` 5.1 s.
`high` links 105–155 programs against `low`'s 58–63, and pays for the difference.

> The *magnitude* of a link is SwiftShader's (it JITs the shader); the *fact* that
> links are still being taken during play is not. The repo's own GPU-path measurement
> (commit 8b87f0e) put the worst load task at 1366–1782 ms and found every one of them
> to be a single shader link.

### 6.2 Collapsed framebuffer, `low` tier, 180 s, 756 frames

Self time by subsystem (complete, not truncated):

| subsystem | self time | share | per frame |
|---|--:|--:|--:|
| native GL entry points | 153.5 s | 83.3% | – |
| three.js JS (of which `WebGLRenderer.setSize` **19.5 s**) | 25.1 s | 13.6% | 33 ms |
| `(program)` / V8 native | 1.9 s | 1.0% | – |
| netcode (`NetworkClient`, `ClientState`) | 0.95 s | 0.52% | 1.26 ms |
| game loop (`Game.ts`) | 0.87 s | 0.47% | 1.15 ms |
| garbage collector | 0.60 s | 0.33% | 0.80 ms |
| shared sim (`src/shared`) | 0.46 s | 0.25% | 0.61 ms |
| render:core | 0.20 s | 0.11% | 0.26 ms |
| render:ship | 0.15 s | 0.08% | 0.20 ms |
| world / island build | 0.14 s | 0.08% | 0.18 ms |
| HUD / DOM | 0.11 s | 0.06% | 0.15 ms |
| environment FX | 0.08 s | 0.04% | 0.10 ms |
| audio | 0.07 s | 0.04% | 0.10 ms |
| combat FX | 0.06 s | 0.03% | 0.08 ms |
| viewmodel | 0.03 s | 0.02% | 0.04 ms |
| systems / animation / ocean / input | 0.04 s | 0.02% | 0.06 ms |

**All of the client's own JavaScript together is 3.2 s of 184 s — 1.76%, about
4.2 ms per frame.** Nothing in the game's logic is a smoothness problem. HUD/DOM,
audio, animation and the LOD/culling passes are each under 0.3 ms a frame.

Top 15 functions by self time (collapsed, `low`):

| self | bucket | function |
|--:|---|---|
| 44,833 ms | gl:uniform-upload | `uniformMatrix4fv` |
| 22,840 ms | gl:shader-link | `getProgramParameter` |
| **19,488 ms** | **gl:swapchain-resize** | **`WebGLRenderer.setSize`** |
| 13,951 ms | gl:uniform-upload | `uniformMatrix3fv` |
| 11,685 ms | gl:shader-link | `getProgramInfoLog` |
| 8,652 ms | gl:draw-submit | `drawElements` |
| 7,347 ms | gl:uniform-upload | `uniform1f` |
| 7,220 ms | gl:uniform-upload | `uniform3f` |
| 6,831 ms | gl:uniform-upload | `uniform3f` |
| 4,436 ms | gl:geometry-upload | `vertexAttribPointer` |
| 4,188 ms | gl:uniform-upload | `uniformMatrix3fv` |
| 3,350 ms | gl:geometry-upload | `bufferSubData` |
| 2,624 ms | gl:geometry-upload | `bindVertexArray` |
| 2,189 ms | gl:draw-submit | `drawArraysInstanced` |
| 2,031 ms | gl:uniform-upload | `useProgram` |

Two things to take from that list.

- **`uniformMatrix4fv` is the single most expensive symbol in the game.** That is the
  per-draw-call bill: one model-view matrix per draw. It is the reason `island-decor`'s
  247–668 calls matter even though they are instanced.
- **`WebGLRenderer.setSize` at 19.5 s of a 180 s capture.** Nothing in the game resizes
  a window. This is the adaptive-resolution governor: `applyPixelRatio` →
  `renderer.setPixelRatio` → `setSize`, which reallocates the swapchain. Every step of
  the resolution ladder costs one, and under sustained distress the ladder steps
  repeatedly.

### 6.3 Allocation and GC

> **SUPERSEDED, phase 5.** Everything in the first three paragraphs below was
> measured with a method that cannot answer the question, and it under-reported
> by roughly **fifty times**. It is kept because the *reason* it was wrong is the
> whole finding. The live numbers are in §6.3.1.

Measured with `--js-flags=--expose-gc --enable-precise-memory-info` and a double
`gc()` before every sample, so these are real bytes and not `performance.memory`
quantisation. Four windows across two `low`-tier captures:

| window | frames | wall | gross | retained after `gc()` | gross per **second** |
|---|--:|--:|--:|--:|--:|
| A1 | 120 | 149.0 s | 147.7 KB/frame | 30.5 KB/frame | 119 KB/s |
| A2 | 300 | 249.4 s | 172.4 KB/frame | 27.7 KB/frame | **207 KB/s** |
| B1 | 120 | 17.7 s | 323.3 KB/frame | −0.25 KB/frame | 2,192 KB/s |
| B2 | 300 | 44.5 s | 34.5 KB/frame | 2.68 KB/frame | **233 KB/s** |

**Per-frame allocation cannot be read off a software rasteriser** and these windows
show exactly why: a frame here is 0.15–1.2 s long, so every 10 Hz network snapshot and
every timer lands inside a *fraction* of the frames and gets charged to them. The
per-frame column disagrees by 5×; the two long windows' **per-second** column agrees to
12% (**207 and 233 KB/s**), and that is the number to carry. Whether it is 3.6 KB/frame
of time-driven work at 60 fps or 35 KB/frame of frame-driven work cannot be separated
without a real GPU (§10). Retention is likewise unresolved: 27.7 KB/frame in one
capture, 2.68 KB/frame in the other.

#### 6.3.1 What a frame actually allocates (phase 5)

**A window that spans a collection cannot measure what the window allocated.** The
table above reads the heap before N frames and after N frames. A scavenge inside
that window sweeps part of what the window allocated, so the delta is
allocation *minus whatever was collected* — and at this allocation rate a scavenge
lands inside every window. That is why B1 and B2 disagree 9× per frame, why the
per-second column looked stable (it was averaging over the same collections
either way), and why every figure above is far too small.

Two changes fix it, both in `scripts/perf-alloc-census.mjs`:

1. **Read the heap either side of ONE frame at a time.** A collection becomes a
   single negative sample instead of a silent refund; the median of the positive
   samples is immune to it, and the distribution comes out as a bonus.
2. **Drive a synthetic frame.** `Game.benchFrameCpu(n, dt)` runs the real
   per-frame CPU path — everything `frame()` does except the draw — `n` times at
   a pinned 1/60. No GL is in it, so the answer is identical on Metal and
   SwiftShader, and every amortised subsystem is charged exactly its share of a
   60 fps frame instead of its share of a 1 fps one.

V8's **sampling heap profiler was tried first and does not work here**: calibrated
against 200,000 retained two-field objects (>6.1 MB) at `samplingInterval: 256`
it reported **0.03 MB**. It finds retention in old space; a frame's garbage dies
in the nursery. It stays in the rig as a ranking hint, labelled, and its
magnitudes are not quoted.

Measured that way, on the pinned map, bots at peace, world settled, sitting on
your own ship:

| tier | before phase 5 | after | at 60 fps |
|---|--:|--:|--:|
| `low` | **287 KB/frame** | **31.9 KB/frame** | 17.2 MB/s → 1.9 MB/s |
| `high` | 89.5 KB/frame¹ | **62 KB/frame** | 5.4 MB/s → 3.7 MB/s |

¹ `high` was not measured before the ship-renderer pass; 89.5 is its reading
after that pass and before the iterator pass, so the tier's own total drop is
larger than the column shows.

Where the 255 KB went, in order of size, all of it invisible in a code read:

| lever | bytes/frame | what it was |
|---|--:|---|
| `gerstnerHeight` | **186 KB** | `normalize2D(w.direction)` per wave per call — four object literals for four module constants, called once per waterline-collar **vertex** per hull |
| `for…of` over an array | **~36 KB** | an array iterator per loop, in the same function, at the same call rate |
| `rampAt` destructuring | **30 KB** (high) | `const [d1, f1] = knots[i]` runs the iterator protocol; twice per prop batch per island per frame |
| hull renderer keys | ~5 KB | `${ship.id}:${index}` per cannon, `new Set(ship.upgrades.map(…))` and `Object.entries` per hull |
| Map reapers | ~4 KB | `for (const [id, x] of map)` builds a two-element array per entry, in six live-entity reapers |
| wildlife | ~13 KB | a fresh `{x,z}` and six `` `leg${n}` `` strings per animal per frame; limbs posed for animals the LOD pass had already hidden |
| gangway planner | ~6 KB | eight objects per dock × ship pair, asked for every pair every frame |
| `spinGulls`, `syncPlayers` | ~3 KB | a `THREE.Euler` per bird; a template-literal movement key per player per frame |

The gate is `scripts/test-frame-allocation.mjs` (wired into `npm run test:browser`).
It grades the median and the p90 of the per-frame distribution at both tiers, and
it **fails when the world it is measuring is not there** — the first run of it
passed `high` at 0.4 KB/frame because the match had ended under a page running at
one frame a second, so `updateScene` returned on its first line.

#### 6.3.2 What it did to the pauses

Same rig as §7 (`perf-frame-profile.mjs --quality low --minutes 3`, framebuffer
collapsed), before and after:

| | pauses | total GC | **longest pause** | GC per second |
|---|--:|--:|--:|--:|
| before (180 s capture) | 49 | 604 ms | **125.4 ms** | 3.4 ms/s |
| after (180 s capture, 1,252 frames) | 101 | **446 ms** | **28.2 ms** | 2.5 ms/s |

**The longest pause fell by 77%,** and that is the number a player feels: a 125 ms
stop is a quarter-second of a fight going missing, a 28 ms one is a long frame.
Total GC time fell 26% in a capture that ran roughly **twice as many frames** as
the one it is compared against — per frame of play, collection costs about half
what it did.

The pause COUNT went up, and that is not a regression: scavenges are triggered by
the nursery filling, and 101 short scavenges totalling 446 ms is a strictly better
shape than 49 that reach 125 ms. What removes pauses outright is allocating less
still.

⚠️ **The `gc=18/9,435 ms` row in the hitch census below is not a GC cost.** That
census attributes the WHOLE rAF gap to whatever was sampled inside it, and on the
software rasteriser a gap is seconds long, so a 20 ms collection inside a 5 s
frame is charged 5,000 ms. The profiler's own `(garbage collector)` samples —
the table above — are the measurement.

GC, from the profile's own `(garbage collector)` samples:

| capture | pauses | total | longest | GC per second of play |
|---|--:|--:|--:|--:|
| `low`, full res, 60 s | 20 | 235 ms | 56.9 ms | 3.9 ms/s |
| `low`, collapsed, 180 s | 49 | 604 ms | **125.4 ms** | 3.4 ms/s |
| `low`, collapsed, 150 s | 62 | 223 ms | 11.3 ms | 1.5 ms/s |
| `high`, full res, 60 s | 31 | 495 ms | 100.3 ms | 8.3 ms/s |

GC costs **1.2–8.3 ms per second of play** (a fifth capture, `high` collapsed over
120 s, read 32 pauses / 175 ms / longest 30.5 ms) and its worst pause reached **125 ms**
in one capture and 11 ms in another. It is a real hitch source but, on the census below, a
minor one: 20 of 657 hitches and 4.7% of hitched time.

---

## 7. Hitch census

rAF-gap sampler with a concurrent CPU profile; every gap over the threshold is
attributed to the samples that fell inside it.

| capture | threshold | frames | median | p90 | p95 | p99 | max | hitches |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `low`, full res, 60 s | 250 ms | 59 | 104.1 ms | 4924 ms | 5761 ms | 13374 ms | 13374 ms | 22 |
| `low`, collapsed, 180 s | 50 ms | 756 | 10.5 ms | 471 ms | 1194 ms | 2664 ms | 19607 ms | **271** |
| `high`, full res, 60 s | 250 ms | 24 | 4683 ms | – | 31059 ms | 84754 ms | 84754 ms | 15 |

### 7.1 The census, per hitch

`low` tier, framebuffer collapsed to 96×54 so rasterisation cannot mask anything,
150 s of driven play, 962 frames, **657 gaps over 50 ms**, each attributed to the
profiler samples that fell inside its own window:

| cause | hitches | total | share of hitched time | worst |
|---|--:|--:|--:|--:|
| **draw submission** (`uniformMatrix4fv`, `drawElements`, `useProgram`) | **380** | 63,733 ms | **43.4%** | – |
| **shader link** (`getProgramParameter`, `getProgramInfoLog`, `getShaderInfoLog`) | 45 | 37,567 ms | **25.6%** | **4,672 ms** |
| **render traversal** (`projectObject`, `updateMatrixWorld`, sorting) | 120 | 22,103 ms | 15.1% | – |
| garbage collection | 20 | 6,930 ms | 4.7% | 1,847 ms |
| net burst | 36 | 5,875 ms | 4.0% | – |
| geometry upload | 27 | 4,728 ms | 3.2% | – |
| other | 27 | 4,014 ms | 2.7% | – |
| **swapchain resize** (`WebGLRenderer.setSize`) | 2 | 1,830 ms | 1.2% | 1,644 ms |
| island build / texture upload / chart | **0** | 0 | 0% | – |

The same census at **`high`** (120 s, 163 frames, median 66.3 ms, p95 3,609 ms,
max 15,169 ms, **87 gaps over 50 ms**) shifts almost entirely onto one cause, which is
what 155 programs instead of 63 looks like:

| cause | hitches | total | share |
|---|--:|--:|--:|
| **shader link** | **56** | 93,523 ms | **77.0%** |
| draw submission | 19 | 15,090 ms | 12.4% |
| garbage collection | 4 | 11,789 ms | 9.7% |
| other | 4 | 5,105 ms | 4.2% |
| render traversal | 2 | 1,158 ms | 1.0% |
| net burst | 1 | 700 ms | 0.6% |
| geometry upload | 1 | 567 ms | 0.5% |
| island build / texture upload / chart / swapchain | **0** | 0 | 0% |

Self time at `high` is **72.0% `gl:shader-link`** and 18.2% `gl:uniform-upload`;
`getProgramInfoLog` alone is 61.3 s of a 120 s capture.

**Eleven of the twelve worst individual hitches are shader links**, and their stacks
name the mechanism exactly:

```
4672ms  shader-link  getProgramParameter | getUniforms | replaceLightNums
3809ms  shader-link  getProgramParameter | drawArrays | uniformMatrix3fv
3123ms  shader-link  getProgramParameter | uniformMatrix3fv | drawElements
2995ms  shader-link  getProgramParameter | (program) | getParameters
2841ms  shader-link  getProgramInfoLog | getShaderInfoLog | vertexAttribPointer
...
1644ms  swapchain-resize  WebGLRenderer.setSize | uniformMatrix4fv | drawElementsInstanced
```

`getUniforms` → `replaceLightNums` is three r160's deferred `onFirstUse` path: the
link the load did not pay for, being paid by the first frame that draws the material.
`ProgramWarmup.ts` already fixes the *load* case; this is the same defect after the
load, when a player walks round a corner and a material comes into view for the first
time.

### 7.2 What never appeared

Island build (0.10 s of a 152 s capture, after the streamed queue drains), texture
upload (0.40 s), chart/minimap (never sampled), HUD/DOM (0.11 s), audio (0.065 s).
None of them produced a single hitch.

---

## 8. Scaling

### 8.1 Pixel ratio — exact, analytically

Everything that is a *fragment* scales with ratio²; everything else does not move.

| ratio | framebuffer | fragments | main-pass fill | post-chain fill | shadow-map texels | draws | triangles |
|--:|---|--:|--:|--:|--:|--:|--:|
| 0.75 | 720×405 | 0.29 M | ×0.56 | ×0.56 | **×1.00** | ×1.00 | ×1.00 |
| 1.00 | 960×540 | 0.52 M | ×1.00 | ×1.00 | ×1.00 | ×1.00 | ×1.00 |
| 1.25 | 1200×675 | 0.81 M | ×1.56 | ×1.56 | **×1.00** | ×1.00 | ×1.00 |
| 1.50 | 1440×810 | 1.17 M | ×2.25 | ×2.25 | **×1.00** | ×1.00 | ×1.00 |

Measured draw counts across the sweep confirm the invariance: 1503/1504/1505/1514 at
dock-vista, 2563/2566/2568/2297 at the worst case.

**The asymmetry is the point.** Dropping resolution buys back main-pass and post-chain
fill and buys back *nothing at all* of the 16.8 M-texel shadow map, which is fixed at
4096². At `high`, ratio 1, that means the resolution ladder can only reach about
13% of the frame's total fill+texel work. **A machine in distress is being handed the
smallest of the three knobs.**

The measured SwiftShader millisecond sweep did **not** resolve a fill exponent
(dock-vista `ms ∝ fragments^0.41`, R²=0.39; worst-case `^0.26`, R²=0.77 — and 1.5 came
out *faster* than 1.25 at dock-vista). That is a failed measurement, not a finding:
those frames are dominated by shader-link storms and GL entry-point overhead, not by
shading. Use the analytic law above; see §9.

### 8.2 Tier

| | `high` → `low` |
|---|---|
| draws | ÷2.6 to ÷6.6 |
| triangles | ÷3.4 to ÷7.6 |
| programs | ÷1.8 to ÷2.6 |
| geometry bytes | ÷1.17 |
| texture bytes | ÷1.02 |
| render-target bytes | ÷∞ (160.5 MB → 0) |
| post-chain fill | ÷∞ (2.03 M → 0) |
| shadow-map texels | ÷∞ (16.8 M → 0) |
| **mean overdraw** | **×1.00** (0.70–1.14 across scenes; *worse* on deck) |
| sky fill | ×1.00 |

### 8.3 Islands and entities in frame

108 samples: three stands (offshore of the dock island, open water, on your own deck),
36 yaw steps each, second lap so the LOD reveal is settled. Counts only — no frame is
rendered, which is what makes 108 samples affordable on a CPU rasteriser.

Observed range at `high`:

| stand | draws | triangles | islands in the cone |
|---|--:|--:|--:|
| offshore of the dock island | 56 – 2,165 | 203k – 2,153k | 0 – 11 |
| open water | 33 – 1,317 | 191k – 1,013k | 0 – 14 |
| on your own deck | 426 – 3,388 | 441k – 2,318k | 1 – 10 |

Least-squares slopes (ridge-regularised; the regressors are collinear because players
ride ships, which is why the multivariate `playersInCone` term comes out negative and
should not be used on its own):

| fit | intercept | per island in cone | per ship in cone | R² |
|---|--:|--:|--:|--:|
| draw calls | 385 | **+61.8** | **+384.7** | 0.61 |
| triangles | 435,299 | **+63,135** | **+329,746** | 0.57 |
| draw calls (island only) | 286 | **+156.1** | – | 0.50 |
| triangles (island only) | 385,719 | **+112,767** | – | 0.50 |
| draw calls (ship only) | 542 | – | **+154.3** | 0.57 |
| **blended** draw calls | 56 | +2.4 | +9.1 | 0.50 |

Read it as: **an island entering the view costs ~60–156 draw calls and ~63–113k
triangles; a ship entering it costs ~154–385 draws.** The R² of ~0.5–0.6 is honest —
cost depends on *distance* as well as count, and the fit does not know that.

Two things the intercepts say. There is a ~~**floor of 286–542 draw calls that no camera
angle removes**~~ (sky, ocean rings, viewmodel, HUD-adjacent meshes, the always-resident
FX pools). And **blended draws barely move with content at all** — 56 at the intercept,
+2.4 per island — which is the counting-side confirmation of §3.1: the blended bill is
a handful of fixed full-screen shells, not a crowd of small things.

> **CORRECTED 2026-08-03, phase 7.** The floor is gone, and the group cull
> (`fd35000`) is what took it. Measured on the pinned map at `low`, free-cam
> turned away from the archipelago with the reveal settled: **44 draw calls,
> 30k triangles, 13 of 14 island groups culled**
> (`scripts/approach-shots.mjs`, `vista-away`). The 286–542 intercept was fitted
> over yaw sweeps taken *before* that lever landed, when three walked into every
> island root whether or not its bounding sphere was in the cone. Nothing else in
> §8.3 moves — the per-island and per-ship slopes are about what entering the
> frustum costs, not about what leaving it saves — but the sentence a reader is
> most likely to quote out of this section is now false by an order of magnitude,
> in the campaign's own favour.

---

## 9. Ranked levers

### 9.1 How the millisecond column was built

The deltas are exact. The milliseconds are a **model**, and it is the weakest thing in
this document. Stated assumptions, for an 8-core Apple integrated GPU in a fanless
chassis sharing ~100 GB/s with the CPU:

- a **heavy** fragment (SKY_FRAG ~470 op tokens, OCEAN_FRAG ~793, the lit island/ship
  materials): **1.5 Gfrag/s** sustained → a full 518,400-px screen ≈ **0.35 ms**
- a **light** fragment (post-chain quads, particles, unlit blends): **4 Gfrag/s** →
  a full screen ≈ **0.13 ms**
- **bandwidth**: 100 GB/s → 1 MB moved ≈ **0.01 ms**
- a **WebGL draw call** through ANGLE, including three's JS and the uniform uploads:
  **5 µs** (the profile's own top symbol is `uniformMatrix4fv`, which is this)
- frame budget at 60 fps: **16.67 ms**

Treat every ms below as ±2×. The ordering is much more robust than the magnitudes,
because it mostly follows deltas that differ by an order of magnitude.

### 9.2 The ranking

Ordered by the hitch census (§7) first and the fill budget (§4) second, because a
hitch is what the player feels and a millisecond of steady cost is not.

| # | lever | exact delta | est. `high` | est. `low` | visible cost |
|--:|---|---|--:|--:|---|
| **1** | ~~**Warm every program the tier can reach, before the match — and cut the program count**~~ **WORKED, round 2 phase 1 — and the walk was the defect, not the budget.** See §11 | draw-time links during 90 s of play at `high`: **36 → 25**, 27,964 → 17,655 ms of joins; live programs 137 → 131 | measured; the remaining large ones are the shadow pass's depth programs, which no walk can reach (§11.3) | same class; `low` owes no depth programs at all | none |
| **2** | **Batch `island-decor`** — the #1 or #2 draw source in *every one of the nine scenes*, 247–668 calls. It is already instanced (227–290 instances in frame), so these are many `InstancedMesh` objects — one per prop type per island — not many props | −200 to −600 draw calls; triangles unchanged | **1.0 – 3.0 ms** (draw submission is 43% of all hitched time) | **0.6 – 1.5 ms** | **none** — identical geometry |
| **3** | ~~**Cull the scene graph at the group level.**~~ **LANDED, and it is worth a third of what this row claimed.** The 9,201–9,388 figure counts hidden nodes three never visits (see §2): the real walk is 4,526 / 4,079 / 1,562 nodes | measured −16% (dock-vista), −6% (cave-interior), −13% (open-sea) of the per-frame traversal, not −70–80% | proportionally less than **0.5 ms** | same | none |
| **4** | ~~**Shadow map 4096² → 1536²**, and skip the pass when the ortho box has no casters.~~ **LANDED at 2048², phase 4** — see `docs/FILL_AND_SHADER_PASS.md`. The size argument is not the one this row made: `shadow.normalBias` is 1.0 m at `high`, so at 4096 the bias was already thirteen texels wide and the map was paying for precision the bias had spent | 16.78 M → 4.19 M texels/frame; 117.4 MB → 29.4 MB resident; the pass itself skipped whenever it last drew nothing | — | 0 (no shadows) | none measured in the shot sheets |
| **5** | ~~**Depth-test the sky and draw it last**~~ **LANDED, phase 4.** Not by depth-testing the sphere as authored — its 2800 m radius sits inside the ocean's 3264 m rim — but by pinning it to the far plane with `gl_Position.z = gl_Position.w` | **−267k to −328k fragments** of a ~470-op procedural shader per frame — measured, not modelled | — | — | **none** — every removed pixel is covered by something else |
| **6** | ~~**Trim the post chain**~~ **LANDED IN PART, phase 4**: MSAA 4×→2× and the grade folded into `OutputPass`. The bloom base resolution was left at 480×270 — it is the pass whose loss is actually visible, and the other two were free | −518,400 quad fragments and one whole pass; 45.6 MB → 22.8 MB of composer residency and half the per-frame resolve | — | 0 (no post) | one MSAA step |
| **7** | **Stop the resolution ladder reallocating the swapchain.** `applyPixelRatio` → `setPixelRatio` → `setSize` runs even when the ratio has not changed; 19.5 s of `WebGLRenderer.setSize` in a 180 s capture with no window resize, and a 1,644 ms hitch attributed to it | one swapchain realloc per ladder step → zero when the ratio is unchanged | removes a hitch class | identical | none |
| **8** | ~~**Cut allocation.** 207–233 KB per second of steady garbage~~ **DONE, phase 5 — and the size of it was wrong by 50×.** A settled `low` frame allocated **287 KB**, not 3.6; 17 MB/s at 60 fps, a scavenge every thirty frames. See §6.3.1 | 20 hitches / 6.9 s of 147 s | **287 → 31.9 KB/frame at `low`, 62 at `high`** | identical | none |
| **9** | **Opaque overdraw on deck** — 1.56 layers at `high`, **1.97 at `low`**, p95 6–7, **21–31% of pixels shaded four times or more**. The most fill-expensive place in the game, and it is hull/deck/interior/rigging, not weather | up to −1.0 layer = −518k heavy fragments | **0.2 – 0.4 ms** | **0.2 – 0.4 ms** | unknown until the cause is attributed (§10) |
| **10** | ~~**Combat FX particle fill**~~ **WIRED, phase 4.** The row was right that the cost is fill and not count, so the governor's `particleScale` — which CombatFx had never read at all — now lands on `gl_PointSize` as the lever's square root, and nowhere else. It is 1.0 across the whole top of the ladder: this is a knob for a machine already in distress, not a cut | up to −29% of the burst's fill at the bottom of the ladder | — | same | none until the governor is at the bottom |
| **11** | **The storm-front cylinder** (0.19–0.28 layers re-measured **in ordinary play**) — **LANDED, phase 4**, but as an early-out rather than a trim: the wall's own profile finishes at 1.77×topY and everything above that was arriving at alpha zero through three fbm fetches. The **rain haze** (0.466 re-measured in a storm) is untouched: it is a `MeshBasicMaterial` with one texture fetch, i.e. the cheapest fragment in the frame, and its coverage IS the effect | the sky above the bank stops being shaded — 10% of the wall at ring range, 37% of it up close | — | same | **none** — no pixel that was painted stops being painted |
| **12** | **Pixel ratio** — the knob the governor pulls first, and the smallest one at `high` | ratio² on the main pass and the post chain; **nothing at all** on the 16.8 M-texel shadow map | ratio 1→0.75 reaches ~12% of the frame's fill+texel work | at `low` it is the only fill knob, and it reaches all of it | resolution — the most visible loss on this list |

### 9.3 What NOT to spend a day on — measured, and innocent

Every one of these was named as a suspect and came back at or near zero:

| suspect | measured |
|---|---|
| waterfall sheets | **0.003** layers |
| plunge-pool mist (723 points) | **0.002** layers |
| foam / wake sprites (90 sprites) | **0.000** layers |
| lantern & glow sprites (29 sprites) | **0.000** layers |
| storm ring, storm halo | **0.000–0.007** layers |
| sun disc, sun glow | **0.000** layers |
| island contact shadows (288 instances) | **0.001** layers |
| island foliage / micro-detail alpha cutouts | **0.008** layers |
| rain streaks (3 shells, up to 3,580 segments) | **0.013–0.026** layers |
| vignette / grade | one full-screen quad, already counted in the post chain |
| texture upload | 0.32 s of a 180 s capture |
| island build, after the streamed queue drains | 0.14 s of a 180 s capture |
| chart / minimap | never appears in a profile |
| net bursts | netcode 0.95 s of 180 s, no bunching |
| HUD / DOM | 0.15 ms per frame |
| audio | 0.10 ms per frame |
| animation / `PlayerAnimator` | 0.02 ms per frame |
| the game's JavaScript, all of it | **1.76%** of CPU |

### 9.4 The one-sentence version

The frame is not limited by the game's logic, its particles, or any of its content
waves — it is limited by **shader links still being taken while the player is moving,
by draw-call submission and scene-graph traversal over 9,185 drawables, by a shadow map
thirty-two times the size of the screen, and by a sky that shades every pixel of the
framebuffer whether or not anyone can see it** — and the quality tier, which is what a
struggling machine currently falls back on, halves the draw calls, deletes the shadow
map and the post chain, and leaves the overdraw *exactly where it was*.

---

## 10. What I could not measure, and why

1. **Absolute milliseconds on the real GPU.** SwiftShader only; the GPU ban is
   non-negotiable on this machine. Every ms in §9 is a model with stated assumptions
   (§9.1) and should be read as ±2×. The deltas are exact; the prices are not.
2. **The pixel-ratio → frame-time exponent.** The sweep ran (0.75/1.0/1.25/1.5 at two
   scenes) and **failed**: R² 0.39 and 0.77, exponents 0.41 and 0.26, and ratio 1.5
   came out *faster* than 1.25 at dock-vista. Those frames are dominated by shader-link
   storms and GL entry-point overhead, not by shading, so the fill exponent is not
   recoverable on this backend. §8.1 gives the analytic law instead, which is exact.
3. ~~**Per-frame allocation, separated from per-second allocation.**~~ **ANSWERED,
   phase 5 — and it needed no GPU, only a frame that is a frame.** The obstacle was
   never the frame rate, it was that the measurement spanned its own garbage
   collections and that the "frame" being timed was a software-rasterised one.
   `Game.benchFrameCpu(n, 1/60)` drives the real per-frame CPU path with no GL in
   it, sampled one frame at a time: a settled `low` frame allocates **31.9 KB**
   today and allocated **287 KB** before the pass, which is 80× the figure §6.3
   inferred. See §6.3.1.
4. ~~**What the opaque overdraw on deck is made of.**~~ **ANSWERED, phase 4.**
   `perf-cost-model.mjs --opaque deck-aft` points the per-source census at the opaque
   set, and it is the SHIP: standing on your own deck, `ship` alone reads **1.662
   layers over 46.0% of the framebuffer, p95 5, max 10** — roughly 87% of the deck's
   opaque half and about two thirds of the whole frame's depth complexity. Everything
   else is rounding: `island-decor` 0.238, the four islands in frame 0.074 between
   them, barrels 0.002. It is not a fill fix — hull, deck, interior and rigging are
   being shaded and then covered by each other. See `docs/FILL_AND_SHADER_PASS.md` §5.
5. **How many times `setSize` is actually called.** 19.5 s of self time in a 180 s
   capture and one 1,644 ms hitch, but the profile gives sample hits, not call counts.
   A counting wrapper would settle whether this is 40 expensive calls or 4,000 cheap
   ones.
6. **The twelve 512×192 textures.** 6.1 MB, 31% of the texture budget, twelve distinct
   objects with no `name` and no distinguishing slot. They look like a repeated
   generated canvas. The resource census needs to record a creation stack or a content
   hash to say what they are.
7. **The `low`-tier scaling sweep** was queued and lost when a run chain was
   interrupted, and the `high` full-resolution CPU profile ran but its JSON was never
   written (its console output is quoted verbatim in §6.1). The `high` hitch census was
   re-run and is in §7.1 — though its own JSON was cut short too, so its figures come
   from `hitch-high.log`, which holds every number quoted. Nothing in the conclusions
   rests on the two that are missing:
   the pixel-ratio law is analytic (§8.1) and the tier comparison comes from the count
   battery, which ran at both tiers.
8. **`combat-burst` at the forced-source attribution pass** died with *"Execution
   context was destroyed, most likely because of a navigation"* — the page navigated
   itself mid-session (a death/respawn path, most likely). The scene's headline numbers
   come from two earlier successful runs; only its per-source blended split is missing.
9. **The uncommitted `OceanRenderer.ts` diet is baked into every number.** See §0.
   Whoever commits or reverts it should re-run `perf-cost-model.mjs`; nothing else in
   the model depends on it.
10. **Scene-to-scene spread.** Bot ships sail; the same scene on the same pinned seed
    reads ±5–15% across runs (e.g. `waterfall-deck` blended overdraw 1.15 and 1.93 in
    two captures, because the fixed camera framed a different amount of the storm
    front). Single-frame columns (`passes`, per-source overdraw) carry that spread.

---

## 11. Lever 1, done: what actually stalls, and what is left

Round 2, phase 1. Everything here is measured on the pinned map (seed 20260801),
software ANGLE, framebuffer collapsed to ratio 0.1 so a ninety-second capture is
thousands of frames of play rather than a few hundred.

### 11.1 The instrument that made it specific

`scripts/perf-program-census.mjs` + `scripts/lib/program-census.mjs`. A CPU
profile can say `getProgramParameter | getUniforms | replaceLightNums`; it cannot
say *which* program or what put it on screen. The census patches
`getProgramParameter` on both context prototypes at document start — the first
thing `new WebGLUniforms()` does is ask for `ACTIVE_UNIFORMS`, so every deferred
first use announces itself exactly once — and wraps the renderer's own
`renderBufferDirect`, so a join taken while that call is on the stack was taken
BY A DRAW and one taken outside it was paid on purpose.

Two corrections that any future reading depends on:

- `checkShaderErrors` reads `LINK_STATUS` and the info log *before* the uniform
  reflection, and on a driver with no parallel compile that read is where the
  link is actually paid. The warmer turns that flag on for its own joins, so
  timing only `ACTIVE_UNIFORMS` reported every warmed join as 0 ms. Both are
  charged now.
- The draw wrapper must be installed with a retry. The game object is published
  before its `WebGLRenderer` exists, so a one-shot install at publication
  silently does nothing and the entire load is then recorded as "warmed" — a run
  whose warmer had been disabled from construction read 82% warmed.

### 11.2 What was wrong, and what it is worth

| finding | measured |
|---|---|
| the warm walk was `traverseVisible` — it could only ever see the frame being drawn, and every program that stalls belongs to the frame after it | weather shells, fx pools and unrevealed island detail sit in the graph with `visible = false` until the instant they draw |
| the walk stopped after 4,000 meshes and resumed next frame, while the scene walks 4,526–9,388 nodes | on any frame most of the graph had not been examined when the hide decision was taken |
| `prepare()` returned before walking whenever the guard was down and nothing was pending | the class was a load-time fix by construction |
| kicking hidden material with a strict FIFO join queue | draw-time links went **UP**, 36 → 52: the material on screen waited behind fifty rooms the player was not in until its forty frames of patience ran out |
| a key was marked paid even when `join()` found no program to join | warmer reported 82 paid; the census could find 16 joins outside a draw |
| `currentProgram` holds only the last program compiled for a material | a material drawn both instanced and not had its first join take the second's program |
| eight cliff-rock programs (`pirates-strata-0/1/2`, `reef-dark`, `reef-wet`, `spire`, `spire-rubble`, `terrace-ledge`) were the same GLSL with one float baked in, each with its own cache key | 10.2 s of joins in one 90 s session; now one program |
| two foliage-card programs, the float named *in* the cache key | now one program |

**Result at `high`, 90 s of play:** draw-time links **36 → 25**, joins **27,964 →
17,655 ms**, live programs **137 → 131**. `low` tours the world with **10**
draw-time links and no depth programs at all.

### 11.3 What is left, named

1. **The shadow pass's depth programs.** `getDepthMaterial` keeps one
   `MeshDepthMaterial`, restamps it per object and draws that, with an empty
   scene, no lights in the render state and a bound render target. Nothing in the
   graph owns those programs and `compile()` cannot reproduce their cache key: a
   pool of hand-stamped depth materials was built and measured, and it minted
   **thirty programs the shadow pass will never ask for** (137 → 167 live) while
   making draw-time links worse. Paying them means driving `shadowMap.render`
   itself, which collides with the shadow update gate. They are the allowlist in
   `scripts/test-program-warm.mjs`.
2. **The menu and the load still take most joins inside a draw** (54 of 69 in a
   toured session). That is the load path, which `test-load-responsiveness.mjs`
   grades, not the play path this lever is about — but it is where the next
   sixty programs are.
3. **`pirates-terrain-detail-m0/m1/volcanic-m1`** fold a cutout COUNT into a
   `#define`. Merging them needs a fixed-size loop and a real fill measurement
   first; it is not a free rename like the rock family was.
4. **A non-finite `AudioParam`** (`SoundEngine.makeSpatialDest`, via
   `playShipImpact`) throws on every tour run. Unrelated to this lever, found by
   it, unfixed.

---

## 12. Lever 2, half done: a pier is now its material count, and its material count is the wall

### 12.1 What the draw report could not say

Lever 2 was written off `island-decor` being "the #1 or #2 draw source in every one
of the nine scenes, 247–668 calls, already instanced — so many `InstancedMesh`
objects, one per prop type per island". **That sentence is wrong in its second
half.** `perf-attribution` stops one level under the island detail root and the
answer is four levels down; `scripts/perf-decor-census.mjs` (new) walks each placed
piece and reports, per mesh, the FIRST rule in `StaticBatcher.isMergeable` that
refuses it. At `low`, pinned seed, fourteen islands:

| piece | copies | draws/copy | the refusal |
|---|--:|--:|---|
| `decor-dock` | 10 | **38.2** | `named` × 362 of 382 meshes |
| `island-micro-root` | 14 | 22.8 | `named` × 265 |
| `prop-mermaid_shrine` | 1 | 15.0 | `named` × 15 |
| `prop-fort` | 1 | 12.0 | `named` × 12 |

Not instancing. **Names** — and not names this repo wrote: `dock_mid_deck`,
`lantern_post_post_1`, `campfire_stone0_3`, `tent_c_pole_5`. glTF names every node
it writes, and the batcher's rule was "never merge a named mesh, because a name is
how this codebase finds a node again". The exporter defeated it wholesale.

### 12.2 What landed

`isMergeable` now refuses a name only if it is ADDRESSED: in
`StaticBatcher.ADDRESSED_NAMES`, or absent from the set of node names the GLBs
themselves carry (`assets.isAssetNodeName`). `scripts/test-decor-batch.mjs` re-derives
the addressed set from `src/` and `scripts/` on every run — every literal reaching
`getObjectByName` or `o.name === '…'` — and fails on one that is not classified.

| | decor draws, all 14 islands | worst pier |
|---|--:|--:|
| before | 1,740 | 38.2 draws / 16 materials |
| after | **1,510** | **16.0 draws / 16 materials** |

Triangles are bit-identical across all 347 pieces. Mutation-proven both ways: drop
`'door'` and the source half fails naming `DockBuilder.ts`; restore
`if (mesh.name) return false` and all ten piers fail the live budget at 34–52.

### 12.3 The wall, and it is not a batching problem

After that change **every remaining decor draw is `sole-of-material`** — draws/copy
equals materials/copy on every row. The batcher is exhausted. The reason is in the
assets: **sixty-three GLBs, zero images, zero textures, and 8–16 flat-colour
`MeshStandardMaterial`s apiece.** `fort.glb` is twelve materials — `Rock_Dark`,
`Stone_Fort`, `Bone`, `Gold` — i.e. twelve draw calls to say twelve colours. It also
costs the instanced props: `props-palm_c` is ONE `InstancedMesh` submitted **5**
times because `mergedGeometry` keeps one group per material.

### 12.4 The collapse: measured, then reverted — and the four traps

Folding every untextured asset material onto one, with the colour and the
roughness/metalness moved to vertex attributes, was built and measured:
**decor draws 1,510 → 927**, `prop-fort` 12 → 2, `decor-dock` 16 → 5,
`props-barrel`/`props-crate`/`props-bush_berry` → 1 each, triangles unchanged.
It is **reverted at HEAD** because it is not shading-neutral yet. Four traps, three
of them fixed on the branch that was thrown away, the fourth open:

1. **`aSurface` dropped by the merge path.** `AssetLibrary.subGeometry`/`mergeGeoms`
   copy position/normal/color by hand. A missing vertex attribute reads (0,0,0,1),
   so a lost roughness attribute is **roughness 0 — a mirror**, and this game ships
   no envMap: every instanced boulder rendered matte black. Store *smoothness*
   (1−roughness) so the same failure is merely "fully rough".
2. **`COLOR_0` is not yours to redefine.** Baking colour into it (free, no shader)
   double-darkens every mesh where a builder reuses ASSET GEOMETRY under its OWN
   material — `SeaRockBuilder` does exactly that. Shore rock RGB 70,68,57 → 41,39,32.
   Use a private `aTint` attribute instead.
3. **A material clone drops `onBeforeCompile` and `customProgramCacheKey`.**
   `Material.copy` does not carry them. Build the material as a **subclass** whose
   constructor reinstalls the patch, since `clone()` is `new this.constructor()`.
   And `PropScatterer.applyFoliageSway` **assigns** rather than chains — on a shared
   asset material that silently deleted the patch and every palm rendered white.
4. **OPEN: `material.color` stops meaning "the colour".** `CaveBuilder` recolours the
   portal frame with `mat.color.copy(portalRockCol)` on a clone of the asset's
   material. With the colour in `aTint`, that multiplies instead of replacing —
   `cave-portal-rock` went black. Every site that writes `.color` on an asset-derived
   material has to be found and given an explicit "ignore the baked tint" switch (a
   `uAssetTint` float the shader mixes with, set to 0 by such callers). **That audit
   is the remaining work**, and shipping without it trades eye-level quality for a
   draw count, which this project does not do.

One material per ASSET, never one per library: a library-wide material makes every
crate and pier bend in `applyFoliageSway`'s wind.

---

## 13. Lever 1, round 2: the biggest remaining link source was not a link at all

Section 11 left lever 1 at "36 → 25 draw-time links at `high`" and named four
things still outstanding. None of them was the largest item. A fresh census on
the pinned map found something the previous pass could not have seen, because
the previous pass never died.

### 13.1 The reading

`scripts/perf-program-census.mjs --quality high --seconds 90`, pinned map 20260801,
software ANGLE, framebuffer collapsed to ratio 0.1.

| | before | after |
|---|---|---|
| program keys in the session | 135 | **75** |
| links taken inside a drawn frame **during play** | 40 | **8** |
| …of those, taken in one 600 ms window | **28** | 0 |
| program keys that were duplicates of a key already paid for | **31** | **0** |

The milliseconds are not in that table on purpose. The after-run's load phase
read 51,355 ms of joins against the before-run's 20,387 ms for the same work —
the machine was simply busier — so a play-phase millisecond comparison across
the two runs would be reporting the machine's mood. The counts are exact and
they are the claim: **40 links during play became 8.**

### 13.2 What it was

Thirty-one of the 135 program keys were pure duplicates. Diffed field by field
against three's own parameter order (`WebGLPrograms.getProgramCacheKeyParameters`),
every one of the 31 pairs differed in **exactly one field: `numHemiLights`, 1 vs
2** — and 28 of the 40 links taken during play were those duplicates, all inside
one 600 ms window at t+76 s.

`Game.updateSpectateLight` built a `THREE.HemisphereLight` the first time the
player died, added it to the scene, and hid it again when the lift decayed. The
light count is a field of the program cache key, so **each of those transitions
re-linked every material the frame drew** — material the warmer had already paid
for, at the one moment in a match when the player is least able to ignore a
freeze. `LightBudget`'s own header states the law ("one torch popping in or out
re-links every material in the scene") and pins the point-light count at a fixed
pool size; nothing was enforcing it for any other kind of light.

The fix is one light, not two. Both are hemispheres, and three shades a
hemisphere as `mix(groundColor, skyColor, w)` with `w` a function of the surface
normal alone and the intensity already multiplied into the colours, so

```
I₁·mix(G₁,S₁,w) + I₂·mix(G₂,S₂,w) = (I₁+I₂)·mix(lerp(G₁,G₂,k), lerp(S₁,S₂,k), w),  k = I₂/(I₁+I₂)
```

for every normal. Folding the spectate fill into the scene's existing hemisphere
light is therefore the same radiance to the last bit, and it costs one fewer
light in the fragment loop of every lit pixel in the game rather than one more.
See `Renderer.applySpectateLift`.

### 13.3 Why nine islands of touring never found it

`test-program-warm.mjs` drove the free cam to sixteen vantage points across
eight islands and passed. Every one of those stops is a change of what is on
SCREEN, and the defect was a change of what is in the SCENE. The suite now does
two things it did not:

- **the tour dies.** It eliminates the local player, waits for `spectateLift` to
  reach 1, and comes back. That is the state change that touches the lighting.
- **`lightCountChurn()`** normalises every cache key by blanking the eleven
  light-count fields and fails if any normalised key maps to more than one real
  key. Exact, no clock, no budget — two keys that differ only in a light count
  are one shader compiled twice. Fields are indexed from the END of the key,
  because the head is the shader id plus the material's own `defines` and varies
  in length.

`--mutate-lights` is its proof and is a SECOND mutation, because the first one
cannot reach this line: disabling `ProgramWarmer` says nothing about a count
that moves mid-match, and no warmer can defend against one. It adds a single
`HemisphereLight` after first control and reproduces the defect as found — 33
duplicate keys, 37 links during play against a clean run's 7. Both mutations now
have to redden the assertion they were written for; a run that goes red
somewhere else no longer counts as proof.

### 13.4 What is left, re-ranked

The `high` play residue is 8 links, and it is no longer dominated by one cause:

| ms (advisory) | what | why it is still there |
|---|---|---|
| 6,009 | `props-boulder_a` instanced+vcolor | island detail revealed before the warmer's join budget reached it |
| 4,534 / 841 | two ship `MeshDepthMaterial` | shadow pass — allowlisted, see 11.3 §1 |
| 4,427 / 250 | a sea rock arriving | sea rocks are built after the island stream, outside the load guard's tail |
| 4,377 | `decor-reef-rock` | same class as the boulder |
| 2,971 | sea-rock `MeshDepthMaterial` | shadow pass |
| 1,549 | `wrecker_tower_ground` | same class |

Five of the eight are one shape: **a subtree is revealed in the same frame the
warm walk first sees it.** During play the guard is down (holding material out of
a frame would be a visible pop), so the walk kicks the program and the reveal
draws it before the join lands. The principled fix is to couple the LOD reveal to
the warmer — a subtree stays hidden until its programs are paid, which is the
guard mechanism applied to newly-revealed subtrees only. `IslandDetailWarmer`
already has the shape of this in its COLD reveal caps; it is not wired to
`ProgramWarmer.paid`.

Two items from 11.3 are now answered rather than open:

- **`pirates-terrain-detail-m0/m1/volcanic-m1` are not worth merging.** `m0` is
  the material with NO cutout at all — no `discard` in its fragment shader — and
  merging it with `m1` would put a discard on every island that has no cave,
  which is an early-Z regression on a machine that is short of fill. The merge
  that IS safe (m1..m8 → one fixed-size loop with the count as a uniform) saves
  nothing on the pinned map, which only ever produces `m1`. Left alone, on
  purpose.
- **The census's own duplicate check is now a gate.** The instrument that found
  this could only report it after the fact; `lightCountChurn` fails a build.

Still open: the shadow pass's depth programs (11.3 §1), the load path (11.3 §2),
and the non-finite `AudioParam` (11.3 §4), which still throws once per tour and
still has no probe of its own.

## 14. Lever 2, done: the material collapse, and the two gates that could not have caught it

### 14.1 The audit §12.4 left open turned out to be four call sites, not a hunt

§12.4 revert-listed one open trap: *"every site that writes `.color` on an
asset-derived material has to be found"*, and treated that as an audit of the
whole codebase. It is not, because the collapse does not have to be
library-wide. Two paths produce a multi-material draw and they are separable:

* **`assets.mergedGeometry`**, whose output is used by exactly FOUR call sites,
  all of them building an `InstancedMesh`. Grepped, read, and enumerated: the
  prop scatter, the interior scrub/log scatter, the cave rubble, the cave portal
  frame. Only the last writes `.color`, and it is the one §12.4 already named.
* **`StaticBatcher`**, whose merged material is a fresh private object that
  nothing addresses — a batch is named `<piece>-batch` on purpose.

So the switch (`bakedTint = false`) has ONE caller, and the batcher needs no
audit at all provided it refuses to fold a material somebody has patched. That
refusal is structural rather than grepped: `collapseFamilyKey` returns null for
a material whose `onBeforeCompile` or `customProgramCacheKey` is not the one
`THREE.Material.prototype` supplies.

### 14.2 Two three.js facts that cost an hour each

**A material ARRAY is a draw call per group, and `mergedGeometry` returns one.**
This is why `props-palm_a` — ONE `InstancedMesh` holding four thousand palms —
was five draw calls on every island that has palms, and why the lever-2 brief's
"merge instanced batches ACROSS islands" would have bought almost nothing: the
count was not per-island, it was per-COLOUR.

**`Material.customProgramCacheKey()` defaults to `onBeforeCompile.toString()`.**
Two consequences, opposite in sign:

* an ordinary patched material already gets its own program for free, so the
  usual worry ("two materials share a cache key and one of them has a patch")
  does not arise — but a material that OVERRIDES the method, which any material
  with its own named key does, gives that up. Anything patching such a material
  afterwards has to put itself back in the key by hand. `applyFoliageSway` now
  chains both hooks for this reason.
* a refusal test written `customProgramCacheKey() !== ''` is **never false**.
  That one line made the batcher change measure as a no-op for a full census
  run.

### 14.3 What it bought

Draw calls per island, `perf-attribution --by calls`, high, pinned map
20260801, triangles bit-identical on every row:

| scene | islands, before | after §14 (asset collapse only) |
|---|--:|--:|
| dock-vista | 651 | 528 |
| island-interior | 573 | 469 |
| open-sea | 580 | 467 |

Draws per copy, `perf-decor-census`, low, after the batcher collapse too:

| piece | §12 | §14 |
|---|--:|--:|
| `decor-dock` | 16.0 | **4.0** |
| `island-micro-root` | 22.8 | **13.4** |
| `prop-mermaid_shrine` | 15.0 | **2.0** |
| `prop-fort` | 12.0 | **2.0** |
| `prop-watchtower` | 7.0 | **2.0** |

Whole-frame draw calls on the approach ladder at high, identical per-batch
instance counts on every rung: 900 m 1070→863, 600 m 1486→1238, 380 m
1273→1038, 220 m 1406→1023.

### 14.4 Two gates that had stopped being able to fail

Both were written before the thing they now guard existed, and both would have
reported a pass through the regression:

* `test-asset-merge` check 3 was group bookkeeping under `if (mats.length > 1)`.
  The collapse makes every asset single-material, so the check would simply have
  stopped running. **A gate whose subject can disappear is a gate that cannot
  fail.** It is now a re-derivation: walk the GLB the way `mergedGeometry` walks
  it, count the merged vertices each source material owns, and require the baked
  tint/surface tally to match exactly.
* `test-decor-batch` graded the pier with `draws > mats + 4` — a budget
  expressed in the very number the change moves. Unmerged is 16 draws for 16
  materials, and 16 is under 20. It now also holds the MATERIAL count to a
  constant ceiling.

Rule worth keeping: **never grade a quantity against a budget derived from that
same measurement's own denominator.** Ratio budgets survive the regression they
were written for.

### 14.5 What is left of lever 2, and what lever 3 turned out to be

`decor-dock` is 4 and not 1 because the bucket key also carries the geometry's
attribute set, its indexed-ness, and its shadow flags — real constraints, worth
maybe two more calls per pier, not worth the risk today. `island-micro-root` at
13.4 is the largest remaining decor row and its census still shows `named×33`.

**Lever 3 is largely already paid.** The model sized it off "the scene holds
9,201-9,388 drawables and `projectObject` walks all of them", and at LOW, pinned
map, three now reaches **1,663 nodes at the dock vista, 1,774 in the island
interior and 387 at sea** — of 7,014 in the graph. The island-level frustum test
(fd35000) plus the radius gates did that. What is left is the gap between
reached-drawable and drawn (1,181 vs 554 at the dock vista): six hundred bounding
spheres tested to reject. That is a manual render list or a coarser per-piece
gate, and it is a smaller prize than the numbers in §9 imply.

---

## 15. Lever 9: the opaque overdraw on a deck, attributed — and two instruments
that could not have attributed anything

Lever 9 was the largest number in this model that had never been sent anywhere:
standing on your own deck, **1.56 opaque layers at `high` and 1.97 at `low`**, p95
6-7, with 21.0% (high) and 30.9% (low) of the framebuffer shaded four times or
more. §10.4 named it, the fill pass got it as far as the word **`ship`** — 1.662
layers over 46% of the frame — and there it stopped, one level above anything
anyone could act on.

`scripts/perf-deck-overdraw.mjs` is the level below. It keys a **part** off the
material rather than the node name, because a hull is hundreds of unnamed meshes
under one named group and `mergeStaticMeshes` then collapses them to one draw per
material: on a ship the material IS the surface, and it is also the thing a fix
edits (`side`, `depthWrite`, a merge, a cull).

### 15.1 Three defects in the measurement, found before any fix was written

Each of these was found by a reading that could not be true, and each would have
sent a fix to the wrong place.

**1. The part key was a colour, and every textured material here is white.**
`MeshStandardMaterial` with a `map` leaves `color` at `0xffffff`, so the first
part census reported hull shell, deck planking, dark timber and barrel wood as
ONE part called `Standard#ffffff` carrying **1.119 layers over 34.5% of the
framebuffer** — the largest reading in the deck's fill budget, naming four
different surfaces at once, one of which is `DoubleSide` and three of which are
not. The key now carries the map and the side, and the ship's materials carry
real names (`ship-hull-shell`, `ship-deck-planking`, …). Nothing reads
`material.name` at runtime.

**2. The ship sails out from under the camera between renders.** `measureScene`
re-anchors a ship-relative scene to the hull on every frame of its capture window
and then returns; every stencil census after it is seconds of software
rasterisation with a camera that no longer follows. Two runs of the same what-if
on the same pinned seed:

| | run A | run B |
|---|---|---|
| ship's share of the framebuffer | 35.4% | 57.6% |
| `DoubleSide → FrontSide` | −0.552 layers | −0.098 layers |

Both were labelled `deck-aft`. `ANCHOR_SHIP` now re-places the camera in the
SAME task as the render that counts, immediately before it.

**3. A counterfactual graded against a stale baseline measures the world's
drift.** Anchoring fixes the ship's framing, not the world behind it. With the
baseline taken minutes earlier, **hiding one hammock read −0.874 layers** —
three quarters of what deleting every ship in the world was worth (−1.168).
`WHAT_IF` now takes its own baseline in the same call, immediately before the
mutated render, and reports only the difference.

### 15.2 The three.js fact the brief was wrong about

> "three sorts opaque front-to-back by default — verify `renderOrder` overrides
> are not defeating it"

**It does not, and nothing is defeating it.** `painterSortStable`
(`three/build/three.module.js:21250`, r0.160.1) compares `groupOrder`, then
`renderOrder`, then **`material.id`**, and only reaches `z` when two draws
already share a material. Opaque draw order in this game is therefore *material
creation order* — for a ship, the order its constructor happens to declare its
materials in. There is no depth sort to defeat.

That makes "draw the biggest occluders first" a real and completely unpriced
lever, so it is priced rather than argued: `WHAT_IF`'s `frontToBack` op assigns
`renderOrder` by distance from the camera across a bucket's opaque drawables, and
one measurement says what the whole hypothesis is worth before a line of renderer
code is written to chase it.

### 15.3 What the deck actually is, at `low`, anchored

Frame 2.741 layers, blended 0.435, **opaque 2.306**. Of that the `ship` bucket is
**1.353 layers over 35.8% of the framebuffer** — which is **3.78 layers over the
ship's own pixels**, p95 5, max 9.

| part | layers | covers | p95 | max | side |
|---|---|---|---|---|---|
| `ship-hull-shell` | 0.256 | 25.6% | 1 | **1** | double |
| `ship-dark-timber` | 0.369 | 21.2% | 2 | **6** | front |
| `ship-iron` | 0.004 | 0.4% | 0 | 2 | front |
| `hold-floor`, `hold-inner-wall`, `LineBasic`, `ship-team-accent` | 0.000 | 0.0% | 0 | 0 | — |

**The hull is cleared, and it was the brief's first suspect.** `ship-hull-shell`
reads **max 1**: it never stacks on itself anywhere in the view. From inside a
closed shell a view ray crosses it exactly once, so its `DoubleSide` — which
exists so a shot hole shows the far interior wall rather than vanished
backfaces — cannot be buying a second layer on a deck. The suspect list's "hull
inner/outer shells drawn twice" is not what is happening.

**The hold is cleared too, for fill, and convicted for something else.** Every
hold surface reads exactly 0.000 layers: the deck is drawn first (its material is
older, and material id is the sort key) so the hold below it is entirely
depth-rejected. It costs no fill at all. What it does cost is that
`mergeStaticMeshes` buckets by material, and `darkMat` is used by both the hold's
ribs, beams and ceiling slabs AND the deck rails and masts — so `ship-dark-timber`
is **one draw call spanning y −0.2 to 11.7**, bilge to masthead. The hold cannot
be gated separately from the rig because they are the same mesh.

### 15.4 The tier inversion is not a tier effect

§3 records `deck-aft` at 2.66 layers at `high` and **3.03 at `low`**, and calls
the low tier being worse than the high one backwards. It is backwards. It is also
not what is happening.

Three anchored runs of the same scene, same pinned seed, same 960×540, same
machine, taken within one afternoon:

| run | tier | frame | blended | opaque | `ship` | `ship` covers |
|---|---|--:|--:|--:|--:|--:|
| A | low | 2.741 | 0.435 | 2.306 | 1.353 | 35.8% |
| B | high | 2.128 | 0.442 | 1.686 | 1.268 | 34.0% |
| C | low | **2.198** | 0.430 | 1.768 | 0.996 | 28.5% |

**The two `low` runs differ by 0.543 layers; `low` minus `high` is +0.613 using
run A and −0.070 using run C.** The sign of the tier difference is decided by
which of two runs of the same tier you happen to compare.

And inside run C alone, the `ship` bucket was censused twice a few minutes apart:
**0.996 layers over 28.5%, then 0.655 over 21.6%** — a third of itself, with the
camera anchored to the hull both times.

This repo's own two published passes already disagreed about the sign and nobody
noticed, because each pass only ever compared against itself:

| source | deck-aft high | deck-aft low | verdict |
|---|--:|--:|---|
| this model, §3 | 2.66 | 3.03 | low is **worse** by 0.37 |
| `FILL_AND_SHADER_PASS.md` §2.1, after | 3.013 | 1.751 | low is **better** by 1.26 |

Both cannot describe the tier. What `deck-aft` actually measures is *wherever the
local hull had sailed to by the time the census ran* — which island is astern,
how far the anchorage is, how the hull is heeled — and that is a different
picture every session. The scene is fine for grading a build against itself in
one session; it cannot carry a cross-session claim about anything, and the
"low is worse than high" entry in §3 should be read as an artifact.

The one cross-tier statement the readings do support is the flat one: the `ship`
bucket is **1.268 at `high` and 1.353 at `low`**, inside the run-to-run spread.
Whatever the deck costs, the quality ladder is not changing it.

### 15.5 What lever 9 needs next, and what it does not

It does not need another afternoon of stencil censuses on `deck-aft` at this
precision. Every absolute reading it can take moves by a third between renders.

1. **A reproducible deck.** Either park the hull (a debug hook that pins ship
   position and rotation for the length of a census) or stop asking `deck-aft`
   cross-session questions. Without one of those, no fix on this lever can be
   shown to have worked.
2. **Attribution by share, not by layers.** Already done here — every row carries
   the whole frame taken in the same task — but the shares still need to be
   re-taken on a parked hull before they rank anything.
3. **The draw-order lever is unpriced and now measurable.** three r160 never
   sorts opaque front-to-back (§15.2), so nothing in this game draws its
   occluders first. `WHAT_IF`'s `frontToBack` op prices it in one paired
   measurement.
4. **Two suspects from the brief are already cleared** and should not be
   re-investigated: the hull's `DoubleSide` (max 1 layer — a ray crosses a closed
   shell once from inside) and the hold interior (0.000 layers — the deck's
   material is older, so it draws first and rejects everything below it).

### 15.6 The parked hull, measured — it fixes the subject and not the frame

`PARK_SHIP` pins the local hull's render transform to a pose derived from the map
(the dock island's centre, offset seaward by its own radius) and puts the camera
on it, at the top of the same task as each counting render. Two sessions, same
seed, both parked at the same point (196, 690):

| | unparked, same session | **parked**, two sessions |
|---|--:|--:|
| `ship` coverage of the framebuffer | 28.5% → 21.6% | **27.7% → 27.7%** |
| `ship` layers | 0.996 → 0.655 (**−34%**) | 0.850 → 0.914 (**+7%**) |
| frame layers | 2.198 | 2.489 → 1.435 |

**The subject holds still now and the frame does not.** Ship coverage repeats to
the tenth of a percent across two separate browser sessions, which is what a
per-part census needs and never had. The frame mean still swings 2.489 → 1.435,
and the blended half with it (0.562 → 0.269): the local hull is parked, the nine
bot hulls, the sea state and the weather are not.

So the shares in §15.3 can now be re-taken and trusted, and a whole-frame number
on `deck-aft` still cannot be compared across sessions. The remaining step, if a
frame-level claim is ever wanted here, is to park the fleet as well — the same
hook over `shipMeshes` rather than over one entry of it.
