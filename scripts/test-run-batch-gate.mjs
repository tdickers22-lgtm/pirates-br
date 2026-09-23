// GATE FOR THE GATE RUNNER (b1.3f, critique gap 2). Logic tier, no ports, no browser.
//
// scripts/run-batch-gate.mjs is what every batch gate agent runs, so if it can
// drop a suite, call a silent exit 0 a pass, forget a verdict or re-run a green
// hour of suites after a kill, the whole campaign's "gate" is a story. Graded:
//   A  the committed scripts/fixtures/batch-gates.json matches a fresh --sync of
//      the campaign plan (when the plan is on this machine)
//   B  --dry-run for b1..b5 lists every fixture suite, exits 0, and the LISTED
//      sets are cumulative (checked here, independently of the runner)
//   C  a fixture whose b2 drops a b1 suite: --dry-run b2 FAILS and names it
//   D  --sync of a plan naming an unregistered, un-planned suite FAILS and writes
//      nothing; the same name declared in newInThisBatch syncs (pending); a plan
//      whose gates are not cumulative FAILS the sync
//   E  a fake registry: one failing suite -> exit 1; the re-run skips the PASS
//      entry and re-runs the FAIL; --fresh re-runs both; a stale PASS (earned
//      before scripts/ changed) is re-run; VACUOUS, TIMEOUT, MISSING and a
//      failed review each fail; server suites get port 0; a deploy gate without
//      --deploy exits 4, with --suites-only 0
//
//   node scripts/test-run-batch-gate.mjs            (RUNNER=<path> grades another copy)
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = process.env.RUNNER ? path.resolve(process.env.RUNNER) : path.join(ROOT, 'scripts', 'run-batch-gate.mjs');
const PLAN = process.env.PIRATES_BR_PLAN ?? '/Users/tobiasdicker/.claude/pirates-br-audit/2026-09-22/plan.json';
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'batch-gates.json');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'pbr-gate-test-'));

