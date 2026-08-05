// FIX-WAVE-4 CROSS-FEATURE SMOKE — does the design wave COHERE?
//
// Seven agents landed seven features into one tree. Each proved its own lane.
// This proves they are one game: that the gold you bank weighs the hull the
// renderer draws, that the bounty the server raises is the sting the score
// plays and the ring the chart paints, that the wreck the sim raises is the
// beacon the client hangs, that the scenes speak when you walk into them, and
// that no surface anywhere still wears another game's proper nouns.
//
// Needs the dev stack (vite :3000, server :8090). Stage 3 boots its own
// server on a FREE port with the wreck forced early — she otherwise rises at ring 0,
// minutes into a match, which is not a smoke test.
//
//   node scripts/fixwave4-smoke.mjs [outDir]
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// EVERY BROWSER SUITE HERE READS PIRATES_BR_URL. A graded run points it at a
// Vite the runner owns rather than at the developer's :3000, and a suite that
// hard-codes the port sends itself somewhere else — which reads as
// ERR_CONNECTION_REFUSED half a second in, an exit code indistinguishable from
// a real failure.
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const OUT = process.argv[2] ?? 'test-results/fixwave4-smoke';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};

// Another game's vocabulary. If any of these survive on a surface a player
// SEES, the rename wave did not land. Kept as word-boundary patterns so
// "sloop" (a real ship type, and a wire id) never trips it.
const FOREIGN_NOUNS = [
  /\bsea of thieves\b/i, /\bathena'?s fortune\b/i, /\bgold hoarders?\b/i,
  /\border of souls\b/i, /\bmerchant alliance\b/i, /\breaper'?s bones\b/i,
  /\btall tales?\b/i, /\bmegalodon\b/i, /\bashen\b/i, /\bpirate legend\b/i,
  /\beye of reach\b/i, /\bgrog\b/i, /\bferry of the damned\b/i,
];
const scanForeign = (text) => FOREIGN_NOUNS
  .filter((re) => re.test(text)).map((re) => String(re));

const browser = await chromium.launch({
  args: browserArgs(['--ignore-gpu-blocklist']),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push(String(err)));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60_000 });
/**
 * WAIT IN THE GAME'S SECONDS, NOT THE WALL'S.
 *
 * Twenty-two `wait(ms)` calls in this file sit between "change something" and
 * "read what the HUD says about it", and every one of them was a wall-clock
 * sleep. The HUD is repainted by the frame loop, and `Game.frame` clamps its
 * clock to 50ms per frame — so on this fanless Air's software rasteriser, where
 * the scene draws at well under a frame a second, `wait(2200)` buys the game
 * about a tenth of the game-time it buys a player at 60fps.
 *
 * The result was eight red assertions that were all the same defect, each one
 * reading the state BEFORE the change it was about:
 *
 *     ✗ banked gold past the safe line becomes a WEIGHED hold  (cargo=3400g "")
 *     ✗ the bounty SIGN is on the HUD  (HOLD: DEEP-LADEN · 3400g · −6% knots)
 *
 * The second line is the tell — the sign it says is missing is printed right
 * there in the failure detail, one read late. Nothing was wrong with the hold,
 * the ballast or the bounty.
 *
 * So `waitFrames` blocks until the CLIENT has integrated that many milliseconds
 * of its own frame time. On a 60fps host it is the sleep it always was. Bounded
 * by a wall-clock cap so a genuinely stopped client fails the assertion instead
 * of hanging the suite, and by a stopped-clock check so waits taken before the
 * game loop exists (the menu) fall straight back to a plain sleep.
 *
 * IT IS OPT-IN, and the reason is that this game keeps time two ways. A feed
 * toast expires on a 3s WALL timer and a story vignette advances its stages on
 * one too, so waiting in game seconds sails straight past both: applied to every
 * sleep in the file it fixed six assertions and broke two, reading an expired
 * bounty cry and a vignette two beats on. So `waitFrames` is used where the thing
 * being waited for is painted by the frame loop — the hold, the ballast, the
 * crates — and plain `wait` stays everywhere else.
 */
