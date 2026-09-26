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
const { SERVER_TICK_MS, PACING_TARGETS, MODES, isModeId } = await import('../src/shared/constants/index.ts');

/** Which roster to sim. MODE=duos runs nine Corsairs with two hands each; the
 *  default (unset) is the legacy Solo run PACING_TARGETS' bands are pinned to,
 *  so the existing gate reads the same numbers it always did. */
export const MODE = isModeId(process.env.MODE) ? process.env.MODE : 'solo';
/** A full bot-only fleet for a mode — solo 12, duos 9, squads 6. Used when MODE
 *  is set; without it the pinned BOT_CREWS (9) is the fleet. */
export const modeBotCrews = (mode) => MODES[mode].crews;

export const MARKS = PACING_TARGETS.MARKS;

/** One bot-only match. Returns crews afloat at each mark, the sim second it
 *  ended at, and why ('last_ship' | 'gold' | 'timeout' when MINUTES ran out),
 *  plus the sim second of every founder (`sinks`) and every PvP kill (`kills`).
 *  `seed` pins PIRATES_BR_MAP_SEED for this match only (Match reads it when it
 *  is constructed), so one process can run several explicit seeds. */
export function simulateMatch({ matchId, minutes, mode = MODE, botCount, marks = MARKS, seed }) {
  const crews = botCount ?? (process.env.MODE ? modeBotCrews(mode) : PACING_TARGETS.BOT_CREWS);
  const prevSeed = process.env.PIRATES_BR_MAP_SEED;
  if (seed !== undefined) process.env.PIRATES_BR_MAP_SEED = String(seed);
  const match = new Match({ matchId, botCount: crews, mode });
  if (seed !== undefined) {
    if (prevSeed === undefined) delete process.env.PIRATES_BR_MAP_SEED;
    else process.env.PIRATES_BR_MAP_SEED = prevSeed;
  }
  const state = match['state'];
  state.phase = 'playing';
  const dt = SERVER_TICK_MS / 1000;
  const steps = Math.ceil((minutes * 60) / dt);
  const at = {};
  const sinks = [];
  const kills = [];
  let alivePrev = state.shipsAlive;
  const pvpKills = () => {
    let n = 0;
    for (const p of state.players) {
      if (match['isSkeletonPlayer']?.(p)) continue;
      n += p.kills ?? 0;
    }
    for (const d of match['matchStatDeltas']?.values?.() ?? []) n -= d?.skeletonsKilled ?? 0;
    return n;
  };
  let killsPrev = pvpKills();
  let next = 0;
  for (let i = 0; i < steps; i++) {
    match['tick']();
    const t = match['t'];
    if (state.shipsAlive < alivePrev) for (let k = state.shipsAlive; k < alivePrev; k++) sinks.push(t);
    alivePrev = state.shipsAlive;
    const kNow = pvpKills();
    if (kNow > killsPrev) for (let k = killsPrev; k < kNow; k++) kills.push(t);
    killsPrev = Math.max(killsPrev, kNow);
    while (next < marks.length && t >= marks[next]) { at[marks[next]] = state.shipsAlive; next += 1; }
    if (state.phase === 'ended') break;
  }
  const endAlive = state.shipsAlive;
  for (const m of marks) if (at[m] === undefined) at[m] = endAlive;
  const endReason = state.phase === 'ended' ? (match['endReason'] ?? 'unknown') : 'timeout';
  const endT = match['t'];
  match.stop?.();
  return { matchId, seed, marks: at, endT, endAlive, endReason, sinks, kills };
}

/** Longest stretch after `from` with no founder and no PvP kill, up to the end
 *  of the match. Returns { gap, start } (seconds). */
export function longestLull(row, from) {
  const events = [...row.sinks, ...row.kills].filter((t) => t >= from).sort((a, b) => a - b);
  let prev = from;
  let best = { gap: 0, start: from };
  for (const t of [...events, row.endT]) {
    if (t - prev > best.gap) best = { gap: t - prev, start: prev };
    prev = Math.max(prev, t);
  }
  return best;
}

export function runPacing({ runs, minutes, marks = MARKS, log = console.log, seeds }) {
  const rows = [];
  const n = seeds ? seeds.length : runs;
  for (let run = 0; run < n; run++) {
    const seed = seeds ? seeds[run] : undefined;
    const row = simulateMatch({ matchId: seeds ? `pacing-s${seed}` : `pacing-${run}`, minutes, marks, mode: MODE, seed });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.env.PACING_CHILD_SEED) {
  // Child mode for test-pacing-curve's parallel runner: one seed, one JSON line.
  const seed = Number(process.env.PACING_CHILD_SEED);
  const minutes = PACING_TARGETS.MAX_MATCH_SECONDS / 60;
  const row = simulateMatch({ matchId: `pacing-s${seed}`, minutes, mode: MODE, seed });
  process.stdout.write(`PACING_ROW ${JSON.stringify(row)}\n`);
  process.exit(0);
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const RUNS = Number(process.env.RUNS ?? 3);
  const MINUTES = Number(process.env.MINUTES ?? PACING_TARGETS.MAX_MATCH_SECONDS / 60);
  const CREWS = process.env.MODE ? modeBotCrews(MODE) : PACING_TARGETS.BOT_CREWS;
  console.log(`pacing-sim: ${RUNS} run(s) x ${MINUTES} min, ${MODE}, ${CREWS} bot crews `
    + `of ${MODES[MODE].crewSize} on ${MODES[MODE].hull}s, `
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
