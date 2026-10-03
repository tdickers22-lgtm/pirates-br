import { packWireIsland } from '../../shared/propWire.js';
import type {
  GameState,
  HotSnapshotPayload,
  InputAckPayload,
  Island,
  Player,
  SeaRock,
  Ship,
  StaticWorldDelta,
  StaticWorldWire,
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
    aiming,
    atCapstan,
    ...wire
  } = player;
  // POSE-01's two pose bits ride the same rule as a hole's `patched`: TRUE ships,
  // false is absent. Written out both ways they are ~35 B per player per full —
  // 24 players x ~11 fulls/s is ~9 KB/s of the word "false", and the 24-player
  // static-world full is already within 2 KB of its ceiling.
  const out = wire as unknown as Player;
  if (aiming) out.aiming = true;
  if (atCapstan) out.atCapstan = true;
  return out;
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
 *     the 0.16-0.31 m (HOLE_SIZE_RADIUS) decal needs.
 *   · `size` ships only when > 1 (absent = 1).
 * That is ~31 B for an open breach against ~70 B for the raw entity.
 */
function stripShipInternals(ship: Ship): Ship {
  const { nextHoleId: _nextHoleId, lastHostileShipId: _lastHostileShipId, holes, ...wire } = ship;
  return {
    ...wire,
    // `tier` is the ONE added byte per breach (SINK-01): the height class the
    // server stamped at placement, so the client renders/announces LOW/MID/HIGH
    // without re-deriving it from y and the hull class.
    // `size` (b2.2b) rides the same way as `patched`: only when it is not the
    // default 1, so a fleet of plain holes pays nothing and a widened breach
    // pays one digit.
    holes: holes.map((hole) => {
      const wireHole: Record<string, unknown> = { id: hole.id, x: hole.x, y: hole.y, z: hole.z, tier: hole.tier };
      if ((hole.size ?? 1) > 1) wireHole.size = hole.size;
      if (hole.patched) wireHole.patched = true;
      return wireHole;
    }),
  } as unknown as Ship;
}

/** Wildlife wire trim: drop server AI internals (spawnPosition, wander state,
 *  islandId, the alert clock, the gull state machine, the carcass timer) — the
 *  client reads id/type/position/rotation, the ground VELOCITY it dead-reckons
 *  with, and two flags. `health` is server-only: liveness is now carried by the
 *  `dead` flag instead, and 70 birds x "health":24 was 0.8 KB of every 10 Hz full.
 *
 *  WILD-01 (islandworld-24): at 10 Hz a gull at 2.8 m/s moves 28 cm between
 *  snapshots and the client's exponential lerp converged in ~60 ms and then
 *  waited, so every animal moved in a sequence of dashes and the gait speed had
 *  to be recovered from noisy position deltas. Two numbers at 0.1 m/s (the
 *  fastest animal is 2.8 m/s x 1.8 while fleeing, so one decimal is ~2 % of top
 *  speed) buy real motion between snapshots. `alert` and `dead` are written only
 *  when true, so a calm world pays nothing for them. */
