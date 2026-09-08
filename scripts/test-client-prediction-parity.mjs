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
    // SERVER: the authoritative arguments (PhysicsSystem.resolveSwimmerShipCollision).
    const serverT = getSwimHullVerticalT(y, SHIP_Y, stats, type);
    const serverWall = getSwimHullHalfWidth(stats, 0, MARGIN, serverT);
    // CLIENT, as of this fix: the same arguments.
    const clientT = getSwimHullVerticalT(y, SHIP_Y, stats, type);
    const clientWall = getSwimHullHalfWidth(stats, 0, MARGIN, clientT);
    // CLIENT, before this fix: fallback draft, verticalT = 0.
    const oldWall = getSwimHullHalfWidth(stats, 0, MARGIN, 0);
    worstAgreement = Math.max(worstAgreement, Math.abs(clientWall - serverWall));
    worstOldGap = Math.max(worstOldGap, Math.abs(oldWall - serverWall));
  }
}
expect(`client and server wall agree within 0.15 m (worst ${worstAgreement.toFixed(4)} m)`, worstAgreement < 0.15);
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

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — test-client-prediction-parity (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures === 0 ? 0 : 1);
