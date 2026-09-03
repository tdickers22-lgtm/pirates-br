import type {
  GameState,
  HotSnapshotPayload,
  Island,
  Player,
  Ship,
  WildlifeAnimal,
} from '../../shared/types/index.js';

// ============================================================
// SNAPSHOT WIRE FORMAT
// ============================================================
// Full snapshots were 83–210 KB of raw JSON at 31 Hz — enough to saturate the
// 512 KB socket gate and starve clients (~1 s snapshot age). The wire layer
// now (a) quantizes floats (positions 2 decimals, angles 3), (b) strips
// server-internal / static fields, and (c) splits cadence: quantized full
// snapshots at ~10 Hz plus tiny 'state_hot' transform updates at ~31 Hz.
//
// IMPORTANT: islands and seaRocks are NEVER quantized — their parameters feed
// the shared deterministic terrain/collision math on the client, and rounding
// them would desync client prediction from server physics. They are static,
// so they simply ride the (rare) includeStaticWorld snapshots at full
// precision instead.

/** Keys whose numeric leaves are angles/phases — kept at 3 decimals. */
const ANGLE_KEYS = new Set([
  'rotation',
  'pitch',
  'roll',
  'yaw',
  'sailAngle',
  'rudderAngle',
  'angularVelocity',
  'shrinkProgress',
  'serverTime',
]);

function roundTo(value: number, decimals: 2 | 3): number {
  if (!Number.isFinite(value)) return value;
  const f = decimals === 3 ? 1000 : 100;
  return Math.round(value * f) / f;
}

/** Fast recursive rounder. Numbers are rounded to `decimals` (angle-ish keys
 *  get 3), strings/booleans/null pass through, objects/arrays are cloned. */
function quantizeDeep<T>(value: T, decimals: 2 | 3 = 2): T {
  if (typeof value === 'number') return roundTo(value, decimals) as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => quantizeDeep(entry, decimals)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const entry = (value as Record<string, unknown>)[key];
    out[key] = quantizeDeep(entry, ANGLE_KEYS.has(key) ? 3 : decimals);
  }
  return out as T;
}

/** Server-internal player fields the client never reads — stripped from the wire. */
function stripPlayerInternals(player: Player): Player {
  const {
    lastDamagedById: _lastDamagedById,
    lastDamagedAt: _lastDamagedAt,
    lastDamageWasHeadshot: _lastDamageWasHeadshot,
    lastEnvDamage: _lastEnvDamage,
    ...wire
  } = player;
  return wire as unknown as Player;
}

/**
 * Ship wire trim. `nextHoleId` is a server-internal counter and never ships.
 *
 * The hole ENTITIES do ride the full snapshot (the client id-diffs them into
 * decals), so they are trimmed hard — a fleet in a running gunfight is the
 * worst case this whole protocol exists to survive:
 *   · `source` is server flavour (fire chars burn downward) — dropped.
 *   · `patched` only ships when TRUE; absent reads as an open breach.
 *   · coordinates quantize to 2 dp (1 cm) with quantizeDeep, far finer than
 *     the HOLE_VISUAL_RADIUS 0.26 m decal needs.
 * That is ~31 B for an open breach against ~70 B for the raw entity.
 */
function stripShipInternals(ship: Ship): Ship {
  const { nextHoleId: _nextHoleId, lastHostileShipId: _lastHostileShipId, holes, ...wire } = ship;
  return {
    ...wire,
    // `tier` is the ONE added byte per breach (SINK-01): the height class the
    // server stamped at placement, so the client renders/announces LOW/MID/HIGH
    // without re-deriving it from y and the hull class.
    holes: holes.map((hole) => (hole.patched
      ? { id: hole.id, x: hole.x, y: hole.y, z: hole.z, tier: hole.tier, patched: true }
      : { id: hole.id, x: hole.x, y: hole.y, z: hole.z, tier: hole.tier })),
  } as unknown as Ship;
}

