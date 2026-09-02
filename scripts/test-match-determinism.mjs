#!/usr/bin/env node
// MATCH DETERMINISM GATE (RNG-01) — does a seeded match replay bit-identically?
//
// Two Match instances built with the SAME matchId under PIRATES_BR_MAP_SEED are
// ticked side by side for SECONDS (default 90) of sim time; every whole second
// the gameplay state (storm ring, every player and hull, sharks, skeleton count)
// is hashed. Every hash must match. Before RNG-01 the storm centre, bot timers,
// skeleton waves, sink knockback and shark spawns all drew from Math.random, so
// the two runs diverged at the first storm draw — which is what made the pacing
// sim unable to fail and every founder/shark scenario unreplayable.
//
// Control ("can it fail?"): a THIRD match with a different matchId must diverge
// from the first — proves the hash actually sees the simulation and that the
// matchId salts the stream (two matches on one seeded server are not clones).
//
//   node --import tsx scripts/test-match-determinism.mjs         # 90 s, ~40 s wall
//   SECONDS=30 node --import tsx scripts/test-match-determinism.mjs
import { createHash } from 'node:crypto';

process.env.PIRATES_BR_MAP_SEED ??= '20260801';
const { Match } = await import('../src/server/core/Match.ts');
const { SERVER_TICK_MS } = await import('../src/shared/constants/index.ts');

const SECONDS = Number(process.env.SECONDS ?? 90);
const BOTS = Number(process.env.BOTS ?? 9);

/** Ids are uuid() (not seeded, and not gameplay) — project them away and keep
 *  everything a player could see or be hit by. Floats are compared exactly:
 *  same code, same draws, same bits. */
function project(state, t) {
  return {
    t,
    storm: state.storm,
    shipsAlive: state.shipsAlive,
    players: state.players.map((p) => ({
      n: p.name, b: p.isBot, s: p.state, h: p.health, g: p.gold,
      p: p.position, r: p.rotation, v: p.velocity, k: p.knockbackVelocity,
      ship: p.shipId ? 1 : 0, sw: p.swimTimer,
    })),
    ships: state.ships.map((s) => ({
      p: s.position, r: s.rotation, h: s.health, sail: s.sailHeight, anch: s.anchored,
      crew: s.crewIds.length, holes: s.holes, sinking: s.sinking ?? null, sunk: s.sunk ?? null,
      v: s.velocity,
    })),
    sharks: state.sharks.map((s) => ({ p: s.position, r: s.rotation })),
    skeletons: state.players.filter((p) => p.name.startsWith('Skeleton_')).length,
    projectiles: (state.projectiles ?? []).length,
  };
}

function sectionHashes(state, t) {
  const proj = project(state, t);
  const out = {};
  for (const [k, v] of Object.entries(proj)) {
    out[k] = createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
  }
  return out;
}

function run(matchId) {
  const match = new Match({ matchId, botCount: BOTS });
  const state = match['state'];
  state.phase = 'playing';
  const dt = SERVER_TICK_MS / 1000;
  const steps = Math.ceil(SECONDS / dt);
  const perSecond = [];
  let nextSecond = 1;
  for (let i = 0; i < steps; i++) {
    match['tick']();
    if (match['t'] >= nextSecond) {
      perSecond.push({ t: nextSecond, h: sectionHashes(state, match["t"]) });
      nextSecond += 1;
    }
  }
  match.stop?.();
  return perSecond;
}

const t0 = performance.now();
const a = run('det-A');
const b = run('det-A');
const c = run('det-B');
const wall = ((performance.now() - t0) / 1000).toFixed(1);

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };

const key = (h) => JSON.stringify(h);
let firstDiff = null;
for (let i = 0; i < a.length; i++) {
  if (key(a[i].h) !== key(b[i].h)) {
    const sections = Object.keys(a[i].h).filter((k) => a[i].h[k] !== b[i].h[k]);
    firstDiff = { t: a[i].t, sections };
    break;
  }
}
ok(a.length === b.length && a.length >= SECONDS - 1,
  `both seeded runs produced ${a.length} per-second samples over ${SECONDS} s (${wall} s wall)`);
ok(firstDiff === null,
  firstDiff === null
    ? `same matchId + seed ⇒ identical state hash every second for ${SECONDS} s`
    : `same matchId + seed diverged at t=${firstDiff.t} s in [${firstDiff.sections.join(', ')}]`);

let controlDiff = null;
for (let i = 0; i < Math.min(a.length, c.length); i++) {
  if (key(a[i].h) !== key(c[i].h)) { controlDiff = a[i].t; break; }
}
ok(controlDiff !== null,
  controlDiff !== null
    ? `control: a different matchId diverges (first at t=${controlDiff} s) — the hash sees the sim and the matchId salts the stream`
    : 'control: a different matchId produced the SAME hashes — the gate is blind');

console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-match-determinism');
process.exit(fails ? 1 : 0);
