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
  shipId: string | null;
  position: Vec3;
  localPosition: Vec3 | null;
  section: keyof HullSections;
  plantedById: string;
  timer: number;
  /** Kill-streak keg: much heavier hull damage when it detonates on a ship. */
  mega?: boolean;
  /** Set when a player cuts the fuse — the keg is inert and must never detonate. */
  defused?: boolean;
}

export type ShipUpgradeType = 'hull_reinforcement' | 'charged_cannons' | 'swift_sails';

/** Held tools selectable from the supply wheel (all innate to the pirate). */
export type EquippableTool = 'spyglass' | 'compass' | 'bucket' | 'shovel' | 'lantern';

export interface ShipUpgrade {
  type: ShipUpgradeType;
}

export interface UpgradeStation {
  id: string;
  type: ShipUpgradeType;
  position: Vec3;
  claimedByShipId: string | null;
}

export type IslandNpcRole = 'mysterious_stranger' | 'shipwright' | 'oracle' | 'gold_hoarder' | 'bartender';

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
  /** Open holes per hull section (integer counts, 0..MAX_HOLES_PER_SECTION) —
   *  the AUTHORITATIVE damage state. Cannonballs punch holes; planks patch them. */
  holes: HullSections;
  /** Derived per-section integrity (0..1) computed from `holes`, kept purely for
   *  the HUD gauges and damage visuals. Damage/flood/sink all key off `holes`. */
  hull: HullSections;
  /** Legacy hull-class number kept for display; no longer scales any damage. */
  maxHull: number;
  onFire: boolean;
  fireTimer: number;
  fireDamageAccum: number;
  sinkProgress: number;   // 0-1; 1 = fully sunk
  sinking: boolean;
  cannonCooldowns: number[];  // seconds until ready
  chainshottedUntil: number; // sim-time seconds (GameState.serverTime clock)
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
  // ── Server wave-riding dynamics (optional: set by PhysicsSystem each tick,
  //    read defensively by the client renderer) ───────────────────────────
  /** Wave attitude pitch in radians, spring-damped. Positive dips the bow. */
  pitch?: number;
  /** Wave attitude roll in radians, spring-damped. Positive raises the starboard rail. */
  roll?: number;
  /** Residual water-surface detail (m) the smoothed hull position filtered out —
   *  the renderer adds it to position.y so hulls sit exactly on the Gerstner surface. */
  heave?: number;
  /** Rudder blade deflection in radians; positive = helm-right input. Turning only
   *  bites with way on the ship. */
  rudderAngle?: number;
  /** True when pointed inside the upwind no-go cone with canvas set — sails luff. */
  luffing?: boolean;
  // ── Flooding (SoT naval damage loop) ─────────────────────────────────────
  /** Normalized bilge fill 0 (dry) – 1 (swamped → sinks). Holed sections below
   *  the waterline take on water; bailing / bilge pump removes it. */
  waterLevel?: number;
  /** Net water-level rate/sec from ingress vs the passive pump (client gauge
   *  trend arrow). Positive = flooding, negative = draining, 0 = dry/holding. */
  floodingRate?: number;
}

// ── Players ──────────────────────────────────────────────────
/** 'downed' = down-but-not-out: hp reached 0 with living crewmates — the pirate
 *  crawls at reduced speed, cannot use weapons/stations, bleeds out over
 *  DBNO.BLEEDOUT_SECONDS (2× faster outside the storm ring) and can be revived
 *  by a crewmate holding interact, or finished by any damage. */
