import * as THREE from 'three';

/**
 * Shipped-GLB material audit — the net under the "featureless black prop"
 * family (gibbet cages, watchtower cabins, door/window panels, hanging
 * lanterns, iron fittings all rendering as flat black boxes at noon).
 *
 * Two authoring habits produce it, and neither is visible in Blender:
 *
 *  1. **Near-black albedo.** `Char_Black` & friends are authored around
 *     0.03–0.05 linear. Blender's viewport lifts them; the game's AgX tonemap
 *     has a hard toe, and once the baked vertex AO (floor 0.55) multiplies in,
 *     anything under ~0.08 lands on screen as pure black with no shading
 *     gradient at all — the surface stops reading as a surface.
 *  2. **High metalness with no environment map.** The scene has no PMREM /
 *     envMap (see Renderer): a `metalness: 0.9` surface therefore has its
 *     diffuse lobe multiplied out (`diffuse *= 1 - metalness`) and gets
 *     nothing back from an environment it can't sample. Iron lantern housings,
 *     cage straps and gold coins all collapse to black regardless of albedo.
 *
 * Both are corrected on load rather than per-GLB in Blender: it is one rule
 * over every asset (56 GLBs, ~300 materials) instead of 22 rebuilt binaries,
 * and it cannot drift back when a scene is next rebuilt.
 *
 * Pinned by scripts/test-material-floor.mjs, which runs the real AssetLibrary
 * over every shipped GLB.
 */

/** Linear max-channel floor. Below this the AgX toe + baked AO crush a surface flat. */
export const MIN_ALBEDO_VALUE = 0.08;

/** Ship-hull dark brown (0x2a1f14) — the darkest value the art direction reads
 *  as "an object in shadow" rather than "a hole in the world". Lifted materials
 *  are warmed toward it so char/tar/soot keep a wood-smoke cast. */
export const SHIP_HULL_DARK = Object.freeze({ r: 0x2a / 255, g: 0x1f / 255, b: 0x14 / 255 });

/** How far a lifted colour is pulled toward SHIP_HULL_DARK (0 = keep own hue). */
export const HULL_WARMTH = 0.5;

/** Metalness ceiling while the scene ships without an environment map. */
export const MAX_METALNESS_NO_ENV = 0.35;

/** Emissive gain for lantern glass so a lantern reads as a lantern in daylight
 *  (its housing is dark iron; without this the whole prop is a black box). */
export const LANTERN_EMISSIVE_MIN = 1.4;
const LANTERN_MATERIAL = /lantern/i;

const hull = new THREE.Color(SHIP_HULL_DARK.r, SHIP_HULL_DARK.g, SHIP_HULL_DARK.b);

/**
 * Normalise one shipped material in place. Returns true when anything changed
 * (used by the test to report which materials needed the floor).
 */
export function auditAssetMaterial(m: THREE.Material): boolean {
  if (!(m instanceof THREE.MeshStandardMaterial)) return false;
  let changed = false;

  const peak = Math.max(m.color.r, m.color.g, m.color.b);
  if (peak < MIN_ALBEDO_VALUE) {
    // Scale onto the floor first (keeps the authored hue ratio), then warm
    // toward ship-hull brown so a dozen different near-blacks land in the same
    // family instead of each picking up its own colour cast when lifted.
    m.color.multiplyScalar(MIN_ALBEDO_VALUE / Math.max(peak, 1e-4));
    m.color.lerp(hull, HULL_WARMTH);
    changed = true;
  }

  if (m.metalness > MAX_METALNESS_NO_ENV) {
    m.metalness = MAX_METALNESS_NO_ENV;
    changed = true;
  }

  if (LANTERN_MATERIAL.test(m.name) && m.emissive.getHex() !== 0
      && m.emissiveIntensity < LANTERN_EMISSIVE_MIN) {
    m.emissiveIntensity = LANTERN_EMISSIVE_MIN;
    changed = true;
  }

  if (changed) m.needsUpdate = true;
  return changed;
}
