import type { WeaponId, ShipType } from '../types/index.js';

// ── World ────────────────────────────────────────────────────
export const WORLD = {
  SIZE: 2000,
  HALF: 1000,
  /** Ships bounce off a soft wall this far inside the world edge. */
  SHIP_MARGIN: 50,
  /** Players hard-clamp this far inside the world edge. */
  PLAYER_MARGIN: 10,
  ISLAND_COUNT: 14,
  SHIP_COUNT: 10,
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
  SWIM_SPEED: 5.2,
  SWIM_MAX_DEPTH: 42,
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
  /** A raised cutlass guard is a HELD stance, so it survives this long without a
   *  fresh reason to hold it. Measured: one input packet arriving without the aim
   *  bit (a coalesced/dropped frame under snapshot load, or a pointer-lock blip
   *  clearing the button set) dropped the guard for a whole 62.5 Hz tick — long
   *  enough for a skeleton swing to land in full while RMB was never released —
   *  and a wave flipping a shoreline walker to 'swimming' for one tick did the
   *  same with no visible cause at all. Deliberate ends to a guard (swinging,
   *  sheathing, hoisting a chest, taking a station) still drop it instantly. */
  GUARD_HOLD_GRACE: 0.25,
  BANANA_HEAL: 25,
  KILL_GOLD_REWARD: 275,
  /** Bounty for foundering an enemy ship — the crew is not eliminated by the
   *  sink (they lose their respawn anchor, not the match). */
  SHIP_SINK_GOLD: 400,
  /** Iron Cuirass pool: combat damage chews through this before health.
   *  Bought from the Tallyman (pricey), lost on death — deliberately
   *  a mid/late-game investment, not a lobby pickup. */
  MAX_ARMOR: 50,
  /** PvE skeletons pay a small bounty, not the full pirate reward. */
  SKELETON_KILL_GOLD: 60,
  HEADSHOT_GOLD_BONUS: 40,
  BOARDING_KILL_HEAL: 25,
  BOARDING_GOLD_STEAL_CAP: 180,
  STARTING_KEGS: 2,
  KEG_REPLENISH_COOLDOWN: 60,
} as const;

// ── Down-but-not-out (DBNO) ──────────────────────────────────
// hp ≤ 0 with a living crewmate downs the pirate instead of killing them:
// crawl at 30% speed, no weapons/stations, bleed out over BLEEDOUT_SECONDS
// (2× faster outside the storm ring). A crewmate holding interact for
// REVIVE_SECONDS revives at REVIVE_HEALTH. Any damage can finish the downed.
export const DBNO = {
  /** Seconds from downed to bleed-out death inside the storm safe ring. */
  BLEEDOUT_SECONDS: 30,
  /** Bleed-out drain multiplier while outside the storm safe ring. */
  STORM_BLEEDOUT_MULT: 2,
  /** Vitality pool while downed — damage against it "finishes" the player. */
  DOWNED_HEALTH: 30,
  /** Crawl speed as a fraction of PLAYER.MOVE_SPEED. */
  CRAWL_SPEED_SCALE: 0.3,
  /** Hold-interact seconds for a crewmate to complete a revive. */
  REVIVE_SECONDS: 4,
  /** Max distance (m) between reviver and downed body. */
  REVIVE_RANGE: 2.8,
  /** Health granted on a successful revive (fraction of MAX_HEALTH). */
  REVIVE_HEALTH_RATIO: 0.3,
  /** Interrupted revives decay progress at this rate per second. */
  PROGRESS_DECAY_PER_SEC: 0.5,
  /** Bots only revive crewmates when no enemy is within this range. */
  BOT_REVIVE_SAFE_RADIUS: 40,
  /** Bots walk over and finish downed enemies inside this range. */
  BOT_FINISH_RADIUS: 12,
} as const;

export const ECONOMY = {
  GOLD_WIN_TARGET: 9000,
  PLAYER_HIT_GOLD_MIN: 6,
  PLAYER_HIT_GOLD_MAX: 30,
  PLAYER_HIT_GOLD_RATIO: 0.18,
  CHEST_VALUE_MIN: 650,
  CHEST_VALUE_MAX: 1450,
  CHEST_SELL_MULTIPLIER: 1.65,
  HOARDER_QUEST_CHEST_BONUS: 1.3,
  /** Iron Cuirass price at the Tallyman — ~a chest-and-a-half of gold,
   *  so armor is a real decision against the 9000g win target. */
  ARMOR_PRICE: 1200,
} as const;

// ── Hold cargo: the gold race made PHYSICAL ──────────────────
// The 9000g win target used to be an invisible number on a scoreboard. Past
// SAFE_GOLD a crew's winnings stop being pocket coin and become CARGO: crates
// and coin-spill you can SEE stacked in the hold, weight the hull carries as
// lost top speed, plunder a boarder can cut out of you, and treasure that
// SPILLS into the shallows when she founders. Below SAFE_GOLD nothing is ever
// taken by the world — a bad night never zeroes a pirate.
export const CARGO = {
  /** Banked gold at or below this is safe pocket coin: no weight, no spill. */
  SAFE_GOLD: 1500,
  /** Cargo gold that reads as a completely full hold (target minus the safe
   *  pocket) — the ballast/steal curves normalize against this. */
  FULL_LOAD: 7500,
  /** Top-speed penalty a completely full hold costs. The leader is catchable. */
  MAX_BALLAST_PENALTY: 0.14,
  /** Cargo-gold floors for hold tiers 1..4 (tier 0 = trim, an empty hold). */
  TIER_THRESHOLDS: [1, 1500, 3400, 5400] as readonly number[],
  /** Share of a crew's CARGO gold that spills into the shallows when she
   *  founders. Half stays with the swimming crew — sinking is not a wipe. */
  SPILL_FRACTION: 0.5,
  /** Hard ceiling on what one wreck can put on the seabed. */
  SPILL_MAX: 2400,
  /** A spill breaks into at most this many divable pieces. */
  SPILL_PIECES_MAX: 6,
  /** Never split a spill into pieces smaller than this. */
  SPILL_PIECE_MIN: 140,
  /** Depth (m below mean sea level) the sunken cargo settles at — one held
   *  breath down, not an abyssal dive. */
  SPILL_DEPTH: 6,
  /** Scatter radius (m) of the spilled pieces around the wreck mark. */
  SPILL_SCATTER: 9,
  /** Swim within this (3D) to scoop a piece of sunken cargo. */
  SPILL_PICKUP_RANGE: 3.4,
  /** Sunken cargo is claimable for this long before the tide takes it. */
  SPILL_LIFETIME: 210,
  /** Hard cap on live spoils in the world. This is a WIRE budget, not a design
   *  one: the 10 Hz full snapshot is capped at 35 KB and every piece of sunken
   *  cargo rides it. Oldest are culled first. */
  SPILL_WORLD_MAX: 24,
  /** Crew gold, as a share of GOLD_WIN_TARGET, that raises a map-wide bounty. */
  BOUNTY_RATIO: 0.6,
  /** The bounty only lifts once the crew falls back below this share —
   *  hysteresis, so a leader hovering at the line doesn't strobe the map. */
  BOUNTY_CLEAR_RATIO: 0.55,
  /** Boarding steal cap multiplier against a completely full hold: a laden
   *  leader is worth boarding, which is the counterplay to the ballast. */
  STEAL_LADEN_MULT: 4,
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
    maxHull: 600, cannonCount: 2, maxSpeed: 15,
    turnRate: 0.7, width: 5, length: 12, height: 2.2, mastCount: 1,
  },
  brigantine: {
    maxHull: 900, cannonCount: 4, maxSpeed: 13,
    turnRate: 0.45, width: 7, length: 16, height: 2.8, mastCount: 2,
  },
  galleon: {
    maxHull: 1400, cannonCount: 8, maxSpeed: 10,
    turnRate: 0.25, width: 10, length: 22, height: 3.5, mastCount: 3,
  },
};

