#!/usr/bin/env node
// VERSION SKEW + DEPLOY NOTICE (b1.2e; online-05, online-11). Real LobbyServer on
// a kernel-chosen port, real WebSockets, a throwaway StatsStore. No browser.
//
// What it is the net under:
//  1. A tab open across a deploy could not tell it was running an old bundle:
//     the welcome carried no build id (online-05). Now welcome.buildId and
//     /health.buildId are the id this host serves (BUILD_ID env, else
//     dist/build-id.txt written by postbuild-compress from the bundle's meta).
//  2. A deploy (SIGTERM -> shutdown(grace)) closed every socket with no word of
//     warning, and the match went into the stats as nothing at all while the
//     client said "the match went on without you" (online-11). Now every client
//     gets server_notice{kind:'restarting', seconds} BEFORE any close, every
//     close is 1012, and a match still at sea is recorded as a NO CONTEST:
//     stats saved, noContests +1, matchesPlayed / wins untouched (not a loss).
//     A match still in its pre-horn countdown was never played: nothing recorded.
// ~15 s (one real 8 s countdown). Logic tier, not quick.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

process.env.BUILD_ID = 'skew-test-1';
delete process.env.PIRATES_BR_ALLOWED_ORIGINS;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = mkdtempSync(path.join(tmpdir(), 'pbr-skew-'));

const lobbyMod = await import('../src/server/core/LobbyServer.ts');
const { LobbyServer, resolveServerBuildId } = lobbyMod;
const { StatsStore } = await import('../src/server/core/StatsStore.ts');

console.log('A  build id resolution (pure)');
expect('resolveServerBuildId exists', typeof resolveServerBuildId === 'function');
if (typeof resolveServerBuildId === 'function') {
  const distA = path.join(TMP, 'distA'); mkdirSync(distA, { recursive: true });
  writeFileSync(path.join(distA, 'build-id.txt'), 'abc123def456\n');
  expect('env BUILD_ID wins', resolveServerBuildId({ BUILD_ID: 'from-env' }, distA) === 'from-env');
  expect('dist/build-id.txt when no env', resolveServerBuildId({}, distA) === 'abc123def456');
  expect("no env, no file -> 'dev' (the client gate's 'unknown')", resolveServerBuildId({}, path.join(TMP, 'nope')) === 'dev');
}
let writeBuildId = null;
try { ({ writeBuildId } = await import('./postbuild-compress.mjs')); } catch {}
expect('postbuild-compress exports writeBuildId', typeof writeBuildId === 'function');
if (typeof writeBuildId === 'function') {
  const client = path.join(TMP, 'distB', 'client'); mkdirSync(client, { recursive: true });
  writeFileSync(path.join(client, 'index.html'), '<html><head><meta name="pirates-build-id" content="f5fee97e1234"></head></html>');
  const id = writeBuildId(client);
  const onDisk = readFileSync(path.join(TMP, 'distB', 'build-id.txt'), 'utf8').trim();
  expect('writeBuildId copies the bundle meta to dist/build-id.txt', id === 'f5fee97e1234' && onDisk === id, `${id} / ${onDisk}`);
  writeFileSync(path.join(client, 'index.html'), '<html><head></head></html>');
  const h = writeBuildId(client);
  expect('index.html without the meta -> stable content hash, never dev', /^h[0-9a-f]{12}$/.test(h) && writeBuildId(client) === h, h);
}
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
expect('vite.config defines VITE_BUILD_ID + __BUILD_ID__ and injects the meta',
  /import\.meta\.env\.VITE_BUILD_ID/.test(vite) && /__BUILD_ID__/.test(vite) && /pirates-build-id/.test(vite));

console.log('\nB  welcome + /health carry the build id');
const server = new LobbyServer();
const statsPath = path.join(TMP, 'stats.json');
const store = new StatsStore(statsPath);
server.stats = store;
server.init(0);
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
const PORT = server.boundPort;

