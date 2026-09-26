/**
 * WHO THIS PIRATE LOOKS LIKE (b3.2f, characters-02 / characters-03 / vm:characters:7).
 *
 * Pure: no three.js, no DOM, no rng. Every client computes the same look for the
 * same playerId (and crew), across reconnects, with zero wire bytes. The runtime
 * (PlayerRigFactory) turns a PirateLook into "which nodes of pirate_base_<body>
 * stay visible" plus a skin tone / eye / hair tint on the shared material.
 *
 * The catalogue below is the node set of the CC0 v2 bodies
 * (assets-src/quaternius/out/pirate_base_{male,female,stout}.glb, b3.2a-d);
 * test-character-variants proves every node this module can emit exists in the
 * body it is emitted for, so an asset rebuild that renames a slot fails there,
 * not as an invisible pirate in a match.
 *
 * Rules (PLAN section 3 characters target spec):
 *  - no two pirates in one crew share head + hat + coat (lookKey);
 *  - captain = tricorn or bicorn + the long frock coat, and the frock coat is
 *    the captain's alone, so the captain reads at 40 m;
 *  - every outfit wears the linen shirt (R2 F2: no bare chests under a vest);
 *  - a hat always takes the hat-safe hair cut (hair_<style>_hat), never the
 *    full style (the full styles poke through the crown, b3.2c negative control);
 *  - bots dress to their personality (archetype), players get the full wardrobe;
 *  - the crew colour arrives only through the mask channel (sash, bandana,
 *    coat trim) handled by the material, never by this picker.
 */

export type BodyType = 'male' | 'female' | 'stout';
export type HatSlot = 'hat_tricorn' | 'hat_bicorn' | 'hat_bandana' | 'hat_headscarf' | null;
/** The outer layer over the shirt. 'shirt' = shirt only. */
export type CoatSlot = 'coat_frock' | 'coat_jacket' | 'vest_waistcoat' | 'shirt';
export type LowerSlot = 'breeches_knee' | 'breeches_slops';
export type BootSlot = 'boots_tall' | 'boots_shoes';
export type WaistSlot = 'sash' | 'belt' | null;
export type Accessory = 'acc_earring' | 'acc_eyepatch';
export type CharacterRole = 'crew' | 'captain' | 'raider';
/** Mirrors BOT_PERSONALITIES names (src/server/systems/bots/personalities.ts);
 *  test-character-variants fails if the two lists drift. */
export type CharacterArchetype = 'merchant' | 'hunter' | 'corsair' | 'coward' | 'wrecker';

export interface PirateLook {
  body: BodyType;
  /** Hair style name without prefix/suffix, e.g. 'long'. */
  hairStyle: string;
  beard: boolean;
  hat: HatSlot;
  coat: CoatSlot;
  lower: LowerSlot;
  boots: BootSlot;
  waist: WaistSlot;
  accessories: Accessory[];
  /** Index into SKIN_TONES / EYE_COLOURS / HAIR_TINTS. */
  skinTone: number;
  eyeColour: number;
  hairTint: number;
  /** Every mesh node of pirate_base_<body> that stays visible, besides
   *  body / eyes / brows which are always on. */
  nodes: string[];
  /** head + hat + coat: unique within a crew. */
  key: string;
}

export interface CrewMember {
  id: string;
  role: CharacterRole;
  archetype?: CharacterArchetype | null;
}

export const BODY_TYPES: readonly BodyType[] = ['male', 'female', 'stout'];

/** Head hair per body, as it exists in the GLB (hair_<style> + hair_<style>_hat). */
export const HAIR_STYLES: Readonly<Record<BodyType, readonly string[]>> = {
  male: ['simpleparted', 'long', 'buzzed'],
  female: ['buns', 'long', 'buzzedfemale'],
  stout: ['buzzed', 'simpleparted'],
};
/** Bodies that carry a beard card (hair_beard, no hat cut: it is facial). */
export const BEARD_BODIES: ReadonlySet<BodyType> = new Set<BodyType>(['male', 'stout']);