export const SHIP = {
  /** Standing surface of the weather deck, above the hull top: shipY + height +
   *  this. The quarterdeck dais is added on top by getShipDeckRaiseAt. */
  DECK_STAND_OFFSET: 0.1,
  /** Cargo-hold floor above the ship origin — one step above the keel line. */
  HOLD_FLOOR_OFFSET: 0.35,
  /** Helm stand point, aft along the hull as a fraction of length (local −z). */
  HELM_LOCAL_Z_F: 0.37,
  HULL_SECTION_RATIO: 0.25,   // each section is 1/4 of total
  SINK_TIME: 20,              // seconds — the founder is a scene, not a pop
  REPAIR_HP: 100,
  FIELD_REPAIR_DELAY: 10,
  FIELD_REPAIR_INTERVAL: 2.5,
  FIELD_REPAIR_HP: 120,
  MAX_SAIL_ANGLE: Math.PI * 0.48,
  /** Full hoist takes ~2.2s solo, ~1.5s with a crewmate on the rope. */
  SAIL_HOIST_RATE: 0.45,
  SAIL_TRIM_RATE: 1.55,
  RUDDER_SLEW: 3.25,
  RUDDER_DECAY: 4.1,
  /** Physical rudder blade deflection limit (radians). */
  RUDDER_MAX_ANGLE: 0.62,
  /** Half-angle of the upwind no-go cone (~35°) — sails luff inside it. */
  SAIL_NO_GO_ANGLE: 0.611,
  /** Keel depth below the waterline as a fraction of hull height. Berth-depth
   *  planning still uses this conservative figure; grounding and swim-hull
   *  collision measure from HULL_DRAFT_F (the RENDERED keel) instead. */
  KEEL_DRAFT_RATIO: 0.55,
  /** RENDERED hull draft as a fraction of hull height — the single truth for
   *  "how deep the visible keel sits" (ShipRenderer HULL_SHAPES.draftF mirrors
   *  these: sloop 0.80 m, brigantine 1.01 m, galleon 1.23 m). Grounding and the
   *  swim-hull band both read it, so no invisible water is solid and no visible
   *  rock is phantom. */
  HULL_DRAFT_F: { sloop: 0.365, brigantine: 0.36, galleon: 0.35 } as Record<ShipType, number>,
  /** Class-average draft fraction, for callers that only have hull dimensions
   *  (within 3 cm of every class's true draft). */
  HULL_DRAFT_F_FALLBACK: 0.357,
  /** Grounding tests the keel plus this safety bite, so a scrape registers just
   *  before the visible keel would clip the seabed. */
  GROUND_KEEL_SAFETY: 0.25,
  /** Impact speed (m/s, measured along the escape normal) below which a scrape
   *  is only a bump: pushback and a yaw kick, no stove planking. */
  GROUND_HOLE_MIN_IMPACT: 2.0,
  /** Helm authority floor for a hull that is HARD AGROUND, as a fraction of her
   *  turn rate.
   *
   *  The rudder only bites with way on (applyShipRudderSteering), which is right
   *  at sea and a death sentence on a bar: a hull run onto a beach sits at 0.0
   *  u/s, so the helm answers at its 0.05 floor — measured, that is 43° of swing
   *  in twenty-five seconds while grounding breaches flood her from 0.31 to 0.84.
   *  She drowns where she stands, and no key on the keyboard changes it.
   *
   *  A grounded hull is not steering, she is PIVOTING: the keel is pinned, the
   *  sails press on the rig, and she swings about the point she is stuck on.
   *  That is what "swinging her off" has always meant, and at this authority it
   *  takes about ten seconds — well inside the flooding she took getting there,
   *  so a beaching costs a fright and some planking instead of the ship. */
  AGROUND_HELM_AUTHORITY: 0.5,
  /** Seconds of no keel contact before the next scrape counts as a NEW grounding
   *  EVENT. Grounding is resolved every tick while a hull sits on a bar, so
   *  without an event ledger one beaching machine-guns 60 breaches a second. */
  GROUND_EVENT_RESET_SEC: 5,
  /** Minimum seconds between breaches WITHIN one grounding event — the hull
   *  tears plank by plank as she grinds, not all at once. */
  GROUND_HOLE_INTERVAL: 1.1,
  /** Hard ceiling on fresh breaches ONE grounding event may open, exactly the
   *  reasoning behind KEG_MAX_HOLES_PER_BLAST: a single scrape used to saturate
   *  the 8-hole cap in one tick, which is not damage, it is a scuttling with no
   *  counterplay. A gentle nudge costs GROUND_MIN, full sail into a reef costs
   *  GROUND_MAX, and everything between is lerped by impact speed. */
  GROUND_MAX_HOLES_PER_EVENT_MIN: 2,
  GROUND_MAX_HOLES_PER_EVENT_MAX: 4,
  /** Impact speed at which the per-event cap reaches its maximum. */
  GROUND_FULL_IMPACT_SPEED: 6,
  ANCHOR_BRAKE: 4.8,
  ANCHOR_RAISE_TIME: 3.2,
  FIRE_DURATION: 18,
  /** A deck fire chars a fresh hull hole every this-many seconds (burn-through). */
  FIRE_HOLE_INTERVAL: 6,
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
  CANNON_LAUNCH_SPEED: 62,
  CANNON_LAUNCH_VERTICAL_BIAS: 3.4,
  CANNON_PLAYER_LAUNCH_PITCH_MIN: 0.08,
  CANNON_PLAYER_LAUNCH_PITCH_MAX: 0.38,
  /** Seconds of ballistic arc before normal physics (must cover full trajectory) */
  CANNON_PLAYER_FLIGHT_MAX: 10,
  KEG_FUSE_TIME: 10,
  KEG_PLACE_RANGE: 2.7,
  KEG_DIFFUSE_RANGE: 2.4,
  KEG_PLAYER_RADIUS: 8.5,
  KEG_PLAYER_DAMAGE: 125,
  KEG_PLAYER_MIN_DAMAGE: 8,
  KEG_BLAST_FORCE: 18,
  /** Hard ceiling on fresh breaches ONE keg can open in a single hull. A keg
   *  lit on your own deck used to stove in eight planks at once — past the
   *  point where bailing or planking can keep up, so the blast wasn't damage,
   *  it was a scuttling. Four is a genuine emergency a crew can still fight. */
  KEG_MAX_HOLES_PER_BLAST: 4,
  KEG_PRIMARY_DAMAGE_RATIO: 0.26,
  KEG_SPLASH_DAMAGE_RATIO: 0.08,
  /** Rigging repair at sail station (per second while holding interact + wood) */
  SAIL_REPAIR_RATE: 0.42,
  SAIL_REPAIR_WOOD_INTERVAL: 0.85,
  /** Seconds per hull-plank hammer swing: one plank patches one hole per swing. */
  HULL_REPAIR_SWING_TIME: 0.9,
  CHAINSHOT_SAIL_DAMAGE: 0.38,
  /** When chainshot hits a sail, the canvas physically collapses by this fraction
   *  of the current hoist (multiplied by damage). Repairing at the sail station
   *  hoists the canvas back up at SAIL_HOIST_RATE * SAIL_REPAIR_HOIST_FACTOR. */
  CHAINSHOT_SAIL_DROP_FACTOR: 1.6,
  SAIL_REPAIR_HOIST_FACTOR: 0.55,
} as const;

