# pirates-br GLB assets

Original stylized assets authored in Blender via `scripts/blender/*.py`
(reproducible: headless `Blender -b -P scripts/blender/<script>.py` re-exports here).
Scale: 1 unit = 1 game unit (~1 m). Up = +Y, ship/game forward = +Z (author fronts
toward Blender −Y). All origins at ground/waterline center unless noted.

2026-07 fidelity pass: every asset rebuilt high-poly with baked vertex AO
(`COLOR_0`, all-or-nothing per GLB — `AssetLibrary.mergedGeometry` requires uniform
attributes), beveled edges, geometry-as-wear. Story scenes are single-GLB hero
vignettes, one per roster island (`docs/ISLAND_STORY_BIBLE.md`).

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
| tent_a.glb bedroll.glb | Saggy patched canvas, guy ropes | |
| rock_arch.glb | Natural rock arch | walk-through |
| bush / bush_berry / flower_bush / fern_plant / flower_patch / wildflowers .glb | Instanced flora (≤3k tris each) | swaying set |

## Story scenes (one per island) + story scatter

| File | Island | Scene |
|---|---|---|
| smuggler_cache.glb | Smuggler's Rest | interrupted contraband handoff, dragged rowboat |
| skull_totem.glb | Skull Cove | carved skull monolith, ritual gone wrong |
| wrecker_tower.glb | The Crooked Atoll | crooked false-light tower, dead lantern (`Glass_Dead`) |
| whale_skeleton.glb | Dead Man Shoals | 22m walk-through rib cathedral |
| gibbet_cage.glb | Dead Man Shoals + Gallows Sands | rusted occupied cage on a post |
| rum_still.glb | Rumrunner Key | burst `Copper` still, scorch ring, barrel pyramid |
| crow_roost.glb | Crow's Perch | tripod lookout, dead watcher w/ spyglass, crows |
| mermaid_shrine.glb | Mermaid's Folly | figurehead idol on `Coral`/`Shell_Pearl` throne, candles |
| castaway_camp.glb | Castaway Reach | marooned skeleton, tally board, unfinished raft |
| kraken_wreck.glb | Kraken Tooth | tentacle-crushed bow, sucker rows, harpoons |
| dig_site.glb | Booty Bay | double-crossed dig, empty chest, coin trail |
| gallows.glb | Gallows Sands | triple gallows, cut ropes, 3 graves / 4 hats |
| parley_table.glb | Parley Point | truce table, crossed pistols, rival flags |
| mine_head.glb | Old Maw Caldera | charred mine portal, `Obsidian` ore cart |
| widow_memorial.glb | Widow's Watch | cottage ruin + stone widow, lit lantern (night beacon) |
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
`Kraken_Flesh`, `Kraken_Sucker`, `Obsidian`, `Crow_Black`.
