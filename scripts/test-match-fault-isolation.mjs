#!/usr/bin/env node
// ONE MATCH'S BUG ENDS ONE MATCH, NOT THE SERVER (correctness-01, b1.2a).
//
// Match.start() drives the sim from a bare setInterval. Before this gate a
// throw inside Match.tick() had no caller to catch it: it reached
// process 'uncaughtException', index.ts counted it toward FATAL_BUDGET (5 in
// 60 s), and because the interval stayed armed the SAME deterministic throw
// fired again 16.7 ms later. Five throws in ~80 ms -> emergencyStop() -> every
// match on the (single, D1) machine closed with 1012 and the process exited.
//
// The contract now: a tick fault is caught inside runTicks, logged as a
// structured `match_fault` line, and counted per match. Three faults inside
// 5 s quarantine THAT match (interval stopped, match_ended{reason:
// 'server_fault'} to its clients, onFault -> the lobby reaps it and sends the
// crews back to their party). Every other match keeps ticking and nothing
// reaches the process-level fatal handler.
//
// Real timers, two real Match instances, fake sockets. No port, no browser. ~2 s.
import { Match } from '../src/server/core/Match.ts';
import { readFileSync } from 'node:fs';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// The process-level fatal counter, as index.ts sees it.
let uncaught = 0;
process.on('uncaughtException', () => { uncaught += 1; });
process.on('unhandledRejection', () => { uncaught += 1; });

function recordingWs() {
  const sent = [];
  return { sent, readyState: 1, send(s) { sent.push(typeof s === 'string' ? JSON.parse(s) : s); },
    close() { this.readyState = 3; }, on() {}, once() {}, removeListener() {}, ping() {}, terminate() {} };
}

function makeLiveMatch(id) {
  const m = new Match({ matchId: id, botCount: 2 });
  const ws = recordingWs();
  m.addHumanClient(ws, `Crew-${id}`);
  m.start();
  // Skip the staged-start countdown so tick() reaches the playing-phase systems.
  m.state.phase = 'playing';
  m.countdownRemaining = 0;
  m.state.countdownRemaining = 0;
  return { m, ws };
}

console.log('Match fault isolation (one match faults, the server keeps serving)');

const A = makeLiveMatch('fault-A');
const B = makeLiveMatch('fault-B');
let injected = 0;
A.m.updateCaptures = () => { injected += 1; throw new Error('injected tick fault (test-match-fault-isolation)'); };
let faultCalls = 0;
let faultReason = null;
A.m.onFault = (reason) => { faultCalls += 1; faultReason = reason; };
const bStart = B.m.tickCount;

const deadline = Date.now() + 3000;
while (Date.now() < deadline && B.m.tickCount - bStart < 20) {
  await new Promise((r) => setTimeout(r, 20));
}
// Give A's interval a few more periods: a quarantined match must stay quiet.
await new Promise((r) => setTimeout(r, 150));
const bTicks = B.m.tickCount - bStart;

expect('match B ticked 20x while match A was throwing', bTicks >= 20, `B advanced ${bTicks} ticks`);
expect('no tick fault reached process uncaughtException (index.ts FATAL_BUDGET untouched)', uncaught === 0,
  `${uncaught} uncaught`);
expect('match A faulted exactly 3 times, then stopped ticking', injected === 3, `${injected} injected throws ran`);
expect('match A is quarantined (tick interval cleared)', A.m.tickInterval === null && A.m.isQuarantined?.() === true);
expect('match B is still live (interval armed, not quarantined)', B.m.tickInterval !== null && !B.m.isQuarantined?.());
const ended = A.ws.sent.filter((msg) => msg?.type === 'match_ended');
expect("match A's clients received match_ended{reason:'server_fault'}",
  ended.length === 1 && ended[0].payload?.reason === 'server_fault',
  JSON.stringify(ended.map((e) => e.payload?.reason)));
expect("match B's clients received no match_ended",
  !B.ws.sent.some((msg) => msg?.type === 'match_ended'));
expect('onFault fired once so the lobby can reap A and send its crews to their party',
  faultCalls === 1 && faultReason === 'server_fault', `${faultCalls} calls, reason ${faultReason}`);

// The lobby wiring: a quarantined match is reaped (detachToParty per session)
// and its result is not persisted as a real placement.
const LOBBY = readFileSync(new URL('../src/server/core/LobbyServer.ts', import.meta.url), 'utf8');
expect('LobbyServer wires match.onFault to reapMatch',
  /onFault\s*=[\s\S]{0,200}reapMatch\(/.test(LOBBY));
expect("LobbyServer does not persist a 'server_fault' result as a placement",
  /server_fault/.test(LOBBY.match(/private onMatchEnd\([\s\S]*?\n  }\n/)?.[0] ?? ''));

A.m.stop();
B.m.stop();
console.log(failures === 0 ? '\nPASS match fault isolation' : `\nFAIL match fault isolation (${failures})`);
process.exit(failures === 0 ? 0 : 1);