export const HATS: readonly HatSlot[] = ['hat_tricorn', 'hat_bicorn', 'hat_bandana', 'hat_headscarf', null];
export const CAPTAIN_HATS: readonly HatSlot[] = ['hat_tricorn', 'hat_bicorn'];
export const CREW_COATS: readonly CoatSlot[] = ['coat_jacket', 'vest_waistcoat', 'shirt'];
export const LOWERS: readonly LowerSlot[] = ['breeches_knee', 'breeches_slops'];
export const BOOTS: readonly BootSlot[] = ['boots_tall', 'boots_shoes'];
export const WAISTS: readonly WaistSlot[] = ['sash', 'belt', null];

/** sRGB, linearised by the material. Pale to deep, evenly spaced in lightness. */
export const SKIN_TONES: readonly number[] = [0xf1d3bc, 0xe0b193, 0xc68c67, 0xa56b47, 0x7c4a2e, 0x55311d];
export const EYE_COLOURS: readonly number[] = [0x4a2f1b, 0x6b5a2e, 0x3f6b8c, 0x4d6f45];
/** Multiplied into the hair baseColorFactor (hair ships dark, HAIR_TINT in _pirate_import.py). */
export const HAIR_TINTS: readonly number[] = [0x1a1410, 0x3b2616, 0x6a4424, 0x9a6a3a, 0x8a3a1c, 0x8c8c86];

/** What a bot of each personality prefers to wear. Every list is non-empty and
 *  a subset of the full wardrobe; the captain rule still wins over this. */
export const ARCHETYPE_WARDROBE: Readonly<Record<CharacterArchetype, {
  hats: readonly HatSlot[]; coats: readonly CoatSlot[]; lowers: readonly LowerSlot[];
  boots: readonly BootSlot[]; waists: readonly WaistSlot[]; accessories: readonly Accessory[];
}>> = {
  // prosperous traders: waistcoats, knee breeches, buckled shoes
  merchant: { hats: ['hat_tricorn', null], coats: ['vest_waistcoat', 'coat_jacket'], lowers: ['breeches_knee'],
    boots: ['boots_shoes'], waists: ['sash', 'belt'], accessories: ['acc_earring'] },
  // hunters dress for the chase: jacket, tall boots
  hunter: { hats: ['hat_tricorn', 'hat_bandana'], coats: ['coat_jacket', 'vest_waistcoat'], lowers: ['breeches_knee', 'breeches_slops'],
    boots: ['boots_tall'], waists: ['belt'], accessories: [] },
  // corsairs: headscarves, bare shirts, jewellery
  corsair: { hats: ['hat_headscarf', 'hat_bandana'], coats: ['shirt', 'vest_waistcoat'], lowers: ['breeches_slops'],
    boots: ['boots_shoes', 'boots_tall'], waists: ['sash'], accessories: ['acc_earring', 'acc_eyepatch'] },
  // cowards: plain deck clothes, nothing to draw fire
  coward: { hats: ['hat_bandana', null], coats: ['shirt', 'coat_jacket'], lowers: ['breeches_slops'],
    boots: ['boots_shoes'], waists: ['belt', null], accessories: [] },
  // wreckers: scarred, patched, heavy boots
  wrecker: { hats: ['hat_headscarf', null], coats: ['coat_jacket', 'shirt'], lowers: ['breeches_slops'],
    boots: ['boots_tall'], waists: ['belt'], accessories: ['acc_eyepatch'] },
};

/** FNV-1a over the id: the same hash the legacy picker used. */
export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Independent draw number `salt` from one hash (murmur3 finaliser). */
function draw(h: number, salt: number, n: number): number {
  let x = (h ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) % n;
}

function pick<T>(list: readonly T[], h: number, salt: number): T {
  return list[draw(h, salt, list.length)];
}

/** The look of one pirate on her own, before crew de-duplication. `reroll`
 *  re-seeds the head/hat/coat draws only (the crew resolver's probe). */
