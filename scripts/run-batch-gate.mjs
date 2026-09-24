// THE CUMULATIVE BATCH GATE (b1.3f, critique gap 2, PLAN rule 11 / D36).
//
// A batch gate is the previous batch's gate IN FULL, plus the do-not-regress
// suites, plus the batch's own new suites, plus (for a deploy gate) the live
// block. Those lists live in the campaign plan; this runner is the one program
// that turns them into verdicts, so no gate agent assembles them by hand and
// no gate silently drops a suite an earlier batch was graded on.
//
//   node scripts/run-batch-gate.mjs --sync                 # plan.json -> scripts/fixtures/batch-gates.json
//   node scripts/run-batch-gate.mjs --batch b1 --dry-run   # print the gate, prove it contains b0..b(N-1)
//   node scripts/run-batch-gate.mjs --batch b1 --suites-only
//   node scripts/run-batch-gate.mjs --batch b1 --deploy    # suites, then the LIVE block
//   options: --fresh (ignore saved PASS verdicts), --fixture <json>, --registry <module>,
//            --plan <plan.json>, --results-dir <dir>
//
// WHAT IT GUARANTEES
//  • Every name resolves through scripts/lib/suites.mjs, and the REGISTRY decides
//    the tier (logic / server / browser), never the plan's list it sat in. A name
//    the registry does not know is MISSING at run time (a failure, not a skip),
//    and at --sync it FAILS unless some batch's newInThisBatch declares that a
//    slice will create it (pending). A typo in the plan cannot become a suite
//    that nobody runs.
//  • gate(bN) ⊇ gate(bN-1) is checked at --sync and at every run.
//  • Order: quick tier, logic + server suites one at a time, review checkpoints,
//    then browser suites one at a time on the runner's OWN 3101/8091 stack
//    (never 3000/8090/8080; killed in finally), then conditional suites, then
//    the live block (--deploy) after the stack is down, because csp-boot and
//    the smokes stand up their own 8091.
//  • Resumable: every verdict is written to test-results/gates/<batch>.json the
//    moment it exists. A killed gate agent's successor skips the PASS entries
//    (unless --fresh), EXCEPT when src/, scripts/, public/ or the build config
//    changed since the commit that PASS was earned at.
//  • Exit 0 only when the whole gate is green. 1 = any FAIL / VACUOUS / TIMEOUT /
//    ERROR / MISSING (VACUOUS = exit 0 with no ✓/✗/PASS/FAIL/OK: line, which is
//    not a pass). 3 = blocked on an owner step (fly sign-in, O1). 4 = a deploy
//    gate whose live block was not run (pass --deploy, or --suites-only to ask
//    for the suites alone and get 0 on green).
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const PLAN = abs(arg('plan', process.env.PIRATES_BR_PLAN ?? '/Users/tobiasdicker/.claude/pirates-br-audit/2026-09-22/plan.json'));
const FIXTURE = abs(arg('fixture', 'scripts/fixtures/batch-gates.json'));
const REGISTRY = abs(arg('registry', 'scripts/lib/suites.mjs'));
const RESULTS_DIR = abs(arg('results-dir', 'test-results/gates'));
const DEFAULT_EVIDENCE = /(^|\s)(✓|✗|PASS\b|FAIL\b|OK:)/m;

const reg = await import(pathToFileURL(REGISTRY).href);
const EVIDENCE = reg.EVIDENCE ?? DEFAULT_EVIDENCE;
const TIER_TIMEOUT_MS = reg.TIER_TIMEOUT_MS ?? { logic: 120_000, server: 120_000, browser: 900_000 };
const REGISTERED = reg.ALL ?? [];

/**
 * THE LIVE BLOCK, as commands. The plan states it in prose; every prose item
 * must match exactly one step here or --sync fails, so a new live requirement
 * cannot be added to the plan without somebody deciding what runs it.
 * `fly: true` steps need an authenticated flyctl (owner step O1).
 */