let fails = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { fails++; console.log(`  ✗ ${msg}${detail ? `  [${String(detail).slice(0, 400)}]` : ''}`); }
};
const run = (...args) => {
  const r = spawnSync('node', [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const tmp = (name, obj) => { const p = path.join(TMP, name); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const names = (b) => [...b.suites, ...b.conditional.map((c) => c.name)];

console.log('A  fixture in sync with the plan');
if (existsSync(PLAN)) {
  const out = path.join(TMP, 'synced.json');
  const r = run('--sync', '--plan', PLAN, '--fixture', out);
  ok(r.code === 0, '--sync of the campaign plan exits 0', r.out.split('\n').filter((l) => l.includes('✗')).join(' | '));
  if (r.code === 0) {
    const fresh = JSON.parse(readFileSync(out, 'utf8'));
    const same = JSON.stringify(fresh.batches) === JSON.stringify(fixture.batches);
    ok(same, 'committed scripts/fixtures/batch-gates.json == a fresh sync (re-run --sync after a plan change)');
  }
} else {
  console.log(`  - ${PLAN} not on this machine: clause A not graded here (B-E still are)`);
}

console.log('B  dry-run b1..b5');
let prev = null;
for (const b of fixture.batches) {
  const r = run('--batch', b.id, '--dry-run');
  const listed = [...r.out.matchAll(/^ {2}(?:SUITE|CONDITIONAL) (.+?) {2}/gm)].map((m) => m[1]);
  ok(r.code === 0, `${b.id} --dry-run exits 0`, r.out.slice(-300));
  ok(listed.length === names(b).length && names(b).every((n) => listed.includes(n)), `${b.id} lists every one of its ${names(b).length} suites`, `listed ${listed.length}`);
  if (prev) {
    const cur = new Set(listed);
    const dropped = prev.listed.filter((n) => !cur.has(n));
    ok(dropped.length === 0, `gate(${b.id}) ⊇ gate(${prev.id}) (${listed.length} ⊇ ${prev.listed.length})`, dropped.join(', '));
  }
  prev = { id: b.id, listed };
}
ok(fixture.batches.length >= 5 && fixture.batches[0].suites.length >= 100, `the fixture carries b1..b5 (${fixture.batches.length} batches, b1 = ${fixture.batches[0]?.suites.length} suites)`);

console.log('C  a non-cumulative fixture is refused');
{
  const mut = JSON.parse(JSON.stringify(fixture));
  const victim = mut.batches[0].suites[3];
  mut.batches[1].suites = mut.batches[1].suites.filter((n) => n !== victim);
  const r = run('--batch', 'b2', '--dry-run', '--fixture', tmp('mut-fixture.json', mut));
  ok(r.code !== 0 && r.out.includes(`drops ${victim}`), `b2 without b1's ${victim}: dry-run exits ${r.code} and names it`, r.out.slice(-300));
}

console.log('D  --sync refuses unregistered and non-cumulative plans');
{
  const gate = (suites, extra = {}) => ({ suites, browserSuites: [], newInThisBatch: [], deploy: false, ...extra });
  const bad = tmp('plan-bad.json', { batches: [{ id: 'x1', gate: gate(['test-deploy-config', 'test-no-such-suite-zz']) }] });
  const outBad = path.join(TMP, 'fx-bad.json');
  let r = run('--sync', '--plan', bad, '--fixture', outBad);
  ok(r.code !== 0 && r.out.includes('test-no-such-suite-zz') && !existsSync(outBad), `unregistered 'test-no-such-suite-zz': sync exits ${r.code}, names it, writes nothing`, r.out.slice(-300));
  const planned = tmp('plan-planned.json', { batches: [{ id: 'x1', gate: gate(['test-deploy-config', 'test-no-such-suite-zz'], { newInThisBatch: ['test-no-such-suite-zz'] }) }] });
  r = run('--sync', '--plan', planned, '--fixture', path.join(TMP, 'fx-planned.json'));
  ok(r.code === 0, 'the same name declared in newInThisBatch syncs as pending', r.out.slice(-300));
  const shrink = tmp('plan-shrink.json', { batches: [{ id: 'x1', gate: gate(['test-deploy-config', 'test-smoke-online']) }, { id: 'x2', gate: gate(['test-deploy-config']) }] });
  r = run('--sync', '--plan', shrink, '--fixture', path.join(TMP, 'fx-shrink.json'));
  ok(r.code !== 0 && r.out.includes('x2 drops test-smoke-online'), `x2 drops x1's test-smoke-online: sync exits ${r.code}`, r.out.slice(-300));
  const live = tmp('plan-live.json', { batches: [{ id: 'x1', gate: gate(['test-deploy-config'], { deploy: true, live: ['sacrifice a goat to the uptime gods'] }) }] });
  r = run('--sync', '--plan', live, '--fixture', path.join(TMP, 'fx-live.json'));
  ok(r.code !== 0 && r.out.includes('matches 0 runner steps'), 'a live-block item no runner step implements FAILS the sync', r.out.slice(-300));
}

console.log('E  running, resuming, verdicts');
{
  const counter = path.join(TMP, 'counter.txt');
  writeFileSync(counter, '');
  const js = (body) => ['node', '-e', `const fs=require('fs');${body}`];
  const registry = tmp('fake-suites.mjs', `export const TIER_TIMEOUT_MS = { logic: 20000, server: 20000, browser: 20000 };
export const ALL = ${JSON.stringify([
    { file: 'pass-a.mjs', kind: 'logic', cmd: js(`fs.appendFileSync(${JSON.stringify(counter)},'a');console.log('✓ a')`) },
    { file: 'fail-b.mjs', kind: 'logic', cmd: js(`fs.appendFileSync(${JSON.stringify(counter)},'b');console.log('✗ b');process.exit(1)`) },
    { file: 'vac-c.mjs', kind: 'logic', cmd: js('console.log("ran, asserted nothing")') },
    { file: 'slow-d.mjs', kind: 'logic', timeoutMs: 1500, cmd: js('setTimeout(()=>{},20000)') },
    { file: 'srv-e.mjs', kind: 'server', cmd: js(`console.log(process.env.PIRATES_BR_TEST_PORT==='0'?'✓ port 0':'✗ no port 0');process.exit(process.env.PIRATES_BR_TEST_PORT==='0'?0:1)`) },
  ])};\n`);
  const review = tmp('review.json', { verdict: 'FAIL: faces read as blobs' });
  const b = (id, suites, extra = {}) => ({ id, deploy: false, quickTier: false, suites, conditional: [], reviews: [], liveSteps: [], ...extra });
  const fx = tmp('fake-fixture.json', {
    aliases: {}, retired: {},
    batches: [
      b('f1', ['pass-a', 'fail-b']),
      b('f2', ['pass-a', 'fail-b', 'vac-c', 'slow-d', 'srv-e', 'not-there'], { conditional: [{ name: 'cond-x', when: 'never' }], reviews: [{ id: 'R9', report: review }] }),
      b('f3', ['pass-a', 'fail-b', 'vac-c', 'slow-d', 'srv-e', 'not-there'], { deploy: true }),
    ],
  });
  const f3 = tmp('fake-fixture-f3.json', { aliases: {}, retired: {}, batches: [b('f3', ['pass-a', 'srv-e'], { deploy: true, liveSteps: ['logic-all'] })] });
  const resDir = path.join(TMP, 'gates');
  const g = (...a) => run('--registry', registry, '--results-dir', resDir, ...a);
  const res = (batch) => JSON.parse(readFileSync(path.join(resDir, `${batch}.json`), 'utf8'));

  let r = g('--fixture', fx, '--batch', 'f1');
  ok(r.code === 1, `one failing suite: exit ${r.code} (want 1)`, r.out.slice(-300));
  ok(res('f1').entries['pass-a']?.verdict === 'PASS' && res('f1').entries['fail-b']?.verdict === 'FAIL', 'per-suite verdicts written to <results>/f1.json (pass-a PASS, fail-b FAIL)');
  ok(readFileSync(counter, 'utf8') === 'ab', 'first run executed both suites', readFileSync(counter, 'utf8'));
  r = g('--fixture', fx, '--batch', 'f1');
  ok(r.code === 1 && readFileSync(counter, 'utf8') === 'abb', 're-run skips the PASS entry and re-runs the FAIL (counter ab -> abb)', readFileSync(counter, 'utf8'));
  r = g('--fixture', fx, '--batch', 'f1', '--fresh');
  ok(readFileSync(counter, 'utf8') === 'abbab', '--fresh re-runs the PASS entry too', readFileSync(counter, 'utf8'));
  // a PASS earned before scripts/ changed is not a PASS now
  const old = execFileSync('git', ['log', '-1', '--format=%H', 'HEAD~1', '--', 'scripts'], { cwd: ROOT }).toString().trim();
  const saved = res('f1');
  saved.entries['pass-a'].head = old;
  writeFileSync(path.join(resDir, 'f1.json'), JSON.stringify(saved));
  r = g('--fixture', fx, '--batch', 'f1');
  ok(readFileSync(counter, 'utf8') === 'abbabab', `a PASS saved at ${old.slice(0, 8)} (scripts/ changed since) is re-run`, readFileSync(counter, 'utf8'));

  r = g('--fixture', fx, '--batch', 'f2');
  const e = res('f2').entries;
  ok(r.code === 1, `f2 exits ${r.code} (want 1)`);
  ok(e['vac-c']?.verdict === 'VACUOUS', `exit 0 with no ✓/✗ line is VACUOUS (${e['vac-c']?.verdict})`);
  ok(e['slow-d']?.verdict === 'TIMEOUT', `a suite past its timeout is TIMEOUT (${e['slow-d']?.verdict})`);
  ok(e['not-there']?.verdict === 'MISSING', `an unregistered name is MISSING, not skipped (${e['not-there']?.verdict})`);
  ok(e['srv-e']?.verdict === 'PASS', `a server suite runs with PIRATES_BR_TEST_PORT=0 (${e['srv-e']?.verdict})`);
  ok(e['review:R9']?.verdict === 'FAIL', `a failed review checkpoint fails the gate (${e['review:R9']?.verdict})`);
  ok(!('cond-x' in e) && /SKIPPED .*cond-x/.test(r.out), 'an unregistered conditional suite is reported as not triggered, not run');
  ok(res('f2').summary?.bad?.length === 5, `summary.bad names the 5 non-green entries (${res('f2').summary?.bad?.join(', ')})`);

  r = g('--fixture', f3, '--batch', 'f3');
  ok(r.code === 4 && /INCOMPLETE/.test(r.out), `a green deploy gate without --deploy exits ${r.code} (want 4, INCOMPLETE)`, r.out.slice(-200));
  r = g('--fixture', f3, '--batch', 'f3', '--suites-only');
  ok(r.code === 0 && /PASS f3 gate \(suites only\)/.test(r.out), `--suites-only on the same green suites exits ${r.code} (want 0)`, r.out.slice(-200));
}

if (fails) { console.log(`\nFAIL test-run-batch-gate: ${fails} clause(s) red`); process.exit(1); }
console.log('\nPASS test-run-batch-gate: all clauses green');
