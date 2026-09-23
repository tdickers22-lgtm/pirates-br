#!/usr/bin/env node
/**
 * PUBLIC-INTERNET ABUSE LIMITS (online-06, vm:correctness:4; slice b1.2d).
 *
 * A real LobbyServer in THIS process on a kernel-picked port, real ws clients
 * from 127.0.0.1, PIRATES_BR_TRUST_PROXY=1 and a forged x-forwarded-for per
 * client so each one is attributed to its own documentation-range address
 * (loopback is exempt from the per-IP caps; a forged public address is not).
 *
 *   - 8 sockets from one IP connect, the 9th is refused 429 before the
 *     upgrade; another IP still connects; closing one frees the slot
 *   - 20 new sockets a minute per IP, the 21st is refused 429
 *   - total cap: at the ceiling the next upgrade is refused 503
 *   - PIRATES_BR_ALLOWED_ORIGINS set: a foreign Origin is refused 403, the
 *     allowed Origin and a missing Origin connect
 *   - 500 create_party in 1 s: <= 30 reach the handler, socket closed 1008
 *     within 11 s of the flood's start (the flood STOPS after 1 s, so the
 *     close has to come from the server's own clock, not the next frame)
 *   - a normal client (60 Hz player_input + a ping every 3 s + a lobby burst)
 *     is NEVER limited over 60 s: 0 frames dropped, every ping answered
 *   - /health reports refusedConnections, rateLimitedFrames, abuseClosed
 *   - pure limits.ts checks: bucket arithmetic, 10 s rule, prune bounds the map
 *
 * NEVER port 8080 on this machine (the content filter corrupts websockets).
 * Wall time ~62 s: the 60 s normal-client window runs CONCURRENTLY with the
 * other cases.
 */
process.env.PIRATES_BR_TRUST_PROXY = '1';
process.env.PIRATES_BR_ALLOWED_ORIGINS = 'https://pirates-br.fly.dev, http://localhost:3000/';
delete process.env.PIRATES_BR_MAX_SOCKETS_PER_IP;
delete process.env.PIRATES_BR_MAX_CLIENTS;
delete process.env.PIRATES_BR_NEW_SOCKETS_PER_MIN;
delete process.env.PIRATES_BR_LIMIT_LOOPBACK;

const { WebSocket } = await import('ws');
const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');
const L = await import('../src/server/net/limits.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0. Pure limits.ts ─────────────────────────────────────────────────────
console.log('limits.ts (pure)');
{
  const lim = new L.SessionLimiter(0);
  let admitted = 0;
  for (let i = 0; i < 500; i += 1) if (lim.admit('lobby', i * 2)) admitted += 1; // 500 over 1 s
  expect('500 lobby frames in 1 s -> <= 30 admitted (burst 20 + 10/s)', admitted <= 30 && admitted >= 20, `admitted ${admitted}`);
  expect('not closed at 9.9 s over budget', !lim.shouldClose(9_900));
  expect('closed at >= 10 s over budget (debt persists after the flood stops)', lim.shouldClose(10_100));
  const calm = new L.SessionLimiter(0);
  let dropped = 0;
  for (let t = 0; t < 60_000; t += 1000 / 60) if (!calm.admit('input', t)) dropped += 1;
  for (let t = 0; t < 60_000; t += 3000) if (!calm.admit('ping', t)) dropped += 1;
  expect('60 Hz input + 3 s pings for 60 s: 0 dropped, never closed', dropped === 0 && !calm.shouldClose(60_000), `dropped ${dropped}`);
  const brief = new L.SessionLimiter(0);
  for (let i = 0; i < 22; i += 1) brief.admit('lobby', 0);
  expect('a 22-frame lobby blip is forgiven once it drains (no close at 11 s)', !brief.shouldClose(11_000));
  expect('player_input -> input, ping -> ping, shop_buy -> match, create_party/unknown -> lobby',
    L.classifyMsg('player_input') === 'input' && L.classifyMsg('ping') === 'ping'
    && L.classifyMsg('shop_buy') === 'match' && L.classifyMsg('create_party') === 'lobby' && L.classifyMsg('zzz') === 'lobby');
  const g = new L.ConnectionGate({ perIp: 8, total: 400, newPerMinute: 20, allowedOrigins: [], limitLoopback: false });
  for (let i = 0; i < 5000; i += 1) g.check(`198.18.${i >> 8}.${i & 255}`, undefined, 0);
  expect('gate tracks 5000 forged IPs, then prune() after a full refill drops them all', g.trackedIps() === 5000 && (g.prune(10 * 60_000), g.trackedIps() === 0), `tracked ${g.trackedIps()}`);
  expect('loopback exempt from the per-IP cap by default', (() => { for (let i = 0; i < 30; i += 1) { if (!g.check('127.0.0.1', undefined, 0).ok) return false; g.open('127.0.0.1'); } return true; })());
}

// ── Server ────────────────────────────────────────────────────────────────
const server = new LobbyServer();
server.init(Number(process.env.PIRATES_BR_TEST_PORT ?? 0));
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) throw new Error('LobbyServer never reported a bound port');
const PORT = server.boundPort;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let createPartyCalls = 0;
const realCreate = server.handleCreateParty.bind(server);
server.handleCreateParty = (...args) => { createPartyCalls += 1; return realCreate(...args); };

