#!/usr/bin/env node
/**
 * PRED-01 / physics-09 — does the CLIENT's mirror of a server pushout agree
 * with the server?
 *
 * Scope landed here: the swim-hull mirror in Game.getPlayerRenderPosition. It
 * called the shared footprint with the FALLBACK draft factor and verticalT = 0
 * — a straight prism — while PhysicsSystem.resolveSwimmerShipCollision resolves
 * against the section tapered with the hull's own draft
 * (getSwimHullVerticalT(y, shipY, stats, ship.type)). So a deep swimmer was
 * walled further out on the client than on the server, every frame, and yanked
 * back in on the next snapshot.
 *
 * The prop / tavern / cave-wall / slope pushouts are the other half of
 * physics-09 and are NOT graded here yet (w6.4 slice d2, deferred: see
 * waves/w6/w6.4.json) — this file is where they land.
 *
 * Logic tier: shared math + a source assertion on the client call site. No
 * server, no browser, no stack.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getSwimHullVerticalBand,
  isNearDockFrame,
  isOnDockDeck,
  getSwimHullVerticalT,
  getSwimHullHalfWidth,
  pushOutOfSwimHullFootprint,
} from '../src/shared/utils/index.ts';
import { PLAYER, SHIP_STATS } from '../src/shared/constants/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const MARGIN = PLAYER.RADIUS + 0.18;
const TYPES = Object.keys(SHIP_STATS);
const SHIP_Y = 3.0;

console.log('\n[1] The swim-hull wall stands in the same place on both sides');
let worstAgreement = 0;
let worstOldGap = 0;
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  for (const depth of [0.0, 0.4, 0.9, 1.6, 2.4]) {
    const y = SHIP_Y - depth;
    // The authoritative wall (PhysicsSystem.resolveSwimmerShipCollision).
    const serverT = getSwimHullVerticalT(y, SHIP_Y, stats, type);
    const serverWall = getSwimHullHalfWidth(stats, 0, MARGIN, serverT);
    // CLIENT, before this fix: fallback draft, verticalT = 0.
    const oldWall = getSwimHullHalfWidth(stats, 0, MARGIN, 0);
    worstOldGap = Math.max(worstOldGap, Math.abs(oldWall - serverWall));
  }
}
// review-6 P2: this block used to ALSO compute `clientT` from the identical
// expression one line below `serverT` and assert the two agreed within 0.15 m.
// That number was 0 by construction whatever Game.ts did, i.e. the headline
// assertion of the file could not fail. It is gone. What the two sides share is
// the ARGUMENT LIST at the call site, so that is what is graded — here across
// the two source files, and in section [4] against the exact client expression.
const clientCall = readFileSync(join(ROOT, 'src/client/core/Game.ts'), 'utf8')
  .match(/getSwimHullVerticalT\(([^)]*)\)/);
const serverCall = readFileSync(join(ROOT, 'src/server/systems/PhysicsSystem.ts'), 'utf8')
  .match(/getSwimHullVerticalT\(([^)]*)\)/);
const argShape = (m) => (m ? m[1].split(',').map((a) => a.trim().split('.').pop()) : null);
const clientArgs = argShape(clientCall);
const serverArgs = argShape(serverCall);
expect('both sides call getSwimHullVerticalT with the same four arguments',
  !!clientArgs && !!serverArgs && clientArgs.length === 4 && serverArgs.length === 4
  && clientArgs[1] === serverArgs[1] && clientArgs[2] === serverArgs[2] && clientArgs[3] === serverArgs[3],
  `client(${clientArgs?.join(', ')}) vs server(${serverArgs?.join(', ')})`);
expect(
  `CONTROL: the pre-fix client arguments DID disagree (worst ${worstOldGap.toFixed(3)} m)`,
  worstOldGap > 0.15,
  'if the old arguments agreed too, this file grades nothing',
);

console.log('\n[2] The keel barrier sits at the hull\'s own draft, not the fallback');
let worstBandGap = 0;
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const typed = getSwimHullVerticalBand(SHIP_Y, stats, type);
  const fallback = getSwimHullVerticalBand(SHIP_Y, stats);
  worstBandGap = Math.max(worstBandGap, Math.abs(typed.keelY - fallback.keelY));
}
expect(`CONTROL: the fallback keel is a different height (worst ${worstBandGap.toFixed(3)} m)`, worstBandGap > 0.01);

console.log('\n[3] A swimmer shoved out of the tapered section lands clear of it');
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const t = getSwimHullVerticalT(SHIP_Y - 1.4, SHIP_Y, stats, type);
  const out = pushOutOfSwimHullFootprint(stats, 0.05, 0.0, MARGIN, t);
  expect(`${type}: a swimmer inside the section is pushed out`, out.pushed);
  // The shared footprint counts a point exactly ON the wall as inside (`<=`),
  // so a second call still reports `pushed` — it just has nowhere to move him.
  // What matters is that the shove converged: the second one is a no-op.
  const still = pushOutOfSwimHullFootprint(stats, out.x, out.z, MARGIN, t);
  const residual = Math.hypot(still.x - out.x, still.z - out.z);
  expect(`${type}: and the shove converged (second push moves him ${residual.toFixed(4)} m)`,
    residual < 1e-3, `landed at ${out.x.toFixed(3)},${out.z.toFixed(3)}`);
}

console.log('\n[4] The client call site passes both arguments');
const gameSrc = readFileSync(join(ROOT, 'src/client/core/Game.ts'), 'utf8');
expect('the mirror reads the band with the ship type',
  gameSrc.includes('getSwimHullVerticalBand(ship.position.y, stats, ship.type)'));
expect('the mirror computes verticalT from the drawn depth',
  gameSrc.includes('getSwimHullVerticalT(visualY, ship.position.y, stats, ship.type)'));
expect('the footprint test is tapered',
  gameSrc.includes('isInsideSwimHullFootprint(stats, localX, localZ, hullMargin, verticalT)'));
expect('the pushout is tapered',
  gameSrc.includes('pushOutOfSwimHullFootprint(stats, localX, localZ, hullMargin, verticalT)'));

console.log('\n[5] The pier edge is in the same place on both sides (review-8 P1)');
// w8.3 narrowed the SERVER's standing surface to the exact planking, but the
// client's local-player mirror kept the 0.45 m pad, so a pirate who stepped off
// the run was drawn standing on open water at deck height for the whole fall —
// clippedUnderTerrain lerped her all the way back up to the deck — and only
// snapped down when the server flipped her to swimming.
{
  const dock = { position: { x: 120, y: 2.4, z: -60 }, rotation: 0.7, width: 6, length: 34 };
  const at = (lx, lz) => {
    const cos = Math.cos(dock.rotation);
    const sin = Math.sin(dock.rotation);
    return {
      x: dock.position.x + lx * cos + lz * sin,
      z: dock.position.z - lx * sin + lz * cos,
    };
  };
  const inboard = at(dock.width * 0.5 - 0.1, 0);
  const overboard = at(dock.width * 0.5 + 0.3, 0);
  const pastTheEnd = at(0, dock.length * 0.5 + 0.3);
  expect('a pirate on the last plank is standing on the pier',
    isOnDockDeck(dock, inboard.x, inboard.z));
  expect('30 cm past the plank she is over water, on BOTH sides',
    !isOnDockDeck(dock, overboard.x, overboard.z)
    && !isOnDockDeck(dock, pastTheEnd.x, pastTheEnd.z));
  expect('CONTROL: the 0.45 m pad still exists, as a broad phase and not as a floor',
    isNearDockFrame(dock, overboard.x, overboard.z)
    && isNearDockFrame(dock, pastTheEnd.x, pastTheEnd.z));
  expect('the client mirror calls the shared predicate, pad and all removed',
    gameSrc.includes('isOnDockDeck(island.dock, predictedX, predictedZ)')
    && !gameSrc.includes('island.dock.width * 0.5 + 0.45'),
    'Game.getPlayerRenderPosition still resolves the dock surface itself');
  const physicsSrc = readFileSync(join(ROOT, 'src/server/systems/PhysicsSystem.ts'), 'utf8');
  expect('and the server floor calls the same one',
    physicsSrc.includes('isOnDockDeck(island.dock, player.position.x, player.position.z)'));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — test-client-prediction-parity (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);
