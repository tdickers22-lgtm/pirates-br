# Z-fighting: what it is here, how it is measured, and what it took to reach zero

## The instrument

`scripts/lib/zfight-probe.mjs`. **A tie in the depth test IS the artifact**, so
the probe measures the tie rather than sampling the shimmer.

Every material in this game runs three's default `LessEqualDepth`, under which
the LAST of a tied pair wins. Render the same world state twice, changing nothing
but that operator to `LessDepth` (the FIRST of a tied pair wins):

* a pixel with no tie is **byte-identical** — `<` and `<=` agree about a strict
  winner;
* a pixel with a tie **changes**, because the operators pick differently.

The changed-pixel count is the exact count of pixels an infinitesimal camera move
can flip. No motion, no animation, no threshold, no judgement.

**Why not a frame diff of a slow dolly.** The ocean, the foliage, the clouds and
the day clock all move, so a frame diff of a moving camera reports the whole
screen. It is also a *sampling* probe: it sees a fight only on the frames where
the fight happened to flip.

### Three things the probe must state out loud

**Self-noise.** Every census first renders twice with nothing changed. That count
must be 0. It is reported beside every measurement and it is the gate's first
assertion. Getting it to 0 was most of the work — see "a render advances
animation" below.

**The sky dome is held out of the flip.** It is the one surface placed at exactly
the far plane (`SKY_VERT` writes `gl_Position.z = w`) and it depends on `<=` to
survive the cleared depth of 1.0. Flipping it to `<` blacks the whole sky and
reports a quarter-million ties that are not ties.

**At `balanced` and `high` the census bypasses the post chain.** Those tiers run
the scene through EffectComposer — MSAA resolve, UnrealBloom, a graded
OutputPass, FXAA — and every one of those spreads a changed pixel into its
neighbours, so a count taken on the PRESENTED frame is a count of a blur kernel
and not of a depth test. The tie happens in the scene render and that render is
reachable: dropping `Renderer.postFx` for the census sends `R.render()` down its
own `renderer.render(scene, camera)` branch, with the same materials, the same
LOD, the same shadow pass and the same resolution.

This is not the weaker claim it looks like. The post chain cannot CREATE a tie,
and it is a deterministic function of its input, so a scene render with zero
changed pixels composes to a presented frame with zero changed pixels — which is
why no per-tier threshold was needed and none was invented. `--presented`
measures the composed frame anyway and reports it beside the scene count, so the
smear is on the record as a number rather than as an argument.

## Not every tie is the artifact

Where two surfaces genuinely **cross** — the ocean meeting a beach or a rock
skirt, a waterfall sheet entering its plunge pool, two foliage cards passing
through each other — their depths are exactly equal along the intersection curve,
by geometry and not by precision. Piercing the tie pixels at the island overlook
finds nothing else: `sea-rock@340.37 m` against `ocean-lod-grid@340.51 m`,
`island-terrain@87.77 m` against `ocean-lod-grid@88.96 m`. No depth bias removes
those and none should.

The shimmering kind differs in **shape**. Two coplanar surfaces tie over an AREA
and the winner reshuffles across it as the eye moves. An intersection ties along
a LINE one or two pixels wide, and no camera movement widens it.

So the gate's assertion is on `patchPixels`: tie pixels whose **whole 3×3
neighbourhood** is tied. A curve of any shape cannot produce one; a coplanar
patch produces them by the hundred. Four-connectivity was tried first and was too
weak — two crossing intersection curves, and a sharp kink in one, each produce a
pixel with a tied neighbour on all four sides, and the gate would have failed on
the shape of a coastline.

## What the near plane was worth

`near` went **0.05 → 0.1** (far:near 60,000:1 → 30,000:1). Depth resolution at a
distance *z* goes as *z²/(near · 2²⁴)*, so at 0.05 a coplanar pair 300 m away was
resolved at one level per **10.7 cm**.

Measured, low tier, 960×540, seed 20260801:

| stand | ties at near 0.05 | at 0.1 | at 0.3 |
|---|---|---|---|
| dock-vista | 121, 137 | 60–80 | 34, 35 |
| shore-waterline | 93, 94 | 39–47 | 33, 21 |

**What held it at 0.05 was never the world.** Across seventeen close-quarters
stands — a ring through the prop scatter, four crouched, three under a cave roof,
the waterline, a deck — the closest drawn surface is 0.3029 m. It was:

1. **The first-person viewmodel.** `depthTest: false` exempts a material from the
   depth TEST, not from near-plane CLIPPING. Aiming the blunderbuss puts geometry
   0.181 m from the eye, the cutlass mid-swing 0.121 m, the lantern 0.205 m.
   `applyViewmodelMaterialSettings` now pins the viewmodel's clip-space z to 0 —
   these fragments never read or write depth, so their z is not information, only
   a clip test they have to pass. `customProgramCacheKey` is not optional there.
