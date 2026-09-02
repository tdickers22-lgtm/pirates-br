// PROBE, not a gate: WALKING OFF THE DECK — the moment nothing told you about.
// Moved to scripts/probes/ (2026-09-02): an instrument that is read, never graded. Run from the repo root.
// WALKING OFF THE DECK — the moment nothing told you about.
//
// You stroll past the rail and the state flips to `swimming`. Today that is the
// entire event: no splash, no wash across the frame, no sound. You find out the
// ship is above you. This walks a real pirate off a real deck and reads the two
// cues that now fire (CombatFx.watchLocalVitals → #water-entry-flash + the swim
// splash on the sound engine).
//
//   node scripts/deck-splash-probe.mjs [outDir]
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

await page.goto(`http://127.0.0.1:3000/?debug&forceinput${process.env.PROBE_SERVER ? `&server=${process.env.PROBE_SERVER}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await wait(2500);
await page.evaluate(() => {
  const cards = document.getElementById('onboard-cards');
  if (cards?.classList.contains('visible')) document.getElementById('oc-skip')?.click();
  window.__piratesBR.setDayNightOverride(854);
});

// Count the swim splashes the sound engine is actually asked for — an overlay
// with no sound is half a cue, and "we called the method" is the only honest
// read of an audio context that headless Chromium never unmutes.
await page.evaluate(() => {
  const g = window.__piratesBR;
  window.__splashCalls = 0;
  const eng = g.combatFx.audio ?? g.audio ?? null;
  if (!eng || typeof eng.playSwimSplash !== 'function') { window.__splashCalls = -1; return; }
  const orig = eng.playSwimSplash.bind(eng);
  eng.playSwimSplash = (...a) => { window.__splashCalls += 1; return orig(...a); };
});

const snap = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  return {
    state: me?.state ?? null,
    onShip: !!me?.onShipId,
    splash: +(document.getElementById('water-entry-flash')?.style.opacity ?? 0),
    calls: window.__splashCalls,
  };
});

let s = await snap();
console.log('start:', JSON.stringify(s));

// Board if we are ashore.
for (let i = 0; i < 90 && !s.onShip; i++) {
  await page.evaluate(() => {
    const g = window.__piratesBR;
    const me = g.state.players.find((p) => p.id === g.localPlayerId);
    const sh = g.state.ships.find((x) => x.id === me?.shipId);
    const st = { sloop: { w: 5, l: 12 }, brigantine: { w: 7, l: 16 }, galleon: { w: 10, l: 22 } }[sh.type];
    const cos = Math.cos(sh.rotation), sin = Math.sin(sh.rotation);
    let best = null;
    for (const lx of [st.w * 0.56, -st.w * 0.56]) {
      const lz = -st.l * 0.18;
      const x = sh.position.x + lx * cos + lz * sin;
      const z = sh.position.z + lz * cos - lx * sin;
      const d = Math.hypot(x - me.position.x, z - me.position.z);
      if (!best || d < best.d) best = { x, z, d };
    }
    g.input.setLook(Math.atan2(best.x - me.position.x, best.z - me.position.z), best.d < 6 ? -0.1 : 0.02);
    g.input.keys.add('KeyW');
    g.input.jumpPressed = true;
  });
  await wait(200);
  const prompt = await page.evaluate(() => document.getElementById('interact-prompt')?.textContent ?? '');
  if (/Climb|Aboard|Board/i.test(prompt)) {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })), 70);
    });
    await wait(250);
  }
  s = await snap();
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
console.log('aboard:', JSON.stringify(s));
await shot('10-on-deck-before-the-step');

// ── Walk straight off the beam. No jump, no dive: the accident. ──────────────
const callsBefore = (await snap()).calls;
const walkOff = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const sh = g.state.ships.find((x) => x.id === me?.shipId);
  // SEAWARD beam. A berthed hull has a pier down one side; walking off THAT
  // side is a step onto planking, not into the sea.
  const nearestIsland = (x, z) => {
    let best = Infinity;
    for (const i of g.state.islands) best = Math.min(best, Math.hypot(i.position.x - x, i.position.z - z) - (i.radius ?? 60));
    return best;
  };
  let pick = null;
  for (const sign of [1, -1]) {
    const yaw = sh.rotation + sign * Math.PI / 2;
    const x = sh.position.x + Math.sin(yaw) * 16;
    const z = sh.position.z + Math.cos(yaw) * 16;
    const clear = nearestIsland(x, z);
    if (!pick || clear > pick.clear) pick = { yaw, clear, sign };
  }
  g.input.setLook(pick.yaw, -0.12);
  g.input.keys.add('KeyW');
  return { yaw: +pick.yaw.toFixed(2), clearM: +pick.clear.toFixed(1), side: pick.sign > 0 ? 'starboard' : 'port' };
});
console.log('stepping off the', walkOff.side, 'beam — nearest land', walkOff.clearM, 'm');

const trace = [];
let peak = 0;
let flipAt = null;
const t0 = Date.now();
for (let i = 0; i < 160; i++) {
  const r = await snap();
  trace.push({ ms: Date.now() - t0, ...r });
  // The weather deck has a rail; a pirate leaving it clears it. Keep walking
  // outboard and keep hopping — the cue under test is the state flip into the
  // water, however she got there.
  if (r.state !== 'swimming') {
    await page.evaluate(() => {
      const g = window.__piratesBR;
      g.input.keys.add('KeyW');
      g.input.jumpPressed = true;
    });
  }
  if (r.splash > peak) peak = r.splash;
  if (r.state === 'swimming' && flipAt === null) {
    flipAt = Date.now() - t0;
    await shot('11-the-instant-you-go-in');
  }
  if (flipAt !== null && Date.now() - t0 - flipAt > 2500) break;
  await wait(70);
}
await page.evaluate(() => window.__piratesBR.input.keys.delete('KeyW'));
const end = await snap();
await shot('12-two-seconds-in-the-water');

const report = {
  wentIn: flipAt !== null,
  peakSplashOpacity: +peak.toFixed(3),
  splashSoundsPlayed: end.calls - callsBefore,
  trace: trace.filter((t) => t.splash > 0 || t.state === 'swimming').slice(0, 30),
};
console.log('SPLASH:', JSON.stringify(report, null, 1));
writeFileSync(`${OUT}/splash-report.json`, JSON.stringify(report, null, 1));
await browser.close();
if (!report.wentIn) { console.error('never left the deck'); process.exit(1); }
if (report.peakSplashOpacity < 0.2 || report.splashSoundsPlayed < 1) {
  console.error('walking off the deck is still silent/invisible');
  process.exit(1);
}
console.log('the step off the deck is seen AND heard.');
