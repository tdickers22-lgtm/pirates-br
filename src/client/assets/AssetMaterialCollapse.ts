import * as THREE from 'three';

/**
 * ONE MATERIAL PER ASSET — the wall §12.3 of the cost model ran into.
 *
 * The static batcher was taught to merge a pier's meshes (c6ca898) and every
 * remaining decor draw became SOLE-OF-MATERIAL: draws per copy equal materials
 * per copy, on every row of the census. The reason is in the assets, not in the
 * code that places them. Sixty-three GLBs (plus 15 _far LODs — the models
 * README carries the generated count), **zero images, zero textures**, and
 * 8-16 flat-colour `MeshStandardMaterial`s apiece. `fort.glb` is twelve
 * materials — `Rock_Dark`, `Stone_Fort`, `Bone`, `Gold` — i.e. twelve draw
 * calls to say twelve colours.
 *
 * It costs the INSTANCED props too, which is the part nobody expected:
 * `assets.mergedGeometry` flattens an asset to one geometry with one group per
 * material and hands back a material ARRAY, and three submits a mesh once per
 * group. `props-palm_a` is ONE `InstancedMesh` of 4,000 palms and **five draw
 * calls**, and it is five on every island that has palms.
 *
 * WHAT THE MATERIALS ACTUALLY DIFFER IN, measured over every shipped GLB rather
 * than assumed: `color`, `roughness`, and — on `barrel`/`keg` alone — `metalness`.
 * Nothing else. Same type, same `flatShading`, same `side`, same
 * `vertexColors`, same opacity, no emissive, no map of any kind. Three floats
 * and a colour. So they go in VERTEX ATTRIBUTES and the array becomes one
 * material.
 *
 * ── THE FOUR TRAPS (docs/FRAME_COST_MODEL.md §12.4), and what this file does
 *    about each ────────────────────────────────────────────────────────────────
 *
 *  1. AN ATTRIBUTE THAT GOES MISSING READS (0,0,0,1). A lost roughness attribute
 *     is therefore roughness ZERO — a mirror — and this game ships no envMap, so
 *     the first attempt rendered every instanced boulder matte black. Both
 *     attributes here are stored so that ALL-ZERO IS THE IDENTITY: `aSurface.x`
 *     is SMOOTHNESS (1 − roughness), so a missing one is merely "fully rough",
 *     and `aTintComp` is the COMPLEMENT of the colour, so a missing one is
 *     white, i.e. "no tint". A geometry that never got baked degrades to a
 *     matte white prop, not to a black one and not to a chrome one.
 *  2. `COLOR_0` IS NOT OURS TO REDEFINE. It carries Blender's baked AO, and
 *     builders reuse ASSET GEOMETRY under their OWN materials — `CaveBuilder`'s
 *     rubble puts `boulder_a`'s merged geometry under a cave-tinted material
 *     with `vertexColors: true`. Multiplying the asset's colour into `COLOR_0`
 *     would double-darken exactly those. Hence a PRIVATE attribute name: the
 *     rubble's plain `MeshStandardMaterial` never declares `aTintComp`, so it
 *     never reads it, and its pixels do not move.
 *  3. `Material.copy` DROPS `onBeforeCompile` AND `customProgramCacheKey`. So
 *     this is a SUBCLASS whose constructor installs both, because `clone()` is
 *     `new this.constructor()` followed by `copy()`. `copy()` is overridden to
 *     carry the one flag that changes the shader.
 *  4. `material.color` STOPS MEANING "THE COLOUR" once a tint is baked in.
 *     `CaveBuilder` recolours the portal frame by cloning the asset's material
 *     and writing `.color`; with a baked tint that would multiply instead of
 *     replace and the portal went black. `bakedTint = false` is the explicit
 *     switch such a caller sets: it compiles the tint and surface reads OUT of
 *     the shader entirely, so `color`/`roughness`/`metalness` mean exactly what
 *     they meant before. It is a separate program, which is why it is in the
 *     cache key.
 *
 * ONE MATERIAL PER ASSET, NEVER ONE PER LIBRARY. A library-wide material would
 * make every crate and pier bend in `applyFoliageSway`'s wind, because that
 * patch is installed on a material and a palm's material is a bush's material
 * the moment they are shared.
 */

