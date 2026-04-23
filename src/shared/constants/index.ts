import type { WeaponId, ShipType } from '../types/index.js';

// ── World ────────────────────────────────────────────────────
export const WORLD = {
  SIZE: 2000,
  HALF: 1000,
  ISLAND_COUNT: 10,
  SHIP_COUNT: 16,
} as const;

// ── Physics ──────────────────────────────────────────────────
export const PHYSICS = {
  GRAVITY: -18,
  WATER_DRAG: 0.85,
  AIR_DRAG: 0.98,
  BUOYANCY_SPRING: 4,
  WAVE_HEIGHT_MAX: 2.5,
} as const;

// ── Player ───────────────────────────────────────────────────
export const PLAYER = {
  MAX_HEALTH: 100,
  MOVE_SPEED: 5,
  SPRINT_MULT: 1.6,
  SWIM_SPEED: 6.1,
  JUMP_FORCE: 6,
  HEIGHT: 1.75,
  RADIUS: 0.35,
  INTERACT_RANGE: 3.5,
  DROWN_TIME: 60,
  DROWN_DAMAGE: 5,
  RESPAWN_TIME: 20,
  RESPAWN_HEALTH: 50,
  RESPAWN_PROTECTION_TIME: 3.5,
  SHIP_EXIT_GRACE_TIME: 0.6,
  BANANA_HEAL: 25,
  KILL_GOLD_REWARD: 25,
  HEADSHOT_GOLD_BONUS: 15,
  BOARDING_KILL_HEAL: 20,
  BOARDING_GOLD_STEAL_CAP: 60,
  STARTING_KEGS: 2,
  KEG_REPLENISH_COOLDOWN: 60,
} as const;

export const ECONOMY = {
  GOLD_WIN_TARGET: 10000,
  PLAYER_HIT_GOLD_MIN: 3,
  PLAYER_HIT_GOLD_MAX: 14,
  PLAYER_HIT_GOLD_RATIO: 0.08,
  CHEST_VALUE_MIN: 650,
  CHEST_VALUE_MAX: 1450,
} as const;

// ── Ships ────────────────────────────────────────────────────
export const SHIP_STATS: Record<ShipType, {
  maxHull: number;
  cannonCount: number;
  maxSpeed: number;
  turnRate: number;
  width: number;
  length: number;
  height: number;
  mastCount: number;
}> = {
  sloop: {
    maxHull: 600, cannonCount: 2, maxSpeed: 11,
    turnRate: 0.7, width: 5, length: 12, height: 2.2, mastCount: 1,
  },
  brigantine: {
    maxHull: 900, cannonCount: 4, maxSpeed: 9,
    turnRate: 0.45, width: 7, length: 16, height: 2.8, mastCount: 2,
  },
  galleon: {
    maxHull: 1400, cannonCount: 8, maxSpeed: 6.5,
    turnRate: 0.25, width: 10, length: 22, height: 3.5, mastCount: 3,
  },
};

export const SHIP = {
  HULL_SECTION_RATIO: 0.25,   // each section is 1/4 of total
  SINK_TIME: 10,              // seconds
  REPAIR_HP: 100,
  FIELD_REPAIR_DELAY: 10,
  FIELD_REPAIR_INTERVAL: 2.5,
  FIELD_REPAIR_HP: 120,
  MAX_SAIL_ANGLE: Math.PI * 0.48,
  SAIL_TRIM_RATE: 1.55,
  RUDDER_SLEW: 3.25,
  RUDDER_DECAY: 4.1,
  ANCHOR_BRAKE: 4.8,
  ANCHOR_RAISE_TIME: 3.2,
  FIRE_DURATION: 18,
  FIRE_HULL_DAMAGE_PER_SEC: 1.5,
  FIRE_PLAYER_DAMAGE_PER_SEC: 4,
  FIRE_REPAIR_DOUSE_TIME: 9,
  FLOOD_SPEED_PENALTY: 0.12,  // per damaged section
  CANNON_RELOAD: 3.5,         // seconds
  CANNON_DAMAGE_HULL: 120,
  CANNON_DAMAGE_PLAYER: 60,
  CANNON_RADIUS: 4,           // blast radius
  CANNON_SPEED: 60,
  CANNON_GRAVITY_MULT: 0.7,
  CANNON_YAW_ARC: Math.PI * 0.42,
  CANNON_PITCH_MIN: -0.16,
  CANNON_PITCH_MAX: 0.62,
  CANNON_LAUNCH_SPEED: 48,
  CANNON_LAUNCH_VERTICAL_BIAS: 1.2,
  /** Seconds of ballistic arc before normal physics (must cover full trajectory) */
  CANNON_PLAYER_FLIGHT_MAX: 8,
  KEG_FUSE_TIME: 10,
  KEG_PLACE_RANGE: 2.7,
  KEG_DIFFUSE_RANGE: 2.4,
  KEG_PLAYER_RADIUS: 8.5,
  KEG_PLAYER_DAMAGE: 125,
  KEG_PLAYER_MIN_DAMAGE: 8,
  KEG_BLAST_FORCE: 18,
  KEG_PRIMARY_DAMAGE_RATIO: 0.26,
  KEG_SPLASH_DAMAGE_RATIO: 0.08,
  /** Rigging repair at sail station (per second while holding interact + wood) */
  SAIL_REPAIR_RATE: 0.42,
  SAIL_REPAIR_WOOD_INTERVAL: 0.85,
  CHAINSHOT_SAIL_DAMAGE: 0.38,
} as const;