const LIVE_STEPS = [
  { id: 'logic-all', match: /^run-all-tests --logic/, cmds: [['node', 'scripts/run-all-tests.mjs', '--logic'], ['node', 'scripts/run-all-tests.mjs', '--server']] },
  { id: 'csp-boot', match: /^CSP boot check/, cmds: [['npx', 'vite', 'build'], ['node', 'scripts/postbuild-compress.mjs'], ['node', 'scripts/probes/csp-boot-probe.mjs']] },
  { id: 'error-census', match: /bot-match error census/, cmds: [['node', 'scripts/probes/error-census.mjs', '--minutes', '5']] },
  { id: 'webkit-smoke', match: /^probes\/webkit-smoke/, cmds: [['node', 'scripts/probes/webkit-smoke.mjs']] },
  { id: 'deploy', match: /^deploy: /, fly: true, cmds: [['node', 'scripts/fly-launch.mjs', '--only', 'preflight,deploy,status']] },
  { id: 'smoke-live', match: /^smoke-online --url/, fly: true, cmds: [['node', 'scripts/fly-launch.mjs', '--only', 'smoke']],
    onFail: 'RED SMOKE ON THE LIVE APP: redeploy the previous image now (DEPLOY.md "Rollback": fly deploy --image <previous> --ha=false), then smoke again.' },
  { id: 'capacity', match: /^capacity re-measure/, fly: true, cmds: [['node', 'scripts/perf-server-load.mjs', '--report'], ['node', 'scripts/fly-launch.mjs', '--only', 'soak,stamp']] },
  { id: 'deploy-config', match: /^test-deploy-config/, cmds: [['node', 'scripts/test-deploy-config.mjs', '--require-measured']] },
  { id: 'cross-device', match: /^smoke-cross-device/, fly: true, cmds: [['node', 'scripts/smoke-cross-device.mjs']] },
  // Not a command: the order rule. Green only when every earlier live step is PASS
  // at this run, so "announce the URL" can be read straight off the results file.
  { id: 'announce', match: /^announce the URL/, cmds: [], afterAllPass: true },
];
const liveStepFor = (prose) => LIVE_STEPS.filter((s) => s.match.test(prose));

// ── resolution ──────────────────────────────────────────────────────────────

/** A gate name may carry arguments for its suite: `probes/throttled-load-probe
 *  --rows A` (OD1). Only `--flag` / `--flag value` tokens of plain characters
 *  count as arguments; anything else is part of a prose name. */
const ARG_TAIL = /^(\S+)((?:\s+--[\w-]+(?:=[\w.,-]+)?(?:\s+(?!--)[\w.,-]+)?)+)$/;
function splitArgs(name) {
  const m = ARG_TAIL.exec(name);
  return m ? { base: m[1], args: m[2].trim().split(/\s+/) } : { base: name, args: [] };
}

/** name -> registry entry, with the name's arguments appended to its command.
 *  `test-x:browser` picks the browser-tier entry of test-x.mjs; `probes/x` is
 *  scripts/probes/x.mjs; aliases map prose names ("viewmodel-states probe")
 *  onto a registered suite once one exists. */
function resolve(name, aliases = {}, retired = {}) {
  const n = aliases[name] ?? retired[name] ?? name;
  const { base: b, args } = splitArgs(n);
  const [base, variant] = b.split(':');
  const hit = REGISTERED.find((s) => s.file === `${base}.mjs` && (!variant || s.kind === variant)) ?? null;
  return hit && args.length ? { ...hit, cmd: [...hit.cmd, ...args] } : hit;
}

function gateNames(b) { return [...b.suites, ...b.conditional.map((c) => c.name)]; }

/** `--rows` values of a gate name as a set (null when the name has none). */
function rowsOf(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rows') return new Set(String(args[i + 1] ?? '').split(','));
    if (args[i].startsWith('--rows=')) return new Set(args[i].slice(7).split(','));
  }
  return null;
}
/** Does a gate holding `cur` still run `name`? Identical names do; so does the
 *  same suite with the same other arguments and a `--rows` superset (OD1:
 *  `--rows A,B` in b4 covers b3's `--rows A`; dropping a row is a violation). */
