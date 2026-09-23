#!/usr/bin/env node
// test-truce-integrity (b1.6e, mechanicshud-01 + vm:mechanicshud:1).
//
// "No crew may fire for the first 2:30" was a bot-only promise: humans could
// shoot, cannon and keg anyone from the horn, and two bot sloops leaving
// neighbouring berths at ~4 m/s stove each other in (ram holes on both hulls),
// both foundered around t=55 s and the survivor of the pair banked a 400 g
// sink bounty inside the truce. This gate runs the REAL server Match:
//
//   A. 12 explicitly seeded solo worlds (15 bot crews) to t = TRUCE_SECONDS:
//      0 holes from ram/cannon/keg, 0 founders, 0 sink credits.
//   B. A firearm shot from one crew's pirate into another crew's pirate inside
//      the truce deals 0 and is held for a refusal; the SAME shot after the
//      truce lands (negative control, so B cannot pass vacuously).
//   C. Ship cannons refuse to fire inside the truce (reason 'truce', nothing
//      queued) and fire after it (negative control).
//   D. Solo-bot hole triage: a bot alone on its hull given 2 waterline holes at
//      t=30 has 0 open holes by t=75.
//   E. The contact rule: bot-vs-bot contact inside the truce is a bump at any
//      speed; a human helm still needs < TRUCE_CONTACT_SPEED (controls both ways).
//
//   node --import tsx scripts/test-truce-integrity.mjs      (SEEDS=n to shorten)
const { Match } = await import('../src/server/core/Match.ts');
const { SERVER_TICK_MS, FLOODING } = await import('../src/shared/constants/index.ts');
const { countOpenHoles } = await import('../src/shared/interactions.ts');
const { TRUCE_SECONDS } = await import('../src/shared/truce.ts');

const dt = SERVER_TICK_MS / 1000;
const failures = [];
let checks = 0;
const expect = (ok, label) => { checks += 1; console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}`); if (!ok) failures.push(label); };

function makeMatch(seed, id) {
  process.env.PIRATES_BR_MAP_SEED = String(seed);
  const match = new Match({ matchId: id, botCount: 15, mode: 'solo' });
  match['state'].phase = 'playing';
  return match;
}
const tickTo = (match, t) => { while (match['t'] < t && match['state'].phase !== 'ended') match['tick'](); };

// ── A. seeded worlds ────────────────────────────────────────────────────────
const SEEDS = [20260801, 7, 11, 42, 101, 202, 303, 404, 505, 606, 707, 808].slice(0, Number(process.env.SEEDS ?? 12));
let totalHarm = 0, totalFounders = 0, totalSinkCredits = 0;
for (const seed of SEEDS) {
  const match = makeMatch(seed, `truce-${seed}`);
  const phys = match['physics'];
  const harm = [];
  const openHoleAt = phys.openHoleAt.bind(phys);
  phys.openHoleAt = (ship, point, n, source) => {
    if (match['t'] < TRUCE_SECONDS && (source === 'ram' || source === 'cannon' || source === 'keg')) {
      harm.push(`${source}@${match['t'].toFixed(1)}s ${ship.id.slice(0, 8)}`);
    }
    return openHoleAt(ship, point, n, source);
  };
  let sinkCredits = 0;
  const credit = match['creditShipSink'].bind(match);
  match['creditShipSink'] = (...args) => { if (match['t'] < TRUCE_SECONDS) sinkCredits += 1; return credit(...args); };
  const founders = new Set();
  while (match['t'] < TRUCE_SECONDS && match['state'].phase !== 'ended') {
    match['tick']();
    for (const s of match['state'].ships) if (s.sinking || !s.alive) founders.add(s.id);
  }
  console.log(`seed ${seed}: harm ${harm.length}${harm.length ? ` [${harm.slice(0, 4).join(', ')}]` : ''} founders ${founders.size} sinkCredits ${sinkCredits}`);
  totalHarm += harm.length; totalFounders += founders.size; totalSinkCredits += sinkCredits;
  match.stop?.();
}
expect(totalHarm === 0, `A: 0 holes from ram/cannon/keg before t=${TRUCE_SECONDS}s over ${SEEDS.length} seeds (got ${totalHarm})`);
expect(totalFounders === 0, `A: 0 founders before the truce ends (got ${totalFounders})`);
expect(totalSinkCredits === 0, `A: 0 sink credits (SHIP_SINK_GOLD) inside the truce (got ${totalSinkCredits})`);

// ── B + C. shots inside and after the truce ─────────────────────────────────
{
  const match = makeMatch(20260801, 'truce-shot');
  tickTo(match, 5);
  const players = match['state'].players.filter((p) => p.state !== 'eliminated');
  const shooter = players[0];
  const target = players.find((p) => p.id !== shooter.id && (p.crewId ?? p.shipId) !== (shooter.crewId ?? shooter.shipId));
  const shoot = () => {
    target.health = 100; target.respawnProtectionTimer = 0; target.state = 'alive';
    match['truceHeldShotBy'] = null;
    const chest = { x: target.position.x, y: target.position.y + 1.2, z: target.position.z };
    const origin = { x: chest.x - 2.5, y: chest.y, z: chest.z };
    match['resolveFirearmHits'](shooter, [{
      origin, visualOrigin: origin, direction: { x: 1, y: 0, z: 0 }, range: 10, damage: 40, knockback: 0, weaponId: 'flintknock',
    }]);
    return { dealt: 100 - target.health, held: match['truceHeldShotBy'] === shooter.id };
  };
  const inside = shoot();
  expect(inside.dealt === 0, `B: a shot into another crew's pirate at t=${match['t'].toFixed(1)}s deals 0 (dealt ${inside.dealt})`);
  expect(inside.held, 'B: that shot is held for a truce refusal to the shooter');
  const src = (await import('node:fs')).readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
  expect(/truceHeldShotBy === player\.id \? 'truce'[\s\S]{0,200}sendInteractRefused\(client, 'fire', held\)/.test(src),
    "B: the human fire path sends interact_refused {intent:'fire', reason:'truce'}");

  const weapons = match['weapons'];
  const ship = match['state'].ships.find((s) => s.id === shooter.shipId);
  const gunner = { ...shooter, atCannon: true, cannonIndex: 0 };
  weapons.flushProjectiles();
  weapons.tryFire(gunner, ship, 0, 0, 0);
  const coldQueued = weapons.flushProjectiles().length;
  expect(coldQueued === 0 && weapons.lastRefusal === 'truce', `C: a ship cannon inside the truce is refused (queued ${coldQueued}, reason ${weapons.lastRefusal})`);

  match['t'] = TRUCE_SECONDS + 1;
  const after = shoot();
  expect(after.dealt > 0 && !after.held, `B control: the same shot after the truce lands (dealt ${after.dealt})`);
  for (const c of ship.cannons ?? []) if (c && typeof c === 'object' && 'cooldown' in c) c.cooldown = 0;
  weapons.tryFire(gunner, ship, 0, 0, 0);
  const hotQueued = weapons.flushProjectiles().length;
  expect(hotQueued > 0, `C control: the same cannon fires after the truce (queued ${hotQueued}, reason ${weapons.lastRefusal})`);
  match.stop?.();
}

