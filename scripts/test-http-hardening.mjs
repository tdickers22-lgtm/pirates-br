#!/usr/bin/env node
/**
 * Server-safety contract (NET-01): one bad request, one throwing join, one
 * disk-filling client must never take the process down.
 *
 * Runs a real LobbyServer in THIS process (the test-net-resilience pattern) so
 * the failure mode is unmistakable: before the fix the first malformed GET
 * raised URIError out of the http 'request' listener, Node had no handler, and
 * this whole process exited. Every live match on the host went with it.
 *
 *   - `GET /%E0%A4%A`  (invalid percent sequence)  -> 400, then /health 200
 *   - `GET //[ HTTP/1.1` (new URL throws)          -> 400, then /health 200
 *   - a throw inside placeClientIntoMatch strands nobody: the other cohort
 *     members still board, the failed one gets lobby_error + lobby_left and
 *     can queue again, a match nobody boarded is reaped, the tick survives
 *   - POST /bugsnap is 404 unless PIRATES_BR_DEV=1 (or a matching key), holds
 *     at most 50 snaps (oldest evicted), and rate-limits to one per 10 s per IP
 *
 * NEVER port 8080 on this machine: a content filter there replays the upgrade
 * bytes and corrupts every websocket.
 */
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { LobbyServer } from '../src/server/core/LobbyServer.ts';
import { Match } from '../src/server/core/Match.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const PORT = 8792;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Production posture for the bugsnap checks: no dev flag, no key, and a scratch
// directory so the suite never touches data/bugsnaps of a real host.
delete process.env.PIRATES_BR_DEV;
delete process.env.BUGSNAP_KEY;
const snapDir = mkdtempSync(join(tmpdir(), 'pbr-bugsnaps-'));
process.env.BUGSNAP_DIR = snapDir;

// The red proof: on HEAD the server exits the process on the first bad GET.
// Turn that into a graded FAIL line instead of a bare stack so the runner sees
// evidence either way (a process that dies with no PASS/FAIL is VACUOUS).
process.on('uncaughtException', (err) => {
  console.error(`  ✗ FAIL: uncaught exception escaped the server: ${err && err.message}`);
  process.exit(1);
});

const server = new LobbyServer();
server.init(PORT);
await sleep(400);

async function health() {
  try {
    const res = await fetch(`${HTTP}/health`);
    return res.status;
  } catch (e) {
    return `error:${e.cause?.code ?? e.message}`;
  }
}

/** Send a raw request line the URL parser cannot even lex, read the status. */
function rawRequest(line) {
  return new Promise((resolve) => {
    const sock = connect(PORT, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => sock.write(`${line}\r\nHost: localhost\r\n\r\n`));
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => resolve(buf));
    sock.on('error', (e) => resolve(`error:${e.code}`));
    setTimeout(() => { try { sock.destroy(); } catch {} }, 1500);
  });
}

console.log('Malformed requests get 400, not a dead process:');
{
  let status;
  try { status = (await fetch(`${HTTP}/%E0%A4%A`)).status; } catch (e) { status = `error:${e.cause?.code ?? e.message}`; }
  expect('invalid percent-encoding -> 400', status === 400, `status=${status}`);
  expect('/health still 200 after the bad decode', (await health()) === 200);

  const raw = await rawRequest('GET //[ HTTP/1.1');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  expect('unparseable URL -> 400', m && m[1] === '400', `response=${JSON.stringify(raw.slice(0, 60))}`);
  expect('/health still 200 after the bad URL', (await health()) === 200);

  let trav;
  try { trav = (await fetch(`${HTTP}/..%2F..%2Fetc%2Fpasswd`)).status; } catch (e) { trav = `error:${e.message}`; }
  expect('traversal falls back to index (200 or 503), never a throw', trav === 200 || trav === 503, `status=${trav}`);
}

/** Open a socket and collect every message (type + payload) it is sent. */
function open() {
  const ws = new WebSocket(WS_URL);
  const seen = [];
  ws.on('message', (data) => {
    try { seen.push(JSON.parse(data.toString())); } catch { seen.push({ type: '<unparsed>' }); }
  });
  ws.on('error', () => {});
  return {
    ws,
    seen,
    types: () => seen.map((m) => m.type),
    ready: new Promise((resolve) => ws.once('open', resolve)),
    sendJson: (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} },
  };
}

async function queueUp(name) {
  const c = open();
  await c.ready;
  c.sendJson({ type: 'set_name', ts: Date.now(), payload: { name } });
  await sleep(50);
  c.sendJson({ type: 'queue_join', ts: Date.now(), payload: {} });
  return c;
}

