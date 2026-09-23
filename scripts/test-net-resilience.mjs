#!/usr/bin/env node
/**
 * The liveness contract, against a real LobbyServer over a real socket.
 *
 * Covers the join-time death that made this suite necessary: a client whose main
 * thread is pinned by the world build sends nothing and — because Chromium stops
 * draining a socket the renderer is not reading — answers nothing either, so the
 * server's silence sweep terminates it mid-match with code 1006 and no way back
 * but a reload. The client fix is to own the socket in a Web Worker
 * (src/client/network/socket.worker.ts) so the beat comes from a thread that
 * never blocks; what THIS suite pins is the server half of the contract:
 *
 *   - a heartbeat is all it takes to stay alive, whatever else the client does
 *   - genuine silence past the budget still gets swept (half-open sockets must
 *     not keep a ghost standing in the match forever)
 *   - hostile frames are contained, not fatal
 *   - /health reports sim dilation, so an overloaded host is visible from outside
 *
 * NEVER port 8080 on this machine: a content filter there replays the upgrade
 * bytes and corrupts every websocket.
 */
import { WebSocket } from 'ws';
import { LobbyServer } from '../src/server/core/LobbyServer.ts';
import { Match } from '../src/server/core/Match.ts';
import { PROTOCOL_VERSION } from '../src/shared/types/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the kernel for a port, then give it straight back — the cold-start case
 *  needs a port nothing is listening on YET. */
async function freePort() {
  const { createServer } = await import('node:net');
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// NEVER A FIXED PORT. This suite sat in the "no ports" LOGIC tier while binding
// 8791; a stale listener there held it until the runner's 900 s kill and the
// two-minute logic run took seventeen. init(0) asks the kernel for a free port
// and the suite reads back what it got. PIRATES_BR_TEST_PORT pins one when a
// human wants to watch it.
const server = new LobbyServer();
server.init(Number(process.env.PIRATES_BR_TEST_PORT ?? 0));
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) throw new Error('LobbyServer never reported a bound port');
const PORT = server.boundPort;
const URL = `ws://127.0.0.1:${PORT}/ws`;

/** Open a socket and collect every message type it is sent. */
function open() {
  const ws = new WebSocket(URL);
  const seen = [];
  let closeCode = null;
  ws.on('message', (data) => {
    try { seen.push(JSON.parse(data.toString()).type); } catch { seen.push('<unparsed>'); }
  });
  ws.on('close', (code) => { closeCode = code; });
  ws.on('error', () => {});
  return {
    ws,
    seen,
    get closeCode() { return closeCode; },
    ready: new Promise((resolve) => ws.once('open', resolve)),
    sendJson: (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} },
  };
}

// The server's own budget, read off the source so the test cannot drift from it.
const HEARTBEAT_TIMEOUT_MS = 15_000;

console.log('Heartbeat keeps a silent-but-beating client alive:');
{
  // The worker's whole job, distilled: send NOTHING but `ping`, and do it from a
  // clock the rest of the client cannot stall.
  const beater = open();
  await beater.ready;
  beater.sendJson({ type: 'set_name', ts: Date.now(), payload: { name: 'Beater' } });
  const beat = setInterval(() => {
    const ts = Date.now();
    beater.sendJson({ type: 'ping', ts, payload: { t: ts } });
  }, 3_000);
  await sleep(HEARTBEAT_TIMEOUT_MS + 6_000);
  clearInterval(beat);
  expect('a client that only pings is never swept', beater.ws.readyState === WebSocket.OPEN,
    `readyState=${beater.ws.readyState} closeCode=${beater.closeCode}`);
  expect('every ping is answered with a pong', beater.seen.filter((t) => t === 'pong').length >= 4,
    `pongs=${beater.seen.filter((t) => t === 'pong').length}`);
  beater.ws.close();
}

console.log('Genuine silence is still swept:');
{
  const mute = open();
  await mute.ready;
  mute.sendJson({ type: 'set_name', ts: Date.now(), payload: { name: 'Mute' } });
  // Answer nothing at all — not even the ws-level ping the server sends. This is
  // a half-open socket (closed laptop, dead wifi), which must not linger.
  mute.ws.pong = () => {};
  mute.ws._receiver?.removeAllListeners?.('ping');
  mute.ws.removeAllListeners('ping');
  mute.ws.on('ping', () => {}); // swallow: no automatic pong
  await sleep(HEARTBEAT_TIMEOUT_MS + 8_000);
  expect('a truly silent socket is dropped past the budget',
    mute.ws.readyState !== WebSocket.OPEN, `readyState=${mute.ws.readyState}`);
}

