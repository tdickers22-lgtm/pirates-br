# pirates-br — Visual Overhaul Build Worklist

Post-audit triage of 21 findings, merged and ranked by **(SoT-illusion impact × on-screen frequency)**. Two duplicate clusters merged (dark-rock materials; ground-foliage clumping), leaving 19 work items.

Ranking axis note: severity labels from the audit are kept, but on-screen frequency reorders within a tier — a "P2" defect on *every island shoreline* outranks a "P2" seen only when diving. One finding is promoted to **P0** on that basis.

---

## P0 / P1 — Ship-blocking (fix first)

### 1. [P0] Waterfalls are flat self-lit white bars draped across island tops
- **Problem:** On all 5 tall hero islands (Crow's Perch, Old Maw, Widow's Watch, Kraken Tooth, Parley Point) the "waterfall" lies nearly horizontal across the terrain, glows pure white, and stays lit at night — reads as a painted greybox slash. Static, so it's in every aerial and every approach.
- **Root cause:** `src/client/core/Game.ts` ~5152-5209 — ribbon spans `surfacePoint(0.3)`→`surfacePoint(0.94)` (a ~0.64·radius *horizontal* run, few units of drop); `fallMat` is emissive (0xb8e0f5 @0.32, opacity 0.78) so it self-lights; white `CircleGeometry` foam pool at 5203-5209. Stream-channel formula at 5230-5231 (`sx=lower.x+lower.x*0.06*t`) scales toward island origin, not down-slope.
- **Fix:** Sample upper/lower at close radii on a genuinely steep local segment; require `horizontalRun < drop` before drawing and orient quads outward. Set `emissiveIntensity ≈ 0` so falls darken at night. Rewrite the 5230-5231 channel to run down-slope to the shore. If no steep face exists on an island, skip the fall rather than drape it.

### 2. [P1] Islands read bald — ground vegetation far below the stylized-AAA bar
- **Problem:** Every island interior is bare sand/grass with a thin dot-scatter of palms. Measured ~1 plant / 400-600 m². On-screen constantly during on-foot play; kills the "lush SoT shore" read.
- **Root cause:** `src/server/world/MapGenerator.ts:1236` — scatter target `min(110, max(12, radius*SCATTER_DENSITY*0.8))` is *shared* across palms/boulders/clutter/foliage, so soft cover is a fraction of an already-capped budget; only ≤3 tiny patches (1186-1209). `Game.ts:4045` grass = `min(2600, r*r*0.3)` blades ≈ 1 tuft/10 m².
- **Fix:** Add a dedicated soft-foliage ground-cover pass separate from the capped structural scatter (or raise `SCATTER_DENSITY` and lift the 110 cap for `shape:'none'` plants). Scale `patchCount` and `patchR` with island area and grow per-patch fill. Increase the grass InstancedMesh count 3-5× so interiors carpet continuously. Pairs with P2 item "ground foliage clumping."

### 3. [P1] Old Maw Caldera volcano is a smooth uniform orange pyramid, not charred rock with lava cracks
- **Problem:** The centerpiece volcano's whole upper cone is one glowing caramel gradient; from above it reads as a flat 2D orange flame decal on a green hill. Visible as an orange smear in many background aerials (01/07/04). Hero landmark.
- **Root cause:** `src/client/core/Game.ts` — emissive far too strong (`totalEmissiveRadiance += mc*g*3.6` ~3979); vein height-gate spans the whole flank (`smoothstep(heightNorm,0.14,0.66)` ~3922); vein power (~3917-3918) leaves too much coverage; ash scorch lerp (`*0.72` ~3929) too weak to darken under that emissive.
- **Fix:** Drop emissive 3.6 → ~1.2-1.6; sharpen veins (raise pow exponents / lower additive so vein <0.3 over most of the flank); strengthen ash scorch (lerp toward ~0.9, darken base rock) so it reads dark charcoal with a few bright cracks + a hot caldera rim.

