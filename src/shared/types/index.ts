// ============================================================
// PIRATES BR — SHARED TYPES
// ============================================================

export interface Vec3 { x: number; y: number; z: number; }
export interface Vec2 { x: number; y: number; }

// ── Ships ────────────────────────────────────────────────────
export type ShipType = 'sloop' | 'brigantine' | 'galleon';

export interface HullSections {
  bow: number;      // 0-1 HP ratio
  stern: number;
  port: number;
  starboard: number;
}

export interface ShipKeg {
  id: string;
  shipId: string;
  position: Vec3;
  localPosition: Vec3;
  section: keyof HullSections;
  plantedById: string;
  timer: number;
}

export type ShipUpgradeType = 'hull_reinforcement' | 'charged_cannons' | 'swift_sails';

export interface ShipUpgrade {
  type: ShipUpgradeType;
}

export interface UpgradeStation {
  id: string;
  type: ShipUpgradeType;
  position: Vec3;
  claimedByShipId: string | null;
}

export type IslandNpcRole = 'mysterious_stranger' | 'shipwright' | 'oracle' | 'gold_hoarder';

export interface IslandNpc {
  id: string;
  role: IslandNpcRole;
  name: string;
  position: Vec3;
  rotation: number;
  cutsceneTitle: string;
  line: string;
  cue: string;
}

export interface Ship {
  id: string;
  type: ShipType;
  ownerId: string;        // crew-lead / bot id
  crewIds: string[];
  position: Vec3;
  rotation: number;       // Y-axis radians
  velocity: Vec3;
  angularVelocity: number;
  sailHeight: number;     // 0 (reefed/slow) – 1 (full/fast)
  sailAngle: number;      // radians, negative = port, positive = starboard
  anchored: boolean;
  anchorRaiseProgress: number; // 0-1 while the capstan is being turned
  hull: HullSections;
  maxHull: number;
  onFire: boolean;
  fireTimer: number;
  fireDamageAccum: number;
  sinkProgress: number;   // 0-1; 1 = fully sunk
  sinking: boolean;
  cannonCooldowns: number[];  // seconds until ready
  chainshottedUntil: number; // timestamp
  /** 0–1 rigging health; chainshot tears canvas and caps speed until repaired at sails */
  sailIntegrity: number;
  /** Seconds accumulated toward next wood plank spent while repairing sails */
  sailRepairWoodTimer: number;
  gold: number;
  treasureChestIds: string[];
  inventory: ItemStack[];
  repairCooldown: number;
  autoRepairProgress: number;
  teamColor: number;      // hex for rendering
  alive: boolean;
  upgrades: ShipUpgrade[];
}

// ── Players ──────────────────────────────────────────────────
export type PlayerState = 'alive' | 'swimming' | 'boarding' | 'respawning' | 'eliminated';
export type WeaponSlot = 0 | 1 | 2 | 3;
export type CannonAmmoType = 'cannonball' | 'firebomb' | 'chainshot';
export type SailControlMode = 'hoist' | 'angle';

export interface Player {
  id: string;
  name: string;
  shipId: string | null;
  position: Vec3;
  rotation: Vec2;      // yaw, pitch
  velocity: Vec3;
  health: number;
  state: PlayerState;
  weapons: (WeaponInstance | null)[];
  activeSlot: WeaponSlot;
  reloading: boolean;
  reloadTimer: number;
  knockbackVelocity: Vec3;
  isBot: boolean;
  kills: number;
  gold: number;
  carryingChestId: string | null;
  treasureMapIslandId: string | null;
  swimTimer: number;   // seconds in open water
  atCannon: boolean;
  atHelm: boolean;
  atSails: boolean;
  sailControlMode: SailControlMode | null;
  /** Climbing / stationed in the main mast crow's nest */
  atCrowNest: boolean;
  cannonIndex: number;
  nearChestId: string | null;
  nearShipId: string | null;
  onShipId: string | null;
  respawnTimer: number;
  respawnProtectionTimer: number;
  shipBoundaryGraceTimer: number;
  lastDamagedById: string | null;
  lastDamageWasHeadshot: boolean;
  selectedCannonAmmo: CannonAmmoType;
  kegs: number;
  kegCooldown: number;
  cannonFlightTimer: number;
  /** True from cannon self-launch until landing in water, on deck, or on ground */
  cannonBallistic: boolean;
  /** Personal supplies (radial wheel) — not ship inventory */
  pocketBanana: number;
  pocketWood: number;
  pocketCoconut: number;
  pocketMango: number;
  hasShovel: boolean;
  nearBarrelId: string | null;
}

