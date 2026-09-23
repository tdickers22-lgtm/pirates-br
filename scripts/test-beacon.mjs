#!/usr/bin/env node
/**
 * CLIENT ERROR BEACON + LIFECYCLE LOGS (b1.2g, online-12).
 *
 * After launch the only eyes on real devices are what the server writes to
 * `fly logs`. This suite drives a REAL LobbyServer on a kernel-chosen port and
 * reads what it prints:
 *
 *   - POST /beacon: a valid report -> 204 and exactly ONE JSON log line
 *     {evt:'client_error', ...} that never carries the client IP; a body over
 *     4 KB -> 413 (declared or streamed); a second report from the same IP
 *     inside 10 s -> 429; a global ceiling of 20/s across IPs; bad JSON or an
 *     unknown kind -> 400; message/stack clipped to 300 / 1500 chars.
 *   - JSON lifecycle lines: queue_join, match_dispatch {mode, humans, bots,
 *     waitedSec}, match_end {reason, durationSec, humans}, refused {reason}.
 *
 * NEVER port 8080 on this machine (its content filter corrupts websockets).
 */
import { WebSocket } from 'ws';

// Production posture: behind the trusted proxy, so Fly-Client-IP names the
// client (lets one process play several IPs), and an Origin allowlist so the
// refused path is reachable.
process.env.PIRATES_BR_TRUST_PROXY = '1';
process.env.PIRATES_BR_ALLOWED_ORIGINS = 'https://pirates-br.fly.dev';
process.env.PIRATES_BR_STATS_PATH = process.env.PIRATES_BR_STATS_PATH || `/tmp/pbr-beacon-stats-${process.pid}.json`;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.info(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture every console.log line the server prints; test output goes through
// console.info/error so it never lands in the capture.
const logged = [];
const realLog = console.log;
console.log = (...args) => { logged.push(args.map(String).join(' ')); };
const jsonLines = () => logged.map((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? o : null; } catch { return null; } }).filter(Boolean);

process.on('uncaughtException', (err) => {
  console.error(`  ✗ FAIL: uncaught exception: ${err && err.message}`);
  process.exit(1);
});

const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
LobbyServer.tunables.queueSoftWaitSeconds = 1;
LobbyServer.tunables.queueHardWaitSeconds = 2;
const server = new LobbyServer();
server.init(0);
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) { console.error('  ✗ FAIL: LobbyServer never bound'); process.exit(1); }
const HTTP = `http://127.0.0.1:${server.boundPort}`;
const WS_URL = `ws://127.0.0.1:${server.boundPort}/ws`;

const IP = '203.0.113.77';
const post = (ip, body, extra = {}) => fetch(`${HTTP}/beacon`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain', 'fly-client-ip': ip, ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then((r) => r.status, (e) => `error:${e.cause?.code ?? e.message}`);

const valid = {
  kind: 'error', message: 'TypeError: x is undefined', stack: 'at Game.ts:1:1',
  buildId: 'abc123', ua: 'safari-ios-phone', quality: 'low', extraField: 'dropped',
};

console.info('POST /beacon:');
{
  const before = jsonLines().length;
  const s = await post(IP, valid);
  expect('valid report -> 204', s === 204, `status=${s}`);
  const lines = jsonLines().slice(before);
  const beacons = lines.filter((o) => o.evt === 'client_error');
  expect('exactly one client_error JSON line', beacons.length === 1, JSON.stringify(lines));
  const line = logged.find((l) => l.includes('"client_error"')) ?? '';
  expect('the log line never carries the IP', line !== '' && !line.includes(IP) && !line.includes('203.0.113'), line);
  const b = beacons[0] ?? {};
  expect('it carries kind, message, stack, buildId, ua, quality',
    b.kind === 'error' && b.message === valid.message && b.stack === valid.stack
      && b.buildId === 'abc123' && b.ua === 'safari-ios-phone' && b.quality === 'low', JSON.stringify(b));
  expect('unknown fields are not logged', !('extraField' in b), JSON.stringify(b));

  const again = await post(IP, valid);
  expect('second report from the same IP within 10 s -> 429', again === 429, `status=${again}`);

  const big = await post('203.0.113.2', { kind: 'error', message: 'x', stack: 'y'.repeat(5 * 1024) });
  expect('5 KB body -> 413', big === 413, `status=${big}`);
  const bigChunked = await fetch(`${HTTP}/beacon`, {
    method: 'POST', headers: { 'fly-client-ip': '203.0.113.3' }, duplex: 'half',
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"kind":"error","message":"' + 'z'.repeat(6000))); c.close(); } }),
  }).then((r) => r.status, (e) => `error:${e.cause?.code ?? e.message}`);
  expect('5 KB streamed without content-length -> 413 (or dropped)', bigChunked === 413 || String(bigChunked).startsWith('error:'), `status=${bigChunked}`);
  const n413 = jsonLines().filter((o) => o.evt === 'client_error').length;
  expect('no log line for refused bodies', n413 === 1, `client_error lines=${n413}`);

  const junk = await post('203.0.113.4', 'not json {');
  expect('bad JSON -> 400', junk === 400, `status=${junk}`);
  const kind = await post('203.0.113.5', { kind: 'rm -rf', message: 'x' });
  expect('unknown kind -> 400', kind === 400, `status=${kind}`);

  const before2 = jsonLines().length;
  const s2 = await post('203.0.113.6', { kind: 'webglcontextlost', message: 'm'.repeat(1000), stack: 's'.repeat(2400) });
  const clip = jsonLines().slice(before2).find((o) => o.evt === 'client_error') ?? {};
  expect('long message/stack are clipped to 300 / 1500', s2 === 204 && clip.message?.length === 300 && clip.stack?.length === 1500,
    `status=${s2} message=${clip.message?.length} stack=${clip.stack?.length}`);

  // Global ceiling: 30 distinct IPs in one burst, at most 20 accepted per second.
  await sleep(1100);
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => post(`198.51.100.${i + 1}`, valid)));
  const ok = burst.filter((s) => s === 204).length;
  const limited = burst.filter((s) => s === 429).length;
  expect('global ceiling: <= 20 of a 30-IP burst accepted, the rest 429', ok <= 20 && ok >= 1 && ok + limited === 30,
    `204=${ok} 429=${limited} other=${burst.filter((s) => s !== 204 && s !== 429).join(',')}`);
}

