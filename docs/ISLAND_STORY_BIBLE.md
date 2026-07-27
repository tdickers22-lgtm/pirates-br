# The Shattered Reach — Island Story Bible

Every island answers three questions on sight: **who was here, what happened, and why should I explore?**
Each island gets one hero **story scene** (a single GLB, placed like the fort: one landmark type,
one terrain stamp, one collider) plus supporting scatter. Names were already stories — now the
world delivers on them.

Conventions: 1 unit = 1 m. Author bow/front toward Blender −Y. Scene GLB origin at ground center.
Hero scenes are one-off per island → poly budget is generous (see fidelity targets at bottom).

---

## 1. Smuggler's Rest — *the friendly front*
Sleepy trading stop above deck, contraband empire below.
**Hero: `smuggler_cache`** — stacked contraband crates under a draped tarp net, rum kegs
half-buried in sand, hand cart, one crate pried open spilling bottle-glint, lantern on a shepherd's
hook, crowbar. Placement: interior grove (dLo 0.18–0.4), stamp ~5.
Beat: the tavern is a front; the real business hides in the trees.

## 2. Skull Cove — *the pirate lair*
The inlet IS a mouth. Lean into it.
**Hero: `skull_totem`** — freestanding carved-skull monolith (weathered rock skull on a bone-heaped
cairn) glaring over the inlet, ringed by bone totems on spears + an iron brazier. Placement: high
ground facing the forcedInlet angle. Beat: trespassers were warned.

## 3. The Crooked Atoll — *the wreckers' false light*
Ships don't die here by accident — someone lights the wrong beacon (real Cornish/Bahamian
wrecker history).
**Hero: `wrecker_tower`** — a crooked driftwood light-tower with an extinguished signal lantern,
salvaged cargo stacked at its base (crates bearing the Black Fin brand), a spyglass tripod,
drag marks. Placement: worst reef spur / outer islet. Beat: the light was never meant to save you.

## 4. Dead Man Shoals — *where dead things wash up*
The reach's bone-yard; crews maroon their problems here.
**Hero: `whale_skeleton`** — a 22 m bleached whale skeleton half-sunk in the sand, ribcage tall
enough to walk through, skull tilted, sand drifted against the bones. Placement: beach band near
waterline (shipwreck-style scoring). Beat: even leviathans wash up here.
Second small piece: **`gibbet_cage`** (rusted iron cage on a post, occupant included, crow on top,
a Black Fin rag tied to the frame) at the shoal edge — also placed on Gallows Sands.

## 5. Rumrunner Key — *the distillery*
The rum has to come from somewhere.
**Hero: `rum_still`** — copper pot-still with coiled pipework, barrel pyramid, bottle crates,
sugar-cane bundles, boil fire with kettle, canvas awning on poles, tasting table with mugs.
Placement: palm grove near the dock side. Beat: business is booming, quality is questionable.

## 6. Crow's Perch — *the dead lookout*
The watchers left; the crows stayed.
**Hero: `crow_roost`** — great dead hardwood snag, branches full of crows, unlit signal pyre
(log teepee with pitch barrel), rope-and-pulley supply crane leaning over the crag, weathered
warning sign. Placement: high shoulder near the watchtower (dHi 0.5). Beat: the signal was never lit.

## 7. Mermaid's Folly — *the siren's toll*
Sailors heard singing; the shrine is apology and warning at once.
**Hero: `mermaid_shrine`** — weathered stone mermaid on a barnacled plinth, arms raised seaward,
ring of offerings: candle clusters (emissive), pearl shells, coin piles, a wrecked rowboat laid
at the base like a tribute. Placement: crescent bay beach, facing the lagoon. Beat: she is owed.

## 8. Castaway Reach — *the marooned man*
The island is named for him; the settlement grew up around his legend.
**Hero: `castaway_camp`** — a skeleton propped against a lone palm trunk, flintlock in its lap,
empty rum bottle beside; a driftwood board carved with hundreds of tally marks; a half-built
escape raft of barrels and lashed planks; fish-drying rack. Placement: beach away from the fort.
Beat: he counted the days. The raft was never finished.

## 9. Kraken Tooth — *the attack* (SHOWSTOPPER)
Twin volcanic spires like teeth. Something bit back.
**Hero: `kraken_wreck`** — a broken hull section CRUSHED inside a giant coiled kraken tentacle
(suckers, tapering tip), harpoons stuck in it with trailing rope, splintered planking, sucker-scar
rings on nearby rock. Placement: shoreline between the twin peaks. Beat: the kraken won, and left.

## 10. Booty Bay — *the double-cross*
Everyone's map says the treasure is here. Someone's was right.
**Hero: `dig_site`** — cratered dig field: 3 pits with spoil mounds, abandoned shovels + pick,
an opened EMPTY grand chest, one skeleton in the deepest pit with its hat over its face, a torn
map pinned to a post by a dagger, a Black Fin pennant on a lean stake, a trail of dropped coins
leading toward the surf. Placement: interior meadow. Beat: the crew that dug it up didn't all
leave.

