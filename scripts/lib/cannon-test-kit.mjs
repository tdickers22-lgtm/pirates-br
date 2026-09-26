// Shared fixture for test-cannon-load / test-cannon-ammo (b3.5b, D20): a real
// Match hull with a human seated at gun 0, a standalone WeaponSystem for the
// unit rows (no truce clock), and the Match itself for the wire rows.
import { Match } from '../../src/server/core/Match.ts';
import { SERVER_TICK_MS } from '../../src/shared/constants/index.ts';
import { TRUCE_SECONDS } from '../../src/shared/truce.ts';

export const DT = SERVER_TICK_MS / 1000;
export const ticksFor = (s) => Math.round(s / DT);

export function makeExpect() {
  let failures = 0;
  const expect = (label, condition, detail = '') => {
    if (condition) console.log(`  ✓ ${label}`);
    else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
  };
  return { expect, failures: () => failures };
}

export const IDLE = {
  seq: 1, ts: 0,
  forward: false, back: false, left: false, right: false,
  jump: false, jumpPressed: false, crouch: false,
  fire: false, useItem: false, aim: false,
  interact: false, interactHeld: false, anchor: false,
  sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
  trade: false, reload: false, placeKeg: false, dropChest: false,
  specialAttack: false, slot: null, cannonAmmo: null,
  yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null,
};

/** A human seated at gun 0 of their own hull, stores replaced by `inventory`. */
export function seatedGunner(label, inventory = []) {
  const sent = [];
  const ws = { readyState: 1, send(raw) { try { sent.push(JSON.parse(raw)); } catch { /* binary */ } }, close() {}, on() {}, once() {}, removeListener() {} };
  const match = new Match({ matchId: `cannon-${label}`, botCount: 0 });
  match.state.phase = 'playing';
  const joined = match.addHumanClient(ws, 'Gunner');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const client = match.clients.get(joined.playerId);
  const ship = match.state.ships.find((s) => s.id === player.shipId);
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  player.superCannonballs = 0;
  ship.inventory = inventory.map((e) => ({ ...e }));
  const seat = () => {
    player.onShipId = ship.id;
    player.position = { x: ship.position.x, y: ship.position.y + 1.9, z: ship.position.z };
    player.atCannon = true;
    player.cannonIndex = 0;
  };
  seat();
  let seq = 10;
  const step = (over = {}) => {
    seq += 1;
    client.lastInput = { ...IDLE, seq, ...over };
    match.tick();
  };
  const run = (seconds, shape = () => ({})) => { const n = ticksFor(seconds); for (let i = 0; i < n; i += 1) step(shape(i)); };
  const pastTruce = () => { match.t = Math.max(match.t, TRUCE_SECONDS + 1); };
  const msgs = (type) => sent.filter((m) => m.type === type).map((m) => m.payload);
  return { match, player, client, ship, seat, step, run, pastTruce, msgs, sent };
}

export const stock = (ship, item) => ship.inventory.filter((e) => e.item === item).reduce((a, e) => a + e.qty, 0);

// Behaviour-level imports that also load on a pre-D20 tree (so the RED run
// reports failing rows instead of a missing-export crash).
const W = await import('../../src/server/systems/WeaponSystem.ts');
export const WeaponSystem = W.WeaponSystem;
export const CANNON_LOAD_SECONDS = W.CANNON_LOAD_SECONDS ?? 1.6;
export const CANNON_FALLBACK_ORDER = W.CANNON_FALLBACK_ORDER ?? [];
export const cannonLoadState = W.cannonLoadState ?? ((ship, i) => {
  const shot = ship.cannonLoaded?.[i] ?? null;
  if (!shot) return 'empty';
  return (ship.cannonLoadLeft?.[i] ?? 0) > 0 ? 'loading' : 'loaded';
});
/** weapons.loadCannon, or a no-op (false) on a tree without it. */
export const load = (weapons, player, ship, i) => (typeof weapons.loadCannon === 'function' ? weapons.loadCannon(player, ship, i) : false);
export const autoLoadManned = (weapons, player, ship) => (typeof weapons.autoLoadManned === 'function' ? weapons.autoLoadManned(player, ship) : false);
