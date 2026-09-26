#!/usr/bin/env node
// test-cannon-ammo (b3.5b, mechanicshud-08, D20).
//
// Before: chainshot selected with none left fired a FIREBOMB (130 g) ahead of
// a cannonball (30 g), and a truly empty rack was a silent dead trigger. D20:
// the selected type is loaded when stocked; when it is out, the CHEAPEST
// stocked type goes in (ball, then chainshot, then firebomb) with a dry click
// + prompt ('cannon_loaded' {fallback:true}); every rack empty = a refusal
// with text and no projectile. A banked super shot is a ball-only upgrade.
//
//   node --import tsx scripts/test-cannon-ammo.mjs
import { SHOP_PRICES } from '../src/shared/constants/index.ts';
import { DT, ticksFor, makeExpect, seatedGunner, stock } from './lib/cannon-test-kit.mjs';
import { WeaponSystem, CANNON_LOAD_SECONDS, CANNON_FALLBACK_ORDER, cannonLoadState, load, autoLoadManned } from './lib/cannon-test-kit.mjs';

const { expect, failures } = makeExpect();

/** Load gun 0 with `selected` from `inventory`, wait it out, fire; report. */
function loadAndFire(inventory, selected, over = {}) {
  const g = seatedGunner(`ammo-${selected}-${Math.random().toString(36).slice(2, 7)}`, inventory);
  Object.assign(g.player, { selectedCannonAmmo: selected, autoLoadCannons: false }, over);
  const weapons = new WeaponSystem();
  const started = load(weapons, g.player, g.ship, 0);
  const rec = weapons.lastLoad;
  const refusal = weapons.lastRefusal;
  for (let i = 0; i < ticksFor(CANNON_LOAD_SECONDS + 0.05); i += 1) weapons.tickCannons(DT, [g.ship]);
  weapons.tryFire(g.player, g.ship, 0, 0, 0);
  const shots = weapons.flushProjectiles();
  return { g, weapons, started, load: rec, refusal, shots, fireRefusal: weapons.lastRefusal };
}

console.log('0. Price order backs the fallback order');
{
  const price = { cannonball: SHOP_PRICES?.cannonball, chainshot: SHOP_PRICES?.chainshot, firebomb: SHOP_PRICES?.firebomb ?? SHOP_PRICES?.firebomb_ball };
  const known = Object.values(price).every((v) => typeof v === 'number');
  expect('CANNON_FALLBACK_ORDER = cannonball, chainshot, firebomb', CANNON_FALLBACK_ORDER.join(',') === 'cannonball,chainshot,firebomb');
  if (known) expect('and it is cheapest-first by SHOP_PRICES', price.cannonball < price.chainshot && price.chainshot < price.firebomb, JSON.stringify(price));
  else console.log(`  (SHOP_PRICES keys differ: ${JSON.stringify(price)}; order pinned above)`);
}

console.log('1. {firebomb:1, ball:0, chain:0}, ball selected');
{
  const r = loadAndFire([{ item: 'firebomb_ball', qty: 1 }], 'cannonball');
  expect('nothing cheaper is stocked, so the firebomb goes in', r.started && r.load?.shot === 'firebomb' && r.load.fallback === true, JSON.stringify(r.load));
  expect('it fires as a firebomb', r.shots.length === 1 && r.shots[0].type === 'firebomb');
  expect('the firebomb left the stores', stock(r.g.ship, 'firebomb_ball') === 0);
}

console.log('2. The firebomb is used ONLY if nothing cheaper is stocked');
{
  const r = loadAndFire([{ item: 'firebomb_ball', qty: 1 }, { item: 'chainshot', qty: 1 }], 'cannonball');
  expect('{firebomb:1, chain:1}, ball selected -> chainshot (90 g) before the firebomb (130 g)', r.load?.shot === 'chainshot' && r.shots[0]?.type === 'chainshot', JSON.stringify(r.load));
  expect('the firebomb is still in stores', stock(r.g.ship, 'firebomb_ball') === 1);
  const c = loadAndFire([{ item: 'firebomb_ball', qty: 1 }, { item: 'cannonball', qty: 1 }], 'chainshot');
  expect('{firebomb:1, ball:1}, chainshot selected -> the ball (the old path fired the firebomb)', c.load?.shot === 'cannonball' && c.shots[0]?.type === 'cannonball', JSON.stringify(c.load));
  expect('firebomb kept', stock(c.g.ship, 'firebomb_ball') === 1);
}

console.log('3. The selected type when it is stocked');
{
  for (const [sel, item] of [['cannonball', 'cannonball'], ['chainshot', 'chainshot'], ['firebomb', 'firebomb_ball']]) {
    const r = loadAndFire([{ item: 'cannonball', qty: 2 }, { item: 'chainshot', qty: 2 }, { item: 'firebomb_ball', qty: 2 }], sel);
    expect(`${sel} selected and stocked -> ${sel}, no fallback`, r.load?.shot === sel && r.load.fallback === false && r.shots[0]?.type === sel && stock(r.g.ship, item) === 1, JSON.stringify(r.load));
  }
}

console.log('4. Every rack empty: a refusal, no projectile');
{
  const r = loadAndFire([], 'cannonball');
  expect("R: no load, lastRefusal 'no_ammo'", r.started === false && r.refusal === 'no_ammo');
  expect('the trigger after it spawns nothing', r.shots.length === 0 && cannonLoadState(r.g.ship, 0) === 'empty');
  const a = loadAndFire([], 'chainshot', { autoLoadCannons: true });
  expect("auto-loader trigger on the empty gun: no projectile, lastRefusal 'no_ammo'", a.shots.length === 0 && a.fireRefusal === 'no_ammo', `fireRefusal=${a.fireRefusal}`);
}

console.log('5. Super shot stays a ball-only upgrade');
{
  const s = loadAndFire([], 'cannonball', { superCannonballs: 1 });
  expect('ball selected, empty stores, one banked super -> super cannonball', s.shots[0]?.special === 'super_cannonball' && s.g.player.superCannonballs === 0);
  const c = loadAndFire([], 'chainshot', { superCannonballs: 1 });
  expect('chainshot selected with only a super banked -> refused, super kept', c.started === false && c.refusal === 'no_ammo' && c.g.player.superCannonballs === 1);
}

console.log('6. Through the real Match: the dry click + prompt, and the empty-rack refusal');
{
  const g = seatedGunner('fallback', [{ item: 'cannonball', qty: 1 }]);
  g.step({ cannonAmmo: 'firebomb' });
  g.step({ reload: true });
  const loaded = g.msgs('cannon_loaded');
  expect("firebomb selected, only a ball: cannon_loaded {selected:'firebomb', shot:'cannonball', fallback:true}",
    loaded.length === 1 && loaded[0].selected === 'firebomb' && loaded[0].shot === 'cannonball' && loaded[0].fallback === true, JSON.stringify(loaded));
  const e = seatedGunner('empty', []);
  e.step({ reload: true });
  const ref = e.msgs('interact_refused');
  expect("R with every rack empty: interact_refused {intent:'reload', reason:'no_ammo'}", ref.some((p) => p.intent === 'reload' && p.reason === 'no_ammo'), JSON.stringify(ref));
  expect('and nothing was loaded', cannonLoadState(e.ship, 0) === 'empty');
}

if (failures() > 0) { console.error(`\ntest-cannon-ammo: ${failures()} FAIL`); process.exit(1); }
console.log('\ntest-cannon-ammo: all green');