export const SHARK = {
  MAX_WORLD: 4,
  SPAWN_CHANCE_PER_TICK: 0.00055,
  SPAWN_SWIM_GRACE: 8,
  SPAWN_COOLDOWN_MIN: 12,
  SPAWN_COOLDOWN_MAX: 20,
  /** Takes several gun hits — not a one-tap */
  HEALTH: 280,
  /** Multiplier vs firearm hitscan damage */
  GUN_DAMAGE_MULT: 0.48,
  BITE_DAMAGE: 52,
  BITE_RANGE: 2.35,
  BITE_COOLDOWN: 2.35,
  CHASE_SPEED: 5.8,
  HIT_RADIUS: 1.15,
  SPAWN_MIN_DIST: 26,
  SPAWN_MAX_DIST: 52,
} as const;

// ── Ship Upgrades ────────────────────────────────────────────
export const SHIP_UPGRADES = {
  HULL_HP_MULT: 1.25,
  CANNON_DAMAGE_MULT: 1.30,
  SWIFT_SPEED_MULT: 1.20,
} as const;

// ── Weapons ──────────────────────────────────────────────────
export const WEAPONS: Record<WeaponId, {
  name: string;
  damage: number;
  reloadTime: number;
  ammoMax: number;
  reserveMax: number;
  range: number;
  spread: number;         // degrees half-angle
  pellets: number;        // for blunderbuss
  knockback: number;      // force units
  melee: boolean;
  projectileSpeed: number;
  scopeFov: number | null;
}> = {
  flintlock: {
    name: 'Flintlock Pistol', damage: 45, reloadTime: 1.5,
    ammoMax: 1, reserveMax: 5, range: 60, spread: 0.28, pellets: 1,
    knockback: 3, melee: false, projectileSpeed: 120, scopeFov: null,
  },
  eye_of_reach: {
    name: 'Sniper Rifle', damage: 95, reloadTime: 2.35,
    ammoMax: 1, reserveMax: 5, range: 5000, spread: 0.01, pellets: 1,
    knockback: 4, melee: false, projectileSpeed: 220, scopeFov: 14,
  },
  blunderbuss: {
    name: 'Blunderbuss', damage: 13, reloadTime: 2.0,
    ammoMax: 1, reserveMax: 5, range: 20, spread: 6, pellets: 7,
    knockback: 6, melee: false, projectileSpeed: 80, scopeFov: null,
  },
  flintknock: {
    name: 'Flintknock Pistol', damage: 30, reloadTime: 2.5,
    ammoMax: 1, reserveMax: 5, range: 50, spread: 0.4, pellets: 1,
    knockback: 28, melee: false, projectileSpeed: 100, scopeFov: null,
  },
  pistol: {
    name: 'Pistol', damage: 25, reloadTime: 0.7,
    ammoMax: 2, reserveMax: 10, range: 50, spread: 0.6, pellets: 1,
    knockback: 2, melee: false, projectileSpeed: 110, scopeFov: null,
  },
  cutlass: {
    name: 'Cutlass', damage: 30, reloadTime: 0.55,
    ammoMax: 0, reserveMax: 0, range: 2.5, spread: 0, pellets: 1,
    knockback: 5, melee: true, projectileSpeed: 0, scopeFov: null,
  },
  ship_cannon: {
    name: 'Ship Cannon', damage: 120, reloadTime: 3.5,
    ammoMax: 1, reserveMax: 20, range: 300, spread: 0.5, pellets: 1,
    knockback: 0, melee: false, projectileSpeed: SHIP.CANNON_SPEED, scopeFov: null,
  },
};