export function pickLook(
  playerId: string,
  role: CharacterRole = 'crew',
  archetype: CharacterArchetype | null = null,
  reroll = 0,
): PirateLook {
  const h = hashId(playerId);
  const hr = reroll === 0 ? h : hashId(`${playerId}#${reroll}`);
  const w = archetype ? ARCHETYPE_WARDROBE[archetype] : null;
  const captain = role === 'captain';

  const body = pick(BODY_TYPES, hr, 0);
  const hairStyle = pick(HAIR_STYLES[body], hr, 1);
  const beard = BEARD_BODIES.has(body) && draw(hr, 2, 5) < 3; // ~60 % of beard-capable bodies
  const hat = captain ? pick(CAPTAIN_HATS, hr, 3) : pick(w ? w.hats : HATS, hr, 3);
  const coat: CoatSlot = captain ? 'coat_frock' : pick(w ? w.coats : CREW_COATS, hr, 4);
  const lower = captain ? 'breeches_knee' : pick(w ? w.lowers : LOWERS, h, 5);
  const boots = captain ? 'boots_tall' : pick(w ? w.boots : BOOTS, h, 6);
  const waist: WaistSlot = captain ? 'sash' : pick(w ? w.waists : WAISTS, h, 7);
  const accPool: readonly Accessory[] = w ? w.accessories : ['acc_earring', 'acc_eyepatch'];
  const accessories: Accessory[] = [];
  for (let i = 0; i < accPool.length; i++) {
    // players: each accessory ~1 in 5; an archetype that lists it: ~1 in 2
    if (draw(h, 8 + i, w ? 2 : 5) === 0) accessories.push(accPool[i]);
  }
  const skinTone = draw(h, 12, SKIN_TONES.length);
  const eyeColour = draw(h, 13, EYE_COLOURS.length);
  const hairTint = draw(hr, 14, HAIR_TINTS.length);

  const nodes: string[] = ['shirt_linen'];
  nodes.push(hat ? `hair_${hairStyle}_hat` : `hair_${hairStyle}`);
  if (beard) nodes.push('hair_beard');
  if (hat) nodes.push(hat);
  if (coat === 'coat_frock') nodes.push('coat_frock', 'vest_waistcoat'); // the captain's coat is worn over a waistcoat
  else if (coat !== 'shirt') nodes.push(coat);
  nodes.push(lower, boots);
  if (waist) nodes.push(waist);
  nodes.push(...accessories);

  const key = `${body}/${hairStyle}/${beard ? 'b' : '-'}/${hairTint}|${hat ?? 'bare'}|${coat}`;
  return { body, hairStyle, beard, hat, coat, lower, boots, waist, accessories, skinTone, eyeColour, hairTint, nodes, key };
}

/** Probe budget for the de-duplicator; a crew is at most 4, the key space is
 *  hundreds wide, so 32 is never reached in practice (the gate proves it). */
const MAX_REROLL = 32;

/**
 * Looks for a whole crew: no two members share head + hat + coat. Deterministic
 * in the SET of members (input order does not matter): members are resolved in
 * id order and a later member whose key is taken re-rolls her head/hat/coat
 * draws (`#1`, `#2`, ...) until it is free. Body-independent slots (boots,
 * skin tone, ...) never re-roll, so a pirate keeps most of her look.
 */
export function pickCrewLooks(members: readonly CrewMember[]): Map<string, PirateLook> {
  const out = new Map<string, PirateLook>();
  const taken = new Set<string>();
  const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of sorted) {
    let look = pickLook(m.id, m.role, m.archetype ?? null, 0);
    for (let r = 1; taken.has(look.key) && r <= MAX_REROLL; r++) {
      look = pickLook(m.id, m.role, m.archetype ?? null, r);
    }
    taken.add(look.key);
    out.set(m.id, look);
  }
  return out;
}

/**
 * MIXER LOD (PLAN b3.2f): full rate inside 15 m, 15 Hz inside 40 m, 5 Hz
 * beyond. Returns the minimum seconds between mixer steps for a camera
 * distance SQUARED (the caller already has it). Never Infinity: a far pirate
 * still walks at 5 Hz instead of sliding in a frozen pose.
 */
export function mixerIntervalFor(cameraDistSq: number): number {
  if (cameraDistSq < 15 * 15) return 0;
  if (cameraDistSq < 40 * 40) return 1 / 15;
  return 1 / 5;
}