/** Per-vertex 1 − colour. Complement so that a missing attribute reads white. */
export const TINT_ATTRIBUTE = 'aTintComp';
/** Per-vertex (smoothness, metalness). Smoothness so a missing one reads rough. */
export const SURFACE_ATTRIBUTE = 'aSurface';
/**
 * Per-vertex emissive radiance (`emissive` x `emissiveIntensity`), and the one
 * attribute here that is stored STRAIGHT rather than complemented — because for
 * a glow, all-zero already IS the identity. That is what lets it be OPTIONAL:
 * a collapsed geometry with no lit chunk never allocates the buffer at all, the
 * program still declares the attribute, and WebGL's default generic value
 * (0,0,0,1) makes the shader read "no glow" (trap 1, from the useful side).
 * So the 9 lit GLBs pay 12 bytes a vertex and the other 54 pay nothing.
 */
export const EMISSIVE_ATTRIBUTE = 'aEmissive';

/**
 * THE DETAIL FAMILY LADDER (PLAN 2.4a) — what a surface is MADE OF, per vertex.
 *
 * The 63 island GLBs ship zero images and never get authored UVs, so the only
 * way they can gain surface texture is a world-space TRIPLANAR fetch, and the
 * only way a triplanar fetch knows whether it is standing on bark or on iron is
 * a family id riding alongside `aTintComp`/`aSurface` in the same collapse. The
 * id is decided by the Blender MATERIAL NAME, because that is the one thing a
 * GLB still carries that says what a surface is: `Rock_Pale` and `Bone_White`
 * are nearly the same beige, so a colour cannot tell them apart, and a hand-set
 * attribute would be forgotten on the next asset.
 *
 * `flat` is family 0 and it is a REFUSAL, not a fallback: skin, feathers,
 * glass, gold, a lantern glow and every hero asset that already carries an
 * authored atlas must not be ground under a tiling rock grain. Zero also stays
 * the identity for a missing attribute, the same rule the tint and the surface
 * follow (trap 1 above).
 *
 * The KTX2 array ships the eight real layers only, so a sampler reads layer
 * `familyIndex - 1` and skips the fetch when the index is 0.
 *
 * PARITY: `scripts/blender/_families.py` carries the identical table for the
 * build scripts, and `scripts/test-asset-merge.mjs` parses that file and fails
 * on a single differing row.
 */
export const DETAIL_FAMILIES = [
  'flat', 'sand', 'grass', 'rock', 'ash', 'bark', 'plank', 'canvas', 'iron',
] as const;

export type DetailFamily = typeof DETAIL_FAMILIES[number];

/** One row per material name every shipped GLB uses. Exhaustive on purpose: an
 *  asset that coins a new material fails the coverage gate instead of silently
 *  reading family 0. */
