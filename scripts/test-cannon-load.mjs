#!/usr/bin/env node
// test-cannon-load (b3.5b, mechanicshud-10, D20).
//
// Cannons were auto-loaders: any pirate could walk up and fire every 3.5 s,
// the ball taken from stores at fire time. D20: each gun has a LOADED state on
// the wire; R / gamepad X / touch Load rams a shot in 1.6 s; the trigger fires
// only a loaded gun and empties it; a loaded gun stays loaded when its gunner
// walks away; "Auto-load cannons" keeps today's one-button 3.5 s cadence; bots
// load through the same path.
//
//   node --import tsx scripts/test-cannon-load.mjs
import { readFileSync } from 'node:fs';
import { sanitizePlayerInput } from '../src/server/net/validate.ts';
import { SHIP } from '../src/shared/constants/index.ts';
import { DT, ticksFor, IDLE, makeExpect, seatedGunner, stock } from './lib/cannon-test-kit.mjs';
import { WeaponSystem, CANNON_LOAD_SECONDS, cannonLoadState, load, autoLoadManned } from './lib/cannon-test-kit.mjs';

const { expect, failures } = makeExpect();

/** Unit rig: the real hull from a Match, a WeaponSystem with no truce clock. */
function rig(inventory = [{ item: 'cannonball', qty: 20 }], over = {}) {
  const g = seatedGunner(`unit-${Math.random().toString(36).slice(2, 7)}`, inventory);
  const weapons = new WeaponSystem();
  Object.assign(g.player, over);
  const fire = () => { weapons.tryFire(g.player, g.ship, 0, 0, 0); return weapons.flushProjectiles(); };
  const tick = (s) => { for (let i = 0; i < ticksFor(s); i += 1) weapons.tickCannons(DT, [g.ship]); };
  return { ...g, weapons, fire, tick };
}

console.log('1. An empty gun does not fire');
{
  const r = rig();
  const shots = r.fire();
  expect('fire on an unloaded gun spawns nothing', shots.length === 0, `shots=${shots.length}`);
  expect("the trigger is a dry click that names the load: lastRefusal 'unloaded'", r.weapons.lastRefusal === 'unloaded', `lastRefusal=${r.weapons.lastRefusal}`);
  expect('no ball left the stores', stock(r.ship, 'cannonball') === 20, `balls=${stock(r.ship, 'cannonball')}`);
  expect('the barrel cooldown did not start', r.ship.cannonCooldowns[0] === 0, `cd=${r.ship.cannonCooldowns[0]}`);
}

console.log('2. The 1.6 s load');
{
  const r = rig();
  expect('CANNON_LOAD_SECONDS is 1.6', CANNON_LOAD_SECONDS === 1.6);
  expect('R rams a shot', load(r.weapons, r.player, r.ship, 0) === true);
  expect('the ball comes out of the stores as it goes in', stock(r.ship, 'cannonball') === 19);
  expect("state 'loading' on the wire", cannonLoadState(r.ship, 0) === 'loading' && r.ship.cannonLoaded[0] === 'cannonball');
  expect('a second R while loading is ignored (no double debit)', load(r.weapons, r.player, r.ship, 0) === false && stock(r.ship, 'cannonball') === 19);
  r.tick(1.5);
  expect('still loading at 1.5 s: fire spawns nothing', r.fire().length === 0 && cannonLoadState(r.ship, 0) === 'loading');
  r.tick(0.12);
  expect("loaded at 1.6 s: cannonLoaded[0] = 'cannonball', cannonLoadLeft[0] = 0",
    cannonLoadState(r.ship, 0) === 'loaded' && r.ship.cannonLoadLeft[0] === 0, JSON.stringify([r.ship.cannonLoaded, r.ship.cannonLoadLeft]));
  const shots = r.fire();
  expect('fire spawns exactly one cannonball', shots.length === 1 && shots[0].type === 'cannonball', JSON.stringify(shots.map((p) => p.type)));
  expect('fire empties the gun', cannonLoadState(r.ship, 0) === 'empty' && r.ship.cannonLoaded[0] === null);
  expect('firing takes nothing more from the stores', stock(r.ship, 'cannonball') === 19);
  expect('barrel cooldown = SHIP.CANNON_RELOAD', r.ship.cannonCooldowns[0] === SHIP.CANNON_RELOAD);
  expect('manual gunner: nothing re-loads itself', (r.tick(5), cannonLoadState(r.ship, 0) === 'empty'));
}

console.log('3. A loaded gun stays loaded when you leave');
{
  const r = rig();
  load(r.weapons, r.player, r.ship, 0);
  r.tick(0.4);
  r.player.atCannon = false;                     // walks off mid-load
  r.tick(20);
  expect('the load finishes without its loader and stays loaded 20 s later', cannonLoadState(r.ship, 0) === 'loaded');
  const mate = { ...r.player, id: 'mate', atCannon: true, cannonIndex: 0, autoLoadCannons: false };
  r.weapons.tryFire(mate, r.ship, 0, 0, 0);
  const shots = r.weapons.flushProjectiles();
  expect('a crewmate who re-enters fires the pre-loaded ball', shots.length === 1 && shots[0].ownerId === 'mate');
}