// ── Weapons ──────────────────────────────────────────────────
export type WeaponId =
  | 'flintlock'
  | 'eye_of_reach'
  | 'blunderbuss'
  | 'flintknock'
  | 'pistol'
  | 'cutlass'
  | 'ship_cannon';

export interface WeaponInstance {
  weaponId: WeaponId;
  ammo: number;
  reserve: number;
  reloading: boolean;
  reloadTimer: number;
}

// ── Projectiles ──────────────────────────────────────────────
export type ProjectileType = 'bullet' | 'cannonball' | 'firebomb' | 'chainshot';

export interface Projectile {
  id: string;
  type: ProjectileType;
  ownerId: string;
  ownerShipId: string | null;
  position: Vec3;
  velocity: Vec3;
  alive: boolean;
  age: number;
  maxAge: number;
  damage: number;
  knockback: number;   // 0 = none
  visualOnly: boolean;
  showImpact: boolean;
}

// ── Islands & World ──────────────────────────────────────────
export interface IslandProfile {
  islandHeading: number;
  footprintX: number;
  footprintZ: number;
  heightProfile: number;
  beachSpread: number;
  ridgeAxis: number;
  ridgeBias: number;
  mesaBias: number;
  primaryHillAngle: number;
  secondaryHillAngle: number;
  tertiaryHillAngle: number;
  primaryHillOffset: number;
  secondaryHillOffset: number;
  tertiaryHillOffset: number;
  secondaryHillScale: number;
  tertiaryHillScale: number;
}

export interface IslandDock {
  position: Vec3;
  rotation: number;
  shoreAngle: number;
  length: number;
  width: number;
  moorSide: -1 | 1;
  respawnPoint: Vec3;
  berthPosition: Vec3;
  berthRotation: number;
}

export interface Island {
  id: string;
  name: string;
  position: Vec3;
  radius: number;
  profile: IslandProfile;
  dock: IslandDock | null;
  chests: TreasureChest[];
  barrels: IslandBarrel[];
  upgradeStations: UpgradeStation[];
  npcs: IslandNpc[];
}

export interface TreasureChest {
  id: string;
  position: Vec3;
  opened: boolean;
  value: number;
  carriedByPlayerId: string | null;
  storedOnShipId: string | null;
  floating: boolean;
  loot: ItemStack[];
  /** When true, chest is underground until digProgress reaches 1 */
  buried: boolean;
  digProgress: number;
  /** Island-local normalized offsets (roughly -1..1) for treasure-map X marks */
  mapOffsetX: number;
  mapOffsetZ: number;
}

export interface IslandBarrel {
  id: string;
  position: Vec3;
  opened: boolean;
  loot: ItemStack[];
}

export interface ItemStack {
  item: ItemType;
  qty: number;
}

export type ItemType =
  | 'gold'
  | 'cannonball'
  | 'firebomb_ball'
  | 'chainshot'
  | 'banana'
  | 'wood_plank'
  | 'coconut'
  | 'mango'
  | 'flintlock_ammo'
  | 'blunderbuss_ammo'
  | 'eye_ammo'
  | 'flintknock_ammo'
  | 'pistol_ammo';

