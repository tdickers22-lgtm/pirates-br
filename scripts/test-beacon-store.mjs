#!/usr/bin/env node
// BEACON STORE + TRIAGE (b1.7c, D35): the 5 MB ring stays under its cap with
// 10k synthetic beacons and evicts oldest-first past it; error signatures group
// across builds (Vite hash + line:col stripped) and split on message/top
// frame; a session nonce is counted once; /health/beacons and /health/telemetry
// answer 403 without HEALTH_KEY; triage-beacons against a fake server lists a
// 3-session signature and omits a 2-session one; the ring survives a restart.
//   node --import tsx scripts/test-beacon-store.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { BeaconStore, STORE_MAX_BYTES, serveBeaconRoute, signatureOf, sanitizeSession } = await import('../src/server/net/beaconStore.ts');
const { triage, formatTriage } = await import('./triage-beacons.mjs');

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
};

const session = (i, over = {}) => sanitizeSession({
  kind: 'session', v: 1, nonce: `nn${i.toString(36)}x`, buildId: `b${i % 7}`, device: ['phone', 'tablet', 'desktop'][i % 3],
  browser: 'safari', tier: 'low', dpr: 3, frames: 5000 + i, frameP50Ms: 34, frameP95Ms: 60, fpsP50: 29.4,
  longTasks: 2, longFrames: 3, contextLosses: 0, reloadWithoutCleanExit: false, matchCompleted: true, durationSec: 600, ...over,
});
const stackIn = (hash, line) => `TypeError: x is undefined\n    at Game.frameBody (https://pirates-br.fly.dev/assets/index-${hash}.js:1:${line})\n    at FrameGuard.run (https://pirates-br.fly.dev/assets/index-${hash}.js:1:99)`;
const err = (msg, build, stack, ua = 'safari/ios/phone') => ({ kind: 'error', message: msg, stack, buildId: build, ua });

console.log('\n[1] 10k synthetic beacons stay under 5 MB; past the cap the oldest go first');
{
  const s = new BeaconStore({ path: null });
  for (let i = 0; i < 5000; i++) s.recordSession(session(i));
  for (let i = 0; i < 5000; i++) s.recordError(err(`TypeError: thing ${i % 3000} broke at key k${i % 3000}`, `b${i % 5}`, stackIn('AbCd1234', 100 + (i % 3000))));
  const size = s.sizeBytes();
  expect(`10k beacons serialize to <= 5 MB (${(size / 1048576).toFixed(2)} MB)`, size <= STORE_MAX_BYTES && size > 100_000, `${size}`);
  expect('the byte accounting tracks the real size within 10%', Math.abs(s.approxSize() - size) / size < 0.1, `${s.approxSize()} vs ${size}`);
  const small = new BeaconStore({ path: null, maxBytes: 200_000 });
  for (let i = 0; i < 10_000; i++) small.recordSession(session(i));
  const t = small.telemetryReport();
  expect(`a 200 KB ring holds <= 200 KB after 10k sessions (${small.sizeBytes()} B)`, small.sizeBytes() <= 200_000 * 1.02, `${small.sizeBytes()}`);
  expect('it kept the NEWEST sessions', t.recent.at(-1)?.nonce === session(9999).nonce && t.recent[0]?.nonce !== session(0).nonce && t.sessions > 100, `${t.sessions}`);
}

