# Fidelity Pass — Build Fleet Brief

You are one agent in a fleet upgrading pirates-br's world assets to stylized-AAA
("Sea of Thieves quality" — quality reference only, all assets original).
Repo: `/Users/tobiasdicker/ai-dev-system/projects/pirates-br`. This brief + the
per-assignment spec below is your contract. Read `docs/ISLAND_STORY_BIBLE.md`
for narrative context.

## Toolchain (proven working — do not reinvent)
- Headless build: `/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/blender/<script>.py`
- Every script is self-contained and starts:
  ```python
  import os
  HERE = os.path.dirname(os.path.abspath(__file__))
  exec(open(os.path.join(HERE, '_helpers.py')).read())
  exec(open(os.path.join(HERE, '_ao.py')).read())
  ```
  (existing scripts resolve `_helpers.py` the same way; add the `_ao.py` line)
- Helpers you get: `mat(name)` palette materials, `asset_collection`, `obj_from_bmesh`,
  `join`, `apply_modifiers`, `bm_cylinder/bm_box/bm_icosphere`, `displace_noise`,
  `decimate`, `bevel_obj`, `export_collection`.
- From `_ao.py`: `bake_ao(coll)` (vertex AO -> COLOR_0, call ONCE on final geometry),
  `export_collection_vc(coll, 'name.glb')` (USE THIS instead of export_collection),
  `verify_glb(path)`, `render_turntable(coll, name, out_dir)`.
- **NEVER edit `_helpers.py`, `_ao.py`, or `public/assets/models/README.md`**
  (report new material names in your return instead — one writer updates the manifest).

## Hard contracts (breaking these breaks the game)
1. **GLB filename == asset/prop type name.** Existing assets keep their exact name.
2. **Material names are a client API** — the game tints/finds materials by name
   (TeamTint, Leaf_*, Wood_*, Rock_*, Gold, Rope, Canvas*, Metal_*, Lantern_Glass
   emissive). For EXISTING assets keep every existing material name (you may add).
3. **Origin + footprint:** origin at ground center (waterline center for sea rocks /
   shipwreck). Existing assets: footprint radius ±15%, height ±20% of current —
  colliders and placement tuning depend on them. `dock_mid`/`dock_end` are tiling
  modules: keep their length/width EXACT.
4. **Forward = Blender −Y** (game +Z). Scenes "face" their audience toward −Y.
5. Scale 1u = 1m. Player is 1.7m tall. Walk-in gaps ≥1.2m, doorways ≥2.2m.
6. All parts of one GLB get vertex AO (all-or-nothing — the instancing merge
   requires uniform attributes). `bake_ao(coll)` handles this; don't skip meshes.
7. Colors: no pure black (each channel ≥0.04), no near-white (≤0.90); roughness
   ≥0.75 except Metal_*/Gold/glass. The game's lighting crushes/blooms extremes.
8. New palette entries: extend locally in your script:
   `EXTRA = {...}` then `for k, v in EXTRA.items(): PALETTE.setdefault(k, v)`.
   Reuse existing palette names wherever possible (esp. Bone from build_fort.py —
   redeclare it locally if your script doesn't already have it: `"Bone": ((0.82, 0.78, 0.68, 1.0), 0.9, 0.0)`).
9. Emissive: copy the Lantern_Glass pattern (Emission Color + Strength 2–3) for
   candles/lanterns/embers only. Sparing — night mood is pooled warm light.

## Fidelity toolkit (this is the actual upgrade — apply ALL of it)
- **Silhouette first.** The asset must read at 80m as a unique black shape.
  Exaggerate: lean the tower, kink the mast, flare the roofline.
- **Bevel every hard edge** (`bevel_obj(obj, width=0.015–0.05)` before join) —
  bevel-caught highlights are what makes flat-color look expensive.
- **Geometry-as-wear:** chip plank corners, rotate every crate/barrel 2–8° off-axis,
  sag ropes as catenary curves (chains of small cylinders along a sampled catenary),
  splay barrel staves, snap one picket, crack one beam. Perfect right angles read cheap.
- **Cluster triads:** big + medium + small, overlapping, leaning on each other,
  bases sunk 3–6cm below z=0 so everything seats into terrain.
- **Mixed shading:** flat-shade planar facets (planks, rock facets), smooth-shade
  organic forms & bevels (`smooth=True` in obj_from_bmesh / per-face use_smooth).
- **Density where shape changes:** curves/silhouette edges get segments; flat faces stay coarse.
  bm_cylinder segs 10→16-24 on hero curves; icospheres subdiv 3 for organic masses.
- **displace_noise** (VORONOI) for rocks/organics; layer a second finer pass
  (`displace_noise(obj, strength=0.08, scale=0.5, seed=n)`) for surface chatter.
- **Top-down interest:** vary member colors (Wood_Dark/Mid/Light/Bleached mix),
  don't monochrome a structure.

## Poly & draw-call budgets (draw calls are the real bottleneck)
- Scatter instanced (bush/fern/flower/bone_pile/driftwood/grave): ≤ 1,000 tris
- Medium instanced (palms, boulders): 2,000–6,000 tris
- One-off buildings/landmarks (tavern, fort, watchtower, shipwreck, stall): 8,000–20,000 tris
- Hero story scenes (one instance in the whole world): 25,000–60,000 tris
- Material slots: ≤6 per normal asset, ≤8 per hero scene (each slot = a draw call
  on one-offs). ONE joined mesh per GLB (`join(parts, '<asset_name>')`).

## Mandatory verification loop (≥2 rounds; never ship unseen)
1. Run your script headless. Read the `VERIFY` line: tris within budget,
   `COLOR_0=True`, material list as designed, bbox sane (footprint/height!).
2. `render_turntable(coll, '<name>', '<scratchpad>/renders')` — then actually
   LOOK at the PNGs with the Read tool. Judge: silhouette, scale vs a 1.7m human,
   composition focal point, color balance, wear/asymmetry present, no z-fighting,
   no floating parts.
3. Fix and re-run. Iterate until it would survive an art director. Renders from
   round N go to `<scratchpad>/renders/round<N>/` so you can compare.
4. Final exports go to `public/assets/models/` via `export_collection_vc` (the
   script's EXPORT_DIR default). Scratch exports for testing go to your scratchpad.

## The Black Fin motif (shared lore thread — build EXACTLY this where assigned)
A doomed crew's mark recurring across islands (players reconstruct their story).
Tattered pennant 1.5 × 0.9m: field material `Flag_Fin` ((0.09, 0.20, 0.23, 1.0), 0.9, 0.0),
appliqué shark fin (raised 2cm relief, material `Bone`), 3 triangular bite-notches
in the fly edge, cloth sag via subdivided grid + gentle wave displacement.
Hangs from whatever the scene offers (pole, yard, gibbet frame).

## Skeletons (several scenes) — stylized, chunky, readable
Material `Bone`. Skull ≈ 0.22m (icosphere subdiv 2 + jaw box + eye socket cuts via
inset/boolean or dark `Char_Black` insets), ribcage from 5-6 curved flat ribs
(toruses sections or bent boxes), limbs = tapered cylinders with ball joints.
~600–1,200 tris per skeleton. POSE tells the story (kneeling, slumped, reaching,
face-down mid-flee). No gore — bleached bone only.

## Return (your final message = data for the orchestrator)
Per asset: name, final tris, material slots (+which are NEW palette entries),
footprint radius (m), height (m), suggested collider (shape/radius/height —
'none' for walk-through), suggested terrain stamp radius for scenes, what the
player should read from 10m away (one sentence), render PNG paths, and any
contract deviation you had to make (should be none).