let seq = 0;
function client(name) {
  const c = { name, events: [], welcome: null, ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws`) };
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'welcome') c.welcome = msg.payload;
    c.events.push({ seq: seq++, type: msg.type, payload: msg.payload });
  });
  c.ws.on('close', (code) => c.events.push({ seq: seq++, type: 'close', code }));
  c.open = new Promise((r) => c.ws.once('open', r));
  c.send = (type, payload) => c.ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  return c;
}
const has = (c, type) => c.events.some((e) => e.type === type);
async function until(pred, ms) { const t = Date.now(); while (!pred() && Date.now() - t < ms) await sleep(50); return pred(); }

let sailor, docker, idler;
try {
  sailor = client('Skewtester');
  await sailor.open;
  await until(() => sailor.welcome, 3000);
  expect("welcome.buildId === BUILD_ID ('skew-test-1')", sailor.welcome?.buildId === 'skew-test-1', JSON.stringify(sailor.welcome));
  const health = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', () => resolve({}));
  });
  expect('/health.buildId === BUILD_ID', health.buildId === 'skew-test-1', JSON.stringify(health.buildId));

  console.log('\nC  drain: notice before any close, 1012, no-contest stats');
  sailor.send('set_name', { name: 'Skewtester' });
  sailor.send('solo_start', { botCount: 2 });
  await until(() => has(sailor, 'match_start'), 20000);
  const matches = () => Array.from(server.matches.values());
  const live = await until(() => matches().some((m) => m.isPlaying()), 30000);
  expect('solo match reached the horn (phase playing)', live);

  docker = client('Dockhand');
  await docker.open;
  docker.send('set_name', { name: 'Dockhand' });
  docker.send('solo_start', { botCount: 2 });
  await until(() => has(docker, 'match_start'), 20000);
  idler = client('Idler');
  await idler.open;
  await until(() => idler.welcome, 3000);
  await sleep(200);
  expect('one match at sea + one in its countdown', matches().filter((m) => m.isPlaying()).length === 1
    && matches().some((m) => m.isAwaitingHorn()), `${matches().length} matches`);

  const t0 = Date.now();
  await server.shutdown('test-version-skew', 1500);
  await until(() => [sailor, docker, idler].every((c) => has(c, 'close')), 5000);
  const all = [sailor, docker, idler];
  for (const c of all) {
    const notice = c.events.find((e) => e.type === 'server_notice');
    const close = c.events.find((e) => e.type === 'close');
    expect(`${c.name}: server_notice{kind:'restarting', seconds:2}`, notice?.payload?.kind === 'restarting' && notice?.payload?.seconds === 2, JSON.stringify(notice?.payload));
    expect(`${c.name}: closed with 1012`, close?.code === 1012, `close ${close?.code}`);
    expect(`${c.name}: the notice came before the close`, notice && close && notice.seq < close.seq);
  }
  const lastNotice = Math.max(...all.map((c) => c.events.find((e) => e.type === 'server_notice')?.seq ?? Infinity));
  const firstClose = Math.min(...all.map((c) => c.events.find((e) => e.type === 'close')?.seq ?? -1));
  expect('every client had its notice before ANY socket closed', lastNotice < firstClose, `last notice #${lastNotice}, first close #${firstClose}`);
  expect('the grace was honoured (>= 1.4 s from drain to close)', Date.now() - t0 >= 1400, `${Date.now() - t0} ms`);
  const ended = sailor.events.find((e) => e.type === 'match_ended');
  expect("the match at sea ended as reason 'interrupted'", ended?.payload?.reason === 'interrupted', JSON.stringify(ended?.payload?.reason));

  const rec = JSON.parse(readFileSync(statsPath, 'utf8')).players?.skewtester;
  expect('interrupted match persisted as a no-contest (noContests 1)', rec?.noContests === 1, JSON.stringify(rec));
  expect('... not a played match and not a loss (matchesPlayed 0, wins 0, bestPlacement 0)',
    rec?.matchesPlayed === 0 && rec?.wins === 0 && rec?.bestPlacement === 0, JSON.stringify(rec && { m: rec.matchesPlayed, w: rec.wins, b: rec.bestPlacement }));
  expect('... play time kept ("your stats are saved")', (rec?.playSeconds ?? 0) >= 0.5, `playSeconds ${rec?.playSeconds}`);
  const dock = store.get('Dockhand');
  expect('pre-horn match: nothing recorded (noContests 0, matchesPlayed 0)', (dock?.noContests ?? 0) === 0 && (dock?.matchesPlayed ?? 0) === 0, JSON.stringify(dock));
} finally {
  for (const c of [sailor, docker, idler]) { try { c?.ws.terminate(); } catch {} }
  try { await server.shutdown?.(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} FAIL` : '\nversion skew + deploy notice: all pass');
process.exit(failures ? 1 : 0);
