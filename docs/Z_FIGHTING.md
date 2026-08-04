# Z-fighting: what it is here, how it is measured, and what is left

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

### Two things the probe must state out loud

**Self-noise.** Every census first renders twice with nothing changed. That count
must be 0. It is reported beside every measurement and it is the gate's first
assertion. Getting it to 0 was most of the work — see "a render advances
animation" below.

**The sky dome is held out of the flip.** It is the one surface placed at exactly
the far plane (`SKY_VERT` writes `gl_Position.z = w`) and it depends on `<=` to
survive the cleared depth of 1.0. Flipping it to `<` blacks the whole sky and
reports a quarter-million ties that are not ties.

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

## State of the world, low tier, seed 20260801

`self-noise 0` at every stand, pose and time of day.

| stand | worst ties | patch | verdict |
|---|---|---|---|
| dock-vista | 69 | 0 | clean — intersection line only |
| island-interior | 92 | 0 | clean |
| cave-interior | 40 | 0 | clean |
| open-sea | 13 | 0 | clean |
| shore-waterline | 46 | 0 | clean |
| island-far | 71 | 0 | clean |
| island-overlook | 212 | 0 | clean (ocean against rock skirts, all curve) |
| **deck-aft** | 496–2003 | **87–130** | **FAILS** |
| **hull-alongside** | 340 | **>0 at pose 0** | **FAILS** |

### What is left, and where

**`deck-aft`, worst at night.** Clusters of 88–310 px along the bottom of the
frame (y ≈ 465–486, the deck under the eye), flipping between a dim plank brown
`rgb(38,23,14)` and near-black `rgb(2,0,0)`, delta 30–40 — loud enough to see. A
dark decal lying exactly on the deck planking and losing the depth test to it
half the time. `ShipRenderer` gives `polygonOffset` to the hole/rim/splinter
decals and to the hole marker; whatever this is does not have it.

**`hull-alongside`, at noon.** A horizontal band at y ≈ 262–267 — the waterline —
in clusters of 35–69 px, but with a delta of only 3–7 levels. Low contrast; the
collar against the hull rather than against the ocean.

Neither is fixed. Both are named, located, and gated: `scripts/test-z-fighting.mjs`
is red on exactly these two stands and green on the other seven.

Note also that `deck-aft` follows the local player's ship, whose position and
heading differ between matches, so its absolute tie count is not comparable run
to run the way the island stands are. Its *patch* count is the readable signal.
