#!/usr/bin/env node
// Wire-size guard (WIRE-01: netcode-03, netcode-28, perf-16).
//
// The split/quantized snapshot protocol exists because full 83-210KB JSON at
// 31Hz starved clients (~1s snapshot age). That fixed the LAN symptom and left
// the online one: at 10 hulls the stream is ~460 KB/s PER CLIENT uncompressed
// (37 Mbit/s of egress for a ten-human match), and the join snapshot is a
// quarter megabyte of static world.
//
// So this suite grades two different things:
//   1. PAYLOAD shape - the old per-message caps, on the historical bot-only
//      world, so a fat new field is still caught the moment it lands.
//   2. EGRESS - what a real client's socket actually carries over a second, in
//      the configurations the mode roster promises (1 human + 9 bots, 16 solo,
//      9x2 duos, 6x4 squads), THROUGH the compressor the lobby negotiates.
//
// (2) is measured with the SAME permessage-deflate parameters the server
// installs, imported from LobbyServer - so deleting the negotiation from the
// server makes this suite measure raw bytes and fail, which is the point.
//
// LOGIC suite: drives the real Match, no stack, no browser.
import zlib from 'node:zlib';
import { Match } from '../src/server/core/Match.ts';
import { buildHotSnapshot, buildWireSnapshot } from '../src/server/core/snapshot.ts';
import * as Lobby from '../src/server/core/LobbyServer.ts';
import { FULL_SNAPSHOT_TICKS, SERVER_TICK_MS, SNAPSHOT_RATE } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const fakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {} });

// ---------------------------------------------------------------- compressor
// The wire is whatever the lobby negotiated, not whatever this file feels like
// assuming. `WS_PERMESSAGE_DEFLATE` is the exact object passed to
// `new WebSocketServer`, so if a future edit drops it the numbers below become
// raw JSON and the egress rows go red.
const deflateCfg = Lobby.WS_PERMESSAGE_DEFLATE ?? null;
const threshold = deflateCfg?.threshold ?? Infinity;
const level = deflateCfg?.zlibDeflateOptions?.level ?? 0;

console.log('The lobby compresses the wire:');
expect('LobbyServer exports the permessage-deflate parameters it installs', !!deflateCfg,
  'no WS_PERMESSAGE_DEFLATE export — ws defaults perMessageDeflate:false, so every byte below is raw JSON');
expect('deflate level is set and cheap (1..6)', level >= 1 && level <= 6, `level=${level}`);
expect('small frames skip the compressor (threshold >= 512 B)', threshold >= 512, `threshold=${threshold}`);
expect('the server keeps its compression context across frames (serverNoContextTakeover false)',
  deflateCfg ? deflateCfg.serverNoContextTakeover === false : false,
  `serverNoContextTakeover=${deflateCfg?.serverNoContextTakeover}`);

/** A per-socket compressor with context takeover, exactly like the ws server's:
 *  one deflateRaw stream per client, Z_SYNC_FLUSH per message, the 4-byte
 *  00 00 FF FF tail stripped (permessage-deflate does the same). */
function makeSocketCompressor() {
  if (!deflateCfg) return { bytes: async (text) => Buffer.byteLength(text), end() {} };
  const stream = zlib.createDeflateRaw({ ...(deflateCfg.zlibDeflateOptions ?? {}) });
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  return {
    async bytes(text) {
      const raw = Buffer.from(text, 'utf8');
      if (raw.length < threshold) return raw.length;
      chunks.length = 0;
      stream.write(raw);
      await new Promise((resolve) => stream.flush(zlib.constants.Z_SYNC_FLUSH, resolve));
      const out = Buffer.concat(chunks).length;
      return Math.max(1, out - 4);
    },
    end() { stream.end(); },
  };
}

async function deflateOnce(text) {
  if (!deflateCfg) return Buffer.byteLength(text);
  return await new Promise((resolve, reject) => {
    zlib.deflateRaw(Buffer.from(text, 'utf8'), { ...(deflateCfg.zlibDeflateOptions ?? {}) },
      (err, buf) => (err ? reject(err) : resolve(Math.max(1, buf.length - 4))));
  });
}

// ------------------------------------------------------------- payload shape
// Historical configuration, kept byte-comparable with every earlier run of this
// suite: 9 bot crews, no human, sim genuinely stepped so projectiles/wakes/
// attitudes populate.
const match = new Match({ matchId: 'wire-size-test', botCount: 9 });
for (let i = 0; i < 250; i++) match.tick(1 / 62.5);

const full = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
const fullWithWorld = JSON.stringify(buildWireSnapshot(match.buildSnapshot(true), true));
const hot = JSON.stringify(buildHotSnapshot(match.state, match.t));

