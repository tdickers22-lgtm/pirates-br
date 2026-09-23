#!/usr/bin/env node
// POST-DEPLOY SMOKE (online-04, b1.3b). Pure Node + ws, no browser, no GPU.
//
// A deploy that "finished" is a return value. This is the side effect: the
// public URL serves the bundle the way a phone on 4G needs it, ONE machine is
// answering, the socket speaks this checkout's protocol and build, and a
// stranger who presses Play is at sea with bots inside 20 s, gets a stream of
// snapshots back for their inputs, finds a public match inside 25 s, and can
// hand a friend a party code that works.
//
//   node scripts/smoke-online.mjs                       # --url defaults to fly.toml PIRATES_BR_PUBLIC_URL
//   node scripts/smoke-online.mjs --url http://127.0.0.1:8091 --build-id <sha>
//   node scripts/smoke-online.mjs --soak 600 [--health-key K]   # 10-minute remote soak (b1.3c)
//   node scripts/smoke-online.mjs --skip-queue          # when a public queue would pull real players in
//
// Exit 0 when every stage passes, 1 otherwise, with a timing table either way.
// deploy.yml runs it after `flyctl deploy` and rolls back on exit 1.
// scripts/test-smoke-online.mjs proves it FAILS against a stopped app, a build
// id mismatch and a two-machine /health (a smoke that cannot fail is a claim).
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The protocol this checkout speaks, read from source so plain `node` works. */
export function localProtocolVersion(root = ROOT) {
  const src = readFileSync(join(root, 'src/shared/types/index.ts'), 'utf8');
  const m = src.match(/export const PROTOCOL_VERSION\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** fly.toml's public origin: the default target. */
export function flyPublicUrl(root = ROOT) {
  try {
    const m = readFileSync(join(root, 'fly.toml'), 'utf8').match(/PIRATES_BR_PUBLIC_URL\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Two build ids name the same build when equal, or when one is a >= 7-char
 *  prefix of the other (a full github.sha against a 12-char vite id). */
export function sameBuild(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 7 && l.startsWith(s);
}

/** GET without decompression, so content-encoding is what the wire said. */
function rawGet(url, headers = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'pirates-br-smoke', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

function input(seq, i) {
  return {
    seq, ts: Date.now(), yaw: (i % 60) * 0.05, pitch: 0,
    forward: i % 3 !== 0, back: false, left: i % 7 === 0, right: false,
    jump: false, jumpPressed: false, fire: false, useItem: false, aim: false,
    interact: false, interactHeld: false, anchor: false, sailRaise: false, sailLower: false,
    sailLeft: false, sailRight: false, trade: false, reload: false, placeKeg: false,
    dropChest: false, specialAttack: false,
  };
}

const SNAP_TYPES = new Set(['state_snapshot', 'state_hot', 'state_delta']);

/** One socket with a message log and typed waits. */
function openClient(wsUrl, name) {
  const c = { name, ws: null, log: [], waiters: [], closed: null, snaps: 0, acks: 0 };
  c.ready = new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    c.ws = ws;
    ws.on('open', resolve);
    ws.on('error', (e) => reject(e));
    ws.on('close', (code) => { c.closed = code; reject(new Error(`socket closed ${code}`)); });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (SNAP_TYPES.has(msg.type)) { c.snaps += 1; return; }
      if (msg.type === 'input_ack') { c.acks += 1; return; }
      c.log.push(msg);
      c.waiters = c.waiters.filter((w) => !(w.pred(msg) && (w.resolve(msg), true)));
    });
  });
  c.ready.catch(() => {});
  c.send = (type, payload) => { try { c.ws.send(JSON.stringify({ type, ts: Date.now(), payload })); } catch {} };
  c.wait = (pred, timeoutMs, what) => {
    const hit = c.log.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        c.waiters = c.waiters.filter((x) => x !== w);
        const errs = c.log.filter((m) => m.type === 'lobby_error').map((m) => m.payload?.reason ?? m.payload?.message);
        reject(new Error(`no ${what} within ${timeoutMs} ms${errs.length ? ` (lobby_error: ${errs.join('; ')})` : ''}${c.closed != null ? ` (socket closed ${c.closed})` : ''}`));
      }, timeoutMs);
      c.waiters.push(w);
    });
  };
  c.close = () => { try { c.ws.close(); } catch {} };
  return c;
}

