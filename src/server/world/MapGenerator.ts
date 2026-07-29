import { v4 as uuid } from 'uuid';
import type {
  IslandBridge, IslandGeyser,
  Island, IslandBarrel, IslandBiome, IslandCave, IslandDock, IslandInlet, IslandNpc,
  IslandProfile, IslandProp, IslandPropType, IslandTavern, ItemType,
  TreasureChest, UpgradeStation, ShipUpgradeType, Vec3, Ship, WildlifeAnimal, WildlifeType, SeaRock,
  SeaPoi, SeaPoiKind,
} from '../../shared/types/index.js';
import {
  BERTH, SHIP, WORLD, SHIP_STATS, CHEST_LOOT_TABLE, BARREL_LOOT_TABLE, ECONOMY, WILDLIFE, SEA_ROCKS,
  SEA_POI, WRECK_EVENT, WRECK_SUPPLY_TABLE,
} from '../../shared/constants/index.js';
// The cast's names and spoken lines are a RENDERED SURFACE (nameplate, cutscene
// card, banner), so every proper noun in them comes from the display layer —
// the same module the client reads. Hardcoding "Black Fin" here is how the
// Reach ends up with two spellings of one crew.
import { BROKER_NAME, FLEET_PENNANT, FLEET_PENNANT_ADJ } from '../../shared/DisplayNames.js';
import {
  angleWrap,
  directionToYaw,
  buildSeaRockColliders,
  getIslandCoastWeights,
  getIslandMaxRadius,
  getIslandSurfacePoint,
  getIslandSurfaceY,
  mulberry32,
} from '../../shared/utils/index.js';
import { BIOME_PALETTES, getPropSpacingRadius } from '../../shared/props.js';

const SHIP_TYPES = ['sloop', 'brigantine', 'galleon'] as const;

// ── Seeded helpers (never Math.random — the whole map must be reproducible) ──
type Rng = () => number;
const rr = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
const ri = (rng: Rng, lo: number, hi: number) => Math.floor(rr(rng, lo, hi + 1));
const ra = (rng: Rng) => rng() * Math.PI * 2;
function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}
function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// ── Curated island roster ────────────────────────────────────────────────────
// Every named island has a FIXED archetype, biome, size and seed so its
// silhouette, coast bands, caves, stamps and props are identical every match —
// only world placement and rotation vary. Players learn the islands.
type LandmarkType =
  | 'watchtower' | 'shipwreck' | 'standing_stones' | 'fort'
  // Story scenes (docs/ISLAND_STORY_BIBLE.md) — one hero vignette per island.
  // Placed from a SEPARATE rng stream so adding them never reshuffled the
  // long-tuned placements drawn from islandRng (see planLandmarks).
  | 'smuggler_cache' | 'skull_totem' | 'wrecker_tower' | 'whale_skeleton'
  | 'rum_still' | 'crow_roost' | 'mermaid_shrine' | 'castaway_camp'
  | 'kraken_wreck' | 'dig_site' | 'gallows' | 'parley_table'
  | 'mine_head' | 'widow_memorial' | 'gibbet_cage';

interface RosterEntry {
  name: string;
  style: IslandProfile['terrainStyle'];
  biome: IslandBiome;
  seed: number;
  radius: number;
  /** -1 ⇒ nearly all beach … +1 ⇒ mostly cliff. */
  coastBias: number;
  landmarks: LandmarkType[];
  hasDock: boolean;
  hasTavern: boolean;
  /** Guaranteed inlet (cove/bay) — [widthLo, widthHi], [depthLo, depthHi]. */
  forcedInlet?: { width: [number, number]; depth: [number, number] };
  /** Bright white-sand beaches (postcard tropical isles). */
  whiteSand?: boolean;
  /** HAND-AUTHORED world placement — the map is a designed, fixed world
   *  ("The Shattered Reach"), identical every match. Players learn it. */
  layout: { x: number; z: number; rotation: number };
}

const ISLAND_ROSTER: readonly RosterEntry[] = [
  { name: "Smuggler's Rest", style: 'tropical', biome: 'lush', seed: 0x5310a11, radius: 66, coastBias: -0.25, whiteSand: true, landmarks: ['standing_stones', 'smuggler_cache'], hasDock: true, hasTavern: true, layout: { x: 40, z: 690, rotation: 2.7 } },
  { name: 'Skull Cove', style: 'rocky', biome: 'bone', seed: 0x2b0be5c, radius: 52, coastBias: 0.05, landmarks: ['shipwreck', 'skull_totem'], hasDock: true, hasTavern: false, forcedInlet: { width: [0.34, 0.46], depth: [0.3, 0.4] }, layout: { x: 700, z: -70, rotation: 4.4 } },
  { name: 'The Crooked Atoll', style: 'archipelago', biome: 'palm_atoll', seed: 0x3c400a7, radius: 70, coastBias: -0.55, whiteSand: true, landmarks: ['shipwreck', 'wrecker_tower'], hasDock: true, hasTavern: false, layout: { x: -588, z: 558, rotation: 2.4 } },
  { name: 'Dead Man Shoals', style: 'archipelago', biome: 'bone', seed: 0x4dead10, radius: 50, coastBias: -0.3, landmarks: ['shipwreck', 'whale_skeleton', 'gibbet_cage'], hasDock: false, hasTavern: false, layout: { x: 612, z: 592, rotation: 3.3 } },
  { name: 'Rumrunner Key', style: 'tropical', biome: 'palm_atoll', seed: 0x5b0b0b0, radius: 42, coastBias: -0.6, whiteSand: true, landmarks: ['shipwreck', 'rum_still'], hasDock: true, hasTavern: false, layout: { x: 640, z: 310, rotation: 0.9 } },
  { name: "Crow's Perch", style: 'mountain', biome: 'highland', seed: 0x6c0ffee, radius: 84, coastBias: 0.45, landmarks: ['watchtower', 'crow_roost'], hasDock: true, hasTavern: false, layout: { x: -278, z: 290, rotation: 3.9 } },
  { name: "Mermaid's Folly", style: 'crescent', biome: 'lush', seed: 0x7f01111, radius: 62, coastBias: -0.1, landmarks: ['standing_stones', 'mermaid_shrine'], hasDock: true, hasTavern: false, layout: { x: 372, z: 372, rotation: 1.2 } },
  { name: 'Castaway Reach', style: 'tropical', biome: 'lush', seed: 0x8beac42, radius: 88, coastBias: -0.35, landmarks: ['fort', 'shipwreck', 'castaway_camp'], hasDock: true, hasTavern: true, layout: { x: 420, z: -385, rotation: 5.6 } },
  { name: 'Kraken Tooth', style: 'twin', biome: 'volcanic', seed: 0x9707071, radius: 68, coastBias: 0.55, landmarks: ['watchtower', 'kraken_wreck'], hasDock: false, hasTavern: false, layout: { x: -705, z: 25, rotation: 5.1 } },
  { name: 'Booty Bay', style: 'crescent', biome: 'lush', seed: 0xab00713, radius: 90, coastBias: -0.2, landmarks: ['standing_stones', 'dig_site'], hasDock: true, hasTavern: true, layout: { x: -365, z: -295, rotation: 2.1 } },
  { name: 'Gallows Sands', style: 'rocky', biome: 'bone', seed: 0xb6a1105, radius: 38, coastBias: -0.15, landmarks: ['shipwreck', 'gallows', 'gibbet_cage'], hasDock: false, hasTavern: false, layout: { x: 646, z: -641, rotation: 0.6 } },
  { name: 'Parley Point', style: 'plateau', biome: 'highland', seed: 0xc9a41e4, radius: 58, coastBias: 0.2, landmarks: ['watchtower', 'parley_table'], hasDock: true, hasTavern: true, layout: { x: -10, z: -690, rotation: 0.3 } },
  { name: 'Old Maw Caldera', style: 'mountain', biome: 'volcanic', seed: 0xdca1de6, radius: 96, coastBias: 0.5, landmarks: ['watchtower', 'mine_head'], hasDock: true, hasTavern: false, layout: { x: 0, z: 0, rotation: 0.8 } },
  { name: "Widow's Watch", style: 'mountain', biome: 'highland', seed: 0xe51d0e7, radius: 70, coastBias: 0.35, landmarks: ['watchtower', 'standing_stones', 'widow_memorial'], hasDock: false, hasTavern: false, layout: { x: -592, z: -590, rotation: 1.7 } },
] as const;

// ── The cast of the Shattered Reach (docs/ISLAND_STORY_BIBLE.md) ───────────
// A hand-authored world deserves a hand-authored cast. Every speaker is keyed
// to their island's story scene, so the beat you walk into is the beat someone
// standing there will tell you — and no two islands share a name. Indexed by
// ROSTER ORDER, drawn from no rng at all, so island prop/loot streams (and
// test-world-fixed's signature) are untouched by anything in here.
//
// `line` is the LORE — the island's voice, spoken on first meeting. The
// teaching lines live client-side keyed by role (Game.ts NPC_ROLE_TIPS) and
// rotate in on later visits, so the tutorial still happens without the world
// repeating three tips through fourteen identical mouths.
interface CastEntry {
  name: string;
  cutsceneTitle: string;
  line: string;
}
interface IslandCast {
  storyteller: CastEntry & { role: 'mysterious_stranger' | 'shipwright' | 'oracle' };
  /** Only read on islands that actually host a tavern / a hoarder. */
  bartender?: CastEntry;
  hoarder?: CastEntry;
}

const NPC_CUES: Record<IslandNpc['role'], string> = {
  gold_hoarder: 'Sell carried chests here or take a treasure map.',
  bartender: 'Tavern: rest, restock, and listen for tales.',
  mysterious_stranger: 'Storm warnings now point to the nearest safe water.',
  shipwright: 'Island barrels are the fastest way to restock repairs.',
  oracle: 'Open the map near islands to inspect local details.',
};

const ISLAND_CAST: readonly IslandCast[] = [
  // 0 — Smuggler's Rest · the tavern is the front, the grove is the business
  {
    storyteller: {
      role: 'mysterious_stranger',
      name: 'Ines the Fence',
      cutsceneTitle: 'A Deal Under the Palms',
      line: 'Everyone lands here for the tavern. The tavern is the doorway. Walk past it, into the trees, and you will find what Smuggler\'s Rest actually sells.',
    },
    bartender: {
      name: 'Tavernkeeper Bess',
      cutsceneTitle: 'A Mug at the Counter',
      line: 'I pour honest rum to dishonest men. Whatever you saw under the tarps out in the grove — you were drinking here all evening, and so was I.',
    },
    hoarder: {
      name: `${BROKER_NAME} Darius`,
      cutsceneTitle: `The ${BROKER_NAME} at the Shore`,
      line: 'Sealed chests, not loose excuses. Half the Reach launders its luck across this beach, and I pay better than the crates in the trees.',
    },
  },
  // 1 — Skull Cove · trespassers were warned
  {
    storyteller: {
      role: 'oracle',
      name: 'Bone-Reader Ovid',
      cutsceneTitle: 'The Stone That Faces the Sea',
      line: 'That skull was cut to face the water so you would read it before your keel touched sand. You did not read it. Nobody ever does.',
    },
    hoarder: {
      name: `${BROKER_NAME} Nessa Trell`,
      cutsceneTitle: 'Coin in the Cove',
      line: 'The totem keeps the warning; I keep the scales. Bring me sealed chests and we are both honest in our way.',
    },
  },
  // 2 — The Crooked Atoll · the wreckers' false light
  {
    storyteller: {
      role: 'shipwright',
      name: 'Salvager Kellan Drage',
      cutsceneTitle: 'Cargo With Another Crew\'s Brand',
      line: `See that crooked tower? On a black night someone lights it, and a ship steers for a harbour that is not there. Half the crates at its foot still wear the ${FLEET_PENNANT_ADJ} brand.`,
    },
    hoarder: {
      name: `${BROKER_NAME} Piet Ostrow`,
      cutsceneTitle: 'Salvage Rates',
      line: 'Everything on this reef washed up wrong side out. Sealed chests I pay for. The rest of it I have already counted twice.',
    },
  },
  // 3 — Dead Man Shoals · even leviathans wash up here
  {
    storyteller: {
      role: 'oracle',
      name: 'Moraine the Bone-Reader',
      cutsceneTitle: 'The Ribs on the Waterline',
      line: `Walk in through those ribs and count what the tide left behind. If this sea can beach a leviathan it can beach you — and ${FLEET_PENNANT} hang whatever the water does not finish.`,
    },
  },
  // 4 — Rumrunner Key · business booming, quality questionable
  {
    storyteller: {
      role: 'mysterious_stranger',
      name: 'Sable Tam',
      cutsceneTitle: 'Three Fingers, No Questions',
      line: 'Every mug in the Reach begins in that copper pot. Do not ask what goes into it. Ask why the last man to taste it is buried behind the awning.',
    },
  },
  // 5 — Crow's Perch · the signal was never lit
  {
    storyteller: {
      role: 'mysterious_stranger',
      name: 'Hesper Vane, Last of the Watch',
      cutsceneTitle: 'The Pyre Nobody Lit',
      line: 'The pyre is still stacked, still dry, still waiting. The watch ran the night the fleet came through. The only thing keeping lookout up here now has feathers.',
    },
  },
  // 6 — Mermaid's Folly · she is owed
  {
    storyteller: {
      role: 'oracle',
      name: 'Shrinekeeper Calla Wren',
      cutsceneTitle: 'Leave Something at Her Feet',
      line: 'The candles are not thanks, they are payment. Men heard singing in this bay and swam for it. Leave a coin at her feet — she is owed, and she keeps accounts.',
    },
    hoarder: {
      name: `${BROKER_NAME} Lira Sarn`,
      cutsceneTitle: 'The Toll Collector',
      line: 'She takes offerings, I take chests. Only one of us gives change, and only one of us is still breathing.',
    },
  },
  // 7 — Castaway Reach · he counted the days, the raft was never finished
  {
    storyteller: {
      role: 'shipwright',
      name: 'Maeve the Shipwright',
      cutsceneTitle: 'The Raft That Was Never Finished',
      line: 'Down that beach is a board with four hundred marks cut into it, and a raft three planks short lying beside the man who ran out of days. Finish your work, sailor. That is the whole of this island.',
    },
    bartender: {
      name: 'Tavernkeeper Corin Ladd',
      cutsceneTitle: 'A Mug at the Counter',
      line: 'We named a whole reach after a man who sat under one palm until he stopped. Drink up, then go and do the opposite.',
    },
  },
  // 8 — Kraken Tooth · the kraken won, and left
  {
    storyteller: {
      role: 'shipwright',
      name: 'Harpooner Silas Threnn',
      cutsceneTitle: 'What Came Up Between the Teeth',
      line: 'It did not sink her. It held her between the teeth of this island until she stopped moving, then it let go. Our harpoons are still in the coil. It never came back for them.',
    },
  },
  // 9 — Booty Bay · the crew that dug it up didn't all leave
  {
    storyteller: {
      role: 'mysterious_stranger',
      name: 'Jessamy Crook',
      cutsceneTitle: 'Everyone\'s Map Says Here',
      line: `Every chart in the Reach marks this meadow, and one of them was right. Look at the pits: an empty chest, a ${FLEET_PENNANT_ADJ} pennant staked over the deepest hole, and one digger still in it with his hat over his face.`,
    },
    bartender: {
      name: 'Tavernkeeper Ruby Vann',
      cutsceneTitle: 'A Mug at the Counter',
      line: 'Diggers come in loud and go out quiet, and never the same number as arrived. Your coin spends the same either way.',
    },
  },
  // 10 — Gallows Sands · the tide brings everyone to justice
  {
    storyteller: {
      role: 'oracle',
      name: 'Gravedigger Ambrose Quill',
      cutsceneTitle: 'Boot Hill Above the Tideline',
      line: 'Two nooses, one cage, and a fresh mound I turned this morning. Nobody sails to Gallows Sands, sailor. The tide brings them.',
    },
  },
  // 11 — Parley Point · the only island where nobody died. Yet.
  {
    storyteller: {
      role: 'mysterious_stranger',
      name: 'Ondine Bask, Keeper of the Truce',
      cutsceneTitle: 'Steel in the Barrel',
      line: 'Captains meet at that table under a white flag, and every blade goes in the truce barrel first. In all the Shattered Reach this is the one stone nobody has bled on. Yet.',
    },
    bartender: {
      name: 'Tavernkeeper Ansel Poe',
      cutsceneTitle: 'A Mug at the Counter',
      line: 'House rules, same as the table on the plateau: no steel, no grudges, no names. Drink, then take your quarrel back out to sea.',
    },
  },
  // 12 — Old Maw Caldera · the mountain kept it
  {
    storyteller: {
      role: 'shipwright',
      name: 'Pitboss Garrow Finch',
      cutsceneTitle: 'The Cut in the Mountain',
      line: 'We cut black glass out of a mountain that was still breathing. Eleven went in on the last shift, the beams charred, and the Maw shut its mouth. The mountain kept the obsidian, and it kept them.',
    },
    hoarder: {
      name: `${BROKER_NAME} Halvard Bex`,
      cutsceneTitle: 'Black Glass and Gold',
      line: 'The mine takes; I only trade. Sealed chests for coin, and my charts point at the next mark — above ground, if you have any sense left.',
    },
  },
  // 13 — Widow's Watch · the light still burns; she doesn't
  {
    storyteller: {
      role: 'oracle',
      name: 'Old Salt Iona',
      cutsceneTitle: 'The Light on the Cliff',
      line: 'She climbed that cliff every night for a captain whose ship was already on the bottom. Forty years of lamp oil. The lantern still burns up there — she does not. Steer by it anyway; she would want the company.',
    },
  },
] as const;

