// CONNECT SUPERVISOR (logic tier, b1.1e): correctness-04 / online-10 / vm:online:2 /
// vm:correctness:1 / vm:crossdevice:4.
//
// Drives the real NetworkClient against a fake socket Worker on a virtual clock
// (no port, no real waiting). What it pins:
//   A  fresh page, server comes up after 7 s (Fly cold start / slow 4G): connect()
//      resolves exactly once, ONE live transport afterwards, no 'resume' frame even
//      though sessionStorage holds a token from a previous page load, no resume
//      failure UI, no "Disconnected" flash during boot, at most one supervisor's
//      worth of attempts. Red on f5fee97e..e6011baf: the connect() loop and the
//      noteClosed() timer both retry, the second tears down the first.
//   B  a drop after the welcome resumes with THIS page's token, exactly once.
//   C  a server that never answers: connect() rejects exactly once inside the
//      60 s budget, and retryNow() connects once the server is back.
//   D  offline -> 'offline' progress; the 'online' event retries at once instead
//      of waiting out the backoff.
//   E  back from 30 s in the background on a socket that died silently (iOS
//      suspend): the client notices within 5 s and resumes into the held seat.
//   G  version gate wiring: a welcome with a different buildId reloads on the
//      menu and defers in a match until returnToMenu().
//
//   node --import tsx scripts/test-connect-supervisor.mjs
import { NetworkClient } from '../src/client/network/NetworkClient.ts';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ── virtual clock ────────────────────────────────────────────────────────────
let now = 1_000_000;
let tid = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0, ...a) => { const id = ++tid; timers.set(id, { at: now + Math.max(0, ms || 0), fn, a }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = (fn, ms = 0, ...a) => { const id = ++tid; timers.set(id, { at: now + ms, fn, a, every: Math.max(1, ms) }); return id; };
globalThis.clearInterval = (id) => { timers.delete(id); };
Date.now = () => now;
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    await flush();
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
    if (!next) break;
    const [id, t] = next;
    now = t.at;
    if (t.every) t.at += t.every; else timers.delete(id);
    try { t.fn(...t.a); } catch (err) { console.log('  timer threw', err); }
  }
  now = end;
  await flush();
}

// ── fake page + worker ───────────────────────────────────────────────────────
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
function fakeTarget() {
  const l = new Map();
  return {
    visibilityState: 'visible', hidden: false,
    addEventListener(t, fn) { if (!l.has(t)) l.set(t, []); l.get(t).push(fn); },
    removeEventListener(t, fn) { l.set(t, (l.get(t) ?? []).filter((f) => f !== fn)); },
    fire(t, ev = {}) { for (const fn of l.get(t) ?? []) fn({ type: t, ...ev }); },
  };
}
const world = { serverUpAt: Infinity, buildId: undefined };
let workers = [];
class FakeWorker {
  constructor() { this.id = workers.length; this.terminated = false; this.socketOpen = false; this.sent = []; this.n = 0; workers.push(this); }
  postMessage(m) {
    if (this.terminated) return;
    if (m.k === 'open') {
      const up = now >= world.serverUpAt;
      setTimeout(() => {
        if (this.terminated || this.clientClosed) return;
        if (up) {
          this.socketOpen = true;
          this.emit({ k: 'open' });
          setTimeout(() => {
            if (this.socketOpen && !this.terminated) this.emitMsg({ type: 'welcome', ts: now, payload: { clientId: `c${this.id}`, sessionToken: `tok${this.id}`, stats: null, partyCapacity: 4, protocolVersion: 2, buildId: world.buildId } });
          }, 20);
        } else {
          this.emit({ k: 'failed' });
          setTimeout(() => this.emit({ k: 'closed', code: 1006, reason: '' }), 0);
        }
      }, up ? 60 : 300);
    } else if (m.k === 'send') this.sent.push(JSON.parse(m.data));
    else if (m.k === 'close') { this.socketOpen = false; this.clientClosed = true; }
  }
  terminate() { this.terminated = true; this.socketOpen = false; }
  emit(d) { if (!this.terminated) this.onmessage?.({ data: d }); }
  emitMsg(obj) { this.emit({ k: 'msg', data: JSON.stringify(obj), n: ++this.n, receivedAt: now }); }
  serverDrop(code = 1006) { this.socketOpen = false; this.emit({ k: 'closed', code, reason: '' }); }
}
globalThis.Worker = FakeWorker;
globalThis.WebSocket = class { constructor() { throw new Error('direct socket not expected in this suite'); } };