console.log("4. Auto-load reproduces today's one-button cadence");
{
  const r = rig([{ item: 'cannonball', qty: 40 }], { autoLoadCannons: true });
  const shotAt = [];
  const n = ticksFor(20);
  for (let i = 0; i < n; i += 1) {
    autoLoadManned(r.weapons, r.player, r.ship);
    if (r.fire().length > 0) shotAt.push(i * DT);
    r.weapons.tickCannons(DT, [r.ship]);
  }
  const gaps = shotAt.slice(1).map((t, i) => t - shotAt[i]);
  expect('first shot one load after sitting down (1.6 s +- 0.1)', Math.abs(shotAt[0] - CANNON_LOAD_SECONDS) <= 0.1, `first=${shotAt[0]?.toFixed(3)}`);
  expect(`held trigger: every gap within 0.2 s of today's ${SHIP.CANNON_RELOAD} s`, gaps.length >= 4 && gaps.every((g) => Math.abs(g - SHIP.CANNON_RELOAD) <= 0.2), gaps.map((g) => g.toFixed(3)).join(','));
  expect('one ball per shot plus the one in the barrel', stock(r.ship, 'cannonball') === 40 - shotAt.length - (cannonLoadState(r.ship, 0) === 'empty' ? 0 : 1), `balls=${stock(r.ship, 'cannonball')} shots=${shotAt.length}`);
}

console.log('5. Bots load through the same path');
{
  const r = rig([{ item: 'cannonball', qty: 5 }], { isBot: true, autoLoadCannons: undefined });
  const before = r.ship.cannonCooldowns[0];
  expect('a bot trigger on an empty gun spawns nothing', r.fire().length === 0);
  expect('...but starts the 1.6 s load (no refusal, cooldown unchanged)', cannonLoadState(r.ship, 0) === 'loading' && r.weapons.lastRefusal === null && r.ship.cannonCooldowns[0] === before);
  r.tick(CANNON_LOAD_SECONDS + 0.05);
  expect('the loaded bot gun fires', r.fire().length === 1);
  expect('and the bot rams the next one straight away', cannonLoadState(r.ship, 0) === 'loading');
}

console.log('6. Through the real Match: R at a gun, the dry trigger, the wire');
{
  const g = seatedGunner('match', [{ item: 'cannonball', qty: 3 }]);
  g.pastTruce();
  g.step({ fire: true });
  const dry = g.msgs('interact_refused');
  expect("fire on the empty gun is answered {intent:'fire', reason:'unloaded'}", dry.some((p) => p.intent === 'fire' && p.reason === 'unloaded'), JSON.stringify(dry));
  expect('and no projectile flew', g.match.state.projectiles.filter((p) => p.ownerId === g.player.id).length === 0);
  g.step({ reload: true });
  const loaded = g.msgs('cannon_loaded');
  expect("R at the gun rams one: cannon_loaded {shot:'cannonball', fallback:false}", loaded.length === 1 && loaded[0].shot === 'cannonball' && loaded[0].fallback === false && loaded[0].cannonIndex === 0, JSON.stringify(loaded));
  expect('R at a gun does not touch the handgun reload', g.player.weapons.every((w) => !w || !w.reloading));
  g.run(CANNON_LOAD_SECONDS + 0.1);
  expect('the snapshot hull carries cannonLoaded / cannonLoadLeft', Array.isArray(g.ship.cannonLoaded) && g.ship.cannonLoaded.length === g.ship.cannonCooldowns.length && Array.isArray(g.ship.cannonLoadLeft));
  expect("loaded on the server after 1.6 s", cannonLoadState(g.ship, 0) === 'loaded');
  const before = g.match.state.projectiles.length;
  g.step({ fire: true });
  expect('the trigger now fires it', g.match.state.projectiles.length > before || cannonLoadState(g.ship, 0) === 'empty');
  expect('and the gun is empty again', cannonLoadState(g.ship, 0) === 'empty');
  // auto-load setting rides the input
  g.step({ autoLoadCannons: true });
  expect('PlayerInput.autoLoadCannons sets the pirate setting', g.player.autoLoadCannons === true);
  g.run(0.2);
  expect('an auto-loader seated at the empty gun starts loading on its own', cannonLoadState(g.ship, 0) !== 'empty');
  const wire = sanitizePlayerInput({ ...IDLE, seq: 3, autoLoadCannons: true });
  const wireOff = sanitizePlayerInput({ ...IDLE, seq: 3, autoLoadCannons: 'yes' });
  expect('the validator keeps a boolean autoLoadCannons and drops junk', wire?.autoLoadCannons === true && wireOff && !('autoLoadCannons' in wireOff));
}

console.log('7. Source pins');
{
  const ws = readFileSync(new URL('../src/server/systems/WeaponSystem.ts', import.meta.url), 'utf8');
  expect('ammo is debited in loadCannon, not at fire time', /loadCannon\(player: Player, ship: Ship/.test(ws) && !/usedIdx/.test(ws));
}

if (failures() > 0) { console.error(`\ntest-cannon-load: ${failures()} FAIL`); process.exit(1); }
console.log('\ntest-cannon-load: all green');