## 11. Gallows Sands — *the execution ground*
Small, grim, unforgettable.
**Hero: `gallows`** — weathered double gallows with two hanging nooses + a gibbet cage swinging
from the side arm, crow on the crossbeam, coffin cart, boot-hill graveyard (leaning crosses,
fresh mound). Placement: highest point of the small isle so it silhouettes. Beat: the tide brings
everyone to justice eventually.

## 12. Parley Point — *neutral ground*
Captains meet under the white flag here — leave your steel at the barrel.
**Hero: `parley_table`** — great round table (ship-hatch top) with mismatched captains' chairs,
chart weighted with a pistol and goblets, tall white parley flag, and a "truce barrel" bristling
with surrendered cutlasses at the perimeter. Placement: plateau top. Beat: the only island where
nobody died. Yet.

## 13. Old Maw Caldera — *the doomed mine*
They dug obsidian out of a live volcano. It went how you'd think.
**Hero: `mine_head`** — timber mine portal into the slope (beams charred), ore cart on a rail
stub, obsidian chunk crates (glassy black), pick + lantern drop, cracked warning sign, collapsed
support pile. Placement: mid-slope of the cone, near a cave mouth if possible. Beat: the mountain
kept it.

## 14. Widow's Watch — *the kept flame*
She lit the cliff lantern every night for a captain who never came home.
**Hero: `widow_memorial`** — cloaked stone figure gazing seaward from a cliff cairn, raised
lantern (warm emissive — visible at night from the sea), engraved plinth, bench, dead rose brush;
beside it a small ruined cottage (standing chimney, collapsed roof beams). Placement: seaward
cliff edge (high dHi, facing open water). Beat: the light still burns; she doesn't.

---

## Shared scatter additions (instanced, cheap, biome-gated)
- `bone_pile` — ribcage + skull heap (bone biome: Dead Man, Gallows, Skull Cove)
- `driftwood_log` — bleached snag (all beaches)
- `grave_marker` — leaning cross/headstone (bone + highland)

## Appendix — Names of the Reach (display layer)

The world had original systems and borrowed vocabulary, so it read as somebody
else's game before its own ideas landed. These are the words the player sees.
**They are DISPLAY NAMES ONLY** — every wire id, save key, stat table key and
test-asserted identifier keeps its original spelling (`sloop`, `eye_of_reach`,
`banana`, `gold_hoarder`, …). The single place the new nouns live is
`src/client/ui/DisplayNames.ts`; nothing else should ever hardcode one.

| Shown to the player | Internal id (unchanged) | Where it came from |
| --- | --- | --- |
| **The Shattered Reach** / *The Reach* | — | the world's own name, now on the menu, the loading card, the chart header and the start ceremony |
| **the Black Fin** | — | the brand on the wreckers' crates (§3), the rag on the gibbet (§4), the pennant at Booty Bay (§10) — now named once at the masthead in the start ceremony |
| **Wreckers' Run** | — | the playlist name on the loading card |
| **Tallyman** (pl. **Tallymen**) | `gold_hoarder` | the Coinwrights' broker ashore: he weighs the haul, tallies it, pays it. Tally marks are already the Reach's way of counting (Castaway Camp, §8) |
| **the Coinwrights** | — | the guild behind the scales — the faction the Tallymen answer to |
| **Cutter** | `sloop` | fast two-hand hull, runs the shoals |
| **Corsair** | `brigantine` | four-hand raider |
| **Man-o'-War** | `galleon` | eight-hand line-of-battle hull |
| **Wrecker's Glass** | `eye_of_reach` | rifled long arm with a salvaged spyglass lashed above the barrel — first built on the Crooked Atoll to read a hull before it struck (§3) |
| **Squall Pistol** | `flintknock` | half a charge of powder behind a fist-sized ball; it hits like weather and puts a man over the rail |
| **Plantain** | `banana` | what a period sailor actually called the fruit; keeps the yellow-crescent art honest |

Kept deliberately: **Cutlass**, **Blunderbuss**, **Flintlock Pistol**, **Powder
Keg**, **kraken**, **mermaid** — genuine period/folklore nouns that belong to
every pirate story, not to any one of them.

## Fidelity targets (final pass)
- Hero story scenes (1×/world): 25k–80k tris, full bevel/AO treatment
- One-off buildings (tavern/fort/watchtower/shipwreck): 3–6× current density
- Medium instanced (palms/boulders/searocks): 2k–6k tris
- Scatter instanced (bushes/ferns/flowers/shells): ≤1.5k tris
- All: bevel-caught edges, baked vertex AO in crevices, top-down hue gradient,
  asymmetry + wear (chips, sag, lean), silhouette-first composition.

