#!/usr/bin/env node
// SESSION TELEMETRY (b1.7c, D35): one summary per match, the reload-without-
// clean-exit marker (set at match start, cleared at the end screen, reported
// at the next boot only when pagehide never fired: the iOS memory-kill
// signature), the pacer's rendered-interval tap, the Show FPS pill's p50, and
// no IP / name / device id on the wire. Logic only, fake pacer + fake pagehide.
//   node --import tsx scripts/test-session-telemetry.mjs
const { SessionTelemetry, SESSION_MARKER_KEY, classifyDevice, histPercentile } = await import('../src/client/network/sessionTelemetry.ts');
const { FramePacer } = await import('../src/client/core/framePacer.ts');
const { sanitizeSession } = await import('../src/server/net/beaconStore.ts');

let failures = 0;
const expect = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
};

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
function rig(storage = new MemStorage(), wallStart = 1_700_000_000_000) {
  const sent = [];
  let clock = 1000;
  let wall = wallStart;
  let seed = 1;
  const t = new SessionTelemetry({
    send: (body) => { sent.push(JSON.parse(body)); return true; },
    storage, now: () => clock, wallNow: () => wall,
    random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    ua: IPHONE_UA, touchPoints: 5, dpr: 3, screenMin: 390, buildId: 'build-a1',
  });
  t.setTier('low');
  // The fake pacer: rendered intervals arrive through the same tap Game wires.
  const pacer = new FramePacer(0);
  pacer.setRenderedTap((ms) => t.recordFrame(ms));
  const frames = (n, ms) => { for (let i = 0; i < n; i++) { clock += ms; wall += ms; pacer.shouldRender(clock); } };
  pacer.shouldRender(clock);
  return { t, sent, storage, frames, wall: () => wall, advance: (ms) => { clock += ms; wall += ms; } };
}