// ── Berthing ─────────────────────────────────────────────────────────────────
// One description of where a hull lies when it is tied up, shared by the two
// halves that have to agree about it: MapGenerator, which dredges the mooring
// lane while it lays a dock out, and Match.computeShipBerth, which parks the
// hull. When these drifted apart, the planner slid a galleon 13m past the tip
// of a short pier looking for water the generator had never dug.
export const BERTH = {
  /** Gap between a berthed hull's side and the dock edge (metres). */
  RAIL_GAP: 1.0,
  /** How far inside the dock's seaward tip a berthed bow sits. */
  BOW_INSET: 0.6,
  /** Extra water under a berthed keel beyond the grounding threshold (wave bob). */
  BOB_MARGIN: 0.25,
  /** How far along the dock axis a berth may shift from the canonical anchor. */
  SEARCH_REACH: 14,
  /** Best-effort berths (reef-mouth docks) must at least keep the hull in water. */
  MIN_WATER: 0.4,
  /** No pier is shorter than the biggest hull plus a bow inset at each end —
   *  below that even a perfect berth leaves a galleon hanging off the end. */
  MIN_DOCK_LENGTH: SHIP_STATS.galleon.length + 4,
  /** Extra water the dredger digs beyond what the deepest keel needs. */
  DREDGE_HEADROOM: 0.9,
} as const;

// ── Flooding / bailing (SoT-style, PURELY hole-based naval damage loop) ──
// There is no hull-HP pool and no per-section bucket. Each cannonball (keg
// blast, ram, rock, grounding, storm sea, fire burn-through) punches a discrete
// HOLE ENTITY at the exact hull-local point the damage landed. Any hole sitting
// at/below the LIVE wave surface (heel/pitch/settle included) takes on water;
// ingress scales with how many open holes are under AND how deep each one sits.
// waterLevel is a normalized 0..1 bilge fill and the ship founders ONLY when it
// reaches 1. A plank patches ONE hole (the one you are standing at); a bucket
// bails water; a passive bilge pump slowly recovers a fully-patched hull.
export const FLOODING = {
  /** Hard cap on hole ENTITIES a single hull carries. This one number is BOTH
   *  the hull shader's discard-slot count and the 10 Hz wire budget: 9 hulls all
   *  simultaneously at the cap is ~3.8 KB of full snapshot, which is what keeps
   *  a fleet-wide gunfight under the 35 KB guard (test-snapshot-size pins it).
   *  Eight unpatched breaches already flood a dry sloop in ~17 s against two
   *  bailers, so the cap is a wire limit, never a mercy: damage on a saturated
   *  hull RE-OPENS the nearest patched hole rather than no-oping, so a hull can
   *  never become immune by being shot enough (the old 3-per-section bug). */
  MAX_HOLES_PER_SHIP: 8,
  /** Hull-local Y band (metres above the design waterline) synthetic breach
   *  points are placed in — rams, rocks, storm seas and keg blasts land here. */
  HOLE_BAND_Y: { min: 0.10, max: 0.45 },
  /** Rendered breach radius (metres) — damage depth reads as MORE holes, not
   *  as one growing disc. */
  HOLE_VISUAL_RADIUS: 0.26,
  /** Planar hull-local distance a pirate can reach a hole from to plank it.
   *  Server truth; the client prompt mirrors it exactly. */
  HOLE_REPAIR_REACH: 2.2,
  /** Hull-local Y a deck fire chars its first hole at — ABOVE the calm
   *  waterline on purpose: a burning ship accumulates dry holes that only start
   *  flooding once the flames burn them DOWN to the sea (see FIRE_BURN_DOWN_RATE)
   *  or storm seas wash over them. Fire is a real threat, not a one-hole douse. */
  FIRE_HOLE_START_Y: 1.05,
  /** Metres/sec an untended fire burns each of its own holes DOWNWARD through
   *  the planking. ~0.06 m/s takes a fresh char from 1.05 m to the waterline in
   *  ~16 s — the length of an untended blaze. */
  FIRE_BURN_DOWN_RATE: 0.06,
  /** Water-level/sec that ONE open, submerged hole lets in (sloop reference).
   *  One bailer (BAIL_RATE 0.014) beats a single hole but loses to two, so a
   *  gushing hull must be planked, not just bailed. ~67 s to founder a sloop on
   *  two open holes, faster with more; a reinforced hull seeps slower still. */
  INGRESS_PER_HOLE: 0.0075,
  /** Ingress scales with how DEEP a hole sits under the live surface:
   *  factor = clamp(1 + depthMetres, MIN, MAX), depth = surfaceY − holeWorldY.
   *  A hole exactly ON the waterline (depth 0) is the INGRESS_PER_HOLE
   *  reference; one washed by wave crests only (depth −0.3 … 0) weeps at
   *  0.7–1×; one dragged half a metre under by the settling bilge gushes at
   *  the 1.5× cap — that is the doom spiral, in one line. The bail-race
   *  relations hold across the whole range (one bailer beats one hole even at
   *  max depth: 0.014 > 0.01125; two holes beat one bailer even at min:
   *  0.0105 ≈ 0.014 only until the hull settles). */
  HOLE_DEPTH_MIN_FACTOR: 0.7,
  HOLE_DEPTH_MAX_FACTOR: 1.5,
  /** Per hull-class scale on ingress — bigger hull, slower to fill.
   *  sloop 50 s / brigantine ~60 s / galleon ~71 s to fill on 2 open sections. */
  INGRESS_CLASS_SCALE: { sloop: 1.0, brigantine: 0.84, galleon: 0.70 } as Record<ShipType, number>,
  /** One player bails this much water-level/sec (beats one open hole, loses to two). */
  BAIL_RATE: 0.014,
  /** Physical bucket bailing is a SCOOP → CARRY → HEAVE cycle: press once to
   *  fill the empty bucket (water drops BAIL_SCOOP_VOLUME), press again to heave
   *  it over the side. Each action locks for BAIL_SCOOP_TIME, so a full cycle is
   *  ~2×BAIL_SCOOP_TIME and clears BAIL_SCOOP_VOLUME → a diligent bailer's net
   *  rate (~0.014/s) still beats one open hole (0.0075/s) and loses to two
   *  (0.015/s), so a real breach demands repair, not just bailing (matches
   *  BAIL_RATE + the code comment; the old 0.03 let one bailer out-drain two holes). */
  BAIL_SCOOP_TIME: 0.6,
  BAIL_SCOOP_VOLUME: 0.017,
  /** Passive bilge pump drain (× BAIL_RATE) when NOTHING is holed-below-waterline. */
  PASSIVE_PUMP_FACTOR: 0.25,
  /** Bots start bailing once standing water exceeds this. */
  BOT_BAIL_THRESHOLD: 0.35,
  /** A hole starts weeping while it sits within this many metres ABOVE the local
   *  surface (wave wash over a near-waterline breach); anything lower floods. */
  HOLE_WATERLINE_DEPTH: 0.30,
  /** Full bilge lowers the buoyancy/heave target this many metres (freeboard loss →
   *  more sections dip under → the doom spiral). */
  FREEBOARD_DROP: 0.8,
  /** Full bilge cuts max speed to (1 − this): 0.38 → 0.62× at waterLevel 1. */
  SPEED_PENALTY: 0.38,
  /** Full bilge dulls rudder authority by this fraction (~40%). */
  RUDDER_PENALTY: 0.40,
  /** Breach HEIGHT tiers (one wire byte, shared classifier getShipHoleTier):
   *  LOW below this hull-local y floods on a level hull, MID up to
   *  HOLE_TIER_HIGH_F x height only once she has settled, HIGH (topside) only
   *  while she lists or the sea gets up. */
  HOLE_TIER_LOW_Y: 0.20,
  HOLE_TIER_HIGH_F: 0.6,
  /** SERVER-owned list: radians of heel/trim per unit of open-breach ingress
   *  weight on one rail / one end, and the bounds the spring may be asked for. */
  LIST_ROLL_GAIN: 0.09,
  LIST_TRIM_GAIN: 0.05,
  LIST_ROLL_MAX: 0.25,
  LIST_TRIM_MAX: 0.15,
  /** Vertical reach on a breach: in the hold, or within this many metres of it. */
  HOLE_REPAIR_REACH_Y: 1.6,
  /** Manned bilge pump (hold [X] in the hold): beats one open hole, loses to three. */
  PUMP_RATE: 0.022,
  /** Hull-local z of the pump as a fraction of length (just aft of amidships). */
  PUMP_LOCAL_Z_F: -0.15,
} as const;

