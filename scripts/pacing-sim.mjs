#!/usr/bin/env node
// WAVE-1 PACING SIM — how fast does the lobby actually empty?
//
// Not part of `npm test` (a single six-minute match takes ~90s of wall clock).
// Run it when you touch BOT_EARLY_PEACE_SECONDS, BOT_ENGAGE_RANGE_BY_PHASE,
// BOT_MAX_HUNTERS_BY_PHASE or anything else that decides who shoots whom:
//
//   RUNS=6 MINUTES=6 node --import tsx scripts/pacing-sim.mjs
//
// It runs whole bot-only matches through the REAL Match tick at full rate and
// reports crews afloat at each mark. Measure here, not in a live browser match:
// a loaded host (leftover zombie matches, a recording browser) slows the sim
// itself and makes the pacing look far slower than it is.
//
// Tuning targets, 9 bot crews: ~8-9 afloat at 150s (the early-peace window
// lifts at BOT_EARLY_PEACE_SECONDS = 150), and never a wipe — 6 or more still
// afloat at 300s.
import { Match } from '../src/server/core/Match.ts';
import { SERVER_TICK_MS } from '../src/shared/constants/index.ts';

const RUNS = Number(process.env.RUNS ?? 3);
const MINUTES = Number(process.env.MINUTES ?? 6);
const MARKS = [60, 120, 150, 180, 240, 276, 300, 360];

const rows = [];
for (let run = 0; run < RUNS; run++) {
  const match = new Match({ matchId: `pacing-${run}`, botCount: 9 });
  const state = match['state'];
  state.phase = 'playing';
  const dt = SERVER_TICK_MS / 1000;
  const steps = Math.ceil((MINUTES * 60) / dt);
  const marks = {};
  let nextMark = 0;
  for (let i = 0; i < steps; i++) {
    match['tick']();
    const t = match['t'];
    while (nextMark < MARKS.length && t >= MARKS[nextMark]) {
      marks[MARKS[nextMark]] = state.shipsAlive;
      nextMark += 1;
    }
    if (state.shipsAlive <= 1) break;
  }
  for (const m of MARKS) if (marks[m] === undefined) marks[m] = state.shipsAlive;
  rows.push({ run, marks, endT: match['t'], endAlive: state.shipsAlive });
  console.log(`run ${run}: ` + MARKS.map((m) => `${m}s=${marks[m]}`).join(' ') + `  end t=${match['t'].toFixed(0)}s alive=${state.shipsAlive}`);
  match.stop?.();
}
const avg = (m) => (rows.reduce((s, r) => s + r.marks[m], 0) / rows.length).toFixed(1);
console.log('\nmean crews afloat: ' + MARKS.map((m) => `${m}s=${avg(m)}`).join('  '));
