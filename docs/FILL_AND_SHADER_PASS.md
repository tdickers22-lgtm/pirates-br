# Fill rate and shader cost

Phase 4 of the smoothness campaign — the first pass in this repo aimed at the
half of the frame a draw-call counter cannot see. It is graded the way
`docs/FRAME_COST_MODEL.md` §0 says to grade things: on the fanless 16 GB
MacBook Air the game targets, under software ANGLE (SwiftShader), against a
**pinned map (seed 20260801)** on a private server on :8091, at a pinned 960×540
framebuffer and pixel ratio 1.

Stencil-counted depth complexity, texels, draw counts and resident bytes are
**exact and backend-independent**. No millisecond is claimed anywhere below.

Every number in §2 is a before/after pair taken with the same rig against the
same seed: `before` from a pristine worktree at `b177a30`, `after` from this
branch. The pictures are in `scripts/fill-pass-shots.mjs`.

---

## 0. The one-sentence version

The sky was being shaded over the whole framebuffer and then painted over half of
it; the shadow map was thirty-two screens of texels resolving detail its own
one-metre bias had already thrown away; and the grade was a whole extra screen of
fill to do four operations on a colour `OutputPass` had just written. Removing
those three took **mean overdraw down 15–32% at `high` and 21–37% at `low`**,
**blended overdraw down 36–75%**, **shadow-map texels from 16.78 M to 4.19 M a
frame**, and **render-target residency from 168.3 MB to 57.4 MB** — with no
frame in a thirty-shot sheet at two tiers, four times of day, that a person can
tell apart.

---

## 1. What changed

| # | change | why it is free to look at |
|--:|---|---|
| 1 | **The sky dome is depth-tested and drawn after the world**, pinned to the far plane with `gl_Position.z = gl_Position.w` | every fragment it loses was covered by ocean, terrain or a hull |
| 2 | **Shadow map 4096² → 2048² at `high`, 2048² → 1536² at `balanced`**; ortho box unchanged | `shadow.normalBias` is 1.0 m — at 4096 the bias was already 13 texels wide |
| 3 | **The shadow pass is skipped while it last drew nothing** | a pass that drew zero casters leaves the map at its clear value, which every lookup reads as lit; bounded at 10 frames *or* 250 ms |
| 4 | **The grade is spliced into `OutputPass`**, and MSAA goes 4× → 2× | same arithmetic in the same place; one MSAA step under a bloom and a grade |
| 5 | **The storm wall discards above its own bank profile** | nothing above 1.77×topY was ever painted — it arrived at alpha zero through three fbm fetches |
| 6 | **The governor's `particleScale` reaches CombatFx**, as an edge-length scale on `gl_PointSize` | 1.0 across the whole top of the ladder; only bites at the bottom |

Not attempted, on purpose: the bloom base resolution (§3), the rain haze (§4),
and anything in the ocean shader (§5).

---

## 2. Before and after

### 2.1 Depth complexity — the whole frame

Stencil-counted, 960×540, mean layers over the framebuffer.

| scene | tier | mean before → after | blended before → after | p95 |
|---|---|--:|--:|--:|
| dock-vista | high | 1.979 → **1.345** (−32%) | 1.269 → **0.634** (−50%) | 3 → 2 |
| deck-aft | high | 3.527 → **3.013** (−15%) | 1.780 → **0.447** (−75%) | 6 → 7 |
| open-sea | high | 1.611 → **1.159** (−28%) | 1.043 → **0.598** (−43%) | 2 → 2 |
| storm-sea | high | 2.339 → **1.885** (−19%) | 1.713 → **1.283** (−25%) | 4 → 4 |
| worst-case | high | 2.353 → **1.768** (−25%) | 2.087 → **1.346** (−36%) | 4 → 3 |
| dock-vista | low | 1.935 → **1.339** (−31%) | 1.228 → **0.629** (−49%) | 3 → 2 |
| deck-aft | low | 2.774 → **1.751** (−37%) | 1.062 → **0.432** (−59%) | 7 → 4 |
| open-sea | low | 1.860 → **1.345** (−28%) | 1.302 → **0.788** (−39%) | 3 → 3 |
| storm-sea | low | 2.362 → **1.874** (−21%) | 1.781 → **1.258** (−29%) | 4 → 4 |
| worst-case | low | 2.297 → **1.732** (−25%) | 1.869 → **1.288** (−31%) | 4 → 3 |