const live = () => workers.filter((w) => w.socketOpen && !w.terminated);
const frames = (type) => workers.flatMap((w) => w.sent.filter((f) => f.type === type));
function fresh() {
  workers = [];
  timers.clear();
  const net = new NetworkClient();
  const spy = { resumeFailed: 0, closedUi: 0, progress: [] };
  net.onResumeFailed = () => { spy.resumeFailed += 1; };
  net.onConnectionClosed = () => { spy.closedUi += 1; };
  net.onConnectProgress = (p) => { spy.progress.push(p); };
  return { net, spy };
}
function track(p) {
  const r = { resolved: 0, rejected: 0, at: null };
  p.then(() => { r.resolved += 1; r.at = now; }, () => { r.rejected += 1; r.at = now; });
  return r;
}
const hasApi = (net, name) => typeof net[name] === 'function';

// ── A: first open fails, server up after 7 s ────────────────────────────────
console.log('A  fresh page, cold start 7 s');
store.set('piratesBR.sessionToken', 'stale-token-from-last-load');
world.serverUpAt = now + 7_000;
const A = fresh();
const t0 = now;
const rA = track(A.net.connect('wss://pirates-br.fly.dev/ws'));
await advance(70_000);
check('connect() resolves exactly once', rA.resolved === 1 && rA.rejected === 0, `resolved ${rA.resolved}, rejected ${rA.rejected}`);
check('resolves soon after the server is up (<= 16 s)', rA.at != null && rA.at - t0 <= 16_000, `${rA.at == null ? 'never' : rA.at - t0} ms`);
check('exactly one live transport', live().length === 1, `${live().length} live of ${workers.length} spawned`);
check('no resume frame from a fresh page', frames('resume').length === 0, `${frames('resume').length} resume frames`);
check('no resume-failed UI', A.spy.resumeFailed === 0, `${A.spy.resumeFailed} calls`);
check('no "Disconnected" UI for attempts that never opened', A.spy.closedUi === 0, `${A.spy.closedUi} calls`);
const opensBeforeUp = workers.length;
check('one supervisor: <= 7 attempts for a 7 s outage', opensBeforeUp <= 7, `${opensBeforeUp} transports spawned`);
check('progress reported for the retries', A.spy.progress.some((p) => p.phase === 'retrying'), JSON.stringify(A.spy.progress.slice(0, 2)));

// ── B: drop after welcome resumes with this page's token ─────────────────────
console.log('B  drop after the welcome');
const liveA = live()[0];
const tokenA = liveA ? `tok${liveA.id}` : null;
liveA?.serverDrop(1006);
await advance(12_000);
const resumesB = frames('resume');
check('exactly one resume after the drop', resumesB.length === 1, `${resumesB.length}`);
check('resume carries this page\'s token, not the stored one', resumesB[0]?.payload?.token === tokenA, `${resumesB[0]?.payload?.token} vs ${tokenA}`);
check('one live transport after the resume', live().length === 1, `${live().length}`);
A.net.disconnect();
await advance(1_000);

// ── C: server never answers, then Retry ─────────────────────────────────────
console.log('C  never up, then Retry');
world.serverUpAt = Infinity;
const C = fresh();
const tC = now;
const rC = track(C.net.connect('wss://pirates-br.fly.dev/ws'));
await advance(75_000);
check('connect() rejects exactly once', rC.rejected === 1 && rC.resolved === 0, `resolved ${rC.resolved}, rejected ${rC.rejected}`);
check('gives up inside the 60 s budget (50-62 s)', rC.at != null && rC.at - tC >= 50_000 && rC.at - tC <= 62_000, `${rC.at == null ? 'never' : rC.at - tC} ms`);
check('no transport left alive after giving up', live().length === 0 && timers.size <= 1, `${live().length} live, ${timers.size} timers`);
world.serverUpAt = now;
if (hasApi(C.net, 'retryNow')) {
  const rC2 = track(C.net.retryNow());
  await advance(3_000);
  check('retryNow() connects once the server is back', rC2.resolved === 1 && live().length === 1, `resolved ${rC2.resolved}, live ${live().length}`);
} else check('retryNow() exists', false, 'missing');
C.net.disconnect();
await advance(1_000);

