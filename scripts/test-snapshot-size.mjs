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
import { SNAPSHOT_BYTES } from './lib/budgets.mjs';
import { Match } from '../src/server/core/Match.ts';
import { buildHotSnapshot, buildWireSnapshot } from '../src/server/core/snapshot.ts';
import * as Lobby from '../src/server/core/LobbyServer.ts';
import { FULL_SNAPSHOT_TICKS, SERVER_TICK_MS, SNAPSHOT_RATE } from '../src/shared/constants/index.ts';
import * as Snapshot from '../src/server/core/snapshot.ts';
import * as StaticWorld from '../src/shared/staticWorld.ts';
import { unpackWireIslands } from '../src/shared/propWire.ts';

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
expect('31Hz hot payload stays tiny (<8KB)', hot.length < SNAPSHOT_BYTES.hot, `${hot.length}B`);
expect('10Hz quantized full stays lean (<35KB)', full.length < SNAPSHOT_BYTES.full, `${full.length}B`);
expect('static-world full stays sane (<250KB, rides ~1/20s + join)', fullWithWorld.length < SNAPSHOT_BYTES.worldFull, `${fullWithWorld.length}B`);
expect('statics stripped from ordinary fulls', !full.includes('"caves"'), 'islands leaked into a non-world snapshot');
// The packed prop columns (src/shared/propWire.ts) must unpack to EXACTLY the
// plain JSON wire: same props, same doubles, same order, every island.
{
  const plain = JSON.stringify(match.buildSnapshot(true).islands.map((i) => JSON.parse(JSON.stringify(Snapshot.staticWorldWireOf([i], []).islands[0]))));
  const unpacked = unpackWireIslands(JSON.parse(fullWithWorld));
  const packedIslands = JSON.parse(fullWithWorld).islands.filter((i) => i.propsPacked).length;
  const propCount = unpacked.islands.reduce((n, i) => n + (i.props?.length ?? 0), 0);
  expect('packed island props unpack bit-identical to the plain wire', StaticWorld.canonicalJson(unpacked.islands) === StaticWorld.canonicalJson(JSON.parse(plain)),
    `${packedIslands} packed islands, ${propCount} props`);
  expect('the full wire actually packs props (no island ships them as plain JSON)', packedIslands > 0 && !fullWithWorld.includes('"props":[{'), `${packedIslands} packed`);
}
match.stop();

// ------------------------------------------------------------------- egress
// Per-client bytes over one simulated second, at the real cadence: a snapshot
// tick every SNAPSHOT_RATE ticks, a FULL on every FULL_SNAPSHOT_TICKS, a hot on
// the rest, plus the amortized static-world frame the match re-sends every
// FULL_WORLD_SNAPSHOT_TICKS (1200 ticks = 19.2 s) — the one term the original
// netcode measurement left out.
const TICKS_PER_SECOND = 1000 / SERVER_TICK_MS;
const WORLD_RESEND_SECONDS = (FULL_SNAPSHOT_TICKS * 200) / TICKS_PER_SECOND;
const EGRESS_CAP = SNAPSHOT_BYTES.egressPerSecond;   // bytes/s per client
const JOIN_CAP = SNAPSHOT_BYTES.joinCompressed;      // compressed join message