const WAIT_WALL_CAP = (ms) => Math.min(30_000, Math.max(2_000, ms * 15));
const wait = (ms) => page.waitForTimeout(ms);
const waitFrames = async (ms) => {
  try {
    await page.evaluate(async ({ ms, capMs }) => {
      const clock = () => window.__piratesBR?.combatFx?.fxClock;
      const nap = (n) => new Promise((r) => setTimeout(r, n));
      const t0 = clock();
      if (typeof t0 !== 'number') { await nap(ms); return; }
      const wallStart = performance.now();
      for (;;) {
        const now = clock();
        if ((now - t0) * 1000 >= ms) return;
        const wall = performance.now() - wallStart;
        if (wall >= capMs) return;
        // Nothing has rendered in four wall seconds: the loop is not running, so
        // waiting on its clock is waiting on nothing. Serve the sleep and go.
        if (wall > 4_000 && now === t0) { await nap(Math.max(0, ms - wall)); return; }
        await nap(Math.min(120, Math.max(20, ms / 6)));
      }
    }, { ms, capMs: WAIT_WALL_CAP(ms) });
  } catch {
    // Navigating, or no handle yet — the wall clock is all there is.
    await page.waitForTimeout(ms);
  }
};

/** The first-voyage SHIP'S ORDERS card owns the middle of the screen and does
 *  not appear until the start ceremony ends — so a single blind [L] on join
 *  can close nothing and then be covered a second later. Poll it shut. */
async function dismissOrders() {
  for (let i = 0; i < 6; i++) {
    const open = await page.evaluate(() => {
      const el = document.getElementById('controls-hint');
      return !!el && getComputedStyle(el).display !== 'none' && el.offsetHeight > 0;
    });
    if (!open) return true;
    await page.keyboard.press('KeyL');
    await wait(500);
  }
  return false;
}

// Other agents editing this tree make vite full-reload the page mid-probe.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

// ══ 1. THE MENU — it names its own world, teaches itself, and sings ════════
console.log('\n1. MENU');
await page.goto(`${BASE_URL}/?debug&forceinput`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await wait(900);
await shot('01-menu');

const menu = await page.evaluate(() => {
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
  const howTo = document.getElementById('menu-panel-howto');
  return {
    bodyText: document.body.innerText,
    subtitle: txt('#menu-subtitle') || txt('.menu-subtitle') || txt('#menu-tagline'),
    howToText: howTo?.textContent?.trim() ?? '',
    howToWin: document.getElementById('howto-win')?.textContent?.trim() ?? '',
    howToControls: document.getElementById('howto-controls')?.textContent?.trim() ?? '',
    audioCtxExists: !!window.__piratesBR?.audio?.ctx,
  };
});
check('the menu subtitle names the Shattered Reach',
  /shattered reach/i.test(menu.subtitle) || /shattered reach/i.test(menu.bodyText),
  menu.subtitle.slice(0, 90));
check('HOW TO PLAY is intact on the menu, and states both win conditions',
  menu.howToText.length > 60 && /9,?000 gold/.test(menu.howToWin)
  && /last crew afloat/i.test(menu.howToWin) && menu.howToControls.length > 20,
  `${menu.howToWin.replace(/\s+/g, ' ').slice(0, 90)}…`);
check('no AudioContext before a gesture (no autoplay warning)', menu.audioCtxExists === false);

// A real gesture — the same body pointerdown a player makes.
await page.mouse.click(24, 24);
await wait(1600);
const menuAudio = await page.evaluate(() => {
  const e = window.__piratesBR?.audio;
  return {
    state: e?.ctx?.state ?? null,
    music: e?.getMusicContext?.() ?? null,
    loops: e?.menuLoopIndex ?? 0,
    timer: e?.musicTimer !== null && e?.musicTimer !== undefined,
  };
});
check('the menu theme starts on the FIRST gesture',
  menuAudio.state === 'running' && menuAudio.music === 'menu'
  && menuAudio.timer && menuAudio.loops >= 1,
  JSON.stringify(menuAudio));

const menuForeign = scanForeign(menu.bodyText);
check('no foreign proper nouns anywhere on the menu', menuForeign.length === 0, menuForeign.join(', '));

// ══ 2. JOIN ════════════════════════════════════════════════════════════════
console.log('\n2. THE HOLD, THE BALLAST, THE BOUNTY, THE STING');
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
await wait(2500);
await page.evaluate(() => {
  window.__piratesBR.setDayNightOverride(854);   // noon
  window.__piratesBR.setBotPeace(true);
});
await dismissOrders();                          // SHIP'S ORDERS owns the centre
await wait(600);

// Record every sting the score is asked to play, so "the bounty sting fires"
// is a fact about the audio engine and not about my ears.
await page.evaluate(() => {
  const e = window.__piratesBR.audio;
  window.__stings = [];
  const original = e.playEventSting.bind(e);
  e.playEventSting = (kind) => { window.__stings.push(kind ?? 'bounty'); return original(kind); };
});

const holdState = () => page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  // The hold stack: one 'hold-cargo' group per hull whose tier children are
  // cumulative variants, exactly one of which may ever be visible.
  let visibleTiers = 0;
  let cargoMeshes = 0;
  g.renderer?.scene?.traverse?.((o) => {
    if (o.name !== 'hold-cargo') return;
    for (const tier of o.children) { cargoMeshes += 1; if (tier.visible) visibleTiers += 1; }
  });
  return {
    gold: me?.gold ?? 0,
    cargoGold: ship?.cargoGold ?? 0,
    bountied: !!ship?.bountied,
    speed: ship ? Math.hypot(ship.velocity?.x ?? 0, ship.velocity?.z ?? 0) : 0,
    holdText: document.getElementById('hold-cargo')?.textContent?.trim() ?? '',
    visibleTiers,
    cargoMeshes,
    stings: window.__stings ?? [],
    feed: [...document.querySelectorAll('#kill-feed div')].map((n) => n.textContent).join(' | '),
  };
});