function covers(cur, name) {
  if (cur.has(name)) return true;
  const p = splitArgs(name);
  const pRows = rowsOf(p.args);
  if (!pRows) return false;
  const rest = (a) => a.filter((x, i) => x !== '--rows' && a[i - 1] !== '--rows' && !x.startsWith('--rows=')).join(' ');
  for (const c of cur) {
    const q = splitArgs(c);
    const qRows = rowsOf(q.args);
    if (q.base !== p.base || !qRows || rest(q.args) !== rest(p.args)) continue;
    if ([...pRows].every((r) => qRows.has(r))) return true;
  }
  return false;
}

/** gate(bN) ⊇ gate(bN-1) for every batch up to `upTo`. Returns the violations. */
function supersetViolations(batches, upTo = batches.length - 1) {
  const out = [];
  for (let i = 1; i <= upTo; i++) {
    const cur = new Set(gateNames(batches[i]));
    for (const n of gateNames(batches[i - 1])) if (!covers(cur, n)) out.push(`${batches[i].id} drops ${n} (in ${batches[i - 1].id})`);
  }
  return out;
}

// ── --sync ──────────────────────────────────────────────────────────────────

function sync() {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const old = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : {};
  const aliases = old.aliases ?? {};
  const retired = plan.retiredSuites ?? {};
  const planned = new Map();
  for (const b of plan.batches) for (const n of b.gate.newInThisBatch ?? []) if (!planned.has(n)) planned.set(n, b.id);
  const errors = [];
  const pending = new Set();
  const batches = plan.batches.map((b) => {
    const g = b.gate;
    const suites = [...new Set([...(g.suites ?? []), ...(g.browserSuites ?? [])])];
    for (const n of suites) {
      if (resolve(n, aliases, retired)) continue;
      if (planned.has(n)) pending.add(n);
      else errors.push(`${b.id}: '${n}' is not registered in scripts/lib/suites.mjs and no batch's newInThisBatch creates it`);
    }
    const live = g.deploy ? (g.live ?? plan.liveBlock ?? []) : [];
    const liveSteps = [];
    for (const prose of live) {
      const m = liveStepFor(prose);
      if (m.length !== 1) errors.push(`${b.id}: live item matches ${m.length} runner steps (need 1): ${prose.slice(0, 80)}`);
      else liveSteps.push(m[0].id);
    }
    return {
      id: b.id,
      deploy: !!g.deploy,
      quickTier: !!g.quickTier,
      suites,
      conditional: Object.entries(g.conditionalSuites ?? {}).map(([name, when]) => ({ name, when })),
      reviews: (g.reviews ?? []).map((r) => {
        const id = String(r).split(' ')[0];
        const cp = (plan.reviewCheckpoints ?? []).find((c) => c.id === id);
        return { id, report: cp ? cp.report.replace('$D', plan.campaignDir ?? path.dirname(PLAN)).replace(/\/+/g, '/') : null };
      }),
      liveSteps,
    };
  });
  errors.push(...supersetViolations(batches));
  if (errors.length) {
    for (const e of errors) console.log(`✗ ${e}`);
    console.log(`FAIL sync: ${errors.length} problem(s); ${FIXTURE} NOT written`);
    process.exit(1);
  }
  const out = {
    about: 'Cumulative batch gates, synced from the campaign plan by `node scripts/run-batch-gate.mjs --sync`. Do not hand-edit the batches; `aliases` (prose name -> registered suite) is kept across syncs.',
    plan: PLAN,
    planGeneratedAt: plan.generatedAt ?? null,
    aliases,
    retired,
    batches,
  };
  writeFileSync(FIXTURE, `${JSON.stringify(out, null, 1)}\n`);
  for (const b of batches) console.log(`✓ ${b.id}: ${b.suites.length} suites, ${b.conditional.length} conditional, ${b.reviews.length} reviews, live [${b.liveSteps.join(', ')}]`);
  console.log(`OK: synced ${batches.length} batches -> ${path.relative(ROOT, FIXTURE)} (${pending.size} distinct names pending a slice that creates them)`);
  process.exit(0);
}