console.log('\n[2] signatures group across builds, split on message and top frame');
{
  const s = new BeaconStore({ path: null });
  s.recordError(err('TypeError: x is undefined', 'build-1', stackIn('AbCd1234', 4211)));
  s.recordError(err('TypeError: x is undefined', 'build-2', stackIn('ZyXw9876', 4388), 'chrome/windows/desktop'));
  s.recordError(err('TypeError: y is undefined', 'build-2', stackIn('ZyXw9876', 4388)));
  s.recordError(err('Error: fetch failed after 3 tries', 'build-2', ''));
  s.recordError(err('Error: fetch failed after 5 tries', 'build-2', ''));
  const r = s.beaconsReport();
  const x = r.signatures.find((g) => g.message.startsWith('TypeError: x'));
  expect('the same bug in two builds is ONE signature', r.signatures.filter((g) => g.message.startsWith('TypeError: x')).length === 1 && x?.count === 2, JSON.stringify(r.signatures.map((g) => g.sig)));
  expect('it counts per build and per device class', x?.builds['build-1'] === 1 && x?.builds['build-2'] === 1 && x?.devices.phone === 1 && x?.devices.desktop === 1, JSON.stringify(x));
  expect('the top frame drops the host, the Vite hash and line:col', x?.topFrame === 'Game.frameBody (/assets/index.js)', x?.topFrame);
  expect('a different message is a different signature', r.signatures.length === 3, `${r.signatures.length}`);
  expect('numbers in a message do not split a signature', signatureOf('error', 'failed after 3 tries', '').sig === signatureOf('error', 'failed after 5 tries', '').sig);
}

console.log('\n[3] a match nonce counts once; killed flag survives; per-device fps histogram');
{
  const s = new BeaconStore({ path: null });
  s.recordSession(session(1, { device: 'phone', reloadWithoutCleanExit: true, matchCompleted: false, frames: 0, fpsP50: 0 }));
  s.recordSession(session(1, { device: 'phone', fpsP50: 31 }));
  s.recordSession(session(2, { device: 'phone', fpsP50: 18 }));
  s.recordSession(session(3, { device: 'desktop', fpsP50: 58 }));
  const t = s.telemetryReport();
  expect('same nonce replaces: 3 sessions, not 4', t.sessions === 3, `${t.sessions}`);
  expect('the killed verdict of the earlier report is kept', t.byDevice.phone?.killed === 1);
  const bins = t.fpsBins;
  const binOf = (fps) => bins.reduce((b, lo, i) => (fps >= lo ? i : b), 0);
  expect('phone fps histogram: one in the 30 bin, one in the 15 bin', t.byDevice.phone.fpsHist[binOf(31)] === 1 && t.byDevice.phone.fpsHist[binOf(18)] === 1, JSON.stringify(t.byDevice.phone.fpsHist));
  expect('sanitizeSession refuses a malformed nonce and a non-session kind', sanitizeSession({ kind: 'session', nonce: '../../x' }) === null && sanitizeSession({ kind: 'error' }) === null);
}

console.log('\n[4] HEALTH_KEY posture on /health/beacons and /health/telemetry');
function fakeReqRes({ path = '/health/beacons', method = 'GET', headers = {}, addr = '127.0.0.1' } = {}) {
  const req = { url: path, method, headers, socket: { remoteAddress: addr }, resume() {} };
  const res = { status: 0, body: '', headers: {}, writeHead(st, h) { this.status = st; Object.assign(this.headers, h ?? {}); }, end(b) { this.body = String(b ?? ''); } };
  return { req, res };
}
const call = (store, opts) => { const { req, res } = fakeReqRes(opts); serveBeaconRoute(store, req, res, opts.path.split('?')[0]); return res; };
{
  const store = new BeaconStore({ path: null });
  store.recordError(err('TypeError: x', 'b1', stackIn('AbCd1234', 1)));
  const saved = process.env.HEALTH_KEY;
  process.env.HEALTH_KEY = 'k3y-for-test';
  expect('/health/telemetry without the key -> 403', call(store, { path: '/health/telemetry' }).status === 403);
  expect('/health/beacons without the key -> 403', call(store, { path: '/health/beacons' }).status === 403);
  expect('a wrong key -> 403', call(store, { path: '/health/beacons', headers: { 'x-health-key': 'k3y-for-tesT' } }).status === 403);
  const ok = call(store, { path: '/health/beacons?sinceHours=24', headers: { 'x-health-key': 'k3y-for-test' } });
  expect('the right key -> 200 with the grouped signatures', ok.status === 200 && JSON.parse(ok.body).signatures?.length === 1, `${ok.status} ${ok.body.slice(0, 80)}`);
  expect('POST -> 405', call(store, { path: '/health/beacons', method: 'POST', headers: { 'x-health-key': 'k3y-for-test' } }).status === 405);
  delete process.env.HEALTH_KEY;
  expect('no key configured: a proxied request -> 403', call(store, { path: '/health/telemetry', headers: { 'fly-client-ip': '9.9.9.9' } }).status === 403);
  expect('no key configured: a non-loopback caller -> 403', call(store, { path: '/health/telemetry', addr: '10.0.0.5' }).status === 403);
  expect('no key configured: local loopback -> 200', call(store, { path: '/health/telemetry' }).status === 200);
  if (saved !== undefined) process.env.HEALTH_KEY = saved;
}

