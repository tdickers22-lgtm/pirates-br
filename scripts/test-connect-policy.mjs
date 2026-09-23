// CONNECT POLICY + VERSION GATE (logic tier, b1.1e): online-10 / online-05 / correctness-04.
//
//   1. the first-connect schedule sums to exactly the 60 s seat budget, and the
//      jittered live waits never run past it;
//   2. no public host ever yields the 'npm run dev' copy (any phase, dev build or
//      not), and no player copy shows a URL or a port; localhost on a dev build
//      still gets the hint;
//   3. versionGate: menu -> reload once (sessionStorage guard stops a loop),
//      in_match -> defer until the menu, unknown build ids never reload;
//   4. static: Game.connectToServer no longer races a 6 s timeout or prints the
//      npm copy itself (red on e6011baf).
//   5. optional: DIST=<dir> greps a built client for the npm copy outside the
//      localhost branch.
//
//   node --import tsx scripts/test-connect-policy.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectSchedule, nextWaitMs, connectCopy, isLocalHost, CONNECT_BUDGET_MS } from '../src/client/network/connectPolicy.ts';
import { decideVersion, VersionGate } from '../src/client/network/versionGate.ts';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ── 1. schedule ─────────────────────────────────────────────────────────────
{
  const sched = connectSchedule();
  const sum = sched.reduce((a, b) => a + b, 0);
  check('schedule sums to 60 s', sum === 60_000 && CONNECT_BUDGET_MS === 60_000, `${sum} ms over ${sched.length} waits: ${sched.join(',')}`);
  check('schedule starts at 0.5 s and caps at 8 s', sched[0] === 500 && Math.max(...sched) === 8_000, sched.slice(0, 6).join(','));
  for (const [label, rand] of [['min jitter', () => 0], ['max jitter', () => 0.999999], ['mid', () => 0.5]]) {
    let elapsed = 0; let attempts = 0; let over = false;
    for (let a = 1; a < 200; a += 1) {
      const w = nextWaitMs(a, elapsed, rand);
      if (w === null) break;
      if (w < 0 || elapsed + w > CONNECT_BUDGET_MS) over = true;
      elapsed += w + 40; // each failed attempt itself costs a little
      attempts += 1;
    }
    check(`${label}: live waits stay inside the budget and stop`, !over && attempts > 5 && attempts < 40 && elapsed <= CONNECT_BUDGET_MS + 40, `${attempts} attempts, ${elapsed} ms`);
  }
  check('spent budget -> null', nextWaitMs(3, 60_000) === null && nextWaitMs(3, 59_900) === null, `${nextWaitMs(3, 59_900)}`);
}

// ── 2. copy ─────────────────────────────────────────────────────────────────
{
  const publicHosts = ['pirates-br.fly.dev', 'pirates-br-game.fly.dev', 'example.com', '192.168.1.20', 'my-laptop.local', 'localhost.evil.com', ''];
  const phases = ['connecting', 'retrying', 'offline', 'gave_up'];
  let leaks = []; let urls = [];
  for (const host of publicHosts) for (const phase of phases) for (const devBuild of [true, false]) {
    const c = connectCopy(phase, { host, attempt: 3, port: 8090, devBuild });
    if (/npm run dev/i.test(c.text)) leaks.push(`${host}/${phase}/${devBuild}`);
    if (/wss?:\/\/|:\d{2,5}\b/.test(c.text)) urls.push(`${host}/${phase}: ${c.text}`);
  }
  check('no public host ever gets the npm copy', leaks.length === 0, leaks.slice(0, 3).join(' | '));
  check('no player copy shows a URL or a port', urls.length === 0, urls.slice(0, 2).join(' | '));
  const dev = connectCopy('gave_up', { host: 'localhost', port: 8090, devBuild: true });
  check('localhost dev build keeps the hint', /npm run dev/.test(dev.text) && dev.retry, dev.text);
  const prodLocal = connectCopy('gave_up', { host: 'localhost', port: 8090, devBuild: false });
  check('localhost production build: no hint', !/npm run dev/.test(prodLocal.text), prodLocal.text);
  check('gave_up and offline offer Retry; retrying does not', connectCopy('gave_up', { host: 'x' }).retry && connectCopy('offline', { host: 'x' }).retry && !connectCopy('retrying', { host: 'x', attempt: 2 }).retry);
  check('retrying copy counts attempts', /attempt 3/.test(connectCopy('retrying', { host: 'x', attempt: 2 }).text), connectCopy('retrying', { host: 'x', attempt: 2 }).text);
  check('isLocalHost', isLocalHost('localhost') && isLocalHost('127.0.0.1') && isLocalHost('::1') && !isLocalHost('pirates-br.fly.dev') && !isLocalHost('localhost.evil.com'));
}