if (has('sync')) sync();

// ── load the gate ───────────────────────────────────────────────────────────

const BATCH = arg('batch');
if (!BATCH) { console.error('usage: run-batch-gate.mjs --sync | --batch bN [--dry-run] [--deploy|--suites-only] [--fresh]'); process.exit(2); }
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const idx = fixture.batches.findIndex((b) => b.id === BATCH);
if (idx < 0) { console.error(`no batch ${BATCH} in ${FIXTURE}`); process.exit(2); }
const gate = fixture.batches[idx];
const aliases = fixture.aliases ?? {};
const retired = fixture.retired ?? {};
const sup = supersetViolations(fixture.batches, idx);
if (sup.length) {
  for (const v of sup) console.log(`✗ not cumulative: ${v}`);
  console.log(`FAIL ${BATCH}: the gate is not a superset of the previous batch gate`);
  process.exit(1);
}

const plan = gate.suites.map((name) => ({ name, entry: resolve(name, aliases, retired) }));
const kindOf = (p) => p.entry?.kind ?? 'missing';

if (has('dry-run')) {
  console.log(`[gate] ${BATCH}: ${gate.suites.length} suites (cumulative over ${fixture.batches.slice(0, idx).map((b) => b.id).join(', ') || 'nothing'})`);
  for (const p of plan) console.log(`  SUITE ${p.name}  ${kindOf(p)}${p.entry ? '' : '  (not registered yet: MISSING at run time)'}`);
  for (const c of gate.conditional) console.log(`  CONDITIONAL ${c.name}  (${c.when})`);
  for (const r of gate.reviews) console.log(`  REVIEW ${r.id}  ${r.report}`);
  for (const s of gate.liveSteps) console.log(`  LIVE ${s}`);
  const missing = plan.filter((p) => !p.entry).length;
  console.log(`✓ ${BATCH} ⊇ ${idx ? fixture.batches[idx - 1].id : '(first batch)'}; ${plan.length - missing} registered, ${missing} not yet`);
  process.exit(0);
}

// ── results (resumable) ─────────────────────────────────────────────────────

mkdirSync(RESULTS_DIR, { recursive: true });
const RESULTS = path.join(RESULTS_DIR, `${BATCH}.json`);
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const HEAD = git('rev-parse', 'HEAD') ?? 'unknown';
const saved = !has('fresh') && existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : null;
const state = { batch: BATCH, head: HEAD, startedAt: saved?.startedAt ?? new Date().toISOString(), entries: saved?.entries ?? {} };
const CODE_PATHS = ['src', 'scripts', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'Dockerfile', 'fly.toml'];
const staleCache = new Map();
/** A PASS earned at another commit still counts only if nothing that can change
 *  a verdict moved since. Unknown commit (rebased away) = stale. */