// ── D: offline / online ─────────────────────────────────────────────────────
console.log('D  offline, then online');
world.serverUpAt = Infinity;
const D = fresh();
const winD = fakeTarget();
const docD = fakeTarget();
if (hasApi(D.net, 'installLifecycle')) D.net.installLifecycle(winD, docD);
const rD = track(D.net.connect('wss://pirates-br.fly.dev/ws'));
await advance(7_600); // in an ~8 s backoff wait now
winD.fire('offline');
check('offline event -> "offline" progress', D.spy.progress.some((p) => p.phase === 'offline'), JSON.stringify(D.spy.progress.at(-1)));
world.serverUpAt = now;
const spawnedBefore = workers.length;
winD.fire('online');
await advance(400);
check('online event retries at once (connected within 0.4 s)', rD.resolved === 1 && workers.length === spawnedBefore + 1, `resolved ${rD.resolved}, spawned ${workers.length - spawnedBefore}`);
D.net.disconnect();
await advance(1_000);

// ── E: back from the background on a silently dead socket ───────────────────
console.log('E  background 30 s, socket died silently');
world.serverUpAt = now;
const E = fresh();
const winE = fakeTarget();
const docE = fakeTarget();
if (hasApi(E.net, 'installLifecycle')) E.net.installLifecycle(winE, docE);
await (async () => { const p = E.net.connect('wss://pirates-br.fly.dev/ws'); await advance(500); await p; })();
const wE = live()[0];
const tokenE = wE ? `tok${wE.id}` : null;
docE.visibilityState = 'hidden'; docE.hidden = true; docE.fire('visibilitychange');
winE.fire('pagehide', { persisted: false });
await advance(30_000);
if (wE) wE.socketOpen = false; // iOS froze the page; the socket is gone but no close event was delivered
docE.visibilityState = 'visible'; docE.hidden = false; docE.fire('visibilitychange');
await advance(5_000);
const resumesE = frames('resume');
check('resumes within 5 s of coming back', resumesE.length === 1 && resumesE[0].payload?.token === tokenE, `${resumesE.length} resumes, token ${resumesE[0]?.payload?.token}`);
check('one live transport after the resume', live().length === 1, `${live().length}`);
// a healthy socket must NOT be torn down by the same check
const wE2 = live()[0];
docE.visibilityState = 'hidden'; docE.hidden = true; docE.fire('visibilitychange');
await advance(30_000);
docE.visibilityState = 'visible'; docE.hidden = false; docE.fire('visibilitychange');
wE2?.emitMsg({ type: 'pong', ts: now, payload: { t: now } });
await advance(5_000);
check('a live socket survives the foreground check', live().length === 1 && live()[0] === wE2 && frames('resume').length === 1, `live ${live().length}, same ${live()[0] === wE2}, resumes ${frames('resume').length}`);
E.net.disconnect();
await advance(1_000);

// ── G: version gate wiring ──────────────────────────────────────────────────
console.log('G  buildId skew');
world.serverUpAt = now;
world.buildId = 'server-b';
const G = fresh();
const reloads = [];
let phase = 'in_match';
if (hasApi(G.net, 'setVersionGate')) {
  const { VersionGate } = await import('../src/client/network/versionGate.ts');
  const gStore = new Map();
  G.net.setVersionGate(new VersionGate({ clientBuild: 'client-a', storage: { getItem: (k) => gStore.get(k) ?? null, setItem: (k, v) => gStore.set(k, v) }, reload: () => reloads.push(now) }), () => phase);
  await (async () => { const p = G.net.connect('wss://pirates-br.fly.dev/ws'); await advance(500); await p; })();
  check('in a match: skew deferred (no reload)', reloads.length === 0, `${reloads.length}`);
  phase = 'menu';
  G.net.returnToMenu();
  await advance(1_000);
  check('back on the menu: reloads exactly once', reloads.length === 1, `${reloads.length}`);
} else check('setVersionGate() exists', false, 'missing');
G.net.disconnect();
world.buildId = undefined;

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  test-connect-supervisor: ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