console.log('\n[1] one summary per match, at the end screen');
{
  const r = rig();
  expect('boot with no marker sends nothing', r.t.checkPreviousRun() === null && r.sent.length === 0);
  r.t.matchStart();
  const marker = JSON.parse(r.storage.getItem(SESSION_MARKER_KEY) ?? 'null');
  expect('the reload marker is set at match start', marker && typeof marker.nonce === 'string' && !marker.reported, JSON.stringify(marker));
  r.frames(300, 16.7);
  r.frames(40, 33.4);
  r.frames(1, 150);
  r.t.noteLongTask(120); r.t.noteLongTask(60); r.t.noteContextLoss();
  expect('nothing sent mid-match', r.sent.length === 0, `${r.sent.length}`);
  r.t.matchEnd(true);
  expect('exactly one summary at the end screen', r.sent.length === 1, `${r.sent.length}`);
  expect('the marker is cleared at the end screen', r.storage.getItem(SESSION_MARKER_KEY) === null);
  const s = r.sent[0] ?? {};
  expect('matchCompleted true, not a reload', s.matchCompleted === true && s.reloadWithoutCleanExit === false);
  expect('frames = 341 rendered intervals from the pacer tap', s.frames === 341, `${s.frames}`);
  expect('p50 = 17 ms bin (fps 58.8), p95 = 34 ms bin', s.frameP50Ms === 17 && s.frameP95Ms === 34 && Math.abs(s.fpsP50 - 58.8) < 0.1, `${s.frameP50Ms}/${s.frameP95Ms}/${s.fpsP50}`);
  expect('long tasks > 100 ms counted (120 yes, 60 no)', s.longTasks === 1, `${s.longTasks}`);
  expect('long rendered frames > 100 ms counted', s.longFrames === 1, `${s.longFrames}`);
  expect('context losses counted', s.contextLosses === 1);
  expect('device phone, browser safari, tier low, dpr 3, build', s.device === 'phone' && s.browser === 'safari' && s.tier === 'low' && s.dpr === 3 && s.buildId === 'build-a1', JSON.stringify(s));
  const allowed = new Set(['kind', 'v', 'nonce', 'buildId', 'device', 'browser', 'tier', 'dpr', 'frames', 'frameP50Ms', 'frameP95Ms', 'fpsP50', 'longTasks', 'longFrames', 'contextLosses', 'reloadWithoutCleanExit', 'matchCompleted', 'durationSec']);
  const extra = Object.keys(s).filter((k) => !allowed.has(k));
  expect('no field outside the whitelist (no ip, name, player id, device id, ua)', extra.length === 0, extra.join(','));
  const raw = JSON.stringify(s);
  expect('no raw UA, ip or name on the wire', !/Mozilla|iPhone OS|ip"|"name"|playerId|deviceId/.test(raw), raw);
  r.t.pageHide();
  r.t.matchEnd(true);
  expect('pagehide and a second end after the end screen send nothing more', r.sent.length === 1, `${r.sent.length}`);
  const back = sanitizeSession(s);
  expect('the server sanitiser accepts the client summary unchanged', back && back.fpsP50 === s.fpsP50 && back.device === 'phone' && back.matchCompleted === true);
  expect('the server sanitiser drops injected fields', !('ip' in (sanitizeSession({ ...s, ip: '1.2.3.4', name: 'x' }) ?? { ip: 1 })));
}

console.log('\n[2] pagehide mid-match: one summary, marker marked reported, next boot silent');
{
  const r = rig();
  r.t.matchStart();
  r.frames(120, 33.4);
  r.t.pageHide();
  expect('pagehide mid-match sends exactly one summary', r.sent.length === 1 && r.sent[0].matchCompleted === false, JSON.stringify(r.sent.map((x) => x.matchCompleted)));
  r.t.pageHide();
  expect('a second pagehide does not re-send', r.sent.length === 1);
  const m = JSON.parse(r.storage.getItem(SESSION_MARKER_KEY) ?? 'null');
  expect('the marker survives, marked reported', m && m.reported === true);
  const next = rig(r.storage);
  expect('next boot does not report a kill for a seen exit', next.t.checkPreviousRun() === null && next.sent.length === 0);
  expect('and clears the marker', r.storage.getItem(SESSION_MARKER_KEY) === null);
}

console.log('\n[3] killed mid-match (no pagehide, no end screen): the next boot reports it once');
{
  const r = rig();
  r.t.matchStart();
  r.frames(200, 40);
  const nonce = JSON.parse(r.storage.getItem(SESSION_MARKER_KEY)).nonce;
  r.advance(95_000);
  const next = rig(r.storage, r.wall());
  const s = next.t.checkPreviousRun();
  expect('the kill is reported at the next boot', next.sent.length === 1 && s?.reloadWithoutCleanExit === true && s?.matchCompleted === false, JSON.stringify(s));
  expect('with the killed match nonce and its device/tier', s?.nonce === nonce && s?.device === 'phone' && s?.tier === 'low');
  expect('duration from the wall clock (~103 s)', s && s.durationSec >= 100 && s.durationSec <= 110, `${s?.durationSec}`);
  expect('marker cleared, a second boot is silent', next.t.checkPreviousRun() === null && next.sent.length === 1);
  expect('the killed page itself never sent', r.sent.length === 0);
}

console.log('\n[4] Return to Port mid-match and back-to-back matches');
{
  const r = rig();
  r.t.matchStart();
  r.frames(60, 16.7);
  r.t.matchEnd(false);
  expect('Return to Port sends one summary, matchCompleted false, marker cleared', r.sent.length === 1 && r.sent[0].matchCompleted === false && r.storage.getItem(SESSION_MARKER_KEY) === null);
  r.t.matchStart(); r.frames(10, 16.7); r.t.matchEnd(true);
  r.t.matchStart(); r.frames(10, 16.7); r.t.matchEnd(true);
  expect('three matches = three summaries, three distinct nonces', r.sent.length === 3 && new Set(r.sent.map((x) => x.nonce)).size === 3);
  expect('counters reset per match (10 frames, not 80)', r.sent[2].frames === 10, `${r.sent[2].frames}`);
  r.frames(50, 16.7);
  r.t.pageHide();
  expect('frames and pagehide outside a match send nothing', r.sent.length === 3);
}

console.log('\n[5] pacer tap, Show FPS p50, device classes');
{
  const got = [];
  const p = new FramePacer(30);
  p.setRenderedTap((ms) => got.push(ms));
  for (let t = 0; t <= 1000; t += 1000 / 120) p.shouldRender(t);
  const mean = got.reduce((a, b) => a + b, 0) / Math.max(1, got.length);
  expect('a 30 fps cap on a 120 Hz display taps rendered intervals only (~33 ms)', got.length >= 28 && got.length <= 31 && Math.abs(mean - 33.3) < 1.5, `${got.length} taps, mean ${mean.toFixed(2)}`);
  const r = rig();
  r.frames(300, 16.7);
  expect('pill p50 ~60 fps', Math.abs(r.t.fpsP50Recent() - 59.9) < 0.5, `${r.t.fpsP50Recent()}`);
  r.frames(200, 33.4);
  expect('pill p50 follows the last 5 s only (~30 fps)', Math.abs(r.t.fpsP50Recent() - 29.9) < 0.5, `${r.t.fpsP50Recent()}`);
  expect('histPercentile of an empty histogram is 0', histPercentile(new Uint32Array(10), 0, 0.5) === 0);
  const ipadDesktop = classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5, 820);
  const macChrome = classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 0, 900);
  const android = classifyDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', 5, 412);
  expect('iPad in desktop mode -> tablet/safari', ipadDesktop.device === 'tablet' && ipadDesktop.browser === 'safari');
  expect('Mac Chrome -> desktop/chrome', macChrome.device === 'desktop' && macChrome.browser === 'chrome');
  expect('Android phone -> phone/chrome', android.device === 'phone' && android.browser === 'chrome');
}

console.log(failures === 0 ? '\nPASS test-session-telemetry' : `\nFAIL test-session-telemetry: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