### 4. [P1] Battle Map POI markers are raw OS color emoji
- **Problem:** Every charted POI on the fullscreen map and minimap is a glossy Apple-style emoji (skull, beer mug, anchor, volcano, moneybag…) drawn via `ctx.fillText`. Clashes with the parchment/gold map and renders differently or as tofu boxes across Windows/Linux/Android — non-deterministic. Map is opened constantly in a BR.
- **Root cause:** `src/client/core/Game.ts:9607-9638` (`renderBattleMap`) draws POI markers as literal emoji strings via `ctx.fillText` in a generic serif font.
- **Fix:** Replace with custom canvas-drawn vector glyphs (or a preloaded 1-bit icon sprite atlas) in the map's gold/bone palette (`#f4e8c6` / `#c9a84c`) with a dark outline, routed through a `drawPoiIcon(ctx,type,x,y)` helper — monochrome, on-style, identical on every platform.

### 5. [P1] Atoll lagoons render as a blinding near-white sand plate, not turquoise
- **Problem:** Crooked Atoll and Dead Man Shoals interiors are huge near-pure-white flat plates with only a faint cyan tint. The signature SoT "white lagoon ringed by turquoise" reads washed-out and flat. Two archipelago islands, but a signature look.
- **Root cause:** `src/client/core/Game.ts` — lagoon floor sits at/just above waterline so turquoise never engages: `depthMask = smoothstep(-pointY,-0.15,2.2)` (~3898) needs the vertex several metres under; barely-emergent shelf keeps bright `whiteSand` (`sandWhite` lerp 0.6 ~3609-3611).
- **Fix:** Make `depthMask`/`submergedColor` engage far shallower (start near `pointY < +0.3`, full by ~-1.0) or blend a dedicated lagoon-turquoise for archipelago interiors below the berm; cap `whiteSand` brightness on near-water verts so the floor tints aqua instead of staying paper-white.

### 6. [P1] Fullscreen Battle Map storm-timer chip overprints the title (quick win)
- **Problem:** The canvas storm chip "NEXT 1:36" is drawn at (8,8) — exactly under the HTML "BATTLE MAP" title — smearing both into an unreadable overlap. The same countdown is already shown correctly top-right as the subtitle, so the chip is redundant in fullscreen. Every fullscreen map open.
- **Root cause:** `src/client/core/Game.ts:9580-9586` draws the chip unconditionally for both minimap and fullscreen; `#map-title` is at top:18/left:22 (`index.html:1149-1156`) over the same corner.
- **Fix:** Guard the `fillRect`/`fillText` at 9580-9586 with `if (!fullscreen)`. One-line fix; do it in the same PR as the emoji-map work (item 4).

---

## P2 — Quality bar (fix next, ordered by frequency on screen)

1. **[borderline P1] Dark rock/cone materials render near-black on pale islands** *(merged: reef ring + scattered boulders + sea rocks + spires).* Every island shoreline shows a ring of near-black cones plus black boulder shards on sand — reads as rendering errors on bone/white-sand isles. Causes: reef ring `reefMatDark=0x282520`/`reefMatWet=0x3a3328` and `spireMat=0x4d4338` (`Game.ts:6067-6111`); `boulder_c` authored as `Rock_Dark` (`scripts/blender/build_rocks.py:153`, `_helpers.py:27` ≈ linear 0.22); waterline `seaRock` dark fallback `darkMat=0x292d2b` (`Game.ts:3521`, cached once at 3424-3428, never rebuilt). **Fix:** raise reef albedo to mid grey-brown (~0x5b5348/0x6d6455) + per-instance hue jitter + flatShading; retint `boulder_c` to `Rock_Grey` (~0.30 linear); invalidate the `seaRockMeshes` cache entry when `assets.clone` returns null and rebuild once the GLB loads (or lighten the fallback); lighten `spireMat`. Consider tinting reef toward each island's `BIOME_PALETTES` rock.

