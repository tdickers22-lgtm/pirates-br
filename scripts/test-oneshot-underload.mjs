#!/usr/bin/env node
// THE PRESS CONTRACT — a one-shot press is a PROMISE, not a sample.
//
// The client streams inputs at 45 Hz into a single `client.lastInput` slot; the
// server reads that slot once per tick. When the sim starves (tick callbacks
// delayed, ticks dropped) the packet carrying `interact: true` is overwritten by
// the newer packets that arrive before any tick reads it — the press evaporates
// with the correct prompt still on screen ("three dead X at the wheel, the
// fourth worked").
//
// This suite drives the REAL intake path (Match.handleMessage) under deliberate
// starvation and asserts:
//   1. every one-shot flag survives being overwritten by unread packets,
//   2. a press the sim ALREADY saw is never resurrected (no double-fire),
//   3. refused [X] answers with `interact_refused` instead of silence.
import { Match } from '../src/server/core/Match.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { toShipWorldPoint } from '../src/shared/interactions.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const sent = [];
const ws = {
  readyState: 1,
  bufferedAmount: 0,
  send(raw) { try { sent.push(JSON.parse(raw)); } catch { /* binary snapshot */ } },
  close() {},
};

const match = new Match({ matchId: 'oneshot-underload', botCount: 0 });
const state = match.state;
state.phase = 'playing';
const { playerId, shipId } = match.addHumanClient(ws, 'Starved');
const client = match.clients.get(playerId);
const player = match.playersById.get(playerId);
const ship = state.ships.find((s) => s.id === shipId);
const stats = SHIP_STATS[ship.type];

let seq = 0;
const packet = (over = {}) => ({
  seq: (seq += 1), ts: 0,
  forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
  fire: false, useItem: false, crouch: false, aim: false, interact: false, interactHeld: false,
  anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
  trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
  slot: null, cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
  barrelTakeAll: false, interactIntent: null, selectMap: null, ...over,
});
/** Wire-level arrival: exactly what a player_input frame does on the socket. */
const arrive = (over = {}) => {
  match.handleMessage(client, { type: 'player_input', ts: Date.now(), payload: packet(over) });
};
/** One server tick's input stage (the loop in Match.tick), at an arbitrary dt so
 *  a starved server can be modelled without wall-clock sleeping. */
const runTick = (dt = 1 / 62.5) => {
  match.t += dt;
  if (client.lastInput) match.applyInput(client, client.lastInput, dt);
};

// Count real deliveries: consumeOneShot returning true IS "the sim saw the press".
const consumes = new Map();
const realConsume = match.consumeOneShot.bind(match);
match.consumeOneShot = (c, action, s) => {
  const ok = realConsume(c, action, s);
  if (ok) consumes.set(action, (consumes.get(action) ?? 0) + 1);
  return ok;
};
const countOf = (action) => consumes.get(action) ?? 0;

/** Stand her on her own deck, clear of every station. */
const standOnDeck = () => {
  const w = toShipWorldPoint({ x: 0, z: 0 }, ship);
  player.onShipId = ship.id;
  player.state = 'alive';
  player.atHelm = false;
  player.atCannon = false;
  player.atCrowNest = false;
  player.mastClimb = null;
  player.position.x = w.x;
  player.position.z = w.z;
  player.position.y = ship.position.y + stats.height + 0.4;
};

// ── 1. The starved sim: presses arrive, ticks do not ───────────────────────
console.log('One-shot presses under a starving sim');
standOnDeck();

const PRESSES = 20;
const PACKETS_PER_TICK = 12; // 45 Hz client vs a sim managing ~4 Hz
for (let i = 0; i < PRESSES; i += 1) {
  for (let p = 0; p < PACKETS_PER_TICK; p += 1) {
    // The press rides packet 4 of 12 — every packet after it overwrites the slot.
    if (p === 3) arrive({ interact: true, interactHeld: true, interactIntent: 'anchor' });
    else arrive({});
  }
  runTick(0.3); // one late tick per burst, well clear of the 0.2 s interact throttle
}
expect('every [X] pressed between two late ticks still reaches the sim',
  countOf('interact') === PRESSES,
  `delivered=${countOf('interact')}/${PRESSES}`);
expect('the intent that rode with the press survives with it',
  client.lastInput.interactIntent === 'anchor',
  `intent=${client.lastInput.interactIntent}`);

