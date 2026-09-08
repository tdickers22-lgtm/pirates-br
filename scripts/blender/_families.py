# THE COMMON FAMILY TABLE — one row per material name the shipped GLBs use.
#
# PLAN 2.4a: the 63 island GLBs never get authored UVs. They get a world-space
# TRIPLANAR detail set chosen per vertex from a FAMILY id, and the family is
# decided by the Blender material NAME — which is the only thing an exported GLB
# still carries that says what a surface is made of. `Trunk_Palm` is bark,
# `Metal_Band` is iron, `Leaf_A` is grass. A colour cannot say that (`Rock_Pale`
# and `Bone_White` are nearly the same beige) and a vertex attribute the build
# scripts would have to set by hand would be forgotten on the next asset.
#
# THIS FILE IS THE AUTHORING SIDE. `src/client/assets/AssetMaterialCollapse.ts`
# carries the identical table for the runtime side, and
# `scripts/test-asset-merge.mjs` parses this file and fails if the two disagree
# by a single row — so a build script that invents `Wood_Charred` fails the gate
# here rather than shipping a plank-grained ash pile.
#
# FAMILIES. Eight detail layers (PLAN 2.4a) plus `flat`, which is the refusal:
# skin, feathers, glass, gold, a glow, and every hero asset that already carries
# an authored atlas (`Atlas_*`) must NOT be ground under a tiling rock grain.
# `flat` is family 0 so that a vertex nobody baked reads "no detail", which is
# the same all-zero-is-the-identity rule the tint and surface attributes follow.
#
# LAYER INDEX. The KTX2 2D-array ships the eight real layers only, so a sampler
# reads layer `family - 1` and skips the fetch entirely when `family == 0`.

FAMILIES = ['flat', 'sand', 'grass', 'rock', 'ash', 'bark', 'plank', 'canvas', 'iron']