// ── D. solo-bot hole triage ─────────────────────────────────────────────────
{
  const match = makeMatch(20260801, 'truce-triage');
  tickTo(match, 30);
  const phys = match['physics'];
  const ship = match['state'].ships.find((s) => s.alive && !s.sinking
    && match['state'].players.filter((p) => p.shipId === s.id && p.isBot).length === 1);
  const bandY = (FLOODING.HOLE_BAND_Y.min + FLOODING.HOLE_BAND_Y.max) * 0.5;
  phys.openHoleAt(ship, phys.hullFacePoint(ship, { x: 1, z: 2 }, bandY, 0.8), 1, 'rock');
  phys.openHoleAt(ship, phys.hullFacePoint(ship, { x: -1, z: -3 }, bandY, 0.8), 1, 'rock');
  const given = countOpenHoles(ship);
  tickTo(match, 75);
  const left = countOpenHoles(ship);
  expect(given >= 2, `D: the solo bot's hull was given 2 waterline holes at t=30 (open ${given})`);
  expect(left === 0 && ship.alive, `D: 0 open holes by t=75 (open ${left}, alive ${ship.alive})`);
  match.stop?.();
}

// ── E. the contact rule (b1.6e2): bot-vs-bot contact inside the truce is a
// bump at ANY speed (seed 42 closed at >= 6 m/s leaving neighbouring berths);
// a HUMAN at either helm still needs < TRUCE_CONTACT_SPEED; after the truce
// every contact counts (negative controls, so E cannot pass vacuously).
{
  const { truceSparesContact, TRUCE_CONTACT_SPEED } = await import('../src/shared/truce.ts');
  const fast = TRUCE_CONTACT_SPEED + 3, slow = TRUCE_CONTACT_SPEED - 2, mid = TRUCE_SECONDS * 0.4;
  expect(truceSparesContact(mid, fast, false), `E: bot-vs-bot contact at ${fast} m/s inside the truce is a bump`);
  expect(truceSparesContact(mid, slow, true), `E: human-helmed contact at ${slow} m/s inside the truce is a bump`);
  expect(!truceSparesContact(mid, fast, true), `E control: human-helmed contact at ${fast} m/s inside the truce still breaches`);
  expect(!truceSparesContact(TRUCE_SECONDS + 1, fast, false), `E control: bot-vs-bot contact at ${fast} m/s after the truce breaches`);
  expect(truceSparesContact(mid, fast) === false, 'E: no helm info defaults to human-helmed (fail closed toward the old rule)');
  const { readFileSync } = await import('node:fs');
  const physSrc = readFileSync(new URL('../src/server/systems/PhysicsSystem.ts', import.meta.url), 'utf8');
  expect(/if \(!player\.isBot\) humanHelmShipIds\.add/.test(physSrc)
    && /truceSparesContact\(t, relSpd, humanAtEitherHelm\)/.test(physSrc),
    'E wiring: PhysicsSystem feeds human-helm truth into truceSparesContact');
}

console.log(`\ntest-truce-integrity: ${checks} checks, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