## Appendix — What the player actually hears (delivery layer)

The beats above are the brief. These are the SHIPPED lines, and where they live.
Change them here and in code together; `scripts/test-story-delivery.mjs` fails
if an island loses its beat, its speaker, or its unique name.

### Vignette discovery — walking into a scene announces it

Footprint entry fires the island-banner + discovery sting once per scene per
match, with a feed line that keeps the find after the banner fades. Table:
`STORY_VIGNETTES` in `src/client/core/Game.ts`.

| Scene | Banner title | Beat |
| --- | --- | --- |
| `smuggler_cache` | The Smuggler's Cache | The tavern is the front. This is the business. |
| `skull_totem` | The Warning Stone | They cut it facing the water, so you would read it before you landed. |
| `wrecker_tower` | The Wrecker's Tower | The light was never meant to save you. |
| `whale_skeleton` | The Leviathan's Rest | Even leviathans wash up here. You will not do better. |
| `gibbet_cage` | The Gibbet | The Black Fin leave their rag on the frame, so you know who to thank. |
| `rum_still` | The Runner's Still | Business is booming. The quality is a rumour. |
| `crow_roost` | The Unlit Pyre | The watch had one job. The crows had another. |
| `mermaid_shrine` | The Siren's Toll | The offerings are not thanks. She is owed. |
| `castaway_camp` | The Last Camp | He counted every day. The raft is still three planks short. |
| `kraken_wreck` | What the Kraken Left | It did not sink her. It held her until she stopped moving. |
| `dig_site` | The Empty Chest | A Black Fin pennant marks the dig. The crew that opened it didn't all leave. |
| `gallows` | The Gallows | The tide brings everyone to justice eventually. |
| `parley_table` | The Parley Table | Leave your steel at the barrel. Nobody has died here. Yet. |
| `mine_head` | The Obsidian Cut | They dug black glass out of a living mountain. The mountain kept it. |
| `widow_memorial` | The Widow's Lantern | She lit it every night for a ship that never came. It still burns. |

### The cast — one authored voice per island

Every roster island has a speaker; no name repeats anywhere in the Reach.
Lore lines are `ISLAND_CAST` in `src/server/world/MapGenerator.ts` (roster
order, zero rng draws — the fixed world gets a fixed cast). A speaker opens
with their island's lore; later visits rotate in the tutorial lines their ROLE
teaches (`NPC_ROLE_TIPS` in `src/client/core/Game.ts`), so the game still
explains storms, repair, charts and trade without fourteen mouths reciting it.

| Island | Speaker (role) | Also ashore |
| --- | --- | --- |
| Smuggler's Rest | Ines the Fence (stranger) | Tavernkeeper Bess · Gold Hoarder Darius |
| Skull Cove | Bone-Reader Ovid (oracle) | Gold Hoarder Nessa Trell |
| The Crooked Atoll | Salvager Kellan Drage (shipwright) | Gold Hoarder Piet Ostrow |
| Dead Man Shoals | Moraine the Bone-Reader (oracle) | — |
| Rumrunner Key | Sable Tam (stranger) | — |
| Crow's Perch | Hesper Vane, Last of the Watch (stranger) | — |
| Mermaid's Folly | Shrinekeeper Calla Wren (oracle) | Gold Hoarder Lira Sarn |
| Castaway Reach | Maeve the Shipwright (shipwright) | Tavernkeeper Corin Ladd |
| Kraken Tooth | Harpooner Silas Threnn (shipwright) | — |
| Booty Bay | Jessamy Crook (stranger) | Tavernkeeper Ruby Vann |
| Gallows Sands | Gravedigger Ambrose Quill (oracle) | — |
| Parley Point | Ondine Bask, Keeper of the Truce (stranger) | Tavernkeeper Ansel Poe |
| Old Maw Caldera | Pitboss Garrow Finch (shipwright) | Gold Hoarder Halvard Bex |
| Widow's Watch | Old Salt Iona (oracle) | — |

The **Black Fin** thread is spoken aloud three times a player can stand in
front of: Kellan Drage on the brand burned into the wreckers' crates, Moraine
on what the Black Fin hang at Dead Man Shoals, and Jessamy Crook on the pennant
staked over the deepest pit at Booty Bay — plus the gibbet and dig vignettes.

### The widow's lantern is a landmark

§14 promised a light visible from the sea; the ordinary lantern glow dissolves
past ~60 m. `buildStoryBeacons`/`updateStoryBeacons` in `src/client/core/Game.ts`
give her lamp the stern-lantern treatment — an amber core plus a soft halo whose
screen size is held up with distance — so from 300 m of black water she reads as
a beacon you can steer by, in HER amber, never the watchtower's white.