export type PlayerState = 'alive' | 'swimming' | 'boarding' | 'downed' | 'respawning' | 'eliminated';
export type WeaponSlot = 0 | 1 | 2 | 3;
export type CannonAmmoType = 'cannonball' | 'firebomb' | 'chainshot';

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
  /** Consecutive pirate kills since last death; PvE kills do not count. */
  playerKillStreak: number;
  superCannonballs: number;
  megaKegs: number;
  tsunamiCharges: number;
  gold: number;
  carryingChestId: string | null;
  treasureMapIslandId: string | null;
  swimTimer: number;   // seconds in open water
  atCannon: boolean;
  atHelm: boolean;
  atSails: boolean;
  /** Climbing / stationed in the main mast crow's nest */
  atCrowNest: boolean;
  /** Cutlass guard is held; frontal melee damage is mostly blocked. */
  blocking: boolean;
  /** True while actively bailing water out of the current ship's bilge. */
  bailing?: boolean;
  /** 0-1 cutlass lunge charge progress, replicated for third-person windup. */
  cutlassCharge: number;
  cannonIndex: number;
  nearChestId: string | null;
  nearShipId: string | null;
  onShipId: string | null;
  respawnTimer: number;
  respawnProtectionTimer: number;
  shipBoundaryGraceTimer: number;
  lastDamagedById: string | null;
  /** Sim time (seconds) when lastDamagedById was set — stale credit expires. */
  lastDamagedAt: number | null;
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
  pocketMeat: number;
  /** Seconds remaining before the pocket wheel can be used again (one fruit at a time) */
  pocketUseCooldown: number;
  hasShovel: boolean;
  /** Spyglass tool — always in the pirate's kit; the client implements the zoom. */
  hasSpyglass: boolean;
  /** Tool currently held from the supply wheel — drives the spyglass zoom,
   *  physical bucket bailing, and the compass bearing. null = weapon in hand. */
  equippedTool: EquippableTool | null;
  /** 0..1 animation timer for the current scoop/heave action (paces the cycle). */
  bailScoopProgress: number;
  /** True once a bucketful of bilge has been scooped and is being carried; the
   *  next bail action heaves it overboard (empties the bucket). */
  bucketFilled: boolean;
  nearBarrelId: string | null;
  // ── Down-but-not-out (DBNO) ────────────────────────────────
  /** Seconds of bleed-out remaining while state === 'downed'. Drains 2× faster
   *  outside the storm safe ring. 0 when not downed. */
  downedUntil: number;
  /** 0-1 revive progress while a crewmate holds interact next to this downed
   *  player. Decays when the revive is interrupted. 0 when not downed. */
  reviveProgress: number;
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
export type ProjectileType = 'bullet' | 'cannonball' | 'firebomb' | 'chainshot' | 'tsunami';

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
  special?: 'super_cannonball' | 'tsunami';
  weaponId?: WeaponId;
}

// ── Islands & World ──────────────────────────────────────────
/** High-level biome identity — drives client vertex palettes and prop mixes. */
export type IslandBiome = 'lush' | 'palm_atoll' | 'volcanic' | 'highland' | 'bone';

/** Exact GLB asset names in public/assets/models (see its README manifest). */
export type IslandPropType =
  | 'palm_a' | 'palm_b' | 'palm_c' | 'palm_tall' | 'palm_ground'
  | 'boulder_a' | 'boulder_b' | 'boulder_c'
  | 'barrel' | 'crate' | 'campfire' | 'lantern_post'
  | 'watchtower' | 'shipwreck' | 'standing_stones' | 'fort'
  | 'tent_a' | 'bedroll' | 'rock_arch'
  | 'bush' | 'bush_berry' | 'flower_bush' | 'fern_plant' | 'flower_patch' | 'wildflowers'
  | 'dock_mid' | 'dock_end';

/** Deterministic decorative/landmark prop. Positions are WORLD-space XZ; Y is
 *  sampled via getIslandSurfaceY at need (dock_mid/dock_end/dock lanterns sit at
 *  dock deck height instead of terrain height). */
export interface IslandProp {
  type: IslandPropType;
  x: number;
  z: number;
  yaw: number;
  scale: number;
}

/** World-space flatten disc applied inside getIslandSurfaceY so structures
 *  (docks, taverns, camps, stations) sit on level ground. */