export const MATERIAL_FAMILIES: Readonly<Record<string, DetailFamily>> = {
  // ── hero atlases: already textured, never re-grained ──────────────────
  Atlas_blunderbuss: 'flat',
  Atlas_cannon: 'flat',
  Atlas_capstan: 'flat',
  Atlas_cutlass: 'flat',
  Atlas_eye_of_reach: 'flat',
  Atlas_flintknock: 'flat',
  Atlas_flintlock: 'flat',
  Atlas_ship_lantern: 'flat',
  Atlas_wheel: 'flat',
  // ── granular ground ───────────────────────────────────────────────────
  Sand: 'sand',
  Sand_Pad: 'sand',
  Dirt: 'sand',
  Grave_Dirt: 'sand',
  // ── foliage ───────────────────────────────────────────────────────────
  Leaf_A: 'grass',
  Leaf_B: 'grass',
  Leaf_C: 'grass',
  Leaf_Dry: 'grass',
  Leaf_Green: 'grass',
  Leaf_Green_Lt: 'grass',
  Stem: 'grass',
  Flower_Pink: 'grass',
  Flower_White: 'grass',
  Flower_Yellow: 'grass',
  // ── stone ─────────────────────────────────────────────────────────────
  Rock_Cave: 'rock',
  Rock_Dark: 'rock',
  Rock_Grey: 'rock',
  Rock_Pale: 'rock',
  Rock_Sea: 'rock',
  Rock_Stack: 'rock',
  Rock_Wet: 'rock',
  Stone_Dark: 'rock',
  Stone_Fort: 'rock',
  Stone_Statue: 'rock',
  Slate: 'rock',
  Plaster: 'rock',
  // ── volcanic / burnt ──────────────────────────────────────────────────
  Rock_Flow: 'ash',
  Obsidian: 'ash',
  Char_Black: 'ash',
  Tar_Black: 'ash',
  // ── living wood ───────────────────────────────────────────────────────
  Trunk_Palm: 'bark',
  Coconut: 'bark',
  Wood_Bleached: 'bark',
  // ── worked wood ───────────────────────────────────────────────────────
  Wood_Dark: 'plank',
  Wood_Light: 'plank',
  Wood_Mid: 'plank',
  Wood_Wet: 'plank',
  Timber: 'plank',
  Shingle: 'plank',
  Shingle_Lt: 'plank',
  Ochre_Paint: 'plank',
  Keg_Red: 'plank',
  // ── cloth and cordage ─────────────────────────────────────────────────
  Canvas: 'canvas',
  Canvas_Dirty: 'canvas',
  Cloth: 'canvas',
  Awning_Cream: 'canvas',
  Awning_Red: 'canvas',
  Flag_Fin: 'canvas',
  Flag_Rival: 'canvas',
  Flag_White: 'canvas',
  Rope: 'canvas',
  // ── metal ─────────────────────────────────────────────────────────────
  Metal_Band: 'iron',
  Metal_Iron: 'iron',
  Rust: 'iron',
  Copper: 'iron',
  Verdigris: 'iron',
  // ── refusals: organic, glass, glow, precious ──────────────────────────
  Beak_Yellow: 'flat',
  Berry_Red: 'flat',
  Bone: 'flat',
  Bone_Shadow: 'flat',
  Bone_White: 'flat',
  Bottle_Green: 'flat',
  Candle_Wax: 'flat',
  Comb_Red: 'flat',
  Coral: 'flat',
  Coral_Pink: 'flat',
  Crab_Dark: 'flat',
  Crab_Red: 'flat',
  Crow_Black: 'flat',
  Crystal_Glow: 'flat',
  Ember: 'flat',
  Eye_Black: 'flat',
  Feather_Black: 'flat',
  Flame_Glow: 'flat',
  GlassWarm: 'flat',
  Glass_Dead: 'flat',
  'Glass_Flame.001': 'flat',
  Gold: 'flat',
  Gull_Dark: 'flat',
  Gull_Grey: 'flat',
  Gull_White: 'flat',
  Hair: 'flat',
  Hen_Brown: 'flat',
  Hen_Cream: 'flat',
  Hoof_Dark: 'flat',
  Kraken_Flesh: 'flat',
  Kraken_Sucker: 'flat',
  Lantern_Glass: 'flat',
  Leather: 'flat',
  Mouth_Red: 'flat',
  Pig_Pink: 'flat',
  Pig_Snout: 'flat',
  Shark_Belly: 'flat',
  Shark_Dark: 'flat',
  Shark_Grey: 'flat',
  Shell_Pearl: 'flat',
  Skin: 'flat',
  TeamTint: 'flat',
  Teeth_White: 'flat',
};

/** Per-vertex detail family index (0..8). Optional, and only baked when a
 *  caller asks: nothing samples the detail array yet, and an attribute nobody
 *  reads is bytes on a low-tier GPU for no picture. */
export const FAMILY_ATTRIBUTE = 'aFamily';

