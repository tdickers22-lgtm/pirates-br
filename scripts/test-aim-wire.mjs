#!/usr/bin/env node
// TWO BITS THAT MAKE A PIRATE READABLE (POSE-01 wire half, avatar-06/11).
//
// `aim` and `atCapstan` were facts only the acting player knew: they lived in
// the input packet (humans) or inside the behaviour tree (bots) and never
// crossed the wire. So a remote pirate drawing a bead on you walked past with
// her weapon at the hip, and a crewmate hauling on the capstan bar looked like
// a crewmate standing still. Everything a third person needs is one bit each.
//
// This suite drives the REAL Match through the REAL applyInput and pins:
//   1. a firearm plus aim (or fire) raises the bit, and hands that are full
//      (chest, cannon, swimming) or holding a cutlass do NOT;
//   2. the bits are MOMENTARY — Match.tick clears them at the top of the tick,
//      so a client that stops sending input cannot freeze a pirate mid-aim;
//   3. the capstan bar sets atCapstan while the anchor is coming up;
//   4. a bot who has picked a target raises hers too, from the turn, not from
//      the shot.
//
//   node --import tsx scripts/test-aim-wire.mjs
import { readFileSync } from 'node:fs';
import { Match } from '../src/server/core/Match.ts';
import { WEAPONS, SERVER_TICK_MS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const DT = SERVER_TICK_MS / 1000;

let seq = 0;
function input(over = {}) {
  return {
    seq: (seq += 1), ts: 0,
    forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
    fire: false, useItem: false, crouch: false, aim: false, interact: false, interactHeld: false,
    anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
    trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
    slot: null, cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
    barrelTakeAll: false, interactIntent: null, ...over,
  };
}

const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
const match = new Match({ matchId: 'aim-wire', botCount: 0 });
const { playerId, shipId } = match.addHumanClient(ws, 'Gunner');
const client = match['clients'].get(playerId);
const player = match['playersById'].get(playerId);
const ship = match['state'].ships.find((s) => s.id === shipId);
match['t'] = 100;

// Put her on her own deck with a loaded firearm in hand.
const firearmSlot = player.weapons.findIndex((w) => w && !WEAPONS[w.weaponId].melee);
const cutlassSlot = player.weapons.findIndex((w) => w && WEAPONS[w.weaponId].melee);
player.onShipId = ship.id;
player.state = 'alive';
player.activeSlot = firearmSlot;

console.log('The firearm goes up on the wire:');
expect('the pirate starts with a firearm and a cutlass to choose between',
  firearmSlot >= 0 && cutlassSlot >= 0, `firearm=${firearmSlot} cutlass=${cutlassSlot}`);

match['applyInput'](client, input({ aim: true }), DT);
expect('holding aim with a firearm sets player.aiming', player.aiming === true);

match['applyInput'](client, input({ fire: true }), DT);
expect('firing from the hip counts as weapon-up too', player.aiming === true);

match['applyInput'](client, input({}), DT);
expect('letting go drops it the same tick', player.aiming === false);

player.activeSlot = cutlassSlot;
match['applyInput'](client, input({ aim: true }), DT);
expect('aim with a cutlass is a GUARD, not an aim', player.aiming === false && player.blocking === true);
player.activeSlot = firearmSlot;

player.carryingChestId = 'chest-x';
match['applyInput'](client, input({ aim: true }), DT);
expect('a pirate carrying a chest has no free hands', player.aiming === false);
player.carryingChestId = null;

player.atCannon = true;
match['applyInput'](client, input({ aim: true }), DT);
expect('a gunner on the cannon is not aiming a firearm', player.aiming === false);
player.atCannon = false;

player.state = 'swimming';
match['applyInput'](client, input({ aim: true }), DT);
expect('a swimmer keeps the weapon down', player.aiming === false);
player.state = 'alive';

// ── Momentary: the tick owns the clear ──────────────────────────────────────
console.log('The bits are momentary:');
player.aiming = true;
player.atCapstan = true;
client.lastInput = null;
match['state'].phase = 'playing';
match.tick();
expect('a tick with no input clears both bits (no frozen aim on a dropped client)',
  player.aiming === false && player.atCapstan === false,
  `aiming=${player.aiming} atCapstan=${player.atCapstan}`);

// ── The capstan bar ─────────────────────────────────────────────────────────
console.log('The capstan bar is visible work:');
{
  const anchor = match['getShipAnchorPoint']?.(ship) ?? null;
  ship.anchored = true;
  ship.anchorRaiseProgress = 0;
  player.onShipId = ship.id;
  player.atHelm = false;
  player.atCannon = false;
  player.atCrowNest = false;
  player.state = 'alive';
  // Stand on the bow, where the capstan is; isNearAnchor is the server's own
  // reach test, so ask it rather than guessing a radius.
  let placed = false;
  if (anchor) { player.position = { x: anchor.x, y: player.position.y, z: anchor.z }; placed = true; }
  else {
    // Walk the bow local offsets until the server agrees we are at the capstan.
    for (let f = 0; f <= 1.0001 && !placed; f += 0.05) {
      const fwd = { x: Math.sin(ship.rotation), z: Math.cos(ship.rotation) };
      for (const sign of [1, -1]) {
        const d = sign * f * 14;
        player.position = { x: ship.position.x + fwd.x * d, y: ship.position.y + 2.4, z: ship.position.z + fwd.z * d };
        if (match['isNearAnchor'](player, ship)) { placed = true; break; }
      }
    }
  }
  expect('a spot at the capstan exists on the bow', placed && match['isNearAnchor'](player, ship));
  const before = ship.anchorRaiseProgress;
  match['applyInput'](client, input({ interactHeld: true }), DT);
  expect('holding [X] at the capstan sets atCapstan while the anchor comes up',
    player.atCapstan === true && ship.anchorRaiseProgress > before,
    `atCapstan=${player.atCapstan} progress ${before} → ${ship.anchorRaiseProgress}`);
}

// ── Bots raise theirs from the turn, not from the shot ──────────────────────
console.log('A bot with a target has her weapon up:');
{
  const src = readFileSync(new URL('../src/server/systems/bots/BotPirate.ts', import.meta.url), 'utf8');
  const idx = src.indexOf('player.aiming = true');
  const fireIdx = src.indexOf('pendingFirearmFires.push');
  expect('BotPirate raises the bit BEFORE the shot is queued, not after',
    idx > 0 && fireIdx > idx, `aiming@${idx} fire@${fireIdx}`);

  // And it really happens in a running match: two bots of different crews put
  // within pistol shot of one another on open deck.
  const bm = new Match({ matchId: 'aim-wire-bots', botCount: 9 });
  bm['state'].phase = 'playing';
  const bots = bm['state'].players.filter((p) => p.isBot);
  const a = bots[0];
  const b = bots.find((p) => p.shipId !== a.shipId);
  let seen = 0;
  for (let i = 0; i < 240 && seen === 0; i++) {
    // Hold them nose to nose; the behaviour tree does the rest.
    b.position = { x: a.position.x + 9, y: a.position.y, z: a.position.z };
    b.onShipId = a.onShipId;
    bm.tick();
    if (bots.some((p) => p.aiming)) seen += 1;
  }
  expect('a bot in a firefight replicates aiming', seen > 0, `no bot raised a weapon in 240 ticks`);
}

console.log(failures === 0 ? '\nPASS test-aim-wire' : `\nFAIL test-aim-wire (${failures})`);
process.exit(failures === 0 ? 0 : 1);