// ── 2. Every one-shot flag, not just interact ──────────────────────────────
console.log('\nThe whole one-shot mask survives the overwrite');
const ONE_SHOTS = [
  ['jumpPressed', { jumpPressed: true }, (m) => m.jumpPressed === true],
  ['trade', { trade: true }, (m) => m.trade === true],
  ['reload', { reload: true }, (m) => m.reload === true],
  ['placeKeg', { placeKeg: true }, (m) => m.placeKeg === true],
  ['dropChest', { dropChest: true }, (m) => m.dropChest === true],
  ['specialAttack', { specialAttack: true }, (m) => m.specialAttack === true],
  ['barrelTakeAll', { barrelTakeAll: true }, (m) => m.barrelTakeAll === true],
  ['slot', { slot: 2 }, (m) => m.slot === 2],
  ['cannonAmmo', { cannonAmmo: 'firebomb' }, (m) => m.cannonAmmo === 'firebomb'],
  ['selectMap', { selectMap: 'island-7' }, (m) => m.selectMap === 'island-7'],
  ['useWheelItem (with its wheel index)', { useWheelItem: true, wheelIndex: 4 },
    (m) => m.useWheelItem === true && m.wheelIndex === 4],
];
for (const [label, press, check] of ONE_SHOTS) {
  runTick();               // flush: the slot is now a packet the sim has read
  arrive(press);           // the press
  for (let p = 0; p < 10; p += 1) arrive({}); // ten idle packets bury it
  expect(`${label} survives ten overwriting packets`, check(client.lastInput),
    JSON.stringify({ slot: client.lastInput.slot, wheelIndex: client.lastInput.wheelIndex }));
}

// ── 3. No resurrection: a press the sim already read fires ONCE ────────────
console.log('\nA press the sim already read is never replayed');
standOnDeck();
match.t += 1;
const beforeSingle = countOf('interact');
arrive({ interact: true, interactIntent: 'anchor' });
runTick();
for (let p = 0; p < 15; p += 1) arrive({});
for (let i = 0; i < 15; i += 1) runTick(0.3);
expect('one press = exactly one delivery, however many packets follow',
  countOf('interact') - beforeSingle === 1,
  `delivered=${countOf('interact') - beforeSingle}`);

// The nastiest resurrection case: a press the sim READ but never consumed
// (the branch's gate said no). It must not be carried forward forever, or it
// fires the instant an unrelated state change opens that gate.
player.activeSlot = 1;
player.equippedTool = null;
runTick();
arrive({ slot: 1 });    // slot 1 is already active — applyInput's gate declines it
runTick();
for (let p = 0; p < 6; p += 1) arrive({});
expect('a press the sim read and declined does not stick to the slot',
  client.lastInput.slot === null, `slot=${client.lastInput.slot}`);

// ── 4. A refused [X] answers back ──────────────────────────────────────────
console.log('\nA refused [X] is never silent');
standOnDeck();
player.position.x = ship.position.x + 400; // nowhere near any station
player.position.z = ship.position.z + 400;
player.onShipId = null;
player.state = 'alive';
sent.length = 0;
match.t += 1;
arrive({ interact: true, interactIntent: 'helm' });
runTick();
const refusals = sent.filter((m) => m.type === 'interact_refused');
expect('an impossible [X] answers with interact_refused', refusals.length === 1,
  `messages=${JSON.stringify(sent.map((m) => m.type))}`);
expect('the refusal names the intent that was refused',
  refusals[0]?.payload?.intent === 'helm', JSON.stringify(refusals[0]?.payload));
expect('the refusal carries a reason', typeof refusals[0]?.payload?.reason === 'string',
  JSON.stringify(refusals[0]?.payload));

// Rate limit: a mashed [X] must not become a wall of amber feed lines.
sent.length = 0;
for (let i = 0; i < 6; i += 1) {
  match.t += 0.21; // clears the interact throttle, inside the refusal rate limit
  arrive({ interact: true, interactIntent: 'helm' });
  runTick();
}
const burst = sent.filter((m) => m.type === 'interact_refused');
expect('mashing [X] is rate-limited to one refusal', burst.length === 1,
  `refusals=${burst.length}`);

// A refusal that resolves must not still fire: a granted [X] says nothing.
standOnDeck();
ship.waterLevel = 0.4;          // there IS water to bail — the press is valid
sent.length = 0;
match.t += 2;
arrive({ interact: true, interactIntent: 'bail' });
runTick();
expect('a granted [X] stays quiet',
  sent.filter((m) => m.type === 'interact_refused').length === 0,
  JSON.stringify(sent.map((m) => m.type)));

if (failures > 0) {
  console.error(`\n${failures} one-shot-intake assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll one-shot intake assertions passed.');