export interface TerrainStamp {
  x: number;
  z: number;
  radius: number;
  targetY: number;
  /** 0..1 fraction of the radius used as the smooth falloff rim. */
  blend: number;
}

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
  /** 0 = ordinary tropical isle, 1 = dramatic mountain peak. Boosts primary-hill height. */
  peakBoost: number;
  /** Identifier for the high-level shape archetype, used by the client for decoration. */
  terrainStyle: 'tropical' | 'mountain' | 'plateau' | 'rocky' | 'twin' | 'archipelago' | 'crescent';
  /** Concave shoreline indentations — narrow deep ones read as coves, wide
   *  shallow ones as bays. Shared by physics + mesh so the carved water is
   *  walkable/sailable identically on server and client. */
  inlets?: IslandInlet[];
  /** Fixed per-roster-entry seed. Drives the coast-type bands, prop scatter and
   *  structure stamps deterministically — the same named island is identical
   *  (up to placement/rotation) every match. */
  seed?: number;
  /** Biome identity for client palettes/prop mixes. */
  biome?: IslandBiome;
  /** Palette hints (0xRRGGBB) the client keys vertex colors off. */
  palette?: { sand: number; grass: number; rock: number; foliage: number };
  /** Shifts the per-angle coast field: -1 ⇒ almost all beach, +1 ⇒ mostly cliff. */
  coastBias?: number;
  /** Bright white-sand beaches (tropical postcard isles) rather than muted tan. */
  whiteSand?: boolean;
}