// ── Storm ────────────────────────────────────────────────────
// Fortnite-style: long first grace period, escalating urgency, lethal endgame.
// Each phase: wait (safe zone static), then shrink to next radius.
// dmgPerSec tuned ~4× gentler than early builds so the ring is threatening but not instant.
export const STORM_PHASES = [
  // Phase 1 — explore, loot, get your bearings (3 min wait)
  { waitSec: 180, shrinkSec: 90,  startRadius: 950, endRadius: 680, dmgPerSec:  0.5 },
  // Phase 2 — circle tightens, time to sail inward (2 min wait)
  { waitSec: 120, shrinkSec: 60,  startRadius: 680, endRadius: 480, dmgPerSec:  1.2 },
  // Phase 3 — urgency kicks in (90 s wait)
  { waitSec:  90, shrinkSec: 45,  startRadius: 480, endRadius: 320, dmgPerSec:  2 },
  // Phase 4 — getting spicy (60 s wait)
  { waitSec:  60, shrinkSec: 35,  startRadius: 320, endRadius: 190, dmgPerSec:  3.5 },
  // Phase 5 — danger zone (45 s wait)
  { waitSec:  45, shrinkSec: 25,  startRadius: 190, endRadius:  95, dmgPerSec:  5.5 },
  // Phase 6 — very dangerous (30 s wait)
  { waitSec:  30, shrinkSec: 20,  startRadius:  95, endRadius:  40, dmgPerSec:  8.5 },
  // Phase 7 — endgame, lethal outside (15 s wait)
  { waitSec:  15, shrinkSec: 15,  startRadius:  40, endRadius:  12, dmgPerSec:  12 },
];

// ── Loot tables ──────────────────────────────────────────────
export const CHEST_LOOT_TABLE = [
  { item: 'gold' as const,           weight: 28, minQty: 50,  maxQty: 200 },
  { item: 'cannonball' as const,     weight: 22, minQty: 3,   maxQty: 8   },
  { item: 'banana' as const,         weight: 18, minQty: 1,   maxQty: 3   },
  { item: 'wood_plank' as const,     weight: 18, minQty: 1,   maxQty: 4   },
  { item: 'coconut' as const,        weight: 14, minQty: 1,   maxQty: 2   },
  { item: 'mango' as const,          weight: 14, minQty: 1,   maxQty: 2   },
  { item: 'firebomb_ball' as const,  weight: 10, minQty: 1,   maxQty: 2   },
  { item: 'chainshot' as const,      weight: 8,  minQty: 1,   maxQty: 2   },
  { item: 'flintlock_ammo' as const,  weight: 0,  minQty: 2,   maxQty: 5   },
  { item: 'blunderbuss_ammo' as const,weight: 14, minQty: 2,   maxQty: 5   },
  { item: 'eye_ammo' as const,        weight: 10, minQty: 2,   maxQty: 4   },
  { item: 'flintknock_ammo' as const, weight: 20, minQty: 2,   maxQty: 4   },
  { item: 'pistol_ammo' as const,    weight: 15, minQty: 3,   maxQty: 8   },
];

/** Supplies on island resource barrels (Sea of Thieves style) */
export const BARREL_LOOT_TABLE = [
  { item: 'banana' as const,         weight: 22, minQty: 1, maxQty: 3 },
  { item: 'coconut' as const,        weight: 18, minQty: 1, maxQty: 2 },
  { item: 'mango' as const,          weight: 18, minQty: 1, maxQty: 2 },
  { item: 'wood_plank' as const,     weight: 20, minQty: 1, maxQty: 3 },
  { item: 'cannonball' as const,     weight: 14, minQty: 2, maxQty: 6 },
  { item: 'firebomb_ball' as const,  weight: 6,  minQty: 1, maxQty: 1 },
  { item: 'chainshot' as const,      weight: 5,  minQty: 1, maxQty: 2 },
];

export const POCKET = {
  FRUIT_HEAL: 22,
  DIG_RATE: 0.42,
} as const;

// ── Tick rate ────────────────────────────────────────────────
export const SERVER_TICK_MS = 16;  // ~60 Hz
export const SNAPSHOT_RATE = 2;    // 30 Hz snapshots; clients interpolate render motion