function trimWildlife(animal: WildlifeAnimal): WildlifeAnimal {
  const wire = {
    id: animal.id,
    type: animal.type,
    position: quantizeDeep(animal.position, 2),
    rotation: roundTo(animal.rotation, 3),
  } as unknown as WildlifeAnimal;
  // 0.1 m/s, and written only when the animal is actually moving: a burrowing
  // crab, a blocked walker and a perched gull are most of the roster most of
  // the time, and "vx":0,"vz":0 on 70 animals is 1 KB of every full snapshot
  // for no information. One decimal is ~2 % of the fastest animal's flee speed
  // (2.8 x 1.8 m/s) and the client only extrapolates 0.25 s with it.
  const vx = Math.round(animal.velocity.x * 10) / 10;
  const vz = Math.round(animal.velocity.z * 10) / 10;
  if (vx !== 0) wire.vx = vx;
  if (vz !== 0) wire.vz = vz;
  if (animal.alert) wire.alert = true;
  if (animal.dead) wire.dead = true;
  return wire;
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

/** The full-statics wire form of a list of already-quantised islands: props as
 *  packed columns at the wire's own yaw precision. */
export function packWireIslands(islands: Island[]): Island[] {
  const yawScale = ANGLE_KEYS.has('yaw') ? 1000 : 100;
  return islands.map((island) => packWireIsland(island, yawScale));
}

/** END-01: how many crews it takes before the chart shows the fleet. */
export const CHART_REVEAL_CREWS = 3;

export function buildWireSnapshot(snap: GameState, includeStaticWorld: boolean): GameState {
  // ALL HANDS ON THE CHART (END-01, gameplay-22). The last three crews are the
  // match's endgame, and until now nothing anywhere said where they were: the
  // feed printed "THREE CREWS REMAIN" and the chart carried a mark for the
  // bounty leader and for nobody else. Past this line every hull afloat is
  // stamped `revealed`, which is what the chart draws its endgame treatment
  // from. The flag is never written false — a match with four crews left pays
  // literally nothing for it.
  const revealed = snap.shipsAlive <= CHART_REVEAL_CREWS;
  return {
    ...snap,
    serverTime: roundTo(snap.serverTime, 3),
    storm: quantizeDeep(snap.storm, 2),
    ships: snap.ships.map((ship) => quantizeDeep(
      revealed && ship.alive && !ship.sinking
        ? { ...stripShipInternals(ship), revealed: true }
        : stripShipInternals(ship),
      2,
    )),
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
    // b4 gate (test-snapshot-size): props ride as packed columns on the full
    // wire (src/shared/propWire.ts); the client unpacks them bit-identically.
    islands: includeStaticWorld ? packWireIslands(snap.islands.map(quantizeIslandForWire)) : [],
    // Sea rocks rode at full float precision, and their collider lists are the
    // single densest run of raw doubles in the world payload: 37 stacks x ~5
    // capsules, each carrying "minY":-3.8040000000000003. 28.8 KB of the 250 KB
    // ceiling was that mantissa noise. 3 decimals is 1 mm on a 15 m shoal —
    // below anything the client renders or predicts against, and the server
    // keeps its own unrounded copy for the authoritative collision test.
    seaRocks: includeStaticWorld ? quantizeDeep(snap.seaRocks, 3) : [],
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
        // Only while it is leaving: the client fades a shark that gave up
        // instead of exploding it in blood (review-6 P1).
        ...(shark.despawnTimer !== undefined
          ? { despawnTimer: roundTo(shark.despawnTimer, 2) }
          : {}),
      })),
  };
}

/**
 * PRED-01 (netcode-35): the per-client receipt a predicting client reconciles
 * against.
 *
 * Deliberately NOT part of the hot snapshot: a hot frame is one string shared by
 * every socket (that is what keeps it cheap), and this is the one fact that is
 * different for every client. It is built per client per hot tick, so it is
 * kept to the six fields the reconciliation actually reads and quantised to
 * millimetres like every other position on the wire — ~70 B, ~2 KB/s at 31 Hz.
 *
 * `pos` is world-space even aboard a hull: the client re-derives the deck-local
 * seat from the hull pose it is already drawing, so an ack that crossed a
 * boarding cannot be misread as a two-metre deck offset in world coordinates.
 */
export function buildInputAck(player: Player, seq: number, serverTime: number): InputAckPayload {
  return {
    seq,
    pos: quantizeDeep(player.position, 3),
    vel: quantizeDeep(player.velocity, 2),
    onShipId: player.onShipId ?? null,
    state: player.state,
    t: roundTo(serverTime, 3),
  };
}

