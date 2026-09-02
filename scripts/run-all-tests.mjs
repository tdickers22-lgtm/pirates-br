#!/usr/bin/env node
// ONE COMMAND FOR THE WHOLE SUITE — `npm test`.
//
// WHAT IT DOES: stands up a game server and a Vite of its own on ports nobody
// plays on, points every suite at them, runs all of them (not just up to the
// first red one), and prints a table with a real verdict per suite.
//
// ── THE FOUR WAYS THIS REPO'S TESTS HAVE LIED, AND WHAT IS DONE ABOUT EACH ───
//
//  1. A SUITE THAT EXITS 0 WITHOUT ASSERTING. `test-perf-budget` did it for a
//     week: it hit a condition it could not measure in, printed a skip, and
//     `return`ed — which exits 0. A run that produces no gradeable line at all
//     is reported VACUOUS here and counts as a failure. See EVIDENCE in
//     lib/suites.mjs.
//  2. A CHAIN THAT STOPS AT THE FIRST FAILURE. `test:logic` was sixty-two
//     commands joined by `&&`, so one red suite hid every suite behind it. The
//     HUD suite sat failing four assertions for a whole wave because nothing
//     ever reached it. Every suite runs; every result is reported.
//  3. A SUITE GRADING SOMEBODY ELSE'S STACK. Pointing PIRATES_BR_URL at a Vite
//     the runner owns used to move the PAGE and not the SOCKET, so the client
//     under test still joined whatever server the developer had up — an
//     unpinned world, and a headless bot in a human's match. The Vite started
//     here bakes its own server's port into the bundle (vite.config.ts), and
//     the server it starts is pinned to PIRATES_BR_MAP_SEED.
//  4. A SUITE NOBODY RUNS. Eight test-shaped files on disk were in no npm
//     script, including both gates for the remote-motion wave. `--audit` walks
//     scripts/ and fails on anything neither listed nor explicitly excluded.
//
// ── AND ONE HOUSE RULE ───────────────────────────────────────────────────────
// ONE SUITE AT A TIME. These run on a fanless laptop whose window server has
// been taken down by concurrent headless GL. Suites are never run in parallel,
// and every child is niced.
//
//   npm test                      # everything: logic, then browser
//   npm run test:quick            # the sub-second logic suites; ≤60 s soft ceiling
//   npm run test:logic            # logic only — no stack, no ports
//   npm run test:server           # the LobbyServer suites (kernel-picked ports)
//   npm run test:browser          # browser only
//   test-results/summary.json     # every run: per-suite verdict + ms, HEAD, slowest 5
//   npm run test:audit            # is every suite on disk accounted for?
//   node scripts/run-all-tests.mjs --only hud,minimap
//   node scripts/run-all-tests.mjs --list
import { execSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL, EVIDENCE, EXCLUDED, TIER_TIMEOUT_MS } from './lib/suites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'test-results');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

/**
 * THE PORTS ARE NOT THE DEVELOPER'S. 3000/8090 is where a human plays; a test
 * run that seizes them evicts him mid-match, and a suite that finds them already
 * up grades a world it did not pin. So the default stack for a graded run is
 * 3101/8091 and it is the runner's own. Point PIRATES_BR_URL at something else
 * and the runner reuses it instead of starting anything.
 *
 * NEVER 8080: this machine's content filter replays the WebSocket upgrade bytes
 * and corrupts every socket served there.
 */
const SERVER_PORT = process.env.PIRATES_BR_SERVER_PORT ?? '8091';
const CLIENT_PORT = process.env.PIRATES_BR_CLIENT_PORT ?? '3101';
const CLIENT_URL = (process.env.PIRATES_BR_URL ?? `http://127.0.0.1:${CLIENT_PORT}`).replace(/\/$/, '');
const HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? `http://127.0.0.1:${SERVER_PORT}/health`;
/** Every perf ceiling in this repo was measured on this world. An unpinned
 *  server rolls a different one and the same build reads 1165 or 2742 draws. */
const MAP_SEED = process.env.PIRATES_BR_MAP_SEED ?? '20260801';
/** Software rasteriser by default: a GPU-backed headless Chromium drives the
 *  real Metal stack through WindowServer and has panicked this machine twice. */
const GL = process.env.PIRATES_GL ?? 'swiftshader';

/** A suite that has not spoken in this long is hung, not slow. Killed and
 *  reported as TIMEOUT — never silently waited on. Sized per tier
 *  (lib/suites.mjs TIER_TIMEOUT_MS) or per suite (`timeoutMs`);
 *  PIRATES_SUITE_TIMEOUT_MS overrides both. */