/** @param {{label:string, botCount:number, mode?:string, crews:number, crewSize:number}} cfg */
async function measure(cfg) {
  const m = new Match({ matchId: `wire-${cfg.label}`, botCount: cfg.botCount, mode: cfg.mode });
  // b4.1b (D30): every member is a seed-capable client, and the join measured
  // is the REAL frame the match wrote to her socket, not a re-serialisation.
  let joinMessage = null;
  for (let c = 0; c < cfg.crews; c++) {
    const members = Array.from({ length: cfg.crewSize }, (_, i) => {
      const frames = [];
      return { ws: { readyState: 1, bufferedAmount: 0, send(d) { frames.push(d); } }, frames, name: `H${c}_${i}`, worldVersion: StaticWorld.WORLD_VERSION };
    });
    const crew = m.createCrew(members);
    crew.joins.forEach((join) => join.send());
    if (!joinMessage) joinMessage = members[0].frames.find((d) => d.startsWith('{"type":"join"')) ?? null;
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

// ------------------------------------------- a link that cannot carry the sim
// netcode-V2. broadcastVolatile withholds snapshots from a congested socket and
// that is right, but nothing ever ENDED the story: `sweepDeadSockets` in the
// lobby tests silence only, and a congested client keeps answering pings while
// sitting minutes behind the sim, so she was kept forever — reliable events
// (kills, hits, countdowns) still queued behind her 512 KB backlog and arrived
// after the state they described, and the server held the memory.
console.log('\nA socket that never drains is let go:');
const jamMatch = new Match({ matchId: 'wire-congestion', botCount: 9 });
const closes = [];
let eventsAfterDeadline = 0;
let deadlinePassed = false;
const jammedWs = {
  readyState: 1,
  bufferedAmount: 600 * 1024,   // permanently over MAX_VOLATILE_BUFFERED_BYTES
  send() { if (deadlinePassed) eventsAfterDeadline += 1; },
  close(code, reason) { closes.push({ code, reason }); this.readyState = 3; },
};
jamMatch.createCrew([{ ws: jammedWs, name: 'Jammed' }]).joins[0].send();
jamMatch.state.phase = 'playing';
const TICKS_PER_SEC = TICKS_PER_SECOND;
for (let i = 0; i < TICKS_PER_SEC * 5; i++) jamMatch.tick(1 / 62.5);
expect('a five-second jam is a spike, not a verdict — she is still aboard', closes.length === 0,
  `closed with ${closes[0]?.code} after 5 s`);
deadlinePassed = true;
for (let i = 0; i < TICKS_PER_SEC * 7; i++) jamMatch.tick(1 / 62.5);
console.log(`  after 12 s jammed: ${closes.length} close(s) ${closes.map((c) => c.code).join(',')},`
  + ` ${eventsAfterDeadline} frames pushed at her past the deadline`);
expect('a socket jammed past the deadline is closed', closes.length === 1, `${closes.length} closes`);
expect('closed with 1013 Try Again Later, not a kick', closes[0]?.code === 1013,
  `code=${closes[0]?.code}`);
jamMatch.stop();

// ------------------------------------------------ static world from the seed
// b4.1b (D30). A seed-capable client (worldVersion === WORLD_VERSION) is handed
// {seed, version, worldHash, deltas} instead of the islands; she regenerates the
// world, applies the deltas and must land on the server's CURRENT static wire
// byte for byte. Her worldHash report settles it: a match is silence, a
// mismatch is a 'world_sync' carrying the full current statics.
console.log('\nStatic world from the seed (b4.1b):');
{
  const m = new Match({ matchId: 'seed-join', botCount: 9, mode: 'solo' });
  const recorder = (name, worldVersion) => {
    const frames = [];
    return { frames, member: { ws: { readyState: 1, bufferedAmount: 0, send(d) { frames.push(d); } }, name, worldVersion } };
  };
  const frameOf = (frames, type) => frames.map((d) => JSON.parse(d)).find((f) => f.type === type) ?? null;
  const wireNow = () => StaticWorld.canonicalJson(Snapshot.staticWorldWireOf(m.state.islands, m.state.seaRocks));
  const rebuild = (world) => {
    const base = Snapshot.staticWorldWire(StaticWorld.generateStaticWorld(world.seed, world.version));
    Snapshot.applyStaticWorldDeltas(base, world.deltas);
    return StaticWorld.canonicalJson(base);
  };

  const a = recorder('Seedy', StaticWorld.WORLD_VERSION);
  const aJoin = m.createCrew([a.member]).joins[0];
  aJoin.send();
  const join = frameOf(a.frames, 'join');
  const world = join?.payload?.world;
  expect('the join names the world: seed + WORLD_VERSION + worldHash + deltas',
    !!world && Number.isInteger(world.seed) && world.version === StaticWorld.WORLD_VERSION
      && typeof world.worldHash === 'string' && Array.isArray(world.deltas), JSON.stringify(world)?.slice(0, 200));
  expect('the join does NOT carry the statics', join?.payload?.snapshot?.islands?.length === 0
    && join?.payload?.snapshot?.seaRocks?.length === 0, `islands=${join?.payload?.snapshot?.islands?.length}`);
  const regenerated = world ? StaticWorld.generateStaticWorld(world.seed, world.version) : null;
  expect('the server\'s worldHash is the regenerated world\'s', !!regenerated
    && StaticWorld.hashStaticWorld(regenerated).worldHash === world.worldHash, world?.worldHash);
  expect('the server plays the world it advertises (live islands == regenerated, by id)', !!regenerated
    && m.state.islands.map((i) => i.id).join() === regenerated.islands.map((i) => i.id).join()
    && m.state.islands.every((isl, i) => (isl.props?.length ?? 0) === (regenerated.islands[i].props?.length ?? 0)));
  expect('seed + deltas rebuild the server\'s static wire byte for byte (fresh match)',
    !!world && rebuild(world) === wireNow(), `${world?.deltas?.length} deltas`);

  // Destroyed + moved statics: the NEXT join must carry them as deltas.
  const isl = m.state.islands.find((i) => (i.barrels?.length ?? 0) > 1 && (i.chests?.length ?? 0) > 0);
  isl.barrels.splice(0, 1);
  isl.chests[0].opened = true;
  isl.chests[0].position = { ...isl.chests[0].position, x: isl.chests[0].position.x + 3.25 };
  m.state.seaRocks.pop();
  const b = recorder('Late', StaticWorld.WORLD_VERSION);
  m.createCrew([b.member]).joins[0].send();
  const bWorld = frameOf(b.frames, 'join')?.payload?.world;
  expect('destroyed/moved statics ride the join as deltas', (bWorld?.deltas?.length ?? 0) > 0, `${bWorld?.deltas?.length}`);
  expect('seed + deltas rebuild the server\'s static wire byte for byte (after play)',
    !!bWorld && rebuild(bWorld) === wireNow());
  const deltaBytes = Buffer.byteLength(JSON.stringify(bWorld?.deltas ?? []));
  expect('the deltas stay small (< 8 KB raw for 3 touched statics)', deltaBytes < 8 * 1024, `${deltaBytes} B`);

  // Report: match = silence; forced mismatch = world_sync with the full statics.
  m.handleClientMessage(aJoin.playerId, { type: 'world_hash', ts: Date.now(), payload: { worldHash: world?.worldHash, version: world?.version } });
  expect('a matching worldHash gets no world_sync', !frameOf(a.frames, 'world_sync'));
  const bJoinPid = JSON.parse(b.frames.find((d) => d.startsWith('{"type":"join"'))).payload.playerId;
  m.handleClientMessage(bJoinPid, { type: 'world_hash', ts: Date.now(), payload: { worldHash: '0000000000000000', version: world?.version } });
  const sync = frameOf(b.frames, 'world_sync');
  expect('a mismatched worldHash gets a world_sync', !!sync, b.frames.map((d) => d.slice(0, 24)).join(' | '));
  expect('world_sync carries the full CURRENT statics', !!sync && sync.payload.islands.length === m.state.islands.length
    && StaticWorld.canonicalJson({ islands: unpackWireIslands(JSON.parse(JSON.stringify(sync.payload))).islands, seaRocks: sync.payload.seaRocks }) === wireNow());

  // A client that never learned the seed protocol still gets today's full join.
  const c = recorder('Legacy', undefined);
  m.createCrew([c.member]).joins[0].send();
  const cJoin = frameOf(c.frames, 'join');
  expect('a legacy client (no worldVersion) still gets the statics in the join',
    (cJoin?.payload?.snapshot?.islands?.length ?? 0) === m.state.islands.length && !cJoin?.payload?.world);
  const d = recorder('Stale', StaticWorld.WORLD_VERSION + 1);
  m.createCrew([d.member]).joins[0].send();
  expect('a client on another WORLD_VERSION gets the full statics, not a seed it cannot build',
    (frameOf(d.frames, 'join')?.payload?.snapshot?.islands?.length ?? 0) === m.state.islands.length);

  // Settled is settled: a second report after the answer pulls nothing more.
  const syncsBefore = b.frames.filter((f) => f.startsWith('{"type":"world_sync"')).length;
  m.handleClientMessage(bJoinPid, { type: 'world_hash', ts: Date.now(), payload: { worldHash: 'ffffffffffffffff', version: StaticWorld.WORLD_VERSION } });
  expect('a repeated world_hash is ignored (no on-demand quarter megabyte)',
    b.frames.filter((f) => f.startsWith('{"type":"world_sync"')).length === syncsBefore);
  // A seed client that never reports is posted the statics once her deadline passes.
  const e = recorder('Silent', StaticWorld.WORLD_VERSION);
  const eJoin = m.createCrew([e.member]).joins[0];
  eJoin.send();
  m.clients.get(eJoin.playerId).worldReportDeadline = Date.now() - 1;
  for (let i = 0; i < FULL_SNAPSHOT_TICKS * 2 && !frameOf(e.frames, 'world_sync'); i++) m.tick(1 / 62.5);
  expect('a seed client whose report never comes gets world_sync (timeout)',
    frameOf(e.frames, 'world_sync')?.payload?.reason === 'timeout');
  m.stop();
}

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
  // HARD since b4.1b (D30, performance-05): the join carries seed +
  // WORLD_VERSION + deltas, the client regenerates the static world, so the
  // quarter megabyte of islands never rides it again.
  expect(`${cfg.label}: join message under ${(JOIN_CAP / 1024).toFixed(0)} KB compressed`,
    r.joinBytes > 0 && r.joinBytes < JOIN_CAP, `${(r.joinBytes / 1024).toFixed(1)} KB (no join frame = 0)`);
}

// HEADROOM, said out loud. The static-world payload is the one budget in this
// suite that is nearly spent, and a pass/fail line hides that: it reads exactly
// the same at 180KB and at 249KB. Whoever adds the next island, cave system or
// prop registry field should see the wall coming in the same output that tells
// them they cleared it.
const WORLD_CEILING = SNAPSHOT_BYTES.worldFull;
const headroom = WORLD_CEILING - fullWithWorld.length;
console.log(
  `\n  headroom: static-world full has ${(headroom / 1024).toFixed(1)}KB left under the 250KB ceiling `
  + `(${(100 - (fullWithWorld.length / WORLD_CEILING) * 100).toFixed(1)}% free)`
  + `${headroom < 20 * 1024 ? '  ⚠ under 20KB — the next world addition will need the protocol widened, not the ceiling raised' : ''}`,
);

if (failures > 0) { console.error(`\n${failures} wire-size assertion(s) failed.`); process.exit(1); }
console.log('\nAll wire-size assertions passed.');
