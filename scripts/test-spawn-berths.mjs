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
import { SHIP_STATS, BERTH_ENV_SAFE_MAX_PHASE } from '../src/shared/constants/index.ts';
import { berthFrameSideOf } from '../src/shared/utils/index.ts';

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

/** Which side of a pier a hull lies on, in the dock's own frame. 0 = not at
 *  this dock at all. This used to be a hand-copy of Match.berthSideOf with the
 *  slack numbers written out again; it now calls the SHARED helper, which is
 *  the same one Match's occupancy map and both of PhysicsSystem's berth rails
 *  ask — so "moored" cannot mean three different shapes in three files. */
const berthSideOf = (pos, dock) => berthFrameSideOf(dock, pos.x, pos.z);

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

// ────────────────────────────────────────────────────────────────────────────
// A BERTH SHELTERS THE HULL THE PLANNER PUT THERE, HOWEVER FAR SHE SLID.
//
// PhysicsSystem has two berth rails — environmental shelter (no storm/keel/reef
// breaches at your moorings during the opening phases) and the waterline-wall
// exemption (a pier deck standing through your planking is not rock, so you are
// not shoved off your own boarding plank). Both used to key on a 42 m circle
// around dock.berthPosition, and computeShipBerth SLIDES a hull along the run
// to find water: the outliers below sit well past 42 m, so the rails read them
// as at sea. That is how 6 of 30 boarding planks stopped reaching the deck.
// The rails now read the dock's own frame, exactly like the occupancy map.
console.log('Both berth rails cover every hull the planner moored:');
for (const [label, m] of [['12 humans', match], ['bot fleet', botMatch]]) {
  const st = m.state;
  const berthed = st.ships.filter((s) => s.alive && !s.sinking && s.anchored);
  st.storm.phase = Math.min(st.storm.phase, BERTH_ENV_SAFE_MAX_PHASE);
  m.physics.update(1 / 60, 0, st.ships, st.players, [], st.islands, st.seaRocks ?? [], st.storm);
  let unsheltered = 0;
  let worstSlide = 0;
  let pastOldRadius = 0;
  for (const hull of berthed) {
    let slide = Infinity;
    for (const isl of st.islands) {
      if (!isl.dock) continue;
      if (berthFrameSideOf(isl.dock, hull.position.x, hull.position.z) === 0) continue;
      slide = Math.hypot(hull.position.x - isl.dock.berthPosition.x,
        hull.position.z - isl.dock.berthPosition.z);
      break;
    }
    if (!Number.isFinite(slide)) continue;
    worstSlide = Math.max(worstSlide, slide);
    if (slide > 42) pastOldRadius += 1;
    if (!m.physics.isEnvironmentallySheltered(hull.id)) unsheltered += 1;
  }
  expect(`${label}: every moored hull is sheltered by her berth`, unsheltered === 0,
    `unsheltered=${unsheltered}/${berthed.length}, worst slide from berthPosition`
    + ` ${worstSlide.toFixed(1)} m, ${pastOldRadius} hull(s) past the old 42 m circle`);
}

botMatch.stop();
match.stop();
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
