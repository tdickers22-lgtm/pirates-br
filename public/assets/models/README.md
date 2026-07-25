# pirates-br GLB assets

Original stylized assets authored in Blender via `scripts/blender/*.py`
(reproducible: headless `Blender -b -P scripts/blender/<script>.py` re-exports here).
Scale: 1 unit = 1 game unit (~1 m). Up = +Y, ship/game forward = +Z (author fronts
toward Blender −Y). All origins at ground/waterline center unless noted.

2026-07 fidelity pass: every asset rebuilt high-poly with baked vertex AO
(`COLOR_0`, all-or-nothing per GLB — `AssetLibrary.mergedGeometry` requires uniform
attributes), beveled edges, geometry-as-wear. Story scenes are single-GLB hero
vignettes, one per roster island (`docs/ISLAND_STORY_BIBLE.md`).

2026-07 fidelity pass **round 2** (audit: "hero story assets read as untextured
primitives at close range"). Baked AO alone left every asset one flat tone, so a
second vertex-colour stage was added on top of it:

* `scripts/blender/_detail.py` — `agx_palette()` (the tonemap lifts mids hard, so
  base colours are DARKENED + SATURATED beyond what looks right in-viewport),
  `tint_pass()` (per-material / per-object / per-vertex tint multiplied into the
  baked AO: tonal jitter between blocks, low-frequency mottle, wood grain and
  strata streaks, moss / rust / verdigris / damp patches, ground-damp bands),
  `carve_facets` + `chisel` (turns smooth icospheres into carved stone), and shared
  builders (tapered segments, catenary rope, rope lashing, iron strap + bolts,
  weathered plank, hand-dressed masonry block, feather).
  Call order is load-bearing: **`bake_ao` → `tint_pass` → `join` → export**
  (`tint_pass` needs one material per object, so it must run before the join).
  `ship_asset()` does the whole chain plus verify + turntable.
* `scripts/blender/_story_props.py` — `rowboat()` and `signal_pyre()` builders,
  shared by the standalone GLBs and by the hero scenes that embed them, so the
  prop and the scene dressing can never drift apart.

Rebuilt assets kept their footprint and bounding box inside 10% of the previous
GLB (worst delta 8.9%, and that is HEIGHT on `mermaid_shrine`; every footprint
moved less than 2.6%) so placement stamps and colliders stay valid.

## Environment & props

| File | Contents | Notes |
|---|---|---|
| palm_a/b/c.glb | Palms 8.5/6.5/5u, curved trunks, modeled leaflet fronds | ~3.2–3.7k tris |
| palm_tall.glb | Thin 13.5u palm | |
| palm_ground.glb | Ground fan palm | |
| boulder_a/b/c.glb | Dome / tilted slab+shard / split stack w/ dark crack | distinct silhouettes |
| searock_a/b/c.glb | Strata-banded sea stacks, undercut waists, wet skirts | origin at waterline |
| barrel.glb keg.glb | Splayed staves, riveted bands | |
| chest_closed/open.glb | Iron straps, rivets; open = coin heap | |
| crate.glb | Chipped planks, corner braces | |
| campfire.glb | Stone ring, charred split logs, `Ember` glow | FX flame in-engine |
| dock_mid/end.glb | Tiling modules 6×3 / 4×3 (exact), warped planks, cleats, `Wood_Wet` band | deck z≈1.1 |
| watchtower.glb | Stone courses, timber frame, ladder, brazier | |
| shipwreck.glb | Broken hull, exposed ribs/strakes, stub mast, torn sail | ~11×5, waterline origin |
| standing_stones.glb | Rune-grooved leaning monoliths, gold inlay | walk-through ring |
| lantern_post.glb | Wrought bracket, glass panes | emissive |
| tavern.glb | Shingle rows, timber frame, round chimney | footprint exactly 7.6×6.4 |
| stall.glb | Sagging canopy market stand | |
| fort.glb | Stone stronghold + carved skull + banner (`TeamTint`) | |
| tent_a.glb bedroll.glb | Saggy patched canvas, guy ropes | A-frame |
| tent_b.glb | Lean-to half-shelter: one canted slope on a forked-stake ridge, driftwood windbreak, torn hem, bedroll | 2.43×2.02×4.79, 3.0k tris — **not yet wired** |
| tent_c.glb | Bell/sail tent: salvaged topsail round a centre pole, rolled-back door flap, smoke vent, peg ring, keg | 2.98×2.49×2.89, 2.5k tris — **not yet wired** |
| rowboat.glb | Weathered clinker tender: lapstrake planking, sawn frames, thwarts, sprung plank, shipped + snapped oars, painter coil, tribute offerings in the bilge | 1.12×0.98×2.65, 3.4k tris — **not yet wired** |
| signal_pyre.glb | Unlit beacon: crib-stacked logs, brush bundles, open tar barrel w/ iron hoops + tar runs, pitch bucket, discarded lid | 2.44×2.13×1.60, 2.5k tris — **not yet wired** |
| rock_arch.glb | Natural rock arch | walk-through |
| bush / bush_berry / flower_bush / fern_plant / flower_patch / wildflowers .glb | Instanced flora (≤3k tris each) | swaying set |

## Story scenes (one per island) + story scatter

| File | Island | Scene |
|---|---|---|
| smuggler_cache.glb | Smuggler's Rest | interrupted contraband handoff, dragged rowboat |
| skull_totem.glb | Skull Cove | carved skull monolith, ritual gone wrong. R2: chisel-faceted (was raw icosphere), tally grooves + fissures + weather shelves carved into the BACK, rusted votive spikes w/ bone charms |
| wrecker_tower.glb | The Crooked Atoll | crooked false-light tower, dead lantern (`Glass_Dead`) |
| whale_skeleton.glb | Dead Man Shoals | 22m walk-through rib cathedral |
| gibbet_cage.glb | Dead Man Shoals + Gallows Sands | rusted occupied cage on a post |
| rum_still.glb | Rumrunner Key | burst `Copper` still, scorch ring, barrel pyramid |
| crow_roost.glb | Crow's Perch | tripod lookout, dead watcher w/ spyglass, crows. R2: **signal pyre added** (backlog item) at (−1.05,−1.45) seaward of the ladder leg; scene now runs `tint_pass` |
| mermaid_shrine.glb | Mermaid's Folly | figurehead idol on `Coral`/`Shell_Pearl` throne, candles. R2: idol re-massed (was a bowling pin) w/ S-curve tail, proud verdigris scale bands, hip fins; **tribute rowboat added** (backlog item) across the seaward approach |
| castaway_camp.glb | Castaway Reach | marooned skeleton, tally board, unfinished raft |
| kraken_wreck.glb | Kraken Tooth | tentacle-crushed bow, sucker rows, harpoons |
| dig_site.glb | Booty Bay | double-crossed dig, empty chest, coin trail |
| gallows.glb | Gallows Sands | triple gallows, cut ropes, 3 graves / 4 hats. R2: real joinery (through-tenons + drawbore pegs, forged straps + bolt heads, adze-hewn posts, ground-rot collars), wind-rippled dune w/ deflation hollow + shell/shale scatter, turned-earth clods round the graves |
| parley_table.glb | Parley Point | truce table, crossed pistols, rival flags |
| mine_head.glb | Old Maw Caldera | charred mine portal, `Obsidian` ore cart. R2: **cart seated on the rails** (backlog item) — zero yaw/offset, tread bitten 15 mm into the railhead, inner flanges added; sleepers under the cart run true |
| widow_memorial.glb | Widow's Watch | cottage ruin + stone widow, lit lantern (night beacon). R2: hand-dressed masonry over a dark mortar core (was "white lego bricks"), moss/damp tinting, wrought lantern post, wind-worn planks + fallen slates; widow carved from her own `Stone_Statue` so she separates from the wall behind her |
| bone_pile.glb | scatter (bone biomes) | ribcage + skull heap |
| driftwood_log.glb | scatter (beaches) | twisted bleached snag |
| grave_marker.glb | scatter (bone/highland) | leaning cross + headstone |

The Black Fin pennant (shark-fin flag, `Flag_Fin` + `Bone`) recurs at the dig site,
the wrecker tower, the parley table and a gibbet — one doomed crew's trail across
the Reach.

## Material name contract (client tints/finds by name — never rename)

Core: `TeamTint`, `Wood_Dark/Mid/Light/Bleached/Wet`, `Rock_Grey/Dark/Sea/Stack/Wet/Pale`,
`Leaf_Green/Green_Lt/Dry`, `Leaf_A/B/C`, `Stem`, `Berry_Red`, `Flower_Pink/Yellow/White`,
`Trunk_Palm`, `Sand`, `Metal_Iron/Band`, `Gold`, `Rope`, `Canvas`, `Canvas_Dirty`,
`Keg_Red`, `Paint_White`, `Coconut`, `Char_Black`, `Lantern_Glass` (emissive),
`Plaster`, `Timber`, `Shingle`, `GlassWarm` (emissive), `Stone_Fort`, `Stone_Dark`,
`Bone`, `Bone_Shadow`, `Awning_Cream/Red`.
Fidelity-pass additions: `Ember` (emissive), `Wood_Wet`, `Rust`, `Flag_Fin`,
`Flag_White`, `Flag_Rival`, `Coral`, `Shell_Pearl`, `Candle_Wax` (emissive),
`Glass_Dead` (deliberately non-emissive), `Bottle_Green`, `Copper`, `Dirt`,
`Kraken_Flesh`, `Kraken_Sucker`, `Obsidian`, `Crow_Black`, `Sand_Pad`, `Grave_Dirt`
(scene base pads — warmer than `Sand`, rims authored sunk + feathered).
Round-2 additions: `Stone_Statue` (widow — darker/warmer than `Stone_Fort` so the
figure reads against the ruin), `Verdigris`, `Coral_Pink`, `Tar_Black`, `Slate`,
`Feather_Black`, `Rock_Grey` on the gallows pad, `Metal_Band` on gallows joinery.
