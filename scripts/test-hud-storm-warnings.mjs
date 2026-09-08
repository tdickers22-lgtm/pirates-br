#!/usr/bin/env node
// TWO ALARMS, TWO LINES — AND A BEARING OUT.
//
//  • hud-04/liveplay-07 — one element carried three unrelated warnings with a
//    fixed priority, so the moment the storm holed the hull to six leaks the
//    only line that named the CAUSE vanished: "SHIP CRITICAL - REPAIR NOW" with
//    no mention of the weather doing it. And a crew ashore inside the ring whose
//    moored hull was outside it was told nothing at all.
//  • storm-09 — "OUTSIDE STORM ZONE" is not steerable. No bearing to the ring,
//    no distance to the wall, no ETA; the compass tape carried a bounty marker
//    and nothing for the storm.
//
// Both fixes are pure functions so this gate needs no DOM, no browser, no stack.
import { warningLines, stormMarkerPlacement, sailCanvasState, SAIL_REEF_WARN_RATIO } from '../src/client/ui/HudController.ts';
import {
  STORM_GUST_BLOWOUT_DEPLOYMENT,
  STORM_GUST_BLOWOUT_PULSE,
  STORM_GUST_BLOWOUT_SAIL_HEIGHT,
  STORM_GUST_BLOWOUT_SECONDS,
} from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

console.log('\nThe storm line and the ship alarm never multiplex');
// The liveplay-07 state exactly: player past the ring AND her hull holed to six.
const both = warningLines({
  outsideStorm: true, shipMetresOutside: null,
  shipSinking: false, shipCritical: true, shipOnFire: false,
});
expect('outside the ring with a critical hull → BOTH lines',
  both.storm === 'OUTSIDE STORM ZONE' && both.ship === 'SHIP CRITICAL - REPAIR NOW',
  JSON.stringify(both));

const burning = warningLines({
  outsideStorm: true, shipMetresOutside: null,
  shipSinking: false, shipCritical: false, shipOnFire: true,
});
expect('outside the ring with a burning hull → BOTH lines',
  burning.storm === 'OUTSIDE STORM ZONE' && burning.ship === 'FIRE ABOARD - REPAIR TO DOUSE IT',
  JSON.stringify(burning));

const sinking = warningLines({
  outsideStorm: true, shipMetresOutside: null,
  shipSinking: true, shipCritical: true, shipOnFire: true,
});
expect('sinking outranks fire and critical, and still leaves the storm line',
  sinking.storm === 'OUTSIDE STORM ZONE' && sinking.ship === 'SHIP IS SINKING', JSON.stringify(sinking));

console.log('\nA hull left behind the ring says so, in metres');
const ashore = warningLines({
  outsideStorm: false, shipMetresOutside: 214.4,
  shipSinking: false, shipCritical: true, shipOnFire: false,
});
expect('ashore inside the ring, hull 214 m outside → named and measured',
  ashore.storm === 'YOUR SHIP IS OUTSIDE THE RING · 214 m' && ashore.ship === 'SHIP CRITICAL - REPAIR NOW',
  JSON.stringify(ashore));
const quiet = warningLines({
  outsideStorm: false, shipMetresOutside: -80,
  shipSinking: false, shipCritical: false, shipOnFire: false,
});
expect('everything inside and sound → no lines at all',
  quiet.storm === null && quiet.ship === null, JSON.stringify(quiet));
expect('the player’s own position wins the storm line over her hull’s',
  warningLines({ outsideStorm: true, shipMetresOutside: 300, shipSinking: false, shipCritical: false, shipOnFire: false })
    .storm === 'OUTSIDE STORM ZONE');

console.log('\nThe compass knows which way the ring is and when the wall arrives');
const storm = {
  centerX: 0, centerZ: 0, safeRadius: 500,
  nextRadius: 300, shrinking: true, shrinkDuration: 60, shrinkProgress: 0,
};
// Due north of the player: the ring's centre is at +z, so bearing 0.
let m = stormMarkerPlacement(0, -700, 0, storm);
expect('centre due north → bearing 0 ±3°', Math.abs(m.bearing) <= 3, `bearing ${m.bearing}`);
expect('700 m out from a 500 m ring → 200 m to the wall',
  Math.abs(m.wallMetres - 200) < 0.5 && m.outside === true, JSON.stringify(m));
expect('outside, so no "the wall reaches you" ETA — you reach IT', m.etaSeconds === null);

// Centre due east (+x) while the player faces north: turn 90° to starboard.
m = stormMarkerPlacement(-700, 0, 0, storm);
expect('centre due east → bearing 90 ±3°', Math.abs(m.bearing - 90) <= 3, `bearing ${m.bearing}`);
// …and the same geometry with the player already heading east reads as no turn.
m = stormMarkerPlacement(-700, 0, 90, storm);
expect('heading at it → delta 0 ±3°', Math.abs(m.delta) <= 3, `delta ${m.delta}`);
// Behind you: the chevron must say "keep turning", not "straight ahead".
m = stormMarkerPlacement(0, -700, 180, storm);
expect('ring dead astern → |delta| 180 ±3°', Math.abs(Math.abs(m.delta) - 180) <= 3, `delta ${m.delta}`);