// ── Geysers ──────────────────────────────────────────────────
// Volcanic vents that erupt on a shared deterministic cycle and launch any
// grounded pirate (players + bots) skyward. Landing is owned by the normal
// fall-damage path, so a big launch onto hard rock genuinely hurts — aim for a
// water landing. Per-vent power/period/phase live on the IslandGeyser record.
export const GEYSER = {
  /** Eruption level (0..1) at/above which a standing pirate is launched. */
  LAUNCH_THRESHOLD: 0.5,
  /** A pirate more than this far above the vent rim is already airborne — the
   *  launch won't re-fire on them until they land back on the vent. */
  TRIGGER_MAX_HEIGHT: 1.6,
  /** Outward horizontal kick as a fraction of the vertical launch — enough that
   *  the ballistic arc genuinely carries a rider clear of the vent footprint
   *  (so an idle pirate can't be relaunched onto the same vent every eruption)
   *  while still usually landing back on the island. */
  OUTWARD_BOOST: 0.24,
  /** Seconds a pirate is immune to re-launch after being thrown — long enough
   *  to cover a full up-and-down arc so one eruption launches them ONCE (no
   *  trampoline death-stack of fall-damage hits). */
  LAUNCH_COOLDOWN: 3.0,
} as const;

export const SHARK = {
  MAX_WORLD: 4,
  SPAWN_CHANCE_PER_TICK: 0.00055,
  SPAWN_SWIM_GRACE: 8,
  SPAWN_COOLDOWN_MIN: 12,
  SPAWN_COOLDOWN_MAX: 20,
  /** A few solid hits will down a shark — still threatening up close, no longer a slog. */
  HEALTH: 110,
  /** Multiplier vs firearm hitscan damage */
  GUN_DAMAGE_MULT: 0.9,
  BITE_DAMAGE: 42,
  BITE_RANGE: 2.35,
  BITE_COOLDOWN: 2.35,
  CHASE_SPEED: 5.4,
  /** Telegraphed attack: windup is the dodge window (direction locks at its
   *  START), the lunge is a straight dash, recovery leaves the shark slow
   *  and biteable. Damage only lands on the lunge if the swimmer is still
   *  inside the locked corridor. */
  AGGRO_RANGE: 26,
  WINDUP_TIME: 0.75,
  LUNGE_TIME: 0.32,
  LUNGE_SPEED: 14,
  RECOVER_TIME: 1.15,
  LUNGE_HIT_RADIUS: 1.7,
  HIT_RADIUS: 1.25,
  SPAWN_MIN_DIST: 26,
  SPAWN_MAX_DIST: 52,
} as const;

export const WILDLIFE = {
  GUN_DAMAGE_MULT: 1,
  HEALTH: {
    crab: 18,
    chicken: 28,
    pig: 52,
    gull: 24,
  },
  SPEED: {
    crab: 0.75,
    chicken: 1.45,
    pig: 0.95,
    gull: 2.8,
  },
  HIT_RADIUS: {
    crab: 0.34,
    chicken: 0.38,
    pig: 0.62,
    gull: 0.42,
  },
  MEAT_DROP: {
    crab: 1,
    chicken: 1,
    pig: 3,
    gull: 1,
  },
  /** Each animal's cut heals differently — pork is the prize, gull is scraps.
   *  Untyped meat (barrels, ship larder) heals the generic POCKET.MEAT_HEAL. */
  MEAT_HEAL: {
    crab: 20,
    chicken: 26,
    pig: 42,
    gull: 18,
  },
  MEAT_NAME: {
    crab: 'crab meat',
    chicken: 'chicken drumstick',
    pig: 'pork shank',
    gull: 'gull cut',
  },
} as const;

export const SEA_ROCKS = {
  COUNT: 36,
  MIN_RADIUS: 8,
  MAX_RADIUS: 30,
  MIN_HEIGHT: 8,
  MAX_HEIGHT: 42,
  SHIP_DAMAGE_PER_SPEED: 18,
} as const;