console.log('\n[5] triage-beacons against a fake server');
{
  const store = new BeaconStore({ path: null });
  for (let i = 0; i < 3; i++) store.recordError(err('TypeError: three sessions', `b${i}`, stackIn('AbCd1234', 10 + i)));
  for (let i = 0; i < 2; i++) store.recordError(err('TypeError: two sessions only', 'b1', stackIn('AbCd1234', 20)));
  for (let i = 0; i < 10; i++) store.recordSession(session(100 + i, { device: 'phone', fpsP50: i < 9 ? 30 : 12 }));
  for (let i = 0; i < 4; i++) store.recordSession(session(200 + i, { device: 'desktop', fpsP50: i < 2 ? 60 : 40 }));
  const key = 'triage-key';
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const { req, res } = fakeReqRes({ path: u.pathname + u.search, headers: init.headers ?? {}, addr: '10.1.1.1' });
    const saved = process.env.HEALTH_KEY;
    process.env.HEALTH_KEY = key;
    serveBeaconRoute(store, req, res, u.pathname);
    if (saved === undefined) delete process.env.HEALTH_KEY; else process.env.HEALTH_KEY = saved;
    return { status: res.status, json: async () => JSON.parse(res.body) };
  };
  const r = await triage({ url: 'https://fake.test/', key, fetchImpl: fakeFetch });
  const text = formatTriage(r);
  expect('lists the signature seen in 3 sessions', r.signatures.some((g) => g.message === 'TypeError: three sessions') && text.includes('TypeError: three sessions'), text);
  expect('omits the one seen in 2 sessions', !r.signatures.some((g) => g.message.includes('two sessions')) && !text.includes('two sessions only'));
  expect('phone fps share 90% at >= 24 fps (9 of 10)', Math.abs(r.classes.phone?.share - 0.9) < 1e-9 && text.includes('phone: 90% of 10 graded sessions >= 24 fps'), text);
  expect('desktop fps share 50% at >= 45 fps (2 of 4)', Math.abs(r.classes.desktop?.share - 0.5) < 1e-9);
  let refused = '';
  try { await triage({ url: 'https://fake.test', key: '', fetchImpl: fakeFetch }); } catch (e) { refused = e.message; }
  expect('without the key triage refuses loudly (403)', /403/.test(refused), refused);
}

console.log('\n[6] the ring survives a restart (volume file)');
{
  const dir = mkdtempSync(join(tmpdir(), 'pbr-beacons-'));
  try {
    const path = join(dir, 'data', 'beacons.json');
    const a = new BeaconStore({ path, flushMs: 0 });
    a.recordError(err('TypeError: persisted', 'b9', stackIn('AbCd1234', 7)));
    a.recordSession(session(42));
    a.close();
    const b = new BeaconStore({ path, flushMs: 0 });
    expect('signatures and sessions reload from the volume', b.beaconsReport().signatures[0]?.message === 'TypeError: persisted' && b.telemetryReport().sessions === 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nPASS test-beacon-store' : `\nFAIL test-beacon-store: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