const before = await holdState();
check('an empty hold shows no cargo readout and no crates',
  before.holdText === '' && before.visibleTiers === 0,
  `hold="${before.holdText}" visibleTiers=${before.visibleTiers}`);

// Past the safe line, into a laden hold. (grantGold SETS the purse, it does
// not add to it — every figure below is an absolute.)
await page.evaluate(() => window.__piratesBR.grantGold(4900));
await waitFrames(2200);
const laden = await holdState();
// Frame the crates themselves: a wide deck shot proves nothing about whether
// anything is actually stacked below.
const framed = await page.evaluate(() => {
  const g = window.__piratesBR;
  const me = g.state.players.find((p) => p.id === g.localPlayerId);
  const ship = g.state.ships.find((s) => s.id === me?.shipId);
  if (!ship) return null;
  let target = null;
  g.renderer.scene.traverse((o) => {
    if (target || o.name !== 'hold-cargo') return;
    for (const tier of o.children) {
      if (!tier.visible || !tier.children.length) continue;
      const mesh = tier.children[0];
      mesh.updateWorldMatrix(true, false);
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      const V = mesh.position.constructor;
      target = new V((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
        .applyMatrix4(mesh.matrixWorld);
      break;
    }
  });
  if (!target) return null;
  const camX = target.x + Math.sin(ship.rotation) * 3.4;
  const camY = target.y + 0.8;
  const camZ = target.z + Math.cos(ship.rotation) * 3.4;
  const dx = target.x - camX, dy = target.y - camY, dz = target.z - camZ;
  g.enableFreeCam(camX, camY, camZ, Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  return { x: +target.x.toFixed(1), y: +target.y.toFixed(2), z: +target.z.toFixed(1) };
});
await wait(900);
await shot('02-hold-laden');
check('the cargo stack stands at a real place in the world (crates framed below decks)',
  !!framed, JSON.stringify(framed));
await page.evaluate(() => window.__piratesBR.disableFreeCam());
await wait(400);
check('banked gold past the safe line becomes a WEIGHED hold',
  laden.cargoGold > 0 && /HOLD:/i.test(laden.holdText),
  `cargo=${laden.cargoGold}g  "${laden.holdText}"`);
check('exactly one cargo tier is drawn in the hold', laden.visibleTiers === 1,
  `visible=${laden.visibleTiers} of ${laden.cargoMeshes} tier meshes`);
check('the HUD names what the hold costs in knots', /[−-]\s*\d+%/.test(laden.holdText),
  laden.holdText);

// Past the bounty line (60% of the 9,000 target = 5,400).
//
// TWO READS, ON THE TWO CLOCKS THIS MOMENT KEEPS. The cry in the feed is a toast
// on a 3s WALL timer and the sign on the HUD is painted by the frame loop, so no
// single wait can catch both on a host this slow: a wall wait long enough for the
// sign lets the toast expire, and a frame wait long enough for the sign takes far
// longer in wall time and lets it expire twice over. So the feed is read first,
// early, and the hold is read after the frames have actually arrived.
await page.evaluate(() => window.__piratesBR.grantGold(8600));
await wait(1200);
const cried = await holdState();
await waitFrames(2500);
const hunted = await holdState();
await shot('03-hold-wallowing');
check('crossing 60% of the target raises a BOUNTY on the crew', hunted.bountied,
  `gold=${hunted.gold} cargo=${hunted.cargoGold}`);
check('the bounty SIGN is on the HUD', /HUNTED/i.test(hunted.holdText), hunted.holdText);
check('the bounty is CRIED in the feed', /bounty/i.test(cried.feed) || /bounty/i.test(hunted.feed),
  ((cried.feed + '|' + hunted.feed).match(/[^|]*bounty[^|]*/i) ?? [''])[0].trim().slice(0, 90));
check('the bounty STING plays (score ↔ gold wire)',
  hunted.stings.includes('bounty'), `stings=[${hunted.stings.join(', ')}]`);

// The chart: an amber ring around a hunted hull.
await page.keyboard.press('KeyM');
await wait(1400);
await shot('04-chart-bounty');
const chart = await page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')]
    .filter((c) => c.width > 200 && getComputedStyle(c).display !== 'none')
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!cv) return { amber: 0, text: document.body.innerText };
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let amber = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (r > 190 && g > 120 && g < 200 && b < 110) amber += 1;
  }
  return { amber, text: document.body.innerText };
});
check('the chart paints the bounty in amber', chart.amber > 200, `${chart.amber} amber px`);
const chartForeign = scanForeign(chart.text);
check('no foreign proper nouns on the chart screen', chartForeign.length === 0, chartForeign.join(', '));
await page.keyboard.press('KeyM');
await wait(700);

