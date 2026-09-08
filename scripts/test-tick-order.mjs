#!/usr/bin/env node
// THE TICK IS A SEQUENCE, AND THE SEQUENCE IS THE CONTRACT (MATCHSPLIT-01).
//
// Match.ts is being taken apart into src/server/systems/*. Every one of those
// extractions is supposed to be MECHANICAL: the same work, in the same order,
// drawing the same numbers off the same seeded stream. Nothing in the existing
// suites can see the difference between "moved" and "moved and quietly
// re-ordered" — they assert outcomes under ONE seed, and two subsystems that
// swap places in the rng stream still produce a legal-looking match. It is the
// NEXT seed, on the owner's machine, that desyncs.
//
// So this suite pins the spine of tick():
//   1. WHICH subsystems run, in WHAT order, every tick (labels, not method
//      names — a label may live on Match today and on its own system class
//      tomorrow, and that is exactly the move we are protecting);
//   2. HOW MANY draws each one takes off match.rng() on each of those ticks
//      (the rng cursor is shared, so a draw moved across a boundary changes
//      every later system's numbers);
//   3. that every label is still findable at all — an extraction that forgets
//      to register its new home fails here rather than silently dropping out
//      of the trace.
//
// The baseline is scripts/fixtures/tick-order-baseline.json, recorded on the
// pre-split tree. Re-record ONLY with a commit that says why the order changed:
//   node --import tsx scripts/test-tick-order.mjs --record
//
//   PIRATES_BR_MAP_SEED=20260801 node --import tsx scripts/test-tick-order.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match, rngDraws } from '../src/server/core/Match.ts';
import { SERVER_TICK_MS } from '../src/shared/constants/index.ts';

// The whole instrument is draw COUNTS off the seeded stream, so an unseeded run
// (makeMatchRng falls through to Math.random) can only ever produce noise. The
// suite pins its own seed rather than trusting the runner's environment.
process.env.PIRATES_BR_MAP_SEED ??= '20260801';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, 'fixtures/tick-order-baseline.json');
const RECORD = process.argv.includes('--record');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── The spine ───────────────────────────────────────────────────────────────
// label → where the work lives. `proto` names are methods on Match.prototype
// (pre-split home); `field` entries are [instance field, method] on the match
// (post-split home, and where the already-extracted systems live today). The
// FIRST candidate that exists wins, and a label with no home at all is a FAIL.
const SPINE = [
  { label: 'respawns',        proto: ['updateRespawns'],          field: [['respawns', 'update']] },
  { label: 'input',           proto: ['applyInput'],              field: [] },
  { label: 'cargoAndBounty',  proto: ['updateCargoAndBounty'],    field: [['cargo', 'update']] },
  { label: 'bots',            proto: [],                          field: [['bots', 'update']] },
  { label: 'skeletonWaves',   proto: ['updateSkeletonWaves'],     field: [['skeletons', 'updateWaves']] },
  { label: 'captures',        proto: ['updateCaptures'],          field: [['captures', 'update']] },
  { label: 'islandSkeletons', proto: ['updateIslandSkeletons'],   field: [['skeletons', 'update']] },
  { label: 'botLooting',      proto: ['processBotLooting'],       field: [] },
  { label: 'botFlooding',     proto: ['updateBotFlooding'],       field: [] },
  { label: 'botDbno',         proto: ['updateBotDbno'],           field: [['downed', 'updateBotDbno']] },
  { label: 'downedRevives',   proto: ['updateDownedAndRevives'],  field: [['downed', 'update']] },
  { label: 'weapons',         proto: [],                          field: [['weapons', 'update']] },
  { label: 'cannons',         proto: [],                          field: [['weapons', 'tickCannons']] },
  { label: 'treasureSync',    proto: ['syncTreasureChests'],      field: [['treasure', 'sync']] },
  { label: 'physics',         proto: [],                          field: [['physics', 'update']] },
  { label: 'sharks',          proto: ['updateSharks'],            field: [] },
  { label: 'wildlife',        proto: ['updateWildlife'],          field: [] },
  { label: 'spoils',          proto: ['updateSpoils'],            field: [['treasure', 'updateSpoils']] },
  { label: 'storm',           proto: [],                          field: [['storm', 'update']] },
  { label: 'wreckEvent',      proto: ['updateWreckEvent'],        field: [['wreck', 'update']] },
  { label: 'kegs',            proto: ['updateKegs'],              field: [['kegs', 'update']] },
  { label: 'fieldRepairs',    proto: ['updateFieldRepairs'],      field: [] },
  { label: 'deathAnchor',     proto: ['updateDeathAnchor'],       field: [] },
  { label: 'trading',         proto: [],                          field: [['trading', 'update']] },
  { label: 'healthDeaths',    proto: ['resolveHealthDeaths'],     field: [['damage', 'resolveHealthDeaths']] },
  { label: 'shipSinking',     proto: ['evaluateShipSinking'],     field: [] },
  { label: 'founderingCrew',  proto: ['updateFounderingCrew'],    field: [] },
  { label: 'crewAttrition',   proto: ['updateCrewAttrition'],     field: [] },
  { label: 'winCondition',    proto: ['checkWinCondition'],       field: [] },
  { label: 'snapshot',        proto: ['buildSnapshot'],           field: [['net', 'buildSnapshot']] },
];

/** Trace buffer: one entry per instrumented call, [label, rngDrawsInside]. */
let trace = [];
let tracing = false;