**The low tier moves as much as the high one.** That is the point of §1 finding 1
of the cost model: the quality ladder was buying geometry and not fill, so the
tier that needed fill most got none of it. Every change in this pass except the
shadow map and the post chain applies at every tier.

Read the whole-frame column with the model's own §10.10 caveat: bot ships sail,
and the same scene on the same seed reads ±5–15% between runs. The per-source
column below does not have that problem for the sky, which is a fixed
full-screen shell.

### 2.2 The sky, per source — the number this pass was built on

| scene | tier | sky layers before | after |
|---|---|--:|--:|
| dock-vista | high | 1.000 (100.0% of frame) | **0.401** (40.1%) |
| storm-sea | high | 1.000 (100.0%) | **0.485** (48.5%) |
| worst-case | high | 1.000 (100.0%) | **0.432** (43.2%) |
| dock-vista | low | 1.000 (100.0%) | **0.401** (40.1%) |
| storm-sea | low | 1.000 (100.0%) | **0.485** (48.5%) |

The after figures land on the phase-1 prediction to the decimal: the occlusion
probe said a depth-tested dome would cover 40.2 / 48.5 / 43.1%, and it covers
40.1 / 48.5 / 43.2%. **−0.52 to −0.60 layers, i.e. 267k–310k fragments of a
138-line, ~470-operation procedural shader, per frame, at every tier, in every
scene.**

### 2.3 The storm wall

| scene | tier | before | after |
|---|---|--:|--:|
| worst-case | high | 0.281 (28.1%) | **0.137** (13.7%) |
| dock-vista | high | 0.265 (26.5%) | 0.244 (24.4%) |
| storm-sea | high | 0.189 (14.3%) | 0.258 (20.1%) |
| dock-vista | low | 0.224 (22.4%) | 0.224 (22.4%) |

**Reported as measured, including the row that went up.** The wall's screen
coverage depends on how much of a 900 m ring the fixed camera happens to frame,
and the model's §10.10 already records this source reading 1.15 and 1.93 in two
captures of the same scene. What the change does is exact and does not depend on
framing: no fragment above 1.77×topY is shaded, which is the top 10% of the wall
at ring range and the top 37% of it close in. What it cannot do is make a
fixed-camera coverage figure repeatable, and it does not.

### 2.4 Passes, counts, and resident bytes (`high`, dock-vista)

| | before | after |
|---|--:|--:|
| draw calls | 1510 | 1501 |
| triangles | 1,745k | 1,745k |
| linked programs | 101 | 101 |
| shadow-pass draws / triangles | 226 / 385k | 216 / 385k |
| **post-chain draws** | 15 | **14** |
| **shadow-map texels per frame** | **16,777,216** | **4,194,304** |
| `sun.shadow.map` | 4096², 117.4 MB | **2048², 29.4 MB** |
| `composer.renderTarget1/2` | 960×540 ×4 samples, 22.8 MB each | **×2 samples, 11.4 MB each** |
| **all render targets** | **168.3 MB** | **57.4 MB** |

Geometry, triangles and program counts are unchanged by design — this pass moved
no vertex and linked no new shader.

### 2.5 The shot sheet

Thirty frames, two tiers, six stands, noon / dusk / night / storm, read as
before-and-after pairs. Nothing in them is distinguishable except the things
that move on their own between sessions (bot ships, wildlife, lantern sprites,
cloud drift). Specifically checked, because these are what the changes could
break:

- **dusk at a vista** — the sun band, the zenith gradient, the horizon rim and
  the vignette are unchanged, which is the grade arriving in the right place
  after being folded into `OutputPass`.
- **night** — the star field, its density and the sky's night gradient are
  unchanged, i.e. the far-plane dome is still being shaded everywhere nothing
  covers it.
- **storm at sea, both tiers** — the cloud bank's ragged silhouette sits at the
  same height with the same profile; no seam, no flat top, no cut.
