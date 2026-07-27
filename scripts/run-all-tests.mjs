#!/usr/bin/env node
// ONE COMMAND FOR THE WHOLE SUITE — `npm run test:all`.
//
// test:logic runs against nothing; test:browser needs the dev stack (vite on
// 3000 + the game server on 8090) and silently 30-second-times-out against a
// dead port, which reads as a test failure instead of "you forgot to start the
// server". So: boot whatever is missing, WAIT for both to answer, run the two
// chains, and take down only what this script started.
//
// If a stack is already up (the normal case while developing) it is reused and
// left running afterwards.
//
//   node scripts/run-all-tests.mjs            # logic + browser
//   node scripts/run-all-tests.mjs --logic    # logic only (no stack needed)
//   node scripts/run-all-tests.mjs --browser  # browser only
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const HEALTH_URL = process.env.PIRATES_BR_SERVER_HEALTH_URL ?? 'http://127.0.0.1:8090/health';
const LOG_DIR = path.join(ROOT, 'test-results');
// Overridable so the boot/wait/teardown path itself can be exercised without
// taking a real dev stack down (see the smoke in this wave's report).
const SERVER_CMD = process.env.PIRATES_BR_SERVER_CMD ?? 'npm run dev:server';
const CLIENT_CMD = process.env.PIRATES_BR_CLIENT_CMD ?? 'npm run dev:client';
const LOGIC_CMD = process.env.PIRATES_BR_LOGIC_CMD ?? 'npm run test:logic';
const BROWSER_CMD = process.env.PIRATES_BR_BROWSER_CMD ?? 'npm run test:browser';

const args = process.argv.slice(2);
const runLogic = !args.includes('--browser');
const runBrowser = !args.includes('--logic');

/** NEVER 8080: this machine's content filter replays the WS upgrade bytes and
 *  corrupts every socket served there. The stack is 3000 + 8090. */
const started = [];

function sh(command, { inherit = true, logFile = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ROOT, shell: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (!inherit && logFile) {
      child.stdout.pipe(logFile);
      child.stderr.pipe(logFile);
    }
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404; // vite answers / with 200; any answer means listening
  } catch {
    return false;
  }
}

/** Boot `command` detached-ish and wait until `url` answers. */
async function ensure(name, command, url, timeoutMs = 90_000) {
  if (await isUp(url)) {
    console.log(`[test:all] ${name} already up — reusing it`);
    return;
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `test-all-${name}.log`);
  const logFile = createWriteStream(logPath);
  console.log(`[test:all] starting ${name} (log: ${logPath})`);
  const child = spawn(command, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  started.push({ name, child });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before it listened — see ${logPath}`);
    if (await isUp(url)) {
      console.log(`[test:all] ${name} is answering at ${url}`);
      return;
    }
    await new Promise(r => setTimeout(r, 600));
  }
  throw new Error(`${name} never answered ${url} within ${timeoutMs / 1000}s — see ${logPath}`);
}

function teardown() {
  for (const { name, child } of started.splice(0)) {
    console.log(`[test:all] stopping ${name}`);
    // Kill the whole process group: `vite` and `tsx watch` both fork children
    // that outlive a bare child.kill() and keep the port bound.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}

process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

let code = 0;
try {
  if (runLogic) {
    console.log('\n[test:all] ── logic suites ─────────────────────────────');
    code = await sh(LOGIC_CMD);
    if (code !== 0) throw new Error('test:logic failed');
  }
  if (runBrowser) {
    await ensure('server', SERVER_CMD, HEALTH_URL);
    await ensure('client', CLIENT_CMD, CLIENT_URL);
    console.log('\n[test:all] ── browser suites ───────────────────────────');
    code = await sh(BROWSER_CMD);
    if (code !== 0) throw new Error('test:browser failed');
  }
  console.log('\n[test:all] ALL SUITES PASSED');
} catch (err) {
  console.error(`\n[test:all] ${err.message}`);
  code = code === 0 ? 1 : code;
} finally {
  teardown();
}
process.exit(code);
