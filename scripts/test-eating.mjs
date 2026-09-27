#!/usr/bin/env node
// test-eating (b3.5a, mechanicshud-03, D21).
//
// Eating used to be instant and chainable: health += 25 the tick the wheel slot
// was pressed, the item eaten even at full health, so four bananas were +100 HP
// in 2.6 s mid-gunfight. D21: a 0.9 s bite (weapon lowered, 70 % move, cancelled
// by firing or by taking a station, NOT by damage), then heal over time (banana
// 20 over 1.2 s, fruit 22 over 1.5 s, meat its species value over 2.0 s), one
// heal at a time, refused at full health. This drives a real human client
// through the real Match at 62.5 Hz and reads the server truth.
//
//   node --import tsx scripts/test-eating.mjs
import { Match } from '../src/server/core/Match.ts';
import { readFileSync } from 'node:fs';
import { SERVER_TICK_MS, PLAYER, WILDLIFE, DBNO } from '../src/shared/constants/index.ts';
import { EatingSystem, eatRequestFor, EATING } from '../src/server/systems/EatingSystem.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const DT = SERVER_TICK_MS / 1000;
const ticksFor = (s) => Math.round(s / DT);

const IDLE = {
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

function makeEater(label) {
  const sent = [];
  const ws = { readyState: 1, send(raw) { try { sent.push(JSON.parse(raw)); } catch { /* binary */ } }, close() {}, on() {}, once() {}, removeListener() {} };
  const match = new Match({ matchId: `eating-${label}`, botCount: 0 });
  match.state.phase = 'playing';
  const joined = match.addHumanClient(ws, 'Eater');
  const player = match.state.players.find((p) => p.id === joined.playerId);
  const client = match.clients.get(joined.playerId);
  player.state = 'alive';
  player.respawnProtectionTimer = 0;
  player.pocketBanana = 0; player.pocketCoconut = 0; player.pocketMango = 0; player.pocketMeat = 0;
  player.pocketMeatByType = {};
  // No crew larder: every bite here comes out of the pocket.
  const ship = match.state.ships.find((s) => s.id === player.shipId);
  if (ship) ship.inventory = ship.inventory.filter((e) => !['banana', 'coconut', 'mango', 'meat'].includes(e.item));
  let seq = 10;
  const step = (over = {}) => {
    seq += 1;
    client.lastInput = { ...IDLE, seq, ...over };
    match.tick();
    if (player.state === 'swimming') player.state = 'alive';
  };
  const run = (seconds, shape = () => ({})) => { const n = ticksFor(seconds); for (let i = 0; i < n; i += 1) step(shape(i)); };
  const eat = (wheelIndex) => step({ useWheelItem: true, wheelIndex });
  const refusals = () => sent.filter((m) => m.type === 'interact_refused').map((m) => m.payload);
  return { match, player, client, step, run, eat, refusals };
}

console.log('Refused at full health');
{
  const e = makeEater('full');
  e.player.health = PLAYER.MAX_HEALTH;
  e.player.pocketBanana = 2;
  e.eat(4);
  e.run(3);
  expect('eating at 100 HP keeps the banana', e.player.pocketBanana === 2, `pocketBanana=${e.player.pocketBanana}`);
  expect('health stays 100', e.player.health === PLAYER.MAX_HEALTH, `health=${e.player.health}`);
  const r = e.refusals();
  expect("the press is answered: interact_refused {intent:'eat', reason:'health_full'}",
    r.some((p) => p.intent === 'eat' && p.reason === 'health_full'), JSON.stringify(r));
}

console.log('Four bananas from 20 HP: heal over time, one heal at a time');
{
  const e = makeEater('four');
  e.player.health = 20;
  e.player.pocketBanana = 4;
  // Mash the banana slot every tick for 10 s (the worst-case spammer).
  const hp = [];
  for (let i = 0; i < ticksFor(10); i += 1) { e.eat(4); hp.push(e.player.health); }
  const at = (s) => hp[ticksFor(s) - 1];
  expect('no heal inside the 0.9 s bite', at(0.85) === 20, `hp@0.85=${at(0.85)}`);
  expect('<= 60 HP at +2.6 s (was 100: instant +25 per 0.85 s)', at(2.6) <= 60, `hp@2.6=${at(2.6)}`);
  expect('a heal is running at +1.5 s (20 < hp < 40)', at(1.5) > 20 && at(1.5) < 40, `hp@1.5=${at(1.5)}`);
  expect('100 HP at +10 s', Math.abs(at(10) - 100) < 1e-6, `hp@10=${at(10)}`);
  expect('all four bananas eaten, none wasted past full', e.player.pocketBanana === 0, `pocketBanana=${e.player.pocketBanana}`);
  let maxJump = 0;
  for (let i = 1; i < hp.length; i += 1) maxJump = Math.max(maxJump, hp[i] - hp[i - 1]);
  expect('health never jumps (<= 20/1.2 HP/s per tick)', maxJump <= (20 / 1.2) * DT + 1e-6, `max per-tick gain ${maxJump.toFixed(3)}`);
}

console.log('Firing during the bite cancels it without consuming');
{
  const e = makeEater('fire');
  e.player.health = 50;
  e.player.pocketBanana = 1;
  e.eat(4);
  expect('the bite is under way (pocketUseCooldown > 0 is the client signal)', e.player.pocketUseCooldown > 0, `cd=${e.player.pocketUseCooldown}`);
  e.run(0.3);
  e.step({ fire: true });
  e.run(3);
  expect('the banana is kept', e.player.pocketBanana === 1, `pocketBanana=${e.player.pocketBanana}`);
  expect('no heal', e.player.health === 50, `health=${e.player.health}`);
  expect('the eat signal is cleared on cancel', e.player.pocketUseCooldown === 0, `cd=${e.player.pocketUseCooldown}`);
}

console.log('Taking a station cancels; damage does not');
{
  // The station half runs on the EatingSystem itself (a pirate ashore in a bare
  // match cannot hold a station flag: clearStationFlags drops it the same tick),
  // and the Match wiring is pinned by source: interrupt runs after applyInput,
  // outside it, because the station branches return early from applyInput.
  const sys = new EatingSystem();
  const pirate = { id: 'p', health: 50, state: 'alive', atHelm: false, atCannon: false, atCrowNest: false };
  let eaten = 0;
  const bite = () => eatRequestFor('banana', () => { eaten += 1; return true; });
  sys.begin(pirate, bite());
  for (let i = 0; i < 18; i += 1) { sys.tick(pirate, DT); sys.interrupt(pirate, false); }
  pirate.atHelm = true; // took the helm mid-bite
  const cancelled = sys.interrupt(pirate, false);
  for (let i = 0; i < ticksFor(3); i += 1) sys.tick(pirate, DT);
  expect('taking a station mid-bite cancels it and keeps the banana', cancelled && eaten === 0 && pirate.health === 50, `cancelled=${cancelled} eaten=${eaten} hp=${pirate.health}`);
  const atHelm = { id: 'q', health: 50, state: 'alive', atHelm: true, atCannon: false, atCrowNest: false };
  sys.begin(atHelm, bite());
  for (let i = 0; i < ticksFor(3); i += 1) { sys.tick(atHelm, DT); sys.interrupt(atHelm, false); }
  expect('control: a bite STARTED at the helm completes (only taking a station cancels)', eaten === 1 && Math.abs(atHelm.health - 70) < 1e-6, `eaten=${eaten} hp=${atHelm.health}`);
  const src = readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
  expect('Match: eating.interrupt runs in the tick loop right after applyInput',
    /this\.applyInput\(client, client\.lastInput, dt\);[\s\S]{0,800}this\.eating\.interrupt\(eater, !!client\.lastInput\.fire/.test(src));

  const d = makeEater('damage');
  d.player.health = 50;
  d.player.pocketBanana = 1;
  d.eat(4);
  d.run(0.3);
  d.player.health -= 15; // a hit lands mid-bite
  d.run(3);
  expect('a hit mid-bite does not cancel: banana eaten', d.player.pocketBanana === 0, `pocketBanana=${d.player.pocketBanana}`);
  expect('and it heals 20 after the hit (35 -> 55)', Math.abs(d.player.health - 55) < 1e-6, `health=${d.player.health}`);
}

console.log('Meat heals its species value over 2.0 s; fruit 22 over 1.5 s');
{
  const e = makeEater('meat');
  e.player.health = 40;
  e.player.pocketMeat = 1;
  e.player.pocketMeatByType = { pig: 1 };
  e.eat(6);
  e.run(0.9 + 1.0 - DT);
  const mid = e.player.health;
  e.run(2);
  expect('pork mid-heal at +1.9 s is about half its value', Math.abs(mid - (40 + WILDLIFE.MEAT_HEAL.pig / 2)) < 1.5, `hp=${mid}`);
  expect('pork gives its full species value', Math.abs(e.player.health - (40 + WILDLIFE.MEAT_HEAL.pig)) < 1e-6, `hp=${e.player.health}`);

  const f = makeEater('coconut');
  f.player.health = 40;
  f.player.pocketCoconut = 1;
  f.eat(5);
  f.run(0.9 + 0.75 - DT);
  const fm = f.player.health;
  f.run(2);
  expect('coconut half-way at +1.65 s', Math.abs(fm - 51) < 1.5, `hp=${fm}`);
  expect('coconut gives 22', Math.abs(f.player.health - 62) < 1e-6, `hp=${f.player.health}`);
}

console.log('70 % move during the bite');
{
  // Top horizontal ground speed over 0.3-0.8 s of holding W (inside the 0.9 s
  // bite). The top, not the median: a spawn that walks into a rock slows the
  // pirate, never speeds her up, so the max is what the move law allows.
  const speed = (eating) => {
    const e = makeEater('move');
    e.player.health = 30;
    e.player.pocketBanana = 1;
    if (eating) e.step({ useWheelItem: true, wheelIndex: 4, forward: true }); else e.step({ forward: true });
    const v = [];
    for (let i = 1; i < ticksFor(0.8); i += 1) {
      e.step({ forward: true });
      if (i >= ticksFor(0.3)) v.push(Math.hypot(e.player.velocity.x, e.player.velocity.z));
    }
    return Math.max(...v);
  };
  const walk = speed(false);
  const munch = speed(true);
  expect('control: walking reaches full speed', walk > PLAYER.MOVE_SPEED * 0.9, `walk=${walk.toFixed(2)} m/s`);
  expect('eating walk tops out at 70 % of MOVE_SPEED', munch <= PLAYER.MOVE_SPEED * 0.7 + 1e-6 && munch >= PLAYER.MOVE_SPEED * 0.6,
    `eat=${munch.toFixed(2)} walk=${walk.toFixed(2)} MOVE_SPEED=${PLAYER.MOVE_SPEED}`);
}

console.log('Going down ends the bite and the heal (b3-bugs-02)');
{
  // Bite in progress when the pirate is downed: the bite is cancelled, the food is kept,
  // and downed vitality (the finisher's target) never rises.
  const e = makeEater('downed-mid-bite');
  e.player.health = 40;
  e.player.pocketBanana = 1;
  e.eat(4);
  e.step(); e.step();
  e.match.enterDowned(e.player);
  const maxHp = [];
  for (let i = 0; i < ticksFor(2.5); i += 1) { e.step(); maxHp.push(e.player.health); }
  expect('downed mid-bite: still downed', e.player.state === 'downed', `state=${e.player.state}`);
  expect('downed mid-bite: vitality never rises above DBNO.DOWNED_HEALTH', Math.max(...maxHp) <= DBNO.DOWNED_HEALTH + 1e-6,
    `max health while downed=${Math.max(...maxHp)} DOWNED_HEALTH=${DBNO.DOWNED_HEALTH}`);
  expect('downed mid-bite: the banana is kept (cancelled bite never consumes)', e.player.pocketBanana === 1, `pocketBanana=${e.player.pocketBanana}`);
  expect('downed mid-bite: no bite left on the eating system', !e.match.eating.isEating(e.player.id));
}
{
  // Bite finished, heal-over-time still queued, then downed: the queued heal is dropped.
  const e = makeEater('downed-heal-queue');
  e.player.health = 20;
  e.player.pocketMeat = 1;
  e.player.pocketMeatByType = { cooked: 1 };
  e.player.pocketBanana = 1;
  e.eat(4);
  e.run(1.3);
  const owed = e.match.eating.pendingHeal(e.player.id);
  e.match.enterDowned(e.player);
  const hp = [];
  for (let i = 0; i < ticksFor(3); i += 1) { e.step(); hp.push(e.player.health); }
  expect('downed with a heal queued: control, the heal was owed', owed > 0, `pendingHeal=${owed}`);
  expect('downed with a heal queued: vitality never rises above DBNO.DOWNED_HEALTH', Math.max(...hp) <= DBNO.DOWNED_HEALTH + 1e-6,
    `max health while downed=${Math.max(...hp)}`);
  expect('downed with a heal queued: nothing owed any more', e.match.eating.pendingHeal(e.player.id) === 0, `pendingHeal=${e.match.eating.pendingHeal(e.player.id)}`);
  // A downed pirate cannot start a bite either (applyDownedInput never routes eat, and begin refuses).
  e.player.health = DBNO.DOWNED_HEALTH;
  const ok = e.match.eating.begin(e.player, { item: 'banana', heal: 10, over: 1, consume: () => true });
  expect("downed: EatingSystem.begin refuses with 'dead'", !ok && e.match.eating.lastRefusal === 'dead', `ok=${ok} refusal=${e.match.eating.lastRefusal}`);
}

// b3-bugs-04: the local pirate's input lead walks at the same 70 % cap the
// server applies mid-bite, or the drawn body leads the server's by
// (1 - 0.7) * MOVE_SPEED * lead and eases back when the bite ends.
{
  const { predictedWalkSpeed } = await import('../src/client/core/Game.ts');
  for (const crouching of [false, true]) {
    const server = PLAYER.MOVE_SPEED * (crouching ? 0.55 : 1) * EATING.MOVE_SCALE;
    const client = predictedWalkSpeed(PLAYER.MOVE_SPEED, crouching, true);
    expect(`client lead cap mid-bite matches the server (crouching=${crouching})`, Math.abs(client - server) < 1e-9, `client=${client} server=${server}`);
  }
  expect('no bite: the client lead is uncapped', predictedWalkSpeed(PLAYER.MOVE_SPEED, false, false) === PLAYER.MOVE_SPEED);
  expect('a slower hold cap still wins mid-bite', predictedWalkSpeed(1.2, false, true) === 1.2);
}

if (failures > 0) { console.error(`\ntest-eating: ${failures} FAILED`); process.exit(1); }
console.log('\ntest-eating: all passed');
