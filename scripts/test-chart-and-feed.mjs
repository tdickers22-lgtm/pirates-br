#!/usr/bin/env node
// Four contracts the mechanical cleanup wave put in place, all of them the kind
// that rot silently because nothing throws when they break:
//
//   1. the first minimap frame of a match rasterizes at most 2 base island
//      charts (the whole Reach used to land on one frame, a hitch on the join);
//   2. a harvest-promoted boulder stands EXACTLY where its instance stood — the
//      clone used to pop up by the GLB's authored base offset on first chop;
//   3. the kill feed keeps one line's worth of height on a short viewport (it
//      collapsed to 0 there, so refusals were written into an invisible box);
//   4. the death screen names the cause the SERVER sent.
//
// Needs the dev stack (vite 3000 + game server 8090).
//   node scripts/test-chart-and-feed.mjs
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';

const ROOT_URL = process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000/';
const GAME_URL = `${ROOT_URL.replace(/\/$/, '')}/?debug&quality=low`;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: browserArgs(),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

try {
  console.log('Chart chunking, boulder promotion, feed floor, death cause');
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { state: 'visible', timeout: 45_000 });

  // Trace the chart cache from BEFORE the join, one sample per animation frame.
  await page.evaluate(() => {
    window.__chartTrace = [];
    const step = () => {
      const game = window.__piratesBR;
      if (game?.map?.debugChartBitmapSizes) {
        window.__chartTrace.push(Object.keys(game.map.debugChartBitmapSizes()).length);
      }
      if (window.__chartTrace.length < 900) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  await page.fill('#menu-name-input', `Chart${Math.floor(Math.random() * 9000 + 1000)}`);
  await page.click('#menu-solo-btn');
  await page.waitForFunction(() => {
    const game = window.__piratesBR;
    return !!game?.state && game.state.phase === 'playing';
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(5000);

  // ── 1. Island charts arrive a couple at a time ───────────────
  const trace = await page.evaluate(() => window.__chartTrace ?? []);
  let previous = 0;
  let worstStep = 0;
  for (const count of trace) {
    if (count > previous) worstStep = Math.max(worstStep, count - previous);
    previous = Math.max(previous, count);
  }
  const islands = await page.evaluate(() => window.__piratesBR.state.islands.length);
  console.log(`    ${islands} islands charted, worst single-frame burst: ${worstStep}`);
  expect('the whole Reach ends up on the chart', previous >= islands, `${previous}/${islands}`);
  expect('no frame rasterizes more than two island charts', worstStep > 0 && worstStep <= 2, `burst=${worstStep}`);

  // ── 2. A promoted boulder does not pop up ────────────────────
  const boulders = await page.evaluate(() => {
    const game = window.__piratesBR;
    const rows = [];
    for (const island of game.state.islands) {
      const slots = game.islandPropInstances.get(island.id);
      if (!slots) continue;
      for (const prop of island.props ?? []) {
        if (!prop.type.startsWith('boulder_') || prop.id === undefined) continue;
        const slot = slots.get(prop.id);
        if (!slot) continue;
        const matrix = slot.inst.instanceMatrix.array;
        const base = slot.index * 16;
        if (matrix[base] === 0 && matrix[base + 5] === 0) continue; // already harvested
        const geometry = slot.inst.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const lift = Math.max(0, geometry.boundingBox.min.y) * prop.scale;
        game.envFx.promoteHarvestProp(island, prop);
        const promoted = game.envFx.harvestPromoted;
        const cloneY = promoted ? promoted.node.position.y : null;
        game.envFx.demotePromotedHarvestProp();
        if (cloneY === null) continue;
        rows.push({ type: prop.type, lift, pop: cloneY - matrix[base + 13] });
        if (rows.length >= 120) return rows;
      }
    }
    return rows;
  });
  const worstPop = boulders.reduce((worst, row) => Math.max(worst, Math.abs(row.pop)), 0);
  const biggestLift = boulders.reduce((worst, row) => Math.max(worst, row.lift), 0);
  console.log(`    ${boulders.length} boulders promoted · biggest authored base offset ${biggestLift.toFixed(3)}m`);
  expect('boulders carry a base offset worth correcting', biggestLift > 0.05, `max lift ${biggestLift}`);
  expect('a promoted boulder stands exactly where its instance stood',
    boulders.length > 0 && worstPop < 1e-4, `worst pop ${worstPop.toFixed(4)}m over ${boulders.length} boulders`);

  // ── 3. The kill feed survives a short viewport ───────────────
  await page.setViewportSize({ width: 900, height: 430 });
  await page.waitForTimeout(400);
  const feed = await page.evaluate(() => {
    const element = document.getElementById('kill-feed');
    element.innerHTML = '';
    const empty = Math.round(element.getBoundingClientRect().height);
    const game = window.__piratesBR;
    game.hud.pushFeed('No room for that here — stand clear of the mast', '#ff9a7a');
    game.hud.pushFeed('Blackfin was eliminated by Redhand', '#e7e1d4');
    const height = Math.round(element.getBoundingClientRect().height);
    const first = element.firstElementChild?.getBoundingClientRect() ?? null;
    return {
      empty,
      height,
      lines: element.childElementCount,
      firstVisible: !!first && first.height > 4 && first.top < element.getBoundingClientRect().bottom,
    };
  });
  console.log(`    short viewport: empty=${feed.empty}px, ${feed.lines} lines → ${feed.height}px`);
  expect('an empty feed still takes no space at all', feed.empty === 0, `${feed.empty}px`);
  expect('a written line is given room to be read', feed.height >= 26, `${feed.height}px`);
  expect('the newest line is inside the box', feed.firstVisible, JSON.stringify(feed));
  await page.setViewportSize({ width: 1280, height: 800 });

  // ── 4. The death screen says what the server said ────────────
  const deaths = [];
  for (const cause of ['storm', 'drowned', 'ship_sunk']) {
    deaths.push(await page.evaluate((wanted) => {
      const game = window.__piratesBR;
      const player = game.getLocalPlayer();
      player.state = 'playing';
      game.hud.updateHud();
      game.network.onGameOver({ died: true, kills: 1, gold: 40, cause: wanted });
      player.state = 'eliminated';
      game.hud.updateHud();
      return { cause: wanted, title: document.getElementById('death-title')?.textContent ?? '' };
    }, cause));
  }
  console.log(`    ${deaths.map((d) => `${d.cause}→"${d.title}"`).join('  ')}`);
  expect('the storm gets its own title', /STORM/i.test(deaths[0].title), deaths[0].title);
  expect('drowning gets its own title', /DROWNED/i.test(deaths[1].title), deaths[1].title);
  expect('a sunk hull gets its own title', /SHIP SUNK/i.test(deaths[2].title), deaths[2].title);
  expect('the three causes do not share one screen',
    new Set(deaths.map((d) => d.title)).size === 3, JSON.stringify(deaths));

  // ── 5. The chart tells you how to read it ────────────────────
  const help = await page.evaluate(() => {
    const game = window.__piratesBR;
    game.map.mapOpen = true;
    document.getElementById('map-overlay').classList.add('visible');
    game.map.resetChartView();
    game.map.drawMaps();
    const element = document.getElementById('map-help');
    const rect = element.getBoundingClientRect();
    const panel = document.getElementById('map-panel').getBoundingClientRect();
    return {
      text: element.textContent ?? '',
      onScreen: rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      insidePanel: rect.right <= panel.right + 1,
    };
  });
  console.log(`    "${help.text}"`);
  expect('the help line teaches pan, zoom, centre and close',
    /pan/i.test(help.text) && /zoom/i.test(help.text) && /centre|center/i.test(help.text) && /\[M\]/i.test(help.text),
    help.text);
  expect('the help line is actually on the screen', help.onScreen && help.insidePanel, JSON.stringify(help));

  expect('No browser errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nChart/feed/death-cause checks passed.');