// BALLAST. The physics of it is measured properly in test-gold-cargo.mjs §2,
// which sails two identical hulls through the REAL PhysicsSystem tick by tick
// on the same wind and reads the peaks. What a live probe can add — and what
// no logic suite can — is that the penalty the server computed actually
// reaches the pirate's eyes, and that it GROWS with the hold. (A live chase
// would need the probe at the wheel with the capstan walked and sails set;
// that is the station rig, not a smoke test.)
console.log('\n   ballast, as the pirate is told it:');
const penaltyOf = (text) => {
  const m = text.match(/[−-]\s*(\d+)\s*%/);
  return m ? Number(m[1]) : null;
};
const ladenPenalty = penaltyOf(laden.holdText);
const huntedPenalty = penaltyOf(hunted.holdText);
console.log(`     ${laden.cargoGold}g → −${ladenPenalty}%   ${hunted.cargoGold}g → −${huntedPenalty}%`);
check('the ballast the server computes reaches the HUD, and grows with the hold',
  ladenPenalty !== null && huntedPenalty !== null && huntedPenalty > ladenPenalty,
  `${laden.cargoGold}g −${ladenPenalty}%  <  ${hunted.cargoGold}g −${huntedPenalty}%`);

// And emptying her lifts both the weight and the price on her head.
await page.evaluate(() => window.__piratesBR.grantGold(0));
await waitFrames(2500);
const cleared = await holdState();
check('emptying the hold clears the bounty and the crates',
  !cleared.bountied && cleared.visibleTiers === 0,
  `bountied=${cleared.bountied} tiers=${cleared.visibleTiers}`);