// ── Ship Upgrades ────────────────────────────────────────────
// Redefined for the hole-based damage model (there is no HP pool to buff):
//  - hull_reinforcement ("Reinforced Hull") → the sea seeps through reinforced
//    planking slower, so open holes flood at HULL_INGRESS_MULT and the passive
//    pump runs faster: you stay afloat far longer and one bailer wins more often.
//  - charged_cannons ("Heavy Shot") → each ball punches CHARGED_EXTRA_HOLES more
//    hole(s) into the section it hits, and still deals more anti-personnel blast.
//  - swift_sails → unchanged top-speed multiplier.
/** Gathering loop: the axe fells palms (wood) and cracks boulders (ore);
 *  upgrade stations consume materials from the pocket+ship pool. Yields and
 *  costs are paced against the ~12.6min storm window: one upgrade ≈ 2-3
 *  minutes of focused gathering, or loot barrels/chests for a shortcut. */
export const HARVEST = {
  CHOP_TIME: 2.2,          // seconds of axe work per palm
  MINE_TIME: 3.0,          // seconds per boulder
  WOOD_PER_TREE_MIN: 2,
  WOOD_PER_TREE_MAX: 4,
  ORE_PER_BOULDER_MIN: 2,
  ORE_PER_BOULDER_MAX: 3,
  RANGE: 3.2,              // how close the axe must be
} as const;

export const UPGRADE_COSTS: Record<'hull_reinforcement' | 'charged_cannons' | 'swift_sails', { wood: number; ore: number }> = {
  hull_reinforcement: { wood: 6, ore: 3 },
  charged_cannons: { wood: 3, ore: 6 },
  swift_sails: { wood: 8, ore: 2 },
};

