#!/usr/bin/env node
// PACING CURVE GATE (RNG-01, re-graded b3.5c / mechanicshud-12) — opt-in, PACING=1.
//
// Runs the seeded bot-only sim (scripts/pacing-sim.mjs, the REAL Match tick) for
// a full solo lobby (PACING_TARGETS.BOT_CREWS = 12 sloops) on the 8 EXPLICIT
// seeds in PACING_TARGETS.SEEDS, one child process per seed, at most
// PACING_CONCURRENCY (default 4) at once, and grades:
//   • PACING_TARGETS.BANDS on the MEAN crews afloat at 150/300/480/600/720 s
//     (the owner's 15-crew curve scaled to 12 crews),
//   • the MEAN match end in END_BAND (720-840 s); a run still going at
//     MAX_MATCH_SECONDS counts as ending there,
//   • no founder before FIRST_FOUNDER_MIN_SECONDS (150 s, the truce) in ANY seed,
//   • no stretch longer than LULL_MAX_SECONDS (120 s) after LULL_FROM_SECONDS
//     (240 s) without a founder or a PvP kill, in ANY seed.
//
// Can it fail? Measured red on the pre-regrade tuning (seed 20260801 ended at
// 441 s with 5 crews gone by 300 s); BOT_EARLY_PEACE_SECONDS=0 turns the 150 s
// band and the no-early-founder row red.
//
// Cost: ~40 s of CPU per seed. Skipped unless PACING=1, and the runner reports
// that as SKIPPED, never PASS. SEEDS=a,b,c overrides the seed list (tuning only).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.PACING !== '1') {
  console.log('SKIPPED test-pacing-curve: opt-in (PACING=1), minutes of sim');
  process.exit(0);
}
const { gradeBands, longestLull, MARKS } = await import('./pacing-sim.mjs');
const { PACING_TARGETS, BOT_EARLY_PEACE_SECONDS } = await import('../src/shared/constants/index.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : PACING_TARGETS.SEEDS;
const CONC = Math.max(1, Math.min(6, Number(process.env.PACING_CONCURRENCY ?? 4)));
console.log(`test-pacing-curve: ${SEEDS.length} seeds x ${PACING_TARGETS.MAX_MATCH_SECONDS / 60} min, `
  + `${PACING_TARGETS.BOT_CREWS} bot crews, ${CONC} at a time, BOT_EARLY_PEACE_SECONDS=${BOT_EARLY_PEACE_SECONDS}`);

function runSeed(seed) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'pacing-sim.mjs')], {
      env: { ...process.env, PACING_CHILD_SEED: String(seed) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('PACING_ROW '));
      if (code !== 0 || !line) return reject(new Error(`seed ${seed}: exit ${code}\n${out.slice(-2000)}`));
      resolve(JSON.parse(line.slice('PACING_ROW '.length)));
    });
  });
}

const t0 = performance.now();
const rows = new Array(SEEDS.length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(CONC, SEEDS.length) }, async () => {
  while (cursor < SEEDS.length) {
    const i = cursor++;
    rows[i] = await runSeed(SEEDS[i]);
    const r = rows[i];
    console.log(`  seed ${r.seed}: ` + MARKS.map((m) => `${m}=${r.marks[m]}`).join(' ')
      + `  | ${r.endReason === 'timeout' ? 'did not end' : `ended ${r.endReason}`} at ${r.endT.toFixed(0)} s`
      + `  | founders ${r.sinks.map((t) => t.toFixed(0)).join(',')}  | kills ${r.kills.length}`
      + `  | why ${Object.entries((r.causes ?? []).reduce((a, c) => ({ ...a, [c.cause]: (a[c.cause] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}));
if (process.env.PACING_DUMP) (await import('node:fs')).writeFileSync(process.env.PACING_DUMP, JSON.stringify(rows, null, 1));
const mean = {};
for (const m of MARKS) mean[m] = rows.reduce((s, r) => s + r.marks[m], 0) / rows.length;
console.log(`arc (mean afloat): ` + MARKS.map((m) => `${m}s=${mean[m].toFixed(2)}`).join('  ')
  + `  (${((performance.now() - t0) / 1000).toFixed(0)} s wall)`);

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
for (const g of gradeBands(mean, PACING_TARGETS.BANDS)) {
  ok(g.ok, `${g.mark}s: mean ${g.value.toFixed(2)} crews afloat in [${g.lo}, ${g.hi}]`);
}
const endMean = rows.reduce((s, r) => s + r.endT, 0) / rows.length;
const [endLo, endHi] = PACING_TARGETS.END_BAND;
ok(endMean >= endLo && endMean <= endHi,
  `mean end ${endMean.toFixed(0)} s in [${endLo}, ${endHi}] (per seed ${rows.map((r) => r.endT.toFixed(0)).join(', ')})`);
const early = rows.flatMap((r) => r.sinks.filter((t) => t < PACING_TARGETS.FIRST_FOUNDER_MIN_SECONDS).map((t) => `${r.seed}@${t.toFixed(0)}s`));
ok(early.length === 0, `no founder before ${PACING_TARGETS.FIRST_FOUNDER_MIN_SECONDS} s in any seed${early.length ? ` (${early.join(', ')})` : ''}`);
const lulls = rows.map((r) => ({ seed: r.seed, ...longestLull(r, PACING_TARGETS.LULL_FROM_SECONDS) }));
const worst = lulls.reduce((a, b) => (b.gap > a.gap ? b : a));
ok(worst.gap <= PACING_TARGETS.LULL_MAX_SECONDS,
  `no ${PACING_TARGETS.LULL_MAX_SECONDS} s lull after ${PACING_TARGETS.LULL_FROM_SECONDS} s (worst: seed ${worst.seed}, `
  + `${worst.gap.toFixed(0)} s from ${worst.start.toFixed(0)} s; per seed ${lulls.map((l) => l.gap.toFixed(0)).join(', ')})`);
ok(rows.length === SEEDS.length && rows.length >= 1, `${rows.length} seed(s) graded`);
console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-pacing-curve');
process.exit(fails ? 1 : 0);
