# pirates-br GLB assets

Original stylized assets authored in Blender via `scripts/blender/*.py`
(reproducible: run the build scripts in Blender, they export here).
Scale: 1 unit = 1 game unit (~1 m). Up = +Y, ship/game forward = +Z.
All origins at ground/waterline center unless noted.

| File | Contents | Footprint | Notes |
|---|---|---|---|
| palm_a.glb | Tall palm (~8.5u) | ~1u trunk | lean +X |
| palm_b.glb | Curved palm (~6.5u) | ~1u trunk | strong lean |
| palm_c.glb | Short bushy palm (~5u) | ~1u trunk | |
| boulder_a.glb | Island boulder | r≈1.6 | grey |
| boulder_b.glb | Large flat boulder | r≈2.6 | grey |
| boulder_c.glb | Small tall boulder | r≈1.1 | dark |
| searock_a.glb | Jagged sea spire | h≈4.5 | origin at waterline |
| searock_b.glb | Large sea spire | h≈7 | origin at waterline |
| searock_c.glb | Small sea spire | h≈3 | origin at waterline |
| barrel.glb | Loot barrel | h=1.0, r≈0.42 | |
| keg.glb | Powder keg (red bands, fuse) | h=0.8 | |
| chest_closed.glb | Treasure chest | 0.95×0.62×0.55 | gold trim |
| chest_open.glb | Open chest w/ gold pile | same | |
| crate.glb | Supply crate | 0.72³ | |
| campfire.glb | Stone ring + charred logs | r≈0.7 | add FX flame in-engine |
| dock_mid.glb | Dock module, deck z=1.1 | 6×3 | walkway along local X/Z after export |
| dock_end.glb | Short dock end module | 4×3 | |
| watchtower.glb | Ruined stone tower, collapsed +X side | r≈2.6, h≈9 | doorway faces −Z (game) |
| shipwreck.glb | Beached hull skeleton (ribs+keel+mast) | ~11×5 | listing to one side |
| standing_stones.glb | Monolith circle + fallen slab + gold glint | r≈3.5 | |
| lantern_post.glb | Lantern post, emissive glass | h≈2.6 | pair with docks/camps |

Material names are stable for client-side tinting: `TeamTint`, `Leaf_Green`,
`Wood_*`, `Rock_*`, `Gold`, `Rope`, `Canvas*`, `Metal_*`, `Lantern_Glass`
(emissive).