- **`island-props` at noon and at dusk, added for this** — the palm's cast
  shadow, the grass tufts' shadows and their edges are the same at 2048 as at
  4096, at both a high sun and a raking one.

---

## 3. Measured, and deliberately left alone

| suspect | reading | why it stays |
|---|---|---|
| the bloom base resolution (480×270) | 345k fragments of blur + 130k of luminosity | it is the only pass in the chain whose loss is *visible*, and the two that were free (grade, MSAA step) came to more |
| `envFx.rainHaze` | **0.466–0.474** layers in a storm, the second largest blended source left | a `MeshBasicMaterial` with one texture fetch — the cheapest fragment in the frame — and its coverage IS the effect. Trimming it trades a visible weather read for the cheapest layers in the game |
| the terrain octave ladder | already 1 / 2 / 3 by tier | phase 3's work; nothing to add |
| the cave-mouth `discard` | already `null` on every island without a mouth | the discard only exists on materials that need it; the per-island gate the brief asked for is already there |
| the ocean shader | untiered, and the heaviest shader in the game over the largest area | see §5 — cutting it without measuring it is exactly what the brief forbids |
| waterfall sheets, plunge mist, foam and wake sprites, lantern glow, storm ring and halo, sun disc, contact shadows | 0.000–0.008 layers (phase 1) | still innocent |

---

## 4. The defect this pass made, and what caught it

The shadow-pass gate shipped broken and the counts did not say so.

`FullScreenQuad.render()` is `renderer.render(quadScene, quadCamera)`, and the
post chain does fourteen of those a frame. Every one arrives at three's
`WebGLShadowMap.render` with an empty shadow-light array: it "runs" a shadow
pass, draws nothing, and the first version of the gate read that as *the world
has no casters*. Measured on a dock vista with 226 casters in the box:
`lastCasterDraws` pinned at zero forever, 12 of every 15 passes skipped.

**The frame totals moved by roughly the right amount for entirely the wrong
reason** — 1510 → 1352 draws, which reads like a win. The only tell was the
cost model's pass split reporting `shadow 0d / post 225d` at a scene that
measures 226 shadow draws and 15 post draws: the shadow pass had been silently
re-attributed to the post chain, because the probe's direct render skipped and
its composer render did not.

`scripts/test-shadow-gate.mjs` is the gate that was missing. It asserts the two
halves separately against the live client — a stand WITH casters runs a real
pass every frame and skips none; open water reports an empty box — and
deliberately asserts no skip *count*, because the skip window is bounded in time
as well as in frames and under software ANGLE a single frame is longer than the
window. A threshold invented to make that assertable here would be a threshold
about SwiftShader.

---

## 5. What the next pass should measure first

1. **The ship's own hull is the opaque overdraw.** The model's §10.4 named this
   the largest un-attributed number it had. `--opaque deck-aft` now answers it:
   standing on your own deck, `ship` alone is **1.662 layers over 46.0% of the
   framebuffer, p95 5, max 10** — about two thirds of the whole frame's depth
   complexity and roughly 87% of its opaque half. Everything else on that deck
   is rounding: `island-decor` 0.238, the four islands in frame 0.074 between
   them, barrels 0.002. The fix is not a fill fix, it is a sorting and
   interior-culling fix: hull, deck, interior and rigging are all being shaded
   and then covered by each other.
2. **The ocean fragment shader, measured rather than guessed.** It re-evaluates
   the full Gerstner sum per pixel for analytic normals, runs `shoreDist` over
   every island, and takes nine value-noise fetches (36 hashes) for the ripple
   normal wherever `detailFade > 0.001`. It is the heaviest shader in the game
   over the largest area and it has no tier path at all. The instrument it needs
   is a per-source shader-cost reading, which this repo does not have: the
   stencil census counts LAYERS, not operations, and a layer of ocean and a
   layer of unlit sprite are the same number to it.
3. **Whether the sky is worth shading at all where the ocean will cover it.**
   The dome now costs 40–48% of the framebuffer, and most of what is left is
   above the horizon where it belongs. The remaining question is the reverse one:
   the ocean covers half the screen with a shader that is *heavier* than the sky,
   and its far band dissolves to exactly the sky's own horizon colour by 2900 m.