2. **Ground foliage renders as isolated specks, never clumps into masses** *(merged: grass tufts + wildflowers + bushes).* Grass reads as isolated green "X" marks, wildflowers as bare green sticks, bushes as lime gumdrops/top-down asterisks. Causes: single 0.4×0.5 grass blade placed one-per-seed (`Game.ts:4046`, 4090-4109); thin `build_wildflowers` stems (`build_plants.py:202-238`); single-gumdrop `leaf_clump` (30-48) + no local clustering + over-bright leaf albedos. **Fix:** mirror the fern clumping (`Game.ts:4137-4160`) — 3-6 grass blades and 2-4 shrubs per seed with XZ jitter and size variation; widen/lengthen the blade; desaturate bush leaf materials; fold wildflowers into the `flower_patch` bed prop instead of scattering singles. Direct multiplier on P1 item 2.

3. **Player/crew character reads as an untextured placeholder mannequin.** Flat single-color coat, faceless skin-tone sphere head, sphere-blob hands — dead-center at the deck camera every match. Cause: `Game.ts` `makePlayerMesh` 251+ (flat `coatMat`/`clothMat` 275-280; facial detail only under `if(isSkeleton)` 408-432; sphere hands 333-361). **Fix:** add pirate-variant face detail (eye/brow/nose quads mirroring the skeleton path), a cheap coat albedo/normal or belt/trim accent meshes, box-mitt hands — or pull the deck camera back.

4. **Ship flags/pennants are flat single-plane quads (cardboard cloth).** Always visible on your own ship. Cause: `src/client/rendering/ShipRenderer.ts:2126-2127` (pennant `PlaneGeometry`) and :2700 (`flagGeo`); animation at :3164-3167 only rotates the whole mesh. **Fix:** subdivide the plane 8-12 segments along its length and drive a sine traveling-wave in a vertex shader anchored at the mast edge, amplitude scaled by `wind.strength` + ship speed.

5. **Radial-fan "pinwheel" discoloration at every island's geometric center.** Purplish streaky star at the triangulation apex — clearest in every aerial and on the map (Rumrunner, Gallows, Parley, Booty Bay, Smuggler's). Cause: ring-0 collapses `angularSegments+1` verts onto one pole (`Game.ts:3758-3759`) but each gets different per-segment `vnoise`/`hueDrift` (3949-3954) and degenerate-fan normals. **Fix:** collapse ring 0 to a single shared vertex (one position/color/normal), or force `vnoise=0` with one averaged color at `ring===0` and skip the degenerate fan triangles.

6. **Tavern is a plain flat-shaded tan box (greybox house).** Social-hub landmark on 4 islands. Cause: `public/assets/models/tavern.glb` is a single-material low-detail box loaded verbatim (`AssetLibrary.ts:21`; placed `Game.ts` ~6825-6876). **Fix:** re-author with timber-frame trim, roof shingles, doorway/porch, and a hanging sign; register a warm eave-lantern emitter (reuse campfire/lantern_post path ~2554-2558) so it glows at night. Interim: add sign board + barrels/crates + lantern + wall vertex-color variation.

7. **Bone/rocky islands are featureless monotone tan sand domes.** Skull Cove (billed "rocky"), Gallows Sands, Dead Man Shoals lack grass/rock character. Cause: `src/shared/props.ts` `BIOME_PALETTES.bone` (~line 55) grass `0x9ba06a` sits too close to sand `0xe6ddc4`; low relief never reaches rock/peak color bands (`Game.ts:3871-3872`). **Fix:** push bone grass more olive/desaturated, lower the grass height threshold so interiors green up, and scatter rock outcrops (boulder/rock_arch) on rocky bone islands.