// ── 3. version gate ─────────────────────────────────────────────────────────
{
  check('decide: same', decideVersion('a', 'a', 'menu', null) === 'same');
  check('decide: menu -> reload', decideVersion('a', 'b', 'menu', null) === 'reload');
  check('decide: in_match -> defer', decideVersion('a', 'b', 'in_match', null) === 'defer');
  check('decide: already reloaded for b -> loop_guard', decideVersion('a', 'b', 'menu', 'b') === 'loop_guard');
  check('decide: unknown ids never reload', ['dev', '', null, undefined].every((x) => decideVersion(x, 'b', 'menu', null) === 'unknown' && decideVersion('a', x, 'menu', null) === 'unknown'));
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let reloads = 0;
  const g1 = new VersionGate({ clientBuild: 'a', storage, reload: () => { reloads += 1; } });
  g1.onWelcome('b', 'menu');
  // the "reloaded" page still gets the old bundle (CDN lag): must not loop
  const g2 = new VersionGate({ clientBuild: 'a', storage, reload: () => { reloads += 1; } });
  const d2 = g2.onWelcome('b', 'menu');
  check('menu: reload exactly once per server build (sessionStorage guard)', reloads === 1 && d2 === 'loop_guard', `reloads ${reloads}, second ${d2}`);
  const g3 = new VersionGate({ clientBuild: 'a', storage, reload: () => { reloads += 1; } });
  g3.onWelcome('c', 'in_match');
  check('in_match: deferred', reloads === 1 && g3.last === 'defer');
  g3.onMenu();
  check('deferred reload fires on the menu, once', reloads === 2 && g3.onMenu() === false, `reloads ${reloads}`);
  const g4 = new VersionGate({ clientBuild: 'dev', storage, reload: () => { reloads += 1; } });
  g4.onWelcome('d', 'menu');
  check('dev bundle never reloads', reloads === 2);
}

// ── 4. static: Game.connectToServer ─────────────────────────────────────────
{
  const game = readFileSync(join(ROOT, 'src/client/core/Game.ts'), 'utf8');
  const m = game.match(/private async connectToServer\(\)[\s\S]*?\n {2}\}\n/);
  const body = m ? m[0] : '';
  check('Game.connectToServer found', body.length > 0);
  check('no 6 s Promise.race timeout', !/Promise\.race|connectTimeoutMs|connect-timeout/.test(body), 'race still present');
  check('no npm copy or socket URL in Game', !/npm run dev/.test(game) && !/Connecting to \$\{socketUrl\}/.test(body));
  check('uses connectCopy + Retry', /connectCopy\(/.test(body) && /waitForRetry\(|retryNow\(/.test(body));
}

// ── 5. optional: built dist ─────────────────────────────────────────────────
if (process.env.DIST) {
  const dir = process.env.DIST;
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p); } };
  if (existsSync(dir)) walk(dir);
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (let i = src.indexOf('npm run dev'); i >= 0; i = src.indexOf('npm run dev', i + 1)) {
      const window = src.slice(Math.max(0, i - 600), i);
      if (!/localhost/.test(window)) bad.push(`${f}@${i}`);
    }
  }
  check(`dist ${dir}: no 'npm run dev' outside the localhost branch`, files.length > 0 && bad.length === 0, `${files.length} files, ${bad.length} bad ${bad.slice(0, 2).join(' ')}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  test-connect-policy: ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
