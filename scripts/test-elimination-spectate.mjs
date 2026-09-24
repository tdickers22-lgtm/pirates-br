#!/usr/bin/env node
// test-elimination-spectate (b1.5f, liveplay-06). Browser, one headless
// SwiftShader Chromium on the 3101/8091 stack (PIRATES_BR_URL), or --own-stack
// to boot and kill its own. Drives a Solo match, puts the local pirate OUT
// (eliminated, the death card raised the way Game does when the hull is gone),
// then within 8 s asserts:
//   - the spectate banner is visible and names a subject
//   - the death card collapsed to a bottom bar (panel in the lower 45 %, the
//     centre of the screen not covered) with a NEXT SHIP button
//   - the frame behind it is not >95 % black
//   - the next-target key changes the subject; right arrow, jump (Space) and
//     interact (X) move the camera to another crew; E (unbound) does not
// Before the scuttle, alive (b1.5f-verify): #ship-status carries hud-model-off
// ashore > 30 m from the own hull and on an enemy deck, not aboard or 20 m
// off; combatFx fed health 8 raises #low-hp-desaturate (> 0.3, blend
// saturation) and full health fades it back to ~0.
// Run: node scripts/test-elimination-spectate.mjs [--own-stack]
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { readPng } from './lib/png-read.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWN = process.argv.includes('--own-stack');
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101').replace(/\/$/, '');
let fails = 0;
const expect = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) fails++;
};
const kids = [];
const start = (cmd, env) => {
  const c = spawn(cmd, { cwd: REPO, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  kids.push(c);
};
const killAll = () => { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } } };

let browser = null;
try {
  if (OWN) {
    start('npx tsx src/server/index.ts', { PORT: '8091', PIRATES_BR_MAP_SEED: '20260801', PIRATES_BR_DEV: '1', PIRATES_BR_DEV_HOOKS: '1' });
    start('npx vite --port 3101 --strictPort', { PIRATES_BR_SERVER_PORT: '8091' });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE_URL}/`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  browser = await chromium.launch({ args: browserArgs() });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.addInitScript(() => { try { localStorage.setItem('piratesBR.seenControls', '1'); } catch { /* private */ } });
  await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => {
    const g = window.__piratesBR;
    return !!(g?.hud && g.getLocalPlayer?.() && g.state?.ships?.length && g.state.players?.length > 2);
  }, null, { timeout: 120_000 });
  expect('a Solo match with other crews is live', true);

  // OUT OF THE VOYAGE, FOR REAL. After the horn, scuttle our own sloop through
  // the server's solo-only dev_scuttle hook: the hull founders and we go down
  // with her via startShipSinking + handlePlayerDeath, so the elimination,
  // the game_over{died} and the death card are the ones a real sinking sends.
  await page.waitForFunction(() => {
    const g = window.__piratesBR;
    const me = g.getLocalPlayer?.();
    return g.state?.phase === 'playing' && !!me?.shipId && me.state !== 'respawning';
  }, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  // ALIVE HALF (b1.5f-verify): the HUD model's ship card and the low-HP grey,
  // measured on the real HudController / CombatFx in the live frame loop.
  // There is no teleport hook, so the pirate the HUD model is FED each frame is
  // rewritten (position ashore > 30 m, or standing on an enemy deck); the
  // class it paints on #ship-status is the side effect graded.
  const shipCardOff = (mode) => page.evaluate(async (m) => {
    const g = window.__piratesBR;
    const hud = g.hud;
    const orig = hud.applyHudVisibility;
    const me0 = g.getLocalPlayer();
    const own = g.shipsById.get(me0.shipId);
    const enemy = [...g.shipsById.values()].find((s) => s.id !== me0.shipId && s.alive !== false);
    let calls = 0;
    if (m !== 'real') {
      hud.applyHudVisibility = function (player, extra) {
        calls++;
        const p = m === 'aboard'
          ? { ...player, onShipId: own.id, state: 'alive', position: { ...own.position } }
          : m === 'near'
            ? { ...player, onShipId: null, state: 'alive', position: { ...player.position, x: own.position.x + 20, z: own.position.z } }
            : m === 'ashore'
              ? { ...player, onShipId: null, state: 'alive', position: { ...player.position, x: own.position.x + 45, z: own.position.z } }
              : { ...player, onShipId: enemy?.id ?? 'no-enemy', state: 'alive', position: { ...(enemy?.position ?? player.position) } };
        return orig.call(this, p, extra);
      };
    }
    try {
      // The HUD paints on a game-dt timer; SwiftShader runs a few fps, so wait
      // for three painted frames under the rewrite rather than a fixed time.
      const t0 = performance.now();
      while (performance.now() - t0 < 20_000 && calls < 3) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const el = document.getElementById('ship-status');
      return {
        calls,
        off: el.classList.contains('hud-model-off'),
        display: getComputedStyle(el).display,
        onShipId: me0.onShipId ?? null,
        shipId: me0.shipId,
        enemy: enemy?.id ?? null,
      };
    } finally {
      if (m !== 'real') delete hud.applyHudVisibility;
    }
  }, mode);
  const aboard = await shipCardOff('aboard');
  expect('ship card shows aboard the own hull (no hud-model-off)', aboard.calls >= 2 && !aboard.off && aboard.display !== 'none', JSON.stringify(aboard));
  const near = await shipCardOff('near');
  expect('ship card shows ashore 20 m from the own hull', near.calls >= 2 && !near.off && near.display !== 'none', JSON.stringify(near));
  const ashore = await shipCardOff('ashore');
  expect('ship card hidden ashore 45 m from the own hull (hud-model-off)', ashore.calls >= 2 && ashore.off && ashore.display === 'none', JSON.stringify(ashore));
  const boarding = await shipCardOff('enemy');
  expect('ship card hidden on an enemy deck (hud-model-off)', boarding.calls >= 2 && !!boarding.enemy && boarding.off && boarding.display === 'none', JSON.stringify(boarding));
  const back = await shipCardOff('aboard');
  expect('ship card returns once back aboard', back.calls >= 2 && !back.off, JSON.stringify(back));

  const desat = (hp, waitMs) => page.evaluate(async ([h, w]) => {
    const fx = window.__piratesBR.combatFx;
    const orig = fx.watchLocalVitals;
    if (h !== null) {
      fx.watchLocalVitals = function (player, ...rest) {
        return orig.call(this, player ? { ...player, health: h } : player, ...rest);
      };
    }
    try {
      // Eased on game dt (~0.2 s time constant): poll up to the budget for the
      // target band instead of one fixed sleep at a few SwiftShader fps.
      const t0 = performance.now();
      const done = () => {
        const o = Number(document.getElementById('low-hp-desaturate')?.style.opacity || 0);
        return h !== null && h < 15 ? o > 0.3 : o < 0.02;
      };
      while (performance.now() - t0 < w && !done()) await new Promise((r) => setTimeout(r, 100));
      const el = document.getElementById('low-hp-desaturate');
      if (!el) return { present: false, opacity: 0, blend: '' };
      const cs = getComputedStyle(el);
      return { present: true, opacity: Number(cs.opacity), blend: cs.mixBlendMode, display: cs.display };
    } finally {
      if (h !== null) delete fx.watchLocalVitals;
    }
  }, [hp, waitMs]);
  const low = await desat(8, 12_000);
  expect('health 8 greys the world (#low-hp-desaturate opacity > 0.3, mix-blend-mode saturation)',
    low.present && low.opacity > 0.3 && low.blend === 'saturation', JSON.stringify(low));
  const healed = await desat(100, 12_000);
  expect('full health fades the grey back to ~0', healed.present && healed.opacity < 0.02, JSON.stringify(healed));

  await page.evaluate(() => {
    window.__piratesBR.network.send({ type: 'dev_scuttle', ts: Date.now(), payload: {} });
  });
  const out = await page.waitForFunction(() => window.__piratesBR.getLocalPlayer?.()?.state === 'eliminated', null, { timeout: 20_000 })
    .then(() => true, () => false);
  expect('scuttling our own sloop in Solo puts us out (server state eliminated)', out,
    out ? '' : 'is PIRATES_BR_DEV_HOOKS=1 set on the server?');
  // Graded on the GAME clock: the handoff eases on frame dt, and under
  // SwiftShader on a loaded Air a wall second can be a fraction of a game
  // second. A player at real frame rates gets the same 8 s.
  const t0 = Date.now();
  const g0 = await page.evaluate(() => window.__piratesBR.ocean.getTime());
  const bannerUp = await page.waitForFunction(() => {
    const b = document.getElementById('spectate-banner');
    return !!b && getComputedStyle(b).display !== 'none' && /watching/i.test(b.textContent ?? '');
  }, null, { timeout: 45_000, polling: 100 }).then(() => true, () => false);
  const tBanner = Date.now() - t0;
  const gBanner = (await page.evaluate(() => window.__piratesBR.ocean.getTime())) - g0;
  expect('spectate banner names a subject within 8 s of game time', bannerUp && gBanner <= 8,
    `${gBanner.toFixed(1)} game s, ${(tBanner / 1000).toFixed(1)} wall s`);
  await page.waitForTimeout(2500); // let the spectate camera lift off the corpse

  const layout = await page.evaluate(() => {
    const panel = document.getElementById('death-panel')?.getBoundingClientRect();
    const next = document.getElementById('death-next-btn');
    return {
      spectating: document.body.classList.contains('spectating'),
      panelTop: panel ? panel.top : -1,
      panelBottom: panel ? panel.bottom : -1,
      vh: innerHeight,
      nextVisible: !!next && getComputedStyle(next).display !== 'none',
      subject: document.getElementById('spectate-line')?.textContent ?? '',
    };
  });
  expect('body is in the spectating state', layout.spectating);
  expect('death card is a bottom bar (panel top in the lower 45 %)', layout.panelTop >= layout.vh * 0.55, JSON.stringify(layout));
  expect('NEXT SHIP button shows on the bar', layout.nextVisible);

  const png = readPng(await page.screenshot({ type: 'png' }));
  let dark = 0; let n = 0;
  for (let y = 0; y < png.height * 0.55; y += 6) {
    for (let x = 0; x < png.width; x += 6) {
      const i = (y * png.width + x) * png.channels;
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (lum < 12) dark++;
      n++;
    }
  }
  const darkPct = (100 * dark) / n;
  expect('the world behind the bar is not >95 % black', darkPct <= 95, `${darkPct.toFixed(1)} % near-black`);
  await page.screenshot({ path: '/tmp/pbr-b15f-spectate.png' });

  const before = await page.evaluate(() => window.__piratesBR.spectateSubjectId);
  await page.keyboard.press('KeyN');
  const after = await page.waitForFunction((b) => {
    const id = window.__piratesBR.spectateSubjectId;
    const line = document.getElementById('spectate-line')?.textContent ?? '';
    return id && id !== b && /watching/i.test(line) ? line : null;
  }, before, { timeout: 30_000, polling: 150 }).then((h) => h.jsonValue(), () => null);
  expect('N moves the camera to the next subject and names it', !!after, `"${after}"`);

  // Every "next" key: interact and jump through the live bindings table
  // (KeyX, Space by default), plus the fixed right arrow. E is not bound to
  // interact any more, so it must NOT cycle.
  const subjectNow = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const id = g.spectateSubjectId ?? null;
    const p = id ? g.state.players.find((c) => c.id === id) : null;
    return { id, crew: p?.shipId ?? null, line: document.getElementById('spectate-line')?.textContent ?? '' };
  });
  const waitNewCrew = async (b, ms) => {
    const t0 = Date.now();
    let a = await subjectNow();
    // The key moves the id at once (keydown, between frames); the line follows
    // on the next HUD repaint. Wait for both, so a label that stays on the old
    // crew is caught instead of read one frame early.
    while (Date.now() - t0 < ms && (a.id === b.id || a.crew === b.crew || a.line === b.line)) {
      await page.waitForTimeout(150);
      a = await subjectNow();
    }
    return a;
  };
  for (const key of ['ArrowRight', 'Space', 'KeyX']) {
    const b = await subjectNow();
    await page.keyboard.press(key);
    const a = await waitNewCrew(b, 8000);
    expect(`${key} moves the camera to another crew`, a.id !== b.id && a.crew !== b.crew, `${b.crew?.slice(0, 8)} -> ${a.crew?.slice(0, 8)} "${a.line}"`);
    expect(`${key}: the watching line names the new crew`, a.line !== b.line && /watching/i.test(a.line), `"${b.line}" -> "${a.line}"`);
  }
  {
    const b = await subjectNow();
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1500);
    const a = await subjectNow();
    expect('KeyE (not bound to interact or jump) leaves the subject alone', a.id === b.id, `${b.id?.slice(0, 8)} -> ${a.id?.slice(0, 8)}`);
    // A chosen subject is held: the nearest-crew re-pick (every 6 game s) must
    // not take the camera back while nobody presses a key.
    const g1 = await page.evaluate(() => window.__piratesBR.ocean.getTime());
    let held = await subjectNow();
    while ((await page.evaluate(() => window.__piratesBR.ocean.getTime())) - g1 < 8) {
      await page.waitForTimeout(500);
      held = await subjectNow();
      if (held.id !== a.id) break;
    }
    const alive = await page.evaluate((id) => window.__piratesBR.state.players.find((c) => c.id === id)?.state ?? 'gone', a.id);
    expect('a chosen subject holds for 8 game s with no key pressed', held.id === a.id || alive === 'eliminated' || alive === 'gone',
      `${a.id?.slice(0, 8)} -> ${held.id?.slice(0, 8)} (${alive})`);
  }
} catch (err) {
  expect('run completed', false, String(err?.message ?? err).split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  killAll();
}
console.log(fails ? `\n${fails} failure(s)` : '\nelimination -> spectate holds');
process.exit(fails ? 1 : 0);