// ============================================================
// STATIC WORLD FROM THE SEED (b4.1b, D30, performance-05)
// ============================================================
// The join used to post ~237 KB of islands + sea rocks. A seed-capable client
// now regenerates them (src/shared/staticWorld.ts) and the join carries only
// the DIFFERENCE between the pristine generated world and the live one, both
// in wire form. Client and server run the same three functions below, so the
// rebuilt wire is byte-identical to what a full join would have delivered.

/** The statics exactly as buildWireSnapshot would put them on the wire, as a
 *  detached plain-JSON tree (undefined keys dropped, no shared references). */
export function staticWorldWireOf(islands: Island[], seaRocks: SeaRock[]): StaticWorldWire {
  return JSON.parse(JSON.stringify({
    islands: islands.map(quantizeIslandForWire),
    seaRocks: quantizeDeep(seaRocks, 3),
  })) as StaticWorldWire;
}

export function staticWorldWire(world: { islands: Island[]; seaRocks: SeaRock[] }): StaticWorldWire {
  return staticWorldWireOf(world.islands, world.seaRocks);
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => v !== null && typeof v === 'object';
const idOf = (v: Json): string | null => (isObj(v) && !Array.isArray(v) && typeof v.id === 'string' ? v.id : null);

function diffInto(a: Json, b: Json, path: (string | number)[], out: StaticWorldDelta[]): void {
  if (a === b) return;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) { out.push([path, b]); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    let base: Json[] = a;
    if (a.length !== b.length) {
      // Id-keyed lists (chests, barrels, npcs, rocks): a destroyed static is one
      // splice, not a re-post of the whole list. Anything else (inserts, a
      // reorder, id-less arrays) re-posts the list.
      const aIds = a.map(idOf);
      const bIds = b.map(idOf);
      if (aIds.some((id) => id === null) || bIds.some((id) => id === null)) { out.push([path, b]); return; }
      const keep = new Set(bIds as string[]);
      const removed: number[] = [];
      aIds.forEach((id, i) => { if (!keep.has(id as string)) removed.push(i); });
      const kept = a.filter((_, i) => !removed.includes(i));
      if (kept.length !== b.length || kept.some((v, i) => idOf(v) !== bIds[i])) { out.push([path, b]); return; }
      for (let r = removed.length - 1; r >= 0; r--) out.push([[...path, removed[r]]]);
      base = kept;
    }
    for (let i = 0; i < b.length; i++) diffInto(base[i], b[i], [...path, i], out);
    return;
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  for (const key of Object.keys(ao)) {
    if (!(key in bo)) out.push([[...path, key]]);
    else diffInto(ao[key], bo[key], [...path, key], out);
  }
  for (const key of Object.keys(bo)) if (!(key in ao)) out.push([[...path, key], bo[key]]);
}

/** Edits that turn `base` (the pristine generated wire) into `current`. */
export function diffStaticWorld(base: StaticWorldWire, current: StaticWorldWire): StaticWorldDelta[] {
  const out: StaticWorldDelta[] = [];
  diffInto(base, current, [], out);
  return out;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Apply diffStaticWorld's edits in place. Throws on a path that does not
 *  resolve (the caller then asks for a world_sync instead of guessing). */
export function applyStaticWorldDeltas(target: StaticWorldWire, deltas: StaticWorldDelta[]): StaticWorldWire {
  for (const delta of deltas) {
    const path = delta[0];
    if (!Array.isArray(path) || path.length === 0) throw new Error('static delta: empty path');
    let node: Json = target;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (UNSAFE_KEYS.has(String(key)) || !isObj(node)) throw new Error(`static delta: bad path ${path.join('.')}`);
      node = (node as Record<string | number, Json>)[key];
    }
    const last = path[path.length - 1];
    if (UNSAFE_KEYS.has(String(last)) || !isObj(node)) throw new Error(`static delta: bad path ${path.join('.')}`);
    if (delta.length < 2) {
      if (Array.isArray(node)) node.splice(Number(last), 1);
      else delete (node as Record<string, Json>)[last as string];
    } else {
      (node as Record<string | number, Json>)[last] = delta[1];
    }
  }
  return target;
}
