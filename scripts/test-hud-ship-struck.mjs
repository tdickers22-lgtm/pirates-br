#!/usr/bin/env node
// A HULL UNDER FIRE SAYS WHO, WHICH SIDE, AND HOW BAD.
//
//  • liveplay-21 — the live rig put fifteen cannonballs into a moored hull and
//    `hud.hit` never fired once. The crew being shelled got no who, no where and
//    no shudder; the only 'ship_hit' on the wire was the ATTACKER's hit-confirm.
//    Wave 1.5 added the defender-facing copy (Match.notifyCrewUnderFire, marked
//    `incoming`); this gate covers the client half that reads it.
//  • The regression that copy created on its own: the client's onShipHit ran
//    handleCombatHit unconditionally, so the crew being shot at was shown the
//    ATTACKER's hitmarker, kill chime and ship-hit-confirm splinters for a ball
//    that had just holed their own hull. `incoming` must divert.
//  • hud-23 — "X is firing on you" is a feed line, and a broadside is ~8 balls:
//    it is throttled per attacker, not printed per ball.
//
// Every rule is a pure function on the module surface: no DOM, no stack.
import {
  hullStruckLine, shouldAnnounceUnderFire, attackerMarkPlacement, UNDER_FIRE_ANNOUNCE_MS,
} from '../src/client/ui/HudController.ts';
import { isIncomingShipHit, hullShudderTrauma } from '../src/client/core/Game.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

console.log('\nThe defender is not shown the attacker’s hitmarker');
expect('a defender-facing ship_hit is diverted off the hit-confirm path',
  isIncomingShipHit({ incoming: true, attackerId: 'vex', damage: 12 }) === true);
expect('the attacker’s own hit-confirm still takes the hit-confirm path',
  isIncomingShipHit({ damage: 12, targetId: 'ship-2' }) === false);
expect('a malformed payload is not treated as incoming',
  isIncomingShipHit(null) === false && isIncomingShipHit(undefined) === false
  && isIncomingShipHit({ incoming: false }) === false);

console.log('\nHULL STRUCK names the crew and the face');
expect('the PLAN line, verbatim',
  hullStruckLine({ attackerCrew: "Vex's sloop", side: 'starboard', topside: false, openedBreach: false })
    === "HULL STRUCK · Vex's sloop · STARBOARD",
  hullStruckLine({ attackerCrew: "Vex's sloop", side: 'starboard', topside: false, openedBreach: false }));
expect('a ball that opened a breach says so',
  hullStruckLine({ attackerCrew: "Vex's sloop", side: 'port', topside: false, openedBreach: true })
    === "HULL STRUCK · Vex's sloop · PORT · BREACH");
expect('a topside hit reads TOPSIDE, not a face',
  hullStruckLine({ attackerCrew: 'Roke’s galleon', side: 'bow', topside: true, openedBreach: false })
    === 'HULL STRUCK · Roke’s galleon · TOPSIDE');
expect('an unseen gun still gets a line (the storm and the shore fire too)',
  hullStruckLine({ attackerCrew: null, side: 'stern', topside: false, openedBreach: false })
    === 'HULL STRUCK · unseen guns · STERN');
for (const side of ['port', 'starboard', 'bow', 'stern']) {
  const line = hullStruckLine({ attackerCrew: 'A', side, topside: false, openedBreach: false });
  expect(`${side} produces a named face`, line.includes(side.toUpperCase()), line);
}

console.log('\n"X is firing on you" is throttled per attacker, not per ball');
expect('the first ball of a broadside announces', shouldAnnounceUnderFire(null, "Vex's sloop", 1000) === true);
expect('the next seven balls do not',
  shouldAnnounceUnderFire({ crew: "Vex's sloop", at: 1000 }, "Vex's sloop", 1600) === false);
expect('a SECOND crew opening up announces immediately',
  shouldAnnounceUnderFire({ crew: "Vex's sloop", at: 1000 }, "Roke's galleon", 1600) === true);
expect('the same crew re-engaging after the window announces again',
  shouldAnnounceUnderFire({ crew: "Vex's sloop", at: 1000 }, "Vex's sloop", 1000 + UNDER_FIRE_ANNOUNCE_MS) === true);
expect('the window is 20 s', UNDER_FIRE_ANNOUNCE_MS === 20000, String(UNDER_FIRE_ANNOUNCE_MS));

console.log('\nThe compass arc points at the guns');
// Player at the origin looking north (heading 0); attacker due east.
const east = attackerMarkPlacement(0, 0, 100, 0, 0);
expect('due east reads 90° bearing, +90° off the bow',
  Math.abs(east.bearing - 90) < 1e-6 && Math.abs(east.delta - 90) < 1e-6, JSON.stringify(east));
expect('and 100 m out', Math.abs(east.metres - 100) < 1e-6, String(east.metres));
// Same attacker, but the hull has come about to face east: the mark centres.
const comeAbout = attackerMarkPlacement(0, 0, 100, 0, 90);
expect('turning onto the guns centres the mark', Math.abs(comeAbout.delta) < 1e-6, JSON.stringify(comeAbout));
// Astern must read as a SHORT turn to port, never +190.
const astern = attackerMarkPlacement(0, 0, -10, -100, 10);
expect('a chaser astern reads a short signed turn, never a 190° one',
  astern.delta >= -180 && astern.delta < 180 && Math.abs(astern.delta) > 150, JSON.stringify(astern));
for (let h = 0; h < 360; h += 17) {
  for (let b = 0; b < 360; b += 23) {
    const rad = (b * Math.PI) / 180;
    const p = attackerMarkPlacement(0, 0, Math.sin(rad) * 50, Math.cos(rad) * 50, h);
    if (!(p.delta >= -180 && p.delta < 180)) {
      expect(`delta stays in [-180,180) for heading ${h} bearing ${b}`, false, JSON.stringify(p));
    }
  }
}
expect('delta is wrapped for every heading × bearing pair', true);

console.log('\nThe shudder scales with the damage, and is bounded');
expect('a graze shudders less than a broadside that opened four leaks',
  hullShudderTrauma(0) < hullShudderTrauma(4), `${hullShudderTrauma(0)} vs ${hullShudderTrauma(4)}`);
expect('a hit always shudders at least a little', hullShudderTrauma(0) > 0, String(hullShudderTrauma(0)));
expect('and a hull holed to the cap does not throw the camera',
  hullShudderTrauma(8) <= 0.6, String(hullShudderTrauma(8)));
expect('the ramp is monotonic',
  [0, 1, 2, 3, 4, 5, 6, 7, 8].every((n, i, a) => i === 0 || hullShudderTrauma(n) >= hullShudderTrauma(a[i - 1])));

console.log(failures === 0
  ? '\nPASS a hull under fire says who and where'
  : `\nFAIL a hull under fire says who and where (${failures})`);
process.exit(failures === 0 ? 0 : 1);
