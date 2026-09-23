// PROBE, not a gate: CSP BOOT. Not in the runner (it needs a fresh build and its own 8091 server);
// the b1 batch gate runs it by hand (b1.2g, online-12). The real BUILT client boots and joins a match
// under the server's Content-Security-Policy with 0 violations. Run from the repo root AFTER a build:
//   npx vite build && node scripts/postbuild-compress.mjs && node scripts/probes/csp-boot-probe.mjs
//
// Stack: its own LobbyServer on 8091 serving dist/client (never 3000/8090/8080), ONE headless
// SwiftShader Chromium, both killed in finally. Exit 0 = pass, 1 = fail. ~1 minute.
//
// Four phases, one browser, one fresh context each:
//   0 self-test  the document's CSP is rewritten to connect-src 'none'; the listener MUST see a
//                violation, or this probe cannot fail and proves nothing.
//   A no-param   http://127.0.0.1:8091/ with no ?server=: records what the first one-off run hit.
//                Any localhost port other than __GAME_SERVER_PORT__ (8090 in a default build) is
//                treated as a dev server, so the page dials ws://127.0.0.1:8090 and sits on
//                "Waking the harbour..." forever. Informational, not graded.
//   B control    bypassCSP:true, ?server=8091: menu visible, solo join reaches phase 'playing'.
//   C csp        the real header, same path: menu, join, 20 s of play, 0 violations, 0 'Refused
//                to' console lines, 0 page errors. B must pass for C to mean anything.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let distBuildId;
try { distBuildId = readFileSync('dist/build-id.txt', 'utf8').trim(); } catch {
  console.error('FAIL no dist/build-id.txt: build first (npx vite build && node scripts/postbuild-compress.mjs)');
  process.exit(1);
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), PIRATES_BR_STATS_PATH: `/tmp/pbr-csp-probe-stats-${process.pid}.json`, PIRATES_BR_MAP_SEED: '20260801' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let browser;
const out = { gl: describeGl(), distBuildId, buildIdServed: null, csp: null, phases: {} };

async function phase(name, { bypassCSP = false, query = '', join = false, menuTimeout = 120_000, rewriteCsp = null, settleMs = 5_000 }) {
  const r = { url: `${BASE}/${query}`, bypassCSP, wsUrls: [], violations: [], cspConsole: [], pageErrors: [], workers: 0 };
  out.phases[name] = r;
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1, bypassCSP });
  try {
    const page = await ctx.newPage();
    if (rewriteCsp) {
      await page.route((url) => url.pathname === '/', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': rewriteCsp } });
      });
    }
    page.on('worker', () => { r.workers += 1; });
    page.on('websocket', (ws) => r.wsUrls.push(ws.url()));
    page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) r.cspConsole.push(t.slice(0, 300)); });
    page.on('pageerror', (e) => r.pageErrors.push(String(e).slice(0, 300)));
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
      });
    });
    const t0 = Date.now();
    await page.goto(r.url, { waitUntil: 'load', timeout: 90_000 });
    try {
      await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: menuTimeout });
      r.menuVisibleMs = Date.now() - t0;
    } catch {
      r.menuVisibleMs = null;
      r.screenText = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => null);
    }
    if (join && r.menuVisibleMs != null) {
      await page.fill('#menu-name-input', `Csp${name.slice(0, 1)}`);
      const tj = Date.now();
      await page.click('#menu-solo-btn', { noWaitAfter: true, timeout: 60_000 });
      try {
        await page.waitForFunction(() => {
          const g = window.__piratesBR;
          return !!g?.state && g.state.phase === 'playing' && g.state.ships?.length >= 10;
        }, null, { timeout: 180_000 });
        r.playingMs = Date.now() - tj;
        await sleep(20_000); // world build, workers, asset streaming, some play
        r.phaseAfter = await page.evaluate(() => window.__piratesBR?.state?.phase ?? null);
      } catch (e) {
        r.playingMs = null;
        r.joinError = String(e).slice(0, 200);
      }
    } else {
      await sleep(settleMs);
    }
    r.violations = await page.evaluate(() => window.__csp).catch(() => ['<evaluate failed>']);
  } finally {
    await ctx.close().catch(() => {});
  }
  return r;
}

const fails = [];
try {
  for (let i = 0; i < 60 && out.buildIdServed == null; i += 1) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok) out.buildIdServed = (await h.json()).buildId ?? '?'; } catch {}
    if (out.buildIdServed == null) await sleep(500);
  }
  const head = await fetch(`${BASE}/`);
  out.csp = head.headers.get('content-security-policy');
  await head.arrayBuffer();
  if (!out.csp) fails.push('document has no content-security-policy header');
  if (out.buildIdServed !== distBuildId) fails.push(`server buildId ${out.buildIdServed} != dist ${distBuildId}`);

  browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
  const self = await phase('0_selftest_connect_none', { query: `?server=${PORT}`, menuTimeout: 15_000, rewriteCsp: `${out.csp}; connect-src 'none'`.replace(/connect-src [^;]*;/, '') });
  if (self.violations.length === 0 && self.cspConsole.length === 0) fails.push('self-test: a connect-src none policy produced no violation, the detector is blind');
  await phase('A_no_server_param', { menuTimeout: 30_000 });
  const b = await phase('B_control_bypassCSP', { bypassCSP: true, query: `?server=${PORT}&debug`, join: true });
  if (b.menuVisibleMs == null || b.playingMs == null) fails.push('control (CSP bypassed) never reached a match: the rig, not the CSP, is broken');
  const c = await phase('C_csp', { query: `?server=${PORT}&debug`, join: true });
  if (c.menuVisibleMs == null) fails.push('under the CSP the menu never became visible');
  if (c.playingMs == null) fails.push('under the CSP the solo join never reached phase playing');
  if (c.violations.length) fails.push(`${c.violations.length} securitypolicyviolation event(s)`);
  if (c.cspConsole.length) fails.push(`${c.cspConsole.length} CSP console line(s)`);
  if (c.pageErrors.length) fails.push(`${c.pageErrors.length} page error(s)`);
} catch (e) {
  fails.push(`probe error: ${String(e).slice(0, 300)}`);
} finally {
  try { await browser?.close(); } catch {}
  server.kill('SIGKILL');
}
console.log(JSON.stringify(out, null, 1));
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `csp-boot-probe FAIL (${fails.length})` : 'csp-boot-probe PASS');
process.exit(fails.length ? 1 : 0);