export interface IslandInlet {
  /** World-space angle (radians) of the inlet mouth from the island centre. */
  angle: number;
  /** Angular half-width of the mouth (radians). Wider ⇒ bay, narrower ⇒ cove. */
  width: number;
  /** 0..1 fraction of the radius the inlet bites inward. */
  depth: number;
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

export interface IslandTavern {
  position: Vec3;
  rotation: number;
  /** Footprint width (x) and depth (z) in metres. */
  width: number;
  depth: number;
  /** World position the bartender stands behind the bar. */
  counterPosition: Vec3;
}

export interface IslandCave {
  /** World position at the entrance opening. */
  position: Vec3;
  /** Rotation so the entrance faces outward (radians, yaw). */
  rotation: number;
  /** Mouth width and height in metres. */
  width: number;
  height: number;
  /** How far the cave tunnel extends into the island. */
  length: number;
  /** Half-width of the walkable interior (perpendicular to the tunnel axis). */
  interiorRadius: number;
  /** World Y of the cave floor. getCaveFloorY blends the carved trench to this. */
  floorY: number;
  /** World Y of the interior ceiling (≈ floorY + height). Together with
   *  interiorRadius/length/floorY this defines the walkable interior box —
   *  the physics track clamps in-cave player Y to [floorY, ceilingY]. */
  ceilingY?: number;
}

export interface Island {
  id: string;
  name: string;
  position: Vec3;
  radius: number;
  profile: IslandProfile;
  dock: IslandDock | null;
  tavern: IslandTavern | null;
  caves: IslandCave[];
  chests: TreasureChest[];
  barrels: IslandBarrel[];
  upgradeStations: UpgradeStation[];
  npcs: IslandNpc[];
  /** Deterministic per-island props (world-space XZ; see IslandProp). */
  props?: IslandProp[];
  /** Flatten discs consumed by getIslandSurfaceY (docks/taverns/camps/stations). */
  stamps?: TerrainStamp[];
  /** Walkable rope bridges between peaks (world-space endpoints ON the terrain).
   *  Deck height is shared math (getBridgeDeckY) so client visuals, client
   *  prediction and server locomotion all agree. */
  bridges?: IslandBridge[];
  /** Volcanic geyser vents that launch a pirate skyward on eruption (volcanic
   *  biome only). Timing is shared (geyserEruptionLevel) so the plume and the
   *  server launch fire together. */
  geysers?: IslandGeyser[];
}

export interface IslandBridge {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Walkable deck width in meters. */
  width: number;
}

/** A volcanic geyser vent. Erupts on a deterministic cycle keyed off shared
 *  match time, so the plume the client draws fires exactly when the server
 *  launches a pirate standing on it (shared geyserEruptionLevel). */
export interface IslandGeyser {
  /** World XZ of the vent center. */
  x: number;
  z: number;
  /** Ground surface Y at the vent rim (where the plume erupts from). */
  y: number;
  /** Horizontal radius within which a grounded pirate is launched. */
  radius: number;
  /** Full eruption cycle length (seconds). */
  period: number;
  /** Seconds of each cycle the plume is actually erupting. */
  activeDuration: number;
  /** Per-vent phase offset (seconds) so neighbouring vents don't fire in unison. */
  phaseOffset: number;
  /** Peak upward launch speed (m/s) at full eruption. */
  power: number;
}

export interface TreasureChest {
  id: string;
  position: Vec3;
  opened: boolean;
  value: number;
  carriedByPlayerId: string | null;
  storedOnShipId: string | null;
  /** Loose chest dropped on a moving deck; follows this ship until picked up/stowed/sold. */
  droppedOnShipId?: string | null;
  droppedLocalPosition?: Vec3 | null;
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

export type WildlifeType = 'crab' | 'chicken' | 'pig' | 'gull';

export interface WildlifeAnimal {
  id: string;
  islandId: string;
  type: WildlifeType;
  position: Vec3;
  spawnPosition: Vec3;
  rotation: number;
  velocity: Vec3;
  health: number;
  wanderAngle: number;
  wanderTimer: number;
}

export interface SeaRockCollider {
  /** Local-space offset from rock origin; rotated by SeaRock.rotation for world collision. */
  localX: number;
  localZ: number;
  /** Horizontal cylinder radius. */
  radius: number;
  /** World-space vertical range relative to SeaRock.position.y. */
  minY: number;
  maxY: number;
}

export interface SeaRock {
  id: string;
  position: Vec3;
  radius: number;
  height: number;
  rotation: number;
  variant: 0 | 1 | 2;
  /** Broadphase radius enclosing all cheap collider primitives. */
  colliderBoundsRadius: number;
  /** Low-cost "mesh collider" approximation used by server physics and hitscan. */
  colliders: SeaRockCollider[];
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
  | 'meat'
  | 'flintlock_ammo'
  | 'blunderbuss_ammo'
  | 'eye_ammo'
  | 'flintknock_ammo'
  | 'pistol_ammo'
  | 'spyglass';

// ── Storm ────────────────────────────────────────────────────
export interface StormState {
  phase: number;           // 0-indexed
  centerX: number;
  centerZ: number;
  nextCenterX: number;     // target safe-zone center for the next shrink
  nextCenterZ: number;
  shrinkStartCenterX: number;
  shrinkStartCenterZ: number;
  shrinkStartRadius: number;
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
  /** Server simulation clock in seconds — clients sync the ocean wave clock to this. */
  serverTime: number;
  shipsAlive: number;
  storm: StormState;
  ships: Ship[];
  players: Player[];
  projectiles: Projectile[];
  kegs: ShipKeg[];
  sharks: Shark[];
  wildlife: WildlifeAnimal[];
  seaRocks: SeaRock[];
  islands: Island[];
  tradeSessions: TradeSession[];
  winnerId: string | null;
}

// ── Hot snapshot (high-rate light wire format) ────────────────
// 'state_hot' rides every snapshot tick (~31 Hz) carrying only fast-moving
// transforms; full 'state_snapshot' messages (~10 Hz) remain the source of
// truth. The client patches hot fields by id onto its last full state.
// Clients that ignore 'state_hot' keep working off full snapshots alone.
export interface HotShipState {
  id: string;
  position: Vec3;
  rotation: number;
  velocity: Vec3;
  angularVelocity: number;
  pitch?: number;
  roll?: number;
  heave?: number;
  rudderAngle?: number;
  sailHeight: number;
  sailAngle: number;
  sinking: boolean;
  sinkProgress: number;
  waterLevel?: number;
  floodingRate?: number;
}

export interface HotPlayerState {
  id: string;
  position: Vec3;
  rotation: Vec2;
  velocity: Vec3;
  health: number;
  state: PlayerState;
  onShipId: string | null;
  cutlassCharge: number;
  downedUntil: number;
  reviveProgress: number;
}

export interface HotProjectileState {
  id: string;
  type: ProjectileType;
  position: Vec3;
  velocity: Vec3;
}

export interface HotKegState {
  id: string;
  position: Vec3;
  timer: number;
}

export interface HotSharkState {
  id: string;
  position: Vec3;
  rotation: number;
  health: number;
}

export interface HotSnapshotPayload {
  tick: number;
  serverTime: number;
  shipsAlive: number;
  storm: StormState;
  ships: HotShipState[];
  players: HotPlayerState[];
  projectiles: HotProjectileState[];
  kegs: HotKegState[];
  sharks: HotSharkState[];
}

// ── Network messages ─────────────────────────────────────────
export type MsgType =
  // game-scoped messages (within a match)
  | 'join'
  | 'state_snapshot'
  | 'state_hot'
  | 'state_delta'
  | 'player_input'
  | 'player_spawned'
  | 'ship_hit'
  | 'ship_damage'
  | 'player_hit'
  | 'kill_event'
  | 'player_downed'
  | 'revive_start'
  | 'revive_complete'
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
  | 'match_ended'
  | 'ping'
  | 'pong'
  // lobby-scoped messages (server orchestration)
  | 'welcome'
  | 'set_name'
  | 'create_party'
  | 'join_party'
  | 'leave_party'
  | 'update_party_settings'
  | 'start_match'
  | 'queue_join'
  | 'queue_leave'
  | 'queue_update'
  | 'solo_start'
  | 'lobby_update'
  | 'lobby_left'
  | 'lobby_error'
  | 'match_start'
  | 'return_to_menu'
  | 'play_again'
  | 'stats_update';

// ── Lobby payload shapes ─────────────────────────────────────
export interface LobbyMember {
  clientId: string;
  name: string;
  isHost: boolean;
}

export interface LobbyUpdatePayload {
  code: string;
  hostId: string;
  members: LobbyMember[];
  botFill: number;
  capacity: number;
  canStart: boolean;
}

export interface QueueUpdatePayload {
  inQueue: number;
  needed: number;
  secondsRemaining: number;
  /** True when the queue is locked in and a match is about to start. */
  starting: boolean;
}

export interface PlayerStatsRecord {
  name: string;
  kills: number;
  deaths: number;
  wins: number;
  matchesPlayed: number;
  totalGold: number;
  bestPlacement: number;
}

export interface WelcomePayload {
  clientId: string;
  stats: PlayerStatsRecord | null;
  partyCapacity: number;
}

export interface MatchStartPayload {
  matchId: string;
  source: 'party' | 'queue';
  expectedHumans: number;
  botCount: number;
  /** Set when the match was launched from a private crew party. Null for solo or public-queue. */
  partyCode: string | null;
}

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
  | 'crow'
  | 'anchor'
  | 'repair'
  | 'bail'
  | 'revive'
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
  dropChest: boolean;
  specialAttack: boolean;
  slot: WeaponSlot | null;
  cannonAmmo: CannonAmmoType | null;
  yaw: number;
  pitch: number;
  /** Radial inventory: 0 banana, 1 wood to ship, 2 coconut, 3 mango */
  wheelIndex: number | null;
  useWheelItem: boolean;
  /** Take-all shortcut while a barrel UI is open (rising-edge). */
  barrelTakeAll: boolean;
  /** When set, interact (X) must resolve to this action if valid; otherwise no-op (bots send null). */
  interactIntent?: InteractIntent | null;
}

export interface TradeActionPayload {
  sessionId: string;
  action: 'offer' | 'confirm' | 'cancel';
  offer?: ItemStack[];
}