console.info('JSON lifecycle lines:');
{
  const ws = new WebSocket(WS_URL);
  const seen = [];
  ws.on('message', (d) => { try { seen.push(JSON.parse(d.toString())); } catch {} });
  ws.on('error', () => {});
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'set_name', ts: Date.now(), payload: { name: 'Beacon' } }));
  await sleep(50);
  ws.send(JSON.stringify({ type: 'queue_join', ts: Date.now(), payload: {} }));
  for (let i = 0; i < 60 && !seen.some((m) => m.type === 'match_start'); i += 1) await sleep(100);
  const j = jsonLines();
  const join = j.find((o) => o.evt === 'queue_join');
  expect('queue_join line {mode, crew}', join && typeof join.mode === 'string' && join.crew === 1, JSON.stringify(join));
  const disp = j.find((o) => o.evt === 'match_dispatch');
  expect('match_dispatch line {mode, humans:1, bots>0, waitedSec}',
    disp && disp.humans === 1 && disp.bots > 0 && typeof disp.waitedSec === 'number' && disp.waitedSec >= 0 && typeof disp.mode === 'string',
    JSON.stringify(disp));
  expect('lifecycle lines carry no IP', !logged.some((l) => l.startsWith('{') && l.includes('127.0.0.1')));

  const matchId = seen.find((m) => m.type === 'match_start')?.payload?.matchId ?? [...server.matches.keys()][0];
  if (matchId && server.matches.has(matchId)) {
    server.onMatchEnd(matchId, { matchId, winnerId: null, winnerName: null, reason: 'server_fault', humans: [], board: [] });
  }
  const end = jsonLines().find((o) => o.evt === 'match_end');
  expect('match_end line {reason, durationSec, humans}',
    end && end.reason === 'server_fault' && typeof end.durationSec === 'number' && end.durationSec >= 0 && end.humans === 0,
    `matchId=${matchId} line=${JSON.stringify(end)}`);
  ws.close();

  const bad = new WebSocket(WS_URL, { headers: { origin: 'https://evil.example' } });
  await new Promise((r) => { bad.on('error', r); bad.on('unexpected-response', r); bad.on('open', r); setTimeout(r, 2000); });
  try { bad.terminate(); } catch {}
  const refused = jsonLines().find((o) => o.evt === 'refused');
  expect('refused line {reason:origin, status:403} without the IP',
    refused && refused.reason === 'origin' && refused.status === 403 && !JSON.stringify(refused).includes('127.0.0.1'),
    JSON.stringify(refused));
}

console.log = realLog;
if (failures > 0) {
  console.error(`\n${failures} beacon assertion(s) failed.`);
  process.exit(1);
}
console.info('\nAll beacon assertions passed.');
process.exit(0);