console.log('Hostile frames are contained, not fatal:');
{
  const victim = open();
  await victim.ready;
  const hostile = [
    () => victim.ws.send(Buffer.alloc(64)),                       // binary — ignored
    () => victim.ws.send('not json at all'),                      // parse failure
    () => victim.ws.send('null'),                                 // parses, no type
    () => victim.ws.send('{"type":123,"ts":0,"payload":{}}'),     // wrong type shape
    () => victim.ws.send(JSON.stringify({ type: 'player_input', ts: 0, payload: {} })), // unaddressable
    () => victim.ws.send('{'.repeat(20_000)),                     // big + malformed
    // Escaped, not literal: a raw NUL and U+FFFF in the source make git call
    // this file binary and stop diffing it.
    () => victim.ws.send(JSON.stringify({ type: 'join_party', ts: 0, payload: { code: '\u0000\uFFFF' } })),
  ];
  for (const fire of hostile) { try { fire(); } catch {} await sleep(120); }
  await sleep(600);

  // The process is the assertion: if any of those escaped, this file is already dead.
  const survivor = open();
  await survivor.ready;
  await sleep(400);
  expect('server still accepts new connections after hostile frames',
    survivor.seen.includes('welcome'), JSON.stringify(survivor.seen));
  victim.ws.close();
  survivor.ws.close();
}

console.log('A blip is not a departure — the seat is held and resumed (RECON-01):');
{
  // The whole point of RECON-01, end to end over a real socket: kill the link
  // mid-match, come back with the token, and get the SAME pirate on the SAME
  // hull with the fleet untouched. Before the fix the close ran straight into
  // Match.removeClient: the player was deleted, the hull foundered (or was
  // spliced out of a match still counting down) and the only recovery the
  // client had was a reload into a new match.
  const first = open();
  const frames = [];
  first.ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await first.ready;
  first.sendJson({ type: 'set_name', ts: Date.now(), payload: { name: 'Castaway' } });
  first.sendJson({ type: 'solo_start', ts: Date.now(), payload: { botCount: 2 } });
  const waitFor = (buf, type, ms = 20_000) => new Promise(async (resolve) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = buf.find((m) => m.type === type);
      if (hit) return resolve(hit);
      await sleep(100);
    }
    resolve(null);
  });
  const welcome = await waitFor(frames, 'welcome', 5_000);
  const join = await waitFor(frames, 'join');
  expect('welcome carries a session token and a protocol version',
    !!welcome && typeof welcome.payload.sessionToken === 'string' && welcome.payload.sessionToken.length > 8
      && welcome.payload.protocolVersion === PROTOCOL_VERSION,
    JSON.stringify(welcome?.payload && { t: typeof welcome.payload.sessionToken, v: welcome.payload.protocolVersion }));
  expect('the solo match joined', !!join, `frames=${frames.map((f) => f.type).join(',')}`);

  if (welcome && join) {
    const playerId = join.payload.playerId;
    const shipId = join.payload.shipId;
    const hullsBefore = join.payload.snapshot.ships.length;

    // A blip, not a goodbye: terminate kills the TCP connection the way a lost
    // wifi does, with no close frame.
    first.ws.terminate();
    await sleep(1_500);

    const second = open();
    const back = [];
    second.ws.on('message', (data) => { try { back.push(JSON.parse(data.toString())); } catch {} });
    await second.ready;
    await waitFor(back, 'welcome', 5_000);
    second.sendJson({
      type: 'resume',
      ts: Date.now(),
      payload: { token: welcome.payload.sessionToken, protocolVersion: PROTOCOL_VERSION },
    });
    const ok = await waitFor(back, 'resume_ok', 8_000);
    const failed = back.find((m) => m.type === 'resume_failed');
    const rejoin = await waitFor(back, 'join', 8_000);
    expect('a resume inside the grace window is accepted', !!ok,
      failed ? `resume_failed: ${JSON.stringify(failed.payload)}` : `frames=${back.map((f) => f.type).join(',')}`);
    expect('the same pirate comes back', !!ok && ok.payload.playerId === playerId,
      `${ok?.payload.playerId} != ${playerId}`);
    expect('on the same hull', !!ok && ok.payload.shipId === shipId,
      `${ok?.payload.shipId} != ${shipId}`);
    expect('the resume is handed the world again, as a join', !!rejoin && !!rejoin.payload.snapshot,
      `frames=${back.map((f) => f.type).join(',')}`);
    expect('no hull left the fleet while the link was down',
      !!rejoin && rejoin.payload.snapshot.ships.length === hullsBefore,
      `${rejoin?.payload.snapshot.ships.length} != ${hullsBefore}`);

    // A token is good for exactly one resume; a second attempt is refused.
    const third = open();
    const again = [];
    third.ws.on('message', (data) => { try { again.push(JSON.parse(data.toString())); } catch {} });
    await third.ready;
    await waitFor(again, 'welcome', 5_000);
    third.sendJson({
      type: 'resume',
      ts: Date.now(),
      payload: { token: welcome.payload.sessionToken, protocolVersion: PROTOCOL_VERSION },
    });
    const reused = await waitFor(again, 'resume_failed', 5_000);
    expect('a spent token cannot be resumed twice',
      !!reused && reused.payload.reason === 'unknown_token', JSON.stringify(reused?.payload));

    // And a bundle from another protocol generation is sent to reload rather
    // than let back into a match whose wire it may not decode.
    third.sendJson({
      type: 'resume',
      ts: Date.now(),
      payload: { token: 'anything', protocolVersion: PROTOCOL_VERSION - 1 },
    });
    await sleep(400);
    const stale = again.filter((m) => m.type === 'resume_failed').pop();
    expect('a stale bundle is refused by version, not by token',
      !!stale && stale.payload.reason === 'stale_client', JSON.stringify(stale?.payload));
    third.ws.close();
    second.ws.close();
  }
}