export const SHIP_UPGRADES = {
  /** Reinforced hull: open holes flood at this fraction of the base rate. */
  HULL_INGRESS_MULT: 0.6,
  /** Reinforced hull: passive bilge pump runs this much faster. */
  HULL_PUMP_MULT: 1.6,
  /** Heavy shot: extra holes punched per cannon hit on the struck section. */
  CHARGED_EXTRA_HOLES: 1,
  /** Heavy shot: anti-personnel cannonball blast multiplier (unchanged). */
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
  // The wreckers' long arm: a rifled barrel with a salvaged spyglass lashed
  // above it, first built on the Crooked Atoll to read a hull before it struck.
  eye_of_reach: {
    name: "Wrecker's Glass", damage: 95, reloadTime: 2.35,
    ammoMax: 1, reserveMax: 5, range: 5000, spread: 0.01, pellets: 1,
    knockback: 4, melee: false, projectileSpeed: 220, scopeFov: 14,
  },
  blunderbuss: {
    name: 'Blunderbuss', damage: 17, reloadTime: 2.0,
    ammoMax: 1, reserveMax: 5, range: 22, spread: 5.4, pellets: 7,
    knockback: 7, melee: false, projectileSpeed: 80, scopeFov: null,
  },
  // Half a charge of powder behind a fist-sized ball — it hits like weather and
  // puts whoever catches it over the rail. (The wire id stays `flintknock`.)
  flintknock: {
    name: 'Squall Pistol', damage: 42, reloadTime: 1.65,
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
// Fortnite-style: readable first grace period, escalating urgency, lethal endgame.
// Each phase: wait (safe zone static), then shrink to next radius.
// dmgPerSec tuned ~4× gentler than early builds so the ring is threatening but not instant.
export const STORM_PHASES = [
  // Phase 1 — explore, loot, get your bearings.
  //
  // THE FIRST RING MUST CONTAIN EVERY SPAWN DOCK. The old 680 m end radius cut
  // through a berth line that reaches 750 m from the origin: a solo who spawned
  // on an outer pier was OUTSIDE the circle at ~T+3:45, bleeding at his own
  // dock, and dead at ~T+5:00 with nobody having fired a shot at him. The phase
  // that promises "explore, loot, get your bearings" cannot be the phase that
  // kills you where it put you. StormSystem re-checks this against the REAL
  // dock geometry every match (see STORM_DOCK_COVER_MARGIN) and widens the
  // first ring if a world ever pushes a berth past this number — the constant
  // is the design intent, the runtime check is the guarantee.
  { waitSec: 150, shrinkSec: 85,  startRadius: 950, endRadius: 825, dmgPerSec:  0.6 },
  // Phase 2 — circle tightens, time to sail inward
  { waitSec: 105, shrinkSec: 55,  startRadius: 825, endRadius: 480, dmgPerSec:  1.3 },
  // Phase 3 — urgency kicks in
  { waitSec:  80, shrinkSec: 45,  startRadius: 480, endRadius: 320, dmgPerSec:  2.2 },
  // Phase 4 — getting spicy (60 s wait)
  { waitSec:  55, shrinkSec: 35,  startRadius: 320, endRadius: 190, dmgPerSec:  3.8 },
  // Phase 5 — danger zone (45 s wait)
  { waitSec:  40, shrinkSec: 25,  startRadius: 190, endRadius:  95, dmgPerSec:  5.8 },
  // Phase 6 — very dangerous (30 s wait)
  { waitSec:  30, shrinkSec: 20,  startRadius:  95, endRadius:  40, dmgPerSec:  8.5 },
  // Phase 7 — endgame, lethal outside (15 s wait)
  { waitSec:  15, shrinkSec: 15,  startRadius:  40, endRadius:  12, dmgPerSec:  12 },
];

/** The whole storm arc in seconds — every phase's wait plus its shrink. The
 *  match's natural length, and the denominator of GameState.matchProgress (the
 *  one number the sky's day cycle is hung on). */
export const STORM_ARC_SECONDS = STORM_PHASES.reduce((sum, phase) => sum + phase.waitSec + phase.shrinkSec, 0);

/** Clearance the FIRST ring keeps outside the furthest spawn dock, measured
 *  from the world origin to the berth AND to the pier's respawn point. A dock
 *  is a place a fresh crew stands, not a place the weather is allowed to reach
 *  in the opening phase, so the ring is sized off real geometry plus this belt:
 *  the hull lies alongside (half a galleon's beam), the crew walks the pier,
 *  and neither is inside the wall when phase 1 settles. */
export const STORM_DOCK_COVER_MARGIN = 45;

/** Grace after a hold begins before a CREWLESS respawn converts to a tow.
 *  Long enough that a mate who is one second from reviving still owns the
 *  rescue, short enough that a solo never reads it as a hang. */
export const RESPAWN_HOLD_GRACE_SECONDS = 10;

/**
 * THE HARD CEILING ON A HELD RESPAWN. Nothing may hold a pirate on the blackout
 * longer than this, in ANY reachable state.
 *
 * The grace above was a condition, not a cap: it only converted the hold when
 * the tide could find somewhere to put the derelict. In the FINAL storm it never
 * could — the last ring is 12 m across and the endgame circle converges on Old
 * Maw Caldera, so pickSafeSpawnDock (which needs radius − 50) and
 * findOpenWaterInsideRing (which needs a hull's length of clear water) both
 * return nothing, forever. A fresh-eyes audit sat in 'respawning' for four
 * minutes reading "the count resumes when your hull is back inside the ring"
 * during a storm with no inside, and died of it.
 *
 * So the cap is absolute: past it the respawn ALWAYS converts to a real
 * countdown, and if the hull cannot be brought to shelter the pirate is put
 * ashore inside the ring without her (getSafeRespawnPlan).
 */
export const RESPAWN_HOLD_MAX_SECONDS = 10;

/**
 * Storm immunity granted at every respawn.
 *
 * The death carousel: the ring crossed a learner's spawn dock, killed him six
 * seconds after it arrived, respawned him on the same deck inside the same
 * weather, and killed him again — three times in three minutes. A respawn that
 * lands inside the tempest has to hand back enough time to make sail and get
 * out, and the HUD has to show that clock (HudController's storm-grace chip)
 * so the seconds read as a reprieve rather than a mystery.
 *
 * This is NOT combat immunity (that stays PLAYER.RESPAWN_PROTECTION_TIME): the
 * weather alone stands down, so it can never be used to board a hull for free.
 */
export const STORM_RESPAWN_GRACE_SECONDS = 15;

/**
 * The storm blows a hull HOME.
 *
 * Measured best-trim hull speed in the audit was 1.26 u/s against a ring that
 * displaces 300–500 m every two minutes: the weather outran the boat and the
 * only counterplay was to already be inside. Outside the wall the local wind now
 * turns to a gale out of the storm and drives toward shelter — the canvas fills
 * (visible on the yard), a hull pointed inward runs, and one pointed away claws.
 * Ramps from nothing AT the ring to the full boost this far outside it, as a
 * fraction of the current safe radius.
 */
export const STORM_TAILWIND = {
  /** Extra wind strength at full ramp (1.0 = double the ordinary breeze). */
  STRENGTH_BOOST: 0.55,
  /** Outside distance, as a fraction of safeRadius, that reaches full boost. */
  FULL_AT_RADIUS_FRACTION: 0.18,
  /** How completely the gale overrides the prevailing wind direction (0..1). */
  DIRECTION_AUTHORITY: 0.85,
} as const;

/** Trim handed to a crew the first time they get under way. The default yard sits
 *  square, which on any reach catches ~0% of the wind: PhysicsSystem's speed
 *  floor (0.16) is all a fresh captain ever saw, and "hold W to get under way"
 *  plateaued at 0.3 u/s and decayed. Bots have auto-trimmed since day one. */
export const FIRST_SAIL_ASSIST = {
  /** Fraction of the wind-optimal yard angle set when the anchor comes up. */
  TRIM_FRACTION: 0.92,
  /** Canvas the assist makes sure is out (only ever raises, never shortens). */
  MIN_SAIL_HEIGHT: 0.5,
  /** Catch below this, held for COACH_AFTER_SECONDS at the wheel, calls the coach. */
  COACH_CATCH: 0.2,
  COACH_AFTER_SECONDS: 4,
  /** How long `ship.aground` survives its last keel contact, in seconds.
   *
 *  A hull held on a shoal does not touch bottom every tick — she touches, gets
 *  shoved off, sails back on, and her head yaws across the escape normal as the
 *  collision kicks her, so the raw signal drops out for a second or two at a time
 *  while she is plainly still stuck (measured on Mermaid's Folly: false at t+10
 *  and t+11, true either side). A flag read straight off the tick would strobe,
 *  and a coach pill that strobes is worse than no coach. Long enough to bridge
 *  the dropouts, short enough that sailing clear clears the words in a breath. */
  AGROUND_HOLD_SECONDS: 3,
  /** Seconds of driving into the bottom before `ship.aground` means anything.
   *  A graze is one tick; being stuck is continuous. Drains at twice this rate. */
  AGROUND_ARM_SECONDS: 0.7,
} as const;

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
  { item: 'meat' as const,           weight: 8,  minQty: 1, maxQty: 2 },
  { item: 'wood_plank' as const,     weight: 20, minQty: 1, maxQty: 3 },
  { item: 'cannonball' as const,     weight: 14, minQty: 2, maxQty: 6 },
  { item: 'firebomb_ball' as const,  weight: 6,  minQty: 1, maxQty: 1 },
  { item: 'chainshot' as const,      weight: 5,  minQty: 1, maxQty: 2 },
];

export const POCKET = {
  FRUIT_HEAL: 22,
  MEAT_HEAL: 36,
  DIG_RATE: 0.42,
  /** Seconds between pocket-wheel uses (eat one fruit at a time) */
  USE_COOLDOWN: 0.85,
} as const;

// ── Tick rate ────────────────────────────────────────────────
export const SERVER_TICK_MS = 16;  // 62.5 Hz physics
/** Hot (light) snapshots go out every SNAPSHOT_RATE ticks (31.25 Hz). */
export const SNAPSHOT_RATE = 2;
/** Full snapshots go out every FULL_SNAPSHOT_TICKS ticks (~10.4 Hz);
 *  hot 'state_hot' updates fill the snapshot ticks in between. */
export const FULL_SNAPSHOT_TICKS = SNAPSHOT_RATE * 3;

// ── Match start ceremony ─────────────────────────────────────
/** Seconds the match sits in phase 'waiting' before the sim goes live: the
 *  server broadcasts one 'match_countdown' per whole second with inputs locked,
 *  then a 'match_horn' at activation. 0 = the legacy instant start (identical
 *  behavior, no countdown/horn traffic). The client renders the staged start
 *  card + countdown off these messages (see Game.showMatchStartSequence). */
export const MATCH_START_COUNTDOWN_SEC = 8;

/** Crews (ships) per match — humans plus bot fill. The lobby sizes the queue to
 *  this and the menu's placeholder queue line quotes it, so the two can't drift
 *  ("0 / 8 pirates" flashed on a 10-pirate queue for months). */
export const MATCH_TOTAL_SHIPS = 10;

/**
 * Kill-streak reward ladder — the ONE place the thresholds live.
 *
 * They used to be typed twice in the server, twice in the HUD and once more in
 * the legend, and the top rung was 20 kills without dying in a lobby of
 * MATCH_TOTAL_SHIPS crews: dead content nobody in the game's history had seen.
 * The ladder is now sized to the lobby — the first rung lands inside a single
 * good boarding, and the top rung is a genuinely exceptional voyage rather than
 * an impossible one.
 */
export const KILL_STREAK_TIERS = {
  super_cannonball: 4,
  mega_keg: 8,
  tsunami: 14,
} as const;

/** The ladder in rung order, for badges, feed lines and the legend copy. */
export const KILL_STREAK_LADDER: ReadonlyArray<{ kills: number; label: string }> = [
  { kills: KILL_STREAK_TIERS.super_cannonball, label: 'super cannonball' },
  { kills: KILL_STREAK_TIERS.mega_keg, label: 'mega keg' },
  { kills: KILL_STREAK_TIERS.tsunami, label: 'tsunami [E]' },
];

// ── Early-game pacing governor ───────────────────────────────
/** Bots do not SEEK ship-to-ship engagements for this long after the horn
 *  (they still defend when fired upon and still loot/patrol). Without it ~half
 *  the lobby was eliminated before the first storm shrink even began, so the
 *  7-phase ring arc never got to matter. */
/** 150 s. The env var BOT_EARLY_PEACE_SECONDS overrides it on the SERVER only:
 *  it is the mutation knob for test-pacing-curve's "can it fail?" proof (0 makes
 *  bots fight from the horn, which must break the 150 s band). The browser
 *  bundle has no `process` and always reads 150. */
export const BOT_EARLY_PEACE_SECONDS = (() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const n = Number(env?.BOT_EARLY_PEACE_SECONDS ?? NaN);
  return Number.isFinite(n) && n >= 0 ? n : 150;
})();