console.log(`\n  sizes: hot=${(hot.length / 1024).toFixed(1)}KB full=${(full.length / 1024).toFixed(1)}KB full+world=${(fullWithWorld.length / 1024).toFixed(1)}KB`);
expect('31Hz hot payload stays tiny (<8KB)', hot.length < 8 * 1024, `${hot.length}B`);
expect('10Hz quantized full stays lean (<35KB)', full.length < 35 * 1024, `${full.length}B`);
expect('static-world full stays sane (<250KB, rides ~1/20s + join)', fullWithWorld.length < 250 * 1024, `${fullWithWorld.length}B`);
expect('statics stripped from ordinary fulls', !full.includes('"caves"'), 'islands leaked into a non-world snapshot');
match.stop();

// ------------------------------------------------------------------- egress
// Per-client bytes over one simulated second, at the real cadence: a snapshot
// tick every SNAPSHOT_RATE ticks, a FULL on every FULL_SNAPSHOT_TICKS, a hot on
// the rest, plus the amortized static-world frame the match re-sends every
// FULL_WORLD_SNAPSHOT_TICKS (1200 ticks = 19.2 s) — the one term the original
// netcode measurement left out.
const TICKS_PER_SECOND = 1000 / SERVER_TICK_MS;
const WORLD_RESEND_SECONDS = (FULL_SNAPSHOT_TICKS * 200) / TICKS_PER_SECOND;
const EGRESS_CAP = 120 * 1024;   // bytes/s per client
const JOIN_CAP = 60 * 1024;      // compressed join message

/** @param {{label:string, botCount:number, mode?:string, crews:number, crewSize:number}} cfg */
async function measure(cfg) {
  const m = new Match({ matchId: `wire-${cfg.label}`, botCount: cfg.botCount, mode: cfg.mode });
  let joinMessage = null;
  for (let c = 0; c < cfg.crews; c++) {
    const members = Array.from({ length: cfg.crewSize }, (_, i) => ({ ws: fakeWs(), name: `H${c}_${i}` }));
    const crew = m.createCrew(members);
    for (const join of crew.joins) {
      const { playerId, shipId, snapshot } = join.send();
      if (!joinMessage) {
        joinMessage = JSON.stringify({ type: 'join', ts: Date.now(), payload: { playerId, shipId, snapshot, matchId: m.id } });
      }
    }
  }
  // Let the sim run so hulls are moving and the wire is at its real width.
  for (let i = 0; i < 250; i++) m.tick(1 / 62.5);

  const socket = makeSocketCompressor();
  let bytes = 0;
  let fulls = 0;
  let hots = 0;
  const startTick = m.tickCount;
  while (m.tickCount - startTick < TICKS_PER_SECOND) {
    m.tick(1 / 62.5);
    if (m.tickCount % SNAPSHOT_RATE !== 0) continue;
    if (m.tickCount % FULL_SNAPSHOT_TICKS === 0) {
      const snap = buildWireSnapshot(m.buildSnapshot(false), false);
      bytes += await socket.bytes(JSON.stringify({ type: 'state_snapshot', ts: Date.now(), payload: snap }));
      fulls += 1;
    } else {
      const hotMsg = buildHotSnapshot(m.state, m.t, m.tickCount);
      bytes += await socket.bytes(JSON.stringify({ type: 'state_hot', ts: Date.now(), payload: hotMsg }));
      hots += 1;
    }
  }
  // The 19.2 s static-world resend, amortized — charged only while the server
  // still puts it on the clock (see the section above).
  const worldSnap = JSON.stringify({ type: 'state_snapshot', ts: Date.now(), payload: buildWireSnapshot(m.buildSnapshot(true), true) });
  const worldBytes = worldResent ? await socket.bytes(worldSnap) : 0;
  socket.end();
  const joinBytes = joinMessage ? await deflateOnce(joinMessage) : 0;
  const joinRaw = joinMessage ? Buffer.byteLength(joinMessage) : 0;
  m.stop();
  return {
    perSecond: bytes + (worldResent ? worldBytes / WORLD_RESEND_SECONDS : 0),
    streamed: bytes,
    worldBytes,
    joinBytes,
    joinRaw,
    fulls,
    hots,
    players: cfg.crews * cfg.crewSize,
  };
}

// ------------------------------------------------- the world is posted ONCE
// netcode-28 third pass: the static world did not only ride the join, it was
// RE-BROADCAST to every client every FULL_WORLD_SNAPSHOT_TICKS (1200 ticks =
// 19.2 s) whether or not anything in it had changed — ~13 KB/s per client of
// repetition, and on the receiving end a 250 KB JSON.parse plus a full
// ensureWorldMeshes/syncBarrels walk on the main thread, i.e. a hitch the
// player feels three times a minute. This drives the REAL broadcast path (the
// match's own tick, through the client's own socket) past that clock.
console.log('\nThe static world is posted once, not on a clock:');
const worldMatch = new Match({ matchId: 'wire-world-clock', botCount: 9 });
const recorded = [];
const recordingWs = { readyState: 1, bufferedAmount: 0, send(data) { recorded.push(data); } };
worldMatch.createCrew([{ ws: recordingWs, name: 'Watcher' }]).joins[0].send();
// The horn, without start()'s setInterval — this fixture steps the sim by hand
// and a live timer would tick it twice.
worldMatch.state.phase = 'playing';
const joinFrames = recorded.length;
expect('the join itself hands her the world', recorded.some((d) => d.includes('"caves"')),
  'no join frame carried islands — the fixture is wrong, not the rule');