2. **The local player's own third-person rig**, which is what stopped 0.2. In the
   cutlass block pose its forearm crosses the eye at 0.1226 m. It is world
   geometry, so the viewmodel exemption does not cover it, and 0.2 cut 32,877
   pixels out of it.

`logarithmicDepthBuffer` was considered and rejected without measuring: three's
implementation writes `gl_FragDepth` in the fragment shader, which disables early
depth rejection everywhere — the opposite of what the fill pass just bought.

## Naming the two surfaces in a fight

`scripts/zfight-blame.mjs`. The census says how many pixels stand on a tie; it
never said whose, and the two obvious ways of asking both lie here:

* three's raycaster **does not test `visible`**, so a pierce at `deck-aft`
  cheerfully reported the ship's LOD proxy as one of the fighters when
  `mesh.proxyRoot.visible` was false and the proxy drew nothing;
* `Line.threshold` is a metre wide, so alongside the hull every pierce came back
  as rigging.

So blame by **ablation**. A tie needs both of its surfaces: hide the meshes of one
material, re-run the flip, and if the coplanar patch goes to zero that material is
one of the two. `--by-owner` does the same to whole named subtrees first, which is
what makes it affordable — 517 materials are drawn at `deck-aft` and one ablation
is two software renders.

Two things had to be pinned before an ablation could be compared with anything:

* **Every render of a sweep happens inside ONE synchronous task.** `deck-aft` is
  anchored to a hull that sails; the sweep's own baseline fell from 615 patch
  pixels to 0 in four chunks while everything measured after that was being scored
  against a frame with no deck in it.
* **The hull's ATTITUDE is pinned, not just its position.** Pitch, roll and heave
  are rewritten from the Gerstner field every frame and the tie moves with them:
  51, 0 and 135 patch pixels on three consecutive chunks of an already-parked hull.

And a pose scan comes before the sweep, because a coplanar pair is one depth level
apart at one eye position and TIED a few centimetres later — a sweep started at the
first is a sweep of a clean frame that can blame nobody.

## The two fights that were left, and what they actually were

### `deck-aft` — the quarterdeck step against the stern castle

Ablation: hiding **`ship-deck-planking`** took the patch from 1,077 to 0; hiding
**`ship-dark-timber`** did the same. A ray through the patch put both of them at
hull-local **z = −3.12** with a **+z face normal**, over x ∈ [−1.0, 1.0] and
y ∈ [2.33, 2.61].

That is the upper quarterdeck step's forward face against the stern castle's
forward face, and they coincide by arithmetic:

```
step front   = −L·0.235 − stepDepth/2 = −L·0.235 − 0.3
castle front = −L·0.37  + L·0.11      = −L·0.26
```

equal exactly when `L·0.025 = 0.3`, i.e. **L = 12 — the sloop**, the hull every
player starts in. The brigantine misses by 10 cm and the galleon by 25, which is
why this only ever showed on the starting boat.

Fixed by giving the two step boxes their own material, `ship-deck-riser`, with
`polygonOffset −2 / −2`.

### `hull-alongside` — the cap rail against the railing it caps

Ablation zeroed the patch by hiding **`ship-dark-timber`** and by hiding nothing
else: the fight is that material against ITSELF. The pierce put every sample at
hull-local **x = 2.5** with a **+x normal**, spanning z −4.0 to 4.6 at y 2.608 —
and 2.5 is exactly `W/2` on the sloop:

```
railing  x = W·0.5 − 0.07, box 0.14 wide  →  outboard face at W·0.5
cap rail x = W·0.48,       box 0.20 wide  →  outboard face at W·0.5
```

a 0.1 m × 9.6 m ribbon of shared plane down each side of every hull, at the height
a boarder's eye sits. One material meant one merged draw and therefore nothing to
bias against anything, so the cap rail became its own material, `ship-dark-trim`,
with `polygonOffset −2 / −2`. The bow cap segments and the stern cap rail moved
with it — a cap run that is offset for part of its length is a cap run with a seam.

### Why an offset and not a nudge

Neither fix moves a box. Moving two coplanar surfaces apart by an epsilon
RELOCATES the tie to whatever distance quantises the new gap to zero rather than
removing it; a polygon offset is a bias in depth and holds at every distance.

The bill is **two extra merged draws per detail hull**: `mergeStaticMeshes`
batches by material and these are two more of them. They exist only on the detail
hull, never on the proxy.

## State of the world, seed 20260801

`self-noise 0` at every stand, pose and time of day, at every tier.

Worst tie count over three poses; `patch` is the gate's assertion and is 0
everywhere.

The full-resolution `low` sweep is 960×540:

| stand | low noon | low night |
|---|---:|---:|
| dock-vista | 81 | 72 |
| island-interior | 100 | 94 |
| cave-interior | 40 | 43 |
| deck-aft | 65 | 62 |
| open-sea | 18 | 16 |
| shore-waterline | 53 | 47 |
| island-far | 72 | 57 |
| island-overlook | 220 | 220 |
| hull-alongside | 45 | 38 |