/** Wildlife wire trim: drop server AI internals (spawnPosition, wander state,
 *  velocity, islandId) — the client only reads id/type/position/rotation.
 *  `health` is server-only too: dead animals are culled from state.wildlife
 *  before the snapshot is built, so anything on the wire is by definition
 *  alive, and 70 birds x "health":24 was 0.8 KB of every 10 Hz full. */
function trimWildlife(animal: WildlifeAnimal): WildlifeAnimal {
  return {
    id: animal.id,
    type: animal.type,
    position: quantizeDeep(animal.position, 2),
    rotation: roundTo(animal.rotation, 3),
  } as WildlifeAnimal;
}

/**
 * Quantized + trimmed full snapshot for the wire. `snap` is the state-shaped
 * snapshot from Match.buildSnapshot (islands already stripped unless this is
 * a static-world tick); seaRocks follow the same static-world cadence.
 */
/** Quantize an island's DECORATIVE/entity data (props, caves, chests, barrels,
 *  npcs, …) to 2 decimals (~1cm — visually lossless) while leaving the fields that
 *  feed the shared deterministic terrain math (profile, stamps, position, radius)
 *  at full precision. Props alone are ~110KB of the world payload at full float
 *  precision, so this is what keeps the join snapshot lean. */
function quantizeIslandForWire(island: Island): Island {
  const q = quantizeDeep(island, 2) as Island;
  return {
    ...q,
    position: island.position,
    radius: island.radius,
    profile: island.profile,
    stamps: island.stamps,
  };
}

export function buildWireSnapshot(snap: GameState, includeStaticWorld: boolean): GameState {
  return {
    ...snap,
    serverTime: roundTo(snap.serverTime, 3),
    storm: quantizeDeep(snap.storm, 2),
    ships: snap.ships.map((ship) => quantizeDeep(stripShipInternals(ship), 2)),
    players: snap.players.map((player) => quantizeDeep(stripPlayerInternals(player), 2)),
    projectiles: snap.projectiles.map((proj) => quantizeDeep(proj, 2)),
    kegs: snap.kegs.map((keg) => quantizeDeep(keg, 2)),
    sharks: snap.sharks.map((shark) => quantizeDeep(shark, 2)),
    wildlife: snap.wildlife.map(trimWildlife),
    // Static world data at full precision (deterministic shared math), only on
    // includeStaticWorld ticks — the client preserves its previous copy. Cave
    // networks are TRANSMITTED data (not regenerated from a seed), so their now
    // much larger multi-vein segment lists quantize to 2 decimals (~1cm) to keep
    // the world payload lean without touching the island's terrain parameters.
    islands: includeStaticWorld ? snap.islands.map(quantizeIslandForWire) : [],
    seaRocks: includeStaticWorld ? snap.seaRocks : [],
    // Only DIRTY chests (touched by play: dug/carried/stowed/floating/opened)
    // ride the 10Hz sync, trimmed to their dynamic fields — pristine buried
    // chests never change, and shipping all ~50 in full blew the snapshot cap.
    chestSync: (snap.chestSync ?? [])
      .filter((chest) => chest.carriedByPlayerId || chest.storedOnShipId || chest.floating || chest.opened || chest.digProgress > 0)
      .map((chest) => quantizeDeep({
        id: chest.id,
        position: chest.position,
        carriedByPlayerId: chest.carriedByPlayerId,
        storedOnShipId: chest.storedOnShipId,
        floating: chest.floating,
        opened: chest.opened,
        digProgress: chest.digProgress,
      } as typeof chest, 2)),
    // Sunken cargo, trimmed to the bone. The expiry clock is server bookkeeping
    // and `fromShipId` is a 36-char uuid the client never reads (attribution
    // rides the one-off 'cargo_spilled' message instead) — carrying it made a
    // full seabed cost 4.3 KB of every 10 Hz snapshot against a 35 KB cap. The
    // key itself is omitted entirely when no wreck is bleeding, so a match with
    // no spills pays literally nothing for the feature.
    ...((snap.spoils?.length ?? 0) > 0
      ? {
        spoils: (snap.spoils ?? []).map((spoil) => ({
          id: spoil.id,
          position: quantizeDeep(spoil.position, 2),
          value: Math.round(spoil.value),
        })) as GameState['spoils'],
      }
      : {}),
  };
}