// ── Rival crews of the Reach ────────────────────────────────────────────────
// The AI crews used to sail as Pirate_1 … Pirate_9 through a world where every
// barkeep, gravedigger and Tallyman has a full name and a grudge. These are the
// captains whose hulls you actually meet out there: the kill feed, the
// nameplates and the "…'s crew" announce lines all read them.
//
// Two rules hold: no name here may collide with a member of ISLAND_CAST (the
// Reach must never carry two people with one name), and the wire identity is
// still the player uuid — this is a DISPLAY name and nothing keys on it.
const BOT_CREW_CAPTAINS: readonly string[] = [
  'Redjack Mordey', 'Isolde Marrow', 'Barnaby Teal', 'Osric Bellows',
  'Marisol Kite', 'Longshank Hale', 'Perrin Gault', 'Adela Frost',
  'Cutter Bramwell', 'Rosalind Vex', 'Tobias Slake', 'Wexford Doyle',
  'Ilsa Raven', 'Gideon Marl', 'Dorran Ashe', 'Petronel Quinn',
  'Hob Ferrow', 'Amabel Stray', 'Nicodemus Pike', 'Selwyn Drear',
] as const;

/** Every proper noun the island cast already owns — the collision guard. */
export const REACH_CAST_NAMES: readonly string[] = ISLAND_CAST.flatMap((cast) => [
  cast.storyteller.name,
  ...(cast.bartender ? [cast.bartender.name] : []),
  ...(cast.hoarder ? [cast.hoarder.name] : []),
]);

// ── Story-scene placement tuning (docs/ISLAND_STORY_BIBLE.md) ───────────────
// Inland scenes ride findLandmarkSite (flatten stamp + slope/height limits);
// coastal scenes ride a shipwreck-style beach scan but must land DRY.
interface StoryInlandSpec {
  minY: number; maxSlope: number; dLo: number; dHi: number;
  stampRadius: number; blend: number; pad: number;
  /** Face the scene's authored front (game +Z at yaw 0) out to sea. */
  faceSeaward?: boolean;
}
const STORY_INLAND: Partial<Record<LandmarkType, StoryInlandSpec>> = {
  smuggler_cache: { minY: 2.5, maxSlope: 0.5, dLo: 0.18, dHi: 0.42, stampRadius: 5.5, blend: 0.4, pad: 5 },
  skull_totem: { minY: 3, maxSlope: 0.55, dLo: 0.2, dHi: 0.5, stampRadius: 5, blend: 0.45, pad: 5, faceSeaward: true },
  rum_still: { minY: 2, maxSlope: 0.5, dLo: 0.2, dHi: 0.45, stampRadius: 6, blend: 0.4, pad: 5.5 },
  crow_roost: { minY: 5, maxSlope: 0.7, dLo: 0.25, dHi: 0.55, stampRadius: 5, blend: 0.5, pad: 5, faceSeaward: true },
  dig_site: { minY: 2.5, maxSlope: 0.45, dLo: 0.16, dHi: 0.4, stampRadius: 7, blend: 0.4, pad: 6 },
  gallows: { minY: 3.5, maxSlope: 0.6, dLo: 0.15, dHi: 0.45, stampRadius: 6, blend: 0.45, pad: 5.5, faceSeaward: true },
  parley_table: { minY: 4, maxSlope: 0.45, dLo: 0.15, dHi: 0.4, stampRadius: 6, blend: 0.4, pad: 5.5 },
  mine_head: { minY: 6, maxSlope: 0.85, dLo: 0.3, dHi: 0.6, stampRadius: 6, blend: 0.5, pad: 5.5, faceSeaward: true },
  // High and rim-ward: the widow keeps her vigil at the cliff edge, lantern
  // visible from open water at night.
  widow_memorial: { minY: 8, maxSlope: 0.6, dLo: 0.45, dHi: 0.75, stampRadius: 6, blend: 0.45, pad: 5.5, faceSeaward: true },
};
/** Story scenes you are meant to WALK INTO keep a clear approach in front of
 *  them (authored front = game +Z at yaw 0). The scatter blocker list only
 *  reserved a disc round the scene centre, so a boulder_b — spacing radius 2.7,
 *  and taller than the cache's tarps — could legally land 8 m dead ahead and
 *  wall off the only readable way in. The value is how far down the approach
 *  (metres) the corridor is held open. */
const STORY_FACING_CLEARANCE: Partial<Record<LandmarkType, number>> = {
  smuggler_cache: 9.0,
};

interface StoryCoastalSpec { bandLo: number; bandHi: number; stampRadius: number; pad: number }
// bandLo well above the swell: scene base discs are 4-13m wide, so a centre
// sampled at ~0.4m still dips its rim underwater (audit P0: wrecker tower
// half-submerged, whale pad seam over the shallows).
const STORY_COASTAL: Partial<Record<LandmarkType, StoryCoastalSpec>> = {
  // Wide scenes need pads that clear a camp's furniture ring (~5m), not just
  // the camp stamp centre.
  whale_skeleton: { bandLo: 0.45, bandHi: 2.0, stampRadius: 7, pad: 8 },
  // The tableau is 1.8x the size the collider used to claim (see
  // PROP_COLLIDERS.kraken_wreck): a 7.5 m pad left her 7.2 m blocking footprint
  // hanging 0.86 m over the slope at its outer edge — the live-floater audit
  // caught it the moment the collider told the truth. The flat she lies on has
  // to be as wide as she is.
  kraken_wreck: { bandLo: 0.6, bandHi: 2.6, stampRadius: 10.5, pad: 9 },
  wrecker_tower: { bandLo: 0.7, bandHi: 2.2, stampRadius: 5.5, pad: 4.5 },
  castaway_camp: { bandLo: 0.7, bandHi: 2.2, stampRadius: 6, pad: 4.5 },
  mermaid_shrine: { bandLo: 0.4, bandHi: 1.5, stampRadius: 5, pad: 4.5 },
  gibbet_cage: { bandLo: 0.3, bandHi: 1.1, stampRadius: 2, pad: 3 },
};

// ── Biome prop scatter tables ───────────────────────────────────────────────
interface ScatterSpec {
  type: IslandPropType;
  weight: number;
  minY: number;
  maxSlope: number;
  dMin: number;
  dMax: number;
  sMin: number;
  sMax: number;
}

const PALM_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.9, maxSlope: 1.4, dMin: 0.25, dMax: 0.93, sMin: 0.85, sMax: 1.25 };
const BOULDER_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.5, maxSlope: 2.4, dMin: 0.08, dMax: 0.95, sMin: 0.75, sMax: 1.35 };
const CLUTTER_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 1.2, maxSlope: 0.42, dMin: 0.2, dMax: 0.8, sMin: 0.9, sMax: 1.1 };
const SHRUB_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.7, maxSlope: 1.0, dMin: 0.08, dMax: 0.95, sMin: 0.8, sMax: 1.35 };
// Story scatter: driftwood hugs the beach band, bone piles + graves dress the interior.
const DRIFTWOOD_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.35, maxSlope: 0.8, dMin: 0.72, dMax: 0.99, sMin: 0.8, sMax: 1.3 };
const BONE_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 0.6, maxSlope: 0.9, dMin: 0.15, dMax: 0.9, sMin: 0.8, sMax: 1.25 };
const GRAVE_SPECS: Omit<ScatterSpec, 'type' | 'weight'> = { minY: 1.2, maxSlope: 0.5, dMin: 0.2, dMax: 0.75, sMin: 0.9, sMax: 1.1 };

const SCATTER_MIX: Record<IslandBiome, ScatterSpec[]> = {
  lush: [
    { type: 'bush', weight: 2.0, ...SHRUB_SPECS },
    { type: 'bush_berry', weight: 1.2, ...SHRUB_SPECS },
    { type: 'flower_bush', weight: 1.4, ...SHRUB_SPECS },
    { type: 'flower_patch', weight: 1.0, ...SHRUB_SPECS },
    { type: 'wildflowers', weight: 1.2, ...SHRUB_SPECS },
    { type: 'fern_plant', weight: 2.2, ...SHRUB_SPECS },
    { type: 'palm_a', weight: 3.0, ...PALM_SPECS },
    { type: 'palm_b', weight: 2.2, ...PALM_SPECS },
    { type: 'palm_c', weight: 2.0, ...PALM_SPECS },
    { type: 'palm_tall', weight: 1.3, ...PALM_SPECS },
    { type: 'palm_ground', weight: 1.6, ...SHRUB_SPECS },
    { type: 'boulder_a', weight: 0.8, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 0.8, ...BOULDER_SPECS },
    { type: 'crate', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'barrel', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'driftwood_log', weight: 0.7, ...DRIFTWOOD_SPECS },
  ],
  palm_atoll: [
    { type: 'bush', weight: 1.6, ...SHRUB_SPECS },
    { type: 'flower_bush', weight: 1.0, ...SHRUB_SPECS },
    { type: 'wildflowers', weight: 1.0, ...SHRUB_SPECS },
    { type: 'fern_plant', weight: 1.8, ...SHRUB_SPECS },
    { type: 'palm_a', weight: 3.4, ...PALM_SPECS },
    { type: 'palm_b', weight: 2.6, ...PALM_SPECS },
    { type: 'palm_c', weight: 2.4, ...PALM_SPECS },
    { type: 'palm_tall', weight: 2.0, ...PALM_SPECS },
    { type: 'palm_ground', weight: 2.4, ...SHRUB_SPECS },
    { type: 'boulder_c', weight: 0.5, ...BOULDER_SPECS },
    { type: 'barrel', weight: 0.4, ...CLUTTER_SPECS },
    { type: 'crate', weight: 0.3, ...CLUTTER_SPECS },
    { type: 'driftwood_log', weight: 0.9, ...DRIFTWOOD_SPECS },
  ],
  volcanic: [
    { type: 'bush', weight: 1.0, ...SHRUB_SPECS },
    { type: 'fern_plant', weight: 1.2, ...SHRUB_SPECS },
    { type: 'boulder_a', weight: 2.6, ...BOULDER_SPECS },
    { type: 'boulder_b', weight: 1.4, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 2.2, ...BOULDER_SPECS },
    { type: 'palm_c', weight: 0.6, ...PALM_SPECS },
    { type: 'crate', weight: 0.4, ...CLUTTER_SPECS },
    { type: 'bone_pile', weight: 0.4, ...BONE_SPECS },
    { type: 'driftwood_log', weight: 0.3, ...DRIFTWOOD_SPECS },
  ],
  highland: [
    { type: 'bush', weight: 1.6, ...SHRUB_SPECS },
    { type: 'bush_berry', weight: 1.0, ...SHRUB_SPECS },
    { type: 'wildflowers', weight: 0.9, ...SHRUB_SPECS },
    { type: 'fern_plant', weight: 1.4, ...SHRUB_SPECS },
    { type: 'boulder_a', weight: 2.4, ...BOULDER_SPECS },
    { type: 'boulder_b', weight: 1.2, ...BOULDER_SPECS },
    { type: 'boulder_c', weight: 1.8, ...BOULDER_SPECS },
    { type: 'palm_b', weight: 0.6, ...PALM_SPECS },
    { type: 'palm_c', weight: 0.7, ...PALM_SPECS },
    { type: 'barrel', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'crate', weight: 0.5, ...CLUTTER_SPECS },
    { type: 'grave_marker', weight: 0.5, ...GRAVE_SPECS },
    { type: 'driftwood_log', weight: 0.4, ...DRIFTWOOD_SPECS },
  ],
  bone: [
    { type: 'bush', weight: 0.8, ...SHRUB_SPECS },
    { type: 'fern_plant', weight: 0.8, ...SHRUB_SPECS },
    { type: 'boulder_c', weight: 1.6, ...BOULDER_SPECS },
    { type: 'boulder_a', weight: 1.0, ...BOULDER_SPECS },
    { type: 'palm_c', weight: 0.8, ...PALM_SPECS },
    { type: 'palm_b', weight: 0.5, ...PALM_SPECS },
    { type: 'crate', weight: 0.9, ...CLUTTER_SPECS },
    { type: 'barrel', weight: 0.9, ...CLUTTER_SPECS },
    { type: 'bone_pile', weight: 1.6, ...BONE_SPECS },
    { type: 'grave_marker', weight: 1.0, ...GRAVE_SPECS },
    { type: 'driftwood_log', weight: 1.2, ...DRIFTWOOD_SPECS },
  ],
};

const SCATTER_DENSITY: Record<IslandBiome, number> = {
  lush: 0.85,
  palm_atoll: 1.0,
  volcanic: 0.7,
  highland: 0.75,
  bone: 0.6,
};

// ── Lush patches ────────────────────────────────────────────────────────────
// The base scatter above is an even sprinkle; on top of it we drop a few DENSE
// patches — flower meadows on green isles, fern/bush thickets on the harsh ones
// — so each island reads as clustered groves that flourish, not a flat spread.
// Patch flora is all soft (shape 'none') so it packs tight without collider
// interpenetration; a small local gap keeps individual plants readable.
interface PatchFlora { type: IslandPropType; weight: number }
const MEADOW_MIX: PatchFlora[] = [
  { type: 'flower_patch', weight: 3.0 },
  { type: 'wildflowers', weight: 2.2 },
  { type: 'flower_bush', weight: 2.2 },
  { type: 'bush', weight: 1.6 },
  { type: 'fern_plant', weight: 1.4 },
];
const THICKET_MIX: PatchFlora[] = [
  { type: 'fern_plant', weight: 2.8 },
  { type: 'bush', weight: 2.0 },
  { type: 'bush_berry', weight: 1.2 },
  { type: 'flower_bush', weight: 0.8 },
];
const PATCH_MIX: Record<IslandBiome, PatchFlora[]> = {
  lush: MEADOW_MIX,
  palm_atoll: MEADOW_MIX,
  highland: MEADOW_MIX,
  volcanic: THICKET_MIX,
  bone: THICKET_MIX,
};

// ── Camp variants ───────────────────────────────────────────────────────────
// Every island used to get the SAME tent_a + fire + bedroll + lantern + crate
// kit at the SAME radii, which read as procedural spam the moment you'd seen
// two islands (audit P2). Three authored tent silhouettes pitched at different
// stand-offs, with the bedroll on a different side and a looser or tighter
// clutter ring, gives each camp its own read at a glance.
interface CampVariant {
  tent: IslandPropType;
  /** Stand-off band from the hearth, in metres. */
  tentDist: [number, number];
  /** Constant added to "face the fire" — how the pitch is squared to the camp. */
  tentYawBias: number;
  /** Where the bedroll lies relative to the tent's bearing (radians). */
  bedOffset: number;
  /** Extra metres the crate/barrel ring may drift outward. */
  clutterSpread: number;
}
const CAMP_VARIANTS: CampVariant[] = [
  // A-frame, squared to the fire, tight kit: the "set up properly" camp.
  { tent: 'tent_a', tentDist: [2.9, 3.4], tentYawBias: Math.PI * 0.5, bedOffset: 0.9, clutterSpread: 0.3 },
  // Lean-to: open face turned to the hearth, gear strewn wide — a wreckers'
  // bivouac thrown together from driftwood.
  { tent: 'tent_b', tentDist: [3.2, 4.0], tentYawBias: Math.PI, bedOffset: -0.7, clutterSpread: 1.1 },
  // Bell tent: pitched close and off-axis, stores stacked against the canvas.
  { tent: 'tent_c', tentDist: [2.5, 3.1], tentYawBias: Math.PI * 0.25, bedOffset: 1.6, clutterSpread: 0.6 },
];

interface CampSite { x: number; z: number; y: number }
interface LandmarkSite { type: LandmarkType; x: number; z: number; yaw: number }

export class MapGenerator {
  private readonly rng: Rng;
  /** The match seed, kept so side-streams (crew names) can be derived from it
   *  without ever drawing from `rng` — see generateBotCrewNames. */
  private readonly seed: number;

  /** Same seed ⇒ bit-identical islands/props/stamps (ids excepted). */
  constructor(seed?: number) {
    const s = seed ?? ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    this.seed = s >>> 0;
    this.rng = mulberry32(s >>> 0);
  }

