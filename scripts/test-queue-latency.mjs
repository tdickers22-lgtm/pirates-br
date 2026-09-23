#!/usr/bin/env node
/**
 * PUBLIC QUEUE LATENCY with the PRODUCTION clocks (online-03, online-17, b1.2c).
 *
 * Launch-day population is 0-5 people. The queue used to hold a lone captain
 * for the 90 s hard wait (the 45 s soft wait needed 6 solo crews), then 8 s of
 * countdown: ~100 s from Play to sailing. D10 set the bar: one clock per mode,
 * T0 = the oldest waiting crew; dispatch at T0+12 s once >= 2 crews wait, at
 * T0+20 s regardless; a crew that queues during the 8 s countdown takes a BOT
 * hull of that match (the fleet never grows); at capacity a crew stays queued
 * with a position, never a lobby_error.
 *
 * This suite never writes LobbyServer.tunables: the numbers graded here are the
 * shipped ones. Time is FAKE (Date.now is driven by the test and tick() is
 * called by hand), so 20 s of queue costs milliseconds. LobbyServer is never
 * init()ed (no port); sockets are ws-shaped fakes; the matches are real.
 * PIRATES_BR_MAX_MATCHES=1 is set before the import so the capacity case runs.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

process.env.PIRATES_BR_MAX_MATCHES = '1';
const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.msgs = [];
  ws.send = (data) => { try { ws.msgs.push(JSON.parse(String(data))); } catch {} };
  ws.ping = () => {};
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  ws.terminate = ws.close;
  return ws;
}

const server = new LobbyServer();
/** Every match the suite ever saw, so the finally can stop them all. */
const seen = new Set();

function captain(name) {
  const ws = fakeSocket();
  server.onConnect(ws);
  const say = (type, payload = {}) => ws.emit('message', Buffer.from(JSON.stringify({ type, ts: Date.now(), payload })), false);
  say('set_name', { name });
  const c = {
    ws, name, say,
    all: (type) => ws.msgs.filter((m) => m.type === type),
    last: (type) => [...ws.msgs].reverse().find((m) => m.type === type),
    session: () => [...server.clients.values()].find((s) => s.ws === ws),
  };
  return c;
}

/** Advance fake time in 250 ms steps, ticking the lobby, until `until()` or `maxMs`. */
function advance(maxMs, until = () => false) {
  const start = clock;
  while (clock - start < maxMs) {
    clock += 250;
    server.tick();
    for (const m of server.matches.values()) seen.add(m);
    if (until()) break;
  }
  return (clock - start) / 1000;
}

function endAllMatches() {
  for (const [id, match] of Array.from(server.matches)) {
    try { match.stop(); } catch {}
    server.matches.delete(id);
    server.queueMatchSlots?.delete?.(id);
  }
}

const botHulls = (match) => match.state.ships.filter((sh) => {
  const crew = sh.crewIds ?? [];
  return crew.length > 0 && crew.every((id) => match.state.players.find((p) => p.id === id)?.isBot);
}).length;

