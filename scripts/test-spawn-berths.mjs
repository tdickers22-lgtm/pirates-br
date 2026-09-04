#!/usr/bin/env node
// SPAWN-01 (netcode-V1, gameplay-27, gameplay-11, netcode-10): every crew that
// joins gets its OWN berth.
//
// The old dock-occupancy test was a 42 m radius around `dock.berthPosition`,
// but `computeShipBerth` slides a hull along the pier to find water — at The
// Crooked Atoll the parked hull ends up 42.3 m from that point, so the next
// joiner read the berth as free and parked INSIDE the hull already there
// (measured: humans 2..N at 0.0 m apart). This suite grades the two things the
// player actually feels: no two hulls stacked, and every hull alongside a pier
// of its own (two berths per dock — one each side of the run).
//
// LOGIC suite: drives the real Match, no stack, no browser.
import { Match } from '../src/server/core/Match.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const fakeWs = () => ({ readyState: 1, send() {} });
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Which side of a pier a hull lies on, in the dock's own frame.
 *  0 = not at this dock at all. */
function berthSideOf(pos, dock) {
  const fwd = { x: Math.sin(dock.rotation), z: Math.cos(dock.rotation) };
  const right = { x: Math.cos(dock.rotation), z: -Math.sin(dock.rotation) };
  const rx = pos.x - dock.position.x;
  const rz = pos.z - dock.position.z;
  const along = rx * fwd.x + rz * fwd.z;
  const lateral = rx * right.x + rz * right.z;
  if (Math.abs(along) > dock.length * 0.5 + 30) return 0;
  if (Math.abs(lateral) > 45) return 0;
  return lateral >= 0 ? 1 : -1;
}

const HUMANS = 12;
const match = new Match({ matchId: 'spawn-berths', botCount: 0 });
match.state.storm.centerX = 0;
match.state.storm.centerZ = 0;
match.state.storm.safeRadius = 1200;

for (let i = 0; i < HUMANS; i++) match.addHumanClient(fakeWs(), `Pirate_${i + 1}`);

const hulls = match.state.ships.filter((s) => s.alive && !s.sinking);
console.log(`${HUMANS} humans, 0 bots -> ${hulls.length} hulls`);
expect('every human got a hull', hulls.length === HUMANS, `hulls=${hulls.length}`);

console.log('No two hulls share a berth:');
// Two crews DO share a pier now (one berth each side of the run), so the honest
// test is not a fixed radius but hull clearance: no two beams may overlap.
let minPair = Infinity;
let worst = '';
let overlaps = 0;
for (let i = 0; i < hulls.length; i++) {
  for (let j = i + 1; j < hulls.length; j++) {
    const d = dist2(hulls[i].position, hulls[j].position);
    const need = (SHIP_STATS[hulls[i].type].width + SHIP_STATS[hulls[j].type].width) * 0.5 + 1;
    if (d < need) overlaps += 1;
    if (d < minPair) {
      minPair = d;
      worst = `${hulls[i].type}@(${hulls[i].position.x.toFixed(1)},${hulls[i].position.z.toFixed(1)})`
        + ` vs ${hulls[j].type}@(${hulls[j].position.x.toFixed(1)},${hulls[j].position.z.toFixed(1)})`
        + ` need>=${need.toFixed(1)}`;
    }
  }
}
console.log(`  min pairwise hull distance ${minPair.toFixed(1)} m — ${worst}`);
expect('no two hulls overlap at the horn', overlaps === 0, `${overlaps} overlapping pair(s); closest ${minPair.toFixed(1)} m — ${worst}`);
expect('no two hulls start at the same point', minPair >= 8, `min=${minPair.toFixed(1)} m — ${worst}`);

console.log('Every hull lies at a berth of its own:');
const docks = match.state.islands.filter((isl) => isl.dock).map((isl) => ({ id: isl.id, dock: isl.dock }));
expect('the roster still carries 10 piers (20 berths)', docks.length === 10, `docks=${docks.length}`);
const taken = new Map();
let adrift = 0;
let doubled = 0;
for (const hull of hulls) {
  let key = null;
  for (const { id, dock } of docks) {
    const side = berthSideOf(hull.position, dock);
    if (side !== 0) { key = `${id}#${side}`; break; }
  }
  if (!key) {
    adrift += 1;
    console.error(`     adrift: ${hull.type} at (${hull.position.x.toFixed(1)},${hull.position.z.toFixed(1)})`
      + ` anchored=${hull.anchored}`);
    continue;
  }
  if (taken.has(key)) doubled += 1;
  taken.set(key, (taken.get(key) ?? 0) + 1);
}
expect('no hull starts adrift in open water', adrift === 0, `adrift=${adrift}/${hulls.length}`);
expect('no berth holds two hulls', doubled === 0, `doubled=${doubled}`);

console.log('A hull with nowhere to moor still starts anchored:');
const spare = match.state.ships.find((s) => s.alive && !s.sinking);
expect('berthed hulls ride at anchor at the horn', match.state.ships.every((s) => !s.alive || s.sinking || s.anchored),
  `unanchored=${match.state.ships.filter((s) => s.alive && !s.sinking && !s.anchored).length}`);
expect('and with canvas furled', spare ? spare.sailHeight === 0 : false, `sailHeight=${spare?.sailHeight}`);

console.log('A bot fleet starts at berths too (gameplay-27):');
const botMatch = new Match({ matchId: 'spawn-berths-bots', botCount: 9 });
const botHulls = botMatch.state.ships.filter((s) => s.alive && !s.sinking);
const botDocks = botMatch.state.islands.filter((isl) => isl.dock).map((isl) => ({ id: isl.id, dock: isl.dock }));
let unberthed = 0;
let inDangerBand = 0;
const botTaken = new Set();
for (const hull of botHulls) {
  let key = null;
  for (const { id, dock } of botDocks) {
    const side = berthSideOf(hull.position, dock);
    if (side !== 0) { key = `${id}#${side}`; break; }
  }
  if (!key || botTaken.has(key)) unberthed += 1; else botTaken.add(key);
  // BotSystem reads inDanger at distToCenter/safeRadius > 0.85; a hull spawned
  // past that opens the match in 'flee' instead of at her moorings.
  const d = Math.hypot(hull.position.x - botMatch.state.storm.centerX, hull.position.z - botMatch.state.storm.centerZ);
  if (d / botMatch.state.storm.safeRadius > 0.85) inDangerBand += 1;
}
expect('every bot hull lies in a berth of its own', unberthed === 0, `unberthed=${unberthed}/${botHulls.length}`);
expect('every bot hull rides at anchor', botHulls.every((h) => h.anchored),
  `adrift=${botHulls.filter((h) => !h.anchored).length}`);
expect('no bot hull opens the match already fleeing', inDangerBand === 0, `inDanger=${inDangerBand}/${botHulls.length}`);
botMatch.stop();

match.stop();
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