// ── Storm ────────────────────────────────────────────────────
export interface StormState {
  phase: number;           // 0-indexed
  centerX: number;
  centerZ: number;
  safeRadius: number;      // current safe radius
  nextRadius: number;      // radius it's shrinking toward
  shrinking: boolean;
  shrinkTimer: number;     // seconds until next shrink begins
  shrinkDuration: number;  // seconds to complete shrink
  shrinkProgress: number;  // 0-1
  damagePerSec: number;
}

// ── Trade ─────────────────────────────────────────────────────
export interface TradeSession {
  id: string;
  initiatorId: string;    // player id
  initiatorShipId: string;
  targetPlayerId: string;
  targetShipId: string;
  initiatorOffer: ItemStack[];
  targetOffer: ItemStack[];
  initiatorConfirmed: boolean;
  targetConfirmed: boolean;
  timer: number;           // seconds remaining
  betrayalWindow: boolean;
  botDecisionMade: boolean;
  botBetrayalChecked: boolean;
}

// ── Game State ───────────────────────────────────────────────
export type GamePhase = 'waiting' | 'playing' | 'ended';

/** Great white — rare surface predator; heavy bites, low HP */
export interface Shark {
  id: string;
  position: Vec3;
  rotation: number;
  velocity: Vec3;
  health: number;
  biteCooldown: number;
  targetId: string | null;
}

export interface GameState {
  phase: GamePhase;
  tick: number;
  shipsAlive: number;
  storm: StormState;
  ships: Ship[];
  players: Player[];
  projectiles: Projectile[];
  kegs: ShipKeg[];
  sharks: Shark[];
  islands: Island[];
  tradeSessions: TradeSession[];
  winnerId: string | null;
}

// ── Network messages ─────────────────────────────────────────
export type MsgType =
  | 'join'
  | 'state_snapshot'
  | 'state_delta'
  | 'player_input'
  | 'player_spawned'
  | 'ship_hit'
  | 'player_hit'
  | 'kill_event'
  | 'keg_exploded'
  | 'chest_opened'
  | 'barrel_opened'
  | 'ship_upgraded'
  | 'treasure_sold'
  | 'treasure_map'
  | 'trade_request'
  | 'trade_update'
  | 'trade_result'
  | 'trade_action'
  | 'game_over'
  | 'ping'
  | 'pong';

export interface NetMsg {
  type: MsgType;
  ts: number;
  payload: unknown;
}

// ── Input ────────────────────────────────────────────────────
/** What the client HUD selected for [X] this frame — server must honor it or do nothing (no legacy mis-clicks). */
export type InteractIntent =
  | 'barrel'
  | 'chest'
  | 'board'
  | 'dock'
  | 'mermaid'
  | 'keg_diffuse'
  | 'upgrade'
  | 'gold_hoarder'
  | 'stow_chest'
  | 'helm'
  | 'sails'
  | 'sail_hoist'
  | 'sail_angle'
  | 'crow'
  | 'anchor'
  | 'repair'
  | 'cannon';

export interface PlayerInput {
  seq: number;
  ts: number;
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  jumpPressed: boolean;
  fire: boolean;
  aim: boolean;
  interact: boolean;
  /** True while interact key is held (digging, etc.) */
  interactHeld: boolean;
  anchor: boolean;
  sailRaise: boolean;
  sailLower: boolean;
  sailLeft: boolean;
  sailRight: boolean;
  trade: boolean;
  reload: boolean;
  placeKeg: boolean;
  slot: WeaponSlot | null;
  cannonAmmo: CannonAmmoType | null;
  yaw: number;
  pitch: number;
  /** Radial inventory: 0 banana, 1 wood to ship, 2 coconut, 3 mango */
  wheelIndex: number | null;
  useWheelItem: boolean;
  /** When set, interact (X) must resolve to this action if valid; otherwise no-op (bots send null). */
  interactIntent?: InteractIntent | null;
}

export interface TradeActionPayload {
  sessionId: string;
  action: 'offer' | 'confirm' | 'cancel';
  offer?: ItemStack[];
}