// Inside a closing ring: the wall sweeps 500 → 300 over 60 s, and a hull 400 m
// out is exactly half way through that sweep.
m = stormMarkerPlacement(0, 400, 0, storm);
expect('inside a closing ring, 100 m to the wall', Math.abs(m.wallMetres - 100) < 0.5 && m.outside === false);
expect('and the wall reaches her in 30 s', m.etaSeconds !== null && Math.abs(m.etaSeconds - 30) < 0.5,
  `eta ${m.etaSeconds}`);
m = stormMarkerPlacement(0, 200, 0, { ...storm, shrinking: true });
expect('a hull already inside the NEXT ring is never reached by this wall', m.etaSeconds === null);
m = stormMarkerPlacement(0, 400, 0, { ...storm, shrinking: false });
expect('a ring that is not moving has no ETA', m.etaSeconds === null);

// ── THE SAIL BLOW-OUT HAS A TELL (storm-07, review-8 P1) ────────────────────
//
// PhysicsSystem holds a hull's canvas at 30 % for 20 s when she carries full
// sail through a squall for two seconds. It shipped with no client half at all:
// `sailBlownOutUntil` appeared nowhere under src/client, so the bar stuck, the
// hull slowed, and the HUD said "Sails 30% out" as though the crew had asked
// for it. The warning must also beat the 2 s dwell, or it is a post-mortem.
console.log('\nThe squall says what it is about to do, then what it did');
const squall = {
  sailHeight: 1, sailIntegrity: 1, chainshotted: false, anchored: false,
  gustPulse: STORM_GUST_BLOWOUT_PULSE, tailwind: 4, blownOutRemaining: 0,
};
{
  const warned = sailCanvasState(squall);
  expect('full canvas in a following squall → REEF SAILS before it tears',
    warned.alarm === 'REEF SAILS - THE GUST WILL TEAR THEM' && !warned.blownOut,
    JSON.stringify(warned));
  expect('and the warning starts BELOW the pulse that tears it (it beats the dwell)',
    SAIL_REEF_WARN_RATIO < 1
    && sailCanvasState({ ...squall, gustPulse: STORM_GUST_BLOWOUT_PULSE * SAIL_REEF_WARN_RATIO }).alarm !== null,
    `ratio ${SAIL_REEF_WARN_RATIO}`);
  const reefed = sailCanvasState({ ...squall, sailHeight: STORM_GUST_BLOWOUT_DEPLOYMENT - 0.05 });
  expect('a crew that already shortened sail is not shouted at',
    reefed.alarm === null, JSON.stringify(reefed));
  expect('nor is a hull at anchor, or one running with the gale astern of her',
    sailCanvasState({ ...squall, anchored: true }).alarm === null
    && sailCanvasState({ ...squall, tailwind: 0 }).alarm === null);
  expect('fair weather says nothing at all',
    sailCanvasState({ ...squall, gustPulse: 1.0 }).alarm === null);
}
{
  const blown = sailCanvasState({
    ...squall,
    sailHeight: STORM_GUST_BLOWOUT_SAIL_HEIGHT,
    blownOutRemaining: STORM_GUST_BLOWOUT_SECONDS - 3,
  });
  expect('while the canvas is blown out the card names it, with the clock',
    blown.blownOut && blown.canvas.includes('CANVAS BLOWN OUT') && blown.canvas.includes('17'),
    JSON.stringify(blown));
  expect('and the alarm stack carries it, under sinking / critical / fire',
    warningLines({
      outsideStorm: false, shipMetresOutside: null, shipSinking: false,
      shipCritical: false, shipOnFire: false, sailAlarm: blown.alarm,
    }).ship === blown.alarm
    && warningLines({
      outsideStorm: false, shipMetresOutside: null, shipSinking: true,
      shipCritical: false, shipOnFire: false, sailAlarm: blown.alarm,
    }).ship === 'SHIP IS SINKING');
  expect('a sound rig leaves the card and the alarm exactly as they were',
    sailCanvasState({ ...squall, sailHeight: 0.5, gustPulse: 1 }).canvas === 'Sails 50% out'
    && warningLines({
      outsideStorm: false, shipMetresOutside: null, shipSinking: false,
      shipCritical: false, shipOnFire: false,
    }).ship === null);
}

console.log(failures === 0 ? '\nPASS storm warnings + compass' : `\nFAIL storm warnings + compass (${failures})`);
process.exit(failures === 0 ? 0 : 1);