8. **Snow/mountain biome barely reads — Widow's Watch is a flat pancake; Crow's Perch a thin spire.** Snow-capped skyline landmarks are indistinguishable from plateaus. Cause: snow gated on `heightNorm=(pointY-seaBase)/peakEst` where `peakEst` over-estimates relief (`Game.ts:3845-3847`); band `smoothstep(heightNorm,0.62,0.9)` (3937-3941) rarely triggers; low mountain amplitude in `src/shared/utils/index.ts:554-563`. **Fix:** base the snow line on *absolute* height above sea (~18-20m) and widen the band; raise the minimum mountain `peakBoost`/height so a real dominating spire builds, then cap the top third with clean bright snow.

9. **Volcanic shaded flanks/shoreline collapse to a purple/magenta cast.** Old Maw shore and Kraken Tooth shaded flank read as a color bug. Cause: `src/shared/props.ts` `BIOME_PALETTES.volcanic` (~line 53) sand `0x6e6154`/rock `0x5a5148` are so dark/desaturated they collapse toward violet under cool sky-fill. **Fix:** warm and slightly lighten the volcanic palette (sand ~0x7a695a, rock ~0x6b5f52) or clamp the sky-fill contribution on volcanic vertex colors → warm charcoal-brown basalt.

10. **Kraken Tooth "twin" island reads as one flat oval pancake with a cake-like cliff wall.** No readable saddle or second peak; continuous vertical rim. Cause: `src/shared/utils/index.ts` twin branch (~626-631) only drops the saddle vs a low seaLift; high `cliffLift` from `coastBias +0.55` (~585/591) walls the whole rim. **Fix:** raise twin peak amplitude and deepen the saddle so two peaks emerge; taper/mix the cliff rim on part of the coast so it isn't a continuous wall.

11. **Deep underwater renders as a near-black empty void.** No murk gradient, god rays, particulate, or seabed. Only when diving deep, so lowest frequency in this tier. Cause: `src/client/rendering/Renderer.ts:202` `fogUnderwaterDeepColor=0x031f35` (near-black) blended at 473-474, density lerp to 0.018 at 476, exposure/light dimming 489-497. **Fix:** lift the deep fog toward murky teal (~0x0a3a4a) and cap density lower (~0.010-0.012) so silhouettes survive; add a cheap god-ray/caustic/particulate layer and keep the seabed lit — dark and moody but non-empty.

---

## Minor / P3 (polish, lower priority)

- **Skull fort is monochrome light-grey on a visible circular disc.** The map's single hero raid landmark reads as a greybox castle on a floating pad — under-delivers, so treat as the highest-value P3. Cause: `public/assets/models/fort.glb` single light-grey material with a built-in flat base slab (`AssetLibrary.ts:21`; collider `props.ts:32/:64`). **Fix:** re-author with weathered multi-tone mossy stone, banners, and a real skull emblem over the gate; remove/feather the base slab (rocky skirt or sink+blend) and scale up ~1.3× so it dominates its shore.

- **Opponent nameplates punch through ship geometry and are oversized up close.** `depthTest:false` + `renderOrder 998` draw labels through your own sails/hull; fixed `scale 3.4` gives a giant label at close range (`Game.ts:961-965`, shown within 85m at :7919). **Fix:** enable `depthTest` (or a soft occlusion fade), scale/clamp sprite size with distance, and consider hiding plates for players sharing the camera's ship.

---

## Suggested PR batching
- **PR-A (islands-terrain):** items 3, 5 (P1) + P2 #5, #7, #8, #9, #10 — all live in `Game.ts` terrain shader + `props.ts` palettes + `utils/index.ts` island profiles.
- **PR-B (vegetation-props):** P1 item 2 + P2 #1, #2 — scatter budget, clumping, and dark-rock retints (touches `MapGenerator.ts`, `Game.ts` scatter/grass, `build_plants.py`, `build_rocks.py`).
- **PR-C (buildings-landmarks):** P0 item 1 (waterfalls) + P2 #6 tavern + P3 fort — `Game.ts` waterfall pass + GLB re-authoring.
- **PR-D (hud-map-ships):** P1 items 4 & 6 (map) + P2 #3 mannequin, #4 flags, #11 underwater + P3 nameplates.