  /**
   * Names for the AI crews, seeded per match and drawn from the Reach's own
   * captains instead of Pirate_1 … Pirate_9.
   *
   * The generator is a SIDE STREAM (mulberry32 off a mixed seed) rather than
   * `this.rng`: naming must never move the world's draw sequence, or the
   * designed archipelago would shift the day the crew list changes length.
   * Same seed ⇒ same captains, in the same berths, every time.
   */
  generateBotCrewNames(count: number): string[] {
    const taken = new Set(REACH_CAST_NAMES);
    const pool = BOT_CREW_CAPTAINS.filter((name) => !taken.has(name));
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const bag = shuffled(rng, pool);
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      // Past the pool, crews take a numbered consort ("Ilsa Raven's Second") so
      // an oversized lobby still never repeats a name.
      names.push(i < bag.length ? bag[i] : `${bag[i % bag.length]} II-${Math.floor(i / bag.length) + 1}`);
    }
    return names;
  }

  generateIslands(): Island[] {
    const islands: Island[] = [];

    // THE SHATTERED REACH — a designed, fixed world. Every island sits where
    // it was authored, every match. Old Maw Caldera is the volcanic heart;
    // four big anchors hold the quadrants; taverns mark the cardinal lanes;
    // the corner archipelagos are the risky edge. Layout invariants (pairwise
    // spacing, world bounds, determinism) are pinned by test-world-fixed.mjs.
    for (const entry of ISLAND_ROSTER) {
      const pos: Vec3 = { x: entry.layout.x, y: 0, z: entry.layout.z };
      const rotation = entry.layout.rotation;
      const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const island: Island = {
        id: slug,
        name: entry.name,
        position: pos,
        radius: entry.radius,
        profile: this.buildProfile(entry, rotation),
        dock: null,
        tavern: null,
        caves: [],
        chests: [],
        barrels: [],
        upgradeStations: [],
        npcs: [],
        props: [],
        stamps: [],
      };

      // Island-local deterministic stream: caves → structures/stamps → loot → props.
      const islandRng = mulberry32((entry.seed ^ 0x9e3779b9) >>> 0);
      island.caves = this.generateCaves(island, islandRng);
      island.dock = entry.hasDock ? this.generateDock(island, islandRng) : null;
      island.tavern = entry.hasTavern ? this.generateTavern(island, islandRng) : null;
      island.upgradeStations = this.generateUpgradeStations(island, islandRng);
      const camps = this.planCamps(island, islandRng);
      const landmarks = this.planLandmarks(island, entry, islandRng);
      // Dredge last of the terrain edits, first of the content: the mooring lane
      // must survive the tavern pad and the landmark flattens, and everything
      // scattered afterwards must see the dredged seabed.
      this.dredgeMooringLane(island);
      island.chests = this.generateChests(island, islandRng);
      island.barrels = this.generateBarrels(island, islandRng);
      island.npcs = this.generateStoryNpcs(island, islands.length, islandRng);
      island.props = this.generateProps(island, entry, islandRng, camps, landmarks, islands.length);
      island.bridges = this.generateBridges(island);
      island.geysers = this.generateGeysers(island, islandRng);
      islands.push(island);
    }

    return islands;
  }

  /** How far from every coast water has to be to count as DEAD SPACE. */
  static readonly SEA_VOID_MIN_CLEARANCE = 170;

  /**
   * The DEAD SPACE of the Reach. A large slice of sailable water (measured by
   * test-sea-voids: ~27% of the water inside the final storm ring is >120 m
   * from any coast, ~5% is >180 m; over the whole 2000 m square it is 38% and
   * 15%) holds nothing but scattered rocks — you set a heading, hold it for a
   * minute and a half, and nothing happens. This finds the deepest pockets so
   * micro-POIs (a floating wreck with lootable barrels, a gull-circled flotsam
   * raft, a lone mast on a shoal) can be seeded into them: landmarks you only
   * ever find by sailing, never charted.
   *
   * Pure geometry, no rng, and keyed ONLY to the fixed island layout — sea
   * rocks and ship spawns are drawn from the match stream, so folding them into
   * the score would make the sites move between matches and stop them being
   * learnable. (A caller that wants them respected passes them as `obstacles`;
   * the wiring pass should instead teach generateSeaRocks to give the sites a
   * berth, the way it already does for islands and spawns.) A coarse grid of
   * the sailable disc is scored by clearance to the nearest COAST and to the
   * storm wall, then the deepest cells are taken greedily with `spacing`
   * between picks, so the sites land in DIFFERENT voids rather than four
   * corners of one.
   */
  findSeaVoids(
    islands: Island[],
    obstacles: Array<{ position: Vec3; radius?: number }> = [],
    count = 4,
    spacing = 300,
    obstacleClear = 60,
  ): Array<{ x: number; z: number; clearance: number }> {
    const step = 25;
    const limit = WORLD.HALF - 120; // inside the final storm ring, off the wall
    const cells: Array<{ x: number; z: number; clearance: number }> = [];
    for (let x = -limit; x <= limit; x += step) {
      for (let z = -limit; z <= limit; z += step) {
        if (Math.hypot(x, z) > limit) continue;
        let clearance = limit - Math.hypot(x, z); // the storm wall is an edge too
        for (const island of islands) {
          const d = Math.hypot(x - island.position.x, z - island.position.z) - getIslandMaxRadius(island);
          if (d < clearance) clearance = d;
        }
        if (clearance < MapGenerator.SEA_VOID_MIN_CLEARANCE) continue;
        if (obstacles.some((o) => Math.hypot(x - o.position.x, z - o.position.z) - (o.radius ?? 0) < obstacleClear)) continue;
        cells.push({ x, z, clearance });
      }
    }
    // Deepest water first, ties broken by position, so the pick is deterministic
    // regardless of scan order.
    cells.sort((a, b) => b.clearance - a.clearance || a.x - b.x || a.z - b.z);
    const picks: Array<{ x: number; z: number; clearance: number }> = [];
    for (const cell of cells) {
      if (picks.length >= count) break;
      if (picks.some((p) => Math.hypot(p.x - cell.x, p.z - cell.z) < spacing)) continue;
      picks.push(cell);
    }
    return picks;
  }

  /** Walkable rope bridge between the two main peaks on split-landmass styles.
   *  Endpoints are the actual LOCAL MAXIMA of the final heightfield (grid
   *  search around each gaussian hill center — detail noise shifts the true
   *  summit off-center), so both ends sit flush on the terrain. Deterministic:
   *  pure function of the island, no rng. Deck math is shared
   *  (getBridgeDeckY), so the deck the client draws is the deck physics walks. */
  private generateBridges(island: Island): IslandBridge[] {
    const profile = island.profile;
    const eligible = profile.terrainStyle === 'twin'
      || profile.terrainStyle === 'archipelago'
      || profile.terrainStyle === 'mountain'
      || (profile.terrainStyle === 'rocky' && profile.secondaryHillScale > 0.3);
    if (!eligible) return [];
    const localPeak = (hillAngle: number, hillOffset: number) => {
      const cx = island.position.x + Math.cos(hillAngle) * hillOffset * profile.footprintX;
      const cz = island.position.z + Math.sin(hillAngle) * hillOffset * profile.footprintZ;
      let best = { x: cx, z: cz, y: getIslandSurfaceY(island, cx, cz) };
      for (let gx = -3; gx <= 3; gx++) {
        for (let gz = -3; gz <= 3; gz++) {
          const x = cx + gx * 2.4;
          const z = cz + gz * 2.4;
          const y = getIslandSurfaceY(island, x, z);
          if (y > best.y) best = { x, z, y };
        }
      }
      return best;
    };
    let a = localPeak(profile.primaryHillAngle, profile.primaryHillOffset);
    let b = localPeak(profile.secondaryHillAngle, profile.secondaryHillOffset);
    // NEAR-LEVEL bridges (SoT): both ends anchor at the LOWER peak's height.
    // From the low top, cross the dip to wherever the taller flank rises back
    // to that height — the deck meets the spire's cliff face at altitude
    // instead of ramping to its summit.
    if (a.y < b.y) { const swap = a; a = b; b = swap; }
    let anchor: { x: number; z: number; y: number } | null = null;
    for (let u = 0.45; u <= 0.96; u += 0.017) {
      const nx = b.x + (a.x - b.x) * u;
      const nz = b.z + (a.z - b.z) * u;
      const ny = getIslandSurfaceY(island, nx, nz);
      if (ny >= b.y + 0.3) { anchor = { x: nx, z: nz, y: ny }; break; }
    }
    if (!anchor) return [];
    const span = Math.hypot(b.x - anchor.x, b.z - anchor.z);
    const seaBase = 5.15 + island.radius * 0.0085;
    if (span < 7 || span > island.radius * 1.15) return [];
    if (b.y - seaBase < 3) return [];
    if (Math.abs(anchor.y - b.y) / span > 0.18) return []; // near-level or nothing
    // A bridge needs a real gap under it: some point of the crossing must
    // drop well below the deck, and terrain must never poke through the deck.
    let deepestDrop = 0;
    let pokes = false;
    // Middle window only: the deck naturally grazes terrain at both ends
    // (that's what an anchor is) — the GAP must exist mid-crossing.
    for (let f = 0.3; f <= 0.7; f += 0.08) {
      const sx = b.x + (anchor.x - b.x) * f;
      const sz = b.z + (anchor.z - b.z) * f;
      const deckY = b.y + (anchor.y - b.y) * f;
      const ground = getIslandSurfaceY(island, sx, sz);
      deepestDrop = Math.max(deepestDrop, deckY - ground);
      if (ground > deckY - 0.22) pokes = true;
    }
    if (pokes || deepestDrop < Math.min(2.2, span * 0.09)) return [];
    return [{ ax: anchor.x, ay: anchor.y, az: anchor.z, bx: b.x, by: b.y, bz: b.z, width: 1.9 }];
  }

  /** Steam/water geysers on the volcanic isles. Placed on footable ground (a
   *  vent, not a wall) up the flanks toward the caldera, spaced apart, on a
   *  deterministic eruption cycle. Launches are shared math (geyserEruptionLevel)
   *  so the client plume and the server launch fire in lockstep. */
  private generateGeysers(island: Island, rng: Rng): IslandGeyser[] {
    if (island.profile.biome !== 'volcanic') return [];
    const geysers: IslandGeyser[] = [];
    const target = island.profile.terrainStyle === 'mountain' ? 4 : 3;
    const GOLDEN = 2.399963229728653;
    for (let attempt = 0; attempt < 110 && geysers.length < target; attempt++) {
      const angle = ra(rng) + attempt * GOLDEN;
      const distRatio = rr(rng, 0.3, 0.82);
      const pt = getIslandSurfacePoint(island, distRatio, angle, 0);
      if (pt.y < 4.5) continue; // clear the wave line + beach band
      // A vent must be footable — reject genuinely steep faces (matches the
      // on-foot slope gate, so a launched pirate was actually standing there).
      const e = 0.9;
      const gx = (getIslandSurfaceY(island, pt.x + e, pt.z) - getIslandSurfaceY(island, pt.x - e, pt.z)) / (2 * e);
      const gz = (getIslandSurfaceY(island, pt.x, pt.z + e) - getIslandSurfaceY(island, pt.x, pt.z - e)) / (2 * e);
      if (Math.hypot(gx, gz) > 0.75) continue;
      // Keep vents apart so their trigger radii don't overlap into a launch pad.
      if (geysers.some((g) => Math.hypot(g.x - pt.x, g.z - pt.z) < 15)) continue;
      geysers.push({
        x: pt.x,
        z: pt.z,
        y: pt.y,
        radius: rr(rng, 2.4, 3.2),
        period: rr(rng, 7.5, 11),
        activeDuration: rr(rng, 2.2, 3.0),
        phaseOffset: rr(rng, 0, 12),
        power: rr(rng, 18, 22),
      });
    }
    return geysers;
  }

  private buildProfile(entry: RosterEntry, rotation: number): IslandProfile {
    const rng = mulberry32(entry.seed >>> 0);
    const radius = entry.radius;
    const terrainStyle = entry.style;
    const islandHeading = angleWrap(ra(rng) + rotation);
    const ridgeAxis = angleWrap(islandHeading + rr(rng, -0.48, 0.48));

    let heightProfile = rr(rng, 0.2, 0.48);
    let mesaBias = rr(rng, 0.15, 1);
    let secondaryHillScale = rr(rng, 0.28, 0.72);
    let tertiaryHillScale = rng() > 0.5 ? rr(rng, 0.14, 0.46) : 0;
    let peakBoost = 0;
    let footprintX = rr(rng, 1.08, 1.72);
    let footprintZ = rr(rng, 1.08, 1.72);
    let ridgeBias = rr(rng, -0.24, 0.24);
    let primaryHillOffset = radius * rr(rng, 0.18, 0.34);
    let secondaryHillOffset = radius * rr(rng, 0.16, 0.36);
    let tertiaryHillOffset = radius * rr(rng, 0.12, 0.28);
    let secondaryAngleSpread = Math.PI * rr(rng, 0.72, 1.06);

    if (terrainStyle === 'mountain') {
      heightProfile = rr(rng, 0.68, 1.22);
      peakBoost = rr(rng, 1.7, 2.6); // sheer SoT-style spires — the skyline landmark
      mesaBias = rr(rng, 0.05, 0.35);
      secondaryHillScale = rr(rng, 0.4, 0.8);
    } else if (terrainStyle === 'plateau') {
      heightProfile = rr(rng, 0.42, 0.74);
      mesaBias = rr(rng, 0.7, 1.0);
      peakBoost = 0;
      ridgeBias = rr(rng, -0.12, 0.12);
    } else if (terrainStyle === 'rocky') {
      heightProfile = rr(rng, 0.28, 0.58);
      tertiaryHillScale = rr(rng, 0.32, 0.64);
      secondaryHillScale = rr(rng, 0.42, 0.78);
      footprintX = rr(rng, 1.0, 1.5);
      footprintZ = rr(rng, 1.0, 1.5);
    } else if (terrainStyle === 'twin') {
      // Two distinct FANGS of comparable height — ridge/bridge running between
      heightProfile = rr(rng, 0.62, 0.95);
      peakBoost = rr(rng, 1.0, 1.5);
      mesaBias = rr(rng, 0.05, 0.3);
      secondaryHillScale = rr(rng, 0.78, 1.05);
      tertiaryHillScale = 0;
      primaryHillOffset = radius * rr(rng, 0.36, 0.5);
      secondaryHillOffset = radius * rr(rng, 0.36, 0.5);
      secondaryAngleSpread = Math.PI * rr(rng, 0.92, 1.08);
      footprintX = rr(rng, 1.4, 1.85);
      footprintZ = rr(rng, 1.05, 1.4);
    } else if (terrainStyle === 'archipelago') {
      // Three smaller peaks each forming their own islet, water flows between.
      // Peaks are pushed WIDE apart (offsets + big footprint) and given real
      // height so the 2D islet-disc gating in getIslandSurfaceY leaves genuine
      // ocean channels rather than one fused blob.
      heightProfile = rr(rng, 0.4, 0.62);
      peakBoost = rr(rng, 0.35, 0.75);
      mesaBias = rr(rng, 0.05, 0.22);
      secondaryHillScale = rr(rng, 0.8, 1.0);
      tertiaryHillScale = rr(rng, 0.62, 0.9);
      primaryHillOffset = radius * rr(rng, 0.4, 0.55);
      secondaryHillOffset = radius * rr(rng, 0.44, 0.6);
      tertiaryHillOffset = radius * rr(rng, 0.42, 0.58);
      secondaryAngleSpread = Math.PI * rr(rng, 0.62, 0.9);
      footprintX = rr(rng, 1.45, 1.72);
      footprintZ = rr(rng, 1.45, 1.72);
    } else if (terrainStyle === 'crescent') {
      // Horseshoe: a main mass at the "back" with two arms wrapping around a bay
      // that opens on the opposite side (carved to open water in getIslandSurfaceY).
      heightProfile = rr(rng, 0.42, 0.66);
      peakBoost = rr(rng, 0.25, 0.6);
      mesaBias = rr(rng, 0.15, 0.4);
      secondaryHillScale = rr(rng, 0.6, 0.88);   // the two arms of the C
      tertiaryHillScale = rr(rng, 0.5, 0.78);
      primaryHillOffset = radius * rr(rng, 0.32, 0.44);   // main mass toward the back
      secondaryHillOffset = radius * rr(rng, 0.46, 0.6);  // arms pushed outward
      tertiaryHillOffset = radius * rr(rng, 0.46, 0.6);
      secondaryAngleSpread = Math.PI * rr(rng, 0.5, 0.64); // arms flank the bay mouth
      footprintX = rr(rng, 1.15, 1.42);
      footprintZ = rr(rng, 1.15, 1.42);
    }

    const primaryHillAngle = ridgeAxis + rr(rng, -0.42, 0.42);
    const secondaryHillAngle = primaryHillAngle + secondaryAngleSpread;
    const tertiaryHillAngle = terrainStyle === 'crescent'
      // Second arm mirrors the first about the ridge, so both flank the bay mouth.
      ? primaryHillAngle - secondaryAngleSpread
      : terrainStyle === 'archipelago'
        ? primaryHillAngle + Math.PI * 0.5 + rr(rng, -0.18, 0.18)
        : ridgeAxis + Math.PI * 0.5 + rr(rng, -0.42, 0.42);

    // Coves & bays — the entry's rng makes each named island's inlet layout a
    // fixed part of its identity (rotated rigidly with the island).
    const inlets: IslandInlet[] = [];
    const hillAngles = [primaryHillAngle, secondaryHillAngle, tertiaryHillAngle];
    const farFromHills = (a: number) =>
      hillAngles.every((h) => Math.abs(angleDelta(a, h)) > 0.7);
    const pushInlet = (width: number, depth: number) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const a = angleWrap(ra(rng) + rotation);
        if (!farFromHills(a)) continue;
        if (inlets.some((inl) => Math.abs(angleDelta(a, inl.angle)) < 1.1)) continue;
        inlets.push({ angle: a, width, depth });
        return;
      }
    };
    if (entry.forcedInlet) {
      pushInlet(rr(rng, entry.forcedInlet.width[0], entry.forcedInlet.width[1]), rr(rng, entry.forcedInlet.depth[0], entry.forcedInlet.depth[1]));
    }
    const inletTarget = radius > 78 ? (rng() < 0.7 ? 2 : 1)
      : radius > 50 ? (rng() < 0.6 ? 1 : 0)
        : (rng() < 0.3 ? 1 : 0);
    while (inlets.length < inletTarget) {
      const isBay = rng() < 0.5;
      const before = inlets.length;
      pushInlet(
        isBay ? rr(rng, 0.7, 1.0) : rr(rng, 0.32, 0.5),
        isBay ? rr(rng, 0.16, 0.26) : rr(rng, 0.28, 0.42),
      );
      if (inlets.length === before) break; // no valid slot left
    }

    return {
      islandHeading,
      footprintX,
      footprintZ,
      heightProfile,
      beachSpread: rr(rng, 1.08, 1.26),
      ridgeAxis,
      ridgeBias,
      mesaBias,
      primaryHillAngle,
      secondaryHillAngle,
      tertiaryHillAngle,
      primaryHillOffset,
      secondaryHillOffset,
      tertiaryHillOffset,
      secondaryHillScale,
      tertiaryHillScale,
      peakBoost,
      terrainStyle,
      inlets,
      seed: entry.seed,
      biome: entry.biome,
      palette: BIOME_PALETTES[entry.biome],
      coastBias: entry.coastBias,
      whiteSand: entry.whiteSand,
    };
  }

  // ── Caves: proper branching SYSTEMS (entrance tunnel → junction chamber →
  //    side branch to a treasure room → a through-tunnel that surfaces on the
  //    far flank). Each segment is an oriented box; the shared carve/ceiling
  //    math unions overlapping segments so the whole network is one walkable,
  //    raycastable, rendered space. ──────────────────────────────────────────
  private generateCaves(island: Island, rng: Rng): IslandCave[] {
    const style = island.profile.terrainStyle;
    const systems = style === 'rocky' ? 1 + (rng() < 0.5 ? 1 : 0)
      : style === 'mountain' ? 1
        : style === 'plateau' ? (rng() < 0.45 ? 1 : 0)
          : (rng() < 0.25 ? 1 : 0);
    if (systems === 0) return [];

    const caves: IslandCave[] = [];
    const profile = island.profile;
    const hillAngles = [profile.primaryHillAngle, profile.secondaryHillAngle];
    if (profile.tertiaryHillScale > 0) hillAngles.push(profile.tertiaryHillAngle);
    const GOLDEN = 2.399963229728653;
    // Cave floors stay ABOVE the waves: a floor below the gerstner surface flips
    // walkers into the swim branch (submergeDepth keys off the standing floor),
    // which then ejects them through the roof via swimSeabedY. Deep networks get
    // their verticality from descending toward this waterline, never past it.
    // It stays at 1.0 even though a calm CREST reaches +1.62m (1.01m of summed
    // amplitude × 1.6 peak roughness): raising the bar to clear the crest lifts
    // every ceiling with it, and the roof check then strangles the networks on
    // the lower isles (skull-cove fell from 10 segments to 4). The sea rendering
    // through a deep gallery's floor is handled where it belongs — the ocean
    // sheet stands down while the camera is under a cave roof (Game
    // .updateOceanCaveSuppression) — and floors this deep are always far enough
    // in for that predicate to have turned on.
    const CAVE_MIN_FLOOR = 1.0;
    // Natural surface stays ≥ `clear` above the tube's (ramping) ceiling along a
    // ray → the roof holds. The ceiling follows the floor ramp f0→f1 (+h), so a
    // descending entrance needs far less overhead rock than its mouth height
    // suggests. Sample from mid-tunnel inward (skip the mouth, where the hill is
    // thin by construction).
    const roofed = (fx: number, fz: number, dx: number, dz: number, len: number, f0: number, f1: number, h: number, clear: number): boolean => {
      // The 0.33 sample guards the stretch just past the mouth with a thinner
      // requirement — enough that the tube arch never pokes proud of the hill,
      // without demanding full rock cover where the portal is still opening up.
      for (const [f, cScale] of [[0.33, 0.3], [0.45, 1], [0.65, 1], [0.85, 1], [1.0, 1]] as const) {
        const ceilAt = f0 + (f1 - f0) * f + h;
        if (getIslandSurfaceY(island, fx + dx * len * f, fz + dz * len * f) < ceilAt + clear * cScale) return false;
      }
      return true;
    };
    const seg = (x: number, z: number, rot: number, rad: number, len: number, floor: number, h: number,
                 opts: { mouth?: boolean; back?: boolean; floorEnd?: number }): IslandCave => ({
      position: { x, y: island.position.y, z }, rotation: rot, width: rad * 2, height: h,
      length: len, interiorRadius: rad, floorY: floor, ceilingY: floor + h,
      floorYEnd: opts.floorEnd ?? floor,
      hasMouth: !!opts.mouth, hasBackWall: !!opts.back,
    });

    for (let i = 0; i < systems; i++) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const angle = attempt < 40
          ? hillAngles[attempt % hillAngles.length] + rr(rng, -0.85, 0.85)
          : ra(rng) + attempt * GOLDEN;
        // Grand landmark caverns belong to tall mountains (and rocky isles): a
        // wide, high mouth carved deep into the massif — not a token side-tunnel.
        // Other styles keep modest grottos.
        const grand = style === 'mountain' || style === 'rocky';
        const mouth = getIslandSurfacePoint(island, rr(rng, 0.34, grand ? 0.62 : 0.6), angle, 0);
        if (mouth.y < 3.2) continue;
        const rot = directionToYaw(Math.cos(angle), Math.sin(angle));
        const inX = -Math.sin(rot), inZ = -Math.cos(rot); // into the hill (toward centre)
        // The mouth floor meets the natural surface at the lip (a small readable
        // step, never a climb): sinking it 1-1.9m below grade left an unwalkable
        // wall at the mouth plane — you could drop in but never step back OUT.
        const floorY = mouth.y - 0.35;
        // Entrance tunnel RAMPS DOWN into the mountain (not a thin roof slab):
        // deeper on bigger, taller islands so mountains hide genuine caverns —
        // but always bottoming out above the waterline (CAVE_MIN_FLOOR).
        const descend = Math.min(grand ? 16 : 9, (grand ? 6.5 : 4) + island.radius * (grand ? 0.095 : 0.05));
        const deepFloor = Math.max(floorY - descend, CAVE_MIN_FLOOR);
        // Pick the TALLEST mouth that still roofs at this spot: grand caverns aim
        // high, but fall back to a shorter cave (and a shorter run) before giving up
        // on the location — so a tall island whose flank can't roof a 6m ceiling
        // still gets a real cave instead of generateCaves silently producing none.
        // Rocky knolls (12-16m peaks) can only roof modest grottos, so their menu
        // reaches lower and their roof-clearance is thinner.
        const clearance = style === 'rocky' ? 1.2 : 2.1;
        const heightMenu = grand
          ? (style === 'rocky' ? [rr(rng, 3.6, 4.4), 3.2, 2.8, 2.5] : [rr(rng, 5.4, 6.6), 4.8, 4.2, 3.6])
          : [rr(rng, 3.6, 4.4)];
        let h = 0, ceilingY = 0, mainLen = 0, rampFloor = deepFloor;
        for (const hc of heightMenu) {
          let L0 = 0;
          for (const L of [15, 12, 9, 7, 6, 5]) {
            // The entrance ramp must stay WALKABLE both ways: cap its drop by a
            // 0.75 gradient (SLOPE_MAX is ~1.15) so a short mouth on a steep flank
            // descends gently instead of becoming a fall-damage pit with an
            // unclimbable exit. The roof check runs against this capped ramp.
            const rf = Math.max(floorY - L * 0.75, deepFloor);
            if (roofed(mouth.x, mouth.z, inX, inZ, L, floorY, rf, hc, clearance)) { L0 = L; rampFloor = rf; break; }
          }
          if (L0 > 0) { h = hc; ceilingY = floorY + hc; mainLen = L0; break; }
        }
        if (mainLen === 0) continue;
        const iRad = grand ? (style === 'rocky' ? rr(rng, 3.2, 4.2) : rr(rng, 4.4, 5.6)) : rr(rng, 2.7, 3.4);
        if (caves.some((c) => Math.hypot(c.position.x - mouth.x, c.position.z - mouth.z) < c.length + mainLen)) continue;
        const sys: IslandCave[] = [];
        sys.push(seg(mouth.x, mouth.z, rot, iRad, mainLen, floorY, h, { mouth: true, floorEnd: rampFloor }));

        // Central junction chamber, deep underground (taller, at the ramp's base).
        // Its floor meets the ramp base EXACTLY: any dip below it reads, through
        // the segment union, as ramp-gradient-plus-dip to the slope probe at the
        // boundary — which crosses SLOPE_MAX and bricks the walk back out.
        const jx = mouth.x + inX * mainLen, jz = mouth.z + inZ * mainLen;
        const jRad = rr(rng, 5.0, 6.4), jLen = rr(rng, 6, 9), jFloor = rampFloor, jH = h + 2.2;
        if (!roofed(jx, jz, inX, inZ, jLen, jFloor, jFloor, jH, 2.2)) { sys[0].hasBackWall = true; caves.push(...sys); break; }
        const junction = seg(jx, jz, rot, jRad, jLen, jFloor, jH, {});
        sys.push(junction);
        const jcx = jx + inX * jLen * 0.5, jcz = jz + inZ * jLen * 0.5;

        // ── Branching, multi-level VEIN network off the junction ──────────────
        // Recursively bore passages: run each as far as the roof allows, descend it
        // (down-and-OUT, never stacked over another gallery), then open a chamber,
        // FORK into diverging children, or dead-end — so a grand cave is a deep,
        // forking warren reaching several levels, not one straight side-tunnel.
        const MAX_SEGS = grand ? 14 : 8;
        // The floor of an already-placed segment at world (px,pz), or null if the
        // point is outside its footprint. Used to reject a NEW passage that would
        // cross an existing gallery at a clashing depth: the ceiling helpers report
        // the globally-lowest ceiling, so stacking two galleries at one (x,z) makes
        // the roof read as collapsed. Keeping the network non-stacked keeps it valid.
        const segFloorAt = (c: IslandCave, px: number, pz: number): number | null => {
          const cLen = c.length, cR = c.interiorRadius ?? 3;
          const dx = px - c.position.x, dz = pz - c.position.z;
          const cs = Math.cos(c.rotation), sn = Math.sin(c.rotation);
          const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
          if (Math.abs(lx) > cR + 1.4 || lz > 1.2 || lz < -cLen - 1.2) return null;
          const along = cLen > 0 ? Math.max(0, Math.min(1, -lz / cLen)) : 0;
          const fE = (c as { floorYEnd?: number }).floorYEnd ?? c.floorY;
          return c.floorY + (fE - c.floorY) * along;
        };
        const overlapClash = (sx: number, sz: number, dX: number, dZ: number, len: number, f0: number, f1: number, rad: number): boolean => {
          // Sweep the new passage's whole FOOTPRINT, not just its centre line: two
          // galleries whose boxes merely graze each other at a corner still merge
          // into one walkable union, and where their floors differ the union's
          // blended floor STEPS by the difference over a single cell — the "hole
          // in the floor" players fall through at chamber corners. The centre-line
          // test missed every one of those (the clash is a body-width off-axis).
          const nX = -dZ, nZ = dX;
          for (let s = 0.1; s <= 1.001; s += 0.1) {
            const newFloor = f0 + (f1 - f0) * s;
            for (const lat of [-1, -0.5, 0, 0.5, 1] as const) {
              const px = sx + dX * len * s + nX * rad * lat;
              const pz = sz + dZ * len * s + nZ * rad * lat;
              for (const c of sys) {
                const cf = segFloorAt(c, px, pz);
                // Overlapping galleries must share a level (the ceiling helper reports
                // the globally-lowest roof, so a deeper crosser would collapse the
                // reported headroom). Connected passages meet at equal floors → fine.
                if (cf !== null && Math.abs(cf - newFloor) > 0.5) return true;
              }
            }
          }
          return false;
        };
        const drill = (sx: number, sz: number, dRot: number, floor: number, rad: number, height: number, depth: number): void => {
          if (sys.length >= MAX_SEGS || depth <= 0) return;
          const dX = -Math.sin(dRot), dZ = -Math.cos(dRot);
          let len = 0;
          for (const L of [13, 10, 8, 6, 5, 4]) { if (roofed(sx, sz, dX, dZ, L, floor, floor, height, 1.8)) { len = L; break; } }
          if (len < 4) return;
          // Gentle DESCENT along the run (down-and-out) → deeper levels you ramp to,
          // small enough that connected passages stay within the ceiling helper's
          // tolerance while the network still steps down through several levels.
          const floorEnd = Math.max(floor - rng() * 1.5, CAVE_MIN_FLOOR);
          const ex = sx + dX * len, ez = sz + dZ * len;
          if (overlapClash(sx, sz, dX, dZ, len, floor, floorEnd, rad)) return;
          const passage = seg(sx, sz, dRot, rad, len, floor, height, { floorEnd });
          sys.push(passage);
          const roll = rng();
          if (sys.length >= MAX_SEGS || depth <= 1 || roll < 0.22) {
            // Terminate this vein in a chamber (treasure room) or a plain dead-end.
            const cRad = rr(rng, 3.6, 5.0), cLen = rr(rng, 4, 6), cH = rr(rng, 4.4, 5.8);
            if (!overlapClash(ex, ez, dX, dZ, cLen, floorEnd, floorEnd, cRad) && roofed(ex, ez, dX, dZ, cLen, floorEnd, floorEnd, cH, 2)) {
              sys.push(seg(ex, ez, dRot, cRad, cLen, floorEnd, cH, { back: true }));
            } else {
              passage.hasBackWall = true;
            }
            return;
          }
          // FORK into a Y — two diverging children (or one), each a fresh vein.
          const spread = rr(rng, 0.6, 1.2);
          const forks = roll < 0.72 ? 2 : 1;
          for (let f = 0; f < forks; f++) {
            const side = f === 0 ? 1 : -1;
            const childRot = dRot + side * spread + (rng() - 0.5) * 0.3;
            const childRad = Math.max(2.2, rad - rr(rng, 0.3, 0.9));
            const childH = Math.max(3.4, height - rr(rng, 0.2, 0.8));
            drill(ex, ez, childRot, floorEnd, childRad, childH, depth - 1);
          }
        };
        // Two vein systems diverge off the junction at near-opposite headings (so
        // they sprawl to opposite sides of the massif and never cross), one starting
        // lower than the other for a genuine level difference.
        const veinBase = rot + (rng() < 0.5 ? 1 : -1) * rr(rng, 0.7, 1.2);
        drill(jcx, jcz, veinBase, jFloor + 0.1, rr(rng, 2.8, 3.6), rr(rng, 3.8, 4.6), grand ? 3 : 2);
        drill(jcx, jcz, veinBase + Math.PI * (0.72 + rng() * 0.46), jFloor + 0.1, rr(rng, 2.8, 3.6), rr(rng, 3.8, 4.6), grand ? 3 : 1);

        // THROUGH-tunnel: bore inward until the roof thins on the far flank, then
        // break out as a SECOND mouth — but ONLY when it stays HONEST. The scan is
        // CAPPED so a valid through-tunnel is a believable length (never an ~80m
        // featureless straight box), and the whole run is roof-validated against the
        // tube's OWN (ramping) ceiling so the closed tube can never float proud of the
        // hillside. If no thin-roof exit is found within the cap — or the roof would
        // breach mid-run — the deep end is sealed instead of boring a protruding tube.
        const THROUGH_SCAN_CAP = 48; // ≈46 + one step, so a genuinely honest far-flank
        //   through-tunnel still qualifies while long straight boxes are rejected.
        let exit: { x: number; z: number; y: number; dist: number } | null = null;
        for (let d = jLen + 4; d < THROUGH_SCAN_CAP; d += 2) {
          const ex = jx + inX * d, ez = jz + inZ * d;
          const surf = getIslandSurfaceY(island, ex, ez);
          if (surf < ceilingY + 0.4) {
            // The breakout must be on the FAR FLANK — a thin-roof reading near the
            // island centre is an interior basin/saddle (twin peaks, calderas), and
            // boring up into it leaves a tube floating proud of the terrain with a
            // "far" mouth in the middle of the island. No honest exit here → seal.
            const exDist = Math.hypot(ex - island.position.x, ez - island.position.z);
            if (surf > 3.0 && exDist > island.radius * 0.45) exit = { x: ex, z: ez, y: surf, dist: d };
            break;
          }
        }
        // Roof-validate the mid-run: the natural surface must stay a clear ≥1.2m ABOVE
        // the tube ceiling (floor ramps jFloor→exit.y−1, ceiling = floorAt + h — the
        // same ramp getCaveCeilingY reads) over all but the final approach to the
        // breakout mouth. If any sample breaches, the tube would poke out → reject it.
        let throughRoofed = false;
        if (exit) {
          const tubeLen = Math.max(4, exit.dist - jLen - 2);
          const throughFloorEnd = exit.y - 1;
          throughRoofed = true;
          for (const f of [0.15, 0.3, 0.45, 0.6, 0.72]) {
            const px = jx + inX * (jLen + tubeLen * f), pz = jz + inZ * (jLen + tubeLen * f);
            const tubeCeil = jFloor + (throughFloorEnd - jFloor) * f + h;
            if (getIslandSurfaceY(island, px, pz) < tubeCeil + 1.2) { throughRoofed = false; break; }
          }
        }
        // Only open the far mouth once BOTH the thin-roof breakout (surf < ceilingY+0.4,
        // above) and the along-length roof validation pass; otherwise seal the junction.
        if (exit && throughRoofed) {
          const exTunLen = exit.dist - jLen;
          // Tunnel ramps UP from the deep junction back to the far surface.
          sys.push(seg(jx + inX * jLen, jz + inZ * jLen, rot, iRad, Math.max(4, exTunLen - 2), jFloor, h, { floorEnd: exit.y - 1 }));
          // Far mouth on the far flank (descends inward to meet the ramp).
          const exAngle = Math.atan2(exit.z - island.position.z, exit.x - island.position.x);
          const exRot = directionToYaw(Math.cos(exAngle), Math.sin(exAngle));
          sys.push(seg(exit.x, exit.z, exRot, iRad, Math.min(exTunLen, 9), exit.y - 1, h, { mouth: true, floorEnd: exit.y - 2 }));
        } else {
          junction.hasBackWall = true; // no honest through-route → seal the deep end
        }

        caves.push(...sys);
        break;
      }
    }
    return caves;
  }

  // ── Docks: always land on a beach coast, shore end stamped flat ───────────
  private generateDock(island: Island, rng: Rng): IslandDock | null {
    let best: { angle: number; score: number } | null = null;
    for (let i = 0; i < 20; i++) {
      const a = ra(rng);
      const w = getIslandCoastWeights(island, a);
      let score = w.beach * 2 - w.cliff;
      // Shore anchor must reach dry land somewhere along the ray — archipelago
      // channels and crescent bays drown the walkway (and its lanterns) otherwise.
      let dryReach = 0;
      for (let d = 0.9; d >= 0.32; d -= 0.05) {
        if (getIslandSurfacePoint(island, d, a, 0).y >= 0.6) { dryReach = d; break; }
      }
      if (dryReach === 0) score -= 4;      // no dry land at this heading at all
      else score += (dryReach - 0.5) * 1.2; // prefer land that reaches near the rim
      for (const cave of island.caves) {
        const caveAngle = Math.atan2(cave.position.z - island.position.z, cave.position.x - island.position.x);
        if (Math.abs(angleDelta(a, caveAngle)) < 0.7) score -= 3;
      }
      if (!best || score > best.score) best = { angle: a, score };
    }
    if (!best) return null;

    const shoreAngle = best.angle;
    const rotation = directionToYaw(Math.cos(shoreAngle), Math.sin(shoreAngle));
    // Draw first (the rng ladder must stay bit-identical), then hold the run to
    // a length a galleon can actually lie alongside: Rumrunner Key's 15.8m pier
    // berthed every class mostly PAST its tip.
    const length = Math.max(rr(rng, Math.max(14, island.radius * 0.3), Math.max(20, island.radius * 0.52)), BERTH.MIN_DOCK_LENGTH);
    const width = rr(rng, 3.6, 5.6);
    const moorSide = (rng() < 0.5 ? -1 : 1) as -1 | 1;
    // Anchor at the outermost dry point along the shore ray (the waterline
    // crossing) — never in a flooded saddle.
    let shore = getIslandSurfacePoint(island, 0.93, shoreAngle, 0);
    if (shore.y < 0.6) {
      for (let d = 0.9; d >= 0.3; d -= 0.02) {
        const p = getIslandSurfacePoint(island, d, shoreAngle, 0);
        if (p.y >= 0.6) { shore = p; break; }
      }
    }
    // Flatten the shore end so the walkway meets level sand.
    island.stamps!.push({ x: shore.x, z: shore.z, radius: 4.6, targetY: shore.y, blend: 0.5 });
    const deckY = Math.max(shore.y + 0.15, 1.5);
    const forward = { x: Math.sin(rotation), z: Math.cos(rotation) };
    const right = { x: Math.cos(rotation), z: -Math.sin(rotation) };
    const center = {
      x: shore.x + forward.x * length * 0.42,
      y: deckY,
      z: shore.z + forward.z * length * 0.42,
    };
    return {
      position: center,
      rotation,
      shoreAngle,
      length,
      width,
      moorSide,
      respawnPoint: {
        x: shore.x + forward.x * Math.min(length * 0.22, 5.5),
        y: deckY + 0.26,
        z: shore.z + forward.z * Math.min(length * 0.22, 5.5),
      },
      // Berth: beside the dock, pushed seaward until BOTH hull ends of the
      // biggest ship class float clear of the beach (281/286 berths used to
      // bury a hull end in the sand — parked ships looked welded to the island).
      berthPosition: (() => {
        const galleonHalf = SHIP_STATS.galleon.length * 0.5 + 5;
        let along = length * 0.42;
        for (let tries = 0; tries < 40; tries++) {
          const cx = shore.x + forward.x * along + right.x * moorSide * (width * 0.65 + 4.6);
          const cz = shore.z + forward.z * along + right.z * moorSide * (width * 0.65 + 4.6);
          const bowGround = getIslandSurfaceY(island, cx + forward.x * galleonHalf, cz + forward.z * galleonHalf);
          const sternGround = getIslandSurfaceY(island, cx - forward.x * galleonHalf, cz - forward.z * galleonHalf);
          const midGround = getIslandSurfaceY(island, cx, cz);
          if (bowGround < -1.2 && sternGround < -1.2 && midGround < -1.2) {
            return { x: cx, y: 0.12, z: cz };
          }
          along += 2.2;
        }
        const cx = shore.x + forward.x * (along + galleonHalf) + right.x * moorSide * (width * 0.65 + 4.6);
        const cz = shore.z + forward.z * (along + galleonHalf) + right.z * moorSide * (width * 0.65 + 4.6);
        return { x: cx, y: 0.12, z: cz };
      })(),
      berthRotation: rotation,
    };
  }

  /**
   * Dig the mooring lane so a hull can lie ALONGSIDE the pier.
   *
   * Match.computeShipBerth anchors a berth with the bow just inside the seaward
   * tip and then slides it along the dock hunting for water deep enough to float
   * the keel. On a shallow shelf that hunt is the whole problem: it would push a
   * galleon 13m past a short pier (Rumrunner Key berthed all three classes at
   * ~25% alongside) rather than admit there was no water at the berth. A real
   * harbour answers that with a dredger, so the generator does too.
   *
   * Only shallow stations get a stamp — a dock already standing in deep water
   * (Booty Bay, Castaway Reach) is left bit-identical. Consumes no rng, and runs
   * AFTER the structure stamps (tavern pad, landmark flattens) so nothing fills
   * the channel back in behind the dredger.
   */
  private dredgeMooringLane(island: Island) {
    const dock = island.dock;
    if (!dock) return;
    const { position: center, length, width, moorSide } = dock;
    const forward = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
    const right = { x: Math.cos(dock.rotation), z: -Math.sin(dock.rotation) };
    // Dredge for the DEEPEST keel that can tie up here; smaller hulls float in
    // the same lane. Same depth arithmetic as the berth planner.
    const stats = SHIP_STATS.galleon;
    const need = -(stats.height * SHIP.HULL_DRAFT_F.galleon + SHIP.GROUND_KEEL_SAFETY + BERTH.BOB_MARGIN);
    const targetY = need - BERTH.DREDGE_HEADROOM;
    const lateral = width * 0.5 + stats.width * 0.5 + BERTH.RAIL_GAP;
    // Wide enough to swallow the three centreline stations the berth planner and
    // grounding both sample, but held off the pier itself: a disc that reached
    // under the walkway sank its lantern posts to the waterline.
    const radius = lateral - width * 0.5 - 1.8;
    // The lane must reach the AFTMOST point the planner samples — a galleon's
    // stern station at the canonical anchor — or the hunt still slides seaward
    // off a shallow patch nobody dug. Held clear of the shore end so the dredge
    // can never bite a notch out of the beach the walkway lands on.
    const anchor = Math.max(0, length * 0.5 - stats.length * 0.5 - BERTH.BOW_INSET);
    const start = Math.max(-length * 0.34, anchor - stats.length * 0.44 - 0.8);
    for (let along = start; along <= length * 0.5 + 2.5; along += 3.2) {
      const x = center.x + forward.x * along + right.x * moorSide * lateral;
      const z = center.z + forward.z * along + right.z * moorSide * lateral;
      if (getIslandSurfaceY(island, x, z) <= targetY) continue;
      const blend = 0.55;
      island.stamps!.push({ x, z, radius, targetY, blend });
      // Close inshore the island's own floor sits ABOVE the target depth, so the
      // cut cannot be made there at all. Take the stamp back out rather than
      // leave one in the list that flattens to a height nothing reaches — a
      // stamp that doesn't hold its own disc is a lie about the terrain.
      if (!this.stampHolds(island, x, z, radius, blend, targetY)) island.stamps!.pop();
    }
  }

  /** Does a stamp actually flatten its inner disc to targetY? (The island floor
   *  clamp in getIslandSurfaceY can refuse a cut this deep.) */
  private stampHolds(island: Island, x: number, z: number, radius: number, blend: number, targetY: number): boolean {
    const inner = radius * (1 - Math.min(0.95, Math.max(0.05, blend))) * 0.8;
    if (Math.abs(getIslandSurfaceY(island, x, z) - targetY) > 0.05) return false;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      if (Math.abs(getIslandSurfaceY(island, x + Math.cos(a) * inner, z + Math.sin(a) * inner) - targetY) > 0.05) return false;
    }
    return true;
  }

  private generateTavern(island: Island, rng: Rng): IslandTavern | null {
    if (!island.dock) return null;

    const dock = island.dock;
    // Place the tavern off the side of the dock, set back inland, on a stamp.
    const sideAngle = dock.shoreAngle + dock.moorSide * 0.55;
    const distRatio = 0.6 + rr(rng, -0.02, 0.04);
    const pos = getIslandSurfacePoint(island, distRatio, sideAngle, 0);
    const rotation = directionToYaw(dock.position.x - pos.x, dock.position.z - pos.z);
    const width = 7.6;
    const depth = 6.4;
    island.stamps!.push({ x: pos.x, z: pos.z, radius: 6.2, targetY: pos.y, blend: 0.42 });

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    // Tavern floor sits 0.18m above the surface — counter Y must match so the
    // bartender stands on planks, not under them.
    const counterPosition: Vec3 = {
      x: pos.x + sinR * (-depth * 0.28),
      y: pos.y + 0.18,
      z: pos.z + cosR * (-depth * 0.28),
    };
    return { position: pos, rotation, width, depth, counterPosition };
  }

  private generateUpgradeStations(island: Island, rng: Rng): UpgradeStation[] {
    const count = island.radius > 70 ? 2 : island.radius > 50 ? 1 : (rng() < 0.55 ? 1 : 0);
    if (count === 0) return [];

    const allTypes: ShipUpgradeType[] = ['hull_reinforcement', 'charged_cannons', 'swift_sails'];
    const types = shuffled(rng, allTypes).slice(0, count);

    return types.map((type, i) => {
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 12 && !pos; attempt++) {
        const angle = island.dock
          ? island.dock.shoreAngle + Math.PI * (0.6 + i * 0.5) + rr(rng, -0.2, 0.2)
          : ra(rng);
        const distRatio = rr(rng, 0.14, 0.4);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0);
        if (candidate.y < 1.2) continue;
        if (this.nearCave(island, candidate.x, candidate.z, 2.5)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 2.4)) continue;
        pos = candidate;
      }
      if (!pos) pos = getIslandSurfacePoint(island, 0.3, ra(rng), 0);
      island.stamps!.push({ x: pos.x, z: pos.z, radius: 2.8, targetY: pos.y, blend: 0.5 });
      return {
        id: uuid(),
        type,
        position: { x: pos.x, y: pos.y + 0.08, z: pos.z },
        claimedByShipId: null,
      };
    });
  }

  // ── Camps: flattened sites that receive campfire/lantern/crate props ──────
  private planCamps(island: Island, rng: Rng): CampSite[] {
    const target = island.radius > 90 ? 2 : 1;
    const camps: CampSite[] = [];
    // Two passes: strict, then relaxed height/slope so even steep islands get
    // a campsite (spacing pads stay fixed).
    for (const relax of [1, 2]) {
      const minY = relax === 1 ? 1.6 : 1.0;
      const maxSlope = relax === 1 ? 0.5 : 0.85;
      for (let attempt = 0; attempt < 26 && camps.length < target; attempt++) {
        const angle = ra(rng);
        const distRatio = rr(rng, 0.28, 0.6);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
        if (pos.y < minY) continue;
        if (this.slopeAt(island, pos.x, pos.z) > maxSlope) continue;
        if (this.nearCave(island, pos.x, pos.z, 3)) continue;
        if (this.nearStamp(island, pos.x, pos.z, 4)) continue;
        if (camps.some((c) => Math.hypot(c.x - pos.x, c.z - pos.z) < 18)) continue;
        island.stamps!.push({ x: pos.x, z: pos.z, radius: 4.8, targetY: pos.y, blend: 0.3 });
        camps.push({ x: pos.x, z: pos.z, y: pos.y });
      }
      if (camps.length >= target) break;
    }
    return camps;
  }

  // ── Landmark POIs (fixed per roster entry) ─────────────────────────────────
  // Placement NEVER silently fails: seeded random attempts run first, then a
  // deterministic golden-angle sweep with progressively relaxed height/slope
  // limits (spacing pads stay fixed so props never interpenetrate), then an
  // absolute fallback on the primary-hill flank — every island keeps its
  // authored landmarks.
  private findLandmarkSite(
    island: Island,
    rng: Rng,
    siteIndex: number,
    limits: { minY: number; maxSlope: number; dLo: number; dHi: number; stampRadius: number; blend: number; pad: number },
  ): { x: number; z: number } {
    const GOLDEN = 2.399963229728653;
    const candidates: Array<{ angle: number; distRatio: number }> = [];
    for (let a = 0; a < 26; a++) candidates.push({ angle: ra(rng), distRatio: rr(rng, limits.dLo, limits.dHi) });
    for (let k = 0; k < 40; k++) {
      candidates.push({
        angle: island.profile.primaryHillAngle + (k + 1) * GOLDEN,
        distRatio: limits.dLo + ((k % 5) / 4) * (limits.dHi - limits.dLo),
      });
    }
    for (const relax of [1, 1.6, 2.6]) {
      for (const c of candidates) {
        const pos = getIslandSurfacePoint(island, c.distRatio, c.angle, 0);
        if (pos.y < limits.minY / relax) continue;
        if (this.slopeAt(island, pos.x, pos.z) > limits.maxSlope * relax) continue;
        if (this.nearCave(island, pos.x, pos.z, 3.5)) continue;
        if (this.nearStamp(island, pos.x, pos.z, limits.pad)) continue;
        island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
        return { x: pos.x, z: pos.z };
      }
    }
    // Absolute fallback: mid-slope near the primary hill, offset per site so
    // two fallbacks on one island can never coincide.
    for (let k = 0; k < 16; k++) {
      const angle = island.profile.primaryHillAngle + Math.PI + siteIndex * 2.1 + k * GOLDEN;
      const pos = getIslandSurfacePoint(island, (limits.dLo + limits.dHi) / 2, angle, 0);
      if (k < 15 && this.nearStamp(island, pos.x, pos.z, limits.pad)) continue;
      island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
      return { x: pos.x, z: pos.z };
    }
    const pos = getIslandSurfacePoint(island, (limits.dLo + limits.dHi) / 2, island.profile.primaryHillAngle + Math.PI, 0);
    island.stamps!.push({ x: pos.x, z: pos.z, radius: limits.stampRadius, targetY: pos.y, blend: limits.blend });
    return { x: pos.x, z: pos.z };
  }

  private planLandmarks(island: Island, entry: RosterEntry, rng: Rng): LandmarkSite[] {
    const sites: LandmarkSite[] = [];
    for (const type of entry.landmarks) {
      if (type === 'fort') {
        // A big stronghold needs a large flat interior pad; stamp a wide disc.
        const s = this.findLandmarkSite(island, rng, sites.length, {
          minY: 3, maxSlope: 0.5, dLo: 0.12, dHi: 0.42, stampRadius: 7.6, blend: 0.42, pad: 8,
        });
        sites.push({ type, x: s.x, z: s.z, yaw: ra(rng) });
      } else if (type === 'watchtower') {
        const s = this.findLandmarkSite(island, rng, sites.length, {
          minY: 4, maxSlope: 0.7, dLo: 0.2, dHi: 0.48, stampRadius: 3.6, blend: 0.5, pad: 4,
        });
        sites.push({ type, x: s.x, z: s.z, yaw: ra(rng) });
      } else if (type === 'standing_stones') {
        const s = this.findLandmarkSite(island, rng, sites.length, {
          minY: 2.5, maxSlope: 0.5, dLo: 0.18, dHi: 0.42, stampRadius: 4.4, blend: 0.4, pad: 4.5,
        });
        sites.push({ type, x: s.x, z: s.z, yaw: ra(rng) });
      } else if (type === 'shipwreck') {
        // Wrecks wash up half-beached at the waterline on beach coasts, away
        // from the dock. Seeded attempts first, then a deterministic sweep
        // scored by beachiness + closeness to the waterline.
        let best: { x: number; z: number; angle: number; score: number } | null = null;
        const consider = (angle: number, strict: boolean) => {
          if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.7) return;
          const w = getIslandCoastWeights(island, angle);
          if (strict && w.beach < 0.55) return;
          const pos = getIslandSurfacePoint(island, 1.02, angle, 0);
          if (strict && (pos.y < -1.3 || pos.y > 1.3)) return;
          if (this.nearStamp(island, pos.x, pos.z, 3)) return;
          const score = w.beach * 2 - Math.abs(pos.y + 0.25);
          if (!best || score > best.score) best = { x: pos.x, z: pos.z, angle, score };
        };
        for (let attempt = 0; attempt < 30 && !best; attempt++) consider(ra(rng), true);
        if (!best) for (let k = 0; k < 64; k++) consider((k / 64) * Math.PI * 2, true);
        if (!best) for (let k = 0; k < 64; k++) consider((k / 64) * Math.PI * 2 + 0.049, false);
        const site = best as { x: number; z: number; angle: number; score: number } | null;
        if (site) {
          sites.push({ type, x: site.x, z: site.z, yaw: angleWrap(site.angle + Math.PI * 0.5 + rr(rng, -0.3, 0.3)) });
        }
      }
    }
    // ── Story scenes (docs/ISLAND_STORY_BIBLE.md) ────────────────────────────
    // A SEPARATE deterministic stream: consuming islandRng here would reshuffle
    // every placement drawn after landmarks (chests/barrels/npcs/props) on the
    // island — the tuned world stays bit-identical with story scenes added.
    const storyRng = mulberry32((entry.seed ^ 0x53ce7a11) >>> 0);
    // Coastal scenes share the rim with un-stamped shipwrecks — enforce the
    // pairwise prop-spacing contract against every already-planned site.
    const farFromSites = (x: number, z: number, type: LandmarkType) => {
      const myR = getPropSpacingRadius(type as IslandPropType, 1);
      for (const s of sites) {
        const otherR = getPropSpacingRadius(s.type as IslandPropType, 1);
        if (Math.hypot(x - s.x, z - s.z) < myR + otherR + 0.6) return false;
      }
      return true;
    };
    for (const type of entry.landmarks) {
      const inland = STORY_INLAND[type];
      if (inland) {
        const s = this.findLandmarkSite(island, storyRng, sites.length, inland);
        // Skull Cove's totem glares over the inlet mouth; other seaward scenes
        // face outward from the island centre.
        const inlet = type === 'skull_totem' ? island.profile.inlets?.[0] : undefined;
        const yaw = inlet
          ? Math.atan2(
              island.position.x + Math.cos(inlet.angle) * island.radius - s.x,
              island.position.z + Math.sin(inlet.angle) * island.radius - s.z,
            )
          : inland.faceSeaward
            ? Math.atan2(s.x - island.position.x, s.z - island.position.z)
            : ra(storyRng);
        sites.push({ type, x: s.x, z: s.z, yaw: angleWrap(yaw) });
        continue;
      }
      const coastal = STORY_COASTAL[type];
      if (coastal) {
        let best: { x: number; z: number; angle: number; score: number } | null = null;
        const consider = (angle: number, distRatio: number, strict: boolean) => {
          if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.7) return;
          const w = getIslandCoastWeights(island, angle);
          if (strict && w.beach < 0.5) return;
          const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
          // Scenes must sit DRY (unlike half-beached wrecks) — keep the band
          // even when relaxing beachiness.
          if (pos.y < coastal.bandLo || pos.y > coastal.bandHi) return;
          if (this.nearStamp(island, pos.x, pos.z, coastal.pad)) return;
          if (!farFromSites(pos.x, pos.z, type)) return;
          const score = w.beach * 2 - Math.abs(pos.y - (coastal.bandLo + coastal.bandHi) * 0.5);
          if (!best || score > best.score) best = { x: pos.x, z: pos.z, angle, score };
        };
        // Deep ratios matter on archipelagos: the footprint envelope is mostly
        // water, and islet beaches sit well inside it.
        const ratios = [0.97, 0.9, 0.82, 0.72, 0.62];
        for (let attempt = 0; attempt < 40 && !best; attempt++) {
          consider(ra(storyRng), ratios[attempt % ratios.length], true);
        }
        for (const strict of [true, false]) {
          if (best) break;
          for (const dr of ratios) {
            for (let k = 0; k < 72; k++) consider((k / 72) * Math.PI * 2 + 0.031, dr, strict);
          }
        }
        const site = best as { x: number; z: number; angle: number; score: number } | null;
        if (site) {
          island.stamps!.push({ x: site.x, z: site.z, radius: coastal.stampRadius, targetY: getIslandSurfaceY(island, site.x, site.z), blend: 0.45 });
          // Face the scene out to sea (authored fronts point game +Z at yaw 0).
          const yaw = Math.atan2(site.x - island.position.x, site.z - island.position.z);
          sites.push({ type, x: site.x, z: site.z, yaw: angleWrap(yaw + rr(storyRng, -0.2, 0.2)) });
        } else {
          // Absolute fallback: inland pad so the scene always exists.
          const s = this.findLandmarkSite(island, storyRng, sites.length, {
            minY: 1.5, maxSlope: 0.6, dLo: 0.3, dHi: 0.6, stampRadius: coastal.stampRadius, blend: 0.45, pad: coastal.pad,
          });
          sites.push({ type, x: s.x, z: s.z, yaw: Math.atan2(s.x - island.position.x, s.z - island.position.z) });
        }
      }
    }
    return sites;
  }

  private generateChests(island: Island, rng: Rng): TreasureChest[] {
    const count = ri(rng, 2, 4);
    const chests: TreasureChest[] = [];
    for (let i = 0; i < count; i++) {
      let angle = 0;
      let distRatio = 0.3;
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 14; attempt++) {
        angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.55) {
          angle += Math.PI * 0.75;
        }
        distRatio = rr(rng, 0.16, 0.56);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0.35);
        if (candidate.y - 0.35 < 1.0) continue; // keep loot on dry land
        if (this.nearCave(island, candidate.x, candidate.z, 1.4)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 1.0)) continue;
        pos = candidate;
        break;
      }
      if (!pos) pos = getIslandSurfacePoint(island, distRatio, angle, 0.35);
      const surfaceY = pos.y;
      const buried = rng() < 0.78;
      if (buried) {
        pos.y = surfaceY - rr(rng, 0.7, 1.35);
      }
      // Chart-exact normalized offsets from the ACTUAL surface point (footprint
      // anisotropy and shoreline bulge included) — the X mark lands on the real
      // world direction and distance, normalized to roughly [-1, 1].
      const maxR = getIslandMaxRadius(island);
      const mapOffsetX = (pos.x - island.position.x) / maxR;
      const mapOffsetZ = (pos.z - island.position.z) / maxR;
      chests.push({
        id: uuid(),
        position: pos,
        opened: false,
        value: ri(rng, ECONOMY.CHEST_VALUE_MIN, ECONOMY.CHEST_VALUE_MAX),
        carriedByPlayerId: null,
        storedOnShipId: null,
        floating: false,
        buried,
        digProgress: buried ? 0 : 1,
        mapOffsetX,
        mapOffsetZ,
        loot: this.rollLoot(rng),
      });
    }
    return chests;
  }

  private generateBarrels(island: Island, rng: Rng): IslandBarrel[] {
    const count = ri(rng, 2, 5);
    const barrels: IslandBarrel[] = [];
    for (let i = 0; i < count; i++) {
      let pos: Vec3 | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        let angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.4) {
          angle += Math.PI * 0.5;
        }
        const distRatio = rr(rng, 0.1, 0.68);
        const candidate = getIslandSurfacePoint(island, distRatio, angle, 0.08);
        if (candidate.y - 0.08 < 1.0) continue;
        if (this.nearCave(island, candidate.x, candidate.z, 1.2)) continue;
        if (this.nearStamp(island, candidate.x, candidate.z, 0.8)) continue;
        pos = candidate;
        break;
      }
      if (!pos) pos = getIslandSurfacePoint(island, 0.4, ra(rng), 0.08);
      barrels.push({
        id: uuid(),
        position: pos,
        opened: false,
        loot: this.rollBarrelLoot(rng),
      });
    }
    return barrels;
  }

  private rollBarrelLoot(rng: Rng) {
    const rolls = ri(rng, 2, 4);
    const loot = new Map<ItemType, number>();
    for (let i = 0; i < rolls; i++) {
      const entry = pickWeighted(rng, [...BARREL_LOOT_TABLE]);
      const qty = ri(rng, entry.minQty, entry.maxQty);
      loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
    }
    return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
  }

  /** A dry standing spot for a shore NPC: march inward from `distRatio` along
   *  `angle` until the surface clears the waterline, so vendors never spawn
   *  knee-deep (or fully submerged) in the surf. */
  private findDryNpcSpot(island: Island, distRatio: number, angle: number): Vec3 {
    let d = distRatio;
    let pos = getIslandSurfacePoint(island, d, angle, 0);
    for (let i = 0; i < 26 && pos.y < 0.85; i++) {
      d = Math.max(0.16, d - 0.03);
      pos = getIslandSurfacePoint(island, d, angle, 0);
    }
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  private generateStoryNpcs(island: Island, islandIndex: number, rng: Rng): IslandNpc[] {
    // Every roster island keeps a speaker now (the Reach used to be mute on
    // nine of fourteen isles). The islands that ALREADY had one keep drawing
    // their placement from the island stream in the same order, so their
    // prop/loot layout is byte-identical; the new speakers draw from a
    // dedicated stream (see npcRng) and never disturb it.
    const shouldSpawn = islandIndex < 3 || (island.radius > 62 && islandIndex % 4 === 0);
    const cast = ISLAND_CAST[islandIndex % ISLAND_CAST.length];
    const npcs: IslandNpc[] = [];

    // Gold hoarders only on a subset of islands — every other dock-hosting island,
    // plus a guaranteed couple early so first-game discovery is fast.
    const hoarderEligible = !!island.dock && island.radius > 50;
    const hoarderHere = hoarderEligible && (islandIndex < 2 || islandIndex % 2 === 0);
    if (hoarderHere) {
      const hoarderAngle = island.dock
        ? island.dock.shoreAngle + island.dock.moorSide * 0.42
        : island.profile.primaryHillAngle - 0.62;
      const hoarderDistRatio = island.dock ? 0.72 : 0.38;
      const hoarderPos = this.findDryNpcSpot(island, hoarderDistRatio, hoarderAngle);
      npcs.push({
        id: uuid(),
        role: 'gold_hoarder',
        name: cast.hoarder?.name ?? `${BROKER_NAME} of ${island.name}`,
        cutsceneTitle: cast.hoarder?.cutsceneTitle ?? `The ${BROKER_NAME} at the Shore`,
        line: cast.hoarder?.line ?? 'Sealed chests, carried in hand. I pay gold, and my charts point at the next mark.',
        cue: NPC_CUES.gold_hoarder,
        position: hoarderPos,
        rotation: directionToYaw(island.position.x - hoarderPos.x, island.position.z - hoarderPos.z),
      });
    }

    if (island.tavern) {
      const t = island.tavern;
      const cosR = Math.cos(t.rotation);
      const sinR = Math.sin(t.rotation);
      // Stand the bartender just behind the bar counter, facing the door.
      const barPos: Vec3 = {
        x: t.counterPosition.x + sinR * 0.55,
        y: t.counterPosition.y,
        z: t.counterPosition.z + cosR * 0.55,
      };
      npcs.push({
        id: uuid(),
        role: 'bartender',
        name: cast.bartender?.name ?? 'Tavernkeeper Bess',
        cutsceneTitle: cast.bartender?.cutsceneTitle ?? 'A Mug at the Counter',
        line: cast.bartender?.line
          ?? 'Sit, sailor. Trade rumours keep the rum warm — drink up and the next horizon feels a touch closer.',
        cue: NPC_CUES.bartender,
        position: barPos,
        rotation: t.rotation + Math.PI,
      });
    }

    // Placement stream: untouched island stream where a speaker already stood,
    // a dedicated per-island stream everywhere else (see the note above).
    const placeRng: Rng = shouldSpawn
      ? rng
      : mulberry32(((islandIndex + 1) * 0x9e3779b9 ^ 0x51ed270b) >>> 0);
    const angle = island.dock
      ? island.dock.shoreAngle + rr(placeRng, -0.34, 0.34)
      : island.profile.primaryHillAngle + rr(placeRng, -0.42, 0.42);
    const distRatio = island.dock ? rr(placeRng, 0.6, 0.74) : rr(placeRng, 0.22, 0.42);
    const pos = this.findDryNpcSpot(island, distRatio, angle);
    const rotation = directionToYaw(island.position.x - pos.x, island.position.z - pos.z);

    npcs.push({
      id: uuid(),
      role: cast.storyteller.role,
      name: cast.storyteller.name,
      cutsceneTitle: cast.storyteller.cutsceneTitle,
      line: cast.storyteller.line,
      cue: NPC_CUES[cast.storyteller.role],
      position: pos,
      rotation,
    });

    return npcs;
  }

  private rollLoot(rng: Rng) {
    const rolls = ri(rng, 3, 6);
    const loot = new Map<ItemType, number>();
    for (let i = 0; i < rolls; i++) {
      const entry = pickWeighted(rng, [...CHEST_LOOT_TABLE]);
      const qty = ri(rng, entry.minQty, entry.maxQty);
      loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
    }
    return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
  }

  // ── Deterministic prop registry ────────────────────────────────────────────
  private generateProps(
    island: Island,
    entry: RosterEntry,
    rng: Rng,
    camps: CampSite[],
    landmarks: LandmarkSite[],
    islandIndex: number,
  ): IslandProp[] {
    const props: IslandProp[] = [];
    const blockers: Array<{ x: number; z: number; r: number }> = [];
    // Island-local sequential id, stable because generation order is
    // deterministic — the harvest system addresses props by (islandId, id).
    let nextPropId = 0;
    const addProp = (type: IslandPropType, x: number, z: number, yaw: number, scale: number) => {
      props.push({ id: nextPropId++, type, x, z, yaw: angleWrap(yaw), scale });
      const r = getPropSpacingRadius(type, scale);
      if (r > 0) blockers.push({ x, z, r });
    };
    const clearOf = (x: number, z: number, r: number) =>
      blockers.every((b) => Math.hypot(x - b.x, z - b.z) >= b.r + r + 0.35);

    // Keep scatter away from interactables.
    for (const st of island.upgradeStations) blockers.push({ x: st.position.x, z: st.position.z, r: 1.6 });
    for (const npc of island.npcs) blockers.push({ x: npc.position.x, z: npc.position.z, r: 1.2 });
    for (const chest of island.chests) blockers.push({ x: chest.position.x, z: chest.position.z, r: 1.0 });
    for (const barrel of island.barrels) blockers.push({ x: barrel.position.x, z: barrel.position.z, r: 0.8 });
    if (island.tavern) blockers.push({ x: island.tavern.position.x, z: island.tavern.position.z, r: 5.6 });

    // 1. Dock walkway modules + lantern pair (y = dock deck height client-side).
    if (island.dock) {
      const dock = island.dock;
      const forward = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
      const right = { x: Math.cos(dock.rotation), z: -Math.sin(dock.rotation) };
      const shoreX = dock.position.x - forward.x * dock.length * 0.42;
      const shoreZ = dock.position.z - forward.z * dock.length * 0.42;
      const midCount = Math.max(1, Math.round((dock.length - 4) / 6));
      for (let i = 0; i < midCount; i++) {
        const d = 3 + i * 6;
        addProp('dock_mid', shoreX + forward.x * d, shoreZ + forward.z * d, dock.rotation, 1);
      }
      const endD = 3 + midCount * 6 - 1;
      addProp('dock_end', shoreX + forward.x * endD, shoreZ + forward.z * endD, dock.rotation, 1);
      for (const side of [-1, 1]) {
        addProp(
          'lantern_post',
          shoreX + forward.x * 1.0 + right.x * side * (dock.width * 0.5 + 0.5),
          shoreZ + forward.z * 1.0 + right.z * side * (dock.width * 0.5 + 0.5),
          dock.rotation,
          1,
        );
      }
    }

    // 2. Camp props on their stamped flats (campfire + lantern + crates).
    // Camp DRESSING (which tent, how it is pitched, how loose the ring is) is
    // drawn from a SEPARATE stream so varying it never reshuffles the long-
    // tuned draws islandRng feeds — same pattern as the story scenes.
    // Before this every island got the identical tent_a + fire + lantern +
    // bedroll + crate kit at the identical radii: "procedural spam once you've
    // seen two islands" (audit P2).
    const campRng = mulberry32((entry.seed ^ 0x33b1f00d) >>> 0);
    // Neighbouring islands must not share a silhouette, so the variant WALKS
    // the roster rather than rolling free — a free roll gave 7 of 12 camps the
    // same tent. Roster order picks the island's first variant, then a stride
    // coprime with the count steps each further camp on the same island.
    let campVariantSeq = islandIndex;
    for (const camp of camps) {
      const theta = ra(rng);
      addProp('campfire', camp.x, camp.z, ra(rng), 1);
      const variant = CAMP_VARIANTS[campVariantSeq % CAMP_VARIANTS.length];
      campVariantSeq += 2; // stride 2 over 3 variants ⇒ every camp differs from the last
      // Tent faces the fire from ~3m; bedroll tucked at the tent mouth.
      const tentAngle = theta + Math.PI * 0.72 + rr(campRng, -0.55, 0.55);
      // Stand-off is the variant's authored band, floored by the two props'
      // own spacing radii (at the largest scale the tent can roll) so a wide
      // guy-rope footprint can never end up laid over the hearth.
      const tentDist = Math.max(
        rr(campRng, variant.tentDist[0], variant.tentDist[1]),
        getPropSpacingRadius('campfire', 1) + getPropSpacingRadius(variant.tent, 1.1) + 0.1,
      );
      const tentX = camp.x + Math.cos(tentAngle) * tentDist;
      const tentZ = camp.z + Math.sin(tentAngle) * tentDist;
      // A tent's base can't drape a drop-off: if the terrain under its ~1.3m
      // footprint falls away more than 1.2m, skip the canvas (the camp keeps
      // its fire). Consume the scale roll REGARDLESS so the rng stream — and
      // every later placement — stays bit-identical (fixed-world contract).
      const tentScale = rr(rng, 0.95, 1.1);
      let tentLo = Infinity;
      let tentHi = -Infinity;
      for (const [ox, oz] of [[0, 0], [1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]] as const) {
        const ty = getIslandSurfaceY(island, tentX + ox, tentZ + oz);
        tentLo = Math.min(tentLo, ty);
        tentHi = Math.max(tentHi, ty);
      }
      if (tentHi - tentLo <= 1.2) {
        // Face the fire, then break the dead-on symmetry: a real pitch is
        // never squared to the hearth.
        const tentYaw = Math.atan2(camp.x - tentX, camp.z - tentZ)
          + variant.tentYawBias + rr(campRng, -0.4, 0.4);
        addProp(variant.tent, tentX, tentZ, tentYaw, tentScale);
      }
      const bedAngle = tentAngle + variant.bedOffset;
      const bedDist = rr(campRng, 1.7, 2.4);
      addProp('bedroll', camp.x + Math.cos(bedAngle) * bedDist, camp.z + Math.sin(bedAngle) * bedDist, ra(rng), 1);
      const lanternAngle = theta + rr(campRng, -0.5, 0.5);
      const lanternDist = rr(campRng, 1.6, 2.3);
      addProp('lantern_post', camp.x + Math.cos(lanternAngle) * lanternDist, camp.z + Math.sin(lanternAngle) * lanternDist, ra(rng), 1);
      const clutter = ri(rng, 1, 3);
      for (let i = 0; i < clutter; i++) {
        // Clutter keeps to the arc opposite the tent so nothing spawns
        // inside the canvas (tent sits at theta + ~2.26 rad).
        const a = theta + 3.5 + i * 0.85 + rr(campRng, -0.25, 0.25);
        const d = rr(rng, 1.8, 2.3) + rr(campRng, 0, variant.clutterSpread);
        const type = rng() < 0.5 ? 'crate' : 'barrel';
        const yaw = ra(rng);
        const scale = rr(rng, 0.9, 1.1);
        // The jitter that breaks the copy-pasted ring can also collide two
        // barrels: the old fixed 0.85-rad arc guaranteed the gap, the jittered
        // one does not. Fall back to the un-jittered slot, then give up —
        // a missing crate beats two crates fused at 1.0 m.
        const spacing = getPropSpacingRadius(type, scale);
        const cx = camp.x + Math.cos(a) * d;
        const cz = camp.z + Math.sin(a) * d;
        if (clearOf(cx, cz, spacing)) {
          addProp(type, cx, cz, yaw, scale);
          continue;
        }
        const fx = camp.x + Math.cos(theta + 3.5 + i * 0.85) * 2.05;
        const fz = camp.z + Math.sin(theta + 3.5 + i * 0.85) * 2.05;
        if (clearOf(fx, fz, spacing)) addProp(type, fx, fz, yaw, scale);
      }
    }

    // 2a. Exposed bedrock CRAGS on the upper flanks of mountain/rocky isles —
    // big angular outcrops so a tall island reads as a rugged massif, not a
    // smooth green cone. This was client-only decoration with NO collision
    // (players walked through the rock); as a registry prop it renders from
    // island.props and blocks with the compound collider in shared/props.ts.
    // Its own rng stream keeps every existing placement bit-identical.
    if (entry.style === 'mountain' || entry.style === 'rocky') {
      const cragRng = mulberry32((entry.seed ^ 0x7c9a11e5) >>> 0);
      const isMtn = entry.style === 'mountain';
      // Density matches the deleted builder: r/12 + 4 on mountains, r/18 + 4
      // on rocky isles.
      const cragTarget = Math.round(island.radius / (isMtn ? 12 : 18)) + 4;
      let cragAttempts = cragTarget * 12;
      let cragsPlaced = 0;
      while (cragsPlaced < cragTarget && cragAttempts-- > 0) {
        const angle = ra(cragRng);
        // Biased to the upper/mid flanks where bare rock shows through.
        const distRatio = 0.12 + cragRng() * (isMtn ? 0.42 : 0.5);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
        // The old builder only drew above y=9; keep that so crags stay a
        // highland read and never litter the beach.
        if (pos.y < 9) continue;
        // Bigger outcrops the higher up the massif you get.
        const scale = 0.85 + cragRng() * (isMtn ? 0.85 : 0.5) + Math.min(0.35, pos.y * 0.006);
        const spacing = getPropSpacingRadius('crag', scale);
        if (this.nearCave(island, pos.x, pos.z, 2.2 + spacing)) continue;
        if (this.nearStamp(island, pos.x, pos.z, spacing + 0.6)) continue;
        if (island.dock && this.nearDockLine(island.dock, pos.x, pos.z, spacing + 1.6)) continue;
        if (!clearOf(pos.x, pos.z, spacing)) continue;
        // Long axis across the slope, so the blades read as strata pushed out
        // of the hillside rather than fins pointing at the player.
        addProp('crag', pos.x, pos.z, angle + Math.PI * 0.5 + rr(cragRng, -0.45, 0.45), scale);
        cragsPlaced++;
      }
    }

    // 2b. One natural rock arch on rugged islands — a real Blender asset at a
    // scenic mid-slope spot (replaces the old blocky client-side arch).
    if (entry.biome === 'bone' || entry.biome === 'highland' || entry.style === 'rocky') {
      const archAngle = island.profile.ridgeAxis + Math.PI * 0.5;
      const archPoint = getIslandSurfacePoint(island, 0.52, archAngle, 0);
      if (archPoint.y > 1.2) {
        addProp('rock_arch', archPoint.x, archPoint.z, archAngle + Math.PI * 0.5, rr(rng, 0.9, 1.25));
      }
    }

    // 3. Landmark POIs.
    for (const site of landmarks) {
      addProp(site.type, site.x, site.z, site.yaw, 1);
      // Hold the approach open in front of walk-in scenes (see
      // STORY_FACING_CLEARANCE): a chain of phantom blockers straight down the
      // scene's facing, so the sprinkle below can never grow a boulder into the
      // doorway. Phantom = blocker only, no prop and no rng draw.
      const reach = STORY_FACING_CLEARANCE[site.type as LandmarkType];
      if (reach) {
        const own = getPropSpacingRadius(site.type as IslandPropType, 1);
        const fx = Math.sin(site.yaw);
        const fz = Math.cos(site.yaw);
        const coneR = Math.max(1.6, own * 0.5);
        for (let d = own * 0.75; d <= reach; d += coneR * 1.2) {
          blockers.push({ x: site.x + fx * d, z: site.z + fz * d, r: coneR });
        }
      }
    }

    // 4a. Dense flourishing patches — a few clustered groves/meadows so the
    //     island reads as flourishing thickets, not an even sprinkle. Placed
    //     BEFORE the base scatter so the sparser sprinkle fills between them.
    const patchFlora = PATCH_MIX[entry.biome];
    const patchCount = Math.max(1, Math.min(3, Math.round(island.radius / 30)));
    for (let p = 0; p < patchCount; p++) {
      // A gentle, well-above-water centre clear of structures/caves/docks.
      let cx = 0;
      let cz = 0;
      let found = false;
      for (let tryC = 0; tryC < 26 && !found; tryC++) {
        const a = ra(rng);
        const dr = rr(rng, 0.22, 0.74);
        const pt = getIslandSurfacePoint(island, dr, a, 0);
        if (pt.y < 1.6) continue;
        if (this.slopeAt(island, pt.x, pt.z) > 0.7) continue;
        if (this.nearStamp(island, pt.x, pt.z, 5)) continue;
        if (this.nearCave(island, pt.x, pt.z, 4)) continue;
        if (island.dock && this.nearDockLine(island.dock, pt.x, pt.z, 6)) continue;
        cx = pt.x;
        cz = pt.z;
        found = true;
      }
      if (!found) continue;
      // Each flower_patch/thicket prop is itself a dense bed, so a modest count
      // reads chock-full while keeping the replicated prop registry lean.
      const patchR = rr(rng, 4.5, 7.5);
      const fill = Math.min(14, Math.round(patchR * patchR * 0.2));
      const localPlaced: Array<{ x: number; z: number }> = [];
      let patchAttempts = fill * 6;
      let placedInPatch = 0;
      while (placedInPatch < fill && patchAttempts-- > 0) {
        const a = ra(rng);
        const rad = Math.pow(rng(), 1.5) * patchR; // denser toward the centre
        const x = cx + Math.cos(a) * rad;
        const z = cz + Math.sin(a) * rad;
        const y = getIslandSurfaceY(island, x, z);
        if (y < 1.4) continue;
        if (this.slopeAt(island, x, z) > 0.95) continue;
        if (this.nearStamp(island, x, z, 0.6)) continue;
        if (island.dock && this.nearDockLine(island.dock, x, z, 1.4)) continue;
        if (!clearOf(x, z, 0.3)) continue; // stay off palms/boulders/structures
        // A small readable gap between neighbours inside the dense bed.
        if (localPlaced.some((q) => Math.hypot(q.x - x, q.z - z) < 0.62)) continue;
        const spec = pickWeighted(rng, patchFlora);
        addProp(spec.type, x, z, ra(rng), rr(rng, 0.85, 1.3));
        localPlaced.push({ x, z });
        placedInPatch++;
      }
    }

    // 4. Biome scatter — an even sprinkle between the patches (pulled back a
    //    little so the dense patches above stand out as the flourishing spots).
    const mix = SCATTER_MIX[entry.biome];
    const target = Math.min(110, Math.max(12, Math.round(island.radius * SCATTER_DENSITY[entry.biome] * 0.8)));
    let placed = 0;
    let attempts = target * 10;
    while (placed < target && attempts-- > 0) {
      const spec = pickWeighted(rng, mix);
      const angle = ra(rng);
      const distRatio = rr(rng, spec.dMin, spec.dMax);
      const scale = rr(rng, spec.sMin, spec.sMax);
      const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
      const spacing = getPropSpacingRadius(spec.type, scale);
      if (pos.y < spec.minY) continue; // above wet sand / never underwater
      if (this.slopeAt(island, pos.x, pos.z) > spec.maxSlope) continue;
      if (this.nearCave(island, pos.x, pos.z, 1.8 + spacing)) continue;
      if (this.nearStamp(island, pos.x, pos.z, spacing + 0.4)) continue;
      if (island.dock && this.nearDockLine(island.dock, pos.x, pos.z, spacing + 1.6)) continue;
      if (!clearOf(pos.x, pos.z, spacing)) continue;
      addProp(spec.type, pos.x, pos.z, ra(rng), scale);
      placed++;
    }

    // 5. INTERIOR FILL on the big isles. The base scatter's density is keyed to
    //    RADIUS, but land AREA grows with radius squared — so the biggest
    //    islands (Castaway Reach r=88 at 102 props over 34,000 m², Booty Bay
    //    r=90 at 104) came out as vast empty lawns you crossed for twenty
    //    seconds seeing nothing. This pass roughly doubles patch + scatter
    //    density inside distRatio ~0.7, where the emptiness lives, leaving the
    //    coastal band as authored. It draws from its OWN stream, and runs after
    //    every existing placement, so nothing already tuned moves by a metre.
    if (island.radius > 80) {
      const fillRng = mulberry32((entry.seed ^ 0x51fbea27) >>> 0);
      // 5a. Two more dense groves/thickets, held to the interior.
      for (let p = 0; p < 2; p++) {
        let cx = 0;
        let cz = 0;
        let found = false;
        for (let tryC = 0; tryC < 30 && !found; tryC++) {
          const pt = getIslandSurfacePoint(island, rr(fillRng, 0.18, 0.62), ra(fillRng), 0);
          if (pt.y < 1.6) continue;
          if (this.slopeAt(island, pt.x, pt.z) > 0.7) continue;
          if (this.nearStamp(island, pt.x, pt.z, 5)) continue;
          if (this.nearCave(island, pt.x, pt.z, 4)) continue;
          if (island.dock && this.nearDockLine(island.dock, pt.x, pt.z, 6)) continue;
          if (!clearOf(pt.x, pt.z, 3)) continue;
          cx = pt.x;
          cz = pt.z;
          found = true;
        }
        if (!found) continue;
        const patchR = rr(fillRng, 5, 8);
        const fill = Math.min(14, Math.round(patchR * patchR * 0.2));
        const localPlaced: Array<{ x: number; z: number }> = [];
        let patchAttempts = fill * 6;
        let placedInPatch = 0;
        while (placedInPatch < fill && patchAttempts-- > 0) {
          const a = ra(fillRng);
          const rad = Math.pow(fillRng(), 1.5) * patchR;
          const x = cx + Math.cos(a) * rad;
          const z = cz + Math.sin(a) * rad;
          if (getIslandSurfaceY(island, x, z) < 1.4) continue;
          if (this.slopeAt(island, x, z) > 0.95) continue;
          if (this.nearStamp(island, x, z, 0.6)) continue;
          if (island.dock && this.nearDockLine(island.dock, x, z, 1.4)) continue;
          if (!clearOf(x, z, 0.3)) continue;
          if (localPlaced.some((q) => Math.hypot(q.x - x, q.z - z) < 0.62)) continue;
          addProp(pickWeighted(fillRng, patchFlora).type, x, z, ra(fillRng), rr(fillRng, 0.85, 1.3));
          localPlaced.push({ x, z });
          placedInPatch++;
        }
      }
      // 5b. Interior sprinkle — same biome mix, but every draw is pulled back
      //     inside the island so it fills the lawn instead of crowding the
      //     already-busy shoreline.
      const fillTarget = Math.round(island.radius * SCATTER_DENSITY[entry.biome] * 0.72);
      let fillPlaced = 0;
      let fillAttempts = fillTarget * 10;
      while (fillPlaced < fillTarget && fillAttempts-- > 0) {
        const spec = pickWeighted(fillRng, mix);
        const angle = ra(fillRng);
        const distRatio = rr(fillRng, Math.max(spec.dMin, 0.12), Math.min(spec.dMax, 0.72));
        const scale = rr(fillRng, spec.sMin, spec.sMax);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
        const spacing = getPropSpacingRadius(spec.type, scale);
        if (pos.y < spec.minY) continue;
        if (this.slopeAt(island, pos.x, pos.z) > spec.maxSlope) continue;
        if (this.nearCave(island, pos.x, pos.z, 1.8 + spacing)) continue;
        if (this.nearStamp(island, pos.x, pos.z, spacing + 0.4)) continue;
        if (island.dock && this.nearDockLine(island.dock, pos.x, pos.z, spacing + 1.6)) continue;
        if (!clearOf(pos.x, pos.z, spacing)) continue;
        addProp(spec.type, pos.x, pos.z, ra(fillRng), scale);
        fillPlaced++;
      }
    }

    return props;
  }

  // ── Placement helpers ──────────────────────────────────────────────────────
  private slopeAt(island: Island, x: number, z: number): number {
    const e = 1.1;
    const yE = getIslandSurfaceY(island, x + e, z);
    const yW = getIslandSurfaceY(island, x - e, z);
    const yN = getIslandSurfaceY(island, x, z + e);
    const yS = getIslandSurfaceY(island, x, z - e);
    return Math.max(Math.abs(yE - yW), Math.abs(yN - yS)) / (2 * e);
  }

  private nearCave(island: Island, x: number, z: number, pad: number): boolean {
    for (const cave of island.caves) {
      const dx = x - cave.position.x;
      const dz = z - cave.position.z;
      const cosR = Math.cos(cave.rotation);
      const sinR = Math.sin(cave.rotation);
      const lx = dx * cosR - dz * sinR;
      const lz = dx * sinR + dz * cosR;
      if (Math.abs(lx) < cave.interiorRadius + pad && lz < 1.0 + pad && lz > -cave.length - pad) return true;
    }
    return false;
  }

  private nearStamp(island: Island, x: number, z: number, pad: number): boolean {
    return (island.stamps ?? []).some((s) => Math.hypot(x - s.x, z - s.z) < s.radius + pad);
  }

  private nearDockLine(dock: IslandDock, x: number, z: number, pad: number): boolean {
    const forward = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
    const ax = dock.position.x - forward.x * dock.length * 0.42;
    const az = dock.position.z - forward.z * dock.length * 0.42;
    const bx = ax + forward.x * dock.length;
    const bz = az + forward.z * dock.length;
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
    const px = ax + abx * t;
    const pz = az + abz * t;
    return Math.hypot(x - px, z - pz) < dock.width * 0.5 + pad;
  }

  generateWildlife(islands: Island[]): WildlifeAnimal[] {
    const rng = this.rng;
    const animals: WildlifeAnimal[] = [];
    for (const island of islands) {
      const baseCount = island.radius > 96 ? 8 : island.radius > 70 ? 6 : island.radius > 54 ? 5 : 4;
      let placed = 0;
      let attempts = 0;
      while (placed < baseCount && attempts < baseCount * 6) {
        attempts++;
        const roll = rng();
        const type: WildlifeType = roll < 0.34
          ? 'crab'
          : roll < 0.62
            ? 'chicken'
            : roll < 0.82
              ? 'pig'
              : 'gull';
        let angle = ra(rng);
        if (island.dock && Math.abs(angleDelta(angle, island.dock.shoreAngle)) < 0.32) {
          angle += Math.PI * 0.55;
        }
        const shoreBias = type === 'crab' ? rr(rng, 0.72, 0.9) : type === 'gull' ? rr(rng, 0.42, 0.76) : rr(rng, 0.22, 0.68);
        const pos = getIslandSurfacePoint(island, shoreBias, angle, type === 'gull' ? 2.2 : 0.08);
        // Skip underwater spawns (beach aprons, archipelago saddles) and cave footprints.
        const groundOnly = pos.y - (type === 'gull' ? 2.2 : 0.08);
        if (groundOnly < (type === 'crab' ? 0.45 : 0.9)) continue;
        if (this.nearCave(island, pos.x, pos.z, 0.5)) continue;
        animals.push({
          // Short deterministic key, not a UUID: 70 animals x 36 wasted bytes
          // was 2.5 KB of every 10 Hz full snapshot spent on decoration ids.
          // The client only ever uses this as an opaque map key.
          id: `w${animals.length}`,
          islandId: island.id,
          type,
          position: { ...pos },
          spawnPosition: { ...pos },
          rotation: ra(rng),
          velocity: { x: 0, y: 0, z: 0 },
          health: WILDLIFE.HEALTH[type],
          wanderAngle: ra(rng),
          wanderTimer: rr(rng, 0.4, 2.4),
        });
        placed++;
      }
    }
    return animals;
  }

  /** UNCHARTED SEA MICRO-POIs.
   *
   *  41% of the Reach's sailable water is more than 180 m from any coast, and a
   *  held heading across it buys ninety seconds of nothing (see
   *  scripts/test-sea-voids.mjs, which already found and pinned the voids).
   *  These are the small hand-nothings that pay a pirate for knowing the sea: a
   *  floating wreck cluster, gull-circled flotsam, a lone mast on a shoal.
   *
   *  FIXED, not per-match: the sites come from findSeaVoids, which reads the
   *  hand-authored island layout alone, and the dressing rolls from ONE salted
   *  stream of its own — so adding them leaves every existing world placement
   *  (islands, props, rocks, spawns) bit-identical. */
  generateSeaPois(islands: Island[]): SeaPoi[] {
    const sites = this.findSeaVoids(islands, [], SEA_POI.COUNT, SEA_POI.SPACING);
    const rng = mulberry32((SEA_POI.SEED ^ 0x9e3779b9) >>> 0);
    // Deepest void gets the hero (the wreck cluster); the lone mast wants a
    // shoal, so it takes the third site and brings its own rock.
    const KINDS: SeaPoiKind[] = ['wreck_cluster', 'flotsam', 'shoal_mast', 'flotsam'];
    return sites.map((site, index) => {
      const kind = KINDS[index % KINDS.length];
      return {
        // Stable, learnable, and 30 bytes lighter on the wire than a uuid.
        id: `sea-poi-${index + 1}`,
        kind,
        position: { x: site.x, y: 0, z: site.z },
        rotation: ra(rng),
        radius: kind === 'wreck_cluster' ? 13 : kind === 'shoal_mast' ? 8 : 9,
        barrelIds: [],
      };
    });
  }

  /** Lash the POIs' supply barrels onto the NEAREST island's barrel array.
   *  They are ordinary IslandBarrels at sea-level world positions, so barrel
   *  proximity, [X] Open, take-all, the client mesh and the wire cadence all
   *  work with no new machinery — the island is only their filing cabinet. */
  attachSeaPoiLoot(pois: SeaPoi[], islands: Island[]): void {
    if (islands.length === 0) return;
    const rng = mulberry32((SEA_POI.SEED ^ 0x1eaf5e11) >>> 0);
    for (const poi of pois) {
      const count = poi.kind === 'wreck_cluster'
        ? SEA_POI.CLUSTER_BARRELS
        : poi.kind === 'flotsam' ? SEA_POI.FLOTSAM_BARRELS : 0;
      if (count === 0) continue;
      let host = islands[0];
      let hostDist = Infinity;
      for (const island of islands) {
        const d = Math.hypot(poi.position.x - island.position.x, poi.position.z - island.position.z);
        if (d < hostDist) { hostDist = d; host = island; }
      }
      for (let i = 0; i < count; i++) {
        const angle = poi.rotation + (i / count) * Math.PI * 2 + rr(rng, -0.3, 0.3);
        const reach = poi.radius * rr(rng, 0.32, 0.55);
        const barrel: IslandBarrel = {
          id: `${poi.id}-b${i}`,
          position: {
            x: poi.position.x + Math.cos(angle) * reach,
            // Riding the raft, not swimming under it.
            y: 0.62,
            z: poi.position.z + Math.sin(angle) * reach,
          },
          opened: false,
          loot: this.rollBarrelLoot(rng),
        };
        host.barrels.push(barrel);
        poi.barrelIds.push(barrel.id);
      }
    }
  }

  /** Cargo of the Gilded Wreck: chests worth banking and a powder store worth
   *  fighting for, scattered along her canted deck and bobbing at her waterline.
   *  Chests come out FLOATING — she is a hull awash, so the shared floating-chest
   *  path (bob on the real sea, grab it from the water, swim it home) does all
   *  the work, and nobody has to walk a deck that isn't there.
   *
   *  `seed` is the match seed mixed with her spawn tick, so two matches never
   *  roll the same hoard while a single match stays replayable. */
  buildWreckLoot(seed: number, position: Vec3, rotation: number): {
    chests: TreasureChest[];
    barrels: IslandBarrel[];
  } {
    const rng = mulberry32((seed ^ 0x9e11ec2b) >>> 0);
    const fwd = { x: Math.sin(rotation), z: Math.cos(rotation) };
    const right = { x: Math.cos(rotation), z: -Math.sin(rotation) };
    const along = (t: number, side: number) => ({
      x: position.x + fwd.x * t + right.x * side,
      z: position.z + fwd.z * t + right.z * side,
    });

    const chests: TreasureChest[] = [];
    for (let i = 0; i < WRECK_EVENT.CHESTS; i++) {
      // Spread down the length of her, alternating sides of the keel line.
      const t = (i / Math.max(1, WRECK_EVENT.CHESTS - 1) - 0.5) * WRECK_EVENT.HULL_HALF_LENGTH * 1.35;
      const side = (i % 2 === 0 ? 1 : -1) * rr(rng, 1.2, WRECK_EVENT.HULL_HALF_BEAM * 0.8);
      const spot = along(t, side);
      chests.push({
        id: `gilded-wreck-c${i}`,
        position: { x: spot.x, y: 0.32, z: spot.z },
        opened: false,
        value: ri(rng, WRECK_EVENT.CHEST_VALUE_MIN, WRECK_EVENT.CHEST_VALUE_MAX),
        carriedByPlayerId: null,
        storedOnShipId: null,
        floating: true,
        buried: false,
        digProgress: 1,
        mapOffsetX: 0,
        mapOffsetZ: 0,
        loot: this.rollLoot(rng),
      });
    }

    const barrels: IslandBarrel[] = [];
    for (let i = 0; i < WRECK_EVENT.BARRELS; i++) {
      const t = (i / Math.max(1, WRECK_EVENT.BARRELS - 1) - 0.5) * WRECK_EVENT.HULL_HALF_LENGTH * 1.0;
      const side = (i % 2 === 0 ? -1 : 1) * rr(rng, 1.6, WRECK_EVENT.HULL_HALF_BEAM * 0.7);
      const spot = along(t + rr(rng, -1.6, 1.6), side);
      barrels.push({
        id: `gilded-wreck-b${i}`,
        position: { x: spot.x, y: 0.66, z: spot.z },
        opened: false,
        loot: this.rollWreckSupply(rng),
      });
    }
    return { chests, barrels };
  }

  /** The powder store: no fruit, no planks — shot, powder and coin. */
  private rollWreckSupply(rng: Rng) {
    const rolls = ri(rng, 3, 4);
    const loot = new Map<ItemType, number>();
    for (let i = 0; i < rolls; i++) {
      const entry = pickWeighted(rng, [...WRECK_SUPPLY_TABLE]);
      const qty = ri(rng, entry.minQty, entry.maxQty);
      loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
    }
    return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
  }

  generateSeaRocks(
    islands: Island[],
    spawns: Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }>,
    seaPois: SeaPoi[] = [],
  ): SeaRock[] {
    const rng = this.rng;
    const rocks: SeaRock[] = [];
    const attempts = SEA_ROCKS.COUNT * 36;

    // The lone mast stands on a SHOAL, and a shoal is a real thing you can put
    // your keel through. Seeded FIRST from a stream of its own so the site is
    // guaranteed and fixed; the match-stream loop below then keeps its usual
    // 45 m off it like any other rock, so no drifting rock ever lands on the POI.
    const shoalRng = mulberry32((SEA_POI.SEED ^ 0x5401d5ea) >>> 0);
    for (const poi of seaPois) {
      if (poi.kind !== 'shoal_mast') continue;
      const radius = SEA_ROCKS.MIN_RADIUS + (SEA_ROCKS.MAX_RADIUS - SEA_ROCKS.MIN_RADIUS) * 0.35;
      // Low and mean: you read it by the mast standing out of it, not by a crag.
      const height = SEA_ROCKS.MIN_HEIGHT * 0.85;
      const colliderSet = buildSeaRockColliders(radius, height, poi.rotation, ri(shoalRng, 0, 2) as 0 | 1 | 2);
      rocks.push({
        id: `${poi.id}-shoal`,
        position: { x: poi.position.x, y: 0, z: poi.position.z },
        radius,
        height,
        rotation: poi.rotation,
        variant: 0,
        colliderBoundsRadius: colliderSet.boundsRadius,
        colliders: colliderSet.colliders,
      });
    }
    const shoalCount = rocks.length;

    for (let attempt = 0; attempt < attempts && rocks.length - shoalCount < SEA_ROCKS.COUNT; attempt++) {
      const angle = ra(rng);
      const dist = rr(rng, 170, WORLD.HALF - 95);
      const radius = rr(rng, SEA_ROCKS.MIN_RADIUS, SEA_ROCKS.MAX_RADIUS);
      const height = rr(rng, SEA_ROCKS.MIN_HEIGHT, SEA_ROCKS.MAX_HEIGHT);
      const rotation = ra(rng);
      const variant = ri(rng, 0, 2) as 0 | 1 | 2;
      const colliderSet = buildSeaRockColliders(radius, height, rotation, variant);
      const candidate: SeaRock = {
        id: uuid(),
        position: {
          x: Math.cos(angle) * dist,
          y: 0,
          z: Math.sin(angle) * dist,
        },
        radius,
        height,
        rotation,
        variant,
        colliderBoundsRadius: colliderSet.boundsRadius,
        colliders: colliderSet.colliders,
      };

      let blocked = false;
      for (const island of islands) {
        const d = Math.hypot(candidate.position.x - island.position.x, candidate.position.z - island.position.z);
        if (d < getIslandMaxRadius(island) + radius + 38) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      for (const spawn of spawns) {
        const d = Math.hypot(candidate.position.x - spawn.position.x, candidate.position.z - spawn.position.z);
        if (d < radius + 80) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      for (const rock of rocks) {
        const d = Math.hypot(candidate.position.x - rock.position.x, candidate.position.z - rock.position.z);
        if (d < candidate.radius + rock.radius + 45) {
          blocked = true;
          break;
        }
      }
      if (!blocked) rocks.push(candidate);
    }

    return rocks;
  }

  generateShipSpawns(islands: Island[]): Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }> {
    const rng = this.rng;
    const spawns: Array<{ position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }> = [];
    const minDist = 120;
    const attempts = 300;

    for (let i = 0; i < WORLD.SHIP_COUNT; i++) {
      let pos: Vec3 | null = null;
      for (let a = 0; a < attempts; a++) {
        const angle = ra(rng);
        const dist = rr(rng, 200, 900);
        const candidate: Vec3 = {
          x: Math.cos(angle) * dist,
          y: 0,
          z: Math.sin(angle) * dist,
        };
        // Not on an island
        let onIsland = false;
        for (const isl of islands) {
          const dx = candidate.x - isl.position.x;
          const dz = candidate.z - isl.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < getIslandMaxRadius(isl) + 30) { onIsland = true; break; }
        }
        // Not too close to another spawn
        let tooClose = false;
        for (const sp of spawns) {
          const dx = candidate.x - sp.position.x;
          const dz = candidate.z - sp.position.z;
          if (Math.sqrt(dx * dx + dz * dz) < minDist) { tooClose = true; break; }
        }
        if (!onIsland && !tooClose) { pos = candidate; break; }
      }
      if (!pos) pos = { x: rr(rng, -700, 700), y: 0, z: rr(rng, -700, 700) };

      // Distribute ship types: mostly sloops, some brigantines, few galleons
      const typeRoll = rng();
      const type = typeRoll < 0.5 ? 'sloop' : typeRoll < 0.8 ? 'brigantine' : 'galleon';
      spawns.push({ position: pos, rotation: ra(rng), type });
    }

    return spawns;
  }

  buildShip(id: string, ownerId: string, spawn: { position: Vec3; rotation: number; type: (typeof SHIP_TYPES)[number] }, teamColor: number): Ship {
    const stats = SHIP_STATS[spawn.type];
    return {
      id,
      type: spawn.type,
      ownerId,
      crewIds: [ownerId],
      position: { ...spawn.position, y: 0 },
      rotation: spawn.rotation,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: 0,
      sailHeight: 0.5,
      sailAngle: 0,
      anchored: false,
      anchorRaiseProgress: 0,
      holes: [],
      nextHoleId: 1,
      maxHull: stats.maxHull,
      onFire: false,
      fireTimer: 0,
      fireDamageAccum: 0,
      sinkProgress: 0,
      sinking: false,
      cannonCooldowns: Array(stats.cannonCount).fill(0),
      chainshottedUntil: 0,
      sailIntegrity: 1,
      sailRepairWoodTimer: 0,
      gold: 0,
      treasureChestIds: [],
      // SoT-style: most cannon ordnance lives in deck barrels (represented as ship stacks)
      inventory: [
        { item: 'cannonball', qty: 48 },
        { item: 'wood_plank', qty: 16 },
        { item: 'banana', qty: 5 },
        { item: 'firebomb_ball', qty: 4 },
        { item: 'chainshot', qty: 14 },
      ],
      repairCooldown: 0,
      autoRepairProgress: 0,
      teamColor,
      alive: true,
      upgrades: [],
    };
  }
}