console.log('A throwing join strands nobody:');
{
  // The cohort dispatches once two humans have waited >5 s (QUEUE_MIN_HUMANS_FAST).
  const original = Match.prototype.createHumanClient;
  let calls = 0;
  Match.prototype.createHumanClient = function (...args) {
    calls += 1;
    if (calls === 2) throw new Error('synthetic spawn failure (test)');
    return original.apply(this, args);
  };
  const a = await queueUp('Able');
  const b = await queueUp('Baker');
  const c = await queueUp('Charlie');
  await sleep(7_500);
  Match.prototype.createHumanClient = original;

  expect('first cohort member boards', a.types().includes('match_start'), `saw=${a.types().join(',')}`);
  expect('third cohort member boards despite the second throwing', c.types().includes('match_start'), `saw=${c.types().join(',')}`);
  expect('the failed member is told (lobby_error)', b.types().includes('lobby_error'), `saw=${b.types().join(',')}`);
  expect('the failed member is sent home (lobby_left), not left in limbo', b.types().includes('lobby_left'), `saw=${b.types().join(',')}`);
  expect('tick survived the throw: /health 200', (await health()) === 200);

  // The failed member is back in 'menu' and may queue again.
  const before = b.seen.length;
  b.sendJson({ type: 'queue_join', ts: Date.now(), payload: {} });
  await sleep(300);
  const after = b.seen.slice(before).map((m) => m.type);
  expect('the failed member can queue again', after.includes('queue_update'), `saw=${after.join(',')}`);
  b.sendJson({ type: 'queue_leave', ts: Date.now(), payload: {} });
  await sleep(100);

  for (const x of [a, b, c]) { try { x.ws.close(); } catch {} }
  await sleep(300);
}

console.log('A match nobody could board is reaped at once:');
{
  const original = Match.prototype.createHumanClient;
  Match.prototype.createHumanClient = function () { throw new Error('synthetic total spawn failure (test)'); };
  const matchesBefore = (await (await fetch(`${HTTP}/health`)).json()).matches;
  const d = await queueUp('Dog');
  const e = await queueUp('Easy');
  await sleep(7_500);
  Match.prototype.createHumanClient = original;
  const matchesAfter = (await (await fetch(`${HTTP}/health`)).json()).matches;
  expect('both members told (lobby_error)', d.types().includes('lobby_error') && e.types().includes('lobby_error'),
    `d=${d.types().join(',')} e=${e.types().join(',')}`);
  expect('the empty match is reaped immediately (no 60 s zombie)', matchesAfter <= matchesBefore,
    `before=${matchesBefore} after=${matchesAfter}`);
  for (const x of [d, e]) { try { x.ws.close(); } catch {} }
  await sleep(300);
}

console.log('/bugsnap is gated, capped and rate-limited:');
{
  const snap = (extra = {}) => fetch(`${HTTP}/bugsnap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify({ image: 'data:image/png;base64,iVBORw0KGgo=', meta: { t: Date.now() } }),
  });

  const prod = await snap();
  expect('POST without dev flag or key -> 404', prod.status === 404, `status=${prod.status}`);
  expect('no file written in prod posture', readdirSync(snapDir).length === 0, `files=${readdirSync(snapDir).length}`);

  process.env.BUGSNAP_KEY = 'hunter2';
  const wrongKey = await snap({ 'x-bugsnap-key': 'wrong' });
  expect('POST with a wrong key -> 404', wrongKey.status === 404, `status=${wrongKey.status}`);
  delete process.env.BUGSNAP_KEY;

  // Pre-seed 50 old snaps so the next accepted one must evict the oldest pair.
  mkdirSync(snapDir, { recursive: true });
  const stamps = [];
  for (let i = 0; i < 50; i++) {
    const stamp = `2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
    stamps.push(stamp);
    for (const ext of ['png', 'json']) {
      const p = join(snapDir, `${stamp}.${ext}`);
      writeFileSync(p, ext === 'json' ? '{}' : Buffer.alloc(8));
      utimesSync(p, 1577836800 + i, 1577836800 + i);
    }
  }
  process.env.PIRATES_BR_DEV = '1';
  const ok = await snap();
  expect('POST with PIRATES_BR_DEV=1 -> 200', ok.status === 200, `status=${ok.status}`);
  const jsons = readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort();
  expect('at most 50 snaps kept', jsons.length === 50, `json count=${jsons.length}`);
  expect('the oldest snap was evicted', !jsons.includes(`${stamps[0]}.json`), `oldest present=${jsons.includes(`${stamps[0]}.json`)}`);
  expect('the oldest png went with it', !readdirSync(snapDir).includes(`${stamps[0]}.png`));

  const again = await snap();
  expect('a second snap within 10 s from the same IP -> 429', again.status === 429, `status=${again.status}`);
  delete process.env.PIRATES_BR_DEV;
}

rmSync(snapDir, { recursive: true, force: true });
await sleep(200);
if (failures > 0) {
  console.error(`\n${failures} http-hardening assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll http-hardening assertions passed.');
process.exit(0);