function wrap(owner, method, label) {
  const original = owner[method];
  if (typeof original !== 'function') return false;
  owner[method] = function patched(...args) {
    if (!tracing) return original.apply(this, args);
    const before = rngDraws.n;
    // Re-entrancy: a nested instrumented call must not double-bill its parent's
    // draws to itself, so the parent bills only what is left after children.
    const parentDepth = trace.length;
    let out;
    try {
      out = original.apply(this, args);
    } finally {
      let childDraws = 0;
      for (let i = parentDepth; i < trace.length; i++) childDraws += trace[i][1];
      trace.push([label, (rngDraws.n - before) - childDraws]);
    }
    return out;
  };
  return true;
}

const missing = [];
const homes = [];
function instrument(match) {
  for (const entry of SPINE) {
    let placed = false;
    for (const name of entry.proto) {
      if (wrap(Object.getPrototypeOf(match), name, entry.label)) { placed = true; homes.push(`${entry.label} → Match.${name}`); break; }
    }
    if (!placed) {
      for (const [field, method] of entry.field) {
        const obj = match[field];
        if (obj && typeof obj[method] === 'function' && wrap(obj, method, entry.label)) {
          placed = true; homes.push(`${entry.label} → ${field}.${method}`); break;
        }
      }
    }
    if (!placed) missing.push(entry.label);
  }
}

// ── Drive the sim ───────────────────────────────────────────────────────────
const TICKS = 400;
const DT = SERVER_TICK_MS / 1000;

function runTrace() {
  const match = new Match({ matchId: 'tick-order', botCount: 9 });
  match.state.phase = 'playing';
  instrument(match);
  const perTick = [];
  tracing = true;
  for (let i = 0; i < TICKS; i++) {
    trace = [];
    match.tick();
    // Collapse consecutive repeats of one label (applyInput runs per client,
    // evaluateShipSinking per hull): the ORDER of subsystems is the contract,
    // not the head count of the entities inside one of them.
    const merged = [];
    for (const [label, draws] of trace) {
      const last = merged[merged.length - 1];
      if (last && last[0] === label) { last[1] += draws; last[2] += 1; }
      else merged.push([label, draws, 1]);
    }
    perTick.push(merged);
  }
  tracing = false;
  match.stop?.();
  return perTick;
}

console.log(`Tick spine (${TICKS} ticks, seed ${process.env.PIRATES_BR_MAP_SEED ?? 'unseeded'}):`);
const perTick = runTrace();
console.log(`  homes: ${homes.length}/${SPINE.length} resolved`);
expect('every spine label has a home in the code', missing.length === 0, missing.length ? `unfound: ${missing.join(', ')}` : '');

// The signature of a tick = the ordered labels, and separately the draws each
// label took. Order changes and draw-count changes are reported apart so the
// failure message says WHICH of the two broke.
const orderSig = perTick.map((t) => t.map((e) => e[0]).join('>'));
const drawSig = perTick.map((t) => t.map((e) => `${e[0]}:${e[1]}`).join(','));
const totalDraws = perTick.reduce((s, t) => s + t.reduce((a, e) => a + e[1], 0), 0);
console.log(`  distinct tick shapes: ${new Set(orderSig).size}; total rng draws: ${totalDraws}`);

/** Run-length encode: 400 ticks of identical spine strings is 280 KB of the
 *  same sentence, and a reviewer cannot read that. Two distinct shapes today. */
function rle(arr) {
  const out = [];
  for (const v of arr) {
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1] += 1; else out.push([v, 1]);
  }
  return out;
}
function unrle(pairs) {
  const out = [];
  for (const [v, n] of pairs) for (let i = 0; i < n; i++) out.push(v);
  return out;
}

if (RECORD) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify({ ticks: TICKS, orderSig: rle(orderSig), drawSig: rle(drawSig), totalDraws }, null, 1)}\n`);
  console.log(`  recorded baseline → ${BASELINE}`);
}

expect('a baseline exists to compare against', existsSync(BASELINE), 'run with --record on a known-good tree');
if (existsSync(BASELINE)) {
  const raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const base = { ...raw, orderSig: unrle(raw.orderSig), drawSig: unrle(raw.drawSig) };
  expect('tick count matches the baseline', base.ticks === TICKS);

  let firstOrderDiff = -1;
  for (let i = 0; i < Math.min(base.orderSig.length, orderSig.length); i++) {
    if (base.orderSig[i] !== orderSig[i]) { firstOrderDiff = i; break; }
  }
  expect(
    'subsystem order per tick is unchanged',
    firstOrderDiff < 0 && base.orderSig.length === orderSig.length,
    firstOrderDiff < 0 ? '' : [
      `tick ${firstOrderDiff}`,
      `  expected: ${base.orderSig[firstOrderDiff]}`,
      `  actual:   ${orderSig[firstOrderDiff]}`,
    ].join('\n     '),
  );

  let firstDrawDiff = -1;
  for (let i = 0; i < Math.min(base.drawSig.length, drawSig.length); i++) {
    if (base.drawSig[i] !== drawSig[i]) { firstDrawDiff = i; break; }
  }
  expect(
    'rng draws per subsystem per tick are unchanged',
    firstDrawDiff < 0,
    firstDrawDiff < 0 ? '' : [
      `tick ${firstDrawDiff}`,
      `  expected: ${base.drawSig[firstDrawDiff]}`,
      `  actual:   ${drawSig[firstDrawDiff]}`,
    ].join('\n     '),
  );

  expect('total rng draws unchanged', base.totalDraws === totalDraws, `baseline ${base.totalDraws}, now ${totalDraws}`);
}

// A trace that graded nothing is worthless (harness doctrine: VACUOUS = FAIL).
expect('the trace is not empty', perTick.length === TICKS && perTick.every((t) => t.length > 0));
expect('the sim actually drew from the seeded stream', totalDraws > 0, 'no rng draws in 400 ticks — is the match frozen?');

console.log(failures === 0 ? '\nPASS test-tick-order' : `\nFAIL test-tick-order (${failures})`);
process.exit(failures === 0 ? 0 : 1);
