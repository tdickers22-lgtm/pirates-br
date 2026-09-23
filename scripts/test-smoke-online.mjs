#!/usr/bin/env node
// THE SMOKE MUST BE ABLE TO FAIL (online-04, b1.3b). Offline: a real LobbyServer
// on a kernel-chosen port behind a tiny fake edge (static fixture + /health pass
// through + a raw WebSocket upgrade pipe), so smoke-online.mjs is graded against
// the real protocol, not against a mock of it. No browser, no fly, no network.
//
//  A  the healthy host passes every stage (welcome, solo join >= 10 ships,
//     inputs -> snapshots, public queue -> match, party code join)
//  B  a stopped app (connection refused) FAILS
//  C  a build id mismatch (stale image) FAILS at the welcome
//  D  a two-machine /health (alternating machineId) FAILS
//  E  a bundle served without brotli FAILS
//  F  wait-idle: idle / unreachable / cap decisions on a fake clock
// ~30 s (the public queue's 20 s dispatch clock). Logic tier, not quick.
// SMOKE_MODULE=<path> grades another copy (the red run used a mutant).
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

process.env.BUILD_ID = 'smoke-build-1234567';
process.env.FLY_MACHINE_ID = 'm-smoke-1';
delete process.env.PIRATES_BR_ALLOWED_ORIGINS;
delete process.env.HEALTH_KEY;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const smokePath = process.env.SMOKE_MODULE ? pathToFileURL(path.resolve(process.env.SMOKE_MODULE)).href : './smoke-online.mjs';
const { runSmoke, sameBuild, formatTable } = await import(smokePath);
const { waitIdle } = await import('./wait-idle.mjs');
const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
const { StatsStore } = await import('../src/server/core/StatsStore.ts');

console.log('G  sameBuild');
expect('full sha vs its 12-char prefix', sameBuild('0123456789abcdef0123', '0123456789ab'));
expect('different ids', !sameBuild('0123456789ab', 'fedcba987654'));
expect('a 3-char prefix is not a match', !sameBuild('012', '0123456789ab'));

const server = new LobbyServer();
server.stats = new StatsStore(path.join(mkdtempSync(path.join(tmpdir(), 'pbr-smoke-')), 'stats.json'));
server.init(0);
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
const REAL = server.boundPort;

// ── the fake edge ─────────────────────────────────────────────────────────
const variant = { twoMachines: false, noBr: false };
let healthHits = 0;
const JS = Buffer.from('console.log("pirates");'.repeat(200));
const edge = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end('<!doctype html><script type="module" crossorigin src="/assets/index-AbC123_x.js"></script>');
  }
  if (req.url === '/assets/index-AbC123_x.js') {
    const h = { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' };
    if (variant.noBr) { res.writeHead(200, h); return res.end(JS); }
    res.writeHead(200, { ...h, 'content-encoding': 'br' });
    return res.end(zlib.brotliCompressSync(JS));
  }
  if (req.url === '/health') {
    const r = await fetch(`http://127.0.0.1:${REAL}/health`);
    const body = await r.json();
    healthHits += 1;
    if (variant.twoMachines) body.machineId = healthHits % 2 ? 'm-smoke-1' : 'm-smoke-2';
    res.writeHead(r.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(404); res.end();
});
edge.on('upgrade', (req, socket, head) => {
  const up = net.connect(REAL, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
await new Promise((r) => edge.listen(0, '127.0.0.1', r));
const URL_OK = `http://127.0.0.1:${edge.address().port}`;
const stageOf = (res, re) => res.rows.find((r) => re.test(r.stage));

console.log('\nA  healthy host: every stage passes');
const a = await runSmoke({ url: URL_OK, buildId: 'smoke-build-1234567', requireMachineId: true });
console.log(formatTable(a.rows));
expect('smoke passes against a healthy host', a.ok, a.rows.filter((r) => !r.ok).map((r) => `${r.stage}: ${r.detail}`).join(' | '));
for (const re of [/GET \//, /brotli|br \+ immutable/, /\/health x20/, /welcome/, /solo_start/, /inputs/, /queue_join/, /party/]) {
  expect(`stage ran and passed: ${re}`, stageOf(a, re)?.ok === true, stageOf(a, re)?.detail ?? 'stage missing');
}

console.log('\nB  stopped app (connection refused)');
const probe = net.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const deadPort = probe.address().port;
await new Promise((r) => probe.close(r));
const b = await runSmoke({ url: `http://127.0.0.1:${deadPort}`, healthProbes: 2, skipQueue: true, joinTimeoutMs: 2000 });
expect('smoke FAILS against a stopped app', !b.ok);
expect('the first stage says why (ECONNREFUSED)', /ECONNREFUSED/.test(b.rows[0]?.detail ?? ''), b.rows[0]?.detail);

console.log('\nC  stale build (buildId mismatch)');
const c = await runSmoke({ url: URL_OK, buildId: 'deadbeefcafe0000', healthProbes: 2, skipQueue: true, joinTimeoutMs: 3000 });
expect('smoke FAILS on a build id mismatch', !c.ok);
expect('the welcome stage names the mismatch', /buildId mismatch/.test(stageOf(c, /welcome/)?.detail ?? ''), stageOf(c, /welcome/)?.detail);

console.log('\nD  two machines behind the proxy');
variant.twoMachines = true;
const d = await runSmoke({ url: URL_OK, buildId: 'smoke-build-1234567', skipQueue: true });
variant.twoMachines = false;
expect('smoke FAILS on a two-machine /health', !d.ok);
expect('the /health stage counts 2 machines', /2 machines/.test(stageOf(d, /\/health/)?.detail ?? ''), stageOf(d, /\/health/)?.detail);

console.log('\nE  bundle without brotli');
variant.noBr = true;
const e = await runSmoke({ url: URL_OK, healthProbes: 2, skipQueue: true });
variant.noBr = false;
expect('smoke FAILS when the bundle is not br', !e.ok && stageOf(e, /br \+ immutable/)?.ok === false, stageOf(e, /br \+ immutable/)?.detail);

console.log('\nF  wait-idle decisions');
let t = 0;
const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
const seq = [2, 1, 0];
const idle = await waitIdle({ url: 'x', ...clock, health: async () => ({ status: 200, body: { matches: seq.shift() } }) });
expect('busy, busy, idle -> idle after 3 polls', idle.decision === 'idle' && idle.polls === 3, JSON.stringify(idle));
t = 0;
const gone = await waitIdle({ url: 'x', ...clock, health: async () => { throw new Error('ECONNREFUSED'); } });
expect('two refused polls -> unreachable (first deploy proceeds)', gone.decision === 'unreachable' && gone.polls === 2, JSON.stringify(gone));
t = 0;
const busy = await waitIdle({ url: 'x', ...clock, capMs: 60_000, intervalMs: 15_000, health: async () => ({ status: 200, body: { matches: 3 } }) });
expect('always busy -> cap at 20 min-style cap', busy.decision === 'cap' && busy.lastMatches === 3, JSON.stringify(busy));
t = 0;
const flaky = [() => { throw new Error('blip'); }, () => ({ status: 200, body: { matches: 0 } })];
const one = await waitIdle({ url: 'x', ...clock, health: async () => flaky.shift()() });
expect('one dropped GET is not "unreachable"', one.decision === 'idle', JSON.stringify(one));

edge.close();
await server.shutdown?.(0);
console.log(failures === 0 ? '\nPASS test-smoke-online' : `\nFAIL test-smoke-online (${failures})`);
process.exit(failures === 0 ? 0 : 1);