function stillValid(entry) {
  if (entry?.verdict !== 'PASS') return false;
  if (entry.head === HEAD) return true;
  if (!staleCache.has(entry.head)) {
    const diff = git('diff', '--name-only', entry.head, HEAD, '--', ...CODE_PATHS);
    staleCache.set(entry.head, diff === '');
  }
  return staleCache.get(entry.head);
}
function save() {
  state.updatedAt = new Date().toISOString();
  const tmp = `${RESULTS}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, RESULTS);
}
function record(key, r) {
  state.entries[key] = { verdict: r.verdict, ms: r.ms ?? 0, head: HEAD, at: new Date().toISOString(), ...(r.detail ? { detail: r.detail } : {}), ...(r.logPath ? { log: path.relative(ROOT, r.logPath) } : {}) };
  save();
  console.log(`  ${r.verdict.padEnd(8)} ${((r.ms ?? 0) / 1000).toFixed(1).padStart(6)}s  ${key}${r.detail ? `  (${r.detail})` : ''}`);
}

// ── running ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(RESULTS_DIR, `${BATCH}-logs`);
if (!process.env.PIRATES_BR_STATS_PATH) {
  process.env.PIRATES_BR_STATS_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'pbr-gate-stats-')), 'stats.json');
}

/** One command, niced, with a silence-proof timeout and the evidence rule. */
function runCmd(key, cmd, env, limit) {
  return new Promise((resolveP) => {
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, `${key.replace(/[^a-z0-9.-]+/gi, '_')}.log`);
    const log = createWriteStream(logPath, { flags: 'a' });
    const t0 = Date.now();
    const nice = process.platform === 'darwin' ? ['taskpolicy', '-c', 'utility', 'nice', '-n', '15'] : ['nice', '-n', '15'];
    const child = spawn(nice[0], [...nice.slice(1), ...cmd], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let evidence = false;
    let notGraded = null;
    const watch = (c) => {
      const s = c.toString();
      if (!evidence && EVIDENCE.test(s)) evidence = true;
      if (notGraded === null) { const m = /^\s*SUITE-NOT-GRADED:\s*(.+)$/m.exec(s); if (m) notGraded = m[1].trim(); }
    };
    child.stdout.on('data', watch); child.stderr.on('data', watch);
    child.stdout.pipe(log); child.stderr.pipe(log);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, limit);
    child.on('error', (e) => { clearTimeout(timer); resolveP({ verdict: 'ERROR', ms: Date.now() - t0, logPath, detail: e.message }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      let verdict;
      if (signal === 'SIGKILL' && ms >= limit - 2000) verdict = 'TIMEOUT';
      else if (code !== 0) verdict = 'FAIL';
      else if (notGraded) verdict = 'SKIPPED';
      else if (!evidence) verdict = 'VACUOUS';
      else verdict = 'PASS';
      resolveP({ verdict, ms, logPath, detail: notGraded ?? (verdict === 'FAIL' ? `exit ${code}` : undefined) });
    });
  });
}

const timeoutFor = (s) => Number(process.env.PIRATES_SUITE_TIMEOUT_MS) || s.timeoutMs || TIER_TIMEOUT_MS[s.kind] || 900_000;
const BAD = new Set(['FAIL', 'VACUOUS', 'TIMEOUT', 'ERROR', 'MISSING', 'BLOCKED']);

async function runSuite(p, env) {
  if (stillValid(state.entries[p.name])) { console.log(`  PASS*    ${'saved'.padStart(7)}  ${p.name}  (PASS at ${state.entries[p.name].head.slice(0, 8)}, skipped; --fresh re-runs)`); return; }
  if (!p.entry) { record(p.name, { verdict: 'MISSING', detail: 'not registered in scripts/lib/suites.mjs' }); return; }
  const s = p.entry;
  // The gate NAMES this suite, so an opt-in switch is flipped on, never skipped.
  const extra = s.optIn ? { [s.optIn]: '1' } : {};
  if (s.skipOn === 'software' && (env.PIRATES_GL ?? 'swiftshader') !== 'metal') { record(p.name, { verdict: 'SKIPPED', detail: s.why }); return; }
  record(p.name, await runCmd(p.name, s.cmd, { ...env, ...extra }, timeoutFor(s)));
}

// Browser stack: the runner's own 3101/8091, pinned seed, SwiftShader. Never 3000/8090/8080.
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
if (['3000', '8090', '8080'].includes(SERVER_PORT) || ['3000', '8090', '8080'].includes(CLIENT_PORT)) { console.error('✗ refusing 3000/8090/8080 (the owner plays there; 8080 corrupts WebSockets)'); process.exit(2); }
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const stack = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 404; } catch { return false; } }
async function standUp(name, command, url, env) {
  if (await isUp(url)) throw new Error(`${url} is already answering: a gate grades only a stack it started (stop it first)`);
  mkdirSync(LOG_DIR, { recursive: true });
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const log = createWriteStream(path.join(LOG_DIR, `stack-${name}.log`));
  child.stdout.pipe(log); child.stderr.pipe(log);
  stack.push(child);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(600)) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened`);
    if (await isUp(url)) return;
  }
  throw new Error(`${name} never answered ${url}`);
}
function teardown() { for (const c of stack.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } } } }
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