Everything remaining is intersection line — the ocean against a beach, a rock
skirt or a hull, foliage cards crossing — which is geometry meeting geometry and
not precision failing.

### `balanced` and `high`: measured at a reduced framebuffer

The first full-resolution attempts exposed the practical limit of this machine.
`balanced` reveals detail LOD to 285 m against `low`'s 170 m (`high` reaches
380 m), so one census carries several times the geometry and performs four
software renders. A single `deck-aft` condition failed to complete after 35
minutes with the post chain attached and after 15 minutes with it detached.

The close-out therefore added an explicit `--ratio` control and ran the complete
9 × 2 × 3 matrix for both heavier tiers at ratio 0.25: **240×135**, or one
sixteenth of the full pixel count. This is sufficient for the binary gate being
claimed here: a 3×3 coplanar patch still has interior pixels, while line
intersections do not. It is not sufficient for comparing the raw tie counts with
the 960×540 `low` table, so the tables stay separate.

| stand | balanced noon | balanced night | high noon | high night |
|---|---:|---:|---:|---:|
| dock-vista | 10 | 7 | 8 | 12 |
| island-interior | 10 | 11 | 9 | 8 |
| cave-interior | 6 | 7 | 10 | 8 |
| deck-aft | 13 | 14 | 9 | 7 |
| open-sea | 5 | 2 | 3 | 3 |
| shore-waterline | 5 | 6 | 11 | 8 |
| island-far | 20 | 21 | 23 | 28 |
| island-overlook | 36 | 33 | 31 | 35 |
| hull-alongside | 6 | 7 | 8 | 6 |

Every one of the 108 heavy-tier readings had `selfNoise = 0` and
`patchPixels = 0`. The raw ties in the table are all one-pixel-wide intersection
lines. The measurements are recorded in
`test-results/closeout/zfight-balanced/report.json` and
`test-results/closeout/zfight-high/report.json`; each report records its tier,
ratio and actual framebuffer dimensions.

That closes the tier gap honestly: `low` is proven at the normal 960×540 gate
resolution, and `balanced`/`high` are proven across the same stands, times and
poses at 240×135. The result is **zero coplanar z-fighting patches at all three
tiers**, not a claim that every geometrically valid depth tie has disappeared.

### Before

| stand | worst ties | patch | |
|---|---|---|---|
| deck-aft, noon | 888 | **579** | quarterdeck step vs stern castle |
| deck-aft, night | 787 | **231** | same |
| hull-alongside, noon | 477 | **31** | cap rail vs railing |

## The gate still fails when a fight comes back

Proved by mutation, not by assertion. With `polygonOffset` turned back off on both
new materials and nothing else changed:

| stand | patch, fixed | patch, mutated |
|---|---|---|
| deck-aft @ noon | 0 | **254** |
| deck-aft @ night | 0 | **82** |
| hull-alongside @ noon | 0 | **60** |

`scripts/test-z-fighting.mjs` is in the browser suite (`scripts/lib/suites.mjs`,
marked `slow`).

## Traps this campaign hit, all found by a control

* **A render in this game ADVANCES ANIMATION.** `MiscMeshFactory`'s station halo
  runs `onBeforeRender = () => animate(performance.now() / 1000)`; `CombatFx`
  re-orients points and impostors in theirs. Those fire once per
  `renderer.render()`, not once per game frame, so any probe that renders more
  than once photographs more than one world. Both probes stub `performance.now`
  for the duration of a census.
* **three packs depth with the COARSE byte in ALPHA** and the finest bits in red.
  Unpacked the obvious way, an unwritten white pixel came out at depth 1.0039,
  the perspective divide went through zero, and every stand reported a distance
  of **minus 78 metres**.
* **`scene.overrideMaterial` replaces the property under test.** The near-plane
  probe's depth override wiped out the viewmodel's clip exemption and then
  reported 41,024 pixels clipped off the cutlass that the real render keeps. The
  depth swap is per-mesh now, and an exempt mesh gets an exempt depth material.
* **Sprites, points and lines handed a mesh depth material produce UNSTABLE
  output** — a mesh program over attributes it never declared. That was the whole
  of an 81,131-pixel self-noise reading, and only at the stands full of motes and
  wisps. They are hidden for the depth pass instead.
* **Editing a client source file kills a live probe run.** Vite's HMR navigates
  the page and Playwright reports `Execution context was destroyed`. A blame
  sweep lost twenty minutes to a commit made while it was running.

## Next

* **`balanced` and `high` are unmeasured** — see the section above for the two
  attempts, the numbers that stopped them, and the smaller framebuffer that would
  make them affordable.
* `deck-aft` follows the local player's ship, whose pose differs between matches,
  so its absolute tie count is not comparable run to run the way the island stands
  are. Its *patch* count is the readable signal. Parking the hull, which
  `zfight-blame.mjs` does, would make the gate's numbers comparable too.
* The blame sweep only ever ran on the sloop. The brigantine and galleon miss both
  coincidences by 10–25 cm, but no other hull class has been swept.