// ══ 3. STORY SCENES SPEAK ══════════════════════════════════════════════════
console.log('\n3. THE REACH SPEAKS (story vignettes)');
// Discovery is a CLIENT feature: Game.ts scans the local player against the
// scene footprints every frame and speaks the beat. So stand him in the scene
// — and keep standing him there, because the authoritative snapshot puts him
// back on his real feet every 100 ms and a one-shot write is gone before the
// scan runs (measured: reverted inside 250 ms).
// Keep a durable copy of feed calls as well. The visual toast correctly expires
// after three wall-clock seconds, but a single SwiftShader frame can take longer
// than that while the scene is first revealed. Grading only the live DOM would
// therefore confuse "the toast has expired" with "the story never spoke".
await page.evaluate(() => {
  const g = window.__piratesBR;
  window.__storyFeedHistory = [];
  const pushFeed = g?.hud?.pushFeed;
  if (typeof pushFeed !== 'function') return;
  g.hud.pushFeed = function (...args) {
    window.__storyFeedHistory.push(args.map((value) => String(value)).join(' '));
    return pushFeed.apply(this, args);
  };
});
const KNOWN_SCENES = ['smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton',
  'rum_still', 'crow_roost', 'mermaid_shrine', 'castaway_camp', 'kraken_wreck',
  'dig_site', 'gallows', 'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage'];
for (const nth of [0, 1]) {
  const walked = await page.evaluate(({ KNOWN, n }) => {
    const g = window.__piratesBR;
    // Each assertion must be backed by a feed call made during this walk, not
    // by the still-retained line from the previous scene.
    window.__storyFeedHistory = [];
    const scenes = [];
    for (const isl of g.state.islands ?? []) {
      for (const p of isl.props ?? []) if (KNOWN.includes(p.type)) scenes.push({ isl, p });
    }
    const target = scenes[n];
    if (!target) return null;
    const at = {
      x: target.p.x,
      y: (g.sampleGroundY?.(target.p.x, target.p.z) ?? 0) + 1.2,
      z: target.p.z,
    };
    window.__unpin?.();
    let stop = false;
    const pin = () => {
      const me = g.state.players.find((x) => x.id === g.localPlayerId);
      if (me) {
        me.onShipId = null; me.state = 'alive';
        me.position.x = at.x; me.position.y = at.y; me.position.z = at.z;
      }
      if (!stop) requestAnimationFrame(pin);
    };
    pin();
    window.__unpin = () => { stop = true; };
    return { type: target.p.type, island: target.isl.name };
  }, { KNOWN: KNOWN_SCENES, n: nth });
  if (!walked) { check(`story scene ${nth + 1} found`, false, 'no scene props in reach'); continue; }

  // Wait for the exact scene's durable discovery marker. Counting the set is
  // insufficient when a previous scene was already discovered on the way in.
  await page.waitForFunction((type) => {
    const seen = window.__piratesBR?.seenVignettes;
    return !!seen && [...seen].some((key) => key.endsWith(`:${type}`));
  }, walked.type, { timeout: 45_000 }).catch(() => {});

  // Catch the scene's own banner before landfall for the same island paints
  // over it, then keep the durable proof: the discovery log line.
  let bannerText = '';
  for (let i = 0; i < 16 && !bannerText; i++) {
    await wait(120);
    bannerText = await page.evaluate(() => {
      const el = document.getElementById('island-banner');
      if (!el || !el.classList.contains('visible')) return '';
      const t = el.innerText || '';
      return /land discovered/i.test(t) ? '' : t.replace(/\n/g, ' · ').trim();
    });
  }
  if (bannerText) await shot(`05-vignette-${nth + 1}`);
  const told = await page.evaluate(() => {
    const g = window.__piratesBR;
    return {
      seen: g.seenVignettes ? [...g.seenVignettes] : [],
      log: [...(window.__storyFeedHistory ?? []),
        ...[...document.querySelectorAll('#kill-feed div')].map((n) => n.textContent)]
        .filter((t) => /Discovered:/i.test(t)),
    };
  });
  await page.evaluate(() => window.__unpin?.());
  const spoke = told.log.some((l) => !/land discovered/i.test(l));
  const sawTarget = told.seen.some((key) => key.endsWith(`:${walked.type}`));
  check(`walking into "${walked.type}" makes the scene SPEAK its name and its beat`,
    spoke && sawTarget,
    `${bannerText || told.log[0] || 'nothing'}`);
}

