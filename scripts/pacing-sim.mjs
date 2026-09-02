#!/usr/bin/env node
// PACING SIM — how fast does the lobby empty, across the WHOLE storm arc?
//
// Runs bot-only matches through the REAL Match tick at full rate and reports
// crews afloat at each mark, plus how and when each match ended. Since RNG-01
// it is SEEDED (PIRATES_BR_MAP_SEED, default 20260801; matchId salts each run),
// so two invocations print the same numbers and a band can be enforced:
//
//   node --import tsx scripts/pacing-sim.mjs                          # 3 runs x 13 min
//   RUNS=2 BAND="150:8-9,360:4.5-7" node --import tsx scripts/pacing-sim.mjs   # exit 1 outside
//   UNSEEDED=1 node --import tsx scripts/pacing-sim.mjs               # the old Math.random matches
//
// Not in npm test: a 13-minute match is minutes of wall clock. Its gate is
// scripts/test-pacing-curve.mjs (opt-in, PACING=1), which grades PACING_TARGETS.
// Measure here, not in a live browser match: a loaded host slows the sim itself
// and makes the pacing look far slower than it is.
//
// The old instrument stopped at 360 s — before phase 3 even began at 395 s — so
// every "endgame" number quoted from it was a guess. MINUTES defaults to 13 now
// (the arc closes at 755 s) and a run that has not ENDED by then says so.
import { pathToFileURL } from 'node:url';

if (process.env.UNSEEDED !== '1') process.env.PIRATES_BR_MAP_SEED ??= '20260801';
const { Match } = await import('../src/server/core/Match.ts');
const { SERVER_TICK_MS, PACING_TARGETS } = await import('../src/shared/constants/index.ts');

export const MARKS = PACING_TARGETS.MARKS;

/** One bot-only match. Returns crews afloat at each mark, the sim second it
 *  ended at, and why ('last_ship' | 'gold' | 'timeout' when MINUTES ran out). */
export function simulateMatch({ matchId, minutes, botCount = PACING_TARGETS.BOT_CREWS, marks = MARKS }) {
  const match = new Match({ matchId, botCount });
  const state = match['state'];
  state.phase = 'playing';
  const dt = SERVER_TICK_MS / 1000;
  const steps = Math.ceil((minutes * 60) / dt);
  const at = {};
  let next = 0;
  for (let i = 0; i < steps; i++) {
    match['tick']();
    const t = match['t'];
    while (next < marks.length && t >= marks[next]) { at[marks[next]] = state.shipsAlive; next += 1; }
    if (state.phase === 'ended') break;
  }
  const endAlive = state.shipsAlive;
  for (const m of marks) if (at[m] === undefined) at[m] = endAlive;
  const endReason = state.phase === 'ended' ? (match['endReason'] ?? 'unknown') : 'timeout';
  match.stop?.();
  return { matchId, marks: at, endT: match['t'], endAlive, endReason };
}

export function runPacing({ runs, minutes, marks = MARKS, log = console.log }) {
  const rows = [];
  for (let run = 0; run < runs; run++) {
    const row = simulateMatch({ matchId: `pacing-${run}`, minutes, marks });
    rows.push(row);
    log(`run ${run}: ` + marks.map((m) => `${m}s=${row.marks[m]}`).join(' ')
      + `  end t=${row.endT.toFixed(0)}s alive=${row.endAlive} reason=${row.endReason}`);
  }
  const mean = {};
  for (const m of marks) mean[m] = rows.reduce((s, r) => s + r.marks[m], 0) / rows.length;
  return { rows, mean };
}

/** "150:8-9,360:4.5-7" -> { 150: [8, 9], 360: [4.5, 7] } */
export function parseBand(spec) {
  const out = {};
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+):(-?[\d.]+)-(-?[\d.]+)$/.exec(part);
    if (!m) throw new Error(`BAND entry "${part}" is not <mark>:<lo>-<hi>`);
    out[Number(m[1])] = [Number(m[2]), Number(m[3])];
  }
  return out;
}

/** Grade mean crews afloat against bands: [{ mark, lo, hi, value, ok }]. */
export function gradeBands(mean, bands) {
  return Object.entries(bands).map(([mark, [lo, hi]]) => {
    const value = mean[Number(mark)];
    return { mark: Number(mark), lo, hi, value, ok: value !== undefined && value >= lo && value <= hi };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const RUNS = Number(process.env.RUNS ?? 3);
  const MINUTES = Number(process.env.MINUTES ?? PACING_TARGETS.MAX_MATCH_SECONDS / 60);
  console.log(`pacing-sim: ${RUNS} run(s) x ${MINUTES} min, ${PACING_TARGETS.BOT_CREWS} bot crews, `
    + (process.env.UNSEEDED === '1' ? 'UNSEEDED' : `seed ${process.env.PIRATES_BR_MAP_SEED}`)
    + `, BOT_EARLY_PEACE_SECONDS=${process.env.BOT_EARLY_PEACE_SECONDS ?? 150}`);
  const t0 = performance.now();
  const { mean } = runPacing({ runs: RUNS, minutes: MINUTES });
  console.log(`\nmean crews afloat: ` + MARKS.map((m) => `${m}s=${mean[m].toFixed(1)}`).join('  ')
    + `  (${((performance.now() - t0) / 1000).toFixed(0)} s wall)`);
  if (process.env.BAND) {
    const graded = gradeBands(mean, parseBand(process.env.BAND));
    for (const g of graded) console.log(`${g.ok ? '✓' : '✗'} ${g.mark}s mean ${g.value.toFixed(2)} in [${g.lo}, ${g.hi}]`);
    process.exit(graded.every((g) => g.ok) ? 0 : 1);
  }
}
