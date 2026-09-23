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

  // ── b1.2h LATE JOIN (critique gap 1, D10) ─────────────────────────────
  // The match sim is ticked by hand (Match.tick, one fixed 16 ms step each), so
  // the horn sounds and bots sail on the same fake clock the lobby reads.
  const TICKS_PER_STEP = 250 / 16;
  let tickDebt = 0;
  function simAdvance(maxMs, until = () => false) {
    const start = clock;
    while (clock - start < maxMs) {
      clock += 250;
      tickDebt += TICKS_PER_STEP;
      const n = Math.floor(tickDebt);
      tickDebt -= n;
      for (const m of server.matches.values()) {
        seen.add(m);
        if (m.endedAtMs()) continue;
        for (let i = 0; i < n; i++) m.tick();
      }
      server.tick();
      if (until()) break;
    }
    return (clock - start) / 1000;
  }
  const takeovers = [];
  function watchTakeovers(match) {
    if (match.__watched || typeof match.takeOverBotHull !== 'function') return;
    match.__watched = true;
    const orig = match.takeOverBotHull.bind(match);
    match.takeOverBotHull = (members) => {
      const ship = match.lateJoinCandidate();
      const hands = ship ? ship.crewIds.map((id) => match.state.players.find((p) => p.id === id)).filter(Boolean)
        .map((p) => ({ x: p.position.x, z: p.position.z })) : [];
      const humansBefore = match.state.players.filter((p) => !p.isBot).map((p) => ({ id: p.id, x: p.position.x, z: p.position.z }));
      const out = orig(members);
      if (out) {
        let nearest = Infinity;
        for (const h of humansBefore) for (const b of hands) nearest = Math.min(nearest, Math.hypot(h.x - b.x, h.z - b.z));
        takeovers.push({ shipId: out.shipId, holes: ship.holes.filter((x) => !x.patched).length, nearestHumanToVanished: nearest });
      }
      return out;
    };
  }

  console.log('\nMAX_MATCHES=1: lone players at t=0/40/80/120 s all sail inside 20 s (the later ones by late join):');
  {
    endAllMatches();
    const T = clock;
    const crews = [];
    for (const [i, at] of [0, 40, 80, 120].entries()) {
      simAdvance(Math.max(0, T + at * 1000 - clock));
      for (const m of server.matches.values()) watchTakeovers(m);
      const c = captain(`Lone${i}`);
      c.joinedAt = clock;
      c.say('queue_join', { mode: 'solo' });
      crews.push(c);
      simAdvance(25_000, () => !!c.last('match_start'));
      const ms = c.last('match_start');
      c.startedAt = ms ? clock : null;
      const waited = ms ? (c.startedAt - c.joinedAt) / 1000 : Infinity;
      expect(`lone player at t=${at} s: match_start <= 20 s`, waited <= 20, `waited ${waited} s, errors=${JSON.stringify(c.all('lobby_error').map((m) => m.payload))}`);
      if (i > 0) {
        expect(`  ...by late join into the running match (lateJoin.stormPhase >= 1, same matchId)`,
          ms?.payload?.lateJoin?.stormPhase >= 1 && ms?.payload?.matchId === crews[0].last('match_start')?.payload?.matchId,
          JSON.stringify(ms?.payload));
      }
      expect(`  ...and no lobby_error`, c.all('lobby_error').length === 0);
    }
    expect('the host never ran a second match (MAX_MATCHES=1)', server.matches.size === 1, `matches=${server.matches.size}`);
    expect('three takeovers were observed', takeovers.length === 3, `takeovers=${takeovers.length}`);
    expect('no taken hull had an open hole', takeovers.every((t) => t.holes === 0), JSON.stringify(takeovers));
    expect('no bot pirate vanished within 150 m of another human', takeovers.every((t) => t.nearestHumanToVanished >= 150),
      takeovers.map((t) => t.nearestHumanToVanished.toFixed(0)).join(', '));
    endAllMatches();
  }

  console.log('\nAn ineligible hull (open hole, engaged, outside the ring, human close by) is never taken:');
  {
    const { Match } = await import('../src/server/core/Match.ts');
    const m = new Match({ matchId: 'elig-test', botCount: 11, mode: 'solo' });
    if (typeof m.lateJoinCandidate !== 'function' || typeof m.takeOverBotHull !== 'function') {
      expect('Match exposes lateJoinCandidate + takeOverBotHull', false);
      throw new Error('no late-join API on Match');
    }
    seen.add(m);
    m.state.phase = 'playing';
    const bots = () => m.state.ships.filter((sh) => sh.crewIds.every((id) => m.state.players.find((p) => p.id === id)?.isBot));
    const hulls = bots();
    // The hull farthest from every other hull is the one we keep clean.
    const gap = (sh) => Math.min(...m.state.ships.filter((o) => o !== sh).map((o) => Math.hypot(o.position.x - sh.position.x, o.position.z - sh.position.z)));
    const clean = [...hulls].sort((a, b) => gap(b) - gap(a))[0];
    const hand = (sh) => m.state.players.find((p) => p.id === sh.crewIds[0]);
    const storm = m.state.storm;
    hulls.forEach((sh, i) => {
      if (sh === clean) return;
      if (i % 3 === 0) sh.holes.push({ id: 99, x: 0, y: -0.5, z: 0, patched: false });
      else if (i % 3 === 1) hand(sh).lastDamagedAt = m.t;
      else { sh.position.x = storm.centerX + storm.safeRadius + 400; sh.position.z = storm.centerZ; for (const id of sh.crewIds) { const p = m.state.players.find((q) => q.id === id); p.position.x = sh.position.x; p.position.z = sh.position.z; } }
    });
    expect('the clean hull (farthest from others) is the candidate', m.lateJoinCandidate()?.id === clean.id,
      `candidate=${m.lateJoinCandidate()?.id?.slice(0, 6)} clean=${clean.id.slice(0, 6)} gap=${gap(clean).toFixed(0)} m`);
    clean.holes.push({ id: 98, x: 0, y: -0.5, z: 0, patched: false });
    expect('with an open hole on it too, no hull is eligible', m.lateJoinCandidate() === null);
    clean.holes = [];
    // A human pirate 100 m away blocks the takeover; 200 m does not.
    const human = m.createCrew([{ ws: fakeSocket(), name: 'Watcher' }]);
    const hp = m.state.players.find((p) => p.id === human.joins[0].playerId);
    hp.position = { x: clean.position.x + 100, y: 0, z: clean.position.z };
    const blocked = m.lateJoinCandidate();
    expect('a human within 150 m of the hull blocks it', blocked === null || blocked.id !== clean.id, `candidate=${blocked?.id?.slice(0, 6)}`);
    hp.position = { x: clean.position.x, y: 0, z: clean.position.z + 5000 };
    const botsBefore = m.botCrewCount();
    const shipsBefore = m.state.ships.length;
    const out = m.takeOverBotHull([{ ws: fakeSocket(), name: 'Latecomer' }]);
    expect('the takeover took exactly the clean hull', out?.shipId === clean.id, `took=${out?.shipId?.slice(0, 6)}`);
    const p = out && m.state.players.find((q) => q.id === out.joins[0].playerId);
    expect('the human stands on her deck, crewing her, and the bot hands are gone',
      !!p && !p.isBot && p.onShipId === clean.id && clean.crewIds.length === 1 && clean.crewIds[0] === p.id
      && m.state.players.filter((q) => q.shipId === clean.id && q.isBot).length === 0,
      JSON.stringify({ onShip: p?.onShipId === clean.id, crew: clean.crewIds.length }));
    expect('the fleet is the same size, one bot hull fewer', m.state.ships.length === shipsBefore && m.botCrewCount() === botsBefore - 1);
    expect('no other hull is taken while all are ineligible', m.takeOverBotHull([{ ws: fakeSocket(), name: 'Nobody' }]) === null);
    m.stop();
  }

  console.log('\nA soak-tagged match is ended before a real crew is queued for capacity:');
  {
    endAllMatches();
    const soak = captain('Soak');
    soak.say('queue_join', { mode: 'solo', soak: true });
    simAdvance(40_000, () => !!soak.last('match_start') && [...server.matches.values()].some((m) => m.isPlaying()));
    const soakMatchId = soak.last('match_start')?.payload?.matchId;
    expect('the soak crew sailed and the host is at its ceiling', !!soakMatchId && server.matches.size === 1);
    const real = captain('Real');
    const t0 = clock;
    real.say('queue_join', { mode: 'solo' });
    expect('the soak match is gone the moment a real crew queues', !server.matches.has(soakMatchId), `matches=${[...server.matches.keys()].map((k) => k.slice(0, 6))}`);
    expect('and the soak match was never offered to the real crew', real.last('match_start')?.payload?.matchId !== soakMatchId);
    simAdvance(25_000, () => !!real.last('match_start'));
    expect('the real crew never read atCapacity', real.all('queue_update').every((u) => !u.payload.atCapacity),
      JSON.stringify(real.all('queue_update').map((u) => u.payload)));
    expect('and sailed inside 20 s on a fresh match', !!real.last('match_start') && (clock - t0) / 1000 <= 20);
    expect('no lobby_error for either', real.all('lobby_error').length === 0 && soak.all('lobby_error').length === 0);
    endAllMatches();
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