MATERIAL_FAMILIES = {
    # ── hero atlases: already textured, never re-grained ──────────────────
    'Atlas_blunderbuss': 'flat',
    'Atlas_cannon': 'flat',
    'Atlas_capstan': 'flat',
    'Atlas_cutlass': 'flat',
    'Atlas_eye_of_reach': 'flat',
    'Atlas_flintknock': 'flat',
    'Atlas_flintlock': 'flat',
    'Atlas_ship_lantern': 'flat',
    'Atlas_wheel': 'flat',
    # ── granular ground ───────────────────────────────────────────────────
    'Sand': 'sand',
    'Sand_Pad': 'sand',
    'Dirt': 'sand',
    'Grave_Dirt': 'sand',
    # ── foliage ───────────────────────────────────────────────────────────
    'Leaf_A': 'grass',
    'Leaf_B': 'grass',
    'Leaf_C': 'grass',
    'Leaf_Dry': 'grass',
    'Leaf_Green': 'grass',
    'Leaf_Green_Lt': 'grass',
    'Stem': 'grass',
    'Flower_Pink': 'grass',
    'Flower_White': 'grass',
    'Flower_Yellow': 'grass',
    # ── stone ─────────────────────────────────────────────────────────────
    'Rock_Cave': 'rock',
    'Rock_Dark': 'rock',
    'Rock_Grey': 'rock',
    'Rock_Pale': 'rock',
    'Rock_Sea': 'rock',
    'Rock_Stack': 'rock',
    'Rock_Wet': 'rock',
    'Stone_Dark': 'rock',
    'Stone_Fort': 'rock',
    'Stone_Statue': 'rock',
    'Slate': 'rock',
    'Plaster': 'rock',
    # ── volcanic / burnt ──────────────────────────────────────────────────
    'Rock_Flow': 'ash',
    'Obsidian': 'ash',
    'Char_Black': 'ash',
    'Tar_Black': 'ash',
    # ── living wood ───────────────────────────────────────────────────────
    'Trunk_Palm': 'bark',
    'Coconut': 'bark',
    'Wood_Bleached': 'bark',
    # ── worked wood ───────────────────────────────────────────────────────
    'Wood_Dark': 'plank',
    'Wood_Light': 'plank',
    'Wood_Mid': 'plank',
    'Wood_Wet': 'plank',
    'Timber': 'plank',
    'Shingle': 'plank',
    'Shingle_Lt': 'plank',
    'Ochre_Paint': 'plank',
    'Keg_Red': 'plank',
    # ── cloth and cordage ─────────────────────────────────────────────────
    'Canvas': 'canvas',
    'Canvas_Dirty': 'canvas',
    'Cloth': 'canvas',
    'Awning_Cream': 'canvas',
    'Awning_Red': 'canvas',
    'Flag_Fin': 'canvas',
    'Flag_Rival': 'canvas',
    'Flag_White': 'canvas',
    'Rope': 'canvas',
    # ── metal ─────────────────────────────────────────────────────────────
    'Metal_Band': 'iron',
    'Metal_Iron': 'iron',
    'Rust': 'iron',
    'Copper': 'iron',
    'Verdigris': 'iron',
    # ── refusals: organic, glass, glow, precious ──────────────────────────
    'Beak_Yellow': 'flat',
    'Berry_Red': 'flat',
    'Bone': 'flat',
    'Bone_Shadow': 'flat',
    'Bone_White': 'flat',
    'Bottle_Green': 'flat',
    'Candle_Wax': 'flat',
    'Comb_Red': 'flat',
    'Coral': 'flat',
    'Coral_Pink': 'flat',
    'Crab_Dark': 'flat',
    'Crab_Red': 'flat',
    'Crow_Black': 'flat',
    'Crystal_Glow': 'flat',
    'Ember': 'flat',
    'Eye_Black': 'flat',
    'Feather_Black': 'flat',
    'Flame_Glow': 'flat',
    'GlassWarm': 'flat',
    'Glass_Dead': 'flat',
    'Glass_Flame.001': 'flat',
    'Gold': 'flat',
    'Gull_Dark': 'flat',
    'Gull_Grey': 'flat',
    'Gull_White': 'flat',
    'Hair': 'flat',
    'Hen_Brown': 'flat',
    'Hen_Cream': 'flat',
    'Hoof_Dark': 'flat',
    'Kraken_Flesh': 'flat',
    'Kraken_Sucker': 'flat',
    'Lantern_Glass': 'flat',
    'Leather': 'flat',
    'Mouth_Red': 'flat',
    'Pig_Pink': 'flat',
    'Pig_Snout': 'flat',
    'Shark_Belly': 'flat',
    'Shark_Dark': 'flat',
    'Shark_Grey': 'flat',
    'Shell_Pearl': 'flat',
    'Skin': 'flat',
    'TeamTint': 'flat',
    'Teeth_White': 'flat',
}



# The terrain's own per-vertex classes (TerrainMeshBuilder's `aMat`, 0..3) and
# the surfaces the game BUILDS rather than loads. Mirrored from
# AssetMaterialCollapse.ts and checked row for row by test-asset-merge.mjs, for
# the same reason the material table is: two copies drift.
TERRAIN_MAT_FAMILIES = ['sand', 'grass', 'rock', 'ash']

SURFACE_FAMILIES = {
    'cave_shell': 'rock',
    'cave_rubble': 'rock',
    'sea_rock': 'rock',
    'ship_hull': 'plank',
    'ship_deck': 'plank',
    'ship_interior': 'plank',
    'ship_sail': 'canvas',
    'ship_rigging': 'canvas',
    'ship_iron': 'iron',
}

def family_of(name):
    """The family for a material name, or None when the table has never heard
    of it. None is deliberate: a build script that coins a new material must add
    a row here, and `assert_families` is how it finds out at build time instead
    of the gate finding out later."""
    return MATERIAL_FAMILIES.get(name)


def assert_families(names):
    """Raise on any material name with no family row. Call at the end of a build
    script with the material names it created."""
    missing = sorted({n for n in names if n not in MATERIAL_FAMILIES})
    if missing:
        raise RuntimeError(
            'materials with no family in scripts/blender/_families.py: '
            + ', '.join(missing))