/** RNG-01 pacing bands for the seeded bot-only sim (scripts/pacing-sim.mjs,
 *  graded by scripts/test-pacing-curve.mjs under PACING=1). MARKS are sim
 *  seconds; the later ones are the storm arc: P3 starts 395, mid-P3 480, P4
 *  520, P5 610, P6 675, P7 725, the last ring closes at 755. BANDS are mean
 *  crews afloat [lo, hi] at a mark, 9 bot crews, 2+ runs. Only the two the
 *  audit could stand behind are pinned; tighten once the printed arc is stable.
 *  Numbers quoted in older comments came from a sim that stopped at 360 s. */
export const PACING_TARGETS = {
  BOT_CREWS: 9,
  MARKS: [60, 120, 150, 180, 240, 300, 360, 395, 480, 520, 610, 675, 725, 755],
  /** 150: the peace window holds — nobody is sunk before it lifts (seeded runs
   *  print exactly 9; BOT_EARLY_PEACE_SECONDS=0 prints 8.5). 360: the audit's
   *  band; the seeded mean sits on its top edge (7.0) — the lobby empties
   *  slower than designed, which is a pacing fact, not a gate defect. */
  BANDS: { 150: [9, 9], 360: [4.5, 7] } as Record<number, [number, number]>,
  /** Sim length. NOTE: as of RNG-01 no seeded bot-only match ends at all (3-6
   *  crews still afloat at 780 s, 3 at 1500 s) — the closed ring does not sink
   *  bot hulls. Reported per run by pacing-sim; graded by the endgame lane. */
  MAX_MATCH_SECONDS: 13 * 60,
};
/** Engage-seek radius by storm phase index (clamped to the last entry) once the
 *  early-peace window is over. The old flat 920/780 had every bot converging
 *  across the whole map from t=0; measured, that emptied the lobby long before
 *  the ~12.5-minute ring arc could matter. Ramping the seek radius with the ring
 *  keeps early fights local and hands the endgame back to the storm.
 *
 *  Phases 0-2 (t=150-400 s, the whole life of the Gilded Wreck) were re-opened
 *  when the wreck instrumentation showed why the fleet CONVERGED on her without
 *  CONVERTING: crews closed to a mean 390 m of the mark and then sat there,
 *  because 260-300 m of seek radius does not reach across the water everyone is
 *  milling in. Instrumented at the old numbers, the 90 s after she rose had
 *  SIX crews within 400 m of her and ZERO of them engaged.
 *
 *  Index 0 costs nothing before the peace lifts: inside BOT_EARLY_PEACE_SECONDS
 *  the seek radius is forced to 0 (or BOT_DEFEND_RANGE under fire) regardless,
 *  so this number only ever speaks from t=150 s — which is exactly the window
 *  the wreck is up in. */
export const BOT_ENGAGE_RANGE_BY_PHASE = [440, 540, 570, 580, 640, 780, 900];
/** Seek radius multiplier while the ring is actively shrinking — everyone is
 *  being funnelled together anyway, so hunting is fair game. */
export const BOT_ENGAGE_SHRINK_MULT = 1.2;
/** How many bot crews may be actively hunting at once, by storm phase index.
 *  Measured: without a cap every bot flipped to 'engage' the tick the peace
 *  window lifted and six of nine crews sank inside 33 s.
 *
 *  The cap is a rate limiter on the LOBBY igniting, not a ban on fighting: with
 *  2/3 through the wreck's whole life only two or three crews were ever allowed
 *  to hunt at once, so nine crews met over one hull and eight of them watched.
 *  Phases 0-2 carry the wreck window, so that is where the cap opens — and it is
 *  still a cap: half the lobby, not the lobby. */
export const BOT_MAX_HUNTERS_BY_PHASE = [5, 7, 7, 7, 8, 8, 10];
/** During early peace a bot only answers ships that shot at it inside this range. */
export const BOT_DEFEND_RANGE = 260;

/**
 * THE GUNS LEARN THE WEATHER.
 *
 * Bot gunnery cadence (the seconds between broadsides, per difficulty) scaled by
 * storm phase. This is the deliberate difficulty call behind the standing pacing
 * gap: a mean 7.5 crews still afloat at 360 s against a 5–6.5 target, because the
 * same slack medium bot that a new player needs at t=180 s is still shooting like
 * one at t=360 s with the ring half closed.
 *
 * Phase 0 is untouched — the opening is the tutorial, and it stays gentle. From
 * the first ring onward the crews sharpen, and the endgame fires ~40% faster
 * (×0.6 on the delay) than the opening does. The multiplier rides the STORM, not
 * the clock, so it moves with the arc a player can actually read on the chart.
 */
export const BOT_CANNON_CADENCE_BY_PHASE = [1.0, 0.72, 0.66, 0.62, 0.6, 0.6, 0.6, 0.6];
/** Aim-jitter multiplier on the same schedule: a late-phase gun crew is not just
 *  faster, it is steadier. Never below the hard-bot floor's own accuracy — this
 *  tightens the shot, it does not make bots snipe. */
export const BOT_CANNON_ACCURACY_BY_PHASE = [1.0, 0.82, 0.74, 0.7, 0.66, 0.66, 0.66, 0.66];

/** Read either schedule at a storm phase index (clamped to the last entry). */
export function botPhaseScale(schedule: readonly number[], phase: number): number {
  if (schedule.length === 0) return 1;
  const idx = Math.max(0, Math.min(schedule.length - 1, Math.floor(phase)));
  return schedule[idx];
}

// ── Environmental peace (the lobby must not empty itself) ─────
/** Nobody's hull is torn open by the WORLD — storm seas, keel scrapes, reef
 *  bites — while she lies tied up in her own berth during these opening storm
 *  phases. Measured before this rail: a never-sailed anchored sloop carried 2
 *  breaches by t=82 s and 3 by t=100 s of a zero-kill lobby, and one or two bot
 *  crews foundered offscreen inside the first 90 s of every match. A berth is
 *  shelter; the sea starts collecting once the ring means something. */
export const BERTH_ENV_SAFE_MAX_PHASE = 1;
/** How close to a dock's berth a hull must lie (metres, planar) to count as
 *  moored there. Matches the berth-occupancy radius the join planner uses. */
export const BERTH_ENV_SAFE_RADIUS = 42;
/** Bot crews take NO grounding breaches before the early-peace window lifts —
 *  they still bounce off, lose way and get shoved back toward deep water, they
 *  just don't drown for it. A bot helm running a shoal at t=40 s is a pathing
 *  miss the player never sees, and it was quietly deleting 10% of the lobby. */
export const BOT_GROUNDING_FORGIVENESS_SECONDS = BOT_EARLY_PEACE_SECONDS;