/**
 * The family for a material name, or null when the table has never heard of it.
 *
 * Null rather than `'flat'` so the coverage gate can tell "deliberately plain"
 * from "nobody classified this yet" — the second is a bug and the first is a
 * decision. The `.001` second chance is Blender's duplicate suffix, which the
 * exporter keeps (`Glass_Flame.001` ships today); the exact row still wins, so
 * a deliberately-suffixed row is never shadowed by its base name.
 */
export function familyForMaterialName(name: string | undefined | null): DetailFamily | null {
  if (!name) return null;
  const exact = MATERIAL_FAMILIES[name];
  if (exact) return exact;
  const dedupe = /^(.*)\.\d{3}$/.exec(name);
  if (dedupe) return MATERIAL_FAMILIES[dedupe[1]] ?? null;
  return null;
}

/** The number the attribute carries. An unclassified material bakes 0 (`flat`),
 *  which draws exactly what it draws today — the gate, not the shader, is what
 *  refuses to ship one. */
export function familyIndexForMaterialName(name: string | undefined | null): number {
  const family = familyForMaterialName(name);
  return family ? DETAIL_FAMILIES.indexOf(family) : 0;
}

/** Program cache keys this file can produce — the warm-up and the program
 *  census both want them by name rather than by reconstruction. */
export const COLLAPSE_CACHE_KEY_TINTED = 'pirates-asset-collapse-tinted';
export const COLLAPSE_CACHE_KEY_PLAIN = 'pirates-asset-collapse-plain';

/**
 * The single material an asset's material array collapses to.
 *
 * With `bakedTint` (the default) the shader reads the per-vertex tint and
 * surface and IGNORES `color`, `roughness` and `metalness`; those stay at their
 * neutral values so that a reader of the material is not misled about what is
 * on screen. Without it the class is a plain `MeshStandardMaterial` that merely
 * carries a stable cache key — the form a caller wants when it is recolouring
 * the whole mesh itself.
 */
export class CollapsedAssetMaterial extends THREE.MeshStandardMaterial {
  /** True while the baked attributes are what decides colour and surface. */
  bakedTint = true;

  constructor(parameters?: THREE.MeshStandardMaterialParameters) {
    super(parameters);
    this.installCollapsePatch();
  }

  copy(source: this): this {
    super.copy(source);
    this.bakedTint = source.bakedTint;
    // super.copy() does not carry either hook; the constructor already installed
    // them on `this`, and they read `this.bakedTint`, so they are correct now.
    return this;
  }