/**
 * Tiny high-rate update: ships + players + projectiles (+ kegs/sharks)
 * transforms only. ~3–6 KB at 14 players / 10 ships, sent at ~31 Hz between
 * ~10 Hz full snapshots. The client patches these by id onto its last full
 * state; entities it has never seen in a full snapshot are ignored (except
 * projectiles, which carry their type so muzzle-fresh rounds can render).
 */
export function buildHotSnapshot(state: GameState, serverTime: number, seq?: number): HotSnapshotPayload {
  return {
    tick: state.tick,
    ...(seq !== undefined ? { seq } : {}),
    // Only rides the wire while a staged start is actually counting down, so the
    // normal hot budget is untouched.
    ...(state.countdownRemaining ? { countdownRemaining: roundTo(state.countdownRemaining, 2) } : {}),
    serverTime: roundTo(serverTime, 3),
    shipsAlive: state.shipsAlive,
    storm: quantizeDeep(state.storm, 2),
    ships: state.ships
      .filter((ship) => ship.alive)
      .map((ship) => ({
        id: ship.id,
        position: quantizeDeep(ship.position, 2),
        rotation: roundTo(ship.rotation, 3),
        velocity: quantizeDeep(ship.velocity, 2),
        angularVelocity: roundTo(ship.angularVelocity, 3),
        pitch: ship.pitch !== undefined ? roundTo(ship.pitch, 3) : undefined,
        roll: ship.roll !== undefined ? roundTo(ship.roll, 3) : undefined,
        heave: ship.heave !== undefined ? roundTo(ship.heave, 2) : undefined,
        rudderAngle: ship.rudderAngle !== undefined ? roundTo(ship.rudderAngle, 3) : undefined,
        sailHeight: roundTo(ship.sailHeight, 2),
        sailAngle: roundTo(ship.sailAngle, 3),
        sinking: ship.sinking,
        sinkProgress: roundTo(ship.sinkProgress, 2),
        waterLevel: ship.waterLevel !== undefined ? roundTo(ship.waterLevel, 2) : undefined,
        floodingRate: ship.floodingRate !== undefined ? roundTo(ship.floodingRate, 3) : undefined,
      })),
    players: state.players
      .filter((player) => player.state !== 'eliminated' && player.state !== 'respawning')
      .map((player) => ({
        id: player.id,
        position: quantizeDeep(player.position, 2),
        rotation: quantizeDeep(player.rotation, 3),
        velocity: quantizeDeep(player.velocity, 2),
        health: roundTo(player.health, 2),
        armor: roundTo(player.armor ?? 0, 2),
        state: player.state,
        mastClimb: player.mastClimb ?? null,
        crouching: !!player.crouching,
        onShipId: player.onShipId,
        cutlassCharge: roundTo(player.cutlassCharge, 2),
        downedUntil: roundTo(player.downedUntil, 2),
        reviveProgress: roundTo(player.reviveProgress, 2),
      })),
    projectiles: state.projectiles
      .filter((proj) => proj.alive)
      .map((proj) => ({
        id: proj.id,
        type: proj.type,
        position: quantizeDeep(proj.position, 2),
        velocity: quantizeDeep(proj.velocity, 2),
      })),
    kegs: state.kegs
      .filter((keg) => keg.timer > 0 && !keg.defused)
      .map((keg) => ({
        id: keg.id,
        position: quantizeDeep(keg.position, 2),
        timer: roundTo(keg.timer, 2),
      })),
    sharks: state.sharks
      .filter((shark) => shark.health > 0)
      .map((shark) => ({
        id: shark.id,
        position: quantizeDeep(shark.position, 2),
        rotation: roundTo(shark.rotation, 3),
        health: roundTo(shark.health, 2),
        attackState: shark.attackState ?? 'cruise',
        attackTimer: roundTo(shark.attackTimer ?? 0, 2),
      })),
  };
}
