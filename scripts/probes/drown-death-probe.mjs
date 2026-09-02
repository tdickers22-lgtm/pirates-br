// PROBE, not a gate: A REAL DEATH, END TO END — the cause tag off the wire, the blackout that names it, and chip damage you can actually see arriving.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// A REAL DEATH, END TO END — the cause tag off the wire, the blackout that
// names it, and chip damage you can actually see arriving.
//
// The tempest is the headline defect but it is also the slowest thing in the
// game to arrange (the ring takes six minutes of sim to reach a berth). Drowning
// bills the SAME WAY the storm does — PLAYER.DROWN_DAMAGE 5 hp/s, delivered as
// 0.5-hp chips at the snapshot rate, well under the half-point threshold that
// used to throw every one of them away — and it is reachable in ninety seconds.
// So this is the live end-to-end: a genuine server-side death, a genuine
// `kill_event.cause` on the wire, the genuine respawn blackout copy, and the
// genuine attrition read while it happens.
//
// ── WHAT THIS NEEDS FROM THE HOST ────────────────────────────────────────────
// A quiet machine. It waits on SIM time, and the dev server sheds ticks under
// load: with four agents' probes on one box (load average 40+) the sim ran at
// roughly 7% of real time and no amount of wall-clock budget reached the death.
// Check /health first — `worstSimLagSec` near 0 means this will finish; a lag
// that climbs while you watch means it will not. `?server=<port>` (PROBE_SERVER
// here) points the tab at a private server so at least the sim is yours alone.
//
//   PROBE_SERVER=8095 node scripts/drown-death-probe.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2]
  ?? '/private/tmp/claude-501/-Users-tobiasdicker/10a91956-1f9b-4664-ae78-2d985d4991c4/scratchpad/killwave/deathcam';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 }).catch(() => {});
const wait = (ms) => page.waitForTimeout(ms);

await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });\nexport const updateStyle = () => {};\nexport const removeStyle = () => {};\nexport const injectQuery = (u) => u;\nexport default {};',
}));
await page.addInitScript(() => {
  try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private mode */ }
});

const url = `http://127.0.0.1:3000/?debug&forceinput${process.env.PROBE_SERVER ? `&server=${process.env.PROBE_SERVER}` : ''}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await wait(2500);
await page.evaluate(() => {
  document.getElementById('onboard-cards')?.classList.remove('visible');
  window.__piratesBR.setDayNightOverride(854);
});

// Watch the wire itself: what cause does the server put on the kill event?
await page.evaluate(() => {
  const g = window.__piratesBR;
  window.__killEvents = [];
  const prev = g.network.onKillEvent;
  g.network.onKillEvent = (payload) => {
    window.__killEvents.push(payload);
    return prev?.(payload);
  };
});

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return {
    state: me?.state ?? null,
    hp: me ? +me.health.toFixed(2) : null,
    swimTimer: me ? +(me.swimTimer ?? 0).toFixed(1) : null,
    onShip: !!me?.onShipId,
    attrition: +(document.getElementById('attrition-vignette')?.style.opacity ?? 0),
    hurt: +(document.getElementById('hurt-vignette')?.style.opacity ?? 0),
    barFlash: (document.getElementById('health-bar-wrap')?.style.filter ?? '') !== '',
    prompt: document.getElementById('interact-prompt')?.textContent ?? '',
    label: document.getElementById('context-label')?.textContent ?? '',
    serverCause: g.hud.serverEliminationCause ?? null,
    kills: window.__killEvents.length,
  };
});

// ── Into the water and stay there ────────────────────────────────────────────
let s = await snap();
console.log('start:', JSON.stringify(s));
const t0 = Date.now();
const peak = { attrition: 0, hurt: 0, barFlash: false };
const trace = [];
let firstChipShot = false;
let deepShot = false;
let dead = null;

while (Date.now() - t0 < 520_000) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    if (!me) return;
    // STRAIGHT OUT TO SEA — away from the nearest island's centre is the
    // shortest line to deep water from anywhere on it or its pier. (Away from
    // the storm centre is not: half the time that is inland.)
    let land = null;
    for (const i of g.state.islands) {
      const d = Math.hypot(i.position.x - me.position.x, i.position.z - me.position.z);
      if (!land || d < land.d) land = { d, x: i.position.x, z: i.position.z };
    }
    const yaw = land
      ? Math.atan2(me.position.x - land.x, me.position.z - land.z)
      : me.rotation.x;
    g.input.setLook(yaw, -0.5);
    g.input.keys.add('KeyW');
    if (me.state === 'swimming') g.input.keys.add('KeyZ');
    else g.input.jumpPressed = true;
  });
  const r = await snap();
  trace.push({ ms: Date.now() - t0, ...r });
  peak.attrition = Math.max(peak.attrition, r.attrition);
  peak.hurt = Math.max(peak.hurt, r.hurt);
  peak.barFlash = peak.barFlash || r.barFlash;
  if (trace.length % 12 === 0) {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s state=${r.state} hp=${r.hp} swim=${r.swimTimer} att=${r.attrition} hurt=${r.hurt} bar=${r.barFlash}`);
  }
  if (!firstChipShot && r.hp !== null && r.hp < 99) {
    firstChipShot = true;
    console.log(`FIRST CHIP: ${JSON.stringify(r)}`);
    await shot('30-first-drown-chip');
  }
  if (!deepShot && r.hp !== null && r.hp < 45) {
    deepShot = true;
    console.log(`DEEP: ${JSON.stringify(r)}`);
    await shot('31-drowning-vignette');
  }
  if (r.state === 'respawning' || r.state === 'eliminated' || r.state === 'downed') {
    dead = r;
    console.log(`DEAD: ${JSON.stringify(r)}`);
    break;
  }
  await wait(280);
}
await page.evaluate(() => {
  const k = window.__piratesBR.input.keys;
  k.delete('KeyW'); k.delete('KeyZ');
});

await wait(900);
const after = await snap();
await shot('32-the-blackout');
const wire = await page.evaluate(() => window.__killEvents.slice(-4));

const report = {
  died: !!dead,
  deathState: dead?.state ?? null,
  killEventsOnTheWire: wire,
  causeTheClientBelieves: after.serverCause,
  blackoutPrompt: after.prompt,
  blackoutLabel: after.label,
  peakDuringTheBleed: peak,
  trace: trace.filter((t) => t.hp !== null && t.hp < 100).slice(0, 40),
};
console.log('DROWN REPORT:', JSON.stringify({ ...report, trace: undefined }, null, 1));
writeFileSync(`${OUT}/drown-report.json`, JSON.stringify(report, null, 1));
await browser.close();

let bad = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); bad += 1; }
};
const mine = wire.filter((e) => e && e.cause);
check('the pirate actually died', !!dead, JSON.stringify(after));
check('the wire carried a cause', mine.length > 0, JSON.stringify(wire));
check('and the cause is DROWNED, not a guess',
  mine.some((e) => e.cause === 'drowned'), JSON.stringify(mine.map((e) => e.cause)));
check('the blackout names what killed you, not just the wait',
  /went under|drown/i.test(report.blackoutPrompt) || /went under|drown/i.test(report.blackoutLabel),
  `${report.blackoutPrompt} / ${report.blackoutLabel}`);
check('drowning chips were visible while they landed',
  peak.attrition > 0.15 && peak.barFlash, JSON.stringify(peak));
if (bad > 0) process.exit(1);
console.log('\nA real death, named correctly, and visible on the way down.');