const TIMEOUT_OVERRIDE_MS = process.env.PIRATES_SUITE_TIMEOUT_MS ? Number(process.env.PIRATES_SUITE_TIMEOUT_MS) : null;
const timeoutFor = (suite) => TIMEOUT_OVERRIDE_MS ?? suite.timeoutMs ?? TIER_TIMEOUT_MS[suite.kind] ?? 900_000;

const started = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stack ────────────────────────────────────────────────────────────────

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404;
  } catch { return false; }
}

/** True when the server answering /health is rolling the world we grade on. */
async function servesPinnedMap() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return String(body.mapSeed ?? '') === String(Number.parseInt(MAP_SEED, 10) >>> 0);
  } catch { return false; }
}

async function ensure(name, command, url, env, timeoutMs = 120_000) {
  if (await isUp(url)) {
    console.log(`[test] ${name} already up at ${url} — reusing it`);
    return;
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `stack-${name}.log`);
  const logFile = createWriteStream(logPath);
  console.log(`[test] starting ${name} → ${url}  (log: ${logPath})`);
  const child = spawn(command, {
    cwd: ROOT, shell: true, detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  started.push({ name, child });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened — see ${logPath}`);
    if (await isUp(url)) { console.log(`[test] ${name} is answering`); return; }
    await sleep(600);
  }
  throw new Error(`${name} never answered ${url} within ${timeoutMs / 1000}s — see ${logPath}`);
}

function teardown() {
  for (const { name, child } of started.splice(0)) {
    console.log(`[test] stopping ${name}`);
    // The whole process group: `vite` and `tsx watch` both fork children that
    // outlive a bare kill() and keep the port bound.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

// ── running one suite ────────────────────────────────────────────────────────

function runSuite(suite, env) {
  return new Promise((resolve) => {
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, `${suite.file.replace(/\.mjs$/, '')}.log`);
    const logFile = createWriteStream(logPath);
    const t0 = Date.now();
    // `taskpolicy -c utility nice -n 15` keeps a suite off the throat of a
    // machine somebody may be using. Not optional on this hardware.
    const child = spawn('taskpolicy', ['-c', 'utility', 'nice', '-n', '15', ...suite.cmd], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let evidence = false;
    let bytes = 0;
    let tail = '';
    const watch = (chunk) => {
      const s = chunk.toString();
      bytes += s.length;
      if (!evidence && EVIDENCE.test(s)) evidence = true;
      tail = (tail + s).slice(-4000);
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.stdout.pipe(logFile);
    child.stderr.pipe(logFile);

    const limit = timeoutFor(suite);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, limit);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ suite, verdict: 'ERROR', code: -1, ms: Date.now() - t0, logPath, detail: err.message, tail });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      let verdict;
      if (signal === 'SIGKILL' && ms >= limit - 2000) verdict = 'TIMEOUT';
      else if (code !== 0) verdict = 'FAIL';
      // Exit 0 having said nothing gradeable is not a pass. It is the single
      // most expensive failure mode in this repo's history.
      else if (!evidence) verdict = 'VACUOUS';
      else verdict = 'PASS';
      resolve({ suite, verdict, code, ms, logPath, bytes, tail });
    });
  });
}

// ── the on-disk audit ────────────────────────────────────────────────────────

function audit() {
  const known = new Set(ALL.map((s) => s.file));
  // EVERY top-level scripts/*.mjs, not just test-shaped names. The old filter
  // (/^(test-|audit-)/ or *smoke.mjs) could not see a file called x-probe.mjs or
  // x-tour.mjs, and 75 of them piled up unseen. The layout now says what a file
  // is: scripts/lib/ shared code, scripts/tools/ doc-cited tooling,
  // scripts/probes/ instruments (read, not graded). A file at the top level is
  // a wired gate, or it is in EXCLUDED with its role, or this fails.
  const onDisk = readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('.') && f !== 'run-all-tests.mjs');
  const orphans = onDisk.filter((f) => !known.has(f) && !(f in EXCLUDED));
  const ghosts = [...known, ...Object.keys(EXCLUDED)].filter((f) => !onDisk.includes(f));
  console.log(`[audit] ${known.size} suites wired, ${Object.keys(EXCLUDED).length} top-level non-gates declared, ${onDisk.length} top-level .mjs files on disk`);
  for (const [f, why] of Object.entries(EXCLUDED)) console.log(`  – not a gate ${f}: ${why}`);
  let bad = 0;
  for (const f of orphans) {
    console.error(`  ✗ FAIL: scripts/${f} is neither a wired suite nor a declared non-gate — wire it in scripts/lib/suites.mjs, list it in EXCLUDED with its role, or move it to scripts/probes/ (instrument) or scripts/tools/ (doc-cited tooling)`);
    bad += 1;
  }
  for (const f of ghosts) {
    console.error(`  ✗ FAIL: the manifest names scripts/${f}, which does not exist`);
    bad += 1;
  }
  if (bad === 0) console.log('  ✓ every top-level scripts/*.mjs is a wired suite or a declared non-gate');
  return bad;
}

// ── main ─────────────────────────────────────────────────────────────────────

const onlyFilter = arg('only');
const pick = (list) => (onlyFilter
  ? list.filter((s) => onlyFilter.split(',').some((f) => s.file.includes(f.trim())))
  : list);

const tier = (kind) => ALL.filter((s) => s.kind === kind);
// One tier per flag: --logic (no stack, no ports), --server (own LobbyServer on
// port 0), --browser (the runner's stack). --quick is the pre-commit subset:
// logic suites tagged `quick` in the manifest, graded against a wall-clock
// ceiling below. No flag runs all three tiers.
const wantQuick = has('quick');
const wantLogic = wantQuick || (!has('browser') && !has('server'));
const wantServer = !wantQuick && !has('browser') && !has('logic');
const wantBrowser = !wantQuick && !has('logic') && !has('server');
const logic = wantLogic ? pick(tier('logic')).filter((s) => !wantQuick || s.quick) : [];
const server = wantServer ? pick(tier('server')) : [];
/** The quick tier's wall-clock budget. A SOFT ceiling: over it prints a
 *  warning (this SwiftShader Air flaps when another agent runs); over TWICE
 *  it is a FAIL, because a "quick" gate nobody waits for is not run. */
const QUICK_BUDGET_MS = Number(process.env.PIRATES_QUICK_BUDGET_MS ?? 60_000);
const RUN_T0 = Date.now();
// Cheap first, machine-owning last: a broken build should be reported in the
// first minute rather than the twentieth.
const browser = wantBrowser
  ? pick(tier('browser')).sort((a, b) => Number(!!a.slow) - Number(!!b.slow))
  : [];

if (has('list')) {
  for (const s of [...logic, ...server, ...browser]) console.log(s.file);
  process.exit(0);
}
if (has('audit')) process.exit(audit() === 0 ? 0 : 1);

const results = [];
let code = 0;
try {
  if (logic.length) {
    console.log(`\n[test] ── ${logic.length} logic suites ──────────────────────────`);
    for (const [i, s] of logic.entries()) {
      // OPT-IN suites (minutes of sim) run only when their env var is 1; reported
      // as SKIPPED otherwise so a missing PACING=1 never reads as a pass.
      if (s.optIn && process.env[s.optIn] !== '1') {
        results.push({ suite: s, verdict: 'SKIPPED', code: 0, ms: 0, detail: s.why });
        console.log(`  ${String(i + 1).padStart(2)}/${logic.length}  SKIPPED ${'—'.padStart(6)}  ${s.file}  (${s.why})`);
        continue;
      }
      const r = await runSuite(s, {});
      results.push(r);
      console.log(`  ${String(i + 1).padStart(2)}/${logic.length}  ${r.verdict.padEnd(7)} ${(r.ms / 1000).toFixed(1)}s  ${s.file}`);
    }
  }

  if (server.length) {
    // Each boots its own LobbyServer on a kernel-picked port: nothing to stand
    // up here, and nothing on disk or in another agent's shell can collide.
    console.log(`\n[test] ── ${server.length} server suites (own LobbyServer, port 0) ──────`);
    for (const [i, s] of server.entries()) {
      const r = await runSuite(s, { PIRATES_BR_TEST_PORT: '0' });
      results.push(r);
      console.log(`  ${String(i + 1).padStart(2)}/${server.length}  ${r.verdict.padEnd(7)} ${(r.ms / 1000).toFixed(1)}s  ${s.file}`);
    }
  }

  if (browser.length) {
    await ensure('server', `npm run dev:server`, HEALTH_URL, {
      PORT: SERVER_PORT, PIRATES_BR_MAP_SEED: MAP_SEED,
    });
    if (!await servesPinnedMap()) {
      // Reused somebody else's server, and it rolls a world these ceilings were
      // not measured on. That is not a state a perf gate can pass or fail in.
      console.error(`\n[test] ✗ the server at ${HEALTH_URL} is not rolling map seed ${MAP_SEED}.`
        + `\n       Stop it, or set PIRATES_BR_SERVER_PORT to a port the runner can own.`);
      throw new Error('server is serving an unpinned world');
    }
    await ensure('client', `npx vite --port ${CLIENT_PORT} --strictPort`, CLIENT_URL, {
      PIRATES_BR_SERVER_PORT: SERVER_PORT,
    });
    console.log(`\n[test] ── ${browser.length} browser suites ────────────────────────`);
    console.log(`[test] client ${CLIENT_URL}  server :${SERVER_PORT}  seed ${MAP_SEED}  gl ${GL}`);
    const env = {
      PIRATES_BR_URL: CLIENT_URL,
      PIRATES_BR_TEST_URL: CLIENT_URL,
      LOAD_URL: CLIENT_URL,
      PIRATES_BR_SERVER_PORT: SERVER_PORT,
      PIRATES_BR_SERVER_HEALTH_URL: HEALTH_URL,
      PIRATES_BR_MAP_SEED: MAP_SEED,
      PIRATES_GL: GL,
    };
    const software = GL === 'swiftshader' || GL === 'software' || GL === 'swangle';
    for (const [i, s] of browser.entries()) {
      // A DECLARED skip. The suite would exit 0 having measured nothing, which
      // is indistinguishable from a pass; saying so here makes it a line in the
      // table that nobody can mistake for one.
      if (s.skipOn === 'software' && software) {
        results.push({ suite: s, verdict: 'SKIPPED', code: 0, ms: 0, detail: s.why });
        console.log(`  ${String(i + 1).padStart(2)}/${browser.length}  SKIPPED ${'—'.padStart(6)}  ${s.file}  (${s.why})`);
        continue;
      }
      const r = await runSuite(s, env);
      results.push(r);
      console.log(`  ${String(i + 1).padStart(2)}/${browser.length}  ${r.verdict.padEnd(7)} ${(r.ms / 1000).toFixed(1)}s  ${s.file}`);
    }
  }
} catch (err) {
  console.error(`\n[test] ${err.message}`);
  code = 1;
} finally {
  teardown();
}

// ── the verdict ──────────────────────────────────────────────────────────────

const skipped = results.filter((r) => r.verdict === 'SKIPPED');
const bad = results.filter((r) => r.verdict !== 'PASS' && r.verdict !== 'SKIPPED');
const passed = results.length - bad.length - skipped.length;
console.log(`\n[test] ══ ${passed}/${results.length} suites passed`
  + `${skipped.length ? `, ${skipped.length} NOT GRADED` : ''} ══════════════════════`);
for (const r of skipped) console.log(`  – SKIPPED ${r.suite.file}: ${r.detail}`);
for (const r of bad) {
  console.error(`\n  ✗ ${r.verdict}  ${r.suite.file}   (${(r.ms / 1000).toFixed(1)}s, exit ${r.code})`);
  if (r.verdict === 'VACUOUS') {
    console.error('     exited 0 without printing a single graded line — it did not pass, it failed to assert');
  }
  const lines = (r.tail ?? '').trim().split('\n').slice(-12);
  for (const l of lines) console.error(`     │ ${l}`);
  console.error(`     full log: ${r.logPath}`);
}
// ── persist it: durations were computed and thrown away for a month ─────────
// test-results/summary.json is what a committer reads to pick a subset, what
// the next audit reads to see where the time goes, and what says which HEAD
// produced the numbers. The slowest-5 line answers "why was that slow" without
// opening it.
const wallMs = Date.now() - RUN_T0;
{
  let head = 'unknown';
  try { head = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo */ }
  const summary = {
    head, argv, startedAt: new Date(RUN_T0).toISOString(), wallMs,
    suites: results.map((r) => ({
      file: r.suite.file, kind: r.suite.kind, quick: !!r.suite.quick,
      verdict: r.verdict, ms: r.ms, bytes: r.bytes ?? 0, code: r.code,
    })),
  };
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(path.join(LOG_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  const slowest = results.filter((r) => r.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 5);
  if (slowest.length) {
    console.log(`[test] slowest: ${slowest.map((r) => `${r.suite.file.replace(/\.mjs$/, '')} ${(r.ms / 1000).toFixed(1)}s`).join('  ')}`);
  }
  console.log(`[test] ${(wallMs / 1000).toFixed(1)}s wall · summary: test-results/summary.json (HEAD ${head})`);
}
let quickOver = false;
if (wantQuick) {
  if (wallMs > 2 * QUICK_BUDGET_MS) {
    console.error(`  ✗ FAIL: the quick tier took ${(wallMs / 1000).toFixed(1)}s, over twice its ${QUICK_BUDGET_MS / 1000}s ceiling — untag suites in lib/suites.mjs or raise PIRATES_QUICK_BUDGET_MS`);
    quickOver = true;
  } else if (wallMs > QUICK_BUDGET_MS) {
    console.log(`  ! quick tier took ${(wallMs / 1000).toFixed(1)}s, over its ${QUICK_BUDGET_MS / 1000}s soft ceiling (advisory; FAIL at 2x)`);
  } else {
    console.log(`  ✓ quick tier within its ${QUICK_BUDGET_MS / 1000}s ceiling`);
  }
}
if (bad.length || code || quickOver) {
  console.error(`\n[test] ${bad.length} suite(s) not green${quickOver ? ', quick ceiling blown' : ''}.`);
  process.exit(1);
}
console.log('[test] ALL SUITES PASSED');
process.exit(0);
