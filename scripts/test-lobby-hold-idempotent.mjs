#!/usr/bin/env node
/**
 * RECON-01 seat hold vs. the heartbeat sweep (correctness-02, b1.2b).
 *
 * The sweep terminates a silent socket and then calls onDisconnect itself,
 * because terminate() on an already-broken socket is not guaranteed to emit
 * 'close'. But it usually DOES emit it, a tick later. The first call parked
 * the seat (heldSince set); the second one used to find shouldHold() false
 * ("already held") and fall through to disposeSession: held.delete, then
 * Match.removeClient, so the player was eliminated and his hull foundered two
 * milliseconds after the server promised him 60 s of grace. That is exactly
 * the phone-backgrounded / lid-closed case the hold exists for.
 *
 * Pinned here, with no port and no real socket (LobbyServer is constructed but
 * never init()ed; the match is a counting fake):
 *   1. onDisconnect twice leaves ONE hold, no removeClient, the session still
 *      in `clients`, heldSince unchanged.
 *   2. The sweep path end to end: terminate() that emits 'close' on the next
 *      tick, like ws does, keeps the seat held.
 *   3. The 'close' listener is identity-safe: a close from a socket the session
 *      no longer owns never touches the session.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { LobbyServer } from '../src/server/core/LobbyServer.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const nextTick = () => new Promise((r) => setImmediate(r));

/** A socket shaped like ws's: terminate() closes asynchronously. */
function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.sent = [];
  ws.send = (data) => { ws.sent.push(String(data)); };
  ws.ping = () => {};
  ws.close = () => { ws.terminate(); };
  ws.terminate = () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    ws.readyState = WebSocket.CLOSED;
    setImmediate(() => ws.emit('close', 1006, Buffer.alloc(0)));
  };
  return ws;
}

function fakeMatch() {
  const calls = { removeClient: 0, markDisconnected: 0 };
  return {
    calls,
    isEnded: () => false,
    markDisconnected: () => { calls.markDisconnected += 1; return true; },
    removeClient: () => { calls.removeClient += 1; },
    resumeClient: () => null,
    resumeReplay: () => [],
  };
}

/** Put a freshly connected session into a live match, the way the lobby would. */
function seatInMatch(server, ws, matchId) {
  server.onConnect(ws);
  const session = [...server.clients.values()].find((s) => s.ws === ws);
  session.name = 'Castaway';
  session.state = 'in_match';
  session.matchId = matchId;
  session.matchPlayerId = `p-${session.id.slice(0, 6)}`;
  server.clientToMatch?.set?.(session.id, matchId);
  return session;
}

const server = new LobbyServer();

console.log('onDisconnect is idempotent for a held seat:');
{
  const match = fakeMatch();
  server.matches.set('m-idem', match);
  const ws = fakeSocket();
  const session = seatInMatch(server, ws, 'm-idem');
  server.onDisconnect(session);
  const heldSince = session.heldSince;
  server.onDisconnect(session);
  expect('the seat is held once', server.held.size === 1 && server.held.get(session.token) === session,
    `held.size=${server.held.size}`);
  expect('a second onDisconnect never removes the player from the match', match.calls.removeClient === 0,
    `removeClient calls=${match.calls.removeClient}`);
  expect('the parked session stays in clients', server.clients.has(session.id));
  expect('heldSince is not re-stamped', session.heldSince === heldSince && typeof heldSince === 'number');
  expect('the match hears about the drop exactly once', match.calls.markDisconnected === 1,
    `markDisconnected calls=${match.calls.markDisconnected}`);
  expect('the session is not disposed', session.disposed !== true);
  server.held.clear();
  server.clients.clear();
}

console.log('The heartbeat sweep path keeps the seat (terminate + late close):');
{
  const match = fakeMatch();
  server.matches.set('m-sweep', match);
  const ws = fakeSocket();
  const session = seatInMatch(server, ws, 'm-sweep');
  session.matchJoinedAt = undefined;              // past the world-build window
  session.lastSeenAt = Date.now() - 60_000;       // silent far past HEARTBEAT_TIMEOUT_MS
  server.sweepDeadSockets();
  await nextTick();
  await nextTick();                               // let the async 'close' land
  expect('the swept socket was terminated', ws.readyState === WebSocket.CLOSED);
  expect('the seat is still held after the late close', server.held.get(session.token) === session,
    `held.size=${server.held.size} disposed=${session.disposed}`);
  expect('the player was never removed from the match', match.calls.removeClient === 0,
    `removeClient calls=${match.calls.removeClient}`);
  expect('the parked session is still in clients', server.clients.has(session.id));
  server.held.clear();
  server.clients.clear();
}

console.log("The 'close' listener is identity-safe:");
{
  const match = fakeMatch();
  server.matches.set('m-ident', match);
  const oldWs = fakeSocket();
  const session = seatInMatch(server, oldWs, 'm-ident');
  // The session now speaks through another socket; the superseded one closing
  // late must not park or dispose it.
  session.ws = fakeSocket();
  session.state = 'menu';
  oldWs.terminate();
  await nextTick();
  await nextTick();
  expect('a close from a socket the session no longer owns is ignored',
    server.clients.has(session.id) && session.disposed !== true && session.heldSince === undefined,
    `inClients=${server.clients.has(session.id)} disposed=${session.disposed} heldSince=${session.heldSince}`);
  expect('and it never reached the match', match.calls.removeClient === 0 && match.calls.markDisconnected === 0);
  server.clients.clear();
}

if (failures > 0) {
  console.error(`\n${failures} lobby-hold assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll lobby-hold assertions passed.');
process.exit(0);