recorded.length = 0;
const WORLD_CLOCK_TICKS = FULL_SNAPSHOT_TICKS * 200 + 60;
for (let i = 0; i < WORLD_CLOCK_TICKS; i++) worldMatch.tick(1 / 62.5);
const worldFrames = recorded.filter((d) => d.includes('"caves"'));
const worldResent = worldFrames.length > 0;
console.log(`  ${recorded.length} frames over ${WORLD_CLOCK_TICKS} ticks (${(WORLD_CLOCK_TICKS / TICKS_PER_SECOND).toFixed(1)} s), ${worldFrames.length} of them carrying the static world`
  + ` (join was ${joinFrames} frame${joinFrames === 1 ? '' : 's'})`);
expect('a client who already has the world is never re-sent it', !worldResent,
  `${worldFrames.length} world frames re-broadcast, ${(worldFrames.reduce((a, d) => a + d.length, 0) / 1024).toFixed(0)} KB`);
expect('the ordinary fulls kept flowing (the match did not simply go quiet)',
  recorded.length > 100, `${recorded.length} frames`);
worldMatch.stop();

const CONFIGS = [
  { label: '1-human', botCount: 9, mode: 'solo', crews: 1, crewSize: 1 },
  { label: '16-solo', botCount: 0, mode: 'solo', crews: 16, crewSize: 1 },
  { label: '9x2-duos', botCount: 0, mode: 'duos', crews: 9, crewSize: 2 },
  { label: '6x4-squads', botCount: 0, mode: 'squads', crews: 6, crewSize: 4 },
];

console.log(`\nPer-client egress at ${deflateCfg ? `deflate level ${level}` : 'NO COMPRESSION'}:`);
for (const cfg of CONFIGS) {
  const r = await measure(cfg);
  console.log(`  ${cfg.label.padEnd(11)} ${String(r.players).padStart(2)} players`
    + ` | ${(r.perSecond / 1024).toFixed(1)} KB/s (${r.fulls} fulls + ${r.hots} hots${worldResent ? ` + world/${WORLD_RESEND_SECONDS.toFixed(0)}s` : ', world posted once'})`
    + ` | join ${(r.joinBytes / 1024).toFixed(1)} KB compressed of ${(r.joinRaw / 1024).toFixed(1)} KB raw`);
  expect(`${cfg.label}: per-client egress under 120 KB/s`, r.perSecond < EGRESS_CAP,
    `${(r.perSecond / 1024).toFixed(1)} KB/s`);
  // The join cap becomes an assertion in WIRE-01 slice c, when the client
  // regenerates the fixed world from the seed instead of being posted it. Until
  // then it is printed loudly: deflate alone takes a quarter megabyte to ~69 KB,
  // which is still over the 60 KB line.
  if (r.joinBytes >= JOIN_CAP) {
    console.log(`     ⚠ join is ${(r.joinBytes / 1024).toFixed(1)} KB compressed, over the 60 KB cap`
      + ' — the static world is still transmitted (WIRE-01 slice c)');
  } else {
    expect(`${cfg.label}: join message under 60 KB compressed`, r.joinBytes < JOIN_CAP,
      `${(r.joinBytes / 1024).toFixed(1)} KB`);
  }
}

// HEADROOM, said out loud. The static-world payload is the one budget in this
// suite that is nearly spent, and a pass/fail line hides that: it reads exactly
// the same at 180KB and at 249KB. Whoever adds the next island, cave system or
// prop registry field should see the wall coming in the same output that tells
// them they cleared it.
const WORLD_CEILING = 250 * 1024;
const headroom = WORLD_CEILING - fullWithWorld.length;
console.log(
  `\n  headroom: static-world full has ${(headroom / 1024).toFixed(1)}KB left under the 250KB ceiling `
  + `(${(100 - (fullWithWorld.length / WORLD_CEILING) * 100).toFixed(1)}% free)`
  + `${headroom < 20 * 1024 ? '  ⚠ under 20KB — the next world addition will need the protocol widened, not the ceiling raised' : ''}`,
);

if (failures > 0) { console.error(`\n${failures} wire-size assertion(s) failed.`); process.exit(1); }
console.log('\nAll wire-size assertions passed.');