// ══ 4. THE BROKER HAS THE REACH'S OWN NAME ═════════════════════════════════
console.log('\n4. THE BROKER');
const broker = await page.evaluate(() => {
  const g = window.__piratesBR;
  const names = [];
  let him = null;
  for (const isl of g.state.islands ?? []) {
    for (const n of isl.npcs ?? []) {
      names.push(n.name ?? n.role ?? '?');
      if (!him && n.role === 'gold_hoarder') him = { ...n, island: isl.name };
    }
  }
  if (him) {
    // Stand off his shoulder and look him in the face.
    const gy = g.sampleGroundY?.(him.position.x, him.position.z) ?? 0;
    const d = 3.4;
    const cx = him.position.x + Math.sin(him.rotation + Math.PI) * d;
    const cz = him.position.z + Math.cos(him.rotation + Math.PI) * d;
    const dx = him.position.x - cx, dz = him.position.z - cz;
    g.enableFreeCam(cx, gy + 1.8, cz, Math.atan2(dx, dz), -0.06);
  }
  return {
    npcNames: names,
    him: him && { name: him.name, role: him.role, title: him.cutsceneTitle, island: him.island },
    bodyText: document.body.innerText,
  };
});
await wait(1400);
if (broker.him) await shot('06-the-tallyman');
await page.evaluate(() => window.__piratesBR.disableFreeCam?.());
check('the broker ashore is the Tallyman, and keeps his gold_hoarder WIRE id',
  !!broker.him && /tallyman/i.test(broker.him.name) && broker.him.role === 'gold_hoarder',
  broker.him ? `${broker.him.name} — "${broker.him.title}" on ${broker.him.island}` : 'no broker found');
const castForeign = scanForeign(broker.npcNames.join(' | '));
check('no NPC on the roster wears a borrowed noun', castForeign.length === 0,
  castForeign.length ? castForeign.join(', ') : broker.npcNames.slice(0, 5).join(', '));

// ══ 5. NO FOREIGN NOUNS ON ANY LIVE SURFACE ════════════════════════════════
console.log('\n5. VOCABULARY');
await shot("07-hud-in-play");
const surfaces = await page.evaluate(() => ({
  hud: document.body.innerText,
  html: document.body.innerHTML,
}));
const hudForeign = scanForeign(surfaces.hud);
check('no foreign proper nouns on the in-play HUD', hudForeign.length === 0, hudForeign.join(', '));
const markupForeign = scanForeign(surfaces.html);
check('none hiding in the markup either (titles, alt text, tooltips)',
  markupForeign.length === 0, markupForeign.join(', '));