// ── Bot seamanship ───────────────────────────────────────────
/** How far ahead a bot helm probes for land / sea rocks along its heading.
 *  Measured: 55m left bots grazing shoals 1.5m deep (their turning circle is
 *  wider than that); 90m cut aground samples 444 → 171 and the worst keel
 *  contact to 0.16m — a wave-trough scrape, not a beaching. */
export const BOT_LOOKAHEAD_METERS = 90;
/** Extra clearance added to an obstacle's radius when picking the escape tangent. */
export const BOT_OBSTACLE_MARGIN = 16;
/** Water a bot demands under its keel before closing further on a shore. */
export const BOT_KEEL_CLEARANCE = 1.4;

// ── The Gilded Wreck (mid-match convergence event) ────────────
/** A half-sunk ghost galleon rises at the ANNOUNCED next ring centre and stays
 *  lootable for one storm phase before the tempest claims her. She exists to
 *  break the mid-match drought the pacing audit found: mean 7.5 crews still
 *  afloat at 360 s with nothing between shrinks to pull them together. The
 *  wreck gives the whole lobby ONE place worth sailing to, at the exact spot
 *  they must sail to anyway, with loot worth fighting over when they arrive. */
export const WRECK_EVENT = {
  /** Zero-indexed storm phase whose FIRST SHRINK raises her — she comes up the
   *  moment the ring starts to move, which is also the second the early-peace
   *  window lifts (BOT_EARLY_PEACE_SECONDS). One horn: the peace is over and
   *  there is somewhere to be.
   *
   *  This is deliberately EARLIER than the audit's "phase 3". A crew 600 m out
   *  needs ~90 s to reach her and another minute to lose a gunfight, so a wreck
   *  that rises at the third circle (~395 s) cannot move a number scored at
   *  360 s — it just relocates the drought. Rising with the first shrink (~150 s)
   *  puts the convergence at ~240 s and the killing across 260-360 s, which is
   *  the hole the audit actually measured, and it leaves the 150 s mark (the
   *  "early peace is intact" number) untouched because she is only just up. */
  SPAWN_PHASE: 0,
  /** She is claimed this many seconds after rising — long enough to sail to her
   *  from the far side of the ring, fight over her, and get the cargo home.
   *
   *  Rising at ~150 s that puts her claim at ~340 s, and the CLAIM is part of
   *  the design: the sea taking her back is what breaks the crews holding
   *  station over her apart and sends the ones with her cargo running for a
   *  Tallyman with everyone else's bows pointed at them. Stretched to 230 s
   *  (the full storm phase) the fleet was still politely circling her at the
   *  360 s mark with the killing all still ahead of it, and the measured curve
   *  came back WORSE, not better. */
  LOOT_SECONDS: 190,
  /** Treasure chests aboard — carry them home and bank them. */
  CHESTS: 3,
  /** Gold value band per chest. Richer than an island chest (ECONOMY.CHEST_*)
   *  because the wreck is contested by definition. */
  CHEST_VALUE_MIN: 340,
  CHEST_VALUE_MAX: 520,
  /** Supply barrels aboard — the "super ammo" cache. */
  BARRELS: 3,
  /** THE GILDED STRONGBOX — the one thing on her that CONVERTS the convergence.
   *
   *  Measured before it existed: crews genuinely closed on the wreck (600 m →
   *  390 m mean, closest approach 26-96 m in 6/6 runs) and then looted nothing,
   *  fought nobody and drifted off — because three equal chests split nine crews
   *  into three happy winners and six shrugs. Nobody CONTESTS a buffet.
   *
   *  So one strongbox, amidships, worth more than the rest of her put together,
   *  and only one crew can have it. The moment it is aboard a hull that hull is
   *  cried like a bounty and marked on every chart — the prize is a thing you
   *  carry, and it drags the fight along behind it. When she founders it floats
   *  back out of her (dropShipTreasure) and the chase starts again. */
  STRONGBOX_VALUE: 2600,
  /** Stable id — the strongbox is a singleton, and Match reads it back off the
   *  chest arrays to find who is holding the prize. */
  STRONGBOX_ID: 'gilded-wreck-strongbox',
  /** A bot crew this close to her heaves to and sends a boarding party over the
   *  side for her loot. Wide enough that the anchor drops before the hull is in
   *  among the chests, which is what makes a plundering crew a sitting target. */
  PLUNDER_RANGE: 62,
  /** Hunt radius for the crew holding the strongbox: everyone inside this wants
   *  it, cap or no cap, phase seek radius or no phase seek radius. */
  PRIZE_HUNT_RANGE: 760,
  /** Hull half-length / half-beam of the ghost galleon, metres. Drives the loot
   *  scatter, the client silhouette and the map icon. */
  HULL_HALF_LENGTH: 17,
  HULL_HALF_BEAM: 5.2,
  /** How far out the gold beacon column is meant to read, metres. The client
   *  sizes the shaft so the wreck is legible at this range. */
  BEACON_RANGE: 320,
  /** Bots inside this radius break off patrol and converge on her. Wide on
   *  purpose: at ~7 m/s a crew 750 m out still makes her with time to fight. */
  LURE_RADIUS: 780,
} as const;

/** Loot table for the wreck's supply barrels: no fruit, no planks — this is the
 *  powder store. Every roll is ammunition or ordnance. */
export const WRECK_SUPPLY_TABLE = [
  { item: 'cannonball' as const,      weight: 20, minQty: 6, maxQty: 10 },
  { item: 'firebomb_ball' as const,   weight: 16, minQty: 2, maxQty: 4  },
  { item: 'chainshot' as const,       weight: 14, minQty: 2, maxQty: 4  },
  { item: 'eye_ammo' as const,        weight: 12, minQty: 4, maxQty: 8  },
  { item: 'blunderbuss_ammo' as const, weight: 12, minQty: 5, maxQty: 9 },
  { item: 'flintknock_ammo' as const, weight: 12, minQty: 4, maxQty: 8  },
  { item: 'pistol_ammo' as const,     weight: 10, minQty: 8, maxQty: 14 },
  { item: 'gold' as const,            weight: 8,  minQty: 60, maxQty: 140 },
];

// ── Sea micro-POIs (uncharted, fixed) ─────────────────────────
/** ~41% of the Reach's water is more than 180 m from any coast (see
 *  scripts/test-sea-voids.mjs). These are the small hand-nothings that make a
 *  held heading worth holding: never on the chart, always in the same place, so
 *  a pirate who learns the sea gets paid for it. */
export const SEA_POI = {
  COUNT: 4,
  /** Metres between sites — they must sit in DIFFERENT voids. */
  SPACING: 300,
  /** rng stream salt; keeps every existing world placement bit-identical. */
  SEED: 0x5ea401,
  /** Supply barrels on the floating wreck cluster. */
  CLUSTER_BARRELS: 2,
  /** Supply barrels lashed to the gull-circled flotsam. */
  FLOTSAM_BARRELS: 1,
  /** Gulls circling a site — the visual signpost you read from a mile off. */
  GULLS: 7,
  /** Radius of the gull circle, metres. */
  GULL_RADIUS: 15,
} as const;