try {
  console.log(`production clocks: soft ${LobbyServer.tunables.queueSoftWaitSeconds} s, hard ${LobbyServer.tunables.queueHardWaitSeconds} s`);

  console.log('\nA lone captain sails inside 20 s:');
  {
    const lone = captain('Lone');
    const t0 = clock;
    lone.say('queue_join', { mode: 'solo' });
    const first = lone.last('queue_update')?.payload;
    expect('queue_update carries an honest ETA (etaSeconds <= 20)',
      typeof first?.etaSeconds === 'number' && first.etaSeconds <= 20 && first.etaSeconds > 0,
      JSON.stringify(first));
    advance(120_000, () => !!lone.last('match_start'));
    const waited = (clock - t0) / 1000;
    expect('match_start reaches a lone solo captain <= 20 s after queue_join', !!lone.last('match_start') && waited <= 20,
      `waited ${waited.toFixed(2)} s, match_start=${!!lone.last('match_start')}`);
    expect('and no lobby_error on the way', lone.all('lobby_error').length === 0,
      JSON.stringify(lone.all('lobby_error').map((m) => m.payload)));
    endAllMatches();
  }

  console.log('\nTwo crews 10 s apart share one match, dispatched at T0+12 s:');
  let shared = null;
  {
    const a = captain('Anne');
    const b = captain('Bonny');
    const t0 = clock;
    a.say('queue_join', { mode: 'solo' });
    advance(10_000);
    expect('the first crew is still waiting at T0+10 s', !a.last('match_start'));
    b.say('queue_join', { mode: 'solo' });
    const eta = b.last('queue_update')?.payload?.etaSeconds;
    expect('with two crews waiting, the ETA quotes the 12 s clock (<= 2 s left)', typeof eta === 'number' && eta <= 2, `eta=${eta}`);
    advance(120_000, () => !!a.last('match_start') && !!b.last('match_start'));
    const waited = (clock - t0) / 1000;
    const ma = a.last('match_start')?.payload?.matchId;
    const mb = b.last('match_start')?.payload?.matchId;
    expect('both got match_start with the SAME matchId', !!ma && ma === mb, `a=${ma} b=${mb}`);
    expect('dispatched at T0+12 s (two crews), not the 20 s fallback', waited <= 12.5, `dispatched at T0+${waited.toFixed(2)} s`);
    shared = ma ? server.matches.get(ma) : null;
  }

  console.log('\nA crew queueing in the 8 s countdown takes a BOT hull of that match:');
  {
    const match = shared;
    expect('the shared match is still awaiting the horn', !!match && match.isAwaitingHorn());
    const shipsBefore = match?.state.ships.length ?? 0;
    const botsBefore = match ? botHulls(match) : 0;
    const late = captain('Late');
    late.say('queue_join', { mode: 'solo' });
    const ml = late.last('match_start')?.payload?.matchId;
    expect('the late crew boards the SAME match', !!ml && ml === match?.id, `late=${ml} shared=${match?.id}`);
    expect('the match has one bot hull fewer', !!match && botHulls(match) === botsBefore - 1,
      `bot hulls ${botsBefore} -> ${match ? botHulls(match) : 'n/a'}`);
    expect('and the fleet did not grow', !!match && match.state.ships.length === shipsBefore,
      `ships ${shipsBefore} -> ${match?.state.ships.length}`);
    expect('match_start.botCount matches the bot hulls left', late.last('match_start')?.payload?.botCount === botHulls(match),
      `botCount=${late.last('match_start')?.payload?.botCount} hulls=${botHulls(match)}`);
  }

  console.log('\nAt capacity a crew stays queued with a position, never a lobby_error (online-17):');
  {
    expect('the host is at its ceiling (1 live match)', server.matches.size === 1, `matches=${server.matches.size}`);
    const d = captain('Drake');
    d.say('queue_join', { mode: 'duos' });
    advance(100_000); // past every mode's hard wait, today's and the 90 s one
    const upd = d.last('queue_update')?.payload;
    expect('no lobby_error while every berth is busy', d.all('lobby_error').length === 0,
      JSON.stringify(d.all('lobby_error').map((m) => m.payload)));
    expect('still queued after 100 s', d.session()?.state === 'queue', `state=${d.session()?.state}`);
    expect('queue_update says so: atCapacity + position 1', upd?.atCapacity === true && upd?.position === 1, JSON.stringify(upd));
    endAllMatches();
    advance(2_000, () => !!d.last('match_start'));
    expect('the moment a berth frees, that crew is dispatched', !!d.last('match_start'), `state=${d.session()?.state}`);
  }
} finally {
  endAllMatches();
  for (const m of seen) { try { m.stop(); } catch {} }
  Date.now = realNow;
}

if (failures > 0) {
  console.error(`\n${failures} queue-latency assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll queue-latency assertions passed.');
process.exit(0);