const flyAuthed = () => { for (const bin of ['fly', 'flyctl']) { try { execFileSync(bin, ['auth', 'whoami'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { /* next */ } } return false; };

let code = 0;
let blocked = false;
let liveRan = false;
try {
  console.log(`[gate] ${BATCH} at ${HEAD.slice(0, 12)}: ${plan.length} suites, results ${path.relative(ROOT, RESULTS)}${saved ? ' (resuming)' : ''}`);
  if (gate.quickTier) {
    if (stillValid(state.entries['pre:typecheck'])) console.log('  PASS*    saved  pre:typecheck');
    else record('pre:typecheck', await runCmd('pre:typecheck', ['npm', 'run', 'typecheck'], {}, 300_000).then((r) => (r.verdict === 'VACUOUS' ? { ...r, verdict: 'PASS' } : r)));
    if (stillValid(state.entries['pre:quick'])) console.log('  PASS*    saved  pre:quick');
    else record('pre:quick', await runCmd('pre:quick', ['node', 'scripts/run-all-tests.mjs', '--quick'], {}, 300_000));
  }
  const early = plan.filter((p) => kindOf(p) !== 'browser');
  const late = plan.filter((p) => kindOf(p) === 'browser');
  console.log(`[gate] ── ${early.length} logic/server suites (missing names graded MISSING here) ──`);
  for (const p of early) await runSuite(p, kindOf(p) === 'server' ? { PIRATES_BR_TEST_PORT: '0', PIRATES_BR_DEV_HOOKS: '1' } : {});
  for (const r of gate.reviews) {
    let v = { verdict: 'MISSING', detail: `no review report at ${r.report}` };
    try { const rep = JSON.parse(readFileSync(r.report, 'utf8')); v = /^PASS/i.test(String(rep.verdict ?? '')) ? { verdict: 'PASS' } : { verdict: 'FAIL', detail: `verdict ${rep.verdict}` }; } catch { /* missing */ }
    record(`review:${r.id}`, v);
  }
  const cond = gate.conditional.map((c) => ({ name: c.name, when: c.when, entry: resolve(c.name, aliases, retired) }));
  const browserTodo = [...late, ...cond.filter((c) => c.entry?.kind === 'browser')].filter((p) => !stillValid(state.entries[p.name]));
  if (browserTodo.length) {
    console.log(`[gate] ── ${late.length} browser suites, one at a time, own stack ${CLIENT_PORT}/${SERVER_PORT}, seed ${MAP_SEED} ──`);
    await standUp('server', 'npm run dev:server', HEALTH_URL, { PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_BR_DEV_HOOKS: '1' });
    await standUp('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, { PIRATES_BR_SERVER_PORT: SERVER_PORT });
  }
  const benv = { PIRATES_BR_URL: CLIENT_URL, PIRATES_BR_TEST_URL: CLIENT_URL, LOAD_URL: CLIENT_URL, PIRATES_BR_SERVER_PORT: SERVER_PORT, PIRATES_BR_SERVER_HEALTH_URL: HEALTH_URL, PIRATES_BR_MAP_SEED: MAP_SEED, PIRATES_GL: process.env.PIRATES_GL ?? 'swiftshader' };
  for (const p of late) await runSuite(p, benv);
  // CONDITIONAL: the plan's condition is "a slice ran", and that slice is what
  // registers the suite, so registered = triggered. Unregistered = not triggered.
  for (const c of cond) {
    if (!c.entry) { console.log(`  SKIPPED  ${'—'.padStart(7)}  ${c.name}  (conditional, not registered: ${c.when})`); continue; }
    await runSuite(c, c.entry.kind === 'browser' ? benv : c.entry.kind === 'server' ? { PIRATES_BR_TEST_PORT: '0', PIRATES_BR_DEV_HOOKS: '1' } : {});
  }
  teardown();

  if (gate.deploy && has('deploy')) {
    liveRan = true;
    console.log(`[gate] ── live block: ${gate.liveSteps.join(' -> ')} ──`);
    let authed = null;
    for (const id of gate.liveSteps) {
      const key = `live:${id}`;
      const step = LIVE_STEPS.find((s) => s.id === id);
      if (stillValid(state.entries[key])) { console.log(`  PASS*    saved  ${key}`); continue; }
      const missing = step?.cmds.flat().find((a) => /^scripts\/.*\.mjs$/.test(a) && !existsSync(path.join(ROOT, a)));
      if (!step || missing) { record(key, { verdict: 'MISSING', detail: missing ? `${missing} does not exist` : 'no runner step' }); continue; }
      if (step.fly) {
        authed ??= flyAuthed();
        if (!authed) { blocked = true; record(key, { verdict: 'BLOCKED', detail: 'fly auth whoami fails: owner step O1 (sign in to Fly once)' }); break; }
      }
      let r = { verdict: 'PASS', ms: 0 };
      if (step.afterAllPass) {
        const prior = gate.liveSteps.slice(0, gate.liveSteps.indexOf(id)).filter((p) => state.entries[`live:${p}`]?.verdict !== 'PASS');
        if (prior.length) r = { verdict: 'FAIL', ms: 0, detail: `do NOT announce the URL: ${prior.join(', ')} not green` };
        else console.log('  ✓ every live step green: the URL may be announced');
      }
      for (const cmd of step.cmds) {
        const one = await runCmd(key, cmd, {}, 3_600_000);
        r = { ...one, ms: r.ms + one.ms };
        // build steps print no ✓ lines; a command that is not a grader passes on exit 0
        if (one.verdict === 'VACUOUS' && cmd !== step.cmds[step.cmds.length - 1]) r.verdict = 'PASS';
        if (r.verdict !== 'PASS') break;
      }
      record(key, r);
      if (r.verdict !== 'PASS') { if (step.onFail) console.log(`  ✗ ${step.onFail}`); if (step.fly) break; }
    }
  }
} catch (e) {
  console.log(`✗ gate aborted: ${e.message}`);
  code = 1;
} finally {
  teardown();
}

const want = [
  ...(gate.quickTier ? ['pre:typecheck', 'pre:quick'] : []),
  ...plan.map((p) => p.name),
  ...gate.reviews.map((r) => `review:${r.id}`),
  ...gate.conditional.filter((c) => state.entries[c.name]).map((c) => c.name),
  ...(liveRan ? gate.liveSteps.map((s) => `live:${s}`) : []),
];
const tally = {};
for (const k of want) { const v = state.entries[k]?.verdict ?? 'NOT-RUN'; tally[v] = (tally[v] ?? 0) + 1; }
const bad = want.filter((k) => BAD.has(state.entries[k]?.verdict) || !state.entries[k]);
state.summary = { tally, bad, liveRan, finishedAt: new Date().toISOString() };
save();
console.log(`\n[gate] ${BATCH}: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
if (bad.length) { console.log(`✗ ${bad.length} not green: ${bad.slice(0, 20).join(', ')}${bad.length > 20 ? ' ...' : ''}`); code = 1; }
if (blocked) { console.log('FAIL: blocked on owner step O1 (fly sign-in); rerun with --deploy after `fly auth login`'); process.exit(3); }
if (code) { console.log(`FAIL ${BATCH} gate`); process.exit(1); }
if (gate.deploy && !liveRan && !has('suites-only')) { console.log(`FAIL ${BATCH} gate INCOMPLETE: suites green, live block not run (--deploy)`); process.exit(4); }
console.log(`PASS ${BATCH} gate${liveRan ? ' incl. the live block' : ' (suites only)'}`);
process.exit(0);