/**
 * Run every stage; never throws. Returns { ok, rows: [{stage, ok, ms, detail}] }.
 * opts: url, buildId (expected), healthProbes, soloBots, joinTimeoutMs,
 * queueTimeoutMs, skipQueue, soakSec, healthKey, requireMachineId, log.
 */
export async function runSmoke(opts) {
  const url = String(opts.url).replace(/\/+$/, '');
  const log = opts.log ?? (() => {});
  const rows = [];
  const ctx = {};
  const stage = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      rows.push({ stage: name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
      return true;
    } catch (e) {
      rows.push({ stage: name, ok: false, ms: Date.now() - t0, detail: e?.message ?? String(e) });
      log(`  ✗ ${name}  [${e?.message ?? e}]`);
      return false;
    }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const remote = url.startsWith('https:');
  const requireMachineId = opts.requireMachineId ?? remote;
  const wsUrl = `${url.replace(/^http/, 'ws')}/ws`;
  const protocol = localProtocolVersion();
  const clients = [];

  await stage('GET / -> 200 text/html no-cache', async () => {
    const r = await rawGet(`${url}/`);
    must(r.status === 200, `status ${r.status}`);
    must(/text\/html/.test(r.headers['content-type'] ?? ''), `content-type ${r.headers['content-type']}`);
    must(/no-cache/.test(r.headers['cache-control'] ?? ''), `cache-control ${r.headers['cache-control']}`);
    const src = String(r.body).match(/(\/assets\/index-[A-Za-z0-9_-]+\.js)/);
    must(src, 'index.html names no /assets/index-*.js');
    ctx.mainJs = src[1];
    return ctx.mainJs;
  });

  await stage('main bundle: content-encoding br + immutable', async () => {
    must(ctx.mainJs, 'no main bundle from GET /');
    const r = await rawGet(`${url}${ctx.mainJs}`, { 'accept-encoding': 'br, gzip' });
    must(r.status === 200, `status ${r.status}`);
    must(r.headers['content-encoding'] === 'br', `content-encoding ${r.headers['content-encoding'] ?? '(none)'}`);
    must(/immutable/.test(r.headers['cache-control'] ?? ''), `cache-control ${r.headers['cache-control']}`);
    return `${(r.body.length / 1024).toFixed(0)} KiB br`;
  });

  const probes = opts.healthProbes ?? 20;
  await stage(`/health x${probes}: ok, accepting, ONE machineId, one buildId`, async () => {
    const machines = new Set();
    const builds = new Set();
    for (let i = 0; i < probes; i += 1) {
      const r = await rawGet(`${url}/health`, { 'cache-control': 'no-cache' });
      must(r.status === 200, `probe ${i}: status ${r.status}`);
      const b = JSON.parse(String(r.body));
      must(b.ok === true, `probe ${i}: ok=${b.ok}`);
      must(b.accepting === true, `probe ${i}: accepting=${b.accepting} (full or draining)`);
      machines.add(b.machineId ?? null);
      builds.add(b.buildId ?? null);
      ctx.health = b;
    }
    must(machines.size === 1, `${machines.size} machines answered: ${[...machines].join(', ')} (parties and the queue live in ONE process; scale back to 1)`);
    must(!requireMachineId || [...machines][0], 'machineId null on a remote host (FLY_MACHINE_ID unset?)');
    must(builds.size === 1, `${builds.size} build ids answered: ${[...builds].join(', ')}`);
    ctx.buildId = [...builds][0];
    return `machine ${[...machines][0]} build ${ctx.buildId}`;
  });

  const a = openClient(wsUrl, `Smoke${Math.floor(1000 + Math.random() * 9000)}`);
  clients.push(a);
  await stage('wss welcome: protocolVersion + buildId', async () => {
    await a.ready;
    const w = (await a.wait((m) => m.type === 'welcome', 10_000, 'welcome')).payload;
    must(w.protocolVersion === protocol, `protocolVersion ${w.protocolVersion} != local ${protocol}`);
    must(!ctx.buildId || w.buildId === ctx.buildId, `welcome buildId ${w.buildId} != /health ${ctx.buildId}`);
    must(!opts.buildId || sameBuild(w.buildId, opts.buildId), `buildId mismatch: served ${w.buildId}, expected ${opts.buildId} (stale image?)`);
    ctx.welcome = true;
    return `v${w.protocolVersion} ${w.buildId}`;
  });

  const soloBots = opts.soloBots ?? 9;
  const joinTimeoutMs = opts.joinTimeoutMs ?? 20_000;
  const inMatch = await stage(`solo_start -> join with >= ${soloBots + 1} ships <= ${joinTimeoutMs / 1000} s`, async () => {
    must(ctx.welcome, 'no welcome');
    a.send('set_name', { name: a.name });
    a.send('solo_start', { botCount: soloBots });
    await a.wait((m) => m.type === 'match_start', joinTimeoutMs, 'match_start');
    const j = await a.wait((m) => m.type === 'join', joinTimeoutMs, 'join');
    const ships = j.payload?.snapshot?.ships?.length ?? 0;
    must(ships >= soloBots + 1, `join snapshot has ${ships} ships`);
    return `${ships} ships`;
  });

  await stage('60 inputs -> >= 20 snapshots', async () => {
    must(inMatch, 'not in a match');
    const before = a.snaps;
    for (let i = 0; i < 60; i += 1) { a.send('player_input', input(i + 1, i)); await sleep(33); }
    await sleep(1000);
    const got = a.snaps - before;
    must(got >= 20, `${got} snapshots for 60 inputs`);
    return `${got} snapshots, ${a.acks} acks`;
  });
  if (inMatch) a.send('return_to_menu', {});

  if (!opts.skipQueue) {
    const queueTimeoutMs = opts.queueTimeoutMs ?? 25_000;
    await stage(`queue_join solo -> match_start <= ${queueTimeoutMs / 1000} s`, async () => {
      must(ctx.welcome, 'no welcome');
      await sleep(300);
      const seen = a.log.length;
      a.send('queue_join', { mode: 'solo' });
      await a.wait((m) => m.type === 'match_start' && a.log.indexOf(m) >= seen, queueTimeoutMs, 'match_start from the queue');
      a.send('return_to_menu', {});
      return 'matched';
    });
  }

  await stage('party: create_party + join_party by code', async () => {
    must(ctx.welcome, 'no welcome');
    await sleep(300);
    const seen = a.log.length;
    a.send('create_party', {});
    const upd = await a.wait((m) => m.type === 'lobby_update' && a.log.indexOf(m) >= seen, 8_000, 'lobby_update after create_party');
    const code = upd.payload?.code;
    must(/^[A-Z0-9]{6}$/.test(code ?? ''), `party code ${code}`);
    const b = openClient(wsUrl, `Mate${Math.floor(1000 + Math.random() * 9000)}`);
    clients.push(b);
    await b.ready;
    await b.wait((m) => m.type === 'welcome', 10_000, 'friend welcome');
    b.send('set_name', { name: b.name });
    b.send('join_party', { code });
    await b.wait((m) => m.type === 'lobby_update' && m.payload?.code === code && m.payload?.members?.length === 2, 8_000, 'friend in the party (2 members)');
    b.send('leave_party', {});
    a.send('leave_party', {});
    return `code ${code}, 2 members`;
  });

  const soakSec = Number(opts.soakSec ?? 0);
  if (soakSec > 0) {
    await stage(`soak ${soakSec} s: snapshots >= 10 Hz per 5 s bucket, one machine${opts.healthKey ? ', worstSimLagSec < 0.1' : ''}`, async () => {
      must(ctx.welcome, 'no welcome');
      await sleep(500);
      const seen = a.log.length;
      a.send('solo_start', { botCount: null });
      await a.wait((m) => m.type === 'join' && a.log.indexOf(m) >= seen, joinTimeoutMs, 'soak join');
      const machine = ctx.health?.machineId ?? null;
      let worstLag = 0; let minBucket = Infinity; let seq = 1000;
      const end = Date.now() + soakSec * 1000;
      let bucketStart = Date.now(); let bucketSnaps = a.snaps; let nextHealth = Date.now() + 10_000;
      while (Date.now() < end) {
        a.send('player_input', input(seq++, seq));
        await sleep(33);
        must(a.closed == null, `socket closed ${a.closed} mid-soak`);
        if (Date.now() - bucketStart >= 5000) {
          minBucket = Math.min(minBucket, (a.snaps - bucketSnaps) / ((Date.now() - bucketStart) / 1000));
          must(minBucket >= 10, `snapshot rate fell to ${minBucket.toFixed(1)} Hz`);
          bucketStart = Date.now(); bucketSnaps = a.snaps;
        }
        if (Date.now() >= nextHealth) {
          nextHealth = Date.now() + 10_000;
          const r = await rawGet(`${url}/health`, opts.healthKey ? { 'x-health-key': opts.healthKey } : {});
          const h = JSON.parse(String(r.body));
          must(r.status === 200 && h.ok === true, `/health ${r.status} ok=${h.ok}`);
          must((h.machineId ?? null) === machine, `machine changed ${machine} -> ${h.machineId}`);
          if (typeof h.worstSimLagSec === 'number') worstLag = Math.max(worstLag, h.worstSimLagSec);
        }
      }
      a.send('return_to_menu', {});
      must(worstLag < 0.1, `worstSimLagSec ${worstLag}`);
      return `min ${minBucket.toFixed(1)} Hz, worstSimLagSec ${opts.healthKey ? worstLag : 'n/a (no --health-key)'}`;
    });
  }

  for (const c of clients) c.close();
  return { ok: rows.every((r) => r.ok), rows };
}

export function formatTable(rows) {
  const w = Math.max(...rows.map((r) => r.stage.length));
  return rows.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.stage.padEnd(w)}  ${String(r.ms).padStart(6)} ms  ${r.detail}`).join('\n');
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--url') o.url = v();
    else if (k === '--build-id') o.buildId = v();
    else if (k === '--soak') o.soakSec = Number(v());
    else if (k === '--health-key') o.healthKey = v();
    else if (k === '--skip-queue') o.skipQueue = true;
    else if (k === '--bots') o.soloBots = Number(v());
    else throw new Error(`unknown arg ${k}`);
  }
  o.url ??= process.env.SMOKE_URL ?? flyPublicUrl();
  o.buildId ??= process.env.SMOKE_BUILD_ID || undefined;
  o.healthKey ??= process.env.HEALTH_KEY || undefined;
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) { console.error('smoke-online: no --url and no fly.toml PIRATES_BR_PUBLIC_URL'); process.exit(2); }
  console.log(`smoke-online ${opts.url}${opts.buildId ? ` expecting build ${opts.buildId}` : ''}`);
  const res = await runSmoke({ ...opts, log: (l) => console.log(l) });
  console.log(`\n${formatTable(res.rows)}`);
  console.log(res.ok ? '\nPASS smoke-online' : `\nFAIL smoke-online (${res.rows.filter((r) => !r.ok).length} stage(s) red)`);
  process.exit(res.ok ? 0 : 1);
}