const opened = [];
/** Resolves { ok, ws } or { ok:false, status }. */
function open(ip, origin) {
  return new Promise((resolve) => {
    const headers = { 'x-forwarded-for': ip };
    if (origin) headers.origin = origin;
    const ws = new WebSocket(WS_URL, { headers });
    opened.push(ws);
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => { resolve({ ok: false, status: res.statusCode }); res.resume(); });
    ws.once('error', (e) => resolve({ ok: false, status: `error:${e.message}` }));
  });
}
async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return res.json();
}
const closeWs = (ws) => new Promise((r) => { if (ws.readyState === WebSocket.CLOSED) return r(); ws.once('close', r); ws.close(); });

try {
  // The 60 s normal client starts FIRST and runs under everything else.
  const normal = (async () => {
    const c = await open('203.0.113.50', 'https://pirates-br.fly.dev');
    if (!c.ok) return { opened: false };
    const ws = c.ws;
    let closedCode = null;
    let pongs = 0;
    ws.on('close', (code) => { closedCode = code; });
    ws.on('message', (d) => { try { if (JSON.parse(String(d)).type === 'pong') pongs += 1; } catch {} });
    const send = (type, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ts: Date.now(), payload })); };
    // A player setting up: name, party, a few settings clicks, in one burst.
    send('set_name', { name: 'Calm Carl' });
    send('create_party', { mode: 'squads' });
    for (let i = 0; i < 6; i += 1) send('party_ready', { ready: i % 2 === 0 });
    let pings = 0;
    const input = { seq: 0, moveX: 0, moveZ: 1, yaw: 0, pitch: 0 };
    const t0 = Date.now();
    const inputTimer = setInterval(() => { input.seq += 1; send('player_input', input); }, 1000 / 60);
    const pingTimer = setInterval(() => { pings += 1; send('ping', { t: Date.now() }); }, 3000);
    await sleep(60_000);
    clearInterval(inputTimer);
    clearInterval(pingTimer);
    await sleep(300);
    const session = [...server.clients.values()].find((s) => s.ip === '203.0.113.50');
    return { opened: true, closedCode, pongs, pings, dropped: session?.limiter.dropped ?? -1, inputs: input.seq, secs: (Date.now() - t0) / 1000 };
  })();

  console.log('per-IP socket cap (8)');
  const eight = [];
  for (let i = 0; i < 8; i += 1) eight.push(await open('203.0.113.7'));
  expect('8 sockets from 203.0.113.7 connect', eight.every((r) => r.ok), JSON.stringify(eight.map((r) => r.status ?? 'ok')));
  const ninth = await open('203.0.113.7');
  expect('9th socket from the same IP refused 429 before the upgrade', !ninth.ok && ninth.status === 429, `got ${ninth.ok ? 'open' : ninth.status}`);
  const other = await open('203.0.113.8');
  expect('a different IP still connects', other.ok, `got ${other.status}`);
  await closeWs(eight[0].ws);
  await sleep(100);
  const again = await open('203.0.113.7');
  expect('closing one of the 8 frees the slot', again.ok, `got ${again.status}`);

  console.log('new sockets per minute per IP (20)');
  let admittedNew = 0;
  let firstRefusal = null;
  for (let i = 0; i < 21; i += 1) {
    const r = await open('203.0.113.9');
    if (r.ok) { admittedNew += 1; await closeWs(r.ws); } else { firstRefusal = r.status; break; }
  }
  expect('20 open-and-close sockets in a burst admitted, the 21st refused 429', admittedNew === 20 && firstRefusal === 429, `admitted ${admittedNew}, refusal ${firstRefusal}`);

  console.log('Origin allowlist (PIRATES_BR_ALLOWED_ORIGINS)');
  const evil = await open('203.0.113.10', 'https://evil.example');
  expect('foreign Origin refused 403', !evil.ok && evil.status === 403, `got ${evil.ok ? 'open' : evil.status}`);
  const good = await open('203.0.113.10', 'https://pirates-br.fly.dev');
  const goodSlash = await open('203.0.113.10', 'http://localhost:3000');
  const none = await open('203.0.113.10');
  expect('allowed Origin (both list entries, trailing slash normalised) and a missing Origin connect', good.ok && goodSlash.ok && none.ok,
    `${good.status ?? 'ok'} ${goodSlash.status ?? 'ok'} ${none.status ?? 'ok'}`);

  console.log('total socket cap');
  const gate = server.gate ?? { limits: { total: 0, perIp: 0, newPerMinute: 0 }, liveCount: () => 0 };
  expect('LobbyServer has a pre-upgrade ConnectionGate', !!server.gate);
  const savedTotal = gate.limits.total;
  gate.limits.total = gate.liveCount();
  const full = await open('203.0.113.11');
  gate.limits.total = savedTotal;
  expect('at the total ceiling the next upgrade is refused 503', !full.ok && full.status === 503, `got ${full.ok ? 'open' : full.status}`);
  expect('default ceilings are 8 per IP, 400 total, 20 new/min', savedTotal === 400 && gate.limits.perIp === 8 && gate.limits.newPerMinute === 20);

  console.log('500 create_party in 1 s');
  const flood = await open('203.0.113.12', 'https://pirates-br.fly.dev');
  expect('flood socket connects', flood.ok);
  if (flood.ok) {
    const ws = flood.ws;
    let closeCode = null;
    let closeAt = null;
    ws.on('close', (code) => { closeCode = code; closeAt = Date.now(); });
    const before = createPartyCalls;
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'set_name', ts: t0, payload: { name: 'Spammy' } }));
    for (let batch = 0; batch < 10; batch += 1) {
      for (let i = 0; i < 50; i += 1) ws.send(JSON.stringify({ type: 'create_party', ts: Date.now(), payload: { mode: 'squads' } }));
      await sleep(100);
    }
    for (let i = 0; i < 120 && closeCode === null; i += 1) await sleep(100);
    const handled = createPartyCalls - before;
    console.log(`    flood: ${handled} of 500 create_party handled, close ${closeCode} after ${closeAt ? ((closeAt - t0) / 1000).toFixed(2) : 'never'} s`);
    expect('<= 30 create_party reached the handler', handled <= 30 && handled > 0, `handled ${handled}`);
    expect('socket closed 1008 within 11 s of the flood start', closeCode === 1008 && closeAt - t0 <= 11_000,
      `code ${closeCode}, after ${closeAt ? ((closeAt - t0) / 1000).toFixed(2) : 'never'} s`);
    expect('not closed before 10 s (the budget is 10 s continuously over)', closeAt === null || closeAt - t0 >= 9_900);
  }

  const h = await health();
  expect('/health reports refusedConnections >= 4, rateLimitedFrames >= 400, abuseClosed >= 1',
    h.refusedConnections >= 4 && h.rateLimitedFrames >= 400 && h.abuseClosed >= 1,
    JSON.stringify({ refused: h.refusedConnections, rl: h.rateLimitedFrames, closed: h.abuseClosed }));

  console.log('normal 60 Hz client for 60 s (running since the start)');
  const n = await normal;
  console.log(`    normal: ${JSON.stringify(n)}`);
  expect('normal client connected', n.opened);
  expect('normal client never limited: 0 frames dropped, never closed',
    n.opened && n.dropped === 0 && n.closedCode === null, JSON.stringify(n));
  expect('normal client sent >= 3300 inputs and every ping was answered',
    n.opened && n.inputs >= 3300 && n.pongs >= n.pings && n.pings >= 19, JSON.stringify(n));
} finally {
  for (const ws of opened) try { ws.terminate(); } catch {}
  try { await server.shutdown?.(); } catch {}
}

if (failures > 0) {
  console.error(`\n${failures} abuse-limit assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll abuse-limit assertions passed.');
process.exit(0);
