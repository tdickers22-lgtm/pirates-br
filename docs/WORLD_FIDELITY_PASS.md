# World fidelity pass — 2026-09-05

Built on `feat/volcanic-geysers-cliffs-flora`, starting at `26e17d6b`.
The recent w2.4 pirate-height/pose work, w2.2 shared hull/deck frame, crew/lobby
changes, and w1.4 sky-lit ocean remain in place. This pass does not replace them.

## Landscape and traversal

- Mountain summits separate into ridges and saddles; elongated buttresses and
  gullies vary the slopes on mountain, twin, rocky and plateau islands.
- Crescent bays actually open toward their bay bearing. Archipelago/crescent
  coasts gain low sand cays with submerged channels and shelving approaches.
- The fixed archipelago has seven suspended bridges: Crooked Atoll, Dead Man
  Shoals, Crow's Perch, Kraken Tooth, two on Old Maw, and Widow's Watch.
  Mountain crossings range from 29 to 94 metres.
- Plank tops, sag and 1.9m deck width use the same function as client/server
  footing. Posts sit on both rails; ropes are round tubes, with lashing detail.
  A deep channel cannot turn a pirate standing on a bridge into a swimmer.
- Existing caves retain their reference topography and RNG sequence. Exterior
  relief fades around their corridors, preserving the tested entrances, floors,
  roofs and escape-repro coordinates. Structure stamps remain authoritative.
- Landing stores search neighbouring beach rays within 40m of the pier. Tent
  and driftwood placement checks their full footprint against sloping ground.

## Nature assets

Fifteen GLBs were rebuilt in Blender, with two visual-review rounds. Detail is
real geometry: folded individual leaves and fern pinnae, cupped petals, raised
palm leaflet midribs, denser scarred trunks, faceted boulders and fluted sea stacks.
All old material names remain; exports have uniform `COLOR_0`, baked vertex AO,
and per-material colour variation. Root transforms are baked before fitting the
existing envelopes; boulder bases are seated at ground level.

| Asset | Before triangles | After triangles |
| --- | ---: | ---: |
| bush | 628 | 2,252 |
| bush_berry | 868 | 2,300 |
| flower_bush | 858 | 2,260 |
| fern_plant | 566 | 2,724 |
| flower_patch | 2,407 | 2,916 |
| wildflowers | 478 | 1,496 |
| palm_a / b / c | 3,630 / 3,224 / 3,660 | 5,614 / 5,000 / 5,684 |
| boulder_a / b / c | 3,392 / 2,496 / 2,316 | 4,672 / 4,134 / 3,774 |
| searock_a / b / c | 4,532 / 4,532 / 5,008 | 5,428 / 5,428 / 5,968 |

The higher scatter budgets are intentional for this request: below 3k per plant
and 6k per palm/rock, while retaining one collapsed instanced material per asset
and the existing distance LOD. Organic assets preserve authored smooth normals.
Ground-cover cards became 25-triangle five-blade tufts and 310-triangle fern
rosettes. Biome-specific, seed-stable patches leave clearings between thickets.
Wind is projected into each instance's local axes and bends short plants from
their roots; it preserves the existing material/tint shader patches.

Rebuild with Blender headless, **one process at a time**:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_plants.py
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_rocks.py
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b -P scripts/blender/build_palms.py
```

`BR_EXPORT_DIR` redirects draft GLBs. CPU review render directories are selected
with `PLANTS_RENDER_DIR`, `ROCKS_RENDER_DIR`, or `RENDER_DIR` (palms), respectively.
The common nature finishing code is `scripts/blender/_nature.py`. The existing
`_helpers.py`, `_ao.py` and `_detail.py` were not changed.

## Water

- Shared zero-mean wave harmonics produce sharper crests and broader troughs.
  CPU and emitted GLSL agree on displacement and analytic slopes.
- Hull heave damping is relative to moving water, including horizontal travel
  through the wave field. Three hull classes remain stable in calm/storm tests.
- A time-sliced 1024-square, 4MB bathymetry texture samples the shared terrain.
  Shallows and foam follow actual bays/cays instead of ellipse approximations.
  There is no extra scene render pass; the ellipse is only the loading fallback.
- Analytic ripple slopes and screen-footprint filtering reduce distant shimmer;
  close foam gains finer breakup. Existing sun, moon, fog and postprocessing stay.

## Verification

Final results: typecheck, production build, suite-manifest audit, all new ocean
and foliage contracts, cave traversal, shore swimming, seeded determinism, and
the five-view live browser check pass. Quick tier: **63/66**, with only the
three baseline failures described below. The five final screenshots were
visually inspected; the sampled-area water rectangles found in the first
capture are fixed and covered by a bathymetry-boundary regression assertion.

```sh
npm run typecheck
npm run build
npm run test:quick
npm run test:audit
node scripts/run-all-tests.mjs --only test-cave-walk,test-swim-shore,test-match-determinism
PIRATES_GL=swiftshader node scripts/run-all-tests.mjs --only test-world-fidelity
```

The runner owns isolated ports 3101/8091 and pins the map seed. Never run the
browser checks concurrently with Blender, Ollama or a training job on this Air.
Software-renderer timing is not evidence of Metal frame rate.

Baseline verification in a detached worktree at `26e17d6b` reproduces three
pre-existing quick-suite failures: the foundering-anchor assertion in
`test-flooding`, unconsumed `match_detached`/`party_available` events in
`test-wire-consumers`, and the leave-event assertion in `test-win-condition`.
Those unrelated behaviours have not been changed or hidden by this pass.

Review artefacts are under `test-results/nature-fidelity/round1`, `round2`, and
`live`; build logs are `test-results/nature-*-final.log`.

Final views: [bay and cays](../test-results/nature-fidelity/live/bay-and-cays.png),
[peak bridge](../test-results/nature-fidelity/live/peak-bridge.png),
[understory](../test-results/nature-fidelity/live/understory.png),
[calm water](../test-results/nature-fidelity/live/calm-water.png), and
[storm water](../test-results/nature-fidelity/live/storm-water.png).
