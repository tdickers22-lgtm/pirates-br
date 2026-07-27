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
 *
 * It lives in `shared/` rather than `client/ui/` because the SERVER authors a
 * rendered surface too: the island cast's names and spoken lines are written in
 * MapGenerator and go over the wire onto nameplates and cutscene cards. When a
 * proper noun lived client-side only, the server quietly hardcoded its own copy
 * — which is exactly how the Reach ended up with two spellings of one crew.
 */
import { WEAPONS } from './constants/index.js';
import type { ShipType, WeaponId } from './types/index.js';

/** The archipelago. Same seed, same isles, every match. */
export const WORLD_NAME = 'The Shattered Reach';
/** What a sailor actually calls it once he lives here. */
export const WORLD_NAME_SHORT = 'The Reach';
/** Mid-sentence form ("…looses you on the Shattered Reach"). */
export const WORLD_NAME_MID = 'the Shattered Reach';
/** The black pennant every crew in the Reach flies — and the brand burned into
 *  the wreckers' salvage crates on the Crooked Atoll. */
export const FLEET_PENNANT = 'the Black Fin';
/** 'the Black Fin' read attributively — "a Black Fin pennant", "the Black Fin
 *  brand". Derived, never spelled out, so this module stays the ONE place the
 *  crew is named — including in the cast lines the server writes. */
export const FLEET_PENNANT_ADJ = FLEET_PENNANT.replace(/^the\s+/i, '');

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
 * Player-facing name of a weapon (kill feed, damage numbers, hit lines, the
 * supply wheel).
 *
 * This used to consult an override table that shadowed two entries of WEAPONS —
 * so the armoury carried "Sniper Rifle" and "Flintknock Pistol" forever, one
 * careless `WEAPONS[id].name` away from putting them back on screen. The Reach's
 * names now live in the table itself and this is a plain lookup: there is only
 * one string per weapon in the whole codebase.
 */
export function weaponDisplayName(id: WeaponId | string): string {
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
