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
  in — meshes, points, sprites and lines — of which 231–2,908 are drawn. three's
  `projectObject` walks all of them every frame, and the shadow pass walks them again.
  That traversal is 15% of all hitched time (§7.1) and it does not care what tier you
  are on.

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

Two things the intercepts say. There is a **floor of 286–542 draw calls that no camera
angle removes** (sky, ocean rings, viewmodel, HUD-adjacent meshes, the always-resident
FX pools). And **blended draws barely move with content at all** — 56 at the intercept,
+2.4 per island — which is the counting-side confirmation of §3.1: the blended bill is
a handful of fixed full-screen shells, not a crowd of small things.

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
| **1** | **Warm every program the tier can reach, before the match — and cut the program count** (105–155 at `high`, 58–63 at `low`). Eleven of the twelve worst hitches are `getUniforms → replaceLightNums`, three r160's deferred first-use link, being taken *during play*. `ProgramWarmup.ts` fixes the load case; nothing fixes the walk-round-a-corner case | 45 hitches / 37.6 s of a 150 s capture → 0; worst single hitch 4,672 ms | **the biggest single win available**; on the GPU path the repo's own figure for one link is 1,366–1,782 ms | same class, ~60% fewer programs to warm | none |
| **2** | **Batch `island-decor`** — the #1 or #2 draw source in *every one of the nine scenes*, 247–668 calls. It is already instanced (227–290 instances in frame), so these are many `InstancedMesh` objects — one per prop type per island — not many props | −200 to −600 draw calls; triangles unchanged | **1.0 – 3.0 ms** (draw submission is 43% of all hitched time) | **0.6 – 1.5 ms** | **none** — identical geometry |
| **3** | **Cull the scene graph at the group level.** The scene holds **9,201–9,388 drawables**; three's `projectObject` walks every one of them per frame, and the shadow pass walks them again. Render traversal is 120 hitches and 15% of hitched time | −70–80% of the per-frame traversal if islands out of the frustum have their detail roots hidden rather than per-mesh culled | **0.5 – 1.5 ms** | **0.5 – 1.5 ms** | none |
| **4** | **Shadow map 4096² → 1536²**, and skip the pass when the ortho box has no casters (measured: **0** caster draws at open-sea and storm-sea, and the 4096² clear is paid anyway) | 16.78 M → 2.36 M texels/frame; 67 MB → 9.4 MB of store traffic per frame; 112 MB → 15.75 MB resident; also −201 to −561 draws | **0.6 – 1.6 ms** | 0 (no shadows) | 7.6 cm/texel → 20 cm/texel under PCF-soft — invisible at this world scale |
| **5** | **Depth-test the sky and draw it last** (today: `depthTest:false, depthWrite:false, renderOrder:-1`, so it can never be rejected) | **−267k to −328k fragments** of a ~470-op procedural shader per frame — measured, not modelled | **0.18 – 0.22 ms** | **0.18 – 0.22 ms** | **none** — every removed pixel is covered by something else |
| **6** | **Trim the post chain at `high`/`balanced`**: MSAA 4×→2×, bloom base 480×270→240×135, fold the grade into `OutputPass` | −0.7 M quad fragments, −10 MB/frame of resolve traffic, −33 MB resident, −2 passes | **0.2 – 0.5 ms** | 0 (no post) | bloom a shade softer; one MSAA step |
| **7** | **Stop the resolution ladder reallocating the swapchain.** `applyPixelRatio` → `setPixelRatio` → `setSize` runs even when the ratio has not changed; 19.5 s of `WebGLRenderer.setSize` in a 180 s capture with no window resize, and a 1,644 ms hitch attributed to it | one swapchain realloc per ladder step → zero when the ratio is unchanged | removes a hitch class | identical | none |
| **8** | **Cut allocation.** 207–233 KB per second of steady garbage; GC costs 1.5–8.3 ms/s and reached a **125 ms** pause | 20 hitches / 6.9 s of 147 s | **modest and uncertain** — see §6.3 and §10 | identical | none |
| **9** | **Opaque overdraw on deck** — 1.56 layers at `high`, **1.97 at `low`**, p95 6–7, **21–31% of pixels shaded four times or more**. The most fill-expensive place in the game, and it is hull/deck/interior/rigging, not weather | up to −1.0 layer = −518k heavy fragments | **0.2 – 0.4 ms** | **0.2 – 0.4 ms** | unknown until the cause is attributed (§10) |
| **10** | **Combat FX particle fill** — flame **0.484** + smoke **0.159** layers during a burst, 13% of the screen up to 3 deep. Cost is *fill*, not count, so shrink the quads rather than the pool | −0.3 to −0.6 layers while a keg is going off | **0.05 – 0.1 ms**, in the burst | same | `getEffectScale()` already exists (0.48 at `low`) |
| **11** | **The storm-front cylinder** (0.12–0.43 layers **in ordinary play** — it is the safe-ring wall, always up) and the **rain haze** cylinder (0.47 in a storm) | −0.1 to −0.5 layers | **0.03 – 0.17 ms** | same | both are gameplay-legible; trim opacity and extent, not existence |
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
3. **Per-frame allocation, separated from per-second allocation.** A frame here is
   0.15–1.2 s, so the 10 Hz snapshot stream lands inside a fraction of frames. Two
   captures disagree 5× per frame and agree to 12% per second (§6.3). Splitting them
   needs a run at a realistic frame rate.
4. **What the opaque overdraw on deck is made of.** 1.56–1.97 layers with p95 6–7 is
   the largest un-attributed number in the model. The per-source stencil census runs on
   blended materials by default; pointing it at the opaque set on `deck-aft` is one
   more run and would name the layers.
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
   re-run and is in §7.1. Nothing in the conclusions rests on the two that are missing:
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