// ══ 6. THE GILDED WRECK — her own server, with the event forced early ══════
console.log('\n6. THE GILDED WRECK');
let wreckServer = null;
try {
  // A FREE PORT, NOT A FAVOURITE ONE. This stage used to hard-code :8091, and
  // :8091 is exactly where the graded runner now stands its own server up. The
  // spawn lost the bind, the health poll got a cheerful 200 from the OTHER
  // server, and the stage went on to wait 120 seconds for a wreck that rises at
  // ring 0 on a server nobody told to hurry. It failed as "the gilded wreck
  // stage did not run", which is true and says nothing about the wreck.
  //
  // So: ask the OS for a port that is free right now, and then refuse to believe
  // any server that answers on it before ours has been started.
  const wreckPort = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  if (await fetch(`http://127.0.0.1:${wreckPort}/health`).then(() => true).catch(() => false)) {
    throw new Error(`something is already listening on ${wreckPort} — refusing to grade a server this stage did not start`);
  }
  wreckServer = spawn('npx', ['tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(wreckPort), PIRATES_WRECK_SEC: '15' },
    stdio: 'ignore',
    detached: false,
  });
  // Wait for her to answer.
  let wreckUp = false;
  for (let i = 0; i < 60 && !wreckUp; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${wreckPort}/health`);
      wreckUp = r.ok;
    } catch { /* not up yet */ }
    if (!wreckUp) await wait(1000);
  }
  if (!wreckUp) throw new Error(`the wreck server never answered on ${wreckPort}`);
  console.log(`  (wreck server on :${wreckPort}, wreck forced at 15s)`);
  await page.goto(`${BASE_URL}/?debug&forceinput&server=${wreckPort}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
  // Install this before joining: on a cold SwiftShader load the three-second
  // visual toast may expire while the first world is still being constructed.
  await page.evaluate(() => {
    const g = window.__piratesBR;
    window.__wreckFeedHistory = [];
    const pushFeed = g?.hud?.pushFeed;
    if (typeof pushFeed !== 'function') return;
    g.hud.pushFeed = function (...args) {
      window.__wreckFeedHistory.push(args.map((value) => String(value)).join(' '));
      return pushFeed.apply(this, args);
    };

    // This stage grades the wreck and its cargo, not the bot plunder race. Keep
    // the real SOLO button path (name submission, menu transition, network
    // message), but ask the server for the supported zero-bot solo variant so
    // nine autonomous crews cannot remove every chest during cold world-build.
    const soloStart = g.network.soloStart.bind(g.network);
    g.network.soloStart = () => soloStart(0);
  });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await wait(1500);
  await page.evaluate(() => {
    window.__piratesBR.setDayNightOverride(854);
    window.__piratesBR.setBotPeace(true);
  });
  await dismissOrders();
  await page.waitForFunction(() => !!window.__piratesBR?.state?.wreck, null, { timeout: 120_000 });
  // The wreck announcement and its static-world loot travel on separate server
  // messages. Wait until every announced chest has reached an island snapshot
  // before grading the cargo rather than sampling the valid interval between
  // those messages.
  await page.waitForFunction(() => {
    const state = window.__piratesBR?.state;
    const ids = state?.wreck?.chestIds;
    if (!ids?.length) return false;
    const present = new Set((state.islands ?? []).flatMap((island) =>
      (island.chests ?? []).map((chest) => chest.id)));
    return ids.every((id) => present.has(id));
  }, null, { timeout: 45_000 }).catch(() => {});
  // She may rise while the card is still being read on a fresh join.
  await dismissOrders();
  const wreck = await page.evaluate(() => {
    const g = window.__piratesBR;
    const w = g.state.wreck;
    const storm = g.state.storm;
    return {
      x: w.position.x, z: w.position.z,
      chests: w.chestIds.length, barrels: w.barrelIds.length,
      offRingCentre: Math.hypot(w.position.x - storm.nextCenterX, w.position.z - storm.nextCenterZ),
      feed: [...(window.__wreckFeedHistory ?? []),
        ...[...document.querySelectorAll('#kill-feed div')].map((n) => n.textContent)].join(' | '),
    };
  });
  check('she rises, and she rises at the announced next ring centre',
    wreck.offRingCentre < 400, `${wreck.offRingCentre.toFixed(0)}m off centre`);
  check('she carries loot worth the sail',
    wreck.chests > 0 && wreck.barrels > 0, `${wreck.chests} chests, ${wreck.barrels} barrels`);
  check('the sea cries her in the feed', /wreck|gilded|galleon/i.test(wreck.feed),
    (wreck.feed.match(/[^|]*(wreck|gilded|galleon)[^|]*/i) ?? [''])[0].trim().slice(0, 90));

  // Frame her from the water so the screenshot is of a SHIP, not of an ocean.
  await page.evaluate(([x, z]) => {
    const g = window.__piratesBR;
    g.enableFreeCam(x + 60, 14, z + 60, Math.atan2(-60, -60), -0.16);
  }, [wreck.x, wreck.z]);
  await wait(1800);
  await shot('07-gilded-wreck');

  // The chart must hang a beacon on her.
  await page.evaluate(() => window.__piratesBR.disableFreeCam?.());
  await wait(400);
  await page.keyboard.press('KeyM');
  await wait(1500);
  await shot('08-wreck-on-chart');
  const beacon = await page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')]
      .filter((c) => c.width > 200 && getComputedStyle(c).display !== 'none')
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (!cv) return { gold: 0 };
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let gold = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 130) gold += 1;
    }
    return { gold, text: document.body.innerText };
  });
  check('the chart hangs a gold beacon on her', beacon.gold > 100, `${beacon.gold} gold px`);
  await page.keyboard.press('KeyM');
  await wait(600);

  // Her cargo, as the CLIENT has it: floating chests lying on her, drawn in
  // the world. (That a swimmer alongside is offered them through the ordinary
  // chest path is pinned server-side in test-wreck-event.mjs §3 against the
  // real Match — a probe cannot teleport the authoritative pirate, only its
  // own copy of him, so asserting it here would be asserting nothing.)
  const cargo = await page.evaluate(() => {
    const g = window.__piratesBR;
    const w = g.state.wreck;
    const chests = [];
    for (const isl of g.state.islands ?? []) {
      for (const c of isl.chests ?? []) {
        if (!w.chestIds.includes(c.id)) continue;
        chests.push({
          floating: !!c.floating,
          buried: !!c.buried,
          value: c.value,
          off: Math.hypot(c.position.x - w.position.x, c.position.z - w.position.z),
        });
      }
    }
    return { chests };
  });
  check('her chests are floating on her, not buried under her',
    cargo.chests.length > 0 && cargo.chests.every((c) => c.floating && !c.buried),
    `${cargo.chests.length} chests, values ${cargo.chests.map((c) => c.value).join('/')}`);
  // `.every()` ON AN EMPTY ARRAY IS TRUE, and `Math.max()` of nothing is
  // -Infinity — so with no chests found this printed "furthest -Infinitym off
  // her centre" and passed. That is a vacuous assertion in the exact shape this
  // repo keeps shipping: it cannot fail in the state where its subject does not
  // exist. The population is now part of the claim.
  check('and they lie ON her, within a hull length',
    cargo.chests.length > 0 && cargo.chests.every((c) => c.off < 40),
    cargo.chests.length
      ? `furthest ${Math.max(...cargo.chests.map((c) => c.off)).toFixed(1)}m off her centre`
      : 'no chests to measure — nothing was graded');

  // Frame the deck itself so the shot is of her cargo, not of an ocean.
  await page.evaluate(([x, z]) => {
    window.__piratesBR.enableFreeCam(x + 18, 7, z + 18, Math.atan2(-18, -18), -0.30);
  }, [wreck.x, wreck.z]);
  await wait(1400);
  await shot('09-her-cargo');
  await page.evaluate(() => window.__piratesBR.disableFreeCam?.());
} catch (err) {
  check('the gilded wreck stage ran', false, String(err).split('\n')[0].slice(0, 120));
} finally {
  if (wreckServer) { try { wreckServer.kill('SIGTERM'); } catch { /* already gone */ } }
}

// ══ VERDICT ════════════════════════════════════════════════════════════════
const hardErrors = errors.filter((e) => !/favicon|WebSocket is closed|net::ERR/i.test(e));
check('no console errors across the whole smoke', hardErrors.length === 0,
  hardErrors.slice(0, 3).join(' | ').slice(0, 200));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cross-feature checks passed. Shots in ${OUT}`);
if (failed.length) {
  console.log(`${failed.length} FAILED:`);
  for (const f of failed) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);