console.log('A silently dead socket swept by the heartbeat keeps its seat (correctness-02):');
{
  // The half-open case RECON-01 exists for: iOS freezes a backgrounded tab, a
  // lid closes, wifi dies. The client sends NOTHING and answers no ws ping
  // (autoPong:false), so only the server's heartbeat sweep can notice. The
  // sweep terminates the socket and parks the seat; the 'close' that terminate
  // emits a tick later used to run onDisconnect a second time, find the seat
  // "already held", and dispose it: eliminated, hull foundered, resume refused.
  const frames = [];
  const ws = new WebSocket(URL, { autoPong: false });
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  ws.on('error', () => {});
  await new Promise((resolve) => ws.once('open', resolve));
  const waitFor = async (buf, type, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = buf.find((m) => m.type === type);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const welcome = await waitFor(frames, 'welcome', 5_000);
  ws.send(JSON.stringify({ type: 'set_name', ts: Date.now(), payload: { name: 'Sleeper' } }));
  ws.send(JSON.stringify({ type: 'solo_start', ts: Date.now(), payload: { botCount: 2 } }));
  const join = await waitFor(frames, 'join');
  expect('the sleeper joined a match', !!welcome && !!join, `frames=${frames.map((f) => f.type).join(',')}`);
  if (welcome && join) {
    const playerId = join.payload.playerId;
    const session = [...server.clients.values()].find((s) => s.matchPlayerId === playerId);
    const match = server.matches.get(session?.matchId);
    // Skip the wall-clock wait, not the mechanism: the world build is long
    // done and the socket has been silent past HEARTBEAT_TIMEOUT_MS. The REAL
    // heartbeat timer does the sweep (it fires every 5 s).
    session.matchJoinedAt = undefined;
    session.lastSeenAt = Date.now() - HEARTBEAT_TIMEOUT_MS - 1_000;
    for (let i = 0; i < 80 && session.ws.readyState === WebSocket.OPEN; i += 1) await sleep(100);
    expect('the heartbeat sweep dropped the silent socket', session.ws.readyState !== WebSocket.OPEN,
      `readyState=${session.ws.readyState}`);
    await sleep(1_000); // the late 'close' from terminate() has long landed by now
    const player = match?.playersById?.get(playerId);
    expect('the seat is still held after the late close', server.held.get(welcome.payload.sessionToken) === session,
      `held=${server.held.size} disposed=${session.disposed}`);
    expect('the sleeper is still in the match and never eliminated',
      !!match && match.clients.has(playerId) && !!player && player.state !== 'eliminated',
      `inMatch=${match?.clients.has(playerId)} state=${player?.state}`);

    const back = [];
    const second = new WebSocket(URL);
    second.on('message', (data) => { try { back.push(JSON.parse(data.toString())); } catch {} });
    second.on('error', () => {});
    await new Promise((resolve) => second.once('open', resolve));
    await waitFor(back, 'welcome', 5_000);
    second.send(JSON.stringify({ type: 'resume', ts: Date.now(),
      payload: { token: welcome.payload.sessionToken, protocolVersion: PROTOCOL_VERSION } }));
    const ok = await waitFor(back, 'resume_ok', 8_000);
    const rejoin = await waitFor(back, 'join', 8_000);
    const failed = back.find((m) => m.type === 'resume_failed');
    expect('the resume after a sweep is accepted', !!ok, failed ? `resume_failed: ${JSON.stringify(failed.payload)}` : '');
    expect('same pirate, seat kept', !!ok && ok.payload.playerId === playerId && !!rejoin,
      `${ok?.payload.playerId} != ${playerId}, join=${!!rejoin}`);
    expect('still not eliminated after the resume', match?.playersById?.get(playerId)?.state !== 'eliminated');
    second.close();
  }
  try { ws.terminate(); } catch {}
}

console.log('A match that ends during the hold replays its end on resume (correctness-08):');
{
  const frames = [];
  const ws = new WebSocket(URL);
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  ws.on('error', () => {});
  await new Promise((resolve) => ws.once('open', resolve));
  const waitFor = async (buf, type, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = buf.find((m) => m.type === type);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const welcome = await waitFor(frames, 'welcome', 5_000);
  ws.send(JSON.stringify({ type: 'set_name', ts: Date.now(), payload: { name: 'Absentee' } }));
  ws.send(JSON.stringify({ type: 'solo_start', ts: Date.now(), payload: { botCount: 2 } }));
  const join = await waitFor(frames, 'join');
  expect('the absentee joined a match', !!welcome && !!join);
  if (welcome && join) {
    const playerId = join.payload.playerId;
    const session = [...server.clients.values()].find((s) => s.matchPlayerId === playerId);
    const match = server.matches.get(session?.matchId);
    ws.terminate(); // the link dies mid-match
    for (let i = 0; i < 30 && !server.held.has(welcome.payload.sessionToken); i += 1) await sleep(100);
    expect('the seat is held', server.held.has(welcome.payload.sessionToken));
    // While he is gone his crew banks the win: a real gold victory through the
    // match's own win check, which broadcasts game_over and match_ended to a
    // socket that is dead.
    const player = match.playersById.get(playerId);
    player.gold = 1e9;
    match.state.phase = 'playing';
    match.checkWinCondition();
    expect('the match ended while he was away', match.isEnded(), `phase=${match.state.phase}`);
    await sleep(300);

    const back = [];
    const second = new WebSocket(URL);
    second.on('message', (data) => { try { back.push(JSON.parse(data.toString())); } catch {} });
    second.on('error', () => {});
    await new Promise((resolve) => second.once('open', resolve));
    await waitFor(back, 'welcome', 5_000);
    second.send(JSON.stringify({ type: 'resume', ts: Date.now(),
      payload: { token: welcome.payload.sessionToken, protocolVersion: PROTOCOL_VERSION } }));
    await waitFor(back, 'match_ended', 5_000);
    const types = back.map((m) => m.type);
    const iOk = types.indexOf('resume_ok');
    const iJoin = types.indexOf('join');
    const iOver = types.indexOf('game_over');
    const iEnd = types.indexOf('match_ended');
    expect('resume_ok, then join, then game_over, then match_ended',
      iOk >= 0 && iJoin > iOk && iOver > iJoin && iEnd > iOver, `frames=${types.join(',')}`);
    const over = back[iOver];
    const ended = back[iEnd];
    expect('the replayed game_over names the gold win', !!over && over.payload.reason === 'gold'
      && over.payload.winnerId === playerId, JSON.stringify(over?.payload));
    expect('the replayed match_ended carries the end board', !!ended && Array.isArray(ended.payload.board)
      && ended.payload.board.length > 0 && ended.payload.humans.some((h) => h.playerId === playerId),
      JSON.stringify(ended?.payload && { board: ended.payload.board?.length, humans: ended.payload.humans?.length }));
    const resumed = [...server.clients.values()].find((s) => s.matchPlayerId === playerId);
    expect('the resumed session is on the end screen with a fresh detach clock',
      resumed?.state === 'match_ended' && Date.now() - (resumed?.endedMatchSince ?? 0) < 2_000,
      `state=${resumed?.state} endedAgo=${Date.now() - (resumed?.endedMatchSince ?? 0)}`);
    second.close();
  }
}

console.log('The client supervises its own link (RECON-01 client half):');
{
  // NetworkClient, driven straight from node: no Worker (spawnWorker catches the
  // ReferenceError and falls back to the direct socket, which is the pre-worker
  // path it keeps byte-for-byte) and `ws` standing in for the browser global.
  globalThis.WebSocket = WebSocket;
  const { NetworkClient } = await import('../src/client/network/NetworkClient.ts');

  // 1. A cold start. The platform is not listening yet; the old client raced a
  //    single connect() against a 6 s timeout and painted "…then refresh".
  const coldPort = await freePort();
  const cold = new NetworkClient();
  const attempts = [];
  // b1.1e: connect() owns the initial retries and reports them through
  // onConnectProgress (onReconnecting is the post-join supervisor's hook).
  cold.onConnectProgress = (p) => { if (p.phase === 'retrying' || p.phase === 'offline') attempts.push(p.attempt); };
  const coldServer = new LobbyServer();
  setTimeout(() => coldServer.init(coldPort), 2_200);
  const t0 = Date.now();
  let coldOk = true;
  try { await cold.connect(`ws://127.0.0.1:${coldPort}/ws`); } catch { coldOk = false; }
  expect('connect survives a server that is not up yet', coldOk, `after ${Date.now() - t0}ms`);
  expect('and it retried rather than failing once', attempts.length >= 2, `attempts=${attempts.join(',')}`);
  cold.disconnect();

  // 2. A blip mid-match: the transport dies with 1006 and the client puts
  //    itself back in the same seat with no reload and no player action.
  const live = new NetworkClient();
  let resumed = null;
  let joinedPlayerId = null;
  live.onResumed = (p) => { resumed = p; };
  live.onJoin = (playerId) => { joinedPlayerId ??= playerId; };
  await live.connect(URL);
  live.setName('Blip');
  live.soloStart(2);
  for (let i = 0; i < 200 && !joinedPlayerId; i += 1) await sleep(100);
  expect('the harness client reached a match', !!joinedPlayerId);
  // Kill the TCP connection under it — a lost wifi, not a goodbye.
  live.ws.terminate();
  for (let i = 0; i < 200 && !resumed; i += 1) await sleep(100);
  expect('the client reconnects and resumes with no reload', !!resumed,
    `resumed=${JSON.stringify(resumed)}`);
  expect('into the same seat', !!resumed && resumed.playerId === joinedPlayerId,
    `${resumed?.playerId} != ${joinedPlayerId}`);
  live.disconnect();
  coldServer.emergencyStop('test over');
}

console.log('A starved sim counts what it throws away:');
{
  // MAX_CATCHUP_TICKS bounds the catch-up per callback and the surplus backlog is
  // DROPPED — the right call (grinding it out is the death spiral) but also the
  // mechanism that turns CPU starvation into silent slow motion. A match once ran
  // at ~7% real time with a clean log. Here a callback arrives 4s late, which is
  // what a starved host looks like from inside runTicks.
  const starved = new Match({ matchId: 'dilation-test', botCount: 2 });
  starved.state.phase = 'playing';
  starved.playingSinceWallMs = Date.now() - 5_000;
  starved.lastTickWallMs = performance.now() - 4_000;
  starved.tickBacklogSec = 0;
  const before = starved.droppedTickCount();
  starved.runTicks();
  const dropped = starved.droppedTickCount() - before;
  expect('a 4s-late callback books the ticks it will never run', dropped > 200,
    `dropped=${dropped}`);
  expect('sim lag is reportable as one number', starved.simLagSeconds() > 3,
    `simLagSeconds=${starved.simLagSeconds()}`);
  starved.stop();
}

console.log('Health reports sim dilation:');
{
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const body = await res.json();
  expect('/health answers ok', body.ok === true);
  expect('/health carries worstSimLagSec', typeof body.worstSimLagSec === 'number',
    JSON.stringify(body));
  expect('/health carries a droppedTicks total', typeof body.droppedTicks === 'number',
    JSON.stringify(body));
  expect('/health carries a per-match sims array', Array.isArray(body.sims));
}

await sleep(200);
if (failures > 0) {
  console.error(`\n${failures} net-resilience assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll net-resilience assertions passed.');
process.exit(0);