  /**
   * Install the GLSL patch and the cache key.
   *
   * Both close over `this` rather than over a captured boolean, so flipping
   * `bakedTint` before first draw is coherent — the key and the source agree
   * because they read the same field at the same moment. Flipping it AFTER a
   * program exists needs `needsUpdate = true`, same as any other material state.
   */
  private installCollapsePatch(): void {
    this.customProgramCacheKey = () => (
      this.bakedTint ? COLLAPSE_CACHE_KEY_TINTED : COLLAPSE_CACHE_KEY_PLAIN
    );
    this.onBeforeCompile = (shader) => {
      if (!this.bakedTint) return;
      shader.vertexShader = `attribute vec3 ${TINT_ATTRIBUTE};
attribute vec2 ${SURFACE_ATTRIBUTE};
attribute vec3 ${EMISSIVE_ATTRIBUTE};
varying vec3 vAssetTint;
varying vec2 vAssetSurface;
varying vec3 vAssetEmissive;
` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Complement in, colour out — see trap 1. Smoothness in, roughness out,
        // for the same reason: an all-zero read has to be the boring answer.
        vAssetTint = 1.0 - ${TINT_ATTRIBUTE};
        vAssetSurface = vec2(1.0 - ${SURFACE_ATTRIBUTE}.x, ${SURFACE_ATTRIBUTE}.y);
        // Straight, not complemented: black already means "does not glow", and
        // a geometry with no lit chunk ships no buffer for this at all.
        vAssetEmissive = ${EMISSIVE_ATTRIBUTE};`,
      );
      shader.fragmentShader = `varying vec3 vAssetTint;
varying vec2 vAssetSurface;
varying vec3 vAssetEmissive;
` + shader.fragmentShader
        // AFTER <color_fragment>, which is where three multiplies COLOR_0 in.
        // The two are independent: COLOR_0 is Blender's baked AO and this is the
        // material's flat colour, and the product is what the array of materials
        // drew before, term for term.
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n\tdiffuseColor.rgb *= vAssetTint;',
        )
        // These two chunks are exactly `float roughnessFactor = roughness;` and
        // `float metalnessFactor = metalness;` (no map is involved anywhere in
        // this game's assets), so assigning over them is the whole substitution.
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\troughnessFactor = vAssetSurface.x;',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\n\tmetalnessFactor = vAssetSurface.y;',
        )
        // `totalEmissiveRadiance` starts as the `emissive` uniform (which three
        // has already multiplied by `emissiveIntensity`) and <emissivemap_fragment>
        // is the last thing to touch it before it is added to outgoingLight. The
        // collapsed material's own emissive is black, so this ASSIGNS rather than
        // adds: the attribute is the whole answer, per chunk, for every lantern
        // pane and ember in one draw.
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = vAssetEmissive;',
        );
    };
  }
}

/** A chunk of a collapsed geometry: which vertices, and the material they had. */
export type CollapseChunk = {
  /** First vertex of the range in the merged geometry. */
  readonly start: number;
  /** How many vertices. */
  readonly count: number;
  readonly material: THREE.Material;
};

/**
 * Which material fields this collapse can carry. Anything else differing
 * between an asset's materials means the collapse would change the picture, and
 * the caller must be told rather than shipped a wrong-looking prop.
 *
 * Exported because `scripts/test-asset-merge.mjs` asserts the shipped GLBs stay
 * inside it — the day an artist adds a texture or a transparent material to an
 * asset, that gate fails instead of the asset silently losing it.
 */
export function collapseBlockers(materials: readonly THREE.Material[]): string[] {
  const blockers: string[] = [];
  const std = materials.filter((m): m is THREE.MeshStandardMaterial => (
    (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
  ));
  if (std.length !== materials.length) {
    blockers.push(`${materials.length - std.length} material(s) are not MeshStandardMaterial`);
    return blockers;
  }
  const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap'] as const;
  for (const m of std) {
    for (const key of maps) {
      if (m[key]) blockers.push(`${m.name || '(unnamed)'} has a ${key}`);
    }
    // NO EMISSIVE BLOCKER. A glow used to refuse the collapse outright, which
    // cost `lantern_post` — on every dock and every trail — three draws a copy,
    // and `campfire` five, for one `Ember` sub-material. It is now a third baked
    // attribute (`EMISSIVE_ATTRIBUTE`), so it costs a vec3 per vertex on the 9
    // GLBs that have one and nothing at all on the other 54. `emissiveMap` is
    // still blocked above: a texture needs UVs the collapse does not reconcile.
  }
  // Everything below is a per-DRAW state that no vertex attribute can express.
  const uniform = <T>(read: (m: THREE.MeshStandardMaterial) => T, label: string) => {
    const first = read(std[0]);
    if (std.some((m) => read(m) !== first)) blockers.push(`${label} differs between materials`);
  };
  uniform((m) => m.side, 'side');
  uniform((m) => m.flatShading, 'flatShading');
  uniform((m) => m.vertexColors, 'vertexColors');
  uniform((m) => m.transparent, 'transparent');
  uniform((m) => m.opacity, 'opacity');
  uniform((m) => m.alphaTest, 'alphaTest');
  uniform((m) => m.depthWrite, 'depthWrite');
  uniform((m) => m.depthTest, 'depthTest');
  uniform((m) => m.blending, 'blending');
  uniform((m) => m.wireframe, 'wireframe');
  uniform((m) => m.toneMapped, 'toneMapped');
  return blockers;
}

/**
 * THE KEY TWO MATERIALS MUST SHARE TO BE FOLDED INTO ONE DRAW — or null when a
 * material must keep its own identity.
 *
 * Everything in the returned string is a per-DRAW state that no vertex
 * attribute can express: which face is culled, whether the normal is flat,
 * whether the thing blends. Colour, roughness and metalness are deliberately
 * NOT in it — carrying those is the entire point.
 *
 * The three refusals are the safety argument for using this as a merge key:
 *
 *   * NOT A STANDARD MATERIAL. Nothing else has the uniforms this patch writes.
 *   * A MAP OR AN EMISSIVE. A texture needs UVs the merge does not reconcile,
 *     and a lit material's glow is not a diffuse tint. Nine of the sixty-three
 *     GLBs are refused here for `Ember`, `Lantern_Glass`, `Candle_Wax`.
 *   * A MATERIAL SOMEONE HAS PATCHED. `onBeforeCompile` or a non-empty
 *     `customProgramCacheKey` means a system elsewhere is writing this material's
 *     shader — the cave rock, the terrain feature rock, the waterfall, the story
 *     pad, the foliage sway. Folding one of those onto a fresh material would
 *     drop the patch silently, which is cost-model §12.4 trap 3 arriving from
 *     the other direction. Its identity is load-bearing, so it keeps it.
 */
export function collapseFamilyKey(material: THREE.Material): string | null {
  const m = material as THREE.MeshStandardMaterial;
  if (m.isMeshStandardMaterial !== true) return null;
  if (collapseBlockers([m]).length > 0) return null;
  // BOTH TESTS ARE IDENTITY TESTS, and the second one has to be. three r160's
  // DEFAULT `customProgramCacheKey()` returns `this.onBeforeCompile.toString()`
  // — so "the key is empty" is never true, not even for a material nobody has
  // touched, and testing for it rejected every clean material in the game. What
  // is being asked is "has anyone replaced these", so ask that.
  if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  if (m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) return null;
  return `collapse|${m.type}|${m.side}|${m.flatShading ? 'F' : '-'}|${m.vertexColors ? 'V' : '-'}`
    + `|${m.transparent ? 'T' : '-'}|${m.opacity}|${m.alphaTest}|${m.depthWrite ? 'W' : '-'}`
    + `|${m.depthTest ? 'D' : '-'}|${m.blending}|${m.wireframe ? 'w' : '-'}|${m.toneMapped ? 'M' : '-'}`;
}

/** Knobs the collapse takes. Everything here is OFF by default: the collapse
 *  is on the boot path of every asset and a new buffer it allocates is paid by
 *  every player, tier or no tier. */
export type CollapseOptions = {
  /**
   * Also bake `aFamily` (one float per vertex, 4 bytes).
   *
   * Off until a consumer exists. The triplanar detail sets (TEX-01 phase 0,
   * `rendering/DetailSets.ts`) are what will read it; until that ships, turning
   * this on would upload ~330 KB of attribute across the shipped library for a
   * picture that does not change, which is exactly the kind of free-seeming
   * cost the low tier cannot afford. The family of every chunk is decided and
   * gated regardless (`familyForMaterialName`), so switching this on is a flag,
   * not a re-derivation.
   */
   readonly bakeFamily?: boolean;
};

/**
 * Bake each chunk's colour/roughness/metalness into per-vertex attributes and
 * return the ONE material that draws the lot.
 *
 * `geometry` is mutated: it gains `aTintComp` and `aSurface` and loses its
 * groups, because with a single material three ignores groups and a leftover
 * group list only misleads the next reader. Returns null when the materials are
 * not collapsible, in which case the caller must keep the array — no silent
 * approximation.
 */
export function collapseChunks(
  geometry: THREE.BufferGeometry,
  chunks: readonly CollapseChunk[],
  options: CollapseOptions = {},
): CollapsedAssetMaterial | null {
  const materials = chunks.map((c) => c.material);
  if (materials.length === 0) return null;
  if (collapseBlockers(materials).length > 0) return null;
  const position = geometry.getAttribute('position');
  if (!position) return null;

  const vertices = position.count;
  const tint = new Float32Array(vertices * 3);
  const surface = new Float32Array(vertices * 2);
  // Allocated only if something actually glows — see EMISSIVE_ATTRIBUTE.
  let emissive: Float32Array | null = null;
  // Default is the identity for both, so a vertex no chunk covers — which the
  // gate forbids, but which a future edit could reintroduce — is untinted and
  // fully rough rather than black and mirrored.
  for (let i = 0; i < vertices; i++) {
    surface[i * 2] = 0;
    surface[i * 2 + 1] = 0;
  }
  for (const chunk of chunks) {
    const m = chunk.material as THREE.MeshStandardMaterial;
    const cr = 1 - m.color.r;
    const cg = 1 - m.color.g;
    const cb = 1 - m.color.b;
    const smoothness = 1 - m.roughness;
    const metal = m.metalness;
    // three folds emissiveIntensity into the `emissive` uniform, so the baked
    // value has to carry it too or a dimmed ember comes back at full strength.
    const intensity = m.emissiveIntensity ?? 1;
    const er = m.emissive ? m.emissive.r * intensity : 0;
    const eg = m.emissive ? m.emissive.g * intensity : 0;
    const eb = m.emissive ? m.emissive.b * intensity : 0;
    const lit = er !== 0 || eg !== 0 || eb !== 0;
    if (lit && !emissive) emissive = new Float32Array(vertices * 3);
    const end = Math.min(vertices, chunk.start + chunk.count);
    for (let i = chunk.start; i < end; i++) {
      tint[i * 3] = cr;
      tint[i * 3 + 1] = cg;
      tint[i * 3 + 2] = cb;
      surface[i * 2] = smoothness;
      surface[i * 2 + 1] = metal;
    }
    if (lit) {
      for (let i = chunk.start; i < end; i++) {
        emissive![i * 3] = er;
        emissive![i * 3 + 1] = eg;
        emissive![i * 3 + 2] = eb;
      }
    }
  }
  geometry.setAttribute(TINT_ATTRIBUTE, new THREE.BufferAttribute(tint, 3));
  geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(surface, 2));
  if (emissive) geometry.setAttribute(EMISSIVE_ATTRIBUTE, new THREE.BufferAttribute(emissive, 3));
  else geometry.deleteAttribute(EMISSIVE_ATTRIBUTE);
  if (options.bakeFamily) {
    const family = new Float32Array(vertices);
    for (const chunk of chunks) {
      const index = familyIndexForMaterialName((chunk.material as THREE.Material).name);
      if (index === 0) continue; // 0 is the default the array already holds.
      const end = Math.min(vertices, chunk.start + chunk.count);
      for (let i = chunk.start; i < end; i++) family[i] = index;
    }
    geometry.setAttribute(FAMILY_ATTRIBUTE, new THREE.BufferAttribute(family, 1));
  } else {
    // Never leave a stale one behind on a geometry the library re-collapses.
    geometry.deleteAttribute(FAMILY_ATTRIBUTE);
  }
  geometry.clearGroups();

  const sample = materials[0] as THREE.MeshStandardMaterial;
  const collapsed = new CollapsedAssetMaterial({
    // Neutral: the shader reads the tint and the surface, and leaving these at
    // their defaults means anything that PRINTS the material cannot claim a
    // colour the asset does not have.
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    vertexColors: sample.vertexColors,
    flatShading: sample.flatShading,
    side: sample.side,
    transparent: sample.transparent,
    opacity: sample.opacity,
    alphaTest: sample.alphaTest,
    depthWrite: sample.depthWrite,
    depthTest: sample.depthTest,
    toneMapped: sample.toneMapped,
    // Black, because the glow is per-vertex now. A non-zero uniform here would
    // be added to every vertex of the asset, lit or not.
    emissive: 0x000000,
  });
  collapsed.name = `${sample.name || 'asset'}+${materials.length - 1}`;
  return collapsed;
}
