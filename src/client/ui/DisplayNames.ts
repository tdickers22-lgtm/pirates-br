/**
 * The Reach's own vocabulary — DISPLAY LAYER ONLY.
 *
 * Wire ids, save keys, SHIP_STATS/WEAPONS/ItemType keys and every
 * test-asserted identifier keep the names they were born with
 * (`sloop`, `banana`, `gold_hoarder`, …). This module is the single place the
 * player-facing nouns live, so the world can be renamed end to end without a
 * single id, packet field or physics constant moving.
 *
 * The lore it speaks is docs/ISLAND_STORY_BIBLE.md: the Shattered Reach, the
 * Black Fin brand on the wreckers' crates, gibbet law, and the Coinwrights who
 * weigh what comes out of the sand.
 */
import { WEAPONS } from '../../shared/constants/index.js';
import type { ShipType, WeaponId } from '../../shared/types/index.js';

/** The archipelago. Same seed, same isles, every match. */
export const WORLD_NAME = 'The Shattered Reach';
/** What a sailor actually calls it once he lives here. */
export const WORLD_NAME_SHORT = 'The Reach';
/** Mid-sentence form ("…looses you on the Shattered Reach"). */
export const WORLD_NAME_MID = 'the Shattered Reach';
/** The black pennant every crew in the Reach flies — and the brand burned into
 *  the wreckers' salvage crates on the Crooked Atoll. */
export const FLEET_PENNANT = 'the Black Fin';

/** The Coinwrights' broker ashore: he weighs the haul, tallies it, pays it,
 *  and is the only man in the Reach whose arithmetic nobody argues with. */
export const BROKER_NAME = 'Tallyman';
export const BROKER_NAME_PLURAL = 'Tallymen';
/** The guild behind the scales. */
export const BROKER_GUILD = 'the Coinwrights';

/**
 * Hull classes of the Reach. The keys are the wire/stat ids and never change;
 * only the right-hand side is ever shown to a player.
 */
export const SHIP_CLASS_NAMES: Record<ShipType, string> = {
  sloop: 'Cutter',
  brigantine: 'Corsair',
  galleon: "Man-o'-War",
};

/** Display name for a hull class, safe against an unknown/absent type. */
export function shipClassName(type: ShipType | string | null | undefined): string {
  if (!type) return 'Hull';
  return SHIP_CLASS_NAMES[type as ShipType] ?? 'Hull';
}

/**
 * Weapons whose player-facing name differs from WEAPONS[id].name. Overriding
 * here rather than in the shared table keeps the balance constants (and the
 * suites that read them) untouched by a vocabulary pass.
 */
const WEAPON_DISPLAY_NAMES: Partial<Record<WeaponId, string>> = {
  // The wreckers' long arm: a rifled barrel and a salvaged spyglass lashed
  // above it, first built on the Crooked Atoll to read a hull before it struck.
  eye_of_reach: "Wrecker's Glass",
  // Half a charge of powder behind a fist-sized ball — it hits like weather and
  // puts whoever catches it over the rail.
  flintknock: 'Squall Pistol',
};

/** Player-facing name of a weapon (kill feed, damage numbers, hit lines). */
export function weaponDisplayName(id: WeaponId | string): string {
  const override = WEAPON_DISPLAY_NAMES[id as WeaponId];
  if (override) return override;
  return WEAPONS[id as WeaponId]?.name ?? 'attack';
}

/** Weapon-slot tile name: the tiles are one line wide, so ' Pistol' is dropped. */
export function weaponSlotName(id: WeaponId | string): string {
  return weaponDisplayName(id).replace(' Pistol', '');
}

/**
 * Loot nouns whose display name differs from the prettified wire id. Anything
 * absent falls through to the generic `wood_plank` → "Wood Plank" treatment.
 */
const ITEM_DISPLAY_NAMES: Record<string, string> = {
  // Period sailors called the fruit a plantain long before anyone called it
  // anything else, and the Reach's provisioning never caught up.
  banana: 'Plantain',
};

/** Display name for a loot/pocket item id. */
export function itemDisplayName(item: string): string {
  const override = ITEM_DISPLAY_NAMES[item];
  if (override) return override;
  return item.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
